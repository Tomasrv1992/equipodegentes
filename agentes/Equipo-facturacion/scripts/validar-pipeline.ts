// agentes/Equipo-facturacion/scripts/validar-pipeline.ts
//
// VALIDADOR END-TO-END (single-tenant local) de la base de facturación.
// Lee LAS 3 fuentes físicas en UNA sola pasada (read-only, sin escribir nada):
//   - Gmail   : labels Facturas/<año>, Descartado/<año>, Duplicado/<año>, pendientes
//   - Sheet   : 12 pestañas mensuales, esquema A:M (13 cols)
//   - Drive   : subcarpetas YYYY-MM con los PDFs
//
// y corre los checkpoints deterministas de lib/validar-pipeline-core.ts:
//   CARGA        -> lee todo, sin asumir
//   NORMALIZACIÓN-> mapa de columnas fijo (COL), parseo de montos
//   VALIDACIÓN   -> validarFila por cada fila (alineación, campos, aritmética)
//   DEDUP        -> detectarDuplicados por numero NORMALIZADO entre meses
//   CRUCE        -> cruzarMes: Sheet ⇄ Drive por conjunto + Gmail por conteo
//   DESCARTES    -> remitentes-gasto botados a Descartado (sospechosos)
//   SALIDA       -> veredicto accionable (HALT/WARN/LOG) + exit code
//
// Uso:
//   npx tsx --env-file=.env.local scripts/validar-pipeline.ts [año] [--json]
//
// Exit code: 0 si veredicto OK; 1 si hay HALT/duplicados/huérfanos (para CI/cron).
//
// REGLA: una sola cuenta OAuth — NO correr en paralelo con procesar-facturas.ts.

import { google } from "googleapis";
import {
  COL,
  validarFila,
  detectarDuplicados,
  cruzarMes,
  veredictoFinal,
  parseNumeroFromFilename,
  parseProveedorFromFilename,
  type FilaProblema,
  type FilaRef,
  type CruceMesResult,
} from "../lib/validar-pipeline-core";

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const ATTACH =
  "(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante)";

// Remitentes cuyos correos casi siempre son GASTO de la empresa: si quedaron en
// Descartado, el clasificador probablemente botó un recibo real.
const DOMINIOS_GASTO = [
  "anthropic.com", "openai.com", "google.com", "stripe.com", "paypal.com",
  "amazonaws.com", "amazon.com", "meta.com", "facebook.com", "notion.so",
  "github.com", "microsoft.com", "azure.com", "slack.com", "zoom.us",
  "figma.com", "adobe.com", "dropbox.com", "shopify.com", "vercel.com",
  "netlify.com", "cloudflare.com",
];

async function countQ(gmail: any, q: string): Promise<number> {
  let t = 0;
  let pt: string | undefined;
  do {
    const r: any = await gmail.users.messages.list({ userId: "me", q, maxResults: 500, pageToken: pt });
    t += (r.data.messages ?? []).length;
    pt = r.data.nextPageToken;
  } while (pt);
  return t;
}

/** Conteo de label Facturas/<año> por mes (recepción). */
async function gmailFacturasPorMes(gmail: any, year: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, "0");
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? year + 1 : year;
    const nmm = String(nm).padStart(2, "0");
    const q = `label:Facturas/${year} after:${year}/${mm}/01 before:${ny}/${nmm}/01`;
    out[MESES[m - 1]] = await countQ(gmail, q);
  }
  return out;
}

/** Lee A:M de una pestaña; devuelve filas de DATOS (sin header) con su rowNumber. */
async function leerTab(
  sheets: any,
  sheetId: string,
  tab: string,
): Promise<Array<{ row: any[]; rowNumber: number }>> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab.replace(/'/g, "''")}'!A2:M`,
    // CRÍTICO: valores CRUDOS, no formateados. Sin esto los montos llegan como
    // "$643.500" (texto) → 1.400+ falsos "monto-como-texto"; con esto llegan como
    // número JS (643500) y la fecha como serial (ej 46098), que validarFila acepta.
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values ?? []) as any[][];
  return rows
    .map((row, i) => ({ row, rowNumber: i + 2 })) // +2: header en 1, datos desde 2
    .filter(({ row }) => row?.some((c) => String(c ?? "").trim() !== ""));
}

/** Lista filenames de PDFs de la subcarpeta YYYY-MM. [] si no existe. */
async function driveFilenamesMes(
  drive: any,
  parentId: string,
  year: number,
  month: number,
): Promise<string[]> {
  const name = `${year}-${String(month).padStart(2, "0")}`;
  const folder = await drive.files.list({
    q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
  });
  const folderId = folder.data.files?.[0]?.id;
  if (!folderId) return [];
  const out: string[] = [];
  let pt: string | undefined;
  do {
    const r: any = await drive.files.list({
      // TODOS los documentos (no solo PDF): las cuentas de cobro se archivan como
      // .docx/.xlsx además de .pdf. Filtrar solo PDF las marcaba como "sin PDF"
      // (falso huérfano). Excluimos subcarpetas.
      q: `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      fields: "nextPageToken,files(name)",
      pageSize: 1000,
      pageToken: pt,
    });
    out.push(...(r.data.files ?? []).map((f: any) => String(f.name ?? "")));
    pt = r.data.nextPageToken;
  } while (pt);
  return out;
}

