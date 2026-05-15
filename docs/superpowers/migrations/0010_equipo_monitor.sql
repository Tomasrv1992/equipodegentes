-- Migration 0010: registrar el agente "Equipo-monitor"
--
-- Agente del operador (Tomás, no de clientes). Corre todos los días a las
-- 8am Bogotá y valida que el cron de facturación de las 7am haya corrido
-- correctamente para cada cliente activo.
--
-- Cierra runs zombies (status='running' > 30min), detecta OAuth roto,
-- y envía un email diario con el resumen al admin.
--
-- Etapa 1 (este MVP):
--   - Chequea runs de hoy por cliente
--   - Cierra zombies
--   - Detecta OAuth expirado
--   - Email diario al admin
--
-- Etapa 2 (futuro):
--   - Coincidencia Gmail/Drive/Sheet por cliente
--   - Verificación de emails entregados (Resend)
--   - Costo Anthropic del día

-- Crear un "cliente" especial para el monitor (necesario porque agent_runs
-- requiere cliente_id NOT NULL — y el monitor es un agente del operador,
-- no de un cliente real). Lo marcamos como inactivo para que no aparezca
-- en la lista de clientes operativos.
insert into public.clientes (slug, nombre, activo, notas)
values (
  'monitor',
  'Operatto Monitor (interno)',
  false,
  'Cliente sintético para registrar runs del agente Equipo-monitor. NO es un cliente real.'
)
on conflict (slug) do update
  set nombre = excluded.nombre,
      activo = false,
      notas = excluded.notas;

-- Registrar el agente monitor
insert into public.agentes (id, nombre, descripcion, activo)
values (
  'monitor',
  'Equipo-monitor',
  'Agente diario del operador: valida que el cron de facturación corrió OK para cada cliente y envía resumen por email. No requiere onboarding del cliente.',
  true
)
on conflict (id) do update
  set nombre = excluded.nombre,
      descripcion = excluded.descripcion,
      activo = excluded.activo;

-- Activar el agente "monitor" para el cliente sintético "monitor"
-- (requerido por la lógica de recordRunStart que busca cliente por slug)
insert into public.client_agents (cliente_id, agente_id, activo)
select c.id, 'monitor', true
from public.clientes c
where c.slug = 'monitor'
on conflict (cliente_id, agente_id) do update
  set activo = true;
