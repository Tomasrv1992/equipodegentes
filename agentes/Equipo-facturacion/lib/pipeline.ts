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
  /**
   * Reglas de retención del cliente (opcional). Si está, el engine
   * `aplicarReglasRetencion` decide qué retenciones aplicar (XML, oficio, override).
   * Si está null/undefined, retenciones quedan tal como vienen del XML.
   */
  retentionRules?: unknown | null;
  /** Municipio donde el cliente paga ICA (para cálculo de oficio). */
  municipioIca?: string | null;
  /**
   * NIT o cédula del cliente actual. Usado para detectar y descartar
   * facturas DONDE EL CLIENTE ES EMISOR (cuentas de cobro que él emite a
   * sus propios clientes) — sino se cuelan como gastos.
   * Si null, no se aplica el filtro (legacy / cron viejo).
   */
  nitCliente?: string | null;
  /**
   * Nombre del cliente (ej "DENTILANDIA", "Tomás Ramírez Villa").
   * Backup filter cuando el LLM no extrae NIT pero sí extrae el nombre del
   * proveedor — si el nombre coincide con el cliente (normalizado), se
   * detecta como auto-factura y skipea.
   */
  nombreCliente?: string | null;
  /**
   * SLUG real del cliente (ej "dentilandia", "freshco"). Lowercase, sin espacios.
   * Usado por el RPC get_next_consecutivo y otros lookups que requieren
   * identificador único. Si no se pasa, fallback a nombreCliente normalizado.
   */
  clienteSlug?: string | null;
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
    /**
     * Si está set (1-12), filtra el query Gmail a SOLO ese mes del año.
     * Usado por el dispatcher multi-pass: para clientes grandes en primer
     * run o force=true, en lugar de un único run que procesa todo el año
     * (y se timeoutea), dispara 12 invocaciones paralelas (1 por mes).
     * Cada una procesa <100 facturas en <5 min, cabe en el límite de 15 min
     * de Netlify Background Functions.
     */
    monthFilter?: number;
    /**
     * Window personalizada por rango de fechas (alternativa a monthFilter).
     * Útil para CHUNKS pequeños cuando un mes entero NO cabe en 15min Netlify.
     *
     * Ejemplo: para procesar primeros 5 días de enero:
     *   windowFrom = "2026/01/01", windowTo = "2026/01/06"
     *
     * Genera: `after:2026/01/01 before:2026/01/06` (Gmail incluye after, excluye before)
     *
     * Si está set, OVERRIDE monthFilter y window. Si NO, comportamiento normal.
     * Bug recovery 2026-05-15: Freshco enero (1340 emails) no cabía en 15min.
     */
    windowFrom?: string; // YYYY/MM/DD
    windowTo?: string;   // YYYY/MM/DD
    /**
     * Workers paralelos en el worker pool del pipeline. Default 5.
     *
     * REDUCIR a 2-3 cuando hay riesgo de hit Sheets API quota (300 reads/min
     * por usuario). Cada worker hace 3-4 reads/factura — 5 workers × 4 reads
     * × 8 fact/min = ~160 reads/min OK, pero con isDuplicate cache cold puede
     * escalar a 300+ RPM = quota exceeded.
     *
     * Caso real 2026-05-18 Freshco: 67/130 facturas erroraron con
     * 'Quota exceeded sheets.googleapis.com Read requests per minute'.
     * Bajar concurrency=2 resolvió.
     */
    concurrency?: number;
    /**
     * Si true, NO ejecuta ensureSheetSetup. Usado por el multi-pass: solo
     * el primer dispatch (mes=1) hace el setup, los otros 11 saltean
     * porque ya está hecho. Evita race conditions + reduce drásticamente
     * las llamadas concurrentes a Google Sheets API.
     */
    skipSheetSetup?: boolean;
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
   * Impuesto Nacional al Consumo (INC, TaxScheme=04). Aplica a restaurantes,
   * bebidas alcohólicas, ciertos servicios. NO es IVA. Si la factura no tiene
   * INC, queda en 0.
   */
  inc?: number;
  /**
   * Suma de impuestos distintos a IVA (01) e INC (04). Para casos especiales
   * (impuestos al combustible, bolsas plásticas, etc).
   */
  otrosImpuestos?: number;
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
  /**
   * Opcionales: el pipeline las setea después de parseInvoiceXml + categorizar().
   * El engine de retenciones las lee para decidir tarifa RTF de oficio.
   */
  categoria?: string;
  cuentaPyg?: string;
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
  /**
   * Consecutivo asignado en Sheet/Drive. Se propaga al payload del
   * agent_event para que el rebuild pueda recrear el Sheet con la
   * misma numeración que existe en Drive — sino los nombres de PDF
   * "244. FEL..." quedan desincronizados del row # del Sheet.
   */
  consecutivo?: number;
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
  /** From: header del email (para auditoría de descartes — pestaña "Descartes"). */
  sender?: string | null;
  /** Date: header del email parseado a ISO. Sirve para agrupar descartes por mes. */
  fechaEmail?: string | null;
}

export interface ErrorRow {
  messageId: string;
  error: string;
  asunto?: string;
  /** From: header del email — para reportar descartes con contexto. */
  sender?: string | null;
  /** Date: header del email parseado a ISO. */
  fechaEmail?: string | null;
}

