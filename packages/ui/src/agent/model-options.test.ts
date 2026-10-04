// @vitest-environment node

/**
 * Native model-options builder contract (PLAN-AGENT-CHAT Phase 1.3, D8):
 * every emitted object is the provider's NATIVE TanStack AI `modelOptions`
 * shape verbatim, values are restricted to the catalog option's
 * `reasoning_options`, and unsupported combinations yield `undefined` —
 * never a default, never a preselection.
 */

import { describe, expect, it } from "vitest";
import type { AgentModelReasoningOption } from "./model-options";

import {
  buildAgentModelOptions,
  buildAnthropicModelOptions,
  buildGeminiModelOptions,
  buildOpenAiModelOptions,
  buildOpenRouterModelOptions,
} from "./model-options";

const OPENAI_EFFORT: AgentModelReasoningOption = {
  type: "effort",
  values: ["minimal", "low", "medium", "high"],
};

const ANTHROPIC_BUDGET: AgentModelReasoningOption = {
  type: "budget_tokens",
  min: 1024,
};

const ANTHROPIC_EFFORT: AgentModelReasoningOption = {
  type: "effort",
  values: ["low", "medium", "high", "xhigh", "max"],
};

const GEMINI_LEVELS: AgentModelReasoningOption = {
  type: "effort",
  values: ["LOW", "MEDIUM", "HIGH"],
};

describe("buildOpenAiModelOptions", () => {
  it("emits the native reasoning.effort shape verbatim", () => {
    expect(buildOpenAiModelOptions(OPENAI_EFFORT, "high")).toEqual({
      reasoning: { effort: "high" },
    });
  });

  it("offers exactly the catalog-listed values", () => {
    for (const effort of OPENAI_EFFORT.values ?? []) {
      expect(buildOpenAiModelOptions(OPENAI_EFFORT, effort)).toBeDefined();
    }
    expect(buildOpenAiModelOptions(OPENAI_EFFORT, "xhigh")).toBeUndefined();
  });

  it("returns undefined when the option declares no values", () => {
    expect(buildOpenAiModelOptions({ type: "effort" }, "high")).toBeUndefined();
  });

  it("returns undefined for non-effort options and non-string values", () => {
    expect(buildOpenAiModelOptions(ANTHROPIC_BUDGET, "high")).toBeUndefined();
    expect(buildOpenAiModelOptions(OPENAI_EFFORT, 2048)).toBeUndefined();
  });
});

describe("buildAnthropicModelOptions", () => {
  it("emits the native thinking budget shape for budget_tokens options", () => {
    expect(buildAnthropicModelOptions(ANTHROPIC_BUDGET, 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
  });

  it("refuses budgets below the catalog minimum or non-integral", () => {
    expect(buildAnthropicModelOptions(ANTHROPIC_BUDGET, 512)).toBeUndefined();
    expect(
      buildAnthropicModelOptions(ANTHROPIC_BUDGET, 1024.5),
    ).toBeUndefined();
  });

  it("returns undefined when the option declares no minimum", () => {
    expect(
      buildAnthropicModelOptions({ type: "budget_tokens" }, 8192),
    ).toBeUndefined();
  });

  it("emits the native output_config.effort shape for effort options", () => {
    expect(buildAnthropicModelOptions(ANTHROPIC_EFFORT, "xhigh")).toEqual({
      output_config: { effort: "xhigh" },
    });
    expect(
      buildAnthropicModelOptions(ANTHROPIC_EFFORT, "bananas"),
    ).toBeUndefined();
  });
});

describe("buildGeminiModelOptions", () => {
  it("emits the native thinkingConfig.thinkingLevel shape verbatim", () => {
    expect(buildGeminiModelOptions(GEMINI_LEVELS, "HIGH")).toEqual({
      thinkingConfig: { thinkingLevel: "HIGH" },
    });
  });

  it("offers exactly the catalog-listed levels (uppercase enum keys)", () => {
    expect(buildGeminiModelOptions(GEMINI_LEVELS, "MEDIUM")).toBeDefined();
    expect(buildGeminiModelOptions(GEMINI_LEVELS, "high")).toBeUndefined();
  });
});

describe("buildOpenRouterModelOptions", () => {
  it("emits the native reasoning.effort shape verbatim", () => {
    expect(buildOpenRouterModelOptions(OPENAI_EFFORT, "medium")).toEqual({
      reasoning: { effort: "medium" },
    });
  });

  it("refuses values outside the catalog listing", () => {
    expect(buildOpenRouterModelOptions(OPENAI_EFFORT, "max")).toBeUndefined();
  });
});

describe("buildAgentModelOptions", () => {
  it("dispatches each named provider to its native shape", () => {
    expect(buildAgentModelOptions("openai", OPENAI_EFFORT, "low")).toEqual(
      buildOpenAiModelOptions(OPENAI_EFFORT, "low"),
    );
    expect(buildAgentModelOptions("anthropic", ANTHROPIC_BUDGET, 2048)).toEqual(
      buildAnthropicModelOptions(ANTHROPIC_BUDGET, 2048),
    );
    expect(buildAgentModelOptions("google", GEMINI_LEVELS, "LOW")).toEqual(
      buildGeminiModelOptions(GEMINI_LEVELS, "LOW"),
    );
    expect(buildAgentModelOptions("openrouter", OPENAI_EFFORT, "high")).toEqual(
      buildOpenRouterModelOptions(OPENAI_EFFORT, "high"),
    );
  });

  it("offers nothing for openai-compatible (no native reasoning shape)", () => {
    expect(
      buildAgentModelOptions("openai-compatible", OPENAI_EFFORT, "high"),
    ).toBeUndefined();
    expect(
      buildAgentModelOptions("openai-compatible", ANTHROPIC_BUDGET, 8192),
    ).toBeUndefined();
  });

  it("offers nothing for toggle-type catalog entries on any provider", () => {
    const toggle: AgentModelReasoningOption = { type: "toggle" };
    for (const provider of [
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "openai-compatible",
    ] as const) {
      expect(buildAgentModelOptions(provider, toggle, "on")).toBeUndefined();
    }
  });
});
