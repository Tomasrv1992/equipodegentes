// netlify/functions/monitor-cron.mts
//
// DEPRECATED 2026-05-15: renombrado a inspector-cron.mts.
// Schedule desactivado (fecha imposible). Para rollback: volver schedule
// a "0 13 * * *" y desactivar inspector-cron.

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
  // DEPRECATED: 31 de febrero — fecha imposible, nunca corre.
  // El inspector-cron lo reemplazó. Rollback: volver a "0 13 * * *".
  schedule: "0 0 31 2 *",
};
