import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAgentes, useFacturasByCliente } from "../lib/queries";
import {
  runsLastDays,
  runsToday,
  tiempoAhorradoHoras,
  formatHoras,
  totalErrores,
  totalFacturas,
  facturasThisMonth,
  facturasToday,
  aggFacturasByCurrentYear,
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
  drive_folder_id: string | null;
  drive_folder_name: string | null;
  sheet_id: string | null;
  sheet_name: string | null;
  notify_email: string | null;
  onboarded_at: string | null;
  /** Reglas de retención fiscal del cliente (Sub-fase 2). */
  retention_rules: RetentionRulesShape | null;
  /** Municipio donde el cliente paga ICA (afecta tarifa de oficio). */
  municipio_ica: string | null;
}

/** Schema del campo retention_rules en client_credentials. */
interface RetentionRulesShape {
  version?: number;
  tipo_persona?: "juridica" | "natural_declarante" | "natural_no_declarante";
  es_agente_retenedor?: {
    reteFuente?: boolean;
    reteIva?: boolean;
    reteIca?: boolean;
  };
  aplicar_de_oficio?: {
    rtf_si_xml_vacio?: boolean;
    ica_si_xml_vacio?: boolean;
  };
  overrides_por_nit?: Record<string, NitOverrideShape>;
  notas?: string;
}

interface NitOverrideShape {
  exento_rtf?: boolean;
  exento_iva?: boolean;
  exento_ica?: boolean;
  nota?: string;
}

const MUNICIPIOS_ICA = [
  "BOGOTA",
  "MEDELLIN",
  "CALI",
  "BARRANQUILLA",
  "BUCARAMANGA",
  "CARTAGENA",
  "PEREIRA",
  "MANIZALES",
  "OTRO",
] as const;

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
          .select("agente_id, google_oauth_status, google_email, drive_folder_id, drive_folder_name, sheet_id, sheet_name, notify_email, onboarded_at, retention_rules, municipio_ica")
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
  const clienteId = data?.cliente.id ?? "";
  const { data: facturas } = useFacturasByCliente(clienteId);

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

  // === KPIs del cliente — agent_events (fecha REAL de la factura) ===
  const facturasArr = facturas ?? [];
  const facturasMes = totalFacturas(facturasThisMonth(facturasArr));
  const facturasHoy = totalFacturas(facturasToday(facturasArr));
  const horasMes = tiempoAhorradoHoras(facturasMes);
  // Errores: hoy (operacional) y 30d (histórico)
  const erroresHoy = totalErrores(runsToday(runs));
  const errores30d = totalErrores(runsLastDays(runs, 30));
  const monthlyAgg = aggFacturasByCurrentYear(facturasArr);

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

      {/* KPIs — orden operacional: día → mes → histórico */}
      <Kpis
        items={[
          { label: "Procesadas hoy", value: facturasHoy, unit: "facturas" },
          { label: "Errores hoy", value: erroresHoy, alert: erroresHoy > 0 },
          { label: "Procesadas mes", value: facturasMes, unit: "facturas", meta: facturasMes > 0 ? `≈ ${formatHoras(horasMes)} ahorradas` : "—" },
          { label: "Errores 30d", value: errores30d, alert: errores30d > 0 },
          { label: "Tiempo ahorrado", value: formatHoras(horasMes).replace(/[hm]/, ""), unit: formatHoras(horasMes).endsWith("h") ? "h" : "min", meta: "este mes" },
        ]}
      />

      {/* === Mini-chart: facturas por mes (siempre visible para mostrar histórico mensual) === */}
      <section className="card mb-9">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="section-title">Facturas procesadas · {new Date().getFullYear()}</h2>
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

interface HealthMonth {
  mes: string;
  gmail: number;
  drive: number;
  sheet: number;
  events: number;
  coincide: boolean;
  diff: string | null;
}
interface HealthResult {
  customerId: string;
  year: number;
  months: HealthMonth[];
  totals: { gmail: number; drive: number; sheet: number; events: number; coincide: boolean };
  summary: { meses_con_data: number; meses_con_discrepancia: number; todo_cuadra: boolean };
}

