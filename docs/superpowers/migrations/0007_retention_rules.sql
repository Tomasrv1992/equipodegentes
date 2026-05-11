-- Migration 0007: reglas de retención por cliente
--
-- Permite que cada cliente tenga su propia configuración de retenciones fiscales
-- (RTF, IVA, ICA) según sus responsabilidades tributarias en Colombia.
--
-- Diseño:
--   - `retention_rules` (jsonb): configuración flexible
--       {
--         version: 1,
--         es_agente_retenedor: { reteFuente, reteIva, reteIca },
--         aplicar_de_oficio: { rtf_si_xml_vacio, ica_si_xml_vacio },
--         overrides_por_nit: { "NIT": { exento_rtf, ... } },
--         notas: string
--       }
--   - `municipio_ica` (text): separado del jsonb para facilitar queries.
--     Valores: BOGOTA | MEDELLIN | CALI | BARRANQUILLA | BUCARAMANGA |
--              CARTAGENA | PEREIRA | MANIZALES | OTRO | null
--
-- Lógica del engine en pipeline:
--   1. XML del proveedor trae retención → confiar (es la fuente oficial)
--   2. XML vacío + cliente es agente retenedor + aplicar_de_oficio=true
--      → calcular según categoría (RTF) o municipio (ICA) + umbral UVT
--   3. Override por NIT (proveedor exento) gana sobre todo

alter table public.client_credentials
  add column if not exists retention_rules jsonb
    default '{
      "version": 1,
      "es_agente_retenedor": {
        "reteFuente": true,
        "reteIva": false,
        "reteIca": false
      },
      "aplicar_de_oficio": {
        "rtf_si_xml_vacio": true,
        "ica_si_xml_vacio": false
      },
      "overrides_por_nit": {},
      "notas": "Configuración inicial por defecto - revisar en el wizard de onboarding"
    }'::jsonb,
  add column if not exists municipio_ica text default null;

comment on column public.client_credentials.retention_rules is
  'Reglas de retención fiscal por cliente. Schema versionado (version=1).';

comment on column public.client_credentials.municipio_ica is
  'Municipio donde el cliente paga ICA. Determina la tarifa cuando se aplica de oficio.';

-- Aplicar default sensato a clientes existentes (Patricia, Mateo, tomas92, Java, Andres)
-- que tienen credenciales pero todavía no tienen retention_rules
update public.client_credentials
set retention_rules = '{
  "version": 1,
  "es_agente_retenedor": {
    "reteFuente": true,
    "reteIva": false,
    "reteIca": false
  },
  "aplicar_de_oficio": {
    "rtf_si_xml_vacio": true,
    "ica_si_xml_vacio": false
  },
  "overrides_por_nit": {},
  "notas": "Default por migración 0007 - revisar y ajustar por cliente"
}'::jsonb
where retention_rules is null;

-- Actualizar el RPC client_credentials_load para incluir los nuevos campos
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
  municipio_ica text
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
    cc.municipio_ica
  from public.client_credentials cc
  where cc.cliente_id = p_cliente_id
    and cc.agente_id = p_agente_id;
$$;

grant execute on function public.client_credentials_load(uuid, text, text) to anon, authenticated;
