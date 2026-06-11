// shared/agents-runtime/src/dedupe-key.ts
//
// Cálculo de la clave de deduplicación de una factura. Función PURA (sin I/O,
// sin Supabase) para que sea trivial de testear y de razonar.
//
// Regla (incidente duplicación masiva mayo 2026, ver migración 0018):
//   - Factura electrónica DIAN  → el CUFE es el identificador único oficial.
//   - Documento NO-DIAN (planilla SS, cuenta de cobro, recibo PDF) → no hay
//     CUFE; usamos el Gmail message id (un email = un documento).
//
// El UNIQUE en la BD es sobre (cliente_id, dedupe_key). Esta función decide
// qué valor toma `dedupe_key`.

export interface DedupeKeyInput {
  /** CUFE de la factura DIAN. Vacío/null/undefined para documentos no-DIAN. */
  cufe?: string | null;
  /** Gmail message id que originó el documento. Fallback cuando no hay CUFE. */
  gmailMessageId: string;
}

/**
 * Devuelve la clave de deduplicación: el CUFE si está presente (trim no vacío),
 * o el Gmail message id en caso contrario.
 */
export function calcularDedupeKey(input: DedupeKeyInput): string {
  const cufe = String(input.cufe ?? "").trim();
  if (cufe.length > 0) return cufe;
  return input.gmailMessageId;
}
