// netlify/functions/supervisor-cron.mts
//
// Scheduled function: 8:45am Bogotá (13:45 UTC).
// Corre después de monitor (8:00) + reparador (8:15) + limpiador (8:30).

import type { Config } from "@netlify/functions";

export default async (_req: Request) => {
  const baseUrl = process.env.URL;
  const secret = process.env.FACTURACION_INTERNAL_SECRET;

  if (!baseUrl || !secret) {
    console.error("[supervisor-cron] falta env");
    return new Response("misconfigured", { status: 500 });
  }

  const target = `${baseUrl}/.netlify/functions/supervisor-background`;
  console.log(JSON.stringify({ triggered_at: new Date().toISOString(), target, agent: "supervisor" }));

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
  schedule: "45 13 * * *", // 8:45am Bogotá
};
