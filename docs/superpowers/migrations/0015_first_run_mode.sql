-- 0015_first_run_mode.sql
--
-- Agrega `first_run_mode` a client_credentials para permitirle al cliente
-- elegir durante el wizard fiscal si quiere:
--
--   'rapido'   → procesa solo los últimos 30 días en 1 invocación (~3 min).
--                Le entrega valor inmediato y le permite ver el panel con
--                contenido REAL antes de comprometerse al backfill anual.
--
--   'completo' → procesa el año entero con multi-pass (5-12 meses paralelos).
--                Más completo, más lento (~15-25 min según volumen).
--
-- Default 'completo' para preservar el comportamiento existente. Wizard nuevo
-- presentará la elección con 'rapido' como default sugerido (mejor UX).
--
-- IDEMPOTENTE.

alter table public.client_credentials
  add column if not exists first_run_mode text
    not null
    default 'completo'
    check (first_run_mode in ('rapido', 'completo'));

comment on column public.client_credentials.first_run_mode is
  '''rapido'' (last 30d, 1 invoc) o ''completo'' (año, multi-pass). Set en wizard fiscal.';

-- Asegurar que client_credentials_load devuelve este campo.
drop function if exists public.client_credentials_load(uuid, text, text);

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
  first_run_done boolean,
  first_run_mode text,
  retention_rules jsonb,
  municipio_ica text,
  nit_cliente text
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
    cc.first_run_done,
    cc.first_run_mode,
    cc.retention_rules,
    cc.municipio_ica,
    cc.nit_cliente
  from public.client_credentials cc
  where cc.cliente_id = p_cliente_id
    and cc.agente_id = p_agente_id
  limit 1;
$$;

-- Permisos: anon/authenticated pueden ejecutar (RPC desde edge functions).
-- El security definer encapsula el acceso real a credenciales encriptadas.
revoke execute on function public.client_credentials_load(uuid, text, text) from public;
grant execute on function public.client_credentials_load(uuid, text, text) to anon, authenticated;
