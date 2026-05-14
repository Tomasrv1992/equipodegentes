// Edge function: /api/admin/client-preflight
//
// Permite al admin (Tomás) correr el preflight on-demand sobre un cliente
// específico, sin esperar al próximo cron. Ideal para validar antes de
// onboardear oficialmente, después de re-enviar OAuth, o cuando algo huele
// mal.
//
// El backend pre-flight vive en shared/agents-runtime, pero Edge Functions
// no pueden importar googleapis (no es Deno-compatible). Por eso replicamos
// los 4 chequeos acá con fetch directo a las APIs REST de Google.
//
// Auth: JWT admin (mismo flow que admin-trigger-rerun).
// Body: { clienteSlug: string }
// Output: {
//   ok: boolean,
//   results: Array<{ check, ok, message, hint, durationMs }>,
//   total_ms: number
// }

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

interface CheckResult {
  check: "oauth" | "drive_folder" | "sheet" | "gmail";
  ok: boolean;
  message: string;
  hint?: string;
  durationMs: number;
}

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // 1. Auth admin
  const auth = request.headers.get("authorization") ?? "";
  const tokenJwt = auth.replace(/^Bearer\s+/i, "");
  if (!tokenJwt) return json({ error: "missing auth" }, 401);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const vaultKey = Netlify.env.get("CREDENTIALS_VAULT_KEY") ?? "";
  const googleClientId = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_ID") ?? "";
  const googleClientSecret = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_SECRET") ?? "";
  const allowedEmail =
    Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

  if (!supabaseUrl || !serviceKey || !vaultKey) {
    return json({ error: "server misconfigured" }, 500);
  }

  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${tokenJwt}`,
      apikey: supabaseAnon,
    },
  });
  if (!userResp.ok) return json({ error: "invalid token" }, 401);
  const user = await userResp.json();
  if (user.email !== allowedEmail) return json({ error: "forbidden" }, 403);

  // 2. Body
  let body: { clienteSlug?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const clienteSlug = (body.clienteSlug ?? "").trim();
  if (!clienteSlug) return json({ error: "missing clienteSlug" }, 400);

  const totalT0 = Date.now();

  // 3. Resolver cliente_id desde slug
  const cliResp = await fetch(
    `${supabaseUrl}/rest/v1/clientes?slug=eq.${encodeURIComponent(clienteSlug)}&select=id`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const cliRows = (await cliResp.json()) as Array<{ id: string }>;
  const cliente = cliRows[0];
  if (!cliente) return json({ error: "cliente no encontrado" }, 404);

  // 4. Cargar credenciales
  const credResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/client_credentials_load`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_cliente_id: cliente.id,
        p_agente_id: "facturacion",
        p_vault_key: vaultKey,
      }),
    },
  );
  const credRows = await credResp.json();
  const cred = Array.isArray(credRows) ? credRows[0] : null;
  if (!cred?.google_refresh_token) {
    return json(
      {
        ok: false,
        results: [
          {
            check: "oauth",
            ok: false,
            message: "Sin refresh_token guardado",
            hint: "El cliente no completó OAuth. Mandar link de onboarding.",
            durationMs: 0,
          },
        ],
        total_ms: Date.now() - totalT0,
      },
      200,
    );
  }

  const results: CheckResult[] = [];

  // === Check 1: OAuth refresh → access_token ===
  const t1 = Date.now();
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: cred.google_refresh_token,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      grant_type: "refresh_token",
    }),
  });
  let accessToken: string | null = null;
  if (!tokenResp.ok) {
    const txt = await tokenResp.text();
    const isInvalidGrant = txt.includes("invalid_grant");
    results.push({
      check: "oauth",
      ok: false,
      message: `${tokenResp.status} ${txt.slice(0, 200)}`,
      hint: isInvalidGrant
        ? "Cliente revocó permisos o token vencido. Mandar link de re-onboarding."
        : "Verificar GOOGLE_OAUTH_WEB_CLIENT_ID/SECRET en env vars del site.",
      durationMs: Date.now() - t1,
    });
    // OAuth falló → no tiene sentido seguir
    return json(
      { ok: false, results, total_ms: Date.now() - totalT0 },
      200,
    );
  }
  const tokenData = (await tokenResp.json()) as { access_token?: string };
  accessToken = tokenData.access_token ?? null;
  if (!accessToken) {
    results.push({
      check: "oauth",
      ok: false,
      message: "Token response sin access_token",
      hint: "Respuesta inesperada de Google OAuth. Reintentar.",
      durationMs: Date.now() - t1,
    });
    return json({ ok: false, results, total_ms: Date.now() - totalT0 }, 200);
  }
  results.push({
    check: "oauth",
    ok: true,
    message: "OK",
    durationMs: Date.now() - t1,
  });

  // === Check 2: Drive folder ===
  const t2 = Date.now();
  if (!cred.drive_folder_id) {
    results.push({
      check: "drive_folder",
      ok: false,
      message: "Sin drive_folder_id guardado",
      hint: "Onboarding incompleto. El cliente debe terminar el wizard.",
      durationMs: Date.now() - t2,
    });
  } else {
    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${cred.drive_folder_id}?fields=id,name,trashed,mimeType`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (driveResp.ok) {
      const f = (await driveResp.json()) as {
        trashed?: boolean;
        mimeType?: string;
        name?: string;
      };
      if (f.trashed) {
        results.push({
          check: "drive_folder",
          ok: false,
          message: `Folder "${f.name}" está trashed`,
          hint: "Cliente envió la carpeta a la papelera. Restaurarla o re-onboardar.",
          durationMs: Date.now() - t2,
        });
      } else if (f.mimeType !== "application/vnd.google-apps.folder") {
        results.push({
          check: "drive_folder",
          ok: false,
          message: `Resource no es folder (mime=${f.mimeType})`,
          hint: "El ID guardado no apunta a una carpeta. Re-onboardar.",
          durationMs: Date.now() - t2,
        });
      } else {
        results.push({
          check: "drive_folder",
          ok: true,
          message: `OK (${f.name})`,
          durationMs: Date.now() - t2,
        });
      }
    } else {
      const status = driveResp.status;
      results.push({
        check: "drive_folder",
        ok: false,
        message: `Drive API ${status}: ${(await driveResp.text()).slice(0, 200)}`,
        hint:
          status === 404
            ? "Folder borrado. Crear uno nuevo y actualizar client_credentials."
            : status === 403
              ? "Sin permisos a Drive. Re-onboardar."
              : "Error transitorio. Reintentar.",
        durationMs: Date.now() - t2,
      });
    }
  }

  // === Check 3: Sheet ===
  const t3 = Date.now();
  if (!cred.sheet_id) {
    results.push({
      check: "sheet",
      ok: false,
      message: "Sin sheet_id guardado",
      hint: "Onboarding incompleto. Re-onboardar.",
      durationMs: Date.now() - t3,
    });
  } else {
    const sheetResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${cred.sheet_id}?fields=spreadsheetId,properties.title`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (sheetResp.ok) {
      const s = (await sheetResp.json()) as {
        spreadsheetId?: string;
        properties?: { title?: string };
      };
      if (s.spreadsheetId) {
        results.push({
          check: "sheet",
          ok: true,
          message: `OK (${s.properties?.title ?? "sin título"})`,
          durationMs: Date.now() - t3,
        });
      } else {
        results.push({
          check: "sheet",
          ok: false,
          message: "Respuesta sin spreadsheetId",
          hint: "Sheet posiblemente trashed. Verificar en sheets.google.com.",
          durationMs: Date.now() - t3,
        });
      }
    } else {
      const status = sheetResp.status;
      results.push({
        check: "sheet",
        ok: false,
        message: `Sheets API ${status}: ${(await sheetResp.text()).slice(0, 200)}`,
        hint:
          status === 404
            ? "Sheet borrado o ID incorrecto. Crear uno nuevo."
            : status === 403
              ? "Sin permisos al Sheet. Re-onboardar."
              : "Error transitorio. Reintentar.",
        durationMs: Date.now() - t3,
      });
    }
  }

  // === Check 4: Gmail ===
  const t4 = Date.now();
  const gmailResp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (gmailResp.ok) {
    results.push({
      check: "gmail",
      ok: true,
      message: "OK",
      durationMs: Date.now() - t4,
    });
  } else {
    const status = gmailResp.status;
    results.push({
      check: "gmail",
      ok: false,
      message: `Gmail API ${status}: ${(await gmailResp.text()).slice(0, 200)}`,
      hint:
        status === 403
          ? "Cliente revocó permisos de Gmail. Re-onboardar."
          : status === 429 || status === 503
            ? "Quota temporalmente excedida. Esperar 60s."
            : "Error transitorio. Verificar status.google.com.",
      durationMs: Date.now() - t4,
    });
  }

  const allOk = results.every((r) => r.ok);
  return json(
    { ok: allOk, results, total_ms: Date.now() - totalT0 },
    200,
  );
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
