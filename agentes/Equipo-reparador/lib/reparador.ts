/**
 * Equipo-reparador — agente que detecta y auto-corrige discrepancias entre
 * agent_events (DB) / Sheet (Google) / Drive (Google).
 *
 * Corre los lunes 9am Bogotá (después del monitor) o disparo manual.
 *
 * Etapa 1 (auto-reparar):
 *   ✓ Para cada cliente, comparar agent_events del año vs filas del Sheet
 *   ✓ Si hay events sin fila correspondiente → INSERT en Sheet desde payload
 *   ✓ Idempotente: skip si N° factura ya existe en Sheet
 *
 * Etapa 2 (detectar, sin auto-repair):
 *   ✓ Listar PDFs en Drive que no tienen fila en Sheet (orphan PDFs)
 *   ✓ Listar filas en Sheet sin PDF en Drive (lookup por nombre/N° factura)
 *   ✓ Reportar al admin para revisión manual
 *
 * Etapa 3 (futuro): auto-repair de PDFs huérfanos (re-descargar de Gmail).
 */

import { google } from "googleapis";
import { getServerClient } from "../../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Headers del Sheet (deben coincidir con pipeline.ts SHEET_HEADERS). */
const SHEET_COL_COUNT = 15;
const COL_NUMERO_DOCUMENTO = 4; // E = índice 4 (0-based)
const COL_NIT = 3;              // D = índice 3
const COL_NUMERO_CONSECUTIVO = 0; // A = índice 0
const COL_LINK_PDF = 14;        // O = índice 14

export interface FilaReparadaSheet {
  cliente_slug: string;
  mes: number;
  num_factura: string;
  proveedor: string;
  total: number;
}

export interface PdfHuerfano {
  cliente_slug: string;
  drive_file_id: string;
  drive_file_name: string;
  mes: number;
}

export interface FilaSinPdf {
  cliente_slug: string;
  num_factura: string;
  proveedor: string;
  mes: number;
}

export interface ReparadorReport {
  fecha: string;
  ts_generated: string;
  clientes_total: number;
  clientes_procesados: number;
  clientes_skipped: number;   // sin OAuth o sin Sheet
  /** Etapa 1: filas re-insertadas en Sheet desde agent_events. */
  filas_reparadas: FilaReparadaSheet[];
  /** Etapa 2 (detección): PDFs en Drive sin fila en Sheet. */
  pdfs_huerfanos: PdfHuerfano[];
  /** Etapa 2 (detección): filas en Sheet sin PDF en Drive. */
  filas_sin_pdf: FilaSinPdf[];
  /** Errores por cliente (no detienen el run). */
  errores: Array<{ cliente_slug: string; error: string }>;
}

