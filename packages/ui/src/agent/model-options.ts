/**
 * Native `modelOptions` builder for the agent chat surface
 * (PLAN-AGENT-CHAT Phase 1.3, D8): turns a selected model's catalog
 * `reasoning_options` entry plus a user-chosen value into that provider's
 * NATIVE TanStack AI `modelOptions` object — verbatim, with no normalized
 * enum and no custom mapping layer. The offered values live in the catalog
 * (the `AgentModelReasoningOption` structural type below); this module only wraps the
 * chosen value in the provider's own shape.
 *
 * Native shapes, verified against the installed adapter type definitions
 * (not from memory):
 *
 * - OpenAI `@tanstack/ai-openai` —
 *   `dist/esm/text/text-provider-options.d.ts`:
 *   `reasoning?: { effort?: 'none'|'minimal'|'low'|'medium'|'high', summary? }`
 * - Anthropic `@tanstack/ai-anthropic` —
 *   `dist/esm/text/text-provider-options.d.ts`
 *   (`AnthropicTextProviderOptions`): `thinking?:
 *   { type: 'enabled', budget_tokens: number }` and
 *   `output_config?: { effort?: 'low'|'medium'|'high'|'xhigh'|'max'|null }`
 * - Gemini `@tanstack/ai-gemini` —
 *   `dist/esm/text/text-provider-options.d.ts`
 *   (`GeminiTextProviderOptions`): `thinkingConfig?: { thinkingLevel?:
 *   keyof typeof ThinkingLevel }` — the `@google/genai` enum keys
 *   `MINIMAL|LOW|MEDIUM|HIGH` (uppercase)
 * - OpenRouter `@tanstack/ai-openrouter` —
 *   `dist/esm/text/text-provider-options.d.ts`:
 *   `reasoning?: { effort?: 'max'|'xhigh'|'high'|'medium'|'low'|'minimal'|
 *   'none'|string, summary?, enabled?: false }`
 *
 * Effort values are typed as `string` on purpose: the catalog is the single
 * source of offered values (D8), and constraining them to a copy of each
 * SDK's literal union would be exactly the drift-prone mapping layer D8
 * forbids. The adapters type-narrow per model at the request boundary.
 *
 * Nothing here preselects: the caller supplies the catalog option and the
 * user's value, and the builder returns `undefined` whenever the pair is not
 * offered by the catalog — the UI hides the effort control entirely in that
 * case.
 */

import type { AgentProviderId } from "./providers";

/**
 * One models.dev `reasoning_options` entry, as the model catalog hands it
 * to the picker (D8). This is the registry item's own structural copy —
 * the slopcad app's Drizzle schema type in
 * `@slopcad/db/schema/model-catalog` is identical by assignability at the
 * app boundary (the app passes catalog rows straight through), which
 * `check-types` enforces on every call site.
 */
export interface AgentModelReasoningOption {
  type: "effort" | "budget_tokens" | "toggle";
  /** Offered values for `effort`-type options, e.g. `["low","medium","high"]`. */
  values?: string[];
  /** Minimum for `budget_tokens`-type options. */
  min?: number;
}

/** OpenAI Responses API: `modelOptions.reasoning.effort`. */
export interface OpenAiModelOptions {
  reasoning: { effort: string };
}

/** Anthropic extended thinking: `modelOptions.thinking` (budget mode). */
export interface AnthropicBudgetTokensModelOptions {
  thinking: { type: "enabled"; budget_tokens: number };
}

/** Anthropic adaptive thinking (Opus 4.6+): `modelOptions.output_config`. */
export interface AnthropicEffortModelOptions {
  output_config: { effort: string };
}

/** Gemini level-based thinking (3.x): `modelOptions.thinkingConfig`. */
export interface GeminiModelOptions {
  thinkingConfig: { thinkingLevel: string };
}

/** OpenRouter normalized reasoning: `modelOptions.reasoning`. */
export interface OpenRouterModelOptions {
  reasoning: { effort: string };
}

