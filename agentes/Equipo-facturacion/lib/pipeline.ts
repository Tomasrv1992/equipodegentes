// netlify/functions/_lib/procesar-facturas-pipeline.ts
// DRAFT 2026-04-29 — pendiente revisión spec
//
// Lógica core del pipeline. Consumida por:
//   1) scripts/procesar-facturas.mjs  (CLI wrapper local)
//   2) netlify/functions/procesar-facturas-background.mts (Netlify worker)
//
// Sin side-effects globales: recibe config como parámetro, retorna resultado.
// `process.exit` está prohibido acá — los errores se throwean.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

// ===== Tipos =====

export interface PipelineConfig {
  /** OAuth + targets. */
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    driveFolderId: string;
    sheetId: string;
    sheetTab: string; // ej "Gastos 2026"
  };
  /** Comportamiento. */
  options?: {
    dryRun?: boolean;
    limit?: number | null;
    /** Gmail search window, e.g. "30d", "365d". */
    window?: string;
  };
}

export interface InvoiceData {
  fecha: string;
  proveedor: string;
  nit: string;
  numero: string;
  cufe: string;
  subtotal: number;
  iva: number;
  total: number;
  concepto: string;
}

export interface ProcessedRow extends InvoiceData {
  driveLink: string;
  subject: string;
  categoria: string;
  cuentaPyg: string;
}

// ===== Categorización =====
import reglasCategoria from "./categorizacion-reglas.json" with { type: "json" };

interface ReglaCategoria {
  proveedor?: string;
  categoria: string;
  cuenta_pyg: string;
}
interface ReglaKeyword {
  patron: string;
  categoria: string;
  cuenta_pyg: string;
}

/**
 * Asigna categoría + cuenta PYG a una factura.
 * Lookup: 1) por NIT exacto → 2) por keyword en concepto → 3) default.
 */
function categorizar(data: { nit: string; concepto: string }): { categoria: string; cuentaPyg: string } {
  // 1. NIT exacto
  const nitNorm = String(data.nit || "").replace(/\D+/g, "");
  const reglasPorNit = (reglasCategoria as any).reglas_por_nit as Record<string, ReglaCategoria>;
  if (reglasPorNit[nitNorm]) {
    return { categoria: reglasPorNit[nitNorm].categoria, cuentaPyg: reglasPorNit[nitNorm].cuenta_pyg };
  }

  // 2. Keyword en concepto
  const keywords = (reglasCategoria as any).reglas_por_keyword_concepto as ReglaKeyword[];
  const concepto = data.concepto || "";
  for (const k of keywords) {
    try {
      if (new RegExp(k.patron).test(concepto)) {
        return { categoria: k.categoria, cuentaPyg: k.cuenta_pyg };
      }
    } catch {
      /* regex inválida en config — ignorar regla */
    }
  }

  // 3. Default
  return {
    categoria: (reglasCategoria as any).default.categoria,
    cuentaPyg: (reglasCategoria as any).default.cuenta_pyg,
  };
}

export interface SkippedRow {
  messageId: string;
  motivo: string;
  asunto?: string;
}

export interface ErrorRow {
  messageId: string;
  error: string;
  asunto?: string;
}

export interface PipelineResult {
  procesadas: ProcessedRow[];
  errores: ErrorRow[];
  saltadas: SkippedRow[];
  /** Solo presente si options.dryRun. */
  dryRun?: {
    query: string;
    total: number;
    sample: Array<{
      id: string;
      subject: string | null;
      from: string | null;
      date: string | null;
      zips: string[];
    }>;
  };
}

const PROCESSED_LABEL = "Procesado";

// ===== Entry point =====

