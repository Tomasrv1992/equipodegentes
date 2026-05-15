import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useLatestRuns, useClientes, useAgentes } from "../lib/queries";
import Pill from "./Pill";
import EmptyState from "./EmptyState";
import type { RunStatus } from "../types";

type StatusFilter = "all" | RunStatus;

export default function Feed() {
  const { data: runs, isLoading } = useLatestRuns();
  const { data: clientes } = useClientes();
  const { data: agentes } = useAgentes();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [agenteFilter, setAgenteFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    if (!runs) return [];
    return runs.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (agenteFilter !== "all" && r.agente_id !== agenteFilter) return false;
      return true;
    });
  }, [runs, statusFilter, agenteFilter]);

  if (isLoading) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }
  if (!runs || !clientes || !agentes) return null;

  const clienteById = Object.fromEntries(clientes.map((c) => [c.id, c]));
  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));

  return (
    <div>
      {/* Header section */}
      <div className="flex items-end justify-between mb-6 pb-5 border-b border-edge">
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
            Cronología
          </div>
          <h1 className="font-display text-4xl font-medium tracking-tightest text-ink leading-none">
            Feed
          </h1>
          <p className="font-sans text-sm text-ink-3 mt-2">
            Todos los runs ordenados por hora de inicio. Click en una fila para abrir el detalle.
          </p>
        </div>
        <div className="font-mono text-[11px] text-ink-3 tabular-nums">
          {filtered.length} de {runs.length} runs
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex items-center gap-2">
          <span className="label-tight">Estado</span>
          <div className="flex gap-1">
            {(["all", "ok", "warn", "fail", "running"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`font-mono text-[10px] uppercase tracking-[0.06em] px-2 py-1 rounded transition-colors ${
                  statusFilter === s
                    ? "bg-ink text-paper"
                    : "text-ink-3 hover:text-ink hover:bg-paper-sunken"
                }`}
              >
                {s === "all" ? "Todos" : s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 ml-4">
          <span className="label-tight">Agente</span>
          <div className="flex gap-1">
            <button
              onClick={() => setAgenteFilter("all")}
              className={`font-mono text-[10px] uppercase tracking-[0.06em] px-2 py-1 rounded transition-colors ${
                agenteFilter === "all"
                  ? "bg-ink text-paper"
                  : "text-ink-3 hover:text-ink hover:bg-paper-sunken"
              }`}
            >
              Todos
            </button>
            {agentes.map((a) => (
              <button
                key={a.id}
                onClick={() => setAgenteFilter(a.id)}
                className={`font-mono text-[10px] uppercase tracking-[0.06em] px-2 py-1 rounded transition-colors ${
                  agenteFilter === a.id
                    ? "bg-ink text-paper"
                    : "text-ink-3 hover:text-ink hover:bg-paper-sunken"
                }`}
              >
                {a.nombre.replace("Equipo-", "")}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Lista de runs */}
      {filtered.length === 0 ? (
        <EmptyState
          title={
            runs.length === 0
              ? "Sin runs todavía"
              : "Ningún run con estos filtros"
          }
          description={
            runs.length === 0
              ? "Cuando el cron disparé el primer run vas a verlo acá. Próxima corrida automática mañana 7am Bogotá."
              : "Cambia los filtros para ver más resultados."
          }
          icon="·"
          cta={null}
        />
      ) : (
        <div className="bg-paper-2 border border-edge rounded-lg overflow-hidden">
          <div className="grid grid-cols-[110px_160px_1fr_1fr_80px] gap-3 px-4 py-2.5 bg-paper-sunken border-b border-edge label-tight">
            <div>Hora</div>
            <div>Agente</div>
            <div>Cliente</div>
            <div>Resumen</div>
            <div>Estado</div>
          </div>
          {filtered.map((r) => {
            const c = clienteById[r.cliente_id];
            const a = agenteById[r.agente_id];
            return (
              <Link
                key={r.id}
                to={`/run/${r.id}`}
                className="grid grid-cols-[110px_160px_1fr_1fr_80px] gap-3 px-4 py-3 border-b border-edge-2 last:border-b-0 text-[12px] hover:bg-paper-sunken transition-colors items-center"
              >
                <div className="font-mono text-[10px] text-ink-3 tabular-nums tracking-[0.04em]">
                  {fmtTime(r.started_at)}
                </div>
                <div className="font-sans font-semibold text-ink truncate">
                  {a?.nombre ?? r.agente_id}
                </div>
                <div className="font-display font-medium tracking-[-0.01em] text-ink truncate">
                  {c?.nombre ?? r.cliente_id}
                </div>
                <div className="text-ink-3 truncate font-sans">
                  {r.summary ?? r.error_message ?? "—"}
                </div>
                <div>
                  <Pill status={r.status} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-CO", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Bogota",
  }).replace(".", "");
}
