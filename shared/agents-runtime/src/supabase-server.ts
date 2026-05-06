import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Cliente Supabase con service_role key — bypassea RLS.
 * USAR SOLO desde código server-side (Netlify functions, scripts).
 * Nunca importar desde apps/admin/.
 *
 * Conecta al proyecto Supabase DEDICADO de equipodegentes (independiente
 * del de consultoria-app). Las tablas viven en el schema `public`.
 */
export function getServerClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Falta env var SUPABASE_URL");
  if (!key) throw new Error("Falta env var SUPABASE_SERVICE_ROLE_KEY");

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}
