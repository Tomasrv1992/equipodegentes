import { Link } from "react-router-dom";
import { useLatestRuns, useClientes, useAgentes } from "../lib/queries";
import Pill from "./Pill";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-CO", {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "America/Bogota",
  });
}

export default function Feed() {
  const { data: runs, isLoading } = useLatestRuns();
  const { data: clientes } = useClientes();
  const { data: agentes } = useAgentes();

  if (isLoading) return <p className="text-muted">Cargando…</p>;
  if (!runs || !clientes || !agentes) return null;

  const clienteById = Object.fromEntries(clientes.map((c) => [c.id, c]));
  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));

  return (
    <div>
      <h2 className="font-serif text-2xl mb-4">Feed cronológico</h2>
      <div className="card p-0 overflow-hidden">
        <div className="grid grid-cols-[110px_140px_1fr_1fr_80px] gap-3 px-4 py-2 bg-paperalt border-b border-edge label">
          <div>Hora</div>
          <div>Agente</div>
          <div>Cliente</div>
          <div>Resumen</div>
          <div>Estado</div>
        </div>
        {runs.map((r) => {
          const c = clienteById[r.cliente_id];
          const a = agenteById[r.agente_id];
          return (
            <Link
              key={r.id}
              to={`/run/${r.id}`}
              className="grid grid-cols-[110px_140px_1fr_1fr_80px] gap-3 px-4 py-2 border-b border-edge text-xs hover:bg-paperalt"
            >
              <div className="font-mono text-muted">{fmtTime(r.started_at)}</div>
              <div className="font-semibold">{a?.nombre ?? r.agente_id}</div>
              <div className="font-serif italic">{c?.nombre ?? r.cliente_id}</div>
              <div className="text-dim truncate">{r.summary ?? r.error_message ?? "—"}</div>
              <div><Pill status={r.status} /></div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
