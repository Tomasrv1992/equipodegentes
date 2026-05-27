// netlify/functions/inspect-descartes.mts
//
// Reporte numérico de descartes por mes/motivo para un cliente.
// Sirve para cuadrar la auditoría: Gmail-label ≈ Sheet + Descartes.
//
// Body: { clienteSlug, year? }
//
// Respuesta:
//   {
//     cliente: "dentilandia",
//     year: 2026,
//     total_descartes: 109,
//     por_mes: [
//       { mes: "2026-01", total: 6, por_motivo: { "planilla-ss-tercero": 4, ... } },
//       ...
//     ],
//     top_motivos: [ { motivo: "...", count: N }, ... ],
//   }

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || new Date().getFullYear();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  // 1. Leer descartes del año
  const yearStart = `${year}-01-01T00:00:00Z`;
  const yearEnd = `${year + 1}-01-01T00:00:00Z`;

  // Agrupar por (mes, motivo). Dedupe por messageId — si un email se descartó
  // varias veces (re-runs), solo cuenta una vez.
  const seenMessages = new Set<string>();
  // mesKey -> motivo -> count
  const porMesMotivo = new Map<string, Map<string, number>>();
  const motivoGlobal = new Map<string, number>();
  let totalUnicos = 0;
  let totalEventsLeidos = 0;

  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("payload")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "email_descartado")
      .gte("created_at", yearStart)
      .lt("created_at", yearEnd)
      .range(from, from + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    totalEventsLeidos += batch.length;
    for (const ev of batch) {
      const p = ev.payload ?? {};
      const messageId = String(p.messageId ?? "");
      if (!messageId || seenMessages.has(messageId)) continue;
      seenMessages.add(messageId);
      totalUnicos++;

      const motivo = String(p.motivo ?? "sin-motivo");
      const mes = String(p.mes ?? "sin-mes");

      // mes/motivo bucket
      if (!porMesMotivo.has(mes)) porMesMotivo.set(mes, new Map());
      const bucket = porMesMotivo.get(mes)!;
      bucket.set(motivo, (bucket.get(motivo) ?? 0) + 1);

      // motivo global
      motivoGlobal.set(motivo, (motivoGlobal.get(motivo) ?? 0) + 1);
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // 2. Tambien contar facturas procesadas por mes para cuadrar
  const facturasPorMes = new Map<string, number>();
  let fp = 0;
  while (fp < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("payload")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", `${year}-01-01`)
      .lt("payload->>fecha", `${year + 1}-01-01`)
      .range(fp, fp + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const fecha = String(ev.payload?.fecha ?? "");
      if (fecha.length >= 7) {
        const mes = fecha.slice(0, 7);
        facturasPorMes.set(mes, (facturasPorMes.get(mes) ?? 0) + 1);
      }
    }
    if (batch.length < 1000) break;
    fp += 1000;
  }

  // 3. Estructurar respuesta
  const allMeses = new Set<string>([...porMesMotivo.keys(), ...facturasPorMes.keys()]);
  const por_mes = Array.from(allMeses)
    .filter((m) => m !== "sin-mes")
    .sort()
    .map((mes) => {
      const motivos = porMesMotivo.get(mes) ?? new Map();
      const por_motivo: Record<string, number> = {};
      for (const [m, c] of motivos.entries()) por_motivo[m] = c;
      const totalDescartesMes = Array.from(motivos.values()).reduce((a, b) => a + b, 0);
      const facturasMes = facturasPorMes.get(mes) ?? 0;
      return {
        mes,
        facturas_procesadas: facturasMes,
        descartes_total: totalDescartesMes,
        cuadre_estimado_gmail: facturasMes + totalDescartesMes,
        por_motivo,
      };
    });

  // sin-mes (descartes que el pipeline no pudo derivar fecha — el cliente
  // ve la lista en la pestaña Descartes con messageId, pero acá los
  // mostramos aparte por transparencia)
  const sinMes = porMesMotivo.get("sin-mes");
  const sin_mes_total = sinMes ? Array.from(sinMes.values()).reduce((a, b) => a + b, 0) : 0;

  const top_motivos = Array.from(motivoGlobal.entries())
    .map(([motivo, count]) => ({ motivo, count }))
    .sort((a, b) => b.count - a.count);

  return new Response(
    JSON.stringify({
      ok: true,
      cliente: clienteSlug,
      year,
      total_descartes_unicos: totalUnicos,
      total_events_leidos: totalEventsLeidos,
      sin_mes: sin_mes_total,
      por_mes,
      top_motivos,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
