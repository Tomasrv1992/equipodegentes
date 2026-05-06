"""Cliente HTTP que reporta inicio/fin de un run al endpoint Netlify /record-run.

Usa urllib (stdlib) para no agregar dependencias. Silencioso ante fallas.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib import request as _request
from urllib.error import URLError

logger = logging.getLogger(__name__)

_BASE = os.environ.get("RECORD_RUN_URL", "").rstrip("/")
_SECRET = os.environ.get("FACTURACION_INTERNAL_SECRET", "")
_TIMEOUT_SEG = 5


def _post(payload: dict[str, Any]) -> dict[str, Any] | None:
    if not _BASE or not _SECRET:
        return None
    url = f"{_BASE}/.netlify/functions/record-run"
    data = json.dumps(payload).encode("utf-8")
    req = _request.Request(
        url,
        data=data,
        headers={
            "x-internal-secret": _SECRET,
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with _request.urlopen(req, timeout=_TIMEOUT_SEG) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except (URLError, TimeoutError, json.JSONDecodeError) as e:
        logger.warning("[runs_client] no-fatal: %s", e)
        return None


def record_run_start(
    cliente_slug: str,
    agente_id: str,
    triggered_by: str = "cron",
) -> str | None:
    """Inicia un run. Devuelve run_id o None si está deshabilitado / falla."""
    resp = _post(
        {
            "action": "start",
            "clienteSlug": cliente_slug,
            "agenteId": agente_id,
            "triggeredBy": triggered_by,
        }
    )
    return resp.get("runId") if isinstance(resp, dict) else None


def record_run_end(
    run_id: str | None,
    status: str,
    duration_ms: int,
    summary: str = "",
    payload: Any = None,
    error_message: str = "",
    error_stack: str = "",
) -> None:
    """Cierra un run. Silencioso ante fallas (no bloquea el agente)."""
    if not run_id:
        return
    _post(
        {
            "action": "end",
            "runId": run_id,
            "status": status,
            "durationMs": duration_ms,
            "summary": summary,
            "payload": payload,
            "errorMessage": error_message,
            "errorStack": error_stack,
        }
    )
