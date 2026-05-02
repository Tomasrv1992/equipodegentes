"""Definiciones de tools en el formato esperado por la API de Anthropic.

Mantiene una lista `TOOLS` consumible directamente por `messages.create(tools=...)`
y un dispatcher `ejecutar_tool` que mapea el nombre del tool al callable
correspondiente y devuelve un JSON serializado del resultado.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from src.tools.prestamos import obtener_prestamo

logger = logging.getLogger(__name__)


TOOLS: list[dict[str, Any]] = [
    {
        "name": "obtener_prestamo",
        "description": (
            "Obtiene los datos completos de un préstamo desde la cartera, "
            "incluyendo campos calculados: días de mora, estado categórico "
            "(al_dia/por_vencer_3/por_vencer_1/vence_hoy/mora_1_3/mora_4_7/"
            "mora_8_15/mora_15_30/mora_30_mas), si el cliente puede ser "
            "contactado hoy y la razón en caso negativo. Usar al inicio de "
            "cada conversación nueva."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prestamo_id": {
                    "type": "string",
                    "description": (
                        "Identificador único del préstamo. "
                        "Ejemplo: 'PR-DEMO-001'."
                    ),
                },
                "telefono": {
                    "type": "string",
                    "description": (
                        "Número de teléfono del cliente en formato E.164 "
                        "(ej. '+573001234567'). Usar como alternativa cuando "
                        "no se conoce el ID del préstamo."
                    ),
                },
            },
            "required": [],
        },
    },
]


_DISPATCH: dict[str, Callable[..., Any]] = {
    "obtener_prestamo": obtener_prestamo,
}


def ejecutar_tool(nombre: str, input_dict: dict[str, Any]) -> str:
    """Ejecuta el tool indicado y devuelve su resultado serializado a JSON.

    Args:
        nombre: Nombre del tool (debe estar en `TOOLS`).
        input_dict: Argumentos que vienen del modelo (`tool_use.input`).

    Returns:
        String JSON con el resultado o un objeto `{"error": "..."}` si
        el tool no existe o falla.
    """
    fn = _DISPATCH.get(nombre)
    if fn is None:
        logger.error("Tool desconocida: %s", nombre)
        return json.dumps({"error": f"Tool desconocida: {nombre}"}, ensure_ascii=False)

    try:
        resultado = fn(**input_dict)
        return json.dumps(resultado, ensure_ascii=False, default=str)
    except Exception as e:  # noqa: BLE001
        logger.exception("Error ejecutando tool %s", nombre)
        return json.dumps(
            {"error": f"Excepción ejecutando {nombre}: {e}"},
            ensure_ascii=False,
        )
