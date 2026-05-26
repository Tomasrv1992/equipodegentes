// netlify/functions/facturacion-background.mts
//
// Background function (suffix `-background` → 15min timeout en cualquier plan).
// Disparada por: facturacion-cron.mts, o POST manual con x-internal-secret.
//
// Thin Netlify wrapper — la lógica vive en agentes/Equipo-facturacion/lib/pipeline.ts
// (compartida con CLI local para evitar drift).
//
// Notificaciones: email diario (incondicional) vía Resend.
// Env vars: RESEND_API_KEY, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM.

import type { Config } from "@netlify/functions";
import { run, type PipelineConfig, type PipelineResult } from "../../agentes/Equipo-facturacion/lib/pipeline";
import {
  recordRunStart,
  recordRunEnd,
} from "../../shared/agents-runtime/src/record-run";
import { markOAuthStatus } from "../../shared/agents-runtime/src/credentials";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import {
  emitFacturaEvents,
  clienteIdBySlug,
  type FacturaEventPayload,
} from "../../shared/agents-runtime/src/agent-events";
import {
  runPreflight,
  preflightToPayload,
  type PreflightResult,
} from "../../shared/agents-runtime/src/preflight";

interface RequestBody {
  /** Forward-compat para SaaS multi-tenant (Proyecto B). */
  customerId?: string;
  /** Override window de búsqueda (ej: "365d" para backfill manual). */
  window?: string;
  /** Solo listar, no procesar. */
  dryRun?: boolean;
  /**
   * Si true, NO excluye -label:Procesado del query Gmail. Re-lee emails
   * ya procesados para encontrar Word/PDF que el cron viejo dejó sin LLM.
   * isDuplicate sigue activo en Sheet — no duplica filas.
   */
  force?: boolean;
  /**
   * Si true, NO manda email al cliente al terminar el run. Útil para
   * pruebas de validación interna sin spam al cliente. El procesamiento
   * (Sheet, Drive, agent_events) sigue normal — solo se skipea el correo.
   */
  silent?: boolean;
  /**
   * Si está set (1-12), filtra el procesamiento a SOLO ese mes del año.
   * Usado por multi-pass para clientes grandes.
   */
  monthFilter?: number;
  /**
   * Window personalizada por rango fechas (alternativa a monthFilter).
   * Útil para CHUNKS chicos en recovery de clientes grandes que NO caben
   * en 15min de Netlify Background (ej Freshco enero = 1340 emails).
   *
   * Ambos en formato YYYY/MM/DD. windowFrom inclusivo, windowTo exclusivo.
   * Override monthFilter y window si están presentes.
   */
  windowFrom?: string;
  windowTo?: string;
  /**
   * Workers paralelos del pipeline. Default 5. Bajar a 2-3 si hay
   * Sheets API quota issues (caso real Freshco 67/130 errores 18-may).
   */
  concurrency?: number;
  /**
   * Si true y customerId presente, en lugar de un único run, dispara 12
   * invocaciones (una por mes) y termina. Útil para primer run + force=true
   * en clientes con alto volumen — evita timeout de Netlify 15min.
   * El dispatcher recibe este request y abre 12 fan-outs paralelos.
   */
  multiPass?: boolean;
  /**
   * Si true, NO ejecuta ensureSheetSetup. Lo usa el dispatcher multi-pass
   * para que solo el primer mes haga setup y los otros 11 lo skip.
   */
  skipSheetSetup?: boolean;
  /**
   * Si true, al terminar el run (cuando hay monthFilter set) manda un email
   * corto "Listo {mes}: N facturas procesadas". Lo usa el dispatcher de
   * fan-out para dar feedback incremental al cliente — no espera al final
   * de los 5-12 meses para saber que algo se procesó.
   * Solo se manda si procesadas > 0 (no spam por meses vacíos).
   * Independiente de `silent`: si notifyMonthComplete=true, este email sale
   * aunque silent=true (silent suprime el email diario, no el de progreso).
   */
  notifyMonthComplete?: boolean;
  /**
   * Si true, SKIPEA el pre-flight check. Lo usa el orquestador del fan-out
   * para los dispatches individuales por mes — el preflight ya corrió antes
   * del fan-out una sola vez, los 5-12 dispatches paralelos no necesitan
   * repetirlo (gastaría 4 llamadas API extra * N meses).
   */
  skipPreflight?: boolean;
  /**
   * Cadena de meses pendientes para procesamiento SECUENCIAL post-onboarding.
   * Al terminar el run de este mes, se dispara el siguiente mes con el array
   * reducido. Cuando array está vacío, no se dispara nada y termina.
   *
   * Reemplaza el paralelismo del auto-fan-out anterior. Garantiza:
   *   1. Solo 1 mes corre a la vez (no compite por Sheets quota)
   *   2. Consecutivos respetan orden cronológico real (mes 1 antes que 2)
   */
  chainNextMonths?: number[];
  /**
   * Si true, skipea el guard que rechaza runs cuando oauth_status != 'connected'.
   * El cron lo deja undefined; dispatches manuales pueden setearlo para
   * forzar un run (raramente útil).
   */
  skipOAuthGuard?: boolean;
  /**
   * Si true, skipea el guard anti-duplicate-dispatch (60s lookback).
   * Útil para chain-next-month que dispara secuencialmente — el chain manda
   * el siguiente mes inmediatamente al terminar el actual, pueden caer
   * dentro de los 60s del run anterior. Sin este escape, el chain se
   * romperia. Set por chainNextMonths internally.
   */
  skipDuplicateGuard?: boolean;
}

