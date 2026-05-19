// netlify/functions/inspect-events.mts
//
// Endpoint SÍNCRONO que devuelve estado real de agent_events para un cliente
// y un rango de fechas (típicamente un mes). Sirve para validar si la BD
// tiene events duplicados (mismo numero+nit) que después rebuild-sheet
// re-inserta como duplicados visibles en el Sheet.
//
// Body: { clienteSlug: string, year: number, month: number }
// Auth: x-internal-secret.

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

interface EventsInspection {
  cliente: string;
  year: number;
  month: number;
  ts: string;
  total_events: number;
  events_unicos: number;          // por (numero, nit)
  duplicados_top: Array<{
    numero: string;
    nit: string;
    proveedor: string;
    count: number;
  }>;
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { clienteSlug?: string; year?: number; month?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year);
  const month = Number(body.month);
  if (!clienteSlug || !year || !month || month < 1 || month > 12) {
    return new Response(
      "missing/invalid clienteSlug | year | month",
      { status: 400 },
    );
  }

  const supa = getServerClient();
  const { data: cli } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", clienteSlug)
    .single();
  if (!cli) return new Response(`cliente "${clienteSlug}" not found`, { status: 404 });

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  // Paginar todos los events del mes
  const PAGE = 1000;
  const all: any[] = [];
  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("payload, created_at")
      .eq("cliente_id", (cli as any).id)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", monthStart)
      .lt("payload->>fecha", monthEnd)
      .range(from, from + PAGE - 1);
    if (error) {
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    const batch = (data ?? []) as any[];
    all.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }

  // Agrupar por (numero, nit)
  const groups = new Map<
    string,
    { numero: string; nit: string; proveedor: string; count: number }
  >();
  for (const ev of all) {
    const p = ev.payload ?? {};
    const numero = String(p.numero ?? "").trim();
    const nit = String(p.nit ?? "").trim();
    const proveedor = String(p.proveedor ?? "").trim();
    if (!numero) continue;
    const key = `${numero}|${nit}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { numero, nit, proveedor, count: 1 });
  }

  const duplicadosTop = Array.from(groups.values())
    .filter((g) => g.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const response: EventsInspection = {
    cliente: clienteSlug,
    year,
    month,
    ts: new Date().toISOString(),
    total_events: all.length,
    events_unicos: groups.size,
    duplicados_top: duplicadosTop,
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
