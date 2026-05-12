/**
 * Coincidencia Gmail/Drive/Sheet por cliente.
 *
 * Para cada cliente con OAuth válido, cuenta del MES ACTUAL:
 *   - Emails con label "Procesado" en Gmail
 *   - Archivos en folder Drive del mes
 *   - Filas con datos en Sheet pestaña del mes
 *
 * Si los 3 difieren más de cierto umbral relativo, marca alerta.
 *
 * Esto detecta:
 *   - Cron procesó email pero no llegó al Sheet (bug pipeline)
 *   - Drive sin algunos PDFs (permisos)
 *   - Sheet con filas que no corresponden a emails procesados (limpieza manual)
 */

import { google } from "googleapis";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export interface CoincidenciaResult {
  gmail_count: number;
  drive_count: number;
  sheet_count: number;
  /** Mes (1-12) en zona Bogotá al que apuntan los conteos. */
  mes_actual: number;
  /** True si los 3 difieren más del umbral (configurable). */
  alerta: boolean;
  /** Texto corto para el reporte. */
  detalle: string;
  /** Error si falló la query. */
  error?: string;
}

/**
 * Tolerancia de diferencia entre Drive y Sheet (cada factura debe tener su PDF
 * en Drive). Si difieren más de este % relativo, alerta.
 * Gmail NO se compara (incluye emails procesados pero descartados como
 * "no-factura" por el LLM → siempre será mucho mayor que Sheet/Drive).
 */
const UMBRAL_DIFERENCIA = 0.30;

/**
 * Cuenta items en Gmail / Drive / Sheet del mes actual para un cliente.
 *
 * @param ctx OAuth + IDs del cliente
 * @returns conteos + flag de alerta
 */
export async function chequearCoincidencia(ctx: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  driveFolderId: string | null;
  sheetId: string | null;
}): Promise<CoincidenciaResult> {
  const mesActual = bogotaMonth();
  const tabName = MES_TABS[mesActual - 1];

  const result: CoincidenciaResult = {
    gmail_count: 0,
    drive_count: 0,
    sheet_count: 0,
    mes_actual: mesActual,
    alerta: false,
    detalle: "",
  };

  try {
    const auth = new google.auth.OAuth2(ctx.clientId, ctx.clientSecret);
    auth.setCredentials({ refresh_token: ctx.refreshToken });

    const gmail = google.gmail({ version: "v1", auth });
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    // === 1) Gmail: emails con label "Procesado" del mes actual ============
    // Query: label:Procesado AND after:YYYY/MM/01 AND before:YYYY/MM/lastday
    const { yearStart, yearEnd } = bogotaMonthRange(mesActual);
    const gmailQuery = `label:Procesado after:${yearStart} before:${yearEnd}`;
    let gmailCount = 0;
    let pageToken: string | undefined;
    do {
      const resp = await gmail.users.messages.list({
        userId: "me",
        q: gmailQuery,
        maxResults: 500,
        pageToken,
      });
      gmailCount += resp.data.messages?.length ?? 0;
      pageToken = resp.data.nextPageToken ?? undefined;
    } while (pageToken);
    result.gmail_count = gmailCount;

    // === 2) Drive: archivos en folder "YYYY-MM" hijo del folder principal ==
    // Estructura: driveFolderId / YYYY-MM / *.pdf
    // IMPORTANTE: solo contamos archivos PDF/XML reales, EXCLUYENDO subcarpetas
    // (sino el conteo se infla porque Drive trata folders como files).
    if (ctx.driveFolderId) {
      const year = bogotaYear();
      const mm = String(mesActual).padStart(2, "0");
      const monthFolderName = `${year}-${mm}`;
      // Buscar subfolder del mes
      const monthFolderResp = await drive.files.list({
        q: `name='${monthFolderName}' and mimeType='application/vnd.google-apps.folder' and '${ctx.driveFolderId}' in parents and trashed=false`,
        fields: "files(id, name)",
      });
      const monthFolderId = monthFolderResp.data.files?.[0]?.id;
      if (monthFolderId) {
        let driveCount = 0;
        let driveToken: string | undefined;
        do {
          const filesResp = await drive.files.list({
            // mimeType != folder → solo archivos reales (pdf, xml, docx)
            q: `'${monthFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
            fields: "files(id, mimeType), nextPageToken",
            pageSize: 1000,
            pageToken: driveToken,
          });
          driveCount += filesResp.data.files?.length ?? 0;
          driveToken = filesResp.data.nextPageToken ?? undefined;
        } while (driveToken);
        result.drive_count = driveCount;
      }
    }

    // === 3) Sheet: filas de datos en pestaña del mes ======================
    if (ctx.sheetId) {
      const rangeResp = await sheets.spreadsheets.values.get({
        spreadsheetId: ctx.sheetId,
        range: `'${tabName}'!A2:A1000`, // col A = N°, salteando header
        majorDimension: "ROWS",
      });
      const rows = rangeResp.data.values ?? [];
      // Contar solo filas con valor (no vacías)
      result.sheet_count = rows.filter((r: any[]) => r[0] != null && r[0] !== "").length;
    }

    // === 4) Evaluar diferencias ============================================
    // Comparamos SOLO Drive vs Sheet (cada factura en Sheet debe tener su PDF
    // en Drive — esos 2 sí deben coincidir).
    // Gmail es siempre mayor porque incluye emails procesados PERO descartados
    // por el LLM como "no factura" (newsletters con adjunto, recibos no
    // facturables, etc). Solo lo mostramos como referencia, no genera alerta.
    const driveN = result.drive_count;
    const sheetN = result.sheet_count;
    const maxCount = Math.max(driveN, sheetN);
    const minCount = Math.min(driveN, sheetN);
    if (maxCount === 0) {
      result.detalle = `Sin actividad este mes (Drive y Sheet en 0).`;
      result.alerta = false;
    } else {
      const diffRel = (maxCount - minCount) / maxCount;
      if (diffRel > UMBRAL_DIFERENCIA) {
        result.alerta = true;
        result.detalle = `Discrepancia Drive↔Sheet: Drive=${driveN}, Sheet=${sheetN} (${(diffRel * 100).toFixed(0)}% dif). Gmail=${result.gmail_count} (info, incluye no-facturas).`;
      } else {
        result.detalle = `Drive=${driveN} ≈ Sheet=${sheetN} ✓ · Gmail=${result.gmail_count} (incl. no-facturas).`;
      }
    }
  } catch (err: any) {
    result.error = err.message ?? String(err);
    result.detalle = `Error al chequear: ${result.error}`;
  }

  return result;
}

/** Mes actual en zona Bogotá (1-12). */
function bogotaMonth(): number {
  const now = new Date();
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  return new Date(bogotaMs).getUTCMonth() + 1;
}

function bogotaYear(): number {
  const now = new Date();
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  return new Date(bogotaMs).getUTCFullYear();
}

/** Rango "YYYY/MM/DD" del mes actual para el query Gmail. */
function bogotaMonthRange(mes: number): { yearStart: string; yearEnd: string } {
  const year = bogotaYear();
  const mm = String(mes).padStart(2, "0");
  const lastDay = new Date(year, mes, 0).getDate();
  return {
    yearStart: `${year}/${mm}/01`,
    yearEnd: `${year}/${mm}/${String(lastDay).padStart(2, "0")}`,
  };
}
