// @vitest-environment node
// The relay handler runs server-only; jsdom adds nothing. The SSE
// Response and the injected transport run on node's own fetch types.

/**
 * The agent relay handler's tests (PLAN-AGENT-CHAT Phase 1.5): the D1
 * key-rejection (both layers — the handler guard over raw JSON and the
 * zod refine over the parsed value — plus the schema's strict top-level
 * object and its provably keyless field set), the D13 access gate (the
 * INJECTED `isServerAiAllowed` resolver refusing → 403 with the
 * transport untouched, granting → stream; the D13 matrix itself lives in
 * `@slopcad/api`'s user-options suite — here only the gate ORDER is
 * proven: every 401, D1, and schema-400 test also asserts the resolver
 * was never called), the D6 missing-env-key refusal naming the provider (and
 * never touching the transport — with an EMPTY-string key counting as
 * missing, consistent with the picker's provider list), the streaming
 * happy path: the REAL Phase 1.2 adapter + the REAL `chat()` +
 * `toServerSentEventsResponse`, driven through an injected transport
 * that answers a scripted OpenAI-compatible SSE body — zero network, the
 * same discipline as the provider factory suites — and the abort path:
 * a client disconnect must abort the upstream provider call's signal.
 */

import { describe, expect, it, vi } from "vitest";

import {
  agentRelayInputSchema,
  findApiKeyLikeFields,
  handleAgentRelayRequest,
  isApiKeyLikeFieldName,
  resolveAgentProviderCredentials,
  type AgentRelayDeps,
  type AgentRelayEnvKeys,
  type AgentRelayFailure,
} from "./relay";

const USER_ID = "user-relay-test";
const MODEL_ID = "raw-model-id";
const COMPATIBLE_BASE_URL = "https://compatible.test/v1";
const SERVER_KEY = "server-env-key";

const signedIn = () => Promise.resolve({ user: { id: USER_ID } });
const anonymous = () => Promise.resolve(null);

/** The env keys the happy-path tests configure (the e2e endpoint's pair). */
const serverKeys: AgentRelayEnvKeys = {
  openAiCompatibleKey: SERVER_KEY,
  openAiCompatibleBaseUrl: COMPATIBLE_BASE_URL,
};

/** A fixture message: the UIMessage wire shape, open for mutation. */
interface FixtureMessage {
  id: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** A valid relay body; every test mutates it from this baseline. */
function validBody(): {
  provider: string;
  modelId: string;
  modelOptions: Record<string, unknown>;
  messages: FixtureMessage[];
  [key: string]: unknown;
} {
  return {
    provider: "openai-compatible",
    modelId: MODEL_ID,
    modelOptions: { reasoning_effort: "low" },
    messages: [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", content: "hi" }],
      },
    ],
  };
}

function firstMessage(body: { messages: FixtureMessage[] }): FixtureMessage {
  const message = body.messages[0];
  if (message === undefined) throw new Error("fixture message missing");
  return message;
}

/** One recorded provider call made through the injected transport. */
interface RecordedFetchCall {
  readonly input: RequestInfo | URL;
  readonly init?: RequestInit;
}

/**
 * A scripted OpenAI-compatible SSE answer (the factory suite's fixture
 * shape) that records every call — the transport the happy-path tests
 * inject.
 */
