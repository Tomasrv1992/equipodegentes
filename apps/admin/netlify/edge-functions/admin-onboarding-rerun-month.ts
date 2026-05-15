// Edge function: /api/admin/onboarding-rerun-month
//
// Re-dispara el procesamiento de un mes específico para un cliente en
// onboarding (o ya onboarded). Útil cuando el fan-out original tuvo un
// mes con error/timeout y queremos retrabajar SOLO ese mes sin afectar
// los otros.
//
// Auth: JWT admin (mismo flow que admin-trigger-rerun).
//
// Body: { clienteSlug: string, monthFilter: number /* 1..12 */ }

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Auth admin
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("missing auth", { status: 401 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const allowedEmail =
    Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

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

  // 2. Body
  let body: { clienteSlug?: string; monthFilter?: number };
  try {
    body = await request.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const clienteSlug = (body.clienteSlug ?? "").trim();
  const monthFilter = Number(body.monthFilter);
  if (!clienteSlug) {
    return new Response("missing clienteSlug", { status: 400 });
  }
  if (!Number.isFinite(monthFilter) || monthFilter < 1 || monthFilter > 12) {
    return new Response("monthFilter must be 1..12", { status: 400 });
  }

  // 3. Dispatch al background con monthFilter + force + notifyMonthComplete
  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (!mainSiteUrl || !internalSecret) {
    return new Response("server misconfigured", { status: 500 });
  }

  const endpoint = `${mainSiteUrl}/.netlify/functions/facturacion-background`;
  // No esperamos — background fn devuelve 202 inmediato.
  fetch(endpoint, {
    method: "POST",
    headers: {
      "x-internal-secret": internalSecret,
      "x-trigger": "admin-rerun-month",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      customerId: clienteSlug,
      monthFilter,
      // force=true para que re-lea emails con label Procesado (sin esto solo
      // procesaría facturas nuevas no procesadas; pero el caso de uso es
      // "el mes falló a medio camino", entonces queremos re-leer todo).
      force: true,
      // Email diario suprimido — se trata de un retry interno, no de un run regular.
      silent: true,
      // Sí mandar el "Listo {mes}" cuando termine — feedback al cliente.
      notifyMonthComplete: true,
      // Skip setup del Sheet — ya está hecho (sino consume quota inútil).
      skipSheetSetup: true,
    }),
  }).catch(() => {});

  return new Response(
    JSON.stringify({
      ok: true,
      dispatched: { clienteSlug, monthFilter },
    }),
    { headers: { "content-type": "application/json" } },
  );
};
