/**
 * Operación (/) — Panel del agente `facturacion`.
 *
 * Vista única de monitoreo del único agente en producción. Bloques:
 *   1. Salud del sistema / Costos (LLM calls, compute, runs/día 14d)
 *   2. Rendimiento (KPIs hoy: runs, % éxito 7d, p50/p95, errores)
 *   3. Facturación (última corrida por cliente)
 *   4. Errores (runs fail/warn con stack + log)
 *
 * Reusa componentes/clases existentes (Kpis, Pill, EmptyState, card, ink, accent).
 * Todas las horas en America/Bogota.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLatestRuns, useClientes } from "../lib/queries";
import Kpis from "../components/Kpis";
import Pill from "../components/Pill";
import EmptyState from "../components/EmptyState";
import type { AgentRun, Cliente, RunStatus } from "../types";

const AGENTE_ID = "facturacion";

// ============================================================================
// Helpers de fecha (zona America/Bogota)
// ============================================================================

/** Clave YYYY-MM-DD del día calendario en Bogotá. */
function bogotaDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Hora HH:mm en Bogotá. */
function bogotaTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fecha + hora larga en Bogotá. */
function bogotaDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "short",
    timeStyle: "short",
  });
}

function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

/** Percentil (interpolación lineal) sobre array YA ordenado asc. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

// ============================================================================
// Página
// ============================================================================

export default function Operacion() {
  const { data: runs, isLoading: lr } = useLatestRuns();
  const { data: clientes, isLoading: lc } = useClientes();

  if (lr || lc) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }
  if (!runs || !clientes) return null;

  // Solo runs del agente facturacion.
  const factRuns = runs.filter((r) => r.agente_id === AGENTE_ID);
  const clienteById = new Map<string, Cliente>(clientes.map((c) => [c.id, c]));

  const now = new Date();
  const todayKey = bogotaDateKey(now);
  const monthKey = todayKey.slice(0, 7); // YYYY-MM

  return (
    <div>
      {/* Header */}
      <div className="border-b border-edge pb-7 mb-8">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
          {now.toLocaleDateString("es-CO", { timeZone: "America/Bogota", dateStyle: "long" })}{" "}
          · agente facturación
        </div>
        <h1 className="font-display text-5xl font-medium tracking-tightest text-ink leading-none mb-3">
          Operación
        </h1>
        <p className="font-sans text-sm text-ink-3 max-w-[640px] leading-relaxed">
          Monitoreo del agente <strong className="text-ink">facturación</strong>: costos,
          rendimiento, última corrida por cliente y errores. Horas en zona Bogotá (UTC-5).
        </p>
      </div>

      <SaludCostos runs={factRuns} todayKey={todayKey} monthKey={monthKey} />
      <Rendimiento runs={factRuns} todayKey={todayKey} />
      <FacturacionPorCliente runs={factRuns} clienteById={clienteById} />
      <Errores runs={factRuns} clienteById={clienteById} />
    </div>
  );
}

// ============================================================================
// 1. Salud del sistema / Costos
// ============================================================================

