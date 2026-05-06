import type { Context } from "@netlify/edge-functions";

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Validar JWT de Supabase
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("missing auth", { status: 401 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const allowedEmail = Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: Netlify.env.get("SUPABASE_ANON_KEY") ?? "",
    },
  });
  if (!userResp.ok) return new Response("invalid token", { status: 401 });
  const user = await userResp.json();
  if (user.email !== allowedEmail) {
    return new Response("forbidden", { status: 403 });
  }

  // 2. Parsear body
  const { runId } = (await request.json()) as { runId: string };
  if (!runId) return new Response("missing runId", { status: 400 });

  // 3. Buscar el run (cliente_id + agente_id) usando service role
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const runResp = await fetch(
    `${supabaseUrl}/rest/v1/agent_runs?id=eq.${runId}&select=cliente_id,agente_id`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Accept-Profile": "equipodegentes",
      },
    }
  );
  const runs = await runResp.json();
  const run = Array.isArray(runs) ? runs[0] : null;
  if (!run) return new Response("run not found", { status: 404 });

  // 4. Resolver slug del cliente
  const cliResp = await fetch(
    `${supabaseUrl}/rest/v1/clientes?id=eq.${run.cliente_id}&select=slug`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Accept-Profile": "equipodegentes",
      },
    }
  );
  const cli = (await cliResp.json())[0];
  const clienteSlug = cli?.slug ?? "owner";

  // 5. Mapear agente a endpoint del sitio principal
  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (!mainSiteUrl || !internalSecret) {
    return new Response("server misconfigured", { status: 500 });
  }

  const endpoint = run.agente_id === "facturacion"
    ? `${mainSiteUrl}/.netlify/functions/facturacion-background`
    : null;

  if (!endpoint) {
    return new Response(`agent ${run.agente_id} no soporta re-disparo aún`, { status: 501 });
  }

  // 6. Disparar (no esperar — background fn devuelve 202 inmediato)
  fetch(endpoint, {
    method: "POST",
    headers: {
      "x-internal-secret": internalSecret,
      "x-trigger": "rerun",
      "content-type": "application/json",
    },
    body: JSON.stringify({ customerId: clienteSlug === "owner" ? undefined : clienteSlug }),
  }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, dispatched: endpoint }), {
    headers: { "content-type": "application/json" },
  });
};
