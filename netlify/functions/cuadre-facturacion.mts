// netlify/functions/cuadre-facturacion.mts
//
// CUADRE POR DESENLACE (solo lectura): para un cliente y período, clasifica cada
// correo del universo (label Facturas/YYYY ∪ Descartado/YYYY ∪ INBOX sin label)
// en exactamente un desenlace y verifica que las PROCESADAS quedaron COMPLETAS
// en Sheet y Drive. Cierra la ecuación:
//
//   universo = procesadas_ok + procesadas_incompletas
//            + descartes_legitimos + descartes_sospechosos + perdidas_reales
//
// Resuelve la pregunta de Tomás "no cuadran correos vs facturas": separa los
// descartes legítimos de las pérdidas reales, y detecta el bug "se puso label
// Facturas/ pero NO quedó en Drive y/o no coincide en el Sheet"
// (PROCESADA_INCOMPLETA → lista `incompletas` para reprocesar con force=true).
//
// A diferencia de conciliar-facturacion.mts (compara los 4 sets por numero/mes y
// EMITE un evento), este endpoint:
//   - es 100% SOLO LECTURA (no escribe nada),
//   - cruza por messageId (inmune al desfase recepción vs emisión),
//   - verifica completitud Sheet+Drive POR messageId, no solo por conjuntos.
//
// Reutiliza los helpers de lectura de conciliar-facturacion.mts (mismos patrones)
// y getAllEventsByYear de agent-events.ts. NO crea labels: solo lee Facturas/ y
// Descartado/.
//
// Auth: x-internal-secret. Body: { clienteSlug, year, month?, format? ('json'|'texto') }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";
import { getAllEventsByYear } from "../../shared/agents-runtime/src/agent-events";
import {
  cuadrarPorDesenlace,
  esMotivoSinApiKey,
} from "../../agentes/Equipo-facturacion/lib/conciliacion-decide";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Filtro de adjuntos de la query de ingestión del pipeline (pipeline.ts ~L414).
// Debe mantenerse en sync con esa query para que `sin-label` represente el mismo
// universo que el pipeline considera procesable.
const ATTACHMENT_FILTER =
  "(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante)";

interface RequestBody {
  clienteSlug?: string;
  year?: number;
  month?: number;
  format?: "json" | "texto";
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

  // Rango de meses: el indicado, o 1..(mes actual si es el año en curso; 12 si pasado).
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

  const notas: string[] = [];

  // ---- Labels (solo lectura; NO se crea ninguno) ----
  const facturasLabelId = await findLabelId(gmail, `Facturas/${year}`);
  const descartadoLabelId = await findLabelId(gmail, `Descartado/${year}`);
  if (!facturasLabelId) notas.push(`label Facturas/${year} no existe en Gmail`);
  if (!descartadoLabelId) notas.push(`label Descartado/${year} no existe en Gmail`);

  // ---- Universo Gmail (unión sobre los meses del rango) ----
  const gmailFacturas = new Set<string>();
  const gmailDescartado = new Set<string>();
  const gmailSinLabel = new Set<string>();
  // Conjuntos de numeros presentes en Sheet/Drive (unión sobre el período: evita
  // falsos "falta_en_sheet" por desfase recepción vs emisión entre pestañas/meses).
  const sheetNumeros = new Set<string>();
  const driveNumeros = new Set<string>();
  let drivePdfsNoParseables = 0;

  // ---- Puente messageId -> numero, y procesadas desde BD ----
  const numeroByMessageId: Record<string, string> = {};
  const bdProcesadaIds = new Set<string>();

