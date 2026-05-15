// netlify/functions/limpiador-cron.mts
//
// Scheduled function: 8:30am Bogotá (13:30 UTC).
// Corre 15 min después del reparador (8:15am) para que ya tenga
// los huérfanos detectados/no-resueltos por el reparador.

import type { Config } from "@netlify/functions";

export default async (_req: Request) => {
  const baseUrl = process.env.URL;
  const secret = process.env.FACTURACION_INTERNAL_SECRET;

  if (!baseUrl || !secret) {
    console.error("[limpiador-cron] falta env: URL o FACTURACION_INTERNAL_SECRET");
    return new Response("misconfigured", { status: 500 });
  }

  const target = `${baseUrl}/.netlify/functions/limpiador-background`;
  console.log(JSON.stringify({ triggered_at: new Date().toISOString(), target, agent: "limpiador" }));

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
  schedule: "30 13 * * *", // 8:30am Bogotá (UTC-5)
};
