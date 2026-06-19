// agentes/Equipo-facturacion/lib/validar-pipeline-core.ts
//
// Funciones PURAS (sin I/O) de la capa de validación end-to-end del pipeline de
// facturación. El orquestador (scripts/validar-pipeline.ts) lee Gmail/Sheet/Drive
// con UNA sola pasada y le pasa estos conjuntos a las funciones de aquí.
//
// Por qué existe:
// La capa previa (conciliacion-decide.ts + conciliar-local.ts + auditoria.ts) NO
// detectaba de forma confiable los problemas reales del Sheet porque:
//   1. auditoria.ts usaba índices de columna VIEJOS (E/C) — tras el cambio de
//      esquema 2026-06-18 (se borraron "#" y "Concepto") el # Documento quedó en
//      col D (idx 3) y Proveedor en col B (idx 1). Auditoria leía Subtotal como
//      "numero" y NIT como "proveedor" → reportaba basura.
//   2. La dedup (isDuplicate / safeAppendToSheet) compara el numero RAW trimmeado.
//      No normaliza: "FE 001" ≠ "FE001", "0001234" ≠ "1234". Duplicados silenciosos.
//   3. No había chequeo de ALINEACIÓN: una fila con columnas corridas (bug
//      histórico de values.append) tiene un MONTO en col D en vez de un numero.
//      Nadie lo detectaba.
//   4. Montos podían quedar como TEXTO ("1.234,56") en vez de número, rompiendo
//      las fórmulas SUM() del Dashboard. Sin chequeo.
//   5. Gmail(Facturas) = Sheet = Drive se comparaba sólo por CONTEO, nunca por
//      conjunto de numeros — errores que se compensan pasaban.
//
// 100% determinística y sin dependencias → trivial de testear.

// ===========================================================================
// MAPA DE COLUMNAS — fuente única de verdad (esquema A:M, 13 cols, 2026-06-18).
// Si el esquema cambia, se actualiza SOLO aquí y todo el validador sigue.
// ===========================================================================
export const COL = {
  FECHA: 0, // A
  PROVEEDOR: 1, // B
  NIT: 2, // C
  NUMERO: 3, // D  (# Documento)
  SUBTOTAL: 4, // E
  IVA: 5, // F
  RETEFUENTE: 6, // G
  RETEIVA: 7, // H
  RETEICA: 8, // I
  TOTAL: 9, // J  (Total a Pagar)
  CATEGORIA: 10, // K
  CUENTA_PYG: 11, // L
  LINK_PDF: 12, // M
} as const;

export const COL_LETTER = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"] as const;

// ===========================================================================
// NORMALIZACIÓN DE NÚMERO DE DOCUMENTO
// ===========================================================================

/**
 * Normaliza un numero de documento para comparación de duplicados.
 *   - uppercase
 *   - elimina espacios internos, guiones, puntos, # y otros separadores
 *   - colapsa el resultado
 *
 * NO elimina ceros a la izquierda de forma destructiva en el caso general
 * (un numero puede ser legítimamente "0012" vs "12" en proveedores distintos),
 * pero SÍ expone `numeroVariantes` para comparar también la versión sin ceros.
 *
 * Ejemplos:
 *   "FE 001"   -> "FE001"
 *   "FE-001"   -> "FE001"
 *   "fe.001"   -> "FE001"
 *   "  FE001 " -> "FE001"
 *   "# 1234"   -> "1234"
 */
