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
   * Si true y customerId presente, en lugar de un único run, dispara 12
   * invocaciones (una por mes) y termina. Útil para primer run + force=true
   * en clientes con alto volumen — evita timeout de Netlify 15min.
   * El dispatcher recibe este request y abre 12 fan-outs paralelos.
   */
  multiPass?: boolean;
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
    const dispatches: Array<Promise<any>> = [];
    for (let mes = 1; mes <= 12; mes++) {
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
            silent: body.silent ?? true, // silent por default en multi-pass (12 emails es spam)
            monthFilter: mes,
          }),
        }).catch((e) => console.warn(`[multi-pass] dispatch mes ${mes} failed: ${e.message}`)),
      );
    }
    console.log(`[multi-pass] cliente=${body.customerId} → disparando 12 invocaciones paralelas`);
    await Promise.all(dispatches);
    return new Response(
      JSON.stringify({ ok: true, multiPass: true, monthsDispatched: 12 }),
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

  // 3.5. AUTO MULTI-PASS para clientes en first_run o force=true.
  //      Disparamos 12 invocaciones paralelas (1 por mes) para evitar timeout
  //      en clientes grandes. Si el body trae monthFilter o multiPass=false
  //      explícito, NO auto-disparamos (respetamos lo que vino).
  const shouldAutoFanOut =
    body.customerId &&
    body.monthFilter == null &&
    !body.multiPass &&
    (wasFirstRun || body.force === true);

  if (shouldAutoFanOut) {
    const baseUrl = process.env.URL;
    if (baseUrl) {
      const target = `${baseUrl}/.netlify/functions/facturacion-background`;
      const dispatches: Array<Promise<any>> = [];
      for (let mes = 1; mes <= 12; mes++) {
        dispatches.push(
          fetch(target, {
            method: "POST",
            headers: {
              "x-internal-secret": secret,
              "x-trigger": "auto-multi-pass",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              customerId: body.customerId,
              force: body.force ?? false,
              silent: true, // siempre silent en fan-out (sino 12 emails al cliente)
              monthFilter: mes,
            }),
          }).catch((e) => console.warn(`[auto-fan-out] mes ${mes} failed: ${e.message}`)),
        );
      }
      console.log(`[auto-fan-out] cliente=${body.customerId} (${wasFirstRun ? "first_run" : "force"}) → disparando 12 invocaciones paralelas (1 por mes)`);
      await Promise.all(dispatches);
      // Marcar first_run_done para que próxima vez NO vuelva a hacer fan-out
      if (wasFirstRun && credBefore) {
        try {
          const supa = getServerClient();
          await supa.rpc("client_credentials_mark_first_run_done", {
            p_cliente_id: credBefore.cliente_id,
            p_agente_id: "facturacion",
          });
        } catch (err: any) {
          console.warn(`[auto-fan-out] failed mark first_run_done: ${err.message}`);
        }
      }
      return new Response(
        JSON.stringify({ ok: true, autoFanOut: true, monthsDispatched: 12 }),
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
    sample: result.procesadas.slice(0, 3),
  }));

  // Registrar fin OK (o WARN si hubo errores parciales)
  if (runId) {
    try {
      const status: "ok" | "warn" = result.errores.length > 0 ? "warn" : "ok";
      const summary =
        `${result.procesadas.length} procesadas` +
        (result.errores.length ? ` · ${result.errores.length} errores` : "") +
        (result.saltadas.length ? ` · ${result.saltadas.length} saltadas` : "");
      await recordRunEnd({
        runId,
        status,
        durationMs,
        summary,
        payload: {
          procesadas: result.procesadas.length,
          errores: result.errores.length,
          saltadas: result.saltadas.length,
          // Tracking de uso LLM para visibilidad de costo por cliente/run
          llm_calls: result.llmStats?.calls ?? 0,
          llm_cost_usd: result.llmStats?.estimatedCostUsd ?? 0,
          llm_pre_filtered: result.llmStats?.preFilteredOut ?? 0,
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

async function notifyResult(result: PipelineResult, customerId?: string): Promise<void> {
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

async function notifyError(err: Error, customerId?: string): Promise<void> {
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