function SaludCostos({
  runs,
  todayKey,
  monthKey,
}: {
  runs: AgentRun[];
  todayKey: string;
  monthKey: string;
}) {
  let llmHoy = 0;
  let llmMes = 0;
  let computeMsMes = 0;
  let runsHoy = 0;

  // Runs por día — últimos 14 días (Bogotá).
  const days: { key: string; label: string; count: number }[] = [];
  const dayIndex = new Map<string, number>();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = bogotaDateKey(d);
    const label = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit",
    }).format(d);
    dayIndex.set(key, days.length);
    days.push({ key, label, count: 0 });
  }

  for (const r of runs) {
    const k = bogotaDateKey(new Date(r.started_at));
    const llm = Number((r.payload as any)?.llm_calls ?? 0);
    if (k === todayKey) {
      llmHoy += llm;
      runsHoy++;
    }
    if (k.slice(0, 7) === monthKey) {
      llmMes += llm;
      computeMsMes += Number(r.duration_ms ?? 0);
    }
    const di = dayIndex.get(k);
    if (di !== undefined) days[di].count++;
  }

  const computeMin = computeMsMes / 60000;
  const gbHoras = computeMsMes / 3_600_000; // 1 GB/función asumido

  // Detección de anomalía: runs de hoy > 3× promedio de los 14 días.
  const promedio14 = days.reduce((s, d) => s + d.count, 0) / days.length;
  const anomalia = promedio14 > 0 && runsHoy > promedio14 * 3;
  const maxDay = Math.max(1, ...days.map((d) => d.count));

  return (
    <section className="mb-9">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="section-title">Salud del sistema · costos</h2>
        {anomalia && (
          <span className="font-mono text-[11px] text-accent tracking-[0.04em]">
            🚨 Runs de hoy anómalos ({runsHoy} vs ~{promedio14.toFixed(1)} promedio)
          </span>
        )}
      </div>

      <Kpis
        items={[
          { label: "LLM calls hoy", value: llmHoy.toLocaleString("es-CO"), unit: "llamadas" },
          { label: "LLM calls mes", value: llmMes.toLocaleString("es-CO"), unit: "llamadas" },
          {
            label: "Compute mes",
            value: computeMin.toFixed(0),
            unit: "min",
            meta: `≈ ${gbHoras.toFixed(2)} GB-h`,
          },
          {
            label: "Runs hoy",
            value: runsHoy,
            unit: "corridas",
            alert: anomalia,
            meta: `prom 14d ${promedio14.toFixed(1)}`,
          },
        ]}
      />

      {/* Mini-gráfico runs/día últimos 14 días */}
      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <div className="label-tight text-ink-3">Runs por día · últimos 14 días</div>
          <div className="font-mono text-[10px] text-ink-3 tabular-nums">
            {days.reduce((s, d) => s + d.count, 0)} en 14 días
          </div>
        </div>
        <div className="flex items-end gap-1.5 h-[80px]">
          {days.map((d, i) => {
            const h = (d.count / maxDay) * 80;
            const isToday = d.key === todayKey;
            return (
              <div
                key={d.key}
                className="flex-1 flex flex-col items-center justify-end gap-1"
                title={`${d.key}: ${d.count} runs`}
              >
                <div className="font-mono text-[9px] text-ink-4 tabular-nums">
                  {d.count > 0 ? d.count : ""}
                </div>
                <div
                  className="w-full rounded-sm"
                  style={{
                    height: `${Math.max(2, h)}px`,
                    background:
                      isToday && anomalia ? "var(--color-accent)" : "var(--color-ok)",
                    opacity: isToday ? 1 : 0.55,
                  }}
                />
                <div
                  className={`font-mono text-[8px] tracking-[0.02em] tabular-nums ${
                    isToday ? "text-ink" : "text-ink-4"
                  }`}
                >
                  {days.length - 1 === i || i % 2 === 0 ? d.label : ""}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// 2. Rendimiento
// ============================================================================

function Rendimiento({ runs, todayKey }: { runs: AgentRun[]; todayKey: string }) {
  const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let runsHoy = 0;
  let erroresHoy = 0;
  const durationsHoy: number[] = [];

  let ok7 = 0;
  let fail7 = 0;
  let warn7 = 0;

  for (const r of runs) {
    const k = bogotaDateKey(new Date(r.started_at));
    if (k === todayKey) {
      runsHoy++;
      if (r.status === "fail" || r.status === "warn") erroresHoy++;
      if (typeof r.duration_ms === "number") durationsHoy.push(r.duration_ms);
    }
    if (new Date(r.started_at).getTime() >= cutoff7d) {
      if (r.status === "ok") ok7++;
      else if (r.status === "fail") fail7++;
      else if (r.status === "warn") warn7++;
    }
  }

  const total7 = ok7 + fail7 + warn7;
  const exito7 = pct(ok7, total7);
  durationsHoy.sort((a, b) => a - b);
  const p50 = percentile(durationsHoy, 50);
  const p95 = percentile(durationsHoy, 95);

  return (
    <section className="mb-9">
      <h2 className="section-title mb-3">Rendimiento</h2>
      <Kpis
        items={[
          { label: "Runs hoy", value: runsHoy, unit: "corridas" },
          {
            label: "Éxito 7d",
            value: total7 > 0 ? `${exito7.toFixed(0)}%` : "—",
            meta: `${ok7} ok · ${warn7} warn · ${fail7} fail`,
            alert: total7 > 0 && exito7 < 90,
          },
          {
            label: "Latencia p50",
            value: durationsHoy.length ? fmtMs(p50) : "—",
            meta: "hoy",
          },
          {
            label: "Latencia p95",
            value: durationsHoy.length ? fmtMs(p95) : "—",
            meta: "hoy",
          },
          { label: "Errores hoy", value: erroresHoy, alert: erroresHoy > 0 },
        ]}
      />
    </section>
  );
}

// ============================================================================
// 3. Facturación · última corrida por cliente
// ============================================================================

function FacturacionPorCliente({
  runs,
  clienteById,
}: {
  runs: AgentRun[];
  clienteById: Map<string, Cliente>;
}) {
  const navigate = useNavigate();

  // runs vienen ordenados started_at desc → el primero por cliente es el más reciente.
  const ultimoPorCliente = new Map<string, AgentRun>();
  for (const r of runs) {
    if (!r.cliente_id) continue;
    if (!ultimoPorCliente.has(r.cliente_id)) ultimoPorCliente.set(r.cliente_id, r);
  }

  const filas = Array.from(ultimoPorCliente.values())
    .map((r) => ({ run: r, cliente: clienteById.get(r.cliente_id) }))
    // Solo clientes reales (no slugs sintéticos sin entry en clientes).
    .filter((f) => f.cliente)
    .sort((a, b) => (a.run.started_at < b.run.started_at ? 1 : -1));

  return (
    <section className="mb-9">
      <h2 className="section-title mb-3">Facturación · última corrida por cliente</h2>
      {filas.length === 0 ? (
        <EmptyState
          title="Sin corridas todavía"
          description="Cuando el agente facturación corra para un cliente, aparecerá acá."
          cta={null}
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-edge bg-paper-sunken">
                <Th>Cliente</Th>
                <Th>Estado</Th>
                <Th right>Duración</Th>
                <Th right>Procesadas</Th>
                <Th right>Repetidas</Th>
                <Th right>Saltadas</Th>
                <Th right>Errores</Th>
                <Th right>Hora</Th>
              </tr>
            </thead>
            <tbody>
              {filas.map(({ run, cliente }) => {
                const p = (run.payload as any) ?? {};
                const errores = Number(p.errores ?? 0);
                return (
                  <tr
                    key={run.id}
                    onClick={() => navigate(`/run/${run.id}`)}
                    className="border-b border-edge-2 hover:bg-paper-sunken/30 cursor-pointer"
                  >
                    <td className="py-2.5 px-3 text-ink font-medium">{cliente!.nombre}</td>
                    <td className="py-2.5 px-3">
                      <Pill status={run.status} />
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-3">
                      {run.duration_ms != null ? fmtMs(run.duration_ms) : "—"}
                    </td>
                    <Num value={p.procesadas} color="ok" />
                    <Num value={p.repetidas} color="muted" />
                    <Num value={p.saltadas} color="muted" />
                    <td
                      className={`py-2.5 px-3 text-right font-mono tabular-nums font-medium ${
                        errores > 0 ? "text-accent" : "text-ink-4"
                      }`}
                    >
                      {errores}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-3">
                      {bogotaTime(run.started_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Num({ value, color }: { value: unknown; color: "ok" | "muted" }) {
  const n = Number(value ?? 0);
  const cls =
    n === 0 ? "text-ink-4" : color === "ok" ? "text-ok" : "text-ink-3";
  return (
    <td className={`py-2.5 px-3 text-right font-mono tabular-nums font-medium ${cls}`}>
      {n}
    </td>
  );
}

// ============================================================================
// 4. Errores
// ============================================================================

function Errores({
  runs,
  clienteById,
}: {
  runs: AgentRun[];
  clienteById: Map<string, Cliente>;
}) {
  const errores = runs.filter(
    (r): r is AgentRun & { status: RunStatus } =>
      r.status === "fail" || r.status === "warn",
  );

  return (
    <section className="mb-9">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="section-title">Errores</h2>
        <span className="section-meta">{errores.length} con fail/warn</span>
      </div>
      {errores.length === 0 ? (
        <div className="card font-mono text-[11px] text-ink-3">
          Nada con errores. Todo en verde.
        </div>
      ) : (
        <div className="space-y-2">
          {errores.map((r) => (
            <ErrorRow
              key={r.id}
              run={r}
              cliente={r.cliente_id ? clienteById.get(r.cliente_id) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ErrorRow({ run, cliente }: { run: AgentRun; cliente?: Cliente }) {
  const [open, setOpen] = useState(false);
  const hasStack = !!run.error_stack;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3">
        <Pill status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-ink-3 tabular-nums">
              {bogotaDateTime(run.started_at)}
            </span>
            <span className="font-medium text-[12px] text-ink">
              {cliente?.nombre ?? run.cliente_id ?? "—"}
            </span>
          </div>
          <div className="font-mono text-[11px] text-accent mt-1 break-words">
            {run.error_message ?? run.summary ?? "(sin mensaje)"}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {run.netlify_log_url && (
            <a
              href={run.netlify_log_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] text-accent hover:underline tracking-[0.04em]"
            >
              ver log ↗
            </a>
          )}
          {hasStack && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="font-mono text-[11px] text-ink-3 hover:text-ink tracking-[0.04em]"
            >
              {open ? "ocultar stack" : "stack"}
            </button>
          )}
        </div>
      </div>
      {open && hasStack && (
        <pre className="bg-paper-sunken border-t border-edge-2 px-4 py-3 font-mono text-[10px] text-ink-3 leading-relaxed overflow-x-auto whitespace-pre-wrap">
          {run.error_stack}
        </pre>
      )}
    </div>
  );
}

// ============================================================================
// Subcomponentes compartidos
// ============================================================================

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
