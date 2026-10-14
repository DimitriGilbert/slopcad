// @vitest-environment node

/**
 * OpenAI-compatible provider factory contract (PLAN-AGENT-CHAT Phase 1.2):
 * the adapter hits exactly the configured endpoint through the injected
 * transport with the user's key (D1), browser-direct construction carries
 * the OpenAI SDK's `dangerouslyAllowBrowser` opt-in, and
 * `listOpenAiCompatibleModels` reads the endpoint's own `/models` — never
 * throwing, degrading to the raw-string-only signal on any failure (D14).
 */

import { chat, EventType } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenAiCompatibleAdapter,
  listOpenAiCompatibleModels,
} from "./openai-compatible";

const API_KEY = "test-compatible-key";
const MODEL_ID = "raw-model-id";
const BASE_URL = "https://compatible.test/v1";

const chatCompletionsSse =
  `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${MODEL_ID}","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n` +
  `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${MODEL_ID}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
  "data: [DONE]\n\n";

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
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

describe("createOpenAiCompatibleAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes the keyed request to the configured endpoint through the injected transport", async () => {
    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const adapter = createOpenAiCompatibleAdapter({
      apiKey: API_KEY,
      modelId: MODEL_ID,
      baseURL: BASE_URL,
      fetch: (input, init) => {
        seen.push({ input, init });
        return Promise.resolve(sseResponse(chatCompletionsSse));
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
    expect(requestUrl(call.input)).toBe(`${BASE_URL}/chat/completions`);
    expect(requestHeaders(call.input, call.init).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(chunkTypes).toContain(EventType.TEXT_MESSAGE_CONTENT);
  });

  it("constructs browser-direct where the bare library factory refuses", () => {
    // The underlying OpenAI SDK refuses construction in a browser-like
    // environment unless `dangerouslyAllowBrowser` is set; the factory
    // always sets it.
    vi.stubGlobal("window", { document: {} });
    vi.stubGlobal("navigator", {});

    expect(() =>
      openaiCompatibleText(MODEL_ID, {
        baseURL: BASE_URL,
        apiKey: API_KEY,
      }),
    ).toThrowError(/browser-like environment/);

    expect(() =>
      createOpenAiCompatibleAdapter({
        apiKey: API_KEY,
        modelId: MODEL_ID,
        baseURL: BASE_URL,
      }),
    ).not.toThrow();
  });
});

describe("listOpenAiCompatibleModels", () => {
  it("lists and dedupes the endpoint's own model ids", async () => {
    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const listing = await listOpenAiCompatibleModels({
      baseURL: `${BASE_URL}/`,
      apiKey: API_KEY,
      fetch: (input, init) => {
        seen.push({ input, init });
        return Promise.resolve(
          jsonResponse(
            '{"data":[{"id":"m-two"},{"id":"m-one"},{"id":"m-two"},{"id":""},{"id":7}]}',
          ),
        );
      },
    });

    expect(seen).toHaveLength(1);
    const call = seen[0];
    if (call === undefined) throw new Error("transport was not called");
    expect(requestUrl(call.input)).toBe(`${BASE_URL}/models`);
    expect(requestHeaders(call.input, call.init).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(listing).toEqual({
      models: ["m-two", "m-one"],
      listAvailable: true,
    });
  });

  it("reports an available but empty list for empty data", async () => {
    const listing = await listOpenAiCompatibleModels({
      baseURL: BASE_URL,
      apiKey: API_KEY,
      fetch: () => Promise.resolve(jsonResponse('{"data":[]}')),
    });
    expect(listing).toEqual({ models: [], listAvailable: true });
  });

  it("degrades to raw-string-only when the endpoint refuses the request", async () => {
    const listing = await listOpenAiCompatibleModels({
      baseURL: BASE_URL,
      apiKey: API_KEY,
      fetch: () => Promise.resolve(jsonResponse("{}", 401)),
    });
    expect(listing).toEqual({ models: [], listAvailable: false });
  });

  it("degrades to raw-string-only for a malformed payload", async () => {
    const listing = await listOpenAiCompatibleModels({
      baseURL: BASE_URL,
      apiKey: API_KEY,
      fetch: () =>
        Promise.resolve(jsonResponse('{"not":"the openai models shape"}')),
    });
    expect(listing).toEqual({ models: [], listAvailable: false });
  });

  it("degrades to raw-string-only when the transport fails (CORS, no route, offline)", async () => {
    const listing = await listOpenAiCompatibleModels({
      baseURL: BASE_URL,
      apiKey: API_KEY,
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(listing).toEqual({ models: [], listAvailable: false });
  });
});
