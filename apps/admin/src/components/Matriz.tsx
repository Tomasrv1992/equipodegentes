import { useClientes, useAgentes, useLatestRuns, useClientAgents } from "../lib/queries";
import {
  totalProcesadas,
  runsThisMonth,
  runsToday,
  runsLastDays,
  totalErrores,
  tiempoAhorradoHoras,
  formatHoras,
} from "../lib/metrics";
import Hero from "./Hero";
import Kpis from "./Kpis";
import ClientCard from "./ClientCard";
import EmptyState from "./EmptyState";

export default function Matriz() {
  const { data: clientes, isLoading: lc } = useClientes();
  const { data: agentes, isLoading: la } = useAgentes();
  const { data: runs, isLoading: lr } = useLatestRuns();
  const { data: activaciones, isLoading: lac } = useClientAgents();

  if (lc || la || lr || lac) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }
  if (!clientes || !agentes || !runs || !activaciones) return null;

  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));
  const clienteById = Object.fromEntries(clientes.map((c) => [c.id, c]));

  // Solo activaciones activas
  const actsActivas = activaciones.filter((a) => a.activo);

  // KPIs globales
  const facturasMes = totalProcesadas(runsThisMonth(runs));
  const horasAhorradasMes = tiempoAhorradoHoras(facturasMes);
  const runsHoyN = runsToday(runs).length;
  const errores7d = totalErrores(runsLastDays(runs, 7));
  const lastFailRuns = runs
    .filter((r) => r.status === "fail")
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
  const lastFail = lastFailRuns[0];
  const lastFailWhen = lastFail ? timeAgo(lastFail.started_at) : null;

  // Status global del hero
  const heroStatus: "ok" | "warn" | "fail" = lastFail && new Date(lastFail.started_at).getTime() > Date.now() - 24 * 60 * 60 * 1000
    ? "fail"
    : "ok";

  // Próximo cron (asumimos cron 7am Bogota; si ya pasó hoy, mañana)
  const proxCron = nextCronAt(7);

  // Contar agentes únicos activados
  const agentesActivados = new Set(actsActivas.map((a) => a.agente_id)).size;

  const heroEyebrow = heroStatus === "ok"
    ? `Todo en orden · ${formatDateTitle(new Date())}`
    : `Atención · ${formatDateTitle(new Date())}`;

  const heroTitle = clientes.length === 0 ? (
    <>Sin clientes <em className="italic font-normal text-ink-2">aún.</em></>
  ) : (
    <>
      {clientes.length} {clientes.length === 1 ? "cliente" : "clientes"},
      <br />
      <em className="italic font-normal text-ink-2">
        {heroStatus === "ok" ? "operación normal." : "revisar runs."}
      </em>
    </>
  );

  const lastRunGlobal = runs[0];
  const heroDeck = lastRunGlobal ? (
    <>
      Último run <span className="font-mono text-ink-2">{timeAgo(lastRunGlobal.started_at)}</span>.
      Próximo cron mañana <span className="font-mono text-ink-2">{proxCron}</span> Bogotá.
      {agentesActivados === 1 ? " Un agente activo: Equipo-facturación." : ` ${agentesActivados} agentes activos.`}
    </>
  ) : null;

  return (
    <div>
      <Hero
        eyebrow={heroEyebrow}
        eyebrowDot={heroStatus}
        title={heroTitle}
        deck={heroDeck}
        statValue={facturasMes}
        statLabel={
          <>
            facturas procesadas <span className="text-ink-4">· este mes</span>
          </>
        }
      />

      <Kpis
        items={[
          {
            label: "Runs hoy",
            value: runsHoyN,
            meta: runsHoyN > 0 ? <>último: <span className="text-ok">{lastRunGlobal ? timeAgo(lastRunGlobal.started_at) : ""}</span></> : "esperando primer cron",
          },
          {
            label: "Errores 7d",
            value: errores7d,
            alert: errores7d > 0,
            meta: lastFailWhen ? `último: ${lastFailWhen}` : "ninguno",
          },
          {
            label: "Procesadas mes",
            value: facturasMes,
            unit: "facturas",
            meta: facturasMes > 0 ? <>≈ {formatHoras(horasAhorradasMes)} ahorradas</> : "—",
          },
          {
            label: "Tiempo ahorrado",
            value: formatHoras(horasAhorradasMes).replace("h", ""),
            unit: formatHoras(horasAhorradasMes).endsWith("h") ? "h" : "min",
            meta: "≈ 24 min · factura",
          },
        ]}
      />

      <div className="flex items-baseline justify-between mb-4">
        <h2 className="section-title">Clientes en operación</h2>
        <span className="section-meta">
          {actsActivas.length === 0
            ? "ninguno activado"
            : `${actsActivas.length} activación${actsActivas.length === 1 ? "" : "es"} · ordenado por última actividad`}
        </span>
      </div>

      {clientes.length === 0 ? (
        <EmptyState
          title="Sin clientes todavía"
          description="Cuando crees un cliente y actives Equipo-facturación, aparecerán acá con su timeline operacional."
          cta={{ label: "Crear primer cliente", to: "/nuevo-cliente" }}
        />
      ) : actsActivas.length === 0 ? (
        <EmptyState
          title="Sin agentes activados"
          description="Tenés clientes pero ninguno tiene un agente activado todavía. Editá un cliente para activar Equipo-facturación."
          cta={null}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {actsActivas.map((act) => {
            const cliente = clienteById[act.cliente_id];
            if (!cliente) return null;
            const agente = agenteById[act.agente_id];
            const runsCA = runs.filter(
              (r) => r.cliente_id === cliente.id && r.agente_id === act.agente_id,
            );
            return (
              <ClientCard
                key={`${act.cliente_id}-${act.agente_id}`}
                cliente={cliente}
                activacion={act}
                agente={agente}
                runs={runsCA}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

function formatDateTitle(d: Date): string {
  const day = d.toLocaleDateString("es-CO", { day: "2-digit" });
  const mon = d.toLocaleDateString("es-CO", { month: "short" }).replace(".", "");
  const yr = d.getFullYear().toString().slice(-2);
  return `${day}.${mon}.${yr}`;
}

function nextCronAt(hour: number): string {
  const now = new Date();
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (now.getTime() >= next.getTime()) {
    // ya pasó hoy → mañana
  }
  return next.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Bogota",
  });
}
