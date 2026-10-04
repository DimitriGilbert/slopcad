// @vitest-environment node

/**
 * OpenAI provider factory contract (PLAN-AGENT-CHAT Phase 1.2): the injected
 * transport is the one used, the API key is sent to the provider endpoint —
 * never to a slopcad origin (D1) — and browser-direct construction carries
 * the OpenAI SDK's `dangerouslyAllowBrowser` opt-in.
 */

import { chat, EventType } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIChatModel } from "@tanstack/ai-openai";

import { createOpenaiAdapter } from "./openai";

const API_KEY = "test-openai-key";
const MODEL_ID = "raw-model-id";

const responsesSse =
  'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
  'data: {"type":"response.completed","response":{}}\n\n';

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

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

describe("createOpenaiAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes the keyed request to the provider through the injected transport", async () => {
    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const adapter = createOpenaiAdapter({
      apiKey: API_KEY,
      modelId: MODEL_ID,
      baseURL: "https://provider.test/v1",
      fetch: (input, init) => {
        seen.push({ input, init });
        return Promise.resolve(sseResponse(responsesSse));
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
    expect(requestUrl(call.input)).toBe("https://provider.test/v1/responses");
    expect(requestHeaders(call.input, call.init).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(chunkTypes).toContain(EventType.TEXT_MESSAGE_CONTENT);
  });

  it("constructs browser-direct where the bare library factory refuses", () => {
    // The OpenAI SDK refuses construction in a browser-like environment
    // unless `dangerouslyAllowBrowser` is set; the factory always sets it.
    vi.stubGlobal("window", { document: {} });
    vi.stubGlobal("navigator", {});

    expect(() => createOpenaiChat("" as OpenAIChatModel, API_KEY)).toThrowError(
      /browser-like environment/,
    );

    expect(() =>
      createOpenaiAdapter({ apiKey: API_KEY, modelId: MODEL_ID }),
    ).not.toThrow();
  });
});
