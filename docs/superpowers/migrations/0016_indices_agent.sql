-- 0016_indices_agent.sql
-- Indices para acelerar inspect-* y reconcile-labels.
--
-- Causa: agent_runs y agent_events crecieron a miles de rows × N clientes.
-- Queries sin index timeoutean a 30s en endpoints sync de Netlify.
--
-- ⚠️ IMPORTANTE: NO aplicar vía migration runner.
-- `CREATE INDEX CONCURRENTLY` NO corre dentro de transacción.
-- Ejecutar UNO POR UNO en Supabase SQL Editor.
-- El runner NO va a registrar esta migration como aplicada — eso está OK,
-- está documentado acá para referencia futura.

create index concurrently if not exists idx_agent_runs_cliente_agente_started
  on agent_runs (cliente_id, agente_id, started_at desc);

create index concurrently if not exists idx_agent_events_cliente_type_created
  on agent_events (cliente_id, tipo, created_at desc);
