/**
 * /agentes — Catálogo jerárquico.
 *
 * Estructura nueva:
 *   - Nivel 1: EQUIPOS (Equipo Facturación)
 *     - Nivel 2: agentes internos del equipo (Monitor, Reparador, Limpiador, Supervisor)
 *
 * Cada equipo agrega métricas (procesadas mes, all-time, clientes, errores 7d).
 * Cada agente interno se puede clickear y abre su /agente/:id con detalle.
 */

import { Link } from "react-router-dom";
import { useAgentes, useLatestRuns, useClientAgents, useAllFacturas } from "../lib/queries";
import {
  totalFacturas,
  facturasThisMonth,
  runsLastDays,
  totalErrores,
  tiempoAhorradoHoras,
  formatHoras,
} from "../lib/metrics";

// Definición de la jerarquía. Si un agente no aparece acá, se muestra "standalone".
// Slugs de agentes que NO se muestran en "Otros agentes" porque están
// inactivos o no son parte del producto actual.
// Equipo-limpiador, Equipo-monitor, Equipo-reparador: fusionados en
// Equipo-archivero — no se muestran 2026-05-19.
const AGENTES_OCULTOS = new Set(["cartera", "limpiador", "monitor", "reparador"]);

const EQUIPOS: Array<{
  id: string;
  categoria: string;
  agenteNombre: string;
  descripcion: string;
  agentePrincipal: string;
  agentesInternos: Array<{ id: string; nombre: string; rol: string; hora: string }>;
}> = [
  {
    id: "equipo-facturacion",
    categoria: "Equipo Facturación",
    agenteNombre: "Procesador facturas de compra",
    descripcion:
      "Pipeline automático de cuentas por pagar: lee Gmail, identifica facturas DIAN y no-DIAN, organiza en Drive y registra en Sheet. Los 4 agentes administrativos validan y reparan el resultado.",
    agentePrincipal: "facturacion",
    agentesInternos: [
      { id: "inspector", nombre: "Inspector", rol: "Observa runs y cierra zombies", hora: "08:00" },
      { id: "archivero", nombre: "Archivero", rol: "Auto-repara filas + recupera huérfanos (LLM) + cleanup dups", hora: "08:15" },
      { id: "supervisor", nombre: "Supervisor", rol: "Valida resultado final y retriggea", hora: "08:45" },
    ],
  },
];

