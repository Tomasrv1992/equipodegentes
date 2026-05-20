// netlify/functions/rebuild-sheet-v2.mts
//
// Versión MINIMAL del rebuild que toma events de Supabase y reescribe el
// Sheet del cliente. SIN log forense, SIN recordRunStart/End, SIN extras
// que puedan crashear en cold start.
//
// Objetivo: si esto funciona y el original no → el bug está en imports
// del original. Si esto tampoco funciona → algo más fundamental.
//
// Body: { clienteSlug: string, year: number, monthFilter?: number }
// Auth: x-internal-secret
//
// Sync function (no -background): devuelve resultado real.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const SHEET_HEADERS = [
  "#", "Fecha", "Proveedor", "NIT", "# Documento",
  "Subtotal", "IVA",
  "ReteFuente", "ReteIVA", "ReteICA",
  "Total a Pagar",
  "Concepto", "Categoría", "Cuenta PYG", "Link PDF",
];

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { clienteSlug?: string; year?: number; monthFilter?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || new Date().getFullYear();
  const monthFilter = Number(body.monthFilter);
  if (!clienteSlug) {
    return new Response("missing clienteSlug", { status: 400 });
  }

  try {
    // 1) cliente_id
    const supa = getServerClient();
    const { data: cli } = await supa
      .from("clientes")
      .select("id")
      .eq("slug", clienteSlug)
      .single();
    if (!cli) {
      return new Response(JSON.stringify({ ok: false, error: "cliente not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const clienteId = (cli as any).id as string;

    // 2) Cargar credenciales
    const cred = await loadCredentials(clienteId, "facturacion");
    if (!cred?.google_refresh_token || !cred.sheet_id) {
      return new Response(JSON.stringify({ ok: false, error: "missing refresh_token or sheet_id" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const sheetId = cred.sheet_id;

    // 3) Leer events del mes
    const startMonth = monthFilter && monthFilter >= 1 && monthFilter <= 12 ? monthFilter : null;
    if (!startMonth) {
      return new Response(JSON.stringify({ ok: false, error: "monthFilter (1-12) requerido en v2" }), { status: 400 });
    }
    const monthStart = `${year}-${String(startMonth).padStart(2, "0")}-01`;
    const nextMonth = startMonth === 12 ? 1 : startMonth + 1;
    const nextYear = startMonth === 12 ? year + 1 : year;
    const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

    const events: any[] = [];
    let from = 0;
    while (from < 50000) {
      const { data, error } = await supa
        .from("agent_events")
        .select("payload")
        .eq("cliente_id", clienteId)
        .eq("agente_id", "facturacion")
        .eq("tipo", "factura_procesada")
        .gte("payload->>fecha", monthStart)
        .lt("payload->>fecha", monthEnd)
        .range(from, from + 999);
      if (error) {
        return new Response(JSON.stringify({ ok: false, error: `supabase: ${error.message}` }), { status: 500 });
      }
      if (!data || data.length === 0) break;
      events.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Ordenar por fecha asc
    events.sort((a, b) => {
      const fa = String((a.payload as any)?.fecha ?? "");
      const fb = String((b.payload as any)?.fecha ?? "");
      return fa.localeCompare(fb);
    });

    // 4) Setup Google Sheets API
    const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
    const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
    const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    auth.setCredentials({ refresh_token: cred.google_refresh_token });
    const sheets = google.sheets({ version: "v4", auth });

    const tab = MES_TABS[startMonth - 1];

    // 5) Buscar sheetId de la pestaña + delete+add
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "sheets(properties(sheetId,title))",
    });
    const sheetProp = (meta.data.sheets ?? []).find(
      (s: any) => s.properties?.title === tab,
    );

    if (sheetProp?.properties?.sheetId != null) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [
            { deleteSheet: { sheetId: sheetProp.properties.sheetId } },
            {
              addSheet: {
                properties: {
                  title: tab,
                  gridProperties: { frozenRowCount: 1, columnCount: 15 },
                },
              },
            },
          ],
        },
      });
    } else {
      // Tab no existe, crear
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: tab,
                  gridProperties: { frozenRowCount: 1, columnCount: 15 },
                },
              },
            },
          ],
        },
      });
    }

    // 6) Escribir headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${tab}'!A1:O1`,
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] },
    });

    // 7) Convertir events a filas y appendear en chunks
    const values: any[][] = [];
    let consec = 0;
    for (const e of events) {
      consec++;
      const p = e.payload as any;
      const subtotal = Number(p?.subtotal ?? 0);
      const iva = Number(p?.iva ?? 0);
      const rtf = Number(p?.reteFuente ?? 0);
      const riva = Number(p?.reteIva ?? 0);
      const rica = Number(p?.reteIca ?? 0);
      const totalAPagar = subtotal + iva - rtf - riva - rica;
      values.push([
        consec,
        p?.fecha ?? "",
        p?.proveedor ?? "",
        p?.nit ?? "",
        p?.numero ?? "",
        subtotal,
        iva,
        rtf,
        riva,
        rica,
        totalAPagar,
        p?.concepto ?? "",
        p?.categoria ?? "",
        p?.cuentaPyg ?? "",
        p?.driveLink ?? "",
      ]);
    }

    const CHUNK = 500;
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `'${tab}'!A:O`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: chunk },
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        cliente: clienteSlug,
        year,
        month: startMonth,
        tab,
        events_encontrados: events.length,
        filas_appendeadas: values.length,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message, stack: err.stack?.slice(0, 500) }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const config: Config = {};
