// netlify/functions/inspect-run-detail.mts
//
// Devuelve detalle COMPLETO de un run específico, incluyendo error_message
// y payload entero. Para diagnóstico de preflight fails.

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const limit = Number(body.limit) || 3;

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const { data, error } = await supa
    .from("agent_runs")
    .select("id, status, started_at, summary, error_message, payload, triggered_by")
    .eq("cliente_id", (cli as any).id)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
