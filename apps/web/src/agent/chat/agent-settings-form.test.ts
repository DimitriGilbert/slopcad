// @vitest-environment node
import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import { describe, expect, it } from "vitest";
import type { AgentProviderId } from "@slopcad/ui/agent/providers";
import {
  DEFAULT_MAX_ITERATIONS,
  type AgentConfig,
} from "@slopcad/ui/agent/config/store";
import { AGENT_BASE_INSTRUCTION } from "@slopcad/ui/agent/use-agent-chat";

import {
  agentConfigPatchFromSettingsValues,
  agentSettingsSchema,
  agentSettingsValuesFromConfig,
  createAgentSettingsFields,
  liveProviderOf,
  modelPickerSourceFor,
  reasoningEffortOptionsOf,
  reasoningSelectionOf,
  resolveSettingsModelId,
  UNSET_CHOICE,
  type AgentSettingsFieldsDeps,
  type AgentSettingsValues,
} from "./agent-settings-form";

/** The unconfigured config: the store's own defaults, verbatim in spirit. */
function unconfiguredConfig(): AgentConfig {
  return {
    apiKeyByProvider: {},
    maxIterations: DEFAULT_MAX_ITERATIONS,
    mode: "client",
    modelId: null,
    openAiCompatibleBaseUrl: null,
    provider: null,
    reasoning: null,
    syncEnabled: false,
    systemPrompt: null,
  };
}

function values(overrides: Partial<AgentSettingsValues>): AgentSettingsValues {
  return {
    apiKey: "",
    maxIterations: DEFAULT_MAX_ITERATIONS,
    mode: "client",
    modelId: "",
    openAiCompatibleBaseUrl: "",
    provider: "",
    rawModelId: "",
    reasoningBudgetTokens: 0,
    reasoningEffort: "",
    syncEnabled: false,
    systemPrompt: AGENT_BASE_INSTRUCTION,
    ...overrides,
  };
}

/** The field factory with a static reasoning lookup and stub options. */
function fields(
  reasoningByModel: Record<string, ModelReasoningOption> = {},
  serverModeAllowed = false,
  liveProvider: AgentProviderId | null = null,
): readonly FormedibleFieldConfig<AgentSettingsValues>[] {
  const deps: AgentSettingsFieldsDeps = {
    liveProvider,
    modelAsyncOptions: () => Promise.resolve([]),
    reasoningOptionOf: (current) => {
      const id = resolveSettingsModelId(current);
      return id === null ? undefined : reasoningByModel[id];
    },
    serverModeAllowed,
  };
  return createAgentSettingsFields(deps);
}

const fieldOf = (
  list: readonly FormedibleFieldConfig<AgentSettingsValues>[],
  name: string,
): FormedibleFieldConfig<AgentSettingsValues> => {
  const found = list.find((field) => field.name === name);
  if (found === undefined) {
    throw new Error(`no field named ${name}`);
  }
  return found;
};

/**
 * A field's visibility for a values scope — the Formedible renderer's own
 * function-conditional semantics (`evaluateFieldConditional` calls the
 * conditional with the scope values; every conditional here is a
 * function), inlined because the `lib/` subpath is type-only through the
 * package exports map.
 */
function visible(
  field: FormedibleFieldConfig<AgentSettingsValues>,
  values: AgentSettingsValues,
): boolean {
  if (field.conditional === undefined) {
    return true;
  }
  if (typeof field.conditional === "string") {
    // The string arm names a value path; every conditional this config
    // declares is a function, so the arm exists only for parity.
    const path = field.conditional as keyof AgentSettingsValues;
    return Boolean(values[path]);
  }
  return Boolean(field.conditional(values));
}

