-- Migration 0006: migrar owner (Tomás) a cliente multi-tenant
--
-- Problema: el owner usa modo legacy single-tenant, no tiene fila en
-- client_credentials. El panel admin lo muestra como "Sin credenciales OAuth"
-- con todos los campos en placeholder.
--
-- Fix: insertar fila en client_credentials con:
--   - refresh_token cifrado (del .env.local legacy)
--   - sheet_id, drive_folder_id de los recursos legacy
--   - notify_email = tomasramirezvilla@gmail.com
--   - first_run_done = true (ya tiene historia de runs, no hace falta backfill 2026)
--   - google_oauth_status = 'connected'
--
-- Ejecutar este SQL en Supabase SQL Editor REEMPLAZANDO los valores TODO con los reales.
-- IMPORTANTE: el refresh token es sensible — esta query NO debe quedar en logs.
-- Después de correrla, eliminar el SQL de la pestaña del editor.

-- Paso 1: Asegurar que existe el cliente "owner" en clientes
insert into public.clientes (slug, nombre, activo, notas)
values ('owner', 'Owner (Tomás)', true, 'Cliente legacy migrado a multi-tenant 2026-05-08')
on conflict (slug) do update
  set nombre = excluded.nombre,
      activo = true;

-- Paso 2: Asegurar que existe la activación del agente facturacion
insert into public.client_agents (cliente_id, agente_id, activo, config)
select id, 'facturacion', true,
  jsonb_build_object(
    'sheet_id', '1dwCu-1ooeyOC5PEd2lBIhua4zUmC5ymymQ6X0O4zcMU',
    'drive_folder', '1ksS7gwlT8OYmMh4Eh2WiIQGNwkERdti2',
    'notify_email', 'tomasramirezvilla@gmail.com',
    'netlify_site', 'equipodegentes-cron'
  )
from public.clientes
where slug = 'owner'
on conflict (cliente_id, agente_id) do update
  set activo = true,
      config = excluded.config;

-- Paso 3: Crear fila en client_credentials con OAuth tokens cifrados
-- IMPORTANTE: reemplazar 'TODO_REFRESH_TOKEN_AQUI' con tu GOOGLE_OAUTH_REFRESH_TOKEN
-- IMPORTANTE: reemplazar 'TODO_VAULT_KEY_AQUI' con tu CREDENTIALS_VAULT_KEY de Netlify

-- Esta llamada usa el RPC que ya tenemos para encriptar el refresh_token
-- antes de guardarlo en la tabla.
select public.client_credentials_save_oauth(
  p_cliente_id := (select id from clientes where slug = 'owner'),
  p_agente_id := 'facturacion',
  p_refresh_token := 'TODO_REFRESH_TOKEN_AQUI',
  p_google_email := 'tomasramirezvilla@gmail.com',
  p_scopes := array[
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email'
  ],
  p_vault_key := 'TODO_VAULT_KEY_AQUI'
);

-- Paso 4: Completar los recursos (sheet_id, drive_folder_id) y marcar first_run_done
update public.client_credentials
set
  drive_folder_id = '1ksS7gwlT8OYmMh4Eh2WiIQGNwkERdti2',
  drive_folder_name = 'Facturas (legacy)',
  sheet_id = '1dwCu-1ooeyOC5PEd2lBIhua4zUmC5ymymQ6X0O4zcMU',
  sheet_name = 'Control Facturas (legacy)',
  sheet_tab = 'Gastos 2026',
  notify_email = 'tomasramirezvilla@gmail.com',
  first_run_done = true,  -- ya tiene historia, no necesita backfill 2026
  onboarded_at = now()
where cliente_id = (select id from clientes where slug = 'owner')
  and agente_id = 'facturacion';

-- Verificar que quedó bien
select
  c.slug,
  c.nombre,
  cred.google_email,
  cred.google_oauth_status,
  cred.sheet_id,
  cred.drive_folder_id,
  cred.first_run_done
from public.clientes c
join public.client_credentials cred on cred.cliente_id = c.id
where c.slug = 'owner';
