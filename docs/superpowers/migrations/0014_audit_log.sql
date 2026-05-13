-- Migration 0014: audit_log inmutable
--
-- Registra cada acción destructiva/correctiva de los agentes para auditoría
-- y eventual rollback. Pensado para responder preguntas como:
--   - "¿Quién borró la fila X del Sheet del cliente Y?"
--   - "¿Por qué se marcó esta factura como REVISAR-BASURA?"
--   - "¿Qué retriggers disparó el supervisor en los últimos 7 días?"
--
-- Las filas NUNCA se actualizan ni borran (append-only).

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz default now() not null,
  agente_id text not null,
  cliente_id uuid references public.clientes(id) on delete set null,
  cliente_slug text,
  -- Acción tipo enum-string. Valores conocidos:
  --   limpiador.borrar_fila_duplicada
  --   limpiador.marcar_basura
  --   limpiador.mover_pdf_papelera
  --   limpiador.mover_pdf_revisar_manual
  --   limpiador.auto_reparar_fila
  --   reparador.insertar_fila_faltante
  --   reparador.actualizar_link_pdf
  --   supervisor.retrigger_agente
  --   supervisor.escalar_intervencion_humana
  --   procesador.skip_factura_invalida
  accion text not null,
  -- Snapshot de datos antes y después (para rollback)
  datos_antes jsonb,
  datos_despues jsonb,
  -- Detalles libres (motivo, contexto)
  motivo text,
  detalles jsonb
);

create index if not exists idx_audit_log_ts on public.audit_log(ts desc);
create index if not exists idx_audit_log_cliente on public.audit_log(cliente_id);
create index if not exists idx_audit_log_agente on public.audit_log(agente_id);
create index if not exists idx_audit_log_accion on public.audit_log(accion);

comment on table public.audit_log is
  'Log inmutable de acciones destructivas/correctivas de los agentes. Append-only.';

-- RLS: solo service_role puede leer/escribir (los agentes usan service_role).
alter table public.audit_log enable row level security;

drop policy if exists "service_role_full_access" on public.audit_log;
create policy "service_role_full_access" on public.audit_log
  for all to service_role
  using (true)
  with check (true);

-- Helper: contar retriggers de un cliente HOY (anti-loop)
create or replace function public.count_retriggers_hoy(
  p_cliente_slug text,
  p_agente_id text default null
) returns integer
language sql
stable
as $$
  select count(*)::integer
  from public.audit_log
  where cliente_slug = p_cliente_slug
    and accion = 'supervisor.retrigger_agente'
    and (p_agente_id is null or detalles->>'agente_destino' = p_agente_id)
    and ts >= date_trunc('day', now() at time zone 'America/Bogota');
$$;

comment on function public.count_retriggers_hoy is
  'Cuenta cuántas veces el supervisor ya retriggeó un agente para un cliente HOY (zona Bogotá). Para anti-loop.';
