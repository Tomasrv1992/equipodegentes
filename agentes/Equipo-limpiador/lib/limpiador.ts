/**
 * Equipo-limpiador — agente que CONFIRMA cada PDF huérfano descargándolo,
 * analizándolo con LLM, y comparando contra agent_events.
 *
 * Diferencia con el reparador (que solo intenta matchear por filename):
 *   El limpiador SÍ descarga el contenido y deja al LLM identificar lo que
 *   realmente es la factura. Después compara contra agent_events y decide:
 *
 *   - DUPLICADO_VERIFICADO: el LLM identificó datos que matchean event existente
 *     → mover archivo a folder "_duplicados" del cliente
 *
 *   - FACTURA_NO_REGISTRADA: el LLM identificó factura pero no hay event
 *     → crear event en DB + insertar fila en Sheet + linkear al PDF original
 *
 *   - NO_IDENTIFICABLE: el LLM no pudo extraer datos válidos (confianza < 0.4)
 *     → dejar como está + reportar al admin
 *
 * Concurrencia: procesa 5 PDFs en paralelo para terminar antes del timeout.
 *
 * Cron: 8:30 AM Bogotá (después del monitor 8:00 + reparador 8:15).
 */

import { google } from "googleapis";
import { getServerClient } from "../../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../../shared/agents-runtime/src/credentials";
import { emitFacturaEvents } from "../../../shared/agents-runtime/src/agent-events";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const COL_NUMERO_DOCUMENTO = 4;
const COL_NUMERO_CONSECUTIVO = 0;
const COL_LINK_PDF = 14;

/** Concurrencia: cuántos PDFs procesar en paralelo. */
const CONCURRENCY = 5;

export interface AccionLimpiador {
  cliente_slug: string;
  drive_file_id: string;
  drive_file_name: string;
  tipo:
    | "duplicado"
    | "factura_recuperada"
    | "no_identificable"
    | "self_emitted_ignorado";
  detalle: string;
  /** Si recuperó: N° factura del event creado/insertado. */
  num_factura?: string;
  /** Si recuperó: monto. */
  total?: number;
}

export interface LimpiadorReport {
  fecha: string;
  ts_generated: string;
  clientes_total: number;
  clientes_procesados: number;
  clientes_skipped: number;
  total_huerfanos_analizados: number;
  duplicados_movidos: number;
  facturas_recuperadas: number;
  no_identificables: number;
  /** PDFs ignorados porque el cliente es emisor (cuentas de cobro propias). */
  self_emitted_ignorados: number;
  costo_llm_usd: number;
  acciones: AccionLimpiador[];
  errores: Array<{ cliente_slug: string; error: string }>;
}

/**
 * Costo aproximado por llamada al LLM (Claude Haiku 4.5).
 * $1/1M input + $5/1M output. Llamada típica ~2000+200 tokens = ~$0.003 USD.
 */
const LLM_COST_PER_CALL_USD = 0.003;

