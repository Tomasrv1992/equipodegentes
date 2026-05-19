/**
 * Equipo-inspector — agente diario que valida la ejecución del cron de
 * facturación del día anterior y envía un resumen al admin.
 *
 * Corre todas las mañanas a las 8am Bogotá (1h después del cron de facturación
 * 7am), para que tenga tiempo de leer los resultados ya escritos en DB.
 *
 * Etapa 1 (MVP):
 *   ✓ ¿Corrió el cron de facturación hoy para cada cliente activo?
 *   ✓ ¿Algún cliente con google_oauth_status='expired' o 'revoked'?
 *   ✓ Cerrar runs zombie (status='running' por más de 30 min).
 *   ✓ Resumen por cliente: procesadas / errores / saltadas del último run.
 *
 * Etapa 2 (futuro):
 *   - Coincidencia Gmail / Drive / Sheet por cliente
 *   - Verificación de emails entregados (Resend)
 *   - Costo Anthropic del día
 *   - Detección de "0 facturas en 7 días" como anomalía
 */

import { getServerClient } from "../../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../../shared/agents-runtime/src/credentials";
import { chequearCoincidencia, type CoincidenciaResult } from "./coincidencia";

export interface ClienteCheckResult {
  cliente_id: string;
  slug: string;
  nombre: string;
  /** Estado del último run del día. */
  estado:
    | "ok"           // corrió + status='ok'
    | "warn"         // corrió + status='warn'
    | "fail"         // corrió + status='fail'
    | "running"      // todavía corriendo (raro a las 8am pero posible)
    | "no_run"       // no corrió hoy
    | "oauth_broken" // OAuth expirado/revocado — el cron no puede correr
    | "no_agente";   // cliente no tiene agente facturación activo
  procesadas?: number;
  errores?: number;
  saltadas?: number;
  duracion_ms?: number;
  ultimo_run_started_at?: string;
  error_message?: string | null;
  oauth_status?: string | null;
  /** Coincidencia Gmail/Drive/Sheet del mes (opcional, solo si OAuth OK). */
  coincidencia?: CoincidenciaResult;
  /** Texto corto para el email. */
  detalle: string;
}

export interface InspectorReport {
  fecha: string;                // YYYY-MM-DD (en zona Bogotá)
  ts_generated: string;          // ISO timestamp
  clientes_total: number;
  clientes_ok: number;
  clientes_con_alerta: number;
  zombies_cerrados: number;
  /** Costo Anthropic del día (USD) sumando todos los runs. */
  costo_anthropic_usd: number;
  /** Cantidad de llamadas LLM del día (todos los runs). */
  llm_calls_dia: number;
  /** Si costo_anthropic_usd supera umbral, true. */
  costo_alerta: boolean;
  /** Detalle por cliente, ordenado por estado (alertas primero). */
  clientes: ClienteCheckResult[];
}

/** Umbral de alerta de costo Anthropic por día (USD). */
const COSTO_ANTHROPIC_UMBRAL_USD = 2.0;

const RUNNING_TIMEOUT_MIN = 30; // runs en running > 30min se consideran zombies

/**
 * Genera el reporte completo del inspector.
 * No envía email — solo arma los datos. El envío es responsabilidad del caller
 * (background fn).
 */