  for (const month of meses) {
    const tabName = MES_TABS[month - 1];
    const monthQuery = gmailMonthQuery(year, month);

    // Gmail: Facturas/ y Descartado/ del mes (por recepción).
    if (facturasLabelId) {
      try {
        for (const id of await listGmailMessageIds(gmail, facturasLabelId, monthQuery)) gmailFacturas.add(id);
      } catch (e: any) { notas.push(`gmail Facturas ${tabName}: ${e.message}`); }
    }
    if (descartadoLabelId) {
      try {
        for (const id of await listGmailMessageIds(gmail, descartadoLabelId, monthQuery)) gmailDescartado.add(id);
      } catch (e: any) { notas.push(`gmail Descartado ${tabName}: ${e.message}`); }
    }
    // Gmail: emails con adjunto procesable, del mes, SIN ninguno de los 2 labels
    // del año = vistos por el pipeline pero sin desenlace de label (INBOX/pendiente).
    try {
      const q = `${ATTACHMENT_FILTER} ${monthQuery} -label:Facturas/${year} -label:Descartado/${year}`;
      for (const id of await listGmailMessageIds(gmail, null, q)) gmailSinLabel.add(id);
    } catch (e: any) { notas.push(`gmail sin-label ${tabName}: ${e.message}`); }

    // Sheet: col E (#Documento) de la pestaña del mes.
    try {
      for (const n of await fetchSheetNumeros(sheets, cred.sheet_id, tabName)) sheetNumeros.add(n);
    } catch (e: any) { notas.push(`sheet ${tabName}: ${e.message}`); }

    // Drive: PDFs de la subcarpeta YYYY-MM.
    try {
      const folderId = await findMonthFolderId(drive, cred.drive_folder_id, year, month);
      if (folderId) {
        const filenames = await listPdfFilenames(drive, folderId);
        for (const f of filenames) {
          const num = parseNumeroFromFilename(f);
          if (num) driveNumeros.add(num);
          else drivePdfsNoParseables++;
        }
      }
    } catch (e: any) { notas.push(`drive ${tabName}: ${e.message}`); }

    // BD: facturas_registro del mes (puente messageId->numero + procesadas).
    const bd = await fetchBdRows(supa, clienteId, year, month, notas);
    for (let i = 0; i < bd.messageIds.length; i++) {
      const mid = bd.messageIds[i];
      const num = bd.numeros[i];
      if (mid) {
        bdProcesadaIds.add(mid);
        if (num && !numeroByMessageId[mid]) numeroByMessageId[mid] = num; // BD = fuente preferida
      }
    }
  }

  if (drivePdfsNoParseables > 0) {
    notas.push(
      `${drivePdfsNoParseables} PDF(s) en Drive con filename no parseable: ` +
      `su numero no se pudo extraer, lo que puede inflar falsos "falta_en_drive"`,
    );
  }

  // ---- Eventos del año (cruce por messageId; created_at, no por emisión) ----
  const eventProcesadaIds = new Set<string>();
  const driveLinkByMessageId: Record<string, string> = {};
  let eventosProcesadaSinMessageId = 0;
  try {
    for (const ev of await getAllEventsByYear(clienteId, "factura_procesada", year)) {
      const mid = String(ev.payload?.messageId ?? "").trim();
      if (!mid) { eventosProcesadaSinMessageId++; continue; }
      eventProcesadaIds.add(mid);
      const num = String(ev.payload?.numero ?? "").trim();
      if (num && !numeroByMessageId[mid]) numeroByMessageId[mid] = num; // BD ya tuvo prioridad
      // driveLink: vacío = no había PDF (DIAN solo-XML) -> no es pérdida de Drive.
      if (driveLinkByMessageId[mid] === undefined) {
        driveLinkByMessageId[mid] = String(ev.payload?.driveLink ?? "").trim();
      }
    }
  } catch (e: any) { notas.push(`eventos factura_procesada: ${e.message}`); }

  const descartadoMotivoById: Record<string, string> = {};
  const senderByMessageId: Record<string, string> = {};
  try {
    for (const ev of await getAllEventsByYear(clienteId, "email_descartado", year)) {
      const mid = String(ev.payload?.messageId ?? "").trim();
      if (mid) {
        descartadoMotivoById[mid] = String(ev.payload?.motivo ?? "");
        senderByMessageId[mid] = String(ev.payload?.sender ?? "");
      }
    }
  } catch (e: any) { notas.push(`eventos email_descartado: ${e.message}`); }

