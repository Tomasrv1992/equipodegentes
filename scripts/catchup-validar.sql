-- ============================================================================
-- Validación post-catchup — correr ~15-20 min después de catchup-clientes-rezagados.sh
-- ============================================================================
--
-- 4 queries en orden:
--   1. Status de los runs disparados (¿corrieron OK? ¿status warn/fail?)
--   2. Cobertura nueva por mes (antes vs después)
--   3. Error patterns: confirmar que el fix de reclasificación funcionó
--   4. Validación contra patrón de proveedor único (Freshco)


-- ----------------------------------------------------------------------------
-- Query 1: ¿Cómo terminaron los runs del catchup?
-- ----------------------------------------------------------------------------
select
  c.slug                                   as cliente,
  ar.payload->>'monthFilter'               as mes,
  ar.status,
  ar.summary,
  ar.duration_ms / 1000                    as duracion_seg,
  ar.payload->'procesadas'                 as procesadas,
  ar.payload->'saltadas'                   as saltadas,
  ar.payload->'errores'                    as errores,
  ar.payload->'error_pattern_breakdown'    as error_patterns,
  ar.payload->'skipped_pattern_breakdown'  as skipped_patterns
from agent_runs ar
join clientes c on c.id = ar.cliente_id
where ar.agente_id = 'facturacion'
  and ar.started_at >= now() - interval '2 hours'
  and (
       (c.slug = 'freshco'    and ar.payload->>'monthFilter' in ('1','2','3'))
    or (c.slug = 'dentilandia' and ar.payload->>'monthFilter' = '1')
    or (c.slug = 'andres'      and ar.payload->>'monthFilter' = '2')
  )
order by c.slug, (ar.payload->>'monthFilter')::int, ar.started_at desc;


-- ----------------------------------------------------------------------------
-- Query 2: Cobertura nueva por cliente×mes (vs el snapshot de hoy AM)
-- ----------------------------------------------------------------------------
-- Snapshot pre-catchup (referencia):
--   Freshco:     ene=350, feb=283, mar=253, abr=428, may=610  (total 1924)
--   Dentilandia: ene=60,  feb=175, mar=161, abr=162, may=65   (total 623)
--   Andres:      ene=40,  feb=10,  mar=39,  abr=35,  may=18   (total 142)
with f as (
  select
    c.slug as cliente,
    to_char((ae.payload->>'fecha')::date, 'YYYY-MM') as mes
  from agent_events ae
  join clientes c on c.id = ae.cliente_id
  where ae.agente_id = 'facturacion'
    and ae.tipo = 'factura_procesada'
    and (ae.payload->>'fecha')::date >= '2026-01-01'
    and (ae.payload->>'fecha')::date <  '2026-06-01'
    and c.slug in ('freshco', 'dentilandia', 'andres')
)
select
  cliente,
  count(*) filter (where mes = '2026-01') as ene,
  count(*) filter (where mes = '2026-02') as feb,
  count(*) filter (where mes = '2026-03') as mar,
  count(*) filter (where mes = '2026-04') as abr,
  count(*) filter (where mes = '2026-05') as may,
  count(*) as total
from f
group by cliente
order by cliente;


-- ----------------------------------------------------------------------------
-- Query 3: Distribución de patrones de error/skip (después del fix)
-- ----------------------------------------------------------------------------
-- Debería verse:
--   error_patterns: { 'real-llm-fail': N1, 'xml-parse': N2, ... } — pocos
--   skipped_patterns: { 'pdf-encrypted': MAYORÍA, 'pdf-no-text': X, ... }
--
-- Si el fix funcionó, "pdf-encrypted" ya no aparece en error_patterns sino
-- en skipped_patterns.
select
  c.slug as cliente,
  ar.payload->>'monthFilter' as mes,
  ar.status,
  ar.payload->'error_pattern_breakdown'   as errores_por_patron,
  ar.payload->'skipped_pattern_breakdown' as saltadas_por_motivo,
  jsonb_pretty(ar.payload->'sample_errors') as sample_errors
from agent_runs ar
join clientes c on c.id = ar.cliente_id
where ar.agente_id = 'facturacion'
  and ar.started_at >= now() - interval '2 hours'
  and c.slug in ('freshco', 'dentilandia', 'andres')
order by ar.started_at desc;


-- ----------------------------------------------------------------------------
-- Query 4: Validación Freshco — proveedor único debería tener cobertura completa
-- ----------------------------------------------------------------------------
-- Hipótesis: si COMERCIALIZADORA DE FRUTAS Y LEGUMBRES SAS factura ~60/día
-- hábil, debería tener:
--   ene = ~1320 (22 días hábiles), feb = ~1140, mar = ~1320, abr = ~1320, may = ~720
-- Total esperado: ~5820
select
  to_char((ae.payload->>'fecha')::date, 'YYYY-MM') as mes,
  count(*) as facturas,
  count(distinct (ae.payload->>'fecha')::date) as dias_con_facturas,
  round(count(*)::numeric / nullif(count(distinct (ae.payload->>'fecha')::date), 0), 1) as promedio_por_dia,
  round(sum((ae.payload->>'total')::numeric)) as monto_total
from agent_events ae
join clientes c on c.id = ae.cliente_id
where c.slug = 'freshco'
  and ae.agente_id = 'facturacion'
  and ae.tipo = 'factura_procesada'
  and ae.payload->>'proveedor' ilike '%FRUTAS Y LEGUMBRES%'
  and (ae.payload->>'fecha')::date >= '2026-01-01'
group by 1
order by 1;
