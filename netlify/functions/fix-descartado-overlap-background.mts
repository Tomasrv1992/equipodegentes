// netlify/functions/fix-descartado-overlap-background.mts
//
// Limpia el overlap entre Facturas/YYYY y Descartado/YYYY (bug 2026-06-03):
// muchos emails quedaron con AMBOS labels porque el apply-labels-historico
// los etiquetó como dup (Descartado/Duplicado) DESPUÉS de que su primer
// procesamiento exitoso ya les había aplicado Facturas/YYYY-MM.
//
// Lógica: para cada email en Descartado/{year}, si TAMBIÉN tiene Facturas/{year},
// quitarle Descartado/{year} (es factura válida que ya está en Sheet). También
// remueve label legacy "Procesado" si todavía está adherido.
//
// Body: { clienteSlug, year? (default 2026), dryRun? (default true) }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

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

  // Resolver IDs labels
  const facturasYearId = await findLabelId(gmail, `Facturas/${year}`);
  const descartadoYearId = await findLabelId(gmail, `Descartado/${year}`);
  const procesadoId = await findLabelId(gmail, "Procesado");

  if (!descartadoYearId) {
    return new Response(JSON.stringify({ ok: false, error: `Label Descartado/${year} no existe` }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (!facturasYearId) {
    return new Response(JSON.stringify({ ok: false, error: `Label Facturas/${year} no existe` }), {
      headers: { "content-type": "application/json" },
    });
  }

  // Listar todos los emails en Descartado/{year}
  const descartadoMids = await listMessageIdsWithLabel(gmail, descartadoYearId);

  const stats: any = {
    cliente: clienteSlug,
    year,
    dryRun,
    total_en_descartado: descartadoMids.length,
    overlap_con_facturas: 0,
    arreglados: 0,
    errores: 0,
    procesado_removed: 0,
  };

  // Para cada email, GET con format=metadata y revisar sus labelIds
  for (const mid of descartadoMids) {
    try {
      const msg: any = await gmail.users.messages.get({
        userId: "me",
        id: mid,
        format: "metadata",
        metadataHeaders: [],
      });
      const labelIds: string[] = msg.data.labelIds ?? [];
      const tieneFacturasYear = labelIds.includes(facturasYearId);
      const tieneProcesado = procesadoId ? labelIds.includes(procesadoId) : false;

      if (!tieneFacturasYear) {
        // Es descarte legítimo (no está en Facturas), saltar — solo limpiar Procesado si aplica
        if (tieneProcesado && !dryRun) {
          await gmail.users.messages.modify({
            userId: "me",
            id: mid,
            requestBody: { removeLabelIds: [procesadoId!] },
          });
          stats.procesado_removed++;
        }
        continue;
      }

      // OVERLAP detectado: email tiene AMBOS Facturas/{year} y Descartado/{year}
      stats.overlap_con_facturas++;

      if (dryRun) continue;

      const removeIds = [descartadoYearId];
      if (tieneProcesado && procesadoId) removeIds.push(procesadoId);

      await gmail.users.messages.modify({
        userId: "me",
        id: mid,
        requestBody: { removeLabelIds: removeIds },
      });
      stats.arreglados++;
      if (tieneProcesado) stats.procesado_removed++;
    } catch (e: any) {
      stats.errores++;
    }
  }

  return new Response(JSON.stringify({ ok: true, ...stats }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