export async function run(cfg: PipelineConfig): Promise<PipelineResult> {
  const { google: g, options = {} } = cfg;
  const { dryRun = false, limit = null, window = "30d" } = options;

  // DIAN Colombia no usa "factura" en el subject — detectamos por adjunto ZIP.
  const searchQuery = `filename:zip -label:Procesado newer_than:${window}`;

  const auth = new google.auth.OAuth2(g.clientId, g.clientSecret);
  auth.setCredentials({ refresh_token: g.refreshToken });

  const gmail = google.gmail({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  // Tab base: si viene "Gastos 2026", se interpreta como prefix → derivamos por año del XML.
  // Si viene solo "Gastos", también — concatenamos el año.
  const baseTabName = deriveBaseTab(g.sheetTab);
  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });

  const labelId = await getOrCreateLabel(gmail, PROCESSED_LABEL);

  let emails = await findInvoiceEmails(gmail, searchQuery);
  if (limit != null && limit > 0) emails = emails.slice(0, limit);

  if (dryRun) {
    const detailed: NonNullable<PipelineResult["dryRun"]>["sample"] = [];
    for (const e of emails.slice(0, 20)) {
      const m = await getMessageFull(gmail, e.id!);
      detailed.push({
        id: e.id!,
        subject: getHeader(m, "Subject"),
        from: getHeader(m, "From"),
        date: getHeader(m, "Date"),
        zips: findZipParts(m.payload).map((z) => z.filename),
      });
    }
    return {
      procesadas: [],
      errores: [],
      saltadas: [],
      dryRun: { query: searchQuery, total: emails.length, sample: detailed },
    };
  }

  // Caché de Sheet rows POR tab (key = nombre del tab, ej "Gastos 2026").
  // Se carga lazy y se actualiza tras cada append. Soporta multi-año en una corrida.
  const sheetRowsCache = new Map<string, any[][]>();
  const loadSheetRows = async (tabName: string): Promise<any[][]> => {
    if (sheetRowsCache.has(tabName)) return sheetRowsCache.get(tabName)!;
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: g.sheetId,
        range: `${tabRange}!A:K`,
      });
      const rows = res.data.values || [];
      sheetRowsCache.set(tabName, rows);
      return rows;
    } catch {
      // El tab puede no existir todavía — lo creará getOrCreateYearTab.
      sheetRowsCache.set(tabName, []);
      return [];
    }
  };

  const result: PipelineResult = { procesadas: [], errores: [], saltadas: [] };

  for (const e of emails) {
    try {
      const r = await processOne(
        e.id!,
        labelId,
        gmail,
        drive,
        sheets,
        xmlParser,
        g,
        baseTabName,
        loadSheetRows,
        (tabName, newRow) => {
          const cached = sheetRowsCache.get(tabName);
          if (cached) cached.push(newRow);
        }
      );
      if ("ok" in r && r.ok) {
        result.procesadas.push(r);
      } else if ("dup" in r && r.dup) {
        result.saltadas.push({ messageId: e.id!, motivo: r.motivo, asunto: r.subject });
      } else if ("skip" in r && r.skip) {
        result.saltadas.push({ messageId: e.id!, motivo: r.reason, asunto: r.subject });
      }
    } catch (err: any) {
      result.errores.push({ messageId: e.id!, error: err.message });
    }
  }

  return result;
}

/**
 * Extrae el "prefix" del nombre del tab. Si tiene un año al final lo quita.
 * "Gastos 2026" → "Gastos"; "Gastos" → "Gastos"; "Mis Gastos" → "Mis Gastos".
 */
function deriveBaseTab(configured: string): string {
  return String(configured || "Gastos").replace(/\s*\d{4}\s*$/, "").trim() || "Gastos";
}

const SHEET_HEADERS = [
  "Fecha", "Proveedor", "NIT", "N° Factura", "Subtotal", "IVA", "Total",
  "Concepto", "Link PDF", "Categoría", "Cuenta PYG",
];

/**
 * Devuelve el nombre del tab para un año dado (ej "Gastos 2027"). Si no existe,
 * lo crea con headers + frozen + bold. Idempotente.
 */
async function getOrCreateYearTab(sheets: any, sheetId: string, baseName: string, year: number): Promise<string> {
  const tabName = `${baseName} ${year}`;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets?.find((s: any) => s.properties?.title === tabName);
  if (existing) return tabName;

  // Crear tab + headers + formato
  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: tabName,
            gridProperties: { frozenRowCount: 1 },
          },
        },
      }],
    },
  });
  const newTabId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${tabName}'!A1:K1`,
    valueInputOption: "RAW",
    requestBody: { values: [SHEET_HEADERS] },
  });

  if (newTabId != null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: newTabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 11 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.95 } } },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        }],
      },
    });
  }

  return tabName;
}

