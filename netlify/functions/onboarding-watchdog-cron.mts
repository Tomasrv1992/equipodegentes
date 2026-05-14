// netlify/functions/onboarding-watchdog-cron.mts
//
// Cron stub (timeout 30s). Cada 30 min revisa clientes en first_run
// (backfill activo) y detecta meses que no se procesaron — re-dispara
// el procesamiento de esos meses.
//
// Cuándo aplica: cliente termina OAuth → fan-out dispara 5-12 meses →
// alguno timeoutea, falla por quota, o nunca completa por race condition.
// Antes: quedaba ese hueco sin facturas + Tomás tenía que verlo en /operacion
// y darle re-disparar manual. Ahora: 30 min después de onboarded_at, este
// watchdog detecta los huecos y los retrabaja solo.
//
// Heurística para "mes pendiente que debería re-dispararse":
//   - Cliente con first_run_done=false (sigue en backfill)
//   - Onboarded hace ≥ 30 min (le dimos tiempo al fan-out original)
//   - Mes 1..currentMonth sin agent_events tipo factura_procesada para ese mes
//   - Y sin agent_run en estado 'running' o 'ok' reciente (últimos 60 min)
//     para ese monthFilter (evita re-disparar mientras todavía está en curso)
//
// Cap protectivo: max 3 re-dispatch por cliente por ejecución (no saturar).

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

const MAX_REDISPATCH_POR_CLIENTE = 3;
const MIN_MINUTOS_DESDE_ONBOARDED = 30;
const VENTANA_RUN_RECIENTE_MIN = 60;

