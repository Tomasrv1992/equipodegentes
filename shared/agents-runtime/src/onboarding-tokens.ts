import { randomBytes } from "node:crypto";
import { getServerClient } from "./supabase-server";

/**
 * Helpers para crear y validar onboarding_tokens — los tokens únicos que
 * Tomás manda al cliente para que complete el flujo OAuth + selección de
 * recursos sin tener que loguear con Supabase.
 */

/** Genera un token URL-safe de 32 bytes (43 chars en base64url). */
export function generateOnboardingToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface CreateOnboardingTokenInput {
  clienteId: string;
  agenteId: string;
  expiresInDays?: number;
  createdBy?: string;
}

export interface OnboardingTokenRow {
  token: string;
  cliente_id: string;
  agente_id: string;
  step: "pending" | "oauth_done" | "resources_done" | "completed" | "expired";
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  created_by: string | null;
}

/**
 * Crea un nuevo token de onboarding. Default: vence a los 7 días.
 * Devuelve el token (string) — Tomás lo manda al cliente.
 */
export async function createOnboardingToken(
  input: CreateOnboardingTokenInput,
): Promise<string> {
  const supa = getServerClient();
  const token = generateOnboardingToken();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (input.expiresInDays ?? 7));

  const { error } = await supa.from("onboarding_tokens").insert({
    token,
    cliente_id: input.clienteId,
    agente_id: input.agenteId,
    expires_at: expiresAt.toISOString(),
    created_by: input.createdBy ?? null,
  });

  if (error) {
    throw new Error(`createOnboardingToken: ${error.message}`);
  }
  return token;
}

/**
 * Lee un token y valida que no expiró ni esté completado.
 * Devuelve null si inválido — el caller debe responder 404 o redirigir.
 */
export async function loadOnboardingToken(
  token: string,
): Promise<OnboardingTokenRow | null> {
  const supa = getServerClient();
  const { data, error } = await supa
    .from("onboarding_tokens")
    .select("*")
    .eq("token", token)
    .single();

  if (error || !data) return null;

  const row = data as OnboardingTokenRow;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (row.step === "completed" || row.step === "expired") return null;
  return row;
}

/**
 * Avanza el step del token (típicamente 'pending' → 'oauth_done' → 'resources_done' → 'completed').
 */
export async function advanceOnboardingStep(
  token: string,
  newStep: OnboardingTokenRow["step"],
): Promise<void> {
  const supa = getServerClient();
  const update: Record<string, unknown> = { step: newStep };
  if (newStep === "completed") {
    update.completed_at = new Date().toISOString();
  }

  const { error } = await supa
    .from("onboarding_tokens")
    .update(update)
    .eq("token", token);

  if (error) throw new Error(`advanceOnboardingStep: ${error.message}`);
}
