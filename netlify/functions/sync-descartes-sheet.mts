// netlify/functions/sync-descartes-sheet.mts
//
// Sincroniza la pestaña "Descartes" del Sheet del cliente con los events
// agent_events.tipo='email_descartado' guardados en BD.
//
// Idempotente: si la pestaña no existe, la crea; si existe, hace TRUNCATE
// (clear) + bulk write con los descartes actuales. Cada corrida deja el
// Sheet alineado con el estado en BD.
//
// Estructura de la pestaña (8 cols):
//   A. Fecha email (ISO)
//   B. Mes (YYYY-MM)
//   C. Motivo del descarte
//   D. Sender (From)
//   E. Subject
//   F. Message ID Gmail
//   G. Link Gmail (https://mail.google.com/mail/u/0/#all/{messageId})
//   H. Run ID (para trace al run que procesó el descarte)
//
// Body: { clienteSlug, year? }
//   - year: filtro opcional (default: año actual). Solo descartes del año.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const DESCARTES_TAB = "Descartes";

const HEADERS = [
  "Fecha email",
  "Mes",
  "Motivo",
  "Sender",
  "Subject",
  "Message ID",
  "Link Gmail",
  "Run ID",
];

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || new Date().getFullYear();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const cred = await loadCredentials(clienteId, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id) {
    return new Response("missing creds", { status: 400 });
  }

  // 1. Leer todos los events email_descartado del cliente del año
  const yearStart = `${year}-01-01T00:00:00Z`;
  const yearEnd = `${year + 1}-01-01T00:00:00Z`;

  const descartes: Array<{
    fechaEmail: string | null;
    mes: string | null;
    motivo: string;
    sender: string | null;
    subject: string | null;
    messageId: string;
    runId: string | null;
  }> = [];

  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("run_id, payload, created_at")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "email_descartado")
      .gte("created_at", yearStart)
      .lt("created_at", yearEnd)
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error(`[sync-descartes] query failed: ${error.message}`);
      break;
    }
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const p = ev.payload ?? {};
      descartes.push({
        fechaEmail: p.fechaEmail ?? null,
        mes: p.mes ?? null,
        motivo: String(p.motivo ?? "sin-motivo"),
        sender: p.sender ?? null,
        subject: p.subject ?? null,
        messageId: String(p.messageId ?? ""),
        runId: ev.run_id ?? null,
      });
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // Deduplicar por messageId (último gana — si el mismo email se descartó
  // en varios runs, conservamos el último motivo).
  const dedup = new Map<string, typeof descartes[0]>();
  for (const d of descartes) {
    if (d.messageId) dedup.set(d.messageId, d);
  }
  const rowsToWrite = Array.from(dedup.values()).sort((a, b) => {
    const fa = a.fechaEmail ?? "";
    const fb = b.fechaEmail ?? "";
    return fa.localeCompare(fb);
  });

  // 2. Auth Google + verificar/crear pestaña Descartes
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });

  // Buscar la pestaña
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: cred.sheet_id,
    fields: "sheets(properties(title,sheetId))",
  });
  const existing = meta.data.sheets?.find((s: any) => s.properties?.title === DESCARTES_TAB);
  let descartesSheetId: number | null | undefined = existing?.properties?.sheetId;

  if (!existing) {
    // Crear pestaña
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cred.sheet_id,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: DESCARTES_TAB,
              gridProperties: { frozenRowCount: 1, columnCount: HEADERS.length },
            },
          },
        }],
      },
    });
    descartesSheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;
  } else {
    // Limpiar contenido existente (excepto cabecera)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: cred.sheet_id,
      range: `'${DESCARTES_TAB}'!A2:H`,
    });
  }

  // 3. Escribir headers + rows
  const values: any[][] = [HEADERS];
  for (const d of rowsToWrite) {
    const fechaFmt = d.fechaEmail
      ? d.fechaEmail.slice(0, 10) // YYYY-MM-DD
      : "";
    const linkGmail = d.messageId
      ? `https://mail.google.com/mail/u/0/#all/${d.messageId}`
      : "";
    values.push([
      fechaFmt,
      d.mes ?? "",
      d.motivo,
      d.sender ?? "",
      d.subject ?? "",
      d.messageId,
      linkGmail,
      d.runId ?? "",
    ]);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: cred.sheet_id,
    range: `'${DESCARTES_TAB}'!A1:H${values.length}`,
    valueInputOption: "RAW",
    requestBody: { values },
  });

  // 4. Formato basico: header bold + auto-resize columnas (solo primera vez)
  if (descartesSheetId != null && !existing) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: cred.sheet_id,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: { sheetId: descartesSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length },
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.95, green: 0.85, blue: 0.85 },
                    horizontalAlignment: "CENTER",
                  },
                },
                fields: "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)",
              },
            },
            {
              autoResizeDimensions: {
                dimensions: {
                  sheetId: descartesSheetId,
                  dimension: "COLUMNS",
                  startIndex: 0,
                  endIndex: HEADERS.length,
                },
              },
            },
          ],
        },
      });
    } catch (e: any) {
      console.warn(`[sync-descartes] format failed (no fatal): ${e.message}`);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      cliente: clienteSlug,
      year,
      total_descartes_unicos: rowsToWrite.length,
      total_events_leidos: descartes.length,
      pestana: DESCARTES_TAB,
      creada_ahora: !existing,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
