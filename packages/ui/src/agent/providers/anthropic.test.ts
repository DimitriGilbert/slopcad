// @vitest-environment node

/**
 * Anthropic provider factory contract (PLAN-AGENT-CHAT Phase 1.2): the
 * injected transport is the one used, the API key is sent to the provider
 * endpoint — never to a slopcad origin (D1) — and browser-direct calls carry
 * the `anthropic-dangerous-direct-browser-access` header on the wire.
 */

import { chat, EventType } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { createAnthropicAdapter } from "./anthropic";

const API_KEY = "test-anthropic-key";
const MODEL_ID = "raw-model-id";

const messagesSse = [
  "event: message_start",
  `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"${MODEL_ID}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}`,
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

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

describe("createAnthropicAdapter", () => {
  it("routes the keyed request to the provider through the injected transport with the browser-direct header", async () => {
    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const adapter = createAnthropicAdapter({
      apiKey: API_KEY,
      modelId: MODEL_ID,
      baseURL: "https://provider.test",
      fetch: (input, init) => {
        seen.push({ input, init });
        return Promise.resolve(
          new Response(messagesSse, {
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
    expect(url.pathname).toBe("/v1/messages");
    const headers = requestHeaders(call.input, call.init);
    expect(headers.get("x-api-key")).toBe(API_KEY);
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe(
      "true",
    );
    expect(chunkTypes).toContain(EventType.TEXT_MESSAGE_CONTENT);
  });
});
