// netlify/functions/gmail-remove-label.mts
//
// Endpoint sÍncrono que remueve un label de TODOS los mensajes Gmail que
// matchean una query. Útil para revertir el estado de emails marcados como
// "Procesado" cuando hay que reprocesar.
//
// Caso de uso real 2026-05-19: 564 facturas DIAN enero quedaron con label
// "Procesado" en Gmail (procesadas por el sitio viejo consultoria-ea) pero
// NUNCA escribieron a agent_events de Supabase. Para que el pipeline nuevo
// las re-procese, hay que quitar "Procesado" de TODOS los emails enero
// (el isDuplicate del pipeline va a saltar los 1088 ya en sheet).
//
// Body: { clienteSlug: string, query: string, label: string }
//   query: query Gmail (ej: "after:2026/01/01 before:2026/02/01")
//   label: nombre del label a remover (ej: "Procesado")
// Auth: x-internal-secret

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

interface RequestBody {
  clienteSlug: string;
  query: string;
  label: string;
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
  const query = body.query?.trim();
  const labelName = body.label?.trim();
  if (!clienteSlug || !query || !labelName) {
    return new Response("missing clienteSlug | query | label", { status: 400 });
  }

  const supa = getServerClient();
  const { data: cli } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", clienteSlug)
    .single();
  if (!cli) return new Response(`cliente "${clienteSlug}" not found`, { status: 404 });

  const cred = await loadCredentials((cli as any).id, "facturacion");
  if (!cred?.google_refresh_token) {
    return new Response("missing google_refresh_token", { status: 400 });
  }

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const gmail = google.gmail({ version: "v1", auth });

  try {
    // Resolver labelId desde el nombre
    const labelsResp = await gmail.users.labels.list({ userId: "me" });
    const lbl = (labelsResp.data.labels ?? []).find((l: any) => l.name === labelName);
    if (!lbl?.id) {
      return new Response(
        JSON.stringify({ ok: false, error: `label "${labelName}" no encontrado` }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    const labelId = lbl.id;

    // Buscar todos los mensajes que matchean la query.
    // Importante: incluir el label en la query para asegurar que solo modificamos
    // los que actualmente lo tienen (idempotencia).
    const fullQuery = `${query} label:${labelName}`;
    const messageIds: string[] = [];
    let pageToken: string | undefined;
    do {
      const resp = await gmail.users.messages.list({
        userId: "me",
        q: fullQuery,
        maxResults: 500,
        pageToken,
      });
      for (const m of resp.data.messages ?? []) {
        if (m.id) messageIds.push(m.id);
      }
      pageToken = resp.data.nextPageToken ?? undefined;
    } while (pageToken);

    if (messageIds.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, total: 0, modified: 0, message: "sin emails matching" }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // batchModify acepta hasta 1000 ids por request
    const BATCH = 1000;
    let modified = 0;
    for (let i = 0; i < messageIds.length; i += BATCH) {
      const batch = messageIds.slice(i, i + BATCH);
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: batch,
          removeLabelIds: [labelId],
        },
      });
      modified += batch.length;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        cliente: clienteSlug,
        query: fullQuery,
        label_removido: labelName,
        total_matched: messageIds.length,
        modified,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const config: Config = {};
