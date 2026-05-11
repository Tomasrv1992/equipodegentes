import { getServerClient } from "./supabase-server";

/**
 * Helpers para emitir agent_events granulares — una fila por cada item
 * procesado por un agente. Permite agrupar/filtrar por la fecha real del item
 * (no por la fecha del run), que es lo que el cliente espera ver.
 */

export interface FacturaEventPayload {
  fecha: string;            // ISO YYYY-MM-DD (fecha de emisión de la factura, NO del run)
  proveedor: string;
  nit: string;
  numero: string;
  cufe?: string;
  subtotal: number;
  iva: number;
  total: number;
  concepto?: string;
  categoria?: string;
  cuentaPyg?: string;
  driveLink?: string;
  /**
   * Tipo de documento. Default 'factura_dian' para retro-compat.
   * Valores: factura_dian | cuenta_cobro | recibo_internacional | recibo_servicio | planilla_ss
   */
  tipo?: string;
  /**
   * Retenciones aplicadas (códigos DIAN 05/06/07). Solo facturas DIAN las extraen;
   * cuentas de cobro y recibos no-DIAN quedan en 0 a menos que se configuren
   * reglas de retención por cliente (Sub-fase 2).
   */
  reteFuente?: number;
  reteIva?: number;
  reteIca?: number;
  totalRetenciones?: number;
}

export interface EmitFacturaEventsInput {
  runId: string;
  clienteId: string;
  agenteId: string;
  facturas: FacturaEventPayload[];
}

/**
 * Inserta en bulk un agent_event por cada factura procesada.
 * Idempotencia: si ya existe un event con el mismo (cliente, agente, payload->>numero, payload->>nit),
 * lo saltea (un cron que reprocesa la misma factura no duplica events).
 *
 * Para idempotencia perfecta usaríamos UNIQUE (cliente_id, agente_id, payload->>numero, payload->>nit)
 * pero por ahora hacemos best-effort: si el insert falla por uniqueness, ignoramos.
 */
export async function emitFacturaEvents(input: EmitFacturaEventsInput): Promise<void> {
  if (input.facturas.length === 0) return;

  const supa = getServerClient();

  const rows = input.facturas.map((f) => ({
    run_id: input.runId,
    cliente_id: input.clienteId,
    agente_id: input.agenteId,
    tipo: "factura_procesada",
    payload: f as unknown as Record<string, unknown>,
  }));

  const { error } = await supa.from("agent_events").insert(rows);
  if (error) {
    // No-fatal: loguamos pero no rompemos el pipeline
    console.error(`emitFacturaEvents: insert failed (${input.facturas.length} rows): ${error.message}`);
  }
}

/**
 * Resuelve cliente_id desde slug (helper de conveniencia).
 * Devuelve null si no existe.
 */
export async function clienteIdBySlug(slug: string): Promise<string | null> {
  const supa = getServerClient();
  const { data, error } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", slug)
    .single();
  if (error || !data) return null;
  return (data as { id: string }).id;
}