/** Any native options object this module emits, tagged by provider shape. */
export type AgentModelOptions =
  | OpenAiModelOptions
  | AnthropicBudgetTokensModelOptions
  | AnthropicEffortModelOptions
  | GeminiModelOptions
  | OpenRouterModelOptions;

/**
 * Returns the chosen string when the option is an `effort`-type entry whose
 * `values` array offers it — `undefined` otherwise (wrong option type,
 * unlisted value, or a catalog entry without values).
 */
function offeredEffort(
  option: AgentModelReasoningOption,
  value: string | number,
): string | undefined {
  if (option.type !== "effort" || typeof value !== "string") {
    return undefined;
  }
  return option.values?.includes(value) === true ? value : undefined;
}

/**
 * Returns the chosen integer when the option is a `budget_tokens`-type entry
 * whose declared `min` it respects — `undefined` otherwise (wrong option
 * type, non-integer, or a catalog entry without a minimum).
 */
function offeredBudget(
  option: AgentModelReasoningOption,
  value: string | number,
): number | undefined {
  if (option.type !== "budget_tokens" || typeof value !== "number") {
    return undefined;
  }
  if (!Number.isInteger(value) || option.min === undefined) {
    return undefined;
  }
  return value >= option.min ? value : undefined;
}

/** OpenAI: `reasoning.effort` (Responses API), catalog-gated. */
export function buildOpenAiModelOptions(
  option: AgentModelReasoningOption,
  value: string | number,
): OpenAiModelOptions | undefined {
  const effort = offeredEffort(option, value);
  return effort === undefined ? undefined : { reasoning: { effort } };
}

/**
 * Anthropic: `thinking.budget_tokens` for `budget_tokens`-type options,
 * `output_config.effort` for `effort`-type options — the two shapes the
 * adapter accepts on the respective model generations.
 */
export function buildAnthropicModelOptions(
  option: AgentModelReasoningOption,
  value: string | number,
): AnthropicBudgetTokensModelOptions | AnthropicEffortModelOptions | undefined {
  const budget = offeredBudget(option, value);
  if (budget !== undefined) {
    return { thinking: { type: "enabled", budget_tokens: budget } };
  }
  const effort = offeredEffort(option, value);
  return effort === undefined ? undefined : { output_config: { effort } };
}

/** Gemini: `thinkingConfig.thinkingLevel` (uppercase enum key), catalog-gated. */
export function buildGeminiModelOptions(
  option: AgentModelReasoningOption,
  value: string | number,
): GeminiModelOptions | undefined {
  const thinkingLevel = offeredEffort(option, value);
  return thinkingLevel === undefined
    ? undefined
    : { thinkingConfig: { thinkingLevel } };
}

/** OpenRouter: `reasoning.effort` (OpenRouter's own normalization), catalog-gated. */
export function buildOpenRouterModelOptions(
  option: AgentModelReasoningOption,
  value: string | number,
): OpenRouterModelOptions | undefined {
  const effort = offeredEffort(option, value);
  return effort === undefined ? undefined : { reasoning: { effort } };
}

/**
 * Builds the provider's native `modelOptions` from the selected catalog
 * reasoning option and the user's value — `undefined` when the provider or
 * option combination is unsupported, so the UI hides the control:
 *
 * - `openai-compatible` has no native reasoning shape in the research doc
 *   (docs/research/tanstack-ai.md §7) — nothing is offered (D8).
 * - `toggle`-type catalog entries have no native shape in scope — nothing is
 *   offered.
 * - Any value the catalog option does not offer is refused — values are
 *   restricted to `reasoning_options` (D8), and nothing is preselected.
 */
export function buildAgentModelOptions(
  provider: AgentProviderId,
  option: AgentModelReasoningOption,
  value: string | number,
): AgentModelOptions | undefined {
  switch (provider) {
    case "openai":
      return buildOpenAiModelOptions(option, value);
    case "anthropic":
      return buildAnthropicModelOptions(option, value);
    case "google":
      return buildGeminiModelOptions(option, value);
    case "openrouter":
      return buildOpenRouterModelOptions(option, value);
    case "openai-compatible":
      return undefined;
  }
}
