// netlify/functions/consolidate-descartado-labels-background.mts
//
// Consolida los 6 sub-labels Descartado/* intermedios → Descartado/Revisar.
//
// Decisión 2026-06-03: pasar de 9 labels (granulares por motivo) a 3:
//   - Descartado/Duplicado (sin cambio — son ~70% del volumen, ruido normal)
//   - Descartado/NoFactura (sin cambio — donde el LLM puede equivocarse)
//   - Descartado/Revisar (nuevo — agrupa los otros 6 motivos para auditoría mensual)
//
// Labels a consolidar (todos van a Revisar):
//   - Descartado/PlanillaSS-Tercero
//   - Descartado/NotaCredito
//   - Descartado/Invalida
//   - Descartado/NoProcesable
//   - Descartado/AutoEmitida
//   - Descartado/AnioAnterior
//   - Descartado/Otro
//
// Lógica: lista emails con cada label viejo, les agrega Revisar y les remueve
// el label viejo. Idempotente: si re-corre, los ya consolidados no cambian.
//
// Body: { clienteSlug, dryRun?: boolean (default true) }
//
// Background function (sufijo -background) → 15 min timeout.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const LABELS_VIEJOS = [
  "Descartado/PlanillaSS-Tercero",
  "Descartado/NotaCredito",
  "Descartado/Invalida",
  "Descartado/NoProcesable",
  "Descartado/AutoEmitida",
  "Descartado/AnioAnterior",
  "Descartado/Otro",
];
const LABEL_NUEVO = "Descartado/Revisar";

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
  const dryRun = body.dryRun !== false; // default TRUE
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

  // Resolver labels
  const labelNuevoId = await getOrCreateLabel(gmail, LABEL_NUEVO);

  const stats: any = {
    cliente: clienteSlug,
    dryRun,
    por_label_viejo: {} as Record<string, { found: number; migrados: number; errores: number }>,
    total_migrados: 0,
    total_errores: 0,
  };
  const sampleErrors: Array<{ messageId: string; label: string; error: string }> = [];

  for (const labelViejo of LABELS_VIEJOS) {
    const labelViejoId = await findLabelId(gmail, labelViejo);
    if (!labelViejoId) {
      stats.por_label_viejo[labelViejo] = { found: 0, migrados: 0, errores: 0 };
      continue;
    }
    const messageIds = await listMessageIdsWithLabel(gmail, labelViejoId);
    const entry = { found: messageIds.length, migrados: 0, errores: 0 };
    stats.por_label_viejo[labelViejo] = entry;

    if (dryRun) continue;

    for (const mid of messageIds) {
      try {
        await gmail.users.messages.modify({
          userId: "me",
          id: mid,
          requestBody: {
            addLabelIds: [labelNuevoId],
            removeLabelIds: [labelViejoId],
          },
        });
        entry.migrados++;
        stats.total_migrados++;
      } catch (e: any) {
        entry.errores++;
        stats.total_errores++;
        if (sampleErrors.length < 10) {
          sampleErrors.push({ messageId: mid, label: labelViejo, error: e.message });
        }
      }
    }
  }

  return new Response(
    JSON.stringify({ ok: true, ...stats, sampleErrors: sampleErrors.length ? sampleErrors : undefined }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
