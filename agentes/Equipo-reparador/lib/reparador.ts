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

/**
 * Reporte de validación 5 fuentes para UN cliente (Bloque B).
 * El reparador valida que TODAS las fuentes cuadren después de auto-reparar:
 *   1. Gmail (label Facturas/YYYY-MM)
 *   2. Drive (PDFs en folder del mes)
 *   3. Sheet (filas en pestaña del mes)
 *   4. Events (agent_events tipo factura_procesada)
 *   5. Dashboard (fórmulas de la pestaña Dashboard) — opcional
 */
export interface ValidacionClienteCliente {
  cliente_slug: string;
  mes: string; // "YYYY-MM"
  gmail: number;
  drive: number;
  sheet: number;
  events: number;
  todo_cuadra: boolean;
  /** Detalle textual de discrepancias para email/log. */
  discrepancias: string[];
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
  /** Bloque B: validación cruzada 5 fuentes por cliente. */
  validaciones: ValidacionClienteCliente[];
  /** Clientes con inconsistencia residual tras auto-repair. */
  clientes_inconsistentes: string[];
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
    validaciones: [],
    clientes_inconsistentes: [],
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
      const gmail = google.gmail({ version: "v1", auth });

      const year = bogotaYear();
      const mesActual = bogotaMonth();
      const tabName = MES_TABS[mesActual - 1];
      // monthFolderId se setea adentro de Etapa 2 si la carpeta existe
      let monthFolderIdRef: string | null = null;

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
        // mesActual y tabName ya están declarados arriba en scope del cliente
        const mm = String(mesActual).padStart(2, "0");
        const monthFolderName = `${year}-${mm}`;

