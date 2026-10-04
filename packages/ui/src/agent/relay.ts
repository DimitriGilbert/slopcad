/**
 * The agent chat's server relay handling (PLAN-AGENT-CHAT Phase 1.5): the
 * server-emitted transport (D2). The browser sends ONLY the conversation
 * shape — `{ provider, modelId, modelOptions, messages }` — and the server
 * calls the chosen provider with ITS OWN env-configured keys, streaming the
 * run back as Server-Sent Events via `toServerSentEventsResponse`
 * (docs/research/tanstack-ai.md §8). The endpoint coexists with tRPC and
 * takes no key parameter anywhere on its surface.
 *
 * User keys never cross to the server (D1). The input schema has no key
 * field and is strict against unknown top-level fields; on top of that, a
 * deep field-name scan rejects any payload carrying apiKey-like FIELD names
 * in the message history with 400 — twice, deliberately: once as a zod
 * refine on the parsed value and once as a handler guard over the raw JSON
 * (which answers before any database work and names the offending field).
 * The ONE scan exemption is the top-level `modelOptions` subtree: it is
 * structure-validated by a CLOSED per-provider schema (D8's verbatim
 * native shapes — unknown fields refused, leaf values bounded), which is
 * how Anthropic's native `thinking.budget_tokens` crosses the relay even
 * though its field NAME carries the scan's `token` fragment. The exemption
 * is positional and structural, never lexical: a `token`-fragment field
 * name inside `messages` stays a refusal.
 *
 * The caller's loop bound rides the same contract: an optional integer
 * `maxIterations` (1..25) the handler binds onto the server-side `chat()`
 * run as its `agentLoopStrategy`; omitted, the engine's own library
 * default (5 model turns) applies.
 *
 * Gate order (every refusal is the io endpoints' structured envelope
 * `{ ok: false, code, message }`):
 *
 * 1. session — Better Auth, injected lookup — 401
 * 2. key-bearing payload — 400, D1's absolute refusal
 * 3. input schema — 400
 * 4. server-AI access (D13): the injected `isServerAiAllowed` resolver —
 *    `@slopcad/api/user-options`'s single implementation (the caller's
 *    `user_options` row `agent.server-ai = "true"` OR the instance env
 *    `AGENT_SERVER_AI_ALLOW_ALL`) — 403
 * 5. the provider's env key (D6): present, else 422 naming the provider
 *    and its missing env var(s) — NEVER a fallback to another provider
 * 6. the real Phase 1.2 adapter + the real `chat()` + SSE. No mock seam
 *    exists in this path: the e2e harness points
 *    `OPENAI_COMPATIBLE_BASE_URL` at a loopback SSE server and exercises
 *    exactly this code (docs/architecture/adr-agent-chat.md).
 *
 * The session lookup, the D13 access resolver, the env keys, and the
 * transport are all injected (the routers' dependency-injection
 * convention) so the unit tests drive every gate without the auth
 * package's import-time database singleton and without any network.
 */

import { chat, maxIterations, toServerSentEventsResponse } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai";
import { z } from "zod";
import type { AgentModelOptions } from "./model-options";

import {
  AGENT_PROVIDER_IDS,
  createAgentProviderAdapter,
  type AgentProviderAdapter,
  type AgentProviderId,
} from "./providers";

/**
 * One chat message as the browser sends it — TanStack AI's `UIMessage`
 * wire shape. `parts` (and the message itself) stay deliberately open:
 * typed exhaustiveness belongs to the Phase 3 parts model, and the relay
 * forwards the client's own history, so unknown part types ride through
 * to the adapter untouched.
 */
const relayMessageSchema = z.looseObject({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.looseObject({ type: z.string().min(1) }).array(),
});

/**
 * The relay's iteration-bound ceiling: the client fetcher sends the config
 * store's loop bound and the handler binds it onto the server-side run.
 * 25 model turns is the deliberate ceiling — more is a runaway, not a
 * conversation.
 */
const AGENT_RELAY_MAX_ITERATIONS = 25;

/**
 * Leaf bounds for the closed `modelOptions` shapes: no key VALUE can ride
 * inside a legal field name either — strings stay too short for any real
 * credential, and the budget is integer-bounded.
 */
const MODEL_OPTIONS_STRING_MAX_LENGTH = 64;

