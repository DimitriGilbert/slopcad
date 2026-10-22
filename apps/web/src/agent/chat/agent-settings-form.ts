/**
 * The agent settings form as Formedible CONFIG (PLAN-AGENT-CHAT Phase
 * 4.5, D5/D8/D14): schema + field list + the pure value mappings, kept
 * free of React so node-env tests pin the whole contract — the sheet
 * component (`./agent-settings`) only binds runtime inputs (the catalog
 * queries, the endpoint fetch) into the {@link createAgentSettingsFields}
 * factory.
 *
 * D5 discipline, field by field:
 *
 * - `provider` and the model fields default to `""`/untyped — nothing is
 *   preselected, and `""` is a real option ("Not chosen") rather than a
 *   hidden sentinel.
 * - The raw model id input is ALWAYS visible (D5's "always typable") and
 *   stays the resolution authority, but it is not a silent veto: the
 *   sheet mirrors every picker change into it (`pickerMirroredRawId`),
 *   so the saved-model prefill can never outvote a fresh pick. A
 *   hand-typed string remains the override until the next pick.
 * - The reasoning controls offer EXACTLY the selected model's catalog
 *   `reasoning_options`: an effort select over the declared `values`, a
 *   budget number over the declared `min`; both hidden when the model
 *   declares no option, and never preselected (`""`/`0` mean "off").
 * - Server mode is offered only when `serverProviders()` allows it, and a
 *   stored `server` choice coerces back to `client` when it is not.
 *
 * The API key is client-only (D1): it maps into the config store's
 * per-provider map and never leaves the browser except to the chosen
 * provider's own endpoint. The field always shows the CHOSEN provider's
 * own stored key (`apiKeySeedFor` — the prefill and the sheet's
 * in-form provider-switch reseed share the one lookup), and a patch
 * never overwrites a stored key with an empty string.
 */

import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import type {
  FormedibleFieldComponent,
  FormedibleFieldConfig,
} from "@slopcad/ui/components/formedible/lib/types";
import { z } from "zod";
import type { NamedProviderId } from "@slopcad/api/providers";
import {
  AGENT_PROVIDER_IDS,
  type AgentProviderId,
} from "@slopcad/ui/agent/providers";
import {
  DEFAULT_MAX_ITERATIONS,
  type AgentChatMode,
  type AgentConfig,
  type AgentReasoningSelection,
} from "@slopcad/ui/agent/config/store";
import { AGENT_BASE_INSTRUCTION } from "@slopcad/ui/agent/use-agent-chat";
import { safeHttpUrl } from "@slopcad/ui/agent/chat/safe-http-url";

/** The relay's own bound on the loop strategy (docs/research §8). */
export const AGENT_MAX_ITERATIONS_CEILING = 25;

/** The provider select's options: one per catalog provider id, D6's five. */
export const AGENT_PROVIDER_OPTIONS: readonly {
  readonly value: AgentProviderId;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    description: "Models from the OpenRouter catalog.",
    label: "OpenRouter",
    value: "openrouter",
  },
  {
    description: "Models from OpenAI.",
    label: "OpenAI",
    value: "openai",
  },
  {
    description: "Models from Anthropic.",
    label: "Anthropic",
    value: "anthropic",
  },
  {
    description: "Models from Google.",
    label: "Google",
    value: "google",
  },
  {
    description: "Any endpoint that speaks the OpenAI-compatible API.",
    label: "OpenAI-compatible endpoint",
    value: "openai-compatible",
  },
];

/** The "nothing chosen" select value (D5: a real option, not a sentinel). */
export const UNSET_CHOICE = "";

/** Where the model picker's options come from, given the chosen provider. */
export type AgentModelPickerSource = "catalog" | "endpoint";

/**
 * D14's scoping, as one pure lookup: the four named providers list from
 * the browser's models.dev catalog cache (BYOK — fetched and cached
 * client-side, no auth); `openai-compatible` lists from its own
 * endpoint's `/models`; no provider chosen means no source yet.
 */