        // Buscar subfolder del mes
        const folderResp = await drive.files.list({
          q: `name='${monthFolderName}' and mimeType='application/vnd.google-apps.folder' and '${cred.drive_folder_id}' in parents and trashed=false`,
          fields: "files(id, name)",
        });
        const monthFolderId = folderResp.data.files?.[0]?.id;
        if (monthFolderId) monthFolderIdRef = monthFolderId;

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
          // IMPORTANTE: ignoramos archivos .xml — son los XMLs DIAN extraídos
          // del ZIP que el cron guarda como auxiliares. NO son facturas
          // independientes (el link del Sheet apunta al .pdf principal).
          // Tampoco contamos archivos sin nombre.
          for (const f of archivosMes) {
            const fname = (f.name ?? "").toLowerCase();
            if (!fname || fname.endsWith(".xml")) continue;
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
                // Buscar archivo cuyo nombre contenga el N° factura.
                // EXIGENTE: probar 3 variantes del número porque el filename
                // del PDF puede tener padding ('00123') o prefijo ('FE-123')
                // mientras la fila tiene '123' nudo.
                const variantes = generarVariantesNumero(f.num);
                let found: any[] = [];
                for (const variante of variantes) {
                  const numEscaped = variante.replace(/'/g, "\\'");
                  const searchResp = await drive.files.list({
                    q: `name contains '${numEscaped}' and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
                    fields: "files(id, name)",
                    pageSize: 5,
                  });
                  found = searchResp.data.files ?? [];
                  if (found.length > 0) break;
                }
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

          // === ETAPA 3.B + 4: Auto-repair PDFs huérfanos (multi-nivel) ======
          // Estrategia de matching (en orden):
          //   1. Por N° factura en filename (Etapa 3.B original)
          //   2. Por proveedor parseado del filename (Etapa 4.A)
          //   3. Por LLM extrayendo texto del PDF (Etapa 4.B) — solo si no
          //      hay match en 1+2 y el filename parece factura
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

            const eventsAll = (eventsCur ?? []) as Array<{ payload: any }>;
            const eventsByNum = new Map<string, any>();
            for (const ev of eventsAll) {
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

            // Index por proveedor normalizado (para Etapa 4.A)
            const eventsByProveedor = new Map<string, any[]>();
            for (const ev of eventsAll) {
              const prov = normalizeText(String(ev.payload?.proveedor ?? ""));
              if (!prov) continue;
              if (!eventsByProveedor.has(prov)) eventsByProveedor.set(prov, []);
              eventsByProveedor.get(prov)!.push(ev.payload);
            }

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
              const fname = h.drive_file_name;
              let matchedNum: string | null = null;
              let matchSource = "";

              // === Etapa 3.B: match por N° factura en filename ============
              for (const num of eventsByNum.keys()) {
                if (num && fname.includes(num)) {
                  matchedNum = num;
                  matchSource = "numero_en_filename";
                  break;
                }
              }

              // === Etapa 4.A: match por proveedor parseado ================
              if (!matchedNum) {
                const provFromFile = extractProveedorFromFilename(fname);
                if (provFromFile) {
                  const provNorm = normalizeText(provFromFile);
                  // Buscar exacto primero
                  let candidates = eventsByProveedor.get(provNorm);
                  // Si no, buscar startsWith / includes
                  if (!candidates) {
                    for (const [k, evs] of eventsByProveedor.entries()) {
                      if (k.startsWith(provNorm) || provNorm.startsWith(k)) {
                        candidates = evs;
                        break;
                      }
                    }
                  }
                  if (candidates && candidates.length > 0) {
                    // Tomar el primero cuyo número no esté ya en Sheet
                    for (const cand of candidates) {
                      const candNum = String(cand?.numero ?? "").trim();
                      if (candNum && !numsEnSheetCur.has(candNum)) {
                        matchedNum = candNum;
                        matchSource = "proveedor_en_filename";
                        break;
                      }
                    }
                  }
                }
              }

              // === Etapa 4.B: LLM fallback (descargar PDF + identificar) ==
              if (!matchedNum && process.env.ANTHROPIC_API_KEY) {
                try {
                  const llmMatchedNum = await matchHuerfanoConLlm(
                    drive,
                    h.drive_file_id,
                    fname,
                    eventsAll.map((e) => e.payload),
                    numsEnSheetCur,
                  );
                  if (llmMatchedNum) {
                    matchedNum = llmMatchedNum;
                    matchSource = "llm";
                  }
                } catch (err: any) {
                  console.warn(
                    `[reparador-4B] LLM falló para ${fname}: ${err.message}`,
                  );
                }
              }

              if (!matchedNum) continue;
              if (numsEnSheetCur.has(matchedNum)) continue;

              const p = eventsByNum.get(matchedNum) ??
                eventsAll.find((e) => String(e.payload?.numero ?? "").trim() === matchedNum)?.payload;
              if (!p) continue;
              // marcar source en log
              console.log(
                `[reparador-3B/4] cliente=${c.slug} #${matchedNum} ← ${fname} (${matchSource})`,
              );
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

      // === ETAPA 5: Validación cruzada 5 fuentes (Bloque B) ====================
      // Después de auto-reparar, valida que las 4 fuentes principales cuadren:
      // Gmail, Drive, Sheet, Events. Si no cuadran, marca al cliente como
      // inconsistente para alerta.
      try {
        const validacion = await validarCincoFuentes({
          clienteSlug: c.slug,
          clienteId: c.id,
          year,
          mesActual,
          tabName,
          gmail,
          drive,
          sheets,
          supa,
          cred,
          monthFolderId: monthFolderIdRef,
        });
        report.validaciones.push(validacion);
        if (!validacion.todo_cuadra) {
          report.clientes_inconsistentes.push(c.slug);
          console.log(`[reparador-5] cliente=${c.slug} INCONSISTENTE: ${validacion.discrepancias.join(" | ")}`);
        }
      } catch (vErr: any) {
        console.warn(`[reparador-5] validación falló para ${c.slug}: ${vErr.message}`);
      }

      report.clientes_procesados++;
    } catch (err: any) {
      console.error(`[reparador] error cliente=${c.slug}: ${err.message}`);
      report.errores.push({ cliente_slug: c.slug, error: err.message });
    }
  }

  return report;
}

/**
 * Validación cruzada 5 fuentes (Bloque B).
 * Cuenta facturas en cada fuente y reporta discrepancias.
 */
async function validarCincoFuentes(ctx: {
  clienteSlug: string;
  clienteId: string;
  year: number;
  mesActual: number;
  tabName: string;
  gmail: any;
  drive: any;
  sheets: any;
  supa: any;
  cred: any;
  monthFolderId: string | null;
}): Promise<ValidacionClienteCliente> {
  const mes = `${ctx.year}-${String(ctx.mesActual).padStart(2, "0")}`;
  const labelName = `Facturas/${mes}`;

  // 1. Gmail count
  let gmailCount = 0;
  try {
    const res = await ctx.gmail.users.messages.list({
      userId: "me",
      q: `label:"${labelName}"`,
      maxResults: 500,
    });
    gmailCount = res.data.messages?.length ?? 0;
  } catch {
    /* 0 */
  }

  // 2. Drive count (PDFs en folder del mes, excluyendo XML)
  let driveCount = 0;
  if (ctx.monthFolderId) {
    try {
      const res = await ctx.drive.files.list({
        q: `'${ctx.monthFolderId}' in parents and trashed=false and mimeType='application/pdf'`,
        fields: "files(id)",
        pageSize: 1000,
      });
      driveCount = res.data.files?.length ?? 0;
    } catch {
      /* 0 */
    }
  }

  // 3. Sheet count
  let sheetCount = 0;
  try {
    const res = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: ctx.cred.sheet_id,
      range: `'${ctx.tabName}'!A2:A1000`,
    });
    sheetCount = (res.data.values || []).filter((row: any) => row[0] && String(row[0]).trim()).length;
  } catch {
    /* 0 */
  }