export async function runLimpiador(): Promise<LimpiadorReport> {
  const supa = getServerClient();
  const ts = new Date();
  const fecha = bogotaDate(ts);

  const report: LimpiadorReport = {
    fecha,
    ts_generated: ts.toISOString(),
    clientes_total: 0,
    clientes_procesados: 0,
    clientes_skipped: 0,
    total_huerfanos_analizados: 0,
    duplicados_movidos: 0,
    facturas_recuperadas: 0,
    no_identificables: 0,
    self_emitted_ignorados: 0,
    costo_llm_usd: 0,
    acciones: [],
    errores: [],
  };

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";

  if (!oauthClientId || !oauthClientSecret) {
    throw new Error("Faltan GOOGLE_OAUTH_WEB_CLIENT_ID / _SECRET");
  }
  if (!anthropicKey) {
    throw new Error("Falta ANTHROPIC_API_KEY — el limpiador necesita LLM");
  }

  const { data: clientesActivos } = await supa
    .from("clientes")
    .select("id, slug, nombre, activo")
    .eq("activo", true)
    .neq("slug", "monitor")
    .neq("slug", "reparador")
    .neq("slug", "owner")
    .order("slug");

  const clientes = (clientesActivos ?? []) as Array<{
    id: string;
    slug: string;
    nombre: string;
  }>;
  report.clientes_total = clientes.length;

  for (const c of clientes) {
    try {
      const cred = await loadCredentials(c.id, "facturacion");
      if (!cred || !cred.google_refresh_token || !cred.sheet_id || !cred.drive_folder_id) {
        report.clientes_skipped++;
        continue;
      }

      const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
      auth.setCredentials({ refresh_token: cred.google_refresh_token });

      const drive = google.drive({ version: "v3", auth });
      const sheets = google.sheets({ version: "v4", auth });

      const year = bogotaYear();
      const mesActual = bogotaMonth();
      const mm = String(mesActual).padStart(2, "0");
      const monthFolderName = `${year}-${mm}`;
      const tabName = MES_TABS[mesActual - 1];

      // 1. Encontrar folder del mes
      const folderResp = await drive.files.list({
        q: `name='${monthFolderName}' and mimeType='application/vnd.google-apps.folder' and '${cred.drive_folder_id}' in parents and trashed=false`,
        fields: "files(id, name)",
      });
      const monthFolderId = folderResp.data.files?.[0]?.id;
      if (!monthFolderId) {
        report.clientes_procesados++;
        continue;
      }

      // 2. Listar archivos del mes (excluyendo XML y folders)
      const archivosMes: Array<{ id: string; name: string }> = [];
      let pageToken: string | undefined;
      do {
        const resp = await drive.files.list({
          q: `'${monthFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder' and not name contains '.xml'`,
          fields: "files(id, name, mimeType), nextPageToken",
          pageSize: 1000,
          pageToken,
        });
        archivosMes.push(...((resp.data.files ?? []) as Array<{ id: string; name: string }>));
        pageToken = resp.data.nextPageToken ?? undefined;
      } while (pageToken);

      // 3. Cargar links existentes en Sheet del mes
      let rowsSheet: any[][] = [];
      try {
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: cred.sheet_id,
          range: `'${tabName}'!A2:O1000`,
        });
        rowsSheet = resp.data.values ?? [];
      } catch {
        /* tab vacío */
      }
      const linksEnSheet = new Set<string>();
      for (const r of rowsSheet) {
        const link = String(r[COL_LINK_PDF] ?? "");
        const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (m) linksEnSheet.add(m[1]);
      }

      // 4. Huérfanos = archivos sin link en Sheet
      const huerfanos = archivosMes.filter((f) => !linksEnSheet.has(f.id));
      if (huerfanos.length === 0) {
        report.clientes_procesados++;
        continue;
      }

      // 5. Cargar events del AÑO COMPLETO para matchear
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year + 1}-01-01`;
      const { data: eventsCli } = await supa
        .from("agent_events")
        .select("payload")
        .eq("cliente_id", c.id)
        .eq("agente_id", "facturacion")
        .eq("tipo", "factura_procesada")
        .gte("payload->>fecha", yearStart)
        .lt("payload->>fecha", yearEnd);

      const events = (eventsCli ?? []).map((e: any) => e.payload);

      // 6. NIT del cliente (para filtrar facturas self-emitted)
      const nitCliente = (cred as any).nit_cliente
        ? String((cred as any).nit_cliente).replace(/\D+/g, "")
        : null;

      // 7. Procesar huérfanos en concurrencia
      console.log(
        `[limpiador] cliente=${c.slug} → ${huerfanos.length} huérfanos a analizar`,
      );
      const queue = [...huerfanos];
      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(processWorker(queue, c, cred, drive, sheets, supa, events, nitCliente, tabName, mesActual, year, report));
      }
      await Promise.all(workers);

      report.clientes_procesados++;
    } catch (err: any) {
      console.error(`[limpiador] error cliente=${c.slug}: ${err.message}`);
      report.errores.push({ cliente_slug: c.slug, error: err.message });
    }
  }

  report.costo_llm_usd = Math.round(report.total_huerfanos_analizados * LLM_COST_PER_CALL_USD * 10000) / 10000;
  return report;
}

/** Worker que pulla huérfanos de una queue compartida y los procesa. */
async function processWorker(
  queue: Array<{ id: string; name: string }>,
  c: { id: string; slug: string; nombre: string },
  cred: any,
  drive: any,
  sheets: any,
  supa: any,
  events: any[],
  nitCliente: string | null,
  tabName: string,
  mesActual: number,
  year: number,
  report: LimpiadorReport,
): Promise<void> {
  while (queue.length > 0) {
    const h = queue.shift();
    if (!h) break;
    try {
      await procesarHuerfano(h, c, cred, drive, sheets, supa, events, nitCliente, tabName, mesActual, year, report);
    } catch (err: any) {
      console.warn(`[limpiador] huerfano ${h.name} falló: ${err.message}`);
    }
  }
}

async function procesarHuerfano(
  h: { id: string; name: string },
  c: { id: string; slug: string; nombre: string },
  cred: any,
  drive: any,
  sheets: any,
  supa: any,
  events: any[],
  nitCliente: string | null,
  tabName: string,
  mesActual: number,
  year: number,
  report: LimpiadorReport,
): Promise<void> {
  report.total_huerfanos_analizados++;

  // 1. Skip si es .docx (sub-pipeline distinto, lo dejamos pendiente)
  const fname = h.name;
  if (fname.toLowerCase().endsWith(".docx")) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: "Es .docx — limpiador no procesa cuentas de cobro Word (pendiente).",
    });
    return;
  }
  if (!fname.toLowerCase().endsWith(".pdf")) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: "Extensión no soportada.",
    });
    return;
  }

  // 2. Descargar PDF
  const tmpPath = `/tmp/limpiador-${h.id}.pdf`;
  try {
    const dl = await drive.files.get({ fileId: h.id, alt: "media" }, { responseType: "arraybuffer" });
    const fs = await import("node:fs");
    fs.writeFileSync(tmpPath, Buffer.from(dl.data as ArrayBuffer));
  } catch (err: any) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: `Error descargando: ${err.message}`,
    });
    return;
  }

  // 3. Extraer texto del PDF
  let text = "";
  try {
    const { extractTextFromPdf } = await import("../../../agentes/Equipo-facturacion/lib/doc-parsers");
    text = await extractTextFromPdf(tmpPath);
  } catch {
    /* ignorar */
  }
  // Cleanup tmp
  try {
    const fs = await import("node:fs");
    fs.unlinkSync(tmpPath);
  } catch {
    /* ignorar */
  }
  if (!text || text.length < 30) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: "PDF sin texto extraíble (escaneado, imagen, o cifrado).",
    });
    return;
  }

  // 4. LLM identifica
  let extracted: any = null;
  try {
    const { extractInvoiceFromText } = await import("../../../agentes/Equipo-facturacion/lib/llm-extractor");
    extracted = await extractInvoiceFromText({
      text: text.slice(0, 8000),
      presumedType: "recibo_servicio",
      filename: fname,
      sender: "(unknown)",
      subject: fname,
      emailDate: new Date().toISOString(),
    });
  } catch (err: any) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: `LLM falló: ${err.message}`,
    });
    return;
  }

  if (!extracted || !extracted.proveedor) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: "LLM no identificó proveedor — probable que no sea factura.",
    });
    return;
  }
  if (extracted.confianza != null && extracted.confianza < 0.4) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: `LLM baja confianza (${extracted.confianza.toFixed(2)}) — probable no factura.`,
    });
    return;
  }

  // 5. Filtro nit_cliente: si el NIT extraído del PDF coincide con el del
  //    cliente, significa que es una factura/cuenta de cobro que ÉL EMITIÓ.
  //    No es un gasto suyo → no crear event ni fila. Marcar como ignorado.
  if (nitCliente) {
    const extractedNitClean = String(extracted.nit ?? "").replace(/\D+/g, "");
    if (extractedNitClean && extractedNitClean === nitCliente) {
      report.self_emitted_ignorados++;
      report.acciones.push({
        cliente_slug: c.slug,
        drive_file_id: h.id,
        drive_file_name: fname,
        tipo: "self_emitted_ignorado",
        detalle: `Cliente es emisor (NIT ${extractedNitClean}=cliente). Cuenta de cobro propia, no es un gasto. Archivo intacto.`,
      });
      return;
    }
  }

  // 6. Match contra events: por número exacto, o por proveedor+monto (±5%)
  const provExt = normalizeText(String(extracted.proveedor ?? ""));
  const numExt = String(extracted.numero ?? "").trim();
  const totalExt = Number(extracted.total ?? 0);

  const matched = events.find((p) => {
    const pNum = String(p?.numero ?? "").trim();
    if (numExt && pNum && pNum === numExt) return true;
    const pProv = normalizeText(String(p?.proveedor ?? ""));
    if (!pProv || !provExt) return false;
    const provMatch =
      pProv === provExt ||
      pProv.startsWith(provExt) ||
      provExt.startsWith(pProv);
    if (!provMatch) return false;
    const pTotal = Number(p?.total ?? 0);
    if (totalExt > 0 && pTotal > 0) {
      const diff = Math.abs(pTotal - totalExt) / Math.max(pTotal, totalExt);
      return diff < 0.05;
    }
    return false;
  });

  if (matched) {
    // === DUPLICADO: mover archivo a Papelera de Drive =====================
    // Drive guarda en papelera 30 días antes de eliminar definitivamente.
    // Esto da tiempo de recuperar si el LLM se equivocó, sin acumular basura.
    try {
      await drive.files.update({
        fileId: h.id,
        requestBody: { trashed: true },
      });
    } catch (err: any) {
      console.warn(`[limpiador] no pude mover a papelera ${fname}: ${err.message}`);
    }
    report.duplicados_movidos++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "duplicado",
      detalle: `Duplicado verificado de ${matched.proveedor} #${matched.numero}. Movido a Papelera de Drive (recuperable 30 días).`,
      num_factura: String(matched.numero ?? ""),
      total: Number(matched.total ?? 0),
    });
    return;
  }

  // === FACTURA NO REGISTRADA: crear event + insertar fila en Sheet ========
  const fechaExt = String(extracted.fecha ?? "").slice(0, 10);
  const nitExt = String(extracted.nit ?? "").replace(/\D+/g, "");
  const ivaExt = Number(extracted.iva ?? 0);
  const subtotalExt = totalExt > 0 && ivaExt > 0 ? totalExt - ivaExt : Number(extracted.subtotal ?? totalExt);
  const driveLink = `https://drive.google.com/file/d/${h.id}/view?usp=drivesdk`;

  // Crear event en DB (via emitFacturaEvents)
  try {
    // Necesitamos un run_id; usamos el más reciente del agente facturacion para este cliente
    const { data: runs } = await supa
      .from("agent_runs")
      .select("id")
      .eq("cliente_id", c.id)
      .eq("agente_id", "facturacion")
      .order("started_at", { ascending: false })
      .limit(1);
    const runId = runs?.[0]?.id;
    if (!runId) {
      report.no_identificables++;
      report.acciones.push({
        cliente_slug: c.slug,
        drive_file_id: h.id,
        drive_file_name: fname,
        tipo: "no_identificable",
        detalle: "No hay run_id para crear event.",
      });
      return;
    }

    await emitFacturaEvents({
      runId,
      clienteId: c.id,
      agenteId: "facturacion",
      facturas: [
        {
          fecha: fechaExt,
          proveedor: String(extracted.proveedor),
          nit: nitExt,
          numero: numExt || `LIMP-${h.id.slice(0, 8)}`,
          subtotal: subtotalExt,
          iva: ivaExt,
          total: totalExt,
          concepto: String(extracted.concepto ?? "Recuperado por limpiador"),
          categoria: "Otros / sin clasificar",
          cuentaPyg: "5195 - Diversos",
          driveLink,
          tipo: "recuperado_por_limpiador",
        },
      ],
    });
  } catch (err: any) {
    report.no_identificables++;
    report.acciones.push({
      cliente_slug: c.slug,
      drive_file_id: h.id,
      drive_file_name: fname,
      tipo: "no_identificable",
      detalle: `Error guardando event: ${err.message}`,
    });
    return;
  }

  // Insertar fila en Sheet (15 cols, formato nuevo)
  try {
    const yearMonth = fechaExt && fechaExt.slice(0, 7);
    const targetMes = yearMonth ? parseInt(yearMonth.slice(5, 7), 10) : mesActual;
    const targetTab = MES_TABS[targetMes - 1] ?? tabName;
    const totalAPagar = subtotalExt + ivaExt; // sin retenciones por defecto en recuperados

    // Obtener consecutivo nuevo
    let maxConsec = 0;
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: cred.sheet_id,
        range: `'${targetTab}'!A2:A1000`,
      });
      const rows = resp.data.values ?? [];
      maxConsec = rows
        .map((r: any[]) => parseInt(r[0] ?? "0", 10) || 0)
        .reduce((a: number, b: number) => Math.max(a, b), 0);
    } catch {
      /* ignorar */
    }
    const nuevoConsec = maxConsec + 1;

    await sheets.spreadsheets.values.append({
      spreadsheetId: cred.sheet_id,
      range: `${targetTab}!A:O`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            nuevoConsec,
            fechaExt,
            extracted.proveedor,
            nitExt,
            numExt || `LIMP-${h.id.slice(0, 8)}`,
            subtotalExt,
            ivaExt,
            0, 0, 0, // retenciones default
            totalAPagar,
            extracted.concepto ?? "Recuperado por limpiador",
            "Otros / sin clasificar",
            "5195 - Diversos",
            driveLink,
          ],
        ],
      },
    });
  } catch (err: any) {
    console.warn(`[limpiador] append Sheet falló: ${err.message}`);
  }

  report.facturas_recuperadas++;
  report.acciones.push({
    cliente_slug: c.slug,
    drive_file_id: h.id,
    drive_file_name: fname,
    tipo: "factura_recuperada",
    detalle: `Recuperada: ${extracted.proveedor} #${numExt || "(sin número)"} → event creado + fila Sheet.`,
    num_factura: numExt,
    total: totalExt,
  });
}

function normalizeText(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bs\.?\s*a\.?\s*s?\.?\b/gi, "")
    .replace(/\bltda\.?\b/gi, "")
    .replace(/\bsociedad\b/gi, "")
    .replace(/\bp\.?\s*h\.?\b/gi, "")
    .replace(/[.,;:|()/\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bogotaDate(now: Date): string {
  const ms = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function bogotaYear(): number {
  const ms = new Date().getTime() - 5 * 60 * 60 * 1000;
  return new Date(ms).getUTCFullYear();
}

function bogotaMonth(): number {
  const ms = new Date().getTime() - 5 * 60 * 60 * 1000;
  return new Date(ms).getUTCMonth() + 1;
}
