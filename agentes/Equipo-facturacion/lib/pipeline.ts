// netlify/functions/_lib/procesar-facturas-pipeline.ts
// DRAFT 2026-04-29 — pendiente revisión spec
//
// Lógica core del pipeline. Consumida por:
//   1) scripts/procesar-facturas.mjs  (CLI wrapper local)
//   2) netlify/functions/procesar-facturas-background.mts (Netlify worker)
//
// Sin side-effects globales: recibe config como parámetro, retorna resultado.
// `process.exit` está prohibido acá — los errores se throwean.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

// ===== Tipos =====

export interface PipelineConfig {
  /** OAuth + targets. */
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    driveFolderId: string;
    sheetId: string;
    sheetTab: string; // ej "Gastos 2026"
  };
  /** Comportamiento. */
  options?: {
    dryRun?: boolean;
    limit?: number | null;
    /** Gmail search window, e.g. "30d", "365d". */
    window?: string;
    /**
     * Si true, NO excluye emails con label "Procesado" del query Gmail.
     * Útil para re-procesar y "encontrar" documentos que el cron viejo no
     * pudo procesar (ej: Word/PDF antes de tener LLM).
     * isDuplicate sigue activo en el Sheet para evitar duplicar filas DIAN.
     */
    force?: boolean;
  };
}

export interface InvoiceData {
  fecha: string;
  proveedor: string;
  nit: string;
  numero: string;
  cufe: string;
  subtotal: number;
  iva: number;
  total: number;
  concepto: string;
  /**
   * Retenciones aplicadas por el proveedor en la factura DIAN.
   * Códigos DIAN del nodo cac:WithholdingTaxTotal/cac:TaxScheme/cbc:ID:
   *   - 05: Retención en la Fuente (ReteFuente)
   *   - 06: Retención de IVA (ReteIVA)
   *   - 07: Retención de ICA (ReteICA)
   * Si la factura no aplica retención, todos son 0.
   * `totalRetenciones` = reteFuente + reteIva + reteIca
   */
  reteFuente?: number;
  reteIva?: number;
  reteIca?: number;
  totalRetenciones?: number;
}

export interface ProcessedRow extends InvoiceData {
  driveLink: string;
  subject: string;
  categoria: string;
  cuentaPyg: string;
  /**
   * Tipo de documento (default 'factura_dian' si no se setea):
   *   - factura_dian: ZIP+XML estándar DIAN (parser XML, sin LLM)
   *   - cuenta_cobro: Word .docx (extracción LLM)
   *   - recibo_internacional: PDF de Stripe/AWS/Notion/etc (LLM)
   *   - recibo_servicio: PDF de servicios locales no-DIAN (LLM)
   *   - planilla_ss: PDF planillas seguridad social PILA Colombia
   */
  tipo?: string;
}

// ===== Categorización =====
import reglasCategoria from "./categorizacion-reglas.json" with { type: "json" };

interface ReglaCategoria {
  proveedor?: string;
  categoria: string;
  cuenta_pyg: string;
}
interface ReglaKeyword {
  patron: string;
  categoria: string;
  cuenta_pyg: string;
}

/**
 * Asigna categoría + cuenta PYG a una factura.
 * Lookup: 1) por NIT exacto → 2) por keyword en concepto → 3) default.
 */
function categorizar(data: { nit: string; concepto: string }): { categoria: string; cuentaPyg: string } {
  // 1. NIT exacto
  const nitNorm = String(data.nit || "").replace(/\D+/g, "");
  const reglasPorNit = (reglasCategoria as any).reglas_por_nit as Record<string, ReglaCategoria>;
  if (reglasPorNit[nitNorm]) {
    return { categoria: reglasPorNit[nitNorm].categoria, cuentaPyg: reglasPorNit[nitNorm].cuenta_pyg };
  }

  // 2. Keyword en concepto
  const keywords = (reglasCategoria as any).reglas_por_keyword_concepto as ReglaKeyword[];
  const concepto = data.concepto || "";
  for (const k of keywords) {
    try {
      if (new RegExp(k.patron).test(concepto)) {
        return { categoria: k.categoria, cuentaPyg: k.cuenta_pyg };
      }
    } catch {
      /* regex inválida en config — ignorar regla */
    }
  }

  // 3. Default
  return {
    categoria: (reglasCategoria as any).default.categoria,
    cuentaPyg: (reglasCategoria as any).default.cuenta_pyg,
  };
}

export interface SkippedRow {
  messageId: string;
  motivo: string;
  asunto?: string;
}

export interface ErrorRow {
  messageId: string;
  error: string;
  asunto?: string;
}

export interface PipelineResult {
  procesadas: ProcessedRow[];
  errores: ErrorRow[];
  saltadas: SkippedRow[];
  /**
   * Estadísticas de uso del LLM en este run.
   * Permite trackear el costo por cliente desde el panel admin.
   */
  llmStats?: {
    /** Total de llamadas a Claude que se hicieron en este run. */
    calls: number;
    /** Costo estimado en USD (calls * costo unitario). */
    estimatedCostUsd: number;
    /** Cuántas veces se evitó una llamada por pre-filter (sender/subject/texto). */
    preFilteredOut: number;
  };
  /** Solo presente si options.dryRun. */
  dryRun?: {
    query: string;
    total: number;
    sample: Array<{
      id: string;
      subject: string | null;
      from: string | null;
      date: string | null;
      zips: string[];
    }>;
  };
}

/**
 * Tracker mutable que se pasa por referencia a los sub-pipelines que llaman LLM.
 * Cada sub-pipeline incrementa el contador correspondiente.
 */
interface LlmTracker {
  calls: number;
  preFilteredOut: number;
}

const PROCESSED_LABEL = "Procesado";

// ===== Entry point =====

export async function run(cfg: PipelineConfig): Promise<PipelineResult> {
  const { google: g, options = {} } = cfg;
  const { dryRun = false, limit = null, window = "30d", force = false } = options;

  // Query amplia: facturas DIAN (ZIP) + planillas SS + Word/PDFs no-DIAN.
  // El processOne distingue qué tipo es y aplica el sub-pipeline correspondiente.
  //
  // El parámetro `window` acepta dos formatos:
  //   - "30d" / "365d" → newer_than:Nd (rolling, último N días)
  //   - "2026/01/01"   → after:YYYY/MM/DD (fecha absoluta, ideal para backfill anual)
  //
  // Si `force=true`, el query NO excluye `-label:Procesado` → re-lee emails
  // ya procesados. Útil para encontrar Word/PDFs que el cron viejo dejó sin
  // procesar (cuando todavía no había LLM).
  const isAbsoluteDate = /^\d{4}\/\d{2}\/\d{2}$/.test(window);
  const dateFilter = isAbsoluteDate ? `after:${window}` : `newer_than:${window}`;
  const labelExclusion = force ? "" : "-label:Procesado ";
  // Query: cubre todos los tipos de documentos que sub-pipelines pueden procesar
  // (DIAN ZIP, planillas SS, Word, PDFs). Filename incluye extensión sin punto.
  const searchQuery = `(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante) ${labelExclusion}${dateFilter}`;

  const auth = new google.auth.OAuth2(g.clientId, g.clientSecret);
  auth.setCredentials({ refresh_token: g.refreshToken });

  const gmail = google.gmail({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  // Estructura nueva: 12 pestañas (Enero..Diciembre), una por mes, con N° consecutivo
  // que reinicia cada mes. El env var INVOICES_SHEET_TAB ahora se ignora — los nombres
  // de pestañas son fijos (estándar contable colombiano).
  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });

  const labelId = await getOrCreateLabel(gmail, PROCESSED_LABEL);

  // Setup del Sheet: garantizar 12 pestañas mensuales + Dashboard.
  // Idempotente: si ya existen, no hace nada.
  await ensureSheetSetup(sheets, g.sheetId);

  let emails = await findInvoiceEmails(gmail, searchQuery);
  if (limit != null && limit > 0) emails = emails.slice(0, limit);

  if (dryRun) {
    const detailed: NonNullable<PipelineResult["dryRun"]>["sample"] = [];
    for (const e of emails.slice(0, 20)) {
      const m = await getMessageFull(gmail, e.id!);
      detailed.push({
        id: e.id!,
        subject: getHeader(m, "Subject"),
        from: getHeader(m, "From"),
        date: getHeader(m, "Date"),
        zips: findZipParts(m.payload).map((z) => z.filename),
      });
    }
    return {
      procesadas: [],
      errores: [],
      saltadas: [],
      dryRun: { query: searchQuery, total: emails.length, sample: detailed },
    };
  }

  // Caché de Sheet rows POR pestaña-mes (key = "Enero", "Febrero"...).
  // Se carga lazy y se actualiza tras cada append. Soporta multi-mes en una corrida.
  const sheetRowsCache = new Map<string, any[][]>();
  const loadSheetRows = async (tabName: string): Promise<any[][]> => {
    if (sheetRowsCache.has(tabName)) return sheetRowsCache.get(tabName)!;
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: g.sheetId,
        range: `${tabRange}!A:P`, // 16 cols (12 originales + 4 retenciones)
      });
      const rows = res.data.values || [];
      sheetRowsCache.set(tabName, rows);
      return rows;
    } catch {
      // El tab puede no existir todavía — lo creará getOrCreateMonthTab.
      sheetRowsCache.set(tabName, []);
      return [];
    }
  };

  const result: PipelineResult = { procesadas: [], errores: [], saltadas: [] };
  const llmTracker: LlmTracker = { calls: 0, preFilteredOut: 0 };

  for (const e of emails) {
    try {
      const r = await processOne(
        e.id!,
        labelId,
        gmail,
        drive,
        sheets,
        xmlParser,
        g,
        loadSheetRows,
        (tabName, newRow) => {
          const cached = sheetRowsCache.get(tabName);
          if (cached) cached.push(newRow);
        },
        llmTracker,
      );
      if ("ok" in r && r.ok) {
        result.procesadas.push(r);
      } else if ("dup" in r && r.dup) {
        result.saltadas.push({ messageId: e.id!, motivo: r.motivo, asunto: r.subject });
      } else if ("skip" in r && r.skip) {
        result.saltadas.push({ messageId: e.id!, motivo: r.reason, asunto: r.subject });
      }
    } catch (err: any) {
      result.errores.push({ messageId: e.id!, error: err.message });
    }
  }

  // Adjuntar stats LLM al result (importante: aunque sea 0 si nunca llamó)
  result.llmStats = {
    calls: llmTracker.calls,
    estimatedCostUsd: Math.round(llmTracker.calls * 0.001 * 10000) / 10000,
    preFilteredOut: llmTracker.preFilteredOut,
  };

  return result;
}

