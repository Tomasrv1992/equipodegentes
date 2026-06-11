// netlify/functions/inspect-backfill-report.mts
//
// Lee el último reporte de backfill-messageid-background dryRun guardado
// en reconcile_dumps. Sync (responde directo, sin sufijo -background).
//
// Body: { clienteSlug, year? }

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || new Date().getFullYear();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  // Buscar el ÚLTIMO reporte de backfill para este cliente/año
  const { data, error } = await supa
    .from("reconcile_dumps")
    .select("id, year, created_at, before_state")
    .eq("cliente_id", clienteId)
    .eq("year", year)
    .filter("before_state->>kind", "eq", "backfill_dryrun_report")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  if (!data || data.length === 0) {
    return new Response(JSON.stringify({
      ok: false,
      error: "No hay reporte de backfill todavía. Disparar backfill-messageid-background con dryRun:true primero.",
    }, null, 2), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    report_id: data[0].id,
    created_at: data[0].created_at,
    report: data[0].before_state,
  }, null, 2), { headers: { "content-type": "application/json" } });
};

export const config: Config = {};
