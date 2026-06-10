import { getServerClient } from "./supabase-server";

/**
 * Helpers para emitir agent_events granulares — una fila por cada item
 * procesado por un agente. Permite agrupar/filtrar por la fecha real del item
 * (no por la fecha del run), que es lo que el cliente espera ver.
 */

export interface FacturaEventPayload {
  /**
   * Gmail message ID que originó la factura. CRÍTICO para reconcile-labels
   * determinístico (2026-06-09): sin esto los migradores de labels usaban
   * heurísticas (numero/proveedor) que producían overlap. Cuentas históricas
   * sin messageId existen — el reconciler tiene guarda de precedencia que
   * NO toca emails sin messageId (no asume su estado).
   */
  messageId?: string;
  fecha: string;            // ISO YYYY-MM-DD (fecha de emisión de la factura, NO del run)
  proveedor: string;
  nit: string;
  numero: string;
  /**
   * Consecutivo asignado en Sheet/Drive durante el procesamiento.
   * CRÍTICO para rebuilds: sin este campo, al recrear el Sheet desde events
   * se asignan consecutivos nuevos 1..N que NO matchean los nombres de PDF
   * en Drive (bug detectado 2026-05-22 en Freshco). Persistir acá es la
   * única fuente de verdad cross-Sheet/Drive/BD.
   */
  consecutivo?: number;
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
 * Helper paginado para leer TODOS los events de un cliente / año / tipo.
 *
 * CRÍTICO 2026-06-09: NO usar LIMIT global. Para reconcile-labels y
 * backfill-messageid necesitamos TODOS los events del año, no los primeros
 * 1000. Esto recorre todas las páginas de 1000 hasta agotar resultados.
 *
 * Filtro temporal: por `created_at` (cuándo se procesó el email), no por
 * `payload->>fecha` (fecha de emisión de la factura).
 */
export async function getAllEventsByYear(
  clienteId: string,
  tipo: "factura_procesada" | "email_descartado",
  year: number,
): Promise<Array<{ id: string; run_id: string | null; payload: any; created_at: string }>> {
  const supa = getServerClient();
  const yearStart = `${year}-01-01T00:00:00Z`;
  const yearEnd = `${year + 1}-01-01T00:00:00Z`;
  const PAGE = 1000;
  const out: any[] = [];
  let from = 0;
  while (from < 200_000) {  // cap defensivo, ~200 páginas
    const { data, error } = await supa
      .from("agent_events")
      .select("id, run_id, payload, created_at")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", tipo)
      .gte("created_at", yearStart)
      .lt("created_at", yearEnd)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`[getAllEventsByYear] error: ${error.message}`);
      break;
    }
    const batch = (data ?? []) as any[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Payload de un email descartado por el pipeline (no quedó en Sheet).
 * Se inserta con tipo="email_descartado". Sirve para auditar la diferencia
 * Gmail-label "Procesado" vs filas reales del Sheet.
 *
 * Motivos típicos: pre-filter-sender, pre-filter-subject, planilla-ss-tercero,
 * docx-no-es-factura, pdf-no-es-factura, factura-invalida, no-es-factura-dian,
 * dian-sin-numero, dup-en-sheet, guard-emergencia, pdf-encrypted, pdf-no-text.
 */
export interface EmailDescartadoPayload {
  /** Gmail message ID — link directo: https://mail.google.com/mail/u/0/#all/{messageId} */
  messageId: string;
  /** Motivo del descarte. Texto libre pero estable (usado para agrupar). */
  motivo: string;
  /** From: header del email (limpio, sin chevrons). Puede ser null si no se pudo extraer. */
  sender?: string | null;
  /** Subject del email. */
  subject?: string | null;
  /** Fecha del email (header Date, ISO). Puede ser null si no se pudo parsear. */
  fechaEmail?: string | null;
  /** YYYY-MM derivado de fechaEmail (para agrupar por mes en endpoints). */
  mes?: string | null;
}

export interface EmitEmailDescartadosInput {
  runId: string;
  clienteId: string;
  agenteId: string;
  descartes: EmailDescartadoPayload[];
}

/**
 * Inserta agent_events con tipo="email_descartado" — uno por cada email que
 * el pipeline rechazó. Idempotencia por (cliente_id, agente_id, messageId):
 * si ya existe un descarte para ese messageId, lo ignora silencioso.
 *
 * No bloquea el run si falla: errores se loguean pero no se throw-ean.
 */
export async function emitEmailDescartadoEvents(input: EmitEmailDescartadosInput): Promise<void> {
  if (input.descartes.length === 0) return;

  const supa = getServerClient();
  let okCount = 0;
  let dupCount = 0;

  for (const d of input.descartes) {
    if (!d.messageId) continue;

    // Derivar mes (YYYY-MM) desde fechaEmail si es parseable
    let mes: string | null = d.mes ?? null;
    if (!mes && d.fechaEmail) {
      try {
        const dt = new Date(d.fechaEmail);
        if (!isNaN(dt.getTime())) {
          mes = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
        }
      } catch { /* mes queda null */ }
    }

    const payload = {
      messageId: d.messageId,
      motivo: String(d.motivo ?? "sin-motivo").slice(0, 200),
      sender: d.sender ?? null,
      subject: d.subject ?? null,
      fechaEmail: d.fechaEmail ?? null,
      mes,
    };

    const { error } = await supa.from("agent_events").insert({
      run_id: input.runId,
      cliente_id: input.clienteId,
      agente_id: input.agenteId,
      tipo: "email_descartado",
      payload,
    });

    if (!error) {
      okCount++;
    } else if (
      error.code === "23505" ||
      /duplicate key|unique constraint/i.test(error.message)
    ) {
      dupCount++;
    } else {
      console.error(`emitEmailDescartado failed for ${d.messageId}: ${error.message}`);
    }
  }

  if (okCount > 0 || dupCount > 0) {
    console.log(
      `[events:descartado] cliente=${input.clienteId}: ${okCount} inserted, ${dupCount} duplicates skipped`,
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
