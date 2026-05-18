// netlify/functions/dedupe-sheet-background.mts
//
// EMERGENCIA: cuando el Sheet acumuló filas duplicadas por el bug del
// reparador (A2:O1000 truncaba lectura → re-insertaba filas >1000 como
// si faltaran). Sheet de Freshco enero quedó con 1647 facturas únicas
// pero 2894 filas físicas con datos.
//
// Estrategia: por cada pestaña indicada (o todas), leer paginado, agrupar
// filas por numeroDIAN (col E) y para cada grupo conservar la PRIMERA fila
// y marcar el resto para borrar. Luego renumera consecutivos (col A) para
// que queden 1..N consecutivos sin gaps.
//
// Body: { clienteSlug: string, tabs?: string[], dryRun?: boolean }
//   - tabs: opcional, si no se pasa procesa TODAS las pestañas de meses
//   - dryRun: opcional, si true solo reporta sin tocar Sheet
//
// Idempotente: si no hay duplicados, no toca nada.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

interface RequestBody {
  clienteSlug: string;
  tabs?: string[];
  dryRun?: boolean;
}

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const COL_NUMERO_DOCUMENTO = 4; // E = índice 4 (0-based)

async function loadAllSheetRows(
  sheets: any,
  spreadsheetId: string,
  tabName: string,
): Promise<any[][]> {
  const PAGE = 1000;
  const MAX_ROWS = 100_000;
  const all: any[][] = [];
  let from = 2;
  while (from < MAX_ROWS + 2) {
    const to = from + PAGE - 1;
    let batch: any[][] = [];
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A${from}:O${to}`,
      });
      batch = (resp.data.values ?? []) as any[][];
    } catch {
      break;
    }
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return all;
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
  const dryRun = body.dryRun === true;
  const tabsToProcess = body.tabs && body.tabs.length > 0 ? body.tabs : MES_TABS;

  console.log(`[dedupe-sheet] cliente=${clienteSlug} dryRun=${dryRun} tabs=${tabsToProcess.join(",")}`);

  const supa = getServerClient();
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
    // Cargar metadata para sheetId de cada pestaña
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: cred.sheet_id,
      fields: "sheets(properties(sheetId,title))",
    });
    const tabIdByName = new Map<string, number>();
    for (const s of meta.data.sheets ?? []) {
      if (s.properties?.title && s.properties.sheetId != null) {
        tabIdByName.set(s.properties.title, s.properties.sheetId);
      }
    }

    const report: Array<{
      tab: string;
      filas_leidas: number;
      filas_unicas: number;
      duplicados_borrados: number;
      filas_sin_numero: number;
      sample_dups: string[];
    }> = [];

    for (const tabName of tabsToProcess) {
      const tabSheetId = tabIdByName.get(tabName);
      if (tabSheetId == null) {
        console.log(`[dedupe-sheet] ${tabName}: tab no existe, skip`);
        continue;
      }

      // Leer todas las filas paginadas
      const rows = await loadAllSheetRows(sheets, cred.sheet_id, tabName);
      if (rows.length === 0) {
        report.push({
          tab: tabName,
          filas_leidas: 0,
          filas_unicas: 0,
          duplicados_borrados: 0,
          filas_sin_numero: 0,
          sample_dups: [],
        });
        continue;
      }

      // Agrupar por numeroDIAN — primera ocurrencia gana, resto se borra
      const firstByNumero = new Map<string, number>(); // numero → rowIdx (0-based en rows)
      const rowsToDelete: number[] = []; // sheetRow 1-based (incluye header)
      const sampleDups: string[] = [];
      let sinNumero = 0;

      for (let i = 0; i < rows.length; i++) {
        const numero = String(rows[i][COL_NUMERO_DOCUMENTO] ?? "").trim();
        const sheetRow = i + 2; // row 2 = primera factura, row N+1 = N-th factura
        if (!numero) {
          sinNumero++;
          continue;
        }
        if (firstByNumero.has(numero)) {
          rowsToDelete.push(sheetRow);
          if (sampleDups.length < 5) sampleDups.push(numero);
        } else {
          firstByNumero.set(numero, i);
        }
      }

      console.log(
        `[dedupe-sheet] ${tabName}: leidas=${rows.length} unicas=${firstByNumero.size} dup=${rowsToDelete.length} sin_num=${sinNumero}`,
      );

      if (!dryRun && rowsToDelete.length > 0) {
        // Borrar de mayor a menor para que los índices no se desplacen
        rowsToDelete.sort((a, b) => b - a);
        // Agrupar índices consecutivos en deleteDimension batch
        const requests: any[] = [];
        let runStart = rowsToDelete[0];
        let runEnd = runStart;
        for (let k = 1; k < rowsToDelete.length; k++) {
          const r = rowsToDelete[k];
          if (r === runEnd - 1) {
            runEnd = r;
          } else {
            requests.push({
              deleteDimension: {
                range: {
                  sheetId: tabSheetId,
                  dimension: "ROWS",
                  startIndex: runEnd - 1, // 0-based, inclusive
                  endIndex: runStart, // 0-based, exclusive (sheetRow N → endIndex N)
                },
              },
            });
            runStart = r;
            runEnd = r;
          }
        }
        // Último run
        requests.push({
          deleteDimension: {
            range: {
              sheetId: tabSheetId,
              dimension: "ROWS",
              startIndex: runEnd - 1,
              endIndex: runStart,
            },
          },
        });

        // Ejecutar en batches de 100 (límite seguro de batchUpdate)
        const BATCH = 100;
        for (let i = 0; i < requests.length; i += BATCH) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: cred.sheet_id,
            requestBody: { requests: requests.slice(i, i + BATCH) },
          });
        }
        console.log(`[dedupe-sheet] ${tabName}: ${rowsToDelete.length} filas duplicadas borradas`);

        // Renumerar consecutivos (col A) — leer de nuevo y reescribir
        const rowsAfter = await loadAllSheetRows(sheets, cred.sheet_id, tabName);
        const newConsecutivos = rowsAfter.map((_r, idx) => [idx + 1]);
        if (newConsecutivos.length > 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: cred.sheet_id,
            range: `'${tabName}'!A2:A${1 + newConsecutivos.length}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: newConsecutivos },
          });
          console.log(`[dedupe-sheet] ${tabName}: ${newConsecutivos.length} consecutivos renumerados`);
        }
      }

      report.push({
        tab: tabName,
        filas_leidas: rows.length,
        filas_unicas: firstByNumero.size,
        duplicados_borrados: dryRun ? 0 : rowsToDelete.length,
        filas_sin_numero: sinNumero,
        sample_dups: sampleDups,
      });
    }

    const totalDups = report.reduce((s, r) => s + r.duplicados_borrados, 0);
    console.log(`[dedupe-sheet] TOTAL duplicados borrados: ${totalDups} dryRun=${dryRun}`);

    return new Response(
      JSON.stringify({
        ok: true,
        cliente: clienteSlug,
        dryRun,
        total_duplicados_borrados: totalDups,
        report,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err: any) {
    console.error(`[dedupe-sheet] fatal: ${err.message}`);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const config: Config = {};
