// @vitest-environment node

/**
 * OpenRouter provider factory contract (PLAN-AGENT-CHAT Phase 1.2): the
 * injected transport — threaded through the OpenRouter SDK's `httpClient`
 * slot, its only fetch override point — is the one used, and the API key is
 * sent to the provider endpoint, never to a slopcad origin (D1).
 */

import { chat, EventType } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { createOpenRouterAdapter } from "./openrouter";

const API_KEY = "test-openrouter-key";
const MODEL_ID = "vendor/raw-model-id";

const chatCompletionsSse =
  `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${MODEL_ID}","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
  `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${MODEL_ID}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (typeof input === "string" || input instanceof URL) {
    return new Headers(init?.headers);
  }
  return input.headers;
}

describe("createOpenRouterAdapter", () => {
  it("routes the keyed request to the provider through the injected transport", async () => {
    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const adapter = createOpenRouterAdapter({
      apiKey: API_KEY,
      modelId: MODEL_ID,
      baseURL: "https://provider.test/v1",
      fetch: (input, init) => {
        seen.push({ input, init });
        return Promise.resolve(
          new Response(chatCompletionsSse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });

    const chunkTypes: string[] = [];
    for await (const chunk of chat({
      adapter,
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunkTypes.push(chunk.type);
    }

    expect(seen).toHaveLength(1);
    const call = seen[0];
    if (call === undefined) throw new Error("transport was not called");
    expect(requestUrl(call.input)).toBe(
      "https://provider.test/v1/chat/completions",
    );
    expect(requestHeaders(call.input, call.init).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(chunkTypes).toContain(EventType.TEXT_MESSAGE_CONTENT);
  });
});