  // duplicado_bloqueado_bd no está en la firma de getAllEventsByYear: query directa.
  const bloqueadoBdIds = new Set<string>();
  try {
    const yearStart = `${year}-01-01T00:00:00Z`;
    const yearEnd = `${year + 1}-01-01T00:00:00Z`;
    let from = 0;
    const PAGE = 1000;
    while (from < 100_000) {
      const { data, error } = await supa
        .from("agent_events")
        .select("payload")
        .eq("cliente_id", clienteId)
        .eq("agente_id", "facturacion")
        .eq("tipo", "duplicado_bloqueado_bd")
        .gte("created_at", yearStart)
        .lt("created_at", yearEnd)
        .range(from, from + PAGE - 1);
      if (error) { notas.push(`eventos duplicado_bloqueado_bd: ${error.message}`); break; }
      const batch = (data ?? []) as Array<{ payload: any }>;
      for (const r of batch) {
        const mid = String(r.payload?.messageId ?? "").trim();
        if (mid) bloqueadoBdIds.add(mid);
      }
      if (batch.length < PAGE) break;
      from += PAGE;
    }
  } catch (e: any) { notas.push(`eventos duplicado_bloqueado_bd: ${e.message}`); }

  // ---- Cuadre ----
  const cuadre = cuadrarPorDesenlace({
    gmailFacturasIds: [...gmailFacturas],
    gmailDescartadoIds: [...gmailDescartado],
    gmailSinLabelIds: [...gmailSinLabel],
    eventProcesadaIds: [...eventProcesadaIds],
    bdProcesadaIds: [...bdProcesadaIds],
    descartadoMotivoById,
    bloqueadoBdIds: [...bloqueadoBdIds],
    numeroByMessageId,
    sheetNumeros: [...sheetNumeros],
    driveNumeros: [...driveNumeros],
    driveLinkByMessageId,
    senderByMessageId,
  });

  // Descartes legítimos por falta de ANTHROPIC_API_KEY: recuperables si la key ya existe.
  const sinApiKey = Object.entries(descartadoMotivoById)
    .filter(([, m]) => esMotivoSinApiKey(m))
    .map(([messageId, motivo]) => ({ messageId, motivo }));

  const periodo = meses.length === 1 ? `${year}-${String(meses[0]).padStart(2, "0")}` : `${year}`;
  const respuesta = {
    cliente: clienteSlug,
    periodo,
    cuadra: cuadre.cuadra,
    universo: cuadre.universo,
    conteos: cuadre.conteos,
    // listas accionables al frente:
    incompletas: cuadre.incompletas,
    perdidas_reales: cuadre.perdidas_reales,
    descartes_sospechosos: cuadre.descartes_sospechosos.map((d) => ({
      ...d,
      sender: senderByMessageId[d.messageId] ?? "",
    })),
    // diagnóstico:
    eventos_procesada_sin_messageId: eventosProcesadaSinMessageId,
    descartes_sin_api_key: sinApiKey,
    notas,
  };

