// Edge function: /api/admin/create-onboarding-link
//
// Tomás (logueado) llama este endpoint para crear un onboarding_token nuevo
// y obtener el link único que va a mandar al cliente por WhatsApp/email.
//
// Auth: JWT Supabase + email = ALLOWED_EMAIL.

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

interface Body {
  clienteId: string;
  agenteId: string;
}

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const adminUrl = Netlify.env.get("ADMIN_SITE_URL") ?? new URL(request.url).origin;
  const allowedEmail =
    Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

  // 1. Validar JWT del usuario logueado
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);

  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnon },
  });
  if (!userResp.ok) return json({ error: "invalid token" }, 401);
  const user = (await userResp.json()) as { email?: string };
  if (user.email !== allowedEmail) return json({ error: "forbidden" }, 403);

  // 2. Parsear body
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.clienteId || !body.agenteId) {
    return json({ error: "missing clienteId or agenteId" }, 400);
  }

  // 3. Generar token URL-safe (32 bytes → 43 chars base64url)
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const onboardingToken = base64url(tokenBytes);

  // 4. Insertar en onboarding_tokens (con service_role)
  const expires = new Date();
  expires.setDate(expires.getDate() + 7);

  const insResp = await fetch(`${supabaseUrl}/rest/v1/onboarding_tokens`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      token: onboardingToken,
      cliente_id: body.clienteId,
      agente_id: body.agenteId,
      expires_at: expires.toISOString(),
      created_by: user.email ?? null,
    }),
  });

  if (!insResp.ok) {
    const txt = await insResp.text();
    return json({ error: `insert failed: ${txt}` }, 500);
  }

  const link = `${adminUrl}/onboarding/${onboardingToken}`;
  return json({ token: onboardingToken, link, expiresAt: expires.toISOString() });
};

function base64url(bytes: Uint8Array): string {
  // Browser/Edge runtime: Uint8Array → base64url
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
