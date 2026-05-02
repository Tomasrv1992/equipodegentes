"""Agente cobrador — loop tool-use sobre Claude API.

Punto de entrada del MVP. Toma un `prestamo_id`, llama a Claude con la
tool `obtener_prestamo`, deja que el modelo decida si enviar mensaje hoy
y registra la decisión final como evento en el Sheet (real o stub).

Uso desde la raíz `agentes/equipo-cartera/`:
    python -m src.agent --prestamo PR-DEMO-001
    python -m src.agent --prestamo PR-DEMO-003 --verbose
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

import anthropic

from src.config import PROJECT_ROOT, settings
from src.tools.definitions import TOOLS, ejecutar_tool
from src.tools.prestamos import get_sheets_client

logger = logging.getLogger(__name__)


PROMPT_PATH = PROJECT_ROOT / "prompts" / "cobrador_v1.md"
MAX_ITERACIONES_LOOP = 10


def cargar_system_prompt() -> str:
    """Carga el system prompt desde `prompts/cobrador_v1.md`."""
    if not PROMPT_PATH.exists():
        raise FileNotFoundError(
            f"No se encontró el system prompt en {PROMPT_PATH}. "
            "¿Se ejecutó la TAREA 4?"
        )
    return PROMPT_PATH.read_text(encoding="utf-8")


def _construir_mensaje_inicial(prestamo_id: str) -> str:
    return (
        f"Procesa el préstamo {prestamo_id}. Decide si hay que enviar "
        f"mensaje hoy. Si sí, redacta el mensaje exacto. Si no, explica "
        f"por qué. Usa la tool obtener_prestamo para obtener los datos."
    )


def _extraer_texto_final(content_blocks: list[Any]) -> str:
    """Concatena el texto de todos los bloques `text` del último mensaje."""
    partes = [b.text for b in content_blocks if getattr(b, "type", None) == "text"]
    return "\n".join(partes).strip()


def _parsear_decision(texto_final: str) -> dict[str, str]:
    """Extrae el bloque DECISIÓN/MENSAJE/RAZÓN del cierre del prompt.

    Formato esperado:
        DECISIÓN: [enviar | no_enviar | escalar]
        MENSAJE: [texto exacto o N/A]
        RAZÓN: [explicación breve]
    """
    decision = mensaje = razon = ""
    for linea in texto_final.splitlines():
        l = linea.strip()
        upper = l.upper()
        if upper.startswith("DECISIÓN:") or upper.startswith("DECISION:"):
            decision = l.split(":", 1)[1].strip().strip("[]").strip()
        elif upper.startswith("MENSAJE:"):
            mensaje = l.split(":", 1)[1].strip().strip("[]").strip()
        elif upper.startswith("RAZÓN:") or upper.startswith("RAZON:"):
            razon = l.split(":", 1)[1].strip().strip("[]").strip()
    return {"decision": decision, "mensaje": mensaje, "razon": razon}


def correr_agente(prestamo_id: str, verbose: bool = False) -> dict[str, Any]:
    """Ejecuta el agente sobre un préstamo y devuelve la decisión final.

    Args:
        prestamo_id: Identificador del préstamo a procesar.
        verbose: Si True, loggea cada paso del razonamiento del modelo.

    Returns:
        dict con: mensaje_redactado, accion_tomada, razon, costo_tokens,
        iteraciones, raw_text.
    """
    if not settings.anthropic_api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY no está configurada en .env. "
            "Configúrala antes de correr el agente."
        )

    cliente = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    system_prompt = cargar_system_prompt()

    messages: list[dict[str, Any]] = [
        {"role": "user", "content": _construir_mensaje_inicial(prestamo_id)}
    ]

    tokens_input = 0
    tokens_output = 0
    iteraciones = 0
    response = None

    while iteraciones < MAX_ITERACIONES_LOOP:
        iteraciones += 1
        if verbose:
            logger.info("--- iteración %d ---", iteraciones)

        response = cliente.messages.create(
            model=settings.modelo_claude,
            max_tokens=2048,
            system=system_prompt,
            tools=TOOLS,
            messages=messages,
        )

        tokens_input += response.usage.input_tokens
        tokens_output += response.usage.output_tokens

        if verbose:
            for b in response.content:
                if b.type == "text":
                    logger.info("[texto] %s", b.text[:300])
                elif b.type == "tool_use":
                    logger.info("[tool_use] %s(%s)", b.name, b.input)

        if response.stop_reason == "end_turn":
            break

        if response.stop_reason != "tool_use":
            logger.warning(
                "stop_reason inesperado: %s — terminando loop.", response.stop_reason
            )
            break

        bloques_tool_use = [b for b in response.content if b.type == "tool_use"]
        messages.append({"role": "assistant", "content": response.content})

        resultados_tool = []
        for bloque in bloques_tool_use:
            resultado_json = ejecutar_tool(bloque.name, bloque.input)
            if verbose:
                logger.info("[tool_result] %s -> %s", bloque.name, resultado_json[:300])
            resultados_tool.append(
                {
                    "type": "tool_result",
                    "tool_use_id": bloque.id,
                    "content": resultado_json,
                }
            )

        messages.append({"role": "user", "content": resultados_tool})
    else:
        logger.warning(
            "Se alcanzó el máximo de %d iteraciones sin end_turn.",
            MAX_ITERACIONES_LOOP,
        )

    texto_final = _extraer_texto_final(response.content) if response else ""
    decision_struct = _parsear_decision(texto_final)

    contenido_evento = json.dumps(
        {
            "decision": decision_struct["decision"],
            "mensaje": decision_struct["mensaje"],
            "razon": decision_struct["razon"],
        },
        ensure_ascii=False,
    )

    cliente_sheets = get_sheets_client()
    cliente_sheets.registrar_evento(
        prestamo_id=prestamo_id,
        tipo="decision_agente",
        canal="agente",
        contenido=contenido_evento,
        resultado=decision_struct["decision"] or "indeterminado",
    )

    return {
        "mensaje_redactado": decision_struct["mensaje"],
        "accion_tomada": decision_struct["decision"],
        "razon": decision_struct["razon"],
        "costo_tokens": {"input": tokens_input, "output": tokens_output},
        "iteraciones": iteraciones,
        "raw_text": texto_final,
    }


def _configurar_logging(verbose: bool) -> None:
    nivel = logging.DEBUG if verbose else getattr(logging, settings.log_level, logging.INFO)
    logging.basicConfig(
        level=nivel,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m src.agent",
        description="Agente cobrador — procesa un préstamo y decide la acción del día.",
    )
    parser.add_argument(
        "--prestamo",
        required=True,
        help="ID del préstamo a procesar (ej. PR-DEMO-001).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Modo dry-run (default True). En esta versión no se envía nada real.",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Imprime cada paso del razonamiento del modelo.",
    )
    args = parser.parse_args(argv)

    _configurar_logging(args.verbose)

    if not settings.anthropic_api_key:
        print(
            "ERROR: ANTHROPIC_API_KEY no está configurada en .env.\n"
            "  1) Abre el archivo .env en agentes/equipo-cartera/\n"
            "  2) Pega tu key en la línea 'ANTHROPIC_API_KEY='\n"
            "  3) Vuelve a correr este comando.",
            file=sys.stderr,
        )
        return 2

    try:
        resultado = correr_agente(args.prestamo, verbose=args.verbose)
    except Exception as e:  # noqa: BLE001
        logger.exception("Fallo ejecutando el agente: %s", e)
        return 1

    print("\n========== RESULTADO DEL AGENTE ==========")
    print(f"Préstamo:        {args.prestamo}")
    print(f"Decisión:        {resultado['accion_tomada']}")
    print(f"Razón:           {resultado['razon']}")
    if resultado["mensaje_redactado"] and resultado["mensaje_redactado"].upper() != "N/A":
        print(f"Mensaje:         {resultado['mensaje_redactado']}")
    print(
        f"Iteraciones:     {resultado['iteraciones']}  |  "
        f"Tokens in/out:   {resultado['costo_tokens']['input']}/{resultado['costo_tokens']['output']}"
    )
    print("==========================================\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
