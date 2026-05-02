"""Tool `obtener_prestamo` y lógica derivada (días de mora, reglas de contacto).

Esta es la única tool expuesta al agente en la sesión 1. Calcula campos
derivados (estado, mora, ventana de contacto) que el modelo no debe
tener que recalcular por su cuenta.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any

import pytz
from dateutil import parser as date_parser

from src.config import settings
from src.integraciones.sheets_client import SheetsClient

logger = logging.getLogger(__name__)


# Singleton del cliente — se inicializa en la primera llamada para
# permitir que tests inyecten su propio cliente vía `set_sheets_client`.
_sheets_client: SheetsClient | None = None


def get_sheets_client() -> SheetsClient:
    """Devuelve la instancia singleton del SheetsClient, creándola si hace falta."""
    global _sheets_client
    if _sheets_client is None:
        _sheets_client = SheetsClient(
            sheet_id=settings.google_sheets_id,
            credentials_path=settings.credentials_path_absoluto,
        )
    return _sheets_client


def set_sheets_client(client: SheetsClient | None) -> None:
    """Inyecta un cliente custom (útil para tests). Pasar None para resetear."""
    global _sheets_client
    _sheets_client = client


# ---------------------------------------------------------------------------
# Cálculos derivados
# ---------------------------------------------------------------------------
def _ahora_co() -> datetime:
    """Devuelve `datetime.now()` en la zona horaria configurada (Colombia)."""
    tz = pytz.timezone(settings.operador_timezone)
    return datetime.now(tz)


def _parsear_fecha(valor: Any) -> date | None:
    """Convierte una cadena ISO/dd-mm-yyyy a `date`, o None si no parsea."""
    if not valor:
        return None
    if isinstance(valor, date) and not isinstance(valor, datetime):
        return valor
    if isinstance(valor, datetime):
        return valor.date()
    try:
        return date_parser.parse(str(valor), dayfirst=False).date()
    except (ValueError, TypeError, date_parser.ParserError):
        return None


def calcular_dias_mora(fecha_vencimiento: Any, hoy: date | None = None) -> int:
    """Días de mora respecto a hoy.

    Negativo si el préstamo aún no vence; 0 si vence hoy; positivo si está
    en mora. Si la fecha no se puede parsear, retorna 0.
    """
    fv = _parsear_fecha(fecha_vencimiento)
    if fv is None:
        return 0
    if hoy is None:
        hoy = _ahora_co().date()
    return (hoy - fv).days


def calcular_estado(dias_mora: int) -> str:
    """Mapea días de mora a un bucket categórico."""
    if dias_mora <= -3:
        return "al_dia"
    if dias_mora == -2 or dias_mora == -3:
        return "por_vencer_3"
    if dias_mora == -1:
        return "por_vencer_1"
    if dias_mora == 0:
        return "vence_hoy"
    if 1 <= dias_mora <= 3:
        return "mora_1_3"
    if 4 <= dias_mora <= 7:
        return "mora_4_7"
    if 8 <= dias_mora <= 15:
        return "mora_8_15"
    if 16 <= dias_mora <= 30:
        return "mora_15_30"
    return "mora_30_mas"


def evaluar_puede_contactarse(
    consentimiento_cobro: bool,
    ultimo_contacto: Any,
    ahora: datetime | None = None,
) -> tuple[bool, str]:
    """Decide si se puede contactar al cliente AHORA según las reglas legales.

    Reglas (todas deben cumplirse):
      - Hora actual entre OPERADOR_HORARIO_INICIO y OPERADOR_HORARIO_FIN.
      - Día de la semana NO domingo (lunes=0 ... domingo=6).
      - consentimiento_cobro debe ser True.
      - Si `ultimo_contacto` existe, debe haber pasado al menos 24h.

    Returns:
        Tupla (puede_contactarse, razón). La razón explica el primer motivo
        de bloqueo si `puede_contactarse` es False, o "ok" si es True.
    """
    if ahora is None:
        ahora = _ahora_co()

    if not consentimiento_cobro:
        return False, "sin_consentimiento"

    if ahora.weekday() == 6:
        return False, "domingo"

    hora = ahora.hour
    if hora < settings.operador_horario_inicio or hora >= settings.operador_horario_fin:
        return False, "fuera_de_horario"

    if ultimo_contacto:
        try:
            uc = date_parser.parse(str(ultimo_contacto))
            if uc.tzinfo is None:
                uc = pytz.timezone(settings.operador_timezone).localize(uc)
            if ahora - uc < timedelta(hours=24):
                return False, "contactado_hace_menos_24h"
        except (ValueError, TypeError, date_parser.ParserError):
            logger.debug("ultimo_contacto no parseable: %s", ultimo_contacto)

    return True, "ok"


# ---------------------------------------------------------------------------
# Tool pública
# ---------------------------------------------------------------------------
def obtener_prestamo(
    prestamo_id: str | None = None,
    telefono: str | None = None,
) -> dict[str, Any]:
    """Devuelve el préstamo identificado por `prestamo_id` o `telefono`.

    Siempre debe pasarse exactamente uno de los dos. El resultado incluye
    todos los campos del Sheet más tres calculados:
      - `dias_mora`: int
      - `estado_calculado`: str (ver `calcular_estado`)
      - `puede_contactarse_hoy`: bool
      - `razon_no_contacto`: str (presente siempre, "ok" si sí se puede)

    Args:
        prestamo_id: Identificador del préstamo (ej. "PR-DEMO-001").
        telefono: Número en formato E.164 (ej. "+573001234567").

    Returns:
        Diccionario con los datos del préstamo y los campos derivados.
        Si no se encuentra, retorna `{"error": "..."}`.
    """
    if not prestamo_id and not telefono:
        return {"error": "Debes pasar prestamo_id o telefono."}

    cliente = get_sheets_client()

    if prestamo_id:
        prestamo = cliente.leer_prestamo(prestamo_id)
    else:
        prestamo = cliente.leer_prestamo_por_telefono(telefono or "")

    if prestamo is None:
        return {
            "error": "Préstamo no encontrado.",
            "buscado_por": "id" if prestamo_id else "telefono",
            "valor": prestamo_id or telefono,
        }

    dias = calcular_dias_mora(prestamo.get("fecha_vencimiento"))
    estado_calc = calcular_estado(dias)
    puede, razon = evaluar_puede_contactarse(
        consentimiento_cobro=bool(prestamo.get("consentimiento_cobro")),
        ultimo_contacto=prestamo.get("ultimo_contacto"),
    )

    enriquecido: dict[str, Any] = dict(prestamo)
    enriquecido["dias_mora"] = dias
    enriquecido["estado_calculado"] = estado_calc
    enriquecido["puede_contactarse_hoy"] = puede
    enriquecido["razon_no_contacto"] = razon
    return enriquecido
