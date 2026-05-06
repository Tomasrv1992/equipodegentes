// Edge function: /auth/google/callback
//
// Recibe el code de Google, lo intercambia por refresh_token, lo encripta
// y guarda en Supabase. Después redirige al user a la siguiente etapa
// del onboarding (selección de Drive folder + Sheet).

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, _context: Context) => {
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
  };

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

  // 5. Avanzar el step del onboarding token a 'oauth_done'
  const advResp = await fetch(
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
  if (!advResp.ok) {
    console.warn("advance step failed:", await advResp.text());
    // no-fatal, redirect anyway
  }

  // 6. Redirigir al user al paso 2 del onboarding (selección de Drive + Sheet)
  return Response.redirect(`${adminUrl}/onboarding/${state}?oauth=ok`, 302);
};