  // 4. Events count (DB)
  let eventsCount = 0;
  const startDate = `${mes}-01`;
  const endDate =
    ctx.mesActual === 12
      ? `${ctx.year + 1}-01-01`
      : `${ctx.year}-${String(ctx.mesActual + 1).padStart(2, "0")}-01`;
  try {
    const { count } = await ctx.supa
      .from("agent_events")
      .select("*", { count: "exact", head: true })
      .eq("cliente_id", ctx.clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", startDate)
      .lt("payload->>fecha", endDate);
    eventsCount = count ?? 0;
  } catch {
    /* 0 */
  }

  // Comparar
  const discrepancias: string[] = [];
  if (gmailCount !== sheetCount) {
    discrepancias.push(`gmail(${gmailCount})≠sheet(${sheetCount})`);
  }
  if (driveCount !== sheetCount) {
    discrepancias.push(`drive(${driveCount})≠sheet(${sheetCount})`);
  }
  if (eventsCount !== sheetCount) {
    discrepancias.push(`events(${eventsCount})≠sheet(${sheetCount})`);
  }

  return {
    cliente_slug: ctx.clienteSlug,
    mes,
    gmail: gmailCount,
    drive: driveCount,
    sheet: sheetCount,
    events: eventsCount,
    todo_cuadra: discrepancias.length === 0,
    discrepancias,
  };
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

/**
 * Normaliza texto para comparación fuzzy:
 *   - lowercase
 *   - sin tildes
 *   - sin "S.A.", "S.A.S.", "Ltda", "LTDA", "SAS", "S.A.S"
 *   - sin signos de puntuación / espacios extras
 *   - colapsa espacios múltiples
 */
function normalizeText(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // sin tildes
    .toLowerCase()
    .replace(/\bs\.?\s*a\.?\s*s?\.?\b/gi, "")     // S.A. / S.A.S. / SAS
    .replace(/\bltda\.?\b/gi, "")                  // Ltda
    .replace(/\bsociedad\b/gi, "")
    .replace(/\bp\.?\s*h\.?\b/gi, "")              // P.H.
    .replace(/[.,;:|()/\\-]/g, " ")                // puntuación
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrae el nombre del proveedor del filename siguiendo el patrón típico que
 * usa el cron: "N. Proveedor Nombre.pdf" o "N. Proveedor Nombre - Detalle.pdf".
 * Devuelve null si no matchea el patrón.
 */
function extractProveedorFromFilename(filename: string): string | null {
  // Quitar extensión
  const base = filename.replace(/\.(pdf|docx|xml)$/i, "");
  // Patrón "N. Proveedor" o "N.M Proveedor" o "Proveedor" (sin N.)
  const m = base.match(/^\s*\d+(?:\.\d+)?\.\s*(.+)$/);
  if (m) return m[1].trim();
  // Si no tiene N. prefix, devolver el base entero (puede ser solo proveedor)
  return base.trim() || null;
}

/**
 * Etapa 4.B: descarga el PDF, extrae texto, llama al LLM para identificar la
 * factura, y matchea contra events del cliente.
 *
 * Retorna el N° factura del event matcheado, o null si no encuentra match.
 */
async function matchHuerfanoConLlm(
  drive: any,
  fileId: string,
  fileName: string,
  eventsPayloads: any[],
  numsEnSheet: Set<string>,
): Promise<string | null> {
  // 1. Skip si filename termina en .docx (no soportamos por ahora — son cuentas de cobro)
  if (fileName.toLowerCase().endsWith(".docx")) return null;
  if (!fileName.toLowerCase().endsWith(".pdf")) return null;

  // 2. Descargar el PDF a /tmp
  const tmpPath = `/tmp/reparador-${fileId}.pdf`;
  try {
    const resp = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    const fs = await import("node:fs");
    fs.writeFileSync(tmpPath, Buffer.from(resp.data as ArrayBuffer));
  } catch (err: any) {
    console.warn(`[reparador-4B] download falló: ${err.message}`);
    return null;
  }

  // 3. Extraer texto con pdf-parse (reusando helper del pipeline)
  let text = "";
  try {
    const { extractTextFromPdf } = await import(
      "../../../agentes/Equipo-facturacion/lib/doc-parsers"
    );
    text = await extractTextFromPdf(tmpPath);
  } catch {
    /* ignorar */
  }
  // Cleanup
  try {
    const fs = await import("node:fs");
    fs.unlinkSync(tmpPath);
  } catch {
    /* ignorar */
  }
  if (!text || text.length < 30) return null;

  // 4. Llamar al LLM para extraer datos del PDF
  let extracted: { proveedor?: string; numero?: string; total?: number; fecha?: string } | null = null;
  try {
    const { extractInvoiceFromText } = await import(
      "../../../agentes/Equipo-facturacion/lib/llm-extractor"
    );
    extracted = await extractInvoiceFromText({
      text: text.slice(0, 8000),
      presumedType: "recibo_servicio",
      filename: fileName,
      sender: "(unknown)",
      subject: fileName,
      emailDate: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[reparador-4B] LLM extract falló: ${err.message}`);
    return null;
  }
  if (!extracted || !extracted.proveedor) return null;

  // 5. Matchear contra events: prioridad por número exacto, después por
  //    proveedor + monto similar.
  const provExtractedNorm = normalizeText(extracted.proveedor);
  const totalExtracted = Number(extracted.total ?? 0);

  // 5a) match exacto por número
  if (extracted.numero) {
    const nNorm = String(extracted.numero).trim();
    for (const p of eventsPayloads) {
      const pNum = String(p?.numero ?? "").trim();
      if (pNum && pNum === nNorm && !numsEnSheet.has(pNum)) return pNum;
    }
  }

  // 5b) match por proveedor + monto (±5% tolerancia)
  for (const p of eventsPayloads) {
    const pProvNorm = normalizeText(String(p?.proveedor ?? ""));
    if (!pProvNorm) continue;
    const provMatch =
      pProvNorm === provExtractedNorm ||
      pProvNorm.startsWith(provExtractedNorm) ||
      provExtractedNorm.startsWith(pProvNorm);
    if (!provMatch) continue;
    const pTotal = Number(p?.total ?? 0);
    if (totalExtracted > 0 && pTotal > 0) {
      const diff = Math.abs(pTotal - totalExtracted) / Math.max(pTotal, totalExtracted);
      if (diff > 0.05) continue; // > 5% diferencia → skip
    }
    const pNum = String(p?.numero ?? "").trim();
    if (pNum && !numsEnSheet.has(pNum)) return pNum;
  }

  return null;
}

/**
 * Genera variantes del N° de factura para mejorar matching en filenames.
 * Filenames suelen tener padding ('00123') o prefijo ('FE-123'). La fila
 * en Sheet puede tener el número "limpio" ('123'). Probamos múltiples.
 */
function generarVariantesNumero(num: string): string[] {
  const variantes = new Set<string>();
  variantes.add(num);
  const soloDigitos = num.replace(/\D/g, "");
  if (soloDigitos && soloDigitos !== num) variantes.add(soloDigitos);
  // Sin ceros a la izquierda
  const sinPadding = soloDigitos.replace(/^0+/, "");
  if (sinPadding && sinPadding !== soloDigitos) variantes.add(sinPadding);
  // Con padding de 4, 5, 6 dígitos
  if (sinPadding && sinPadding.length < 6) {
    variantes.add(sinPadding.padStart(4, "0"));
    variantes.add(sinPadding.padStart(5, "0"));
    variantes.add(sinPadding.padStart(6, "0"));
  }
  return Array.from(variantes).filter((v) => v.length >= 3); // filtra ruido < 3 chars
}
