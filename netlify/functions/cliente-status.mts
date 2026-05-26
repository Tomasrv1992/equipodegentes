// netlify/functions/cliente-status.mts
//
// Devuelve estado completo de un cliente: slug, credenciales (OAuth status,
// drive_folder_id, sheet_id, first_run_done), conteo agent_events, agent_runs.
// Diagnóstico previo a operaciones destructivas (reonboarding, reset).
//
// Body: { clienteSlug }

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa
    .from("clientes")
    .select("id, slug, nombre, created_at")
    .eq("slug", clienteSlug)
    .single();
  if (!cli) return new Response(`cliente "${clienteSlug}" not found`, { status: 404 });
  const clienteId = (cli as any).id as string;

  // Credenciales
  const { data: creds } = await supa
    .from("client_credentials")
    .select("agente_id, google_oauth_status, drive_folder_id, drive_folder_name, sheet_id, sheet_name, first_run_done, onboarded_at, updated_at")
    .eq("cliente_id", clienteId);

  // Total agent_events
  const { count: eventsCount } = await supa
    .from("agent_events")
    .select("*", { count: "exact", head: true })
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion");

  // Últimos 5 runs
  const { data: lastRuns } = await supa
    .from("agent_runs")
    .select("id, status, started_at, finished_at, summary, triggered_by")
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion")
    .order("started_at", { ascending: false })
    .limit(5);

  return new Response(
    JSON.stringify(
      {
        cliente: cli,
        credenciales: creds,
        agent_events_total: eventsCount ?? 0,
        ultimos_runs: lastRuns ?? [],
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