export function modelPickerSourceFor(
  provider: AgentProviderId | null,
): AgentModelPickerSource | null {
  if (provider === null) {
    return null;
  }
  return provider === "openai-compatible" ? "endpoint" : "catalog";
}

/**
 * The form's LIVE provider selection (D5): `null` while "Not chosen".
 * The sheet keys the catalog-backed picker, its refresh row, and the
 * reasoning controls on THIS — what the open form selects — rather than
 * the saved config's provider, so first-time configuration works before
 * any Save.
 */
export function liveProviderOf(
  provider: AgentSettingsValues["provider"],
): AgentProviderId | null {
  return provider === "" ? null : provider;
}

/**
 * The catalog-scoped view of a provider choice (D14): the id itself when
 * it is one of the four named providers, `null` for the BYO-endpoint
 * provider (never catalog-backed) and for no choice — typed so callers
 * hand the result straight to the browser catalog loader.
 */
export function namedCatalogProviderOf(
  provider: AgentProviderId | null,
): NamedProviderId | null {
  if (provider === null || provider === "openai-compatible") {
    return null;
  }
  return provider;
}

/**
 * One option in the model picker's list — what the sheet hands the
 * command-picker field for the LIVE provider. `label` is the human name
 * (a bare id for the BYO endpoint's `/models` list), `value` the model
 * id committed to the form, `family` the group heading, and `detail`
 * the right-edge readout (context size) when the catalog declares one.
 */
export interface AgentModelPickerOption {
  readonly value: string;
  readonly label: string;
  readonly family: string;
  readonly detail?: string;
}

/**
 * How the picker's option source is doing. `loading`/`error`/`empty`
 * render an honest state line inside the list (no fake success): an
 * upstream or transport failure keeps whatever entries were already
 * served — `options` may be non-empty under `error` (the stale cache).
 */
export type AgentModelPickerStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty"; readonly message: string };

/**
 * Everything the command-picker field needs, resolved by the sheet for
 * the LIVE provider: the (already grouped-by-family-at-render) options,
 * the source's status, and the empty-state copy for that source.
 */
export interface AgentModelPickerData {
  readonly options: readonly AgentModelPickerOption[];
  readonly status: AgentModelPickerStatus;
  /**
   * The text the list shows while nothing matches the search AND the
   * source has options, or while the source is `ready` with none —
   * each naming the raw-id escape hatch (D5's always-typable rule).
   */
  readonly emptyText: string;
}

/** `fieldConfig.pickerData` on the `modelId` field (custom-prop channel). */
export const MODEL_PICKER_DATA_PROP = "pickerData";

/**
 * The group heading a model belongs under, derived without any catalog
 * field the cache does not store: cut a display NAME at its first
 * digit-bearing token ("Claude Sonnet 4.5" → "Claude Sonnet",
 * "Gemini 3 Pro" → "Gemini"); a digit-leading first token ("GPT-5.2")
 * yields its alpha head ("GPT"). Bare ids take the same rule on
 * dash-segments ("claude-sonnet-4-5" → "claude-sonnet"), and a name or
 * id with no usable stem groups under itself.
 */
export function modelFamilyOf(name: string, modelId: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const nameCut = tokens.findIndex((token) => /\d/.test(token));
  if (nameCut > 0) {
    return tokens.slice(0, nameCut).join(" ");
  }
  if (nameCut === 0) {
    const stem = (tokens[0] ?? "").replace(/\d.*$/, "").replace(/[-.]+$/, "");
    if (stem.length >= 2) {
      return stem;
    }
  }
  const segments = modelId.trim().split("-").filter(Boolean);
  const idCut = segments.findIndex((segment) => /\d/.test(segment));
  if (idCut > 0) {
    return segments.slice(0, idCut).join("-");
  }
  if (idCut === 0) {
    const stem = (segments[0] ?? "").replace(/\d.*$/, "");
    if (stem.length >= 2) {
      return stem;
    }
  }
  return name.trim() !== "" ? name.trim() : modelId.trim();
}