// ===== Gmail helpers =====

async function getOrCreateLabel(gmail: any, name: string): Promise<string> {
  const list = await gmail.users.labels.list({ userId: "me" });
  const found = list.data.labels?.find((l: any) => l.name === name);
  if (found) return found.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id;
}

async function findInvoiceEmails(gmail: any, query: string) {
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });
    if (res.data.messages) out.push(...res.data.messages);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function getMessageFull(gmail: any, messageId: string) {
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return res.data;
}

function getHeader(msg: any, name: string): string | null {
  return msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function findZipParts(payload: any) {
  const out: Array<{ filename: string; attachmentId: string }> = [];
  function walk(part: any) {
    if (part.filename && /\.zip$/i.test(part.filename) && part.body?.attachmentId) {
      out.push({ filename: part.filename, attachmentId: part.body.attachmentId });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return out;
}

async function downloadAttachment(gmail: any, messageId: string, attachmentId: string, filename: string) {
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  const buf = Buffer.from(res.data.data!, "base64url");
  const safeName = filename.replace(/[\\/:*?"<>|]/g, "_");
  const tmpPath = path.join(os.tmpdir(), `factura-${Date.now()}-${safeName}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

async function markEmailProcessed(gmail: any, messageId: string, labelId: string) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

/**
 * Aplica un label "Facturas/YYYY-MM" al mensaje (lo crea si no existe) Y archiva
 * el correo (remueve INBOX). Gmail soporta labels anidados con `/` — quedan
 * agrupados visualmente bajo "Facturas/".
 *
 * Razón del archive: si la factura ya está organizada en su carpeta de mes,
 * no tiene sentido que siga ocupando espacio en la bandeja principal. Sigue
 * accesible vía el label.
 */
async function applyMonthLabel(gmail: any, messageId: string, year: number, month: number) {
  const labelName = `Facturas/${year}-${String(month).padStart(2, "0")}`;
  const labelId = await getOrCreateLabel(gmail, labelName);
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: ["INBOX"], // archivar — sale de la bandeja, queda en el label
    },
  });
}

// ===== ZIP & XML =====

function extractZip(zipPath: string): { pdfPath: string | null; xmlPaths: string[]; allPaths: string[]; tmpDir: string } {
  const zip = new AdmZip(zipPath);
  const tmpDir = path.join(
    os.tmpdir(),
    `factura-extracted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  zip.extractAllTo(tmpDir, true);
  const all: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else all.push(full);
    }
  }
  walk(tmpDir);
  return {
    pdfPath: all.find((p) => /\.pdf$/i.test(p)) || null,
    xmlPaths: all.filter((p) => /\.xml$/i.test(p)),
    allPaths: all,
    tmpDir,
  };
}

/** Best-effort cleanup de paths temporales — silencioso si falla. */
function cleanupTmp(paths: string[]) {
  for (const p of paths) {
    if (!p) continue;
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch {
      /* archivo ya borrado o inaccesible — no es crítico */
    }
  }
}

function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p.split(".")) {
      if (cur == null) {
        ok = false;
        break;
      }
      cur = cur[k];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return null;
}

function asNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v["#text"] != null) return parseFloat(v["#text"]) || 0;
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

function asString(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v["#text"] != null) return String(v["#text"]);
  return String(v);
}

function unwrapAttachedDocument(parsed: any, xmlParser: XMLParser): any | null {
  const ad = parsed.AttachedDocument;
  if (!ad) return null;
  function findInvoiceXml(node: any): string | null {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const x of node) {
        const f = findInvoiceXml(x);
        if (f) return f;
      }
      return null;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "Description" && typeof v === "string" && v.includes("<Invoice")) return v;
      if (k === "Description" && Array.isArray(v)) {
        for (const x of v) if (typeof x === "string" && x.includes("<Invoice")) return x;
      }
      const nested = findInvoiceXml(v);
      if (nested) return nested;
    }
    return null;
  }
  const innerXml = findInvoiceXml(ad);
  if (!innerXml) return null;
  return xmlParser.parse(innerXml);
}

