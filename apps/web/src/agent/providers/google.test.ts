// @vitest-environment node

/**
 * Google (Gemini) provider factory contract (PLAN-AGENT-CHAT Phase 1.2): the
 * injected transport — threaded through the Google GenAI SDK's
 * `httpOptions.fetch`, its only fetch override point — is the one used, and
 * the API key is sent to the provider endpoint, never to a slopcad origin
 * (D1).
 */

import { chat, EventType } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { createGoogleAdapter } from "./google";

const API_KEY = "test-google-key";
const MODEL_ID = "raw-model-id";

const generateContentSse = `data: {"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2},"modelVersion":"${MODEL_ID}"}\n\n`;

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

describe("createGoogleAdapter", () => {
  it("routes the keyed request to the provider through the injected transport", async () => {
    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const adapter = createGoogleAdapter({
      apiKey: API_KEY,
      modelId: MODEL_ID,
      baseURL: "https://provider.test",
      fetch: (input, init) => {
        seen.push({ input, init });
        return Promise.resolve(
          new Response(generateContentSse, {
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
    const url = new URL(requestUrl(call.input));
    expect(url.host).toBe("provider.test");
    expect(url.pathname).toContain(`models/${MODEL_ID}`);
    expect(requestHeaders(call.input, call.init).get("x-goog-api-key")).toBe(
      API_KEY,
    );
    expect(chunkTypes).toContain(EventType.TEXT_MESSAGE_CONTENT);
  });
});
