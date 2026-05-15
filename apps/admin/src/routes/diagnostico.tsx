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
  { id: "facturacion", nombre: "Procesador facturas de compra", hora: "07:00", emoji: "📥" },
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

      return {
        clientes: (clientes ?? []) as ClienteRow[],
        runs: (runs ?? []) as RunRow[],
      };
    },
  });
}


// ============================================================================
// Página principal
// ============================================================================

export default function DiagnosticoPage() {
  const { data, isLoading } = useDiagnosticoData();
  const [auditCliente, setAuditCliente] = useState<{ slug: string; nombre: string } | null>(null);

  if (isLoading || !data) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando diagnóstico…
      </div>
    );
  }

  const { clientes, runs } = data;
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
  // Recalculamos desde llm_calls × $0.003 para runs viejos que tienen factor antiguo.
  const costoFact = aggFact.llmCostUsd;
  const llmCallsLimp = Number(aggLimp.llamadas_llm ?? aggLimp.total_huerfanos_analizados ?? 0);
  const costoLimp = llmCallsLimp * LLM_COST_PER_CALL_USD;
  const llmCallsFact = aggFact.llmCalls;
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

  // Cliente seleccionado para auditoría (state arriba)
  // (declarado dentro del componente para usar useState)

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

      {/* === Card principal: el Procesador === */}
      <section className="mb-3">
        <h2 className="label mb-3">Procesador · agente principal</h2>
        <FacturacionCard
          agente={AGENTES_ORDEN[0]}
          agg={aggFact}
          clientesOp={clientesOp.length}
          big
        />
      </section>

      {/* === 4 cards administrativos === */}
      <section className="mb-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="label">Agentes administrativos · validan y reparan después del procesador</h2>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <MonitorCard agente={AGENTES_ORDEN[1]} run={monitorRun} />
          <ReparadorCard agente={AGENTES_ORDEN[2]} run={reparadorRun} payload={aggRep} />
          <LimpiadorCard agente={AGENTES_ORDEN[3]} run={limpiadorRun} payload={aggLimp} />
          <SupervisorCard agente={AGENTES_ORDEN[4]} run={supervisorRun} payload={aggSup} />
        </div>
      </section>

      {/* === Selector de cliente para auditoría === */}
      <section className="mb-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="label">Auditoría por cliente · compara Gmail vs Drive vs Sheet vs Events</h2>
          <Link
            to="/clientes"
            className="font-mono text-[11px] text-accent hover:underline tracking-[0.04em]"
          >
            ver todos los clientes →
          </Link>
        </div>
        <div className="card">
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase mb-3">
            Selecciona un cliente para auditar
          </div>
          <div className="flex flex-wrap gap-1.5">
            {clientesOp.map((c) => (
              <button
                key={c.id}
                onClick={() => setAuditCliente({ slug: c.slug, nombre: c.nombre })}
                className={`font-mono text-[11px] tracking-[0.04em] px-2.5 py-1 rounded-md transition-all ${
                  auditCliente?.slug === c.slug
                    ? "bg-ink text-paper font-medium"
                    : "text-ink-3 hover:text-ink hover:bg-paper-sunken"
                }`}
              >
                {c.nombre}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* === Panel de auditoría (cuando hay cliente seleccionado) === */}
      {auditCliente && (
        <AuditoriaPanel
          cliente={auditCliente}
          onClose={() => setAuditCliente(null)}
        />
      )}

      {/* === Drilldowns por click === */}
      <DrilldownSection
        reparadorPayload={aggRep}
        limpiadorPayload={aggLimp}
        supervisorPayload={aggSup}
        clienteById={clienteById}
      />
    </div>
  );
}

// ============================================================================
// Agregación
// ============================================================================

// Pricing real Claude Haiku 4.5 — debe coincidir con LLM_COST_PER_CALL_USD del backend
const LLM_COST_PER_CALL_USD = 0.003;

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
    llmCalls += Number(p.llm_calls ?? 0);
    if (!ultimaHora || r.started_at > (ultimaHora || "")) ultimaHora = r.started_at;
  }
  // Filtrar clientes_con_run a solo operativos
  const opIds = new Set(clientesOp.map((c) => c.id));
  const clientesValidos = Array.from(clientesConRun).filter((id) => opIds.has(id));
  // Calcular costo desde llm_calls (NO desde payload.llm_cost_usd) porque runs
  // viejos están con factor obsoleto $0.001. El factor real Haiku 4.5 es $0.003.
  return {
    procesadas,
    saltadas,
    repetidas,
    errores,
    clientesConRun: clientesValidos.length,
    llmCostUsd: llmCalls * LLM_COST_PER_CALL_USD,
    llmCalls,
    ultimaHora,
  };
}