export default async (req: Request) => {
  // 1. Auth interna: solo el cron stub o un curl con el secret correcto puede invocar
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2. Parse body
  let body: RequestBody = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json();
    }
  } catch {
    /* body opcional, default {} */
  }

  // 2.5. MULTI-PASS FAN-OUT: si viene multiPass=true + customerId, en lugar
  //      de procesar nosotros mismos, disparamos 12 invocaciones (una por mes)
  //      en paralelo y terminamos. Cada invocación procesa solo su mes,
  //      cabiendo en el límite de 15min de Netlify. Resuelve clientes grandes.
  if (body.multiPass && body.customerId) {
    const baseUrl = process.env.URL;
    if (!baseUrl) {
      return new Response("missing URL env", { status: 500 });
    }
    const target = `${baseUrl}/.netlify/functions/facturacion-background`;

    // Solo procesar meses con facturas posibles (mes actual hacia atrás)
    // y en orden descendente — mes actual primero para entregar valor inmediato.
    const currentMonth = new Date().getMonth() + 1;
    const meses: number[] = [];
    for (let m = currentMonth; m >= 1; m--) meses.push(m);
    const firstMes = meses[0];

    console.log(
      `[multi-pass] cliente=${body.customerId} → disparando ${meses.length} meses ` +
      `[${meses.join(",")}] (desc, stagger 3.5s)`,
    );
    const dispatches: Array<Promise<any>> = [];
    for (const mes of meses) {
      if (mes !== firstMes) await new Promise((r) => setTimeout(r, 3500));
      dispatches.push(
        fetch(target, {
          method: "POST",
          headers: {
            "x-internal-secret": secret,
            "x-trigger": "multi-pass",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            customerId: body.customerId,
            force: body.force ?? false,
            silent: body.silent ?? true,
            monthFilter: mes,
            // Solo el primer dispatch (mes actual) ejecuta setup; los otros skipean.
            skipSheetSetup: mes !== firstMes,
            // Email corto "listo {mes}" al terminar cada mes — feedback incremental.
            notifyMonthComplete: true,
            // Preflight ya corrió en el orquestador — los dispatches del fan-out
            // no necesitan repetirlo (gasta llamadas API, mismo cred).
            skipPreflight: true,
          }),
        }).catch((e) => console.warn(`[multi-pass] dispatch mes ${mes} failed: ${e.message}`)),
      );
    }
    await Promise.all(dispatches);
    return new Response(
      JSON.stringify({
        ok: true,
        multiPass: true,
        monthsDispatched: meses.length,
        months: meses,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // 3. Cargar credenciales del cliente (multi-tenant) ANTES del run
  //    Lo necesitamos para detectar `wasFirstRun` y elegir entre email
  //    de bienvenida (post-onboarding) vs email diario.
  let credBefore: Awaited<ReturnType<typeof loadCredentialsForBackground>> = null;
  if (body.customerId) {
    credBefore = await loadCredentialsForBackground(body.customerId);
  }
  const wasFirstRun = !!(credBefore && !credBefore.first_run_done);

  // 3.-1. GUARD anti-duplicate-dispatch:
  //   Si el mismo cliente tiene un run en status='running' iniciado hace <60s,
  //   skipear silenciosamente. Eso bloquea CUALQUIER fuente de dispatches
  //   duplicados rápidos:
  //     - Doble-click del cliente
  //     - 3 edge functions disparando independiente (bug Dentilandia 2026-05-26)
  //     - Polling del frontend
  //     - Cron concurrente con dispatch manual
  //     - Auto-fan-out (aunque ya está off)
  //   Segunda capa de defensa. El primer dispatch entra; los demás se descartan.
  if (body.customerId && !body.skipDuplicateGuard) {
    try {
      const supa = getServerClient();
      const { data: cli } = await supa
        .from("clientes")
        .select("id")
        .eq("slug", body.customerId)
        .single();
      if (cli) {
        const sinceCutoff = new Date(Date.now() - 60_000).toISOString();
        const { data: recientes } = await supa
          .from("agent_runs")
          .select("id, started_at, status")
          .eq("cliente_id", (cli as any).id)
          .eq("agente_id", "facturacion")
          .gte("started_at", sinceCutoff)
          .order("started_at", { ascending: false })
          .limit(5);
        const reciente = (recientes ?? []).find(
          (r: any) => r.status === "running" || r.status === "ok",
        );
        if (reciente) {
          console.log(JSON.stringify({
            skipped: true,
            reason: "duplicate_dispatch_within_60s",
            customerId: body.customerId,
            existing_run_id: (reciente as any).id,
            existing_status: (reciente as any).status,
          }));
          return new Response(
            JSON.stringify({
              ok: true,
              skipped: true,
              reason: `duplicate dispatch (run ${(reciente as any).id} ya activo)`,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
    } catch (e: any) {
      console.warn(`[duplicate-guard] check failed (no-fatal): ${e.message}`);
    }
  }

  // 3.0. GUARD anti-spam: si oauth_status NO está 'connected', skipear todo
  //   el run silenciosamente. Casos típicos:
  //     - Cliente recién reseteado (oauth_status='pending'): espera reonboarding
  //     - OAuth expirado: ya hay notificación, no spamear cron diario con más mails
  //   Sin este guard, cada cron diario para los 10 clientes reseteados manda
  //   N emails "preflight oauth falló" al admin → spam masivo.
  //   Cuando el cliente complete reonboarding, oauth_status pasa a 'connected'
  //   y el cron lo recoge naturalmente.
  if (
    body.customerId &&
    credBefore &&
    credBefore.google_oauth_status !== "connected" &&
    !body.skipOAuthGuard
  ) {
    console.log(JSON.stringify({
      skipped: true,
      reason: "oauth_status_not_connected",
      customerId: body.customerId,
      oauth_status: credBefore.google_oauth_status,
    }));
    return new Response(
      JSON.stringify({
        ok: true,
        skipped: true,
        reason: `oauth_status=${credBefore.google_oauth_status} (esperando reonboarding)`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  // 3.25. PRE-FLIGHT VALIDATION (multi-tenant, no skipPreflight).
  //
  //   Si tenemos credBefore válido y body.skipPreflight!=true, chequear las 4
  //   dependencias críticas (oauth, drive folder, sheet, gmail) con ~4
  //   llamadas API baratas ANTES de empezar a procesar. Si alguna falla:
  //     - Registramos un agent_run con status=fail y payload.preflight
  //     - Mandamos email al cliente con hint accionable
  //     - Retornamos sin tocar Sheet/Drive (idempotente, no deja basura)
  //
  //   Por qué importa: hoy si el cliente revocó OAuth, borró su Drive folder,
  //   o trasheó el Sheet, nos enteramos a mitad del pipeline — perdiendo
  //   tiempo de Netlify, dejando estados parciales, y sin contexto claro
  //   en el error.
  let preflightResult: PreflightResult | null = null;
  if (credBefore && !body.skipPreflight) {
    try {
      preflightResult = await runPreflight({
        clientId: requireEnv("GOOGLE_OAUTH_WEB_CLIENT_ID"),
        clientSecret: requireEnv("GOOGLE_OAUTH_WEB_CLIENT_SECRET"),
        refreshToken: credBefore.google_refresh_token!,
        driveFolderId: credBefore.drive_folder_id!,
        sheetId: credBefore.sheet_id!,
      });
    } catch (err: any) {
      // Si preflight mismo crasheó (ej: env var ausente), fail-safe: log
      // y continuar — preferimos un run con error a un cliente sin run.
      console.error(`[preflight] crash: ${err.message}`);
    }

    if (preflightResult && !preflightResult.ok) {
      console.error(JSON.stringify({
        level: "preflight_fail",
        customerId: body.customerId,
        check: preflightResult.check,
        message: preflightResult.message,
        hint: preflightResult.hint,
      }));

      // Registrar agent_run preflight_failed para visibilidad en panel
      try {
        const runIdPf = await recordRunStart({
          clienteSlug: body.customerId ?? "owner",
          agenteId: "facturacion",
          triggeredBy: "preflight",
        });
        if (runIdPf) {
          await recordRunEnd({
            runId: runIdPf,
            status: "fail",
            durationMs: preflightResult.durationMs,
            error: new Error(`preflight ${preflightResult.check}: ${preflightResult.message}`),
            summary: `Preflight failed: ${preflightResult.check}`,
            payload: preflightToPayload(preflightResult),
          });
        }
      } catch (e: any) {
        console.error(`[preflight] failed to record agent_run: ${e.message}`);
      }

      // Notificar al admin (Tomás) con hint accionable.
      try {
        await notifyPreflightFailed(body.customerId!, preflightResult);
      } catch (e: any) {
        console.error(`[preflight] notify failed: ${e.message}`);
      }

      // Para errores de OAuth, marcar credenciales como expired SOLO si
      // hay PATRÓN — no en el primer error.
      //
      // Bug arreglado 2026-05-14: Andres tuvo 1 invalid_grant aislado y se
      // marcó como expired aunque los 11 runs anteriores estaban OK. Era un
      // hiccup transitorio (token cache Google, race condition al refresh).
      // Marcar expired al primer error rompe el flow del cliente sin
      // necesidad — la auto-corrección de Google suele resolverlo en horas.
      //
      // Regla nueva: marcar expired solo si hay >=3 fallos consecutivos de
      // OAuth en las últimas 24h, sin runs OK entremedio. Si el último run
      // antes de este preflight_fail era OK, NO marcamos — es transitorio.
      if (preflightResult.check === "oauth") {
        try {
          const supa = getServerClient();
          const { data: cliente } = await supa
            .from("clientes")
            .select("id")
            .eq("slug", body.customerId)
            .single();
          if (cliente) {
            const shouldMark = await shouldMarkOAuthExpired(supa, (cliente as any).id);
            if (shouldMark) {
              await markOAuthStatus((cliente as any).id, "facturacion", "expired");
              console.log(`[preflight] oauth marcado expired (>=3 fallos consecutivos, sin runs OK entremedio)`);
            } else {
              console.log(`[preflight] oauth fallo transitorio (último run anterior OK o <3 fallos) — no marcamos expired`);
            }
          }
        } catch (e: any) {
          console.error(`[preflight] markOAuthStatus failed: ${e.message}`);
        }
      }

      return new Response(
        JSON.stringify({
          ok: false,
          preflight_failed: preflightResult.check,
          message: preflightResult.message,
          hint: preflightResult.hint,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } else if (preflightResult?.ok) {
      console.log(`[preflight] OK cliente=${body.customerId} (${preflightResult.durationMs}ms)`);
    }
  }

  // 3.5. AUTO MULTI-PASS — solo para PRIMER RUN del cliente (onboarding).
  //
  //      Si el cliente está en first_run (first_run_done=false), disparamos
  //      N invocaciones paralelas (1 por mes) para procesar histórico anual
  //      sin que ningún mes timeoutee (Netlify Background = 15min).
  //
  //      BUG CRÍTICO 2026-05-15: ANTES la condición incluía `body.force === true`
  //      → cualquier retrigger del supervisor (que pasa force=true sin monthFilter)
  //      disparaba fan-out completo. Resultado:
  //        - Cliente onboardeado recibía 5 emails "Listo {mes}" cada vez que el
  //          supervisor lo retriggeaba (notifyMonthComplete se propagaba al fan-out)
  //        - 5 runs concurrentes hit api-quota Anthropic + duplicaban filas Sheet
  //          (407k filas en Sheet de Freshco abril = 316× duplicado, vs 428 events reales)
  //
  //      Fix: solo wasFirstRun activa fan-out. force=true se respeta como
  //      "re-lee emails con label Procesado" pero corre EN UN SOLO run, no fan-out.
  //
  //      Si Tomás quiere fan-out manual para un cliente ya onboardeado (catchup),
  //      tiene que pasar explícitamente `multiPass: true`.
  // DESACTIVADO 2026-05-26 (post bug paralelismo Dentilandia):
  //   El auto-fan-out viene siendo fuente persistente de runs paralelos que
  //   rompen orden cronológico de consecutivos y saturan quota Sheets API.
  //   Decisión: NUNCA auto-fan-out. Si un cliente necesita backfill anual,
  //   Tomás lo dispara MANUALMENTE con endpoint dedicado pasando chainNextMonths.
  //   El primer run del onboarding queda en monthFilter=null → procesa con
  //   window default ("YYYY/01/01" = desde inicio año) en UN SOLO run serial.
  //   Si no cabe en 15min, el resto queda para el cron diario o disparo manual.
  const shouldAutoFanOut = false;

  if (shouldAutoFanOut) {
    const baseUrl = process.env.URL;
    if (baseUrl) {
      const target = `${baseUrl}/.netlify/functions/facturacion-background`;

      // OPTIMIZACIÓN 1: Solo procesar meses con facturas posibles.
      // Estamos en mayo → procesar enero..mayo. No tiene sentido disparar
      // junio..diciembre porque no hay facturas todavía. Reduce dispatches
      // de 12 fijos a `currentMonth` (típicamente 5-7).
      const currentMonth = new Date().getMonth() + 1;

      // OPTIMIZACIÓN 2: Orden descendente — mes actual primero.
      // El cliente quiere ver mayo (mes actual) en su dashboard ANTES que
      // enero. Procesar de currentMonth → 1 entrega valor inmediato y
      // mejora la percepción de velocidad.
      const meses: number[] = [];
      for (let m = currentMonth; m >= 1; m--) meses.push(m);

      // OPTIMIZACIÓN 3: Marcar first_run_done ANTES del dispatch (no después).
      // Hoy se marca al final de Promise.all, pero los dispatches devuelven
      // 202 inmediato — el procesamiento real ocurre en background después.
      // Si el cron diario corre mientras los meses procesan, NO debe
      // re-disparar fan-out. Marcamos antes para que el flag refleje
      // "ya empecé" no "ya terminé".
      if (wasFirstRun && credBefore) {
        try {
          const supa = getServerClient();
          await supa.rpc("client_credentials_mark_first_run_done", {
            p_cliente_id: credBefore.cliente_id,
            p_agente_id: "facturacion",
          });
          console.log(`[auto-fan-out] first_run_done marcado ANTES del dispatch (cliente=${body.customerId})`);
        } catch (err: any) {
          console.warn(`[auto-fan-out] failed mark first_run_done: ${err.message}`);
        }
      }

      // CAMBIO 2026-05-26: SECUENCIAL en lugar de paralelo.
      //   Bug: disparar N meses en paralelo (aún con stagger 3.5s) genera
      //   contención sobre Sheets API (300 reads/min) y rompe orden cronológico
      //   de consecutivos — factura del mes 5 podía recibir #1 si llegaba
      //   primero al lock distribuido.
      //
      //   Fix: dispatch SOLO el mes más viejo (enero) con chainNextMonths
      //   conteniendo los meses pendientes. Al final del run, ese background
      //   dispara el siguiente mes. Cada mes corre SECUENCIAL, no compite por
      //   quota Sheets, y los consecutivos respetan orden temporal real.
      const mesesAsc = [...meses].reverse(); // [1,2,3,...,currentMonth]
      const firstMes = mesesAsc[0]; // enero (más viejo)
      const chainNextMonths = mesesAsc.slice(1); // [2,3,...,currentMonth]

      console.log(
        `[auto-fan-out-sequential] cliente=${body.customerId} → ` +
        `inicio mes=${firstMes}, chain=[${chainNextMonths.join(",")}] ` +
        `(secuencial, cada mes espera al anterior)`,
      );

      // Solo UN dispatch ahora: el mes más viejo. Al terminar, dispara el siguiente.
      await fetch(target, {
        method: "POST",
        headers: {
          "x-internal-secret": secret,
          "x-trigger": "auto-multi-pass-sequential",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customerId: body.customerId,
          force: body.force ?? false,
          silent: true,
          monthFilter: firstMes,
          // Primer mes hace setup completo del Sheet
          skipSheetSetup: false,
          notifyMonthComplete: true,
          skipPreflight: true,
          // Cadena de meses a procesar después de este (orden ascendente).
          chainNextMonths,
        }),
      }).catch((e) => console.warn(`[auto-fan-out-sequential] dispatch failed: ${e.message}`));
      return new Response(
        JSON.stringify({
          ok: true,
          autoFanOut: true,
          monthsDispatched: meses.length,
          months: meses,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
  }

  // 4. Resolver config según customerId (reutiliza cred si ya cargado)
  const cfg = await buildConfig(body, credBefore);

  // 5. Ejecutar pipeline + registrar en agent_runs
  const startedAt = Date.now();
  const clienteSlug = body.customerId ?? "owner";

  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug,
      agenteId: "facturacion",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("recordRunStart failed (no-fatal):", err.message);
    // No bloqueamos el pipeline si Supabase está caído.
  }

  let result: PipelineResult;
  try {
    result = await run(cfg);
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "fatal",
      customerId: clienteSlug,
      error: err.message,
      stack: err.stack,
      hint: err.message?.includes("invalid_grant")
        ? "Refresh token expiró: corré scripts/setup-oauth.mjs local y actualizá GOOGLE_OAUTH_REFRESH_TOKEN en Netlify env vars"
        : undefined,
    }));

    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          error: err,
          netlifyLogUrl: process.env.URL
            ? `${process.env.URL}/.netlify/functions/facturacion-background`
            : undefined,
        });
      } catch (e: any) {
        console.error("recordRunEnd(fail) failed:", e.message);
      }
    }

    // Si el error es invalid_grant en modo multi-tenant, marcar credenciales expiradas
    if (body.customerId && err.message?.includes("invalid_grant")) {
      try {
        const supa = getServerClient();
        const { data: cliente } = await supa
          .from("clientes")
          .select("id")
          .eq("slug", body.customerId)
          .single();
        if (cliente) {
          await markOAuthStatus((cliente as any).id, "facturacion", "expired");
          console.log(`OAuth marked expired for cliente ${body.customerId}`);
        }
      } catch (e: any) {
        console.error("mark oauth expired failed:", e.message);
      }
    }

    if (!body.silent) {
      try {
        await notifyError(err, body.customerId);
      } catch {
        /* notify falla silencioso */
      }
    }
    return new Response("internal error", { status: 500 });
  }

  const durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    level: "result",
    customerId: clienteSlug,
    durationMs,
    procesadas: result.procesadas.length,
    errores: result.errores.length,
    saltadas: result.saltadas.length,
    repetidas: result.repetidas.length,
    sample: result.procesadas.slice(0, 3),
  }));

  // Registrar fin OK (o WARN si hubo errores parciales)
  if (runId) {
    try {
      const status: "ok" | "warn" = result.errores.length > 0 ? "warn" : "ok";
      const summary =
        `${result.procesadas.length} procesadas` +
        (result.repetidas.length ? ` · ${result.repetidas.length} repetidas` : "") +
        (result.saltadas.length ? ` · ${result.saltadas.length} saltadas` : "") +
        (result.errores.length ? ` · ${result.errores.length} errores` : "");
      await recordRunEnd({
        runId,
        status,
        durationMs,
        summary,
        payload: {
          procesadas: result.procesadas.length,
          errores: result.errores.length,
          saltadas: result.saltadas.length,
          repetidas: result.repetidas.length,
          // Tracking de uso LLM para visibilidad de costo por cliente/run
          llm_calls: result.llmStats?.calls ?? 0,
          llm_cost_usd: result.llmStats?.estimatedCostUsd ?? 0,
          llm_pre_filtered: result.llmStats?.preFilteredOut ?? 0,
          // CONTEXTO DEL RUN — para diagnóstico SQL sin tener que adivinar
          // qué tipo de run fue. Bug detectado 2026-05-14: las queries por
          // payload->>'monthFilter' devolvían 0 rows porque el campo NO se
          // guardaba; ahora sí. También guardamos customerId, force, window
          // para entender el run completo desde una sola fila.
          monthFilter: body.monthFilter ?? null,
          customerId: body.customerId ?? null,
          force: body.force ?? false,
          window: body.window ?? null,
          dryRun: body.dryRun ?? false,
          skipSheetSetup: body.skipSheetSetup ?? false,
          skipPreflight: body.skipPreflight ?? false,
          notifyMonthComplete: body.notifyMonthComplete ?? false,
          silent: body.silent ?? false,
          wasFirstRun: wasFirstRun,
          trigger_header: req.headers.get("x-trigger") ?? null,
          // Sample primeros 10 errores con detalle para diagnóstico SQL.
          // Antes solo se guardaba el count `errores: N` — para investigar
          // qué falló había que escarbar en Netlify logs (caros y lentos).
          // Ahora basta `select payload->'sample_errors' from agent_runs`.
          sample_errors: result.errores.slice(0, 10).map((e) => ({
            messageId: e.messageId,
            error: e.error,
            asunto: e.asunto,
          })),
          // Mismo concepto para saltadas — útil para entender qué se filtró.
          sample_skipped: result.saltadas.slice(0, 5).map((s) => ({
            messageId: s.messageId,
            motivo: s.motivo,
            asunto: s.asunto,
          })),
          // Breakdown de motivos de error/saltada para detectar patrones.
          // Ej: si 80 errores son "pdf-encrypted", sabemos que es ruido bancario.
          error_pattern_breakdown: countByErrorPattern(result.errores),
          skipped_pattern_breakdown: countByMotivo(result.saltadas),
        },
      });
    } catch (e: any) {
      console.error("recordRunEnd(ok) failed:", e.message);
    }
  }

  // Marcar first_run_done + emitir agent_events (uno por factura procesada)
  if (body.customerId) {
    try {
      const clienteUuid = await clienteIdBySlug(body.customerId);
      if (clienteUuid && runId) {
        // 1. Emit agent_events granulares (1 por factura procesada con su fecha REAL)
        if (result.procesadas.length > 0) {
          const facturas: FacturaEventPayload[] = result.procesadas.map((p) => ({
            fecha: p.fecha,           // YYYY-MM-DD de la factura, NO del run
            proveedor: p.proveedor,
            nit: p.nit,
            numero: p.numero,
            consecutivo: (p as any).consecutivo,
            cufe: p.cufe,
            subtotal: p.subtotal,
            iva: p.iva,
            total: p.total,
            concepto: p.concepto,
            categoria: p.categoria,
            cuentaPyg: p.cuentaPyg,
            tipo: (p as any).tipo ?? "factura_dian",
            // Retenciones: si el cliente tiene reglas configuradas, vienen
            // del engine (XML/oficio/override). Sino, del XML directo.
            reteFuente: (p as any).reteFuente ?? 0,
            reteIva: (p as any).reteIva ?? 0,
            reteIca: (p as any).reteIca ?? 0,
            totalRetenciones: (p as any).totalRetenciones ?? 0,
            // Audit trail del engine de retenciones (solo si se aplicó).
            // Valores: "xml" | "oficio" | "override_nit" | "none"
            retencionSource: (p as any).retencionSource,
            driveLink: p.driveLink,
          }));
          await emitFacturaEvents({
            runId,
            clienteId: clienteUuid,
            agenteId: "facturacion",
            facturas,
          });
          console.log(`[events] cliente ${body.customerId}: ${facturas.length} facturas → agent_events`);
        }

        // 2. Marcar first_run_done si terminó sin errores
        if (result.errores.length === 0) {
          const supa = getServerClient();
          await supa.rpc("client_credentials_mark_first_run_done", {
            p_cliente_id: clienteUuid,
            p_agente_id: "facturacion",
          });
          console.log(`[backfill] cliente ${body.customerId} first_run_done=true`);
        }
      }
    } catch (e: any) {
      console.error("post-run hooks failed (no-fatal):", e.message);
    }
  }

  // Email per-mes del fan-out: feedback incremental durante el backfill.
  // Independiente de `silent`. Solo manda si procesó > 0 facturas (no spam).
  if (body.notifyMonthComplete && body.customerId && body.monthFilter && result.procesadas.length > 0) {
    try {
      await notifyMonthDone(body.customerId, body.monthFilter, result);
    } catch (err: any) {
      console.error("notifyMonthDone failed:", err.message);
    }
  }

  // Email: si fue primer run del cliente (post-onboarding) Y terminó OK,
  // mandamos email de BIENVENIDA con resumen completo del año actual.
  // Sino, email diario regular con lo procesado en este run.
  //
  // Si body.silent === true → SKIPEAR completamente el envío. Útil para
  // disparar runs de prueba sin spam al cliente.
  if (body.silent) {
    console.log(`[silent] skip email — cliente=${body.customerId ?? "owner"}`);
  } else {
    try {
      if (wasFirstRun && body.customerId && result.errores.length === 0) {
        console.log(`[welcome] cliente ${body.customerId}: primer run OK, enviando email de bienvenida`);
        await notifyWelcome(body.customerId);
      } else {
        await notifyResult(result, body.customerId);
      }
    } catch (err: any) {
      console.error("notify failed:", err.message);
    }
  }

  // ENCADENAMIENTO SECUENCIAL: si vino chainNextMonths con elementos,
  // dispatch el siguiente mes AHORA (justo antes de devolver). Esto garantiza
  // que el siguiente mes arranca solo después de que este terminó — cero
  // paralelismo, cero contención de quota Sheets, consecutivos en orden real.
  if (
    body.customerId &&
    body.chainNextMonths &&
    body.chainNextMonths.length > 0 &&
    result.errores.length < 50 // no encadenar si este mes fue catástrofe
  ) {
    const baseUrl = process.env.URL;
    if (baseUrl) {
      const target = `${baseUrl}/.netlify/functions/facturacion-background`;
      const [nextMes, ...resto] = body.chainNextMonths;
      console.log(
        `[chain-next] mes ${body.monthFilter} OK (${result.procesadas.length} procesadas) → ` +
        `dispatch mes ${nextMes}, restantes=[${resto.join(",")}]`,
      );
      try {
        await fetch(target, {
          method: "POST",
          headers: {
            "x-internal-secret": secret,
            "x-trigger": "chain-next-month",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            customerId: body.customerId,
            force: body.force ?? false,
            silent: true,
            monthFilter: nextMes,
            skipSheetSetup: true, // setup ya hecho por el primer mes
            notifyMonthComplete: true,
            skipPreflight: true,
            skipDuplicateGuard: true, // chain encadenado, no es duplicate
            chainNextMonths: resto,
          }),
        });
      } catch (e: any) {
        console.warn(`[chain-next] dispatch mes ${nextMes} failed: ${e.message}`);
      }
    }
  } else if (body.customerId && body.chainNextMonths !== undefined) {
    console.log(
      `[chain-next] cadena terminada en mes ${body.monthFilter} ` +
      `(restantes=${body.chainNextMonths?.length ?? 0}, errores=${result.errores.length})`,
    );
  }

  return new Response(JSON.stringify({ ok: true, durationMs, runId }), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  // Sin `schedule` → no es scheduled. El sufijo `-background` la marca como bg.
};

// ===== Config builder =====

/**
 * Carga las credenciales del cliente para el background fn (con validación).
 * Devuelve null si el customerId no tiene fila o las creds están incompletas.
 * Usar antes de buildConfig para detectar wasFirstRun.
 */
async function getNombreClienteFromSlug(slug: string | undefined): Promise<string | null> {
  if (!slug) return null;
  try {
    const supa = getServerClient();
    const { data } = await supa
      .from("clientes")
      .select("nombre")
      .eq("slug", slug)
      .single();
    return (data as { nombre?: string } | null)?.nombre ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide si marcar oauth_status='expired' después de un preflight fail
 * con check='oauth'. Anti-falso-positivo: solo retornar true si hay
 * patrón claro de expiración, no por hiccups transitorios.
 *
 * Reglas:
 *   - Si el último agent_run anterior (excluyendo el propio preflight
 *     en curso) fue 'ok' o 'warn' (= corrió, no preflight_fail), NO
 *     marcar — el problema es transitorio.
 *   - Si hay >=3 runs consecutivos con preflight failed por oauth en las
 *     últimas 24h, sí marcar.
 *   - Si error_message del último run contiene 'invalid_grant' Y ya hay
 *     2 errores similares en las últimas 24h, marcar.
 *
 * Devuelve false si está borderline — preferimos NO marcar y dejar que
 * Tomás vea el preflight_fail en panel y decida.
 */
async function shouldMarkOAuthExpired(
  supa: ReturnType<typeof getServerClient>,
  clienteId: string,
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supa
      .from("agent_runs")
      .select("status, triggered_by, error_message, started_at")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(10);

    const runs = (recent ?? []) as Array<{
      status: string;
      triggered_by: string | null;
      error_message: string | null;
    }>;

    // Excluir el preflight actual (el que está corriendo) — todavía no se
    // guardó pero el siguiente está en curso. Filtramos por triggered_by != 'preflight'
    // del último para asegurar que no contamos el actual.
    // En la práctica el run actual aún no se guardó cuando llegamos acá, así
    // que `recent` solo trae los previos.

    // Buscar el último run no-preflight (que efectivamente corrió):
    const ultimoRunReal = runs.find((r) => r.triggered_by !== "preflight");
    if (ultimoRunReal && (ultimoRunReal.status === "ok" || ultimoRunReal.status === "warn")) {
      // El último run real funcionó OK → el preflight fail de ahora es
      // probablemente transitorio. NO marcar.
      return false;
    }

    // Contar preflight fails de oauth en las últimas 24h
    const preflightOauthFails = runs.filter(
      (r) =>
        r.triggered_by === "preflight" &&
        r.status === "fail" &&
        (r.error_message ?? "").toLowerCase().includes("oauth"),
    ).length;
    if (preflightOauthFails >= 2) {
      // 2 fallos previos + el actual = 3 consecutivos → patrón confirmado
      return true;
    }

    // Contar invalid_grant en error_message
    const invalidGrants = runs.filter((r) =>
      (r.error_message ?? "").toLowerCase().includes("invalid_grant"),
    ).length;
    if (invalidGrants >= 2) {
      return true;
    }

    // Borderline → no marcar, preferimos visibility via panel
    return false;
  } catch (e: any) {
    console.warn(`[preflight] shouldMarkOAuthExpired query failed: ${e.message}`);
    // En caso de error, ser conservador: no marcar
    return false;
  }
}

async function loadCredentialsForBackground(customerId: string) {
  const { loadCredentialsBySlug } = await import("../../shared/agents-runtime/src/credentials-by-slug");
  const cred = await loadCredentialsBySlug(customerId, "facturacion");
  if (!cred) return null;
  return cred;
}

async function buildConfig(
  body: RequestBody,
  preloadedCred: Awaited<ReturnType<typeof loadCredentialsForBackground>> = null,
): Promise<PipelineConfig> {
  // === Multi-tenant: customerId es el SLUG del cliente en public.clientes ===
  // Carga credenciales del cliente desde Supabase (refresh_token desencriptado
  // con pgcrypto + recursos elegidos durante onboarding).
  if (body.customerId) {
    const cred = preloadedCred ?? (await loadCredentialsForBackground(body.customerId));
    if (!cred) {
      throw new Error(
        `Cliente con slug "${body.customerId}" no tiene credenciales en client_credentials`,
      );
    }
    if (cred.google_oauth_status !== "connected") {
      throw new Error(
        `Cliente "${body.customerId}" tiene OAuth en estado '${cred.google_oauth_status}'. Reconectar.`,
      );
    }
    if (!cred.google_refresh_token) {
      throw new Error(`Cliente "${body.customerId}" sin refresh_token`);
    }
    if (!cred.drive_folder_id || !cred.sheet_id) {
      throw new Error(
        `Cliente "${body.customerId}" no completó selección de Drive folder o Sheet`,
      );
    }

    // Backfill rule: si es el primer run del cliente (first_run_done = false)
    // o si vino force=true (reprocesamiento manual), procesa todo el año
    // calendario actual (after:YYYY/01/01) en vez del rolling 30d.
    // El primer run después de onboarding entrega valor inmediato al cliente.
    // Force re-procesa hacia atrás para capturar lo que el cron viejo no pudo.
    let resolvedWindow: string;
    if (body.window) {
      resolvedWindow = body.window;  // override explícito desde el body
    } else if (!cred.first_run_done || body.force) {
      // First run o force=true → backfill desde 1° de enero del año actual
      const yearStart = new Date(new Date().getFullYear(), 0, 1);
      const yyyy = yearStart.getFullYear();
      const mm = String(yearStart.getMonth() + 1).padStart(2, "0");
      const dd = String(yearStart.getDate()).padStart(2, "0");
      resolvedWindow = `${yyyy}/${mm}/${dd}`;
      const reason = !cred.first_run_done ? "first_run_done=false" : "force=true";
      console.log(`[backfill] cliente ${body.customerId} ${reason} → window=${resolvedWindow}`);
    } else {
      resolvedWindow = "30d";
    }

    return {
      google: {
        // Usamos el OAuth Web Client de Operatto (compartido entre todos los clientes).
        // Cada cliente tiene su propio refresh_token autorizado contra ese client.
        clientId: requireEnv("GOOGLE_OAUTH_WEB_CLIENT_ID"),
        clientSecret: requireEnv("GOOGLE_OAUTH_WEB_CLIENT_SECRET"),
        refreshToken: cred.google_refresh_token,
        driveFolderId: cred.drive_folder_id,
        sheetId: cred.sheet_id,
        sheetTab: cred.sheet_tab,
      },
      // Reglas de retención del cliente (Sub-fase 2). Si null, el pipeline
      // deja las retenciones tal como vienen del XML (sin engine).
      retentionRules: (cred as any).retention_rules ?? null,
      municipioIca: (cred as any).municipio_ica ?? null,
      // NIT/cédula del cliente para descartar facturas self-emitted (Migración 0008).
      nitCliente: (cred as any).nit_cliente ?? null,
      // Nombre del cliente para fuzzy match cuando LLM no extrae NIT.
      // Cargado en buildConfig con un query extra (fuera de este return).
      nombreCliente: await getNombreClienteFromSlug(body.customerId),
      options: {
        dryRun: body.dryRun ?? false,
        window: resolvedWindow,
        force: body.force ?? false,
        monthFilter: body.monthFilter,
        windowFrom: body.windowFrom,
        windowTo: body.windowTo,
        concurrency: body.concurrency,
        skipSheetSetup: (body as any).skipSheetSetup ?? false,
      },
    };
  }

  // === Single-tenant (legacy): owner desde env vars del site ===
  return {
    google: {
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refreshToken: requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
      driveFolderId: requireEnv("INVOICES_DRIVE_FOLDER_ID"),
      sheetId: requireEnv("INVOICES_SHEET_ID"),
      sheetTab: process.env.INVOICES_SHEET_TAB || "Gastos 2026",
    },
    options: {
      dryRun: body.dryRun ?? false,
      window: body.window ?? "30d",
      force: body.force ?? false,
    },
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta env var: ${name}`);
  return v;
}

// ===== Notificaciones (Resend) =====

// Fallback links del owner legacy. Para clientes multi-tenant se construyen
// dinámicamente desde cred.sheet_id y cred.drive_folder_id.
const OWNER_SHEET_LINK = "https://docs.google.com/spreadsheets/d/1dwCu-1ooeyOC5PEd2lBIhua4zUmC5ymymQ6X0O4zcMU/edit";
const OWNER_DRIVE_LINK = "https://drive.google.com/drive/folders/1ksS7gwlT8OYmMh4Eh2WiIQGNwkERdti2";

interface NotifyTarget {
  to: string;
  sheetLink: string;
  driveLink: string;
}

/**
 * Resuelve a quién mandar el correo y qué links usar.
 * Multi-tenant: usa cred.notify_email + IDs del cliente.
 * Legacy: env vars del site.
 */
async function resolveNotifyTarget(customerId?: string): Promise<NotifyTarget> {
  if (customerId) {
    try {
      const { loadCredentialsBySlug } = await import("../../shared/agents-runtime/src/credentials-by-slug");
      const cred = await loadCredentialsBySlug(customerId, "facturacion");
      if (cred?.notify_email) {
        return {
          to: cred.notify_email,
          sheetLink: cred.sheet_id
            ? `https://docs.google.com/spreadsheets/d/${cred.sheet_id}/edit`
            : OWNER_SHEET_LINK,
          driveLink: cred.drive_folder_id
            ? `https://drive.google.com/drive/folders/${cred.drive_folder_id}`
            : OWNER_DRIVE_LINK,
        };
      }
    } catch (e: any) {
      console.warn(`resolveNotifyTarget: failed loading cred for ${customerId}:`, e.message);
    }
  }
  // Fallback legacy — owner
  return {
    to: process.env.NOTIFY_EMAIL_TO || "tomasramirezvilla@gmail.com",
    sheetLink: OWNER_SHEET_LINK,
    driveLink: OWNER_DRIVE_LINK,
  };
}

/**
 * MUTE GLOBAL DE EMAILS — modo testing post-reset masivo 2026-05-26.
 *
 * Por default TODOS los emails (cliente + admin) están silenciados. Para
 * reactivarlos, setear env var EMAILS_ENABLED=true en Netlify. Cuando el
 * onboarding de los 10 clientes esté validado y todo opere bien, Tomás
 * pone la env var y los emails vuelven a salir.
 */
function emailsMuted(): boolean {
  return process.env.EMAILS_ENABLED !== "true";
}

async function notifyResult(result: PipelineResult, customerId?: string): Promise<void> {
  if (emailsMuted()) {
    console.log("notifyResult: skip (EMAILS_ENABLED!=true, modo testing)");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY ausente — no se envía notificación");
    return;
  }

  // Owner (modo legacy single-tenant) NO recibe correo — Tomás monitorea desde
  // el panel admin. Solo clientes multi-tenant reciben su resumen.
  if (!customerId) {
    console.log("notifyResult: skip (modo owner) — Tomás monitorea desde panel");
    return;
  }

  const target = await resolveNotifyTarget(customerId);
  const from = process.env.NOTIFY_EMAIL_FROM || "Operatto <onboarding@resend.dev>";

  const total = result.procesadas.length + result.errores.length + result.saltadas.length;
  const today = new Date().toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Bogota" });

  let subject: string;
  if (result.errores.length > 0) {
    subject = `⚠️ Facturas ${today}: ${result.procesadas.length} OK, ${result.errores.length} con error`;
  } else if (result.procesadas.length > 0) {
    subject = `✅ Facturas ${today}: ${result.procesadas.length} procesadas`;
  } else {
    subject = `📭 Facturas ${today}: sin novedad`;
  }

  const html = renderHtmlSummary(result, today, customerId, target.sheetLink, target.driveLink);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to: [target.to], subject, html }),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("Resend error:", res.status, txt);
  } else {
    console.log(`Email enviado a ${target.to} (cliente: ${customerId ?? "owner"}) — total ${total} items`);
  }
}

const MES_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;

/**
 * Agrupa errores por patrón reconocible para detectar ruido vs problemas reales.
 *
 * Patrones que hoy alimentan el contador "errores" y NO son fallas reales:
 *   - pdf-encrypted     → extractos bancarios con password (Bancolombia, Itaú, tarjetas)
 *   - pdf-no-text       → PDFs escaneados solo imagen, sin texto extraíble
 *   - llm-no-invoice    → LLM determinó que el doc no es factura
 *   - timeout           → red inestable, el daily cron retry-ea
 *
 * Devuelve { "pdf-encrypted": 80, "real-llm-fail": 12, "other": 8 } así Tomás
 * puede entender de un vistazo si el "31% error rate" es ruido bancario o
 * problema real del pipeline.
 */
function countByErrorPattern(errores: Array<{ error: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of errores) {
    const msg = (e.error ?? "").toLowerCase();
    const pat = classifyErrorMessage(msg);
    out[pat] = (out[pat] ?? 0) + 1;
  }
  return out;
}

/**
 * Clasifica un mensaje de error en categorías reconocibles. Centralizada para
 * que sea fácil agregar nuevos patrones cuando los descubrimos en prod.
 *
 * Orden importante: más específico → más genérico. El primer match gana.
 */
function classifyErrorMessage(msg: string): string {
  // 1. Anthropic API issues (rate limit, overload, auth)
  if (/quota|rate.?limit|429|too many requests/i.test(msg)) return "api-quota";
  if (/overload|529|503/i.test(msg)) return "api-overload";
  if (/anthropic.*401|claude.*unauthorized/i.test(msg)) return "anthropic-auth";

  // 2. OAuth issues
  if (/invalid_grant/i.test(msg)) return "oauth-invalid-grant";
  if (/oauth|refresh.token|access.token expired/i.test(msg)) return "oauth-expired";

  // 3. Google APIs quotas (Drive, Sheets, Gmail)
  if (/sheets.*quota|sheets.*read.requests|spreadsheets.*quota/i.test(msg)) return "sheets-quota";
  if (/drive.*quota|drive.*rate/i.test(msg)) return "drive-quota";
  if (/gmail.*quota|gmail.*rate/i.test(msg)) return "gmail-quota";
  if (/google.*quota|userratelimitexceeded/i.test(msg)) return "google-quota";

  // 4. PDF processing
  if (/no password|password given|encrypted/i.test(msg)) return "pdf-encrypted";
  if (/no text|sin texto|pdf.*empty|pdf vacío/i.test(msg)) return "pdf-no-text";
  if (/pdf.*corrupt|pdf.*invalid|invalid pdf/i.test(msg)) return "pdf-corrupted";

  // 5. ZIP / XML processing (DIAN)
  if (/zip.*corrupt|invalid zip|bad zip/i.test(msg)) return "zip-corrupted";
  if (/zip.*sin xml|no xml in zip/i.test(msg)) return "zip-no-xml";
  if (/xml.*parse|invalid xml|malformed xml/i.test(msg)) return "xml-parse";

  // 6. LLM extraction issues
  if (/not.?invoice|no es factura|not a factura/i.test(msg)) return "llm-no-invoice";
  if (/baja confianza|low confidence/i.test(msg)) return "llm-low-confidence";
  if (/llm.*timeout|claude.*timeout/i.test(msg)) return "llm-timeout";
  if (/llm.*json|invalid json from llm/i.test(msg)) return "llm-malformed-json";

  // 7. Network / transient
  if (/timeout|econnreset|etimedout|aborted/i.test(msg)) return "network-timeout";
  if (/dns|enotfound|getaddrinfo/i.test(msg)) return "network-dns";
  if (/socket hang up|connection reset/i.test(msg)) return "network-reset";

  // 8. Sheet writes specific
  if (/range_not_found|rango no encontrado|range not found/i.test(msg)) return "sheet-range-not-found";
  if (/sheet.*forbidden|spreadsheet.*forbidden/i.test(msg)) return "sheet-forbidden";

  // 9. Drive issues
  if (/drive.*not_found|file not found.*drive|fileid.*404/i.test(msg)) return "drive-not-found";
  if (/drive.*forbidden|drive.*403/i.test(msg)) return "drive-forbidden";

  // 10. Dedup / DB
  if (/duplicate key|unique constraint|agent_events_factura_unique/i.test(msg)) return "db-dedup";
  if (/supabase.*5\d\d|postgres.*5\d\d/i.test(msg)) return "supabase-error";

  // 11. Custom motivos del nuevo classifier (en pipeline.ts, commit 1206687)
  // Estos NO deberían llegar acá porque ya se reclasifican como saltadas,
  // pero por si quedó alguno legacy:
  if (/doc-no-procesable/i.test(msg)) return "doc-no-procesable-legacy";

  return "other";
}

function countByMotivo(saltadas: Array<{ motivo: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of saltadas) {
    const m = s.motivo ?? "unknown";
    out[m] = (out[m] ?? 0) + 1;
  }
  return out;
}

/**
 * Email corto "Listo {mes}: N facturas — $X procesado" al terminar cada
 * mes del fan-out. Feedback incremental durante el backfill para que el
 * cliente vea progreso real, no espere 15+ min al welcome final.
 */
async function notifyMonthDone(
  customerId: string,
  monthNumber: number,
  result: PipelineResult,
): Promise<void> {
  if (emailsMuted()) {
    console.log("notifyMonthDone: skip (EMAILS_ENABLED!=true)");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const target = await resolveNotifyTarget(customerId);
  const from = process.env.NOTIFY_EMAIL_FROM || "Operatto <onboarding@resend.dev>";

  const mesName = MES_NAMES[monthNumber - 1] ?? `mes ${monthNumber}`;
  const totalMonto = result.procesadas.reduce((s, p) => s + (Number(p.total) || 0), 0);
  const moneyCO = "$" + Math.round(totalMonto).toLocaleString("es-CO");

  const subject = `✅ Listo ${mesName}: ${result.procesadas.length} factura${result.procesadas.length === 1 ? "" : "s"} (${moneyCO})`;

  const html = `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#222;padding:24px">
  <div style="background:#f0f9ff;padding:20px;border-radius:8px;border-left:4px solid #1a3a5c;margin-bottom:16px">
    <div style="font-size:14px;color:#666;margin-bottom:4px">Backfill en curso</div>
    <h2 style="margin:0 0 12px;font-size:20px;color:#1a3a5c">
      Listo ${mesName.charAt(0).toUpperCase()}${mesName.slice(1)}
    </h2>
    <div style="display:flex;gap:16px;margin-top:12px">
      <div>
        <div style="font-size:24px;font-weight:600;color:#1a3a5c;line-height:1">${result.procesadas.length}</div>
        <div style="font-size:12px;color:#666">factura${result.procesadas.length === 1 ? "" : "s"}</div>
      </div>
      <div>
        <div style="font-size:24px;font-weight:600;color:#1a3a5c;line-height:1">${moneyCO}</div>
        <div style="font-size:12px;color:#666">monto registrado</div>
      </div>
    </div>
  </div>
  <p style="margin:0 0 12px;font-size:14px;color:#444;line-height:1.5">
    Procesamos las facturas de ${mesName} y ya están en tu Sheet con sus PDFs en Drive.
    Seguimos con los otros meses — te avisamos cuando termine cada uno.
  </p>
  <p style="margin:16px 0 0;font-size:13px;color:#666">
    <a href="${target.sheetLink}" style="color:#1a3a5c;font-weight:600">📊 Abrir Sheet</a>
    &nbsp;·&nbsp;
    <a href="${target.driveLink}" style="color:#1a3a5c;font-weight:600">📁 Abrir Drive</a>
  </p>
  <p style="margin:24px 0 0;font-size:12px;color:#999;text-align:center">— Operatto</p>
</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [target.to], subject, html }),
  });
  if (!res.ok) {
    console.error("notifyMonthDone resend error:", res.status, await res.text());
  } else {
    console.log(`[month-done] email enviado a ${target.to} — ${mesName} (${result.procesadas.length} facturas)`);
  }
}

/**
 * Email al admin (Tomás) cuando preflight detecta un problema con las
 * credenciales del cliente. Mejor que enterarse a mitad del pipeline:
 * tenemos hint accionable + permite Tomás actuar antes del próximo cron.
 */
async function notifyPreflightFailed(
  customerId: string,
  pf: Extract<PreflightResult, { ok: false }>,
): Promise<void> {
  if (emailsMuted()) {
    console.log("notifyPreflightFailed: skip (EMAILS_ENABLED!=true)");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  // Solo Tomás (admin) — no spam al cliente con errores de OAuth técnicos.
  const adminEmail = process.env.NOTIFY_EMAIL_TO || "tomasramirezvilla@gmail.com";
  const from = process.env.NOTIFY_EMAIL_FROM || "Operatto <onboarding@resend.dev>";

  const subject = `🚨 Preflight ${pf.check} falló — ${customerId}`;
  const html = `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;color:#222;padding:24px">
  <h2 style="color:#c00;margin:0 0 12px;font-size:20px">🚨 Preflight failed</h2>
  <table style="font-size:14px;border-collapse:collapse">
    <tr>
      <td style="padding:4px 8px 4px 0;color:#666;font-weight:600">Cliente:</td>
      <td style="padding:4px 0"><code>${escapeHtml(customerId)}</code></td>
    </tr>
    <tr>
      <td style="padding:4px 8px 4px 0;color:#666;font-weight:600">Check fallado:</td>
      <td style="padding:4px 0"><code style="background:#fee;padding:2px 6px;border-radius:3px;color:#c00">${pf.check}</code></td>
    </tr>
    <tr>
      <td style="padding:4px 8px 4px 0;color:#666;font-weight:600">Mensaje:</td>
      <td style="padding:4px 0;font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(pf.message)}</td>
    </tr>
  </table>
  <div style="background:#fef9e7;border-left:4px solid #f0b020;padding:14px 16px;margin:16px 0;border-radius:0 6px 6px 0">
    <div style="font-weight:600;color:#806600;margin-bottom:4px">Acción sugerida</div>
    <div style="color:#444;font-size:14px;line-height:1.5">${escapeHtml(pf.hint)}</div>
  </div>
  <p style="margin:24px 0 0;font-size:12px;color:#999">
    El pipeline NO procesó nada — Sheet y Drive del cliente quedan intactos.
    Cuando arregles las credenciales, el próximo cron diario (o un re-disparo
    manual) volverá a chequear.
  </p>
</div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [adminEmail], subject, html }),
  });
}

