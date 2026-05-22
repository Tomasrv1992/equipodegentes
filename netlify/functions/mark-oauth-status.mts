// netlify/functions/mark-oauth-status.mts
//
// Marca el oauth_status de un cliente. Útil para detectar invalid_grant
// runtime y reflejarlo en el panel.
//
// Body: { clienteSlug, status: "connected"|"expired"|"revoked" }

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const status = body.status;
  const allowed = ["connected", "expired", "revoked"];
  if (!clienteSlug || !allowed.includes(status)) return new Response("missing params", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const { error } = await supa
    .from("client_credentials")
    .update({ google_oauth_status: status, updated_at: new Date().toISOString() })
    .eq("cliente_id", (cli as any).id)
    .eq("agente_id", "facturacion");

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  return new Response(JSON.stringify({ ok: true, cliente: clienteSlug, status }), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
