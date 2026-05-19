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

  let totalAutoCompleted = 0;
  for (const cred of creds as Array<{ cliente_id: string }>) {
    const cli = slugById.get(cred.cliente_id);
    if (!cli) continue;
    totalChecked++;

    // 3a. Meses con al menos 1 factura procesada (paginado — clientes
    //     grandes superan 1000 events).
    const PAGE_SIZE = 1000;
    const HARD_CEILING = 50_000;
    const mesesConFacturas = new Set<number>();
    let totalFacturasYear = 0;
    {
      let from = 0;
      while (from < HARD_CEILING) {
        const { data, error } = await supa
          .from("agent_events")
          .select("payload")
          .eq("cliente_id", cred.cliente_id)
          .eq("agente_id", "facturacion")
          .eq("tipo", "factura_procesada")
          .gte("payload->>fecha", `${year}-01-01`)
          .lt("payload->>fecha", `${year + 1}-01-01`)
          .range(from, from + PAGE_SIZE - 1);
        if (error) {
          console.warn(`[watchdog] events query failed ${cli.slug}: ${error.message}`);
          break;
        }
        const batch = (data ?? []) as Array<{ payload: any }>;
        for (const ev of batch) {
          const fecha = ev.payload?.fecha as string | undefined;
          if (!fecha || !fecha.startsWith(`${year}-`)) continue;
          const mes = parseInt(fecha.slice(5, 7), 10);
          if (Number.isFinite(mes)) mesesConFacturas.add(mes);
        }
        totalFacturasYear += batch.length;
        if (batch.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
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

    // 3d. AUTO-MARK first_run_done si el cliente ya tiene cobertura razonable.
    //
    //   Caso real: Freshco quedó con first_run_done=false porque el código
    //   viejo solo marcaba el flag si result.errores.length === 0 en cada
    //   mes del fan-out. Cualquier error en cualquier mes dejaba al cliente
    //   "atascado" en estado onboarding aunque ya tuviera 1700+ facturas
    //   procesadas. El panel admin lo seguía marcando como "Onboarding en
    //   progreso · LIVE" indefinidamente.
    //
    //   Heurística para considerarlo "ya completó":
    //     - >= 80% de los meses esperados tienen al menos 1 factura, O
    //     - tiene más de 200 facturas registradas en el año
    //   AND
    //     - onboarded_at hace más de 6h (le dimos tiempo al fan-out)
    //
    //   Si cumple, marcar first_run_done=true. Próximos cron diarios
    //   procesan en modo regular (window=30d) en vez de re-disparar fan-out.
    const onboardedMs = (cred as any).onboarded_at
      ? new Date((cred as any).onboarded_at as string).getTime()
      : null;
    const horasDesdeOnboard = onboardedMs
      ? (triggeredAt.getTime() - onboardedMs) / 3_600_000
      : Infinity;
    const coberturaMeses = mesesConFacturas.size / Math.max(1, currentMonth);
    const yaTieneCoberturaCompleta =
      horasDesdeOnboard > 6 &&
      (coberturaMeses >= 0.8 || totalFacturasYear >= 200);

    if (yaTieneCoberturaCompleta) {
      try {
        await supa.rpc("client_credentials_mark_first_run_done", {
          p_cliente_id: cred.cliente_id,
          p_agente_id: "facturacion",
        });
        console.log(
          `[watchdog] auto-complete ${cli.slug} — first_run_done=true ` +
          `(${mesesConFacturas.size}/${currentMonth} meses, ${totalFacturasYear} facturas, ${horasDesdeOnboard.toFixed(1)}h desde onboard)`,
        );
        totalAutoCompleted++;
        reporte.push({ cliente: cli.slug, redispatched: [], skipped: [] });
        continue; // no necesita re-dispatch; ya está completo
      } catch (err: any) {
        console.warn(`[watchdog] auto-complete ${cli.slug} failed: ${err.message}`);
      }
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
      auto_completed: totalAutoCompleted,
      redispatched: totalRedispatched,
      report: reporte,
    }),
  );

  return new Response(
    JSON.stringify({
      ok: true,
      checked: totalChecked,
      auto_completed: totalAutoCompleted,
      redispatched: totalRedispatched,
      report: reporte,
    }),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  // DESACTIVADO 2026-05-19: estaba re-disparando facturación cada 30min para
  // clientes con OAuth expired/revoked → 50+ disparos extra al día contra
  // OAuth roto → gasto en Anthropic + Netlify sin valor.
  // Para reactivar: cambiar schedule a "*/30 * * * *" y agregar guard que
  // skipee clientes con oauth_status='expired'|'revoked'.
  schedule: "0 0 31 2 *", // fecha imposible (Feb 31 no existe)
};