describe("agentSettingsValuesFromConfig (D5: nothing preselected)", () => {
  it("builds unconfigured defaults from a fresh config", () => {
    const built = agentSettingsValuesFromConfig(unconfiguredConfig(), false);
    expect(built).toEqual(values({}));
    expect(built.provider).toBe("");
    expect(built.modelId).toBe("");
    expect(built.rawModelId).toBe("");
    expect(built.reasoningEffort).toBe("");
    expect(built.reasoningBudgetTokens).toBe(0);
  });

  it("remembers the stored selection (picker + key + prompt)", () => {
    const built = agentSettingsValuesFromConfig(
      {
        ...unconfiguredConfig(),
        apiKeyByProvider: { anthropic: "key-anthropic" },
        modelId: "stored-model",
        provider: "anthropic",
        reasoning: { type: "effort", value: "high" },
        systemPrompt: "custom instructions",
      },
      false,
    );
    expect(built.apiKey).toBe("key-anthropic");
    expect(built.modelId).toBe("stored-model");
    expect(built.rawModelId).toBe("stored-model");
    expect(built.reasoningEffort).toBe("high");
    expect(built.systemPrompt).toBe("custom instructions");
  });

  it("coerces a stored server choice back to client when the server mode is disallowed", () => {
    const built = agentSettingsValuesFromConfig(
      { ...unconfiguredConfig(), mode: "server" },
      false,
    );
    expect(built.mode).toBe("client");
  });

  it("keeps a stored server choice when the server mode is allowed", () => {
    const built = agentSettingsValuesFromConfig(
      { ...unconfiguredConfig(), mode: "server" },
      true,
    );
    expect(built.mode).toBe("server");
  });

  it("fills the base instruction into an unedited system prompt", () => {
    const built = agentSettingsValuesFromConfig(unconfiguredConfig(), false);
    expect(built.systemPrompt).toBe(AGENT_BASE_INSTRUCTION);
  });
});

describe("modelPickerSourceFor (D14)", () => {
  it("answers null before a provider is chosen", () => {
    expect(modelPickerSourceFor(null)).toBeNull();
  });

  it("answers catalog for the four named providers", () => {
    expect(modelPickerSourceFor("openai")).toBe("catalog");
    expect(modelPickerSourceFor("anthropic")).toBe("catalog");
    expect(modelPickerSourceFor("google")).toBe("catalog");
    expect(modelPickerSourceFor("openrouter")).toBe("catalog");
  });

  it("answers endpoint for the BYO-endpoint provider", () => {
    expect(modelPickerSourceFor("openai-compatible")).toBe("endpoint");
  });
});

describe("liveProviderOf (D14: the sheet keys on the open form's selection)", () => {
  it("answers null while nothing is chosen (the empty + hint state)", () => {
    expect(liveProviderOf(values({}).provider)).toBeNull();
  });

  it("answers the chosen id, named or BYO-endpoint", () => {
    expect(liveProviderOf(values({ provider: "openrouter" }).provider)).toBe(
      "openrouter",
    );
    expect(
      liveProviderOf(values({ provider: "openai-compatible" }).provider),
    ).toBe("openai-compatible");
  });

  it("re-keys the picker source from the live selection without a save", () => {
    // First-time configuration: the saved config has no provider, but the
    // open form's select does — the picker source must follow the FORM,
    // not the saved config (the pre-fix bug: nothing listed until Save).
    const saved = agentSettingsValuesFromConfig(unconfiguredConfig(), false);
    expect(modelPickerSourceFor(liveProviderOf(saved.provider))).toBeNull();
    const picked: AgentSettingsValues = { ...saved, provider: "openrouter" };
    expect(modelPickerSourceFor(liveProviderOf(picked.provider))).toBe(
      "catalog",
    );
    const byo: AgentSettingsValues = {
      ...saved,
      provider: "openai-compatible",
    };
    expect(modelPickerSourceFor(liveProviderOf(byo.provider))).toBe("endpoint");
  });
});

describe("resolveSettingsModelId (D5: raw string always typable)", () => {
  it("is null when neither raw nor picker carries a value", () => {
    expect(resolveSettingsModelId(values({}))).toBeNull();
  });

  it("takes the picker choice when the raw string is empty", () => {
    expect(resolveSettingsModelId(values({ modelId: "picked" }))).toBe(
      "picked",
    );
  });

  it("the raw string overrides the picker when filled", () => {
    expect(
      resolveSettingsModelId(
        values({ modelId: "picked", rawModelId: " raw-id " }),
      ),
    ).toBe("raw-id");
  });

  it("the raw string alone carries the choice", () => {
    expect(resolveSettingsModelId(values({ rawModelId: "raw-only" }))).toBe(
      "raw-only",
    );
  });
});

