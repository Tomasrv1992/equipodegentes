/**
 * /clientes — Tabla unificada de todos los clientes.
 *
 * Reemplaza la lista que estaba dispersa en /operacion (ClientCards) y
 * /diagnostico (tabla estado hoy). Acá vive una sola fuente.
 *
 * Foco: vista mensual + tendencia. Para detalle puntual → /cliente/:slug.
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import {
  useClientes,
  useAllFacturas,
  useLatestRuns,
  useClientAgents,
  useLatestReparadorValidations,
} from "../lib/queries";
import {
  facturasThisMonth,
  totalErrores,
  runsLastDays,
} from "../lib/metrics";
import { calcularHealthScore, type HealthScoreResult } from "../lib/health-score";
import type { Cliente, AgentEvent } from "../types";
import EmptyState from "../components/EmptyState";

interface FacturaPayload {
  fecha?: string;
  total?: number;
}

type FiltroEstado = "todos" | "activos" | "con_problemas" | "inactivos" | "onboarding";

export default function ClientesPage() {
  const { data: clientes, isLoading: lc } = useClientes();
  const { data: facturas, isLoading: lf } = useAllFacturas();
  const { data: runs, isLoading: lr } = useLatestRuns();
  const { data: activaciones, isLoading: la } = useClientAgents();
  const { data: validaciones } = useLatestReparadorValidations();
  const [filtro, setFiltro] = useState<FiltroEstado>("todos");

  if (lc || lf || lr || la) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }
  if (!clientes || !facturas || !runs || !activaciones) return null;

  const SYNTHETIC = new Set([
    "monitor", "inspector",
    "reparador", "limpiador", "archivero",
    "supervisor", "owner",
  ]);
  const clientesOp = clientes.filter((c) => !SYNTHETIC.has(c.slug));

  const filas = clientesOp.map((c) =>
    calcularFila(c, facturas, runs, activaciones, validaciones ?? null),
  );

  // Filtros
  const filtradas = filas.filter((f) => {
    if (filtro === "todos") return true;
    if (filtro === "activos") return f.estado === "ok";
    if (filtro === "con_problemas") return f.estado === "fail" || f.estado === "warn";
    if (filtro === "inactivos") return !f.cliente.activo;
    if (filtro === "onboarding") return f.estado === "onboarding";
    return true;
  });

  // Ordenar: con problemas primero, luego por facturas mes desc
  filtradas.sort((a, b) => {
    const peso = { fail: 0, warn: 1, ok: 2, onboarding: 3, inactivo: 4 };
    if (peso[a.estado] !== peso[b.estado]) return peso[a.estado] - peso[b.estado];
    return b.factMes - a.factMes;
  });

  const counters = {
    todos: filas.length,
    activos: filas.filter((f) => f.estado === "ok").length,
    con_problemas: filas.filter((f) => f.estado === "fail" || f.estado === "warn").length,
    inactivos: filas.filter((f) => !f.cliente.activo).length,
    onboarding: filas.filter((f) => f.estado === "onboarding").length,
  };

  const ahora = new Date();
  const mesActualLabel = ahora.toLocaleDateString("es-CO", { month: "long", year: "numeric" });

  return (
    <div>
      <div className="border-b border-edge pb-7 mb-8">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
          Catálogo
        </div>
        <h1 className="font-display text-5xl font-medium tracking-tightest text-ink leading-none mb-3">
          Clientes
        </h1>
        <p className="font-sans text-sm text-ink-3 max-w-[640px] leading-relaxed">
          Vista unificada del estado de cada cliente: actividad del mes, tendencia
          últimos 30 días, errores recientes. Click en un cliente para ver su ficha completa.
        </p>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-1 mb-5">
        <FilterChip label={`Todos (${counters.todos})`} active={filtro === "todos"} onClick={() => setFiltro("todos")} />
        <FilterChip label={`Activos (${counters.activos})`} active={filtro === "activos"} onClick={() => setFiltro("activos")} />
        <FilterChip label={`Con problemas (${counters.con_problemas})`} active={filtro === "con_problemas"} onClick={() => setFiltro("con_problemas")} color="warn" />
        <FilterChip label={`Onboarding (${counters.onboarding})`} active={filtro === "onboarding"} onClick={() => setFiltro("onboarding")} />
        <FilterChip label={`Inactivos (${counters.inactivos})`} active={filtro === "inactivos"} onClick={() => setFiltro("inactivos")} />
        <Link to="/nuevo-cliente" className="ml-auto btn-primary text-[12px]">
          + Nuevo cliente
        </Link>
      </div>

      {filtradas.length === 0 ? (
        <EmptyState
          title="Sin clientes con este filtro"
          description="Probá cambiar el filtro o crear un cliente nuevo."
          cta={{ label: "Crear cliente", to: "/nuevo-cliente" }}
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-edge bg-paper-sunken">
                <Th>Cliente</Th>
                <Th>Estado</Th>
                <Th right>Health</Th>
                <Th right>{mesActualLabel}</Th>
                <Th right>vs mes ant.</Th>
                <Th>Tendencia 30d</Th>
                <Th>Última factura</Th>
                <Th right>Errores 7d</Th>
                <Th right>Histórico</Th>
              </tr>
            </thead>
            <tbody>
              {filtradas.map((f) => (
                <ClienteRow key={f.cliente.id} fila={f} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Cálculo por fila
// ============================================================================

interface Fila {
  cliente: Cliente;
  estado: "ok" | "warn" | "fail" | "inactivo" | "onboarding";
  factMes: number;
  factMesPrev: number;
  factAllTime: number;
  delta: number | null;
  spark: number[];
  ultimaFecha: string | null;
  diasSinFactura: number;
  errores7d: number;
  healthScore: HealthScoreResult;
}

function calcularFila(
  c: Cliente,
  facturas: AgentEvent[],
  runs: any[],
  activaciones: any[],
  validaciones: Map<string, any> | null,
): Fila {
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const factCliente = facturas.filter((f) => f.cliente_id === c.id);
  const factMes = facturasThisMonth(factCliente).length;
  const factMesPrev = facturasThisMonth(factCliente, prevMonth).length;
  const factAllTime = factCliente.length;
  const delta = factMesPrev > 0 ? ((factMes - factMesPrev) / factMesPrev) * 100 : null;

  // Sparkline 30 días
  const spark: number[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const count = factCliente.filter(
      (f) => (f.payload as FacturaPayload | null)?.fecha === dayKey,
    ).length;
    spark.push(count);
  }

  // Última fecha de factura
  const dates = factCliente
    .map((f) => (f.payload as FacturaPayload | null)?.fecha)
    .filter((d): d is string => !!d)
    .sort();
  const ultimaFecha = dates[dates.length - 1] ?? null;
  const diasSinFactura = ultimaFecha
    ? Math.floor((Date.now() - new Date(ultimaFecha + "T00:00:00").getTime()) / (24 * 60 * 60 * 1000))
    : 999;

  // Errores últimos 7 días
  const runsCliente = runs.filter((r) => r.cliente_id === c.id);
  const errores7d = totalErrores(runsLastDays(runsCliente, 7));

  // Activación
  const tieneActivacion = activaciones.some(
    (a) => a.cliente_id === c.id && a.agente_id === "facturacion" && a.activo,
  );

  // Estado consolidado
  let estado: Fila["estado"];
  if (!c.activo) estado = "inactivo";
  else if (!tieneActivacion) estado = "onboarding";
  else if (errores7d > 2) estado = "fail";
  else if (factMes === 0 && diasSinFactura > 7) estado = "fail";
  else if (factMes > 0 && factMesPrev > 0 && factMes < factMesPrev * 0.5) estado = "warn";
  else estado = "ok";

  // Health-score (0-100) — usa última validación del reparador si existe
  const validacion = validaciones?.get(c.slug) ?? null;
  const healthScore = calcularHealthScore({
    validacion,
    errores7d,
    diasSinFactura,
    factMes,
    factMesPrev,
    tieneActivacion,
    clienteActivo: c.activo,
  });

  return {
    cliente: c,
    estado,
    factMes,
    factMesPrev,
    factAllTime,
    delta,
    spark,
    ultimaFecha,
    diasSinFactura,
    errores7d,
    healthScore,
  };
}

// ============================================================================
// Subcomponentes
// ============================================================================

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] ${right ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function ClienteRow({ fila }: { fila: Fila }) {
  return (
    <tr className="border-b border-edge-2 hover:bg-paper-sunken/30">
      <td className="py-2.5 px-3">
        <Link
          to={`/cliente/${fila.cliente.slug}`}
          className="text-ink hover:text-accent font-medium"
        >
          {fila.cliente.nombre}
        </Link>
      </td>
      <td className="py-2.5 px-3">
        <EstadoBadge estado={fila.estado} />
      </td>
      <td className="py-2.5 px-3 text-right">
        <HealthBadge health={fila.healthScore} />
      </td>
      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium">
        {fila.factMes}
      </td>
      <td className="py-2.5 px-3 text-right">
        {fila.delta !== null ? (
          <span
            className={`font-mono text-[11px] tabular-nums ${
              fila.delta > 5 ? "text-ok" : fila.delta < -5 ? "text-accent" : "text-ink-4"
            }`}
          >
            {fila.delta > 0 ? "↗" : fila.delta < 0 ? "↘" : "→"} {Math.abs(fila.delta).toFixed(0)}%
          </span>
        ) : (
          <span className="text-ink-4 font-mono text-[10px]">—</span>
        )}
      </td>
      <td className="py-2 px-3">
        <SparklineInline values={fila.spark} />
      </td>
      <td className="py-2.5 px-3 font-mono text-[10px] text-ink-3">
        {fila.ultimaFecha
          ? fila.diasSinFactura === 0
            ? "hoy"
            : fila.diasSinFactura === 1
              ? "ayer"
              : `hace ${fila.diasSinFactura}d`
          : "nunca"}
      </td>
      <td
        className={`py-2.5 px-3 text-right font-mono tabular-nums ${fila.errores7d > 0 ? "text-accent" : "text-ink-4"}`}
      >
        {fila.errores7d}
      </td>
      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-3">
        {fila.factAllTime}
      </td>
    </tr>
  );
}

function EstadoBadge({ estado }: { estado: Fila["estado"] }) {
  const cfg: Record<Fila["estado"], { label: string; cls: string }> = {
    ok: { label: "OK", cls: "pill-ok" },
    warn: { label: "Cayó", cls: "pill-warn" },
    fail: { label: "Atención", cls: "pill-fail" },
    onboarding: { label: "Onboarding", cls: "pill-running" },
    inactivo: { label: "Inactivo", cls: "pill-off" },
  };
  const c = cfg[estado];
  return <span className={`pill ${c.cls}`}>{c.label}</span>;
}

function HealthBadge({ health }: { health: HealthScoreResult }) {
  const colorClass =
    health.color === "ok"
      ? "text-ok"
      : health.color === "warn"
        ? "text-accent"
        : health.color === "fail"
          ? "text-fail"
          : "text-ink-4";
  const bgClass =
    health.color === "ok"
      ? "bg-ok/10"
      : health.color === "warn"
        ? "bg-accent/10"
        : health.color === "fail"
          ? "bg-fail/10"
          : "bg-paper-sunken";

  if (health.banda === "inactivo") {
    return <span className="font-mono text-[10px] text-ink-4">—</span>;
  }

  return (
    <div
      className={`inline-flex items-baseline gap-1 px-2 py-0.5 rounded ${bgClass}`}
      title={health.razon}
    >
      <span className={`font-display text-[14px] font-semibold tabular-nums ${colorClass}`}>
        {health.score}
      </span>
      <span className="font-mono text-[9px] text-ink-3">/100</span>
    </div>
  );
}

function SparklineInline({ values }: { values: number[] }) {
  const max = Math.max(...values);
  if (max === 0) {
    return <span className="font-mono text-[10px] text-ink-4">—</span>;
  }
  const w = 80;
  const h = 22;
  const stepX = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(2)},${(h - (v / max) * h).toFixed(2)}`)
    .join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const trendUp = last >= first;
  return (
    <svg width={w} height={h} className="block">
      <polyline
        points={points}
        fill="none"
        stroke={trendUp ? "var(--color-ok)" : "var(--color-accent)"}
        strokeWidth="1.2"
        opacity="0.85"
      />
      <circle
        cx={(values.length - 1) * stepX}
        cy={h - (last / max) * h}
        r="1.8"
        fill={trendUp ? "var(--color-ok)" : "var(--color-accent)"}
      />
    </svg>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: "warn";
}) {
  const base =
    "font-mono text-[11px] tracking-[0.04em] px-2.5 py-1 rounded-md transition-all";
  const cls = active
    ? `${base} bg-ink text-paper font-medium`
    : color === "warn"
      ? `${base} text-accent hover:bg-paper-sunken`
      : `${base} text-ink-3 hover:text-ink hover:bg-paper-sunken`;
  return (
    <button onClick={onClick} className={cls}>
      {label}
    </button>
  );
}