  if (format === "texto") {
    return new Response(renderTexto(respuesta), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(respuesta, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};

// ===== Helpers de lectura (mismos patrones que conciliar-facturacion.mts) =====

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

/**
 * Lista TODOS los messageIds (paginación completa). Si labelId es null filtra
 * solo por la query `q` (usado para el universo sin-label).
 */
async function listGmailMessageIds(gmail: any, labelId: string | null, q: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res: any = await gmail.users.messages.list({
      userId: "me",
      ...(labelId ? { labelIds: [labelId] } : {}),
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

async function fetchSheetNumeros(sheets: any, spreadsheetId: string, tabName: string): Promise<string[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName.replace(/'/g, "''")}'!D2:D`,
  });
  const rows = (res.data.values ?? []) as any[][];
  return rows.map((r) => String(r[0] ?? "").trim()).filter(Boolean);
}

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

/** Numero del filename "{numero}. {Proveedor}.pdf" (substring antes del primer ". "). */
function parseNumeroFromFilename(name: string): string | null {
  const base = String(name ?? "").replace(/\.pdf$/i, "");
  const idx = base.indexOf(". ");
  if (idx <= 0) return null;
  const numero = base.slice(0, idx).trim();
  return numero || null;
}

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
        if (!notas.some((n) => n.includes("facturas_registro no existe"))) {
          notas.push("facturas_registro no existe (aplicar migración 0018 + backfill)");
        }
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

function renderTexto(r: {
  cliente: string;
  periodo: string;
  cuadra: boolean;
  universo: number;
  conteos: {
    procesadas_ok: number;
    procesadas_incompletas: number;
    descartes_legitimos: number;
    descartes_sospechosos: number;
    perdidas_reales: number;
  };
  incompletas: Array<{ messageId: string; numero: string; falta_en_sheet: boolean; falta_en_drive: boolean }>;
  perdidas_reales: Array<{ messageId: string; origen: string }>;
  descartes_sospechosos: Array<{ messageId: string; motivo: string; sender?: string }>;
  eventos_procesada_sin_messageId: number;
  descartes_sin_api_key: Array<{ messageId: string; motivo: string }>;
  notas: string[];
}): string {
  const c = r.conteos;
  const lines: string[] = [];
  lines.push(`CUADRE POR DESENLACE — ${r.cliente} ${r.periodo}`);
  lines.push(`Universo (correos): ${r.universo}  ·  ${r.cuadra ? "CUADRA ✓" : "NO CUADRA ✗"}`);
  lines.push("");
  lines.push(`  procesadas OK ............ ${c.procesadas_ok}`);
  lines.push(`  procesadas INCOMPLETAS ... ${c.procesadas_incompletas}   (etiquetadas pero faltan en Drive/Sheet)`);
  lines.push(`  descartes legítimos ...... ${c.descartes_legitimos}`);
  lines.push(`  descartes SOSPECHOSOS .... ${c.descartes_sospechosos}`);
  lines.push(`  PÉRDIDAS REALES .......... ${c.perdidas_reales}`);
  lines.push("");

  if (r.incompletas.length) {
    lines.push(`INCOMPLETAS (${r.incompletas.length}) — reprocesar con force=true regenera Drive+Sheet:`);
    for (const i of r.incompletas.slice(0, 50)) {
      const falta = [i.falta_en_drive ? "Drive" : "", i.falta_en_sheet ? "Sheet" : ""].filter(Boolean).join("+");
      lines.push(`  ${i.messageId}  num=${i.numero || "?"}  falta: ${falta}`);
    }
    lines.push("");
  }
  if (r.perdidas_reales.length) {
    lines.push(`PÉRDIDAS REALES (${r.perdidas_reales.length}):`);
    for (const p of r.perdidas_reales.slice(0, 50)) lines.push(`  ${p.messageId}  origen: ${p.origen}`);
    lines.push("");
  }
  if (r.descartes_sospechosos.length) {
    lines.push(`DESCARTES SOSPECHOSOS (${r.descartes_sospechosos.length}) — revisar (recibo de gasto botado o motivo no reconocido):`);
    for (const d of r.descartes_sospechosos.slice(0, 50)) {
      lines.push(`  ${d.messageId}  ${d.sender ? `de=${d.sender}  ` : ""}motivo: ${d.motivo}`);
    }
    lines.push("");
  }
  if (r.descartes_sin_api_key.length) {
    lines.push(`Descartados por falta de ANTHROPIC_API_KEY (${r.descartes_sin_api_key.length}) — recuperables si la key ya existe.`);
  }
  if (r.eventos_procesada_sin_messageId > 0) {
    lines.push(`Nota: ${r.eventos_procesada_sin_messageId} evento(s) factura_procesada sin messageId (históricos) — no se pudieron cruzar.`);
  }
  for (const n of r.notas) lines.push(`nota: ${n}`);
  return lines.join("\n") + "\n";
}