// Nombres de las 12 pestañas (1 por mes), formato español.
const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/**
 * Genera el nombre base de un archivo de factura para Drive.
 * El mes NO se incluye porque ya está en la carpeta padre (YYYY-MM/).
 * Ejemplos:
 *   buildFileBaseName(1, "SEGUROS DE VIDA SURAMERICANA")
 *     → "1. Seguros De Vida Suramericana"
 *   buildFileBaseName(1, "SEGUROS DE VIDA SURAMERICANA", 1)
 *     → "1.1. Seguros De Vida Suramericana"  (XML idx 1)
 *   buildFileBaseName(1, "SEGUROS DE VIDA SURAMERICANA", 3)
 *     → "1.3. Seguros De Vida Suramericana"  (futuro: comprobante pago)
 */
function buildFileBaseName(n: number, proveedor: string, subIdx?: number): string {
  const N = subIdx != null ? `${n}.${subIdx}` : `${n}`;
  // Title-case proveedor (capitaliza primera letra de cada palabra), max 60 chars
  const provClean = String(proveedor || "Sin Proveedor")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 60)
    .trim();
  return `${N}. ${provClean}`;
}

// Headers: 16 columnas (col A = N° consecutivo del mes).
// Las últimas 4 (ReteFuente, ReteIVA, ReteICA, Total Retenciones) se agregaron
// el 2026-05-11 al implementar extracción de retenciones del XML DIAN.
// Pestañas existentes con 12 columnas se migran automáticamente en getOrCreateMonthTab.
const SHEET_HEADERS = [
  "N°", "Fecha", "Proveedor", "NIT", "N° Factura", "Subtotal", "IVA",
  "Total", "Concepto", "Link PDF", "Categoría", "Cuenta PYG",
  "ReteFuente", "ReteIVA", "ReteICA", "Total Retenciones",
];
const SHEET_HEADERS_COUNT = SHEET_HEADERS.length; // 16

const DASHBOARD_TAB = "Dashboard";

/**
 * Garantiza que el Sheet del cliente tiene la estructura completa:
 *   1. 12 pestañas mensuales (Enero..Diciembre) con headers
 *   2. Pestaña "Dashboard" como primera pestaña con métricas vivas
 *
 * Idempotente: si ya existen, no hace nada.
 * Llamada al inicio de cada `run()` — primer run de cliente nuevo arma todo,
 * runs subsiguientes son no-op (chequeos baratos).
 */
