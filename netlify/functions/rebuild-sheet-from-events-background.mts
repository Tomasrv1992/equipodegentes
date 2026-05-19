// netlify/functions/rebuild-sheet-from-events-background.mts
//
// REGENERA el Google Sheet de un cliente desde agent_events (fuente limpia).
//
// Caso de uso: cuando el Sheet tiene filas duplicadas por un bug histórico
// (caso real 2026-05-15: bug del supervisor disparando fan-out producía 316×
// duplicación en Sheet de Freshco). Como agent_events tiene unique constraint
// y está limpio, reconstruir el Sheet desde events garantiza alineación 1:1.
//
// Proceso:
//   1. Lee TODOS los events del cliente para el year + opcional filtro mes
//   2. Por cada pestaña mensual (Enero..Diciembre):
//      - Si vamos a regenerar ese mes:
//        a. Borra todas las filas de datos (A2:O*) — preserva headers
//        b. Re-appendea cada event como fila, ordenadas por fecha factura
//        c. Recalcula consecutivo secuencial (1, 2, 3, ...)
//
// Idempotente: si lo corres 2 veces sin que pase nada en agent_events, el
// resultado final es el mismo.
//
// Body: {
//   clienteSlug: string,
//   year?: number,           // default año actual Bogotá
//   monthFilter?: number,    // opcional 1..12 — si se pasa, solo regenera ese mes
//   dryRun?: boolean,        // si true, no toca Sheet, solo reporta qué haría
// }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

interface RequestBody {
  clienteSlug: string;
  year?: number;
  monthFilter?: number;
  dryRun?: boolean;
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

  const clienteSlug = (body.clienteSlug ?? "").trim();
  if (!clienteSlug) {
    return new Response("missing clienteSlug", { status: 400 });
  }
  const year = Number(body.year) || new Date().getFullYear();
  const monthFilter = Number(body.monthFilter);
  const dryRun = !!body.dryRun;

  console.log(`[rebuild-sheet] cliente=${clienteSlug} year=${year} monthFilter=${monthFilter || "all"} dryRun=${dryRun}`);

  const supa = getServerClient();

  // 1. Resolver cliente_id
  const { data: cli, error: e1 } = await supa
    .from("clientes")
    .select("id, slug, nombre")
    .eq("slug", clienteSlug)
    .single();
  if (e1 || !cli) {
    return new Response(`cliente "${clienteSlug}" no encontrado`, { status: 404 });
  }
  const clienteId = (cli as any).id as string;

