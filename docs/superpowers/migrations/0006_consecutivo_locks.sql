-- Migración 0006: lock distribuido para consecutivo de facturas por cliente/mes
--
-- Contexto: el contador `getNextConsecutivo` del pipeline vive en memoria
-- (Map per-run). Cuando corren DOS chunks paralelos del mismo cliente
-- (ej: recovery con stagger corto), cada uno tiene SU propio counter y
-- pueden asignar el mismo número consecutivo a facturas distintas.
--
-- Esta tabla + RPC garantiza atomicidad entre chunks: la columna A del
-- Sheet (#) siempre queda con valores únicos consecutivos sin colisiones.
--
-- Idempotente: si la tabla ya existe, CREATE IF NOT EXISTS no falla.
-- El RPC se redefine cada vez con CREATE OR REPLACE.

create table if not exists invoice_consecutivo_locks (
  cliente_slug  text not null,
  tab_name      text not null,
  consecutivo   integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (cliente_slug, tab_name)
);

-- RPC atómico: incrementa el counter y devuelve el nuevo valor.
-- INSERT...ON CONFLICT con returning garantiza atomicidad row-level lock
-- aún con N workers concurrentes.
create or replace function get_next_consecutivo(
  p_cliente_slug text,
  p_tab_name     text
) returns integer
language plpgsql
as $$
declare
  v_next integer;
begin
  insert into invoice_consecutivo_locks (cliente_slug, tab_name, consecutivo)
  values (p_cliente_slug, p_tab_name, 1)
  on conflict (cliente_slug, tab_name)
  do update set
    consecutivo = invoice_consecutivo_locks.consecutivo + 1,
    updated_at  = now()
  returning consecutivo into v_next;

  return v_next;
end;
$$;
