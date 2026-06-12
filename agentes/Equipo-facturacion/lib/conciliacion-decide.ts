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