export default async (_req: Request) => {
  const baseUrl = process.env.URL;
  const secret = process.env.FACTURACION_INTERNAL_SECRET;

  if (!baseUrl || !secret) {
    console.error("[watchdog] falta env URL o FACTURACION_INTERNAL_SECRET");
    return new Response("misconfigured", { status: 500 });
  }

  const target = `${baseUrl}/.netlify/functions/facturacion-background`;
  const triggeredAt = new Date();

  let supa: ReturnType<typeof getServerClient>;
  try {
    supa = getServerClient();
  } catch (e: any) {
    console.error(`[watchdog] no Supabase: ${e.message}`);
    return new Response("supabase-down", { status: 500 });
  }

  // 1. Clientes en backfill — first_run_done=false + onboarded_at viejo (>30 min).
  const cutoffOnboarded = new Date(
    triggeredAt.getTime() - MIN_MINUTOS_DESDE_ONBOARDED * 60_000,
  ).toISOString();

  const { data: creds, error: credsErr } = await supa
    .from("client_credentials")
    .select("cliente_id, onboarded_at")
    .eq("first_run_done", false)
    .eq("agente_id", "facturacion")
    .lt("onboarded_at", cutoffOnboarded);
  if (credsErr) {
    console.error(`[watchdog] query creds failed: ${credsErr.message}`);
    return new Response("query-failed", { status: 500 });
  }

  if (!creds || creds.length === 0) {
    console.log("[watchdog] sin clientes en backfill — nothing to do");
    return new Response(
      JSON.stringify({ ok: true, checked: 0, redispatched: 0 }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // 2. Resolver slugs (necesario para el dispatch al background).
  const clienteIds = creds.map((c: any) => c.cliente_id);
  const { data: clientesData } = await supa
    .from("clientes")
    .select("id, slug, nombre")
    .in("id", clienteIds);
  const slugById = new Map<string, { slug: string; nombre: string }>();
  for (const c of (clientesData ?? []) as Array<{
    id: string;
    slug: string;
    nombre: string;
  }>) {
    slugById.set(c.id, { slug: c.slug, nombre: c.nombre });
  }

  // 3. Por cada cliente, detectar meses pendientes y re-disparar.
  const year = triggeredAt.getFullYear();
  const currentMonth = triggeredAt.getMonth() + 1;
  let totalChecked = 0;
  let totalRedispatched = 0;
  const reporte: Array<{
    cliente: string;
    redispatched: number[];
    skipped: number[];
  }> = [];

  for (const cred of creds as Array<{ cliente_id: string }>) {
    const cli = slugById.get(cred.cliente_id);
    if (!cli) continue;
    totalChecked++;

    // 3a. Meses con al menos 1 factura procesada
    const { data: events } = await supa
      .from("agent_events")
      .select("payload")
      .eq("cliente_id", cred.cliente_id)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("payload->>fecha", `${year}-01-01`)
      .lt("payload->>fecha", `${year + 1}-01-01`);
    const mesesConFacturas = new Set<number>();
    for (const ev of (events ?? []) as Array<{ payload: any }>) {
      const fecha = ev.payload?.fecha as string | undefined;
      if (!fecha || !fecha.startsWith(`${year}-`)) continue;
      const mes = parseInt(fecha.slice(5, 7), 10);
      if (Number.isFinite(mes)) mesesConFacturas.add(mes);
    }

    // 3b. Runs recientes (últimos 60 min) para evitar re-disparar
    //     un mes que todavía está procesando.
    const cutoffRun = new Date(
      triggeredAt.getTime() - VENTANA_RUN_RECIENTE_MIN * 60_000,
    ).toISOString();
    const { data: recentRuns } = await supa
      .from("agent_runs")
      .select("payload, status, started_at")
      .eq("cliente_id", cred.cliente_id)
      .eq("agente_id", "facturacion")
      .gte("started_at", cutoffRun);
    const mesesConRunReciente = new Set<number>();
    for (const r of (recentRuns ?? []) as Array<{
      payload: any;
      status: string;
    }>) {
      const mf = r.payload?.monthFilter as number | undefined;
      if (!mf) continue;
      // Si está running u ok reciente, NO re-disparar (todavía en curso).
      // Si está fail, sí re-disparar (el watchdog es el que retrabaja).
      if (r.status === "running" || r.status === "ok") {
        mesesConRunReciente.add(mf);
      }
    }

    // 3c. Meses 1..currentMonth sin facturas Y sin run reciente activo.
    const mesesPendientes: number[] = [];
    for (let m = 1; m <= currentMonth; m++) {
      if (mesesConFacturas.has(m)) continue;
      if (mesesConRunReciente.has(m)) continue;
      mesesPendientes.push(m);
    }

    // Limitar dispatches por cliente para no saturar.
    const toDispatch = mesesPendientes.slice(0, MAX_REDISPATCH_POR_CLIENTE);
    const skipped = mesesPendientes.slice(MAX_REDISPATCH_POR_CLIENTE);

    if (toDispatch.length === 0) {
      reporte.push({ cliente: cli.slug, redispatched: [], skipped: [] });
      continue;
    }

    console.log(
      `[watchdog] cliente=${cli.slug} pendientes=[${mesesPendientes.join(",")}] ` +
      `redispatch=[${toDispatch.join(",")}]${skipped.length ? ` (cap, skip=${skipped.join(",")})` : ""}`,
    );

    // Stagger entre dispatches del mismo cliente para evitar quota.
    let firstDispatch = true;
    for (const mes of toDispatch) {
      if (!firstDispatch) await new Promise((r) => setTimeout(r, 3500));
      firstDispatch = false;
      try {
        await fetch(target, {
          method: "POST",
          headers: {
            "x-internal-secret": secret,
            "x-trigger": "watchdog-rerun-mes",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            customerId: cli.slug,
            monthFilter: mes,
            force: true,
            silent: true,
            notifyMonthComplete: true,
            skipSheetSetup: true,
          }),
        });
        totalRedispatched++;
      } catch (e: any) {
        console.warn(`[watchdog] dispatch ${cli.slug}/${mes} failed: ${e.message}`);
      }
    }

    reporte.push({ cliente: cli.slug, redispatched: toDispatch, skipped });
  }

  console.log(
    JSON.stringify({
      triggered_at: triggeredAt.toISOString(),
      checked: totalChecked,
      redispatched: totalRedispatched,
      report: reporte,
    }),
  );

  return new Response(
    JSON.stringify({
      ok: true,
      checked: totalChecked,
      redispatched: totalRedispatched,
      report: reporte,
    }),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  // Cada 30 minutos. Suficiente para reaccionar rápido sin spam.
  // Costo: 48 invocaciones/día (~1500/mes), bien dentro del free tier de Netlify.
  schedule: "*/30 * * * *",
};
