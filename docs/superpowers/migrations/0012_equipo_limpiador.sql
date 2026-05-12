-- Migration 0012: registrar el agente "Equipo-limpiador"
--
-- Agente que CONFIRMA cada PDF huérfano descargándolo y analizándolo con LLM.
-- Si es duplicado de un event existente → mueve a folder "_duplicados_operatto".
-- Si es factura no registrada → crea event + inserta fila en Sheet.
-- Si LLM no identifica → reporta para revisión manual.
--
-- Cron: 8:30am Bogotá (después de monitor 8:00 y reparador 8:15).

insert into public.clientes (slug, nombre, activo, notas)
values (
  'limpiador',
  'Operatto Limpiador (interno)',
  false,
  'Cliente sintético para runs del agente Equipo-limpiador. NO es un cliente real.'
)
on conflict (slug) do update
  set nombre = excluded.nombre,
      activo = false,
      notas = excluded.notas;

insert into public.agentes (id, nombre, descripcion, activo)
values (
  'limpiador',
  'Equipo-limpiador',
  'Confirma cada PDF huérfano descargándolo + LLM identifica + compara con DB. Mueve duplicados a folder _duplicados, recupera facturas no registradas, reporta los no identificables. Corre 8:30am Bogotá.',
  true
)
on conflict (id) do update
  set nombre = excluded.nombre,
      descripcion = excluded.descripcion,
      activo = excluded.activo;

insert into public.client_agents (cliente_id, agente_id, activo)
select c.id, 'limpiador', true
from public.clientes c
where c.slug = 'limpiador'
on conflict (cliente_id, agente_id) do update
  set activo = true;
