-- 0002_client_credentials_and_onboarding.sql
--
-- Multi-tenant OAuth: cada cliente tiene credenciales propias para que
-- Operatto procese su Gmail/Drive/Sheets en su nombre.
--
-- - `client_credentials`: refresh_token Google encriptado + recursos del cliente
-- - `onboarding_tokens`: tokens únicos para el flujo de onboarding web
--
-- Asume que la migración 0001 (init) ya corrió y existen public.clientes /
-- public.agentes / public.client_agents.

-- ===== Extension pgcrypto =====
-- Necesaria para pgp_sym_encrypt / pgp_sym_decrypt (cifrado simétrico de
-- refresh tokens). Supabase ya viene con pgcrypto disponible.
create extension if not exists pgcrypto;

-- ===== Tabla: client_credentials =====
-- Una fila por (cliente, agente). Guarda el refresh_token de Google
-- encriptado + los recursos que el cliente eligió durante onboarding.

create table public.client_credentials (
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  agente_id text not null references public.agentes(id),

  -- Google OAuth (refresh_token encriptado con pgcrypto + key en env var)
  google_refresh_token_encrypted bytea,
  google_oauth_status text not null default 'pending'
    check (google_oauth_status in ('pending', 'connected', 'expired', 'revoked')),
  google_email text,                  -- email Google del cliente (info; no auth)
  google_scopes text[],               -- scopes autorizados (para verificar)

  -- Recursos elegidos por el cliente durante onboarding
  drive_folder_id text,
  drive_folder_name text,             -- ej "Facturas 2026"
  sheet_id text,
  sheet_name text,                    -- nombre legible del Sheet
  sheet_tab text not null default 'Gastos 2026',

  -- Notificaciones (a dónde llega el resumen diario)
  notify_email text,

  -- Timestamps
  onboarded_at timestamptz,
  last_oauth_refresh timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (cliente_id, agente_id)
);

create index client_credentials_status_idx
  on public.client_credentials (google_oauth_status)
  where google_oauth_status in ('expired', 'revoked');

-- Trigger para updated_at automático
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger client_credentials_touch_updated_at
  before update on public.client_credentials
  for each row execute function public.touch_updated_at();

-- ===== Tabla: onboarding_tokens =====
-- Tokens únicos URL-safe que Tomás manda al cliente para que complete
-- el onboarding sin tener que loguear con Supabase.

create table public.onboarding_tokens (
  token text primary key,            -- 32 chars random URL-safe
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  agente_id text not null references public.agentes(id),

  -- Estado del flujo de onboarding
  step text not null default 'pending'
    check (step in ('pending', 'oauth_done', 'resources_done', 'completed', 'expired')),

  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  completed_at timestamptz,

  -- Quién lo creó (Tomás siempre, pero queda registro)
  created_by text
);

create index onboarding_tokens_cliente_idx
  on public.onboarding_tokens (cliente_id, agente_id);

create index onboarding_tokens_expires_idx
  on public.onboarding_tokens (expires_at)
  where step != 'completed';

-- ===== RLS =====
-- Lectura/escritura solo para Tomás. Service role bypassea (lo usan las
-- edge functions de OAuth callback y el cron).

alter table public.client_credentials enable row level security;
alter table public.onboarding_tokens  enable row level security;

create policy "tomas_only" on public.client_credentials
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on public.onboarding_tokens
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');

-- ===== Helper RPC: validar token público (sin RLS) =====
-- Las edge functions del flujo de onboarding usan este RPC con anon key
-- para validar tokens sin exponer el resto de la tabla.

create or replace function public.onboarding_token_lookup(p_token text)
returns table (
  cliente_id uuid,
  cliente_nombre text,
  cliente_slug text,
  agente_id text,
  agente_nombre text,
  step text,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    ot.cliente_id,
    c.nombre as cliente_nombre,
    c.slug as cliente_slug,
    ot.agente_id,
    a.nombre as agente_nombre,
    ot.step,
    ot.expires_at
  from public.onboarding_tokens ot
  join public.clientes c on c.id = ot.cliente_id
  join public.agentes a on a.id = ot.agente_id
  where ot.token = p_token
    and ot.expires_at > now()
    and ot.step != 'completed';
$$;

-- Permitir que el rol anon llame al RPC (sin exponer la tabla completa)
grant execute on function public.onboarding_token_lookup(text) to anon, authenticated;

-- ===== RPCs internos: cifrado/descifrado de refresh_token =====
-- Encapsulan pgp_sym_encrypt/decrypt para que el código TS no tenga que
-- pasar la key en el SELECT/UPDATE plano. La key viaja como parámetro y
-- queda dentro del plan de query (no se persiste).

-- Nota: en Supabase, pgcrypto vive en el schema 'extensions'.
-- search_path incluye 'extensions' para resolver pgp_sym_encrypt/decrypt sin prefix.
create or replace function public.client_credentials_save_oauth(
  p_cliente_id uuid,
  p_agente_id text,
  p_refresh_token text,
  p_google_email text,
  p_scopes text[],
  p_vault_key text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.client_credentials (
    cliente_id, agente_id,
    google_refresh_token_encrypted,
    google_oauth_status,
    google_email, google_scopes,
    last_oauth_refresh
  ) values (
    p_cliente_id, p_agente_id,
    extensions.pgp_sym_encrypt(p_refresh_token, p_vault_key),
    'connected',
    p_google_email, p_scopes,
    now()
  )
  on conflict (cliente_id, agente_id) do update set
    google_refresh_token_encrypted = excluded.google_refresh_token_encrypted,
    google_oauth_status = 'connected',
    google_email = coalesce(excluded.google_email, public.client_credentials.google_email),
    google_scopes = coalesce(excluded.google_scopes, public.client_credentials.google_scopes),
    last_oauth_refresh = now();
end;
$$;

create or replace function public.client_credentials_load(
  p_cliente_id uuid,
  p_agente_id text,
  p_vault_key text
)
returns table (
  cliente_id uuid,
  agente_id text,
  google_refresh_token text,
  google_oauth_status text,
  google_email text,
  google_scopes text[],
  drive_folder_id text,
  drive_folder_name text,
  sheet_id text,
  sheet_name text,
  sheet_tab text,
  notify_email text,
  onboarded_at timestamptz,
  last_oauth_refresh timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public, extensions
as $$
  select
    cc.cliente_id,
    cc.agente_id,
    case
      when cc.google_refresh_token_encrypted is null then null
      else extensions.pgp_sym_decrypt(cc.google_refresh_token_encrypted, p_vault_key)::text
    end as google_refresh_token,
    cc.google_oauth_status,
    cc.google_email,
    cc.google_scopes,
    cc.drive_folder_id,
    cc.drive_folder_name,
    cc.sheet_id,
    cc.sheet_name,
    cc.sheet_tab,
    cc.notify_email,
    cc.onboarded_at,
    cc.last_oauth_refresh,
    cc.created_at,
    cc.updated_at
  from public.client_credentials cc
  where cc.cliente_id = p_cliente_id
    and cc.agente_id = p_agente_id
  limit 1;
$$;

-- Estos RPCs solo los puede llamar service_role (el código TS server-side
-- los invoca con esa key). NO los exponemos a anon/authenticated.
revoke execute on function public.client_credentials_save_oauth(uuid, text, text, text, text[], text) from public, anon, authenticated;
revoke execute on function public.client_credentials_load(uuid, text, text) from public, anon, authenticated;
