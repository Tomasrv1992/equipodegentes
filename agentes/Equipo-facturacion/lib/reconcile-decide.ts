/**
 * Función PURA de decisión del reconciliador de labels Gmail.
 *
 * Causa raíz que ataca: los migradores de labels usaban heurísticas
 * (numero/proveedor) → producían overlap. Esta función toma decisiones
 * determinísticas basadas en messageId.
 *
 * Diseñada como función pura para test unitario antes de aplicar en prod.
 *
 * GUARDA DE PRECEDENCIA (CRÍTICA):
 * Si un email tiene label Facturas/year PERO NO hay event con su messageId,
 * NO TOCAR. Es probablemente histórico sin backfill — no se puede asumir su
 * estado. Pre-backfill: peor caso = overlap se queda (cosmético).
 * Post-backfill: este path no se ejecuta (todas tienen messageId).
 *
 * Sin esta guarda, reconcile invierte facturas reales a Descartado.
 */
export function decide(
  messageId: string,
  F: Set<string>,           // emails con label Facturas/year
  D: Set<string>,           // emails con label Descartado/year
  esFactura: Set<string>,   // messageIds de events factura_procesada
  esDescartado: Set<string>, // messageIds de events email_descartado
  facturasId: string,        // label ID Facturas/year (para add/remove arrays)
  descartadoId: string,      // label ID Descartado/year
): { add: string[]; remove: string[] } {
  const haveFacturas = F.has(messageId);
  const haveDescartado = D.has(messageId);
  const shouldFacturas = esFactura.has(messageId);

  if (shouldFacturas) {
    // Evidencia positiva: es factura. Aplicar Facturas, quitar Descartado.
    const add: string[] = [];
    const remove: string[] = [];
    if (!haveFacturas) add.push(facturasId);      // recuperar Facturas si lo perdió
    if (haveDescartado) remove.push(descartadoId);
    return { add, remove };
  }

  if (haveFacturas) {
    // GUARDA DE PRECEDENCIA: tiene Facturas pero NO hay event con messageId.
    // Probablemente histórico sin backfill. NO TOCAR — evita inversión.
    return { add: [], remove: [] };
  }

  if (esDescartado.has(messageId)) {
    // No es factura, hay event de descarte. Aplicar Descartado si falta.
    const add: string[] = [];
    if (!haveDescartado) add.push(descartadoId);
    return { add, remove: [] };
  }

  // Huérfano: en Gmail pero no en events. Skip por seguridad.
  return { add: [], remove: [] };
}
