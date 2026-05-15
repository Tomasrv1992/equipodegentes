// netlify/functions/archivero-cron.mts
//
// Cron stub que dispara el archivero-background diariamente.
// Schedule: 8:15 AM Bogotá (13:15 UTC) — antes corrían reparador y limpiador
// por separado en 8:15 y 8:30. Ahora un solo run consolida ambos.

import type { Config } from "@netlify/functions";

export default async (_req: Request) => {
  const baseUrl = process.env.URL;
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (!baseUrl || !secret) {
    console.error("[archivero-cron] falta URL o FACTURACION_INTERNAL_SECRET");
    return new Response("misconfigured", { status: 500 });
  }
  const target = `${baseUrl}/.netlify/functions/archivero-background`;
  await fetch(target, {
    method: "POST",
    headers: {
      "x-internal-secret": secret,
      "x-trigger": "cron",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  }).catch((e) => console.warn(`[archivero-cron] dispatch failed: ${e.message}`));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  schedule: "15 13 * * *", // 8:15 AM Bogotá (UTC-5)
};
