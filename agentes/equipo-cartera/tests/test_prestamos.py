"""Tests unitarios de la tool `obtener_prestamo` y la lógica de mora/contacto."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
import pytz

from src.config import settings
from src.integraciones.sheets_client import SheetsClient
from src.tools import prestamos as tools_prestamos
from src.tools.prestamos import (
    calcular_dias_mora,
    calcular_estado,
    evaluar_puede_contactarse,
    obtener_prestamo,
    set_sheets_client,
)


@pytest.fixture(autouse=True)
def _reset_cliente_stub():
    """Cada test arranca con un SheetsClient stub fresco e independiente."""
    cliente = SheetsClient(sheet_id="", credentials_path="./_no_existe_.json")
    set_sheets_client(cliente)
    yield
    set_sheets_client(None)


# ---------------------------------------------------------------------------
# obtener_prestamo
# ---------------------------------------------------------------------------
def test_obtener_prestamo_retorna_estructura_completa():
    """El dict debe traer todos los campos del Sheet + los calculados."""
    p = obtener_prestamo(prestamo_id="PR-DEMO-001")

    assert "error" not in p
    for campo in (
        "id",
        "cliente_nombre",
        "cliente_telefono",
        "monto_capital",
        "fecha_vencimiento",
        "consentimiento_cobro",
        "dias_mora",
        "estado_calculado",
        "puede_contactarse_hoy",
        "razon_no_contacto",
    ):
        assert campo in p, f"Falta el campo {campo}"

    assert p["id"] == "PR-DEMO-001"
    assert isinstance(p["dias_mora"], int)


def test_obtener_prestamo_inexistente_retorna_error():
    p = obtener_prestamo(prestamo_id="PR-NO-EXISTE-999")
    assert "error" in p


def test_obtener_prestamo_sin_argumentos_retorna_error():
    p = obtener_prestamo()
    assert "error" in p


# ---------------------------------------------------------------------------
# calcular_dias_mora
# ---------------------------------------------------------------------------
def test_dias_mora_negativo_si_aun_no_vence():
    hoy = date(2026, 5, 1)
    fv = "2026-05-06"
    assert calcular_dias_mora(fv, hoy=hoy) == -5


def test_dias_mora_cero_si_vence_hoy():
    hoy = date(2026, 5, 1)
    assert calcular_dias_mora("2026-05-01", hoy=hoy) == 0


def test_dias_mora_positivo_si_ya_vencio():
    hoy = date(2026, 5, 1)
    assert calcular_dias_mora("2026-04-21", hoy=hoy) == 10


def test_dias_mora_fecha_invalida_retorna_cero():
    assert calcular_dias_mora("no-es-fecha") == 0
    assert calcular_dias_mora(None) == 0
    assert calcular_dias_mora("") == 0


# ---------------------------------------------------------------------------
# calcular_estado (buckets)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "dias,esperado",
    [
        (-30, "al_dia"),
        (-5, "al_dia"),
        (-1, "por_vencer_1"),
        (0, "vence_hoy"),
        (2, "mora_1_3"),
        (5, "mora_4_7"),
        (10, "mora_8_15"),
        (22, "mora_15_30"),
        (45, "mora_30_mas"),
    ],
)
def test_calcular_estado_buckets(dias, esperado):
    assert calcular_estado(dias) == esperado


# ---------------------------------------------------------------------------
# evaluar_puede_contactarse
# ---------------------------------------------------------------------------
def _ahora_co(hora: int, dia_semana: int = 0) -> datetime:
    """Construye un datetime con tz Colombia. dia_semana 0=lunes ... 6=domingo."""
    tz = pytz.timezone(settings.operador_timezone)
    base = date(2026, 5, 4)  # 2026-05-04 es lunes
    fecha = base + timedelta(days=dia_semana)
    return tz.localize(datetime.combine(fecha, datetime.min.time()).replace(hour=hora))


def test_puede_contactarse_ok_en_horario_y_con_consentimiento():
    ok, razon = evaluar_puede_contactarse(
        consentimiento_cobro=True,
        ultimo_contacto=None,
        ahora=_ahora_co(hora=10),
    )
    assert ok is True
    assert razon == "ok"


def test_no_puede_contactarse_fuera_de_horario_temprano():
    ok, razon = evaluar_puede_contactarse(
        consentimiento_cobro=True,
        ultimo_contacto=None,
        ahora=_ahora_co(hora=6),  # antes de las 8
    )
    assert ok is False
    assert razon == "fuera_de_horario"


def test_no_puede_contactarse_fuera_de_horario_tarde():
    ok, razon = evaluar_puede_contactarse(
        consentimiento_cobro=True,
        ultimo_contacto=None,
        ahora=_ahora_co(hora=20),  # después de las 19
    )
    assert ok is False
    assert razon == "fuera_de_horario"


def test_no_puede_contactarse_domingo():
    ok, razon = evaluar_puede_contactarse(
        consentimiento_cobro=True,
        ultimo_contacto=None,
        ahora=_ahora_co(hora=10, dia_semana=6),  # domingo
    )
    assert ok is False
    assert razon == "domingo"


def test_no_puede_contactarse_sin_consentimiento():
    ok, razon = evaluar_puede_contactarse(
        consentimiento_cobro=False,
        ultimo_contacto=None,
        ahora=_ahora_co(hora=10),
    )
    assert ok is False
    assert razon == "sin_consentimiento"


def test_no_puede_contactarse_si_contactado_hace_menos_de_24h():
    ahora = _ahora_co(hora=10)
    hace_5_horas = (ahora - timedelta(hours=5)).isoformat()
    ok, razon = evaluar_puede_contactarse(
        consentimiento_cobro=True,
        ultimo_contacto=hace_5_horas,
        ahora=ahora,
    )
    assert ok is False
    assert razon == "contactado_hace_menos_24h"


def test_si_puede_contactarse_si_paso_mas_de_24h():
    ahora = _ahora_co(hora=10)
    hace_2_dias = (ahora - timedelta(days=2)).isoformat()
    ok, razon = evaluar_puede_contactarse(
        consentimiento_cobro=True,
        ultimo_contacto=hace_2_dias,
        ahora=ahora,
    )
    assert ok is True
    assert razon == "ok"


# ---------------------------------------------------------------------------
# Integración: PR-DEMO-005 (sin consentimiento) bloquea contacto
# ---------------------------------------------------------------------------
def test_pr_demo_005_no_puede_contactarse_por_falta_consentimiento():
    p = obtener_prestamo(prestamo_id="PR-DEMO-005")
    assert p["consentimiento_cobro"] is False
    assert p["puede_contactarse_hoy"] is False
    assert p["razon_no_contacto"] == "sin_consentimiento"
