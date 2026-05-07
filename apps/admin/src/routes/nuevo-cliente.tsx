import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAgentes } from "../lib/queries";
import { slugify } from "../lib/slugify";
import { enabledAgents, type FieldSpec } from "../lib/agent-config-schema";
import type { Cliente } from "../types";

interface ActivacionForm {
  agente_id: string;
  activo: boolean;
  config: Record<string, string>;
}

interface FormState {
  nombre: string;
  slug: string;
  slugTouched: boolean;
  notas: string;
  activaciones: Record<string, ActivacionForm>;
}

export default function NuevoCliente() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: agentes } = useAgentes();
  const enabledSchemas = enabledAgents();

  const [form, setForm] = useState<FormState>({
    nombre: "",
    slug: "",
    slugTouched: false,
    notas: "",
    activaciones: {},
  });

  // Auto-slug desde nombre hasta que el user lo toque manualmente
  useEffect(() => {
    if (!form.slugTouched) {
      setForm((f) => ({ ...f, slug: slugify(f.nombre) }));
    }
  }, [form.nombre, form.slugTouched]);

  // Init activaciones cuando cargan los agentes
  useEffect(() => {
    if (agentes && Object.keys(form.activaciones).length === 0) {
      const init: Record<string, ActivacionForm> = {};
      for (const schema of enabledSchemas) {
        const config: Record<string, string> = {};
        for (const f of schema.fields) config[f.key] = "";
        init[schema.agente_id] = {
          agente_id: schema.agente_id,
          activo: false,
          config,
        };
      }
      setForm((f) => ({ ...f, activaciones: init }));
    }
  }, [agentes]);

  const crear = useMutation({
    mutationFn: async (): Promise<Cliente> => {
      const { data: cliente, error: e1 } = await supabase
        .from("clientes")
        .insert({
          nombre: form.nombre,
          slug: form.slug,
          notas: form.notas || null,
          activo: true,
        })
        .select("*")
        .single();
      if (e1 || !cliente) throw new Error(e1?.message ?? "no cliente");

      const activaciones = Object.values(form.activaciones).filter((a) => a.activo);
      if (activaciones.length > 0) {
        const rows = activaciones.map((a) => ({
          cliente_id: (cliente as Cliente).id,
          agente_id: a.agente_id,
          activo: true,
          config: a.config,
        }));
        const { error: e2 } = await supabase.from("client_agents").insert(rows);
        if (e2) throw new Error(e2.message);
      }
      return cliente as Cliente;
    },
    onSuccess: (cliente) => {
      qc.invalidateQueries({ queryKey: ["clientes"] });
      qc.invalidateQueries({ queryKey: ["client-agents"] });
      qc.invalidateQueries({ queryKey: ["latest-runs"] });
      navigate(`/cliente/${cliente.slug}`);
    },
  });

  const canSubmit =
    form.nombre.trim().length > 0 && form.slug.trim().length > 0 && !crear.isPending;

  return (
    <div className="max-w-3xl">
      {/* Breadcrumbs */}
      <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mb-3 flex items-center gap-1.5">
        <Link to="/" className="hover:text-ink transition-colors">Operación</Link>
        <span className="text-ink-4">/</span>
        <span className="text-ink-2">Nuevo cliente</span>
      </div>

      {/* Header */}
      <div className="border-b border-edge pb-7 mb-9">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-2">
          Onboarding · OAuth flow
        </div>
        <h1 className="font-display text-5xl font-medium tracking-tightest text-ink leading-none mb-4">
          Nuevo cliente
        </h1>
        <p className="font-sans text-sm text-ink-3 max-w-[640px] leading-relaxed">
          Solo necesitás <strong className="text-ink">nombre + slug</strong>. Activá el agente
          y dejá los campos técnicos (Sheet, Drive folder, etc.) <strong className="text-ink">vacíos</strong> —
          después de crear el cliente, click "Crear link de onboarding" en su ficha y mandale el link al
          cliente. El cliente conecta su Google solo y elige sus recursos durante ese flow.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) crear.mutate();
        }}
      >
        {/* Datos del cliente */}
        <section className="card mb-6 space-y-5">
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="section-title">Datos del cliente</h2>
            <span className="section-meta">requeridos: nombre, slug</span>
          </div>

          <Field
            label="Nombre"
            required
            hint="Nombre comercial del cliente como aparece en facturas. Ej: 'Clínica San Lucas'."
          >
            <input
              type="text"
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              className="input"
              placeholder="Clínica San Lucas"
              required
            />
          </Field>

          <Field
            label="Slug"
            required
            hint="Identificador URL-friendly. Auto-generado del nombre, editable. Aparece en la URL del cliente."
          >
            <input
              type="text"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value, slugTouched: true })}
              className="input input-mono"
              placeholder="clinica-san-lucas"
              required
            />
          </Field>

          <Field
            label="Notas"
            hint="Opcional. Contexto interno (ej: fecha onboarding, sitio Netlify del cron)."
          >
            <textarea
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
              className="input min-h-[80px] resize-y"
              placeholder="Onboarded 2026-05-06. Sitio Netlify: equipodegentes-cron-clinicaxyz."
            />
          </Field>
        </section>

        {/* Agentes */}
        <section className="card mb-6">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="section-title">Agentes a activar</h2>
            <span className="section-meta">
              {enabledSchemas.length} disponible{enabledSchemas.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="space-y-4">
            {enabledSchemas.map((schema) => {
              const a = agentes?.find((ag) => ag.id === schema.agente_id);
              const act = form.activaciones[schema.agente_id];
              if (!act) return null;
              return (
                <div
                  key={schema.agente_id}
                  className={`border rounded-lg transition-all duration-150 ease-out-expo ${
                    act.activo
                      ? "border-edge bg-paper"
                      : "border-edge-2 bg-paper-sunken/40"
                  }`}
                >
                  <label className="flex items-center gap-3 p-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={act.activo}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          activaciones: {
                            ...form.activaciones,
                            [schema.agente_id]: { ...act, activo: e.target.checked },
                          },
                        })
                      }
                      className="w-4 h-4 accent-accent"
                    />
                    <div className="flex-1">
                      <div className="font-display text-base font-semibold tracking-tighter text-ink flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                        {a?.nombre ?? schema.agente_id}
                      </div>
                      {a?.descripcion && (
                        <div className="font-sans text-xs text-ink-3 mt-1">
                          {a.descripcion}
                        </div>
                      )}
                    </div>
                  </label>

                  {act.activo && schema.fields.length > 0 && (
                    <div className="px-4 pb-4 pt-1 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-edge-2">
                      {schema.fields.map((f) => (
                        <DynamicField
                          key={f.key}
                          spec={f}
                          value={act.config[f.key] ?? ""}
                          onChange={(v) =>
                            updateConfig(form, setForm, schema.agente_id, f.key, v)
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {enabledSchemas.length === 0 && (
              <p className="text-ink-3 text-sm">
                Ningún agente disponible para activar todavía.
              </p>
            )}
          </div>
        </section>

        {/* Acciones */}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={!canSubmit} className="btn-accent">
            {crear.isPending ? "Creando…" : "Crear cliente"}
          </button>
          <Link to="/" className="btn-ghost">
            Cancelar
          </Link>
          {crear.isError && (
            <span className="font-mono text-[11px] text-fail tracking-[0.04em]">
              Error: {(crear.error as Error)?.message ?? "desconocido"}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="label mb-1.5">
        {label} {required && <span className="text-accent">*</span>}
      </span>
      {children}
      {hint && (
        <p className="font-mono text-[10px] text-ink-3 mt-1.5 tracking-[0.04em] leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}

function DynamicField({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <span className="label-tight mb-1 block">
        {spec.label} {spec.required && <span className="text-accent">*</span>}
      </span>
      <input
        type={spec.type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input input-mono"
        placeholder={spec.placeholder}
      />
      {spec.hint && (
        <p className="font-mono text-[10px] text-ink-3 mt-1 tracking-[0.04em] leading-relaxed">
          {spec.hint}
        </p>
      )}
    </div>
  );
}

function updateConfig(
  form: FormState,
  setForm: (f: FormState) => void,
  agenteId: string,
  field: string,
  value: string,
) {
  const act = form.activaciones[agenteId];
  if (!act) return;
  setForm({
    ...form,
    activaciones: {
      ...form.activaciones,
      [agenteId]: {
        ...act,
        config: { ...act.config, [field]: value },
      },
    },
  });
}