// ============================================================================
// Cards de agentes (con stats integradas)
// ============================================================================

function FacturacionCard({
  agente,
  agg,
  clientesOp,
  big = false,
}: {
  agente: { nombre: string; hora: string; emoji: string };
  agg: ReturnType<typeof aggregateFacturacion>;
  clientesOp: number;
  big?: boolean;
}) {
  const tieneRun = agg.clientesConRun > 0;
  const status: "ok" | "warn" | "fail" = !tieneRun ? "fail" : agg.errores > 0 ? "warn" : "ok";
  const totalCorreos = agg.procesadas + agg.repetidas + agg.saltadas + agg.errores;

  if (!big) {
    // Versión compacta (no se usa actualmente, pero queda por si)
    return (
      <div className="card">
        <CardHeader agente={agente} run={undefined} />
        <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
          <StatLine label="Procesadas" value={agg.procesadas} colorIfPos="ok" />
        </div>
      </div>
    );
  }

  // Versión grande (1 fila, 6 columnas con stats)
  return (
    <div className="card">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl">{agente.emoji}</div>
          <div>
            <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-1">
              {agente.hora} · agente principal
            </div>
            <div className="font-display text-xl font-semibold tracking-tighter">{agente.nombre}</div>
            <div className="font-mono text-[10px] text-ink-4 tracking-[0.04em] mt-1">
              {agg.clientesConRun}/{clientesOp} clientes corrieron hoy
              {agg.ultimaHora
                ? ` · último ${new Date(agg.ultimaHora).toLocaleTimeString("es-CO", {
                    timeZone: "America/Bogota",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`
                : ""}
            </div>
          </div>
        </div>
        {tieneRun ? <Pill status={status} /> : <span className="font-mono text-[9px] text-ink-4 uppercase">sin run</span>}
      </div>
      <div className="grid grid-cols-6 gap-3 pt-3 border-t border-edge-2">
        <BigStat label="Procesadas" value={agg.procesadas} colorIfPos="ok" sub="facturas nuevas en Sheet" />
        <BigStat label="Repetidas" value={agg.repetidas} colorIfPos="muted" sub="ya estaban (dedup OK)" />
        <BigStat label="Saltadas" value={agg.saltadas} colorIfPos="muted" sub="correos no-factura" />
        <BigStat label="Errores" value={agg.errores} colorIfPos="warn" sub="revisar" />
        <BigStat label="Correos leídos" value={totalCorreos} sub="total = suma izquierda" muted />
        <BigStat
          label="Costo LLM"
          value={`$${agg.llmCostUsd.toFixed(3)}`}
          sub={`${agg.llmCalls} llamadas Claude`}
          muted
        />
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  colorIfPos = "ink",
  sub,
  muted,
}: {
  label: string;
  value: number | string;
  colorIfPos?: "ok" | "warn" | "muted" | "ink";
  sub?: string;
  muted?: boolean;
}) {
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
  const isPositive = numeric > 0;
  const color =
    muted || !isPositive
      ? "text-ink"
      : colorIfPos === "ok"
        ? "text-ok"
        : colorIfPos === "warn"
          ? "text-accent"
          : colorIfPos === "muted"
            ? "text-ink-3"
            : "text-ink";
  return (
    <div>
      <div className="label-tight text-ink-3 mb-1">{label}</div>
      <div className={`font-display text-2xl font-medium tracking-[-0.02em] tabular-nums leading-none mb-1 ${color}`}>
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[9px] text-ink-4 tracking-[0.04em] uppercase">{sub}</div>
      )}
    </div>
  );
}

