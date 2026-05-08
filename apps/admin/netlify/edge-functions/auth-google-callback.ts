// Edge function: /auth/google/callback
//
// Recibe el code de Google, lo intercambia por refresh_token, lo encripta
// y guarda en Supabase. Después redirige al user a la siguiente etapa
// del onboarding (selección de Drive folder + Sheet).

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const adminUrl = Netlify.env.get("ADMIN_SITE_URL") ?? url.origin;

  if (error) {
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=${encodeURIComponent(error)}`,
      302,
    );
  }

  if (!code || !state) {
    return new Response("missing code or state", { status: 400 });
  }

  // 1. Validar token y obtener cliente_id, agente_id
  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const vaultKey = Netlify.env.get("CREDENTIALS_VAULT_KEY") ?? "";
  const clientId = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_ID") ?? "";
  const clientSecret = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_SECRET") ?? "";

  if (!supabaseUrl || !serviceKey || !vaultKey || !clientId || !clientSecret) {
    return new Response("server misconfigured (env vars)", { status: 500 });
  }

  const valResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/onboarding_token_lookup`,
    {
      method: "POST",
      headers: {
        apikey: supabaseAnon,
        Authorization: `Bearer ${supabaseAnon}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_token: state }),
    },
  );
  if (!valResp.ok) return new Response("token validation failed", { status: 500 });
  const rows = await valResp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return new Response("invalid or expired token", { status: 404 });
  }
  const onboarding = rows[0] as {
    cliente_id: string;
    agente_id: string;
    cliente_slug: string;
    step?: string;
  };

  // 1.5. Si el token ya fue completado, redirigir al frontend SIN re-procesar.
  //      Evita que un cliente que abre el link 2 veces (o reenvía el callback)
  //      sobreescriba folder/sheet con nuevos recursos cada vez.
  if (onboarding.step === "completed") {
    console.log(`callback: token ya completado para ${onboarding.cliente_slug} — skip re-OAuth`);
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?oauth=ok&completed=1`,
      302,
    );
  }

  // 2. Intercambiar code por tokens
  const redirectUri = `${adminUrl}/api/auth/google/callback`;
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    const txt = await tokenResp.text();
    console.error("token exchange failed:", txt);
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=oauth_exchange_failed`,
      302,
    );
  }

  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    scope: string;
    token_type: string;
    id_token?: string;
    expires_in: number;
  };

  if (!tokens.refresh_token) {
    // Sin refresh_token no podemos correr crons. Google solo lo da en el primer
    // consent. Si el user ya autorizó antes, debe revocar en myaccount.google.com
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=no_refresh_token`,
      302,
    );
  }

  // 3. Obtener email Google del user (para guardar como info)
  const userInfoResp = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  const userInfo = userInfoResp.ok
    ? ((await userInfoResp.json()) as { email?: string })
    : { email: undefined };

  // 4. Guardar refresh_token encriptado en client_credentials (RPC)
  const saveResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/client_credentials_save_oauth`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_cliente_id: onboarding.cliente_id,
        p_agente_id: onboarding.agente_id,
        p_refresh_token: tokens.refresh_token,
        p_google_email: userInfo.email ?? null,
        p_scopes: tokens.scope ? tokens.scope.split(" ") : null,
        p_vault_key: vaultKey,
      }),
    },
  );

  if (!saveResp.ok) {
    const txt = await saveResp.text();
    console.error("save oauth failed:", txt);
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=save_failed`,
      302,
    );
  }

  // 5. AUTO-CREAR carpeta Drive + Sheet (skip paso 2 manual)
  //    Operatto crea la carpeta y el Sheet a nombre del cliente, sin fricción.
  //    El cliente sofisticado podrá editarlo desde el panel admin después
  //    si lo necesita.
  let folderId: string | null = null;
  let folderName: string | null = null;
  let sheetId: string | null = null;
  let sheetName: string | null = null;

  try {
    // Get cliente nombre para naming
    const cliResp = await fetch(
      `${supabaseUrl}/rest/v1/clientes?id=eq.${onboarding.cliente_id}&select=nombre`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    const cliRows = (await cliResp.json()) as Array<{ nombre: string }>;
    const clienteNombre = cliRows[0]?.nombre || onboarding.cliente_slug;

    folderName = `Facturas ${clienteNombre} - Operatto`;
    sheetName = `Control Facturas ${clienteNombre}`;

    // 5a. Crear carpeta en Drive root
    const folderResp = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      }),
    });
    if (!folderResp.ok) {
      throw new Error(`drive folder create: ${await folderResp.text()}`);
    }
    folderId = ((await folderResp.json()) as { id: string }).id;

    // 5b. Crear Sheet dentro de la carpeta
    const sheetResp = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: sheetName,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [folderId],
      }),
    });
    if (!sheetResp.ok) {
      throw new Error(`sheet create: ${await sheetResp.text()}`);
    }
    sheetId = ((await sheetResp.json()) as { id: string }).id;
  } catch (e: any) {
    console.error("auto-create resources failed:", e.message);
    // Si falla la auto-creación, redirigir al paso 2 manual (fallback)
    await fetch(
      `${supabaseUrl}/rest/v1/onboarding_tokens?token=eq.${encodeURIComponent(state)}`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ step: "oauth_done" }),
      },
    );
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?oauth=ok&autocreate_failed=1`,
      302,
    );
  }

  // 6. Update client_credentials con los recursos auto-creados
  const upResp = await fetch(
    `${supabaseUrl}/rest/v1/client_credentials?cliente_id=eq.${onboarding.cliente_id}&agente_id=eq.${onboarding.agente_id}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        drive_folder_id: folderId,
        drive_folder_name: folderName,
        sheet_id: sheetId,
        sheet_name: sheetName,
        notify_email: userInfo.email ?? null,
        onboarded_at: new Date().toISOString(),
      }),
    },
  );
  if (!upResp.ok) {
    console.warn("update client_credentials failed:", await upResp.text());
  }

  // 7. Marcar onboarding token como COMPLETED (skip paso 2)
  await fetch(
    `${supabaseUrl}/rest/v1/onboarding_tokens?token=eq.${encodeURIComponent(state)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        step: "completed",
        completed_at: new Date().toISOString(),
      }),
    },
  );

  // 8. Disparar el primer run en background.
  //    Edge functions cancelan los fetches pendientes cuando el handler retorna.
  //    Para evitarlo: o await del fetch (esperamos 2-3s) o usar context.waitUntil
  //    si está disponible. Vamos con AWAIT — el redirect inmediato no nos sirve
  //    si el dispatch silenciosamente falla (Patricia onboardeó OK pero quedó sin run).
  //
  //    El dispatch a Netlify background fn devuelve 202 inmediato; esperar el
  //    response no bloquea — solo confirma que el server recibió la petición.
  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (mainSiteUrl && internalSecret && onboarding.agente_id === "facturacion") {
    try {
      const dispatchResp = await fetch(`${mainSiteUrl}/.netlify/functions/facturacion-background`, {
        method: "POST",
        headers: {
          "x-internal-secret": internalSecret,
          "x-trigger": "onboarding",
          "content-type": "application/json",
        },
        body: JSON.stringify({ customerId: onboarding.cliente_slug }),
      });
      console.log(`[first-run] cliente=${onboarding.cliente_slug} dispatch status=${dispatchResp.status}`);
    } catch (e: any) {
      console.warn(`[first-run] dispatch failed (no-fatal): ${e.message}`);
    }
  }

  // 9. Redirect — el frontend detecta step='completed' y muestra StepDone
  return Response.redirect(`${adminUrl}/onboarding/${state}?oauth=ok&completed=1`, 302);
};