export async function runReparador(): Promise<ReparadorReport> {
  const supa = getServerClient();
  const ts = new Date();
  const fecha = bogotaDate(ts);

  const report: ReparadorReport = {
    fecha,
    ts_generated: ts.toISOString(),
    clientes_total: 0,
    clientes_procesados: 0,
    clientes_skipped: 0,
    filas_reparadas: [],
    pdfs_huerfanos: [],
    filas_sin_pdf: [],
    errores: [],
  };

  // 1. Cargar clientes activos con agente facturacion
  const { data: clientesActivos, error: cErr } = await supa
    .from("clientes")
    .select("id, slug, nombre, activo")
    .eq("activo", true)
    .neq("slug", "monitor")
    .neq("slug", "owner")
    .order("slug");

  if (cErr) throw new Error(`fetch clientes failed: ${cErr.message}`);

  const clientes = (clientesActivos ?? []) as Array<{
    id: string;
    slug: string;
    nombre: string;
  }>;
  report.clientes_total = clientes.length;

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";

  if (!oauthClientId || !oauthClientSecret) {
    throw new Error("Faltan GOOGLE_OAUTH_WEB_CLIENT_ID / _SECRET");
  }

  for (const c of clientes) {
    try {
      // Cargar credenciales del cliente (Google OAuth)
      const cred = await loadCredentials(c.id, "facturacion");
      if (!cred || !cred.google_refresh_token || !cred.sheet_id) {
        report.clientes_skipped++;
        continue;
      }

      const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
      auth.setCredentials({ refresh_token: cred.google_refresh_token });

      const sheets = google.sheets({ version: "v4", auth });
      const drive = google.drive({ version: "v3", auth });

      const year = bogotaYear();

      // === ETAPA 1: comparar events vs Sheet, reparar filas faltantes =======
      for (let mes = 1; mes <= 12; mes++) {
        const tabName = MES_TABS[mes - 1];

        // 1a) Cargar events del mes
        const monthStart = `${year}-${String(mes).padStart(2, "0")}-01`;
        const monthEnd =
          mes === 12
            ? `${year + 1}-01-01`
            : `${year}-${String(mes + 1).padStart(2, "0")}-01`;

        const { data: events } = await supa
          .from("agent_events")
          .select("payload, created_at")
          .eq("cliente_id", c.id)
          .eq("agente_id", "facturacion")
          .eq("tipo", "factura_procesada")
          .gte("payload->>fecha", monthStart)
          .lt("payload->>fecha", monthEnd);

        const eventsMes = (events ?? []) as Array<{
          payload: any;
          created_at: string;
        }>;

        if (eventsMes.length === 0) continue;

        // 1b) Cargar filas del Sheet del mes
        let rowsSheet: any[][] = [];
        try {
          const resp = await sheets.spreadsheets.values.get({
            spreadsheetId: cred.sheet_id,
            range: `'${tabName}'!A2:O1000`,
          });
          rowsSheet = resp.data.values ?? [];
        } catch {
          // Tab no existe — el reparador no la crea, eso es responsabilidad del pipeline.
          continue;
        }

        // Set de números de factura ya en Sheet
        const numsEnSheet = new Set<string>();
        for (const r of rowsSheet) {
          const num = String(r[COL_NUMERO_DOCUMENTO] ?? "").trim();
          if (num) numsEnSheet.add(num);
        }

        // 1c) Identificar events faltantes en Sheet
        const filasNuevas: any[][] = [];
        for (const ev of eventsMes) {
          const p = ev.payload ?? {};
          const numFactura = String(p.numero ?? "").trim();
          if (!numFactura) continue; // sin número no podemos matchear ni insertar
          if (numsEnSheet.has(numFactura)) continue; // ya existe → skip

          // Construir fila desde payload
          const subtotal = Number(p.subtotal ?? 0);
          const iva = Number(p.iva ?? 0);
          const rtf = Number(p.reteFuente ?? 0);
          const riva = Number(p.reteIva ?? 0);
          const rica = Number(p.reteIca ?? 0);
          const totalAPagar = subtotal + iva - rtf - riva - rica;
          // Consecutivo: max existente + 1 + N
          const maxConsecutivo =
            rowsSheet.length > 0
              ? Math.max(
                  0,
                  ...rowsSheet.map((r) => parseInt(r[COL_NUMERO_CONSECUTIVO] ?? "0", 10) || 0),
                )
              : 0;
          const consecutivo = maxConsecutivo + 1 + filasNuevas.length;

          filasNuevas.push([
            consecutivo,
            p.fecha ?? "",
            p.proveedor ?? "",
            p.nit ?? "",
            numFactura,
            subtotal,
            iva,
            rtf,
            riva,
            rica,
            totalAPagar,
            p.concepto ?? "",
            p.categoria ?? "",
            p.cuentaPyg ?? "",
            p.driveLink ?? "",
          ]);

          report.filas_reparadas.push({
            cliente_slug: c.slug,
            mes,
            num_factura: numFactura,
            proveedor: String(p.proveedor ?? ""),
            total: totalAPagar,
          });
        }

        // 1d) Insertar filas nuevas (si hay)
        if (filasNuevas.length > 0) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: cred.sheet_id,
            range: `${tabName}!A:O`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: filasNuevas },
          });
          console.log(
            `[reparador] cliente=${c.slug} mes=${mes} → ${filasNuevas.length} filas insertadas`,
          );
        }
      }

      // === ETAPA 2: detectar PDFs huérfanos + filas sin PDF =================
      if (cred.drive_folder_id) {
        // Para el MES ACTUAL solamente (el resto es legacy, no se reporta)
        const mesActual = bogotaMonth();
        const mm = String(mesActual).padStart(2, "0");
        const monthFolderName = `${year}-${mm}`;
        const tabName = MES_TABS[mesActual - 1];

        // Buscar subfolder del mes
        const folderResp = await drive.files.list({
          q: `name='${monthFolderName}' and mimeType='application/vnd.google-apps.folder' and '${cred.drive_folder_id}' in parents and trashed=false`,
          fields: "files(id, name)",
        });
        const monthFolderId = folderResp.data.files?.[0]?.id;

        if (monthFolderId) {
          // 2a) Listar todos los archivos del mes
          let archivosMes: Array<{ id: string; name: string }> = [];
          let pageToken: string | undefined;
          do {
            const filesResp = await drive.files.list({
              q: `'${monthFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
              fields: "files(id, name), nextPageToken",
              pageSize: 1000,
              pageToken,
            });
            archivosMes.push(...((filesResp.data.files ?? []) as any));
            pageToken = filesResp.data.nextPageToken ?? undefined;
          } while (pageToken);

          // 2b) Re-cargar filas del Sheet del mes actual (con repairs ya hechos)
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

          // Set de links de Drive en Sheet
          const linksEnSheet = new Set<string>();
          for (const r of rowsSheet) {
            const link = String(r[COL_LINK_PDF] ?? "");
            // Extraer file id de URL Drive (formato: .../d/FILE_ID/...)
            const match = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (match) linksEnSheet.add(match[1]);
          }

          // 2c) PDFs en Drive sin link en Sheet (huérfanos)
          for (const f of archivosMes) {
            if (!linksEnSheet.has(f.id)) {
              report.pdfs_huerfanos.push({
                cliente_slug: c.slug,
                drive_file_id: f.id,
                drive_file_name: f.name,
                mes: mesActual,
              });
            }
          }

          // 2d) Filas en Sheet sin PDF en Drive (link inválido o falta)
          const archivosIds = new Set(archivosMes.map((f) => f.id));
          for (const r of rowsSheet) {
            const link = String(r[COL_LINK_PDF] ?? "");
            const numFactura = String(r[COL_NUMERO_DOCUMENTO] ?? "").trim();
            const proveedor = String(r[2] ?? ""); // col C
            if (!numFactura) continue;
            const match = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
            const fileId = match?.[1];
            if (!fileId || !archivosIds.has(fileId)) {
              report.filas_sin_pdf.push({
                cliente_slug: c.slug,
                num_factura: numFactura,
                proveedor,
                mes: mesActual,
              });
            }
          }
        }
      }

      report.clientes_procesados++;
    } catch (err: any) {
      console.error(`[reparador] error cliente=${c.slug}: ${err.message}`);
      report.errores.push({ cliente_slug: c.slug, error: err.message });
    }
  }

  return report;
}

function bogotaDate(now: Date): string {
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(bogotaMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function bogotaYear(): number {
  const now = new Date();
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  return new Date(bogotaMs).getUTCFullYear();
}

function bogotaMonth(): number {
  const now = new Date();
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  return new Date(bogotaMs).getUTCMonth() + 1;
}
