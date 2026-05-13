/**
 * Página /diagnostico — Vista consolidada de los 5 agentes.
 *
 * Refresca cada minuto. Reemplaza los emails diarios:
 *   - Cards de agentes con stats integradas (procesadas/saltadas/repetidas/errores)
 *   - Tabla de clientes con detalle por cliente
 *   - Drilldown por click (huérfanos / no identificables / retriggers → lista de clientes)
 *   - Botón "Generar reporte ejecutivo" → llama Claude para resumir el día
 *   - Charts histórico de últimos 30 días (facturas/día, costo Anthropic/día)
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { Link } from "react-router-dom";
import { useState } from "react";
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

const SYNTHETIC_SLUGS = new Set(["monitor", "reparador", "limpiador", "supervisor", "owner"]);

function bogotaTodayUtcStart(): string {
  const now = new Date();
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(bogotaMs);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + 5 * 60 * 60 * 1000).toISOString();
}

function bogotaDateNDaysAgo(n: number): string {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000;
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + 5 * 60 * 60 * 1000).toISOString();
}

function useDiagnosticoData() {
  return useQuery({
    queryKey: ["diagnostico-hoy"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const dayStart = bogotaTodayUtcStart();

      const { data: clientes } = await supabase
        .from("clientes")
        .select("id, slug, nombre, activo")
        .eq("activo", true)
        .order("slug");

      const { data: runs } = await supabase
        .from("agent_runs")
        .select("*")
        .gte("started_at", dayStart)
        .order("started_at", { ascending: false });

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

function useHistorico30Dias() {
  return useQuery({
    queryKey: ["diagnostico-historico-30d"],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const since = bogotaDateNDaysAgo(30);
      const { data: runs } = await supabase
        .from("agent_runs")
        .select("agente_id, status, started_at, payload")
        .gte("started_at", since)
        .order("started_at", { ascending: true });
      return (runs ?? []) as Array<Pick<RunRow, "agente_id" | "status" | "started_at" | "payload">>;
    },
  });
}

// Día Bogotá (YYYY-MM-DD) desde ISO UTC
function bogotaDayKey(iso: string): string {
  const ms = new Date(iso).getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ============================================================================
// Página principal
// ============================================================================

export default function DiagnosticoPage() {
  const { data, isLoading } = useDiagnosticoData();
  const historico = useHistorico30Dias();

  if (isLoading || !data) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando diagnóstico…
      </div>
    );
  }

  const { clientes, runs, conteos } = data;
  const clientesOp = clientes.filter((c) => !SYNTHETIC_SLUGS.has(c.slug));

  // Stats agregadas por agente
  const aggFact = aggregateFacturacion(runs, clientesOp);
  const lastByAgent = new Map<string, RunRow>();
  for (const r of runs) {
    if (["monitor", "reparador", "limpiador", "supervisor"].includes(r.agente_id) && !lastByAgent.has(r.agente_id)) {
      lastByAgent.set(r.agente_id, r);
    }
  }

  const monitorRun = lastByAgent.get("monitor");
  const reparadorRun = lastByAgent.get("reparador");
  const limpiadorRun = lastByAgent.get("limpiador");
  const supervisorRun = lastByAgent.get("supervisor");

  // Stats de cada agente diario
  const aggRep = reparadorRun?.payload ?? {};
  const aggLimp = limpiadorRun?.payload ?? {};
  const aggSup = supervisorRun?.payload ?? {};

  // Costo Anthropic total del día (facturación + limpiador)
  const costoFact = aggFact.llmCostUsd;
  const costoLimp = Number(aggLimp.costo_llm_usd ?? 0);
  const llmCallsFact = aggFact.llmCalls;
  const llmCallsLimp = Number(aggLimp.llamadas_llm ?? aggLimp.total_huerfanos_analizados ?? 0);
  const costoTotal = costoFact + costoLimp;
  const llmCallsTotal = llmCallsFact + llmCallsLimp;

  // Mapa cliente_id → nombre para drilldowns
  const clienteById = new Map<string, ClienteRow>();
  for (const c of clientes) clienteById.set(c.id, c);

  // Runs de facturación por cliente HOY
  const runsFactByCliente = new Map<string, RunRow[]>();
  for (const r of runs) {
    if (r.agente_id !== "facturacion" || !r.cliente_id) continue;
    const arr = runsFactByCliente.get(r.cliente_id) ?? [];
    arr.push(r);
    runsFactByCliente.set(r.cliente_id, arr);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-6 mb-6">
        <div>
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-3">
            <span className="text-ink-4">Diagnóstico · estado de los 5 agentes ·</span>{" "}
            <span className="text-ink-2">
              {new Date().toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "long" })}
            </span>
          </div>
          <h1 className="font-display text-4xl font-medium tracking-tightest text-ink leading-none mb-1">
            Diagnóstico
          </h1>
          <p className="font-sans text-sm text-ink-3 mt-2">
            Vista en vivo del estado de hoy. Refresca cada minuto.
          </p>
        </div>

        {/* Costo Anthropic arriba a la derecha */}
        <CostoAnthropicCard costoTotal={costoTotal} llmCalls={llmCallsTotal} />
      </div>

      {/* === Botón reporte ejecutivo === */}
      <ReporteEjecutivoSection />

      {/* === 5 cards de agentes con stats integradas === */}
      <section className="mb-8">
        <h2 className="label mb-3">Agentes diarios</h2>
        <div className="grid grid-cols-5 gap-3">
          <FacturacionCard agente={AGENTES_ORDEN[0]} agg={aggFact} clientesOp={clientesOp.length} />
          <MonitorCard agente={AGENTES_ORDEN[1]} run={monitorRun} />
          <ReparadorCard agente={AGENTES_ORDEN[2]} run={reparadorRun} payload={aggRep} />
          <LimpiadorCard agente={AGENTES_ORDEN[3]} run={limpiadorRun} payload={aggLimp} />
          <SupervisorCard agente={AGENTES_ORDEN[4]} run={supervisorRun} payload={aggSup} />
        </div>
      </section>

      {/* === Tabla de clientes (4 columnas: Procesadas/Saltadas/Repetidas/Errores) === */}
      <section className="mb-8">
        <h2 className="label mb-3">Clientes operativos · estado hoy</h2>
        <div className="card overflow-hidden p-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-edge bg-paper-sunken">
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Cliente</th>
                <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Facturas 2026</th>
                <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Procesadas</th>
                <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Repetidas</th>
                <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Saltadas</th>
                <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Errores</th>
                <th className="text-center py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Runs</th>
                <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Último</th>
              </tr>
            </thead>
            <tbody>
              {clientesOp.map((c) => {
                const cRuns = runsFactByCliente.get(c.id) ?? [];
                const ultimo = cRuns[0];
                const facturas = conteos.get(c.id) ?? 0;
                // Sumar payload de TODOS los runs del cliente hoy (multi-pass = 12 runs)
                const proc = sumPayload(cRuns, "procesadas");
                const rep = sumPayload(cRuns, "repetidas");
                const salt = sumPayload(cRuns, "saltadas");
                const err = sumPayload(cRuns, "errores");
                return (
                  <tr key={c.id} className="border-b border-edge-2 hover:bg-paper-sunken/50">
                    <td className="py-2.5 px-4">
                      <Link to={`/cliente/${c.slug}`} className="text-ink hover:text-accent transition-colors font-medium">
                        {c.nombre}
                      </Link>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums">{facturas}</td>
                    <td className={`py-2.5 px-3 text-right font-mono tabular-nums ${proc > 0 ? "text-ok" : "text-ink-4"}`}>{proc}</td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-3">{rep}</td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-3">{salt}</td>
                    <td className={`py-2.5 px-3 text-right font-mono tabular-nums ${err > 0 ? "text-accent" : "text-ink-4"}`}>{err}</td>
                    <td className="py-2.5 px-3 text-center font-mono text-ink-3">{cRuns.length}</td>
                    <td className="py-2.5 px-3">
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* === Drilldowns por click === */}
      <DrilldownSection
        reparadorPayload={aggRep}
        limpiadorPayload={aggLimp}
        supervisorPayload={aggSup}
        clienteById={clienteById}
      />

      {/* === Dashboard gráfico === */}
      <section className="mb-8">
        <h2 className="label mb-3">Histórico · últimos 30 días</h2>
        <HistoricoCharts runs={historico.data ?? []} loading={historico.isLoading} />
      </section>
    </div>
  );
}

// ============================================================================
// Agregación
// ============================================================================

function aggregateFacturacion(
  runs: RunRow[],
  clientesOp: ClienteRow[],
): {
  procesadas: number;
  saltadas: number;
  repetidas: number;
  errores: number;
  clientesConRun: number;
  llmCostUsd: number;
  llmCalls: number;
  ultimaHora?: string;
} {
  let procesadas = 0,
    saltadas = 0,
    repetidas = 0,
    errores = 0,
    llmCost = 0,
    llmCalls = 0;
  const clientesConRun = new Set<string>();
  let ultimaHora: string | undefined;
  for (const r of runs) {
    if (r.agente_id !== "facturacion") continue;
    if (r.cliente_id) clientesConRun.add(r.cliente_id);
    const p = r.payload ?? {};
    procesadas += Number(p.procesadas ?? 0);
    saltadas += Number(p.saltadas ?? 0);
    repetidas += Number(p.repetidas ?? 0);
    errores += Number(p.errores ?? 0);
    llmCost += Number(p.llm_cost_usd ?? 0);
    llmCalls += Number(p.llm_calls ?? 0);
    if (!ultimaHora || r.started_at > (ultimaHora || "")) ultimaHora = r.started_at;
  }
  // Filtrar clientes_con_run a solo operativos
  const opIds = new Set(clientesOp.map((c) => c.id));
  const clientesValidos = Array.from(clientesConRun).filter((id) => opIds.has(id));
  return {
    procesadas,
    saltadas,
    repetidas,
    errores,
    clientesConRun: clientesValidos.length,
    llmCostUsd: llmCost,
    llmCalls,
    ultimaHora,
  };
}

function sumPayload(runs: RunRow[], key: string): number {
  let sum = 0;
  for (const r of runs) sum += Number(r.payload?.[key] ?? 0);
  return sum;
}

// ============================================================================
// Cards de agentes (con stats integradas)
// ============================================================================

function FacturacionCard({
  agente,
  agg,
  clientesOp,
}: {
  agente: { nombre: string; hora: string; emoji: string };
  agg: ReturnType<typeof aggregateFacturacion>;
  clientesOp: number;
}) {
  const tieneRun = agg.clientesConRun > 0;
  const status: "ok" | "warn" | "fail" = !tieneRun ? "fail" : agg.errores > 0 ? "warn" : "ok";
  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-base mb-0.5">{agente.emoji}</div>
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase">{agente.hora}</div>
          <div className="font-display text-sm font-semibold tracking-tighter">{agente.nombre}</div>
        </div>
        {tieneRun ? <Pill status={status} /> : <span className="font-mono text-[9px] text-ink-4 uppercase">sin run</span>}
      </div>
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="Clientes" value={`${agg.clientesConRun}/${clientesOp}`} />
        <StatLine label="Procesadas" value={agg.procesadas} colorIfPos="ok" />
        <StatLine label="Repetidas" value={agg.repetidas} colorIfPos="muted" />
        <StatLine label="Saltadas" value={agg.saltadas} colorIfPos="muted" />
        <StatLine label="Errores" value={agg.errores} colorIfPos="warn" />
        <div className="font-mono text-[9px] text-ink-4 mt-2">
          {agg.ultimaHora
            ? `Último: ${new Date(agg.ultimaHora).toLocaleTimeString("es-CO", {
                timeZone: "America/Bogota",
                hour: "2-digit",
                minute: "2-digit",
              })}`
            : "Aún no corrió"}
        </div>
      </div>
    </div>
  );
}