async function notifyError(err: Error, customerId?: string): Promise<void> {
  if (emailsMuted()) {
    console.log("notifyError: skip (EMAILS_ENABLED!=true)");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  // Owner (modo legacy) NO recibe correo de error — Tomás monitorea desde panel.
  if (!customerId) {
    console.log("notifyError: skip (modo owner)");
    return;
  }
  // Errores al cliente para que sepa que algo falla.
  const target = await resolveNotifyTarget(customerId);
  const to = target.to;
  const from = process.env.NOTIFY_EMAIL_FROM || "Operatto <onboarding@resend.dev>";

  const today = new Date().toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Bogota" });
  const hint = err.message?.includes("invalid_grant")
    ? `<p style="color:#a00"><b>Causa probable:</b> el refresh token expiró o tiene un <code>=</code> de más al inicio en Netlify env vars. Corré <code>scripts/setup-oauth.mjs</code> local y actualizá <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> en Netlify.</p>`
    : "";

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px">
      <h2 style="color:#c00;margin:0 0 8px">🔴 Pipeline cayó — ${today}</h2>
      <p><b>Cliente:</b> ${customerId || "owner"}</p>
      <p><b>Error:</b> <code>${escapeHtml(err.message)}</code></p>
      ${hint}
      <p style="color:#666;font-size:13px;margin-top:24px">Logs completos en Netlify dashboard → Functions → procesar-facturas-background.</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: `🔴 Procesar-Facturas: fatal (${today})`, html }),
  });
}

