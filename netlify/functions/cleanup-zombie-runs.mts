// netlify/functions/cleanup-zombie-runs.mts
//
// Marca como 'fail' runs en status='running' cuya started_at > 16 min atrás
// (Netlify background timeout = 15min, +1min margen). Esos records quedaron
// sin actualizar porque el proceso murió por timeout pero recordRunEnd nunca
// se llamó.
//
// Body: { clienteSlug? }  (si omite, limpia todos los clientes)

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const clienteSlug = body.clienteSlug?.trim();

  const supa = getServerClient();

  let clienteId: string | null = null;
  if (clienteSlug) {
    const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
    if (!cli) return new Response("cliente not found", { status: 404 });
    clienteId = (cli as any).id;
  }

  const cutoff = new Date(Date.now() - 16 * 60 * 1000).toISOString();

  let q = supa
    .from("agent_runs")
    .update({
      status: "fail",
      finished_at: new Date().toISOString(),
      summary: "zombie cleanup: proceso murio por timeout sin recordRunEnd",
      error_message: "Marcado fail por cleanup-zombie-runs (running > 16min sin update)",
    })
    .eq("status", "running")
    .lt("started_at", cutoff);

  if (clienteId) q = q.eq("cliente_id", clienteId);

  const { data, error } = await q.select("id");

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  return new Response(
    JSON.stringify({ ok: true, cliente: clienteSlug ?? "all", zombies_cleaned: data?.length ?? 0 }),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