describe("reasoningSelectionOf (D8: exactly the catalog's offered values)", () => {
  const effort: ModelReasoningOption = {
    type: "effort",
    values: ["low", "medium", "high"],
  };
  const budget: ModelReasoningOption = { type: "budget_tokens", min: 1024 };

  it("offers nothing without an option", () => {
    expect(
      reasoningSelectionOf(values({ reasoningEffort: "high" }), undefined),
    ).toBeNull();
  });

  it("takes an offered effort label", () => {
    expect(
      reasoningSelectionOf(values({ reasoningEffort: "high" }), effort),
    ).toEqual({ type: "effort", value: "high" });
  });

  it("refuses an effort value the option does not list", () => {
    expect(
      reasoningSelectionOf(values({ reasoningEffort: "ultra" }), effort),
    ).toBeNull();
  });

  it("zero means no budget (never preselected)", () => {
    expect(
      reasoningSelectionOf(values({ reasoningBudgetTokens: 0 }), budget),
    ).toBeNull();
  });

  it("takes a budget at or above the model minimum", () => {
    expect(
      reasoningSelectionOf(values({ reasoningBudgetTokens: 2048 }), budget),
    ).toEqual({ type: "budget_tokens", value: 2048 });
    expect(
      reasoningSelectionOf(values({ reasoningBudgetTokens: 1024 }), budget),
    ).toEqual({ type: "budget_tokens", value: 1024 });
  });

  it("refuses a budget below the model minimum", () => {
    expect(
      reasoningSelectionOf(values({ reasoningBudgetTokens: 512 }), budget),
    ).toBeNull();
  });
});

describe("agentConfigPatchFromSettingsValues", () => {
  it("maps an unconfigured submission back to the unconfigured config", () => {
    const patch = agentConfigPatchFromSettingsValues(values({}), {
      config: unconfiguredConfig(),
      reasoningOption: undefined,
    });
    expect(patch.provider).toBeNull();
    expect(patch.modelId).toBeNull();
    expect(patch.reasoning).toBeNull();
  });

  it("writes the chosen provider, key, and model", () => {
    const patch = agentConfigPatchFromSettingsValues(
      values({
        apiKey: " key ",
        modelId: "model-a",
        provider: "openai",
      }),
      { config: unconfiguredConfig(), reasoningOption: undefined },
    );
    expect(patch.provider).toBe("openai");
    expect(patch.modelId).toBe("model-a");
    expect(patch.apiKeyByProvider).toEqual({ openai: "key" });
  });

  it("keeps the other providers' keys and clears an emptied key", () => {
    const config: AgentConfig = {
      ...unconfiguredConfig(),
      apiKeyByProvider: { anthropic: "keep-me", openai: "old" },
      provider: "openai",
    };
    const patch = agentConfigPatchFromSettingsValues(
      values({ apiKey: "", provider: "openai" }),
      { config, reasoningOption: undefined },
    );
    expect(patch.apiKeyByProvider).toEqual({ anthropic: "keep-me" });
  });

  it("clearing the provider keeps the remembered endpoint untouched", () => {
    const config: AgentConfig = {
      ...unconfiguredConfig(),
      openAiCompatibleBaseUrl: "https://kept.example/v1",
    };
    const patch = agentConfigPatchFromSettingsValues(
      values({ openAiCompatibleBaseUrl: "https://changed.example/v1" }),
      { config, reasoningOption: undefined },
    );
    expect(patch.openAiCompatibleBaseUrl).toBe("https://kept.example/v1");
  });

  it("stores the endpoint only for the BYO-endpoint provider", () => {
    const patch = agentConfigPatchFromSettingsValues(
      values({
        openAiCompatibleBaseUrl: "https://endpoint.example/v1",
        provider: "openai-compatible",
      }),
      { config: unconfiguredConfig(), reasoningOption: undefined },
    );
    expect(patch.openAiCompatibleBaseUrl).toBe("https://endpoint.example/v1");
    const cleared = agentConfigPatchFromSettingsValues(
      values({ openAiCompatibleBaseUrl: "", provider: "openai-compatible" }),
      { config: unconfiguredConfig(), reasoningOption: undefined },
    );
    expect(cleared.openAiCompatibleBaseUrl).toBeNull();
  });

  it("carries the reasoning selection and forces sync off in server mode", () => {
    const patch = agentConfigPatchFromSettingsValues(
      values({
        mode: "server",
        reasoningEffort: "medium",
        syncEnabled: true,
      }),
      {
        config: unconfiguredConfig(),
        reasoningOption: { type: "effort", values: ["low", "medium"] },
      },
    );
    expect(patch.reasoning).toEqual({ type: "effort", value: "medium" });
    expect(patch.syncEnabled).toBe(false);
  });

  it("round-trips an explicitly emptied system prompt", () => {
    const patch = agentConfigPatchFromSettingsValues(
      values({ systemPrompt: "" }),
      { config: unconfiguredConfig(), reasoningOption: undefined },
    );
    expect(patch.systemPrompt).toBe("");
  });
});

