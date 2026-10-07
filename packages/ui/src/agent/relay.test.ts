// @vitest-environment node
// The relay handler runs server-only; jsdom adds nothing. The SSE
// Response and the injected transport run on node's own fetch types.

/**
 * The agent relay handler's tests (PLAN-AGENT-CHAT Phase 1.5): the D1
 * key-rejection (both layers — the handler guard over raw JSON and the
 * zod refine over the parsed value — plus the schema's strict top-level
 * object and its provably keyless field set), the Phase 3 closed
 * per-provider modelOptions universe (D8's native shapes verbatim,
 * unknown fields refused, bounded leaves, provider-correlated — the fix
 * that lets Anthropic's `thinking.budget_tokens` stream end-to-end while
 * the scan keeps flagging `token`-fragment names inside `messages`), the
 * maxIterations contract (1..25 bound onto the server run's loop
 * strategy; omitted ⇒ the library's own default), the D13 access gate
 * (the INJECTED `isServerAiAllowed` resolver refusing → 403 with the
 * transport untouched, granting → stream; the D13 matrix itself lives in
 * `@slopcad/api`'s user-options suite — here only the gate ORDER is
 * proven: every 401, D1, and schema-400 test also asserts the resolver
 * was never called), the D6 missing-env-key refusal naming the provider
 * (and never touching the transport — with an EMPTY-string key counting
 * as missing, consistent with the picker's provider list), the streaming
 * happy path: the REAL Phase 1.2 adapter + the REAL `chat()` +
 * `toServerSentEventsResponse`, driven through an injected transport
 * that answers a scripted OpenAI-compatible SSE body — zero network, the
 * same discipline as the provider factory suites — and the abort path: a
 * client disconnect must abort the upstream provider call's signal. The
 * size gates are pinned too: the io endpoints' two-step body cap (a
 * declared oversize content-length and a mid-stream overrun both 413; a
 * legitimate multi-MiB history still parses), the input bounds (messages,
 * per-message parts, modelId, part type), and the credential scan's depth
 * bound (a hostile deep-nested body is a structured 400, never a 500).
 */

import type { AgentLoopState, AgentLoopStrategy } from "@tanstack/ai";
import type * as TanstackAi from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RELAY_MAX_BODY_BYTES,
  agentRelayInputSchema,
  API_KEY_SCAN_EXEMPT_ROOT_KEYS,
  API_KEY_SCAN_MAX_DEPTH,
  ApiKeyScanDepthError,
  findApiKeyLikeFields,
  handleAgentRelayRequest,
  isApiKeyLikeFieldName,
  resolveAgentProviderCredentials,
  type AgentRelayDeps,
  type AgentRelayEnvKeys,
  type AgentRelayFailure,
} from "./relay";

/** The slice of chat()'s options the loop-strategy tests read back. */
interface RecordedChatOptions {
  readonly agentLoopStrategy?: AgentLoopStrategy;
}

/**
 * A params-recording spy AROUND the real `chat()`: every test still drives
 * the real run (the factory delegates to the implementation it wraps), and
 * the recorded options are how the maxIterations binding is proven — the
 * strategy function the handler actually bound, not a mock's echo.
 */
const recordedChatOptions = vi.hoisted(() => [] as RecordedChatOptions[]);

vi.mock("@tanstack/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackAi>();
  return {
    ...actual,
    chat: (options: unknown) => {
      recordedChatOptions.push({
        agentLoopStrategy:
          typeof options === "object" &&
          options !== null &&
          "agentLoopStrategy" in options
            ? (options as { agentLoopStrategy?: AgentLoopStrategy })
                .agentLoopStrategy
            : undefined,
      });
      return actual.chat(options as Parameters<typeof actual.chat>[0]);
    },
  };
});

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
    modelOptions: { reasoning: { effort: "low" } },
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