export function normalizeNumero(numero: string | null | undefined): string {
  return String(numero ?? "")
    .toUpperCase()
    .replace(/[\s.\-_#/\\]+/g, "")
    .trim();
}

/**
 * Variante adicional de un numero normalizado SIN ceros a la izquierda de su
 * cola numérica. Se usa como segunda llave de dedup para atrapar "FE0001" vs
 * "FE1" cuando el prefijo alfabético coincide.
 *   "FE0001" -> "FE1"
 *   "00012"  -> "12"
 *   "ABC"    -> "ABC"   (sin parte numérica: igual)
 */
export function numeroSinCerosIzq(numeroNormalizado: string): string {
  return numeroNormalizado.replace(/([A-Z]*)0*(\d.*)?$/i, (_m, pre, num) => {
    if (num == null || num === "") return pre;
    return pre + num.replace(/^0+/, "");
  });
}

/**
 * Parsea el numero_documento del filename de un PDF de Drive de forma
 * determinística: el pipeline nombra los archivos "{numero}. {Proveedor}.pdf"
 * (ver buildFileBaseName en pipeline.ts), así que el numero es el substring
 * ANTES del primer ". ". Si no hay ". " devuelve null.
 *
 * Réplica local de la función homónima de conciliar-facturacion.mts para que el
 * validador no dependa de un archivo de netlify/functions (que arrastra tipos de
 * @netlify/functions y rompe el import bajo tsx). Mantener ambas en sync.
 */
export function parseNumeroFromFilename(name: string): string | null {
  const base = String(name ?? "").replace(/\.pdf$/i, "");
  const idx = base.indexOf(". ");
  if (idx <= 0) return null;
  const numero = base.slice(0, idx).trim();
  return numero || null;
}

// ===========================================================================
// PARSEO DE MONTOS — detecta texto-vs-número y montos mal formateados
// ===========================================================================

export interface MontoParse {
  /** Valor numérico interpretado, o null si no es interpretable. */
  valor: number | null;
  /** true si el valor original ya era un número JS (no texto). */
  esNumero: boolean;
  /** El valor crudo tal cual venía. */
  crudo: unknown;
}

/**
 * Interpreta una celda de monto. Distingue:
 *   - number JS real            -> { valor, esNumero: true }
 *   - string numérica "1234.5"  -> { valor, esNumero: false }   (TEXTO: warn)
 *   - string formato COP "1.234,56" / "$ 1.234" -> intenta parsear
 *   - "" / null / no parseable  -> { valor: null }
 *
 * Importa porque las fórmulas SUM() del Dashboard ignoran montos guardados como
 * texto → el total del Dashboard sale mal sin que ninguna fila "falte".
 */
export function parseMonto(crudo: unknown): MontoParse {
  if (crudo == null || crudo === "") return { valor: null, esNumero: false, crudo };
  if (typeof crudo === "number") {
    return { valor: Number.isFinite(crudo) ? crudo : null, esNumero: true, crudo };
  }
  const s = String(crudo).trim();
  if (s === "") return { valor: null, esNumero: false, crudo };
  // Quitar simbolo moneda y espacios.
  let limpio = s.replace(/[$\s ]/g, "");
  // Formato COP "1.234.567,89" -> "1234567.89"; o "1234.56"/"1234,56".
  const tieneComa = limpio.includes(",");
  const tienePunto = limpio.includes(".");
  if (tieneComa && tienePunto) {
    // El ultimo separador es el decimal.
    if (limpio.lastIndexOf(",") > limpio.lastIndexOf(".")) {
      limpio = limpio.replace(/\./g, "").replace(",", ".");
    } else {
      limpio = limpio.replace(/,/g, "");
    }
  } else if (tieneComa) {
    // Solo coma: decimal COP.
    limpio = limpio.replace(/\./g, "").replace(",", ".");
  } else if (tienePunto) {
    // Solo punto: ambiguo. En COP el punto suele ser MILES ("1.234" = 1234).
    // Lo tratamos como decimal SOLO si hay un único punto seguido de 1–2
    // dígitos (típico decimal "1234.5"); si hay varios puntos, o exactamente 3
    // dígitos tras el último punto, es separador de miles → se elimina.
    const partes = limpio.split(".");
    const ultima = partes[partes.length - 1];
    const esDecimalReal = partes.length === 2 && ultima.length > 0 && ultima.length <= 2;
    if (!esDecimalReal) limpio = limpio.replace(/\./g, "");
  }
  const v = Number(limpio);
  if (!Number.isFinite(v)) return { valor: null, esNumero: false, crudo };
  return { valor: v, esNumero: false, crudo };
}

// ===========================================================================
// VALIDACIÓN DE FILA — alineación de columnas + campos obligatorios
// ===========================================================================

export type Severidad = "HALT" | "WARN" | "LOG";

export interface FilaProblema {
  rowNumber: number; // fila 1-based real del Sheet (header = 1)
  codigo: string; // identificador estable del check
  severidad: Severidad;
  mensaje: string;
  /** Snapshot corto de la fila para el reporte (numero, proveedor, total). */
  contexto?: Record<string, unknown>;
}

/** ¿La celda parece un numero de documento (no un monto puro)? */
export function pareceNumeroDocumento(v: string): boolean {
  const s = String(v ?? "").trim();
  if (s === "") return false;
  // Señal fuerte de MONTO corrido a esta columna: contiene $, o un patrón de
  // separadores de miles ("1.234.567" / "1,234,567" / "1.234,56"). Un # Documento
  // legítimo no usa miles agrupados.
  if (/\$/.test(s)) return false;
  if (/^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/.test(s)) return false; // miles agrupados → monto
  // Un entero "limpio" (con o sin letras/guion) es un numero de documento válido.
  // OJO: NO descartamos por longitud — muchos numeros DIAN reales son enteros
  // largos (ej. SODIMAC "4009100475683", 13 dígitos). La señal de "monto filtrado
  // a la col D" se detecta aparte en validarFila comparando col D con Subtotal/Total
  // (preciso), no por la forma del numero (que daba falsos positivos masivos).
  return true;
}

/**
 * Valida UNA fila de datos del Sheet contra el esquema A:M. Devuelve la lista de
 * problemas (vacía = fila sana). Cada problema trae su severidad.
 *
 * Política:
 *   HALT  -> integridad rota (no se puede confiar en la fila): fila vacía con
 *            datos sueltos, total no numérico, numero ausente, fecha invalida,
 *            columnas evidentemente corridas (monto en col D / numero en col J).
 *   WARN  -> recuperable / sospechoso: monto guardado como TEXTO, sin NIT,
 *            sin link PDF, total que no cuadra con subtotal+iva-retenciones.
 *   LOG   -> informativo.
 */
export function validarFila(row: any[], rowNumber: number): FilaProblema[] {
  const probs: FilaProblema[] = [];
  const cell = (i: number) => String(row?.[i] ?? "").trim();

  const fecha = cell(COL.FECHA);
  const proveedor = cell(COL.PROVEEDOR);
  const numero = cell(COL.NUMERO);
  const total = cell(COL.TOTAL);
  const link = cell(COL.LINK_PDF);

  const ctx = { rowNumber, numero, proveedor, total };

  // Fila completamente vacía: el caller no debería pasarla; si llega, LOG.
  const algunDato = row?.some((c) => String(c ?? "").trim() !== "");
  if (!algunDato) {
    return [
      { rowNumber, codigo: "fila-vacia", severidad: "LOG", mensaje: "fila sin datos", contexto: ctx },
    ];
  }

  // 1) # Documento obligatorio (col D).
  if (numero === "") {
    probs.push({
      rowNumber,
      codigo: "numero-ausente",
      severidad: "HALT",
      mensaje: `col D (# Documento) vacía — sin numero la fila no es deduplicable ni conciliable`,
      contexto: ctx,
    });
  }

  // 2) Fecha válida (col A). Con lectura UNFORMATTED, una fecha real llega como
  //    SERIAL de Google Sheets (nº de días desde 1899-12-30; una fecha de 2024-2027
  //    cae ~45000-47000). También aceptamos el string "YYYY-MM-DD" por si se leyó
  //    formateado. Solo es HALT si está vacía o es claramente inválida.
  const fechaRaw = row?.[COL.FECHA];
  const fechaEsSerial = typeof fechaRaw === "number" && fechaRaw > 30000 && fechaRaw < 90000;
  if (fecha === "") {
    probs.push({ rowNumber, codigo: "fecha-ausente", severidad: "HALT", mensaje: "col A (Fecha) vacía", contexto: ctx });
  } else if (!fechaEsSerial && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    probs.push({
      rowNumber,
      codigo: "fecha-formato",
      severidad: "HALT",
      mensaje: `col A (Fecha) no es una fecha válida (serial ni YYYY-MM-DD): "${fecha}"`,
      contexto: ctx,
    });
  }

  // 3) Total a Pagar (col J) numérico y > 0.
  const totalParse = parseMonto(row?.[COL.TOTAL]);
  if (totalParse.valor == null) {
    probs.push({
      rowNumber,
      codigo: "total-no-numerico",
      severidad: "HALT",
      mensaje: `col J (Total a Pagar) no es numérico: "${total}"`,
      contexto: ctx,
    });
  } else {
    if (!totalParse.esNumero) {
      probs.push({
        rowNumber,
        codigo: "total-como-texto",
        severidad: "WARN",
        mensaje: `col J (Total) está como TEXTO ("${total}") — rompe las fórmulas SUM del Dashboard`,
        contexto: ctx,
      });
    }
    if (totalParse.valor <= 0) {
      probs.push({
        rowNumber,
        codigo: "total-no-positivo",
        severidad: "WARN",
        mensaje: `col J (Total) <= 0 (${totalParse.valor})`,
        contexto: ctx,
      });
    }
  }

  // 4) Subtotal (col E) numérico (si presente).
  const subParse = parseMonto(row?.[COL.SUBTOTAL]);
  if (cell(COL.SUBTOTAL) !== "" && subParse.valor == null) {
    probs.push({
      rowNumber,
      codigo: "subtotal-no-numerico",
      severidad: "HALT",
      mensaje: `col E (Subtotal) no es numérico: "${cell(COL.SUBTOTAL)}"`,
      contexto: ctx,
    });
  } else if (cell(COL.SUBTOTAL) !== "" && !subParse.esNumero) {
    probs.push({
      rowNumber,
      codigo: "subtotal-como-texto",
      severidad: "WARN",
      mensaje: `col E (Subtotal) está como TEXTO ("${cell(COL.SUBTOTAL)}")`,
      contexto: ctx,
    });
  }

  // 5) ALINEACIÓN DE COLUMNAS (el bug histórico de values.append).
  //    Síntoma típico: las columnas se corrieron 1 a la izquierda → el MONTO
  //    cayó en col D (numero) y el numero se perdió, o la Fecha cayó en col A
  //    pero el resto se desplazó. Detectamos:
  //    a) col D (numero) parece un MONTO grande con separadores/decimales.
  //    b) col J (total) NO es numérico PERO col D sí lo es → corrimiento.
  // a) col D con formato de MONTO explícito ($ o miles agrupados) → corrida.
  if (numero !== "" && !pareceNumeroDocumento(numero)) {
    probs.push({
      rowNumber,
      codigo: "numero-parece-monto",
      severidad: "HALT",
      mensaje: `col D (# Documento) tiene formato de MONTO ("${numero}") — columnas posiblemente corridas`,
      contexto: ctx,
    });
  } else {
    // b) señal PRECISA: el valor numérico de col D coincide con el Subtotal (E) o
    //    el Total (J) de la MISMA fila → el monto se filtró a la columna del numero
    //    (desalineación real). Evita falsos positivos en numeros enteros largos.
    const dNum = parseMonto(row?.[COL.NUMERO]).valor;
    const subV = subParse.valor;
    const totV = totalParse.valor;
    if (
      dNum != null && dNum > 1000 &&
      ((subV != null && subV > 0 && Math.abs(dNum - subV) < 1) ||
        (totV != null && totV > 0 && Math.abs(dNum - totV) < 1))
    ) {
      probs.push({
        rowNumber,
        codigo: "columnas-corridas",
        severidad: "HALT",
        mensaje: `col D (# Documento = ${dNum}) coincide con Subtotal/Total → monto filtrado a la columna del numero (desalineación)`,
        contexto: ctx,
      });
    }
  }

  // 6) Coherencia aritmética: Total ≈ Subtotal + IVA - retenciones (col J vs E/F/G/H/I).
  if (totalParse.valor != null && subParse.valor != null) {
    const iva = parseMonto(row?.[COL.IVA]).valor ?? 0;
    const rtf = parseMonto(row?.[COL.RETEFUENTE]).valor ?? 0;
    const riva = parseMonto(row?.[COL.RETEIVA]).valor ?? 0;
    const rica = parseMonto(row?.[COL.RETEICA]).valor ?? 0;
    const esperado = subParse.valor + iva - rtf - riva - rica;
    const dif = Math.abs(esperado - totalParse.valor);
    // Tolerancia 1 peso por redondeos.
    if (subParse.valor > 0 && dif > 1) {
      probs.push({
        rowNumber,
        codigo: "total-no-cuadra",
        severidad: "WARN",
        mensaje: `Total (${totalParse.valor}) ≠ Subtotal+IVA-Retenciones (${esperado}); dif=${Math.round(dif)}`,
        contexto: ctx,
      });
    }
  }

  // 7) Link PDF (col M) — WARN si ausente (puede ser DIAN solo-XML, no HALT).
  if (link === "") {
    probs.push({
      rowNumber,
      codigo: "link-pdf-ausente",
      severidad: "WARN",
      mensaje: `col M (Link PDF) vacía — verificar si la factura tenía PDF que archivar`,
      contexto: ctx,
    });
  }

  // 8) Proveedor ausente (col B) — WARN.
  if (proveedor === "") {
    probs.push({ rowNumber, codigo: "proveedor-ausente", severidad: "WARN", mensaje: "col B (Proveedor) vacía", contexto: ctx });
  }

  return probs;
}

// ===========================================================================
// DEDUP DETERMINÍSTICA POR NÚMERO NORMALIZADO (todo el Sheet, todos los meses)
// ===========================================================================

export interface FilaRef {
  tab: string;
  rowNumber: number;
  numero: string;
  nit: string;
  proveedor: string;
  /** Fecha (serial o YYYY-MM-DD) — distingue numeros informales reusados entre meses. */
  fecha?: string;
}

/**
 * Numeros NO informativos que el LLM a veces pone como "numero" pero no
 * identifican la factura: literalmente "no especificado", "sin numero", "n/a",
 * "varios", etc. No deben usarse como llave de dedup (3 CC distintas con
 * "no especificado" NO son la misma factura).
 */
export function esNumeroNoInformativo(numero: string | null | undefined): boolean {
  const n = normalizeNumero(numero).toUpperCase();
  if (n === "") return true;
  return /^(NOESPECIFICADO|SINNUMERO|SN|NA|NINGUNO|VARIOS|PENDIENTE)$/.test(n);
}

export interface GrupoDuplicado {
  key: string; // numeroNorm|nitNorm (o |provNorm si falta NIT)
  numeroNorm: string;
  ocurrencias: FilaRef[];
}

function normNit(nit: string): string {
  return String(nit ?? "").replace(/\D+/g, "");
}
function normProv(p: string): string {
  return String(p ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(s\.?\s*a\.?\s*s?\.?|ltda\.?|sociedad|p\.?\s*h\.?)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Llave de identidad de una factura para dedup: numero normalizado + (NIT si
 * existe, sino proveedor normalizado). Misma lógica conceptual que isDuplicate
 * de pipeline.ts pero con normalización de numero (que isDuplicate NO hace).
 */
export function claveDedup(ref: { numero: string; nit: string; proveedor: string; fecha?: string }): string {
  const numN = normalizeNumero(ref.numero);
  const nitN = normNit(ref.nit);
  const tail = nitN || normProv(ref.proveedor) || "?";
  // Incluir FECHA: las cuentas de cobro informales reusan consecutivos ("1","2")
  // mes a mes — mismo numero + mismo proveedor pero DISTINTA fecha = facturas
  // distintas, NO un duplicado. Una factura repetida real comparte numero+nit+fecha.
  return `${numN}|${tail}|${String(ref.fecha ?? "").trim()}`;
}

/**
 * Detecta grupos de filas que representan la MISMA factura (duplicados) a través
 * de TODAS las pestañas, comparando por numero NORMALIZADO + NIT/proveedor.
 * Atrapa lo que isDuplicate deja pasar: "FE 001" vs "FE001", "0001" vs "1".
 */
export function detectarDuplicados(filas: FilaRef[]): GrupoDuplicado[] {
  const porClave = new Map<string, FilaRef[]>();
  for (const f of filas) {
    if (esNumeroNoInformativo(f.numero)) continue; // sin numero / "no especificado" → no dedup
    const k = claveDedup(f);
    const arr = porClave.get(k) ?? [];
    arr.push(f);
    porClave.set(k, arr);
  }
  const grupos: GrupoDuplicado[] = [];
  for (const [key, ocurrencias] of porClave) {
    if (ocurrencias.length > 1) {
      grupos.push({ key, numeroNorm: key.split("|")[0], ocurrencias });
    }
  }
  // Orden estable: mayor cantidad de ocurrencias primero, luego por key.
  grupos.sort((a, b) => b.ocurrencias.length - a.ocurrencias.length || a.key.localeCompare(b.key));
  return grupos;
}

// ===========================================================================
// CRUCE 3 FUENTES POR MES: Gmail(Facturas) = Sheet = Drive (por numero norm)
// ===========================================================================

export interface CruceMesInput {
  tab: string;
  /** numeros (col D) de las filas con datos del Sheet de ese mes. */
  sheetNumeros: string[];
  /** numeros parseados de los filenames de PDFs en Drive YYYY-MM. */
  driveNumeros: string[];
  /** Conteo de emails con label Facturas/YYYY recibidos en ese mes. */
  gmailFacturasCount: number;
}

export interface CruceMesResult {
  tab: string;
  conteos: { gmail: number; sheet: number; drive: number };
  /** Numeros en Sheet sin PDF correspondiente en Drive (huérfanos de Sheet). */
  sheet_sin_drive: string[];
  /** PDFs en Drive sin fila en Sheet (huérfanos de Drive). */
  drive_sin_sheet: string[];
  /** Diferencia Gmail vs Sheet (recepción vs emisión: puede haber borde de mes). */
  gmail_vs_sheet: number;
  ok: boolean;
}

/**
 * Cruza un mes por CONJUNTO de numeros normalizados (no por conteo): Sheet⊆Drive
 * y Drive⊆Sheet. Gmail se compara sólo por conteo (no parseamos numero del email)
 * y se reporta como diferencia informativa (borde de mes recepción/emisión).
 */
export function cruzarMes(input: CruceMesInput): CruceMesResult {
  // Normaliza Y quita ceros a la izquierda para el cruce: el filename de Drive a
  // veces trae "00846" y el Sheet "846" — es la MISMA factura, no un huérfano.
  const normSet = (xs: string[]) =>
    new Set(xs.map((x) => numeroSinCerosIzq(normalizeNumero(x))).filter((x) => x !== ""));
  const sheet = normSet(input.sheetNumeros);
  const drive = normSet(input.driveNumeros);

  const sheet_sin_drive = [...sheet].filter((n) => !drive.has(n)).sort();
  const drive_sin_sheet = [...drive].filter((n) => !sheet.has(n)).sort();
  const gmail_vs_sheet = input.gmailFacturasCount - sheet.size;

  return {
    tab: input.tab,
    conteos: { gmail: input.gmailFacturasCount, sheet: sheet.size, drive: drive.size },
    sheet_sin_drive,
    drive_sin_sheet,
    gmail_vs_sheet,
    // ok exige paridad EXACTA de conjuntos Sheet<->Drive. Gmail es informativo
    // (borde de mes) → no tumba el ok, pero se reporta.
    ok: sheet_sin_drive.length === 0 && drive_sin_sheet.length === 0,
  };
}

// ===========================================================================
// AGREGADO FINAL — veredicto del validador
// ===========================================================================

export interface VeredictoInput {
  problemasFila: FilaProblema[];
  duplicados: GrupoDuplicado[];
  crucesMes: CruceMesResult[];
  /** Descartes sospechosos (remitentes-gasto botados) detectados aparte. */
  descartesSospechosos: number;
}

export interface Veredicto {
  ok: boolean;
  halts: number;
  warns: number;
  logs: number;
  duplicados: number;
  meses_con_huerfanos: number;
  descartes_sospechosos: number;
  /** Resumen 1-línea por severidad agregando todo. */
  resumen: string;
}

/**
 * Veredicto global: ok=true SOLO si 0 HALT, 0 duplicados, 0 huérfanos de mes.
 * WARN y descartes sospechosos NO tumban ok pero se cuentan y reportan.
 */
export function veredictoFinal(input: VeredictoInput): Veredicto {
  const halts = input.problemasFila.filter((p) => p.severidad === "HALT").length;
  const warns = input.problemasFila.filter((p) => p.severidad === "WARN").length;
  const logs = input.problemasFila.filter((p) => p.severidad === "LOG").length;
  const duplicados = input.duplicados.length;
  const meses_con_huerfanos = input.crucesMes.filter((c) => !c.ok).length;
  const ok = halts === 0 && duplicados === 0 && meses_con_huerfanos === 0;
  const resumen =
    `${ok ? "OK" : "FALLA"} · ${halts} HALT · ${warns} WARN · ${duplicados} duplicados · ` +
    `${meses_con_huerfanos} meses con huérfanos · ${input.descartesSospechosos} descartes sospechosos`;
  return {
    ok,
    halts,
    warns,
    logs,
    duplicados,
    meses_con_huerfanos,
    descartes_sospechosos: input.descartesSospechosos,
    resumen,
  };
}
