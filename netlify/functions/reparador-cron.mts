// netlify/functions/reparador-cron.mts
//
// DEPRECATED 2026-05-15: el reparador ahora corre dentro del archivero
// (que coordina reparador + limpiador en una sola pasada a las 8:15 Bogotá).
// Este cron quedó desactivado (schedule = fecha imposible) pero se mantiene
// para permitir rollback rápido si el archivero falla.
//
// Para reactivar: cambiar schedule de "0 0 31 2 *" a "15 13 * * *"
// Y desactivar el archivero-cron correspondiente.

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
  // DEPRECATED: 31 de febrero — fecha imposible, nunca corre.
  // El archivero-cron lo reemplazó. Si querés rollback, volvé a "15 13 * * *".
  schedule: "0 0 31 2 *",
};
