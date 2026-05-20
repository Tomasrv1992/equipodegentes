// netlify/functions/inspect-runs.mts
// Devuelve los últimos N agent_runs de un cliente

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const limit = Math.min(20, Number(body.limit) || 10);

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const { data, error } = await supa
    .from("agent_runs")
    .select("id, status, started_at, ended_at, summary, payload->procesadas, payload->errores, payload->saltadas, payload->repetidas, triggered_by")
    .eq("cliente_id", (cli as any).id)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const runs = (data ?? []).map((r: any) => ({
    id: r.id,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_min: r.started_at && r.ended_at
      ? Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 6000) / 10
      : null,
    triggered_by: r.triggered_by,
    procesadas: Array.isArray(r.procesadas) ? r.procesadas.length : (r.procesadas ?? 0),
    errores: Array.isArray(r.errores) ? r.errores.length : (r.errores ?? 0),
    saltadas: Array.isArray(r.saltadas) ? r.saltadas.length : (r.saltadas ?? 0),
    repetidas: Array.isArray(r.repetidas) ? r.repetidas.length : (r.repetidas ?? 0),
    summary: r.summary,
  }));

  return new Response(JSON.stringify(runs, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
