// netlify/functions/compare-gmail-bd.mts
//
// Compara, día por día, el conteo de emails en Gmail vs events en BD
// para identificar los días con gap. Devuelve lista de días con su delta.
//
// Body: { clienteSlug, year, month }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year);
  const month = Number(body.month);
  if (!clienteSlug || !year || !month) return new Response("missing params", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  // 1. Conteo Gmail por día (1 query por día, max 31 queries)
  const cred = await loadCredentials(clienteId, "facturacion");
  if (!cred?.google_refresh_token) return new Response("no refresh_token", { status: 400 });

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const gmail = google.gmail({ version: "v1", auth });

  const daysInMonth = new Date(year, month, 0).getDate();
  const days: Array<{
    day: number;
    gmail_count: number;
    bd_count: number;
    delta: number;
  }> = [];

  // 2. Conteo BD por día (1 sola query con ->>fecha)
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const bdByDay: Record<string, number> = {};
  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("payload->fecha")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", monthStart)
      .lt("payload->>fecha", monthEnd)
      .range(from, from + 999);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    const batch = (data ?? []) as any[];
    for (const e of batch) {
      const f = String(e.fecha ?? "").slice(0, 10);
      if (f) bdByDay[f] = (bdByDay[f] ?? 0) + 1;
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // 3. Gmail por día — 31 queries (cada una pagina)
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    const next = new Date(year, month - 1, d + 1);
    const nyy = next.getFullYear();
    const nmm = String(next.getMonth() + 1).padStart(2, "0");
    const ndd = String(next.getDate()).padStart(2, "0");
    const q = `(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante) after:${year}/${mm}/${dd} before:${nyy}/${nmm}/${ndd}`;

    let total = 0;
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res: any = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 500,
        pageToken,
      });
      const msgs = res.data.messages ?? [];
      total += msgs.length;
      pageToken = res.data.nextPageToken;
      pages++;
      if (pages > 20) break;
    } while (pageToken);

    const dateKey = `${year}-${mm}-${dd}`;
    const bd = bdByDay[dateKey] ?? 0;
    days.push({
      day: d,
      gmail_count: total,
      bd_count: bd,
      delta: total - bd,
    });
  }

  const totalGmail = days.reduce((a, d) => a + d.gmail_count, 0);
  const totalBd = days.reduce((a, d) => a + d.bd_count, 0);
  const diasConGap = days.filter((d) => d.delta > 0);
  const totalGap = diasConGap.reduce((a, d) => a + d.delta, 0);

  return new Response(
    JSON.stringify(
      {
        cliente: clienteSlug,
        year,
        month,
        total_gmail: totalGmail,
        total_bd: totalBd,
        total_gap: totalGap,
        dias_con_gap: diasConGap.length,
        days,
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
