-- 0018_facturas_registro_dedupe.sql
--
-- Dedup de facturas a nivel BASE DE DATOS (constraint UNIQUE), no solo a nivel app.
--
-- Contexto — incidente de duplicación masiva mayo 2026 (cliente Freshco):
--   Un deploy legacy "zombie" en Netlify siguió escribiendo al Google Sheet en
--   paralelo al pipeline nuevo. La guarda de aplicación (safeAppendToSheet, que
--   lee el Sheet antes de insertar) NO lo frenó porque el zombie corría su propio
--   código con el cache de lectura contaminado. Resultado: 1.088 facturas reales
--   se inflaron a 52.000+ filas físicas en el Sheet.
--
-- Esta tabla traslada la deduplicación a la BD: el UNIQUE (cliente_id, dedupe_key)
-- hace FÍSICAMENTE IMPOSIBLE registrar dos veces la misma factura, sin importar
-- qué código (o deploy zombie) intente escribirla. El Google Sheet pasa a ser una
-- proyección; esta tabla es la fuente de verdad de "qué facturas ya se procesaron".
--
-- safeAppendToSheet se mantiene como SEGUNDA línea de defensa.

create table if not exists facturas_registro (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references clientes(id) on delete cascade,
  dedupe_key       text not null,
  cufe             text,                      -- nullable, solo facturas DIAN
  gmail_message_id text not null,
  numero_documento text,
  fecha_factura    date,
  proveedor_nit    text,
  total            numeric,
  origen           text not null default 'pipeline',  -- 'pipeline' | 'backfill'
  created_at       timestamptz not null default now(),
  constraint facturas_registro_cliente_dedupe_unique unique (cliente_id, dedupe_key)
);

-- Índice adicional para lookups/auditoría por email de origen.
create index if not exists idx_facturas_registro_cliente_gmail
  on facturas_registro (cliente_id, gmail_message_id);

comment on table facturas_registro is
  'Fuente de verdad de qué facturas ya fueron procesadas. El UNIQUE (cliente_id, dedupe_key) hace físicamente imposible duplicar una factura, sin importar qué código intente escribirla. Creada tras el incidente de duplicación masiva de mayo 2026 (Freshco: 1.088 facturas reales -> 52.000+ filas en el Sheet por un deploy zombie en Netlify). El Google Sheet pasa a ser una proyección de esta tabla; safeAppendToSheet queda como segunda línea de defensa.';

comment on column facturas_registro.dedupe_key is
  'Clave de deduplicación por cliente. CUFE si es factura electrónica DIAN (identificador único oficial); gmail_message_id si es un documento no-DIAN (planilla SS, cuenta de cobro, recibo PDF). El UNIQUE es sobre (cliente_id, dedupe_key).';

comment on column facturas_registro.origen is
  'Cómo entró el registro: ''pipeline'' (procesamiento normal en vivo) o ''backfill'' (carga histórica desde agent_events vía backfill-facturas-registro).';
