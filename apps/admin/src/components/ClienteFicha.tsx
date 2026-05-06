import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAgentes } from "../lib/queries";
import Pill from "./Pill";
import type { Cliente, AgentRun, ClientAgent, Agente } from "../types";

function useClienteBySlug(slug: string) {
  return useQuery({
    queryKey: ["cliente", slug],
    enabled: !!slug,
    queryFn: async (): Promise<{ cliente: Cliente; activaciones: ClientAgent[]; runs: AgentRun[] }> => {
      const { data: cliente, error: e1 } = await supabase
        .from("clientes")
        .select("*")
        .eq("slug", slug)
        .single();
      if (e1 || !cliente) throw new Error(e1?.message ?? "cliente no encontrado");

      const [{ data: activaciones, error: e2 }, { data: runs, error: e3 }] = await Promise.all([
        supabase.from("client_agents").select("*").eq("cliente_id", (cliente as Cliente).id),
        supabase
          .from("agent_runs")
          .select("*")
          .eq("cliente_id", (cliente as Cliente).id)
          .order("started_at", { ascending: false })
          .limit(30),
      ]);
      if (e2) throw e2;
      if (e3) throw e3;
      return {
        cliente: cliente as Cliente,
        activaciones: (activaciones as ClientAgent[]) ?? [],
        runs: (runs as AgentRun[]) ?? [],
      };
    },
  });
}

export default function ClienteFicha({ slug }: { slug: string }) {
  const { data, isLoading } = useClienteBySlug(slug);
  const { data: agentes } = useAgentes();

  if (isLoading || !data || !agentes) return <p className="text-muted">Cargando…</p>;
  const { cliente, activaciones, runs } = data;
  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));

  return (
    <div>
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link> · {cliente.nombre}
      </div>
      <h1 className="font-serif text-3xl mb-1">{cliente.nombre}</h1>
      <p className="text-xs text-dim mb-6">
        slug <code>{cliente.slug}</code> · activo desde {new Date(cliente.created_at).toLocaleDateString("es-CO")}
        {cliente.notas && <> · {cliente.notas}</>}
      </p>

      <div className="grid grid-cols-2 gap-5">
        <section className="card">
          <div className="label mb-3">Agentes activados</div>
          {activaciones.length === 0 && <p className="text-muted text-sm">Ninguno.</p>}
          <div className="space-y-3">
            {activaciones.map((act) => (
              <ActivacionItem
                key={act.agente_id}
                cliente={cliente}
                activacion={act}
                agente={agenteById[act.agente_id]}
                ultimoRun={runs.find((r) => r.agente_id === act.agente_id)}
                slug={slug}
              />
            ))}
          </div>
        </section>

        <section className="card">
          <div className="label mb-2">Últimos runs (todos los agentes)</div>
          <ul className="text-xs space-y-1">
            {runs.slice(0, 15).map((r) => (
              <li key={r.id} className="flex items-center gap-2 border-b border-edge pb-1">
                <span className="text-muted font-mono w-16">
                  {new Date(r.started_at).toLocaleDateString("es-CO", { month: "short", day: "2-digit" })}
                </span>
                <Pill status={r.status} />
                <Link to={`/run/${r.id}`} className="text-dim truncate flex-1 hover:text-ink">
                  <span className="text-ink">{agenteById[r.agente_id]?.nombre ?? r.agente_id}</span>
                  {" — "}
                  {r.summary ?? r.error_message ?? "—"}
                </Link>
              </li>
            ))}
            {runs.length === 0 && <li className="text-muted">Sin runs aún.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

interface ActivacionItemProps {
  cliente: Cliente;
  activacion: ClientAgent;
  agente: Agente | undefined;
  ultimoRun: AgentRun | undefined;
  slug: string;
}

function ActivacionItem({ cliente, activacion, agente, ultimoRun, slug }: ActivacionItemProps) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const initialConfig = activacion.config as Record<string, string>;
  const [draft, setDraft] = useState({
    sheet_id: initialConfig.sheet_id ?? "",
    drive_folder: initialConfig.drive_folder ?? "",
    notify_email: initialConfig.notify_email ?? "",
    netlify_site: initialConfig.netlify_site ?? "",
  });

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

  const guardarConfig = useMutation({
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
    <div className="border border-edge rounded p-3 bg-paperalt/40">
      <div className="flex items-center gap-3">
        <Link
          to={`/agente/${activacion.agente_id}`}
          className="font-semibold hover:text-accent flex-1"
        >
          {agente?.nombre ?? activacion.agente_id}
        </Link>
        {ultimoRun ? (
          <>
            <Pill status={ultimoRun.status} />
            <Link
              to={`/run/${ultimoRun.id}`}
              className="text-xs text-muted hover:text-ink"
            >
              último run
            </Link>
          </>
        ) : (
          <span className="text-xs text-muted">sin runs</span>
        )}
        {!activacion.activo && (
          <span className="pill pill-off">Pausado</span>
        )}
      </div>

      {/* Vista de config (lectura) */}
      {!editing && (
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <ConfigRow label="Sheet ID" value={initialConfig.sheet_id} />
          <ConfigRow label="Drive folder" value={initialConfig.drive_folder} />
          <ConfigRow label="Notify email" value={initialConfig.notify_email} />
          <ConfigRow label="Netlify site" value={initialConfig.netlify_site} />
        </div>
      )}

      {/* Editor inline */}
      {editing && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <FieldEdit
            label="Sheet ID"
            value={draft.sheet_id}
            onChange={(v) => setDraft({ ...draft, sheet_id: v })}
          />
          <FieldEdit
            label="Drive folder"
            value={draft.drive_folder}
            onChange={(v) => setDraft({ ...draft, drive_folder: v })}
          />
          <FieldEdit
            label="Notify email"
            value={draft.notify_email}
            onChange={(v) => setDraft({ ...draft, notify_email: v })}
            type="email"
          />
          <FieldEdit
            label="Netlify site"
            value={draft.netlify_site}
            onChange={(v) => setDraft({ ...draft, netlify_site: v })}
          />
        </div>
      )}

      {/* Acciones */}
      <div className="mt-3 flex items-center gap-2 text-xs">
        {!editing ? (
          <>
            <button
              onClick={() => setEditing(true)}
              className="text-accent hover:underline"
            >
              Editar config
            </button>
            <span className="text-muted">·</span>
            <button
              onClick={() => togglePausa.mutate()}
              disabled={togglePausa.isPending}
              className="text-muted hover:text-fail"
            >
              {activacion.activo ? "Pausar" : "Reactivar"}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => guardarConfig.mutate()}
              disabled={guardarConfig.isPending}
              className="bg-accent text-paper px-3 py-1 rounded text-[10px] uppercase tracking-wider font-semibold disabled:opacity-50"
            >
              {guardarConfig.isPending ? "Guardando…" : "Guardar"}
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
              className="text-muted hover:text-ink"
            >
              Cancelar
            </button>
            {guardarConfig.isError && (
              <span className="text-fail">
                {(guardarConfig.error as Error).message}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <>
      <span className="text-muted">{label}:</span>
      <span className="font-mono text-ink truncate" title={value || ""}>
        {value || <span className="text-muted italic">—</span>}
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
      <span className="label block mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-edge rounded px-2 py-1 bg-white text-[11px] font-mono"
      />
    </label>
  );
}
