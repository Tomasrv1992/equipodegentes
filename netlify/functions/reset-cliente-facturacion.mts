// netlify/functions/reset-cliente-facturacion.mts
//
// Resetea un cliente para reonboarding limpio:
//   1. Borra agent_events (tipo=factura_procesada) del cliente
//   2. Resetea client_credentials.facturacion:
//        - first_run_done = false
//        - google_oauth_status = 'pending'
//        - drive_folder_id = null
//        - sheet_id = null
//        - google_refresh_token = null (forzar OAuth nuevo)
//
// NO toca agent_runs (preservamos histórico de fallas).
//
// Body: { clienteSlug }
// Devuelve count de filas afectadas + estado final.

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
    .select("id, slug, nombre")
    .eq("slug", clienteSlug)
    .single();
  if (!cli) return new Response(`cliente "${clienteSlug}" not found`, { status: 404 });
  const clienteId = (cli as any).id as string;

  // 1) Borrar agent_events
  const { count: eventsBefore } = await supa
    .from("agent_events")
    .select("*", { count: "exact", head: true })
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion");

  const { error: delErr } = await supa
    .from("agent_events")
    .delete()
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion");

  if (delErr) {
    return new Response(JSON.stringify({ error: `delete events failed: ${delErr.message}` }), { status: 500 });
  }

  // 1.5) Borrar consecutivo locks (resetea contador a 1 para próximo run)
  //
  //   Sin esto, el consecutivo asignado en Sheet/Drive arranca desde el
  //   último número usado en runs anteriores (caso Dentilandia: empezó en
  //   326 porque pruebas previas subieron el contador).
  //
  //   Tabla `invoice_consecutivo_locks` guarda { cliente_slug, tab_name,
  //   next_consecutivo }. Al borrar las rows, RPC get_next_consecutivo
  //   crea nueva entrada empezando en 1.
  try {
    await supa
      .from("invoice_consecutivo_locks")
      .delete()
      .eq("cliente_slug", clienteSlug);
  } catch (e: any) {
    console.warn(`[reset] no se borraron consecutivo_locks (no-fatal): ${e.message}`);
  }

  // 1.6) Borrar dispatch_lock (liberar lock atómico si quedó tomado)
  try {
    await supa
      .from("dispatch_locks")
      .delete()
      .eq("cliente_id", clienteId);
  } catch (e: any) {
    console.warn(`[reset] no se borró dispatch_lock (no-fatal): ${e.message}`);
  }

  // 2) Resetear client_credentials
  const { error: updErr } = await supa
    .from("client_credentials")
    .update({
      first_run_done: false,
      google_oauth_status: "pending",
      drive_folder_id: null,
      drive_folder_name: null,
      sheet_id: null,
      sheet_name: null,
      google_refresh_token_encrypted: null,
      updated_at: new Date().toISOString(),
    })
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion");

  if (updErr) {
    return new Response(JSON.stringify({ error: `update creds failed: ${updErr.message}` }), { status: 500 });
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        cliente: (cli as any).slug,
        nombre: (cli as any).nombre,
        events_borrados: eventsBefore ?? 0,
        credenciales_reseteadas: true,
        siguiente_paso:
          "1) Borra Drive folder + Sheet en Google. 2) Borra label 'Procesado' en Gmail. 3) Crea link onboarding nuevo en /admin. 4) Cliente sigue el flow.",
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
