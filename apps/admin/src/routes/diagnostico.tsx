/**
 * Página /diagnostico — Vista consolidada de los 5 agentes.
 *
 * Reemplaza los emails diarios. Muestra en UN solo lugar:
 *   - Estado por cliente (Drive vs Sheet vs events del mes actual)
 *   - Acciones de cada agente HOY (filas reparadas, duplicados movidos, etc)
 *   - Alertas residuales que requieren atención manual
 *   - Costo Anthropic acumulado
 *   - Histórico últimos 7 días
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { Link } from "react-router-dom";
import Pill from "../components/Pill";

type RunRow = {
  id: string;
  cliente_id: string | null;
  agente_id: string;
  status: "running" | "ok" | "warn" | "fail";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  summary: string | null;
  error_message: string | null;
  payload: any;
};

type ClienteRow = {
  id: string;
  slug: string;
  nombre: string;
  activo: boolean;
};

const AGENTES_ORDEN = [
  { id: "facturacion", nombre: "Facturación", hora: "07:00", emoji: "📥" },
  { id: "monitor", nombre: "Monitor", hora: "08:00", emoji: "🔍" },
  { id: "reparador", nombre: "Reparador", hora: "08:15", emoji: "🔧" },
  { id: "limpiador", nombre: "Limpiador", hora: "08:30", emoji: "🧹" },
  { id: "supervisor", nombre: "Supervisor", hora: "08:45", emoji: "👁" },
];

function bogotaTodayUtcStart(): string {
  // Inicio del día Bogotá (00:00 UTC-5 → 05:00 UTC) como ISO
  const now = new Date();
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(bogotaMs);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + 5 * 60 * 60 * 1000).toISOString();
}

function useDiagnosticoData() {
  return useQuery({
    queryKey: ["diagnostico-hoy"],
    refetchInterval: 60_000, // refresca cada minuto
    queryFn: async () => {
      const dayStart = bogotaTodayUtcStart();

      // 1. Clientes activos
      const { data: clientes } = await supabase
        .from("clientes")
        .select("id, slug, nombre, activo")
        .eq("activo", true)
        .order("slug");

      // 2. Runs de HOY de TODOS los agentes
      const { data: runs } = await supabase
        .from("agent_runs")
        .select("*")
        .gte("started_at", dayStart)
        .order("started_at", { ascending: false });

      // 3. Conteo de facturas año por cliente
      const conteos = await Promise.all(
        ((clientes ?? []) as ClienteRow[]).map(async (c) => {
          const { count } = await supabase
            .from("agent_events")
            .select("*", { count: "exact", head: true })
            .eq("cliente_id", c.id)
            .eq("agente_id", "facturacion")
            .eq("tipo", "factura_procesada")
            .gte("payload->>fecha", "2026-01-01");
          return { cliente_id: c.id, facturas_2026: count ?? 0 };
        }),
      );

      return {
        clientes: (clientes ?? []) as ClienteRow[],
        runs: (runs ?? []) as RunRow[],
        conteos: new Map(conteos.map((c) => [c.cliente_id, c.facturas_2026])),
      };
    },
  });
}

export default function DiagnosticoPage() {
  const { data, isLoading } = useDiagnosticoData();

  if (isLoading || !data) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando diagnóstico…
      </div>
    );
  }

  const { clientes, runs, conteos } = data;

  // Clientes operativos (excluir sintéticos)
  const SYNTHETIC_SLUGS = new Set(["monitor", "reparador", "limpiador", "supervisor", "owner"]);
  const clientesOp = clientes.filter((c) => !SYNTHETIC_SLUGS.has(c.slug));

  // Runs sintéticos por agente (último de cada uno)
  const ultimosRunsAgente = new Map<string, RunRow>();
  for (const r of runs) {
    if (
      ["monitor", "reparador", "limpiador", "supervisor"].includes(r.agente_id) &&
      !ultimosRunsAgente.has(r.agente_id)
    ) {
      ultimosRunsAgente.set(r.agente_id, r);
    }
  }

  // Runs de facturacion por cliente HOY
  const runsFactByCliente = new Map<string, RunRow[]>();
  for (const r of runs) {
    if (r.agente_id !== "facturacion" || !r.cliente_id) continue;
    const arr = runsFactByCliente.get(r.cliente_id) ?? [];
    arr.push(r);
    runsFactByCliente.set(r.cliente_id, arr);
  }

  return (
    <div>
      {/* Breadcrumbs */}
      <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-3 flex items-center gap-1.5">
        <span className="text-ink-4">Diagnóstico · estado de los 5 agentes ·</span>
        <span className="text-ink-2">{new Date().toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "long" })}</span>
      </div>

      <h1 className="font-display text-4xl font-medium tracking-tightest text-ink leading-none mb-1">
        Diagnóstico
      </h1>
      <p className="font-sans text-sm text-ink-3 mt-2 mb-8">
        Vista en vivo del estado de hoy. Se actualiza cada minuto.
      </p>

      {/* === Fila superior: estado de los 5 agentes hoy === */}
      <section className="mb-8">
        <h2 className="label mb-3">Agentes diarios</h2>
        <div className="grid grid-cols-5 gap-3">
          {AGENTES_ORDEN.map((a) => {
            const run = ultimosRunsAgente.get(a.id);
            return <AgenteCard key={a.id} agente={a} run={run} />;
          })}
        </div>
      </section>

      {/* === Tabla de clientes operativos === */}
      <section className="mb-8">
        <h2 className="label mb-3">Clientes operativos · estado hoy</h2>
        <div className="card overflow-hidden p-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-edge bg-paper-sunken">
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Cliente</th>
                <th className="text-right py-2.5 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Facturas 2026</th>
                <th className="text-center py-2.5 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Runs hoy</th>
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Último run</th>
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Resumen</th>
              </tr>
            </thead>
            <tbody>
              {clientesOp.map((c) => {
                const runs = runsFactByCliente.get(c.id) ?? [];
                const ultimo = runs[0];
                const facturas = conteos.get(c.id) ?? 0;
                return (
                  <tr key={c.id} className="border-b border-edge-2 hover:bg-paper-sunken/50">
                    <td className="py-2.5 px-4">
                      <Link to={`/cliente/${c.slug}`} className="text-ink hover:text-accent transition-colors font-medium">
                        {c.nombre}
                      </Link>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{facturas}</td>
                    <td className="py-2.5 px-4 text-center font-mono">{runs.length}</td>
                    <td className="py-2.5 px-4">
                      {ultimo ? (
                        <div className="flex items-center gap-2">
                          <Pill status={ultimo.status} />
                          <span className="font-mono text-[10px] text-ink-3">
                            {new Date(ultimo.started_at).toLocaleTimeString("es-CO", {
                              timeZone: "America/Bogota",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      ) : (
                        <span className="text-ink-4 font-mono text-[10px]">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[10px] text-ink-3 truncate max-w-[260px]" title={ultimo?.summary ?? ""}>
                      {ultimo?.summary ?? ultimo?.error_message ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* === Resumen consolidado de acciones de hoy === */}
      <ResumenAcciones runs={runs} />
    </div>
  );
}

// ============================================================================
// Subcomponentes
// ============================================================================

function AgenteCard({
  agente,
  run,
}: {
  agente: { id: string; nombre: string; hora: string; emoji: string };
  run: RunRow | undefined;
}) {
  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-base mb-0.5">{agente.emoji}</div>
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase">{agente.hora}</div>
          <div className="font-display text-sm font-semibold tracking-tighter">{agente.nombre}</div>
        </div>
        {run ? <Pill status={run.status} /> : <span className="font-mono text-[9px] text-ink-4 uppercase">sin run</span>}
      </div>
      <div className="mt-3 pt-2.5 border-t border-edge-2">
        {run ? (
          <>
            <div className="font-mono text-[10px] text-ink-3 leading-tight">
              {run.summary ?? run.error_message ?? "—"}
            </div>
            <div className="font-mono text-[9px] text-ink-4 mt-1.5">
              {new Date(run.started_at).toLocaleTimeString("es-CO", {
                timeZone: "America/Bogota",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {run.duration_ms ? ` · ${Math.round(run.duration_ms / 1000)}s` : ""}
            </div>
          </>
        ) : (
          <div className="font-mono text-[10px] text-ink-4">
            Aún no corrió hoy
          </div>
        )}
      </div>
    </div>
  );
}

function ResumenAcciones({ runs }: { runs: RunRow[] }) {
  // Buscar último run de reparador y limpiador, sumar acciones
  const reparadorRun = runs.find((r) => r.agente_id === "reparador");
  const limpiadorRun = runs.find((r) => r.agente_id === "limpiador");
  const supervisorRun = runs.find((r) => r.agente_id === "supervisor");

  const reparadas = reparadorRun?.payload?.filas_reparadas?.length ?? 0;
  const huerfanos = reparadorRun?.payload?.pdfs_huerfanos?.length ?? 0;
  const sinPdf = reparadorRun?.payload?.filas_sin_pdf?.length ?? 0;
  const duplicadosLimp = limpiadorRun?.payload?.duplicados_movidos ?? 0;
  const recuperadas = limpiadorRun?.payload?.facturas_recuperadas ?? 0;
  const noIdent = limpiadorRun?.payload?.no_identificables ?? 0;
  const costoLlm = limpiadorRun?.payload?.costo_llm_usd ?? 0;
  const retriggers = supervisorRun?.payload?.retriggers_disparados ?? 0;

  // Costo Anthropic agregado del día (sumar de facturacion runs payload.llmStats)
  let costoFact = 0;
  let llmCalls = 0;
  for (const r of runs) {
    if (r.agente_id === "facturacion") {
      const stats = r.payload?.llmStats;
      if (stats) {
        costoFact += Number(stats.estimatedCostUsd ?? 0);
        llmCalls += Number(stats.calls ?? 0);
      }
    }
  }
  const costoTotal = costoFact + costoLlm;

  return (
    <section className="mb-8">
      <h2 className="label mb-3">Acciones de hoy</h2>
      <div className="grid grid-cols-4 gap-3">
        <AccionStat
          label="Filas reparadas"
          subtitle="Reparador (Etapa 1)"
          value={reparadas}
          color={reparadas > 0 ? "ok" : "neutral"}
        />
        <AccionStat
          label="Facturas recuperadas"
          subtitle="Limpiador"
          value={recuperadas}
          color={recuperadas > 0 ? "ok" : "neutral"}
        />
        <AccionStat
          label="Duplicados → Papelera"
          subtitle="Limpiador"
          value={duplicadosLimp}
          color={duplicadosLimp > 0 ? "warn" : "neutral"}
        />
        <AccionStat
          label="Retriggers automáticos"
          subtitle="Supervisor"
          value={retriggers}
          color={retriggers > 0 ? "warn" : "neutral"}
        />
        <AccionStat
          label="PDFs huérfanos"
          subtitle="Para revisar"
          value={huerfanos}
          color={huerfanos > 0 ? "warn" : "neutral"}
        />
        <AccionStat
          label="Filas sin PDF"
          subtitle="Para revisar"
          value={sinPdf}
          color={sinPdf > 0 ? "warn" : "neutral"}
        />
        <AccionStat
          label="No identificables"
          subtitle="Limpiador"
          value={noIdent}
          color={noIdent > 0 ? "warn" : "neutral"}
        />
        <AccionStat
          label="Costo Anthropic"
          subtitle={`${llmCalls} llamadas LLM`}
          value={`$${costoTotal.toFixed(3)}`}
          color={costoTotal > 2 ? "warn" : "neutral"}
        />
      </div>
    </section>
  );
}

function AccionStat({
  label,
  subtitle,
  value,
  color,
}: {
  label: string;
  subtitle: string;
  value: number | string;
  color: "ok" | "warn" | "neutral";
}) {
  const colorClass =
    color === "ok"
      ? "text-ok"
      : color === "warn"
        ? "text-accent"
        : "text-ink";
  return (
    <div className="card">
      <div className="label-tight text-ink-3 mb-1.5">{label}</div>
      <div className={`font-display text-3xl font-medium tracking-[-0.02em] tabular-nums ${colorClass} leading-none mb-1`}>
        {value}
      </div>
      <div className="font-mono text-[9px] text-ink-4 tracking-[0.04em] uppercase">{subtitle}</div>
    </div>
  );
}