/** `count` minimal legitimate messages (no credential-like field names). */
function relayMessages(count: number): FixtureMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${String(index)}`,
    role: "user",
    parts: [{ type: "text" }],
  }));
}

/** A message part wrapped `levels` objects deep below the part itself. */
function deepNestedPart(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "text" };
  for (let level = 0; level < levels; level += 1) {
    // Every wrapper stays schema-valid (a `type` string), so base
    // validation passes and the depth refusal comes from the scan.
    node = { nested: node, type: "text" };
  }
  return node;
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

/**
 * A scripted Anthropic Messages SSE answer (the provider suite's fixture
 * shape) — the transport the native-budget end-to-end test injects, so the
 * real Anthropic adapter's wire path runs with zero network.
 */
const anthropicSseBody = [
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

/** A recording transport answering Anthropic's SSE shape. */
function anthropicSseFetch(): {
  fetch: typeof globalThis.fetch;
  calls: RecordedFetchCall[];
} {
  const calls: RecordedFetchCall[] = [];
  const fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(anthropicSseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return { fetch, calls };
}

/** The JSON body a recorded provider call carried (init or Request input). */
async function transportJsonBody(
  call: RecordedFetchCall | undefined,
): Promise<Record<string, unknown>> {
  if (call === undefined) throw new Error("transport was not called");
  const raw = call.init?.body;
  const text =
    typeof raw === "string"
      ? raw
      : call.input instanceof Request
        ? await call.input.clone().text()
        : undefined;
  if (text === undefined) {
    throw new Error("the transport call carried no JSON body");
  }
  return JSON.parse(text) as Record<string, unknown>;
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

describe("relay input schema (D1: no key field exists; D8: closed modelOptions)", () => {
  it("accepts a valid body with all five contract fields", () => {
    const parsed = agentRelayInputSchema.safeParse({
      ...validBody(),
      maxIterations: 7,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the minimal body with both optional fields omitted", () => {
    const body = validBody();
    const parsed = agentRelayInputSchema.safeParse({
      messages: body.messages,
      modelId: body.modelId,
      provider: body.provider,
    });
    expect(parsed.success).toBe(true);
  });

  it("provably has no key field: the schema's field set is exactly the five inputs", () => {
    expect(Object.keys(agentRelayInputSchema.shape).sort()).toEqual([
      "maxIterations",
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

  it("accepts each provider's native modelOptions shape verbatim (D8)", () => {
    const native: Array<[string, Record<string, unknown>]> = [
      ["openai", { reasoning: { effort: "high" } }],
      ["openai-compatible", { reasoning: { effort: "low" } }],
      ["openrouter", { reasoning: { effort: "max" } }],
      ["anthropic", { thinking: { budget_tokens: 2048, type: "enabled" } }],
      ["anthropic", { output_config: { effort: "xhigh" } }],
      ["google", { thinkingConfig: { thinkingLevel: "HIGH" } }],
    ];
    for (const [provider, modelOptions] of native) {
      const parsed = agentRelayInputSchema.safeParse({
        ...validBody(),
        modelOptions,
        provider,
      });
      expect(parsed.success, provider).toBe(true);
    }
  });

  it("rejects an unknown modelOptions field anywhere in the subtree (the closed universe)", () => {
    for (const modelOptions of [
      { temperature: 0.2 },
      // `summary` is a real SDK field but NOT one the Phase 1.3 builder
      // emits — "exactly what it can emit, nothing more".
      { reasoning: { effort: "high", summary: "auto" } },
      { reasoning: { effort: "high" }, apiKey: "sk-client" },
    ]) {
      const parsed = agentRelayInputSchema.safeParse({
        ...validBody(),
        modelOptions,
      });
      expect(parsed.success, JSON.stringify(modelOptions)).toBe(false);
    }
  });

  it("rejects a native shape riding the wrong provider", () => {
    const parsed = agentRelayInputSchema.safeParse({
      ...validBody(),
      modelOptions: { thinking: { budget_tokens: 2048, type: "enabled" } },
      provider: "google",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((issue) => issue.path[0] === "modelOptions"),
    ).toBe(true);
  });

  it("bounds every leaf so no key VALUE can ride a legal field name", () => {
    // A 65-char string — shorter than any real credential — is refused.
    expect(
      agentRelayInputSchema.safeParse({
        ...validBody(),
        modelOptions: { reasoning: { effort: "x".repeat(65) } },
      }).success,
    ).toBe(false);
    const budgetBody = (budget_tokens: number) => ({
      ...validBody(),
      modelOptions: { thinking: { budget_tokens, type: "enabled" } },
      provider: "anthropic",
    });
    // Anthropic's own floor (1024), a bounded ceiling, and integers only.
    expect(agentRelayInputSchema.safeParse(budgetBody(1023)).success).toBe(
      false,
    );
    expect(agentRelayInputSchema.safeParse(budgetBody(2_000_001)).success).toBe(
      false,
    );
    expect(agentRelayInputSchema.safeParse(budgetBody(1.5)).success).toBe(
      false,
    );
    expect(agentRelayInputSchema.safeParse(budgetBody(1024)).success).toBe(
      true,
    );
  });

  it("bounds maxIterations to an integer 1..25 (omitted means the library default)", () => {
    for (const maxIterations of [1, 25]) {
      expect(
        agentRelayInputSchema.safeParse({ ...validBody(), maxIterations })
          .success,
        String(maxIterations),
      ).toBe(true);
    }
    for (const maxIterations of [0, 26, 2.5, "3", null]) {
      expect(
        agentRelayInputSchema.safeParse({ ...validBody(), maxIterations })
          .success,
        String(maxIterations),
      ).toBe(false);
    }
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

describe("relay input bounds (messages, parts, modelId, part type)", () => {
  it("bounds messages to 512: 513 refuse, 512 parse", () => {
    const over = agentRelayInputSchema.safeParse({
      ...validBody(),
      messages: relayMessages(513),
    });
    expect(over.success).toBe(false);
    const at = agentRelayInputSchema.safeParse({
      ...validBody(),
      messages: relayMessages(512),
    });
    expect(at.success).toBe(true);
  });

  it("bounds per-message parts to 256 — the api package's AGENT_MESSAGE_MAX_PARTS", () => {
    const parts = (count: number): Array<Record<string, unknown>> =>
      Array.from({ length: count }, () => ({ type: "text" }));
    const over = validBody();
    firstMessage(over).parts = parts(257);
    expect(agentRelayInputSchema.safeParse(over).success).toBe(false);
    const at = validBody();
    firstMessage(at).parts = parts(256);
    expect(agentRelayInputSchema.safeParse(at).success).toBe(true);
  });

  it("bounds modelId to 128 characters", () => {
    expect(
      agentRelayInputSchema.safeParse({
        ...validBody(),
        modelId: "m".repeat(129),
      }).success,
    ).toBe(false);
    expect(
      agentRelayInputSchema.safeParse({
        ...validBody(),
        modelId: "m".repeat(128),
      }).success,
    ).toBe(true);
  });

  it("bounds the part type string to 64 characters", () => {
    const bodyWithPartType = (type: string) => {
      const body = validBody();
      firstMessage(body).parts = [{ type }];
      return body;
    };
    expect(
      agentRelayInputSchema.safeParse(bodyWithPartType("t".repeat(65))).success,
    ).toBe(false);
    expect(
      agentRelayInputSchema.safeParse(bodyWithPartType("t".repeat(64))).success,
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

  it("still flags the token fragment — including Anthropic's native budget_tokens name itself", () => {
    // The Phase 3 collision, pinned at the source: `budget_tokens` IS an
    // apiKey-like name to the scan (that is exactly why modelOptions is
    // exempt by STRUCTURE at the relay, never by whitelisting the word).
    expect(isApiKeyLikeFieldName("budget_tokens")).toBe(true);
    expect(isApiKeyLikeFieldName("sessionToken")).toBe(true);
  });

  it("exempts ONLY the root modelOptions: a budget_tokens-named field inside messages stays a finding", () => {
    const body = validBody();
    firstMessage(body).parts = [
      { type: "text", content: "hi", budget_tokens: 2048 },
    ];
    // The root modelOptions subtree is skipped (structure-validated by the
    // closed schema instead) …
    expect(
      findApiKeyLikeFields(body, "$", {
        exemptRootKeys: API_KEY_SCAN_EXEMPT_ROOT_KEYS,
      }),
    ).toEqual(
      // … but the same field NAME inside the message history is flagged —
      // the scan's continuing duty.
      [
        {
          field: "budget_tokens",
          path: "$.messages[0].parts[0].budget_tokens",
        },
      ],
    );
  });
});

describe("credential scan depth bound", () => {
  it("scans payloads nested just under the default bound and throws past it", () => {
    const nested = (levels: number): unknown => {
      let node: unknown = "leaf";
      for (let level = 0; level < levels; level += 1) {
        node = { v: node };
      }
      return node;
    };
    // A 64-container chain bottoms out at depth 63 — still under the
    // bound; one more level puts a container at depth 64 and refuses.
    expect(() => findApiKeyLikeFields(nested(64))).not.toThrow();
    expect(() => findApiKeyLikeFields(nested(65))).toThrowError(
      ApiKeyScanDepthError,
    );
  });

  it("honors a caller-supplied maxDepth for findings below it", () => {
    const body = validBody();
    firstMessage(body).parts = [
      {
        type: "text",
        content: "hi",
        metadata: { deep: { deeper: { token: "t" } } },
      },
    ];
    expect(() => findApiKeyLikeFields(body, "$", { maxDepth: 7 })).toThrowError(
      ApiKeyScanDepthError,
    );
    expect(findApiKeyLikeFields(body, "$", { maxDepth: 8 })).toEqual([
      {
        field: "token",
        path: "$.messages[0].parts[0].metadata.deep.deeper.token",
      },
    ]);
  });

  it("a real message history nests far under the default bound", () => {
    const body = validBody();
    firstMessage(body).parts = [
      { type: "text", content: "hi", metadata: { token: "t" } },
    ];
    expect(() =>
      findApiKeyLikeFields(body, "$", {
        exemptRootKeys: API_KEY_SCAN_EXEMPT_ROOT_KEYS,
      }),
    ).not.toThrow();
  });

  it("safeParse refuses an over-deep payload with an issue instead of throwing", () => {
    const body = validBody();
    firstMessage(body).parts = [deepNestedPart(100)];
    type ParseResult = ReturnType<typeof agentRelayInputSchema.safeParse>;
    let parsed: ParseResult | undefined;
    expect(() => {
      parsed = agentRelayInputSchema.safeParse(body);
    }).not.toThrow();
    expect(parsed?.success).toBe(false);
    if (parsed?.success === false) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("scan bound"),
        ),
      ).toBe(true);
    }
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

  it("rejects a token-fragment credential field inside a message part with 400 (the raw-JSON guard keeps scanning messages)", async () => {
    const body = validBody();
    firstMessage(body).parts = [
      { type: "text", content: "hi", sessionToken: "t-client" },
    ];
    const { deps, isServerAiAllowed } = relayDeps();
    const response = await handleAgentRelayRequest(relayRequest(body), deps);
    expect(response.status).toBe(400);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/client-key-rejected");
    expect(failure.message).toContain("sessionToken");
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });

  it("refuses a key inside modelOptions through the closed schema — the scan exemption is not a hole", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    const response = await handleAgentRelayRequest(
      relayRequest({
        ...validBody(),
        modelOptions: { reasoning: { effort: "low" }, apiKey: "sk-client" },
      }),
      deps,
    );
    expect(response.status).toBe(400);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/invalid-input");
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

  it("rejects over-bound messages, parts, or modelId with 400 before consulting access", async () => {
    const { deps, isServerAiAllowed } = relayDeps();

    const tooManyMessages = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), messages: relayMessages(513) }),
      deps,
    );
    expect(tooManyMessages.status).toBe(400);
    const messagesFailure = await readFailure(tooManyMessages);
    expect(messagesFailure.code).toBe("agent-relay/invalid-input");
    expect(messagesFailure.message).toContain("messages");

    const tooManyParts = validBody();
    firstMessage(tooManyParts).parts = Array.from({ length: 257 }, () => ({
      type: "text",
    }));
    const partsResponse = await handleAgentRelayRequest(
      relayRequest(tooManyParts),
      deps,
    );
    expect(partsResponse.status).toBe(400);
    const partsFailure = await readFailure(partsResponse);
    expect(partsFailure.code).toBe("agent-relay/invalid-input");
    expect(partsFailure.message).toContain("parts");

    const longModelId = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), modelId: "m".repeat(129) }),
      deps,
    );
    expect(longModelId.status).toBe(400);
    const modelIdFailure = await readFailure(longModelId);
    expect(modelIdFailure.code).toBe("agent-relay/invalid-input");
    expect(modelIdFailure.message).toContain("modelId");

    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });
});

describe("handleAgentRelayRequest: body size gate (413)", () => {
  it("refuses a declared oversize content-length with 413 before reading the body", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    const request = new Request("http://slopcad.test/api/agent-relay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // undici preserves an explicit content-length; the declared gate
        // must trust it and refuse without pulling a byte.
        "content-length": String(AGENT_RELAY_MAX_BODY_BYTES + 1),
      },
      body: new ReadableStream({
        pull() {
          throw new Error("TEST: an oversize declared body must not be read");
        },
      }),
      // `duplex` is required by the runtime for streaming bodies; it rides
      // through the spread (object-literal excess checks do not).
      ...{ duplex: "half" },
    });
    const response = await handleAgentRelayRequest(request, deps);
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/payload-too-large");
    expect(failure.message).toContain("declared");
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });

  it("cancels an undersized-declared body's read past the cap with 413", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    // One 1 MiB chunk enqueued repeatedly: the running byte count passes
    // the 16 MiB cap mid-stream, so the read must cancel (the underlying
    // source sees it) and answer 413 — never buffer the whole thing.
    const chunk = new Uint8Array(1024 * 1024);
    let cancelled = false;
    const request = new Request("http://slopcad.test/api/agent-relay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "16",
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 20; i += 1) {
            controller.enqueue(chunk);
          }
        },
        cancel() {
          cancelled = true;
        },
      }),
      ...{ duplex: "half" },
    });
    const response = await handleAgentRelayRequest(request, deps);
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/payload-too-large");
    expect(failure.message).toContain("received");
    expect(cancelled).toBe(true);
    expect(isServerAiAllowed).not.toHaveBeenCalled();
  });

  it("parses a legitimate multi-MiB history under the cap", async () => {
    const { deps } = relayDeps();
    const body = validBody();
    firstMessage(body).parts = [
      { type: "text", content: "x".repeat(2 * 1024 * 1024) },
    ];
    const response = await handleAgentRelayRequest(relayRequest(body), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();
  });
});

describe("handleAgentRelayRequest: scan depth gate", () => {
  it("answers a hostile deep-nested body with a structured 400, never a 500", async () => {
    const { deps, isServerAiAllowed } = relayDeps();
    const body = validBody();
    firstMessage(body).parts = [deepNestedPart(100)];
    const response = await handleAgentRelayRequest(relayRequest(body), deps);
    expect(response.status).toBe(400);
    const failure = await readFailure(response);
    expect(failure.code).toBe("agent-relay/payload-too-deep");
    expect(failure.message).toContain(String(API_KEY_SCAN_MAX_DEPTH));
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
      // modelOptions omitted: the baseline's `reasoning` shape is native
      // to the openai family, and this test switches to anthropic (the
      // closed universe would rightly refuse the foreign shape first).
      relayRequest({
        ...validBody(),
        modelOptions: undefined,
        provider: "anthropic",
      }),
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
  it("streams a native Anthropic budget_tokens selection end-to-end (the Phase 3 collision, closed)", async () => {
    const transport = anthropicSseFetch();
    const { deps } = relayDeps({
      envKeys: { anthropicKey: SERVER_KEY },
      fetch: transport.fetch,
    });
    const response = await handleAgentRelayRequest(
      relayRequest({
        ...validBody(),
        modelOptions: { thinking: { budget_tokens: 2048, type: "enabled" } },
        provider: "anthropic",
      }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("hi");

    // The provider call went to the Anthropic Messages endpoint with the
    // SERVER's env key, and the native budget shape reached the wire
    // VERBATIM — the exact field name the old open scan's `token`
    // fragment used to reject. (Host asserted by path only: the SDK honors
    // an ANTHROPIC_BASE_URL env override, and the injected transport
    // means no network either way.)
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    if (call === undefined) throw new Error("transport was not called");
    const url =
      typeof call.input === "string" || call.input instanceof URL
        ? call.input.toString()
        : call.input.url;
    expect(url).toContain("/v1/messages");
    const headers =
      typeof call.input === "string" || call.input instanceof URL
        ? new Headers(call.init?.headers)
        : call.input.headers;
    expect(headers.get("x-api-key")).toBe(SERVER_KEY);
    const wireBody = await transportJsonBody(call);
    expect(wireBody.thinking).toEqual({
      budget_tokens: 2048,
      type: "enabled",
    });
  });

  it("binds the caller's maxIterations onto the server run's agent loop strategy", async () => {
    const { deps } = relayDeps();
    const response = await handleAgentRelayRequest(
      relayRequest({ ...validBody(), maxIterations: 3 }),
      deps,
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();

    // The strategy the handler actually bound onto chat(): it stops the
    // model-turn loop exactly at the caller's bound.
    const strategy = recordedChatOptions.at(-1)?.agentLoopStrategy;
    expect(strategy).toBeTypeOf("function");
    if (strategy === undefined)
      throw new Error("chat() ran without a strategy");
    const loopState = (iterationCount: number): AgentLoopState => ({
      finishReason: "tool_calls",
      iterationCount,
      lastTurnToolCallCount: 1,
      messages: [],
      toolCallCount: 1,
    });
    expect(strategy(loopState(2))).toBe(true);
    expect(strategy(loopState(3))).toBe(false);
  });

  it("leaves agentLoopStrategy unset when maxIterations is omitted — the library's own default (5) applies", async () => {
    const { deps } = relayDeps();
    const response = await handleAgentRelayRequest(
      relayRequest(validBody()),
      deps,
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(recordedChatOptions.at(-1)?.agentLoopStrategy).toBeUndefined();
  });

  it("rejects out-of-range maxIterations with 400 before consulting access", async () => {
    for (const maxIterations of [0, 26, 2.5]) {
      const { deps, isServerAiAllowed } = relayDeps();
      const response = await handleAgentRelayRequest(
        relayRequest({ ...validBody(), maxIterations }),
        deps,
      );
      expect(response.status, String(maxIterations)).toBe(400);
      const failure = await readFailure(response);
      expect(failure.code).toBe("agent-relay/invalid-input");
      expect(failure.message).toContain("maxIterations");
      expect(isServerAiAllowed).not.toHaveBeenCalled();
    }
  });

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
