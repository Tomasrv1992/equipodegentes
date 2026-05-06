import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url) throw new Error("Falta VITE_SUPABASE_URL en .env");
if (!anonKey) throw new Error("Falta VITE_SUPABASE_ANON_KEY en .env");

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const ALLOWED_EMAIL =
  import.meta.env.VITE_ADMIN_ALLOWED_EMAIL ?? "tomasramirezvilla@gmail.com";
