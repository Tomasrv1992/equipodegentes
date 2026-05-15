// Edge function: /api/admin/reparador-trigger-cliente
//
// Dispara el reparador-background sin esperar al próximo cron diario (8:15am).
// Útil cuando Tomás quiere re-validar la salud del archivo de un cliente
// después de hacer cambios manuales (mover archivos en Drive, editar Sheet,
// re-procesar facturas, etc).
//
// Nota: el reparador corre globalmente (para todos los clientes en su run),
// no acepta filtro por cliente. El parámetro clienteSlug es informativo —
// solo para que el cliente que dispara sepa que su data se va a refrescar
// junto con la de los demás.
//
// Auth: JWT admin.
// Body: { clienteSlug: string } (informativo)

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Auth admin
  const auth = request.headers.get("authorization") ?? "";
  const tokenJwt = auth.replace(/^Bearer\s+/i, "");
  if (!tokenJwt) return new Response("missing auth", { status: 401 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const allowedEmail =
    Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${tokenJwt}`,
      apikey: Netlify.env.get("SUPABASE_ANON_KEY") ?? "",
    },
  });
  if (!userResp.ok) return new Response("invalid token", { status: 401 });
  const user = await userResp.json();
  if (user.email !== allowedEmail) {
    return new Response("forbidden", { status: 403 });
  }

  // 2. Body (clienteSlug es informativo — el reparador corre global)
  let body: { clienteSlug?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // 3. Dispatch al reparador-background
  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (!mainSiteUrl || !internalSecret) {
    return new Response("server misconfigured", { status: 500 });
  }

  const endpoint = `${mainSiteUrl}/.netlify/functions/reparador-background`;
  // Fire-and-forget — background fn devuelve 202 inmediato, procesa hasta 15min
  fetch(endpoint, {
    method: "POST",
    headers: {
      "x-internal-secret": internalSecret,
      "x-trigger": "admin-revalidar",
      "content-type": "application/json",
    },
  }).catch(() => {});

  return new Response(
    JSON.stringify({
      ok: true,
      dispatched: "reparador-background",
      note: "Reparador corre para todos los clientes — datos de " +
        (body.clienteSlug ?? "tu cliente") +
        " se refrescan junto con los demás en ~5-10 min.",
    }),
    { headers: { "content-type": "application/json" } },
  );
};
