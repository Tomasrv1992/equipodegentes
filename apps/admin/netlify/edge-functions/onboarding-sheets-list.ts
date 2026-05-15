// Edge function: /api/onboarding/sheets-list
//
// Lista los Google Sheets del cliente para que elija el de control de facturas.
// Auth: onboarding token. Mismo patrón que drive-list.

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const vaultKey = Netlify.env.get("CREDENTIALS_VAULT_KEY") ?? "";
  const googleClientId = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_ID") ?? "";
  const googleClientSecret = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_SECRET") ?? "";

  if (!supabaseUrl || !serviceKey || !vaultKey) {
    return json({ error: "server misconfigured" }, 500);
  }

  let body: { token: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.token) return json({ error: "missing token" }, 400);

  // 1. Validar token
  const valResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/onboarding_token_lookup`,
    {
      method: "POST",
      headers: {
        apikey: supabaseAnon,
        Authorization: `Bearer ${supabaseAnon}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_token: body.token }),
    },
  );
  if (!valResp.ok) return json({ error: "token validation failed" }, 500);
  const rows = await valResp.json();
  if (!Array.isArray(rows) || rows.length === 0) return json({ error: "invalid token" }, 404);
  const ob = rows[0] as { cliente_id: string; agente_id: string };

  // 2. Cargar refresh_token
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
        p_cliente_id: ob.cliente_id,
        p_agente_id: ob.agente_id,
        p_vault_key: vaultKey,
      }),
    },
  );
  if (!credResp.ok) return json({ error: "load credentials failed" }, 500);
  const credRows = await credResp.json();
  const cred = Array.isArray(credRows) ? credRows[0] : null;
  if (!cred?.google_refresh_token) return json({ error: "no refresh_token" }, 400);

  // 3. Refresh access token
  const accessToken = await refreshAccessToken(
    cred.google_refresh_token,
    googleClientId,
    googleClientSecret,
  );
  if (!accessToken) return json({ error: "refresh failed" }, 500);

  // 4. Listar Sheets (mimeType = spreadsheet)
  const driveQuery =
    "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
  const driveResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(driveQuery)}&fields=files(id,name,modifiedTime)&pageSize=100&orderBy=modifiedTime desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!driveResp.ok) return json({ error: `drive error ${driveResp.status}` }, 500);
  const data = (await driveResp.json()) as {
    files: Array<{ id: string; name: string; modifiedTime: string }>;
  };

  return json({ sheets: data.files });
};

async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { access_token?: string };
  return data.access_token ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
