/**
 * /operacion (home) — Vista gerencial.
 *
 * No es operativa (eso es /diagnostico). Acá querés ver el negocio:
 *   - KPIs de negocio con delta vs mes anterior
 *   - Lo que requiere TU acción HOY (generado por Claude)
 *   - Salud de clientes con sparkline 30d
 *   - Pipeline de onboarding
 *   - Charts comparativos últimos 6 meses
 *   - Botón "Reporte ejecutivo del mes" (Claude resume el mes)
 */

import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "../lib/supabase";
import {
  useClientes,
  useAgentes,
  useLatestRuns,
  useClientAgents,
  useAllFacturas,
} from "../lib/queries";
import {
  facturasThisMonth,
  tiempoAhorradoHoras,
  formatHoras,
  aggFacturasByMonth,
} from "../lib/metrics";
import type { Cliente, AgentEvent } from "../types";
import EmptyState from "./EmptyState";

interface FacturaPayload {
  fecha?: string;
  total?: number;
  proveedor?: string;
}

export default function Matriz() {
  const { data: clientes, isLoading: lc } = useClientes();
  const { data: agentes, isLoading: la } = useAgentes();
  const { data: runs, isLoading: lr } = useLatestRuns();
  const { data: activaciones, isLoading: lac } = useClientAgents();
  const { data: facturas, isLoading: lf } = useAllFacturas();
  const onboarding = useOnboardingPipeline();

  if (lc || la || lr || lac || lf) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }
  if (!clientes || !agentes || !runs || !activaciones || !facturas) return null;

  // ===== KPIs de NEGOCIO =====
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const facturasMesActual = facturasThisMonth(facturas);
  const facturasMesAnterior = facturasThisMonth(facturas, prevMonth);
  const factMes = facturasMesActual.length;
  const factMesPrev = facturasMesAnterior.length;
  const deltaFactPct = factMesPrev > 0 ? ((factMes - factMesPrev) / factMesPrev) * 100 : null;

  // Clientes activos = tienen al menos 1 factura este mes
  const clientesActivosIds = new Set(facturasMesActual.map((f) => f.cliente_id));
  const clientesActivosMesPrev = new Set(facturasMesAnterior.map((f) => f.cliente_id));
  const totalClientes = clientes.length;
  const deltaClientes = clientesActivosIds.size - clientesActivosMesPrev.size;

  // Costo Anthropic mes actual (suma de payload.llm_cost_usd en runs facturación)
  let costoMes = 0;
  for (const r of runs) {
    if (r.agente_id !== "facturacion") continue;
    const d = new Date(r.started_at);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      costoMes += Number((r.payload as any)?.llm_cost_usd ?? 0);
    }
  }
  const costoPorFactura = factMes > 0 ? costoMes / factMes : 0;

  // Horas ahorradas
  const horasAhorradasMes = tiempoAhorradoHoras(factMes);
  const horasAhorradasMesPrev = tiempoAhorradoHoras(factMesPrev);

  return (
    <div>
      {/* === HERO: KPIs de negocio === */}
      <section className="border-b border-edge pb-7 mb-9">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
          {formatDateTitle(now)} · operación
        </div>
        <h1 className="font-display text-5xl font-medium tracking-tightest text-ink leading-none mb-6">
          {factMes > 0 ? (
            <>
              {factMes.toLocaleString("es-CO")} facturas
              <br />
              <em className="italic font-normal text-ink-2">
                este mes.
              </em>
            </>
          ) : (
            <>
              Mes recién empezado.
              <br />
              <em className="italic font-normal text-ink-2">Esperando primer batch.</em>
            </>
          )}
        </h1>

        <div className="grid grid-cols-4 gap-3">
          <KpiCard
            label="Facturas mes"
            value={factMes.toLocaleString("es-CO")}
            delta={deltaFactPct}
            subtitle={`vs ${factMesPrev} el mes pasado`}
          />
          <KpiCard
            label="Clientes activos"
            value={`${clientesActivosIds.size} / ${totalClientes}`}
            deltaAbs={deltaClientes}
            subtitle={
              deltaClientes > 0
                ? `+${deltaClientes} este mes`
                : deltaClientes < 0
                  ? `${deltaClientes} este mes`
                  : "sin cambios"
            }
          />
          <KpiCard
            label="Horas ahorradas"
            value={formatHoras(horasAhorradasMes)}
            delta={
              horasAhorradasMesPrev > 0
                ? ((horasAhorradasMes - horasAhorradasMesPrev) / horasAhorradasMesPrev) * 100
                : null
            }
            subtitle={`vs ${formatHoras(horasAhorradasMesPrev)} el mes pasado`}
          />
          <KpiCard
            label="Costo / factura"
            value={`$${costoPorFactura.toFixed(3)}`}
            subtitle={`$${costoMes.toFixed(2)} en LLM este mes`}
            invertColor
          />
        </div>
      </section>

      {/* === LO QUE REQUIERE TU ACCIÓN HOY === */}
      <ReporteEjecutivoMensual />

      {/* === CLIENTES (resumen + link a tabla completa) === */}
      <section className="mb-9">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="section-title">Clientes</h2>
          <Link
            to="/clientes"
            className="font-mono text-[11px] text-accent hover:underline tracking-[0.04em]"
          >
            ver tabla completa →
          </Link>
        </div>
        {clientes.length === 0 ? (
          <EmptyState
            title="Sin clientes todavía"
            description="Cuando crees un cliente y actives el Procesador, aparecerán acá."
            cta={{ label: "Crear primer cliente", to: "/nuevo-cliente" }}
          />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <ResumenClientesCard
              label="Activos este mes"
              value={clientesActivosIds.size}
              total={totalClientes}
              accent="ok"
            />
            <ResumenClientesCard
              label="Sin actividad 7+ días"
              value={contarSinActividad(clientes, facturas, 7)}
              total={totalClientes}
              accent="warn"
            />
            <ResumenClientesCard
              label="Onboarding en curso"
              value={onboarding.data?.enProgreso.length ?? 0}
              total={totalClientes}
              accent="neutral"
            />
          </div>
        )}
      </section>

      {/* === CHARTS COMPARATIVOS 6 MESES === */}
      <section className="mb-9">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="section-title">Histórico · últimos 6 meses</h2>
        </div>
        <HistoricoMensual facturas={facturas} />
      </section>
    </div>
  );
}