function MonitorCard({ agente, run }: { agente: { nombre: string; hora: string; emoji: string }; run: RunRow | undefined }) {
  const p = run?.payload ?? {};
  return (
    <div className="card">
      <CardHeader agente={agente} run={run} />
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="Total" value={p.clientes_total ?? 0} />
        <StatLine label="OK" value={p.clientes_ok ?? 0} colorIfPos="ok" />
        <StatLine label="Alertas" value={p.clientes_con_alerta ?? 0} colorIfPos="warn" />
        <StatLine label="Zombies" value={p.zombies_cerrados ?? 0} colorIfPos="muted" />
        <CardFooter run={run} />
      </div>
    </div>
  );
}

function ReparadorCard({
  agente,
  run,
  payload,
}: {
  agente: { nombre: string; hora: string; emoji: string };
  run: RunRow | undefined;
  payload: any;
}) {
  const reparadas = payload.filas_reparadas?.length ?? 0;
  const huerfanos = payload.pdfs_huerfanos?.length ?? 0;
  const sinPdf = payload.filas_sin_pdf?.length ?? 0;
  return (
    <div className="card">
      <CardHeader agente={agente} run={run} />
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="Reparadas" value={reparadas} colorIfPos="ok" />
        <StatLine label="Huérfanos" value={huerfanos} colorIfPos="warn" />
        <StatLine label="Sin PDF" value={sinPdf} colorIfPos="warn" />
        <CardFooter run={run} />
      </div>
    </div>
  );
}

