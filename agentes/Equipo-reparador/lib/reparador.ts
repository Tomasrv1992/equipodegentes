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

export interface AutoRepair {
  cliente_slug: string;
  tipo: "link_actualizado" | "fila_insertada_desde_pdf";
  num_factura: string;
  detalle: string;
}

export interface ReparadorReport {
  fecha: string;
  ts_generated: string;
  clientes_total: number;
  clientes_procesados: number;
  clientes_skipped: number;   // sin OAuth o sin Sheet
  /** Etapa 1: filas re-insertadas en Sheet desde agent_events. */
  filas_reparadas: FilaReparadaSheet[];
  /** Etapa 2 (detección): PDFs en Drive sin fila en Sheet (residuales tras Etapa 3). */
  pdfs_huerfanos: PdfHuerfano[];
  /** Etapa 2 (detección): filas en Sheet sin PDF en Drive (residuales tras Etapa 3). */
  filas_sin_pdf: FilaSinPdf[];
  /** Etapa 3 (auto-repair): acciones tomadas para resolver huérfanos. */
  auto_repairs: AutoRepair[];
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
    auto_repairs: [],
    errores: [],
  };

  // Límite total de auto-repairs por run (Etapa 3) para evitar timeout.
  // Con 462 huérfanos en el primer run, si cada uno hace 1-2 queries Drive,
  // 50 toma ~5-7 min. Si quedan más, próximo run los procesa.
  const MAX_AUTO_REPAIRS_POR_RUN = 50;

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
          // También guardamos filas con su rowIndex para Etapa 3 (update)
          const filasSinPdfConIndex: Array<{
            rowIdx: number; // 0-based en rowsSheet
            sheetRow: number; // fila real en Sheet (rowIdx + 2 porque skip header)
            num: string;
            proveedor: string;
          }> = [];
          for (let i = 0; i < rowsSheet.length; i++) {
            const r = rowsSheet[i];
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
              filasSinPdfConIndex.push({
                rowIdx: i,
                sheetRow: i + 2,
                num: numFactura,
                proveedor,
              });
            }
          }

          // === ETAPA 3.A: Auto-repair filas sin PDF ==========================
          // Para cada fila sin PDF: buscar archivo en TODO el Drive del cliente
          // por nombre que contenga el N° factura. Si lo encuentra, update link
          // en Sheet. Si no, queda como huérfano para revisión manual.
          if (report.auto_repairs.length < MAX_AUTO_REPAIRS_POR_RUN) {
            for (const f of filasSinPdfConIndex) {
              if (report.auto_repairs.length >= MAX_AUTO_REPAIRS_POR_RUN) break;
              try {
                // Buscar archivo cuyo nombre contenga el N° factura
                const numEscaped = f.num.replace(/'/g, "\\'");
                const searchResp = await drive.files.list({
                  q: `name contains '${numEscaped}' and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
                  fields: "files(id, name)",
                  pageSize: 5,
                });
                const found = searchResp.data.files ?? [];
                if (found.length === 0) continue; // no encontrado, deja como huérfano

                // Tomar el primer match
                const fileEncontrado = found[0];
                const fileId = fileEncontrado.id;
                if (!fileId) continue; // sin id no podemos updatear
                const fileName = fileEncontrado.name ?? "(sin nombre)";
                const newLink = `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`;
                // Update col O de la fila correspondiente
                await sheets.spreadsheets.values.update({
                  spreadsheetId: cred.sheet_id,
                  range: `'${tabName}'!O${f.sheetRow}`,
                  valueInputOption: "USER_ENTERED",
                  requestBody: { values: [[newLink]] },
                });
                report.auto_repairs.push({
                  cliente_slug: c.slug,
                  tipo: "link_actualizado",
                  num_factura: f.num,
                  detalle: `Link actualizado al archivo "${fileName}" encontrado en Drive.`,
                });
                // Remover de filas_sin_pdf residuales
                const idx = report.filas_sin_pdf.findIndex(
                  (x) => x.cliente_slug === c.slug && x.num_factura === f.num,
                );
                if (idx >= 0) report.filas_sin_pdf.splice(idx, 1);
                console.log(
                  `[reparador-3A] cliente=${c.slug} fila ${f.sheetRow} #${f.num} → link actualizado a ${fileId.slice(0, 12)}…`,
                );
              } catch (err: any) {
                console.warn(
                  `[reparador-3A] falló para cliente=${c.slug} #${f.num}: ${err.message}`,
                );
              }
            }
          }

          // === ETAPA 3.B: Auto-repair PDFs huérfanos ========================
          // Para cada PDF huérfano: buscar event con N° factura matcheando el
          // filename del PDF. Si match, insertar fila en Sheet con link al PDF.
          if (report.auto_repairs.length < MAX_AUTO_REPAIRS_POR_RUN) {
            // Cargar events del mes actual para matchear contra filenames
            const monthStartCur = `${year}-${String(mesActual).padStart(2, "0")}-01`;
            const monthEndCur =
              mesActual === 12
                ? `${year + 1}-01-01`
                : `${year}-${String(mesActual + 1).padStart(2, "0")}-01`;
            const { data: eventsCur } = await supa
              .from("agent_events")
              .select("payload")
              .eq("cliente_id", c.id)
              .eq("agente_id", "facturacion")
              .eq("tipo", "factura_procesada")
              .gte("payload->>fecha", monthStartCur)
              .lt("payload->>fecha", monthEndCur);

            const eventsByNum = new Map<string, any>();
            for (const ev of (eventsCur ?? []) as Array<{ payload: any }>) {
              const num = String(ev.payload?.numero ?? "").trim();
              if (num) eventsByNum.set(num, ev.payload);
            }

            // Re-cargar Sheet (puede haber filas insertadas en 3.A)
            let rowsActualizado: any[][] = [];
            try {
              const resp = await sheets.spreadsheets.values.get({
                spreadsheetId: cred.sheet_id,
                range: `'${tabName}'!A2:O1000`,
              });
              rowsActualizado = resp.data.values ?? [];
            } catch {
              /* skip */
            }
            const numsEnSheetCur = new Set(
              rowsActualizado
                .map((r) => String(r[COL_NUMERO_DOCUMENTO] ?? "").trim())
                .filter(Boolean),
            );

            const huerfanosClient = report.pdfs_huerfanos.filter(
              (h) => h.cliente_slug === c.slug,
            );
            const filasNuevasAdopt: any[][] = [];
            for (const h of huerfanosClient) {
              if (
                report.auto_repairs.length + filasNuevasAdopt.length >=
                MAX_AUTO_REPAIRS_POR_RUN
              ) {
                break;
              }
              // Intentar matchear filename contra eventsByNum
              const fname = h.drive_file_name;
              let matchedNum: string | null = null;
              for (const num of eventsByNum.keys()) {
                if (num && fname.includes(num)) {
                  matchedNum = num;
                  break;
                }
              }
              if (!matchedNum) continue; // no se encontró match
              if (numsEnSheetCur.has(matchedNum)) continue; // ya hay fila

              const p = eventsByNum.get(matchedNum);
              const subtotal = Number(p.subtotal ?? 0);
              const iva = Number(p.iva ?? 0);
              const rtf = Number(p.reteFuente ?? 0);
              const riva = Number(p.reteIva ?? 0);
              const rica = Number(p.reteIca ?? 0);
              const totalAPagar = subtotal + iva - rtf - riva - rica;
              const maxConsec =
                rowsActualizado.length > 0
                  ? Math.max(
                      0,
                      ...rowsActualizado.map(
                        (r) => parseInt(r[COL_NUMERO_CONSECUTIVO] ?? "0", 10) || 0,
                      ),
                    )
                  : 0;
              const consec = maxConsec + 1 + filasNuevasAdopt.length;
              const driveLink = `https://drive.google.com/file/d/${h.drive_file_id}/view?usp=drivesdk`;
              filasNuevasAdopt.push([
                consec,
                p.fecha ?? "",
                p.proveedor ?? "",
                p.nit ?? "",
                matchedNum,
                subtotal,
                iva,
                rtf,
                riva,
                rica,
                totalAPagar,
                p.concepto ?? "",
                p.categoria ?? "",
                p.cuentaPyg ?? "",
                driveLink,
              ]);
              numsEnSheetCur.add(matchedNum);
              report.auto_repairs.push({
                cliente_slug: c.slug,
                tipo: "fila_insertada_desde_pdf",
                num_factura: matchedNum,
                detalle: `Insertada fila en Sheet enlazando al PDF huérfano "${fname}".`,
              });
              // Remover de pdfs_huerfanos residuales
              const idxH = report.pdfs_huerfanos.findIndex(
                (x) => x.cliente_slug === c.slug && x.drive_file_id === h.drive_file_id,
              );
              if (idxH >= 0) report.pdfs_huerfanos.splice(idxH, 1);
            }

            if (filasNuevasAdopt.length > 0) {
              await sheets.spreadsheets.values.append({
                spreadsheetId: cred.sheet_id,
                range: `${tabName}!A:O`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: filasNuevasAdopt },
              });
              console.log(
                `[reparador-3B] cliente=${c.slug} → ${filasNuevasAdopt.length} filas adoptadas desde PDFs huérfanos`,
              );
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
