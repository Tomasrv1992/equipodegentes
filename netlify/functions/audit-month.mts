// netlify/functions/audit-month.mts
//
// Auditoria Gmail vs BD por mes:
// - Lee emails de Gmail con attachments del mes
// - Extrae NIT+numero del subject (formato DIAN: "NIT;PROVEEDOR;NUMERO;...")
// - Compara con eventos en agent_events (por numero+nit)
// - Devuelve: emails en Gmail SIN evento en BD (gap real)
//
// Body: { clienteSlug, year, month }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year);
  const month = Number(body.month);
  if (!clienteSlug || !year || !month) return new Response("missing params", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const cred = await loadCredentials((cli as any).id, "facturacion");
  if (!cred?.google_refresh_token) return new Response("no refresh_token", { status: 400 });

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const gmail = google.gmail({ version: "v1", auth });

  const mm = String(month).padStart(2, "0");
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nmm = String(nextMonth).padStart(2, "0");
  const dateFilter = `after:${year}/${mm}/01 before:${nextYear}/${nmm}/01`;
  const query = `filename:zip ${dateFilter}`;

  // Listar emails con ZIP del mes (facturas DIAN)
  const allIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });
    const msgs = res.data.messages ?? [];
    allIds.push(...msgs.map((m: any) => m.id));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Obtener subject de cada uno + extraer NIT+numero
  const facturasGmail: Array<{ msgId: string; nit: string; numero: string; subject: string }> = [];
  for (const id of allIds.slice(0, 500)) { // límite para no timeout
    try {
      const full: any = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Subject"],
      });
      const subj = (full.data.payload?.headers ?? []).find((h: any) => h.name === "Subject")?.value ?? "";
      // Formato DIAN: "NIT;PROVEEDOR;NUMERO;..." (puede tener "Fwd:" prefix)
      const cleaned = subj.replace(/^(Fwd:|RE:|FW:)\s*/i, "").trim();
      const parts = cleaned.split(";");
      const nit = (parts[0] ?? "").replace(/\D+/g, "");
      const numero = (parts[2] ?? "").trim();
      facturasGmail.push({ msgId: id, nit, numero, subject: subj.slice(0, 80) });
    } catch {}
  }

  // Eventos en BD del cliente para este mes
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${nextYear}-${nmm}-01`;
  const eventosBd = new Set<string>();
  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("payload")
      .eq("cliente_id", (cli as any).id)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", monthStart)
      .lt("payload->>fecha", monthEnd)
      .range(from, from + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const nit = String(ev.payload?.nit ?? "").replace(/\D+/g, "");
      const numero = String(ev.payload?.numero ?? "").trim();
      if (nit && numero) eventosBd.add(`${nit}|${numero}`);
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // Comparar: Gmail vs BD
  const enGmailNoBd: typeof facturasGmail = [];
  for (const f of facturasGmail) {
    if (!f.nit || !f.numero) continue; // Skip si no se extrajo bien
    if (!eventosBd.has(`${f.nit}|${f.numero}`)) {
      enGmailNoBd.push(f);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      cliente: clienteSlug,
      year,
      month,
      gmail_total_zips: allIds.length,
      gmail_subjects_extraidos: facturasGmail.length,
      eventos_bd: eventosBd.size,
      gap_en_gmail_no_bd: enGmailNoBd.length,
      muestra_gap: enGmailNoBd.slice(0, 30),
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
