// netlify/functions/inspect-events-detail.mts
//
// Inspecciona los events con MÁS detalle: rango de consecutivos, fechas, sample.
// Body: { clienteSlug, year, month }

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year);
  const month = Number(body.month);
  if (!clienteSlug || !year || !month) {
    return new Response("missing params", { status: 400 });
  }

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

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
      .range(from, from + 999);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    const batch = (data ?? []) as any[];
    all.push(...batch);
    if (batch.length < 1000) break;
    from += 1000;
  }

  // Analizar consecutivos
  const consecutivos: number[] = [];
  const conConsecutivo: any[] = [];
  const sinConsecutivo: any[] = [];
  const fechas: Record<string, number> = {};

  for (const ev of all) {
    const p = ev.payload ?? {};
    const c = p.consecutivo;
    if (typeof c === "number" && c > 0) {
      consecutivos.push(c);
      conConsecutivo.push(ev);
    } else {
      sinConsecutivo.push(ev);
    }
    const f = String(p.fecha ?? "").slice(0, 10);
    if (f) fechas[f] = (fechas[f] ?? 0) + 1;
  }

  consecutivos.sort((a, b) => a - b);
  const minC = consecutivos[0];
  const maxC = consecutivos[consecutivos.length - 1];

  // Detectar huecos en consecutivos
  const huecos: Array<{ desde: number; hasta: number; faltan: number }> = [];
  if (consecutivos.length > 1) {
    for (let i = 1; i < consecutivos.length; i++) {
      const prev = consecutivos[i - 1];
      const curr = consecutivos[i];
      if (curr - prev > 1) {
        huecos.push({ desde: prev + 1, hasta: curr - 1, faltan: curr - prev - 1 });
      }
    }
  }

  // Sample 3 events
  const sample = all.slice(0, 3).map((e) => ({
    keys: Object.keys(e.payload ?? {}),
    payload: e.payload,
  }));

  // Fechas con > 100 facturas
  const fechasHot = Object.entries(fechas)
    .filter(([, n]) => n > 50)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // Día con más y menos
  const dias = Object.entries(fechas).sort((a, b) => a[0].localeCompare(b[0]));

  return new Response(
    JSON.stringify(
      {
        cliente: clienteSlug,
        year,
        month,
        total_events: all.length,
        con_consecutivo: conConsecutivo.length,
        sin_consecutivo: sinConsecutivo.length,
        consecutivo_min: minC,
        consecutivo_max: maxC,
        consecutivo_rango: minC && maxC ? maxC - minC + 1 : null,
        huecos_consecutivos: huecos.slice(0, 30),
        total_huecos: huecos.length,
        total_facturas_faltantes_en_huecos: huecos.reduce((acc, h) => acc + h.faltan, 0),
        dias_con_eventos: dias.length,
        primer_dia: dias[0]?.[0],
        ultimo_dia: dias[dias.length - 1]?.[0],
        fechas_top: fechasHot,
        sample_payload_keys: sample,
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
