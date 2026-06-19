/**
 * Auditoría de salud del archivo de un cliente.
 *
 * Compara Sheet vs Gmail (label "Procesado") y detecta:
 *   - Duplicación masiva (filas > emails procesados × 1.1)
 *   - Filas con col D (# Documento) vacía → riesgo de no-dedup
 *   - Numeros de documento repetidos en la misma pestaña
 *   - Mismo numero+proveedor en pestañas distintas (mismo mes)
 *
 * Uso:
 *   npm run facturacion:auditoria -- <clienteSlug>
 *   # o
 *   CLIENTE_SLUG=freshco npx tsx agentes/Equipo-facturacion/scripts/auditoria.ts
 *
 * Necesita las mismas env vars que pipeline.ts:
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (para loadCredentials)
 *   - GOOGLE_OAUTH_WEB_CLIENT_ID, GOOGLE_OAUTH_WEB_CLIENT_SECRET
 *   - CREDENTIALS_VAULT_KEY
 */

import { google } from "googleapis";
import { getServerClient } from "../../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Esquema A:M (13 cols) tras eliminar "#" y "Concepto" (2026-06-18).
// BUG FIX 2026-06-18: estos índices estaban en E(4)/C(2) del esquema VIEJO; tras
// el cambio de esquema el # Documento quedó en col D (idx 3) y Proveedor en col B
// (idx 1). Con los índices viejos auditoria leía Subtotal como "numero" y NIT como
// "proveedor" → reportaba basura (parte de por qué "la base no sirve").
const COL_NUMERO = 3;      // D (0-based) — # Documento
const COL_PROVEEDOR = 1;   // B (0-based) — Proveedor
const PROCESSED_LABEL = "Procesado";

interface NumeroDuplicado {
  numero: string;
  proveedor: string;
  pestanas: string[];
  count: number;
}

interface AuditoriaReport {
  cliente: string;
  fecha_auditoria: string;
  alertas: string[];
  resumen: {
    filas_totales: number;
    emails_procesados: number;
    ratio: number;
    filas_sin_numero: number;
    numeros_duplicados: NumeroDuplicado[];
  };
}