export interface PipelineResult {
  procesadas: ProcessedRow[];
  errores: ErrorRow[];
  /** Saltadas: no es factura (filtro pre-LLM, sender/subject, LLM dice "no es factura"). */
  saltadas: SkippedRow[];
  /** Repetidas: factura válida pero YA estaba en el Sheet (dedup contra cache). */
  repetidas: SkippedRow[];
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

/**
 * Label viejo. Se mantiene para no re-procesar emails históricos que aún
 * tienen este label (durante la ventana de migración a labels nuevos
 * `Descartado/MOTIVO`). Después de migrar todo el histórico con el endpoint
 * apply-labels-historico, se puede eliminar esta constante y la exclusión
 * `-label:Procesado` del query Gmail.
 */
const PROCESSED_LABEL = "Procesado";

/**
 * Mapea un motivo (string libre que retorna el pipeline en skip/dup) a un
 * nombre de label final tipo `Descartado/MOTIVO`. Categorización pensada para
 * que Tomás pueda auditar visualmente desde Gmail por categoría.
 */
export function mapMotivoToLabel(motivo: string): string {
  const m = motivo.toLowerCase();
  if (m.startsWith("dup")) return "Descartado/Duplicado";
  if (m.includes("planilla-ss-tercero")) return "Descartado/PlanillaSS-Tercero";
  if (m === "no-es-factura-dian") return "Descartado/NotaCredito";
  if (
    m.includes("pdf-no-es-factura") ||
    m.includes("docx-no-es-factura") ||
    m.startsWith("pre-filter")
  ) return "Descartado/NoFactura";
  if (m.includes("self-emitted")) return "Descartado/AutoEmitida";
  if (m.startsWith("fecha-año-anterior") || m.startsWith("fecha-ano-anterior")) {
    return "Descartado/AnioAnterior";
  }
  if (
    m.includes("encrypted") ||
    m.includes("sin-texto") ||
    m === "sin-zip" ||
    m.startsWith("zip-sin-xml") ||
    m.startsWith("zip-no-procesable") ||
    m.includes("no-procesable")
  ) return "Descartado/NoProcesable";
  if (
    m.startsWith("factura-invalida") ||
    m.startsWith("docx-invalida") ||
    m.includes("dian-sin-numero") ||
    m.includes("pdf-invalido") ||
    m.includes("confianza-baja") ||
    m.startsWith("docx-confianza") ||
    m.startsWith("pdf-confianza")
  ) return "Descartado/Invalida";
  // Fallback: cualquier motivo no mapeado va a Otro para revisar después
  return "Descartado/Otro";
}

// ===== Entry point =====

export async function run(cfg: PipelineConfig): Promise<PipelineResult> {
  const { google: g, options = {} } = cfg;
  const {
    dryRun = false,
    limit = null,
    window = "30d",
    force = false,
    monthFilter,
    windowFrom,
    windowTo,
    concurrency,
    skipSheetSetup = false,
  } = options;

  // Query amplia: facturas DIAN (ZIP) + planillas SS + Word/PDFs no-DIAN.
  // El processOne distingue qué tipo es y aplica el sub-pipeline correspondiente.
  //
  // Prioridad del date filter (de mayor a menor):
  //   1. windowFrom + windowTo (chunks personalizados) — recovery Bug B
  //   2. monthFilter (1-12) — multi-pass por mes (estándar)
  //   3. window (legacy) — "30d" rolling o "YYYY/MM/DD" absoluta
  //
  // Si `force=true`, el query NO excluye `-label:Procesado` → re-lee emails
  // ya procesados (re-procesamiento explícito).
  let dateFilter: string;
  if (windowFrom && windowTo) {
    // Chunk personalizado: from inclusive, to exclusive (Gmail semántica)
    dateFilter = `after:${windowFrom} before:${windowTo}`;
    console.log(`[windowChunk] procesando ${windowFrom} → ${windowTo} (${dateFilter})`);
  } else if (monthFilter && monthFilter >= 1 && monthFilter <= 12) {
    const year = new Date().getFullYear();
    const mm = String(monthFilter).padStart(2, "0");
    const nextMonth = monthFilter === 12 ? 1 : monthFilter + 1;
    const nextYear = monthFilter === 12 ? year + 1 : year;
    const nmm = String(nextMonth).padStart(2, "0");
    dateFilter = `after:${year}/${mm}/01 before:${nextYear}/${nmm}/01`;
    console.log(`[monthFilter] procesando solo ${year}-${mm} (${dateFilter})`);
  } else {
    const isAbsoluteDate = /^\d{4}\/\d{2}\/\d{2}$/.test(window);
    dateFilter = isAbsoluteDate ? `after:${window}` : `newer_than:${window}`;
  }
  // Migración 2026-06: ahora cada email procesado lleva label `Facturas/YYYY-MM`
  // (exitoso) o `Descartado/MOTIVO` (descartado). Excluimos los tres labels
  // (Facturas, Descartado, Procesado-legacy) para no re-procesar emails ya tocados.
  // El label `Procesado` se mantiene durante la ventana de migración hasta que
  // el endpoint apply-labels-historico complete la re-etiquetación del histórico.
  const labelExclusion = force ? "" : "-label:Procesado -label:Facturas -label:Descartado ";
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
  // ensureSheetSetup hace muchas lecturas/escrituras al Sheet. En multi-pass
  // con 12 invocaciones paralelas, esto causa "Quota exceeded for Read requests"
  // y race conditions. Lo skippeamos en los 11 dispatches no-primero — el
  // primer dispatch (mes=1) lo ejecuta solo.
  if (!skipSheetSetup) {
    await ensureSheetSetup(sheets, g.sheetId);
  } else {
    console.log(`[skip-setup] cliente ya tiene setup hecho por otra invocación`);
  }

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
      repetidas: [],
      dryRun: { query: searchQuery, total: emails.length, sample: detailed },
    };
  }

  // Caché de Sheet rows POR pestaña-mes (key = "Enero", "Febrero"...).
  // Se carga lazy y se actualiza tras cada append. Soporta multi-mes en una corrida.
  //
  // BUG H FIX 2026-05-15 — duplicación masiva (Freshco abril 316×):
  //   El catch silencioso del try/catch viejo cacheaba `[]` cuando la API
  //   tiraba quota/timeout. Entonces TODAS las facturas siguientes en ese run
  //   veían el cache vacío → isDuplicate=false → cada una se appendea otra vez
  //   → Sheet acumula 1000× la realidad. Las llamadas a appendToSheet sí
  //   funcionan (escritura), pero como el cache de lectura estaba contaminado,
  //   no podía detectar dups.
  //
  //   Fix: si la lectura falla por error que NO sea "tab no existe", hacemos
  //   THROW para abortar el cliente entero ese run. Mejor perder un run que
  //   duplicar 1000× las filas. El próximo cron lo recupera.
  //
  //   Cómo distinguimos "tab no existe" (OK, lo crea getOrCreateMonthTab) de
  //   "quota/timeout" (NO OK, abortar): el error de Sheets API trae .code o
  //   .response.status. 400 con "Unable to parse range" = tab no existe. Resto
  //   son errores transitorios o reales — abortar.
  const sheetRowsCache = new Map<string, any[][]>();
  const loadSheetRows = async (tabName: string): Promise<any[][]> => {
    if (sheetRowsCache.has(tabName)) return sheetRowsCache.get(tabName)!;
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: g.sheetId,
        range: `${tabRange}!A:O`, // 15 cols nueva estructura (retenciones entre IVA y Total)
      });
      const rows = res.data.values || [];
      sheetRowsCache.set(tabName, rows);
      return rows;
    } catch (err: any) {
      const status = err?.code ?? err?.response?.status;
      const msg = String(err?.message ?? "");
      const isTabNotFound =
        status === 400 &&
        (msg.includes("Unable to parse range") ||
          msg.includes("not found"));
      if (isTabNotFound) {
        // Tab no existe — lo creará getOrCreateMonthTab. OK cachear [].
        sheetRowsCache.set(tabName, []);
        return [];
      }
      // Error transitorio o real (quota, timeout, 5xx, network).
      // NO cachear nada — sino el resto del run vería [] y duplicaría todo.
      // THROW para abortar este cliente y proteger integridad del Sheet.
      console.error(
        `[loadSheetRows] ERROR no-cacheable en ${tabName}: status=${status} msg=${msg}. Abortando para proteger Sheet (sino duplicaríamos).`,
      );
      throw new Error(
        `loadSheetRows ${tabName} failed (status=${status}): ${msg}. Abortando run para evitar duplicación masiva en Sheet.`,
      );
    }
  };

  // ATOMIC COUNTER del consecutivo POR pestaña-mes.
  //
  // Bug detectado 2026-05-15 (Freshco enero, ~50 filas duplicadas con mismo
  // consecutivo): cuando 5 workers procesaban facturas del mismo proveedor en
  // paralelo, todos leían el cache de sheetRows al mismo tiempo, calculaban
  // maxN+1 igual, y todos asignaban el MISMO consecutivo a facturas distintas.
  // Resultado: 5 filas en Sheet con #101 (números FEL distintos) y 5 PDFs en
  // Drive llamados "1. Comercializadora...pdf" (mismo nombre, contenido distinto).
  //
  // Fix: counter atómico en memoria. Cada worker que necesita un consecutivo
  // llama getNextConsecutivo() — la operación read+increment es ATOMIC en JS
  // single-thread entre awaits. Garantiza que cada worker recibe un valor único.
  const mesConsecutivoCounter = new Map<string, number>();
  const getNextConsecutivo = async (tabName: string): Promise<number> => {
    // FIX 2026-05-26: usar cfg.clienteSlug (el slug real lowercase, sin espacios)
    // en vez de cfg.nombreCliente (nombre con mayúsculas y espacios). El RPC
    // get_next_consecutivo guarda rows por (cliente_slug, tab_name), y si el
    // slug es "Dentilandia " (capital + espacio), un reset que busca
    // "dentilandia" NO encuentra esos rows y el contador queda alto eternamente.
    // Bug detectado en Dentilandia: consecutivos quedaron en 433-1630 incluso
    // tras resets sucesivos porque el slug guardado tenía espacio al final.
    const clienteSlug = (cfg.clienteSlug ?? cfg.nombreCliente ?? "unknown")
      .toString()
      .trim()
      .toLowerCase();

    // Intento 1: lock distribuido en Supabase (fuente de verdad entre chunks paralelos)
    try {
      const { getServerClient } = await import(
        "../../../shared/agents-runtime/src/supabase-server"
      );
      const supa = getServerClient();

      // Upsert atómico: si no existe la fila, la crea con el maxN del Sheet.
      // Si existe, incrementa. El RPC garantiza atomicidad (no hay race condition).
      const { data, error } = await supa.rpc("get_next_consecutivo", {
        p_cliente_slug: clienteSlug,
        p_tab_name: tabName,
      });

      if (!error && data != null) {
        return data as number;
      }
      // Si falla el RPC, fallback al counter en memoria
      console.warn(`[consecutivo] RPC falló (${error?.message}), usando counter en memoria`);
    } catch (e: any) {
      console.warn(`[consecutivo] Supabase no disponible (${e.message}), usando counter en memoria`);
    }

    // Fallback: counter en memoria (funciona dentro de un solo run)
    if (!mesConsecutivoCounter.has(tabName)) {
      const rows = await loadSheetRows(tabName);
      let maxN = 0;
      for (let i = 1; i < rows.length; i++) {
        const v = parseInt(String(rows[i][0] ?? ""), 10);
        if (!isNaN(v) && v > maxN) maxN = v;
      }
      mesConsecutivoCounter.set(tabName, maxN);
    }
    const next = (mesConsecutivoCounter.get(tabName) ?? 0) + 1;
    mesConsecutivoCounter.set(tabName, next);
    return next;
  };

  const result: PipelineResult = { procesadas: [], errores: [], saltadas: [], repetidas: [] };
  const llmTracker: LlmTracker = { calls: 0, preFilteredOut: 0 };

  // Contexto de retenciones para pasar a processOne (puede ser null si cliente
  // legacy sin reglas configuradas).
  const retentionCtx = cfg.retentionRules
    ? { rules: cfg.retentionRules, municipioIca: cfg.municipioIca ?? null }
    : null;

  // NIT/cédula del cliente — usado para detectar facturas self-emitted y skip.
  const nitCliente = cfg.nitCliente ? String(cfg.nitCliente).replace(/\D+/g, "") : null;
  // Nombre del cliente normalizado — backup filter cuando LLM no extrae NIT.
  const nombreClienteNorm = cfg.nombreCliente ? normalizeProveedorName(cfg.nombreCliente) : null;

  // CONCURRENCIA: procesar 5 emails en paralelo para reducir tiempo total ~5x.
  // Crítico para clientes con alto volumen (Tomas92, Patricia, Paulina) que
  // antes timeoutaban a los 15min de Netlify Background.
  //
  // Thread-safety:
  // - sheetRowsCache es un Map: writes son atómicos en JS single-thread
  //   (Node es event-loop, no preemptivo). pushToCache es safe.
  // - result.procesadas/saltadas/errores: arrays con .push() — JS garantiza
  //   atomicidad. No hay race conditions.
  // - llmTracker (counters): JS atomic. OK.
  // - El consecutivo Sheet ya no es cronológico, pero la col B (Fecha) es
  //   la verdad temporal — sin impacto funcional.
  // CONCURRENCY configurable via options.concurrency (default 1 = una por una).
  // INCIDENTE 2026-05-19: default 5 con safeAppendToSheet (lectura extra
  // pre-append) dispara quota Sheets (300 reads/min/user). Bajamos a 3.
  // INCIDENTE 2026-05-22 (Freshco): orden cronológico se rompe con paralelo
  // (factura del 31-ene puede recibir consecutivo antes que la del 02-ene).
  // Default permanente: 1 (serial, una por una, garantiza orden temporal).
  // Clientes con alto volumen pueden subirla via options.concurrency.
  const CONCURRENCY = Math.max(1, Math.min(10, concurrency ?? 1));
  console.log(`[pipeline] CONCURRENCY=${CONCURRENCY} para ${emails.length} emails`);
  const queue = [...emails];

  async function worker() {
    while (queue.length > 0) {
      const e = queue.shift();
      if (!e) return;
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
          retentionCtx,
          nitCliente,
          nombreClienteNorm,
          getNextConsecutivo,  // ← NUEVO: counter atómico per-mes
        );
        if ("ok" in r && r.ok) {
          result.procesadas.push(r);
        } else if ("dup" in r && r.dup) {
          // Enriquecer con metadata (sender + fecha) para reporte de descartes.
          const meta = await getMessageMetaLite(gmail, e.id!);
          result.repetidas.push({
            messageId: e.id!,
            motivo: r.motivo,
            asunto: r.subject,
            sender: meta.sender,
            fechaEmail: meta.fechaEmail,
          });
        } else if ("skip" in r && r.skip) {
          const meta = await getMessageMetaLite(gmail, e.id!);
          result.saltadas.push({
            messageId: e.id!,
            motivo: r.reason,
            asunto: r.subject,
            sender: meta.sender,
            fechaEmail: meta.fechaEmail,
          });
        }
      } catch (err: any) {
        // CLASIFICACIÓN DE ERROR: muchos "errores" no son fallas del pipeline,
        // son docs que no debían procesarse (extractos bancarios encriptados,
        // newsletters con adjuntos, PDFs escaneados sin texto). Antes todos
        // contaban como "error", inflando el contador y disparando WARN/FAIL
        // status del run. Ahora los reclasificamos como `saltadas` para que
        // el panel admin refleje la realidad.
        const msg = String(err?.message ?? "").toLowerCase();
        const esRuido =
          msg.includes("no password") ||
          msg.includes("password given") ||
          msg.includes("encrypted") ||
          msg.includes("sin texto") ||
          msg.includes("no extraible");
        if (esRuido) {
          let motivo = "doc-no-procesable";
          if (msg.includes("password") || msg.includes("encrypted")) motivo = "pdf-encrypted";
          else if (msg.includes("sin texto")) motivo = "pdf-no-text";
          const meta = await getMessageMetaLite(gmail, e.id!);
          result.saltadas.push({
            messageId: e.id!,
            motivo,
            asunto: meta.subject ?? undefined,
            sender: meta.sender,
            fechaEmail: meta.fechaEmail,
          });
        } else {
          const meta = await getMessageMetaLite(gmail, e.id!);
          result.errores.push({
            messageId: e.id!,
            error: err.message,
            asunto: meta.subject ?? undefined,
            sender: meta.sender,
            fechaEmail: meta.fechaEmail,
          });
        }
      }
    }
  }

  console.log(`[concurrency] processing ${emails.length} emails with ${CONCURRENCY} workers`);
  const startTime = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`[concurrency] done in ${Math.round((Date.now() - startTime) / 1000)}s · ${result.procesadas.length} procesadas, ${result.saltadas.length} saltadas, ${result.repetidas.length} repetidas, ${result.errores.length} errores`);

  // Adjuntar stats LLM al result (importante: aunque sea 0 si nunca llamó)
  result.llmStats = {
    calls: llmTracker.calls,
    estimatedCostUsd: Math.round(llmTracker.calls * 0.003 * 10000) / 10000,
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
 *
 * BUG C FIX 2026-05-15: antes el filename era `{consecutivo}. {Proveedor}`,
 * pero el consecutivo es per-mes y se reasigna en cada re-run. Si re-run-eábamos
 * facturas, varias terminaban con el mismo "1. Comercializadora..." aunque
 * fueran facturas distintas (consecutivos DIAN distintos). Drive entonces
 * sobrescribía archivos (cuando appProperties.unique_key falla) o creaba
 * "Sas (1).pdf, Sas (2).pdf" lo cual era confuso.
 *
 * Ahora el filename incluye también el numero DIAN o equivalente único —
 * garantiza unicidad sin importar cuántas veces se re-corra. Mantiene el
 * consecutivo al inicio para preservar orden visual en Drive.
 *
 * Ejemplos:
 *   buildFileBaseName(1, "SEGUROS DE VIDA SURAMERICANA", "FEL428843")
 *     → "1. FEL428843. Seguros De Vida Suramericana"
 *   buildFileBaseName(1, "SEGUROS DE VIDA SURAMERICANA", "FEL428843", 1)
 *     → "1. FEL428843.1. Seguros De Vida Suramericana"  (XML idx 1)
 *   buildFileBaseName(1, "Sin Proveedor", null)        // sin numero DIAN
 *     → "1. Sin Proveedor"                              // fallback al viejo formato
 */
function buildFileBaseName(
  n: number,
  proveedor: string,
  numeroDIAN?: string | null,
  subIdx?: number,
): string {
  // Title-case proveedor (capitaliza primera letra de cada palabra), max 60 chars
  const provClean = String(proveedor || "Sin Proveedor")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 60)
    .trim();

  // numeroDIAN sanitizado (sin caracteres que rompan filename)
  const numClean = numeroDIAN
    ? String(numeroDIAN).replace(/[\\/:*?"<>|]/g, "-").trim()
    : "";

  if (!numClean) {
    // Fallback al formato viejo (cuando no hay numero DIAN — raro, casos
    // donde el LLM no extrajo numero o son docs no-DIAN sin identificador).
    const N = subIdx != null ? `${n}.${subIdx}` : `${n}`;
    return `${N}. ${provClean}`;
  }

  // Formato nuevo: {consecutivo}. {numeroDIAN}[.{subIdx}]. {Proveedor}
  const numPart = subIdx != null ? `${numClean}.${subIdx}` : numClean;
  return `${n}. ${numPart}. ${provClean}`;
}

// Headers: 15 columnas. Retenciones AHORA entre IVA y Total a Pagar (no al final).
// "Total a Pagar" se calcula como Subtotal + IVA - ReteFuente - ReteIVA - ReteICA
// = lo que el cliente le paga REALMENTE al proveedor (post-retenciones).
// "# Documento" reemplaza "N° Factura" — sirve para facturas DIAN y cuentas de cobro.
// Pestañas con esquema viejo (12 o 16 cols) se reescriben automáticamente.
const SHEET_HEADERS = [
  "#", "Fecha", "Proveedor", "NIT", "# Documento",       // A-E
  "Subtotal", "IVA",                                      // F-G
  "ReteFuente", "ReteIVA", "ReteICA",                     // H-I-J
  "Total a Pagar",                                        // K
  "Concepto", "Categoría", "Cuenta PYG", "Link PDF",      // L-O
];
const SHEET_HEADERS_COUNT = SHEET_HEADERS.length; // 15

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
/**
 * Wrapper de llamadas a Google Sheets API con retry para quota exceeded.
 * Google Sheets Read API limit: 300/min/usuario. Cuando se excede, devuelve
 * 429 ó 403 con mensaje "Quota exceeded". Retry con backoff exponencial.
 */
async function withSheetRetry<T>(fn: () => Promise<T>, label = "sheet-op"): Promise<T> {
  const MAX_RETRIES = 4;
  let lastError: any = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const code = err?.code ?? err?.response?.status ?? err?.status;
      const msg = err?.message ?? "";
      const isQuota =
        code === 429 ||
        (code === 403 && /quota/i.test(msg)) ||
        /Quota exceeded|RATE_LIMIT_EXCEEDED/i.test(msg);
      if (!isQuota || attempt === MAX_RETRIES) throw err;
      const delayMs = Math.pow(2, attempt) * 2000 + Math.floor(Math.random() * 1000); // 2s, 4s, 8s, 16s + jitter
      console.warn(`[${label}] quota exceeded — retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

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
  //
  //    CONCURRENCIA: en multi-pass, 12 invocaciones intentan recrear el
  //    Dashboard al mismo tiempo. Wrappamos las operaciones con try/catch
  //    para tolerar errores "ya existe" / "no existe" cuando otra invocación
  //    ya hizo el trabajo. Idempotencia robusta.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existingDashboard = meta.data.sheets?.find(
    (s: any) => s.properties?.title === DASHBOARD_TAB,
  );
  if (existingDashboard) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            deleteSheet: { sheetId: existingDashboard.properties.sheetId },
          }],
        },
      });
    } catch (e: any) {
      // Si otra invocación ya borró → ignorar ("No sheet with id...")
      if (!/No sheet|not found/i.test(e.message ?? "")) throw e;
      console.log(`[ensureSheetSetup] dashboard ya borrado por otra invocación — skip`);
    }
  }

  // Crear Dashboard como PRIMERA pestaña (index: 0)
  let dashSheetId: number | null | undefined;
  try {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: DASHBOARD_TAB,
              index: 0,
              gridProperties: { rowCount: 60, columnCount: 6 },
            },
          },
        }],
      },
    });
    dashSheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;
  } catch (e: any) {
    // Si otra invocación ya lo creó, buscarlo
    if (!/already exists|Ya existe/i.test(e.message ?? "")) throw e;
    console.log(`[ensureSheetSetup] dashboard ya creado por otra invocación — buscando ID`);
    const meta2 = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existing = meta2.data.sheets?.find(
      (s: any) => s.properties?.title === DASHBOARD_TAB,
    );
    dashSheetId = existing?.properties?.sheetId;
    if (dashSheetId == null) {
      // Race condition pierde — otra invocación lo manejará. Skip resto.
      console.warn(`[ensureSheetSetup] no encontró dashSheetId, skip resto de setup`);
      return;
    }
  }

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
  // Rango consolidado de las 12 pestañas (para QUERY). 15 cols → A2:O.
  // Col en QUERY: 1=#, 2=Fecha, 3=Proveedor, 4=NIT, 5=#Doc, 6=Subtotal, 7=IVA,
  // 8=ReteFuente, 9=ReteIVA, 10=ReteICA, 11=Total a Pagar, 12=Concepto,
  // 13=Categoría, 14=Cuenta PYG, 15=Link PDF.
  const allMonthsRange = MES_TABS.map((m) => `'${m}'!A2:O`).join(";");

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
    // Row 6: Monto (Total a Pagar = col K)
    ["Total a Pagar (COP)", `=SUM(INDIRECT(CHOOSE(MONTH(TODAY());${monthChooseStr})&"!K2:K1000"))`, "", "", "", ""],
    // Row 7: Tiempo
    ["Tiempo ahorrado", `=ROUND(B5*10/60;1)&" h (10 min/factura)"`, "", "", "", ""],
    // Row 8: vacío
    ["", "", "", "", "", ""],
    // Row 9: header sección
    ["HISTÓRICO 2026", "", "", "", "", ""],
    // Row 10: headers
    ["Mes", "Facturas", "Total a Pagar (COP)", "", "", ""],
    // Row 11-22: 12 meses (Total a Pagar = col K)
    ...MES_TABS.map((m) => [
      m,
      `=COUNTA('${m}'!A2:A1000)`,
      `=SUM('${m}'!K2:K1000)`,
      "", "", "",
    ]),
    // Row 23: Total
    ["TOTAL", `=SUM(B11:B22)`, `=SUM(C11:C22)`, "", "", ""],
    // Row 24: vacío
    ["", "", "", "", "", ""],
    // Row 25: header sección
    ["TOP 5 PROVEEDORES (todo el año)", "", "", "", "", ""],
    // Row 26: QUERY — Col3=Proveedor, Col11=Total a Pagar
    [
      `=QUERY({${allMonthsRange}};"select Col3, count(Col3), sum(Col11) where Col3 is not null and Col3 <> '' group by Col3 order by count(Col3) desc limit 5 label Col3 'Proveedor', count(Col3) 'Facturas', sum(Col11) 'Total a Pagar'";0)`,
      "", "", "", "", "",
    ],
    // Rows 27-31 reservadas para el resultado del QUERY (5 filas)
    [], [], [], [], [],
    // Row 32: vacío
    ["", "", "", "", "", ""],
    // Row 33: header sección
    ["TOP 5 CATEGORÍAS (todo el año)", "", "", "", "", ""],
    // Row 34: QUERY — Col13=Categoría, Col11=Total a Pagar
    [
      `=QUERY({${allMonthsRange}};"select Col13, count(Col13), sum(Col11) where Col13 is not null and Col13 <> '' group by Col13 order by count(Col13) desc limit 5 label Col13 'Categoría', count(Col13) 'Facturas', sum(Col11) 'Total a Pagar'";0)`,
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
    // Row 43: ReteFuente = SUM de cols H de las 12 pestañas
    ["ReteFuente", `=${MES_TABS.map((m) => `SUM('${m}'!H:H)`).join("+")}`, "", "", "", ""],
    // Row 44: ReteIVA = col I
    ["ReteIVA", `=${MES_TABS.map((m) => `SUM('${m}'!I:I)`).join("+")}`, "", "", "", ""],
    // Row 45: ReteICA = col J
    ["ReteICA", `=${MES_TABS.map((m) => `SUM('${m}'!J:J)`).join("+")}`, "", "", "", ""],
    // Row 46: Total retenciones (suma de las 3 anteriores)
    ["Total retenido", `=B43+B44+B45`, "", "", "", ""],
    // Row 47: Bruto (Subtotal + IVA) = Total a Pagar + Retenciones
    ["Bruto facturado", `=C23+B46`, "(Total a Pagar + Total retenido)", "", "", ""],
    // Row 48: vacío
    ["", "", "", "", "", ""],
    // Row 49: header sección RETENCIONES MES ACTUAL
    ["RETENCIONES MES ACTUAL", "", "", "", "", ""],
    // Row 50: headers
    ["Tipo", "Monto (COP)", "", "", "", ""],
    // Row 51: ReteFuente del mes (col H)
    ["ReteFuente del mes", `=SUM(INDIRECT(CHOOSE(MONTH(TODAY());${monthChooseStr})&"!H:H"))`, "", "", "", ""],
    // Row 52: ReteIVA del mes (col I)
    ["ReteIVA del mes", `=SUM(INDIRECT(CHOOSE(MONTH(TODAY());${monthChooseStr})&"!I:I"))`, "", "", "", ""],
    // Row 53: ReteICA del mes (col J)
    ["ReteICA del mes", `=SUM(INDIRECT(CHOOSE(MONTH(TODAY());${monthChooseStr})&"!J:J"))`, "", "", "", ""],
    // Row 54: Total retenciones del mes (suma de las 3 anteriores)
    ["Total retenido mes", `=B51+B52+B53`, "", "", "", ""],
    // Row 55: Bruto facturado mes (Total a Pagar del mes + retenciones del mes)
    ["Bruto facturado mes", `=B6+B54`, "(Total a Pagar mes + Total retenido mes)", "", "", ""],
  ];

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${DASHBOARD_TAB}'!A1:F${content.length}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: content },
    });
  } catch (e: any) {
    console.warn(`[ensureSheetSetup] update dashboard content falló (concurrencia): ${e.message}`);
  }

  // 4. Formato visual (tolerante a concurrencia)
  if (dashSheetId != null) {
    try {
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
          // Headers de sección (rows 3, 9, 25, 33, 41, 49): bold con fondo claro
          ...[2, 8, 24, 32, 40, 48].map((rowIdx) => ({
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
          // Retenciones AÑO (rows 43-47): formato moneda en col B
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 42, endRowIndex: 47, startColumnIndex: 1, endColumnIndex: 2 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // Retenciones AÑO header tabla (row 42)
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 41, endRowIndex: 42, startColumnIndex: 0, endColumnIndex: 3 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat",
            },
          },
          // Total retenido + Neto pagado año (rows 46-47): bold + fondo
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
          // Retenciones MES (rows 51-55): formato moneda en col B
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 50, endRowIndex: 55, startColumnIndex: 1, endColumnIndex: 2 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // Retenciones MES header tabla (row 50)
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 49, endRowIndex: 50, startColumnIndex: 0, endColumnIndex: 3 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat",
            },
          },
          // Total retenido + Neto pagado mes (rows 54-55): bold + fondo
          {
            repeatCell: {
              range: { sheetId: dashSheetId, startRowIndex: 53, endRowIndex: 55, startColumnIndex: 0, endColumnIndex: 3 },
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
              range: { sheetId: dashSheetId, startRowIndex: 3, endRowIndex: 55, startColumnIndex: 1, endColumnIndex: 3 },
              cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
              fields: "userEnteredFormat.horizontalAlignment",
            },
          },
          // Bordes en todas las celdas con data (rows 3-55, cols A-C)
          {
            updateBorders: {
              range: { sheetId: dashSheetId, startRowIndex: 2, endRowIndex: 55, startColumnIndex: 0, endColumnIndex: 3 },
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
    } catch (e: any) {
      // Concurrencia: el dashboard puede estar siendo modificado por otra
      // invocación. Idempotente — la próxima ejecución completará el formato.
      console.warn(`[ensureSheetSetup] formato Dashboard falló (concurrencia): ${e.message}`);
    }
  }
}

/**
 * Devuelve el nombre del tab del mes (ej "Enero", "Febrero"...). Si no existe,
 * lo crea con headers + frozen + bold + centrado + formato moneda + auto-resize.
 * Idempotente.
 *
 * Migración automática: si la pestaña existe con DIFERENTE número de columnas
 * que SHEET_HEADERS_COUNT (versión vieja: 12 o 16 cols), DROP + RECREATE.
 * Tomás está al tanto de que los datos viejos se borran — la idea es re-disparar
 * con force=true después del deploy y todo se regenera con el formato nuevo.
 */
async function getOrCreateMonthTab(sheets: any, sheetId: string, month: number): Promise<string> {
  const tabName = MES_TABS[month - 1];
  if (!tabName) throw new Error(`Mes inválido: ${month}`);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets?.find((s: any) => s.properties?.title === tabName);

  if (existing) {
    const existingCols = existing.properties?.gridProperties?.columnCount ?? 0;
    // FIX 2026-05-27: tolerar columnas EXTRAS (>= SHEET_HEADERS_COUNT).
    // Antes el código exigía == SHEET_HEADERS_COUNT y borraba la pestaña si
    // tenía 16+ cols (caso real: usuario agregó columna "Veces Repetido"
    // manualmente para detectar duplicados → borró 134 facturas de Abril).
    // Ahora solo migra si tiene MENOS columnas que el esquema (legacy).
    if (existingCols >= SHEET_HEADERS_COUNT) {
      return tabName; // OK como está (puede tener cols extras del usuario)
    }
    // Esquema viejo (12 cols o menos) → DROP y recrear con esquema nuevo (15 cols).
    console.log(`[migrate-tab] ${tabName}: ${existingCols} cols → drop + recreate (${SHEET_HEADERS_COUNT} cols)`);
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: existing.properties.sheetId } }],
        },
      });
    } catch (e: any) {
      // Concurrencia: otra invocación ya borró/migró el tab. Re-leer estado.
      if (!/No sheet|not found/i.test(e.message ?? "")) throw e;
      console.log(`[migrate-tab] ${tabName} ya migrado por otra invocación`);
      return tabName;
    }
    // Fallthrough al bloque de creación abajo
  }

  // Crear desde cero con 15 cols + formato completo
  let newTabId: number | null | undefined;
  try {
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
    newTabId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;
  } catch (e: any) {
    // Concurrencia: otra invocación ya creó el tab.
    if (!/already exists|Ya existe/i.test(e.message ?? "")) throw e;
    console.log(`[migrate-tab] ${tabName} ya creado por otra invocación — skip creación`);
    return tabName;
  }

  // Escribir headers
  const endColLetter = String.fromCharCode("A".charCodeAt(0) + SHEET_HEADERS_COUNT - 1); // "O"
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${tabName}'!A1:${endColLetter}1`,
    valueInputOption: "RAW",
    requestBody: { values: [SHEET_HEADERS] },
  });

  if (newTabId != null) {
    // Cols de moneda: F=Subtotal, G=IVA, H=ReteFuente, I=ReteIVA, J=ReteICA, K=Total a Pagar
    // Indices: F=5, G=6, H=7, I=8, J=9, K=10 (0-indexed). endIndex es exclusive → 11.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          // 1) Headers: bold + bg azul claro + centrado vertical/horizontal
          {
            repeatCell: {
              range: { sheetId: newTabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS_COUNT },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.9, green: 0.9, blue: 0.95 },
                  horizontalAlignment: "CENTER",
                  verticalAlignment: "MIDDLE",
                  wrapStrategy: "WRAP",
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy)",
            },
          },
          // 2) Filas de datos (1-999): centrado horizontal + vertical
          {
            repeatCell: {
              range: { sheetId: newTabId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS_COUNT },
              cell: {
                userEnteredFormat: { horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" },
              },
              fields: "userEnteredFormat(horizontalAlignment,verticalAlignment)",
            },
          },
          // 3) Cols F-K (Subtotal, IVA, las 3 retenciones, Total a Pagar): formato moneda COP
          {
            repeatCell: {
              range: { sheetId: newTabId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 5, endColumnIndex: 11 },
              cell: {
                userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // 4) Auto-resize todas las columnas al contenido
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId: newTabId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: SHEET_HEADERS_COUNT,
              },
            },
          },
        ],
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
  let pages = 0;
  try {
    do {
      pages++;
      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 500,
        pageToken,
      });
      const batch = res.data.messages ?? [];
      out.push(...batch);
      const nextTok = res.data.nextPageToken;
      console.log(
        `[gmail-list] page=${pages} batch=${batch.length} nextToken=${nextTok ? "yes" : "no"} totalSoFar=${out.length}`,
      );
      pageToken = nextTok ?? undefined;
    } while (pageToken);
  } catch (err: any) {
    console.error(
      `[gmail-list] FATAL after page=${pages} total=${out.length}: ${err.message}`,
    );
    throw new Error(
      `findInvoiceEmails falló en página ${pages} con ${out.length} emails leídos: ${err.message}. El run se aborta para evitar procesamiento parcial silencioso.`,
    );
  }
  console.log(`[gmail-list] DONE pages=${pages} total=${out.length} query="${query}"`);
  // Gmail API devuelve por defecto orden DESC (más nuevo primero). Reverse →
  // orden cronológico ASC (más viejo primero). Esto asegura procesamiento
  // ordenado: factura 1 del mes → factura N. Importante cuando concurrency=1
  // y cuando se asigna consecutivo (Drive/Sheet quedan en orden temporal real).
  return out.reverse();
}