function LimpiadorCard({
  agente,
  run,
  payload,
}: {
  agente: { nombre: string; hora: string; emoji: string };
  run: RunRow | undefined;
  payload: any;
}) {
  const dup = payload.duplicados_movidos ?? 0;
  const rec = payload.facturas_recuperadas ?? 0;
  const noId = payload.no_identificables ?? 0;
  const costo = Number(payload.costo_llm_usd ?? 0);
  return (
    <div className="card">
      <CardHeader agente={agente} run={run} />
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="Duplicados" value={dup} colorIfPos="warn" />
        <StatLine label="Recuperadas" value={rec} colorIfPos="ok" />
        <StatLine label="No id." value={noId} colorIfPos="warn" />
        <StatLine label="Costo LLM" value={`$${costo.toFixed(3)}`} colorIfPos="muted" />
        <CardFooter run={run} />
      </div>
    </div>
  );
}

function SupervisorCard({
  agente,
  run,
  payload,
}: {
  agente: { nombre: string; hora: string; emoji: string };
  run: RunRow | undefined;
  payload: any;
}) {
  // El supervisor siempre es OK si corrió — los warn/fail son del estado de clientes, no del run.
  const supRun: RunRow | undefined = run ? { ...run, status: run.status === "fail" && !run.error_message ? "ok" : run.status } : undefined;
  const ok = payload.clientes_ok ?? 0;
  const warn = payload.clientes_warn ?? 0;
  const fail = payload.clientes_fail ?? 0;
  const retriggers = payload.retriggers_disparados ?? 0;
  return (
    <div className="card">
      <CardHeader agente={agente} run={supRun} />
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="OK" value={ok} colorIfPos="ok" />
        <StatLine label="Warn" value={warn} colorIfPos="warn" />
        <StatLine label="Fail" value={fail} colorIfPos="warn" />
        <StatLine label="Retriggers" value={retriggers} colorIfPos="muted" />
        <CardFooter run={run} />
      </div>
    </div>
  );
}

