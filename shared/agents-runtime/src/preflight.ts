/**
 * Pre-flight validation antes de ejecutar el pipeline de un cliente.
 *
 * Hoy si las credenciales OAuth caducaron, el Drive folder fue borrado, el
 * Sheet ya no existe, o Gmail API está retornando errores, nos enteramos
 * recién cuando el pipeline está mitad camino — perdemos contexto y dejamos
 * el Sheet/Drive en estado parcial.
 *
 * Pre-flight chequea las 4 dependencias críticas con 4 llamadas baratas
 * antes de empezar a procesar. Si alguna falla, retorna error específico
 * con acción sugerida — y el run aborta limpiamente sin tocar nada.
 *
 * Costo: ~2-4s, 4 llamadas API por run. Negligible vs el run que evita.
 */

import { google } from "googleapis";

export interface PreflightConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  driveFolderId: string;
  sheetId: string;
}

export interface PreflightOk {
  ok: true;
  durationMs: number;
}

export interface PreflightFail {
  ok: false;
  /** Cuál check falló — para classify the error en el panel admin. */
  check: "oauth" | "drive_folder" | "sheet" | "gmail";
  /** Mensaje técnico para logs. */
  message: string;
  /** Sugerencia accionable para mostrar al admin. */
  hint: string;
  durationMs: number;
}

export type PreflightResult = PreflightOk | PreflightFail;

/**
 * Corre los 4 chequeos pre-flight secuencialmente. Para temprano al primer
 * error — no hay razón de seguir si el OAuth ya falló (todos los demás
 * van a fallar igual).
 */
