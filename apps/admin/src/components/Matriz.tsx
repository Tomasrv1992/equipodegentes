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
  const totalClientes = clientes.length;

  // Costo Anthropic recalculado desde llm_calls × $0.003 (factor real Haiku 4.5)
  let llmCallsMes = 0;
  for (const r of runs) {
    if (r.agente_id !== "facturacion") continue;
    const d = new Date(r.started_at);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      llmCallsMes += Number((r.payload as any)?.llm_calls ?? 0);
    }
  }
  const costoMes = llmCallsMes * 0.003;
  const costoPorFactura = factMes > 0 ? costoMes / factMes : 0;

  // Horas ahorradas + VALOR económico equivalente.
  // Tarifa de contadora junior promedio Colombia: $30.000 COP/hora.
  const HORAS_POR_FACTURA = 10 / 60; // 10 minutos
  const TARIFA_CONTADORA_COP = 30_000;
  const USD_COP = 4200;
  const horasAhorradasMes = factMes * HORAS_POR_FACTURA;
  const valorEntregadoCop = horasAhorradasMes * TARIFA_CONTADORA_COP;
  const valorEntregadoUsd = valorEntregadoCop / USD_COP;
  const costoMesCop = costoMes * USD_COP;
  const ratioROI = costoMesCop > 0 ? valorEntregadoCop / costoMesCop : 0;

  return (
    <div>
      {/* === HERO: VALOR ENTREGADO === */}
      <section className="border-b border-edge pb-7 mb-9">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
          {formatDateTitle(now)} · operación
        </div>
        <h1 className="font-display text-5xl font-medium tracking-tightest text-ink leading-none mb-2">
          Valor entregado
          <br />
          <em className="italic font-normal text-ink-2">este mes.</em>
        </h1>
        <p className="font-sans text-sm text-ink-3 mt-3 mb-6 max-w-[640px]">
          Operatto procesó <strong className="text-ink">{factMes.toLocaleString("es-CO")} facturas</strong> para{" "}
          <strong className="text-ink">{clientesActivosIds.size} clientes</strong> · ahorró{" "}
          <strong className="text-ink">{formatHoras(horasAhorradasMes)}</strong> de tiempo humano ·
          equivalentes a <strong className="text-ink">${formatCop(valorEntregadoCop)} COP</strong> en
          tarifa de contadora (${TARIFA_CONTADORA_COP.toLocaleString("es-CO")}/h).
        </p>

        {/* 4 KPIs gerenciales */}
        <div className="grid grid-cols-4 gap-3">
          <ValorCard
            label="Valor entregado"
            value={`$${formatCop(valorEntregadoCop)}`}
            unit="COP este mes"
            sub={`≈ $${valorEntregadoUsd.toFixed(0)} USD · ${formatHoras(horasAhorradasMes)} ahorradas`}
            delta={
              factMesPrev > 0 ? ((factMes - factMesPrev) / factMesPrev) * 100 : null
            }
            accent="ok"
          />
          <ValorCard
            label="Costo Operatto"
            value={`$${costoMes.toFixed(2)}`}
            unit="USD este mes"
            sub={`≈ $${formatCop(costoMesCop)} COP · ${llmCallsMes.toLocaleString("es-CO")} llamadas LLM`}
            accent="neutral"
          />
          <ValorCard
            label="ROI"
            value={ratioROI > 0 ? `${Math.round(ratioROI)}×` : "—"}
            unit="valor / costo"
            sub={
              ratioROI > 0
                ? `Cada $1 invertido en LLM devuelve $${Math.round(ratioROI)} en tiempo humano`
                : "Sin gasto LLM aún"
            }
            accent={ratioROI >= 100 ? "ok" : ratioROI >= 50 ? "neutral" : "warn"}
          />
          <ValorCard
            label="Volumen activo"
            value={`${factMes.toLocaleString("es-CO")}`}
            unit="facturas · mes"
            sub={
              deltaFactPct !== null
                ? `${deltaFactPct >= 0 ? "↗" : "↘"} ${Math.abs(deltaFactPct).toFixed(0)}% vs ${factMesPrev} mes pasado`
                : `${clientesActivosIds.size} de ${totalClientes} clientes generando`
            }
            accent={deltaFactPct !== null && deltaFactPct > 0 ? "ok" : "neutral"}
          />
        </div>

        {/* Costo por factura — pequeño abajo */}
        <div className="mt-4 font-mono text-[11px] text-ink-3">
          Costo unitario: <span className="tabular-nums">${costoPorFactura.toFixed(3)}</span> USD/factura ·
          equivalente a <span className="tabular-nums">${(costoPorFactura * USD_COP).toFixed(0)}</span> COP por
          factura procesada.
        </div>
      </section>

      {/* === TOP CLIENTES POR VALOR ENTREGADO === */}
      <section className="mb-9">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="section-title">Top clientes · valor que te aportan</h2>
          <Link
            to="/clientes"
            className="font-mono text-[11px] text-accent hover:underline tracking-[0.04em]"
          >
            ver todos →
          </Link>
        </div>
        <TopClientesValor
          clientes={clientes}
          facturas={facturas}
          tarifaCop={TARIFA_CONTADORA_COP}
          horasPorFactura={HORAS_POR_FACTURA}
        />
      </section>

      {/* === LO QUE REQUIERE TU ATENCIÓN === */}
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
// KPI Cards (legacy, no usado tras rediseño opción B)
// ============================================================================

// @ts-expect-error legacy
function _KpiCardLegacy({
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
// Top clientes por valor entregado (mes actual)
// ============================================================================

function TopClientesValor({
  clientes,
  facturas,
  tarifaCop,
  horasPorFactura,
}: {
  clientes: Cliente[];
  facturas: AgentEvent[];
  tarifaCop: number;
  horasPorFactura: number;
}) {
  const SYNTHETIC = new Set(["monitor", "reparador", "limpiador", "supervisor", "owner"]);
  const clientesOp = clientes.filter((c) => !SYNTHETIC.has(c.slug));

  const rows = clientesOp
    .map((c) => {
      const factCliente = facturas.filter((f) => f.cliente_id === c.id);
      const factMes = facturasThisMonth(factCliente).length;
      const horasMes = factMes * horasPorFactura;
      const valorCop = horasMes * tarifaCop;
      return { cliente: c, factMes, horasMes, valorCop };
    })
    .filter((r) => r.factMes > 0)
    .sort((a, b) => b.valorCop - a.valorCop)
    .slice(0, 5);

  if (rows.length === 0) {
    return (
      <div className="card font-mono text-[11px] text-ink-3">
        Sin facturas procesadas este mes todavía.
      </div>
    );
  }

  const totalValor = rows.reduce((s, r) => s + r.valorCop, 0);

  return (
    <div className="card overflow-hidden p-0">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-edge bg-paper-sunken">
            <th className="text-left py-2.5 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
              Cliente
            </th>
            <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
              Facturas mes
            </th>
            <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
              Horas ahorradas
            </th>
            <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
              Valor entregado (COP)
            </th>
            <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
              % del total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = totalValor > 0 ? (r.valorCop / totalValor) * 100 : 0;
            return (
              <tr key={r.cliente.id} className="border-b border-edge-2 hover:bg-paper-sunken/30">
                <td className="py-2.5 px-4">
                  <Link
                    to={`/cliente/${r.cliente.slug}`}
                    className="text-ink hover:text-accent font-medium"
                  >
                    {r.cliente.nombre}
                  </Link>
                </td>
                <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium">
                  {r.factMes}
                </td>
                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-3">
                  {formatHoras(r.horasMes)}
                </td>
                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ok font-medium">
                  ${formatCop(r.valorCop)}
                </td>
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-paper-sunken rounded-full overflow-hidden">
                      <div
                        className="h-full bg-ok rounded-full"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                    <span className="font-mono text-[10px] text-ink-3 tabular-nums">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
          <tr className="bg-paper-sunken font-semibold">
            <td className="py-2.5 px-4 font-mono text-[10px] uppercase tracking-[0.04em]">
              Top {rows.length}
            </td>
            <td className="py-2.5 px-3 text-right font-mono tabular-nums">
              {rows.reduce((s, r) => s + r.factMes, 0)}
            </td>
            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-3">
              {formatHoras(rows.reduce((s, r) => s + r.horasMes, 0))}
            </td>
            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ok">
              ${formatCop(totalValor)}
            </td>
            <td className="py-2.5 px-3 font-mono text-[10px] text-ink-3">100%</td>
          </tr>
        </tbody>
      </table>
    </div>
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
  // AUDIT 2026-05-13: parse defensivo del monto (acepta string + number)
  const totalMonto = (events: AgentEvent[]): number => {
    let total = 0;
    for (const ev of events) {
      const raw = (ev.payload as FacturaPayload | null)?.total;
      if (raw == null) continue;
      const t = typeof raw === "number" ? raw : Number(raw);
      if (!isNaN(t) && isFinite(t)) total += t;
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

/** Formatea COP con separadores de miles. Ej: 5750000 → "5.750.000" */
function formatCop(cop: number): string {
  return Math.round(cop).toLocaleString("es-CO");
}

function ValorCard({
  label,
  value,
  unit,
  sub,
  delta,
  accent,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  delta?: number | null;
  accent: "ok" | "warn" | "neutral";
}) {
  const colorClass =
    accent === "ok" ? "text-ok" : accent === "warn" ? "text-accent" : "text-ink";
  return (
    <div className="card">
      <div className="label-tight text-ink-3 mb-1.5">{label}</div>
      <div className="flex items-baseline gap-2 mb-0.5">
        <span
          className={`font-display text-3xl font-medium tracking-[-0.02em] tabular-nums leading-none ${colorClass}`}
        >
          {value}
        </span>
        {delta !== undefined && delta !== null && (
          <span
            className={`font-mono text-[11px] tabular-nums ${delta > 0 ? "text-ok" : delta < 0 ? "text-accent" : "text-ink-4"}`}
          >
            {delta > 0 ? "↗" : delta < 0 ? "↘" : "→"} {Math.abs(delta).toFixed(0)}%
          </span>
        )}
      </div>
      {unit && (
        <div className="font-mono text-[10px] text-ink-4 tracking-[0.04em] uppercase mb-1.5">
          {unit}
        </div>
      )}
      {sub && (
        <div className="font-mono text-[10px] text-ink-3 leading-tight mt-1">{sub}</div>
      )}
    </div>
  );
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