function parseInvoiceXml(xmlPath: string, xmlParser: XMLParser): InvoiceData | null {
  const raw = fs.readFileSync(xmlPath, "utf8");
  const parsed = xmlParser.parse(raw);

  let invoice = parsed.Invoice;
  if (!invoice) {
    const unwrapped = unwrapAttachedDocument(parsed, xmlParser);
    if (unwrapped) invoice = unwrapped.Invoice;
  }
  if (!invoice) return null;

  const supplier = invoice.AccountingSupplierParty?.Party;
  const proveedor = asString(
    pick(supplier, "PartyTaxScheme.RegistrationName") ??
      pick(supplier, "PartyLegalEntity.RegistrationName") ??
      pick(supplier, "PartyName.Name") ??
      "Desconocido"
  );
  const nit = asString(
    pick(supplier, "PartyTaxScheme.CompanyID") ?? pick(supplier, "PartyIdentification.ID") ?? ""
  ).replace(/\D+/g, "");

  const totals = invoice.LegalMonetaryTotal;
  const subtotal = asNumber(pick(totals, "LineExtensionAmount"));
  const total = asNumber(pick(totals, "TaxInclusiveAmount") ?? pick(totals, "PayableAmount"));

  let iva = 0;
  const taxArr = Array.isArray(invoice.TaxTotal) ? invoice.TaxTotal : invoice.TaxTotal ? [invoice.TaxTotal] : [];
  for (const t of taxArr) iva += asNumber(t.TaxAmount);

  const lines = Array.isArray(invoice.InvoiceLine)
    ? invoice.InvoiceLine
    : invoice.InvoiceLine
      ? [invoice.InvoiceLine]
      : [];
  let concepto = "";
  if (lines.length === 1) {
    concepto = asString(pick(lines[0], "Item.Description", "Item.Name"));
  } else if (lines.length > 1) {
    const first = asString(pick(lines[0], "Item.Description", "Item.Name"));
    concepto = first ? `${first} (+${lines.length - 1} más)` : `${lines.length} ítems`;
  }

  return {
    fecha: asString(pick(invoice, "IssueDate")),
    proveedor,
    nit,
    numero: asString(pick(invoice, "ID")),
    cufe: asString(pick(invoice, "UUID")),
    subtotal,
    iva,
    total,
    concepto,
  };
}

// ===== Drive =====

async function getOrCreateMonthFolder(drive: any, parentFolderId: string, year: number, month: number) {
  const name = `${year}-${String(month).padStart(2, "0")}`;
  const q = `name='${name}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({ q, fields: "files(id, name)", spaces: "drive" });
  if (list.data.files?.length) return list.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] },
    fields: "id",
  });
  return created.data.id;
}

async function uploadFile(drive: any, localPath: string, parentId: string, name: string) {
  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  return res.data;
}

// ===== Sheets =====

function isDuplicate(rows: any[][], numero: string, nit: string): boolean {
  if (!numero) return false;
  const numTrim = String(numero).trim();
  const nitNorm = String(nit || "").replace(/\D+/g, "");
  // Match estricto: ambos NITs deben existir e igualar.
  // Si NIT entrante vacío → no podemos verificar dup confiablemente → procesar.
  // (La idempotencia primaria sigue siendo el label "Procesado" en Gmail.)
  if (!nitNorm) return false;
  return rows.some((r) => {
    const rowNum = String(r[3] || "").trim();
    const rowNit = String(r[2] || "").replace(/\D+/g, "");
    return rowNum === numTrim && rowNit === nitNorm;
  });
}

async function appendToSheet(
  sheets: any,
  sheetId: string,
  tabRange: string,
  d: ProcessedRow
): Promise<any[]> {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tabRange}!A:K`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[d.fecha, d.proveedor, d.nit, d.numero, d.subtotal, d.iva, d.total, d.concepto, d.driveLink, d.categoria, d.cuentaPyg]],
    },
  });
  return [d.fecha, d.proveedor, d.nit, d.numero, d.subtotal, d.iva, d.total, d.concepto, d.driveLink, d.categoria, d.cuentaPyg];
}

