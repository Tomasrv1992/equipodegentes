-- Migration 0004: fix onboarding_token_lookup para que devuelva tokens completed
--
-- Problema: con el flujo nuevo donde el callback marca step='completed' al
-- terminar OAuth (auto-crea folder + Sheet), el frontend redirige a la página
-- de onboarding, hace lookup del token, y el RPC devolvía 0 rows porque tenía
-- filtro `step != 'completed'`. Resultado: cliente veía "Link inválido o
-- vencido" en lugar de la pantalla "¡Listo!".
--
-- Fix: quitamos el filtro de step. El expiration por `expires_at > now()` sigue
-- protegiendo. El frontend ya tiene la lógica correcta para mostrar pantalla
-- "completed" cuando step='completed'.

create or replace function public.onboarding_token_lookup(p_token text)
returns table (
  cliente_id uuid,
  cliente_nombre text,
  cliente_slug text,
  agente_id text,
  agente_nombre text,
  step text,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    ot.cliente_id,
    c.nombre as cliente_nombre,
    c.slug as cliente_slug,
    ot.agente_id,
    a.nombre as agente_nombre,
    ot.step,
    ot.expires_at
  from public.onboarding_tokens ot
  join public.clientes c on c.id = ot.cliente_id
  join public.agentes a on a.id = ot.agente_id
  where ot.token = p_token
    and ot.expires_at > now();
$$;
