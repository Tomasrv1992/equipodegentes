export { recordRun, recordRunStart, recordRunEnd } from "./record-run";
export { slugify } from "./slugify";
export { getServerClient } from "./supabase-server";
export type { RecordRunStartInput, RecordRunEndInput } from "./record-run";

// Agent events granulares (factura por factura, etc.)
export { emitFacturaEvents, clienteIdBySlug } from "./agent-events";
export type { FacturaEventPayload, EmitFacturaEventsInput } from "./agent-events";

// LLM rate limiting (Anthropic token bucket) — usar antes de cada
// anthropic.messages.create() para evitar 429s en cascada.
export {
  acquireLlmToken,
  llmRateLimiterStats,
} from "./llm-rate-limiter";

// Multi-tenant credentials (Fase 3)
export {
  saveOAuthTokens,
  loadCredentials,
  markOAuthStatus,
  saveResources,
} from "./credentials";
export {
  loadCredentialsBySlug,
  listActiveClientsForAgent,
} from "./credentials-by-slug";
export type {
  ClientCredentialsRow,
  GoogleOAuthStatus,
  SaveOAuthTokensInput,
  SaveResourcesInput,
} from "./credentials";

// Onboarding tokens (Fase 3)
export {
  generateOnboardingToken,
  createOnboardingToken,
  loadOnboardingToken,
  advanceOnboardingStep,
} from "./onboarding-tokens";
export type {
  CreateOnboardingTokenInput,
  OnboardingTokenRow,
} from "./onboarding-tokens";
