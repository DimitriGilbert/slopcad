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
 * - The raw model id input is ALWAYS visible (D5's "always typable");
 *   when filled it overrides the picker — the explicit string is the more
 *   specific intent, and the picker exists to fill, not to veto it.
 * - The reasoning controls offer EXACTLY the selected model's catalog
 *   `reasoning_options`: an effort select over the declared `values`, a
 *   budget number over the declared `min`; both hidden when the model
 *   declares no option, and never preselected (`""`/`0` mean "off").
 * - Server mode is offered only when `serverProviders()` allows it, and a
 *   stored `server` choice coerces back to `client` when it is not.
 *
 * The API key is client-only (D1): it maps into the config store's
 * per-provider map and never leaves the browser except to the chosen
 * provider's own endpoint.
 */

import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import { z } from "zod";
import type { NamedProviderId } from "@slopcad/api/providers";

import { AGENT_PROVIDER_IDS, type AgentProviderId } from "../providers";
import {
  DEFAULT_MAX_ITERATIONS,
  type AgentChatMode,
  type AgentConfig,
  type AgentReasoningSelection,
} from "../config/store";
import { AGENT_BASE_INSTRUCTION } from "../use-agent-chat";
import { safeHttpUrl } from "./safe-http-url";

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
 * the server's models.dev catalog cache; `openai-compatible` lists from
 * its own endpoint's `/models`; no provider chosen means no source yet.
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
 * hand the result straight to `modelCatalog.list`/`refresh`.
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
  /** The always-visible raw model string; overrides the picker when set. */
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

/** Builds the form's (remembered) default values from the live config. */
export function agentSettingsValuesFromConfig(
  config: AgentConfig,
  serverModeAllowed: boolean,
): AgentSettingsValues {
  return {
    apiKey:
      config.provider === null
        ? ""
        : (config.apiKeyByProvider[config.provider] ?? ""),
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
    if (trimmedKey === "") {
      delete apiKeyByProvider[values.provider];
    } else {
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
   * fields whenever the in-form selection changes, and the factory hands
   * each rebuild's selection to the model picker's option source, so the
   * picker re-keys without a save.
   */
  readonly liveProvider: AgentProviderId | null;
  /** Whether `serverProviders()` allows the server mode option (D13). */
  readonly serverModeAllowed: boolean;
  /**
   * The model picker's async option source (catalog query or endpoint),
   * invoked with the LIVE provider selection the fields were built for.
   */
  readonly modelAsyncOptions: (
    query: string,
    liveProvider: AgentProviderId | null,
  ) => Promise<readonly { value: string; label: string }[]>;
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
            "The slopcad server calls the provider with its own keys.",
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
    },
    {
      name: "openAiCompatibleBaseUrl",
      type: "text",
      label: "Endpoint base URL",
      description:
        "The endpoint's own base URL, e.g. https://host/v1 — its /models list feeds the picker.",
      placeholder: "https://your-endpoint/v1",
      conditional: (values) => values.provider === "openai-compatible",
    },
    {
      name: "modelId",
      type: "autocomplete",
      label: "Model",
      description:
        "Search the {{provider}} model list; nothing is preselected.",
      placeholder: "Search models…",
      autocompleteConfig: {
        allowCustom: false,
        // The picker's source keys on the LIVE selection this field list
        // was built for — the sheet rebinds the list on every provider
        // switch, so the option fetch follows the form without a save.
        asyncOptions: (query) =>
          deps.modelAsyncOptions(query, deps.liveProvider),
        debounceMs: 200,
        minChars: 0,
        noOptionsText: "No models — type a raw id below or refresh.",
      },
      conditional: (values) => values.provider !== "",
    },
    {
      name: "rawModelId",
      type: "text",
      label: "Model id",
      description:
        "The exact model string sent to the provider; when filled it overrides the picker.",
      placeholder: "type any model id",
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
    },
    {
      name: "systemPrompt",
      type: "textarea",
      label: "System prompt",
      description:
        "Your instruction to the agent. The document state and tool catalogue are appended automatically.",
      rows: 5,
      textareaConfig: { resize: "vertical" },
    },
    {
      name: "maxIterations",
      type: "number",
      label: "Max iterations",
      description: `Upper bound on model turns per run (default ${DEFAULT_MAX_ITERATIONS}).`,
      min: 1,
      max: AGENT_MAX_ITERATIONS_CEILING,
      step: 1,
    },
    {
      name: "syncEnabled",
      type: "switch",
      label: "Sync conversations to the server",
      description:
        "Opt-in: local conversations also push to your slopcad account.",
      conditional: (values) => values.mode === "client",
    },
  ];
}
