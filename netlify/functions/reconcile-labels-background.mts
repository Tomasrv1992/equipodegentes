// netlify/functions/reconcile-labels-background.mts
//
// Reconciliador determinístico de labels Gmail Facturas/year vs Descartado/year.
// Reemplaza los 3 endpoints de migración heurísticos (apply-labels-historico,
// consolidate-todos-labels, fix-descartado-overlap) — causa raíz del 1-mes
// de parches.
//
// Lógica:
// 1. Lee events factura_procesada + email_descartado del año → arma sets
//    de messageIds que SON factura vs SON descarte.
// 2. Lista emails Gmail con label Facturas/year ∪ Descartado/year → arma
//    sets de membresía (NO N+1 GET por email).
// 3. Para cada email: aplica función pura `decide()` con guarda de precedencia.
// 4. dryRun=true: reporta fixes sin aplicar.
// 5. dryRun=false: dump before-state a tabla reconcile_dumps (rollback),
//    después aplica con batchModify-friendly (50 paralelos).
//
// Body: { clienteSlug, year, dryRun?: true (default) }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";
import { getAllEventsByYear } from "../../shared/agents-runtime/src/agent-events";
import { decide } from "../../agentes/Equipo-facturacion/lib/reconcile-decide";
import crypto from "node:crypto";

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

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
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

  // 1. PAGINAR todos los events del año
  const procesadas = await getAllEventsByYear(clienteId, "factura_procesada", year);
  const descartados = await getAllEventsByYear(clienteId, "email_descartado", year);

  const esFactura = new Set(
    procesadas.map((e) => e.payload?.messageId).filter((m: any): m is string => Boolean(m)),
  );
  const esDescartado = new Set(
    descartados.map((e) => e.payload?.messageId).filter((m: any): m is string => Boolean(m)),
  );

  // 2. Resolver IDs labels Gmail
  const facturasId = await getOrCreateLabel(gmail, `Facturas/${year}`);
  const descartadoId = await getOrCreateLabel(gmail, `Descartado/${year}`);

  // 3. Listar emails por label → SETS DE MEMBRESÍA (NO get por email)
  const F = new Set(await listMessageIdsWithLabel(gmail, facturasId));
  const D = new Set(await listMessageIdsWithLabel(gmail, descartadoId));
  const allLabeled = new Set<string>([...F, ...D]);

  // 4. Calcular fixes usando función pura `decide`
  const fixes: Array<{ id: string; addIds: string[]; removeIds: string[]; before: string[] }> = [];
  for (const mid of allLabeled) {
    const { add, remove } = decide(mid, F, D, esFactura, esDescartado, facturasId, descartadoId);
    if (add.length === 0 && remove.length === 0) continue;
    const before = [
      ...(F.has(mid) ? [facturasId] : []),
      ...(D.has(mid) ? [descartadoId] : []),
    ];
    fixes.push({ id: mid, addIds: add, removeIds: remove, before });
  }

  // 5. dryRun → reportar fixes
  if (dryRun) {
    // Categorías para entender qué van a hacer los fixes
    const stats = {
      add_facturas: 0,
      add_descartado: 0,
      remove_facturas: 0,
      remove_descartado: 0,
    };
    for (const f of fixes) {
      if (f.addIds.includes(facturasId)) stats.add_facturas++;
      if (f.addIds.includes(descartadoId)) stats.add_descartado++;
      if (f.removeIds.includes(facturasId)) stats.remove_facturas++;
      if (f.removeIds.includes(descartadoId)) stats.remove_descartado++;
    }
    return new Response(
      JSON.stringify({
        ok: true,
        dryRun: true,
        cliente: clienteSlug,
        year,
        total_events_factura_procesada: procesadas.length,
        total_events_email_descartado: descartados.length,
        total_emails_con_messageid_en_facturas: esFactura.size,
        total_emails_con_messageid_en_descartado: esDescartado.size,
        total_gmail_facturas_label: F.size,
        total_gmail_descartado_label: D.size,
        total_fixes: fixes.length,
        stats,
        sample_fixes: fixes.slice(0, 50),
      }, null, 2),
      { headers: { "content-type": "application/json" } },
    );
  }

  // 6. dryRun=false: dump before-state + aplicar
  const dumpId = crypto.randomUUID();
  await supa.from("reconcile_dumps").insert({
    id: dumpId,
    cliente_id: clienteId,
    year,
    before_state: fixes,
  });

  // 7. Aplicar fixes en bulks (50 paralelos por bulk)
  let okCount = 0;
  let errCount = 0;
  const errors: Array<{ id: string; error: string }> = [];
  for (const batch of chunks(fixes, 50)) {
    const results = await Promise.allSettled(
      batch.map((f) =>
        gmail.users.messages.modify({
          userId: "me",
          id: f.id,
          requestBody: { addLabelIds: f.addIds, removeLabelIds: f.removeIds },
        })
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        okCount++;
      } else {
        errCount++;
        if (errors.length < 10) {
          errors.push({ id: batch[i].id, error: String(r.reason?.message ?? r.reason) });
        }
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      dryRun: false,
      cliente: clienteSlug,
      year,
      total_fixes_applied: okCount,
      errors: errCount,
      sample_errors: errors,
      dump_id: dumpId,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
