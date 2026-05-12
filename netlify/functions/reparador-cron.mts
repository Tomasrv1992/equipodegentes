// netlify/functions/reparador-cron.mts
//
// Scheduled function: corre todos los días a las 8:15am Bogotá (13:15 UTC).
// 15 min después del monitor (8:00am), para no solaparse y dar tiempo al
// monitor a terminar su check.

import type { Config } from "@netlify/functions";

export default async (_req: Request) => {
  const baseUrl = process.env.URL;
  const secret = process.env.FACTURACION_INTERNAL_SECRET;

  if (!baseUrl || !secret) {
    console.error("[reparador-cron] falta env: URL o FACTURACION_INTERNAL_SECRET");
    return new Response("misconfigured", { status: 500 });
  }

  const target = `${baseUrl}/.netlify/functions/reparador-background`;
  const triggeredAt = new Date().toISOString();

  console.log(JSON.stringify({
    triggered_at: triggeredAt,
    target,
    agent: "reparador",
  }));

  const res = await fetch(target, {
    method: "POST",
    headers: {
      "x-internal-secret": secret,
      "x-trigger": "cron",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });

  return new Response(
    JSON.stringify({ triggered: 1, status: res.status }),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  schedule: "15 13 * * *", // 8:15am Bogotá (UTC-5). Cron es UTC.
};