async function getMessageFull(gmail: any, messageId: string) {
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return res.data;
}

/**
 * Light fetch: solo headers From, Subject, Date — sin bajar adjuntos.
 * Usado por el worker cuando hay skip/dup, para enriquecer el reporte de
 * descartes con sender/fecha del email (sino solo tenemos messageId).
 * Cuesta 1 API call Gmail por descarte — aceptable (<5% del total típico).
 */
async function getMessageMetaLite(
  gmail: any,
  messageId: string,
): Promise<{ sender: string | null; subject: string | null; fechaEmail: string | null }> {
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers: Array<{ name?: string; value?: string }> = res.data?.payload?.headers ?? [];
    const get = (name: string) =>
      headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? null;
    const dateHeader = get("Date");
    let fechaIso: string | null = null;
    if (dateHeader) {
      const d = new Date(dateHeader);
      if (!isNaN(d.getTime())) fechaIso = d.toISOString();
    }
    return {
      sender: get("From"),
      subject: get("Subject"),
      fechaEmail: fechaIso,
    };
  } catch {
    return { sender: null, subject: null, fechaEmail: null };
  }
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
 * Aplica label `Descartado/MOTIVO` al email descartado + remueve INBOX (archiva).
 * Reemplaza el viejo `markEmailProcessed` para emails que NO entraron al Sheet.
 *
 * Mantiene también el label `Procesado` (legacy) para no romper la query Gmail
 * durante la ventana de migración. Después del cleanup endpoint, ese label se
 * remueve.
 */