function CardHeader({
  agente,
  run,
}: {
  agente: { nombre: string; hora: string; emoji: string };
  run: RunRow | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <div>
        <div className="text-base mb-0.5">{agente.emoji}</div>
        <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase">{agente.hora}</div>
        <div className="font-display text-sm font-semibold tracking-tighter">{agente.nombre}</div>
      </div>
      {run ? <Pill status={run.status} /> : <span className="font-mono text-[9px] text-ink-4 uppercase">sin run</span>}
    </div>
  );
}

function CardFooter({ run }: { run: RunRow | undefined }) {
  if (!run) return <div className="font-mono text-[9px] text-ink-4 mt-2">Aún no corrió hoy</div>;
  return (
    <div className="font-mono text-[9px] text-ink-4 mt-2">
      {new Date(run.started_at).toLocaleTimeString("es-CO", {
        timeZone: "America/Bogota",
        hour: "2-digit",
        minute: "2-digit",
      })}
      {run.duration_ms ? ` · ${Math.round(run.duration_ms / 1000)}s` : ""}
    </div>
  );
}

function StatLine({
  label,
  value,
  colorIfPos = "ink",
}: {
  label: string;
  value: number | string;
  colorIfPos?: "ok" | "warn" | "muted" | "ink";
}) {
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/\D/g, ""));
  const isPositive = numeric > 0;
  const color = !isPositive
    ? "text-ink-4"
    : colorIfPos === "ok"
      ? "text-ok"
      : colorIfPos === "warn"
        ? "text-accent"
        : colorIfPos === "muted"
          ? "text-ink-3"
          : "text-ink";
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase">{label}</span>
      <span className={`font-mono text-[12px] tabular-nums font-medium ${color}`}>{value}</span>
    </div>
  );
}

