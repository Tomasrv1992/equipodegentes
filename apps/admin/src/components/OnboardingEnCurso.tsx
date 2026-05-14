/**
 * Sección "En onboarding" del home /operacion.
 *
 * Muestra los clientes que están en su PRIMER RUN (first_run_done=false en
 * client_credentials, agente facturacion). Para cada uno calcula desde los
 * datos ya cargados de Matriz:
 *   - meses completados (al menos 1 factura procesada en agent_events)
 *   - meses con run failed reciente (re-disparable)
 *   - último mes terminado
 *   - ETA basado en mes más cargado de la estimación inicial
 *
 * UX: card por cliente con progress bar + botón "Re-disparar mes X" si hay
 * meses sin procesar. Tomás puede ver de un vistazo qué clientes están
 * todavía en onboarding y dónde se atascaron.
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useFirstRunClients } from "../lib/queries";
import type { Cliente, AgentRun, AgentEvent } from "../types";

interface FacturaPayload {
  fecha?: string;
  total?: number;
}

interface Props {
  clientes: Cliente[];
  runs: AgentRun[];
  facturas: AgentEvent[];
}

const MES_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
] as const;

export default function OnboardingEnCurso({ clientes, runs, facturas }: Props) {
  const { data: firstRunCreds, isLoading } = useFirstRunClients();

  if (isLoading) {
    return (
      <section className="mb-9">
        <h2 className="section-title mb-3">Clientes en onboarding</h2>
        <p className="font-mono text-[11px] text-ink-3 tracking-[0.04em]">
          Cargando…
        </p>
      </section>
    );
  }

  // Filtrar a clientes de facturación con first_run_done=false que existen
  // en clientes (puede haber huérfanos si se borró el cliente)
  const credsFact = (firstRunCreds ?? []).filter((c) => c.agente_id === "facturacion");
  if (credsFact.length === 0) return null;

  const clientesMap = new Map(clientes.map((c) => [c.id, c]));
  const filas = credsFact
    .map((cred) => {
      const cliente = clientesMap.get(cred.cliente_id);
      if (!cliente) return null;
      return { cred, cliente };
    })
    .filter((x): x is { cred: typeof credsFact[0]; cliente: Cliente } => !!x)
    // Ordenar por onboarded_at desc — los más recientes arriba
    .sort((a, b) => {
      const ta = a.cred.onboarded_at ? new Date(a.cred.onboarded_at).getTime() : 0;
      const tb = b.cred.onboarded_at ? new Date(b.cred.onboarded_at).getTime() : 0;
      return tb - ta;
    });

  if (filas.length === 0) return null;

  return (
    <section className="mb-9">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="section-title">
          En onboarding · {filas.length} cliente{filas.length === 1 ? "" : "s"}
        </h2>
        <span className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase">
          first_run_done=false
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {filas.map(({ cred, cliente }) => (
          <OnboardingCard
            key={cliente.id}
            cliente={cliente}
            credOnboardedAt={cred.onboarded_at}
            sheetId={cred.sheet_id}
            driveId={cred.drive_folder_id}
            runs={runs}
            facturas={facturas}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  cliente: Cliente;
  credOnboardedAt: string | null;
  sheetId: string | null;
  driveId: string | null;
  runs: AgentRun[];
  facturas: AgentEvent[];
}

function OnboardingCard({
  cliente,
  credOnboardedAt,
  sheetId,
  driveId,
  runs,
  facturas,
}: CardProps) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const year = now.getFullYear();

  // Meses con al menos 1 factura procesada este año
  const facturasCliente = facturas.filter((f) => f.cliente_id === cliente.id);
  const mesesConFacturas = new Set<number>();
  const facturasPorMes = new Map<number, number>();
  for (const f of facturasCliente) {
    const fecha = (f.payload as FacturaPayload | null)?.fecha;
    if (!fecha || !fecha.startsWith(`${year}-`)) continue;
    const mes = parseInt(fecha.slice(5, 7), 10);
    if (!Number.isFinite(mes)) continue;
    mesesConFacturas.add(mes);
    facturasPorMes.set(mes, (facturasPorMes.get(mes) ?? 0) + 1);
  }

  // Meses con run reciente (últimos 7d) — para detectar "en curso" vs "stale"
  const cutoffMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const runsCliente = runs.filter(
    (r) => r.cliente_id === cliente.id && r.agente_id === "facturacion",
  );
  const mesesConRunReciente = new Set<number>();
  const mesesConRunFailed = new Set<number>();
  for (const r of runsCliente) {
    const startedMs = new Date(r.started_at).getTime();
    if (startedMs < cutoffMs) continue;
    // El monthFilter está en payload.monthFilter o se infiere del triggered_by
    const payloadMonth = (r.payload as any)?.monthFilter as number | undefined;
    if (!payloadMonth) continue;
    mesesConRunReciente.add(payloadMonth);
    if (r.status === "fail") mesesConRunFailed.add(payloadMonth);
  }

  // Meses esperados (1..currentMonth)
  const mesesEsperados = currentMonth;
  const mesesCompletados = mesesConFacturas.size;
  const pctCompletado = Math.round((mesesCompletados / mesesEsperados) * 100);

  // Meses pendientes (no completados todavía)
  const mesesPendientes: number[] = [];
  for (let m = 1; m <= currentMonth; m++) {
    if (!mesesConFacturas.has(m)) mesesPendientes.push(m);
  }

  // Meses que parecen estancados: pendiente Y no tiene run reciente
  // (o lo tiene y falló). Esos son los candidatos a "Re-disparar".
  const mesesEstancados = mesesPendientes.filter(
    (m) => !mesesConRunReciente.has(m) || mesesConRunFailed.has(m),
  );

  // ETA: si onboarded_at < 30 min y todavía hay meses pendientes, está en curso normal.
  // Si onboarded_at > 1h y todavía hay >50% pendiente, probablemente atascado.
  const onboardedMs = credOnboardedAt ? new Date(credOnboardedAt).getTime() : null;
  const elapsedMin = onboardedMs ? Math.round((now.getTime() - onboardedMs) / 60_000) : null;
  const estaAtascado =
    elapsedMin !== null && elapsedMin > 60 && pctCompletado < 50;

  const totalFacturasProcesadas = facturasCliente.filter((f) => {
    const fecha = (f.payload as FacturaPayload | null)?.fecha;
    return fecha?.startsWith(`${year}-`);
  }).length;

  return (
    <div className={`card ${estaAtascado ? "border-fail/40" : ""}`}>
      {/* Header: nombre + estado */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <Link
            to={`/cliente/${cliente.slug}`}
            className="font-display text-lg font-semibold tracking-tighter text-ink hover:text-accent"
          >
            {cliente.nombre}
          </Link>
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase mt-0.5">
            {credOnboardedAt
              ? `Onboard hace ${formatElapsed(elapsedMin)}`
              : "Sin fecha onboard"}
          </div>
        </div>
        <StatusBadge atascado={estaAtascado} pct={pctCompletado} />
      </div>

      {/* Progress bar + cifras */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase">
            {mesesCompletados} / {mesesEsperados} meses · {totalFacturasProcesadas} facturas
          </span>
          <span className="font-mono text-[11px] tabular-nums text-ink-2">
            {pctCompletado}%
          </span>
        </div>
        <div className="w-full h-1.5 bg-paper-sunken rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${estaAtascado ? "bg-fail" : "bg-ok"}`}
            style={{ width: `${Math.min(100, pctCompletado)}%` }}
          />
        </div>
      </div>

      {/* Meses individuales: chip por mes con estado */}
      <div className="mb-3">
        <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-1.5">
          Estado por mes
        </div>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: currentMonth }, (_, i) => i + 1).map((m) => {
            const done = mesesConFacturas.has(m);
            const failed = mesesConRunFailed.has(m);
            const running = !done && mesesConRunReciente.has(m) && !failed;
            const count = facturasPorMes.get(m) ?? 0;
            return (
              <div
                key={m}
                className={`px-2 py-0.5 rounded text-[10px] font-mono tracking-[0.04em] ${
                  done
                    ? "bg-ok-soft text-ok"
                    : failed
                      ? "bg-fail-soft text-fail"
                      : running
                        ? "bg-accent-soft text-accent"
                        : "bg-paper-sunken text-ink-3"
                }`}
                title={
                  done
                    ? `${MES_NAMES[m - 1]}: ${count} facturas`
                    : failed
                      ? `${MES_NAMES[m - 1]}: run falló`
                      : running
                        ? `${MES_NAMES[m - 1]}: procesando`
                        : `${MES_NAMES[m - 1]}: sin procesar`
                }
              >
                {MES_NAMES[m - 1]}
                {done && count > 0 && (
                  <span className="ml-1 opacity-60 tabular-nums">{count}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Acciones: re-disparar meses estancados */}
      {mesesEstancados.length > 0 && (
        <ReDispararPanel
          clienteSlug={cliente.slug}
          mesesEstancados={mesesEstancados}
        />
      )}

      {/* Footer: links */}
      <div className="flex gap-3 mt-3 pt-3 border-t border-edge-2">
        {sheetId && (
          <a
            href={`https://docs.google.com/spreadsheets/d/${sheetId}/edit`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] text-accent hover:underline tracking-[0.04em]"
          >
            Sheet ↗
          </a>
        )}
        {driveId && (
          <a
            href={`https://drive.google.com/drive/folders/${driveId}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] text-accent hover:underline tracking-[0.04em]"
          >
            Drive ↗
          </a>
        )}
      </div>
    </div>
  );
}

function StatusBadge({
  atascado,
  pct,
}: {
  atascado: boolean;
  pct: number;
}) {
  if (atascado) {
    return (
      <span className="font-mono text-[10px] tracking-[0.06em] uppercase bg-fail-soft text-fail px-2 py-0.5 rounded">
        Atascado
      </span>
    );
  }
  if (pct >= 100) {
    return (
      <span className="font-mono text-[10px] tracking-[0.06em] uppercase bg-ok-soft text-ok px-2 py-0.5 rounded">
        Listo
      </span>
    );
  }
  return (
    <span className="font-mono text-[10px] tracking-[0.06em] uppercase bg-accent-soft text-accent px-2 py-0.5 rounded">
      En curso
    </span>
  );
}

function ReDispararPanel({
  clienteSlug,
  mesesEstancados,
}: {
  clienteSlug: string;
  mesesEstancados: number[];
}) {
  const [mesSel, setMesSel] = useState<number>(mesesEstancados[0]);
  const queryClient = useQueryClient();

  const mut = useMutation({
    mutationFn: async () => {
      const { data: sess } = await supabase.auth.getSession();
      const accessToken = sess.session?.access_token;
      const resp = await fetch("/api/admin/onboarding-rerun-month", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ clienteSlug, monthFilter: mesSel }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      return resp.json();
    },
    onSuccess: () => {
      // Refetch los datos del onboarding para reflejar el dispatch
      queryClient.invalidateQueries({ queryKey: ["first-run-clients"] });
      queryClient.invalidateQueries({ queryKey: ["latest-runs"] });
    },
  });

  return (
    <div className="bg-paper-sunken rounded-md p-2.5 mb-2">
      <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-1.5">
        Re-disparar mes estancado
      </div>
      <div className="flex items-center gap-2">
        <select
          value={mesSel}
          onChange={(e) => setMesSel(Number(e.target.value))}
          className="input input-sm font-mono text-[11px] py-1 px-2 h-7"
          disabled={mut.isPending}
        >
          {mesesEstancados.map((m) => (
            <option key={m} value={m}>
              {MES_NAMES[m - 1]}
            </option>
          ))}
        </select>
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
          className="btn-accent text-[11px] py-1 px-2.5 h-7 disabled:opacity-50"
        >
          {mut.isPending ? "…" : "Re-disparar"}
        </button>
        {mut.isSuccess && (
          <span className="font-mono text-[10px] text-ok tracking-[0.04em]">
            ✓ disparado
          </span>
        )}
        {mut.isError && (
          <span
            className="font-mono text-[10px] text-fail tracking-[0.04em]"
            title={(mut.error as Error).message}
          >
            ⚠ falló
          </span>
        )}
      </div>
    </div>
  );
}

function formatElapsed(minutes: number | null): string {
  if (minutes == null) return "—";
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const horas = Math.floor(minutes / 60);
  if (horas < 24) {
    const remMin = minutes % 60;
    return remMin > 0 ? `${horas}h ${remMin}m` : `${horas}h`;
  }
  const dias = Math.floor(horas / 24);
  return `${dias}d`;
}
