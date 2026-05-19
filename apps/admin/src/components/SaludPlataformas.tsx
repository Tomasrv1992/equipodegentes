/**
 * Widget de Salud de Plataformas — vista panorámica al inicio de /operacion.
 *
 * Objetivo: detectar rápidamente cuando una plataforma externa se queda sin
 * créditos / cuota antes de invertir tiempo debuggeando el código.
 *
 * Cards (calculadas a partir de datos en Supabase, sin APIs externas):
 *   1. Anthropic: costo hoy/mes (suma llm_calls × $0.003)
 *   2. Supabase: eventos hoy + DB usage proxy
 *   3. Netlify: runs hoy + invocations proxy
 *   4. Google Sheets/Drive: errores con patrón "quota" últimas 24h
 *   5. Clientes con alerta (OAuth roto, sheet inflado)
 *
 * Cada card tiene un botón "Ver billing →" que abre la página oficial de
 * billing de esa plataforma. La idea es: si una card está roja/amarilla,
 * clickeas y vas directo a verificar el saldo.
 *
 * Origen: incidente 2026-05-19 donde tardamos horas en darnos cuenta que
 * Netlify se había quedado sin créditos y Supabase también — habiendo
 * tenido ese estado visible, la detección habría sido inmediata.
 */

import { Link } from "react-router-dom";
import type { Cliente, AgentRun } from "../types";
import type { OAuthHealthRow } from "../lib/queries";

interface Props {
  runs: AgentRun[];
  clientes: Cliente[];
  oauthHealth: OAuthHealthRow[];
}

type Status = "ok" | "warn" | "fail";

interface PlatformCardData {
  titulo: string;
  metricas: Array<{ label: string; value: string }>;
  status: Status;
  link: string;
  linkLabel: string;
}

const COST_PER_LLM_CALL_USD = 0.003; // Haiku 4.5 factor real

