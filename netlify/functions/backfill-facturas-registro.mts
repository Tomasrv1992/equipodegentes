// netlify/functions/backfill-facturas-registro.mts
//
// Backfill histórico de facturas_registro (migración 0018).
//
// Sin este backfill, la guarda de BD solo protege facturas NUEVAS: las históricas
// (ya en el Sheet pero ausentes de facturas_registro) no estarían registradas, así
// que un reproceso podría re-escribirlas. Este script las carga desde agent_events
// (tipo 'factura_procesada') para que la guarda también las cubra.
//
// Idempotente: ON CONFLICT (cliente_id, dedupe_key) DO NOTHING. origen='backfill'.
//
// Auth: x-internal-secret (mismo que el cron).
//
// POST body: { clienteSlug: "freshco", year?: 2026, dryRun?: true (default) }
//   - dryRun=true  → solo reporta cuántas filas insertaría, sin escribir.
//   - dryRun=false → inserta y reporta { total_eventos, insertadas, duplicadas_omitidas }.

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { getAllEventsByYear } from "../../shared/agents-runtime/src/agent-events";
import { calcularDedupeKey } from "../../shared/agents-runtime/src/facturas-registro";

interface RequestBody {
  clienteSlug: string;
  year?: number;
  dryRun?: boolean;
}

interface FilaRegistro {
  cliente_id: string;
  dedupe_key: string;
  cufe: string | null;
  gmail_message_id: string;
  numero_documento: string | null;
  fecha_factura: string | null;
  proveedor_nit: string | null;
  total: number | null;
  origen: "backfill";
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || new Date().getFullYear();
  const dryRun = body.dryRun !== false; // default TRUE (seguro)
  if (!clienteSlug) {
    return new Response("missing clienteSlug", { status: 400 });
  }

  const supa = getServerClient();
  const { data: cli } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", clienteSlug)
    .single();
  if (!cli) {
    return new Response(
      JSON.stringify({ error: `cliente "${clienteSlug}" no encontrado` }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  const clienteId = (cli as any).id as string;

  // 1. Leer TODOS los eventos factura_procesada del cliente/año (paginado).
  const events = await getAllEventsByYear(clienteId, "factura_procesada", year);

  // 2. Construir filas dedup. Mapa por dedupe_key para no mandar 2 filas con la
  //    misma clave en el mismo upsert. Eventos sin messageId ni CUFE no se pueden
  //    deduplicar → se cuentan y se omiten.
  const porKey = new Map<string, FilaRegistro>();
  let sinIdentificador = 0;
  for (const ev of events) {
    const p: any = ev.payload ?? {};
    const messageId = String(p.messageId ?? "").trim();
    const cufe = String(p.cufe ?? "").trim();
    if (!messageId && !cufe) {
      sinIdentificador++;
      continue;
    }
    const dedupeKey = calcularDedupeKey({ cufe, gmailMessageId: messageId });
    if (!dedupeKey) {
      sinIdentificador++;
      continue;
    }
    if (porKey.has(dedupeKey)) continue;
    const fechaRaw = typeof p.fecha === "string" ? p.fecha : "";
    porKey.set(dedupeKey, {
      cliente_id: clienteId,
      dedupe_key: dedupeKey,
      cufe: cufe || null,
      // gmail_message_id es NOT NULL. Si el evento histórico no tiene messageId
      // pero sí CUFE, usamos el dedupeKey (= CUFE) como placeholder.
      gmail_message_id: messageId || dedupeKey,
      numero_documento: p.numero ? String(p.numero) : null,
      fecha_factura: /^\d{4}-\d{2}-\d{2}/.test(fechaRaw) ? fechaRaw.slice(0, 10) : null,
      proveedor_nit: p.nit ? String(p.nit).replace(/\D+/g, "") : null,
      total: typeof p.total === "number" ? p.total : Number(p.total) || null,
      origen: "backfill",
    });
  }
  const filas = [...porKey.values()];

  // 3. dryRun → solo reporta, sin escribir.
  if (dryRun) {
    return new Response(
      JSON.stringify(
        {
          dryRun: true,
          cliente: clienteSlug,
          year,
          total_eventos: events.length,
          eventos_sin_identificador: sinIdentificador,
          filas_unicas: filas.length,
          wouldInsert: filas.length,
          sample: filas.slice(0, 3),
        },
        null,
        2,
      ),
      { headers: { "content-type": "application/json" } },
    );
  }

  // 4. Insertar con ON CONFLICT (cliente_id, dedupe_key) DO NOTHING, por lotes.
  let insertadas = 0;
  const CHUNK = 500;
  for (let i = 0; i < filas.length; i += CHUNK) {
    const lote = filas.slice(i, i + CHUNK);
    const { data, error } = await supa
      .from("facturas_registro")
      .upsert(lote, { onConflict: "cliente_id,dedupe_key", ignoreDuplicates: true })
      .select("id");
    if (error) {
      return new Response(
        JSON.stringify({
          error: `insert facturas_registro falló: ${error.message}`,
          hint: "¿Aplicaste la migración 0018 en Supabase?",
          insertadas_antes_del_error: insertadas,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    insertadas += data?.length ?? 0;
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        cliente: clienteSlug,
        year,
        total_eventos: events.length,
        eventos_sin_identificador: sinIdentificador,
        insertadas,
        duplicadas_omitidas: filas.length - insertadas,
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
