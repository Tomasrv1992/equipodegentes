import { Link } from "react-router-dom";
import { useClientes, useAgentes, useLatestRuns } from "../lib/queries";
import type { AgentRun, RunStatus } from "../types";

function statusDot(status: RunStatus | "off"): string {
  return {
    ok:      "bg-ok",
    warn:    "bg-warn",
    fail:    "bg-fail",
    running: "bg-stone-300 animate-pulse",
    off:     "bg-off",
  }[status];
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function Matriz() {
  const { data: clientes, isLoading: lc } = useClientes();
  const { data: agentes, isLoading: la } = useAgentes();
  const { data: runs, isLoading: lr } = useLatestRuns();

  if (lc || la || lr) return <p className="text-muted">Cargando…</p>;
  if (!clientes || !agentes || !runs) return null;

  // Mapa { clienteId: { agenteId: ultimoRun } }
  const ultimo: Record<string, Record<string, AgentRun>> = {};
  for (const r of runs) {
    const byA = ultimo[r.cliente_id] ?? (ultimo[r.cliente_id] = {});
    if (!byA[r.agente_id]) byA[r.agente_id] = r;
  }

  const errCount = runs.filter((r) => r.status === "fail").length;
  const todayCount = runs.filter(
    (r) => new Date(r.started_at).toDateString() === new Date().toDateString()
  ).length;

  return (
    <div>
      <div className="grid grid-cols-4 gap-2 mb-6">
        <Kpi label="Runs hoy" val={String(todayCount)} />
        <Kpi label="Errores" val={String(errCount)} accent={errCount > 0} />
        <Kpi label="Clientes" val={String(clientes.length)} />
        <Kpi label="Agentes" val={String(agentes.length)} />
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="text-left text-[10px] uppercase tracking-wider text-dim font-semibold py-2 px-3 bg-paperalt border border-edge">
              Cliente
            </th>
            {agentes.map((a) => (
              <th
                key={a.id}
                className="text-left text-[10px] uppercase tracking-wider text-dim font-semibold py-2 px-3 bg-paperalt border border-edge"
              >
                <Link to={`/agente/${a.id}`} className="hover:text-accent">
                  {a.nombre}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clientes.map((c) => (
            <tr key={c.id}>
              <td className="bg-white border border-edge px-3 py-2 font-serif font-semibold">
                <Link to={`/cliente/${c.slug}`} className="hover:text-accent">
                  {c.nombre}
                </Link>
              </td>
              {agentes.map((a) => {
                const r = ultimo[c.id]?.[a.id];
                return (
                  <td key={a.id} className="border border-edge px-3 py-2">
                    {r ? (
                      <Link
                        to={`/run/${r.id}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <span
                          className={`w-2 h-2 rounded-full inline-block ${statusDot(r.status)}`}
                        />
                        <span className="text-xs">
                          {r.status.toUpperCase()} · {timeAgo(r.started_at)}
                        </span>
                      </Link>
                    ) : (
                      <span className="flex items-center gap-2 text-muted">
                        <span className={`w-2 h-2 rounded-full inline-block ${statusDot("off")}`} />
                        <span className="text-xs">no activado</span>
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, val, accent = false }: { label: string; val: string; accent?: boolean }) {
  return (
    <div className="card py-3">
      <div className="label">{label}</div>
      <div className={`text-2xl font-semibold ${accent ? "text-accent" : ""}`}>{val}</div>
    </div>
  );
}
