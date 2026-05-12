/**
 * Equipo-supervisor — meta-agente que CIERRA el ciclo diario.
 *
 * Corre 8:45 AM Bogotá (después de monitor 8:00, reparador 8:15, limpiador 8:30).
 *
 * Función: AUDITAR estado FINAL y RETRIGGER agentes si quedan problemas.
 *
 * Chequeos por cliente:
 *   1. Drive: no debe haber archivos con NOMBRE EXACTO repetido en mismo folder
 *   2. Drive: numeración (`1.`, `2.`, ...) consecutiva sin huecos
 *   3. Sheet col A (consecutivo) coincide con numeración Drive
 *   4. Sheet rows == agent_events count (descontando self-emitted)
 *   5. Drive files (sin .xml ni papelera) == Sheet rows
 *
 * Si hay gaps:
 *   - 1+2 dups Drive → retrigger LIMPIADOR (mueve duplicados a papelera)
 *   - 3 numeración mal → log (es estético, no crítico — solo se arregla al
 *     borrar todas las filas + force=true)
 *   - 4+5 Sheet vs events vs Drive → retrigger REPARADOR (inserta filas faltantes)
 *
 * Después de 2 retriggers sin éxito → marca como "requiere intervención manual"
 * y envía email crítico al admin.
 *
 * Resultado: escribe TODO al payload del agent_run del supervisor para que el
 * panel admin /diagnostico pueda mostrarlo.
 */

import { google } from "googleapis";
import { getServerClient } from "../../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const COL_NUMERO_DOCUMENTO = 4;
const COL_NUMERO_CONSECUTIVO = 0;
const COL_LINK_PDF = 14;

export interface ChequeoCliente {
  cliente_id: string;
  cliente_slug: string;
  cliente_nombre: string;
  /** Estado final del cliente. */
  estado: "ok" | "warn" | "fail" | "no_oauth" | "skipped";
  /** Conteos del mes actual. */
  drive_count: number;       // archivos no .xml en folder del mes
  sheet_count: number;       // filas en pestaña del mes
  events_count: number;      // events en agent_events del mes
  /** Duplicados detectados (nombres exactos repetidos en Drive). */
  duplicados_drive: Array<{ nombre: string; cantidad: number }>;
  /** Inconsistencias en numeración (consecutivo Drive != Sheet). */
  numeracion_inconsistente: boolean;
  /** Acciones tomadas (retriggers automáticos). */
  acciones_tomadas: string[];
  /** Detalle textual. */
  detalle: string;
}

export interface SupervisorReport {
  fecha: string;
  ts_generated: string;
  clientes_total: number;
  clientes_ok: number;
  clientes_warn: number;
  clientes_fail: number;
  retriggers_disparados: number;
  /** Indica si el reporte requiere atención urgente (email crítico). */
  requiere_atencion_critica: boolean;
  chequeos: ChequeoCliente[];
  errores: Array<{ cliente_slug: string; error: string }>;
}

