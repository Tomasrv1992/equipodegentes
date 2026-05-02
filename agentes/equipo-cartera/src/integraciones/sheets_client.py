"""Cliente de Google Sheets con modo stub para desarrollo offline.

El cliente intenta conectarse a un Google Sheet real usando un Service
Account; si el archivo de credenciales no existe en disco, cae automáticamente
en `modo_stub = True` y sirve datos hardcodeados (los 5 préstamos demo
descritos en `scripts/datos_demo.csv`).

Esto permite construir y probar el agente end-to-end sin depender de
credenciales reales ni intervención humana.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# -------- Datos demo (modo stub) ---------------------------------------------
# Las fechas se calculan dinámicamente respecto a "hoy" para que siempre
# reflejen los estados descritos en el plan (al día, por vencer, mora N).
def _construir_prestamos_demo() -> list[dict[str, Any]]:
    """Construye los 5 préstamos demo con fechas relativas a hoy.

    Estados producidos:
        - PR-DEMO-001: al día, vence en +5 días
        - PR-DEMO-002: por vencer, vence mañana
        - PR-DEMO-003: mora 2 días
        - PR-DEMO-004: mora 10 días
        - PR-DEMO-005: mora 22 días, sin consentimiento de cobro
    """
    hoy = datetime.now().date()

    def fecha(delta_dias: int) -> str:
        return (hoy + timedelta(days=delta_dias)).isoformat()

    return [
        {
            "id": "PR-DEMO-001",
            "cliente_nombre": "Juan Pérez Rodríguez",
            "cliente_telefono": "+573001234567",
            "cliente_cedula": "1010101010",
            "monto_capital": 1_000_000,
            "tasa_mes": 0.025,
            "fecha_desembolso": fecha(-25),
            "fecha_vencimiento": fecha(5),
            "frecuencia": "mensual",
            "saldo_pendiente": 1_025_000,
            "estado": "vigente",
            "ultimo_contacto": "",
            "ultimo_canal": "",
            "consentimiento_cobro": True,
        },
        {
            "id": "PR-DEMO-002",
            "cliente_nombre": "María Gómez Castro",
            "cliente_telefono": "+573005551122",
            "cliente_cedula": "2020202020",
            "monto_capital": 750_000,
            "tasa_mes": 0.025,
            "fecha_desembolso": fecha(-29),
            "fecha_vencimiento": fecha(1),
            "frecuencia": "mensual",
            "saldo_pendiente": 768_750,
            "estado": "vigente",
            "ultimo_contacto": "",
            "ultimo_canal": "",
            "consentimiento_cobro": True,
        },
        {
            "id": "PR-DEMO-003",
            "cliente_nombre": "Carlos Ramírez Mejía",
            "cliente_telefono": "+573009998877",
            "cliente_cedula": "3030303030",
            "monto_capital": 500_000,
            "tasa_mes": 0.030,
            "fecha_desembolso": fecha(-32),
            "fecha_vencimiento": fecha(-2),
            "frecuencia": "mensual",
            "saldo_pendiente": 515_000,
            "estado": "vencido",
            "ultimo_contacto": "",
            "ultimo_canal": "",
            "consentimiento_cobro": True,
        },
        {
            "id": "PR-DEMO-004",
            "cliente_nombre": "Laura Martínez Silva",
            "cliente_telefono": "+573007776655",
            "cliente_cedula": "4040404040",
            "monto_capital": 1_500_000,
            "tasa_mes": 0.025,
            "fecha_desembolso": fecha(-40),
            "fecha_vencimiento": fecha(-10),
            "frecuencia": "mensual",
            "saldo_pendiente": 1_590_000,
            "estado": "vencido",
            "ultimo_contacto": "",
            "ultimo_canal": "",
            "consentimiento_cobro": True,
        },
        {
            "id": "PR-DEMO-005",
            "cliente_nombre": "Andrés Quintero López",
            "cliente_telefono": "+573004443322",
            "cliente_cedula": "5050505050",
            "monto_capital": 2_000_000,
            "tasa_mes": 0.030,
            "fecha_desembolso": fecha(-52),
            "fecha_vencimiento": fecha(-22),
            "frecuencia": "mensual",
            "saldo_pendiente": 2_180_000,
            "estado": "vencido",
            "ultimo_contacto": "",
            "ultimo_canal": "",
            "consentimiento_cobro": False,
        },
    ]


# Columnas esperadas en cada pestaña del Google Sheet real.
COLUMNAS_PRESTAMOS = [
    "id",
    "cliente_nombre",
    "cliente_telefono",
    "cliente_cedula",
    "monto_capital",
    "tasa_mes",
    "fecha_desembolso",
    "fecha_vencimiento",
    "frecuencia",
    "saldo_pendiente",
    "estado",
    "ultimo_contacto",
    "ultimo_canal",
    "consentimiento_cobro",
]

COLUMNAS_EVENTOS = [
    "timestamp",
    "prestamo_id",
    "tipo",
    "canal",
    "contenido",
    "resultado",
    "costo_usd",
]


class SheetsClient:
    """Cliente de Google Sheets con fallback a modo stub.

    Si `credentials_path` apunta a un archivo existente, intenta abrir el
    Sheet real con `gspread` y `google-auth`. En caso contrario (o si la
    autenticación falla), opera en `modo_stub = True` con datos demo en
    memoria; los métodos de escritura solo loggean lo que harían.

    Attributes:
        sheet_id: ID del Google Sheet (vacío en modo stub).
        credentials_path: Ruta al JSON del Service Account.
        modo_stub: True si el cliente opera contra datos en memoria.
    """

    def __init__(self, sheet_id: str, credentials_path: str | Path) -> None:
        self.sheet_id: str = sheet_id
        self.credentials_path: Path = Path(credentials_path)
        self.modo_stub: bool = False
        self._prestamos_stub: list[dict[str, Any]] = []
        self._eventos_stub: list[dict[str, Any]] = []
        self._sheet = None  # type: ignore[assignment]
        self._ws_prestamos = None  # type: ignore[assignment]
        self._ws_eventos = None  # type: ignore[assignment]

        if not self.credentials_path.exists() or not sheet_id:
            self._activar_modo_stub(
                razon=(
                    "credenciales no encontradas en disco"
                    if not self.credentials_path.exists()
                    else "GOOGLE_SHEETS_ID vacío"
                )
            )
            return

        try:
            self._inicializar_real()
        except Exception as e:  # noqa: BLE001 — fallback amplio justificado
            logger.warning(
                "Fallo al inicializar gspread (%s). Cayendo en modo stub.", e
            )
            self._activar_modo_stub(razon=f"error inicializando gspread: {e}")

    # -- Inicialización --------------------------------------------------------
    def _activar_modo_stub(self, razon: str) -> None:
        """Carga datos demo en memoria y marca el cliente como stub."""
        self.modo_stub = True
        self._prestamos_stub = _construir_prestamos_demo()
        self._eventos_stub = []
        logger.info("SheetsClient en modo STUB (%s).", razon)

    def _inicializar_real(self) -> None:
        """Abre el Sheet real usando gspread + Service Account."""
        import gspread
        from google.oauth2.service_account import Credentials

        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ]
        creds = Credentials.from_service_account_file(
            str(self.credentials_path), scopes=scopes
        )
        gc = gspread.authorize(creds)
        self._sheet = gc.open_by_key(self.sheet_id)
        self._ws_prestamos = self._sheet.worksheet("prestamos")
        self._ws_eventos = self._sheet.worksheet("eventos")
        logger.info("SheetsClient conectado a Sheet real id=%s", self.sheet_id)

    # -- API pública -----------------------------------------------------------
    def leer_prestamo(self, prestamo_id: str) -> dict[str, Any] | None:
        """Devuelve el préstamo cuyo `id` coincida, o None si no existe.

        Args:
            prestamo_id: Identificador único del préstamo (ej. "PR-DEMO-001").

        Returns:
            Diccionario con todos los campos del préstamo, o None.
        """
        if self.modo_stub:
            for p in self._prestamos_stub:
                if p["id"] == prestamo_id:
                    return dict(p)
            return None

        try:
            registros = self._ws_prestamos.get_all_records()  # type: ignore[union-attr]
            for fila in registros:
                if str(fila.get("id", "")).strip() == prestamo_id:
                    return self._normalizar_fila(fila)
            return None
        except Exception as e:  # noqa: BLE001
            logger.error("Error leyendo préstamo %s: %s", prestamo_id, e)
            return None

    def leer_prestamo_por_telefono(self, telefono: str) -> dict[str, Any] | None:
        """Devuelve el primer préstamo cuyo teléfono coincida exactamente."""
        telefono = (telefono or "").strip()
        if not telefono:
            return None

        if self.modo_stub:
            for p in self._prestamos_stub:
                if p["cliente_telefono"] == telefono:
                    return dict(p)
            return None

        try:
            registros = self._ws_prestamos.get_all_records()  # type: ignore[union-attr]
            for fila in registros:
                if str(fila.get("cliente_telefono", "")).strip() == telefono:
                    return self._normalizar_fila(fila)
            return None
        except Exception as e:  # noqa: BLE001
            logger.error("Error leyendo préstamo por teléfono %s: %s", telefono, e)
            return None

    def actualizar_prestamo(self, prestamo_id: str, campos: dict[str, Any]) -> bool:
        """Actualiza los campos indicados en la fila del préstamo.

        En modo stub solo loggea la operación, no persiste nada.

        Returns:
            True si la actualización se realizó (o se simuló) sin errores.
        """
        if self.modo_stub:
            logger.info(
                "[STUB] actualizar_prestamo id=%s campos=%s (no se persiste).",
                prestamo_id,
                campos,
            )
            for p in self._prestamos_stub:
                if p["id"] == prestamo_id:
                    p.update(campos)
                    return True
            return False

        try:
            ws = self._ws_prestamos  # type: ignore[union-attr]
            cell = ws.find(prestamo_id, in_column=1)
            if cell is None:
                logger.warning("actualizar_prestamo: id %s no encontrado.", prestamo_id)
                return False
            fila = cell.row
            encabezados = ws.row_values(1)
            for clave, valor in campos.items():
                if clave in encabezados:
                    col = encabezados.index(clave) + 1
                    ws.update_cell(fila, col, valor)
            return True
        except Exception as e:  # noqa: BLE001
            logger.error("Error actualizando préstamo %s: %s", prestamo_id, e)
            return False

    def registrar_evento(
        self,
        prestamo_id: str,
        tipo: str,
        contenido: str,
        canal: str = "sistema",
        resultado: str = "ok",
        costo_usd: float = 0.0,
    ) -> bool:
        """Anexa un evento a la pestaña `eventos`.

        En modo stub guarda el evento en memoria y loggea.

        Returns:
            True si la escritura se realizó (o se simuló) sin errores.
        """
        evento = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "prestamo_id": prestamo_id,
            "tipo": tipo,
            "canal": canal,
            "contenido": contenido,
            "resultado": resultado,
            "costo_usd": float(costo_usd),
        }

        if self.modo_stub:
            self._eventos_stub.append(evento)
            logger.info("[STUB] registrar_evento %s", evento)
            return True

        try:
            fila = [evento[c] for c in COLUMNAS_EVENTOS]
            self._ws_eventos.append_row(fila, value_input_option="USER_ENTERED")  # type: ignore[union-attr]
            return True
        except Exception as e:  # noqa: BLE001
            logger.error("Error registrando evento para %s: %s", prestamo_id, e)
            return False

    # -- Utilidades ------------------------------------------------------------
    @staticmethod
    def _normalizar_fila(fila: dict[str, Any]) -> dict[str, Any]:
        """Convierte tipos de una fila cruda de gspread a tipos Python sanos."""
        normalizada: dict[str, Any] = dict(fila)

        for campo in ("monto_capital", "saldo_pendiente"):
            if campo in normalizada and normalizada[campo] not in ("", None):
                try:
                    normalizada[campo] = int(float(normalizada[campo]))
                except (TypeError, ValueError):
                    pass

        if "tasa_mes" in normalizada and normalizada["tasa_mes"] not in ("", None):
            try:
                normalizada["tasa_mes"] = float(normalizada["tasa_mes"])
            except (TypeError, ValueError):
                pass

        if "consentimiento_cobro" in normalizada:
            valor = normalizada["consentimiento_cobro"]
            if isinstance(valor, str):
                normalizada["consentimiento_cobro"] = valor.strip().upper() in (
                    "TRUE",
                    "1",
                    "SI",
                    "SÍ",
                    "YES",
                )

        return normalizada
