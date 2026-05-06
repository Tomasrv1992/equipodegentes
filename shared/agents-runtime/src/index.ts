export { recordRun, recordRunStart, recordRunEnd } from "./record-run";
export { slugify } from "./slugify";
export { getServerClient } from "./supabase-server";
export type { RecordRunStartInput, RecordRunEndInput } from "./record-run";

// Multi-tenant credentials (Fase 3)
export {
  saveOAuthTokens,
  loadCredentials,
  markOAuthStatus,
  saveResources,
} from "./credentials";
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