async function applyDescartadoLabel(
  gmail: any,
  messageId: string,
  motivo: string,
  processedLabelId: string,
): Promise<void> {
  const labelName = mapMotivoToLabel(motivo);
  let descartadoLabelId: string;
  try {
    descartadoLabelId = await getOrCreateLabel(gmail, labelName);
  } catch (e: any) {
    // Si falla la creación del label, hacemos fallback al viejo markEmailProcessed
    // (el email queda solo con "Procesado") — preferible a tirar el run.
    console.warn(`[applyDescartadoLabel] no pude crear label ${labelName}: ${e.message}. Fallback a Procesado.`);
    await markEmailProcessed(gmail, messageId, processedLabelId);
    return;
  }
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [descartadoLabelId, processedLabelId],
        removeLabelIds: ["INBOX"],
      },
    });
  } catch (e: any) {
    console.warn(`[applyDescartadoLabel] modify falló para ${messageId} (${labelName}): ${e.message}`);
  }
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

function parseInvoiceXml(
  xmlPath: string,
  xmlParser: XMLParser,
  nitCliente?: string | null,
): InvoiceData | null {
  const raw = fs.readFileSync(xmlPath, "utf8");
  const parsed = xmlParser.parse(raw);

  let invoice = parsed.Invoice;
  if (!invoice) {
    const unwrapped = unwrapAttachedDocument(parsed, xmlParser);
    if (unwrapped) invoice = unwrapped.Invoice;
  }
  if (!invoice) return null;

  // Filtro tipo de documento DIAN:
  //   01 = Factura electrónica (procesar)
  //   02 = Documento equivalente
  //   05 = Nota de retención / certificado RTE (NO es factura, skip)
  //   07 = Comprobante de retención (skip)
  //   91 = Nota crédito (skip — no es factura nueva)
  //   92 = Nota débito (skip)
  // Solo procesamos type 01 y 02 que son facturas reales de compra.
  const tipoDoc = asString(pick(invoice, "InvoiceTypeCode") ?? "");
  if (tipoDoc && tipoDoc !== "01" && tipoDoc !== "02") {
    console.log(`[skip-tipo-doc] tipoDoc=${tipoDoc} (no es factura, es retención/nota crédito/débito)`);
    return null;
  }

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

  // Skip si el supplier es el mismo cliente actual: significa que es una factura
  // que el cliente emitió (cuenta de cobro hacia sus clientes), no un gasto.
  // Comparamos por NIT y también por NOMBRE normalizado (caso donde NIT viene mal).
  if (nitCliente) {
    const nitClienteClean = String(nitCliente).replace(/\D+/g, "");
    if (nit && nit === nitClienteClean) {
      console.log(`[skip-self-emitted] proveedor=${proveedor} nit=${nit} === nitCliente`);
      return null;
    }
  }

  // PayableAmount es el TOTAL FINAL que paga el cliente (incluye propinas y
  // cargos globales). TaxInclusiveAmount sería solo subtotal+impuestos (sin
  // propinas), insuficiente para restaurantes con INC y propina cliente.
  const totals = invoice.LegalMonetaryTotal;
  const subtotal = asNumber(pick(totals, "LineExtensionAmount"));
  const total = asNumber(pick(totals, "PayableAmount") ?? pick(totals, "TaxInclusiveAmount"));

  // Distinguir IVA (TaxScheme.ID=01) de otros impuestos (INC=04, etc).
  // Antes sumaba todo como IVA — bug en facturas de restaurantes (INC) y otros
  // sectores con impuestos especiales.
  let iva = 0;
  let inc = 0;
  let otrosImpuestos = 0;
  const taxArr = Array.isArray(invoice.TaxTotal) ? invoice.TaxTotal : invoice.TaxTotal ? [invoice.TaxTotal] : [];
  for (const t of taxArr) {
    const taxAmount = asNumber(t.TaxAmount);
    const subtotalsArr = Array.isArray(t.TaxSubtotal)
      ? t.TaxSubtotal
      : t.TaxSubtotal
        ? [t.TaxSubtotal]
        : [];
    if (subtotalsArr.length === 0) {
      // No hay subtotales detallados: fallback al taxAmount como IVA
      iva += taxAmount;
      continue;
    }
    for (const sub of subtotalsArr) {
      const schemeId = asString(pick(sub, "TaxCategory.TaxScheme.ID"));
      const subAmount = asNumber(pick(sub, "TaxAmount"));
      if (schemeId === "01") iva += subAmount;
      else if (schemeId === "04") inc += subAmount;
      else otrosImpuestos += subAmount;
    }
  }

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
    inc,
    otrosImpuestos,
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

/**
 * Find-or-create de carpeta mensual con AUTO-CONSOLIDACIÓN de duplicados.
 *
 * Bug histórico: el multi-pass dispara 12 invocaciones paralelas. Cada una
 * llamaba esta función, hacía list → veía 0, hacía create → creaba carpeta.
 * Resultado: 12 carpetas con mismo nombre creadas simultáneamente (Freshco
 * tuvo 5+ duplicadas por mes).
 *
 * Fix: si list encuentra MÁS DE UNA carpeta con el mismo nombre, consolida:
 *   - Mantiene la más vieja (canónica, ordenada por createdTime)
 *   - Mueve archivos de las extras a la canónica (addParents + removeParents)
 *   - Borra las extras
 *
 * También re-verifica DESPUÉS de crear (race condition post-create) y aplica
 * la misma lógica de consolidación.
 */
async function getOrCreateMonthFolder(drive: any, parentFolderId: string, year: number, month: number) {
  const name = `${year}-${String(month).padStart(2, "0")}`;
  const q = `name='${name}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  // Helper local: si hay más de 1 carpeta, consolida y devuelve canónica.
  const consolidarSiDuplicado = async (files: any[]): Promise<string> => {
    if (files.length === 1) return files[0].id;
    if (files.length === 0) throw new Error(`consolidar: 0 files (no debería llegar acá)`);

    // Ordenar por createdTime (más vieja primero = canónica)
    files.sort((a, b) => String(a.createdTime ?? "").localeCompare(String(b.createdTime ?? "")));
    const canonica = files[0].id;
    const extras = files.slice(1);
    console.warn(
      `[getOrCreateMonthFolder] DEDUP: ${files.length} carpetas '${name}' encontradas. Canónica=${canonica}. Consolidando ${extras.length} extras…`,
    );

    for (const extra of extras) {
      try {
        // Listar archivos dentro de la extra
        let pageToken: string | undefined;
        do {
          const filesInExtra = await drive.files.list({
            q: `'${extra.id}' in parents and trashed=false`,
            fields: "files(id), nextPageToken",
            pageSize: 1000,
            pageToken,
          });
          // Mover cada archivo a canónica
          for (const file of filesInExtra.data.files ?? []) {
            try {
              await drive.files.update({
                fileId: file.id!,
                addParents: canonica,
                removeParents: extra.id,
                fields: "id",
              });
            } catch (e: any) {
              console.warn(`[consolidar] no pude mover ${file.id}: ${e.message}`);
            }
          }
          pageToken = filesInExtra.data.nextPageToken ?? undefined;
        } while (pageToken);

        // Borrar la carpeta extra ahora vacía
        await drive.files.delete({ fileId: extra.id });
      } catch (e: any) {
        console.warn(`[consolidar] error con extra ${extra.id}: ${e.message}`);
      }
    }
    return canonica;
  };

  // 1. Primer intento: listar
  const list = await drive.files.list({
    q,
    fields: "files(id, name, createdTime)",
    spaces: "drive",
  });
  const filesInicial = list.data.files ?? [];

  if (filesInicial.length >= 1) {
    return consolidarSiDuplicado(filesInicial);
  }

  // 2. No existe: crear
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] },
    fields: "id, createdTime",
  });

  // 3. RE-VERIFICAR (race condition post-create): otro proceso paralelo
  //    pudo haber creado otra carpeta al mismo tiempo.
  const recheck = await drive.files.list({
    q,
    fields: "files(id, createdTime)",
    spaces: "drive",
  });
  const filesPostCreate = recheck.data.files ?? [];
  if (filesPostCreate.length > 1) {
    console.warn(
      `[getOrCreateMonthFolder] RACE detectada post-create: ${filesPostCreate.length} carpetas '${name}'`,
    );
    return consolidarSiDuplicado(filesPostCreate);
  }
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

/**
 * Sube un archivo a Drive con deduplicación opcional.
 *
 * Si se pasa `uniqueKey`, primero busca en el `parentId` si ya existe un
 * archivo con `appProperties.unique_key = uniqueKey`. Si existe, lo retorna
 * sin crear uno nuevo. Si no existe, crea con esa appProperty.
 *
 * Esto previene los duplicados visibles en Drive cuando el cron re-procesa
 * un mismo email (force=true, dobles disparos) — antes creaba archivos
 * nuevos cada vez con consecutivo distinto (1. Foo.pdf, 2. Foo.pdf, etc).
 *
 * Para DIAN, uniqueKey = CUFE del XML.
 * Para Word/PDF no-DIAN, uniqueKey = `{messageId}:{filename}` del Gmail.
 */
async function uploadFile(
  drive: any,
  localPath: string,
  parentId: string,
  name: string,
  uniqueKey?: string,
) {
  // Si hay uniqueKey, chequear si ya existe
  if (uniqueKey) {
    try {
      const safeKey = uniqueKey.replace(/'/g, "\\'");
      const q = `'${parentId}' in parents and trashed=false and appProperties has { key='unique_key' and value='${safeKey}' }`;
      const existing = await drive.files.list({
        q,
        fields: "files(id, name, webViewLink)",
        spaces: "drive",
        pageSize: 1,
      });
      if (existing.data.files && existing.data.files.length > 0) {
        console.log(`[upload-dedup] cliente=${parentId.slice(0, 8)} → reusando archivo existente "${existing.data.files[0].name}" (key=${uniqueKey.slice(0, 20)}...)`);
        return existing.data.files[0];
      }
    } catch (err: any) {
      // INCIDENTE 2026-05-19: si la query de dedup falla y caemos al upload
      // normal, podemos DUPLICAR el archivo en Drive (el archivo SÍ existía,
      // pero la query lo "ocultó"). Preferimos perder el upload a duplicar.
      console.error(
        `[upload-dedup] query con uniqueKey="${uniqueKey.slice(0, 30)}..." falló: ${err.message}. Abortando upload para evitar duplicación.`,
      );
      throw new Error(
        `upload-dedup query falló (uniqueKey=${uniqueKey.slice(0, 30)}): ${err.message}`,
      );
    }
  }

  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      ...(uniqueKey ? { appProperties: { unique_key: uniqueKey } } : {}),
    },
    media: { body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  return res.data;
}

// ===== Sheets =====

/**
 * Detecta si una factura ya está en el Sheet.
 *
 * La REGLA DE NEGOCIO según Tomás:
 *   - El CONSECUTIVO (numero) es la fuente única de verdad para identificar
 *     una factura. Si el mismo proveedor emite dos facturas con MISMO número,
 *     es duplicado. Si emite varias con números distintos, cada una es real
 *     aunque sean el mismo día por el mismo monto.
 *
 * Estrategia (en orden):
 *   1. Si NIT presente en ambos lados → match por (numero, NIT) [estricto]
 *   2. Si alguno sin NIT → fallback por (numero, proveedor normalizado)
 *      (caso típico: planillas SS sin NIT, cuentas de cobro persona natural)
 *
 * Cols 15: A=N°(0), B=Fecha(1), C=Proveedor(2), D=NIT(3), E=N°Doc(4), ...
 */
function isDuplicate(
  rows: any[][],
  numero: string,
  nit: string,
  proveedor?: string,
): boolean {
  if (!numero) return false;
  const numTrim = String(numero).trim();
  if (numTrim.length < 1) return false;
  const nitNorm = String(nit || "").replace(/\D+/g, "");
  const proveedorNorm = proveedor ? normalizeProveedorName(proveedor) : "";

  return rows.some((r) => {
    const rowNum = String(r[4] || "").trim();
    if (rowNum !== numTrim) return false;
    // Mismo número — validar que sea el mismo proveedor:
    const rowNit = String(r[3] || "").replace(/\D+/g, "");
    if (nitNorm && rowNit) {
      // Ambos NITs presentes: comparar NIT
      return rowNit === nitNorm;
    }
    // Alguno sin NIT: comparar por nombre normalizado del proveedor
    if (proveedorNorm) {
      const rowProveedor = normalizeProveedorName(String(r[2] || ""));
      return rowProveedor === proveedorNorm;
    }
    // Sin NIT ni proveedor → ser conservador y considerar duplicado si num idéntico
    return true;
  });
}

async function appendToSheet(
  sheets: any,
  sheetId: string,
  tabRange: string,
  consecutivo: number,
  d: ProcessedRow
): Promise<any[]> {
  // 15 cols: A=#, B=Fecha, C=Proveedor, D=NIT, E=#Documento, F=Subtotal,
  //          G=IVA, H=ReteFuente, I=ReteIVA, J=ReteICA, K=Total a Pagar,
  //          L=Concepto, M=Categoría, N=Cuenta PYG, O=Link PDF.
  // Total a Pagar = Subtotal + IVA - retenciones (lo que se paga REAL al proveedor).
  const rtf = d.reteFuente ?? 0;
  const riva = d.reteIva ?? 0;
  const rica = d.reteIca ?? 0;
  const totalAPagar = (d.subtotal || 0) + (d.iva || 0) - rtf - riva - rica;
  const row = [
    consecutivo, d.fecha, d.proveedor, d.nit, d.numero,           // A-E
    d.subtotal, d.iva,                                              // F-G
    rtf, riva, rica,                                                // H-I-J
    totalAPagar,                                                    // K
    d.concepto, d.categoria, d.cuentaPyg, d.driveLink,              // L-O
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tabRange}!A:O`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  return row;
}

/**
 * Guard de emergencia que envuelve appendToSheet (FIX A 2026-05-19).
 *
 * Antes de cada append hace una LECTURA DIRECTA a la Sheets API (no al cache
 * cached por loadSheetRows) de la columna E del tab, y verifica que el
 * `numero` recibido no exista ya. Si existe, retorna null → el caller debe
 * tratar el email como duplicado y marcarlo procesado.
 *
 * Solo aplica cuando `numero` tiene valor — los emails sin numero los maneja
 * el FIX C (skip en processOne) y los sub-pipelines que confían en otros
 * dedupes (planilla/docx/pdf genérico usan messageId en uniqueKey de Drive).
 *
 * Si la lectura falla (quota Sheets, network, etc.), lanza error en vez de
 * appendear — preferimos perder el email a duplicar masivamente como pasó
 * en Freshco enero (628K filas físicas).
 */
async function safeAppendToSheet(
  sheets: any,
  sheetId: string,
  tabRange: string,
  tabName: string,
  consecutivo: number,
  d: ProcessedRow,
  numero: string | undefined | null,
): Promise<any[] | null> {
  const numTrim = numero ? String(numero).trim() : "";
  if (numTrim.length > 0) {
    // Retry con backoff exponencial cuando Sheets responde 429 quota.
    // Sin esto, en runs con muchas facturas el guard pre-append dispara
    // quota y devuelve error → emails que SÍ procesarían sin dedup fallan.
    const MAX_RETRIES = 3;
    const BACKOFF_MS = [2000, 5000, 12000]; // 2s, 5s, 12s
    let lastErr: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `${tabRange}!E:E`,
        });
        const values = (resp.data.values ?? []) as any[][];
        for (let i = 1; i < values.length; i++) {
          const existing = String(values[i]?.[0] ?? "").trim();
          if (existing === numTrim) {
            console.log(
              `[safeAppend] DUP pre-append detectado en ${tabName}: numero="${numTrim}" ya está en fila ${i + 1}. Skip append.`,
            );
            return null;
          }
        }
        lastErr = null;
        break; // lectura exitosa → salir del retry loop
      } catch (err: any) {
        lastErr = err;
        const code = err?.code ?? err?.response?.status;
        const msg = String(err?.message ?? "");
        const isQuota =
          code === 429 ||
          (code === 403 && /quota/i.test(msg)) ||
          /quota.*exceeded/i.test(msg);
        if (!isQuota || attempt === MAX_RETRIES) {
          console.error(
            `[safeAppend] lectura pre-append de E:E en ${tabName} falló (attempt ${attempt + 1}): ${msg}. Abortando append.`,
          );
          throw new Error(`safeAppend pre-check failed (${tabName}): ${msg}`);
        }
        const wait = BACKOFF_MS[attempt];
        console.warn(
          `[safeAppend] quota Sheets en ${tabName}, retry ${attempt + 1}/${MAX_RETRIES} en ${wait}ms...`,
        );
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    if (lastErr) {
      // Defensa: si después de todos los retries seguimos en error, no appendees.
      throw new Error(`safeAppend pre-check failed (${tabName}): ${lastErr.message}`);
    }
  }
  return appendToSheet(sheets, sheetId, tabRange, consecutivo, d);
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
  retentionCtx: { rules: unknown | null; municipioIca: string | null } | null,
  nitCliente: string | null,
  nombreClienteNorm: string | null,
  getNextConsecutivo: (tabName: string) => Promise<number>,
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
      loadSheetRows, pushToCache, getNextConsecutivo,
      nitCliente, // FIX 2026-05-27: pasar nitCliente para filtrar planillas terceros
    );
  }

  // PRE-FILTRO A+B (sender/subject) — aplica a flows que llaman LLM (.docx + PDF).
  // Si el sender o subject indican que NO es factura, skip sin cargar el adjunto.
  if (zips.length === 0 && (docxs.length > 0 || hasNonPlanillaPdf(msg.payload, planillas))) {
    const { isLikelyNonInvoiceSender, isLikelyNonInvoiceSubject } = await import("./llm-pre-filters");
    if (isLikelyNonInvoiceSender(sender)) {
      llmTracker.preFilteredOut++;
      await applyDescartadoLabel(gmail, messageId, "pre-filter-sender", labelId);
      return {
        skip: true,
        reason: `pre-filter-sender (${sender.slice(0, 60)})`,
        subject,
      };
    }
    if (isLikelyNonInvoiceSubject(subject)) {
      llmTracker.preFilteredOut++;
      await applyDescartadoLabel(gmail, messageId, "pre-filter-subject", labelId);
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
      loadSheetRows, pushToCache, llmTracker, nitCliente, nombreClienteNorm,
      getNextConsecutivo,
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
        loadSheetRows, pushToCache, llmTracker, nitCliente, nombreClienteNorm,
        getNextConsecutivo,
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
        const candidate = parseInvoiceXml(x, xmlParser, nitCliente);
        if (candidate && (candidate.numero || candidate.cufe)) {
          data = candidate;
          break;
        }
      } catch {
        /* probar el siguiente XML */
      }
    }
    if (!data) return { skip: true, reason: "no-es-factura-dian", subject };

    // FIX C 2026-05-19: si parseInvoiceXml no extrajo numero (XML malformado o
    // ZIP corrupto), marcamos el email como procesado y salimos. Sin numero
    // no podemos dedup → si re-procesamos el mismo email duplica fila.
    if (!data.numero || data.numero.trim() === "") {
      await applyDescartadoLabel(gmail, messageId, "dian-sin-numero", labelId);
      return {
        skip: true,
        reason: "dian-sin-numero (XML malformado o ZIP corrupto)",
        subject,
      };
    }

    // BLOQUE I — Validación preventiva exigente.
    // Antes de meter la factura al Sheet, validamos formato del número,
    // fecha, monto, etc. Si falla, NO se procesa y queda en Gmail con label
    // de Procesado para evitar reprocesos infinitos.
    const { validarFacturaCompleta } = await import("./validations");
    const validacion = validarFacturaCompleta({
      numero: data.numero,
      fecha: data.fecha,
      nit: data.nit,
      total: data.total,
      proveedor: data.proveedor,
    });
    if (!validacion.esValida) {
      await applyDescartadoLabel(gmail, messageId, "factura-invalida", labelId);
      console.log(`[skip-validacion-dian] factura inválida: ${validacion.motivos.join("; ")}`);
      return {
        skip: true,
        reason: `factura-invalida: ${validacion.motivos.join("; ")}`,
        subject,
      };
    }

    // year/month derivados del IssueDate del XML (no del header del email).
    const issue = data.fecha ? new Date(data.fecha) : new Date();
    const year = issue.getFullYear();
    const month = issue.getMonth() + 1;

    // Skip facturas de años anteriores al actual (típico: cierre fiscal de
    // diciembre del año pasado llega al inbox en enero del año nuevo).
    // Etiqueta el email para no re-procesarlo en runs futuros.
    const minYear = parseInt(process.env.MIN_INVOICE_YEAR ?? "") || new Date().getFullYear();
    if (year < minYear) {
      await applyDescartadoLabel(gmail, messageId, "fecha-año-anterior", labelId);
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
    if (isDuplicate(sheetRows, data.numero, data.nit, data.proveedor)) {
      await applyDescartadoLabel(gmail, messageId, "dup-en-sheet", labelId);
      return { dup: true, motivo: `${data.proveedor} ${data.numero} (ya en ${tabName})`, subject };
    }

    // Consecutivo: counter atómico per-mes (anti race condition workers paralelos).
    // Fix bug 2026-05-15 (~50 filas duplicadas mismo # en Freshco enero).
    const consecutivo = await getNextConsecutivo(tabName);

    const folderId = await getOrCreateMonthFolder(drive, g.driveFolderId, year, month);

    let driveLink = "";
    // Naming: "{N}. {numeroDIAN}. {Proveedor}.pdf"
    //         ej "1. FEL428843. Seguros De Vida Suramericana.pdf"
    // El mes está en la carpeta padre YYYY-MM/, no se repite en el filename.
    // XMLs: "{N}. {numeroDIAN}.1. {Proveedor}.xml" (idx 1, 2, etc).
    // BUG C FIX 2026-05-15: incluir numero DIAN evita colisiones cuando un
    // proveedor envía múltiples facturas en un mes (varias "1. Comercializadora..."
    // antes sobrescribían entre sí).
    // FIX 2026-05-18: cuando data.numero queda null (LLM no logró extraer),
    // el filename queda "N. Proveedor" sin numero DIAN. Si la misma factura
    // sin numero se procesa en chunks diferentes del recovery, cada chunk
    // genera un PDF distinto con MISMO nombre → Drive permite mismo nombre
    // y duplica el archivo. Fallback: usar CUFE si existe, sino primeros
    // 12 chars del messageId. Garantiza filename único + idempotencia.
    const identificadorUnico =
      data.numero || data.cufe || `m${messageId.slice(0, 12)}`;
    const baseName = buildFileBaseName(consecutivo, data.proveedor, identificadorUnico);
    // uniqueKey en Drive: CUFE > messageId. Garantiza dedupe de re-uploads.
    const dianUniqueKey = data.cufe ? `dian:${data.cufe}` : `gmail:${messageId}`;
    if (pdfPath) {
      const uploaded = await uploadFile(drive, pdfPath, folderId, `${baseName}.pdf`, dianUniqueKey);
      driveLink = uploaded.webViewLink || "";
    }
    for (let j = 0; j < xmlPaths.length; j++) {
      const xmlName = buildFileBaseName(consecutivo, data.proveedor, identificadorUnico, j + 1);
      const xmlUniqueKey = `${dianUniqueKey}:xml${j + 1}`;
      await uploadFile(drive, xmlPaths[j], folderId, `${xmlName}.xml`, xmlUniqueKey);
    }

    const { categoria, cuentaPyg } = categorizar({ nit: data.nit, concepto: data.concepto });
    // Stub categoria en `data` para que el engine de retenciones pueda leerla
    // cuando decide la tarifa RTF de oficio. ProcessedRow las setea explícitas abajo.
    data.categoria = categoria;
    data.cuentaPyg = cuentaPyg;

    // Aplicar reglas de retención del cliente (si están configuradas).
    // El engine prioriza: override_nit > xml > oficio (según reglas).
    // Si retentionCtx es null (cliente legacy), retenciones quedan tal como
    // vienen del XML (extracción Sub-fase 1).
    let retencionSource:
      | { rtf: string; iva: string; ica: string }
      | undefined;
    if (retentionCtx) {
      const { aplicarReglasRetencion } = await import("./retenciones-engine");
      const aplicado = aplicarReglasRetencion(
        data,
        retentionCtx.rules as any,
        retentionCtx.municipioIca,
        year,
      );
      data.reteFuente = aplicado.reteFuente;
      data.reteIva = aplicado.reteIva;
      data.reteIca = aplicado.reteIca;
      data.totalRetenciones = aplicado.totalRetenciones;
      retencionSource = aplicado.source;
    }

    // categoria/cuentaPyg ya están en data; el spread los incluye.
    const row: ProcessedRow = {
      ...data, driveLink, subject, categoria, cuentaPyg,
      tipo: "factura_dian",
      consecutivo,
    };
    // Adjuntar audit trail al row (lo usa el background fn para guardar en
    // agent_events.payload.retencionSource). No va al Sheet — campo interno.
    if (retencionSource) {
      (row as any).retencionSource = retencionSource;
    }
    const newRow = await safeAppendToSheet(sheets, g.sheetId, tabRange, tabName, consecutivo, row, data.numero);
    if (!newRow) {
      // Guard de emergencia detectó duplicado pre-append — marcar como dup y salir.
      await applyDescartadoLabel(gmail, messageId, "dup-guard-emergencia", labelId);
      return { dup: true, motivo: `guard-emergencia: ${data.proveedor} ${data.numero}`, subject };
    }
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
  getNextConsecutivo: (tabName: string) => Promise<number>,
  nitCliente: string | null,
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

    // 5. N° planilla del filename (típicamente "Autoliquidaciones_84333812_..." → 84333812)
    //    MOVIDO ARRIBA porque ahora lo usamos para filtrar terceros ANTES de procesar.
    const numeroPlanilla = (() => {
      for (const p of planillas) {
        const m = p.filename.match(/(\d{6,})/);
        if (m) return m[1];
      }
      return "";
    })();

    // FIX 2026-05-27: SKIPEAR planillas SS de terceros (prestadores de servicios).
    // Solo procesa si el número del titular (extraído del filename) coincide con
    // el NIT del cliente. Caso típico Dentilandia (NIT 901117356) recibe:
    //   - Planillas propias de empleados directos: numero=901117356 → PROCESA
    //   - Planillas de freelancers (Tomás Ramirez 84333812): numero≠901117356 → SKIP
    // Sin este filtro, las planillas de terceros se registran como gasto fantasma.
    // Si nitCliente está null (cliente no configuró NIT), skip por defecto.
    if (!nitCliente || numeroPlanilla !== nitCliente.replace(/\D+/g, "")) {
      console.log(
        `[processPlanilla] SKIP planilla SS de tercero: ` +
        `numeroPlanilla=${numeroPlanilla}, nitCliente=${nitCliente ?? "null"}`,
      );
      // Aplicar label Descartado/PlanillaSS-Tercero + archivar
      await applyDescartadoLabel(gmail, messageId, "planilla-ss-tercero", labelProcesadoId);
      return {
        skip: true,
        reason: `planilla-ss-tercero (titular ${numeroPlanilla} ≠ cliente ${nitCliente ?? "null"})`,
        subject,
      };
    }

    // 2. Tab del mes + folder del mes
    const tabName = await getOrCreateMonthTab(sheets, g.sheetId, month);
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;
    const folderId = await getOrCreateMonthFolder(drive, g.driveFolderId, year, month);

    // 3. Calcular consecutivo (counter atómico anti race condition)
    const sheetRows = await loadSheetRows(tabName);
    const consecutivo = await getNextConsecutivo(tabName);

    // 4. Proveedor: hardcoded "Planilla Seguridad Social" (más claro y consistente).
    //    Antes: derivábamos del sender, pero remitentes con display name corto
    //    (ej: 'T <...>', 'M <...>' por forwards de Gmail) generaban proveedor = 'T' / 'M'.
    //    Cuando hagamos OCR del PDF de planilla extraeremos el operador real
    //    (Aportes en Línea, SOI, etc).
    const proveedor = "Planilla Seguridad Social";

    // 6. Subir PDFs al folder del mes con naming "{N}. {planilla#}. Planilla SS" + sub-índices
    // Bug C fix: usar numeroPlanilla como identificador único (mismo flow que facturas DIAN).
    const baseName = buildFileBaseName(consecutivo, proveedor, numeroPlanilla);
    let driveLink = "";
    let n = 0;
    for (const p of planillas) {
      const tmpPath = await downloadAttachment(gmail, messageId, p.attachmentId, p.filename);
      tmpPaths.push(tmpPath);
      try {
        const fileName = n === 0
          ? `${baseName}.pdf`
          : `${buildFileBaseName(consecutivo, proveedor, numeroPlanilla, n + 1)}.pdf`;
        // uniqueKey para planillas: messageId + filename original (Gmail no
        // re-genera adjuntos con mismo messageId, así garantizamos idempotencia).
        const planillaKey = `gmail:${messageId}:${p.filename}`;
        const uploaded = await uploadFile(drive, tmpPath, folderId, fileName, planillaKey);
        if (n === 0) driveLink = uploaded.webViewLink || "";
        n++;
      } catch (e: any) {
        // Log ERROR (no warn) para que se vea en logs/Sentry. No throw —
        // permitimos que las demás planillas del email se procesen. La fila
        // del Sheet queda con driveLink="" si TODOS los uploads fallan.
        console.error(
          `[processPlanilla] upload "${p.filename}" falló: ${e.message}. Sigo con siguiente adjunto.`,
        );
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
      consecutivo,
    };
    const newRow = await safeAppendToSheet(sheets, g.sheetId, tabRange, tabName, consecutivo, row, numeroPlanilla);
    if (!newRow) {
      await applyDescartadoLabel(gmail, messageId, "dup-guard-emergencia", labelProcesadoId);
      return { dup: true, motivo: `guard-emergencia: ${proveedor} ${numeroPlanilla}`, subject };
    }
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
  nitCliente: string | null,
  nombreClienteNorm: string | null,
  getNextConsecutivo: (tabName: string) => Promise<number>,
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
      await applyDescartadoLabel(gmail, messageId, "docx-no-es-factura", labelProcesadoId);
      return {
        skip: true,
        reason: "docx-sin-indicadores-factura",
        subject,
      };
    }

    // 3. Llamar al LLM para extraer campos estructurados.
    // Pasamos el NIT y nombre del cliente para que el LLM:
    //   a) NO confunda al cliente con el proveedor en cuentas de cobro
    //   b) Skip si extracción detecta NIT cliente como proveedor (self-emitted)
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
      nitCliente,
      nombreCliente: nombreClienteNorm,
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

    // BLOQUE I — Validación preventiva exigente para cuentas de cobro
    {
      const { validarFacturaCompleta } = await import("./validations");
      const v = validarFacturaCompleta({
        numero: extracted.numero,
        fecha: extracted.fecha,
        nit: extracted.nit,
        total: extracted.total,
        proveedor: extracted.proveedor,
      });
      if (!v.esValida) {
        await applyDescartadoLabel(gmail, messageId, "docx-invalida", labelProcesadoId);
        console.log(`[skip-validacion-docx] cuenta-cobro inválida: ${v.motivos.join("; ")}`);
        return {
          skip: true,
          reason: `docx-invalida: ${v.motivos.join("; ")}`,
          subject,
        };
      }
    }

    // Skip si el documento es una cuenta de cobro EMITIDA por el propio cliente.
    // Doble check: (a) NIT extraído coincide con nit_cliente, O (b) nombre del
    // proveedor extraído por el LLM coincide con el nombre del cliente normalizado.
    // El (b) es importante cuando el LLM no extrae el NIT pero sí el nombre.
    if (isSelfEmitted(extracted.proveedor, extracted.nit, nitCliente, nombreClienteNorm)) {
      console.log(`[skip-self-emitted-docx] proveedor="${extracted.proveedor}" nit="${extracted.nit}" → cliente=emisor`);
      await applyDescartadoLabel(gmail, messageId, "docx-self-emitted", labelProcesadoId);
      return { skip: true, reason: "docx-self-emitted (cliente es emisor)", subject };
    }

    // 4. Year/month del documento
    const issue = new Date(extracted.fecha + "T00:00:00");
    const year = issue.getFullYear();
    const month = issue.getMonth() + 1;

    // Skip pre-año-actual (mismo guard que facturas DIAN)
    const minYear = parseInt(process.env.MIN_INVOICE_YEAR ?? "") || new Date().getFullYear();
    if (year < minYear) {
      await applyDescartadoLabel(gmail, messageId, "fecha-año-anterior", labelProcesadoId);
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
    if (extracted.numero && isDuplicate(sheetRows, extracted.numero, extracted.nit, extracted.proveedor)) {
      await applyDescartadoLabel(gmail, messageId, "dup-en-sheet", labelProcesadoId);
      return {
        dup: true,
        motivo: `${extracted.proveedor} ${extracted.numero} (ya en ${tabName})`,
        subject,
      };
    }

    // 7. Consecutivo (counter atómico anti race condition)
    const consecutivo = await getNextConsecutivo(tabName);

    // 8. Subir el .docx al folder del mes
    // Bug C fix: incluir numero (extracted.numero) en filename para evitar
    // colisiones cuando un proveedor envía múltiples cuentas de cobro.
    const baseName = buildFileBaseName(consecutivo, extracted.proveedor, extracted.numero);
    // uniqueKey: messageId del Gmail + filename original — el mismo email
    // procesado dos veces va a reusar el archivo subido la primera vez.
    const docxUniqueKey = `gmail:${messageId}:${d.filename}`;
    const uploaded = await uploadFile(drive, docxPath, folderId, `${baseName}.docx`, docxUniqueKey);
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
      consecutivo,
    };
    const newRow = await safeAppendToSheet(sheets, g.sheetId, tabRange, tabName, consecutivo, row, extracted.numero);
    if (!newRow) {
      await applyDescartadoLabel(gmail, messageId, "dup-guard-emergencia", labelProcesadoId);
      return { dup: true, motivo: `guard-emergencia: ${extracted.proveedor} ${extracted.numero}`, subject };
    }
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
  nitCliente: string | null,
  nombreClienteNorm: string | null,
  getNextConsecutivo: (tabName: string) => Promise<number>,
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
      await applyDescartadoLabel(gmail, messageId, "pdf-no-es-factura", labelProcesadoId);
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

    // 4. LLM (con contexto del cliente para evitar self-emitted)
    const { extractInvoiceFromText } = await import("./llm-extractor");
    llmTracker.calls++;
    const extracted = await extractInvoiceFromText({
      text,
      presumedType,
      filename: p.filename,
      sender,
      subject,
      emailDate: dateHeader,
      nitCliente,
      nombreCliente: nombreClienteNorm,
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

    // BLOQUE I — Validación preventiva exigente para PDFs
    {
      const { validarFacturaCompleta } = await import("./validations");
      const v = validarFacturaCompleta({
        numero: extracted.numero,
        fecha: extracted.fecha,
        nit: extracted.nit,
        total: extracted.total,
        proveedor: extracted.proveedor,
      });
      if (!v.esValida) {
        await applyDescartadoLabel(gmail, messageId, "pdf-invalido", labelProcesadoId);
        console.log(`[skip-validacion-pdf] pdf inválido: ${v.motivos.join("; ")}`);
        return {
          skip: true,
          reason: `pdf-invalido: ${v.motivos.join("; ")}`,
          subject,
        };
      }
    }

    // Skip si el PDF es factura/recibo EMITIDO por el propio cliente.
    // Doble check: NIT extraído O nombre del proveedor coinciden con el cliente.
    if (isSelfEmitted(extracted.proveedor, extracted.nit, nitCliente, nombreClienteNorm)) {
      console.log(`[skip-self-emitted-pdf] proveedor="${extracted.proveedor}" nit="${extracted.nit}" → cliente=emisor`);
      await applyDescartadoLabel(gmail, messageId, "pdf-self-emitted", labelProcesadoId);
      return { skip: true, reason: "pdf-self-emitted (cliente es emisor)", subject };
    }

    // 5. Year/month + skip pre-año-actual
    const issue = new Date(extracted.fecha + "T00:00:00");
    const year = issue.getFullYear();
    const month = issue.getMonth() + 1;
    const minYear = parseInt(process.env.MIN_INVOICE_YEAR ?? "") || new Date().getFullYear();
    if (year < minYear) {
      await applyDescartadoLabel(gmail, messageId, "fecha-año-anterior", labelProcesadoId);
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
    if (extracted.numero && isDuplicate(sheetRows, extracted.numero, extracted.nit, extracted.proveedor)) {
      await applyDescartadoLabel(gmail, messageId, "dup-en-sheet", labelProcesadoId);
      return {
        dup: true,
        motivo: `${extracted.proveedor} ${extracted.numero} (ya en ${tabName})`,
        subject,
      };
    }

    // 8. Consecutivo (counter atómico anti race condition)
    const consecutivo = await getNextConsecutivo(tabName);

    // 9. Subir PDF a Drive
    // Bug C fix: incluir numero (extracted.numero) en filename para evitar
    // colisiones cuando un proveedor envía múltiples recibos en un mes.
    const baseName = buildFileBaseName(consecutivo, extracted.proveedor, extracted.numero);
    // uniqueKey: messageId Gmail + filename — re-procesar mismo email no duplica
    const pdfUniqueKey = `gmail:${messageId}:${p.filename}`;
    const uploaded = await uploadFile(drive, pdfPath, folderId, `${baseName}.pdf`, pdfUniqueKey);
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
      consecutivo,
    };
    const newRow = await safeAppendToSheet(sheets, g.sheetId, tabRange, tabName, consecutivo, row, extracted.numero);
    if (!newRow) {
      await applyDescartadoLabel(gmail, messageId, "dup-guard-emergencia", labelProcesadoId);
      return { dup: true, motivo: `guard-emergencia: ${extracted.proveedor} ${extracted.numero}`, subject };
    }
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

// ===== Helpers: detección de auto-facturas (cliente=emisor) ==================

/**
 * Normaliza nombre de proveedor para fuzzy matching contra el cliente.
 * Quita acentos, signos, sufijos legales (S.A.S, Ltda, etc), espacios extra.
 *
 * Ejemplos:
 *   "DENTILANDIA S.A.S"     → "dentilandia"
 *   "DENTILANDIA SAS"       → "dentilandia"
 *   "Tomás Ramírez Villa"   → "tomas ramirez villa"
 */
function normalizeProveedorName(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bs\.?\s*a\.?\s*s?\.?\b/gi, "")
    .replace(/\bltda\.?\b/gi, "")
    .replace(/\bsociedad\b/gi, "")
    .replace(/\bp\.?\s*h\.?\b/gi, "")
    .replace(/[.,;:|()/\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detecta si una factura/recibo extraído por el LLM corresponde al propio
 * cliente como emisor. 2 caminos (cualquiera detecta):
 *   1. NIT extraído === nit_cliente (filtro principal, exacto)
 *   2. Nombre del proveedor normalizado matches nombreClienteNorm
 *      (backup cuando LLM no extrae NIT)
 */
function isSelfEmitted(
  proveedor: string | undefined,
  nitExtracted: string | undefined,
  nitCliente: string | null,
  nombreClienteNorm: string | null,
): boolean {
  if (nitCliente) {
    const nitClean = String(nitExtracted ?? "").replace(/\D+/g, "");
    const clienteClean = String(nitCliente).replace(/\D+/g, "");
    if (nitClean && nitClean === clienteClean) return true;
  }
  if (nombreClienteNorm && proveedor) {
    const provNorm = normalizeProveedorName(proveedor);
    if (provNorm && (
      provNorm === nombreClienteNorm ||
      provNorm.includes(nombreClienteNorm) ||
      nombreClienteNorm.includes(provNorm)
    )) {
      return true;
    }
  }
  return false;
}
