import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useClientes } from "../lib/queries";
import Pill from "./Pill";
import type { Agente, AgentRun } from "../types";

function useAgenteData(id: string) {
  return useQuery({
    queryKey: ["agente", id],
    enabled: !!id,
    queryFn: async (): Promise<{ agente: Agente; runs: AgentRun[] }> => {
      const [{ data: agente, error: e1 }, { data: runs, error: e2 }] = await Promise.all([
        supabase.from("agentes").select("*").eq("id", id).single(),
        supabase
          .from("agent_runs")
          .select("*")
          .eq("agente_id", id)
          .order("started_at", { ascending: false })
          .limit(50),
      ]);
      if (e1 || !agente) throw new Error(e1?.message ?? "agente no encontrado");
      if (e2) throw e2;
      return { agente: agente as Agente, runs: (runs as AgentRun[]) ?? [] };
    },
  });
}

export default function AgenteFicha({ id }: { id: string }) {
  const { data, isLoading } = useAgenteData(id);
  const { data: clientes } = useClientes();

  if (isLoading || !data || !clientes) return <p className="text-muted">Cargando…</p>;
  const { agente, runs } = data;
  const clienteById = Object.fromEntries(clientes.map((c) => [c.id, c]));

  return (
    <div>
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link> · {agente.nombre}
      </div>
      <h1 className="font-serif text-3xl mb-1">{agente.nombre}</h1>
      <p className="text-xs text-dim mb-6">
        id <code>{agente.id}</code>
        {agente.cron_default && <> · cron {agente.cron_default}</>}
        {agente.descripcion && <> · {agente.descripcion}</>}
      </p>

      <h2 className="font-serif text-xl mb-3">Últimos runs (todos los clientes)</h2>
      <div className="card p-0 overflow-hidden">
        {runs.map((r) => (
          <Link
            key={r.id}
            to={`/run/${r.id}`}
            className="grid grid-cols-[110px_1fr_1fr_80px] gap-3 px-4 py-2 border-b border-edge text-xs hover:bg-paperalt"
          >
            <div className="font-mono text-muted">
              {new Date(r.started_at).toLocaleString("es-CO", {
                month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
                timeZone: "America/Bogota",
              })}
            </div>
            <div className="font-serif italic">
              {clienteById[r.cliente_id]?.nombre ?? r.cliente_id}
            </div>
            <div className="text-dim truncate">{r.summary ?? r.error_message ?? "—"}</div>
            <div><Pill status={r.status} /></div>
          </Link>
        ))}
      </div>
    </div>
  );
}