// ===== Pipeline per email =====

type ProcessOneResult =
  | (ProcessedRow & { ok: true })
  | { dup: true; motivo: string; subject: string }
  | { skip: true; reason: string; subject: string };

async function processOne(
  messageId: string,
  labelId: string,
  gmail: any,
  drive: any,
  sheets: any,
  xmlParser: XMLParser,
  g: PipelineConfig["google"],
  baseTabName: string,
  loadSheetRows: (tabName: string) => Promise<any[][]>,
  pushToCache: (tabName: string, row: any[]) => void
): Promise<ProcessOneResult> {
  const msg = await getMessageFull(gmail, messageId);
  const subject = getHeader(msg, "Subject") || "(sin asunto)";

  const zips = findZipParts(msg.payload);
  if (!zips.length) return { skip: true, reason: "sin-zip", subject };

  // Tracking de tmp paths para cleanup garantizado en finally.
  const tmpPaths: string[] = [];

  try {
    const z = zips[0];
    const zipPath = await downloadAttachment(gmail, messageId, z.attachmentId, z.filename);
    tmpPaths.push(zipPath);

    let extracted;
    try {
      extracted = extractZip(zipPath);
      tmpPaths.push(extracted.tmpDir);
    } catch (e: any) {
      // ZIPs con password / corruptos no son facturas DIAN procesables — skip silencioso
      return { skip: true, reason: `zip-no-procesable: ${e.message}`, subject };
    }
    const { pdfPath, xmlPaths } = extracted;
    if (!xmlPaths.length) {
      return { skip: true, reason: "zip-sin-xml", subject };
    }

    let data: InvoiceData | null = null;
    for (const x of xmlPaths) {
      try {
        const candidate = parseInvoiceXml(x, xmlParser);
        if (candidate && (candidate.numero || candidate.cufe)) {
          data = candidate;
          break;
        }
      } catch {
        /* probar el siguiente XML */
      }
    }
    if (!data) return { skip: true, reason: "no-es-factura-dian", subject };

    // year/month derivados del IssueDate del XML (no del header del email).
    const issue = data.fecha ? new Date(data.fecha) : new Date();
    const year = issue.getFullYear();
    const month = issue.getMonth() + 1;

    // Tab dinámico por año — crea "Gastos {year}" si no existe (con headers).
    const tabName = await getOrCreateYearTab(sheets, g.sheetId, baseTabName, year);
    const tabRange = `'${tabName.replace(/'/g, "''")}'`;

    const sheetRows = await loadSheetRows(tabName);
    if (isDuplicate(sheetRows, data.numero, data.nit)) {
      await markEmailProcessed(gmail, messageId, labelId);
      await applyMonthLabel(gmail, messageId, year, month);
      return { dup: true, motivo: `${data.proveedor} ${data.numero} (ya en ${tabName})`, subject };
    }

    const folderId = await getOrCreateMonthFolder(drive, g.driveFolderId, year, month);

    let driveLink = "";
    const baseName = `${data.fecha || "sin-fecha"}_${data.proveedor.slice(0, 40)}_${data.numero || data.cufe.slice(0, 8)}`
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, "_");

    if (pdfPath) {
      const uploaded = await uploadFile(drive, pdfPath, folderId, `${baseName}.pdf`);
      driveLink = uploaded.webViewLink || "";
    }
    for (const x of xmlPaths) {
      await uploadFile(drive, x, folderId, `${baseName}__${path.basename(x)}`);
    }

    const { categoria, cuentaPyg } = categorizar({ nit: data.nit, concepto: data.concepto });
    const row: ProcessedRow = { ...data, driveLink, subject, categoria, cuentaPyg };
    const newRow = await appendToSheet(sheets, g.sheetId, tabRange, row);
    pushToCache(tabName, newRow);
    await markEmailProcessed(gmail, messageId, labelId);
    await applyMonthLabel(gmail, messageId, year, month);

    return { ok: true, ...row };
  } finally {
    // Cleanup garantizado de tmp paths (FIX: leak de /tmp en Netlify functions)
    cleanupTmp(tmpPaths);
  }
}
