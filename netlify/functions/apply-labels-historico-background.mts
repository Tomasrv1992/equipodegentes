// netlify/functions/apply-labels-historico.mts
//
// Re-etiqueta histórico de emails descartados Gmail con los NUEVOS labels
// granulares (Descartado/MOTIVO + archivar). Lee los events
// `email_descartado` de agent_events para un cliente, y por cada uno:
//   1. Mapea el motivo a sub-label `Descartado/X` (mismo mapeo del pipeline)
//   2. Aplica el sub-label al email en Gmail + remueve INBOX
//   3. (Opcional) Remueve label `Procesado` viejo
//
// 404 de Gmail (email borrado por el usuario) NO es fatal — se loguea y sigue.
//
// Body:
//   - clienteSlug (required)
//   - dryRun (boolean, default true): si true, no llama Gmail, solo reporta
//   - removeProcesadoLegacy (boolean, default false): si true, también remueve
//     el label viejo `Procesado` después de aplicar el nuevo

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

// Mismo mapeo que pipeline.ts → mapMotivoToLabel.
// (Duplicado intencional: el endpoint no debe depender del bundle del pipeline
// para no arrastrar googleapis-heavy imports innecesarios.)
// Solo 3 sub-labels (decisión 2026-06-03):
//   Descartado/Duplicado / Descartado/NoFactura / Descartado/Revisar
function mapMotivoToLabel(motivo: string): string {
  const m = String(motivo ?? "").toLowerCase();
  if (m.startsWith("dup")) return "Descartado/Duplicado";
  if (
    m.includes("pdf-no-es-factura") ||
    m.includes("docx-no-es-factura") ||
    m.startsWith("pre-filter")
  ) return "Descartado/NoFactura";
  return "Descartado/Revisar";
}

async function getOrCreateLabelCached(
  gmail: any,
  name: string,
  cache: Map<string, string>,
): Promise<string> {
  if (cache.has(name)) return cache.get(name)!;
  const list = await gmail.users.labels.list({ userId: "me" });
  const found = list.data.labels?.find((l: any) => l.name === name);
  if (found?.id) {
    cache.set(name, found.id);
    return found.id;
  }
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  const id = created.data.id!;
  cache.set(name, id);
  return id;
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const dryRun = body.dryRun !== false; // default TRUE — más seguro
  const removeProcesadoLegacy = body.removeProcesadoLegacy === true;
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

  // Pre-resolve label Procesado (para removerlo si removeProcesadoLegacy=true)
  let procesadoLabelId: string | null = null;
  if (removeProcesadoLegacy && !dryRun) {
    try {
      const list = await gmail.users.labels.list({ userId: "me" });
      procesadoLabelId = list.data.labels?.find((l: any) => l.name === "Procesado")?.id ?? null;
    } catch (e: any) {
      console.warn(`[apply-labels-historico] no pude listar labels para Procesado: ${e.message}`);
    }
  }

  // Cache labels nuevos
  const labelCache = new Map<string, string>();

  // Counters
  const stats = {
    descartes_leidos: 0,
    aplicados: 0,
    saltados_sin_messageid: 0,
    saltados_404: 0,
    errores: 0,
    por_label: {} as Record<string, number>,
  };
  const sampleErrors: Array<{ messageId: string; error: string }> = [];
  const dryRunPreview: Array<{ messageId: string; motivo: string; label: string }> = [];

  // Lee events descartado paginado
  let from = 0;
  const seenMessages = new Set<string>();
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("payload")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "email_descartado")
      .range(from, from + 999);
    if (error) {
      console.error(`[apply-labels-historico] query failed: ${error.message}`);
      break;
    }
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      stats.descartes_leidos++;
      const p = ev.payload ?? {};
      const messageId = String(p.messageId ?? "");
      if (!messageId) {
        stats.saltados_sin_messageid++;
        continue;
      }
      if (seenMessages.has(messageId)) continue; // dedupe por messageId
      seenMessages.add(messageId);

      const motivo = String(p.motivo ?? "sin-motivo");
      const labelName = mapMotivoToLabel(motivo);
      stats.por_label[labelName] = (stats.por_label[labelName] ?? 0) + 1;

      if (dryRun) {
        if (dryRunPreview.length < 50) {
          dryRunPreview.push({ messageId, motivo, label: labelName });
        }
        continue;
      }

      // Real: aplicar label + remover INBOX (+ Procesado opcional)
      try {
        const labelId = await getOrCreateLabelCached(gmail, labelName, labelCache);
        const removeIds: string[] = ["INBOX"];
        if (removeProcesadoLegacy && procesadoLabelId) removeIds.push(procesadoLabelId);
        await gmail.users.messages.modify({
          userId: "me",
          id: messageId,
          requestBody: {
            addLabelIds: [labelId],
            removeLabelIds: removeIds,
          },
        });
        stats.aplicados++;
      } catch (e: any) {
        const code = e?.code ?? e?.response?.status;
        if (code === 404) {
          stats.saltados_404++;
        } else {
          stats.errores++;
          if (sampleErrors.length < 10) sampleErrors.push({ messageId, error: e.message });
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
      dryRun,
      removeProcesadoLegacy,
      stats,
      sampleErrors: sampleErrors.length ? sampleErrors : undefined,
      dryRunPreview: dryRun ? dryRunPreview : undefined,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