function ActivacionCard({ cliente, activacion, agente, runs, cred, slug }: ActivacionCardProps) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [creatingLink, setCreatingLink] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [healthResult, setHealthResult] = useState<HealthResult | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const initialConfig = activacion.config as Record<string, string>;
  const [draft, setDraft] = useState({
    sheet_id: initialConfig.sheet_id ?? "",
    drive_folder: initialConfig.drive_folder ?? "",
    notify_email: initialConfig.notify_email ?? "",
    netlify_site: initialConfig.netlify_site ?? "",
  });

  async function handleHealthCheck() {
    setCheckingHealth(true);
    setHealthError(null);
    setHealthResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("no session");
      const resp = await fetch("/api/admin/health-check", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          customerId: cliente.slug,
          agenteId: activacion.agente_id,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error ?? `HTTP ${resp.status}`);
      setHealthResult(body as HealthResult);
    } catch (e: any) {
      setHealthError(e.message ?? String(e));
    } finally {
      setCheckingHealth(false);
    }
  }

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
          {/* Lee primero de client_credentials (multi-tenant OAuth) y fallback al config_json legacy */}
          <ConfigRow
            label="Sheet"
            value={cred?.sheet_name || cred?.sheet_id || initialConfig.sheet_id}
          />
          <ConfigRow
            label="Drive folder"
            value={cred?.drive_folder_name || cred?.drive_folder_id || initialConfig.drive_folder}
          />
          <ConfigRow
            label="Notify email"
            value={cred?.notify_email || initialConfig.notify_email}
          />
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
              onClick={handleHealthCheck}
              disabled={checkingHealth}
              className="text-ink-3 hover:text-ink transition-colors tracking-[0.04em]"
              title="Compara Gmail/Drive/Sheet/events mes a mes y detecta discrepancias"
            >
              {checkingHealth ? "Validando…" : "Validar coincidencia"}
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
            {healthError && (
              <span className="text-fail w-full">Health check error: {healthError}</span>
            )}
            {healthResult && (
              <HealthPanel result={healthResult} onClose={() => setHealthResult(null)} />
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

      {/* Sección Retenciones fiscales — visualización + edición */}
      <RetentionRulesSection
        clienteId={cliente.id}
        agenteId={activacion.agente_id}
        rules={cred?.retention_rules ?? null}
        municipioIca={cred?.municipio_ica ?? null}
        slug={slug}
      />
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

function HealthPanel({
  result,
  onClose,
}: {
  result: HealthResult;
  onClose: () => void;
}) {
  const { months, totals, summary } = result;
  return (
    <div className="w-full mt-3 border border-edge rounded-lg overflow-hidden">
      <div
        className={`px-4 py-2.5 flex items-center justify-between border-b border-edge ${
          summary.todo_cuadra ? "bg-ok-soft" : "bg-warn-soft"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`font-mono text-[10px] uppercase tracking-[0.1em] font-semibold ${
            summary.todo_cuadra ? "text-ok" : "text-warn"
          }`}>
            {summary.todo_cuadra ? "✓ Todo cuadra" : `⚠ ${summary.meses_con_discrepancia} mes(es) con discrepancia`}
          </span>
          <span className="font-mono text-[10px] text-ink-3 tracking-[0.04em]">
            · {summary.meses_con_data} mes(es) con data · año {result.year}
          </span>
        </div>
        <button
          onClick={onClose}
          className="font-mono text-[10px] text-ink-3 hover:text-ink tracking-[0.04em]"
        >
          cerrar ×
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="bg-paper-sunken">
            <tr className="text-ink-3 tracking-[0.04em] uppercase text-[9px]">
              <th className="text-left px-3 py-1.5">Mes</th>
              <th className="text-right px-3 py-1.5">Gmail</th>
              <th className="text-right px-3 py-1.5">Drive</th>
              <th className="text-right px-3 py-1.5">Sheet</th>
              <th className="text-right px-3 py-1.5">Events</th>
              <th className="text-left px-3 py-1.5">Estado</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.mes} className="border-t border-edge-2">
                <td className="px-3 py-1.5 text-ink">{m.mes}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.gmail}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.drive}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.sheet}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.events}</td>
                <td className="px-3 py-1.5">
                  {m.coincide ? (
                    <span className="text-ok">✓</span>
                  ) : (
                    <span className="text-warn" title={m.diff || ""}>⚠ {m.diff}</span>
                  )}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-edge bg-paper-sunken font-semibold">
              <td className="px-3 py-1.5 text-ink uppercase tracking-[0.04em] text-[9px]">Total</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{totals.gmail}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{totals.drive}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{totals.sheet}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{totals.events}</td>
              <td className="px-3 py-1.5">
                {totals.coincide ? <span className="text-ok">✓</span> : <span className="text-warn">⚠</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 bg-paper-sunken border-t border-edge font-mono text-[9px] text-ink-3 tracking-[0.04em]">
        Gmail = emails con label · Drive = PDFs en folder YYYY-MM · Sheet = filas en pestaña del mes · Events = filas en agent_events
      </div>
    </div>
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

// ============================================================================
// RetentionRulesSection — visualización + edición de reglas de retención
// ============================================================================

function RetentionRulesSection({
  clienteId,
  agenteId,
  rules,
  municipioIca,
  slug,
}: {
  clienteId: string;
  agenteId: string;
  rules: RetentionRulesShape | null;
  municipioIca: string | null;
  slug: string;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Defaults para nuevo cliente sin reglas
  const r = rules ?? {};
  const tipoPersona = r.tipo_persona ?? "juridica";
  const agente = r.es_agente_retenedor ?? { reteFuente: true, reteIva: false, reteIca: false };
  const oficio = r.aplicar_de_oficio ?? { rtf_si_xml_vacio: true, ica_si_xml_vacio: false };
  const overrides = r.overrides_por_nit ?? {};
  const overrideNits = Object.keys(overrides);

  // Estado del form
  const [draft, setDraft] = useState({
    tipo_persona: tipoPersona,
    aplica_rtf: agente.reteFuente ?? true,
    aplica_iva: agente.reteIva ?? false,
    aplica_ica: agente.reteIca ?? false,
    oficio_rtf: oficio.rtf_si_xml_vacio ?? true,
    oficio_ica: oficio.ica_si_xml_vacio ?? false,
    municipio_ica: municipioIca ?? "",
    notas: r.notas ?? "",
  });

  // Resetear draft cuando cambia rules de Supabase
  function resetDraft() {
    setDraft({
      tipo_persona: tipoPersona,
      aplica_rtf: agente.reteFuente ?? true,
      aplica_iva: agente.reteIva ?? false,
      aplica_ica: agente.reteIca ?? false,
      oficio_rtf: oficio.rtf_si_xml_vacio ?? true,
      oficio_ica: oficio.ica_si_xml_vacio ?? false,
      municipio_ica: municipioIca ?? "",
      notas: r.notas ?? "",
    });
  }

  const guardar = useMutation({
    mutationFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("no session");

      const newRules: RetentionRulesShape = {
        version: 1,
        tipo_persona: draft.tipo_persona,
        es_agente_retenedor: {
          reteFuente: draft.aplica_rtf,
          reteIva: draft.aplica_iva,
          reteIca: draft.aplica_ica,
        },
        aplicar_de_oficio: {
          rtf_si_xml_vacio: draft.oficio_rtf,
          ica_si_xml_vacio: draft.oficio_ica,
        },
        overrides_por_nit: overrides,
        notas: draft.notas,
      };

      const resp = await fetch("/api/admin/update-retention-rules", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          clienteId,
          agenteId,
          retention_rules: newRules,
          municipio_ica: draft.municipio_ica || null,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cliente", slug] });
      setEditing(false);
      setSaveError(null);
    },
    onError: (err: any) => {
      setSaveError(err.message ?? String(err));
    },
  });

  // === VISTA (no editing) ====================================================
  if (!editing) {
    const tipoLabel = {
      juridica: "Persona jurídica",
      natural_declarante: "Persona natural — declarante",
      natural_no_declarante: "Persona natural — NO declarante",
    }[tipoPersona];

    const retencionesActivas: string[] = [];
    if (agente.reteFuente) retencionesActivas.push("RTF");
    if (agente.reteIva) retencionesActivas.push("IVA");
    if (agente.reteIca) retencionesActivas.push("ICA");

    return (
      <div className="mt-4 pt-4 border-t border-edge-2">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-display text-[13px] font-semibold tracking-tighter text-ink">
            Retenciones fiscales
          </h3>
          <button
            onClick={() => { resetDraft(); setEditing(true); }}
            className="font-mono text-[10px] text-accent hover:underline tracking-[0.04em]"
          >
            editar
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] py-1">
          <span className="text-ink-3 tracking-[0.04em]">Tipo de cliente</span>
          <span className="font-mono text-ink truncate" title={tipoLabel}>{tipoLabel}</span>

          <span className="text-ink-3 tracking-[0.04em]">Agente retenedor</span>
          <span className="font-mono text-ink">
            {retencionesActivas.length > 0
              ? retencionesActivas.join(" · ")
              : <span className="text-ink-4 italic">ninguna</span>}
          </span>

          <span className="text-ink-3 tracking-[0.04em]">Municipio ICA</span>
          <span className="font-mono text-ink">
            {municipioIca || <span className="text-ink-4 italic">no aplica</span>}
          </span>

          <span className="text-ink-3 tracking-[0.04em]">Aplicar de oficio</span>
          <span className="font-mono text-ink">
            {(() => {
              const arr: string[] = [];
              if (oficio.rtf_si_xml_vacio) arr.push("RTF");
              if (oficio.ica_si_xml_vacio) arr.push("ICA");
              return arr.length > 0
                ? arr.join(" · ")
                : <span className="text-ink-4 italic">ninguna</span>;
            })()}
          </span>

          {overrideNits.length > 0 && (
            <>
              <span className="text-ink-3 tracking-[0.04em]">Proveedores exentos</span>
              <span className="font-mono text-ink">{overrideNits.length} NIT(s)</span>
            </>
          )}
        </div>
      </div>
    );
  }

  // === EDICIÓN (form) ========================================================
  return (
    <div className="mt-4 pt-4 border-t border-edge-2 bg-paper-sunken -mx-6 px-6 pb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-display text-[13px] font-semibold tracking-tighter text-ink">
          Editar retenciones fiscales
        </h3>
      </div>

      <div className="grid grid-cols-1 gap-4 text-[12px]">
        {/* Tipo de persona */}
        <div>
          <div className="label-tight mb-1.5">Tipo de cliente</div>
          <select
            value={draft.tipo_persona}
            onChange={(e) => setDraft({ ...draft, tipo_persona: e.target.value as any })}
            className="input"
          >
            <option value="juridica">Persona jurídica (empresa)</option>
            <option value="natural_declarante">Persona natural — declarante de renta</option>
            <option value="natural_no_declarante">Persona natural — NO declarante</option>
          </select>
        </div>

        {/* Agente retenedor */}
        <div>
          <div className="label-tight mb-1.5">¿Es agente retenedor de…?</div>
          <div className="flex flex-col gap-1.5 font-mono text-[11px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.aplica_rtf}
                onChange={(e) => setDraft({ ...draft, aplica_rtf: e.target.checked })} />
              Retención en la Fuente (RTF)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.aplica_iva}
                onChange={(e) => setDraft({ ...draft, aplica_iva: e.target.checked })} />
              Retención de IVA (solo grandes contribuyentes)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.aplica_ica}
                onChange={(e) => setDraft({ ...draft, aplica_ica: e.target.checked })} />
              Retención de ICA
            </label>
          </div>
        </div>

        {/* Municipio ICA */}
        <div>
          <div className="label-tight mb-1.5">Municipio donde paga ICA</div>
          <select
            value={
              draft.municipio_ica && !MUNICIPIOS_ICA.includes(draft.municipio_ica as any)
                ? "OTRO"
                : draft.municipio_ica
            }
            onChange={(e) => setDraft({ ...draft, municipio_ica: e.target.value })}
            className="input"
          >
            <option value="">— No aplica —</option>
            {MUNICIPIOS_ICA.map((m) => (
              <option key={m} value={m}>
                {m === "BOGOTA" ? "Bogotá" :
                 m === "MEDELLIN" ? "Medellín" :
                 m === "CALI" ? "Cali" :
                 m === "BARRANQUILLA" ? "Barranquilla" :
                 m === "BUCARAMANGA" ? "Bucaramanga" :
                 m === "CARTAGENA" ? "Cartagena" :
                 m === "PEREIRA" ? "Pereira" :
                 m === "MANIZALES" ? "Manizales" :
                 "Otro municipio…"}
              </option>
            ))}
          </select>
          {/* Si eligió OTRO o un valor custom, mostrar input de texto */}
          {(draft.municipio_ica === "OTRO" ||
            (draft.municipio_ica && !MUNICIPIOS_ICA.includes(draft.municipio_ica as any))) && (
            <div className="mt-2">
              <input
                type="text"
                value={draft.municipio_ica === "OTRO" ? "" : draft.municipio_ica}
                onChange={(e) => setDraft({ ...draft, municipio_ica: e.target.value.toUpperCase().trim() || "OTRO" })}
                className="input input-mono"
                placeholder="Ej: ENVIGADO, ITAGUI, RIONEGRO..."
              />
              <div className="font-mono text-[10px] text-ink-3 mt-1 tracking-[0.04em]">
                Escribí el nombre del municipio. Como no está en nuestra lista de tarifas, ICA de oficio quedará en 0 — el cliente revisa manual.
              </div>
            </div>
          )}
        </div>

        {/* Aplicar de oficio */}
        <div>
          <div className="label-tight mb-1.5">Aplicar retención de oficio si el proveedor no la incluyó</div>
          <div className="flex flex-col gap-1.5 font-mono text-[11px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.oficio_rtf}
                onChange={(e) => setDraft({
                  ...draft,
                  oficio_rtf: e.target.checked,
                  // Si activa oficio RTF y no es agente retenedor, auto-activarlo
                  aplica_rtf: e.target.checked ? true : draft.aplica_rtf,
                })} />
              RTF (según categoría del servicio/producto)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.oficio_ica}
                onChange={(e) => setDraft({
                  ...draft,
                  oficio_ica: e.target.checked,
                  // Si activa oficio ICA, auto-activar también "agente retenedor de ICA"
                  aplica_ica: e.target.checked ? true : draft.aplica_ica,
                })} />
              ICA (según tarifa del municipio)
              {draft.oficio_ica && !draft.municipio_ica && (
                <span className="text-warn text-[10px] ml-2">⚠ falta elegir municipio arriba</span>
              )}
            </label>
          </div>
        </div>

        {/* Notas */}
        <div>
          <div className="label-tight mb-1.5">Notas internas (opcional)</div>
          <textarea
            value={draft.notas}
            onChange={(e) => setDraft({ ...draft, notas: e.target.value })}
            className="input"
            rows={2}
            placeholder="Ej: cliente con régimen especial, etc"
          />
        </div>

        {saveError && (
          <div className="text-fail text-[11px]">Error guardando: {saveError}</div>
        )}

        <div className="flex items-center gap-3 mt-2">
          <button
            onClick={() => guardar.mutate()}
            disabled={guardar.isPending}
            className="btn-accent"
          >
            {guardar.isPending ? "Guardando…" : "Guardar"}
          </button>
          <button
            onClick={() => setEditing(false)}
            className="font-mono text-[11px] text-ink-3 hover:text-ink tracking-[0.04em]"
          >
            cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
