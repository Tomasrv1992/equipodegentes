// Edge function: /api/onboarding/drive-list
//
// Lista carpetas Drive del cliente para que elija dónde guardar facturas.
// Auth: onboarding token en header (no Supabase login).
//
// Body: { token: string, parentId?: string }
// Output: { folders: [{ id, name, parents }] }

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

  let body: { token: string; parentId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (!body.token) return json({ error: "missing token" }, 400);

  // 1. Validar token y obtener cliente_id, agente_id
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
  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: "invalid token" }, 404);
  }
  const ob = rows[0] as { cliente_id: string; agente_id: string };

  // 2. Cargar refresh_token del cliente
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
  if (!cred?.google_refresh_token) {
    return json({ error: "no refresh_token (run OAuth first)" }, 400);
  }

  // 3. Obtener access_token fresh con el refresh_token
  const accessToken = await refreshAccessToken(
    cred.google_refresh_token,
    googleClientId,
    googleClientSecret,
  );
  if (!accessToken) return json({ error: "could not refresh access token" }, 500);

  // 4. Listar carpetas Drive
  const parentClause = body.parentId
    ? `'${body.parentId}' in parents`
    : "'root' in parents";
  const driveQuery = `mimeType = 'application/vnd.google-apps.folder' and ${parentClause} and trashed = false`;
  const driveResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(driveQuery)}&fields=files(id,name,parents)&pageSize=100&orderBy=name`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!driveResp.ok) {
    const txt = await driveResp.text();
    return json({ error: `drive api error: ${driveResp.status}`, details: txt }, 500);
  }
  const driveData = (await driveResp.json()) as { files: Array<{ id: string; name: string; parents?: string[] }> };

  return json({ folders: driveData.files });
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
