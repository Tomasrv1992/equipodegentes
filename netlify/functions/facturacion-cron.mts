// netlify/functions/facturacion-cron.mts
//
// Scheduled function: dispara diario 7am Bogotá (12:00 UTC) al background worker.
// Pattern: cron stub (timeout 30s) → background fn (timeout 15min).
//
// Multi-tenant: itera sobre todos los clientes con `client_agents.activo = true`
// para el agente "facturacion" y dispara una invocación por cliente.
// Si no encuentra ninguno (porque Supabase está down o vacío), cae al modo
// legacy single-tenant (un solo run con env vars del site).

import type { Config } from "@netlify/functions";
import { listActiveClientsForAgent } from "../../shared/agents-runtime/src/credentials-by-slug";

export default async (_req: Request) => {
  const baseUrl = process.env.URL; // inyectado por Netlify automáticamente
  const secret = process.env.FACTURACION_INTERNAL_SECRET;

  if (!baseUrl || !secret) {
    console.error("Falta env: URL o FACTURACION_INTERNAL_SECRET");
    return new Response("misconfigured", { status: 500 });
  }

  const target = `${baseUrl}/.netlify/functions/facturacion-background`;
  const triggeredAt = new Date().toISOString();

  // Multi-tenant: leer clientes activos
  let clientes: Array<{ id: string; slug: string; nombre: string }> = [];
  try {
    clientes = await listActiveClientsForAgent("facturacion");
  } catch (err: any) {
    console.warn("listActiveClientsForAgent failed (no-fatal):", err.message);
  }

  // Fallback legacy: si Supabase no devuelve clientes, correr una sola vez
  // sin customerId (modo owner). Útil mientras nadie completó onboarding.
  if (clientes.length === 0) {
    console.log(JSON.stringify({
      triggered_at: triggeredAt,
      mode: "legacy_single_tenant",
      target,
    }));
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "x-internal-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    return new Response(
      JSON.stringify({ triggered: 1, mode: "legacy", status: res.status }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // Multi-tenant: dispara N invocaciones en paralelo (no esperamos respuesta).
  // Cada background fn corre hasta 15min en paralelo con las otras.
  console.log(JSON.stringify({
    triggered_at: triggeredAt,
    mode: "multi_tenant",
    n_clients: clientes.length,
    clients: clientes.map((c) => c.slug),
    target,
  }));

  const results = await Promise.allSettled(
    clientes.map((c) =>
      fetch(target, {
        method: "POST",
        headers: {
          "x-internal-secret": secret,
          "content-type": "application/json",
        },
        body: JSON.stringify({ customerId: c.slug }),
      }),
    ),
  );

  const ok = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - ok;

  console.log(JSON.stringify({
    triggered_at: triggeredAt,
    triggered: ok,
    failed,
  }));

  return new Response(
    JSON.stringify({
      triggered: ok,
      failed,
      n_clients: clientes.length,
      clients: clientes.map((c) => c.slug),
    }),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  schedule: "0 12 * * *", // 7am Bogotá (UTC-5). Cron es UTC.
};
