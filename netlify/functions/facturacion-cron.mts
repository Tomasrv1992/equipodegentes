// netlify/functions/facturacion-cron.mts
//
// Scheduled function: dispara diario 7am Bogotá (12:00 UTC) al background worker.
// Pattern: cron stub (timeout 30s, usa <2s) → background fn (timeout 15min).

import type { Config } from "@netlify/functions";

export default async (req: Request) => {
  const baseUrl = process.env.URL; // inyectado por Netlify automáticamente
  const secret = process.env.FACTURACION_INTERNAL_SECRET;

  if (!baseUrl || !secret) {
    console.error("Falta env: URL o FACTURACION_INTERNAL_SECRET");
    return new Response("misconfigured", { status: 500 });
  }

  const target = `${baseUrl}/.netlify/functions/facturacion-background`;

  const res = await fetch(target, {
    method: "POST",
    headers: {
      "x-internal-secret": secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({}), // single-tenant: sin customerId
  });

  // Background fn responde 202 (Accepted) inmediatamente
  console.log(JSON.stringify({
    triggered_at: new Date().toISOString(),
    target,
    background_response_status: res.status,
  }));

  return new Response(
    JSON.stringify({ triggered: true, status: res.status }),
    { headers: { "content-type": "application/json" } }
  );
};

export const config: Config = {
  schedule: "0 12 * * *", // 7am Bogotá (UTC-5). Cron es UTC.
};
