import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Schema "equipodegentes" no es asignable al default "public", por eso usamos `any`
// para los generics del cliente cacheado.
let cached: SupabaseClient<any, any, any> | null = null;

/**
 * Cliente Supabase con service_role key — bypassea RLS.
 * USAR SOLO desde código server-side (Netlify functions, scripts).
 * Nunca importar desde apps/admin/.
 */
export function getServerClient(): SupabaseClient<any, any, any> {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Falta env var SUPABASE_URL");
  if (!key) throw new Error("Falta env var SUPABASE_SERVICE_ROLE_KEY");

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "equipodegentes" },
  });

  return cached;
}
