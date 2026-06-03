// netlify/functions/consolidate-todos-labels-background.mts
//
// Consolida TODOS los labels Gmail viejos a los 2 finales:
//   - Facturas/2026-01..12 (12 labels)  → Facturas/2026
//   - Descartado/Duplicado, NoFactura, Revisar, PlanillaSS-Tercero, NotaCredito,
//     Invalida, NoProcesable, AutoEmitida, AnioAnterior, Otro (10 labels) → Descartado/2026
//   - Remueve label `Procesado` de cada email que ya tenga Facturas/2026 o Descartado/2026
//
// Decisión 2026-06-03: simplificar Gmail al máximo. 2 labels por año.
// El motivo específico de descarte queda en la pestaña Descartes del Sheet.
//
// Body: { clienteSlug, year? (default 2026), dryRun? (default true) }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const FACTURAS_MONTHS_LABELS = (year: number) =>
  Array.from({ length: 12 }, (_, i) => `Facturas/${year}-${String(i + 1).padStart(2, "0")}`);

const DESCARTADO_SUB_LABELS = [
  "Descartado/Duplicado",
  "Descartado/NoFactura",
  "Descartado/Revisar",
  "Descartado/PlanillaSS-Tercero",
  "Descartado/NotaCredito",
  "Descartado/Invalida",
  "Descartado/NoProcesable",
  "Descartado/AutoEmitida",
  "Descartado/AnioAnterior",
  "Descartado/Otro",
];

async function getOrCreateLabel(gmail: any, name: string): Promise<string> {
  const list = await gmail.users.labels.list({ userId: "me" });
  const found = list.data.labels?.find((l: any) => l.name === name);
  if (found?.id) return found.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id!;
}

async function findLabelId(gmail: any, name: string): Promise<string | null> {
  const list = await gmail.users.labels.list({ userId: "me" });
  return list.data.labels?.find((l: any) => l.name === name)?.id ?? null;
}

async function listMessageIdsWithLabel(gmail: any, labelId: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res: any = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: 500,
      pageToken,
    });
    const batch = res.data.messages ?? [];
    out.push(...batch.map((m: any) => m.id as string));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || 2026;
  const dryRun = body.dryRun !== false;
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const cred = await loadCredentials(clienteId, "facturacion");
  if (!cred?.google_refresh_token) return new Response("missing creds", { status: 400 });

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const gmail = google.gmail({ version: "v1", auth });

  // 1. Resolver labels destino (crear si no existen)
  const facturasYearLabelId = await getOrCreateLabel(gmail, `Facturas/${year}`);
  const descartadoYearLabelId = await getOrCreateLabel(gmail, `Descartado/${year}`);
  const procesadoLabelId = await findLabelId(gmail, "Procesado");

  const stats: any = {
    cliente: clienteSlug,
    year,
    dryRun,
    facturas_consolidados: {} as Record<string, number>,
    descartado_consolidados: {} as Record<string, number>,
    procesado_removed: 0,
    errores: 0,
  };

  // 2. Migrar Facturas/YYYY-MM → Facturas/YYYY
  for (const labelMonth of FACTURAS_MONTHS_LABELS(year)) {
    const labelMonthId = await findLabelId(gmail, labelMonth);
    if (!labelMonthId) {
      stats.facturas_consolidados[labelMonth] = 0;
      continue;
    }
    const messageIds = await listMessageIdsWithLabel(gmail, labelMonthId);
    stats.facturas_consolidados[labelMonth] = messageIds.length;
    if (dryRun) continue;

    for (const mid of messageIds) {
      try {
        const removeIds = [labelMonthId];
        if (procesadoLabelId) removeIds.push(procesadoLabelId);
        await gmail.users.messages.modify({
          userId: "me",
          id: mid,
          requestBody: {
            addLabelIds: [facturasYearLabelId],
            removeLabelIds: removeIds,
          },
        });
        if (procesadoLabelId) stats.procesado_removed++;
      } catch (e: any) {
        stats.errores++;
      }
    }
  }

  // 3. Migrar Descartado/* → Descartado/YYYY
  for (const labelSub of DESCARTADO_SUB_LABELS) {
    const labelSubId = await findLabelId(gmail, labelSub);
    if (!labelSubId) {
      stats.descartado_consolidados[labelSub] = 0;
      continue;
    }
    const messageIds = await listMessageIdsWithLabel(gmail, labelSubId);
    stats.descartado_consolidados[labelSub] = messageIds.length;
    if (dryRun) continue;

    for (const mid of messageIds) {
      try {
        const removeIds = [labelSubId];
        if (procesadoLabelId) removeIds.push(procesadoLabelId);
        await gmail.users.messages.modify({
          userId: "me",
          id: mid,
          requestBody: {
            addLabelIds: [descartadoYearLabelId],
            removeLabelIds: removeIds,
          },
        });
        if (procesadoLabelId) stats.procesado_removed++;
      } catch (e: any) {
        stats.errores++;
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, ...stats }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
