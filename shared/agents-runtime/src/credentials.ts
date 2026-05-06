import { getServerClient } from "./supabase-server";

/**
 * Helpers para encriptar/desencriptar refresh_tokens de Google y para
 * leer credenciales del cliente desde Supabase.
 *
 * Usa pgcrypto (`pgp_sym_encrypt` / `pgp_sym_decrypt`) en el lado de Postgres,
 * con la key viviendo en una env var del sitio Netlify (`CREDENTIALS_VAULT_KEY`).
 *
 * Decisión arquitectónica: cifrado en DB (no en aplicación) porque permite
 * hacer queries que comparan/buscan sin exfiltrar la key al cliente. La
 * key NUNCA debe loggearse ni serializarse a logs.
 */

/** Falla con mensaje claro si la env var no está configurada. */
function requireVaultKey(): string {
  const key = process.env.CREDENTIALS_VAULT_KEY;
  if (!key) {
    throw new Error(
      "Falta env var CREDENTIALS_VAULT_KEY (usada para cifrar refresh tokens). " +
      "Generá una con: openssl rand -hex 32"
    );
  }
  if (key.length < 32) {
    throw new Error("CREDENTIALS_VAULT_KEY es muy corta (<32 chars). Regenerá con `openssl rand -hex 32`.");
  }
  return key;
}

export type GoogleOAuthStatus = "pending" | "connected" | "expired" | "revoked";

export interface ClientCredentialsRow {
  cliente_id: string;
  agente_id: string;
  google_refresh_token: string | null;  // ya desencriptado (NO el _encrypted)
  google_oauth_status: GoogleOAuthStatus;
  google_email: string | null;
  google_scopes: string[] | null;
  drive_folder_id: string | null;
  drive_folder_name: string | null;
  sheet_id: string | null;
  sheet_name: string | null;
  sheet_tab: string;
  notify_email: string | null;
  onboarded_at: string | null;
  last_oauth_refresh: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveOAuthTokensInput {
  clienteId: string;
  agenteId: string;
  refreshToken: string;
  googleEmail?: string;
  scopes?: string[];
}

/**
 * Guarda (o actualiza) el refresh_token Google del cliente, cifrándolo con pgcrypto.
 * Marca status='connected' y last_oauth_refresh=now().
 */
export async function saveOAuthTokens(input: SaveOAuthTokensInput): Promise<void> {
  const supa = getServerClient();
  const key = requireVaultKey();

  const { error } = await supa.rpc("client_credentials_save_oauth", {
    p_cliente_id: input.clienteId,
    p_agente_id: input.agenteId,
    p_refresh_token: input.refreshToken,
    p_google_email: input.googleEmail ?? null,
    p_scopes: input.scopes ?? null,
    p_vault_key: key,
  });

  if (error) {
    throw new Error(`saveOAuthTokens: ${error.message}`);
  }
}

/**
 * Lee credenciales del cliente desencriptando el refresh_token.
 * Devuelve null si el cliente no tiene fila o status != 'connected'.
 *
 * USAR SOLO server-side (Netlify functions / scripts) — la key está en env vars.
 */
export async function loadCredentials(
  clienteId: string,
  agenteId: string,
): Promise<ClientCredentialsRow | null> {
  const supa = getServerClient();
  const key = requireVaultKey();

  const { data, error } = await supa
    .rpc("client_credentials_load", {
      p_cliente_id: clienteId,
      p_agente_id: agenteId,
      p_vault_key: key,
    })
    .single();

  if (error) {
    // Si no encontró, error code PGRST116 — devolvemos null en vez de throw
    if (error.code === "PGRST116") return null;
    throw new Error(`loadCredentials: ${error.message}`);
  }

  return data as ClientCredentialsRow | null;
}

/**
 * Marca el status del OAuth (típicamente 'expired' o 'revoked' cuando un cron
 * detecta un invalid_grant).
 */
export async function markOAuthStatus(
  clienteId: string,
  agenteId: string,
  status: GoogleOAuthStatus,
): Promise<void> {
  const supa = getServerClient();
  const { error } = await supa
    .from("client_credentials")
    .update({ google_oauth_status: status })
    .eq("cliente_id", clienteId)
    .eq("agente_id", agenteId);

  if (error) throw new Error(`markOAuthStatus: ${error.message}`);
}

/**
 * Actualiza los recursos elegidos durante onboarding (Drive folder + Sheet).
 */
export interface SaveResourcesInput {
  clienteId: string;
  agenteId: string;
  driveFolderId: string;
  driveFolderName?: string;
  sheetId: string;
  sheetName?: string;
  sheetTab?: string;
  notifyEmail?: string;
}
export async function saveResources(input: SaveResourcesInput): Promise<void> {
  const supa = getServerClient();
  const { error } = await supa
    .from("client_credentials")
    .update({
      drive_folder_id: input.driveFolderId,
      drive_folder_name: input.driveFolderName ?? null,
      sheet_id: input.sheetId,
      sheet_name: input.sheetName ?? null,
      sheet_tab: input.sheetTab ?? "Gastos 2026",
      notify_email: input.notifyEmail ?? null,
      onboarded_at: new Date().toISOString(),
    })
    .eq("cliente_id", input.clienteId)
    .eq("agente_id", input.agenteId);

  if (error) throw new Error(`saveResources: ${error.message}`);
}
