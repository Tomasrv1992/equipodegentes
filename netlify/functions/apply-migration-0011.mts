// netlify/functions/apply-migration-0011.mts
//
// Endpoint one-shot para aplicar migration 0011 (dispatch_locks).
// Idempotente: usa CREATE TABLE IF NOT EXISTS y CREATE OR REPLACE FUNCTION.
//
// Llamar UNA VEZ con: curl -X POST .../apply-migration-0011 -H "x-internal-secret: ..."

import type { Config } from "@netlify/functions";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS public.dispatch_locks (
  cliente_id UUID PRIMARY KEY REFERENCES public.clientes(id) ON DELETE CASCADE,
  agente_id TEXT NOT NULL DEFAULT 'facturacion',
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  UPDATE public.dispatch_locks
  SET locked_at = now()
  WHERE cliente_id = p_cliente_id
    AND locked_at < now() - (p_max_age_seconds || ' seconds')::interval;
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected > 0 THEN RETURN true; END IF;
  BEGIN
    INSERT INTO public.dispatch_locks (cliente_id, locked_at)
    VALUES (p_cliente_id, now());
    RETURN true;
  EXCEPTION WHEN unique_violation THEN
    RETURN false;
  END;
END;
$$;

CREATE INDEX IF NOT EXISTS dispatch_locks_locked_at_idx
  ON public.dispatch_locks (locked_at);
`;

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const supa = getServerClient();

  // Usamos supabase admin REST endpoint para ejecutar SQL crudo.
  // Si Supabase no tiene exec_sql expuesto, hay que usar otro approach.
  // Alternativa: usar sql endpoint del PostgREST con función custom.
  //
  // El approach más confiable: hacer las operaciones via RPC si existen,
  // o pedirle a Tomás que ejecute manualmente en SQL Editor de Supabase.

  // Test rápido: intentar llamar try_acquire_dispatch_lock con un UUID dummy.
  // Si la función existe → migration ya aplicada.
  // Si no existe → la migration NO se aplicó, hay que hacerlo manualmente.

  try {
    const { data, error } = await supa.rpc("try_acquire_dispatch_lock", {
      p_cliente_id: "00000000-0000-0000-0000-000000000000",
      p_max_age_seconds: 30,
    });

    if (!error) {
      return new Response(
        JSON.stringify({
          ok: true,
          migration_status: "already_applied",
          test_call_result: data,
          note: "La funcion ya existe en Supabase. Migration aplicada.",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // Si error es "function does not exist" o similar:
    return new Response(
      JSON.stringify({
        ok: false,
        migration_status: "needs_manual_apply",
        error: error.message,
        instructions: [
          "1. Abre Supabase dashboard -> SQL Editor",
          "2. Copia y pega el SQL de docs/superpowers/migrations/0011_dispatch_locks.sql",
          "3. Run",
          "4. Verifica re-llamando este endpoint",
        ],
        sql: MIGRATION_SQL,
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e.message, sql: MIGRATION_SQL }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const config: Config = {};
