// Edge function: /auth/google/start
//
// Inicia el flujo OAuth de Google Workspace para un cliente con onboarding token válido.
// Redirige al user a la página de consentimiento de Google con state=<token>.

import type { Context } from "@netlify/edge-functions";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
];

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, _context: Context) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("missing token query param", { status: 400 });
  }

  // 1. Validar el onboarding token contra Supabase (anon key + RPC público)
  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";

  const valResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/onboarding_token_lookup`,
    {
      method: "POST",
      headers: {
        apikey: supabaseAnon,
        Authorization: `Bearer ${supabaseAnon}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_token: token }),
    },
  );

  if (!valResp.ok) {
    return new Response(`token validation failed: ${valResp.status}`, {
      status: 500,
    });
  }

  const rows = await valResp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return new Response("invalid or expired token", { status: 404 });
  }

  // 2. Construir URL de consentimiento Google
  const clientId = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_ID");
  const adminUrl = Netlify.env.get("ADMIN_SITE_URL") ?? url.origin;

  if (!clientId) {
    return new Response("server misconfigured: GOOGLE_OAUTH_WEB_CLIENT_ID missing", {
      status: 500,
    });
  }

  const redirectUri = `${adminUrl}/api/auth/google/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // siempre solicitar refresh_token
    state: token,
    include_granted_scopes: "true",
  });

  const consentUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // 3. Redirigir al user
  return Response.redirect(consentUrl, 302);
};