export async function runInspector(): Promise<InspectorReport> {
  const supa = getServerClient();
  const ts = new Date();
  const fecha = bogotaDate(ts);

  // === 1) Cerrar runs zombies ===============================================
  const zombieCutoff = new Date(ts.getTime() - RUNNING_TIMEOUT_MIN * 60 * 1000);
  const { data: zombies, error: zErr } = await supa
    .from("agent_runs")
    .update({
      status: "fail",
      finished_at: ts.toISOString(),
      error_message: `Zombie cerrado por inspector (running > ${RUNNING_TIMEOUT_MIN}min)`,
    })
    .eq("status", "running")
    .lt("started_at", zombieCutoff.toISOString())
    .select("id");

  if (zErr) {
    console.warn("[inspector] error cerrando zombies:", zErr.message);
  }
  const zombiesCerrados = zombies?.length ?? 0;

  // === 2) Listar todos los clientes activos =================================
  const { data: clientesActivos, error: cErr } = await supa
    .from("clientes")
    .select("id, slug, nombre, activo")
    .eq("activo", true)
    .order("slug");

  if (cErr) throw new Error(`fetch clientes failed: ${cErr.message}`);

  const clientes = (clientesActivos ?? []) as Array<{
    id: string;
    slug: string;
    nombre: string;
  }>;

  // === 3) Por cada cliente, evaluar estado ==================================
  const results: ClienteCheckResult[] = [];

  for (const c of clientes) {
    // 3a) ¿Tiene agente facturación activo?
    const { data: ca } = await supa
      .from("client_agents")
      .select("activo")
      .eq("cliente_id", c.id)
      .eq("agente_id", "facturacion")
      .maybeSingle();

    if (!ca || !(ca as any).activo) {
      results.push({
        cliente_id: c.id,
        slug: c.slug,
        nombre: c.nombre,
        estado: "no_agente",
        detalle: "Cliente sin agente Equipo-facturación activo.",
      });
      continue;
    }

    // 3b) ¿OAuth status OK?
    const { data: cred } = await supa
      .from("client_credentials")
      .select("google_oauth_status")
      .eq("cliente_id", c.id)
      .eq("agente_id", "facturacion")
      .maybeSingle();

    const oauthStatus = cred ? (cred as any).google_oauth_status : null;
    if (oauthStatus === "expired" || oauthStatus === "revoked") {
      results.push({
        cliente_id: c.id,
        slug: c.slug,
        nombre: c.nombre,
        estado: "oauth_broken",
        oauth_status: oauthStatus,
        detalle: `Google OAuth ${oauthStatus} — necesita re-onboarding. El cron no puede procesar facturas hasta resolver esto.`,
      });
      continue;
    }

    // 3c) ¿Tuvo un run hoy (zona Bogotá)?
    const dayStartUtc = bogotaDayStartUtc(ts);
    const { data: runs } = await supa
      .from("agent_runs")
      .select(
        "id, status, started_at, finished_at, duration_ms, error_message, summary, payload",
      )
      .eq("cliente_id", c.id)
      .eq("agente_id", "facturacion")
      .gte("started_at", dayStartUtc)
      .order("started_at", { ascending: false });

    const runsHoy = (runs ?? []) as Array<{
      id: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      duration_ms: number | null;
      error_message: string | null;
      summary: string | null;
      payload: any;
    }>;

    if (runsHoy.length === 0) {
      results.push({
        cliente_id: c.id,
        slug: c.slug,
        nombre: c.nombre,
        estado: "no_run",
        oauth_status: oauthStatus,
        detalle:
          "El cron de las 7am no corrió hoy para este cliente. Revisar logs de facturacion-cron.",
      });
      continue;
    }

    const lastRun = runsHoy[0];
    const payload = lastRun.payload ?? {};
    const procesadas = Number(payload.procesadas ?? 0);
    const errores = Number(payload.errores ?? 0);
    const saltadas = Number(payload.saltadas ?? 0);
    const repetidas = Number(payload.repetidas ?? 0);

    let estado: ClienteCheckResult["estado"];
    if (lastRun.status === "ok") estado = "ok";
    else if (lastRun.status === "warn") estado = "warn";
    else if (lastRun.status === "fail") estado = "fail";
    else estado = "running";

    const detalle = buildDetalle(estado, {
      procesadas,
      errores,
      saltadas,
      repetidas,
      error_message: lastRun.error_message,
    });

    results.push({
      cliente_id: c.id,
      slug: c.slug,
      nombre: c.nombre,
      estado,
      procesadas,
      errores,
      saltadas,
      duracion_ms: lastRun.duration_ms ?? undefined,
      ultimo_run_started_at: lastRun.started_at,
      error_message: lastRun.error_message,
      oauth_status: oauthStatus,
      detalle,
    });
  }

  // Ordenar: alertas primero (no_run, fail, oauth_broken, warn), OK al final
  const orderRank: Record<ClienteCheckResult["estado"], number> = {
    fail: 0,
    oauth_broken: 1,
    no_run: 2,
    warn: 3,
    running: 4,
    no_agente: 5,
    ok: 6,
  };
  results.sort((a, b) => orderRank[a.estado] - orderRank[b.estado]);

  // === 3.5) Coincidencia Gmail/Drive/Sheet (Etapa 2) =========================
  // Solo para clientes con OAuth válido. Best-effort: si falla el chequeo de un
  // cliente, lo registramos pero no rompemos el reporte.
  const oauthClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ?? "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET ?? "";
  const vaultKey = process.env.CREDENTIALS_VAULT_KEY ?? "";
  if (oauthClientId && oauthClientSecret && vaultKey) {
    for (const r of results) {
      if (r.estado === "oauth_broken" || r.estado === "no_agente") continue;
      try {
        const cred = await loadCredentials(r.cliente_id, "facturacion");
        if (!cred || !cred.google_refresh_token) continue;
        // El refresh_token ya viene desencriptado por loadCredentials (que usa el RPC)
        r.coincidencia = await chequearCoincidencia({
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          refreshToken: cred.google_refresh_token,
          driveFolderId: cred.drive_folder_id,
          sheetId: cred.sheet_id,
        });

        // Si coincidencia detectó alerta y el cliente estaba OK, escalarlo a warn
        if (r.coincidencia.alerta && r.estado === "ok") {
          r.estado = "warn";
          r.detalle = r.coincidencia.detalle;
        }

        // VALIDACIÓN ANTI-DUPLICACIÓN 2026-05-19: si el Sheet del mes actual
        // tiene MUCHO más filas que emails procesados en Gmail (ratio > 1.1),
        // es señal clara de duplicación masiva — el incidente Freshco enero
        // pasó porque el reparador truncaba lectura del Sheet a 1000 filas y
        // re-insertaba las facturas >1000 como si faltaran. Esta validación
        // hubiera detectado el problema antes de que llegara a 11K filas.
        const sheetCount = r.coincidencia.sheet_count;
        const gmailCount = r.coincidencia.gmail_count;
        if (
          r.estado === "ok" &&
          gmailCount > 0 &&
          sheetCount > gmailCount * 1.1
        ) {
          r.estado = "warn";
          r.detalle = `Sheet tiene ${sheetCount} filas pero solo ${gmailCount} emails procesados — posible duplicación (ratio ${(
            sheetCount / gmailCount
          ).toFixed(2)}×).`;
        }
      } catch (err: any) {
        console.error(
          `[inspector] coincidencia falló para ${r.slug}: ${err.message}`,
        );
      }
    }
  } else {
    console.log("[inspector] coincidencia skip — faltan env vars OAuth/vault");
  }

  const clientesConAlerta = results.filter((r) =>
    ["fail", "oauth_broken", "no_run", "warn"].includes(r.estado),
  ).length;
  const clientesOk = results.filter((r) => r.estado === "ok").length;

  // === 4) Costo Anthropic del día ============================================
  // Suma el costo estimado de TODOS los runs del día (incluye reprocessos manuales).
  // El cron escribe llmStats al payload del run (ver pipeline.ts result.llmStats).
  const dayStartUtc = bogotaDayStartUtc(ts);
  const { data: runsHoyAll } = await supa
    .from("agent_runs")
    .select("payload")
    .eq("agente_id", "facturacion")
    .gte("started_at", dayStartUtc);

  let costoAnthropicUsd = 0;
  let llmCallsDia = 0;
  for (const r of (runsHoyAll ?? []) as Array<{ payload: any }>) {
    const stats = r.payload?.llmStats;
    if (stats) {
      costoAnthropicUsd += Number(stats.estimatedCostUsd ?? 0);
      llmCallsDia += Number(stats.calls ?? 0);
    }
  }
  costoAnthropicUsd = Math.round(costoAnthropicUsd * 10000) / 10000;
  const costoAlerta = costoAnthropicUsd >= COSTO_ANTHROPIC_UMBRAL_USD;

  return {
    fecha,
    ts_generated: ts.toISOString(),
    clientes_total: clientes.length,
    clientes_ok: clientesOk,
    clientes_con_alerta: clientesConAlerta,
    zombies_cerrados: zombiesCerrados,
    costo_anthropic_usd: costoAnthropicUsd,
    llm_calls_dia: llmCallsDia,
    costo_alerta: costoAlerta,
    clientes: results,
  };
}

