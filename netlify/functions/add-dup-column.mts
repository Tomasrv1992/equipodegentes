// netlify/functions/add-dup-column.mts
//
// Agrega columna "Veces Repetido" en una pestaña del Sheet con formula
// =COUNTIF(E:E, E2) para detectar duplicados por # Documento.
//
// Body: { clienteSlug, year?, monthsToProcess?: number[] }
// Si monthsToProcess omitido, procesa todos los meses con datos (1-12).

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
  const monthsToProcess: number[] | undefined = body.monthsToProcess;
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const cred = await loadCredentials((cli as any).id, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id) {
    return new Response("missing refresh_token o sheet_id", { status: 400 });
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });

  // Determinar qué pestañas procesar
  const monthsList = monthsToProcess && monthsToProcess.length > 0
    ? monthsToProcess
    : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  // Primero, leer metadata de pestañas para identificar IDs y expandir a 16 cols
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: cred.sheet_id,
    fields: "sheets(properties(sheetId,title,gridProperties))",
  });
  const sheetByTitle = new Map<string, any>();
  for (const s of meta.data.sheets ?? []) {
    if (s.properties?.title) sheetByTitle.set(s.properties.title, s.properties);
  }

  const results: any[] = [];
  for (const m of monthsList) {
    if (m < 1 || m > 12) continue;
    const tab = MES_TABS[m - 1];
    try {
      // Expandir grid a 16 columnas si está en 15
      const props = sheetByTitle.get(tab);
      if (props && (props.gridProperties?.columnCount ?? 0) < 16) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: cred.sheet_id,
          requestBody: {
            requests: [{
              updateSheetProperties: {
                properties: {
                  sheetId: props.sheetId,
                  gridProperties: { columnCount: 16 },
                },
                fields: "gridProperties.columnCount",
              },
            }],
          },
        });
      }

      // Leer columna A para saber cuántas filas tienen datos
      const colA = await sheets.spreadsheets.values.get({
        spreadsheetId: cred.sheet_id,
        range: `'${tab}'!A1:A1000`,
      });
      const aRows = colA.data.values || [];
      // Encontrar última fila con datos
      let lastRow = 0;
      for (let i = aRows.length - 1; i >= 0; i--) {
        if (aRows[i]?.[0]) {
          lastRow = i + 1; // 1-indexed
          break;
        }
      }

      if (lastRow < 2) {
        results.push({ tab, skipped: "sin datos" });
        continue;
      }

      // Header en P1
      // Formulas en P2:P{lastRow}
      const values: any[][] = [["Veces Repetido"]];
      for (let row = 2; row <= lastRow; row++) {
        values.push([`=COUNTIF($E$2:$E$${lastRow}, E${row})`]);
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: cred.sheet_id,
        range: `'${tab}'!P1:P${lastRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });

      results.push({ tab, filas_procesadas: lastRow - 1, formula_added: true });
    } catch (e: any) {
      results.push({ tab, error: e.message });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, cliente: clienteSlug, results }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