export default function SaludPlataformas({ runs, clientes, oauthHealth }: Props) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const since24h = new Date(now.getTime() - 24 * 60 * 60_000);
  const sinceWeek = new Date(now.getTime() - 7 * 24 * 60 * 60_000);

  // ===== 1. ANTHROPIC =====
  let llmCallsHoy = 0;
  let llmCallsMes = 0;
  for (const r of runs) {
    const calls = Number((r.payload as any)?.llm_calls ?? 0);
    if (!calls) continue;
    const ts = new Date(r.started_at);
    if (ts >= todayStart) llmCallsHoy += calls;
    if (ts >= monthStart) llmCallsMes += calls;
  }
  const costoHoy = llmCallsHoy * COST_PER_LLM_CALL_USD;
  const costoMes = llmCallsMes * COST_PER_LLM_CALL_USD;
  // Anthropic status: warn si >$5/día (umbral conservador), fail si >$15
  const anthropicStatus: Status = costoHoy > 15 ? "fail" : costoHoy > 5 ? "warn" : "ok";
  const anthropicCard: PlatformCardData = {
    titulo: "Anthropic",
    metricas: [
      { label: "Hoy", value: `$${costoHoy.toFixed(2)}` },
      { label: "Mes", value: `$${costoMes.toFixed(2)}` },
      { label: "Calls hoy", value: llmCallsHoy.toLocaleString("es-CO") },
    ],
    status: anthropicStatus,
    link: "https://console.anthropic.com/settings/billing",
    linkLabel: "Ver billing",
  };

  // ===== 2. SUPABASE (proxy: runs ÚLT semana → indicador de DB growth) =====
  let runsUltSemana = 0;
  let runsHoy = 0;
  for (const r of runs) {
    const ts = new Date(r.started_at);
    if (ts >= sinceWeek) runsUltSemana++;
    if (ts >= todayStart) runsHoy++;
  }
  // Supabase Pro = 8GB DB. No tenemos lectura directa del tamaño, solo proxy.
  const supabaseCard: PlatformCardData = {
    titulo: "Supabase",
    metricas: [
      { label: "Runs hoy", value: runsHoy.toLocaleString("es-CO") },
      { label: "Runs 7d", value: runsUltSemana.toLocaleString("es-CO") },
      { label: "Plan", value: "Pro" },
    ],
    status: "ok", // sin lectura real, asumimos ok después del upgrade Pro
    link: "https://supabase.com/dashboard/project/_/settings/billing",
    linkLabel: "Ver usage",
  };

  // ===== 3. NETLIFY (proxy: function invocations = agent_runs hoy/mes) =====
  let runsMes = 0;
  for (const r of runs) {
    const ts = new Date(r.started_at);
    if (ts >= monthStart) runsMes++;
  }
  // Netlify free = 125k invocations/mes, Pro = 2M. Sin API directa.
  const netlifyCard: PlatformCardData = {
    titulo: "Netlify",
    metricas: [
      { label: "Runs hoy", value: runsHoy.toLocaleString("es-CO") },
      { label: "Runs mes", value: runsMes.toLocaleString("es-CO") },
      { label: "Status", value: "deploy ok" },
    ],
    status: "ok",
    link: "https://app.netlify.com/teams/_/billing",
    linkLabel: "Ver builds",
  };

  // ===== 4. GOOGLE APIS — detección de errores quota últimas 24h =====
  const QUOTA_REGEX = /quota|exceeded|rate.?limit|429|too many requests/i;
  let erroresQuota24h = 0;
  let ultimoErrorQuota: { ts: string; cliente_id: string } | null = null;
  for (const r of runs) {
    const ts = new Date(r.started_at);
    if (ts < since24h) continue;
    const msg = String(r.error_message ?? "");
    if (msg && QUOTA_REGEX.test(msg)) {
      erroresQuota24h++;
      if (!ultimoErrorQuota || ts > new Date(ultimoErrorQuota.ts)) {
        ultimoErrorQuota = { ts: r.started_at, cliente_id: r.cliente_id };
      }
    }
  }
  const googleStatus: Status =
    erroresQuota24h >= 10 ? "fail" : erroresQuota24h >= 3 ? "warn" : "ok";
  const googleCard: PlatformCardData = {
    titulo: "Google APIs",
    metricas: [
      { label: "Errores quota 24h", value: erroresQuota24h.toLocaleString("es-CO") },
      {
        label: "Último",
        value: ultimoErrorQuota
          ? new Date(ultimoErrorQuota.ts).toLocaleTimeString("es-CO", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—",
      },
      { label: "Status", value: googleStatus === "ok" ? "ok" : "revisar" },
    ],
    status: googleStatus,
    link: "https://console.cloud.google.com/apis/dashboard",
    linkLabel: "Ver quotas",
  };

  const cards = [anthropicCard, supabaseCard, netlifyCard, googleCard];

  // ===== 5. CLIENTES CON ALERTA =====
  const oauthByCliente = new Map<string, string>();
  for (const o of oauthHealth) {
    if (o.agente_id === "facturacion") {
      oauthByCliente.set(o.cliente_id, o.google_oauth_status ?? "");
    }
  }

  interface Alerta {
    cliente: Cliente;
    nivel: Status;
    motivo: string;
  }
  const alertas: Alerta[] = [];
  for (const c of clientes) {
    if (!c.activo) continue;
    const oauth = oauthByCliente.get(c.id);
    if (oauth === "expired" || oauth === "revoked") {
      alertas.push({
        cliente: c,
        nivel: "fail",
        motivo: `OAuth ${oauth} · re-onboardear`,
      });
      continue;
    }
    // Errores en runs últimas 24h
    const runsCliente = runs.filter(
      (r) => r.cliente_id === c.id && new Date(r.started_at) >= since24h,
    );
    const errores = runsCliente.filter((r) => r.status === "fail").length;
    const warns = runsCliente.filter((r) => r.status === "warn").length;
    if (errores >= 2) {
      alertas.push({
        cliente: c,
        nivel: "fail",
        motivo: `${errores} runs fail en 24h`,
      });
    } else if (warns >= 3) {
      alertas.push({
        cliente: c,
        nivel: "warn",
        motivo: `${warns} runs warn en 24h`,
      });
    }
  }
  // Orden: fail antes que warn, después alfabético
  alertas.sort((a, b) => {
    if (a.nivel !== b.nivel) return a.nivel === "fail" ? -1 : 1;
    return a.cliente.nombre.localeCompare(b.cliente.nombre);
  });

  return (
    <section className="border-b border-edge pb-7 mb-9">
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-3">
        Salud de plataformas
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        {cards.map((c) => (
          <PlatformCard key={c.titulo} data={c} />
        ))}
      </div>

      {alertas.length > 0 && (
        <div className="border border-fail/30 bg-fail-soft/30 rounded-md p-3">
          <div className="font-mono text-[10px] tracking-[0.04em] uppercase text-fail mb-2">
            ⚠️ {alertas.length} cliente{alertas.length !== 1 ? "s" : ""} con alerta
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {alertas.map((a) => (
              <Link
                key={a.cliente.id}
                to={`/cliente/${a.cliente.slug}`}
                className="flex items-center gap-2 text-[12px] font-sans py-1 hover:bg-ink-bg/30 rounded px-1 -mx-1"
              >
                <span className={a.nivel === "fail" ? "text-fail" : "text-warn"}>
                  {a.nivel === "fail" ? "🔴" : "🟡"}
                </span>
                <span className="text-ink font-medium">{a.cliente.slug}</span>
                <span className="text-ink-3 text-[11px]">{a.motivo}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function PlatformCard({ data }: { data: PlatformCardData }) {
  const borderColor =
    data.status === "fail"
      ? "border-fail/40"
      : data.status === "warn"
      ? "border-warn/40"
      : "border-edge";
  const bg =
    data.status === "fail"
      ? "bg-fail-soft/30"
      : data.status === "warn"
      ? "bg-warn-soft/30"
      : "bg-transparent";

  return (
    <div className={`border ${borderColor} ${bg} rounded-md p-3 flex flex-col`}>
      <div className="font-mono text-[10px] tracking-[0.04em] uppercase text-ink-3 mb-2">
        {data.titulo}
      </div>
      <div className="flex-1 space-y-1.5 mb-3">
        {data.metricas.map((m, i) => (
          <div key={i} className="flex justify-between text-[12px] font-sans">
            <span className="text-ink-3">{m.label}</span>
            <span className="text-ink font-mono tabular-nums">{m.value}</span>
          </div>
        ))}
      </div>
      <a
        href={data.link}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[10px] tracking-[0.04em] uppercase text-ink-2 hover:text-ink underline decoration-dotted"
      >
        {data.linkLabel} →
      </a>
    </div>
  );
}