async function ensureSheetSetup(sheets: any, sheetId: string): Promise<void> {
  // 1. Crear las 12 pestañas mensuales si no existen (las fórmulas del Dashboard
  //    referencian todas, así que deben existir aunque vacías).
  for (let month = 1; month <= 12; month++) {
    await getOrCreateMonthTab(sheets, sheetId, month);
  }

  // 2. Setear locale es-CO + zona horaria Bogotá (idempotente — no-op si ya está).
  //    Necesario para que las fórmulas con separador `;` funcionen, y para que los
  //    formatos de moneda/fecha sean coherentes con Colombia.
  const metaForLocale = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const currentLocale = metaForLocale.data.properties?.locale;
  if (currentLocale !== "es_CO") {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          updateSpreadsheetProperties: {
            properties: { locale: "es_CO", timeZone: "America/Bogota" },
            fields: "locale,timeZone",
          },
        }],
      },
    });
  }

  // 3. SIEMPRE regenerar Dashboard (delete + recreate). Idempotente y permite que
  //    futuros cambios al template (fórmulas, formato) se propaguen sin que el
  //    cliente tenga que borrar la pestaña manualmente.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existingDashboard = meta.data.sheets?.find(
    (s: any) => s.properties?.title === DASHBOARD_TAB,
  );
  if (existingDashboard) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          deleteSheet: { sheetId: existingDashboard.properties.sheetId },
        }],
      },
    });
  }

  // Crear Dashboard como PRIMERA pestaña (index: 0)
  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: DASHBOARD_TAB,
            index: 0,
            gridProperties: { rowCount: 50, columnCount: 6 },
          },
        },
      }],
    },
  });
  const dashSheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;

  // 3. Llenar el contenido (fórmulas vivas — leen de las 12 pestañas mensuales)
  // Spec del MVP:
  //   - Mes actual: facturas, monto, tiempo ahorrado
  //   - Histórico 2026: 12 meses + total
  //   - Top 5 proveedores (cross-mes)
  //   - Top 5 categorías (cross-mes)

  // OJO: Sheet locale es es_CO → separador de argumentos de funciones es `;`, no `,`.
  // Los `,` solo se usan dentro del lenguaje QUERY (en el SQL string) que tiene su
  // propia sintaxis SQL. Las funciones nativas (CHOOSE, TEXT, ROUND, SUM, etc) van con `;`.
  const monthChooseStr = MES_TABS.map((m) => `"${m}"`).join(";");
  // Rangos consolidados de las 12 pestañas (para QUERY)
  const allMonthsRange = MES_TABS.map((m) => `'${m}'!A2:L`).join(";");

  const content: any[][] = [
    // Row 1: título grande
    ["TABLERO RESUMEN — Equipo de Facturación", "", "", "", "", ""],
    // Row 2: vacío
    ["", "", "", "", "", ""],
    // Row 3: header sección
    ["MES ACTUAL", "", "", "", "", ""],
    // Row 4: Mes
    ["Mes", `=PROPER(TEXT(TODAY();"mmmm yyyy"))`, "", "", "", ""],
    // Row 5: Facturas
    ["Facturas procesadas", `=COUNTA(INDIRECT(CHOOSE(MONTH(TODAY());${monthChooseStr})&"!A2:A1000"))`, "", "", "", ""],
    // Row 6: Monto
    ["Monto total (COP)", `=SUM(INDIRECT(CHOOSE(MONTH(TODAY());${monthChooseStr})&"!H2:H1000"))`, "", "", "", ""],
    // Row 7: Tiempo
    ["Tiempo ahorrado", `=ROUND(B5*10/60;1)&" h (10 min/factura)"`, "", "", "", ""],
    // Row 8: vacío
    ["", "", "", "", "", ""],
    // Row 9: header sección
    ["HISTÓRICO 2026", "", "", "", "", ""],
    // Row 10: headers
    ["Mes", "Facturas", "Monto (COP)", "", "", ""],
    // Row 11-22: 12 meses
    ...MES_TABS.map((m) => [
      m,
      `=COUNTA('${m}'!A2:A1000)`,
      `=SUM('${m}'!H2:H1000)`,
      "", "", "",
    ]),
    // Row 23: Total
    ["TOTAL", `=SUM(B11:B22)`, `=SUM(C11:C22)`, "", "", ""],
    // Row 24: vacío
    ["", "", "", "", "", ""],
    // Row 25: header sección
    ["TOP 5 PROVEEDORES (todo el año)", "", "", "", "", ""],
    // Row 26: QUERY (se expande hacia abajo automáticamente con 5 filas + header)
    [
      `=QUERY({${allMonthsRange}};"select Col3, count(Col3), sum(Col8) where Col3 is not null and Col3 <> '' group by Col3 order by count(Col3) desc limit 5 label Col3 'Proveedor', count(Col3) 'Facturas', sum(Col8) 'Monto'";0)`,
      "", "", "", "", "",
    ],
    // Rows 27-31 reservadas para el resultado del QUERY (5 filas)
    [], [], [], [], [],
    // Row 32: vacío
    ["", "", "", "", "", ""],
    // Row 33: header sección
    ["TOP 5 CATEGORÍAS (todo el año)", "", "", "", "", ""],
    // Row 34: QUERY (expande 5 filas hacia abajo)
    [
      `=QUERY({${allMonthsRange}};"select Col11, count(Col11), sum(Col8) where Col11 is not null and Col11 <> '' group by Col11 order by count(Col11) desc limit 5 label Col11 'Categoría', count(Col11) 'Facturas', sum(Col8) 'Monto'";0)`,
      "", "", "", "", "",
    ],
    // Rows 35-38 reservadas para el resultado del QUERY (5 filas + header = 6)
    [], [], [], [], [],
    // Row 40: vacío
    ["", "", "", "", "", ""],
    // Row 41: header sección RETENCIONES
    ["RETENCIONES (todo el año)", "", "", "", "", ""],
    // Row 42: headers tabla
    ["Tipo", "Monto (COP)", "", "", "", ""],
    // Row 43: ReteFuente = SUM de cols M de las 12 pestañas
    ["ReteFuente", `=${MES_TABS.map((m) => `SUM('${m}'!M:M)`).join("+")}`, "", "", "", ""],
    // Row 44: ReteIVA
    ["ReteIVA", `=${MES_TABS.map((m) => `SUM('${m}'!N:N)`).join("+")}`, "", "", "", ""],
    // Row 45: ReteICA
    ["ReteICA", `=${MES_TABS.map((m) => `SUM('${m}'!O:O)`).join("+")}`, "", "", "", ""],
    // Row 46: Total retenciones (suma directa de col P)
    ["Total retenido", `=${MES_TABS.map((m) => `SUM('${m}'!P:P)`).join("+")}`, "", "", "", ""],
    // Row 47: Neto pagado (Total bruto - Retenciones)
    ["Neto pagado al proveedor", `=C23-B46`, "(Total año − Total retenido)", "", "", ""],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${DASHBOARD_TAB}'!A1:F${content.length}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: content },
  });

  // 4. Formato visual
  if (dashSheetId != null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          // Título row 1: merged + bold + fondo + texto blanco
          {
            mergeCells: {
              range: { sheetId: dashSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
              mergeType: "MERGE_ALL",
            },
          },
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
                  horizontalAlignment: "CENTER",
                  verticalAlignment: "MIDDLE",
                  backgroundColor: { red: 0.15, green: 0.25, blue: 0.4 },
                },
              },
              fields: "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment,backgroundColor)",
            },
          },
          // Headers de sección (rows 3, 9, 25, 33, 41): bold con fondo claro
          ...[2, 8, 24, 32, 40].map((rowIdx) => ({
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: 6 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, fontSize: 11 },
                  backgroundColor: { red: 0.92, green: 0.92, blue: 0.95 },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          })),
          // Header tabla histórico (row 10): bold
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 3 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat",
            },
          },
          // TOTAL row (23): bold + fondo
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 22, endRowIndex: 23, startColumnIndex: 0, endColumnIndex: 3 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.98, green: 0.95, blue: 0.85 },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          // Formato moneda COP — todas las celdas de monto del Dashboard
          // B6 (mes actual monto), C11:C23 (histórico), C27:C31 (top proveedores), C34:C38 (top categorías)
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 10, endRowIndex: 23, startColumnIndex: 2, endColumnIndex: 3 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // Top proveedores — col C (monto)
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 26, endRowIndex: 32, startColumnIndex: 2, endColumnIndex: 3 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // Top categorías — col C (monto)
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 33, endRowIndex: 39, startColumnIndex: 2, endColumnIndex: 3 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // Retenciones (rows 43-47): formato moneda en col B
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 42, endRowIndex: 47, startColumnIndex: 1, endColumnIndex: 2 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // Retenciones header tabla (row 42)
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 41, endRowIndex: 42, startColumnIndex: 0, endColumnIndex: 3 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat",
            },
          },
          // Total retenido + Neto pagado (rows 45-46): bold + fondo
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 45, endRowIndex: 47, startColumnIndex: 0, endColumnIndex: 3 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.98, green: 0.95, blue: 0.85 },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          // Centrar columnas numéricas (B y C) en todas las secciones de data
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 3, endRowIndex: 47, startColumnIndex: 1, endColumnIndex: 3 },
              cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
              fields: "userEnteredFormat.horizontalAlignment",
            },
          },
          // Bordes en todas las celdas con data (rows 3-46, cols A-C)
          {
            updateBorders: {
              range: { sheetId: dashSheetId, startRowIndex: 2, endRowIndex: 47, startColumnIndex: 0, endColumnIndex: 3 },
              top:    { style: "SOLID", width: 1, color: { red: 0.78, green: 0.78, blue: 0.82 } },
              bottom: { style: "SOLID", width: 1, color: { red: 0.78, green: 0.78, blue: 0.82 } },
              left:   { style: "SOLID", width: 1, color: { red: 0.78, green: 0.78, blue: 0.82 } },
              right:  { style: "SOLID", width: 1, color: { red: 0.78, green: 0.78, blue: 0.82 } },
              innerHorizontal: { style: "SOLID", width: 1, color: { red: 0.85, green: 0.85, blue: 0.88 } },
              innerVertical:   { style: "SOLID", width: 1, color: { red: 0.85, green: 0.85, blue: 0.88 } },
            },
          },
          // Auto-resize columnas A, B, C según contenido (no se corta el texto)
          {
            autoResizeDimensions: {
              dimensions: { sheetId: dashSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 3 },
            },
          },
          // Altura row 1 (título)
          {
            updateDimensionProperties: {
              range: { sheetId: dashSheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
              properties: { pixelSize: 40 },
              fields: "pixelSize",
            },
          },
        ],
      },
    });
  }
}

/**
 * Devuelve el nombre del tab del mes (ej "Enero", "Febrero"...). Si no existe,
 * lo crea con headers + frozen + bold. Idempotente.
 *
 * Migración automática: si la pestaña existe pero solo tiene 12 columnas
 * (versión vieja, pre-retenciones), agrega las 4 columnas nuevas
 * (ReteFuente, ReteIVA, ReteICA, Total Retenciones) con sus headers.
 */