function MonitorCard({ agente, run }: { agente: { nombre: string; hora: string; emoji: string }; run: RunRow | undefined }) {
  const p = run?.payload ?? {};
  return (
    <div className="card" title="Monitor no usa LLM — solo consulta agent_runs">
      <CardHeader agente={agente} run={run} />
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="Total" value={p.clientes_total ?? 0} />
        <StatLine label="OK" value={p.clientes_ok ?? 0} colorIfPos="ok" />
        <StatLine label="Alertas" value={p.clientes_con_alerta ?? 0} colorIfPos="warn" />
        <StatLine label="Zombies" value={p.zombies_cerrados ?? 0} colorIfPos="muted" />
        <StatLine label="Costo LLM" value="—" colorIfPos="muted" />
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
    <div className="card" title="Reparador no usa LLM — matching textual proveedor/número">
      <CardHeader agente={agente} run={run} />
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="Reparadas" value={reparadas} colorIfPos="ok" />
        <StatLine
          label="Huérfanos"
          value={huerfanos}
          colorIfPos="warn"
        />
        <div title="Filas en Sheet sin PDF correspondiente en Drive">
          <StatLine label="Sin PDF" value={sinPdf} colorIfPos="warn" />
        </div>
        <StatLine label="Costo LLM" value="—" colorIfPos="muted" />
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
    <div className="card" title="Supervisor no usa LLM — valida con SQL queries">
      <CardHeader agente={agente} run={supRun} />
      <div className="mt-3 pt-2.5 border-t border-edge-2 space-y-1.5">
        <StatLine label="OK" value={ok} colorIfPos="ok" />
        <StatLine label="Warn" value={warn} colorIfPos="warn" />
        <StatLine label="Fail" value={fail} colorIfPos="warn" />
        <StatLine label="Retriggers" value={retriggers} colorIfPos="muted" />
        <StatLine label="Costo LLM" value="—" colorIfPos="muted" />
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

  // No identificables: vienen en limpiador.acciones[] con tipo='no_identificable'
  const accionesLimp = (limpiadorPayload.acciones ?? []) as Array<any>;
  const noId = accionesLimp.filter((a) => a.tipo === "no_identificable");

  // Retriggers: vienen en supervisor.chequeos[].acciones_tomadas (array de strings)
  // Aplanamos a lista con cliente_slug + descripción
  const chequeosSup = (supervisorPayload.chequeos ?? []) as Array<any>;
  const retriggers: Array<{ cliente_slug: string; motivo: string }> = [];
  for (const ch of chequeosSup) {
    for (const accion of ch.acciones_tomadas ?? []) {
      retriggers.push({ cliente_slug: ch.cliente_slug, motivo: accion });
    }
  }

  const items = [
    { id: "huerfanos", label: "PDFs huérfanos", count: huerfanos.length, list: huerfanos, color: "warn", help: "PDFs en Drive sin fila correspondiente en Sheet" },
    { id: "sin_pdf", label: "Filas sin PDF", count: sinPdf.length, list: sinPdf, color: "warn", help: "Filas en Sheet sin archivo PDF en Drive" },
    { id: "no_id", label: "No identificables", count: noId.length, list: noId, color: "warn", help: "PDFs huérfanos que el LLM no pudo clasificar" },
    { id: "retriggers", label: "Retriggers automáticos", count: retriggers.length, list: retriggers, color: "muted", help: "Acciones que el supervisor disparó automáticamente" },
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
              title={it.help}
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
                <td className="py-2 px-4 font-mono text-[10px] text-ink-3 truncate max-w-[480px]">
                  {items
                    .slice(0, 3)
                    .map(
                      (it) =>
                        it.nombre_archivo ??
                        it.drive_file_name ??
                        it.numero ??
                        it.proveedor ??
                        it.motivo ??
                        it.detalle ??
                        JSON.stringify(it).slice(0, 80),
                    )
                    .join(" · ")}
                  {items.length > 3 ? ` …+${items.length - 3}` : ""}
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
      if (!resp.ok) {
        // Leer body del error para mostrar mensaje útil
        let detalle = "";
        try {
          const errJson = await resp.json();
          detalle = errJson.error ?? JSON.stringify(errJson).slice(0, 250);
        } catch {
          try {
            detalle = (await resp.text()).slice(0, 250);
          } catch {
            detalle = "(sin detalle)";
          }
        }
        throw new Error(`HTTP ${resp.status} — ${detalle}`);
      }
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
// Auditoría: compara Gmail vs Drive vs Sheet vs agent_events por mes
// ============================================================================

interface AuditoriaMes {
  mes: string;
  gmail: number;
  drive: number;
  sheet: number;
  events: number;
  coincide: boolean;
  diff: string | null;
}

interface AuditoriaResult {
  customerId: string;
  year: number;
  google_email: string;
  months: AuditoriaMes[];
  totals: { gmail: number; drive: number; sheet: number; events: number; coincide: boolean };
  summary: { meses_con_data: number; meses_con_discrepancia: number; todo_cuadra: boolean };
}

function AuditoriaPanel({
  cliente,
  onClose,
}: {
  cliente: { slug: string; nombre: string };
  onClose: () => void;
}) {
  const audit = useQuery({
    queryKey: ["auditoria", cliente.slug],
    queryFn: async (): Promise<AuditoriaResult> => {
      const { data: sess } = await supabase.auth.getSession();
      const accessToken = sess.session?.access_token;
      const resp = await fetch("/api/admin/health-check", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          customerId: cliente.slug,
          year: new Date().getFullYear(),
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 150)}`);
      }
      return resp.json();
    },
    staleTime: 60_000,
  });

  return (
    <section className="mb-8 card">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="font-display text-base font-semibold tracking-tighter">
            Auditoría · {cliente.nombre}
          </h2>
          <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase mt-0.5">
            Compara Gmail (etiqueta Facturas/YYYY-MM) vs Drive (PDFs en folder) vs Sheet (filas) vs agent_events
          </p>
        </div>
        <button
          onClick={onClose}
          className="font-mono text-[11px] text-ink-3 hover:text-ink tracking-[0.04em]"
        >
          cerrar ×
        </button>
      </div>

      {audit.isLoading && (
        <div className="font-mono text-[11px] text-ink-3 uppercase tracking-[0.04em] py-4">
          Consultando Gmail + Drive + Sheet + Supabase… (puede tardar 10-15s)
        </div>
      )}

      {audit.isError && (
        <div className="font-mono text-[11px] text-accent">
          Error: {(audit.error as Error).message}
        </div>
      )}

      {audit.data && <AuditoriaResultadoTabla data={audit.data} />}
    </section>
  );
}

function AuditoriaResultadoTabla({ data }: { data: AuditoriaResult }) {
  return (
    <div>
      {/* Banner resumen */}
      <div
        className={`mb-3 pt-3 border-t border-edge-2 flex items-baseline gap-4 font-mono text-[11px] ${
          data.summary.todo_cuadra ? "text-ok" : "text-accent"
        }`}
      >
        <span className="font-medium uppercase tracking-[0.04em]">
          {data.summary.todo_cuadra
            ? "✓ Todo cuadra"
            : `⚠ ${data.summary.meses_con_discrepancia} mes(es) con discrepancia`}
        </span>
        <span className="text-ink-3">
          Año {data.year} · cuenta Google {data.google_email}
        </span>
      </div>

      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-edge bg-paper-sunken">
            <th className="text-left py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Mes</th>
            <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Gmail (label)</th>
            <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Drive (PDFs)</th>
            <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Sheet (filas)</th>
            <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Events (DB)</th>
            <th className="text-left py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Estado</th>
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <tr key={m.mes} className={`border-b border-edge-2 ${m.coincide ? "" : "bg-accent/5"}`}>
              <td className="py-2 px-3 font-mono text-[11px] font-medium">{m.mes}</td>
              <td className="py-2 px-3 text-right font-mono tabular-nums">{m.gmail}</td>
              <td className="py-2 px-3 text-right font-mono tabular-nums">{m.drive}</td>
              <td className="py-2 px-3 text-right font-mono tabular-nums">{m.sheet}</td>
              <td className="py-2 px-3 text-right font-mono tabular-nums">{m.events}</td>
              <td className="py-2 px-3">
                {m.coincide ? (
                  <span className="font-mono text-[10px] text-ok tracking-[0.04em] uppercase">✓ ok</span>
                ) : (
                  <span className="font-mono text-[10px] text-accent" title={m.diff ?? ""}>
                    {m.diff ?? "discrepancia"}
                  </span>
                )}
              </td>
            </tr>
          ))}
          <tr className="border-b-2 border-edge bg-paper-sunken font-semibold">
            <td className="py-2.5 px-3 font-mono text-[11px] uppercase tracking-[0.04em]">Total {data.year}</td>
            <td className="py-2.5 px-3 text-right font-mono tabular-nums">{data.totals.gmail}</td>
            <td className="py-2.5 px-3 text-right font-mono tabular-nums">{data.totals.drive}</td>
            <td className="py-2.5 px-3 text-right font-mono tabular-nums">{data.totals.sheet}</td>
            <td className="py-2.5 px-3 text-right font-mono tabular-nums">{data.totals.events}</td>
            <td className="py-2.5 px-3">
              {data.totals.coincide ? (
                <span className="font-mono text-[10px] text-ok tracking-[0.04em] uppercase">✓ ok</span>
              ) : (
                <span className="font-mono text-[10px] text-accent uppercase tracking-[0.04em]">discrepancia</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