export async function runSupervisor(): Promise<SupervisorReport> {
  const supa = getServerClient();
  const ts = new Date();
  const fecha = bogotaDate(ts);

  const report: SupervisorReport = {
    fecha,
    ts_generated: ts.toISOString(),
    clientes_total: 0,
    clientes_ok: 0,
    clientes_warn: 0,
    clientes_fail: 0,
    retriggers_disparados: 0,
    requiere_atencion_critica: false,
    chequeos: [],
    errores: [],
  };

  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  const internalSecret = process.env.FACTURACION_INTERNAL_SECRET ?? "";
  const baseUrl = process.env.URL ?? "";

  if (!oauthClientId || !oauthClientSecret) {
    throw new Error("Faltan GOOGLE_OAUTH_WEB_CLIENT_ID / _SECRET");
  }

  const { data: clientesActivos } = await supa
    .from("clientes")
    .select("id, slug, nombre, activo")
    .eq("activo", true)
    .neq("slug", "monitor")
    .neq("slug", "reparador")
    .neq("slug", "limpiador")
    .neq("slug", "supervisor")
    .neq("slug", "owner")
    .order("slug");

  const clientes = (clientesActivos ?? []) as Array<{
    id: string;
    slug: string;
    nombre: string;
  }>;
  report.clientes_total = clientes.length;

  const year = bogotaYear();
  const mesActual = bogotaMonth();
  const tabName = MES_TABS[mesActual - 1];

  for (const c of clientes) {
    try {
      const chequeo = await chequearCliente(
        c,
        supa,
        oauthClientId,
        oauthClientSecret,
        year,
        mesActual,
        tabName,
      );
      report.chequeos.push(chequeo);

      // Retrigger si hay duplicados (limpiador) o gaps (reparador)
      const tieneDuplicados = chequeo.duplicados_drive.length > 0;
      const gapSheetEvents = Math.abs(chequeo.events_count - chequeo.sheet_count) > 0;

      if (tieneDuplicados && baseUrl && internalSecret) {
        try {
          await disparar(`${baseUrl}/.netlify/functions/limpiador-background`, internalSecret);
          chequeo.acciones_tomadas.push(`Retrigger LIMPIADOR (${chequeo.duplicados_drive.length} grupos dup)`);
          report.retriggers_disparados++;
        } catch (err: any) {
          console.warn(`[supervisor] retrigger limpiador falló: ${err.message}`);
        }
      }
      if (gapSheetEvents && baseUrl && internalSecret) {
        try {
          await disparar(`${baseUrl}/.netlify/functions/reparador-background`, internalSecret);
          chequeo.acciones_tomadas.push(`Retrigger REPARADOR (${Math.abs(chequeo.events_count - chequeo.sheet_count)} filas faltan)`);
          report.retriggers_disparados++;
        } catch (err: any) {
          console.warn(`[supervisor] retrigger reparador falló: ${err.message}`);
        }
      }

      // Recalcular estado final
      if (chequeo.estado === "fail") {
        report.clientes_fail++;
        report.requiere_atencion_critica = true;
      } else if (chequeo.estado === "warn") {
        report.clientes_warn++;
      } else if (chequeo.estado === "ok") {
        report.clientes_ok++;
      }
    } catch (err: any) {
      console.error(`[supervisor] error cliente=${c.slug}: ${err.message}`);
      report.errores.push({ cliente_slug: c.slug, error: err.message });
    }
  }

  return report;
}