async function getOrCreateMonthTab(sheets: any, sheetId: string, month: number): Promise<string> {
  const tabName = MES_TABS[month - 1];
  if (!tabName) throw new Error(`Mes inválido: ${month}`);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets?.find((s: any) => s.properties?.title === tabName);

  if (existing) {
    // Pestaña ya existe → verificar si necesita migración (agregar columnas faltantes)
    const existingCols = existing.properties?.gridProperties?.columnCount ?? 0;
    if (existingCols < SHEET_HEADERS_COUNT) {
      const existingTabId = existing.properties.sheetId;
      // 1. Expandir grid a 16 columnas
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: {
                sheetId: existingTabId,
                gridProperties: { columnCount: SHEET_HEADERS_COUNT, frozenRowCount: 1 },
              },
              fields: "gridProperties.columnCount,gridProperties.frozenRowCount",
            },
          }],
        },
      });
      // 2. Escribir SOLO los headers faltantes (columnas 13-16 = M-P)
      const newHeaders = SHEET_HEADERS.slice(existingCols);
      const startColLetter = String.fromCharCode("A".charCodeAt(0) + existingCols);
      const endColLetter = String.fromCharCode("A".charCodeAt(0) + SHEET_HEADERS_COUNT - 1);
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `'${tabName}'!${startColLetter}1:${endColLetter}1`,
        valueInputOption: "RAW",
        requestBody: { values: [newHeaders] },
      });
      // 3. Aplicar formato bold + bg a los nuevos headers
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            repeatCell: {
              range: {
                sheetId: existingTabId,
                startRowIndex: 0, endRowIndex: 1,
                startColumnIndex: existingCols, endColumnIndex: SHEET_HEADERS_COUNT,
              },
              cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.95 } } },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          }],
        },
      });
    }
    return tabName;
  }

  // Pestaña no existe → crear desde cero con 16 cols
  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: tabName,
            gridProperties: { frozenRowCount: 1, columnCount: SHEET_HEADERS_COUNT },
          },
        },
      }],
    },
  });
  const newTabId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${tabName}'!A1:P1`,
    valueInputOption: "RAW",
    requestBody: { values: [SHEET_HEADERS] },
  });

  if (newTabId != null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: newTabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS_COUNT },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.95 } } },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        }],
      },
    });
  }

  return tabName;
}

// ===== Gmail helpers =====

async function getOrCreateLabel(gmail: any, name: string): Promise<string> {
  const list = await gmail.users.labels.list({ userId: "me" });
  const found = list.data.labels?.find((l: any) => l.name === name);
  if (found) return found.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id;
}

async function findInvoiceEmails(gmail: any, query: string) {
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });
    if (res.data.messages) out.push(...res.data.messages);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function getMessageFull(gmail: any, messageId: string) {
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return res.data;
}