async function main() {
  const year = Number(process.argv[2]) || new Date().getFullYear();
  const asJson = process.argv.includes("--json");

  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth });
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  const sheetId = process.env.INVOICES_SHEET_ID!;
  const folderId = process.env.INVOICES_DRIVE_FOLDER_ID!;
  const me = await gmail.users.getProfile({ userId: "me" });

  // ===== CHECKPOINT: CARGA + VALIDACIÓN POR FILA + DEDUP =====
  const todasLasFilas: FilaRef[] = [];
  const problemasFila: FilaProblema[] = [];
  const cruces: CruceMesResult[] = [];
  const filasPorMes: Record<string, number> = {};

  const gmailFacturas = await gmailFacturasPorMes(gmail, year);

  for (let m = 1; m <= 12; m++) {
    const tab = MESES[m - 1];
    let filas: Array<{ row: any[]; rowNumber: number }> = [];
    try {
      filas = await leerTab(sheets, sheetId, tab);
    } catch (e: any) {
      // Pestaña inexistente o error de rango: 0 filas para ese mes.
      filas = [];
    }
    if (filas.length) filasPorMes[tab] = filas.length;

    const sheetDocs: { numero: string; proveedor: string; tienePdf: boolean }[] = [];
    for (const { row, rowNumber } of filas) {
      // VALIDACIÓN por fila (alineación, campos, montos, aritmética).
      problemasFila.push(...validarFila(row, rowNumber).map((p) => ({ ...p, contexto: { ...p.contexto, tab } })));
      const numero = String(row?.[COL.NUMERO] ?? "").trim();
      const proveedor = String(row?.[COL.PROVEEDOR] ?? "").trim();
      const tienePdf = String(row?.[COL.LINK_PDF] ?? "").trim() !== "";
      sheetDocs.push({ numero, proveedor, tienePdf });
      todasLasFilas.push({
        tab,
        rowNumber,
        numero,
        nit: String(row?.[COL.NIT] ?? "").trim(),
        proveedor,
        fecha: String(row?.[COL.FECHA] ?? "").trim(),
      });
    }

    // ===== CHECKPOINT: CRUCE Sheet ⇄ Drive ⇄ Gmail por mes =====
    const driveNames = await driveFilenamesMes(drive, folderId, year, m);
    const driveDocs = driveNames
      .map((n) => ({ numero: parseNumeroFromFilename(n) ?? "", proveedor: parseProveedorFromFilename(n) }))
      .filter((d) => d.numero !== "" || d.proveedor !== "");
    cruces.push(
      cruzarMes({
        tab,
        sheetDocs,
        driveDocs,
        gmailFacturasCount: gmailFacturas[tab] ?? 0,
      }),
    );
  }

  // ===== CHECKPOINT: DEDUP global por numero NORMALIZADO =====
  const duplicados = detectarDuplicados(todasLasFilas);

  // ===== CHECKPOINT: DESCARTES sospechosos (remitentes-gasto botados) =====
  const fromFilter = DOMINIOS_GASTO.map((d) => `from:${d}`).join(" OR ");
  const descartesSospechosos = await countQ(gmail, `label:Descartado/${year} (${fromFilter})`);

  // ===== SALIDA: veredicto =====
  const veredicto = veredictoFinal({ problemasFila, duplicados, crucesMes: cruces, descartesSospechosos });

  if (asJson) {
    console.log(JSON.stringify({
      cuenta: me.data.emailAddress, year, veredicto,
      problemasFila, duplicados, cruces, filasPorMes,
    }, null, 2));
    process.exit(veredicto.ok ? 0 : 1);
  }

  // ---- Reporte texto accionable ----
  const L = (s = "") => console.log(s);
  L(`\n========= VALIDACIÓN PIPELINE  ${me.data.emailAddress} · ${year} =========\n`);
  L(`VEREDICTO: ${veredicto.resumen}\n`);

  L(`--- CRUCE POR MES (Gmail recepción / Sheet / Drive) ---`);
  L(`Mes         | Gmail | Sheet | Drive | Estado`);
  L(`------------|-------|-------|-------|--------`);
  for (const c of cruces) {
    if (c.conteos.sheet === 0 && c.conteos.drive === 0 && c.conteos.gmail === 0) continue;
    const pad = (n: number) => String(n).padStart(5, " ");
    L(`${c.tab.padEnd(11)} | ${pad(c.conteos.gmail)} | ${pad(c.conteos.sheet)} | ${pad(c.conteos.drive)} | ${c.ok ? "OK" : "HUÉRFANOS"}`);
  }
  L("");

  const huerfanos = cruces.filter((c) => !c.ok);
  if (huerfanos.length) {
    L(`--- HUÉRFANOS Sheet ⇄ Drive ---`);
    for (const c of huerfanos) {
      if (c.sheet_sin_drive.length)
        L(`  ${c.tab}: ${c.sheet_sin_drive.length} fila(s) en Sheet SIN PDF en Drive: ${c.sheet_sin_drive.slice(0, 30).join(", ")}`);
      if (c.drive_sin_sheet.length)
        L(`  ${c.tab}: ${c.drive_sin_sheet.length} PDF(s) en Drive SIN fila en Sheet: ${c.drive_sin_sheet.slice(0, 30).join(", ")}`);
    }
    L("");
  }

  // Gmail vs Sheet (informativo, borde de mes).
  const desbalanceGmail = cruces.filter((c) => c.gmail_vs_sheet !== 0 && (c.conteos.gmail || c.conteos.sheet));
  if (desbalanceGmail.length) {
    L(`--- Gmail(Facturas) vs Sheet (informativo: recepción≠emisión en bordes de mes) ---`);
    for (const c of desbalanceGmail) {
      L(`  ${c.tab}: Gmail ${c.conteos.gmail} vs Sheet ${c.conteos.sheet} (dif ${c.gmail_vs_sheet > 0 ? "+" : ""}${c.gmail_vs_sheet})`);
    }
    L("");
  }

  if (duplicados.length) {
    L(`--- DUPLICADOS por numero NORMALIZADO (${duplicados.length} grupos) ---`);
    for (const g of duplicados.slice(0, 40)) {
      const locs = g.ocurrencias.map((o) => `${o.tab}!${o.rowNumber}("${o.numero}")`).join("  ");
      L(`  ${g.numeroNorm}  ×${g.ocurrencias.length}:  ${locs}`);
    }
    if (duplicados.length > 40) L(`  ... y ${duplicados.length - 40} grupos más`);
    L("");
  }

  const halts = problemasFila.filter((p) => p.severidad === "HALT");
  const warns = problemasFila.filter((p) => p.severidad === "WARN");
  if (halts.length) {
    L(`--- HALT: ${halts.length} fila(s) con integridad ROTA ---`);
    for (const p of halts.slice(0, 60)) {
      L(`  ${(p.contexto?.tab as string) ?? "?"}!${p.rowNumber} [${p.codigo}]: ${p.mensaje}`);
    }
    if (halts.length > 60) L(`  ... y ${halts.length - 60} más`);
    L("");
  }
  if (warns.length) {
    // Agrupar warns por codigo para no saturar.
    const porCodigo = new Map<string, number>();
    for (const w of warns) porCodigo.set(w.codigo, (porCodigo.get(w.codigo) ?? 0) + 1);
    L(`--- WARN: ${warns.length} (recuperables / sospechosos) ---`);
    for (const [cod, n] of [...porCodigo.entries()].sort((a, b) => b[1] - a[1])) {
      L(`  ${cod}: ${n}`);
    }
    L("");
  }

  if (descartesSospechosos > 0) {
    L(`--- DESCARTES SOSPECHOSOS: ${descartesSospechosos} correo(s) de remitentes-GASTO en Descartado/${year} ---`);
    L(`  (probables recibos reales botados por el clasificador — revisar en Gmail)\n`);
  }

  L(`Filas por mes: ${JSON.stringify(filasPorMes)}\n`);
  L(veredicto.ok ? "RESULTADO: base CONSISTENTE." : "RESULTADO: hay problemas que requieren acción (ver arriba).");

  process.exit(veredicto.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("ERR", e?.message ?? e);
  process.exit(2);
});