export default function AgentesList() {
  const { data: agentes, isLoading: la } = useAgentes();
  const { data: runs, isLoading: lr } = useLatestRuns();
  const { data: activaciones, isLoading: lac } = useClientAgents();
  const { data: facturas, isLoading: lf } = useAllFacturas();

  if (la || lr || lac || lf) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }
  if (!agentes || !runs || !activaciones || !facturas) return null;

  const ahora = new Date();
  const mesActualLabel = ahora.toLocaleDateString("es-CO", { month: "long", year: "numeric" });

  // IDs de agentes que están agrupados dentro de equipos (los excluimos de "standalone")
  const idsAgrupados = new Set<string>();
  for (const e of EQUIPOS) {
    idsAgrupados.add(e.agentePrincipal);
    e.agentesInternos.forEach((a) => idsAgrupados.add(a.id));
  }

  // Standalone: agentes que existen en DB pero no están listados en ningún equipo
  // ni en AGENTES_OCULTOS (inactivos, en desarrollo)
  const standalone = agentes.filter((a) => !idsAgrupados.has(a.id) && !AGENTES_OCULTOS.has(a.id));

  return (
    <div>
      <div className="border-b border-edge pb-7 mb-9">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
          Catálogo
        </div>
        <h1 className="font-display text-5xl font-medium tracking-tightest text-ink leading-none mb-3">
          Agentes
        </h1>
        <p className="font-sans text-sm text-ink-3 max-w-[640px] leading-relaxed">
          Equipos de agentes que operan automáticamente. Cada equipo tiene un agente
          principal y agentes internos que lo asisten. Click para ver métricas y runs.
        </p>
      </div>

      {/* Equipos */}
      {EQUIPOS.map((eq) => {
        const principal = agentes.find((a) => a.id === eq.agentePrincipal);
        if (!principal) return null;
        const runsAg = runs.filter((r) => r.agente_id === principal.id);
        // Facturas únicas por fecha REAL (agent_events) — fuente de verdad.
        // No usar agent_runs porque multi-pass + retriggers inflan los contadores.
        const facturasAg = facturas.filter((ev) => ev.agente_id === principal.id);
        const proc = totalFacturas(facturasThisMonth(facturasAg));
        const allTime = totalFacturas(facturasAg);
        const horasMes = tiempoAhorradoHoras(proc);
        const errores7d = totalErrores(runsLastDays(runsAg, 7));
        const clientesQ = new Set(
          activaciones
            .filter((act) => act.agente_id === principal.id && act.activo)
            .map((act) => act.cliente_id),
        ).size;

        return (
          <section key={eq.id} className="mb-10">
            {/* Card del agente principal — mismo layout visual que /diagnostico */}
            <Link
              to={`/agente/${principal.id}`}
              className="card card-hover no-underline text-ink block mb-3"
            >
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-accent font-medium mb-2">
                {eq.categoria}
              </div>
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-start gap-3">
                  <div className="text-2xl">📥</div>
                  <div>
                    <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-1">
                      07:00 · agente principal
                    </div>
                    <h2 className="font-display text-xl font-semibold tracking-tighter text-ink m-0">
                      {eq.agenteNombre}
                    </h2>
                    <p className="text-xs text-ink-3 mt-1.5 leading-relaxed max-w-[760px]">
                      {eq.descripcion}
                    </p>
                  </div>
                </div>
                {!principal.activo && <span className="pill pill-off">Inactivo</span>}
              </div>

              <div className="grid grid-cols-4 gap-3 pt-3 border-t border-edge-2">
                <BigStat
                  label={mesActualLabel}
                  value={proc}
                  sub="facturas · mes en curso"
                />
                <BigStat
                  label="Histórico total"
                  value={allTime}
                  sub="facturas · desde inicio"
                />
                <BigStat
                  label="Horas ahorradas"
                  value={formatHoras(horasMes)}
                  sub="mes en curso"
                />
                <BigStat
                  label="Clientes activos"
                  value={clientesQ}
                  sub={errores7d > 0 ? `${errores7d} err 7d · revisar` : "con agente activado"}
                  alert={errores7d > 0}
                />
              </div>
            </Link>

            {/* Agentes internos del equipo */}
            <div className="ml-6 pl-4 border-l-2 border-edge-2">
              <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-2">
                Agentes administrativos · validan y reparan el resultado del procesador
              </div>
              <div className="grid grid-cols-4 gap-2">
                {eq.agentesInternos.map((sub) => {
                  const agDb = agentes.find((a) => a.id === sub.id);
                  const runsSub = runs.filter((r) => r.agente_id === sub.id);
                  const lastRun = runsSub[0];
                  const errores = totalErrores(runsLastDays(runsSub, 7));
                  return (
                    <Link
                      key={sub.id}
                      to={`/agente/${sub.id}`}
                      className="card card-hover no-underline text-ink p-3"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <div className="font-mono text-[9px] text-ink-3 tracking-[0.06em] uppercase">
                            {sub.hora}
                          </div>
                          <div className="font-display text-sm font-semibold tracking-tighter">
                            {sub.nombre}
                          </div>
                        </div>
                        {lastRun ? (
                          <span className={`pill ${pillClass(lastRun.status)}`}>
                            {lastRun.status.toUpperCase()}
                          </span>
                        ) : (
                          <span className="font-mono text-[9px] text-ink-4 uppercase">—</span>
                        )}
                      </div>
                      <div className="text-[10px] text-ink-3 leading-tight mb-2">
                        {sub.rol}
                      </div>
                      <div className="flex items-center justify-between font-mono text-[9px]">
                        <span className="text-ink-4">{runsSub.length} runs</span>
                        {errores > 0 ? (
                          <span className="text-accent">{errores} err 7d</span>
                        ) : (
                          <span className="text-ink-4">{agDb?.activo ? "activo" : "inactivo"}</span>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}

      {/* Standalone (agentes sin equipo) */}
      {standalone.length > 0 && (
        <section className="mt-12 pt-8 border-t border-edge">
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-3">
            Otros agentes
          </div>
          <div className="grid grid-cols-2 gap-3">
            {standalone.map((a) => {
              const runsAg = runs.filter((r) => r.agente_id === a.id);
              const facturasAg = facturas.filter((ev) => ev.agente_id === a.id);
              const proc = totalFacturas(facturasThisMonth(facturasAg));
              const allTime = totalFacturas(facturasAg);
              const errores7d = totalErrores(runsLastDays(runsAg, 7));
              return (
                <Link key={a.id} to={`/agente/${a.id}`} className="card card-hover no-underline text-ink">
                  <h3 className="font-display text-lg font-semibold tracking-tighter mb-2">
                    {a.nombre}
                  </h3>
                  {a.descripcion && (
                    <p className="text-xs text-ink-3 mb-3 leading-relaxed">{a.descripcion}</p>
                  )}
                  <div className="grid grid-cols-3 gap-3 pt-3 border-t border-edge-2">
                    <Stat label={mesActualLabel} value={proc} unit="facturas" sublabel="mes en curso" />
                    <Stat label="Histórico total" value={allTime} unit="facturas" sublabel="desde inicio" />
                    <Stat
                      label="Errores 7d"
                      value={errores7d}
                      unit=""
                      alert={errores7d > 0}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function pillClass(status: string): string {
  if (status === "ok") return "pill-ok";
  if (status === "warn") return "pill-warn";
  if (status === "fail") return "pill-fail";
  if (status === "running") return "pill-running";
  return "pill-off";
}

function BigStat({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: number | string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div>
      <div className="label-tight text-ink-3 mb-1">{label}</div>
      <div
        className={`font-display text-2xl font-medium tracking-[-0.02em] tabular-nums leading-none mb-1 ${alert ? "text-accent" : "text-ink"}`}
      >
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[9px] text-ink-4 tracking-[0.04em] uppercase">{sub}</div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  alert,
  sublabel,
}: {
  label: string;
  value: number | string;
  unit?: string;
  alert?: boolean;
  sublabel?: string;
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
      {sublabel && (
        <div className="font-mono text-[8px] text-ink-4 tracking-[0.04em] uppercase mt-0.5">
          {sublabel}
        </div>
      )}
    </div>
  );
}
