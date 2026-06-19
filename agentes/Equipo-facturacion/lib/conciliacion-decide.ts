// agentes/Equipo-facturacion/lib/conciliacion-decide.ts
//
// Lógica PURA de conciliación entre las 4 fuentes de verdad del sistema de
// facturación: Gmail (label Facturas/YYYY), BD (facturas_registro), Google Sheet
// (pestaña del mes) y Google Drive (carpeta del mes).
//
// 100% determinística: compara CONJUNTOS de identificadores, no totales. Dos
// errores que se compensan dan el mismo total pero difieren en los conjuntos —
// por eso `ok` se decide por diferencias de sets, no por igualdad de conteos.
//
// Sin I/O ni dependencias: trivial de testear (mismo patrón que reconcile-decide).

export interface ConciliacionMesInput {
  /** messageIds de Gmail con label Facturas/YYYY recibidos en el mes. */
  gmailMessageIds: string[];
  /** gmail_message_id de las filas de facturas_registro con fecha_factura en el mes. */
  bdMessageIds: string[];
  /** numero_documento de esas MISMAS filas de facturas_registro (1 por fila). */
  bdNumeros: string[];
  /** numero_documento (columna E) de las filas con datos del Sheet del mes. */
  sheetNumeros: string[];
  /** Cantidad de PDFs en la carpeta Drive del mes. */
  driveCount: number;
  /**
   * numero_documento parseado de los filenames de los PDFs (substring antes del
   * primer ". "), SOLO para los filenames donde el parseo es determinístico. Si
   * se omite, Drive se concilia únicamente por conteo (`diferencia_drive`).
   */
  driveNumeros?: string[];
}

export interface ConciliacionMesResult {
  conteos: { gmail: number; bd: number; sheet: number; drive: number };
  ok: boolean;
  discrepancias: {
    en_gmail_no_en_bd: string[];
    en_bd_no_en_gmail: string[];
    en_bd_no_en_sheet: string[];
    en_sheet_no_en_bd: string[];
    diferencia_drive: number;
    /** Solo presentes si se proveyó `driveNumeros`. */
    en_drive_no_en_bd?: string[];
    en_bd_no_en_drive?: string[];
  };
}

/**
 * Identificadores de `a` que NO están en `b`. Ignora vacíos y deduplica,
 * preservando el orden de primera aparición.
 */
export function soloEnA(a: string[], b: string[]): string[] {
  const setB = new Set(b.filter((x) => x !== "" && x != null));
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const x of a) {
    if (x === "" || x == null) continue;
    if (!setB.has(x) && !vistos.has(x)) {
      out.push(x);
      vistos.add(x);
    }
  }
  return out;
}

/**
 * Concilia un mes comparando los conjuntos de identificadores de las 4 fuentes.
 *
 * `ok` es true sólo si TODAS las diferencias de conjuntos están vacías y la
 * diferencia de conteo de Drive es 0 (y, si hay `driveNumeros`, también sus sets).
 */
export function conciliarMes(input: ConciliacionMesInput): ConciliacionMesResult {
  const gmailSet = [...new Set(input.gmailMessageIds.filter(Boolean))];
  const bdMsg = input.bdMessageIds.filter(Boolean);
  const bdNum = input.bdNumeros.filter(Boolean);
  const sheetNum = input.sheetNumeros.filter(Boolean);

  const en_gmail_no_en_bd = soloEnA(gmailSet, bdMsg);
  const en_bd_no_en_gmail = soloEnA(bdMsg, gmailSet);
  const en_bd_no_en_sheet = soloEnA(bdNum, sheetNum);
  const en_sheet_no_en_bd = soloEnA(sheetNum, bdNum);

  // Conteo de BD = número de FILAS (no deduplicado): si la BD tuviera 2 filas
  // con el mismo identificador, queremos verlo reflejado en el conteo.
  const bdCount = input.bdMessageIds.length;
  const diferencia_drive = input.driveCount - bdCount;

  const discrepancias: ConciliacionMesResult["discrepancias"] = {
    en_gmail_no_en_bd,
    en_bd_no_en_gmail,
    en_bd_no_en_sheet,
    en_sheet_no_en_bd,
    diferencia_drive,
  };

  let driveSetOk = true;
  if (input.driveNumeros) {
    const driveNum = input.driveNumeros.filter(Boolean);
    discrepancias.en_drive_no_en_bd = soloEnA(driveNum, bdNum);
    discrepancias.en_bd_no_en_drive = soloEnA(bdNum, driveNum);
    driveSetOk =
      discrepancias.en_drive_no_en_bd.length === 0 &&
      discrepancias.en_bd_no_en_drive.length === 0;
  }

  const ok =
    en_gmail_no_en_bd.length === 0 &&
    en_bd_no_en_gmail.length === 0 &&
    en_bd_no_en_sheet.length === 0 &&
    en_sheet_no_en_bd.length === 0 &&
    diferencia_drive === 0 &&
    driveSetOk;

  return {
    conteos: {
      gmail: gmailSet.length,
      bd: bdCount,
      sheet: sheetNum.length,
      drive: input.driveCount,
    },
    ok,
    discrepancias,
  };
}