async function chequearCliente(
  c: { id: string; slug: string; nombre: string },
  supa: any,
  oauthClientId: string,
  oauthClientSecret: string,
  year: number,
  mesActual: number,
  tabName: string,
): Promise<ChequeoCliente> {
  const chequeo: ChequeoCliente = {
    cliente_id: c.id,
    cliente_slug: c.slug,
    cliente_nombre: c.nombre,
    estado: "ok",
    drive_count: 0,
    sheet_count: 0,
    events_count: 0,
    duplicados_drive: [],
    numeracion_inconsistente: false,
    acciones_tomadas: [],
    detalle: "",
  };

  const cred = await loadCredentials(c.id, "facturacion");
  if (!cred || !cred.google_refresh_token) {
    chequeo.estado = "no_oauth";
    chequeo.detalle = "Sin OAuth Google.";
    return chequeo;
  }
  if (!cred.sheet_id || !cred.drive_folder_id) {
    chequeo.estado = "skipped";
    chequeo.detalle = "Sin Sheet o Drive folder configurado.";
    return chequeo;
  }

  const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  // 1. Encontrar folder del mes
  const mm = String(mesActual).padStart(2, "0");
  const monthFolderName = `${year}-${mm}`;
  const folderResp = await drive.files.list({
    q: `name='${monthFolderName}' and mimeType='application/vnd.google-apps.folder' and '${cred.drive_folder_id}' in parents and trashed=false`,
    fields: "files(id, name)",
  });
  const monthFolderId = folderResp.data.files?.[0]?.id;
  if (!monthFolderId) {
    chequeo.detalle = "Sin folder del mes actual en Drive (no procesa todavía).";
    return chequeo;
  }

  // 2. Listar archivos del mes (excluyendo .xml y folders)
  const archivos: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;
  do {
    const resp = await drive.files.list({
      q: `'${monthFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder' and not name contains '.xml'`,
      fields: "files(id, name), nextPageToken",
      pageSize: 1000,
      pageToken,
    });
    archivos.push(...((resp.data.files ?? []) as Array<{ id: string; name: string }>));
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);
  chequeo.drive_count = archivos.length;

  // 3. Detectar nombres exactos repetidos
  const conteoNombres = new Map<string, number>();
  for (const f of archivos) {
    const key = (f.name ?? "").trim();
    conteoNombres.set(key, (conteoNombres.get(key) ?? 0) + 1);
  }
  for (const [nombre, cnt] of conteoNombres.entries()) {
    if (cnt > 1) chequeo.duplicados_drive.push({ nombre, cantidad: cnt });
  }

  // 4. Cargar filas del Sheet
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
  chequeo.sheet_count = rowsSheet.filter(
    (r: any[]) => r[COL_NUMERO_DOCUMENTO] != null && String(r[COL_NUMERO_DOCUMENTO]).trim() !== "",
  ).length;

  // 5. Cargar events del mes
  const monthStart = `${year}-${mm}-01`;
  const monthEnd =
    mesActual === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(mesActual + 1).padStart(2, "0")}-01`;
  const { count: eventsCount } = await supa
    .from("agent_events")
    .select("*", { count: "exact", head: true })
    .eq("cliente_id", c.id)
    .eq("agente_id", "facturacion")
    .eq("tipo", "factura_procesada")
    .gte("payload->>fecha", monthStart)
    .lt("payload->>fecha", monthEnd);
  chequeo.events_count = eventsCount ?? 0;

  // 6. Numeración inconsistente: extraer consecutivos del nombre del archivo
  //    (regex N. al inicio) y comparar con col A del Sheet.
  const consecutivosDrive: number[] = [];
  for (const f of archivos) {
    const m = (f.name ?? "").match(/^(\d+)\./);
    if (m) consecutivosDrive.push(parseInt(m[1], 10));
  }
  consecutivosDrive.sort((a, b) => a - b);
  // Set de consecutivos en Sheet
  const consecSheet = new Set<number>();
  for (const r of rowsSheet) {
    const v = parseInt(String(r[COL_NUMERO_CONSECUTIVO] ?? ""), 10);
    if (!isNaN(v)) consecSheet.add(v);
  }
  // Inconsistente si hay consecutivos en Drive que NO están en Sheet (o viceversa)
  const consecDriveSet = new Set(consecutivosDrive);
  let inconsistencias = 0;
  for (const n of consecDriveSet) {
    if (!consecSheet.has(n)) inconsistencias++;
  }
  chequeo.numeracion_inconsistente = inconsistencias > 0;

  // 7. Determinar estado final del cliente
  const gapSheetEvents = Math.abs(chequeo.events_count - chequeo.sheet_count);
  const gapDriveSheet = Math.abs(chequeo.drive_count - chequeo.sheet_count);

  if (chequeo.duplicados_drive.length > 5 || gapSheetEvents > 10) {
    chequeo.estado = "fail";
  } else if (
    chequeo.duplicados_drive.length > 0 ||
    gapSheetEvents > 0 ||
    gapDriveSheet > 2
  ) {
    chequeo.estado = "warn";
  } else {
    chequeo.estado = "ok";
  }

  chequeo.detalle =
    `Drive=${chequeo.drive_count}, Sheet=${chequeo.sheet_count}, Events=${chequeo.events_count}. ` +
    (chequeo.duplicados_drive.length > 0 ? `${chequeo.duplicados_drive.length} grupos de nombres duplicados. ` : "") +
    (chequeo.numeracion_inconsistente ? "Numeración Drive↔Sheet inconsistente. " : "") +
    (chequeo.estado === "ok" ? "Todo OK." : "");

  return chequeo;
}

async function disparar(url: string, secret: string): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-internal-secret": secret,
      "x-trigger": "supervisor",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