/**
 * The picker's right-edge context readout: models.dev `limit.context`
 * compacted (128000 → "128k", 1_000_000 → "1M"), undefined when the
 * model declares no limit.
 */
export function formatContextLimit(limit: number | null): string | undefined {
  if (limit === null || !Number.isInteger(limit) || limit <= 0) {
    return undefined;
  }
  if (limit >= 1_000_000) {
    const millions = limit / 1_000_000;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (limit >= 1000) {
    return `${Math.round(limit / 1000)}k`;
  }
  return String(limit);
}

/**
 * Groups picker options by family, preserving each family's first-seen
 * order and the catalog's newest-first ordering within it. Pure so the
 * node test pins the grouping without rendering the picker.
 */
export function groupModelPickerOptions(
  options: readonly AgentModelPickerOption[],
): readonly {
  readonly family: string;
  readonly options: AgentModelPickerOption[];
}[] {
  const groups: { family: string; options: AgentModelPickerOption[] }[] = [];
  const byFamily = new Map<string, AgentModelPickerOption[]>();
  for (const option of options) {
    const bucket = byFamily.get(option.family);
    if (bucket === undefined) {
      const created: AgentModelPickerOption[] = [option];
      byFamily.set(option.family, created);
      groups.push({ family: option.family, options: created });
    } else {
      bucket.push(option);
    }
  }
  return groups;
}

/**
 * The form's values — every select-able choice is `""` until chosen. A
 * type alias (not an interface) so it satisfies Formedible's
 * `Record<string, unknown>` values constraint structurally.
 */
export type AgentSettingsValues = {
  mode: AgentChatMode;
  provider: AgentProviderId | "";
  apiKey: string;
  openAiCompatibleBaseUrl: string;
  /** The picker's choice; `""` when the raw string is the only source. */
  modelId: string;
  /**
   * The always-visible raw model string — the resolution authority that
   * mirrors every picker edit (`pickerMirroredRawId`), so a hand-typed
   * value is the override and a picker edit is never vetoed.
   */
  rawModelId: string;
  /** An offered effort label; `""` = not chosen. */
  reasoningEffort: string;
  /** A budget-token count; 0 = not chosen (budgets start above zero). */
  reasoningBudgetTokens: number;
  systemPrompt: string;
  maxIterations: number;
  syncEnabled: boolean;
};

const providerEnum = z.enum([UNSET_CHOICE, ...AGENT_PROVIDER_IDS]);

/**
 * The form's schema. Cross-field rules live in the final `superRefine`:
 * the endpoint URL must be an http(s) URL exactly when the BYO-endpoint
 * provider is chosen (field-level refine cannot see the provider).
 */
export const agentSettingsSchema = z
  .object({
    mode: z.enum(["client", "server"]),
    provider: providerEnum,
    apiKey: z.string(),
    openAiCompatibleBaseUrl: z.string(),
    modelId: z.string(),
    rawModelId: z.string(),
    reasoningEffort: z.string(),
    reasoningBudgetTokens: z.number().int().min(0),
    systemPrompt: z.string(),
    maxIterations: z.number().int().min(1).max(AGENT_MAX_ITERATIONS_CEILING),
    syncEnabled: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (
      values.provider === "openai-compatible" &&
      values.openAiCompatibleBaseUrl.trim() !== "" &&
      safeHttpUrl(values.openAiCompatibleBaseUrl.trim()) === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "The endpoint base URL must be a complete http(s) URL (e.g. https://host/v1).",
        path: ["openAiCompatibleBaseUrl"],
      });
    }
  });

/**
 * The stored key of the given provider, as the key FIELD should show it:
 * that provider's own entry, or `""` — never another provider's key. The
 * prefill and the sheet's in-form provider-switch reseed (the
 * cross-provider leak fix) share this one lookup.
 */
export function apiKeySeedFor(
  config: AgentConfig,
  provider: AgentProviderId | null,
): string {
  return provider === null ? "" : (config.apiKeyByProvider[provider] ?? "");
}