// ===========================================================================
// CUADRE POR DESENLACE
//
// Responde una pregunta distinta a conciliarMes: ¿cada correo del universo
// (label Facturas/YYYY ∪ Descartado/YYYY ∪ INBOX sin label) tiene un desenlace
// que lo explique, y las PROCESADAS quedaron COMPLETAS en Sheet y Drive?
//
// El bug que motiva esto: a varios correos se les puso label Facturas/ (=
// "procesado") pero NO se registraron en Drive y/o no coincidían en el Sheet.
// Aquí eso se detecta como PROCESADA_INCOMPLETA y se lista para reprocesar.
//
// 100% determinística, sin I/O: el caller lee las fuentes y pasa los conjuntos.
// ===========================================================================

/**
 * Prefijos/patrones de `motivo` (campo de email_descartado, derivado de los
 * `reason:`/`motivo:` reales del pipeline) que cuentan como DESCARTE LEGÍTIMO:
 * el correo NO era una factura registrable o ya estaba procesado. Cualquier
 * motivo que NO matchee aquí se marca DESCARTE_SOSPECHOSO para revisión.
 *
 * Verificado contra pipeline.ts (grep `reason:`/`motivo:`). `constraint_unique_bd`
 * NO está aquí a propósito: el bloqueo por BD se maneja vía `bloqueadoBdIds`
 * (cuenta como PROCESADA, no como descarte por motivo).
 */
export const MOTIVOS_LEGITIMOS: ReadonlyArray<string | RegExp> = [
  // pre-filtros sender/subject (ruido evidente, nunca fue factura)
  /^pre-filter-/,
  // estructura de adjunto / no-DIAN
  "sin-zip",
  /^zip-no-procesable/,
  "zip-sin-xml",
  "no-es-factura-dian",
  /^dian-sin-numero/,
  "doc-no-procesable",
  "pdf-no-text",
  "pdf-encrypted",
  // clasificación LLM / heurística: no es factura
  /-no-es-factura/, // docx/pdf-no-es-factura (también cubre no-es-factura-dian)
  /-sin-indicadores/, // docx/pdf-sin-indicadores-factura
  /-sin-texto/, // docx/pdf-sin-texto-extraible
  /-baja-confianza/, // docx/pdf-baja-confianza
  // validación de negocio
  /^factura-invalida/,
  /-invalid[oa]/, // docx-invalida, pdf-invalido
  // pertenencia / temporalidad
  /^planilla-ss-tercero/, // titular ≠ cliente
  /-self-emitted/, // cliente es emisor, no receptor
  /a[ñn]o-anterior/, // fecha-año-anterior, docx/pdf-fecha-año-anterior
  // config faltante (legítimo pero recuperable — ver esMotivoSinApiKey)
  /-sin-api-key/,
  // duplicados ya procesados antes (no es pérdida)
  /^dup:/,
  /^guard-emergencia/,
];

export function esMotivoLegitimo(motivo: string): boolean {
  const m = String(motivo ?? "").toLowerCase();
  return MOTIVOS_LEGITIMOS.some((p) =>
    typeof p === "string" ? m.startsWith(p) : p.test(m),
  );
}

/**
 * Remitentes cuyos correos suelen ser GASTO de la compañía (recibos de
 * plataformas / proveedores de servicio). Si uno de estos correos fue
 * descartado, el descarte es SOSPECHOSO aunque el motivo parezca legítimo
 * (el clasificador pudo botar un recibo real). Tomás: "todo lo que sea gasto
 * de la compañía" — DIAN, cuentas de cobro Y recibos de Meta/Google/Anthropic…
 *
 * Match por substring sobre el sender (dominio o nombre), case-insensitive.
 */
