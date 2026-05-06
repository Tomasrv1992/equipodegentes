import { useState } from "react";
import { Link } from "react-router-dom";
import { useRun, useClientes, useAgentes, useRunsByClienteAgente } from "../lib/queries";
import { classifyError } from "../lib/classify-error";
import { supabase } from "../lib/supabase";
import Pill from "./Pill";

export default function RunDetail({ runId }: { runId: string }) {
  const { data: run, isLoading } = useRun(runId);
  const { data: clientes } = useClientes();
  const { data: agentes } = useAgentes();

  const [rerunStatus, setRerunStatus] = useState<"idle" | "dispatching" | "ok" | "fail">("idle");
  const [rerunMsg, setRerunMsg] = useState("");

  if (isLoading || !run) return <p className="text-muted">Cargando run…</p>;

  const cliente = clientes?.find((c) => c.id === run.cliente_id);
  const agente  = agentes?.find((a) => a.id === run.agente_id);
  const errCls  = run.error_message ? classifyError(run.error_message) : null;

  const runIdForRerun = run.id;
  async function handleRerun() {
    setRerunStatus("dispatching");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("no session");

      const resp = await fetch("/api/trigger-rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ runId: runIdForRerun }),
      });
      if (!resp.ok) {
        throw new Error(await resp.text());
      }
      setRerunStatus("ok");
      setRerunMsg("Disparado. El nuevo run aparecerá en la matriz en ~30s.");
    } catch (err: any) {
      setRerunStatus("fail");
      setRerunMsg(err.message ?? String(err));
    }
  }

  return (
    <div>
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link>
        {cliente && <> · <Link to={`/cliente/${cliente.slug}`} className="text-accent">{cliente.nombre}</Link></>}
        {agente  && <> · <Link to={`/agente/${agente.id}`} className="text-accent">{agente.nombre}</Link></>}
        {" · "}Run del {new Date(run.started_at).toLocaleString("es-CO", { timeZone: "America/Bogota" })}
      </div>

      <h1 className="font-serif text-2xl mb-1">
        Run · {agente?.nombre ?? run.agente_id}
      </h1>
      <div className="text-xs text-dim mb-6">
        <Pill status={run.status} />
        <span className="ml-3">
          Cliente: <strong>{cliente?.nombre ?? run.cliente_id}</strong>
          {" · "}duración {(run.duration_ms ?? 0) / 1000}s
          {" · "}trigger: {run.triggered_by}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <section className="card">
          <div className="label mb-2">Resumen</div>
          {run.summary ? <p className="text-sm">{run.summary}</p> : <p className="text-muted text-sm">—</p>}

          {run.error_message && (
            <>
              <div className="label mt-5 mb-2 text-fail">Error</div>
              <pre className="bg-ink text-paper text-[11px] font-mono p-3 rounded overflow-auto whitespace-pre-wrap">
{`${run.error_message}

${run.error_stack ?? ""}`}
              </pre>
              {errCls && (
                <div className="mt-3 text-xs">
                  <p><strong className="text-accent">Causa probable:</strong> {errCls.causaProbable}</p>
                  {errCls.fixSugerido && (
                    <p className="mt-1"><strong className="text-accent">Fix sugerido:</strong> {errCls.fixSugerido}</p>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        <section className="card">
          <div className="label mb-2">Historial reciente</div>
          <Historial clienteId={run.cliente_id} agenteId={run.agente_id} excludeId={run.id} />

          {run.netlify_log_url && (
            <a
              href={run.netlify_log_url}
              target="_blank"
              rel="noreferrer"
              className="block mt-5 text-xs text-accent hover:underline"
            >
              Ver logs Netlify →
            </a>
          )}
        </section>
      </div>

      <div className="mt-6 flex flex-wrap gap-2 items-center">
        <button
          onClick={handleRerun}
          disabled={rerunStatus === "dispatching" || rerunStatus === "ok"}
          className="bg-accent text-paper px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold disabled:opacity-50"
        >
          {rerunStatus === "dispatching" ? "Disparando…" : rerunStatus === "ok" ? "Disparado ✓" : "Re-disparar run"}
        </button>
        <button className="bg-ink text-paper px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold opacity-50 cursor-not-allowed" disabled>
          Pausar agente p/ este cliente
        </button>
        {run.netlify_log_url && (
          <a
            href={run.netlify_log_url}
            target="_blank"
            rel="noreferrer"
            className="border border-ink text-ink px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold"
          >
            Ver logs Netlify
          </a>
        )}
        {rerunMsg && (
          <span className={`text-xs ${rerunStatus === "fail" ? "text-fail" : "text-ok"}`}>
            {rerunMsg}
          </span>
        )}
      </div>
    </div>
  );
}

function Historial({
  clienteId,
  agenteId,
  excludeId,
}: { clienteId: string; agenteId: string; excludeId: string }) {
  const { data: runs } = useRunsByClienteAgente(clienteId, agenteId, 6);
  if (!runs) return <p className="text-muted text-sm">Cargando…</p>;
  const filtered = runs.filter((r) => r.id !== excludeId).slice(0, 5);
  if (filtered.length === 0) return <p className="text-muted text-sm">Sin historial previo.</p>;

  return (
    <ul className="text-xs space-y-1">
      {filtered.map((r) => (
        <li key={r.id} className="flex items-center gap-2 border-b border-edge pb-1">
          <span className="text-muted font-mono w-16">
            {new Date(r.started_at).toLocaleDateString("es-CO", { month: "short", day: "2-digit" })}
          </span>
          <Pill status={r.status} />
          <Link to={`/run/${r.id}`} className="text-dim truncate flex-1 hover:text-ink">
            {r.summary ?? r.error_message ?? "—"}
          </Link>
        </li>
      ))}
    </ul>
  );
}
