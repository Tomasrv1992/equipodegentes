/**
 * Helper para escribir entradas al audit log (Capa 4 de exigencia).
 *
 * Todas las acciones destructivas o correctivas de los agentes deben
 * pasar por aquí. Append-only — nunca actualizar ni borrar.
 *
 * Uso:
 *   await auditLog({
 *     agente: 'limpiador',
 *     accion: 'limpiador.borrar_fila_duplicada',
 *     clienteSlug: 'dentilandia',
 *     clienteId: c.id,
 *     datosAntes: { fila: 45, numero: '...' },
 *     motivo: 'Duplicado exacto con fila 12',
 *   });
 */

import { getServerClient } from "./supabase-server";

export type AuditAccion =
  // Limpiador
  | "limpiador.borrar_fila_duplicada"
  | "limpiador.marcar_basura"
  | "limpiador.auto_reparar_fila"
  | "limpiador.mover_pdf_papelera"
  | "limpiador.mover_pdf_revisar_manual"
  // Reparador
  | "reparador.insertar_fila_faltante"
  | "reparador.actualizar_link_pdf"
  // Supervisor
  | "supervisor.retrigger_agente"
  | "supervisor.escalar_intervencion_humana"
  // Procesador
  | "procesador.skip_factura_invalida";

export interface AuditEntry {
  agente: string;
  accion: AuditAccion;
  clienteSlug?: string;
  clienteId?: string;
  datosAntes?: Record<string, any>;
  datosDespues?: Record<string, any>;
  motivo?: string;
  detalles?: Record<string, any>;
}

/**
 * Escribe una entrada al audit log. Idempotente en errores: si falla la escritura,
 * solo loggea — NO interrumpe el flujo del agente.
 */
export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    const supa = getServerClient();
    const { error } = await supa.from("audit_log").insert({
      agente_id: entry.agente,
      accion: entry.accion,
      cliente_id: entry.clienteId ?? null,
      cliente_slug: entry.clienteSlug ?? null,
      datos_antes: entry.datosAntes ?? null,
      datos_despues: entry.datosDespues ?? null,
      motivo: entry.motivo ?? null,
      detalles: entry.detalles ?? null,
    });
    if (error) {
      console.warn(`[audit-log] insert failed: ${error.message}`);
    }
  } catch (err: any) {
    console.warn(`[audit-log] crash escribiendo: ${err.message}`);
  }
}

/**
 * Cuenta cuántas veces el supervisor ya retriggeó un agente para un cliente HOY
 * (zona Bogotá). Para anti-loop.
 */
export async function contarRetriggersHoy(
  clienteSlug: string,
  agenteDestino?: string,
): Promise<number> {
  try {
    const supa = getServerClient();
    const { data, error } = await supa.rpc("count_retriggers_hoy", {
      p_cliente_slug: clienteSlug,
      p_agente_id: agenteDestino ?? null,
    });
    if (error) {
      console.warn(`[audit-log] count_retriggers_hoy failed: ${error.message}`);
      return 0;
    }
    return Number(data ?? 0);
  } catch (err: any) {
    console.warn(`[audit-log] crash contando: ${err.message}`);
    return 0;
  }
}

/** Threshold de anti-loop. Si el supervisor ya retriggeó N veces hoy → escalar. */
export const MAX_RETRIGGERS_POR_DIA = 3;
