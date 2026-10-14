/**
 * The agent chat's provider-id single source (PLAN-AGENT-CHAT D6): the
 * five ids every surface derives from — the model-catalog router's
 * accepted providers and the web picker's provider universe. A
 * dependency-free module so browser code can import it without dragging
 * the server stack (drizzle, the db singleton) into the bundle — the
 * same discipline as `limits.ts`. The literals live here and nowhere
 * else; consumers re-export or derive, never restate.
 */

/** The BYO-endpoint provider — never catalog-backed (D14). */
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

/**
 * The providers whose models the models.dev catalog lists (D14) — every
 * supported id except the BYO-endpoint one.
 */
export const NAMED_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
] as const;

/** A provider whose models the models.dev catalog lists. */
export type NamedProviderId = (typeof NAMED_PROVIDER_IDS)[number];

/** Every supported provider id, in the canonical order (D6). */
export const PROVIDER_IDS = [
  ...NAMED_PROVIDER_IDS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
] as const;

/** Any provider id the agent chat surfaces accept. */
export type ProviderId = (typeof PROVIDER_IDS)[number];
