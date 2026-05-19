// netlify/functions/inspect-sheet.mts
//
// Endpoint SÍNCRONO (no background) que devuelve estado de un Sheet:
//   - Total filas físicas del tab
//   - Filas con datos (col E no vacía)
//   - Último consecutivo en col A
//   - Filas sin numero (col E vacía)
//   - Top numeros duplicados (mismo numero+proveedor)
//
// Sirve para que cualquier proceso (humano, agente, scripts) pueda VERIFICAR
// el estado del sheet sin esperar background functions. Timeout 10s estándar
// de Netlify functions.
//
// Body: { clienteSlug: string, tabs?: string[] }
//   - tabs: opcional, default ["Enero"..."Diciembre"]
// Auth: x-internal-secret header con FACTURACION_INTERNAL_SECRET.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const COL_NUMERO = 4;     // E
const COL_PROVEEDOR = 2;  // C
const COL_CONSECUTIVO = 0; // A

interface TabInspection {
  tab: string;
  filas_fisicas: number;        // gridProperties.rowCount
  filas_con_datos: number;       // rows con col E no vacía
  ultimo_consecutivo: number;    // max(col A)
  filas_sin_numero: number;
  duplicados_top: Array<{ numero: string; proveedor: string; count: number }>;
}

interface InspectResponse {
  ok: boolean;
  cliente: string;
  ts: string;
  tabs: TabInspection[];
  resumen: {
    total_filas_fisicas: number;
    total_filas_con_datos: number;
    total_duplicados: number;
    total_sin_numero: number;
  };
}

async function inspectTab(
  sheets: any,
  spreadsheetId: string,
  tabName: string,
  rowCount: number,
): Promise<TabInspection> {
  // Lectura paginada (max 50k para no timeoutear si hay sheet gigante)
  const PAGE = 5000;
  const MAX = 50_000;
  let from = 2;
  const allRows: any[][] = [];
  while (from <= Math.min(rowCount, MAX + 1)) {
    const to = Math.min(from + PAGE - 1, rowCount);
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
    allRows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }

  let ultimoConsecutivo = 0;
  let filasSinNumero = 0;
  let filasConDatos = 0;
  const dupGroups = new Map<string, { numero: string; proveedor: string; count: number }>();

  for (const r of allRows) {
    const numero = String(r[COL_NUMERO] ?? "").trim();
    const proveedor = String(r[COL_PROVEEDOR] ?? "").trim();
    const consecRaw = String(r[COL_CONSECUTIVO] ?? "").trim();
    const consec = parseInt(consecRaw, 10);
    if (!isNaN(consec) && consec > ultimoConsecutivo) ultimoConsecutivo = consec;

    if (!numero) {
      if (proveedor || consecRaw) filasSinNumero++;
      continue;
    }
    filasConDatos++;
    const key = `${numero}|${proveedor.toLowerCase()}`;
    const g = dupGroups.get(key);
    if (g) {
      g.count++;
    } else {
      dupGroups.set(key, { numero, proveedor, count: 1 });
    }
  }

  const duplicadosTop = Array.from(dupGroups.values())
    .filter((d) => d.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    tab: tabName,
    filas_fisicas: rowCount,
    filas_con_datos: filasConDatos,
    ultimo_consecutivo: ultimoConsecutivo,
    filas_sin_numero: filasSinNumero,
    duplicados_top: duplicadosTop,
  };
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { clienteSlug?: string; tabs?: string[] };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const clienteSlug = body.clienteSlug?.trim();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });
  const tabsToInspect = body.tabs && body.tabs.length > 0 ? body.tabs : MES_TABS;

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
    // Metadata de TODAS las pestañas (rowCount, sheetId)
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: cred.sheet_id,
      fields: "sheets(properties(title,gridProperties))",
    });
    const tabMeta = new Map<string, number>();
    for (const s of meta.data.sheets ?? []) {
      const t = s.properties?.title;
      const rc = s.properties?.gridProperties?.rowCount ?? 0;
      if (t) tabMeta.set(t, rc);
    }

    const inspections: TabInspection[] = [];
    for (const tabName of tabsToInspect) {
      const rc = tabMeta.get(tabName);
      if (rc == null) continue; // tab no existe
      inspections.push(await inspectTab(sheets, cred.sheet_id, tabName, rc));
    }

    const resumen = {
      total_filas_fisicas: inspections.reduce((s, t) => s + t.filas_fisicas, 0),
      total_filas_con_datos: inspections.reduce((s, t) => s + t.filas_con_datos, 0),
      total_duplicados: inspections.reduce(
        (s, t) => s + t.duplicados_top.reduce((a, d) => a + (d.count - 1), 0),
        0,
      ),
      total_sin_numero: inspections.reduce((s, t) => s + t.filas_sin_numero, 0),
    };

    const response: InspectResponse = {
      ok: true,
      cliente: clienteSlug,
      ts: new Date().toISOString(),
      tabs: inspections,
      resumen,
    };

    return new Response(JSON.stringify(response, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const config: Config = {};