/**
 * Anthropic's own floor, verified against the installed adapter
 * (`@tanstack/ai-anthropic`'s `validateTextProviderOptions`: budget
 * "must be at least 1024").
 */
const MODEL_OPTIONS_BUDGET_TOKENS_MIN = 1024;

/** Generous beyond any current model's output ceiling, but bounded. */
const MODEL_OPTIONS_BUDGET_TOKENS_MAX = 2_000_000;

const effortSchema = z.string().min(1).max(MODEL_OPTIONS_STRING_MAX_LENGTH);
const budgetTokensSchema = z
  .number()
  .int()
  .min(MODEL_OPTIONS_BUDGET_TOKENS_MIN)
  .max(MODEL_OPTIONS_BUDGET_TOKENS_MAX);

/**
 * `reasoning.effort` — the OpenAI-wire shape the schema accepts for
 * openai, openai-compatible, and openrouter alike; the Phase 1.3
 * builder emits it only for openai/openrouter (openai-compatible
 * offers no effort control, D8).
 */
const reasoningEffortModelOptionsSchema = z.strictObject({
  reasoning: z.strictObject({ effort: effortSchema }),
});

/** Anthropic extended thinking (budget mode): `thinking.{type, budget_tokens}` (D8). */
const anthropicBudgetModelOptionsSchema = z.strictObject({
  thinking: z.strictObject({
    budget_tokens: budgetTokensSchema,
    type: z.literal("enabled"),
  }),
});

/** Anthropic adaptive thinking (Opus 4.6+): `output_config.effort` (D8). */
const anthropicEffortModelOptionsSchema = z.strictObject({
  output_config: z.strictObject({ effort: effortSchema }),
});

/** Anthropic's two native shapes (budget mode and adaptive effort). */
const anthropicModelOptionsSchema = z.union([
  anthropicBudgetModelOptionsSchema,
  anthropicEffortModelOptionsSchema,
]);

/** Gemini level-based thinking: `thinkingConfig.thinkingLevel` (D8). */
const geminiModelOptionsSchema = z.strictObject({
  thinkingConfig: z.strictObject({ thinkingLevel: effortSchema }),
});

/**
 * The CLOSED `modelOptions` universe: exactly the native shapes the
 * Phase 1.3 builder (`model-options.ts`) can emit — verbatim (D8),
 * nothing more. Every branch is a strict object, so an unknown field at
 * ANY depth under `modelOptions` is refused, and the bounded leaves mean
 * no field VALUE can be a credential either (D1 by structure).
 */
const agentNativeModelOptionsSchema = z.union([
  reasoningEffortModelOptionsSchema,
  anthropicBudgetModelOptionsSchema,
  anthropicEffortModelOptionsSchema,
  geminiModelOptionsSchema,
]);

/** One provider's own closed shape(s) — the dispatch-switch convention. */
function nativeModelOptionsSchemaFor(provider: AgentProviderId) {
  switch (provider) {
    case "openai":
    case "openai-compatible":
    case "openrouter":
      return reasoningEffortModelOptionsSchema;
    case "anthropic":
      return anthropicModelOptionsSchema;
    case "google":
      return geminiModelOptionsSchema;
  }
}

/** The relay's entire accepted input — provably keyless (D1). */
export const agentRelayInputSchema = z
  .strictObject({
    provider: z.enum(AGENT_PROVIDER_IDS),
    modelId: z.string().min(1),
    modelOptions: agentNativeModelOptionsSchema.optional(),
    maxIterations: z
      .number()
      .int()
      .min(1)
      .max(AGENT_RELAY_MAX_ITERATIONS)
      .optional(),
    messages: z.array(relayMessageSchema).min(1),
  })
  .superRefine((value, ctx) => {
    // The per-provider half of the closed universe: a shape native to SOME
    // provider may still not ride another provider's run — the builder
    // emits the chosen provider's own shape, so anything else is a
    // malformed client.
    if (value.modelOptions !== undefined) {
      const native = nativeModelOptionsSchemaFor(value.provider).safeParse(
        value.modelOptions,
      );
      if (!native.success) {
        ctx.addIssue({
          code: "custom",
          path: ["modelOptions"],
          message: `modelOptions must be the ${value.provider} provider's native shape (reasoning.effort | thinking.budget_tokens | output_config.effort | thinkingConfig.thinkingLevel).`,
        });
      }
    }
    // The zod half of D1's double guard: the strict top-level object keeps
    // unknown FIELDS out of the parsed value, the closed schema above is
    // the modelOptions subtree's structural proof (the scan's one
    // exemption), and this refine keeps credential-bearing fields out of
    // the open (loose) message/part objects inside it.
    for (const finding of findApiKeyLikeFields(value, "$", {
      exemptRootKeys: API_KEY_SCAN_EXEMPT_ROOT_KEYS,
    })) {
      ctx.addIssue({
        code: "custom",
        message: `Client API keys never cross to the server: credential field "${finding.field}" at ${finding.path}.`,
      });
    }
  });

