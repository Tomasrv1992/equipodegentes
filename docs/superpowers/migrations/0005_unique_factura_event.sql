-- Migration 0005: UNIQUE constraint para agent_events tipo factura_procesada
--
-- Problema: emitFacturaEvents hace insert simple sin restricción. Si por algún
-- motivo el cron reprocesa la misma factura (Gmail label removido manualmente,
-- replay manual del backfill, etc), se duplica el event. KPIs del panel cuentan
-- 2 facturas distintas cuando son la misma.
--
-- Fix: índice único parcial sobre (cliente_id, agente_id, numero, nit) cuando
-- tipo='factura_procesada' y numero/nit están presentes. Permite null/vacío
-- para events de otros tipos (cartera, etc) que no tienen esos campos.

create unique index if not exists agent_events_factura_unique
on public.agent_events (
  cliente_id,
  agente_id,
  (payload->>'numero'),
  (payload->>'nit')
)
where tipo = 'factura_procesada'
  and payload->>'numero' is not null
  and payload->>'numero' <> ''
  and payload->>'nit' is not null
  and payload->>'nit' <> '';
