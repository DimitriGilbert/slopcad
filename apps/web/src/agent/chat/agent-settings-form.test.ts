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
  apiKeySeedFor,
  createAgentSettingsFields,
  formatContextLimit,
  groupModelPickerOptions,
  liveProviderOf,
  modelFamilyOf,
  modelPickerSourceFor,
  pickerMirroredRawId,
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
    modelPickerData: {
      emptyText: "no models",
      options: [],
      status: { kind: "ready" },
    },
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

  it("remembers the stored selection (picker + key + prompt), raw mirroring the stored model", () => {
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
    // The raw field starts MIRRORED to the stored model (the resolution
    // authority is raw-first), but it is not a veto: a picker edit
    // rewrites it (pinned in the pickerMirroredRawId describe below).
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

describe("pickerMirroredRawId (the raw field mirrors picker edits, R1F1)", () => {
  it("a picker-only change survives Save once mirrored", () => {
    // The prefill mirrors the stored model into the raw field — which is
    // exactly what used to veto a picker-only change on Save.
    const prefilled = agentSettingsValuesFromConfig(
      { ...unconfiguredConfig(), modelId: "stored-model", provider: "openai" },
      false,
    );
    expect(resolveSettingsModelId(prefilled)).toBe("stored-model");
    // The sheet's onChange mirror: the picker moved, the raw field takes
    // the pick, and the raw-first resolver then persists it.
    const mirrored = pickerMirroredRawId(prefilled.modelId, "fresh-pick");
    expect(mirrored).toBe("fresh-pick");
    if (mirrored !== null) {
      expect(
        resolveSettingsModelId({ ...prefilled, rawModelId: mirrored }),
      ).toBe("fresh-pick");
    }
  });

  it("a cleared picker mirrors as the empty string", () => {
    expect(pickerMirroredRawId("stored-model", "")).toBe("");
  });

  it("a raw-field edit is left alone (the picker did not move)", () => {
    expect(pickerMirroredRawId("stored-model", "stored-model")).toBeNull();
  });
});

describe("apiKeySeedFor (the key field shows the chosen provider's own key, R1F2)", () => {
  it("answers the stored key of the chosen provider", () => {
    const config: AgentConfig = {
      ...unconfiguredConfig(),
      apiKeyByProvider: { openai: "sk-openai", anthropic: "sk-anthropic" },
      provider: "openai",
    };
    expect(apiKeySeedFor(config, "openai")).toBe("sk-openai");
    expect(apiKeySeedFor(config, "anthropic")).toBe("sk-anthropic");
  });

  it("answers empty for a provider with no stored key — never another provider's key", () => {
    const config: AgentConfig = {
      ...unconfiguredConfig(),
      apiKeyByProvider: { openai: "sk-openai" },
    };
    expect(apiKeySeedFor(config, "anthropic")).toBe("");
  });

  it("answers empty before a provider is chosen", () => {
    expect(apiKeySeedFor(unconfiguredConfig(), null)).toBe("");
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

  it("keeps the other providers' keys and never erases a stored key with an emptied field", () => {
    const config: AgentConfig = {
      ...unconfiguredConfig(),
      apiKeyByProvider: { anthropic: "keep-me", openai: "old" },
      provider: "openai",
    };
    const patch = agentConfigPatchFromSettingsValues(
      values({ apiKey: "", provider: "openai" }),
      { config, reasoningOption: undefined },
    );
    expect(patch.apiKeyByProvider).toEqual({
      anthropic: "keep-me",
      openai: "old",
    });
  });

  it("a provider switch with an empty key field does not move the old key (R1F2)", () => {
    // The in-form switch reseeds the field to "" (anthropic has no stored
    // key); the submit must leave openai's key where it is and store
    // nothing under anthropic.
    const config: AgentConfig = {
      ...unconfiguredConfig(),
      apiKeyByProvider: { openai: "sk-openai" },
      provider: "openai",
    };
    const patch = agentConfigPatchFromSettingsValues(
      values({ apiKey: "", provider: "anthropic" }),
      { config, reasoningOption: undefined },
    );
    expect(patch.provider).toBe("anthropic");
    expect(patch.apiKeyByProvider).toEqual({ openai: "sk-openai" });
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

  it("binds the picker's data + renderer for the LIVE selection each build was made for", () => {
    // The sheet rebuilds the fields on every in-form provider switch;
    // each rebuild's picker payload must be the one the deps were minted
    // with, so the picker re-keys without a save (D14).
    const component = () => null;
    const depsFor = (
      liveProvider: AgentProviderId | null,
    ): AgentSettingsFieldsDeps => ({
      liveProvider,
      modelPickerComponent: component,
      modelPickerData: {
        emptyText: `empty-${String(liveProvider)}`,
        options: [
          { family: "f", label: "m", value: `m-${String(liveProvider)}` },
        ],
        status: { kind: "ready" },
      },
      reasoningOptionOf: () => undefined,
      serverModeAllowed: false,
    });
    const openrouter = fieldOf(
      createAgentSettingsFields(depsFor("openrouter")),
      "modelId",
    );
    expect(openrouter.component).toBe(component);
    expect(openrouter.pickerData).toEqual(
      depsFor("openrouter").modelPickerData,
    );
    const endpoint = fieldOf(
      createAgentSettingsFields(depsFor("openai-compatible")),
      "modelId",
    );
    expect(endpoint.pickerData).toEqual(
      depsFor("openai-compatible").modelPickerData,
    );
  });

  it("groups the field list into the sheet's three sections", () => {
    const list = fields();
    expect(fieldOf(list, "mode").section).toBe("Connection");
    expect(fieldOf(list, "provider").section).toBe("Connection");
    expect(fieldOf(list, "apiKey").section).toBe("Connection");
    expect(fieldOf(list, "openAiCompatibleBaseUrl").section).toBe("Connection");
    expect(fieldOf(list, "modelId").section).toBe("Model");
    expect(fieldOf(list, "rawModelId").section).toBe("Model");
    expect(fieldOf(list, "reasoningEffort").section).toBe("Model");
    expect(fieldOf(list, "reasoningBudgetTokens").section).toBe("Model");
    expect(fieldOf(list, "systemPrompt").section).toBe("Behavior");
    expect(fieldOf(list, "maxIterations").section).toBe("Behavior");
    expect(fieldOf(list, "syncEnabled").section).toBe("Behavior");
  });
});

describe("modelFamilyOf (the picker's group headings)", () => {
  it("cuts a display name at its first digit-bearing token", () => {
    expect(modelFamilyOf("Claude Sonnet 4.5", "claude-sonnet-4-5")).toBe(
      "Claude Sonnet",
    );
    expect(modelFamilyOf("Gemini 3 Pro", "gemini-3-pro")).toBe("Gemini");
    expect(modelFamilyOf("GPT-5.1 Codex", "gpt-5.1-codex")).toBe("GPT");
  });

  it("takes a digit-leading first token's alpha head", () => {
    expect(modelFamilyOf("GPT-5.2", "gpt-5.2")).toBe("GPT");
    expect(modelFamilyOf("GPT-4o", "gpt-4o")).toBe("GPT");
  });

  it("derives from the id when the name has no usable stem", () => {
    expect(modelFamilyOf("o3", "o3")).toBe("o3");
    expect(modelFamilyOf("", "claude-sonnet-4-5")).toBe("claude-sonnet");
    expect(modelFamilyOf("", "llama-3.1-70b")).toBe("llama");
  });

  it("falls back to the name or id itself when nothing yields a stem", () => {
    expect(modelFamilyOf("Codex Mini Latest", "codex-mini-latest")).toBe(
      "Codex Mini Latest",
    );
    expect(modelFamilyOf("", "my-finetune")).toBe("my-finetune");
  });
});

describe("formatContextLimit (the picker's right-edge readout)", () => {
  it("compacts to k and M", () => {
    expect(formatContextLimit(128000)).toBe("128k");
    expect(formatContextLimit(1000000)).toBe("1M");
    expect(formatContextLimit(1500000)).toBe("1.5M");
    expect(formatContextLimit(640)).toBe("640");
  });

  it("is undefined for absent or malformed limits", () => {
    expect(formatContextLimit(null)).toBeUndefined();
    expect(formatContextLimit(0)).toBeUndefined();
    expect(formatContextLimit(-5)).toBeUndefined();
  });
});

describe("groupModelPickerOptions (first-seen family order)", () => {
  it("groups by family preserving order", () => {
    const groups = groupModelPickerOptions([
      { family: "Claude Sonnet", label: "a", value: "a" },
      { family: "GPT", label: "b", value: "b" },
      { family: "Claude Sonnet", label: "c", value: "c" },
    ]);
    expect(groups.map((group) => group.family)).toEqual([
      "Claude Sonnet",
      "GPT",
    ]);
    expect(groups[0]?.options.map((option) => option.value)).toEqual([
      "a",
      "c",
    ]);
    expect(groups[1]?.options.map((option) => option.value)).toEqual(["b"]);
  });

  it("answers empty for no options", () => {
    expect(groupModelPickerOptions([])).toEqual([]);
  });
});