/** The parsed relay input — the five fields, and never a key. */
export type AgentRelayInput = z.output<typeof agentRelayInputSchema>;

/**
 * Field names (normalized: lowercase, non-alphanumerics stripped) that
 * equal one of these mark the payload as carrying a client credential.
 */
const API_KEY_LIKE_EXACT_NAMES = new Set(["key", "auth", "bearer"]);

/** Fragments whose presence in a normalized field name means the same. */
const API_KEY_LIKE_FRAGMENTS = [
  "apikey",
  "apisecret",
  "secretkey",
  "accesstoken",
  "bearertoken",
  "authorization",
  "credential",
  "password",
  "secret",
  "token",
] as const;

/** Whether a payload FIELD name looks like a client credential carrier. */
export function isApiKeyLikeFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (API_KEY_LIKE_EXACT_NAMES.has(normalized)) {
    return true;
  }
  return API_KEY_LIKE_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

/** One credential-bearing field discovered in a payload: its name and path. */
export interface ApiKeyLikeFinding {
  readonly field: string;
  readonly path: string;
}

/** Options for {@link findApiKeyLikeFields}. */
export interface ApiKeyLikeScanOptions {
  /**
   * Keys of the ROOT object (path `$`) whose subtrees are exempt from the
   * scan — their structure is validated elsewhere. The exemption is
   * positional: fields of the same name at any deeper path are NOT exempt.
   */
  readonly exemptRootKeys?: readonly string[];
}

/**
 * The ONE root the relay's credential scan exempts: the top-level
 * `modelOptions` subtree. Its schema is closed per provider (unknown
 * fields refused, leaves bounded), so D1 holds by STRUCTURE there — which
 * is what lets Anthropic's native `budget_tokens` field name through, a
 * name whose `token` fragment the scan must keep flagging everywhere
 * else, chiefly inside `messages`. Exported so the client-side
 * body-contract tests scan the fetcher's emitted body with exactly the
 * relay's own posture.
 */
export const API_KEY_SCAN_EXEMPT_ROOT_KEYS = ["modelOptions"] as const;

/**
 * Deeply scans a JSON payload for apiKey-like FIELD names (never values —
 * a user typing a key into chat is their own text; the D1 invariant is
 * that the client SOFTWARE must never send keys as fields).
 */
export function findApiKeyLikeFields(
  value: unknown,
  path: string = "$",
  options: ApiKeyLikeScanOptions = {},
): ApiKeyLikeFinding[] {
  const findings: ApiKeyLikeFinding[] = [];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      findings.push(
        ...findApiKeyLikeFields(item, `${path}[${String(index)}]`, options),
      );
    }
    return findings;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (path === "$" && options.exemptRootKeys?.includes(key) === true) {
        continue;
      }
      const childPath = `${path}.${key}`;
      if (isApiKeyLikeFieldName(key)) {
        findings.push({ field: key, path: childPath });
      }
      findings.push(...findApiKeyLikeFields(child, childPath, options));
    }
  }
  return findings;
}

/**
 * The server-side provider credential surface, read from `@slopcad/env`'s
 * optional agent vars by the route (D2/D6): one key per named provider,
 * plus the OpenAI-compatible pair. Empty by default — no key, no server
 * mode for that provider.
 */
export interface AgentRelayEnvKeys {
  readonly openAiKey?: string;
  readonly anthropicKey?: string;
  readonly googleKey?: string;
  readonly openRouterKey?: string;
  readonly openAiCompatibleKey?: string;
  readonly openAiCompatibleBaseUrl?: string;
}