function renderHtmlSummary(
  result: PipelineResult,
  today: string,
  customerId?: string,
  sheetLink: string = OWNER_SHEET_LINK,
  driveLink: string = OWNER_DRIVE_LINK,
): string {
  const moneyCO = (n: number) =>
    "$" + Math.round(n).toLocaleString("es-CO");

  const procRows = result.procesadas
    .map((p) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.fecha)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.proveedor)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.numero)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${moneyCO(p.total)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee"><a href="${escapeHtml(p.driveLink)}">PDF</a></td>
      </tr>`)
    .join("");

  const errRows = result.errores
    .map((e) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #fcc">${escapeHtml(e.asunto || "(sin asunto)")}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #fcc"><code>${escapeHtml(e.error)}</code></td>
      </tr>`)
    .join("");

  const totalProc = result.procesadas.reduce((s, p) => s + (p.total || 0), 0);

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:720px;color:#222">
      <h2 style="margin:0 0 4px">Resumen de facturas — ${today}</h2>
      ${customerId ? `<p style="color:#666;margin:0 0 12px">Cliente: ${customerId}</p>` : ""}

      <div style="background:#f5f7fa;padding:12px 16px;border-radius:6px;margin:16px 0">
        <strong>${result.procesadas.length}</strong> procesadas
        · <strong>${result.saltadas.length}</strong> saltadas
        · <strong style="color:${result.errores.length ? "#c00" : "#222"}">${result.errores.length}</strong> errores
        ${result.procesadas.length > 0 ? `<br><span style="color:#666">Total procesado: <b>${moneyCO(totalProc)}</b></span>` : ""}
      </div>

      ${
        procRows
          ? `<h3 style="margin:20px 0 8px">✅ Procesadas (${result.procesadas.length})</h3>
             <table style="border-collapse:collapse;width:100%;font-size:14px">
               <thead><tr style="background:#fafafa">
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">Fecha</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">Proveedor</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">N° Factura</th>
                 <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ddd">Total</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd"></th>
               </tr></thead>
               <tbody>${procRows}</tbody>
             </table>`
          : `<p style="color:#666;margin:16px 0">Sin facturas nuevas hoy.</p>`
      }

      ${
        errRows
          ? `<h3 style="margin:24px 0 8px;color:#c00">⚠️ Errores (${result.errores.length})</h3>
             <table style="border-collapse:collapse;width:100%;font-size:14px">
               <thead><tr style="background:#fff5f5">
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #fcc">Asunto</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #fcc">Error</th>
               </tr></thead>
               <tbody>${errRows}</tbody>
             </table>`
          : ""
      }

      <p style="margin:28px 0 4px;color:#666;font-size:13px">
        <a href="${sheetLink}">📊 Abrir Sheet</a>
        &nbsp;·&nbsp;
        <a href="${driveLink}">📁 Abrir Drive</a>
      </p>
    </div>
  `;
}

/**
 * Email de BIENVENIDA — sale 1 sola vez después del primer run exitoso del cliente.
 * Resumen completo del año en curso: total facturas, monto, top proveedores,
 * breakdown por mes, tiempo ahorrado. Más celebratorio que el email diario.
 */
async function notifyWelcome(customerId: string): Promise<void> {
  if (emailsMuted()) {
    console.log("notifyWelcome: skip (EMAILS_ENABLED!=true)");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY ausente — no se envía notificación welcome");
    return;
  }

  const target = await resolveNotifyTarget(customerId);
  const from = process.env.NOTIFY_EMAIL_FROM || "Operatto <onboarding@resend.dev>";

  // Cargar nombre del cliente + agregados desde Supabase
  const supa = getServerClient();
  const year = new Date().getFullYear();

  const { data: cli } = await supa
    .from("clientes")
    .select("id, nombre")
    .eq("slug", customerId)
    .single();
  const clienteNombre = (cli as { nombre?: string } | null)?.nombre ?? customerId;
  const clienteId = (cli as { id?: string } | null)?.id;

  if (!clienteId) {
    console.warn(`[welcome] cliente ${customerId} no encontrado en clientes`);
    return;
  }

  // Cargar todos los events del año en curso
  const startYear = `${year}-01-01`;
  const endYear = `${year + 1}-01-01`;
  const { data: events } = await supa
    .from("agent_events")
    .select("payload")
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion")
    .eq("tipo", "factura_procesada")
    .gte("payload->>fecha", startYear)
    .lt("payload->>fecha", endYear);

  const list = (events as Array<{ payload: any }> | null) ?? [];
  const total = list.length;
  const totalMonto = list.reduce((s, ev) => s + (Number(ev.payload?.total) || 0), 0);
  const tiempoMinutos = total * 10; // 10 min/factura
  const tiempoHoras = Math.round((tiempoMinutos / 60) * 10) / 10;
  const tiempoDias = Math.round((tiempoHoras / 8) * 10) / 10;

  // Top 5 proveedores
  const proveedoresMap = new Map<string, { count: number; monto: number }>();
  for (const ev of list) {
    const p = ev.payload?.proveedor || "Sin nombre";
    const t = Number(ev.payload?.total) || 0;
    const cur = proveedoresMap.get(p) ?? { count: 0, monto: 0 };
    cur.count++;
    cur.monto += t;
    proveedoresMap.set(p, cur);
  }
  const topProveedores = Array.from(proveedoresMap.entries())
    .map(([proveedor, agg]) => ({ proveedor, ...agg }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Breakdown por mes
  const mesesMap = new Map<string, { count: number; monto: number }>();
  for (const ev of list) {
    const fecha = ev.payload?.fecha;
    if (!fecha) continue;
    const ymKey = fecha.slice(0, 7); // YYYY-MM
    const cur = mesesMap.get(ymKey) ?? { count: 0, monto: 0 };
    cur.count++;
    cur.monto += Number(ev.payload?.total) || 0;
    mesesMap.set(ymKey, cur);
  }
  const mesesOrdenados = Array.from(mesesMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, agg]) => {
      const [, m] = key.split("-");
      const mesName = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
                       "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"][parseInt(m, 10) - 1];
      return { mes: mesName, ...agg };
    });

  const subject = `🎉 Operatto desatrasó tu ${year} — ${total} facturas listas`;
  const html = renderWelcomeHtml({
    clienteNombre,
    year,
    total,
    totalMonto,
    tiempoHoras,
    tiempoDias,
    topProveedores,
    mesesOrdenados,
    sheetLink: target.sheetLink,
    driveLink: target.driveLink,
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to: [target.to], subject, html }),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("Resend welcome error:", res.status, txt);
  } else {
    console.log(`[welcome] email enviado a ${target.to} — ${total} facturas`);
  }
}

interface WelcomeData {
  clienteNombre: string;
  year: number;
  total: number;
  totalMonto: number;
  tiempoHoras: number;
  tiempoDias: number;
  topProveedores: Array<{ proveedor: string; count: number; monto: number }>;
  mesesOrdenados: Array<{ mes: string; count: number; monto: number }>;
  sheetLink: string;
  driveLink: string;
}

function renderWelcomeHtml(d: WelcomeData): string {
  const moneyCO = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");

  const proveedoresRows = d.topProveedores
    .map((p, i) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#888;font-variant-numeric:tabular-nums">${i + 1}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${escapeHtml(p.proveedor)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${p.count}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${moneyCO(p.monto)}</td>
      </tr>`)
    .join("");

  const mesesRows = d.mesesOrdenados
    .map((m) => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${m.mes}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${m.count}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${moneyCO(m.monto)}</td>
      </tr>`)
    .join("");

  return `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:0 auto;color:#222;padding:24px">
  <div style="text-align:center;padding:32px 16px;background:linear-gradient(135deg,#1a3a5c 0%,#2c5282 100%);color:#fff;border-radius:12px;margin-bottom:24px">
    <div style="font-size:48px;margin-bottom:12px">🎉</div>
    <h1 style="margin:0 0 8px;font-size:28px;font-weight:600">Operatto desatrasó tu ${d.year}</h1>
    <p style="margin:0;font-size:16px;opacity:0.9">Hola ${escapeHtml(d.clienteNombre)} — esto fue lo que procesamos</p>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
    <div style="background:#f5f7fa;padding:20px;border-radius:8px;text-align:center">
      <div style="font-size:36px;font-weight:600;color:#1a3a5c;line-height:1">${d.total}</div>
      <div style="font-size:13px;color:#666;margin-top:6px">facturas procesadas</div>
    </div>
    <div style="background:#f5f7fa;padding:20px;border-radius:8px;text-align:center">
      <div style="font-size:36px;font-weight:600;color:#1a3a5c;line-height:1">${moneyCO(d.totalMonto)}</div>
      <div style="font-size:13px;color:#666;margin-top:6px">monto registrado</div>
    </div>
    <div style="background:#fef9e7;padding:20px;border-radius:8px;text-align:center;grid-column:1/3">
      <div style="font-size:24px;font-weight:600;color:#8a6d00;line-height:1">${d.tiempoHoras} h</div>
      <div style="font-size:13px;color:#806600;margin-top:6px">≈ ${d.tiempoDias} días de trabajo ahorrado (10 min/factura)</div>
    </div>
  </div>

  ${d.mesesOrdenados.length > 0 ? `
    <h2 style="margin:24px 0 8px;font-size:18px;color:#1a3a5c">📊 Por mes</h2>
    <table style="border-collapse:collapse;width:100%;font-size:14px;background:#fff">
      <thead><tr style="background:#fafafa">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd;color:#666;font-weight:600">Mes</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #ddd;color:#666;font-weight:600">Facturas</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #ddd;color:#666;font-weight:600">Monto</th>
      </tr></thead>
      <tbody>${mesesRows}</tbody>
    </table>
  ` : ""}

  ${d.topProveedores.length > 0 ? `
    <h2 style="margin:24px 0 8px;font-size:18px;color:#1a3a5c">🏆 Top 5 proveedores</h2>
    <table style="border-collapse:collapse;width:100%;font-size:14px;background:#fff">
      <thead><tr style="background:#fafafa">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd;color:#666;font-weight:600">#</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd;color:#666;font-weight:600">Proveedor</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #ddd;color:#666;font-weight:600">Facturas</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #ddd;color:#666;font-weight:600">Monto</th>
      </tr></thead>
      <tbody>${proveedoresRows}</tbody>
    </table>
  ` : ""}

  <div style="background:#f0f9ff;padding:20px;border-radius:8px;margin:24px 0;border-left:4px solid #1a3a5c">
    <h3 style="margin:0 0 12px;font-size:16px;color:#1a3a5c">📁 Tus archivos</h3>
    <p style="margin:0;font-size:14px;line-height:1.6">
      <a href="${d.sheetLink}" style="color:#1a3a5c;font-weight:600;text-decoration:none">📊 Abrir tu Sheet con Dashboard →</a><br>
      <a href="${d.driveLink}" style="color:#1a3a5c;font-weight:600;text-decoration:none">📁 Abrir carpeta Drive con todos los PDFs →</a>
    </p>
  </div>

  <div style="background:#fff;padding:20px;border:1px solid #e5e7eb;border-radius:8px;margin:24px 0">
    <h3 style="margin:0 0 8px;font-size:16px;color:#1a3a5c">¿Qué sigue?</h3>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#444">
      Operatto va a procesar todas tus facturas nuevas <strong>todos los días a las 7:00am</strong> (zona Bogotá).
      Vas a recibir un email diario con el resumen del día. No tenés que hacer nada — solo abrir tu Sheet
      cuando quieras revisar.
    </p>
  </div>

  <p style="margin:32px 0 0;font-size:13px;color:#888;text-align:center">
    Cualquier cosa, escribime. — Tomás
  </p>
</div>
`;
}

function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