function buildDetalle(
  estado: ClienteCheckResult["estado"],
  ctx: {
    procesadas: number;
    errores: number;
    saltadas: number;
    repetidas: number;
    error_message: string | null;
  },
): string {
  if (estado === "ok") {
    return `OK — ${ctx.procesadas} procesadas, ${ctx.repetidas} repetidas, ${ctx.saltadas} saltadas.`;
  }
  if (estado === "warn") {
    return `WARN — ${ctx.procesadas} procesadas, ${ctx.errores} errores, ${ctx.repetidas} repetidas, ${ctx.saltadas} saltadas. ${ctx.error_message ?? ""}`;
  }
  if (estado === "fail") {
    return `FAIL — ${ctx.error_message ?? "sin mensaje"}`;
  }
  if (estado === "running") {
    return `Todavía corriendo. Si esto persiste a las 9am, revisar timeout.`;
  }
  return "";
}

/** Fecha actual en zona Bogotá (UTC-5), formato YYYY-MM-DD. */
function bogotaDate(now: Date): string {
  // Bogotá no tiene DST → siempre UTC-5
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(bogotaMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Inicio del día en zona Bogotá, como ISO UTC. */
function bogotaDayStartUtc(now: Date): string {
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(bogotaMs);
  d.setUTCHours(0, 0, 0, 0);
  // Volver a UTC sumando 5h
  return new Date(d.getTime() + 5 * 60 * 60 * 1000).toISOString();
}
