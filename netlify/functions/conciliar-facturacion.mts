// netlify/functions/conciliar-facturacion.mts
//
// Conciliación determinística (cero LLM, cero heurísticas) de las 4 fuentes de
// verdad de facturación, por cliente/período:
//   1) Gmail  — emails con label Facturas/YYYY (fecha de RECEPCIÓN en el mes)
//   2) BD     — filas de facturas_registro (fecha_factura, emisión, en el mes)
//   3) Sheet  — columna E (#Documento) de la pestaña del mes
//   4) Drive  — PDFs en la subcarpeta YYYY-MM de la carpeta del cliente
//
// SOLO LECTURA: no corrige ni escribe en Gmail/Sheet/Drive/facturas_registro.
// El único write es el agent_event 'conciliacion_ejecutada' (PASO 3), que requiere
// un agent_run para satisfacer el FK (run sintético, igual que backfill-*).
//
// Compara por CONJUNTOS de identificadores (no por totales): dos errores que se
// compensan dan el mismo total pero distinto conjunto. La lógica vive en la
// función pura conciliarMes() (agentes/Equipo-facturacion/lib/conciliacion-decide).
//
// NOTA temporal: Gmail filtra por fecha de RECEPCIÓN del email; BD/Sheet/Drive
// agrupan por fecha de EMISIÓN de la factura. Una factura emitida a fin de mes y
// recibida a principios del siguiente puede aparecer como discrepancia de borde.
//
// Requiere la migración 0018 (facturas_registro) aplicada + backfill para que la
// fuente BD sea significativa; si la tabla no existe, BD se reporta como 0 (con nota).
//
// Auth: x-internal-secret. Body: { clienteSlug, year, month?, format? ('json'|'texto') }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";
import {
  conciliarMes,
  type ConciliacionMesResult,
} from "../../agentes/Equipo-facturacion/lib/conciliacion-decide";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

interface RequestBody {
  clienteSlug?: string;
  year?: number;
  month?: number;
  format?: "json" | "texto";
}

interface MesReporte extends ConciliacionMesResult {
  mes: number;
  mes_nombre: string;
  drive_pdfs_no_parseables: number;
  notas: string[];
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

  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || new Date().getFullYear();
  const format = body.format === "texto" ? "texto" : "json";
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  // Rango de meses: el indicado, o 1..(mes actual si es el año en curso; 12 si es pasado).
  const now = new Date();
  const maxMonth = year < now.getFullYear() ? 12 : now.getMonth() + 1;
  let meses: number[];
  if (body.month && body.month >= 1 && body.month <= 12) {
    meses = [body.month];
  } else {
    meses = [];
    for (let m = 1; m <= maxMonth; m++) meses.push(m);
  }

  // Resolver cliente + credenciales.
  const supa = getServerClient();
  const { data: cli } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", clienteSlug)
    .single();
  if (!cli) return new Response(`cliente "${clienteSlug}" not found`, { status: 404 });
  const clienteId = (cli as any).id as string;

