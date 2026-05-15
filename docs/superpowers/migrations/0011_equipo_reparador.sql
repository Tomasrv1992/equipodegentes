-- Migration 0011: registrar el agente "Equipo-reparador"
--
-- Agente del operador (Tomás) que detecta y corrige discrepancias entre
-- agent_events (DB) / Sheet (Google) / Drive (Google).
--
-- Corre todos los días a las 8:15am Bogotá (15 min después del monitor).
--
-- Etapa 1 (auto-repara): inserta filas faltantes en Sheet desde agent_events.
-- Etapa 2 (detecta + reporta): PDFs huérfanos en Drive y filas sin PDF.

-- Cliente sintético para registrar runs del reparador
insert into public.clientes (slug, nombre, activo, notas)
values (
  'reparador',
  'Operatto Reparador (interno)',
  false,
  'Cliente sintético para runs del agente Equipo-reparador. NO es un cliente real.'
)
on conflict (slug) do update
  set nombre = excluded.nombre,
      activo = false,
      notas = excluded.notas;

-- Registrar el agente reparador
insert into public.agentes (id, nombre, descripcion, activo)
values (
  'reparador',
  'Equipo-reparador',
  'Detecta y auto-repara discrepancias entre agent_events, Sheet y Drive. Inserta filas faltantes en Sheet desde el log de events. Reporta huérfanos para revisión manual. Corre 8:15am Bogotá.',
  true
)
on conflict (id) do update
  set nombre = excluded.nombre,
      descripcion = excluded.descripcion,
      activo = excluded.activo;

-- Activar el agente "reparador" para el cliente sintético "reparador"
insert into public.client_agents (cliente_id, agente_id, activo)
select c.id, 'reparador', true
from public.clientes c
where c.slug = 'reparador'
on conflict (cliente_id, agente_id) do update
  set activo = true;
