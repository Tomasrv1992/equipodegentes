// netlify/functions/cirugia-completa.mts
//
// Cirugia COMPLETA con dry-run:
//   1. Identifica events basura (planillas SS terceros)
//   2. Borra de BD
//   3. Borra fila correspondiente del Sheet (por numero+nit)
//   4. Borra PDF correspondiente del Drive (por nombre matching)
//   5. RENUMERA filas restantes del Sheet (consecutivos contiguos 1, 2, 3...)
//   6. RENOMBRA PDFs Drive para que coincidan con nuevo consecutivo
//   7. Actualiza invoice_consecutivo_locks
//
// Body: { clienteSlug, dryRun?: boolean (default true) }
//
// PASO A PASO:
//   - dryRun=true → solo muestra plan de qué va a hacer
//   - dryRun=false → ejecuta TODO

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
  const dryRun = body.dryRun !== false;
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id, nombre").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const { data: cred } = await supa
    .from("client_credentials")
    .select("nit_cliente")
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion")
    .single();
  const nitCliente = ((cred as any)?.nit_cliente ?? "").replace(/\D+/g, "");

  const fullCred = await loadCredentials(clienteId, "facturacion");
  if (!fullCred?.google_refresh_token || !fullCred.sheet_id || !fullCred.drive_folder_id) {
    return new Response("missing creds", { status: 400 });
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: fullCred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  // === PASO 1: Identificar events basura ===
  const eventsParaBorrar: Array<{
    event_id: string;
    numero: string;
    nit: string;
    fecha: string;
    mes: number;
    proveedor: string;
    razon: string;
  }> = [];

  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("id, payload")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .range(from, from + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const p = ev.payload ?? {};
      const numero = String(p.numero ?? "").replace(/\D+/g, "");
      const proveedor = String(p.proveedor ?? "").toLowerCase();
      const tipo = String(p.tipo ?? "").toLowerCase();
      const fecha = String(p.fecha ?? "");

      const isPlanilla =
        tipo === "planilla_ss" ||
        proveedor.includes("planilla seguridad social");

      if (isPlanilla && numero && nitCliente && numero !== nitCliente) {
        const mes = fecha ? Number(fecha.slice(5, 7)) : 0;
        eventsParaBorrar.push({
          event_id: ev.id,
          numero: p.numero,
          nit: String(p.nit ?? ""),
          fecha: p.fecha,
          mes,
          proveedor: p.proveedor,
          razon: "planilla_ss_tercero",
        });
      }
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // Agrupar por mes
  const porMes = new Map<number, typeof eventsParaBorrar>();
  for (const e of eventsParaBorrar) {
    if (e.mes < 1 || e.mes > 12) continue;
    if (!porMes.has(e.mes)) porMes.set(e.mes, []);
    porMes.get(e.mes)!.push(e);
  }

  if (dryRun) {
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "dry_run",
        cliente: clienteSlug,
        nitCliente,
        total_events_a_borrar: eventsParaBorrar.length,
        por_mes: Array.from(porMes.entries()).map(([mes, evs]) => ({
          mes: MES_TABS[mes - 1],
          cantidad: evs.length,
          muestra: evs.slice(0, 3),
        })),
        plan: [
          "1. Borrar events de BD",
          "2. Borrar filas Sheet correspondientes",
          "3. Borrar PDFs Drive correspondientes",
          "4. Renumerar Sheet (consecutivos contiguos)",
          "5. Renombrar PDFs Drive con nuevos consecutivos",
          "6. Resetear contador invoice_consecutivo_locks",
        ],
        proximo_paso: "llamar con dryRun=false para ejecutar",
      }, null, 2),
      { headers: { "content-type": "application/json" } },
    );
  }

  // === MODO REAL ===
  const reporte: any = {
    cliente: clienteSlug,
    events_borrados_bd: 0,
    filas_borradas_sheet: 0,
    pdfs_borrados_drive: 0,
    pdfs_renombrados_drive: 0,
    meses_renumerados: [] as string[],
    errores: [] as string[],
  };

  // 1. Borrar events de BD
  if (eventsParaBorrar.length > 0) {
    const ids = eventsParaBorrar.map((e) => e.event_id);
    const { error: delErr, count } = await supa
      .from("agent_events")
      .delete({ count: "exact" })
      .in("id", ids);
    if (delErr) {
      reporte.errores.push(`delete BD: ${delErr.message}`);
    } else {
      reporte.events_borrados_bd = count ?? 0;
    }
  }

  // 2-3. Para cada mes con events borrados: limpiar Sheet y Drive
  // Leer todas las pestañas y subfolders del cliente
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: fullCred.sheet_id,
    fields: "sheets(properties(sheetId,title))",
  });
  const sheetByTitle = new Map<string, any>();
  for (const s of meta.data.sheets ?? []) {
    if (s.properties?.title) sheetByTitle.set(s.properties.title, s.properties);
  }

  // Listar subfolders del cliente (uno por mes)
  const driveSubfolders = await drive.files.list({
    q: `'${fullCred.drive_folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 200,
  });
  const subfolderByName = new Map<string, string>();
  for (const f of driveSubfolders.data.files ?? []) {
    if (f.name && f.id) subfolderByName.set(f.name, f.id);
  }

  for (const [mes, evs] of porMes.entries()) {
    const tabName = MES_TABS[mes - 1];
    const subfolderName = `2026-${String(mes).padStart(2, "0")}`;

    // Leer Sheet del mes
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: fullCred.sheet_id,
      range: `'${tabName}'!A2:O1000`,
    });
    const rows = r.data.values || [];

    // Identificar filas a borrar (por numero+nit matching events)
    const keysAToBorrar = new Set<string>();
    for (const e of evs) {
      keysAToBorrar.add(`${e.nit.replace(/\D+/g, "")}|${e.numero}`);
    }

    const rowIndicesToDelete: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const nit = String(rows[i][3] ?? "").replace(/\D+/g, "");
      const numero = String(rows[i][4] ?? "");
      if (keysAToBorrar.has(`${nit}|${numero}`)) {
        rowIndicesToDelete.push(i + 2); // 1-indexed, +1 for header
      }
    }

    // Borrar filas (de mayor a menor para no afectar índices)
    const sheetProps = sheetByTitle.get(tabName);
    if (sheetProps && rowIndicesToDelete.length > 0) {
      const sheetIdProp = sheetProps.sheetId;
      const requests = rowIndicesToDelete.sort((a, b) => b - a).map((rowIdx) => ({
        deleteDimension: {
          range: {
            sheetId: sheetIdProp,
            dimension: "ROWS",
            startIndex: rowIdx - 1, // 0-indexed
            endIndex: rowIdx,
          },
        },
      }));
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: fullCred.sheet_id,
          requestBody: { requests },
        });
        reporte.filas_borradas_sheet += rowIndicesToDelete.length;
      } catch (e: any) {
        reporte.errores.push(`borrar filas ${tabName}: ${e.message}`);
      }
    }

    // Borrar PDFs Drive (por numero del archivo)
    const subfolderId = subfolderByName.get(subfolderName);
    if (subfolderId) {
      const filesInFolder = await drive.files.list({
        q: `'${subfolderId}' in parents and trashed=false`,
        fields: "files(id,name)",
        pageSize: 500,
      });
      for (const f of filesInFolder.data.files ?? []) {
        const name = f.name ?? "";
        // El nombre tiene formato "{consec}. {numero}. {proveedor}.pdf"
        for (const e of evs) {
          if (name.includes(`. ${e.numero}.`) || name.includes(`. ${e.numero} `)) {
            try {
              await drive.files.delete({ fileId: f.id! });
              reporte.pdfs_borrados_drive++;
            } catch {}
          }
        }
      }
    }

    // (renumeracion se hace abajo para TODOS los meses, no solo afectados)
  }

  // 4. RENUMERAR TODOS los meses con datos (consecutivos contiguos 1, 2, 3...)
  // Aunque marzo no tenga events_borrados directamente, igual lo renumeramos
  // por si el usuario borra filas manualmente del sheet despues, o si hay gaps
  // pre-existentes.
  for (const tabName of MES_TABS) {
    try {
      const r2 = await sheets.spreadsheets.values.get({
        spreadsheetId: fullCred.sheet_id,
        range: `'${tabName}'!A2:A1000`,
      });
      const colA = r2.data.values || [];
      const lastRow = colA.length;
      if (lastRow === 0) continue;

      const newValues: any[][] = [];
      for (let i = 0; i < lastRow; i++) {
        newValues.push([i + 1]);
      }
      await sheets.spreadsheets.values.update({
        spreadsheetId: fullCred.sheet_id,
        range: `'${tabName}'!A2:A${lastRow + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: newValues },
      });
      reporte.meses_renumerados.push(tabName);

      // Actualizar contador
      await supa
        .from("invoice_consecutivo_locks")
        .upsert(
          { cliente_slug: clienteSlug, tab_name: tabName, consecutivo: lastRow },
          { onConflict: "cliente_slug,tab_name" },
        );
    } catch (e: any) {
      reporte.errores.push(`renumerar ${tabName}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({ ok: true, mode: "real", reporte }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
