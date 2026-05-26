-- Migration 0011: Lock atómico para evitar dispatches duplicados de facturacion-background
--
-- Bug 2026-05-26: hasta 14 dispatches paralelos llegando al mismo customerId
-- en segundos, todos pasando el guard SELECT-then-CHECK (race condition).
--
-- Solución: tabla con UNIQUE constraint + RPC atómico que solo retorna TRUE
-- al PRIMER dispatch que llega. Resto recibe FALSE → descarta.

CREATE TABLE IF NOT EXISTS public.dispatch_locks (
  cliente_id UUID PRIMARY KEY REFERENCES public.clientes(id) ON DELETE CASCADE,
  agente_id TEXT NOT NULL DEFAULT 'facturacion',
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RPC atómico: intenta tomar el lock para el cliente.
-- Si el lock anterior tiene > p_max_age_seconds, expira y el nuevo dispatch gana.
-- Si está vigente, retorna FALSE → el caller descarta el dispatch.
--
-- Atomicidad: garantizada por el INSERT con UNIQUE constraint (PRIMARY KEY).
-- UPDATE solo afecta filas que cumplen el WHERE, así que la condición de
-- expiración es serializada por Postgres.
CREATE OR REPLACE FUNCTION public.try_acquire_dispatch_lock(
  p_cliente_id UUID,
  p_max_age_seconds INT DEFAULT 30
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows_affected INT;
BEGIN
  -- Caso 1: si existe lock expirado (> max_age), UPDATE lo refresca y gana.
  UPDATE public.dispatch_locks
  SET locked_at = now()
  WHERE cliente_id = p_cliente_id
    AND locked_at < now() - (p_max_age_seconds || ' seconds')::interval;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

  IF v_rows_affected > 0 THEN
    RETURN true;
  END IF;

  -- Caso 2: no existe lock (primera vez), INSERT lo crea y gana.
  -- Si OTRO dispatch insertó primero (race condition), la UNIQUE constraint
  -- hace que este INSERT falle con unique_violation. Capturamos y retornamos
  -- FALSE (otro ganó el lock).
  BEGIN
    INSERT INTO public.dispatch_locks (cliente_id, locked_at)
    VALUES (p_cliente_id, now());
    RETURN true;
  EXCEPTION WHEN unique_violation THEN
    RETURN false;
  END;
END;
$$;

-- Indice para queries por fecha (opcional, para diagnóstico)
CREATE INDEX IF NOT EXISTS dispatch_locks_locked_at_idx
  ON public.dispatch_locks (locked_at);

-- Comentarios
COMMENT ON TABLE public.dispatch_locks IS
  'Lock atomico para evitar dispatches paralelos a facturacion-background por mismo cliente. Expira tras 30s sin actividad.';
COMMENT ON FUNCTION public.try_acquire_dispatch_lock IS
  'Intenta adquirir lock para cliente. Devuelve TRUE si lo logra, FALSE si otro dispatch lo tiene activo.';
