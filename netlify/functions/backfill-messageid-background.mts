// netlify/functions/backfill-messageid-background.mts
//
// Backfill histórico: asigna messageId a events factura_procesada que YA
// existen sin ese campo. Prerrequisito de reconcile-labels — sin esto,
// reconcile sobre histórico inverte facturas válidas a Descartado.
//
// Estrategia (corregida 2026-06-09):
// 1. Listar emails de Facturas/year ∪ Descartado/year (NO solo Facturas — sino
//    no recupera los Protokimicas que quedaron solo en Descartado).
// 2. Para cada candidato: parsear (numero, nit) del subject DIAN típico.
// 3. Match contra events sin messageId por (numero, nit) AMBOS NORMALIZADOS
//    con nitMatch tolerante a DV (Dígito de Verificación).
// 4. dryRun reporta matches + near-misses (subjects que no parsearon o que
//    matchearon numero pero no nit) — diagnóstico de normalización.
// 5. dryRun=false aplica via RPC set_event_message_id (idempotente).
//
// Body: { clienteSlug, year, dryRun?: true (default) }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";
import { getAllEventsByYear } from "../../shared/agents-runtime/src/agent-events";

// === Helpers de normalización + match tolerante ===
// CRÍTICO: NO asumir que todo NIT 10 dígitos es "9+DV". Las cédulas de personas
// naturales (freelancers Jeisy, Tatiana, etc) son 10 dígitos SIN DV. Truncarlas
// rompe el match con los events.
function digitsOnly(s: string): string {
  return String(s ?? "").replace(/\D+/g, "");
}

function nitMatch(a: string, b: string): boolean {
  // Compara tolerante a presencia del DV en cualquier lado, sin asumir longitud.
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da === db.slice(0, -1)) return true;   // b trae DV, a no
  if (db === da.slice(0, -1)) return true;   // a trae DV, b no
  return false;
}

function normalizeNumero(numero: string): string {
  return String(numero ?? "").trim().toUpperCase().replace(/^0+(?=\d)/, "");
}

function numeroMatch(a: string, b: string): boolean {
  return normalizeNumero(a) === normalizeNumero(b);
}

function stripFwdPrefix(subject: string): string {
  // Quitar Fwd:/RV:/Re:/Fw: (incluso apilados como "Fwd: RV: ...")
  return subject.replace(/^(\s*(fwd|rv|re|fw)\s*:\s*)+/i, "").trim();
}

