import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useClientes, useFacturasByAgente } from "../lib/queries";
import {
  runsLastDays,
  totalErrores,
  tiempoAhorradoHoras,
  formatHoras,
  totalFacturas,
  facturasThisMonth,
  aggFacturasByMonth,
} from "../lib/metrics";
import Pill from "./Pill";
import Kpis from "./Kpis";
import EmptyState from "./EmptyState";
import MonthlyBars from "./MonthlyBars";
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
          .limit(200),
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
  const { data: facturas } = useFacturasByAgente(id);

  if (isLoading || !data || !clientes) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }

  const { agente, runs } = data;
  const clienteById = Object.fromEntries(clientes.map((c) => [c.id, c]));
  const facturasArr = facturas ?? [];

  // Métricas por fecha REAL de la factura (agent_events)
  const facturasMes = totalFacturas(facturasThisMonth(facturasArr));
  const horasMes = tiempoAhorradoHoras(facturasMes);
  // Errores y clientes únicos siguen usando runs (info técnica)
  const errores7d = totalErrores(runsLastDays(runs, 7));
  const clientesUnicos = new Set(runs.map((r) => r.cliente_id)).size;
  const monthlyAgg = aggFacturasByMonth(facturasArr, 12);

  return (
    <div>
      {/* Breadcrumbs */}
      <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-3 flex items-center gap-1.5">
        <Link to="/" className="hover:text-ink transition-colors">Operación</Link>
        <span className="text-ink-4">/</span>
        <span className="text-ink-2">Agentes</span>
        <span className="text-ink-4">/</span>
        <span className="text-ink-2">{agente.nombre}</span>
      </div>

      {/* Header */}
      <div className="border-b border-edge pb-7 mb-9">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2 flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent" />
          Agente · {agente.id}
        </div>
        <h1
          className="font-display font-medium leading-[0.98] tracking-tightest text-ink m-0 mb-3"
          style={{ fontSize: "clamp(36px, 5vw, 60px)" }}
        >
          {agente.nombre}
        </h1>
        {agente.descripcion && (
          <p className="font-sans text-sm text-ink-3 max-w-[640px] leading-relaxed">
            {agente.descripcion}
          </p>
        )}
        <div className="flex items-center gap-4 mt-3 font-mono text-[11px] text-ink-3 tracking-[0.04em]">
          {agente.cron_default && (
            <>
              <span>
                <span className="text-ink-4">cron</span> {agente.cron_default}
              </span>
              <span className="text-ink-4">·</span>
            </>
          )}
          <span>
            <span className="text-ink-4">activo</span> {agente.activo ? "sí" : "no"}
          </span>
          <span className="text-ink-4">·</span>
          <span>
            <span className="text-ink-4">corriendo en</span> {clientesUnicos} cliente
            {clientesUnicos === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <Kpis
        items={[
          {
            label: "Procesadas mes",
            value: facturasMes,
            unit: "facturas",
            meta: facturasMes > 0 ? `≈ ${formatHoras(horasMes)} ahorradas` : "—",
          },
          { label: "Errores 7 días", value: errores7d, alert: errores7d > 0 },
          { label: "Clientes activos", value: clientesUnicos },
          {
            label: "Runs totales",
            value: runs.length,
            meta:
              runs.length > 0
                ? `desde ${new Date(runs[runs.length - 1].started_at)
                    .toLocaleDateString("es-CO", { month: "short", year: "numeric" })
                    .replace(".", "")}`
                : "—",
          },
        ]}
      />

      {/* Histórico mensual del agente */}
      <section className="card mb-9">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="section-title">Histórico · 12 meses</h2>
          <span className="section-meta">
            facturas procesadas · todos los clientes que usan {agente.nombre}
          </span>
        </div>
        <MonthlyBars data={monthlyAgg} />
      </section>

      <div className="flex items-baseline justify-between mb-4">
        <h2 className="section-title">Runs cross-cliente</h2>
        <span className="section-meta">
          {runs.length} totales · más recientes primero
        </span>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title="Sin runs todavía"
          description="Cuando un cliente con este agente corra el cron, los runs van a aparecer acá."
          icon="·"
          cta={null}
        />
      ) : (
        <div className="bg-paper-2 border border-edge rounded-lg overflow-hidden">
          <div className="grid grid-cols-[110px_1fr_1fr_80px] gap-3 px-4 py-2.5 bg-paper-sunken border-b border-edge label-tight">
            <div>Hora</div>
            <div>Cliente</div>
            <div>Resumen</div>
            <div>Estado</div>
          </div>
          {runs.slice(0, 50).map((r) => (
            <Link
              key={r.id}
              to={`/run/${r.id}`}
              className="grid grid-cols-[110px_1fr_1fr_80px] items-center gap-3 px-4 py-3 border-b border-edge-2 last:border-b-0 text-[12px] hover:bg-paper-sunken transition-colors"
            >
              <span className="font-mono text-[10px] text-ink-3 tabular-nums tracking-[0.04em]">
                {new Date(r.started_at)
                  .toLocaleString("es-CO", {
                    month: "short",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "America/Bogota",
                  })
                  .replace(".", "")}
              </span>
              <span className="font-display font-medium tracking-[-0.01em] text-ink truncate">
                {clienteById[r.cliente_id]?.nombre ?? r.cliente_id}
              </span>
              <span className="text-ink-3 truncate font-sans">
                {r.summary ?? r.error_message ?? "—"}
              </span>
              <Pill status={r.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
