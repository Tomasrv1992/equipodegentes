// Edge function: /api/admin/rebuild-sheet-cliente
//
// Dispara rebuild-sheet-from-events-background para regenerar el Sheet de un
// cliente desde agent_events. Útil para limpiar duplicación masiva (caso real
// 2026-05-15: bug del supervisor causó 316× duplicación en Sheet Freshco).
//
// Auth: JWT admin.
// Body: {
//   clienteSlug: string,
//   year?: number,
//   monthFilter?: number,   // opcional 1..12 — regenerar solo ese mes
//   dryRun?: boolean,
// }

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Auth admin JWT
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

  let body: {
    clienteSlug?: string;
    year?: number;
    monthFilter?: number;
    dryRun?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const clienteSlug = (body.clienteSlug ?? "").trim();
  if (!clienteSlug) {
    return new Response("missing clienteSlug", { status: 400 });
  }

  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (!mainSiteUrl || !internalSecret) {
    return new Response("server misconfigured", { status: 500 });
  }

  const endpoint = `${mainSiteUrl}/.netlify/functions/rebuild-sheet-from-events-background`;

  // Fire-and-forget — background fn devuelve 202 inmediato, procesa hasta 15min
  fetch(endpoint, {
    method: "POST",
    headers: {
      "x-internal-secret": internalSecret,
      "x-trigger": "admin-rebuild-sheet",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      clienteSlug,
      year: body.year,
      monthFilter: body.monthFilter,
      dryRun: !!body.dryRun,
    }),
  }).catch(() => {});

  return new Response(
    JSON.stringify({
      ok: true,
      dispatched: "rebuild-sheet-from-events-background",
      clienteSlug,
      year: body.year ?? null,
      monthFilter: body.monthFilter ?? null,
      dryRun: !!body.dryRun,
      note: body.dryRun
        ? "Dry-run: el background NO toca el Sheet, solo reporta qué haría."
        : "Regenerando Sheet desde events. Toma 1-5 min según volumen del cliente.",
    }),
    { headers: { "content-type": "application/json" } },
  );
};