function parseDianSubject(subject: string): { numero: string; nit: string } | null {
  const cleaned = stripFwdPrefix(subject);
  // Formato típico DIAN: "901117356;PROVEEDOR S.A;FE12345;01;PROVEEDOR" o variantes
  const parts = cleaned.split(";").map(s => s.trim());
  if (parts.length < 3) return null;
  const nit = parts[0];
  const numero = parts[2];
  if (!/^\d{6,11}$/.test(nit)) return null;  // NIT colombiano: 6-11 dígitos
  if (!numero) return null;
  return { nit, numero };
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
  const year = Number(body.year) || new Date().getFullYear();
  const dryRun = body.dryRun !== false;  // default TRUE
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

  // 1. PAGINAR todos los events factura_procesada del año
  const events = await getAllEventsByYear(clienteId, "factura_procesada", year);
  const sinMessageId = events.filter((e) => !e.payload?.messageId);

  // 2. Listar emails de AMBOS labels (Facturas ∪ Descartado) — CRÍTICO
  const facturasId = await findLabelId(gmail, `Facturas/${year}`);
  const descartadoId = await findLabelId(gmail, `Descartado/${year}`);
  if (!facturasId || !descartadoId) {
    return new Response(
      JSON.stringify({ ok: false, error: `Labels Facturas/${year} o Descartado/${year} no existen` }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const facturasMsgs = await listMessageIdsWithLabel(gmail, facturasId);
  const descartadoMsgs = await listMessageIdsWithLabel(gmail, descartadoId);
  const candidatos = [...new Set([...facturasMsgs, ...descartadoMsgs])];

  // 3. Para cada candidato: parsear + match
  const matches: Array<{ eventId: string; messageId: string; subject: string; parsedNumero: string; parsedNit: string }> = [];
  const nearMisses: Array<{ messageId: string; subject: string; parsedNumero?: string; parsedNit?: string; reason: string }> = [];

  for (const mid of candidatos) {
    let subject = "";
    try {
      const meta = await gmail.users.messages.get({
        userId: "me",
        id: mid,
        format: "metadata",
        metadataHeaders: ["Subject"],
      });
      subject = (meta.data.payload?.headers ?? []).find((h: any) => h.name === "Subject")?.value ?? "";
    } catch (e: any) {
      nearMisses.push({ messageId: mid, subject: `<get-failed: ${e.message}>`, reason: "gmail-get-failed" });
      continue;
    }
    const parsed = parseDianSubject(subject);
    if (!parsed) {
      nearMisses.push({
        messageId: mid,
        subject: subject.slice(0, 120),
        reason: "no-dian-format",
      });
      continue;
    }

    // MATCH POR (numero, nit) AMBOS TOLERANTES
    const event = sinMessageId.find((e) =>
      numeroMatch(e.payload.numero, parsed.numero) &&
      nitMatch(e.payload.nit, parsed.nit)
    );
    if (!event) {
      const numOnlyMatch = sinMessageId.find((e) => numeroMatch(e.payload.numero, parsed.numero));
      nearMisses.push({
        messageId: mid,
        subject: subject.slice(0, 120),
        parsedNumero: parsed.numero,
        parsedNit: parsed.nit,
        reason: numOnlyMatch
          ? `numero-match-pero-nit-distinto (event nit: ${numOnlyMatch.payload.nit}, parsed: ${parsed.nit})`
          : "no-event-match",
      });
      continue;
    }

    matches.push({
      eventId: event.id,
      messageId: mid,
      subject: subject.slice(0, 120),
      parsedNumero: parsed.numero,
      parsedNit: parsed.nit,
    });
  }

  // 4. dryRun → reporte completo
  if (dryRun) {
    // FIX 2026-06-11: como este endpoint es -background, Netlify NO devuelve el body
    // al cliente curl. Guardamos el reporte en reconcile_dumps para que un endpoint
    // sync (inspect-backfill-report) lo lea después. Usamos `kind` en before_state
    // para distinguir backfill reports de reconcile dumps.
    const crypto = await import("node:crypto");
    const reportId = crypto.randomUUID();
    const report = {
      kind: "backfill_dryrun_report",
      ok: true,
      dryRun: true,
      cliente: clienteSlug,
      year,
      total_candidatos: candidatos.length,
      total_events_sin_messageid: sinMessageId.length,
      matches_count: matches.length,
      sample_matches: matches.slice(0, 30),
      near_misses_count: nearMisses.length,
      sample_near_misses: nearMisses.slice(0, 30),
      cobertura_porcentaje: sinMessageId.length
        ? Math.round((matches.length / sinMessageId.length) * 100)
        : 0,
      timestamp: new Date().toISOString(),
    };
    try {
      await supa.from("reconcile_dumps").insert({
        id: reportId,
        cliente_id: clienteId,
        year,
        before_state: report,
      });
      console.log(`[backfill] dryRun report saved id=${reportId}`);
    } catch (e: any) {
      console.error(`[backfill] no pude guardar report: ${e.message}`);
    }
    return new Response(
      JSON.stringify(report, null, 2),
      { headers: { "content-type": "application/json" } },
    );
  }

  // 5. dryRun=false → UPDATE events via RPC
  let okCount = 0;
  let errCount = 0;
  for (const { eventId, messageId } of matches) {
    const { error } = await supa.rpc("set_event_message_id", {
      p_event_id: eventId,
      p_message_id: messageId,
    });
    if (error) errCount++;
    else okCount++;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      dryRun: false,
      cliente: clienteSlug,
      year,
      matches_applied: okCount,
      errors: errCount,
      total_events_sin_messageid: sinMessageId.length,
      near_misses_count: nearMisses.length,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
