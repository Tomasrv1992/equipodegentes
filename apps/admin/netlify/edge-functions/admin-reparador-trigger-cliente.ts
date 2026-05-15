// Edge function: /api/admin/reparador-trigger-cliente
//
// Dispara el reparador-background sin esperar al próximo cron diario (8:15am)
// SOLO para el cliente especificado (el reparador acepta clienteSlugFilter
// y skipea todos los demás). Más rápido + menos costo Gmail/Drive API.
//
// Útil cuando Tomás quiere re-validar la salud del archivo de un cliente
// después de hacer cambios manuales (mover archivos en Drive, editar Sheet,
// re-procesar facturas, etc).
//
// Auth: JWT admin.
// Body: { clienteSlug: string } — se reenvía al reparador-background como filtro

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
  const clienteSlug = (body.clienteSlug ?? "").trim();

  // Fire-and-forget — background fn devuelve 202 inmediato, procesa hasta 15min
  fetch(endpoint, {
    method: "POST",
    headers: {
      "x-internal-secret": internalSecret,
      "x-trigger": "admin-revalidar",
      "content-type": "application/json",
    },
    body: clienteSlug
      ? JSON.stringify({ clienteSlug })
      : JSON.stringify({}),
  }).catch(() => {});

  return new Response(
    JSON.stringify({
      ok: true,
      dispatched: "reparador-background",
      filter: clienteSlug || null,
      note: clienteSlug
        ? `Reparador corriendo solo para ${clienteSlug} — datos se refrescan en ~1-2 min.`
        : "Reparador corre para todos los clientes — datos en ~5-10 min.",
    }),
    { headers: { "content-type": "application/json" } },
  );
};