/**
 * The picker-mirror rule (the raw-veto fix): the resolver is raw-first,
 * so every picker edit is written into the raw id field verbatim — the
 * raw field then carries the picked id until the next pick or a
 * hand-typed override. `null` = the picker did not move; leave the raw
 * field alone (a raw-field edit must not be clobbered).
 */
export function pickerMirroredRawId(
  previousModelId: string,
  nextModelId: string,
): string | null {
  return nextModelId === previousModelId ? null : nextModelId;
}

/** Builds the form's (remembered) default values from the live config. */
export function agentSettingsValuesFromConfig(
  config: AgentConfig,
  serverModeAllowed: boolean,
): AgentSettingsValues {
  return {
    apiKey: apiKeySeedFor(config, config.provider),
    maxIterations: config.maxIterations,
    mode:
      config.mode === "server" && !serverModeAllowed ? "client" : config.mode,
    modelId: config.provider === null ? "" : (config.modelId ?? ""),
    openAiCompatibleBaseUrl: config.openAiCompatibleBaseUrl ?? "",
    provider: config.provider ?? "",
    rawModelId: config.provider === null ? "" : (config.modelId ?? ""),
    reasoningBudgetTokens:
      config.reasoning?.type === "budget_tokens" ? config.reasoning.value : 0,
    reasoningEffort:
      config.reasoning?.type === "effort" ? config.reasoning.value : "",
    syncEnabled: config.syncEnabled,
    systemPrompt: config.systemPrompt ?? AGENT_BASE_INSTRUCTION,
  };
}

/**
 * The effective model id: the raw string when filled (the explicit
 * override), the picker's choice otherwise, `null` when neither — the
 * unconfigured state (D5).
 */
export function resolveSettingsModelId(
  values: AgentSettingsValues,
): string | null {
  const raw = values.rawModelId.trim();
  if (raw !== "") {
    return raw;
  }
  return values.modelId.trim() !== "" ? values.modelId.trim() : null;
}

/** The reasoning selection the values carry, gated by the model's option. */
export function reasoningSelectionOf(
  values: AgentSettingsValues,
  option: ModelReasoningOption | undefined,
): AgentReasoningSelection | null {
  if (
    option?.type === "effort" &&
    values.reasoningEffort !== "" &&
    option.values?.includes(values.reasoningEffort) === true
  ) {
    return { type: "effort", value: values.reasoningEffort };
  }
  if (
    option?.type === "budget_tokens" &&
    values.reasoningBudgetTokens > 0 &&
    option.min !== undefined &&
    values.reasoningBudgetTokens >= option.min
  ) {
    return { type: "budget_tokens", value: values.reasoningBudgetTokens };
  }
  return null;
}

/**
 * Maps submitted values onto a config-store patch. The current config
 * rides along so the per-provider key map keeps the OTHER providers'
 * keys (the store's patch is a shallow merge) and the stored system
 * prompt round-trips (an explicitly emptied prompt stays empty — that is
 * the documented "context block only" mode).
 *
 * The key map only ever WRITES a non-empty field: the field always shows
 * the chosen provider's own stored key (the prefill/reseed contract), so
 * an empty submission means "unchanged" — it can neither move a previous
 * provider's key into the new slot nor erase a stored one.
 */
export function agentConfigPatchFromSettingsValues(
  values: AgentSettingsValues,
  input: {
    readonly config: AgentConfig;
    readonly reasoningOption: ModelReasoningOption | undefined;
  },
): Partial<AgentConfig> {
  const { config, reasoningOption } = input;
  const apiKeyByProvider: Partial<Record<AgentProviderId, string>> = {
    ...config.apiKeyByProvider,
  };
  if (values.provider !== "") {
    const trimmedKey = values.apiKey.trim();
    if (trimmedKey !== "") {
      apiKeyByProvider[values.provider] = trimmedKey;
    }
  }
  return {
    apiKeyByProvider,
    maxIterations: values.maxIterations,
    mode: values.mode,
    modelId: resolveSettingsModelId(values),
    openAiCompatibleBaseUrl:
      values.provider === "openai-compatible"
        ? values.openAiCompatibleBaseUrl.trim() === ""
          ? null
          : values.openAiCompatibleBaseUrl.trim()
        : config.openAiCompatibleBaseUrl,
    provider: values.provider === "" ? null : values.provider,
    reasoning: reasoningSelectionOf(values, reasoningOption),
    syncEnabled: values.mode === "client" ? values.syncEnabled : false,
    systemPrompt: values.systemPrompt,
  };
}

