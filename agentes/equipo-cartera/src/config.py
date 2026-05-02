"""Configuración global del agente Equipo Cartera.

Carga variables de entorno desde `.env` usando pydantic-settings y las
expone en una instancia global `settings`. Si `ANTHROPIC_API_KEY` está
vacío, se permite continuar (loggeando warning) para que el resto del
sistema pueda construirse y testearse aunque el usuario aún no tenga
configurada la key real.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


# Raíz del proyecto: agentes/equipo-cartera/
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Configuración cargada desde el archivo `.env` de la raíz del proyecto.

    Attributes:
        anthropic_api_key: API key de Anthropic. Puede estar vacía durante
            desarrollo; el agente fallará al ejecutarse hasta que se llene.
        google_sheets_id: ID del Google Sheet que contiene la cartera.
        google_credentials_path: Ruta (relativa o absoluta) al JSON del
            Service Account de Google Cloud.
        operador_nombre: Nombre del operador / negocio que se muestra al cliente.
        operador_horario_inicio: Hora (0-23) a partir de la cual se permite contactar.
        operador_horario_fin: Hora (0-23) hasta la cual se permite contactar.
        operador_timezone: Zona horaria IANA usada para validar el horario.
        env: Modo de ejecución del proceso ("development" o "production").
        log_level: Nivel mínimo de logging.
        dry_run: Si True, el agente no realiza acciones externas reales
            (no envía mensajes, no actualiza Sheet de forma irreversible).
    """

    model_config = SettingsConfigDict(
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")

    google_sheets_id: str = Field(default="", alias="GOOGLE_SHEETS_ID")
    google_credentials_path: str = Field(
        default="./credentials/service-account.json",
        alias="GOOGLE_CREDENTIALS_PATH",
    )

    operador_nombre: str = Field(default="Equipo Cartera", alias="OPERADOR_NOMBRE")
    operador_horario_inicio: int = Field(default=8, alias="OPERADOR_HORARIO_INICIO")
    operador_horario_fin: int = Field(default=19, alias="OPERADOR_HORARIO_FIN")
    operador_timezone: str = Field(default="America/Bogota", alias="OPERADOR_TIMEZONE")

    env: Literal["development", "staging", "production"] = Field(
        default="development", alias="ENV"
    )
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    dry_run: bool = Field(default=True, alias="DRY_RUN")

    @property
    def credentials_path_absoluto(self) -> Path:
        """Devuelve la ruta absoluta al JSON de credenciales del Service Account."""
        ruta = Path(self.google_credentials_path)
        if not ruta.is_absolute():
            ruta = PROJECT_ROOT / ruta
        return ruta.resolve()

    @property
    def modelo_claude(self) -> str:
        """Modelo de Claude usado por el agente."""
        return "claude-haiku-4-5"


def _cargar_settings() -> Settings:
    """Construye la instancia global y emite warnings de configuración faltante."""
    s = Settings()
    if not s.anthropic_api_key:
        logger.warning(
            "ANTHROPIC_API_KEY no está configurada en .env. "
            "El agente no podrá llamar a Claude hasta que la pegues."
        )
    if not s.google_sheets_id:
        logger.info(
            "GOOGLE_SHEETS_ID vacío. SheetsClient operará en modo stub "
            "con datos demo hardcodeados."
        )
    return s


settings: Settings = _cargar_settings()
