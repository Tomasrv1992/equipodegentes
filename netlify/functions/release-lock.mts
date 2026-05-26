// netlify/functions/release-lock.mts
// Borra el dispatch_lock de un cliente. Util para limpiar estado raro.
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
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const { error } = await supa
    .from("dispatch_locks")
    .delete()
    .eq("cliente_id", (cli as any).id);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  return new Response(JSON.stringify({ ok: true, cliente: clienteSlug, lock_released: true }), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
