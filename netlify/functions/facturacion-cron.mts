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

  // Multi-tenant: dispara N invocaciones CON STAGGER 800ms.
  //
  // Bug detectado 2026-05-15: 3 clientes recibieron email "OAuth invalid_grant"
  // a la misma hora exacta (12:06:30 UTC), pero ninguno había revocado permisos.
  // Causa: cuando dispatchamos 10+ clientes con Promise.allSettled, todos hacen
  // refresh_token al MISMO Google OAuth client_id (el Web Client compartido de
  // Operatto) en milisegundos. Google rate-limita por client_id y devuelve
  // invalid_grant transitorio a algunos.
  //
  // Fix: stagger 800ms entre dispatches. Total para 11 clientes: ~9s, bien
  // dentro del timeout de 30s del cron stub. Cada cliente sigue corriendo
  // en paralelo en su propio background fn (15min max) — solo se ARRANCAN
  // separados, después corren simultáneos.
  console.log(JSON.stringify({
    triggered_at: triggeredAt,
    mode: "multi_tenant_staggered",
    n_clients: clientes.length,
    stagger_ms: 800,
    clients: clientes.map((c) => c.slug),
    target,
  }));

  const DISPATCH_STAGGER_MS = 800;
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < clientes.length; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, DISPATCH_STAGGER_MS));
    }
    const c = clientes[i];
    try {
      const resp = await fetch(target, {
        method: "POST",
        headers: {
          "x-internal-secret": secret,
          "content-type": "application/json",
        },
        body: JSON.stringify({ customerId: c.slug }),
      });
      if (resp.ok || resp.status === 202) ok++;
      else {
        failed++;
        console.warn(`[cron] ${c.slug} status=${resp.status}`);
      }
    } catch (e: any) {
      failed++;
      console.warn(`[cron] ${c.slug} dispatch failed: ${e.message}`);
    }
  }

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
