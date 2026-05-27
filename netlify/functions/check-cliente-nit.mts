// Verifica nit_cliente y nombre del cliente en BD
import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id, slug, nombre").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const { data: cred } = await supa
    .from("client_credentials")
    .select("nit_cliente, retention_rules, municipio_ica")
    .eq("cliente_id", (cli as any).id)
    .eq("agente_id", "facturacion")
    .single();

  return new Response(JSON.stringify({ cliente: cli, creds_fiscales: cred }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
