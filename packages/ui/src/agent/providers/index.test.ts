// @vitest-environment node

/**
 * Provider index contract (PLAN-AGENT-CHAT Phase 1.2): the provider-id
 * universe is exactly the five catalog ids (D6), and the dispatch builds a
 * matching text adapter per id — refusing `openai-compatible` without a
 * baseURL. The cross-check against the slopcad app's
 * `@slopcad/api/providers` single source lives app-side
 * (`apps/web/src/agent/provider-id-parity.test.ts`) — the registry copy
 * may not import workspace packages.
 */

import { describe, expect, it } from "vitest";

import { AGENT_PROVIDER_IDS, createAgentProviderAdapter } from "./index";

const API_KEY = "test-key";
const MODEL_ID = "raw-model-id";

describe("AGENT_PROVIDER_IDS", () => {
  it("is exactly the five catalog provider ids", () => {
    expect([...AGENT_PROVIDER_IDS]).toEqual([
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "openai-compatible",
    ]);
  });
});

describe("createAgentProviderAdapter", () => {
  it("builds a text adapter for the given model under every provider id", () => {
    for (const providerId of AGENT_PROVIDER_IDS) {
      const adapter = createAgentProviderAdapter(providerId, {
        apiKey: API_KEY,
        modelId: MODEL_ID,
        ...(providerId === "openai-compatible"
          ? { baseURL: "https://compatible.test/v1" }
          : {}),
      });
      expect(adapter.kind).toBe("text");
      expect(adapter.model).toBe(MODEL_ID);
    }
  });

  it("refuses openai-compatible without a baseURL", () => {
    expect(() =>
      createAgentProviderAdapter("openai-compatible", {
        apiKey: API_KEY,
        modelId: MODEL_ID,
      }),
    ).toThrowError(/requires a baseURL/);
  });
});