export async function runPreflight(cfg: PreflightConfig): Promise<PreflightResult> {
  const t0 = Date.now();

  // 1. OAuth: ¿el refresh_token todavía da access_token válido?
  //
  // RETRY CON BACKOFF — bug detectado 2026-05-15: cuando el cron dispara
  // muchos clientes al mismo tiempo, Google rate-limita el endpoint OAuth
  // por client_id (compartido entre todos los clientes via shared Web Client
  // de Operatto) y devuelve `invalid_grant` transitorio a algunos. El error
  // es indistinguible (mismo string) del "token realmente revocado", lo
  // que causaba falsos positivos y emails alarmantes.
  //
  // Solución: si falla con invalid_grant en el PRIMER intento, esperamos
  // 1.5-2s con jitter y reintentamos. Si vuelve a fallar, sí es real.
  const auth = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
  auth.setCredentials({ refresh_token: cfg.refreshToken });

  const MAX_OAUTH_ATTEMPTS = 2;
  let lastErr: any = null;
  let tokenResult: string | null = null;
  for (let attempt = 1; attempt <= MAX_OAUTH_ATTEMPTS; attempt++) {
    try {
      const { token } = await auth.getAccessToken();
      if (token) {
        tokenResult = token;
        break;
      }
      lastErr = new Error("getAccessToken returned no token");
    } catch (err: any) {
      lastErr = err;
      const isInvalidGrant =
        err.message?.includes("invalid_grant") ||
        err.response?.data?.error === "invalid_grant";
      // Solo reintentar invalid_grant (los demás errores son determinísticos
      // — credentials mal configuradas, etc — no mejoran con retry).
      if (!isInvalidGrant || attempt >= MAX_OAUTH_ATTEMPTS) break;
      // Backoff con jitter para no sincronizar reintentos entre clientes
      const delay = 1500 + Math.floor(Math.random() * 1000);
      console.warn(
        `[preflight] oauth invalid_grant attempt ${attempt}/${MAX_OAUTH_ATTEMPTS} — retry in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (!tokenResult) {
    const err = lastErr;
    const isInvalidGrant =
      err?.message?.includes("invalid_grant") ||
      err?.response?.data?.error === "invalid_grant";
    return {
      ok: false,
      check: "oauth",
      message: `OAuth refresh failed (${MAX_OAUTH_ATTEMPTS} attempts): ${err?.message ?? "unknown"}`,
      hint: isInvalidGrant
        ? "Cliente revocó permisos o el token está vencido. Mandar link de re-onboarding."
        : "Verificar GOOGLE_OAUTH_WEB_CLIENT_ID/SECRET en env vars del site.",
      durationMs: Date.now() - t0,
    };
  }

  // 2. Drive folder: ¿existe y no está trashed?
  const drive = google.drive({ version: "v3", auth });
  try {
    const fileResp = await drive.files.get({
      fileId: cfg.driveFolderId,
      fields: "id,name,trashed,mimeType",
    });
    const f = fileResp.data as { trashed?: boolean; mimeType?: string };
    if (f.trashed) {
      return {
        ok: false,
        check: "drive_folder",
        message: `Drive folder ${cfg.driveFolderId} está trashed`,
        hint: "El cliente envió la carpeta a la papelera. Restaurarla en Drive o re-onboardar.",
        durationMs: Date.now() - t0,
      };
    }
    if (f.mimeType !== "application/vnd.google-apps.folder") {
      return {
        ok: false,
        check: "drive_folder",
        message: `Drive resource ${cfg.driveFolderId} no es folder (mime=${f.mimeType})`,
        hint: "El ID guardado no es una carpeta válida. Revisar client_credentials.drive_folder_id.",
        durationMs: Date.now() - t0,
      };
    }
  } catch (err: any) {
    const status = err.response?.status ?? err.code;
    if (status === 404) {
      return {
        ok: false,
        check: "drive_folder",
        message: `Drive folder ${cfg.driveFolderId} no existe (404)`,
        hint: "Folder borrado permanentemente. Cliente debe re-hacer onboarding o admin debe crear uno nuevo.",
        durationMs: Date.now() - t0,
      };
    }
    if (status === 403) {
      return {
        ok: false,
        check: "drive_folder",
        message: `Drive folder ${cfg.driveFolderId} sin permisos (403)`,
        hint: "El cliente revocó permisos de Drive sin revocar el OAuth completo. Re-onboardar.",
        durationMs: Date.now() - t0,
      };
    }
    return {
      ok: false,
      check: "drive_folder",
      message: `Drive folder check failed: ${err.message}`,
      hint: "Error transitorio de Drive API. Si persiste, verificar el folder en drive.google.com manualmente.",
      durationMs: Date.now() - t0,
    };
  }

  // 3. Sheet: ¿existe y es spreadsheet?
  const sheets = google.sheets({ version: "v4", auth });
  try {
    const sheetResp = await sheets.spreadsheets.get({
      spreadsheetId: cfg.sheetId,
      fields: "spreadsheetId,properties.title",
    });
    if (!sheetResp.data.spreadsheetId) {
      return {
        ok: false,
        check: "sheet",
        message: `Sheet ${cfg.sheetId} no devolvió spreadsheetId`,
        hint: "Sheet posiblemente trashed o inaccesible. Verificar en sheets.google.com.",
        durationMs: Date.now() - t0,
      };
    }
  } catch (err: any) {
    const status = err.response?.status ?? err.code;
    if (status === 404) {
      return {
        ok: false,
        check: "sheet",
        message: `Sheet ${cfg.sheetId} no existe (404)`,
        hint: "Sheet borrado o ID guardado incorrecto. Admin debe crear uno nuevo y actualizar client_credentials.",
        durationMs: Date.now() - t0,
      };
    }
    if (status === 403) {
      return {
        ok: false,
        check: "sheet",
        message: `Sheet ${cfg.sheetId} sin permisos (403)`,
        hint: "Cliente revocó permisos a este Sheet. Re-onboardar.",
        durationMs: Date.now() - t0,
      };
    }
    return {
      ok: false,
      check: "sheet",
      message: `Sheet check failed: ${err.message}`,
      hint: "Error transitorio de Sheets API. Si persiste, verificar manualmente.",
      durationMs: Date.now() - t0,
    };
  }

  // 4. Gmail: ¿la cuenta responde? — query barata con maxResults=1
  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.list({
      userId: "me",
      maxResults: 1,
    });
  } catch (err: any) {
    const status = err.response?.status ?? err.code;
    if (status === 403) {
      return {
        ok: false,
        check: "gmail",
        message: `Gmail API forbidden (403): ${err.message}`,
        hint: "Cliente revocó permisos de Gmail. Re-onboardar.",
        durationMs: Date.now() - t0,
      };
    }
    if (status === 429 || status === 503) {
      return {
        ok: false,
        check: "gmail",
        message: `Gmail API rate limited (${status})`,
        hint: "Quota de Gmail temporalmente excedida. Esperar 60s y reintentar.",
        durationMs: Date.now() - t0,
      };
    }
    return {
      ok: false,
      check: "gmail",
      message: `Gmail check failed: ${err.message}`,
      hint: "Error transitorio de Gmail API. Verificar status.google.com.",
      durationMs: Date.now() - t0,
    };
  }

  return { ok: true, durationMs: Date.now() - t0 };
}

/**
 * Format del resultado de preflight para incluir en agent_runs.payload.
 * Estructura estable para que el panel admin lo lea consistentemente.
 */
export function preflightToPayload(result: PreflightResult): Record<string, unknown> {
  if (result.ok) {
    return { preflight: { ok: true, duration_ms: result.durationMs } };
  }
  return {
    preflight: {
      ok: false,
      check: result.check,
      message: result.message,
      hint: result.hint,
      duration_ms: result.durationMs,
    },
  };
}
