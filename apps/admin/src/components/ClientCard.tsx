import { Link } from "react-router-dom";
import Timeline24h from "./Timeline24h";
import Sparkline from "./Sparkline";
import { timelineLast24h, sparkRunsByDay } from "../lib/timeline";
import {
  totalProcesadas,
  runsLastDays,
  tiempoAhorradoHoras,
  formatHoras,
} from "../lib/metrics";
import type { Cliente, Agente, AgentRun, ClientAgent } from "../types";

interface ClientCardProps {
  cliente: Cliente;
  /** Activación del agente que vamos a mostrar en el card. */
  activacion: ClientAgent;
  agente: Agente | undefined;
  /** Runs recientes del par (cliente, agente). */
  runs: AgentRun[];
}

export default function ClientCard({ cliente, activacion, agente, runs }: ClientCardProps) {
  const ticks = timelineLast24h(runs);
  const sparkPoints = sparkRunsByDay(runs, 14);

  // Estado actual: peor estado de los runs últimas 24h
  const last24Runs = runs.filter(
    (r) => Date.now() - new Date(r.started_at).getTime() < 24 * 60 * 60 * 1000,
  );
  const hasRecentFail = last24Runs.some((r) => r.status === "fail");
  const hasRecentWarn = last24Runs.some((r) => r.status === "warn");
  const status: "ok" | "warn" | "fail" = hasRecentFail
    ? "fail"
    : hasRecentWarn
    ? "warn"
    : "ok";

  const statusLabel = {
    ok:   { text: "Operativo", cls: "text-ok" },
    warn: { text: "Con advertencias", cls: "text-warn" },
    fail: { text: "Con errores", cls: "text-fail" },
  }[status];

  // Última corrida
  const lastRun = runs[0];
  const lastRunWhen = lastRun
    ? new Date(lastRun.started_at).toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Bogota",
      })
    : null;

  // Métricas de 7 días
  const last7 = runsLastDays(runs, 7);
  const facturas7d = totalProcesadas(last7);
  const horasAhorradas = tiempoAhorradoHoras(facturas7d);

  return (
    <Link
      to={`/cliente/${cliente.slug}`}
      className="grid grid-cols-[280px_1fr_220px] items-stretch bg-paper-2 border border-edge rounded-lg overflow-hidden card-hover no-underline text-ink"
    >
      {/* Columna izquierda: info del cliente */}
      <div className="p-6 flex flex-col gap-1 border-r border-edge-2">
        <div className="font-display text-[19px] font-semibold tracking-tighter leading-[1.1]">
          {cliente.nombre}
        </div>
        <div className="font-mono text-[10px] text-ink-3 tracking-[0.04em] mt-1">
          {cliente.slug}
        </div>
        <div className={`flex items-center gap-1.5 mt-3 font-mono text-[10px] uppercase tracking-[0.1em] font-semibold ${statusLabel.cls}`}>
          <span
            className="w-1.5 h-1.5 rounded-full bg-current"
            style={{ boxShadow: "0 0 0 3px color-mix(in oklch, currentColor 22%, transparent)" }}
          />
          {statusLabel.text}
        </div>
        <div className="mt-auto font-mono text-[10px] text-ink-4 tracking-[0.04em]">
          desde{" "}
          {new Date(cliente.created_at).toLocaleDateString("es-CO", {
            month: "short",
            year: "numeric",
          }).replace(".", "")}
          {" · "}1 agente
        </div>
      </div>

      {/* Columna media: timeline 24h */}
      <div className="p-6 flex flex-col gap-2.5 justify-between border-r border-edge-2">
        <div className="flex justify-between items-baseline">
          <div className="font-sans text-[13px] font-semibold tracking-[-0.005em] flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            {agente?.nombre ?? activacion.agente_id}
          </div>
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.04em]">
            {lastRunWhen ? `${lastRunWhen} · ${(lastRun?.status ?? "").toUpperCase()}` : "sin runs"}
          </div>
        </div>
        <Timeline24h ticks={ticks} />
      </div>

      {/* Columna derecha: sparkline + KPIs */}
      <div className="p-6 flex flex-col justify-between gap-2">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3 font-medium">
            Procesadas · últ 7 días
          </span>
          <span className="font-display text-xl font-semibold tracking-tighter text-ink">
            {facturas7d}
          </span>
        </div>
        <Sparkline points={sparkPoints} />
        <div className="font-mono text-[10px] text-ink-3 tracking-[0.04em]">
          ≈ {formatHoras(horasAhorradas)} ahorradas
        </div>
      </div>
    </Link>
  );
}