  const cred = await loadCredentials(clienteId, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id || !cred.drive_folder_id) {
    return new Response(
      JSON.stringify({ error: "faltan credenciales (refresh_token / sheet_id / drive_folder_id)" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "",
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "",
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const gmail = google.gmail({ version: "v1", auth });
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  // Label Facturas/YYYY (una sola búsqueda para todo el año).
  const facturasLabelId = await findLabelId(gmail, `Facturas/${year}`);

  const reportes: MesReporte[] = [];

  for (const month of meses) {
    const notas: string[] = [];
    const tabName = MES_TABS[month - 1];

    // a) GMAIL — paginación completa, filtrado por fecha de recepción del mes.
    let gmailMessageIds: string[] = [];
    if (facturasLabelId) {
      try {
        gmailMessageIds = await listGmailMessageIds(gmail, facturasLabelId, gmailMonthQuery(year, month));
      } catch (e: any) {
        notas.push(`gmail error: ${e.message}`);
      }
    } else {
      notas.push(`label Facturas/${year} no existe en Gmail`);
    }

    // b) BD — facturas_registro del mes (paginado).
    const bd = await fetchBdRows(supa, clienteId, year, month, notas);

    // c) SHEET — columna E (#Documento) de la pestaña del mes.
    let sheetNumeros: string[] = [];
    try {
      sheetNumeros = await fetchSheetNumeros(sheets, cred.sheet_id, tabName);
    } catch (e: any) {
      notas.push(`sheet error: ${e.message}`);
    }

    // d) DRIVE — PDFs en la subcarpeta YYYY-MM (paginado).
    let driveFilenames: string[] = [];
    try {
      const folderId = await findMonthFolderId(drive, cred.drive_folder_id, year, month);
      if (folderId) {
        driveFilenames = await listPdfFilenames(drive, folderId);
      } else {
        notas.push(`carpeta Drive ${year}-${String(month).padStart(2, "0")} no existe`);
      }
    } catch (e: any) {
      notas.push(`drive error: ${e.message}`);
    }
    const driveCount = driveFilenames.length;
    const driveParseados = driveFilenames
      .map(parseNumeroFromFilename)
      .filter((x): x is string => !!x);
    const noParseables = driveCount - driveParseados.length;
    // Solo comparamos Drive por CONJUNTO si el parseo del filename cubre el 100%
    // de los PDFs; si no, evitamos falsos positivos y comparamos solo por conteo.
    const driveNumeros = noParseables === 0 ? driveParseados : undefined;
    if (noParseables > 0) {
      notas.push(`${noParseables} PDF(s) de Drive con filename no parseable -> Drive solo por conteo`);
    }

    const resultado = conciliarMes({
      gmailMessageIds,
      bdMessageIds: bd.messageIds,
      bdNumeros: bd.numeros,
      sheetNumeros,
      driveCount,
      driveNumeros,
    });

    reportes.push({
      mes: month,
      mes_nombre: tabName,
      drive_pdfs_no_parseables: noParseables,
      notas,
      ...resultado,
    });
  }

  const resumen = {
    cliente: clienteSlug,
    year,
    meses_conciliados: reportes.length,
    meses_ok: reportes.filter((r) => r.ok).length,
    meses_con_discrepancias: reportes.filter((r) => !r.ok).length,
    total_facturas_bd: reportes.reduce((s, r) => s + r.conteos.bd, 0),
  };

  // PASO 3 — emitir agent_event 'conciliacion_ejecutada' (único write).
  // Crea un agent_run sintético para satisfacer el FK run_id (igual que backfill-*).
  // No fatal: si falla, el reporte se devuelve igual.
  const startedAt = Date.now();
  try {
    const runId = await recordRunStart({ clienteSlug, agenteId: "facturacion", triggeredBy: "manual" });
    await supa.from("agent_events").insert({
      run_id: runId,
      cliente_id: clienteId,
      agente_id: "facturacion",
      tipo: "conciliacion_ejecutada",
      payload: {
        ...resumen,
        por_mes: reportes.map((r) => ({ mes: r.mes, conteos: r.conteos, ok: r.ok })),
      },
    });
    await recordRunEnd({
      runId,
      status: resumen.meses_con_discrepancias === 0 ? "ok" : "warn",
      durationMs: Date.now() - startedAt,
      summary: `Conciliación ${clienteSlug} ${year}: ${resumen.meses_ok}/${resumen.meses_conciliados} meses OK`,
      payload: resumen,
    });
  } catch (e: any) {
    console.error(`[conciliar] no pude emitir evento conciliacion_ejecutada: ${e.message}`);
  }

  if (format === "texto") {
    return new Response(renderTexto(resumen, reportes), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(
    JSON.stringify({ resumen, meses: reportes }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};

// ===== Helpers de lectura (deterministas) =====

/** Query Gmail por mes (fecha de recepción): after inclusivo, before exclusivo. */
function gmailMonthQuery(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nmm = String(nextMonth).padStart(2, "0");
  return `after:${year}/${mm}/01 before:${nextYear}/${nmm}/01`;
}

async function findLabelId(gmail: any, name: string): Promise<string | null> {
  const list = await gmail.users.labels.list({ userId: "me" });
  return list.data.labels?.find((l: any) => l.name === name)?.id ?? null;
}

/** Lista TODOS los messageIds (paginación completa hasta agotar pageToken). */
async function listGmailMessageIds(gmail: any, labelId: string, q: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res: any = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      q,
      maxResults: 500,
      pageToken,
    });
    const batch = res.data.messages ?? [];
    out.push(...batch.map((m: any) => m.id as string));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/** Columna E (#Documento) de las filas con datos de la pestaña del mes. */
async function fetchSheetNumeros(sheets: any, spreadsheetId: string, tabName: string): Promise<string[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName.replace(/'/g, "''")}'!D2:D`,
  });
  const rows = (res.data.values ?? []) as any[][];
  return rows.map((r) => String(r[0] ?? "").trim()).filter(Boolean);
}

/** Subcarpeta YYYY-MM dentro de la carpeta del cliente. null si no existe. */
async function findMonthFolderId(
  drive: any,
  parentId: string,
  year: number,
  month: number,
): Promise<string | null> {
  const name = `${year}-${String(month).padStart(2, "0")}`;
  const q =
    `'${parentId}' in parents and name='${name}' ` +
    `and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: "files(id,name)", spaces: "drive" });
  return res.data.files?.[0]?.id ?? null;
}

/** Filenames de los PDFs de una carpeta (paginación completa). */
async function listPdfFilenames(drive: any, folderId: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType='application/pdf'`,
      fields: "nextPageToken, files(id,name)",
      spaces: "drive",
      pageSize: 1000,
      pageToken,
    });
    out.push(...(res.data.files ?? []).map((f: any) => String(f.name ?? "")));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Parsea el numero_documento del filename de un PDF de forma determinística:
 * el pipeline nombra los archivos "{numero}. {Proveedor}.pdf" (ver buildFileBaseName),
 * así que el numero es el substring ANTES del primer ". ". Si no hay ". "
 * (filenames sin numero, ej "Sin Proveedor.pdf"), devuelve null.
 */
export function parseNumeroFromFilename(name: string): string | null {
  const base = String(name ?? "").replace(/\.pdf$/i, "");
  const idx = base.indexOf(". ");
  if (idx <= 0) return null;
  const numero = base.slice(0, idx).trim();
  return numero || null;
}

/** Filas de facturas_registro del cliente con fecha_factura en el mes (paginado). */
async function fetchBdRows(
  supa: ReturnType<typeof getServerClient>,
  clienteId: string,
  year: number,
  month: number,
  notas: string[],
): Promise<{ messageIds: string[]; numeros: string[] }> {
  const mm = String(month).padStart(2, "0");
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nmm = String(nextMonth).padStart(2, "0");
  const start = `${year}-${mm}-01`;
  const end = `${nextYear}-${nmm}-01`;

  const messageIds: string[] = [];
  const numeros: string[] = [];
  const PAGE = 1000;
  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("facturas_registro")
      .select("gmail_message_id, numero_documento")
      .eq("cliente_id", clienteId)
      .gte("fecha_factura", start)
      .lt("fecha_factura", end)
      .order("fecha_factura", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("does not exist") || msg.includes("schema cache") || error.code === "42P01") {
        notas.push("facturas_registro no existe (aplicar migración 0018 + backfill)");
      } else {
        notas.push(`bd error: ${error.message}`);
      }
      break;
    }
    const batch = (data ?? []) as Array<{ gmail_message_id: string | null; numero_documento: string | null }>;
    for (const r of batch) {
      messageIds.push(String(r.gmail_message_id ?? "").trim());
      numeros.push(String(r.numero_documento ?? "").trim());
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return { messageIds, numeros };
}

// ===== Render texto =====

function renderTexto(
  resumen: { cliente: string; year: number; meses_ok: number; meses_conciliados: number; meses_con_discrepancias: number; total_facturas_bd: number },
  reportes: MesReporte[],
): string {
  const lines: string[] = [];
  lines.push(`CONCILIACION ${resumen.cliente} ${resumen.year}`);
  lines.push(`${resumen.meses_ok}/${resumen.meses_conciliados} meses OK · ${resumen.meses_con_discrepancias} con discrepancias · ${resumen.total_facturas_bd} facturas en BD`);
  lines.push("");
  lines.push("Mes         | Gmail |  BD   | Sheet | Drive | Estado");
  lines.push("------------|-------|-------|-------|-------|--------");
  for (const r of reportes) {
    const c = r.conteos;
    lines.push(
      `${r.mes_nombre.padEnd(11)} | ${pad(c.gmail)} | ${pad(c.bd)} | ${pad(c.sheet)} | ${pad(c.drive)} | ${r.ok ? "OK" : "DISCREPANCIA"}`,
    );
  }
  lines.push("");

  const conProblemas = reportes.filter((r) => !r.ok || r.notas.length > 0);
  if (conProblemas.length === 0) {
    lines.push("Sin discrepancias.");
  } else {
    lines.push("DETALLE DE MESES CON PROBLEMAS:");
    for (const r of conProblemas) {
      lines.push("");
      lines.push(`# ${r.mes_nombre}`);
      const d = r.discrepancias;
      if (d.en_gmail_no_en_bd.length) lines.push(`  en Gmail no en BD (${d.en_gmail_no_en_bd.length}): ${d.en_gmail_no_en_bd.slice(0, 20).join(", ")}`);
      if (d.en_bd_no_en_gmail.length) lines.push(`  en BD no en Gmail (${d.en_bd_no_en_gmail.length}): ${d.en_bd_no_en_gmail.slice(0, 20).join(", ")}`);
      if (d.en_bd_no_en_sheet.length) lines.push(`  en BD no en Sheet (${d.en_bd_no_en_sheet.length}): ${d.en_bd_no_en_sheet.slice(0, 20).join(", ")}`);
      if (d.en_sheet_no_en_bd.length) lines.push(`  en Sheet no en BD (${d.en_sheet_no_en_bd.length}): ${d.en_sheet_no_en_bd.slice(0, 20).join(", ")}`);
      if (d.diferencia_drive !== 0) lines.push(`  diferencia Drive vs BD: ${d.diferencia_drive > 0 ? "+" : ""}${d.diferencia_drive} PDFs`);
      if (d.en_drive_no_en_bd?.length) lines.push(`  en Drive no en BD (${d.en_drive_no_en_bd.length}): ${d.en_drive_no_en_bd.slice(0, 20).join(", ")}`);
      if (d.en_bd_no_en_drive?.length) lines.push(`  en BD no en Drive (${d.en_bd_no_en_drive.length}): ${d.en_bd_no_en_drive.slice(0, 20).join(", ")}`);
      for (const n of r.notas) lines.push(`  nota: ${n}`);
    }
  }
  return lines.join("\n") + "\n";
}

function pad(n: number): string {
  return String(n).padStart(5, " ");
}
