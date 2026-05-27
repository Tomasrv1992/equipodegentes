// Endpoint diagnostico: lista events que matchean un patron de busqueda
// Body: { clienteSlug, year, month, patterns: { proveedor_contains?, numero_equals? }[] }

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year);
  const month = Number(body.month);
  const patterns: Array<{ proveedor_contains?: string; numero_equals?: string }> = body.patterns ?? [];
  if (!clienteSlug || !year || !month) return new Response("missing params", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const matches: any[] = [];
  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("id, payload")
      .eq("cliente_id", (cli as any).id)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", monthStart)
      .lt("payload->>fecha", monthEnd)
      .range(from, from + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const p = ev.payload ?? {};
      for (const pat of patterns) {
        let match = true;
        if (pat.proveedor_contains) {
          if (!String(p.proveedor ?? "").toLowerCase().includes(pat.proveedor_contains.toLowerCase())) {
            match = false;
          }
        }
        if (pat.numero_equals) {
          if (String(p.numero ?? "") !== pat.numero_equals) match = false;
        }
        if (match) {
          matches.push({
            event_id: ev.id,
            numero: p.numero,
            proveedor: p.proveedor,
            fecha: p.fecha,
            tipo: p.tipo,
            concepto: p.concepto,
            nit: p.nit,
          });
          break;
        }
      }
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      cliente: clienteSlug,
      year,
      month,
      patterns_used: patterns,
      total_matches: matches.length,
      matches,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
