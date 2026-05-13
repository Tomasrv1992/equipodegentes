/**
 * Panel LIVE de progreso del onboarding/primer-run de un cliente.
 *
 * Aparece automáticamente en /cliente/:slug si:
 *   - first_run_done = false (todavía no terminó)
 *   - O hay runs de facturación en los últimos 30 min
 *
 * Refresca cada 10s para mostrar el avance del multi-pass (12 invocaciones,
 * una por mes Ene-Dic).
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

const MES_LABELS = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

interface RunData {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  payload: any;
  summary: string | null;
}

interface CredentialsData {
  google_oauth_status: string | null;
  onboarded_at: string | null;
  first_run_done: boolean;
  nit_cliente: string | null;
  sheet_id: string | null;
  drive_folder_id: string | null;
}

export default function OnboardingProgress({ clienteId }: { clienteId: string }) {
  // 1. Credentials del cliente (oauth + first_run_done)
  const creds = useQuery({
    queryKey: ["onboarding-creds", clienteId],
    refetchInterval: 10_000,
    queryFn: async (): Promise<CredentialsData | null> => {
      const { data } = await supabase
        .from("client_credentials")
        .select("google_oauth_status, onboarded_at, first_run_done, nit_cliente, sheet_id, drive_folder_id")
        .eq("cliente_id", clienteId)
        .eq("agente_id", "facturacion")
        .maybeSingle();
      return data as CredentialsData | null;
    },
  });

  // 2. Runs de facturación recientes
  const runs = useQuery({
    queryKey: ["onboarding-runs", clienteId],
    refetchInterval: 10_000,
    queryFn: async (): Promise<RunData[]> => {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("agent_runs")
        .select("id, status, started_at, finished_at, duration_ms, triggered_by, payload, summary")
        .eq("cliente_id", clienteId)
        .eq("agente_id", "facturacion")
        .gte("started_at", since)
        .order("started_at", { ascending: false });
      return (data ?? []) as RunData[];
    },
  });

  // 3. Conteo de events por mes
  const eventsByMonth = useQuery({
    queryKey: ["onboarding-events-month", clienteId],
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("agent_events")
        .select("payload")
        .eq("cliente_id", clienteId)
        .eq("agente_id", "facturacion")
        .eq("tipo", "factura_procesada");
      const byMonth = new Array(12).fill(0);
      for (const ev of data ?? []) {
        const fecha = (ev.payload as any)?.fecha;
        if (!fecha) continue;
        const m = parseInt(String(fecha).slice(5, 7), 10);
        if (m >= 1 && m <= 12) byMonth[m - 1]++;
      }
      return byMonth;
    },
  });

  if (creds.isLoading) return null;

  const c = creds.data;
  const allRuns = runs.data ?? [];
  const eventsCount = eventsByMonth.data ?? new Array(12).fill(0);

  // Lógica para decidir si mostrar el panel:
  // - Si no hay credentials → cliente recién creado, mostrar wizard
  // - Si first_run_done = false → todavía en proceso
  // - Si hay runs en últimos 30 min → algo en marcha (incluso después de first_run_done)
  const recentRuns = allRuns.filter(
    (r) => Date.now() - new Date(r.started_at).getTime() < 30 * 60 * 1000,
  );
  const hayActividadReciente = recentRuns.length > 0;
  const firstRunPending = !c || !c.first_run_done;

  if (!firstRunPending && !hayActividadReciente) return null; // no mostrar

  // Stages del wizard
  const oauthDone = c?.google_oauth_status === "connected";
  const fiscalDone = !!c?.nit_cliente;
  const recursosCreados = !!(c?.sheet_id && c?.drive_folder_id);
  const primerRunOk = !!c?.first_run_done;

  // Stats del primer-run
  const runsOk = allRuns.filter((r) => r.status === "ok").length;
  const runsRunning = allRuns.filter((r) => r.status === "running").length;
  const runsFail = allRuns.filter((r) => r.status === "fail").length;
  const totalProcesadas = allRuns.reduce(
    (s, r) => s + Number(r.payload?.procesadas ?? 0),
    0,
  );
  const totalRepetidas = allRuns.reduce(
    (s, r) => s + Number(r.payload?.repetidas ?? 0),
    0,
  );
  const totalSaltadas = allRuns.reduce(
    (s, r) => s + Number(r.payload?.saltadas ?? 0),
    0,
  );
  const totalErrores = allRuns.reduce(
    (s, r) => s + Number(r.payload?.errores ?? 0),
    0,
  );

  // Última actividad
  const ultimoRun = allRuns[0];
  const ultimoTimestamp = ultimoRun?.started_at;
  const segDesdeUltimo = ultimoTimestamp
    ? Math.round((Date.now() - new Date(ultimoTimestamp).getTime()) / 1000)
    : null;

  // Detectar meses procesados (multi-pass dispara 12 runs con monthFilter)
  const mesesProcesados = new Set<number>();
  for (const r of allRuns) {
    const mes = Number(r.payload?.monthFilter ?? r.payload?.mes);
    if (mes >= 1 && mes <= 12 && (r.status === "ok" || r.status === "warn")) {
      mesesProcesados.add(mes);
    }
  }
  // Fallback: si no hay monthFilter, contar OK runs
  const mesesProgreso = mesesProcesados.size > 0 ? mesesProcesados.size : runsOk;
  const progresoPct = Math.min(100, Math.round((mesesProgreso / 12) * 100));

  return (
    <section className="mb-6 card border-l-4 border-l-accent">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-accent font-medium mb-1">
            ⚡ Onboarding en progreso · live
          </div>
          <h2 className="font-display text-xl font-semibold tracking-tighter">
            {primerRunOk ? "Primer-run completado · monitoreando" : `Procesando histórico 2026 · ${progresoPct}%`}
          </h2>
          {segDesdeUltimo !== null && (
            <div className="font-mono text-[10px] text-ink-3 tracking-[0.04em] mt-1">
              Última actividad: hace {formatSeg(segDesdeUltimo)} · refresca cada 10s
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          <span className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">live</span>
        </div>
      </div>

      {/* Wizard stages */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <StageBox label="OAuth" done={oauthDone} />
        <StageBox label="Datos fiscales" done={fiscalDone} />
        <StageBox label="Sheet + Drive" done={recursosCreados} />
        <StageBox label="Primer run" done={primerRunOk} active={!primerRunOk && oauthDone} />
      </div>

      {/* Progreso multi-pass */}
      {(runsRunning > 0 || allRuns.length > 0) && (
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-2">
            <div className="label-tight text-ink-3">Multi-pass · 12 meses</div>
            <div className="font-mono text-[11px] text-ink-3 tabular-nums">
              {mesesProgreso}/12 completados · {runsRunning} corriendo · {runsFail} fail
            </div>
          </div>
          <div className="w-full h-2 bg-paper-sunken rounded-full overflow-hidden mb-2">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${progresoPct}%` }}
            />
          </div>
          {/* Grid de meses */}
          <div className="grid grid-cols-12 gap-1">
            {MES_LABELS.map((mes, i) => {
              const procesado = mesesProcesados.has(i + 1) || (i < runsOk);
              const count = eventsCount[i] ?? 0;
              return (
                <div
                  key={mes}
                  className={`text-center py-1 px-0.5 rounded text-[10px] font-mono ${
                    procesado
                      ? "bg-ok/15 text-ok font-medium"
                      : "bg-paper-sunken text-ink-4"
                  }`}
                  title={`${mes}: ${count} facturas`}
                >
                  <div className="uppercase tracking-tight">{mes}</div>
                  <div className="font-display text-[11px] tabular-nums">{count}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stats agregadas */}
      <div className="grid grid-cols-4 gap-2 pt-3 border-t border-edge-2">
        <StatCell label="Procesadas" value={totalProcesadas} accent="ok" />
        <StatCell label="Repetidas" value={totalRepetidas} accent="muted" />
        <StatCell label="Saltadas" value={totalSaltadas} accent="muted" />
        <StatCell label="Errores" value={totalErrores} accent={totalErrores > 0 ? "warn" : "muted"} />
      </div>

      {/* Último run summary */}
      {ultimoRun?.summary && (
        <div className="mt-3 pt-3 border-t border-edge-2 font-mono text-[11px] text-ink-3 leading-relaxed">
          <span className="text-ink-4 uppercase tracking-[0.06em] text-[9px]">Último run · </span>
          {ultimoRun.summary}
        </div>
      )}
    </section>
  );
}

function StageBox({
  label,
  done,
  active,
}: {
  label: string;
  done: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={`px-3 py-2 rounded-md border text-center ${
        done
          ? "bg-ok/10 border-ok/30 text-ok"
          : active
            ? "bg-accent/10 border-accent/30 text-accent animate-pulse"
            : "bg-paper-sunken border-edge text-ink-4"
      }`}
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.06em] mb-0.5">
        {done ? "✓" : active ? "⚡" : "○"}
      </div>
      <div className="font-mono text-[10px]">{label}</div>
    </div>
  );
}

function StatCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "ok" | "warn" | "muted";
}) {
  const color = value === 0
    ? "text-ink-4"
    : accent === "ok"
      ? "text-ok"
      : accent === "warn"
        ? "text-accent"
        : "text-ink-3";
  return (
    <div>
      <div className="font-mono text-[9px] text-ink-3 tracking-[0.06em] uppercase mb-0.5">
        {label}
      </div>
      <div className={`font-display text-xl font-medium tracking-tight tabular-nums ${color}`}>
        {value.toLocaleString("es-CO")}
      </div>
    </div>
  );
}

function formatSeg(seg: number): string {
  if (seg < 60) return `${seg}s`;
  if (seg < 3600) return `${Math.floor(seg / 60)}m ${seg % 60}s`;
  return `${Math.floor(seg / 3600)}h ${Math.floor((seg % 3600) / 60)}m`;
}
