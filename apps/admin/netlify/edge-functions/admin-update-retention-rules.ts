// Edge function: /api/admin/update-retention-rules
//
// Actualiza las reglas de retención fiscal (retention_rules + municipio_ica) de
// un cliente. Solo el admin (validado por JWT de Supabase) puede llamar.
//
// POST body: {
//   clienteId: string,
//   agenteId?: string (default "facturacion"),
//   retention_rules: { ... },
//   municipio_ica: string | null
// }

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

interface Body {
  clienteId: string;
  agenteId?: string;
  retention_rules: unknown;
  municipio_ica: string | null;
  nit_cliente?: string | null;
}

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  // 1. Validar JWT de admin
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("missing auth", { status: 401 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.clienteId) return json({ error: "missing clienteId" }, 400);
  if (!body.retention_rules) return json({ error: "missing retention_rules" }, 400);

  const agenteId = body.agenteId ?? "facturacion";

  // 3. PATCH a client_credentials
  const upResp = await fetch(
    `${supabaseUrl}/rest/v1/client_credentials?cliente_id=eq.${body.clienteId}&agente_id=eq.${agenteId}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        retention_rules: body.retention_rules,
        municipio_ica: body.municipio_ica,
        // Solo actualizar nit_cliente si vino explícitamente en el body (undefined
        // significa "no tocar"; null significa "borrar"; string significa "setear").
        ...(body.nit_cliente !== undefined ? { nit_cliente: body.nit_cliente } : {}),
      }),
    },
  );

  if (!upResp.ok) {
    const txt = await upResp.text();
    return json({ error: `update failed: ${txt}` }, 500);
  }

  return json({ ok: true });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