/** A provider's resolved server credentials, or why they are unavailable. */
export type ProviderCredentialResolution =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly baseURL?: string;
    }
  | {
      readonly ok: false;
      readonly provider: AgentProviderId;
      readonly missingEnvVars: readonly string[];
    };

/**
 * An env var counts as carrying a credential only when it has a value: an
 * EMPTY string is exactly as unconfigured as an unset one — the same rule
 * `serverProviderIdsWithEnvKeys` applies to the picker's provider list.
 */
function configuredValue(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Resolves a provider's server-side credentials. Pure: the provider→env
 * mapping lives here and nowhere else, and a missing (or empty-string) key
 * NEVER falls back to another provider (D6) — the refusal names the
 * provider and its env var(s) so the caller (and operator) can act on
 * exactly that provider.
 */
export function resolveAgentProviderCredentials(
  provider: AgentProviderId,
  keys: AgentRelayEnvKeys,
): ProviderCredentialResolution {
  switch (provider) {
    case "openai": {
      const apiKey = configuredValue(keys.openAiKey);
      return apiKey === undefined
        ? missing(provider, ["OPENAI_KEY"])
        : { ok: true, apiKey };
    }
    case "anthropic": {
      const apiKey = configuredValue(keys.anthropicKey);
      return apiKey === undefined
        ? missing(provider, ["ANTHROPIC_KEY"])
        : { ok: true, apiKey };
    }
    case "google": {
      const apiKey = configuredValue(keys.googleKey);
      return apiKey === undefined
        ? missing(provider, ["GOOGLE_KEY"])
        : { ok: true, apiKey };
    }
    case "openrouter": {
      const apiKey = configuredValue(keys.openRouterKey);
      return apiKey === undefined
        ? missing(provider, ["OPENROUTER_KEY"])
        : { ok: true, apiKey };
    }
    case "openai-compatible": {
      const key = configuredValue(keys.openAiCompatibleKey);
      const baseURL = configuredValue(keys.openAiCompatibleBaseUrl);
      if (key === undefined || baseURL === undefined) {
        const missingEnvVars: string[] = [];
        if (key === undefined) {
          missingEnvVars.push("OPENAI_COMPATIBLE_KEY");
        }
        if (baseURL === undefined) {
          missingEnvVars.push("OPENAI_COMPATIBLE_BASE_URL");
        }
        return missing(provider, missingEnvVars);
      }
      return { ok: true, apiKey: key, baseURL };
    }
  }
}

function missing(
  provider: AgentProviderId,
  missingEnvVars: readonly string[],
): ProviderCredentialResolution {
  return { ok: false, provider, missingEnvVars };
}

/** The relay's structured failure envelope (the io endpoints' shape). */
export interface AgentRelayFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/** Reads the caller's session from the request headers — the auth package's `auth.api.getSession` shape, injected by the route. */
export type AgentRelaySessionLookup = (
  headers: Headers,
) => Promise<{ readonly user: { readonly id: string } } | null>;

/**
 * The D13 access resolution, injected so this module holds no copy of it:
 * the route wires `@slopcad/api/user-options`'s `isServerAiAllowed` (the
 * allow-all env posture OR the caller's own granting `user_options` row).
 */
export type AgentServerAiAccessResolver = (userId: string) => Promise<boolean>;

/** Everything the handler needs from its host, injected for testability. */
export interface AgentRelayDeps {
  readonly getSession: AgentRelaySessionLookup;
  readonly isServerAiAllowed: AgentServerAiAccessResolver;
  readonly envKeys: AgentRelayEnvKeys;
  /** Injectable transport (the provider factories' convention); defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The native per-provider `modelOptions` union across the five adapters (D8). */
export type AgentProviderModelOptions =
  AgentProviderAdapter["~types"]["providerOptions"];

function relayFailure(status: number, code: string, message: string): Response {
  const payload: AgentRelayFailure = { ok: false, code, message };
  return Response.json(payload, { status });
}

/** The relay's POST handling: gates, adapter, SSE stream. */
export async function handleAgentRelayRequest(
  request: Request,
  deps: AgentRelayDeps,
): Promise<Response> {
  const session = await deps.getSession(request.headers);
  if (session === null) {
    return relayFailure(
      401,
      "agent-relay/authentication-required",
      "A signed-in session is required to use server-emitted chat.",
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return relayFailure(
      400,
      "agent-relay/malformed-body",
      "The relay accepts exactly one JSON object as the request body.",
    );
  }

  // The handler half of D1's double guard — over the RAW payload, so the
  // refusal fires before any database work and names the offending field.
  // The same single modelOptions exemption applies: that subtree's proof
  // is its closed structure (checked by the schema next), never the scan.
  const keyFindings = findApiKeyLikeFields(payload, "$", {
    exemptRootKeys: API_KEY_SCAN_EXEMPT_ROOT_KEYS,
  });
  if (keyFindings.length > 0) {
    const fields = [...new Set(keyFindings.map((finding) => finding.field))]
      .map((field) => `"${field}"`)
      .join(", ");
    return relayFailure(
      400,
      "agent-relay/client-key-rejected",
      `Client API keys never cross to the server. The request body carries credential field(s) ${fields} (first at ${keyFindings[0]?.path ?? "$"}); send only { provider, modelId, modelOptions, messages }.`,
    );
  }

  const parsed = agentRelayInputSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    return relayFailure(
      400,
      "agent-relay/invalid-input",
      `The relay request is invalid: ${details}`,
    );
  }
  const input: AgentRelayInput = parsed.data;

  if (!(await deps.isServerAiAllowed(session.user.id))) {
    return relayFailure(
      403,
      "agent-relay/server-ai-not-permitted",
      "Server-emitted chat is not enabled for this account.",
    );
  }

  const credentials = resolveAgentProviderCredentials(
    input.provider,
    deps.envKeys,
  );
  if (!credentials.ok) {
    return relayFailure(
      422,
      "agent-relay/provider-not-configured",
      `Server-emitted chat is not configured for provider "${credentials.provider}": missing ${credentials.missingEnvVars.join(", ")}. No other provider is used in its place.`,
    );
  }

  const adapter = createAgentProviderAdapter(input.provider, {
    apiKey: credentials.apiKey,
    modelId: input.modelId,
    ...(credentials.baseURL === undefined
      ? {}
      : { baseURL: credentials.baseURL }),
    fetch: deps.fetch ?? globalThis.fetch,
  });

  // Two documented widenings at the provider-generic relay boundary,
  // mirroring the factory-boundary widening in providers/openai.ts: the
  // values are the client's own wire shapes (its message history and its
  // native modelOptions from the same Phase 1.3 builder the client-direct
  // mode uses), JSON-validated above. The messages widening goes through
  // `unknown` because the schema's `parts` are deliberately open — an
  // intentionally WIDER type than UIMessage's literal part union (Phase 3
  // forward-compat), so the types cannot overlap by construction; at
  // runtime chat() consumes the UIMessage wire format verbatim and
  // converts it itself. The modelOptions widening rides the same bridge:
  // the typed local first PINS the closed schema's output to the Phase
  // 1.3 builder's own union (one source of truth), then crosses to the
  // adapters' providerOptions because the relay's shapes keep
  // effort/thinkingLevel as bounded strings (the catalog is the single
  // source of offered values, D8) while each SDK narrows them to literal
  // unions per model.
  const messages = input.messages as unknown as UIMessage[];
  const nativeModelOptions: AgentModelOptions | undefined = input.modelOptions;
  const modelOptions = nativeModelOptions as unknown as
    AgentProviderModelOptions | undefined;

  // A client disconnect aborts the upstream provider call instead of
  // paying for a stream nobody reads.
  const abortController = new AbortController();
  request.signal.addEventListener(
    "abort",
    () => {
      abortController.abort();
    },
    { once: true },
  );

  return toServerSentEventsResponse(
    chat({
      adapter,
      messages,
      // The caller's loop bound (1..25) becomes the engine's own stop
      // rule; omitted, chat()'s library default — maxIterations(5) —
      // applies (the engine's own fallback, not a copy of it here).
      ...(input.maxIterations === undefined
        ? {}
        : { agentLoopStrategy: maxIterations(input.maxIterations) }),
      ...(modelOptions === undefined ? {} : { modelOptions }),
      abortController,
    }),
  );
}
