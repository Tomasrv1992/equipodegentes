import { Link } from "react-router-dom";
import { useAgentes, useLatestRuns, useClientAgents } from "../lib/queries";
import {
  totalProcesadas,
  runsThisMonth,
  runsLastDays,
  totalErrores,
  tiempoAhorradoHoras,
  formatHoras,
} from "../lib/metrics";
import EmptyState from "../components/EmptyState";

export default function AgentesList() {
  const { data: agentes, isLoading: la } = useAgentes();
  const { data: runs, isLoading: lr } = useLatestRuns();
  const { data: activaciones, isLoading: lac } = useClientAgents();

  if (la || lr || lac) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }
  if (!agentes || !runs || !activaciones) return null;

  return (
    <div>
      {/* Header */}
      <div className="border-b border-edge pb-7 mb-9">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
          Catálogo
        </div>
        <h1 className="font-display text-5xl font-medium tracking-tightest text-ink leading-none mb-3">
          Agentes
        </h1>
        <p className="font-sans text-sm text-ink-3 max-w-[640px] leading-relaxed">
          Cada agente es un servicio autónomo desplegado por cliente. Click en uno
          para ver sus métricas, runs cross-cliente e histórico.
        </p>
      </div>

      {agentes.length === 0 ? (
        <EmptyState
          title="Sin agentes registrados"
          description="Cuando un agente nuevo se sume al catálogo, aparece acá."
          icon="·"
          cta={null}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {agentes.map((a) => {
            const runsAg = runs.filter((r) => r.agente_id === a.id);
            const proc = totalProcesadas(runsThisMonth(runsAg));
            const allTime = totalProcesadas(runsAg);
            const horasMes = tiempoAhorradoHoras(proc);
            const errores7d = totalErrores(runsLastDays(runsAg, 7));
            const clientesQ = new Set(
              activaciones
                .filter((act) => act.agente_id === a.id && act.activo)
                .map((act) => act.cliente_id),
            ).size;

            return (
              <Link
                key={a.id}
                to={`/agente/${a.id}`}
                className="card card-hover no-underline text-ink"
              >
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent translate-y-[-2px]" />
                  <h2 className="font-display text-xl font-semibold tracking-tighter text-ink m-0">
                    {a.nombre}
                  </h2>
                  {!a.activo && (
                    <span className="pill pill-off ml-auto">Inactivo</span>
                  )}
                </div>
                {a.descripcion && (
                  <p className="text-xs text-ink-3 mb-4 leading-relaxed">{a.descripcion}</p>
                )}

                <div className="grid grid-cols-4 gap-3 pt-3 border-t border-edge-2">
                  <Stat label="Mes" value={proc} unit="facts" />
                  <Stat label="All-time" value={allTime} unit="facts" />
                  <Stat
                    label="Ahorrado mes"
                    value={formatHoras(horasMes).replace(/[hm]/, "")}
                    unit={formatHoras(horasMes).endsWith("h") ? "h" : "min"}
                  />
                  <Stat
                    label="Clientes"
                    value={clientesQ}
                    unit={errores7d > 0 ? `${errores7d} err 7d` : "ok"}
                    alert={errores7d > 0}
                  />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  alert,
}: {
  label: string;
  value: number | string;
  unit?: string;
  alert?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3 font-medium mb-0.5">
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className={`font-display text-lg font-semibold tracking-tighter tabular-nums ${
            alert ? "text-accent" : "text-ink"
          }`}
        >
          {value}
        </span>
        {unit && (
          <span className="font-mono text-[9px] text-ink-3 tracking-[0.04em]">{unit}</span>
        )}
      </div>
    </div>
  );
}
