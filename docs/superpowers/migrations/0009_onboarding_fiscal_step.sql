-- Migration 0009: agregar 'fiscal_pending' al check constraint de onboarding_tokens.step
--
-- Nuevo flujo de onboarding:
--   1. pending          → Cliente abre el link y conecta Google (OAuth)
--   2. oauth_done       → OAuth OK; selección manual de Drive/Sheet (fallback,
--                         actualmente raro porque auto-create suele funcionar)
--   3. fiscal_pending   → Auto-create OK; ahora pide datos fiscales (NIT,
--                         tipo persona, retenciones). NUEVO en 0009.
--   4. completed        → Datos fiscales guardados, primer run disparado.
--   5. expired          → Token venció.
--
-- Antes el callback marcaba 'completed' inmediatamente después del auto-create
-- y disparaba el primer run. Eso significaba que el cliente arrancaba con
-- retention_rules default (jurídica + RTF=true) que NO aplica a la mayoría.
-- Ahora el callback marca 'fiscal_pending' y el run se dispara después de que
-- el cliente conteste el wizard.

alter table public.onboarding_tokens
  drop constraint if exists onboarding_tokens_step_check;

alter table public.onboarding_tokens
  add constraint onboarding_tokens_step_check
  check (step in (
    'pending',
    'oauth_done',
    'fiscal_pending',
    'resources_done',
    'completed',
    'expired'
  ));

comment on column public.onboarding_tokens.step is
  'Estado del flujo: pending → oauth_done → (fiscal_pending|resources_done) → completed';
