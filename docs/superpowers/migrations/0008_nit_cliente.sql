-- Migration 0008: agregar nit_cliente a client_credentials
--
-- Permite identificar facturas DIAN DONDE EL CLIENTE ES EL EMISOR (cuentas
-- de cobro que él emite a sus clientes) y descartarlas — sino se cuelan
-- como gastos en el Sheet con su propio nombre como "proveedor".
--
-- Comparación: AccountingSupplierParty.NIT === nit_cliente → skip.
--
-- También se usa en el sub-pipeline LLM (Word/PDF) como contexto para que
-- el modelo sepa "esto debe ser facturado a X, NIT Y".

alter table public.client_credentials
  add column if not exists nit_cliente text default null;

comment on column public.client_credentials.nit_cliente is
  'NIT o cédula del cliente. Usado para descartar facturas donde el cliente es el emisor (cuentas de cobro propias).';

-- Actualizar RPC client_credentials_load para incluir el nuevo campo
-- (drop + recreate porque cambia el return type)
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
      else extensions.pgp_sym_decrypt(cc.google_refresh_token_encrypted, p_vault_key)
    end as google_refresh_token,
    cc.google_oauth_status::text,
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
    cc.retention_rules,
    cc.municipio_ica,
    cc.nit_cliente
  from public.client_credentials cc
  where cc.cliente_id = p_cliente_id
    and cc.agente_id = p_agente_id;
$$;

grant execute on function public.client_credentials_load(uuid, text, text) to anon, authenticated;

-- Setear NIT/cédula de Tomás (cliente 'tomas' = tomasramirezvilla@gmail.com)
-- Cédula 1152197612 confirmada vía factura Marzzano del 9/5/2026.
update public.client_credentials
set nit_cliente = '1152197612'
where cliente_id = (select id from public.clientes where slug = 'tomas');

-- También aplicar a tomas92 si existe (misma persona, distinta cuenta Gmail).
update public.client_credentials
set nit_cliente = '1152197612'
where cliente_id = (select id from public.clientes where slug = 'tomas92');
