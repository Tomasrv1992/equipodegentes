import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAgentes } from "../lib/queries";
import { slugify } from "../lib/slugify";
import type { Cliente } from "../types";

interface ActivacionForm {
  agente_id: string;
  activo: boolean;
  config: {
    sheet_id: string;
    drive_folder: string;
    notify_email: string;
    netlify_site: string;
  };
}

interface FormState {
  nombre: string;
  slug: string;
  slugTouched: boolean;
  notas: string;
  activaciones: Record<string, ActivacionForm>;
}

const EMPTY_CONFIG = {
  sheet_id: "",
  drive_folder: "",
  notify_email: "",
  netlify_site: "",
};

export default function NuevoCliente() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: agentes } = useAgentes();

  const [form, setForm] = useState<FormState>({
    nombre: "",
    slug: "",
    slugTouched: false,
    notas: "",
    activaciones: {},
  });

  // Auto-actualizar slug desde nombre, hasta que el usuario lo edite manualmente
  useEffect(() => {
    if (!form.slugTouched) {
      setForm((f) => ({ ...f, slug: slugify(f.nombre) }));
    }
  }, [form.nombre, form.slugTouched]);

  // Inicializar activaciones cuando cargan los agentes
  useEffect(() => {
    if (agentes && Object.keys(form.activaciones).length === 0) {
      const init: Record<string, ActivacionForm> = {};
      for (const a of agentes) {
        init[a.id] = {
          agente_id: a.id,
          activo: false,
          config: { ...EMPTY_CONFIG },
        };
      }
      setForm((f) => ({ ...f, activaciones: init }));
    }
  }, [agentes]);

  const crear = useMutation({
    mutationFn: async (): Promise<Cliente> => {
      // 1. Insert cliente
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

      // 2. Insert client_agents para cada agente activado
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
      qc.invalidateQueries({ queryKey: ["latest-runs"] });
      navigate(`/cliente/${cliente.slug}`);
    },
  });

  const canSubmit =
    form.nombre.trim().length > 0 &&
    form.slug.trim().length > 0 &&
    !crear.isPending;

  return (
    <div className="max-w-3xl">
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link> · Nuevo cliente
      </div>
      <h1 className="font-serif text-3xl mb-1">Nuevo cliente</h1>
      <p className="text-xs text-dim mb-6">
        Solo crea el registro en la base de datos. Las credenciales del agente
        (Google OAuth, Drive, Sheet) van en env vars del sitio Netlify dedicado
        del cliente — ver{" "}
        <code className="text-ink">docs/MANUAL-AGREGAR-CLIENTE.md</code>.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) crear.mutate();
        }}
        className="space-y-5"
      >
        <section className="card space-y-4">
          <div>
            <label className="label block mb-1">Nombre *</label>
            <input
              type="text"
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              className="w-full border border-edge rounded px-3 py-2 bg-white text-sm"
              placeholder="Ej: Clínica San Lucas"
              required
            />
          </div>

          <div>
            <label className="label block mb-1">Slug *</label>
            <input
              type="text"
              value={form.slug}
              onChange={(e) =>
                setForm({ ...form, slug: e.target.value, slugTouched: true })
              }
              className="w-full border border-edge rounded px-3 py-2 bg-white text-sm font-mono"
              placeholder="clinica-san-lucas"
              required
            />
            <p className="text-[10px] text-muted mt-1">
              Identificador URL-friendly. Auto-generado del nombre, editable.
              Aparece en la URL del cliente (<code>/cliente/&lt;slug&gt;</code>).
            </p>
          </div>

          <div>
            <label className="label block mb-1">Notas (opcional)</label>
            <textarea
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
              className="w-full border border-edge rounded px-3 py-2 bg-white text-sm h-20"
              placeholder="Ej: Onboarded 2026-05-06. Sitio Netlify: equipodegentes-cron-clinicaxyz."
            />
          </div>
        </section>

        <section className="card">
          <div className="label mb-3">Agentes a activar</div>
          {!agentes && (
            <p className="text-xs text-muted">Cargando agentes…</p>
          )}
          {agentes &&
            agentes.map((a) => {
              const act = form.activaciones[a.id];
              if (!act) return null;
              return (
                <div
                  key={a.id}
                  className="border-b border-edge pb-3 mb-3 last:border-b-0 last:pb-0 last:mb-0"
                >
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <input
                      type="checkbox"
                      checked={act.activo}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          activaciones: {
                            ...form.activaciones,
                            [a.id]: { ...act, activo: e.target.checked },
                          },
                        })
                      }
                    />
                    <span className="font-semibold">{a.nombre}</span>
                    {a.descripcion && (
                      <span className="text-xs text-muted">— {a.descripcion}</span>
                    )}
                  </label>

                  {act.activo && (
                    <div className="ml-6 grid grid-cols-2 gap-3 mt-2">
                      <ConfigField
                        label="Sheet ID (Google Sheets)"
                        value={act.config.sheet_id}
                        onChange={(v) =>
                          updateConfig(form, setForm, a.id, "sheet_id", v)
                        }
                        placeholder="1aB2cD..."
                      />
                      <ConfigField
                        label="Drive folder ID"
                        value={act.config.drive_folder}
                        onChange={(v) =>
                          updateConfig(form, setForm, a.id, "drive_folder", v)
                        }
                        placeholder="1xY2zA..."
                      />
                      <ConfigField
                        label="Email destino del resumen"
                        value={act.config.notify_email}
                        onChange={(v) =>
                          updateConfig(form, setForm, a.id, "notify_email", v)
                        }
                        placeholder="cliente@empresa.co"
                        type="email"
                      />
                      <ConfigField
                        label="Sitio Netlify del cron"
                        value={act.config.netlify_site}
                        onChange={(v) =>
                          updateConfig(form, setForm, a.id, "netlify_site", v)
                        }
                        placeholder="equipodegentes-cron-cliente"
                      />
                    </div>
                  )}
                </div>
              );
            })}
        </section>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="bg-accent text-paper px-5 py-2 rounded text-xs uppercase tracking-wider font-semibold disabled:opacity-50"
          >
            {crear.isPending ? "Creando…" : "Crear cliente"}
          </button>
          <Link to="/" className="text-xs text-muted hover:text-ink">
            Cancelar
          </Link>
          {crear.isError && (
            <span className="text-xs text-fail">
              Error: {(crear.error as Error)?.message ?? "desconocido"}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function ConfigField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="label block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-edge rounded px-2 py-1 bg-white text-xs font-mono"
      />
    </div>
  );
}

function updateConfig(
  form: FormState,
  setForm: (f: FormState) => void,
  agenteId: string,
  field: keyof ActivacionForm["config"],
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
