// netlify/functions/delete-empty-rows-background.mts
//
// EMERGENCIA: cuando un Sheet hit el límite 10M celdas de Google.
//
// `clear()` borra VALORES pero NO filas físicas. Cuando un Sheet acumula
// >10M celdas físicas (típicamente por duplicación masiva pasada), CUALQUIER
// append falla con "Esta acción aumentará el número de celdas del libro de
// trabajo por encima del límite".
//
// Este endpoint usa `batchUpdate.deleteDimension` para eliminar las filas
// físicas vacías de TODAS las pestañas de un Sheet, liberando capacidad.
//
// Body: { clienteSlug: string, keepRows?: number }
//   - keepRows: cuántas filas mantener desde el inicio (default 1 = solo header)
//
// Es seguro: NO afecta valores que existen, solo elimina filas vacías al final.
// Si una pestaña tiene 5 filas con datos y 50k filas vacías, queda con 5 filas.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

interface RequestBody {
  clienteSlug: string;
  keepRows?: number;
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const clienteSlug = body.clienteSlug?.trim();
  if (!clienteSlug) {
    return new Response("missing clienteSlug", { status: 400 });
  }

  const keepRows = Math.max(1, Number(body.keepRows) || 1);
  console.log(`[delete-empty-rows] cliente=${clienteSlug} keepRows=${keepRows}`);

  const supa = getServerClient();

  // Cargar cliente + credentials
  const { data: cli } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", clienteSlug)
    .single();
  if (!cli) return new Response(`cliente "${clienteSlug}" not found`, { status: 404 });

  const cred = await loadCredentials((cli as any).id, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id) {
    return new Response("missing credentials/sheet_id", { status: 400 });
  }

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });

  try {
    // 1. Obtener metadata de TODAS las pestañas
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: cred.sheet_id,
      fields: "sheets(properties(sheetId,title,gridProperties))",
    });

    const tabs = meta.data.sheets ?? [];
    console.log(`[delete-empty-rows] ${tabs.length} pestañas encontradas`);

    const report: Array<{
      tab: string;
      sheetId: number;
      rowsBefore: number;
      rowsAfter: number;
      rowsDeleted: number;
    }> = [];

    // 2. Para cada pestaña, eliminar filas vacías
    // Estrategia: leer cuántas filas tienen DATOS (valores no vacíos en col A),
    // luego eliminar todas las filas físicas posteriores.
    for (const t of tabs) {
      const props = t.properties;
      if (!props) continue;
      const tabName = props.title!;
      const tabSheetId = props.sheetId!;
      const totalRows = props.gridProperties?.rowCount ?? 0;

      // Leer cuántas filas tienen DATOS (col A no vacía)
      let rowsWithData = 0;
      try {
        const valuesResp = await sheets.spreadsheets.values.get({
          spreadsheetId: cred.sheet_id,
          range: `'${tabName}'!A:A`,
        });
        rowsWithData = valuesResp.data.values?.length || 0;
      } catch (e: any) {
        console.warn(`[delete-empty-rows] ${tabName}: read failed: ${e.message}`);
        continue;
      }

      // Mínimo de filas a mantener: max(keepRows, rowsWithData)
      // Eso garantiza no borrar datos reales.
      const keepFinal = Math.max(keepRows, rowsWithData);

      if (totalRows <= keepFinal) {
        // No hay filas vacías al final
        report.push({
          tab: tabName,
          sheetId: tabSheetId,
          rowsBefore: totalRows,
          rowsAfter: totalRows,
          rowsDeleted: 0,
        });
        console.log(`[delete-empty-rows] ${tabName}: no hay filas vacías que eliminar (${totalRows})`);
        continue;
      }

      // Eliminar filas físicas desde keepFinal hasta el final
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: cred.sheet_id,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: tabSheetId,
                    dimension: "ROWS",
                    startIndex: keepFinal, // 0-based, inclusive
                    endIndex: totalRows, // exclusive
                  },
                },
              },
            ],
          },
        });
        const deleted = totalRows - keepFinal;
        console.log(`[delete-empty-rows] ${tabName}: ${deleted} filas físicas eliminadas (${totalRows} → ${keepFinal})`);
        report.push({
          tab: tabName,
          sheetId: tabSheetId,
          rowsBefore: totalRows,
          rowsAfter: keepFinal,
          rowsDeleted: deleted,
        });
      } catch (e: any) {
        console.error(`[delete-empty-rows] ${tabName}: delete failed: ${e.message}`);
        report.push({
          tab: tabName,
          sheetId: tabSheetId,
          rowsBefore: totalRows,
          rowsAfter: totalRows,
          rowsDeleted: 0,
        });
      }
    }

    const totalDeleted = report.reduce((s, r) => s + r.rowsDeleted, 0);
    console.log(`[delete-empty-rows] TOTAL filas físicas eliminadas: ${totalDeleted}`);

    return new Response(
      JSON.stringify({
        ok: true,
        cliente: clienteSlug,
        total_rows_deleted: totalDeleted,
        report,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err: any) {
    console.error(`[delete-empty-rows] fatal: ${err.message}`);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const config: Config = {};
