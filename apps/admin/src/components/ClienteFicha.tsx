import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAgentes } from "../lib/queries";
import {
  totalProcesadas,
  runsThisMonth,
  runsLastDays,
  tiempoAhorradoHoras,
  formatHoras,
  aggByMonth,
  totalErrores,
} from "../lib/metrics";
import Pill from "./Pill";
import Sparkline from "./Sparkline";
import Kpis from "./Kpis";
import MonthlyBars from "./MonthlyBars";
import { sparkRunsByDay } from "../lib/timeline";
import type { Cliente, AgentRun, ClientAgent, Agente } from "../types";

interface CredStatus {
  agente_id: string;
  google_oauth_status: "pending" | "connected" | "expired" | "revoked" | null;
  google_email: string | null;
  drive_folder_name: string | null;
  sheet_name: string | null;
  notify_email: string | null;
  onboarded_at: string | null;
}

function useClienteBySlug(slug: string) {
  return useQuery({
    queryKey: ["cliente", slug],
    enabled: !!slug,
    queryFn: async (): Promise<{
      cliente: Cliente;
      activaciones: ClientAgent[];
      runs: AgentRun[];
      credentials: CredStatus[];
    }> => {
      const { data: cliente, error: e1 } = await supabase
        .from("clientes")
        .select("*")
        .eq("slug", slug)
        .single();
      if (e1 || !cliente) throw new Error(e1?.message ?? "cliente no encontrado");

      const [
        { data: activaciones, error: e2 },
        { data: runs, error: e3 },
        { data: creds, error: e4 },
      ] = await Promise.all([
        supabase
          .from("client_agents")
          .select("*")
          .eq("cliente_id", (cliente as Cliente).id),
        supabase
          .from("agent_runs")
          .select("*")
          .eq("cliente_id", (cliente as Cliente).id)
          .order("started_at", { ascending: false })
          .limit(200),
        supabase
          .from("client_credentials")
          .select("agente_id, google_oauth_status, google_email, drive_folder_name, sheet_name, notify_email, onboarded_at")
          .eq("cliente_id", (cliente as Cliente).id),
      ]);
      if (e2) throw e2;
      if (e3) throw e3;
      if (e4) {
        // No fallar si client_credentials no existe (migración 0002 todavía no corrida)
        console.warn("client_credentials query failed (no fatal):", e4.message);
      }
      return {
        cliente: cliente as Cliente,
        activaciones: (activaciones as ClientAgent[]) ?? [],
        runs: (runs as AgentRun[]) ?? [],
        credentials: (creds as CredStatus[]) ?? [],
      };
    },
  });
}

