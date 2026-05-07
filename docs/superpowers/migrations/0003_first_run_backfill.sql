-- 0003_first_run_backfill.sql
--
-- Agrega flag `first_run_done` a client_credentials para que el primer run
-- de un cliente recién onboardeado haga BACKFILL de las facturas del año
-- (window 365d) en vez del default 30d.
--
-- Flujo:
--   1. Cliente completa onboarding OAuth → first_run_done = false (default)
--   2. Primer cron / disparo manual → window = 365d → procesa todo el histórico
--   3. Tras run OK → first_run_done = true
--   4. Crons subsecuentes → window = 30d normal
--
-- IDEMPOTENTE: se puede correr varias veces.

alter table public.client_credentials
  add column if not exists first_run_done boolean not null default false;

comment on column public.client_credentials.first_run_done is
  'false → próximo run usa window=365d (backfill). true → window=30d normal. Se marca true tras primer run OK.';

-- Asegurar que el RPC client_credentials_load devuelve también este campo.
-- Re-creamos la función (or replace) con la columna nueva.

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
  updated_at timestamptz,
  first_run_done boolean
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
    cc.updated_at,
    cc.first_run_done
  from public.client_credentials cc
  where cc.cliente_id = p_cliente_id
    and cc.agente_id = p_agente_id
  limit 1;
$$;

revoke execute on function public.client_credentials_load(uuid, text, text) from public, anon, authenticated;

-- ===== RPC para marcar first_run_done después de un run OK =====
create or replace function public.client_credentials_mark_first_run_done(
  p_cliente_id uuid,
  p_agente_id text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.client_credentials
  set first_run_done = true
  where cliente_id = p_cliente_id
    and agente_id = p_agente_id;
$$;

revoke execute on function public.client_credentials_mark_first_run_done(uuid, text) from public, anon, authenticated;