describe("agentSettingsSchema", () => {
  it("accepts the unconfigured defaults", () => {
    const result = agentSettingsSchema.safeParse(values({}));
    expect(result.success).toBe(true);
  });

  it("bounds maxIterations on both sides", () => {
    expect(
      agentSettingsSchema.safeParse(values({ maxIterations: 0 })).success,
    ).toBe(false);
    expect(
      agentSettingsSchema.safeParse(values({ maxIterations: 26 })).success,
    ).toBe(false);
    expect(
      agentSettingsSchema.safeParse(values({ maxIterations: 25 })).success,
    ).toBe(true);
  });

  it("refuses a non-http(s) endpoint URL for the BYO-endpoint provider", () => {
    const result = agentSettingsSchema.safeParse(
      values({
        openAiCompatibleBaseUrl: "ftp://endpoint.example/v1",
        provider: "openai-compatible",
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("openAiCompatibleBaseUrl");
    }
  });

  it("accepts an empty endpoint URL (configured later) and http(s) ones", () => {
    expect(
      agentSettingsSchema.safeParse(
        values({ openAiCompatibleBaseUrl: "", provider: "openai-compatible" }),
      ).success,
    ).toBe(true);
    expect(
      agentSettingsSchema.safeParse(
        values({
          openAiCompatibleBaseUrl: "http://localhost:8080/v1",
          provider: "openai-compatible",
        }),
      ).success,
    ).toBe(true);
  });
});

describe("createAgentSettingsFields (conditional visibility as config)", () => {
  it("keeps the mode/provider/raw-id/prompt/iterations fields always visible", () => {
    const list = fields();
    for (const name of [
      "mode",
      "provider",
      "rawModelId",
      "systemPrompt",
      "maxIterations",
    ]) {
      expect(visible(fieldOf(list, name), values({}))).toBe(true);
    }
  });

  it("hides the key, endpoint, and picker before a provider is chosen", () => {
    const list = fields();
    for (const name of ["apiKey", "openAiCompatibleBaseUrl", "modelId"]) {
      expect(visible(fieldOf(list, name), values({}))).toBe(false);
    }
  });

  it("shows the key and picker once a named provider is chosen", () => {
    const list = fields();
    const chosen = values({ provider: "openai" });
    expect(visible(fieldOf(list, "apiKey"), chosen)).toBe(true);
    expect(visible(fieldOf(list, "modelId"), chosen)).toBe(true);
    expect(visible(fieldOf(list, "openAiCompatibleBaseUrl"), chosen)).toBe(
      false,
    );
  });

  it("shows the endpoint URL only for the BYO-endpoint provider", () => {
    const list = fields();
    const chosen = values({ provider: "openai-compatible" });
    expect(visible(fieldOf(list, "openAiCompatibleBaseUrl"), chosen)).toBe(
      true,
    );
  });

  it("offers the server mode option only when allowed", () => {
    const disallowed = fields({}, false);
    const modeField = fieldOf(disallowed, "mode");
    expect(modeField.options).toHaveLength(1);
    const allowed = fields({}, true);
    expect(fieldOf(allowed, "mode").options).toHaveLength(2);
  });

  it("hides both reasoning controls when the model declares no option", () => {
    const list = fields({});
    const chosen = values({ modelId: "plain-model", provider: "openai" });
    expect(visible(fieldOf(list, "reasoningEffort"), chosen)).toBe(false);
    expect(visible(fieldOf(list, "reasoningBudgetTokens"), chosen)).toBe(false);
  });

  it("shows the effort select exactly when the model offers effort values", () => {
    const list = fields({
      "effort-model": { type: "effort", values: ["low", "high"] },
    });
    const chosen = values({ modelId: "effort-model", provider: "openai" });
    expect(visible(fieldOf(list, "reasoningEffort"), chosen)).toBe(true);
    expect(visible(fieldOf(list, "reasoningBudgetTokens"), chosen)).toBe(false);
  });

  it("offers exactly the declared effort values, nothing extra", () => {
    const option: ModelReasoningOption = {
      type: "effort",
      values: ["low", "high"],
    };
    expect(reasoningEffortOptionsOf(option)).toEqual(["low", "high"]);
    expect(reasoningEffortOptionsOf(undefined)).toEqual([]);
    expect(reasoningEffortOptionsOf({ type: "toggle" })).toEqual([]);
    expect(reasoningEffortOptionsOf({ type: "effort" })).toEqual([]);
  });

  it("shows the budget control only for budget-type models", () => {
    const list = fields({
      "budget-model": { type: "budget_tokens", min: 2048 },
    });
    const chosen = values({
      modelId: "budget-model",
      provider: "anthropic",
    });
    expect(visible(fieldOf(list, "reasoningBudgetTokens"), chosen)).toBe(true);
    expect(visible(fieldOf(list, "reasoningEffort"), chosen)).toBe(false);
  });

  it("flags a below-minimum budget through the field validation", () => {
    const list = fields({
      "budget-model": { type: "budget_tokens", min: 2048 },
    });
    const budgetField = fieldOf(list, "reasoningBudgetTokens");
    const validate = budgetField.validation as (
      value: unknown,
      values: AgentSettingsValues,
    ) => string | null | undefined;
    const chosen = values({
      modelId: "budget-model",
      provider: "anthropic",
      reasoningBudgetTokens: 1024,
    });
    expect(validate(1024, chosen)).toContain("2048");
    expect(validate(2048, chosen)).toBeNull();
    expect(validate(0, chosen)).toBeNull();
  });

  it("gates the sync switch on client mode", () => {
    const list = fields();
    expect(visible(fieldOf(list, "syncEnabled"), values({}))).toBe(true);
    expect(
      visible(fieldOf(list, "syncEnabled"), values({ mode: "server" })),
    ).toBe(false);
  });

  it("carries an explicit not-chosen provider option (no hidden sentinel)", () => {
    const list = fields();
    const providerField = fieldOf(list, "provider");
    const options = providerField.options as readonly { value: string }[];
    expect(options.some((option) => option.value === UNSET_CHOICE)).toBe(true);
  });

  it("hands the picker's option source the LIVE selection each build was made for", async () => {
    // The sheet rebuilds the fields on every in-form provider switch;
    // each rebuild's option source must carry that moment's selection,
    // so the picker re-keys without a save (D14).
    const seen: (AgentProviderId | null)[] = [];
    const depsFor = (
      liveProvider: AgentProviderId | null,
    ): AgentSettingsFieldsDeps => ({
      liveProvider,
      modelAsyncOptions: (_query, liveSelection) => {
        seen.push(liveSelection);
        return Promise.resolve([]);
      },
      reasoningOptionOf: () => undefined,
      serverModeAllowed: false,
    });
    await fieldOf(
      createAgentSettingsFields(depsFor("openrouter")),
      "modelId",
    ).autocompleteConfig?.asyncOptions?.("");
    await fieldOf(
      createAgentSettingsFields(depsFor("openai-compatible")),
      "modelId",
    ).autocompleteConfig?.asyncOptions?.("");
    await fieldOf(
      createAgentSettingsFields(depsFor(null)),
      "modelId",
    ).autocompleteConfig?.asyncOptions?.("");
    expect(seen).toEqual(["openrouter", "openai-compatible", null]);
  });
});