/** Everything the field factory binds from the host. */
export interface AgentSettingsFieldsDeps {
  /**
   * The form's LIVE provider selection (D14) — what the open sheet has
   * chosen, not the saved config's provider. The sheet rebuilds these
   * fields whenever the in-form selection changes, so the picker re-keys
   * without a save.
   */
  readonly liveProvider: AgentProviderId | null;
  /** Whether `serverProviders()` allows the server mode option (D13). */
  readonly serverModeAllowed: boolean;
  /**
   * The model picker's renderer — the sheet injects its `command`-based
   * grouped picker here so this module stays React-free. Optional: node
   * tests pin the config without a renderer (the field then falls back
   * to the registry's autocomplete).
   */
  readonly modelPickerComponent?: FormedibleFieldComponent<AgentSettingsValues>;
  /**
   * The picker's option list + source status for the LIVE provider
   * (catalog cache or endpoint `/models`); lands on the field's custom
   * `pickerData` prop for the component to read.
   */
  readonly modelPickerData: AgentModelPickerData;
  /**
   * The catalog `reasoning_options` entry of the model the VALUES name —
   * read per conditional/options evaluation, so both reasoning controls
   * track the live picker choice.
   */
  readonly reasoningOptionOf: (
    values: AgentSettingsValues,
  ) => ModelReasoningOption | undefined;
}

/** The mode select's options: client always, server only when allowed. */
function modeOptions(serverModeAllowed: boolean): readonly {
  value: AgentChatMode;
  label: string;
  description: string;
}[] {
  return serverModeAllowed
    ? [
        {
          description: "The browser calls the provider with your key (D1).",
          label: "Client (this browser)",
          value: "client",
        },
        {
          description:
            "The slopcad server calls the provider with its own keys. Text-only: the agent's tools are unavailable in this mode.",
          label: "Server (slopcad relay)",
          value: "server",
        },
      ]
    : [
        {
          description: "The browser calls the provider with your key (D1).",
          label: "Client (this browser)",
          value: "client",
        },
      ];
}

/** The effort select's options: exactly the catalog-declared values. */
export function reasoningEffortOptionsOf(
  option: ModelReasoningOption | undefined,
): readonly string[] {
  if (option?.type !== "effort") {
    return [];
  }
  return option.values ?? [];
}

/**
 * The field list's three named groups (the dialog's section bands —
 * "provider section + model section + connection/auth state" read as
 * three runs): Connection holds the mode/provider/key/endpoint set,
 * Model the picker + raw id + reasoning controls, Behavior the prompt,
 * iteration bound and sync opt-in.
 */
const SECTION_CONNECTION = "Connection";
const SECTION_MODEL = "Model";
const SECTION_BEHAVIOR = "Behavior";

/**
 * Builds the field list. Conditional visibility is config, not code:
 * `conditional` functions read the live values, so provider and mode
 * switches restyle the form without any hand-rolled field juggling.
 */
