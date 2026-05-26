// Endpoint diagnostico: ver y borrar invoice_consecutivo_locks de un cliente
// Body: { clienteSlug, delete?: boolean }

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const shouldDelete = body.delete === true;
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();

  // Leer rows actuales
  const { data: rows, error: readErr } = await supa
    .from("invoice_consecutivo_locks")
    .select("*")
    .eq("cliente_slug", clienteSlug);

  if (readErr) {
    return new Response(JSON.stringify({ error: readErr.message, hint: "tabla puede no existir" }), { status: 500 });
  }

  let deleteResult: any = null;
  if (shouldDelete) {
    const { error: delErr } = await supa
      .from("invoice_consecutivo_locks")
      .delete()
      .eq("cliente_slug", clienteSlug);
    deleteResult = { ok: !delErr, error: delErr?.message ?? null };
  }

  return new Response(
    JSON.stringify({
      ok: true,
      cliente: clienteSlug,
      rows_count: rows?.length ?? 0,
      rows: rows ?? [],
      deleted: shouldDelete ? deleteResult : "no_delete_requested",
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
