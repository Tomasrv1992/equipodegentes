-- Migration 0013: registrar el agente "Equipo-supervisor"
--
-- Meta-agente que corre 8:45am Bogotá (después de monitor + reparador + limpiador).
-- Valida estado final del día, dispara retriggers automáticos si quedan gaps,
-- y envía email crítico solo si algún cliente queda en FAIL.

insert into public.clientes (slug, nombre, activo, notas)
values (
  'supervisor',
  'Operatto Supervisor (interno)',
  false,
  'Cliente sintético para runs del agente Equipo-supervisor. NO es un cliente real.'
)
on conflict (slug) do update
  set nombre = excluded.nombre, activo = false, notas = excluded.notas;

insert into public.agentes (id, nombre, descripcion, activo)
values (
  'supervisor',
  'Equipo-supervisor',
  'Valida estado final del día (Drive=Sheet=events, sin duplicados, numeración consistente). Dispara retriggers automáticos a reparador/limpiador si quedan gaps. Email solo si hay alerta crítica. Corre 8:45am Bogotá.',
  true
)
on conflict (id) do update
  set nombre = excluded.nombre, descripcion = excluded.descripcion, activo = excluded.activo;

insert into public.client_agents (cliente_id, agente_id, activo)
select c.id, 'supervisor', true
from public.clientes c
where c.slug = 'supervisor'
on conflict (cliente_id, agente_id) do update set activo = true;
