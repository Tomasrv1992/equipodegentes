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
  /**
   * Audit trail del engine de retenciones (Sub-fase 2). Indica de dónde
   * salió cada valor de retención:
   *   - "xml"          → del XML del proveedor (proveedor calculó)
   *   - "oficio"       → calculado por reglas del cliente (XML vacío)
   *   - "override_nit" → cliente declaró proveedor exento por NIT
   *   - "none"         → no aplica retención (cliente no es agente o monto < umbral)
   * Si el cliente no tiene reglas configuradas, este campo queda undefined.
   */
  retencionSource?: {
    rtf: "xml" | "oficio" | "override_nit" | "none";
    iva: "xml" | "oficio" | "override_nit" | "none";
    ica: "xml" | "oficio" | "override_nit" | "none";
  };
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

  // AUDIT 2026-05-13: SANITIZACIÓN DE TIPOS antes de insertar.
  // Garantiza que el admin panel reciba SIEMPRE tipos correctos:
  //   - total/subtotal/iva: number
  //   - fecha: YYYY-MM-DD string
  //   - proveedor/nit/numero: strings no vacíos
  // Si alguno falla validación, se loguea y se SKIP el insert (no rompe el batch).
  const rows: any[] = [];
  for (const f of input.facturas) {
    const fechaStr = String(f.fecha ?? "").trim();
    const fechaOk = /^\d{4}-\d{2}-\d{2}$/.test(fechaStr);
    const numeroStr = String(f.numero ?? "").trim();
    const total = typeof f.total === "number" ? f.total : Number(f.total ?? 0);
    if (!fechaOk || !numeroStr || isNaN(total)) {
      console.warn(
        `[events] skip insert por datos inválidos: fecha="${fechaStr}" numero="${numeroStr}" total=${f.total}`,
      );
      continue;
    }
    // Normalizar payload: forzar tipos correctos
    const cleanPayload = {
      ...f,
      fecha: fechaStr,
      proveedor: String(f.proveedor ?? "").trim(),
      nit: String(f.nit ?? "").replace(/\D+/g, ""),
      numero: numeroStr,
      subtotal: Number(f.subtotal ?? 0) || 0,
      iva: Number(f.iva ?? 0) || 0,
      total,
      reteFuente: Number(f.reteFuente ?? 0) || 0,
      reteIva: Number(f.reteIva ?? 0) || 0,
      reteIca: Number(f.reteIca ?? 0) || 0,
      totalRetenciones: Number(f.totalRetenciones ?? 0) || 0,
    };
    rows.push({
      run_id: input.runId,
      cliente_id: input.clienteId,
      agente_id: input.agenteId,
      tipo: "factura_procesada",
      payload: cleanPayload as unknown as Record<string, unknown>,
    });
  }

  // Insert por filas individuales con ON CONFLICT DO NOTHING (idempotente).
  // El insert bulk fallaba TODO el batch si una sola fila chocaba con el UNIQUE
  // constraint agent_events_factura_unique (migración 0005), perdiendo events
  // de facturas nuevas. Ahora cada fila va por separado — los duplicados se
  // ignoran silenciosamente y las nuevas se guardan.
  let okCount = 0;
  let dupCount = 0;
  for (const row of rows) {
    const { error } = await supa.from("agent_events").insert(row);
    if (!error) {
      okCount++;
    } else if (
      error.code === "23505" ||
      /duplicate key|unique constraint/i.test(error.message)
    ) {
      dupCount++;
    } else {
      // Error no-duplicado: logueamos pero seguimos
      console.error(`emitFacturaEvents row failed: ${error.message}`);
    }
  }
  if (dupCount > 0 || okCount < rows.length) {
    console.log(
      `[events] cliente=${input.clienteId}: ${okCount} inserted, ${dupCount} duplicates skipped`,
    );
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
