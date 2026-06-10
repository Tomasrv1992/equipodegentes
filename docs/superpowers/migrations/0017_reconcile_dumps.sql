-- 0017_reconcile_dumps.sql
-- Tabla para guardar before-state de reconcile-labels (rollback safety).
-- Cada corrida real (dryRun=false) guarda un dump con los labels actuales
-- ANTES de aplicar cambios, para que un rollback manual sea posible.
--
-- También: RPC set_event_message_id para backfill idempotente.

create table if not exists reconcile_dumps (
  id uuid primary key,
  cliente_id uuid not null references clientes(id) on delete cascade,
  year int not null,
  created_at timestamptz not null default now(),
  before_state jsonb not null
);

create index if not exists idx_reconcile_dumps_cliente_year_created
  on reconcile_dumps(cliente_id, year, created_at desc);

-- RPC para backfill: set payload.messageId de un event específico (idempotente).
-- Usado por backfill-messageid-background. No sobrescribe si ya existe messageId.
create or replace function set_event_message_id(
  p_event_id uuid,
  p_message_id text
) returns void
language plpgsql
security definer
as $$
begin
  update agent_events
  set payload = jsonb_set(payload, '{messageId}', to_jsonb(p_message_id), true)
  where id = p_event_id
    and (payload->>'messageId') is null;
end;
$$;