async function loadAllRowsPaginated(
  sheets: any,
  spreadsheetId: string,
  tabName: string,
): Promise<any[][]> {
  const PAGE = 1000;
  const MAX = 100_000;
  const all: any[][] = [];
  let from = 2;
  while (from < MAX + 2) {
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

async function countEmailsProcesados(gmail: any): Promise<number> {
  let total = 0;
  let pageToken: string | undefined;
  do {
    const resp = await gmail.users.messages.list({
      userId: "me",
      q: `label:${PROCESSED_LABEL}`,
      maxResults: 500,
      pageToken,
    });
    total += (resp.data.messages ?? []).length;
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);
  return total;
}

async function main() {
  const clienteSlug = process.argv[2] || process.env.CLIENTE_SLUG;
  if (!clienteSlug) {
    console.error("Uso: npm run facturacion:auditoria -- <clienteSlug>");
    console.error("  o: CLIENTE_SLUG=freshco npx tsx ...");
    process.exit(1);
  }

  console.error(`[auditoria] cliente=${clienteSlug} start`);

  const supa = getServerClient();
  const { data: cli, error: cErr } = await supa
    .from("clientes")
    .select("id, slug, nombre")
    .eq("slug", clienteSlug)
    .single();

  if (cErr || !cli) {
    console.error(`Cliente "${clienteSlug}" no encontrado`);
    process.exit(1);
  }

  const cred = await loadCredentials((cli as any).id, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id) {
    console.error(`Cliente "${clienteSlug}" sin credenciales OAuth o sheet_id`);
    process.exit(1);
  }

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  if (!oauthClientId || !oauthClientSecret) {
    console.error("Faltan GOOGLE_OAUTH_WEB_CLIENT_ID / _SECRET");
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });
  const gmail = google.gmail({ version: "v1", auth });

  // === 1) Leer TODAS las pestañas mensuales ===============================
  const filasPorTab = new Map<string, any[][]>();
  let filasTotales = 0;
  let filasSinNumero = 0;

  for (const tabName of MES_TABS) {
    const rows = await loadAllRowsPaginated(sheets, cred.sheet_id, tabName);
    if (rows.length === 0) continue;
    filasPorTab.set(tabName, rows);
    filasTotales += rows.length;
    for (const r of rows) {
      const num = String(r[COL_NUMERO] ?? "").trim();
      if (!num) filasSinNumero++;
    }
    console.error(`[auditoria] ${tabName}: ${rows.length} filas`);
  }

  // === 2) Contar emails con label Procesado en Gmail ======================
  console.error(`[auditoria] contando emails con label "${PROCESSED_LABEL}"...`);
  const emailsProcesados = await countEmailsProcesados(gmail);
  console.error(`[auditoria] emails procesados: ${emailsProcesados}`);

  // === 3) Detectar numeros duplicados ====================================
  // a) Mismo numero en MISMA pestaña → duplicación clara
  // b) Mismo numero + mismo proveedor en pestañas distintas → sospechoso
  const numerosPorClave = new Map<
    string, // key = `${numero}|${proveedorNorm}`
    { numero: string; proveedor: string; pestanas: Map<string, number> }
  >();

  for (const [tabName, rows] of filasPorTab.entries()) {
    for (const r of rows) {
      const numero = String(r[COL_NUMERO] ?? "").trim();
      const proveedor = String(r[COL_PROVEEDOR] ?? "").trim();
      if (!numero) continue;
      const proveedorNorm = proveedor.toLowerCase().replace(/\s+/g, " ");
      const key = `${numero}|${proveedorNorm}`;
      let entry = numerosPorClave.get(key);
      if (!entry) {
        entry = { numero, proveedor, pestanas: new Map() };
        numerosPorClave.set(key, entry);
      }
      entry.pestanas.set(tabName, (entry.pestanas.get(tabName) ?? 0) + 1);
    }
  }

  const duplicados: NumeroDuplicado[] = [];
  for (const entry of numerosPorClave.values()) {
    const totalOcurrencias = Array.from(entry.pestanas.values()).reduce((a, b) => a + b, 0);
    if (totalOcurrencias > 1) {
      duplicados.push({
        numero: entry.numero,
        proveedor: entry.proveedor,
        pestanas: Array.from(entry.pestanas.keys()),
        count: totalOcurrencias,
      });
    }
  }
  duplicados.sort((a, b) => b.count - a.count);

  // === 4) Construir alertas ===============================================
  const alertas: string[] = [];
  const ratio = emailsProcesados > 0
    ? Math.round((filasTotales / emailsProcesados) * 100) / 100
    : filasTotales > 0 ? Infinity : 0;

  if (emailsProcesados > 0 && filasTotales > emailsProcesados * 1.1) {
    alertas.push(
      `ALERTA DUPLICACIÓN: Sheet tiene ${filasTotales} filas pero solo ${emailsProcesados} emails procesados (ratio ${ratio}×).`,
    );
  }
  if (filasSinNumero > 0) {
    alertas.push(
      `${filasSinNumero} filas SIN # Documento (col D vacía) — riesgo de no-dedup.`,
    );
  }
  if (duplicados.length > 0) {
    const muySospechosos = duplicados.filter((d) => d.count > 2).length;
    alertas.push(
      `${duplicados.length} números duplicados (${muySospechosos} con >2 ocurrencias).`,
    );
  }

  const report: AuditoriaReport = {
    cliente: clienteSlug,
    fecha_auditoria: new Date().toISOString(),
    alertas,
    resumen: {
      filas_totales: filasTotales,
      emails_procesados: emailsProcesados,
      ratio,
      filas_sin_numero: filasSinNumero,
      numeros_duplicados: duplicados.slice(0, 100), // top 100 para no saturar consola
    },
  };

  // Stdout = JSON (parseable). Logs informativos van a stderr arriba.
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(`[auditoria] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