  // 2. Registrar run en agent_runs
  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug,
      agenteId: "facturacion",
      triggeredBy: "manual",
    });
  } catch (err: any) {
    console.warn(`[rebuild-sheet] recordRunStart failed (no-fatal): ${err.message}`);
  }
  const startedAt = Date.now();

  try {
    // 3. Cargar credenciales del cliente
    const cred = await loadCredentials(clienteId, "facturacion");
    if (!cred?.google_refresh_token || !cred.sheet_id) {
      throw new Error(`Cliente "${clienteSlug}" sin refresh_token o sheet_id`);
    }
    const sheetId = cred.sheet_id;

    // 4. Leer TODOS los events del cliente para el year (paginado)
    const events: any[] = [];
    let from = 0;
    while (from < 50000) {
      const { data, error } = await supa
        .from("agent_events")
        .select("payload")
        .eq("cliente_id", clienteId)
        .eq("agente_id", "facturacion")
        .eq("tipo", "factura_procesada")
        .gte("payload->>fecha", `${year}-01-01`)
        .lt("payload->>fecha", `${year + 1}-01-01`)
        .range(from, from + 999);
      if (error) throw error;
      if (!data || data.length === 0) break;
      events.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
    console.log(`[rebuild-sheet] cargados ${events.length} events del año ${year}`);

    // 5. Agrupar por mes
    const eventsByMonth = new Map<number, any[]>();
    for (const e of events) {
      const fecha = (e.payload as any)?.fecha as string | undefined;
      if (!fecha) continue;
      const m = parseInt(String(fecha).slice(5, 7), 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) continue;
      if (!eventsByMonth.has(m)) eventsByMonth.set(m, []);
      eventsByMonth.get(m)!.push(e);
    }

    // 6. Setup Google Sheets API
    const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
    const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
    if (!oauthClientId || !oauthClientSecret) {
      throw new Error("Faltan GOOGLE_OAUTH_WEB_CLIENT_ID / _SECRET");
    }
    const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    auth.setCredentials({ refresh_token: cred.google_refresh_token });
    const sheets = google.sheets({ version: "v4", auth });

    // 7. Por cada mes, regenerar (si está en el filtro o no hay filtro)
    const meses = monthFilter && monthFilter >= 1 && monthFilter <= 12
      ? [monthFilter]
      : Array.from({ length: 12 }, (_, i) => i + 1);

    const report: Array<{
      mes: number;
      tab: string;
      events_encontrados: number;
      filas_borradas: number;
      filas_appendeadas: number;
    }> = [];

    for (const mes of meses) {
      const tab = MES_TABS[mes - 1];
      const evs = (eventsByMonth.get(mes) ?? []).slice().sort((a, b) => {
        const fa = String((a.payload as any)?.fecha ?? "");
        const fb = String((b.payload as any)?.fecha ?? "");
        return fa.localeCompare(fb);
      });

      console.log(`[rebuild-sheet] ${tab}: ${evs.length} events a regenerar`);

      // 7.a Leer filas actuales para reportar cuántas borraríamos
      let filasActuales = 0;
      try {
        const cur = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `'${tab}'!A2:A`,
        });
        filasActuales = (cur.data.values?.length) || 0;
      } catch {
        /* tab puede no existir */
      }

      if (dryRun) {
        report.push({
          mes,
          tab,
          events_encontrados: evs.length,
          filas_borradas: filasActuales,
          filas_appendeadas: 0,
        });
        continue;
      }

      // 7.b NUKE tab completo (deleteSheet + addSheet con headers + frozen row).
      //
      // INCIDENTE 2026-05-19: deleteDimension de 600K filas físicas timeoutea
      // o satura quota Sheets. deleteSheet es INSTANT sin importar cuántas
      // filas tenga (es metadata, no toca celdas). addSheet recrea la pestaña
      // vacía con headers. Como el Dashboard referencia por NOMBRE de tab
      // (no por sheetId), las fórmulas siguen funcionando.
      try {
        const meta = await sheets.spreadsheets.get({
          spreadsheetId: sheetId,
          fields: "sheets(properties(sheetId,title))",
        });
        const sheetProp = (meta.data.sheets ?? []).find(
          (s: any) => s.properties?.title === tab,
        );
        const tabSheetId = sheetProp?.properties?.sheetId;

        if (tabSheetId != null) {
          // Borrar pestaña entera y recrearla con headers + frozen row
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              requests: [
                { deleteSheet: { sheetId: tabSheetId } },
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
          // Escribir headers en row 1 de la pestaña nueva
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `'${tab}'!A1:O1`,
            valueInputOption: "RAW",
            requestBody: {
              values: [[
                "#", "Fecha", "Proveedor", "NIT", "# Documento",
                "Subtotal", "IVA",
                "ReteFuente", "ReteIVA", "ReteICA",
                "Total a Pagar",
                "Concepto", "Categoría", "Cuenta PYG", "Link PDF",
              ]],
            },
          });
          console.log(`[rebuild-sheet] ${tab}: pestaña recreada (deleteSheet + addSheet)`);
        } else {
          // Tab no existe — el addSheet del próximo bloque la creará
          console.log(`[rebuild-sheet] ${tab}: no existe, se creará nueva`);
        }
      } catch (e: any) {
        console.error(`[rebuild-sheet] ${tab}: nuke failed: ${e.message}`);
        throw new Error(`rebuild-sheet nuke failed para ${tab}: ${e.message}`);
      }

      // 7.c Re-appendear eventos como filas (15 cols, formato pipeline)
      if (evs.length === 0) {
        report.push({ mes, tab, events_encontrados: 0, filas_borradas: filasActuales, filas_appendeadas: 0 });
        continue;
      }

      const values: any[][] = [];
      let consec = 0;
      for (const e of evs) {
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

      // Append en chunks de 500 para evitar timeout
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
      console.log(`[rebuild-sheet] ${tab}: ${values.length} filas appendeadas`);

      report.push({
        mes,
        tab,
        events_encontrados: evs.length,
        filas_borradas: filasActuales,
        filas_appendeadas: values.length,
      });
    }

    const summary = report
      .filter((r) => r.events_encontrados > 0 || r.filas_borradas > 0)
      .map((r) => `${r.tab}: ${r.filas_borradas}→${r.filas_appendeadas}`)
      .join(" · ");

    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "ok",
          durationMs: Date.now() - startedAt,
          summary: `rebuild-sheet ${clienteSlug} ${year}${monthFilter ? `/${monthFilter}` : ""}: ${summary || "nada que regenerar"}`,
          payload: {
            cliente_slug: clienteSlug,
            year,
            monthFilter: monthFilter || null,
            dryRun,
            report,
            total_events: events.length,
            total_filas_appendeadas: report.reduce((s, r) => s + r.filas_appendeadas, 0),
            total_filas_borradas: report.reduce((s, r) => s + r.filas_borradas, 0),
          },
        });
      } catch (e: any) {
        console.error(`[rebuild-sheet] recordRunEnd failed: ${e.message}`);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        cliente: clienteSlug,
        year,
        monthFilter: monthFilter || null,
        dryRun,
        report,
        summary,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err: any) {
    console.error(`[rebuild-sheet] fatal: ${err.message}\n${err.stack}`);
    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          summary: `rebuild-sheet ${clienteSlug} crashed: ${err.message}`,
          error: err,
        });
      } catch {
        /* ignorar */
      }
    }
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const config: Config = {
  // Background fn (suffix `-background`) → 15min timeout. Necesario para
  // clientes grandes con miles de filas para regenerar.
};
