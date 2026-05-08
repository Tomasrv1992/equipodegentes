// Edge function: /api/admin/health-check
//
// Proxy autenticado del frontend admin al health-check del cron site.
// Verifica JWT del admin (mismo que admin-trigger-rerun) y reenvía con
// x-internal-secret al cron site.
//
// El frontend nunca ve el secret; el secret solo vive en env vars del admin site.

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Validar JWT de Supabase (sesión del admin)
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("missing auth", { status: 401 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const allowedEmail = Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: supabaseAnon,
    },
  });
  if (!userResp.ok) return new Response("invalid token", { status: 401 });
  const user = await userResp.json();
  if (user.email !== allowedEmail) {
    return new Response("forbidden", { status: 403 });
  }

  // 2. Parsear body
  let body: { customerId: string; year?: number; agenteId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.customerId) return json({ error: "missing customerId" }, 400);

  // 3. Reenviar al cron site con x-internal-secret
  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (!mainSiteUrl || !internalSecret) {
    return json({ error: "server misconfigured" }, 500);
  }

  const resp = await fetch(`${mainSiteUrl}/.netlify/functions/health-check`, {
    method: "POST",
    headers: {
      "x-internal-secret": internalSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      customerId: body.customerId,
      agenteId: body.agenteId ?? "facturacion",
      year: body.year ?? new Date().getFullYear(),
    }),
  });

  const result = await resp.json();
  return json(result, resp.status);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
