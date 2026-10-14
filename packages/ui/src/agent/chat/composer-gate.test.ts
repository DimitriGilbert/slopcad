// @vitest-environment node
// Pure gating derivations; jsdom adds nothing.

/**
 * The composer's disabled-with-reason gate (PLAN-AGENT-CHAT Phase 4.4,
 * D5): sending is blocked with a user-facing reason until the agent is
 * genuinely configured — provider AND model chosen (never preselected),
 * the client-direct key present, the openai-compatible endpoint set —
 * while a configured config passes open, and the model-slot summary
 * names exactly what is (or is not) chosen.
 */

import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config/store";

import { agentComposerGate, agentModelSummary } from "./composer-gate";

/** A fully unconfigured config (D5's distinct starting state). */
function unconfigured(): AgentConfig {
  return {
    provider: null,
    apiKeyByProvider: {},
    modelId: null,
    reasoning: null,
    systemPrompt: null,
    openAiCompatibleBaseUrl: null,
    mode: "client",
    syncEnabled: false,
    maxIterations: 5,
  };
}

describe("agentComposerGate", () => {
  it("blocks with a reason while no provider is chosen", () => {
    const gate = agentComposerGate(unconfigured());
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("provider");
  });

  it("blocks with a reason once a provider is chosen but no model is", () => {
    const gate = agentComposerGate({
      ...unconfigured(),
      provider: "openrouter",
    });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("model");
  });

  it("blocks client mode when the chosen provider's key is absent", () => {
    const gate = agentComposerGate({
      ...unconfigured(),
      provider: "openrouter",
      modelId: "vendor/example-model",
    });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("openrouter");
    expect(gate.reason).toContain("API key");
  });

  it("blocks the openai-compatible provider without an endpoint URL", () => {
    const gate = agentComposerGate({
      ...unconfigured(),
      provider: "openai-compatible",
      modelId: "vendor/example-model",
      apiKeyByProvider: { "openai-compatible": "sk-test" },
    });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toContain("endpoint URL");
  });

  it("passes open once client mode is fully configured", () => {
    const gate = agentComposerGate({
      ...unconfigured(),
      provider: "openrouter",
      modelId: "vendor/example-model",
      apiKeyByProvider: { openrouter: "sk-test" },
    });
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeNull();
  });

  it("passes open for the openai-compatible provider once the endpoint is set", () => {
    const gate = agentComposerGate({
      ...unconfigured(),
      provider: "openai-compatible",
      modelId: "vendor/example-model",
      apiKeyByProvider: { "openai-compatible": "sk-test" },
      openAiCompatibleBaseUrl: "https://example.invalid/v1",
    });
    expect(gate.disabled).toBe(false);
  });

  it("needs only provider and model in server mode (access is the relay's call)", () => {
    const gate = agentComposerGate({
      ...unconfigured(),
      provider: "openai",
      modelId: "vendor/example-model",
      mode: "server",
    });
    expect(gate.disabled).toBe(false);
    expect(gate.reason).toBeNull();
  });
});

describe("agentModelSummary", () => {
  it("names the unconfigured state without inventing a provider", () => {
    expect(agentModelSummary(unconfigured())).toBe("Agent: not configured");
  });

  it("names a chosen provider with its missing model honestly", () => {
    expect(
      agentModelSummary({ ...unconfigured(), provider: "anthropic" }),
    ).toBe("Agent: anthropic · no model");
  });

  it("names the chosen provider and model together", () => {
    expect(
      agentModelSummary({
        ...unconfigured(),
        provider: "google",
        modelId: "vendor/example-model",
      }),
    ).toBe("Agent: google · vendor/example-model");
  });
});
