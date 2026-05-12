// netlify/functions/monitor-cron.mts
//
// Scheduled function: corre todos los días a las 8am Bogotá (13:00 UTC).
// 1 hora después del cron de facturación (7am Bogotá / 12:00 UTC) para que
// todos los runs de los clientes hayan terminado o pasado a timeout.
//
// Dispara el monitor-background que hace los chequeos + envía email al admin.

import type { Config } from "@netlify/functions";

export default async (_req: Request) => {
  const baseUrl = process.env.URL;
  const secret = process.env.FACTURACION_INTERNAL_SECRET;

  if (!baseUrl || !secret) {
    console.error("[monitor-cron] falta env: URL o FACTURACION_INTERNAL_SECRET");
    return new Response("misconfigured", { status: 500 });
  }

  const target = `${baseUrl}/.netlify/functions/monitor-background`;
  const triggeredAt = new Date().toISOString();

  console.log(JSON.stringify({
    triggered_at: triggeredAt,
    target,
    agent: "monitor",
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
  schedule: "0 13 * * *", // 8am Bogotá (UTC-5). Cron es UTC.
};