export function createAgentSettingsFields(
  deps: AgentSettingsFieldsDeps,
): readonly FormedibleFieldConfig<AgentSettingsValues>[] {
  const { reasoningOptionOf } = deps;
  return [
    {
      name: "mode",
      type: "select",
      label: "Mode",
      description: "Where the model calls run.",
      options: modeOptions(deps.serverModeAllowed),
      section: SECTION_CONNECTION,
    },
    {
      name: "provider",
      type: "select",
      label: "Provider",
      description: "Nothing is chosen until you choose (D5).",
      options: [
        {
          description: "Pick a provider to configure it.",
          label: "Not chosen",
          value: UNSET_CHOICE,
        },
        ...AGENT_PROVIDER_OPTIONS,
      ],
      section: SECTION_CONNECTION,
    },
    {
      name: "apiKey",
      type: "password",
      label: "{{provider}} API key",
      description:
        "Stored only in this browser — it never reaches the slopcad server.",
      passwordConfig: { showToggle: true },
      placeholder: "sk-…",
      conditional: (values) => values.provider !== "",
      section: SECTION_CONNECTION,
    },
    {
      name: "openAiCompatibleBaseUrl",
      type: "text",
      label: "Endpoint base URL",
      description:
        "The endpoint's own base URL, e.g. https://host/v1 — its /models list feeds the picker.",
      placeholder: "https://your-endpoint/v1",
      conditional: (values) => values.provider === "openai-compatible",
      section: SECTION_CONNECTION,
    },
    {
      name: "modelId",
      type: "autocomplete",
      // The command-picker renderer is injected by the sheet (this module
      // stays React-free); `pickerData` is the custom-prop channel the
      // component reads its options + source status from.
      component: deps.modelPickerComponent,
      [MODEL_PICKER_DATA_PROP]: deps.modelPickerData,
      label: "Model",
      description: "Search the {{provider}} catalog; nothing is preselected.",
      placeholder: "Choose a model…",
      conditional: (values) => values.provider !== "",
      section: SECTION_MODEL,
    },
    {
      name: "rawModelId",
      type: "text",
      label: "Model id",
      description:
        "The exact model string sent to the provider — it follows the picker; type here to override or when the catalog does not list the model.",
      placeholder: "type any model id",
      section: SECTION_MODEL,
    },
    {
      name: "reasoningEffort",
      type: "select",
      label: "Reasoning effort",
      description:
        "The model's own effort levels, as the provider defines them.",
      options: (values) =>
        reasoningEffortOptionsOf(reasoningOptionOf(values)).map((value) => ({
          label: value,
          value,
        })),
      conditional: (values) =>
        reasoningEffortOptionsOf(reasoningOptionOf(values)).length > 0,
      section: SECTION_MODEL,
    },
    {
      name: "reasoningBudgetTokens",
      type: "number",
      label: "Thinking budget (tokens)",
      description:
        "0 disables extended thinking; anything above 0 must respect the model's own minimum.",
      min: 0,
      step: 1,
      conditional: (values) =>
        reasoningOptionOf(values)?.type === "budget_tokens",
      validation: (value, values) => {
        const option = reasoningOptionOf(values);
        if (
          option?.type !== "budget_tokens" ||
          option.min === undefined ||
          typeof value !== "number" ||
          value === 0
        ) {
          return null;
        }
        return value < option.min
          ? `The model's minimum thinking budget is ${option.min} tokens (0 disables).`
          : null;
      },
      section: SECTION_MODEL,
    },
    {
      name: "systemPrompt",
      type: "textarea",
      label: "System prompt",
      description:
        "Your instruction to the agent. The document state and tool catalogue are appended automatically.",
      rows: 5,
      textareaConfig: { resize: "vertical" },
      className: "sm:col-span-full",
      section: SECTION_BEHAVIOR,
    },
    {
      name: "maxIterations",
      type: "number",
      label: "Max iterations",
      description: `Upper bound on model turns per run (default ${DEFAULT_MAX_ITERATIONS}).`,
      min: 1,
      max: AGENT_MAX_ITERATIONS_CEILING,
      step: 1,
      section: SECTION_BEHAVIOR,
    },
    {
      name: "syncEnabled",
      type: "switch",
      label: "Sync conversations to the server",
      description:
        "Opt-in: local conversations also push to your slopcad account.",
      conditional: (values) => values.mode === "client",
      section: SECTION_BEHAVIOR,
    },
  ];
}