function getHeader(msg: any, name: string): string | null {
  return msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function findZipParts(payload: any) {
  const out: Array<{ filename: string; attachmentId: string }> = [];
  function walk(part: any) {
    if (part.filename && /\.zip$/i.test(part.filename) && part.body?.attachmentId) {
      out.push({ filename: part.filename, attachmentId: part.body.attachmentId });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return out;
}

/**
 * Detecta PDFs de planillas seguridad social (PILA Colombia).
 * Filenames típicos: "Autoliquidaciones_84333812_Consolidado.pdf" o "Comprobante_Pago_84333812.pdf".
 * Match laxo: contiene "autoliquidaci" o "comprobante" (case-insensitive).
 */
function findPlanillaPdfs(payload: any) {
  const out: Array<{ filename: string; attachmentId: string }> = [];
  function walk(part: any) {
    if (part.filename && /\.pdf$/i.test(part.filename) && part.body?.attachmentId) {
      const lower = part.filename.toLowerCase();
      if (lower.includes("autoliquidaci") || lower.includes("comprobante")) {
        out.push({ filename: part.filename, attachmentId: part.body.attachmentId });
      }
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return out;
}

/**
 * Detecta adjuntos .docx (Word) — típicamente cuentas de cobro de proveedores
 * no obligados a facturación electrónica (personas naturales, contratistas).
 */
function findDocxParts(payload: any) {
  const out: Array<{ filename: string; attachmentId: string }> = [];
  function walk(part: any) {
    if (part.filename && /\.docx?$/i.test(part.filename) && part.body?.attachmentId) {
      out.push({ filename: part.filename, attachmentId: part.body.attachmentId });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return out;
}

/**
 * Quick check: hay algún PDF que NO sea planilla SS?
 * Usado para decidir si aplicar pre-filtros antes de descargar.
 */
function hasNonPlanillaPdf(payload: any, planillas: Array<{ filename: string }>): boolean {
  const planillaNames = new Set(planillas.map((p) => p.filename));
  let found = false;
  function walk(part: any) {
    if (found) return;
    if (part.filename && /\.pdf$/i.test(part.filename) && part.body?.attachmentId) {
      if (!planillaNames.has(part.filename)) {
        found = true;
        return;
      }
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return found;
}

/**
 * Detecta PDFs adjuntos genéricos (no DIAN ZIP, no planilla SS).
 * Usado para recibos internacionales (Stripe, AWS) y servicios locales no-DIAN.
 */
function findGenericPdfs(payload: any, exclude: Array<{ filename: string }>) {
  const excludeNames = new Set(exclude.map((e) => e.filename));
  const out: Array<{ filename: string; attachmentId: string }> = [];
  function walk(part: any) {
    if (part.filename && /\.pdf$/i.test(part.filename) && part.body?.attachmentId) {
      if (!excludeNames.has(part.filename)) {
        out.push({ filename: part.filename, attachmentId: part.body.attachmentId });
      }
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return out;
}

async function downloadAttachment(gmail: any, messageId: string, attachmentId: string, filename: string) {
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  const buf = Buffer.from(res.data.data!, "base64url");
  const safeName = filename.replace(/[\\/:*?"<>|]/g, "_");
  const tmpPath = path.join(os.tmpdir(), `factura-${Date.now()}-${safeName}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

async function markEmailProcessed(gmail: any, messageId: string, labelId: string) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

/**
 * Aplica un label "Facturas/YYYY-MM" al mensaje (lo crea si no existe) Y archiva
 * el correo (remueve INBOX). Gmail soporta labels anidados con `/` — quedan
 * agrupados visualmente bajo "Facturas/".
 *
 * Razón del archive: si la factura ya está organizada en su carpeta de mes,
 * no tiene sentido que siga ocupando espacio en la bandeja principal. Sigue
 * accesible vía el label.
 */
async function applyMonthLabel(gmail: any, messageId: string, year: number, month: number) {
  const labelName = `Facturas/${year}-${String(month).padStart(2, "0")}`;
  const labelId = await getOrCreateLabel(gmail, labelName);
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: ["INBOX"], // archivar — sale de la bandeja, queda en el label
    },
  });
}

// ===== ZIP & XML =====

function extractZip(zipPath: string): { pdfPath: string | null; xmlPaths: string[]; allPaths: string[]; tmpDir: string } {
  const zip = new AdmZip(zipPath);
  const tmpDir = path.join(
    os.tmpdir(),
    `factura-extracted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  zip.extractAllTo(tmpDir, true);
  const all: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else all.push(full);
    }
  }
  walk(tmpDir);
  return {
    pdfPath: all.find((p) => /\.pdf$/i.test(p)) || null,
    xmlPaths: all.filter((p) => /\.xml$/i.test(p)),
    allPaths: all,
    tmpDir,
  };
}

/** Best-effort cleanup de paths temporales — silencioso si falla. */
function cleanupTmp(paths: string[]) {
  for (const p of paths) {
    if (!p) continue;
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch {
      /* archivo ya borrado o inaccesible — no es crítico */
    }
  }
}

function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p.split(".")) {
      if (cur == null) {
        ok = false;
        break;
      }
      cur = cur[k];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return null;
}

function asNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v["#text"] != null) return parseFloat(v["#text"]) || 0;
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

function asString(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v["#text"] != null) return String(v["#text"]);
  return String(v);
}

function unwrapAttachedDocument(parsed: any, xmlParser: XMLParser): any | null {
  const ad = parsed.AttachedDocument;
  if (!ad) return null;
  function findInvoiceXml(node: any): string | null {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const x of node) {
        const f = findInvoiceXml(x);
        if (f) return f;
      }
      return null;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "Description" && typeof v === "string" && v.includes("<Invoice")) return v;
      if (k === "Description" && Array.isArray(v)) {
        for (const x of v) if (typeof x === "string" && x.includes("<Invoice")) return x;
      }
      const nested = findInvoiceXml(v);
      if (nested) return nested;
    }
    return null;
  }
  const innerXml = findInvoiceXml(ad);
  if (!innerXml) return null;
  return xmlParser.parse(innerXml);
}

function parseInvoiceXml(xmlPath: string, xmlParser: XMLParser): InvoiceData | null {
  const raw = fs.readFileSync(xmlPath, "utf8");
  const parsed = xmlParser.parse(raw);

  let invoice = parsed.Invoice;
  if (!invoice) {
    const unwrapped = unwrapAttachedDocument(parsed, xmlParser);
    if (unwrapped) invoice = unwrapped.Invoice;
  }
  if (!invoice) return null;

  const supplier = invoice.AccountingSupplierParty?.Party;
  const proveedor = asString(
    pick(supplier, "PartyTaxScheme.RegistrationName") ??
      pick(supplier, "PartyLegalEntity.RegistrationName") ??
      pick(supplier, "PartyName.Name") ??
      "Desconocido"
  );
  const nit = asString(
    pick(supplier, "PartyTaxScheme.CompanyID") ?? pick(supplier, "PartyIdentification.ID") ?? ""
  ).replace(/\D+/g, "");

  const totals = invoice.LegalMonetaryTotal;
  const subtotal = asNumber(pick(totals, "LineExtensionAmount"));
  const total = asNumber(pick(totals, "TaxInclusiveAmount") ?? pick(totals, "PayableAmount"));

  let iva = 0;
  const taxArr = Array.isArray(invoice.TaxTotal) ? invoice.TaxTotal : invoice.TaxTotal ? [invoice.TaxTotal] : [];
  for (const t of taxArr) iva += asNumber(t.TaxAmount);

  // Retenciones del nodo cac:WithholdingTaxTotal (puede ser objeto o array).
  // Cada nodo tiene un TaxScheme.ID que indica el tipo:
  //   05 = ReteFuente (Retención en la Fuente)
  //   06 = ReteIVA
  //   07 = ReteICA
  const { reteFuente, reteIva, reteIca } = extractRetenciones(invoice);
  const totalRetenciones = reteFuente + reteIva + reteIca;

  const lines = Array.isArray(invoice.InvoiceLine)
    ? invoice.InvoiceLine
    : invoice.InvoiceLine
      ? [invoice.InvoiceLine]
      : [];
  let concepto = "";
  if (lines.length === 1) {
    concepto = asString(pick(lines[0], "Item.Description", "Item.Name"));
  } else if (lines.length > 1) {
    const first = asString(pick(lines[0], "Item.Description", "Item.Name"));
    concepto = first ? `${first} (+${lines.length - 1} más)` : `${lines.length} ítems`;
  }

  return {
    fecha: asString(pick(invoice, "IssueDate")),
    proveedor,
    nit,
    numero: asString(pick(invoice, "ID")),
    cufe: asString(pick(invoice, "UUID")),
    subtotal,
    iva,
    total,
    concepto,
    reteFuente,
    reteIva,
    reteIca,
    totalRetenciones,
  };
}

/**
 * Extrae las 3 retenciones colombianas del nodo cac:WithholdingTaxTotal.
 * Soporta el caso de que sea objeto único o array.
 * El nodo TaxScheme.ID identifica el tipo:
 *   - "05" → ReteFuente
 *   - "06" → ReteIVA
 *   - "07" → ReteICA
 * Si no hay nodo, todos quedan en 0.
 */
function extractRetenciones(invoice: any): {
  reteFuente: number;
  reteIva: number;
  reteIca: number;
} {
  const out = { reteFuente: 0, reteIva: 0, reteIca: 0 };
  const wt = invoice.WithholdingTaxTotal;
  if (!wt) return out;

  // Puede venir como objeto único o como array de objetos (múltiples retenciones)
  const wtArr = Array.isArray(wt) ? wt : [wt];

  for (const w of wtArr) {
    // El TaxSubtotal a su vez puede ser objeto o array
    const subArr = Array.isArray(w.TaxSubtotal)
      ? w.TaxSubtotal
      : w.TaxSubtotal
        ? [w.TaxSubtotal]
        : [];

    // Si NO hay TaxSubtotal pero hay TaxAmount directo, sumamos al ReteFuente (default)
    if (subArr.length === 0) {
      const amount = asNumber(w.TaxAmount);
      out.reteFuente += amount;
      continue;
    }

    for (const sub of subArr) {
      const code = String(
        pick(sub, "TaxCategory.TaxScheme.ID") ?? pick(sub, "TaxScheme.ID") ?? ""
      ).trim();
      const amount = asNumber(sub.TaxAmount);
      switch (code) {
        case "05":
          out.reteFuente += amount;
          break;
        case "06":
          out.reteIva += amount;
          break;
        case "07":
          out.reteIca += amount;
          break;
        default:
          // Código desconocido: por convención sumamos a ReteFuente (es el más común)
          out.reteFuente += amount;
      }
    }
  }

  return out;
}

// ===== Drive =====

async function getOrCreateMonthFolder(drive: any, parentFolderId: string, year: number, month: number) {
  const name = `${year}-${String(month).padStart(2, "0")}`;
  const q = `name='${name}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({ q, fields: "files(id, name)", spaces: "drive" });
  if (list.data.files?.length) return list.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] },
    fields: "id",
  });
  return created.data.id;
}

/**
 * Find-or-create de una subcarpeta nombrada dentro de un padre Drive.
 * Idempotente. Usado para la carpeta "Seguridad Social" del sub-pipeline planillas.
 */
async function getOrCreateNamedFolder(drive: any, parentFolderId: string, name: string): Promise<string> {
  const safeName = name.replace(/'/g, "\\'");
  const q = `name='${safeName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({ q, fields: "files(id, name)", spaces: "drive" });
  if (list.data.files?.length) return list.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] },
    fields: "id",
  });
  return created.data.id;
}

async function uploadFile(drive: any, localPath: string, parentId: string, name: string) {
  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  return res.data;
}

// ===== Sheets =====

function isDuplicate(rows: any[][], numero: string, nit: string): boolean {
  if (!numero) return false;
  const numTrim = String(numero).trim();
  const nitNorm = String(nit || "").replace(/\D+/g, "");
  // Match estricto: ambos NITs deben existir e igualar.
  // (La idempotencia primaria sigue siendo el label "Procesado" en Gmail.)
  if (!nitNorm) return false;
  // Cols nuevas (12): A=N°, B=Fecha, C=Proveedor, D=NIT, E=N°Factura, F..L resto
  return rows.some((r) => {
    const rowNum = String(r[4] || "").trim();
    const rowNit = String(r[3] || "").replace(/\D+/g, "");
    return rowNum === numTrim && rowNit === nitNorm;
  });
}

async function appendToSheet(
  sheets: any,
  sheetId: string,
  tabRange: string,
  consecutivo: number,
  d: ProcessedRow
): Promise<any[]> {
  // 16 cols: A=N°, B=Fecha, C=Proveedor, D=NIT, E=N°Factura, F=Subtotal,
  //          G=IVA, H=Total, I=Concepto, J=Link PDF, K=Categoría, L=Cuenta PYG,
  //          M=ReteFuente, N=ReteIVA, O=ReteICA, P=Total Retenciones.
  // Para non-DIAN (Word/PDF/planillas), retenciones = 0 (LLM no las extrae aún).
  const row = [
    consecutivo, d.fecha, d.proveedor, d.nit, d.numero, d.subtotal,
    d.iva, d.total, d.concepto, d.driveLink, d.categoria, d.cuentaPyg,
    d.reteFuente ?? 0, d.reteIva ?? 0, d.reteIca ?? 0, d.totalRetenciones ?? 0,
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tabRange}!A:P`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  return row;
}

// ===== Pipeline per email =====

type ProcessOneResult =
  | (ProcessedRow & { ok: true })
  | { dup: true; motivo: string; subject: string }
  | { skip: true; reason: string; subject: string };

async function processOne(
  messageId: string,
  labelId: string,
  gmail: any,
  drive: any,
  sheets: any,
  xmlParser: XMLParser,
  g: PipelineConfig["google"],
  loadSheetRows: (tabName: string) => Promise<any[][]>,
  pushToCache: (tabName: string, row: any[]) => void,
  llmTracker: LlmTracker,
): Promise<ProcessOneResult> {
  const msg = await getMessageFull(gmail, messageId);
  const subject = getHeader(msg, "Subject") || "(sin asunto)";
  const sender = getHeader(msg, "From") || "";

  const zips = findZipParts(msg.payload);
  const planillas = findPlanillaPdfs(msg.payload);
  const docxs = findDocxParts(msg.payload);

  // Sub-pipeline planillas: si NO hay ZIPs pero SÍ hay autoliquidaciones/comprobantes,
  // tratar como planilla seguridad social. Va al folder del mes con fila en Sheet
  // (categoría "Seguridad Social", total=0 — Tomás edita manual).
  if (zips.length === 0 && planillas.length > 0) {
    return await processPlanilla(
      messageId, labelId, gmail, drive, sheets, g, planillas, subject, msg,
      loadSheetRows, pushToCache,
    );
  }

  // PRE-FILTRO A+B (sender/subject) — aplica a flows que llaman LLM (.docx + PDF).
  // Si el sender o subject indican que NO es factura, skip sin cargar el adjunto.
  if (zips.length === 0 && (docxs.length > 0 || hasNonPlanillaPdf(msg.payload, planillas))) {
    const { isLikelyNonInvoiceSender, isLikelyNonInvoiceSubject } = await import("./llm-pre-filters");
    if (isLikelyNonInvoiceSender(sender)) {
      llmTracker.preFilteredOut++;
      await markEmailProcessed(gmail, messageId, labelId);
      return {
        skip: true,
        reason: `pre-filter-sender (${sender.slice(0, 60)})`,
        subject,
      };
    }
    if (isLikelyNonInvoiceSubject(subject)) {
      llmTracker.preFilteredOut++;
      await markEmailProcessed(gmail, messageId, labelId);
      return {
        skip: true,
        reason: `pre-filter-subject (${subject.slice(0, 60)})`,
        subject,
      };
    }
  }

  // Sub-pipeline cuenta de cobro Word: si NO hay ZIPs ni planillas, pero SÍ hay .docx,
  // tratar como cuenta de cobro. Extrae texto con mammoth + LLM Claude para datos.
  if (zips.length === 0 && docxs.length > 0) {
    return await processCuentaCobroDocx(
      messageId, labelId, gmail, drive, sheets, g, docxs, subject, msg,
      loadSheetRows, pushToCache, llmTracker,
    );
  }

  // Sub-pipeline PDF genérico (recibos internacionales / servicios locales):
  // si NO hay ZIPs ni planillas SS pero SÍ hay PDFs adjuntos, intentar extracción
  // con LLM. Cubre Stripe, AWS, Notion, recibos de servicios públicos, etc.
  if (zips.length === 0) {
    const genericPdfs = findGenericPdfs(msg.payload, planillas);
    if (genericPdfs.length > 0) {
      return await processGenericPdf(
        messageId, labelId, gmail, drive, sheets, g, genericPdfs, subject, msg,
        loadSheetRows, pushToCache, llmTracker,
      );
    }
  }

  if (zips.length === 0) return { skip: true, reason: "sin-zip", subject };

  // Tracking de tmp paths para cleanup garantizado en finally.
  const tmpPaths: string[] = [];

  try {
    const z = zips[0];
    const zipPath = await downloadAttachment(gmail, messageId, z.attachmentId, z.filename);
    tmpPaths.push(zipPath);

    let extracted;
    try {
      extracted = extractZip(zipPath);
      tmpPaths.push(extracted.tmpDir);
    } catch (e: any) {
      // ZIPs con password / corruptos no son facturas DIAN procesables — skip silencioso
      return { skip: true, reason: `zip-no-procesable: ${e.message}`, subject };
    }
    const { pdfPath, xmlPaths } = extracted;
    if (!xmlPaths.length) {
      return { skip: true, reason: "zip-sin-xml", subject };
    }

    let data: InvoiceData | null = null;
    for (const x of xmlPaths) {
      try {
        const candidate = parseInvoiceXml(x, xmlParser);
        if (candidate && (candidate.numero || candidate.cufe)) {
          data = candidate;
          break;
        }
      } catch {
        /* probar el siguiente XML */
      }
    }
    if (!data) return { skip: true, reason: "no-es-factura-dian", subject };

    // year/month derivados del IssueDate del XML (no del header del email).
    const issue = data.fecha ? new Date(data.fecha) : new Date();
    const year = issue.getFullYear();
    const month = issue.getMonth() + 1;

    // Skip facturas de años anteriores al actual (típico: cierre fiscal de
    // diciembre del año pasado llega al inbox en enero del año nuevo).
    // Etiqueta el email para no re-procesarlo en runs futuros.
    const minYear = parseInt(process.env.MIN_INVOICE_YEAR ?? "") || new Date().getFullYear();
    if (year < minYear) {
      await markEmailProcessed(gmail, messageId, labelId);
      return {
        skip: true,
        reason: `fecha-año-anterior (${data.fecha} < ${minYear})`,
        subject,
      };
    }

    // Tab del mes (Enero, Febrero...). Se crea con headers si no existe.
    const tabName = await getOrCreateMonthTab(sheets, g.sheetId, month);
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;

    const sheetRows = await loadSheetRows(tabName);
    if (isDuplicate(sheetRows, data.numero, data.nit)) {
      await markEmailProcessed(gmail, messageId, labelId);
      await applyMonthLabel(gmail, messageId, year, month);
      return { dup: true, motivo: `${data.proveedor} ${data.numero} (ya en ${tabName})`, subject };
    }

    // Calcular N° consecutivo del mes: max(col A) + 1. Header en row 0 → data en row 1+.
    let maxN = 0;
    for (let i = 1; i < sheetRows.length; i++) {
      const v = parseInt(String(sheetRows[i][0] ?? ""), 10);
      if (!isNaN(v) && v > maxN) maxN = v;
    }
    const consecutivo = maxN + 1;

    const folderId = await getOrCreateMonthFolder(drive, g.driveFolderId, year, month);

    let driveLink = "";
    // Naming: "{N}. {Proveedor}.pdf" — ej "1. Seguros De Vida Suramericana.pdf"
    // El mes está en la carpeta padre YYYY-MM/, no se repite en el filename.
    // XMLs: "{N}.1. {Proveedor}.xml", "{N}.2. {Proveedor}.xml"...
    // {N}.3 reservado para comprobante de pago (futuro sub-pipeline).
    const baseName = buildFileBaseName(consecutivo, data.proveedor);
    if (pdfPath) {
      const uploaded = await uploadFile(drive, pdfPath, folderId, `${baseName}.pdf`);
      driveLink = uploaded.webViewLink || "";
    }
    for (let j = 0; j < xmlPaths.length; j++) {
      const xmlName = buildFileBaseName(consecutivo, data.proveedor, j + 1);
      await uploadFile(drive, xmlPaths[j], folderId, `${xmlName}.xml`);
    }

    const { categoria, cuentaPyg } = categorizar({ nit: data.nit, concepto: data.concepto });
    const row: ProcessedRow = {
      ...data, driveLink, subject, categoria, cuentaPyg,
      tipo: "factura_dian",
    };
    const newRow = await appendToSheet(sheets, g.sheetId, tabRange, consecutivo, row);
    pushToCache(tabName, newRow);
    await markEmailProcessed(gmail, messageId, labelId);
    await applyMonthLabel(gmail, messageId, year, month);

    return { ok: true, ...row };
  } finally {
    // Cleanup garantizado de tmp paths (FIX: leak de /tmp en Netlify functions)
    cleanupTmp(tmpPaths);
  }
}

/**
 * Sub-pipeline planillas seguridad social (PILA Colombia).
 *
 * Refactor 2026-05-07: las planillas ya NO van a una subcarpeta `Seguridad Social/`,
 * sino al folder del mes regular (`YYYY-MM/`) e insertan UNA fila en el Sheet con
 * categoría "Seguridad Social" y total=0 (Tomás edita manual el monto).
 *
 * Razón: que cliente vea TODOS los gastos del mes en un solo lugar (Drive + Sheet),
 * no en silos separados. Más simple para conciliar.
 *
 * Sin OCR del PDF — el monto queda 0 hasta que Tomás lo edite. Los archivos
 * conservan el nombre `{N}. Planilla Seguridad Social.pdf` (autoliquidación) y
 * `{N}.1. Planilla Seguridad Social.pdf` (comprobante) para que se vea ordenado
 * en Drive.
 */
async function processPlanilla(
  messageId: string,
  labelProcesadoId: string,
  gmail: any,
  drive: any,
  sheets: any,
  g: PipelineConfig["google"],
  planillas: Array<{ filename: string; attachmentId: string }>,
  subject: string,
  msg: any,
  loadSheetRows: (tabName: string) => Promise<any[][]>,
  pushToCache: (tabName: string, row: any[]) => void,
): Promise<ProcessOneResult> {
  const tmpPaths: string[] = [];
  try {
    // 1. Fecha del email → year/month (las planillas no tienen XML con IssueDate,
    //    así que usamos la fecha de recepción como aproximación).
    const dateHeader = getHeader(msg, "Date") || new Date().toISOString();
    const emailDate = new Date(dateHeader);
    const year = emailDate.getFullYear();
    const month = emailDate.getMonth() + 1;
    const fechaIso = `${year}-${String(month).padStart(2, "0")}-${String(emailDate.getDate()).padStart(2, "0")}`;

    // 2. Tab del mes + folder del mes
    const tabName = await getOrCreateMonthTab(sheets, g.sheetId, month);
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;
    const folderId = await getOrCreateMonthFolder(drive, g.driveFolderId, year, month);

    // 3. Calcular consecutivo
    const sheetRows = await loadSheetRows(tabName);
    let maxN = 0;
    for (let i = 1; i < sheetRows.length; i++) {
      const v = parseInt(String(sheetRows[i][0] ?? ""), 10);
      if (!isNaN(v) && v > maxN) maxN = v;
    }
    const consecutivo = maxN + 1;

    // 4. Proveedor: hardcoded "Planilla Seguridad Social" (más claro y consistente).
    //    Antes: derivábamos del sender, pero remitentes con display name corto
    //    (ej: 'T <...>', 'M <...>' por forwards de Gmail) generaban proveedor = 'T' / 'M'.
    //    Cuando hagamos OCR del PDF de planilla extraeremos el operador real
    //    (Aportes en Línea, SOI, etc).
    const proveedor = "Planilla Seguridad Social";

    // 5. N° planilla del filename (típicamente "Autoliquidaciones_84333812_..." → 84333812)
    const numeroPlanilla = (() => {
      for (const p of planillas) {
        const m = p.filename.match(/(\d{6,})/);
        if (m) return m[1];
      }
      return "";
    })();

    // 6. Subir PDFs al folder del mes con naming "{N}. Planilla SS" + sub-índices
    const baseName = buildFileBaseName(consecutivo, proveedor);
    let driveLink = "";
    let n = 0;
    for (const p of planillas) {
      const tmpPath = await downloadAttachment(gmail, messageId, p.attachmentId, p.filename);
      tmpPaths.push(tmpPath);
      try {
        const fileName = n === 0
          ? `${baseName}.pdf`
          : `${buildFileBaseName(consecutivo, proveedor, n + 1)}.pdf`;
        const uploaded = await uploadFile(drive, tmpPath, folderId, fileName);
        if (n === 0) driveLink = uploaded.webViewLink || "";
        n++;
      } catch (e: any) {
        console.warn(`processPlanilla: upload "${p.filename}" failed: ${e.message}`);
      }
    }

    // 7. Construir ProcessedRow + insertar fila en el Sheet
    const data: InvoiceData = {
      fecha: fechaIso,
      proveedor,
      nit: "",
      numero: numeroPlanilla,
      cufe: "",
      subtotal: 0,
      iva: 0,
      total: 0,
      concepto: "Planilla Seguridad Social",
    };
    const row: ProcessedRow = {
      ...data,
      driveLink,
      subject,
      categoria: "Seguridad Social",
      cuentaPyg: "5202 - Seguridad social",
      tipo: "planilla_ss",
    };
    const newRow = await appendToSheet(sheets, g.sheetId, tabRange, consecutivo, row);
    pushToCache(tabName, newRow);

    // 8. Labels: Procesado + Facturas/YYYY-MM (mismo flujo que facturas DIAN)
    await markEmailProcessed(gmail, messageId, labelProcesadoId);
    await applyMonthLabel(gmail, messageId, year, month);

    return { ok: true, ...row };
  } finally {
    cleanupTmp(tmpPaths);
  }
}

/**
 * Sub-pipeline cuenta de cobro Word (.docx).
 *
 * Los proveedores no obligados a facturación electrónica (personas naturales,
 * contratistas, freelancers) emiten cuentas de cobro en Word con campos no
 * estructurados. Las extraemos con LLM (Claude) y las guardamos en el Sheet
 * con tipo='cuenta_cobro'.
 *
 * Se requiere env var ANTHROPIC_API_KEY. Si no está, skip silencioso con razón.
 */
async function processCuentaCobroDocx(
  messageId: string,
  labelProcesadoId: string,
  gmail: any,
  drive: any,
  sheets: any,
  g: PipelineConfig["google"],
  docxs: Array<{ filename: string; attachmentId: string }>,
  subject: string,
  msg: any,
  loadSheetRows: (tabName: string) => Promise<any[][]>,
  pushToCache: (tabName: string, row: any[]) => void,
  llmTracker: LlmTracker,
): Promise<ProcessOneResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      skip: true,
      reason: "docx-sin-api-key (configurar ANTHROPIC_API_KEY)",
      subject,
    };
  }

  const tmpPaths: string[] = [];
  try {
    // 1. Descargar el primer .docx (asumimos 1 cuenta de cobro por email)
    const d = docxs[0];
    const docxPath = await downloadAttachment(gmail, messageId, d.attachmentId, d.filename);
    tmpPaths.push(docxPath);

    // 2. Extraer texto plano del Word
    const { extractTextFromDocx } = await import("./doc-parsers");
    const text = await extractTextFromDocx(docxPath);
    if (!text || text.length < 30) {
      return { skip: true, reason: "docx-sin-texto-extraible", subject };
    }

    // PRE-FILTRO C: el texto debe tener indicadores de factura. Sino, no
    // gastamos una llamada LLM en algo que claramente no lo es.
    const { hasInvoiceIndicators } = await import("./llm-pre-filters");
    if (!hasInvoiceIndicators(text)) {
      llmTracker.preFilteredOut++;
      await markEmailProcessed(gmail, messageId, labelProcesadoId);
      return {
        skip: true,
        reason: "docx-sin-indicadores-factura",
        subject,
      };
    }

    // 3. Llamar al LLM para extraer campos estructurados
    const { extractInvoiceFromText } = await import("./llm-extractor");
    const sender = getHeader(msg, "From") || "";
    const dateHeader = getHeader(msg, "Date") || "";
    llmTracker.calls++;
    const extracted = await extractInvoiceFromText({
      text,
      presumedType: "cuenta_cobro",
      filename: d.filename,
      sender,
      subject,
      emailDate: dateHeader,
    });
    if (!extracted) {
      return { skip: true, reason: "docx-no-es-factura (LLM)", subject };
    }
    if (extracted.confianza < 0.4) {
      return {
        skip: true,
        reason: `docx-baja-confianza (${extracted.confianza.toFixed(2)}): ${extracted.notas ?? ""}`,
        subject,
      };
    }

    // 4. Year/month del documento
    const issue = new Date(extracted.fecha + "T00:00:00");
    const year = issue.getFullYear();
    const month = issue.getMonth() + 1;

    // Skip pre-año-actual (mismo guard que facturas DIAN)
    const minYear = parseInt(process.env.MIN_INVOICE_YEAR ?? "") || new Date().getFullYear();
    if (year < minYear) {
      await markEmailProcessed(gmail, messageId, labelProcesadoId);
      return {
        skip: true,
        reason: `docx-fecha-año-anterior (${extracted.fecha} < ${minYear})`,
        subject,
      };
    }

    // 5. Tab del mes + folder del mes
    const tabName = await getOrCreateMonthTab(sheets, g.sheetId, month);
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;
    const folderId = await getOrCreateMonthFolder(drive, g.driveFolderId, year, month);

    // 6. Dedup por NIT+número en el Sheet
    const sheetRows = await loadSheetRows(tabName);
    if (extracted.nit && extracted.numero && isDuplicate(sheetRows, extracted.numero, extracted.nit)) {
      await markEmailProcessed(gmail, messageId, labelProcesadoId);
      await applyMonthLabel(gmail, messageId, year, month);
      return {
        dup: true,
        motivo: `${extracted.proveedor} ${extracted.numero} (ya en ${tabName})`,
        subject,
      };
    }

    // 7. Consecutivo
    let maxN = 0;
    for (let i = 1; i < sheetRows.length; i++) {
      const v = parseInt(String(sheetRows[i][0] ?? ""), 10);
      if (!isNaN(v) && v > maxN) maxN = v;
    }
    const consecutivo = maxN + 1;

    // 8. Subir el .docx al folder del mes
    const baseName = buildFileBaseName(consecutivo, extracted.proveedor);
    const uploaded = await uploadFile(drive, docxPath, folderId, `${baseName}.docx`);
    const driveLink = uploaded.webViewLink || "";

    // 9. Append al Sheet
    const { categoria, cuentaPyg } = categorizar({
      nit: extracted.nit,
      concepto: extracted.concepto,
    });
    const row: ProcessedRow = {
      fecha: extracted.fecha,
      proveedor: extracted.proveedor,
      nit: extracted.nit,
      numero: extracted.numero,
      cufe: "",
      subtotal: extracted.subtotal,
      iva: extracted.iva,
      total: extracted.totalCop,  // siempre en COP en el Sheet
      concepto: extracted.concepto + (extracted.moneda !== "COP" ? ` (${extracted.moneda})` : ""),
      driveLink,
      subject,
      categoria,
      cuentaPyg,
      tipo: "cuenta_cobro",
    };
    const newRow = await appendToSheet(sheets, g.sheetId, tabRange, consecutivo, row);
    pushToCache(tabName, newRow);

    // 10. Labels
    await markEmailProcessed(gmail, messageId, labelProcesadoId);
    await applyMonthLabel(gmail, messageId, year, month);

    console.log(`[cuenta-cobro] ${extracted.proveedor} #${extracted.numero} ${extracted.totalCop} (${extracted.moneda}) confianza=${extracted.confianza.toFixed(2)}`);

    return { ok: true, ...row };
  } finally {
    cleanupTmp(tmpPaths);
  }
}

/**
 * Sub-pipeline PDF genérico (recibos internacionales + servicios locales no-DIAN).
 *
 * Cubre: Stripe, PayPal, AWS, Notion, GitHub, Anthropic, OpenAI, recibos de
 * servicios públicos (luz/agua/internet) sin XML DIAN.
 *
 * Detecta sender para decidir presumedType:
 *   - Sender internacional conocido → recibo_internacional
 *   - Sender colombiano/desconocido → recibo_servicio (o LLM detecta no-factura)
 *
 * Si LLM dice "es_factura: false" (típico para confirmaciones de pago de
 * Stripe sin detalle), skip silencioso.
 */
async function processGenericPdf(
  messageId: string,
  labelProcesadoId: string,
  gmail: any,
  drive: any,
  sheets: any,
  g: PipelineConfig["google"],
  pdfs: Array<{ filename: string; attachmentId: string }>,
  subject: string,
  msg: any,
  loadSheetRows: (tabName: string) => Promise<any[][]>,
  pushToCache: (tabName: string, row: any[]) => void,
  llmTracker: LlmTracker,
): Promise<ProcessOneResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      skip: true,
      reason: "pdf-sin-api-key (configurar ANTHROPIC_API_KEY)",
      subject,
    };
  }

  const tmpPaths: string[] = [];
  try {
    const sender = getHeader(msg, "From") || "";
    const dateHeader = getHeader(msg, "Date") || "";

    // 1. Descargar primer PDF
    const p = pdfs[0];
    const pdfPath = await downloadAttachment(gmail, messageId, p.attachmentId, p.filename);
    tmpPaths.push(pdfPath);

    // 2. Extraer texto
    const { extractTextFromPdf, isLikelyInternationalSender } = await import("./doc-parsers");
    const text = await extractTextFromPdf(pdfPath);
    if (!text || text.length < 30) {
      return { skip: true, reason: "pdf-sin-texto-extraible", subject };
    }

    // PRE-FILTRO C: indicadores de factura en el texto. Skip si no los hay.
    const { hasInvoiceIndicators } = await import("./llm-pre-filters");
    if (!hasInvoiceIndicators(text)) {
      llmTracker.preFilteredOut++;
      await markEmailProcessed(gmail, messageId, labelProcesadoId);
      return {
        skip: true,
        reason: "pdf-sin-indicadores-factura",
        subject,
      };
    }

    // 3. Determinar tipo presumido
    const presumedType = isLikelyInternationalSender(sender)
      ? "recibo_internacional"
      : "recibo_servicio";

    // 4. LLM
    const { extractInvoiceFromText } = await import("./llm-extractor");
    llmTracker.calls++;
    const extracted = await extractInvoiceFromText({
      text,
      presumedType,
      filename: p.filename,
      sender,
      subject,
      emailDate: dateHeader,
    });
    if (!extracted) {
      return { skip: true, reason: `pdf-no-es-factura (LLM: ${presumedType})`, subject };
    }
    if (extracted.confianza < 0.4) {
      return {
        skip: true,
        reason: `pdf-baja-confianza (${extracted.confianza.toFixed(2)}): ${extracted.notas ?? ""}`,
        subject,
      };
    }

    // 5. Year/month + skip pre-año-actual
    const issue = new Date(extracted.fecha + "T00:00:00");
    const year = issue.getFullYear();
    const month = issue.getMonth() + 1;
    const minYear = parseInt(process.env.MIN_INVOICE_YEAR ?? "") || new Date().getFullYear();
    if (year < minYear) {
      await markEmailProcessed(gmail, messageId, labelProcesadoId);
      return {
        skip: true,
        reason: `pdf-fecha-año-anterior (${extracted.fecha} < ${minYear})`,
        subject,
      };
    }

    // 6. Tab + folder del mes
    const tabName = await getOrCreateMonthTab(sheets, g.sheetId, month);
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;
    const folderId = await getOrCreateMonthFolder(drive, g.driveFolderId, year, month);

    // 7. Dedup
    const sheetRows = await loadSheetRows(tabName);
    if (extracted.nit && extracted.numero && isDuplicate(sheetRows, extracted.numero, extracted.nit)) {
      await markEmailProcessed(gmail, messageId, labelProcesadoId);
      await applyMonthLabel(gmail, messageId, year, month);
      return {
        dup: true,
        motivo: `${extracted.proveedor} ${extracted.numero} (ya en ${tabName})`,
        subject,
      };
    }

    // 8. Consecutivo
    let maxN = 0;
    for (let i = 1; i < sheetRows.length; i++) {
      const v = parseInt(String(sheetRows[i][0] ?? ""), 10);
      if (!isNaN(v) && v > maxN) maxN = v;
    }
    const consecutivo = maxN + 1;

    // 9. Subir PDF a Drive
    const baseName = buildFileBaseName(consecutivo, extracted.proveedor);
    const uploaded = await uploadFile(drive, pdfPath, folderId, `${baseName}.pdf`);
    const driveLink = uploaded.webViewLink || "";

    // 10. Append al Sheet — anota moneda en concepto si != COP
    const { categoria, cuentaPyg } = categorizar({
      nit: extracted.nit,
      concepto: extracted.concepto,
    });
    const conceptoFinal = extracted.moneda !== "COP"
      ? `${extracted.concepto} [${extracted.moneda} ${extracted.total.toLocaleString("en-US")}]`
      : extracted.concepto;
    const row: ProcessedRow = {
      fecha: extracted.fecha,
      proveedor: extracted.proveedor,
      nit: extracted.nit,
      numero: extracted.numero,
      cufe: "",
      subtotal: extracted.subtotal,
      iva: extracted.iva,
      total: extracted.totalCop,
      concepto: conceptoFinal,
      driveLink,
      subject,
      categoria,
      cuentaPyg,
      tipo: presumedType, // "recibo_internacional" o "recibo_servicio"
    };
    const newRow = await appendToSheet(sheets, g.sheetId, tabRange, consecutivo, row);
    pushToCache(tabName, newRow);

    // 11. Labels
    await markEmailProcessed(gmail, messageId, labelProcesadoId);
    await applyMonthLabel(gmail, messageId, year, month);

    console.log(`[${presumedType}] ${extracted.proveedor} #${extracted.numero} ${extracted.totalCop} ${extracted.moneda} confianza=${extracted.confianza.toFixed(2)}`);

    return { ok: true, ...row };
  } finally {
    cleanupTmp(tmpPaths);
  }
}
