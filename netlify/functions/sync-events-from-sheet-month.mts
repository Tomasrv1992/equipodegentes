// netlify/functions/sync-events-from-sheet-month.mts
//
// Sincroniza events en BD desde el Sheet, mes por mes.
// Lee las filas del Sheet de un mes y crea agent_events para cada factura
// que NO tenga event ya en BD (por NIT+numero).
//
// Body: { clienteSlug, year, month }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year);
  const month = Number(body.month);
  if (!clienteSlug || !year || !month) return new Response("missing params", { status: 400 });

  const tab = MES_TABS[month - 1];
  if (!tab) return new Response("invalid month", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });

  const cred = await loadCredentials((cli as any).id, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id) {
    return new Response("missing creds", { status: 400 });
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });

  // Leer Sheet del mes
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: cred.sheet_id,
    range: `'${tab}'!A2:O1000`,
  });
  const rows = r.data.values || [];
  if (rows.length === 0) {
    return new Response(JSON.stringify({ ok: true, tab, rows: 0, inserted: 0 }), { headers: { "content-type": "application/json" } });
  }

  // Cargar set de events ya existentes (numero+nit)
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  const existingKeys = new Set<string>();
  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("payload")
      .eq("cliente_id", (cli as any).id)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", monthStart)
      .lt("payload->>fecha", monthEnd)
      .range(from, from + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const nit = String(ev.payload?.nit ?? "").replace(/\D+/g, "");
      const numero = String(ev.payload?.numero ?? "").trim();
      if (nit && numero) existingKeys.add(`${nit}|${numero}`);
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // Crear/obtener run sintético para FK
  const { data: runRow, error: runErr } = await supa
    .from("agent_runs")
    .insert({
      cliente_id: (cli as any).id,
      agente_id: "facturacion",
      status: "ok",
      triggered_by: "manual_sync_from_sheet",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      summary: `Sync events from Sheet ${tab}`,
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return new Response(JSON.stringify({ error: runErr?.message ?? "no run created" }), { status: 500 });
  }
  const runId = (runRow as any).id;

  // Procesar cada fila del sheet
  let inserted = 0;
  let skipped_dup = 0;
  let skipped_invalid = 0;
  let errors = 0;

  for (const row of rows) {
    // Columnas: A=#, B=Fecha, C=Proveedor, D=NIT, E=#Doc, F=Subt, G=IVA, H=ReteFte, I=ReteIVA, J=ReteICA, K=Total, L=Concepto, M=Cat, N=CuentaPYG, O=Drive
    const fecha = String(row[1] ?? "").trim();
    const proveedor = String(row[2] ?? "").trim();
    const nit = String(row[3] ?? "").replace(/\D+/g, "");
    const numero = String(row[4] ?? "").trim();
    const subtotal = Number(row[5] ?? 0) || 0;
    const iva = Number(row[6] ?? 0) || 0;
    const reteFuente = Number(row[7] ?? 0) || 0;
    const reteIva = Number(row[8] ?? 0) || 0;
    const reteIca = Number(row[9] ?? 0) || 0;
    const total = Number(row[10] ?? 0) || 0;
    const concepto = String(row[11] ?? "").trim();
    const categoria = String(row[12] ?? "").trim();
    const cuentaPyg = String(row[13] ?? "").trim();
    const driveLink = String(row[14] ?? "").trim();

    if (!nit || !numero || !fecha) { skipped_invalid++; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { skipped_invalid++; continue; }

    const key = `${nit}|${numero}`;
    if (existingKeys.has(key)) { skipped_dup++; continue; }

    const payload = {
      fecha, proveedor, nit, numero,
      subtotal, iva, total,
      reteFuente, reteIva, reteIca,
      totalRetenciones: reteFuente + reteIva + reteIca,
      concepto, categoria, cuentaPyg, driveLink,
      tipo: "factura_dian",
    };

    const { error: insErr } = await supa.from("agent_events").insert({
      run_id: runId,
      cliente_id: (cli as any).id,
      agente_id: "facturacion",
      tipo: "factura_procesada",
      payload,
    });

    if (insErr) {
      if (/duplicate|unique/i.test(insErr.message)) skipped_dup++;
      else errors++;
    } else {
      inserted++;
      existingKeys.add(key);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      cliente: clienteSlug,
      tab,
      total_rows_sheet: rows.length,
      inserted,
      skipped_dup,
      skipped_invalid,
      errors,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
