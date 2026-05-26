// netlify/functions/clientes-list.mts
//
// Lista TODOS los clientes con su slug, nombre, oauth_status, first_run_done.
// Solo lectura.

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const supa = getServerClient();
  const { data: clientes } = await supa
    .from("clientes")
    .select("id, slug, nombre, activo")
    .order("created_at", { ascending: true });

  const { data: creds } = await supa
    .from("client_credentials")
    .select("cliente_id, agente_id, google_oauth_status, first_run_done, drive_folder_id, sheet_id");

  const credsByClient: Record<string, any> = {};
  for (const c of (creds ?? []) as any[]) {
    if (c.agente_id === "facturacion") credsByClient[c.cliente_id] = c;
  }

  const out = (clientes ?? []).map((c: any) => ({
    slug: c.slug,
    nombre: c.nombre,
    activo: c.activo,
    oauth_status: credsByClient[c.id]?.google_oauth_status ?? "no-cred",
    first_run_done: credsByClient[c.id]?.first_run_done ?? null,
    has_drive: !!credsByClient[c.id]?.drive_folder_id,
    has_sheet: !!credsByClient[c.id]?.sheet_id,
  }));

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