export default function ClienteFicha({ slug }: { slug: string }) {
  const { data, isLoading } = useClienteBySlug(slug);
  const { data: agentes } = useAgentes();

  if (isLoading || !data || !agentes) {
    return (
      <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        Cargando…
      </div>
    );
  }

  const { cliente, activaciones, runs, credentials } = data;
  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));
  const credByAgente = Object.fromEntries(credentials.map((c) => [c.agente_id, c]));

  // === KPIs del cliente ===
  const facturasMes = totalProcesadas(runsThisMonth(runs));
  const facturas7d = totalProcesadas(runsLastDays(runs, 7));
  const horasMes = tiempoAhorradoHoras(facturasMes);
  const errores30d = totalErrores(runsLastDays(runs, 30));
  const monthlyAgg = aggByMonth(runs, 6);

  return (
    <div>
      {/* Breadcrumbs */}
      <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-3 flex items-center gap-1.5">
        <Link to="/" className="hover:text-ink transition-colors">Operación</Link>
        <span className="text-ink-4">/</span>
        <span className="text-ink-2">Clientes</span>
        <span className="text-ink-4">/</span>
        <span className="text-ink-2">{cliente.nombre}</span>
      </div>

      {/* Header */}
      <div className="border-b border-edge pb-7 mb-9 grid grid-cols-[1fr_auto] items-end gap-8">
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
            Cliente · {cliente.slug}
          </div>
          <h1
            className="font-display font-medium leading-[0.98] tracking-tightest text-ink m-0 mb-3"
            style={{ fontSize: "clamp(36px, 5vw, 60px)" }}
          >
            {cliente.nombre}
          </h1>
          {cliente.notas && (
            <p className="font-sans text-sm text-ink-3 max-w-[640px] leading-relaxed">
              {cliente.notas}
            </p>
          )}
          <div className="flex items-center gap-4 mt-3 font-mono text-[11px] text-ink-3 tracking-[0.04em]">
            <span>
              <span className="text-ink-4">activo desde</span>{" "}
              {new Date(cliente.created_at).toLocaleDateString("es-CO", {
                month: "short",
                year: "numeric",
              }).replace(".", "")}
            </span>
            <span className="text-ink-4">·</span>
            <span>
              <span className="text-ink-4">agentes</span>{" "}
              {activaciones.filter((a) => a.activo).length}
            </span>
          </div>
        </div>

        <div className="text-right">
          <div
            className="font-display font-normal leading-none tracking-tightest text-ink"
            style={{ fontSize: "44px" }}
          >
            {facturasMes}
          </div>
          <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mt-1">
            facturas · este mes
          </div>
        </div>
      </div>

      {/* KPIs */}
      <Kpis
        items={[
          { label: "Procesadas mes", value: facturasMes, unit: "facturas", meta: facturasMes > 0 ? `≈ ${formatHoras(horasMes)} ahorradas` : "—" },
          { label: "Procesadas 7 días", value: facturas7d, unit: "facturas" },
          { label: "Errores 30d", value: errores30d, alert: errores30d > 0 },
          { label: "Tiempo ahorrado", value: formatHoras(horasMes).replace(/[hm]/, ""), unit: formatHoras(horasMes).endsWith("h") ? "h" : "min", meta: "este mes" },
        ]}
      />

      {/* === Mini-chart: facturas por mes (siempre visible para mostrar histórico mensual) === */}
      <section className="card mb-9">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="section-title">Facturas procesadas · 6 meses</h2>
          <span className="section-meta">
            total {monthlyAgg.reduce((a, m) => a + m.procesadas, 0)} facturas
          </span>
        </div>
        <MonthlyBars data={monthlyAgg} />
      </section>

      <div className="grid grid-cols-2 gap-5">
        {/* Activaciones */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="section-title">Agentes activados</h2>
            <span className="section-meta">{activaciones.length} total</span>
          </div>
          <div className="space-y-3">
            {activaciones.length === 0 && (
              <div className="card text-ink-3 text-sm">Ninguno todavía.</div>
            )}
            {activaciones.map((act) => (
              <ActivacionCard
                key={act.agente_id}
                cliente={cliente}
                activacion={act}
                agente={agenteById[act.agente_id]}
                runs={runs.filter((r) => r.agente_id === act.agente_id)}
                cred={credByAgente[act.agente_id]}
                slug={slug}
              />
            ))}
          </div>
        </section>

        {/* Últimos runs */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="section-title">Últimos runs</h2>
            <span className="section-meta">{runs.length} totales</span>
          </div>
          <div className="card p-0 overflow-hidden">
            {runs.length === 0 ? (
              <div className="p-5 text-ink-3 text-sm">Sin runs aún.</div>
            ) : (
              <ul>
                {runs.slice(0, 15).map((r) => (
                  <li
                    key={r.id}
                    className="grid grid-cols-[60px_60px_1fr] items-center gap-2 px-4 py-2.5 border-b border-edge-2 last:border-b-0 text-xs hover:bg-paper-sunken transition-colors"
                  >
                    <span className="font-mono text-[10px] text-ink-3 tracking-[0.04em] tabular-nums">
                      {new Date(r.started_at).toLocaleDateString("es-CO", {
                        month: "short",
                        day: "2-digit",
                      }).replace(".", "")}
                    </span>
                    <Pill status={r.status} />
                    <Link
                      to={`/run/${r.id}`}
                      className="text-ink-3 truncate hover:text-ink transition-colors"
                    >
                      <span className="text-ink font-medium">{agenteById[r.agente_id]?.nombre.replace("Equipo-", "") ?? r.agente_id}</span>
                      {" · "}
                      {r.summary ?? r.error_message ?? "—"}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

interface ActivacionCardProps {
  cliente: Cliente;
  activacion: ClientAgent;
  agente: Agente | undefined;
  runs: AgentRun[];
  cred: CredStatus | undefined;
  slug: string;
}

function ActivacionCard({ cliente, activacion, agente, runs, cred, slug }: ActivacionCardProps) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [creatingLink, setCreatingLink] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const initialConfig = activacion.config as Record<string, string>;
  const [draft, setDraft] = useState({
    sheet_id: initialConfig.sheet_id ?? "",
    drive_folder: initialConfig.drive_folder ?? "",
    notify_email: initialConfig.notify_email ?? "",
    netlify_site: initialConfig.netlify_site ?? "",
  });

  const last = runs[0];
  const sparkPoints = sparkRunsByDay(runs, 14);

  async function handleCreateOnboardingLink() {
    setCreatingLink(true);
    setLinkError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("no session");

      const resp = await fetch("/api/admin/create-onboarding-link", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          clienteId: cliente.id,
          agenteId: activacion.agente_id,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const { link } = (await resp.json()) as { link: string };
      setCreatedLink(link);
      // copiar al portapapeles
      try {
        await navigator.clipboard.writeText(link);
      } catch {}
    } catch (e: any) {
      setLinkError(e.message ?? String(e));
    } finally {
      setCreatingLink(false);
    }
  }

  const togglePausa = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("client_agents")
        .update({ activo: !activacion.activo })
        .eq("cliente_id", cliente.id)
        .eq("agente_id", activacion.agente_id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cliente", slug] }),
  });

  const guardar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("client_agents")
        .update({ config: draft })
        .eq("cliente_id", cliente.id)
        .eq("agente_id", activacion.agente_id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cliente", slug] });
      setEditing(false);
    },
  });

  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-3">
        <Link
          to={`/agente/${activacion.agente_id}`}
          className="font-display text-base font-semibold tracking-tighter text-ink hover:text-accent transition-colors flex-1"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent mr-2 align-middle" />
          {agente?.nombre ?? activacion.agente_id}
        </Link>
        {last ? (
          <>
            <Pill status={last.status} />
            <Link
              to={`/run/${last.id}`}
              className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors tracking-[0.04em]"
            >
              último
            </Link>
          </>
        ) : (
          <span className="font-mono text-[10px] text-ink-3 tracking-[0.04em]">sin runs</span>
        )}
        {!activacion.activo && <span className="pill pill-off">Pausado</span>}
      </div>

      {/* Status OAuth credentials */}
      {cred && (
        <div className="mb-3 -mt-1">
          <CredentialStatusBadge status={cred.google_oauth_status} email={cred.google_email} onboardedAt={cred.onboarded_at} />
        </div>
      )}
      {!cred && (
        <div className="mb-3 -mt-1">
          <span className="font-mono text-[10px] text-ink-3 tracking-[0.04em] inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-4" />
            Sin credenciales OAuth · usar "Crear link de onboarding"
          </span>
        </div>
      )}

      {sparkPoints.some((p) => p.value > 0) && (
        <div className="mb-3">
          <Sparkline points={sparkPoints} className="h-6" />
          <div className="font-mono text-[9px] text-ink-3 tracking-[0.06em] uppercase mt-1">
            últimos 14d · runs OK por día
          </div>
        </div>
      )}

      {!editing ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] py-1">
          <ConfigRow label="Sheet ID" value={initialConfig.sheet_id} />
          <ConfigRow label="Drive folder" value={initialConfig.drive_folder} />
          <ConfigRow label="Notify email" value={initialConfig.notify_email} />
          <ConfigRow label="Netlify site" value={initialConfig.netlify_site} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <FieldEdit label="Sheet ID" value={draft.sheet_id} onChange={(v) => setDraft({ ...draft, sheet_id: v })} />
          <FieldEdit label="Drive folder" value={draft.drive_folder} onChange={(v) => setDraft({ ...draft, drive_folder: v })} />
          <FieldEdit label="Notify email" value={draft.notify_email} onChange={(v) => setDraft({ ...draft, notify_email: v })} type="email" />
          <FieldEdit label="Netlify site" value={draft.netlify_site} onChange={(v) => setDraft({ ...draft, netlify_site: v })} />
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-edge-2 flex items-center gap-3 font-mono text-[11px] flex-wrap">
        {!editing ? (
          <>
            <button
              onClick={handleCreateOnboardingLink}
              disabled={creatingLink}
              className="text-accent hover:underline tracking-[0.04em] font-semibold"
              title="Genera un link único de 7 días para mandar al cliente"
            >
              {creatingLink
                ? "Generando…"
                : createdLink
                ? "Link copiado ✓"
                : "Crear link de onboarding"}
            </button>
            <span className="text-ink-4">·</span>
            <button
              onClick={() => setEditing(true)}
              className="text-ink-3 hover:text-ink transition-colors tracking-[0.04em]"
            >
              Editar config manual
            </button>
            <span className="text-ink-4">·</span>
            <button
              onClick={() => togglePausa.mutate()}
              disabled={togglePausa.isPending}
              className="text-ink-3 hover:text-fail transition-colors tracking-[0.04em]"
            >
              {activacion.activo ? "Pausar" : "Reactivar"}
            </button>
            {createdLink && (
              <div className="w-full mt-2 p-2 bg-paper-sunken rounded border border-edge-2 text-[10px] break-all">
                <span className="text-ink-3 mr-2 tracking-[0.04em]">link:</span>
                <a href={createdLink} target="_blank" rel="noreferrer" className="text-accent">
                  {createdLink}
                </a>
                <span className="text-ink-4 ml-2">(copiado al portapapeles · vence en 7d)</span>
              </div>
            )}
            {linkError && (
              <span className="text-fail w-full">Error: {linkError}</span>
            )}
          </>
        ) : (
          <>
            <button
              onClick={() => guardar.mutate()}
              disabled={guardar.isPending}
              className="btn-accent"
            >
              {guardar.isPending ? "Guardando…" : "Guardar"}
            </button>
            <button
              onClick={() => {
                setDraft({
                  sheet_id: initialConfig.sheet_id ?? "",
                  drive_folder: initialConfig.drive_folder ?? "",
                  notify_email: initialConfig.notify_email ?? "",
                  netlify_site: initialConfig.netlify_site ?? "",
                });
                setEditing(false);
              }}
              className="btn-ghost"
            >
              Cancelar
            </button>
            {guardar.isError && (
              <span className="text-fail">{(guardar.error as Error).message}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CredentialStatusBadge({
  status,
  email,
  onboardedAt,
}: {
  status: CredStatus["google_oauth_status"];
  email: string | null;
  onboardedAt: string | null;
}) {
  const map = {
    connected: { color: "text-ok", label: "Conectado", dotBg: "bg-ok" },
    expired:   { color: "text-warn", label: "OAuth expirado · reconectar", dotBg: "bg-warn" },
    revoked:   { color: "text-fail", label: "OAuth revocado por el cliente", dotBg: "bg-fail" },
    pending:   { color: "text-ink-3", label: "Esperando que el cliente complete onboarding", dotBg: "bg-ink-4" },
  } as const;

  const cfg = status ? map[status] : map.pending;

  return (
    <span className={`font-mono text-[10px] tracking-[0.04em] inline-flex items-center gap-2 ${cfg.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotBg}`} />
      {cfg.label}
      {email && status === "connected" && (
        <span className="text-ink-3">· {email}</span>
      )}
      {onboardedAt && (
        <span className="text-ink-4">
          · onboarded {new Date(onboardedAt).toLocaleDateString("es-CO", { month: "short", day: "2-digit" }).replace(".", "")}
        </span>
      )}
    </span>
  );
}

function ConfigRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <>
      <span className="text-ink-3 tabular-nums tracking-[0.04em]">{label}</span>
      <span className="font-mono text-ink truncate" title={value || ""}>
        {value || <span className="text-ink-4 italic">—</span>}
      </span>
    </>
  );
}

function FieldEdit({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="label-tight mb-1 block">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input input-mono"
      />
    </label>
  );
}
