import { useState } from "react";
import { Link } from "react-router-dom";
import { useRun, useClientes, useAgentes, useRunsByClienteAgente } from "../lib/queries";
import { classifyError } from "../lib/classify-error";
import { supabase } from "../lib/supabase";
import Pill from "./Pill";
import type { RunPayloadFacturacion } from "../lib/metrics";

export default function RunDetail({ runId }: { runId: string }) {
  const { data: run, isLoading } = useRun(runId);
  const { data: clientes } = useClientes();
  const { data: agentes } = useAgentes();

  const [rerunStatus, setRerunStatus] = useState<"idle" | "dispatching" | "ok" | "fail">("idle");
  const [rerunMsg, setRerunMsg] = useState("");

  if (isLoading || !run) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando run…
      </div>
    );
  }

  const cliente = clientes?.find((c) => c.id === run.cliente_id);
  const agente = agentes?.find((a) => a.id === run.agente_id);
  const errCls = run.error_message ? classifyError(run.error_message) : null;
  const payload = run.payload as RunPayloadFacturacion | null;

  async function handleRerun() {
    setRerunStatus("dispatching");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("no session");

      const resp = await fetch("/api/trigger-rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ runId: run!.id }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setRerunStatus("ok");
      setRerunMsg("Disparado. El nuevo run aparecerá en la matriz en ~30s.");
    } catch (err: any) {
      setRerunStatus("fail");
      setRerunMsg(err.message ?? String(err));
    }
  }

  const dur = (run.duration_ms ?? 0) / 1000;
  const startedFmt = new Date(run.started_at).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div>
      {/* Breadcrumbs */}
      <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-3 flex items-center gap-1.5">
        <Link to="/" className="hover:text-ink transition-colors">Operación</Link>
        <span className="text-ink-4">/</span>
        {cliente && (
          <>
            <Link to={`/cliente/${cliente.slug}`} className="hover:text-ink transition-colors">
              {cliente.nombre}
            </Link>
            <span className="text-ink-4">/</span>
          </>
        )}
        {agente && (
          <>
            <Link to={`/agente/${agente.id}`} className="hover:text-ink transition-colors">
              {agente.nombre.replace("Equipo-", "")}
            </Link>
            <span className="text-ink-4">/</span>
          </>
        )}
        <span className="text-ink-2">{startedFmt}</span>
      </div>

      {/* Header */}
      <div className="border-b border-edge pb-6 mb-8">
        <div className="flex items-start gap-4 mb-3">
          <Pill status={run.status} />
          <div className="font-mono text-[11px] text-ink-3 tracking-[0.04em] tabular-nums">
            <span className="text-ink-4">duración</span> {dur.toFixed(1)}s
            <span className="text-ink-4 ml-3">·</span>
            <span className="text-ink-4 ml-3">trigger</span> {run.triggered_by}
            <span className="text-ink-4 ml-3">·</span>
            <span className="text-ink-4 ml-3">id</span> {run.id.slice(0, 8)}
          </div>
        </div>
        <h1 className="font-display text-4xl font-medium tracking-tightest text-ink leading-none mb-1">
          Run · {agente?.nombre ?? run.agente_id}
        </h1>
        {cliente && (
          <p className="font-sans text-sm text-ink-3 mt-2">
            Cliente: <span className="text-ink font-medium">{cliente.nombre}</span>
          </p>
        )}
      </div>

      <div className="grid grid-cols-[1fr_360px] gap-6 mb-8">
        {/* Columna principal: resumen + error */}
        <section className="space-y-6">
          <div className="card">
            <div className="label mb-3">Resumen</div>
            {run.summary ? (
              <p className="text-base text-ink">{run.summary}</p>
            ) : (
              <p className="text-sm text-ink-3">—</p>
            )}
            {payload && (
              <div className="grid grid-cols-3 gap-4 mt-5 pt-5 border-t border-edge-2">
                <PayloadStat label="Procesadas" value={payload.procesadas ?? 0} />
                <PayloadStat label="Errores" value={payload.errores ?? 0} alert={(payload.errores ?? 0) > 0} />
                <PayloadStat label="Saltadas" value={payload.saltadas ?? 0} />
              </div>
            )}
          </div>

          {run.error_message && (
            <div className="card">
              <div className="label mb-3 text-fail">Error</div>
              <pre className="terminal whitespace-pre-wrap mb-4">
                <span className="terminal-label">{run.error_message}</span>
                {run.error_stack && (
                  <>
                    {"\n\n"}
                    <span className="opacity-70">{run.error_stack}</span>
                  </>
                )}
              </pre>
              {errCls && (
                <div className="space-y-3 text-sm">
                  <div className="border-l-2 border-accent pl-4 py-1">
                    <div className="label-tight text-accent mb-1">Causa probable</div>
                    <p className="text-ink leading-relaxed">{errCls.causaProbable}</p>
                  </div>
                  {errCls.fixSugerido && (
                    <div className="border-l-2 border-ok pl-4 py-1">
                      <div className="label-tight text-ok mb-1">Fix sugerido</div>
                      <p className="text-ink leading-relaxed">{errCls.fixSugerido}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Columna lateral: historial + acciones */}
        <aside className="space-y-6">
          <div className="card">
            <div className="label mb-3">Historial reciente</div>
            <Historial
              clienteId={run.cliente_id}
              agenteId={run.agente_id}
              excludeId={run.id}
            />
            {run.netlify_log_url && (
              <a
                href={run.netlify_log_url}
                target="_blank"
                rel="noreferrer"
                className="block mt-4 font-mono text-[11px] text-accent hover:underline tracking-[0.04em]"
              >
                Ver logs Netlify completos →
              </a>
            )}
          </div>
        </aside>
      </div>

      {/* Acciones */}
      <div className="border-t border-edge pt-6">
        <div className="label mb-3">Acciones</div>
        <div className="flex flex-wrap gap-2 items-center">
          <button
            onClick={handleRerun}
            disabled={rerunStatus === "dispatching" || rerunStatus === "ok"}
            className="btn-accent"
          >
            {rerunStatus === "dispatching"
              ? "Disparando…"
              : rerunStatus === "ok"
              ? "Disparado ✓"
              : "Re-disparar run"}
          </button>
          <button
            className="btn-primary opacity-50 cursor-not-allowed"
            disabled
            title="Próximamente"
          >
            Pausar agente p/ este cliente
          </button>
          {run.netlify_log_url && (
            <a
              href={run.netlify_log_url}
              target="_blank"
              rel="noreferrer"
              className="btn-outline"
            >
              Ver logs Netlify
            </a>
          )}
          {rerunMsg && (
            <span className={`font-mono text-[11px] tracking-[0.04em] ${rerunStatus === "fail" ? "text-fail" : "text-ok"}`}>
              {rerunMsg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PayloadStat({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <div>
      <div className="label-tight mb-1">{label}</div>
      <div
        className={`font-display text-2xl font-medium tracking-[-0.02em] tabular-nums ${
          alert ? "text-accent" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Historial({
  clienteId,
  agenteId,
  excludeId,
}: {
  clienteId: string;
  agenteId: string;
  excludeId: string;
}) {
  const { data: runs } = useRunsByClienteAgente(clienteId, agenteId, 6);
  if (!runs) return <p className="text-ink-3 text-xs">Cargando…</p>;
  const filtered = runs.filter((r) => r.id !== excludeId).slice(0, 5);
  if (filtered.length === 0)
    return <p className="text-ink-3 text-xs">Sin historial previo.</p>;

  return (
    <ul className="text-xs space-y-1.5">
      {filtered.map((r) => (
        <li key={r.id} className="flex items-center gap-2 border-b border-edge-2 pb-1.5 last:border-b-0">
          <span className="font-mono text-[10px] text-ink-3 w-14 tracking-[0.04em] tabular-nums">
            {new Date(r.started_at).toLocaleDateString("es-CO", {
              month: "short",
              day: "2-digit",
            }).replace(".", "")}
          </span>
          <Pill status={r.status} />
          <Link
            to={`/run/${r.id}`}
            className="text-ink-3 truncate flex-1 hover:text-ink transition-colors"
          >
            {r.summary ?? r.error_message ?? "—"}
          </Link>
        </li>
      ))}
    </ul>
  );
}
