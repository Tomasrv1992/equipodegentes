// netlify/functions/renumber-sheet-only.mts
//
// Renumera columna A de TODOS los meses con datos (consecutivos 1, 2, 3...).
// Actualiza invoice_consecutivo_locks. Operación SOLO sobre Sheet + BD locks.
// NO toca Drive.
//
// Body: { clienteSlug }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const cred = await loadCredentials(clienteId, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id) {
    return new Response("missing creds", { status: 400 });
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });

  const reporte: any = {
    cliente: clienteSlug,
    meses_renumerados: [] as any[],
    errores: [] as string[],
  };

  for (let mIdx = 0; mIdx < 12; mIdx++) {
    const tabName = MES_TABS[mIdx];
    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: cred.sheet_id,
        range: `'${tabName}'!A2:O1000`,
      });
      const rows = r.data.values || [];
      // Considerar filas con datos: col E (numero) o col C (proveedor) no vacíos
      const rowsConDatos = rows.filter((row) => (row[2] && row[2].toString().trim()) || (row[4] && row[4].toString().trim()));
      if (rowsConDatos.length === 0) continue;

      // Renumerar col A
      const newValues: any[][] = rowsConDatos.map((_, i) => [i + 1]);
      await sheets.spreadsheets.values.update({
        spreadsheetId: cred.sheet_id,
        range: `'${tabName}'!A2:A${rowsConDatos.length + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: newValues },
      });

      // Actualizar counter
      await supa
        .from("invoice_consecutivo_locks")
        .upsert(
          { cliente_slug: clienteSlug, tab_name: tabName, consecutivo: rowsConDatos.length },
          { onConflict: "cliente_slug,tab_name" },
        );

      reporte.meses_renumerados.push({
        tab: tabName,
        filas: rowsConDatos.length,
      });
    } catch (e: any) {
      reporte.errores.push(`${tabName}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify(reporte, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
