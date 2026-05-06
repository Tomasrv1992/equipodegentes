import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAgentes } from "../lib/queries";
import Pill from "./Pill";
import type { Cliente, AgentRun, ClientAgent } from "../types";

function useClienteBySlug(slug: string) {
  return useQuery({
    queryKey: ["cliente", slug],
    enabled: !!slug,
    queryFn: async (): Promise<{ cliente: Cliente; activaciones: ClientAgent[]; runs: AgentRun[] }> => {
      const { data: cliente, error: e1 } = await supabase
        .from("clientes")
        .select("*")
        .eq("slug", slug)
        .single();
      if (e1 || !cliente) throw new Error(e1?.message ?? "cliente no encontrado");

      const [{ data: activaciones, error: e2 }, { data: runs, error: e3 }] = await Promise.all([
        supabase.from("client_agents").select("*").eq("cliente_id", (cliente as Cliente).id),
        supabase
          .from("agent_runs")
          .select("*")
          .eq("cliente_id", (cliente as Cliente).id)
          .order("started_at", { ascending: false })
          .limit(30),
      ]);
      if (e2) throw e2;
      if (e3) throw e3;
      return {
        cliente: cliente as Cliente,
        activaciones: (activaciones as ClientAgent[]) ?? [],
        runs: (runs as AgentRun[]) ?? [],
      };
    },
  });
}

export default function ClienteFicha({ slug }: { slug: string }) {
  const { data, isLoading } = useClienteBySlug(slug);
  const { data: agentes } = useAgentes();

  if (isLoading || !data || !agentes) return <p className="text-muted">Cargando…</p>;
  const { cliente, activaciones, runs } = data;
  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));

  return (
    <div>
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link> · {cliente.nombre}
      </div>
      <h1 className="font-serif text-3xl mb-1">{cliente.nombre}</h1>
      <p className="text-xs text-dim mb-6">
        slug <code>{cliente.slug}</code> · activo desde {new Date(cliente.created_at).toLocaleDateString("es-CO")}
      </p>

      <div className="grid grid-cols-2 gap-5">
        <section className="card">
          <div className="label mb-2">Agentes activados</div>
          {activaciones.length === 0 && <p className="text-muted text-sm">Ninguno.</p>}
          <ul className="space-y-2">
            {activaciones.map((act) => {
              const a = agenteById[act.agente_id];
              const last = runs.find((r) => r.agente_id === act.agente_id);
              return (
                <li key={act.agente_id} className="flex items-center gap-3 border-b border-edge pb-2">
                  <Link to={`/agente/${act.agente_id}`} className="font-semibold hover:text-accent flex-1">
                    {a?.nombre ?? act.agente_id}
                  </Link>
                  {last ? (
                    <>
                      <Pill status={last.status} />
                      <Link to={`/run/${last.id}`} className="text-xs text-muted hover:text-ink">
                        último run
                      </Link>
                    </>
                  ) : (
                    <span className="text-xs text-muted">sin runs</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card">
          <div className="label mb-2">Últimos runs (todos los agentes)</div>
          <ul className="text-xs space-y-1">
            {runs.slice(0, 15).map((r) => (
              <li key={r.id} className="flex items-center gap-2 border-b border-edge pb-1">
                <span className="text-muted font-mono w-16">
                  {new Date(r.started_at).toLocaleDateString("es-CO", { month: "short", day: "2-digit" })}
                </span>
                <Pill status={r.status} />
                <Link to={`/run/${r.id}`} className="text-dim truncate flex-1 hover:text-ink">
                  <span className="text-ink">{agenteById[r.agente_id]?.nombre ?? r.agente_id}</span>
                  {" — "}
                  {r.summary ?? r.error_message ?? "—"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
