-- 0001_init_equipodegentes.sql
-- Crea todas las tablas del panel admin en el schema equipodegentes.
-- Asume que el schema ya existe (ver pre-tarea P1 del plan):
--   create schema if not exists equipodegentes;

-- ===== Tablas =====

create table equipodegentes.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  slug text unique not null,
  activo boolean not null default true,
  notas text,
  created_at timestamptz not null default now()
);

create table equipodegentes.agentes (
  id text primary key,
  nombre text not null,
  descripcion text,
  cron_default text,
  activo boolean not null default true
);

create table equipodegentes.client_agents (
  cliente_id uuid references equipodegentes.clientes(id) on delete cascade,
  agente_id text references equipodegentes.agentes(id) on delete cascade,
  activo boolean not null default true,
  config jsonb not null default '{}',
  activated_at timestamptz not null default now(),
  primary key (cliente_id, agente_id)
);

create table equipodegentes.agent_runs (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references equipodegentes.clientes(id),
  agente_id text not null references equipodegentes.agentes(id),
  status text not null check (status in ('running','ok','fail','warn')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int,
  triggered_by text not null default 'cron',
  summary text,
  payload jsonb,
  error_message text,
  error_stack text,
  netlify_log_url text
);

create index agent_runs_started_at_idx
  on equipodegentes.agent_runs (started_at desc);
create index agent_runs_cliente_agente_started_idx
  on equipodegentes.agent_runs (cliente_id, agente_id, started_at desc);
create index agent_runs_problem_idx
  on equipodegentes.agent_runs (status)
  where status in ('fail','warn');

create table equipodegentes.agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references equipodegentes.agent_runs(id) on delete cascade,
  cliente_id uuid not null references equipodegentes.clientes(id),
  agente_id text not null references equipodegentes.agentes(id),
  tipo text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index agent_events_run_idx on equipodegentes.agent_events (run_id);
create index agent_events_cliente_agente_idx
  on equipodegentes.agent_events (cliente_id, agente_id, created_at desc);

-- ===== RLS =====

alter table equipodegentes.clientes        enable row level security;
alter table equipodegentes.agentes         enable row level security;
alter table equipodegentes.client_agents   enable row level security;
alter table equipodegentes.agent_runs      enable row level security;
alter table equipodegentes.agent_events    enable row level security;

-- Policy única: solo el email whitelisted puede leer/escribir.
-- Service role key (que usan los agentes desde Netlify) bypassea RLS.
create policy "tomas_only" on equipodegentes.clientes
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.agentes
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.client_agents
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.agent_runs
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.agent_events
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');

-- ===== Seed de catálogo =====

insert into equipodegentes.agentes (id, nombre, descripcion, cron_default, activo) values
  ('facturacion', 'Equipo-facturación',
   'Pipeline DIAN: Gmail → Drive → Sheets',
   '0 12 * * *', true),
  ('cartera',     'Equipo-cartera',
   'Agente cobrador con Claude (MVP local)',
   null, true);

-- Seed de clientes mínimo (los reemplazas con UPDATE después).
insert into equipodegentes.clientes (nombre, slug) values
  ('Owner (Tomás)', 'owner');

-- Activamos facturación para el owner (caso single-tenant actual).
insert into equipodegentes.client_agents (cliente_id, agente_id, config)
select c.id, 'facturacion', '{"sheet_id":"placeholder","drive_folder":"placeholder"}'::jsonb
from equipodegentes.clientes c where c.slug = 'owner';