export const REMITENTES_GASTO: readonly string[] = [
  "meta", "facebook", "instagram",
  "google", "googlecloud", "google cloud", "gcp", "google ads", "googleads",
  "anthropic", "openai", "claude",
  "stripe", "paypal",
  "amazon", "aws", "amazonaws",
  "microsoft", "azure", "office365",
  "notion", "github", "gitlab", "vercel", "netlify", "cloudflare",
  "slack", "zoom", "atlassian", "figma", "linkedin", "twilio", "digitalocean",
  "apple", "adobe", "dropbox", "hubspot", "mailchimp", "shopify",
];

export function esRemitenteGasto(sender: string | null | undefined): boolean {
  const s = String(sender ?? "").toLowerCase();
  if (!s) return false;
  return REMITENTES_GASTO.some((p) => s.includes(p));
}

/**
 * Descartes por falta de ANTHROPIC_API_KEY: legítimos hoy, pero si la key ya
 * está configurada son pérdidas recuperables. Se reportan aparte para revisión.
 */
export function esMotivoSinApiKey(motivo: string): boolean {
  return /-sin-api-key/.test(String(motivo ?? "").toLowerCase());
}

export type DesenlaceCategoria =
  | "PROCESADA_OK"
  | "PROCESADA_INCOMPLETA"
  | "DESCARTE_LEGITIMO"
  | "DESCARTE_SOSPECHOSO"
  | "PERDIDA_REAL";

export interface CuadrePorDesenlaceInput {
  /** messageIds con label Facturas/YYYY (recepción en el período). */
  gmailFacturasIds: string[];
  /** messageIds con label Descartado/YYYY (recepción en el período). */
  gmailDescartadoIds: string[];
  /** messageIds que matchean la query de ingestión sin ninguno de los 2 labels. */
  gmailSinLabelIds: string[];
  /** messageIds con evento factura_procesada (payload.messageId no vacío). */
  eventProcesadaIds: string[];
  /** messageIds en facturas_registro.gmail_message_id (refuerza PROCESADA). */
  bdProcesadaIds?: string[];
  /** messageId -> motivo del evento email_descartado. */
  descartadoMotivoById: Record<string, string>;
  /** messageIds con evento duplicado_bloqueado_bd (factura ya procesada antes). */
  bloqueadoBdIds?: string[];
  /** messageId -> numero_documento (de facturas_registro + payload factura_procesada). */
  numeroByMessageId: Record<string, string>;
  /** numero_documento (col E) presentes en el Sheet del período. */
  sheetNumeros: string[];
  /** numero_documento parseado de filenames de PDFs en Drive del período. */
  driveNumeros: string[];
  /**
   * messageId -> driveLink del evento factura_procesada. Si el driveLink está
   * vacío, NO había PDF que archivar (p.ej. DIAN solo-XML) → no es "falta_en_drive".
   * Si está lleno pero el numero no aparece en Drive → pérdida real de PDF.
   * Si un messageId no está aquí (procesada solo por BD), se cae al chequeo por numero.
   */
  driveLinkByMessageId?: Record<string, string>;
  /** messageId -> sender del evento email_descartado (para detectar recibos de plataforma). */
  senderByMessageId?: Record<string, string>;
}

export interface CuadrePorDesenlaceResult {
  universo: number;
  conteos: {
    procesadas_ok: number;
    procesadas_incompletas: number;
    descartes_legitimos: number;
    descartes_sospechosos: number;
    perdidas_reales: number;
  };
  /** universo === Σ conteos (invariante; siempre true por construcción). */
  cuadra: boolean;
  /** Etiquetadas/registradas pero sin PDF en Drive y/o sin fila en Sheet. */
  incompletas: Array<{
    messageId: string;
    numero: string;
    falta_en_sheet: boolean;
    falta_en_drive: boolean;
  }>;
  /** Etiquetadas o vistas sin ningún registro que las explique. */
  perdidas_reales: Array<{
    messageId: string;
    origen: "Facturas" | "Descartado" | "sin-label";
  }>;
  /** Descartes con motivo no reconocido como legítimo. */
  descartes_sospechosos: Array<{ messageId: string; motivo: string }>;
  /** Desglose por messageId (cada uno aparece exactamente una vez). */
  clasificacion: Record<
    string,
    { categoria: DesenlaceCategoria; origen: string; motivo?: string }
  >;
}

/**
 * Clasifica cada messageId del universo en exactamente un desenlace y verifica
 * que las PROCESADAS quedaron completas en Sheet y Drive. Precedencia explícita:
 * PROCESADA (con check de completitud) > DESCARTE_LEGITIMO > DESCARTE_SOSPECHOSO
 * > PERDIDA_REAL.
 */