function compatibleSseFetch(): {
  fetch: typeof globalThis.fetch;
  calls: RecordedFetchCall[];
} {
  const calls: RecordedFetchCall[] = [];
  const body =
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${MODEL_ID}","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n` +
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${MODEL_ID}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
    "data: [DONE]\n\n";
  const fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return { fetch, calls };
}

interface DepsOverrides {
  readonly session?: () => Promise<{ user: { id: string } } | null>;
  readonly envKeys?: AgentRelayEnvKeys;
  readonly allowed?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

/** Deps with everything stubbed; the access resolver records its calls. */
function relayDeps(overrides: DepsOverrides = {}): {
  deps: AgentRelayDeps;
  isServerAiAllowed: ReturnType<typeof vi.fn>;
  calls: RecordedFetchCall[];
} {
  const isServerAiAllowed = vi.fn((userId: string): Promise<boolean> =>
    Promise.resolve(userId === USER_ID && (overrides.allowed ?? true)),
  );
  const transport =
    overrides.fetch === undefined
      ? compatibleSseFetch()
      : { fetch: overrides.fetch, calls: [] as RecordedFetchCall[] };
  const deps: AgentRelayDeps = {
    getSession: overrides.session ?? signedIn,
    isServerAiAllowed,
    envKeys: overrides.envKeys ?? serverKeys,
    fetch: transport.fetch,
  };
  return { deps, isServerAiAllowed, calls: transport.calls };
}

function relayRequest(body: unknown): Request {
  return new Request("http://slopcad.test/api/agent-relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readFailure(
  response: Response,
): Promise<{ code: string; message: string }> {
  const payload = (await response.json()) as AgentRelayFailure;
  expect(payload.ok).toBe(false);
  return { code: payload.code, message: payload.message };
}

describe("relay input schema (D1: no key field exists)", () => {
  it("accepts a valid body with exactly the four fields", () => {
    const parsed = agentRelayInputSchema.safeParse(validBody());
    expect(parsed.success).toBe(true);
  });

  it("provably has no key field: the schema's field set is exactly the four inputs", () => {
    expect(Object.keys(agentRelayInputSchema.shape).sort()).toEqual([
      "messages",
      "modelId",
      "modelOptions",
      "provider",
    ]);
  });

  it("rejects an unknown top-level apiKey field (strict object)", () => {
    const parsed = agentRelayInputSchema.safeParse({
      ...validBody(),
      apiKey: "sk-client",
    });
    expect(parsed.success).toBe(false);
  });

  it("the zod refine rejects a credential field nested in the open message objects", () => {
    const body = validBody();
    firstMessage(body).api_key = "sk-client";
    const parsed = agentRelayInputSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((issue) => issue.message.includes("api_key")),
    ).toBe(true);
  });
});

describe("apiKey-like field detection", () => {
  it("marks key, apiKey, api_key, token, and authorization-style names", () => {
    for (const name of [
      "key",
      "apiKey",
      "api_key",
      "api-key",
      "bearerToken",
      "authorization",
      "openaiApiKey",
      "secret",
    ]) {
      expect(isApiKeyLikeFieldName(name), name).toBe(true);
    }
  });

  it("does not mark the payload's legitimate field names", () => {
    for (const name of [
      "provider",
      "modelId",
      "modelOptions",
      "messages",
      "id",
      "role",
      "parts",
      "type",
      "content",
      "reasoning",
      "thinking",
      "signature",
      "metadata",
      "output",
    ]) {
      expect(isApiKeyLikeFieldName(name), name).toBe(false);
    }
  });

  it("finds credential fields at any depth with their paths", () => {
    const body = validBody();
    firstMessage(body).parts = [
      { type: "text", content: "hi", metadata: { token: "t" } },
    ];
    expect(findApiKeyLikeFields(body)).toEqual([
      { field: "token", path: "$.messages[0].parts[0].metadata.token" },
    ]);
  });
});

describe("provider credential resolution (D6: no fallback)", () => {
  const keys = (partial: Partial<AgentRelayEnvKeys>): AgentRelayEnvKeys => ({
    ...partial,
  });

  it("resolves each named provider from its own env key", () => {
    expect(
      resolveAgentProviderCredentials("openai", keys({ openAiKey: "k1" })),
    ).toEqual({ ok: true, apiKey: "k1" });
    expect(
      resolveAgentProviderCredentials(
        "anthropic",
        keys({ anthropicKey: "k2" }),
      ),
    ).toEqual({ ok: true, apiKey: "k2" });
    expect(
      resolveAgentProviderCredentials("google", keys({ googleKey: "k3" })),
    ).toEqual({ ok: true, apiKey: "k3" });
    expect(
      resolveAgentProviderCredentials(
        "openrouter",
        keys({ openRouterKey: "k4" }),
      ),
    ).toEqual({ ok: true, apiKey: "k4" });
  });

  it("refuses a provider whose env key is missing, naming the provider and its env var", () => {
    const resolution = resolveAgentProviderCredentials(
      "anthropic",
      keys({ openAiKey: "another-providers-key" }),
    );
    expect(resolution).toEqual({
      ok: false,
      provider: "anthropic",
      missingEnvVars: ["ANTHROPIC_KEY"],
    });
  });

  it("treats an EMPTY-string env key exactly like a missing one", () => {
    for (const [provider, envKeys] of [
      ["openai", keys({ openAiKey: "" })],
      ["anthropic", keys({ anthropicKey: "" })],
      ["google", keys({ googleKey: "" })],
      ["openrouter", keys({ openRouterKey: "" })],
    ] as const) {
      const resolution = resolveAgentProviderCredentials(provider, envKeys);
      expect(resolution.ok, provider).toBe(false);
    }
    expect(
      resolveAgentProviderCredentials("openai", keys({ openAiKey: "" })),
    ).toEqual({
      ok: false,
      provider: "openai",
      missingEnvVars: ["OPENAI_KEY"],
    });
  });

  it("requires both the compatible endpoint's key and base URL", () => {
    expect(
      resolveAgentProviderCredentials(
        "openai-compatible",
        keys({ openAiCompatibleBaseUrl: "https://x.test" }),
      ),
    ).toEqual({
      ok: false,
      provider: "openai-compatible",
      missingEnvVars: ["OPENAI_COMPATIBLE_KEY"],
    });
    expect(
      resolveAgentProviderCredentials("openai-compatible", keys({})),
    ).toEqual({
      ok: false,
      provider: "openai-compatible",
      missingEnvVars: ["OPENAI_COMPATIBLE_KEY", "OPENAI_COMPATIBLE_BASE_URL"],
    });
    expect(
      resolveAgentProviderCredentials(
        "openai-compatible",
        keys({
          openAiCompatibleKey: "k",
          openAiCompatibleBaseUrl: "https://x.test",
        }),
      ),
    ).toEqual({ ok: true, apiKey: "k", baseURL: "https://x.test" });
    // The empty-string rule is total: a blank base URL is just as missing.
    expect(
      resolveAgentProviderCredentials(
        "openai-compatible",
        keys({ openAiCompatibleKey: "k", openAiCompatibleBaseUrl: "" }),
      ),
    ).toEqual({
      ok: false,
      provider: "openai-compatible",
      missingEnvVars: ["OPENAI_COMPATIBLE_BASE_URL"],
    });
  });
});

describe("handleAgentRelayRequest: authentication", () => {
  it("refuses an anonymous caller with 401 before reading the body", async () => {
    const { deps, isServerAiAllowed } = relayDeps({ session: anonymous });
    const request = new Request("http://slopcad.test/api/agent-relay", {
      method: "POST",
      body: new ReadableStream({
        pull() {
          throw new Error(
            "TEST: the body must not be read before the session gate",
          );
        },
      }),
      // `duplex` is required by the runtime for streaming bodies; it rides
      // through the spread (object-literal excess checks do not).
      ...{ duplex: "half" },
    });
    const response = await handleAgentRelayRequest(request, deps);
    expect(response.status).toBe(401);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/authentication-required");
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });
});

describe("handleAgentRelayRequest: D1 key rejection", () => {
  it("rejects a top-level apiKey field with 400 and never consults access", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    const response = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), apiKey: "sk-client" }),
      deps,
    );
    expect(response.status).toBe(400);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/client-key-rejected");
    expect(failure.message).toContain("apiKey");
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });

  it("rejects a credential field nested in a message with 400", async () => {
    const body = validBody();
    firstMessage(body).metadata = { openaiApiKey: "sk-client" };
    const { deps, isServerAiAllowed } = relayDeps();
    const response = await handleAgentRelayRequest(relayRequest(body), deps);
    expect(response.status).toBe(400);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/client-key-rejected");
    expect(failure.message).toContain("openaiApiKey");
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });

  it("rejects a key nested in modelOptions with 400", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    const response = await handleAgentRelayRequest(
      relayRequest({
        ...validBody(),
        modelOptions: { temperature: 0.2, apiKey: "sk-client" },
      }),
      deps,
    );
    expect(response.status).toBe(400);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/client-key-rejected");
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });
});

describe("handleAgentRelayRequest: input validation", () => {
  it("rejects a malformed JSON body with 400", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    const response = await handleAgentRelayRequest(
      relayRequest("{not json"),
      deps,
    );
    expect(response.status).toBe(400);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/malformed-body");
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider and an empty message list with 400", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    const unknownProvider = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), provider: "closedai" }),
      deps,
    );
    expect(unknownProvider.status).toBe(400);
    expect((await readFailure(unknownProvider)).code).toBe(
      "agent-relay/invalid-input",
    );

    const noMessages = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), messages: [] }),
      deps,
    );
    expect(noMessages.status).toBe(400);
    expect((await readFailure(noMessages)).code).toBe(
      "agent-relay/invalid-input",
    );
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });
});

describe("handleAgentRelayRequest: D13 access gate (injected resolver)", () => {
  it("refuses with 403 when the resolver denies, asking it about exactly the session user and never touching the transport", async () => {
    const { deps, isServerAiAllowed, calls } = relayDeps({
      allowed: false,
    });
    const response = await handleAgentRelayRequest(
      relayRequest(validBody()),
      deps,
    );
    expect(response.status).toBe(403);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/server-ai-not-permitted");
    expect(isServerAiAllowed).toHaveBeenCalledTimes(1);
    expect(isServerAiAllowed).toHaveBeenCalledWith(USER_ID);
    expect(calls).toHaveLength(0);
  });

  it("streams when the resolver grants", async () => {
    const { deps, isServerAiAllowed } = relayDeps({ allowed: true });
    const response = await handleAgentRelayRequest(
      relayRequest(validBody()),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(isServerAiAllowed).toHaveBeenCalledWith(USER_ID);
    expect((await response.text()).length).toBeGreaterThan(0);
  });
});

describe("handleAgentRelayRequest: missing env key (D6)", () => {
  it("refuses with a structured 4xx naming the missing provider, and never touches the transport", async () => {
    const { deps, calls } = relayDeps({
      envKeys: { openAiKey: SERVER_KEY },
    });
    const response = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), provider: "anthropic" }),
      deps,
    );
    expect(response.status).toBe(422);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/provider-not-configured");
    expect(failure.message).toContain("anthropic");
    expect(failure.message).toContain("ANTHROPIC_KEY");
    expect(calls).toHaveLength(0);
  });

  it("refuses an EMPTY-string env key through the same 422 missing-key path", async () => {
    const { deps, calls } = relayDeps({
      envKeys: { openAiKey: "" },
    });
    const response = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), provider: "openai" }),
      deps,
    );
    expect(response.status).toBe(422);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/provider-not-configured");
    expect(failure.message).toContain("OPENAI_KEY");
    expect(calls).toHaveLength(0);
  });
});

describe("handleAgentRelayRequest: streaming passthrough", () => {
  it("streams the real chat() run back as SSE from the env-keyed adapter", async () => {
    const transport = compatibleSseFetch();
    const { deps } = relayDeps({ fetch: transport.fetch });
    const response = await handleAgentRelayRequest(
      relayRequest(validBody()),
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length));
    expect(events.length).toBeGreaterThan(0);
    // The AG-UI run: content deltas carry the scripted answer, and the
    // stream terminates on RUN_FINISHED.
    const types = events.map(
      (event) => (JSON.parse(event) as { type: string }).type,
    );
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    expect(types[types.length - 1]).toBe("RUN_FINISHED");
    expect(body).toContain("hi");

    // The provider call went to the env-configured endpoint with the
    // SERVER's key — never a user key, and no other provider.
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    if (call === undefined) throw new Error("transport was not called");
    const url =
      typeof call.input === "string" || call.input instanceof URL
        ? call.input.toString()
        : call.input.url;
    expect(url).toBe(`${COMPATIBLE_BASE_URL}/chat/completions`);
    expect(new Headers(call.init?.headers).get("authorization")).toBe(
      `Bearer ${SERVER_KEY}`,
    );
  });

  it("aborts the upstream provider call's signal when the client disconnects", async () => {
    const calls: RecordedFetchCall[] = [];
    // A transport faithful to undici's abort semantics: the call answers
    // one SSE chunk and then stays in flight, and aborting the fetch's
    // init signal ERRORS the response body (as the real transport would),
    // so the run terminates instead of leaking.
    const transport = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ input, init });
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${MODEL_ID}","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n`,
            ),
          );
          signal?.addEventListener(
            "abort",
            () => {
              controller.error(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("upstream aborted"),
              );
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    };
    const clientAbort = new AbortController();
    const request = new Request("http://slopcad.test/api/agent-relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
      signal: clientAbort.signal,
    });

    const { deps } = relayDeps({ fetch: transport });
    const response = await handleAgentRelayRequest(request, deps);
    expect(response.status).toBe(200);

    // The SSE response's pump drives the chat() run; wait until the
    // upstream provider call has actually been issued.
    const deadline = Date.now() + 5_000;
    while (calls.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(calls).toHaveLength(1);
    const upstreamSignal = calls[0]?.init?.signal;
    expect(upstreamSignal?.aborted).toBe(false);

    clientAbort.abort();
    expect(request.signal.aborted).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);

    await response.body?.cancel();
  });
});
