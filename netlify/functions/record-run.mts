// Endpoint HTTP que agentes en runtimes no-TS (ej Python) usan para
// reportar inicio/fin de un run a Supabase.
//
// Auth: header x-internal-secret == FACTURACION_INTERNAL_SECRET
// (reusamos el mismo secret que el cron-background).

import type { Config } from "@netlify/functions";
import {
  recordRunStart,
  recordRunEnd,
} from "../../shared/agents-runtime/src/record-run";

interface StartBody {
  action: "start";
  clienteSlug: string;
  agenteId: string;
  triggeredBy?: "cron" | "manual" | "rerun";
}

interface EndBody {
  action: "end";
  runId: string;
  status: "ok" | "fail" | "warn";
  durationMs: number;
  summary?: string;
  payload?: unknown;
  errorMessage?: string;
  errorStack?: string;
}

type Body = StartBody | EndBody;

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  try {
    if (body.action === "start") {
      const runId = await recordRunStart({
        clienteSlug: body.clienteSlug,
        agenteId: body.agenteId,
        triggeredBy: body.triggeredBy,
      });
      return new Response(JSON.stringify({ runId }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (body.action === "end") {
      await recordRunEnd({
        runId: body.runId,
        status: body.status,
        durationMs: body.durationMs,
        summary: body.summary,
        payload: body.payload,
        error: body.errorMessage
          ? { message: body.errorMessage, stack: body.errorStack }
          : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("invalid action", { status: 400 });
  } catch (err: any) {
    console.error("record-run error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

export const config: Config = {};
