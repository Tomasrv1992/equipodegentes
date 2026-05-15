-- 0001_init_equipodegentes.sql
-- Crea las tablas del panel admin en el proyecto Supabase DEDICADO de equipodegentes.
-- (Proyecto independiente, separado de consultoria-app — no se usa schema custom,
-- todo vive en `public` del proyecto nuevo.)

-- ===== Tablas =====

create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  slug text unique not null,
  activo boolean not null default true,
  notas text,
  created_at timestamptz not null default now()
);

create table public.agentes (
  id text primary key,
  nombre text not null,
  descripcion text,
  cron_default text,
  activo boolean not null default true
);

create table public.client_agents (
  cliente_id uuid references public.clientes(id) on delete cascade,
  agente_id text references public.agentes(id) on delete cascade,
  activo boolean not null default true,
  config jsonb not null default '{}',
  activated_at timestamptz not null default now(),
  primary key (cliente_id, agente_id)
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id),
  agente_id text not null references public.agentes(id),
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
  on public.agent_runs (started_at desc);
create index agent_runs_cliente_agente_started_idx
  on public.agent_runs (cliente_id, agente_id, started_at desc);
create index agent_runs_problem_idx
  on public.agent_runs (status)
  where status in ('fail','warn');

create table public.agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  cliente_id uuid not null references public.clientes(id),
  agente_id text not null references public.agentes(id),
  tipo text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index agent_events_run_idx on public.agent_events (run_id);
create index agent_events_cliente_agente_idx
  on public.agent_events (cliente_id, agente_id, created_at desc);

-- ===== RLS =====

alter table public.clientes        enable row level security;
alter table public.agentes         enable row level security;
alter table public.client_agents   enable row level security;
alter table public.agent_runs      enable row level security;
alter table public.agent_events    enable row level security;

-- Policy única: solo el email whitelisted puede leer/escribir.
-- Service role key (que usan los agentes desde Netlify) bypassea RLS.
create policy "tomas_only" on public.clientes
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on public.agentes
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on public.client_agents
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on public.agent_runs
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on public.agent_events
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');

-- ===== Seed de catálogo =====

insert into public.agentes (id, nombre, descripcion, cron_default, activo) values
  ('facturacion', 'Equipo-facturación',
   'Pipeline DIAN: Gmail → Drive → Sheets',
   '0 12 * * *', true),
  ('cartera',     'Equipo-cartera',
   'Agente cobrador con Claude (MVP local)',
   null, true);

-- Seed de clientes mínimo (los reemplazas con UPDATE después).
insert into public.clientes (nombre, slug) values
  ('Owner (Tomás)', 'owner');

-- Activamos facturación para el owner (caso single-tenant actual).
insert into public.client_agents (cliente_id, agente_id, config)
select c.id, 'facturacion', '{"sheet_id":"placeholder","drive_folder":"placeholder"}'::jsonb
from public.clientes c where c.slug = 'owner';