export function cuadrarPorDesenlace(
  input: CuadrePorDesenlaceInput,
): CuadrePorDesenlaceResult {
  const clean = (xs: string[] | undefined) =>
    (xs ?? []).filter((x) => x !== "" && x != null);

  const facturas = new Set(clean(input.gmailFacturasIds));
  const descartado = new Set(clean(input.gmailDescartadoIds));
  const sinLabel = new Set(clean(input.gmailSinLabelIds));

  const procesadaSet = new Set(clean(input.eventProcesadaIds));
  const bdSet = new Set(clean(input.bdProcesadaIds));
  const bloqueadoSet = new Set(clean(input.bloqueadoBdIds));
  const sheetSet = new Set(clean(input.sheetNumeros));
  const driveSet = new Set(clean(input.driveNumeros));

  // Universo = unión SOLO de fuentes Gmail (no se infiere de eventos).
  const universo = new Set<string>([...facturas, ...descartado, ...sinLabel]);

  const origenDe = (id: string): "Facturas" | "Descartado" | "sin-label" =>
    facturas.has(id) ? "Facturas" : descartado.has(id) ? "Descartado" : "sin-label";

  const result: CuadrePorDesenlaceResult = {
    universo: universo.size,
    conteos: {
      procesadas_ok: 0,
      procesadas_incompletas: 0,
      descartes_legitimos: 0,
      descartes_sospechosos: 0,
      perdidas_reales: 0,
    },
    cuadra: false,
    incompletas: [],
    perdidas_reales: [],
    descartes_sospechosos: [],
    clasificacion: {},
  };

  for (const id of universo) {
    const origen = origenDe(id);
    const esProcesada =
      procesadaSet.has(id) || bdSet.has(id) || bloqueadoSet.has(id);

    if (esProcesada) {
      const numero = input.numeroByMessageId[id] ?? "";
      // Sin numero resoluble no se puede verificar la escritura -> incompleta.
      const faltaSheet = numero === "" || !sheetSet.has(numero);
      // driveLink-aware: si el evento dice driveLink vacío, NO había PDF que
      // archivar (no es pérdida). Solo es "falta_en_drive" si SÍ debía haber PDF
      // (driveLink lleno, o desconocido) y el numero no aparece en Drive.
      const driveLink = input.driveLinkByMessageId?.[id];
      const huboPdf = driveLink === undefined ? true : driveLink.trim() !== "";
      const faltaDrive = huboPdf && (numero === "" || !driveSet.has(numero));
      if (!faltaSheet && !faltaDrive) {
        result.conteos.procesadas_ok++;
        result.clasificacion[id] = { categoria: "PROCESADA_OK", origen };
      } else {
        result.conteos.procesadas_incompletas++;
        result.incompletas.push({
          messageId: id,
          numero,
          falta_en_sheet: faltaSheet,
          falta_en_drive: faltaDrive,
        });
        result.clasificacion[id] = { categoria: "PROCESADA_INCOMPLETA", origen };
      }
      continue;
    }

    const motivo = input.descartadoMotivoById[id];
    if (motivo != null) {
      const sender = input.senderByMessageId?.[id];
      // Un recibo de plataforma (gasto) descartado es SOSPECHOSO aunque el motivo
      // parezca legítimo: el clasificador pudo botar un gasto real.
      const legitimo = esMotivoLegitimo(motivo) && !esRemitenteGasto(sender);
      if (legitimo) {
        result.conteos.descartes_legitimos++;
        result.clasificacion[id] = {
          categoria: "DESCARTE_LEGITIMO",
          origen,
          motivo,
        };
      } else {
        result.conteos.descartes_sospechosos++;
        result.descartes_sospechosos.push({ messageId: id, motivo });
        result.clasificacion[id] = {
          categoria: "DESCARTE_SOSPECHOSO",
          origen,
          motivo,
        };
      }
      continue;
    }

    result.conteos.perdidas_reales++;
    result.perdidas_reales.push({ messageId: id, origen });
    result.clasificacion[id] = { categoria: "PERDIDA_REAL", origen };
  }

  const suma =
    result.conteos.procesadas_ok +
    result.conteos.procesadas_incompletas +
    result.conteos.descartes_legitimos +
    result.conteos.descartes_sospechosos +
    result.conteos.perdidas_reales;
  result.cuadra = suma === result.universo;

  return result;
}