// ============================================================================
// Costo Anthropic
// ============================================================================

function CostoAnthropicCard({ costoTotal, llmCalls }: { costoTotal: number; llmCalls: number }) {
  return (
    <div className="card min-w-[200px]">
      <div className="label-tight text-ink-3 mb-1.5">Costo Anthropic HOY</div>
      <div className="font-display text-3xl font-medium tracking-[-0.02em] tabular-nums text-ink leading-none mb-1">
        ${costoTotal.toFixed(3)}
      </div>
      <div className="font-mono text-[9px] text-ink-4 tracking-[0.04em] uppercase">{llmCalls} llamadas LLM</div>
      <a
        href="https://console.anthropic.com/settings/billing"
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[10px] text-accent hover:underline mt-2 inline-block"
      >
        Ver saldo →
      </a>
    </div>
  );
}

// ============================================================================
// Drilldown por click
// ============================================================================

function DrilldownSection({
  reparadorPayload,
  limpiadorPayload,
  supervisorPayload,
  clienteById,
}: {
  reparadorPayload: any;
  limpiadorPayload: any;
  supervisorPayload: any;
  clienteById: Map<string, ClienteRow>;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const huerfanos = reparadorPayload.pdfs_huerfanos ?? [];
  const sinPdf = reparadorPayload.filas_sin_pdf ?? [];
  const noId = limpiadorPayload.no_identificables_lista ?? [];
  const retriggers = supervisorPayload.retriggers ?? supervisorPayload.acciones ?? [];

  const items = [
    { id: "huerfanos", label: "PDFs huérfanos", count: huerfanos.length, list: huerfanos, color: "warn" },
    { id: "sin_pdf", label: "Filas sin PDF", count: sinPdf.length, list: sinPdf, color: "warn" },
    { id: "no_id", label: "No identificables", count: noId.length || (limpiadorPayload.no_identificables ?? 0), list: noId, color: "warn" },
    { id: "retriggers", label: "Retriggers automáticos", count: retriggers.length || (supervisorPayload.retriggers_disparados ?? 0), list: retriggers, color: "muted" },
  ];

  // Sin items para mostrar
  if (items.every((i) => i.count === 0)) {
    return (
      <section className="mb-8">
        <h2 className="label mb-3">Acciones que requieren revisión</h2>
        <div className="card font-mono text-[11px] text-ink-3">
          Nada para revisar hoy. Todo limpio.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <h2 className="label mb-3">Acciones que requieren revisión</h2>
      <div className="grid grid-cols-4 gap-3 mb-3">
        {items.map((it) => {
          const isOpen = open === it.id;
          const isWarn = it.color === "warn" && it.count > 0;
          return (
            <button
              key={it.id}
              onClick={() => setOpen(isOpen ? null : it.id)}
              className={`card text-left transition-all ${isOpen ? "ring-2 ring-accent" : "hover:ring-1 hover:ring-edge"}`}
            >
              <div className="label-tight text-ink-3 mb-1.5">{it.label}</div>
              <div
                className={`font-display text-3xl font-medium tracking-[-0.02em] tabular-nums leading-none mb-1 ${
                  it.count === 0 ? "text-ink-4" : isWarn ? "text-accent" : "text-ink"
                }`}
              >
                {it.count}
              </div>
              <div className="font-mono text-[9px] text-ink-4 tracking-[0.04em] uppercase">
                {it.count > 0 ? (isOpen ? "click para cerrar" : "click para ver detalle") : "—"}
              </div>
            </button>
          );
        })}
      </div>

      {open && (
        <DrilldownDetail
          item={items.find((i) => i.id === open)!}
          clienteById={clienteById}
        />
      )}
    </section>
  );
}

function DrilldownDetail({
  item,
  clienteById,
}: {
  item: { id: string; label: string; count: number; list: any[] };
  clienteById: Map<string, ClienteRow>;
}) {
  if (!item.list || item.list.length === 0) {
    return (
      <div className="card font-mono text-[11px] text-ink-3">
        {item.count > 0
          ? `${item.count} elementos — el detalle no se está guardando en el payload del run (solo el contador).`
          : "Sin detalle"}
      </div>
    );
  }

  // Agrupar por cliente_slug
  const porCliente = new Map<string, any[]>();
  for (const it of item.list) {
    const slug = it.cliente_slug ?? it.slug ?? "sin_cliente";
    const arr = porCliente.get(slug) ?? [];
    arr.push(it);
    porCliente.set(slug, arr);
  }

  return (
    <div className="card overflow-hidden p-0">
      <div className="px-4 py-2.5 bg-paper-sunken border-b border-edge font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase">
        Detalle · {item.label}
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-edge bg-paper-sunken">
            <th className="text-left py-2 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Cliente</th>
            <th className="text-right py-2 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Items</th>
            <th className="text-left py-2 px-4 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Ejemplos</th>
          </tr>
        </thead>
        <tbody>
          {Array.from(porCliente.entries()).map(([slug, items]) => {
            const cliente = Array.from(clienteById.values()).find((c) => c.slug === slug);
            return (
              <tr key={slug} className="border-b border-edge-2 hover:bg-paper-sunken/30">
                <td className="py-2 px-4">
                  {cliente ? (
                    <Link to={`/cliente/${cliente.slug}`} className="text-ink hover:text-accent font-medium">
                      {cliente.nombre}
                    </Link>
                  ) : (
                    <span className="text-ink-4 font-mono text-[11px]">{slug}</span>
                  )}
                </td>
                <td className="py-2 px-4 text-right font-mono tabular-nums">{items.length}</td>
                <td className="py-2 px-4 font-mono text-[10px] text-ink-3 truncate max-w-[400px]">
                  {items
                    .slice(0, 2)
                    .map((it) => it.nombre_archivo ?? it.numero ?? it.proveedor ?? it.motivo ?? JSON.stringify(it).slice(0, 60))
                    .join(" · ")}
                  {items.length > 2 ? ` …+${items.length - 2}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Reporte ejecutivo
// ============================================================================

function ReporteEjecutivoSection() {
  const [reporte, setReporte] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: async () => {
      const { data: sess } = await supabase.auth.getSession();
      const accessToken = sess.session?.access_token;
      const resp = await fetch("/api/diagnostico-reporte", {
        method: "POST",
        headers: { "content-type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ fecha: new Date().toISOString() }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      return json.reporte as string;
    },
    onSuccess: (r) => setReporte(r),
  });

  return (
    <section className="mb-8 card">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="font-display text-base font-semibold tracking-tighter mb-0.5">Reporte ejecutivo del día</h2>
          <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase">
            Claude analiza los runs de hoy y te resume qué pasó
          </p>
        </div>
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
          className="btn-primary disabled:opacity-50"
        >
          {mut.isPending ? "Generando…" : reporte ? "Regenerar" : "Generar reporte"}
        </button>
      </div>
      {mut.isError && (
        <div className="font-mono text-[11px] text-accent mt-2">
          Error: {(mut.error as Error).message}
        </div>
      )}
      {reporte && (
        <div className="mt-3 pt-3 border-t border-edge-2 font-sans text-[13px] text-ink whitespace-pre-wrap leading-relaxed">
          {reporte}
        </div>
      )}
    </section>
  );
}

// ============================================================================
// Charts SVG nativos
// ============================================================================

function HistoricoCharts({
  runs,
  loading,
}: {
  runs: Array<Pick<RunRow, "agente_id" | "status" | "started_at" | "payload">>;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="card font-mono text-[11px] text-ink-3">Cargando histórico…</div>
    );
  }

  // Agrupar por día
  const porDia = new Map<string, { procesadas: number; errores: number; costo: number }>();
  for (const r of runs) {
    if (r.agente_id !== "facturacion") continue;
    const day = bogotaDayKey(r.started_at);
    const entry = porDia.get(day) ?? { procesadas: 0, errores: 0, costo: 0 };
    const p = r.payload ?? {};
    entry.procesadas += Number(p.procesadas ?? 0);
    entry.errores += Number(p.errores ?? 0);
    entry.costo += Number(p.llm_cost_usd ?? 0);
    porDia.set(day, entry);
  }

  // Generar todos los días (incluso vacíos) de los últimos 30
  const days: Array<{ day: string; procesadas: number; errores: number; costo: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const v = porDia.get(key) ?? { procesadas: 0, errores: 0, costo: 0 };
    days.push({ day: key, ...v });
  }

  const totalProc30d = days.reduce((s, d) => s + d.procesadas, 0);
  const totalCosto30d = days.reduce((s, d) => s + d.costo, 0);

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <div className="label-tight text-ink-3">Facturas procesadas/día</div>
          <div className="font-mono text-[10px] text-ink-3 tabular-nums">{totalProc30d} en 30 días</div>
        </div>
        <BarChart
          data={days.map((d) => ({ label: d.day.slice(5), value: d.procesadas, isError: d.errores > 0 }))}
          height={140}
          color="ok"
        />
      </div>
      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <div className="label-tight text-ink-3">Costo Anthropic/día</div>
          <div className="font-mono text-[10px] text-ink-3 tabular-nums">${totalCosto30d.toFixed(2)} en 30 días</div>
        </div>
        <BarChart
          data={days.map((d) => ({ label: d.day.slice(5), value: d.costo, isError: false }))}
          height={140}
          color="accent"
          format={(v) => `$${v.toFixed(2)}`}
        />
      </div>
    </div>
  );
}

function BarChart({
  data,
  height,
  color,
  format = (v: number) => v.toString(),
}: {
  data: Array<{ label: string; value: number; isError?: boolean }>;
  height: number;
  color: "ok" | "accent" | "ink";
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barW = 100 / data.length;
  const fillVar = color === "ok" ? "var(--color-ok)" : color === "accent" ? "var(--color-accent)" : "var(--color-ink)";

  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height: `${height}px` }}>
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 16);
          const x = i * barW + barW * 0.15;
          const y = height - 16 - h;
          const w = barW * 0.7;
          const isLast = i === data.length - 1;
          return (
            <g key={d.label}>
              <rect
                x={x}
                y={y}
                width={w}
                height={Math.max(1, h)}
                fill={d.isError ? "var(--color-accent)" : fillVar}
                opacity={isLast ? 1 : 0.85}
              >
                <title>
                  {d.label}: {format(d.value)}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between font-mono text-[9px] text-ink-4 mt-1.5 tracking-[0.04em]">
        <span>{data[0].label}</span>
        <span>{data[Math.floor(data.length / 2)].label}</span>
        <span>{data[data.length - 1].label}</span>
      </div>
    </div>
  );
}