// ============================================================================
// KPI Cards (con delta)
// ============================================================================

function KpiCard({
  label,
  value,
  delta,
  deltaAbs,
  subtitle,
  invertColor,
}: {
  label: string;
  value: string | number;
  delta?: number | null;
  deltaAbs?: number;
  subtitle?: string;
  invertColor?: boolean;
}) {
  const hasDelta = delta !== undefined && delta !== null && !isNaN(delta);
  const isPositive = hasDelta ? delta! > 0 : deltaAbs !== undefined ? deltaAbs > 0 : null;
  const isNegative = hasDelta ? delta! < 0 : deltaAbs !== undefined ? deltaAbs < 0 : null;
  // invertColor: para "costo por factura", bajar es bueno
  const arrowColor = invertColor
    ? isPositive
      ? "text-accent"
      : isNegative
        ? "text-ok"
        : "text-ink-4"
    : isPositive
      ? "text-ok"
      : isNegative
        ? "text-accent"
        : "text-ink-4";

  return (
    <div className="card">
      <div className="label-tight text-ink-3 mb-1.5">{label}</div>
      <div className="flex items-baseline gap-2 mb-1">
        <div className="font-display text-3xl font-medium tracking-[-0.02em] tabular-nums text-ink leading-none">
          {value}
        </div>
        {hasDelta && (
          <div className={`font-mono text-[11px] tabular-nums ${arrowColor}`}>
            {delta! > 0 ? "↗" : delta! < 0 ? "↘" : "→"} {Math.abs(delta!).toFixed(0)}%
          </div>
        )}
        {!hasDelta && deltaAbs !== undefined && deltaAbs !== 0 && (
          <div className={`font-mono text-[11px] tabular-nums ${arrowColor}`}>
            {deltaAbs > 0 ? `+${deltaAbs}` : deltaAbs}
          </div>
        )}
      </div>
      {subtitle && (
        <div className="font-mono text-[9px] text-ink-4 tracking-[0.04em] uppercase">
          {subtitle}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Reporte ejecutivo mensual (botón)
// ============================================================================

function ReporteEjecutivoMensual() {
  const [reporte, setReporte] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: async () => {
      const { data: sess } = await supabase.auth.getSession();
      const accessToken = sess.session?.access_token;
      const resp = await fetch("/api/operacion-reporte-mes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ fecha: new Date().toISOString() }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      const json = await resp.json();
      return json.reporte as string;
    },
    onSuccess: (r) => setReporte(r),
  });

  return (
    <section className="mb-9 card">
      <div className="flex items-start justify-between mb-2 gap-4">
        <div>
          <h2 className="font-display text-base font-semibold tracking-tighter mb-0.5">
            Lo que requiere tu atención
          </h2>
          <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase">
            Claude analiza el mes y te dice qué decisiones tomar
          </p>
        </div>
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
          className="btn-primary disabled:opacity-50 shrink-0"
        >
          {mut.isPending ? "Analizando…" : reporte ? "Regenerar" : "Generar análisis"}
        </button>
      </div>
      {mut.isError && (
        <div className="font-mono text-[11px] text-accent mt-2">
          Error: {(mut.error as Error).message}
        </div>
      )}
      {reporte && (
        <div className="mt-3 pt-3 border-t border-edge-2 font-sans text-[13px] text-ink whitespace-pre-wrap leading-relaxed">
          {reporte}
        </div>
      )}
    </section>
  );
}

// ============================================================================
// Resumen Clientes Card (gerencial)
// ============================================================================

function ResumenClientesCard({
  label,
  value,
  total,
  accent,
}: {
  label: string;
  value: number;
  total: number;
  accent: "ok" | "warn" | "neutral";
}) {
  const colorClass =
    value === 0
      ? "text-ink-4"
      : accent === "ok"
        ? "text-ok"
        : accent === "warn"
          ? "text-accent"
          : "text-ink";
  return (
    <Link to="/clientes" className="card card-hover no-underline text-ink">
      <div className="label-tight text-ink-3 mb-1.5">{label}</div>
      <div className="flex items-baseline gap-2">
        <span
          className={`font-display text-3xl font-medium tracking-[-0.02em] tabular-nums leading-none ${colorClass}`}
        >
          {value}
        </span>
        <span className="font-mono text-[10px] text-ink-4">de {total}</span>
      </div>
    </Link>
  );
}

function contarSinActividad(
  clientes: Cliente[],
  facturas: AgentEvent[],
  dias: number,
): number {
  const cutoff = Date.now() - dias * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const c of clientes) {
    if (!c.activo) continue;
    const factCliente = facturas.filter((f) => f.cliente_id === c.id);
    const fechas = factCliente
      .map((f) => (f.payload as FacturaPayload | null)?.fecha)
      .filter((d): d is string => !!d)
      .sort();
    const ultima = fechas[fechas.length - 1];
    if (!ultima) {
      count++;
      continue;
    }
    const ultimaMs = new Date(ultima + "T00:00:00").getTime();
    if (ultimaMs < cutoff) count++;
  }
  return count;
}


function HistoricoMensual({ facturas }: { facturas: AgentEvent[] }) {
  const meses = aggFacturasByMonth(facturas, 6);
  const totalMonto = (events: AgentEvent[]): number => {
    let total = 0;
    for (const ev of events) {
      const t = (ev.payload as FacturaPayload | null)?.total;
      if (typeof t === "number") total += t;
    }
    return total;
  };

  // Calcular monto $ por mes
  const mesesConMonto = meses.map((m) => {
    const factDelMes = facturas.filter((f) => {
      const fecha = (f.payload as FacturaPayload | null)?.fecha;
      return fecha?.slice(0, 7) === m.key;
    });
    return { ...m, monto: totalMonto(factDelMes) };
  });

  const maxFact = Math.max(1, ...mesesConMonto.map((m) => m.procesadas));
  const maxMonto = Math.max(1, ...mesesConMonto.map((m) => m.monto));

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <div className="label-tight text-ink-3">Facturas por mes</div>
          <div className="font-mono text-[10px] text-ink-3 tabular-nums">
            {mesesConMonto.reduce((s, m) => s + m.procesadas, 0)} en 6 meses
          </div>
        </div>
        <BarsMensuales data={mesesConMonto} valueKey="procesadas" max={maxFact} color="ink" />
      </div>
      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <div className="label-tight text-ink-3">Volumen $ procesado</div>
          <div className="font-mono text-[10px] text-ink-3 tabular-nums">
            ${(mesesConMonto.reduce((s, m) => s + m.monto, 0) / 1_000_000).toFixed(0)}M COP
          </div>
        </div>
        <BarsMensuales
          data={mesesConMonto}
          valueKey="monto"
          max={maxMonto}
          color="accent"
          format={(v) => `$${(v / 1_000_000).toFixed(1)}M`}
        />
      </div>
    </div>
  );
}

function BarsMensuales({
  data,
  valueKey,
  max,
  color,
  format = (v: number) => v.toString(),
}: {
  data: Array<{ label: string; procesadas: number; monto?: number; key: string }>;
  valueKey: "procesadas" | "monto";
  max: number;
  color: "ok" | "accent" | "ink";
  format?: (v: number) => string;
}) {
  const fillVar = color === "ok" ? "var(--color-ok)" : color === "accent" ? "var(--color-accent)" : "var(--color-ink)";
  const height = 120;
  return (
    <div>
      <div className="flex items-end gap-3 h-[120px] mb-2">
        {data.map((m, i) => {
          const v = (m as any)[valueKey] as number;
          const h = (v / max) * height;
          const isLast = i === data.length - 1;
          return (
            <div key={m.key} className="flex-1 flex flex-col items-center justify-end gap-1">
              <div className="font-mono text-[9px] text-ink-3 tabular-nums">{v > 0 ? format(v) : ""}</div>
              <div
                className="w-full rounded-sm"
                style={{
                  height: `${Math.max(1, h)}px`,
                  background: fillVar,
                  opacity: isLast ? 1 : 0.6,
                }}
                title={`${m.label}: ${format(v)}`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-3">
        {data.map((m, i) => (
          <div
            key={m.key}
            className={`flex-1 text-center font-mono text-[9px] tracking-[0.04em] uppercase ${i === data.length - 1 ? "text-ink" : "text-ink-4"}`}
          >
            {m.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDateTitle(d: Date): string {
  const day = d.toLocaleDateString("es-CO", { day: "2-digit" });
  const mon = d.toLocaleDateString("es-CO", { month: "short" }).replace(".", "");
  const yr = d.getFullYear().toString().slice(-2);
  return `${day}.${mon}.${yr}`;
}

// Hook que cuenta clientes en proceso de onboarding (no completado)
function useOnboardingPipeline() {
  return useQuery({
    queryKey: ["onboarding-pipeline"],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("onboarding_tokens")
        .select("token, step")
        .in("step", ["pending", "oauth_done", "fiscal_pending", "resources_done"]);
      return { enProgreso: (data ?? []) as any[] };
    },
  });
}
