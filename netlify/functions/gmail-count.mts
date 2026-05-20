// netlify/functions/gmail-count.mts
//
// Cuenta correos Gmail que matchean un query, paginando.
// Body: { clienteSlug: string, query?: string, year: number, month: number }
//
// Devuelve:
//   - total: número de correos
//   - sample_subjects: muestra de 10 subjects
//   - daily_counts: cuántos correos por día

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

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
  const customQuery: string | undefined = body.query;

  if (!clienteSlug || !year || !month) {
    return new Response("missing clienteSlug | year | month", { status: 400 });
  }

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const cred = await loadCredentials((cli as any).id, "facturacion");
  if (!cred?.google_refresh_token) {
    return new Response("missing google refresh_token", { status: 400 });
  }

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const gmail = google.gmail({ version: "v1", auth });

  const mm = String(month).padStart(2, "0");
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nmm = String(nextMonth).padStart(2, "0");

  const dateFilter = `after:${year}/${mm}/01 before:${nextYear}/${nmm}/01`;

  const queries: Array<{ name: string; q: string }> = customQuery
    ? [{ name: "custom", q: customQuery }]
    : [
        {
          name: "todos_attachment",
          q: `(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante) ${dateFilter}`,
        },
        {
          name: "todos_attachment_procesado",
          q: `(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante) label:Procesado ${dateFilter}`,
        },
        {
          name: "todos_attachment_no_procesado",
          q: `(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante) -label:Procesado ${dateFilter}`,
        },
        {
          name: "zip_dian_only",
          q: `filename:zip ${dateFilter}`,
        },
      ];

  const results: Record<string, any> = {};
  for (const { name, q } of queries) {
    const allIds: string[] = [];
    let pageToken: string | undefined = undefined;
    let pages = 0;
    do {
      const res: any = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 500,
        pageToken,
      });
      const msgs = res.data.messages ?? [];
      allIds.push(...msgs.map((m: any) => m.id));
      pageToken = res.data.nextPageToken;
      pages++;
      if (pages > 50) break;
    } while (pageToken);

    results[name] = {
      query: q,
      total: allIds.length,
      pages,
    };
  }

  // Para el query principal, obtener fechas
  const mainQuery = customQuery
    ? customQuery
    : `(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante) ${dateFilter}`;

  // Para evitar timeout, solo hacer "muestra" de fechas con los primeros 200
  const sampleRes: any = await gmail.users.messages.list({ userId: "me", q: mainQuery, maxResults: 200 });
  const sampleMsgs = (sampleRes.data.messages ?? []).slice(0, 200);

  const dailyCounts: Record<string, number> = {};
  const sampleSubjects: string[] = [];

  for (let i = 0; i < Math.min(sampleMsgs.length, 50); i++) {
    const m: any = sampleMsgs[i];
    try {
      const full: any = await gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["Subject", "Date", "From"],
      });
      const dateH = (full.data.payload?.headers ?? []).find((h: any) => h.name === "Date")?.value ?? "";
      const subjH = (full.data.payload?.headers ?? []).find((h: any) => h.name === "Subject")?.value ?? "";
      const d = new Date(dateH);
      if (!isNaN(d.getTime())) {
        const day = d.toISOString().slice(0, 10);
        dailyCounts[day] = (dailyCounts[day] ?? 0) + 1;
      }
      if (sampleSubjects.length < 10) sampleSubjects.push(subjH);
    } catch {}
  }

  return new Response(
    JSON.stringify(
      {
        cliente: clienteSlug,
        year,
        month,
        ts: new Date().toISOString(),
        queries: results,
        sample_subjects: sampleSubjects,
        sample_daily_counts: dailyCounts,
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
