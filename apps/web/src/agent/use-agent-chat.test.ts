// @vitest-environment node

/**
 * The Phase 3.3 runtime hook contract (PLAN-AGENT-CHAT): transport selection
 * by mode (the useChat `connection` XOR `fetcher` currencies), system-prompt
 * assembly (user prompt + delimited context block), the native modelOptions
 * merge from Phase 1.3, the config-driven `maxIterations` loop bound, and
 * stop/retry — all against the REAL chat machinery (`@tanstack/ai-client`'s
 * ChatClient driving the transport), with the model doubled by a scripted
 * text adapter at the Phase 1.2 seam (client mode) and by the Phase 3.2
 * MockProvider serialized to SSE (server mode). No live network: every fetch
 * is injected.
 */

import { describe, expect, it } from "vitest";
import { EventType } from "@tanstack/ai";
import type {
  AdapterYieldChunk,
  DefaultMessageMetadataByModality,
  Modality,
  StreamChunk,
  TextAdapter,
  UIMessage,
} from "@tanstack/ai";
import type {
  ChatFetcher,
  ChatTransport,
  ConnectConnectionAdapter,
} from "@tanstack/ai-client";
import { ChatClient } from "@tanstack/ai-client";
import { z } from "zod";
import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";

import { DEFAULT_MAX_ITERATIONS, type AgentConfig } from "./config/store";
import {
  AGENT_BASE_INSTRUCTION,
  AGENT_CONTEXT_END,
  AGENT_CONTEXT_START,
  agentToolCatalogue,
  assembleAgentSystemPrompt,
  createAgentChatTransport,
  resolveAgentModelOptions,
  type AgentChatTool,
} from "./use-agent-chat";
import {
  agentRelayInputSchema,
  API_KEY_SCAN_EXEMPT_ROOT_KEYS,
  findApiKeyLikeFields,
} from "./relay";
import { createAgentTools, type AgentWebMcpExecutor } from "./tools";
import { createMockProvider } from "./testing/mock-provider";
import { defineWebMcpTool, type WebMcpToolEntry } from "../webmcp/registry";

/** Collects every chunk of a stream, in order. */
async function collect(
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * Poll loop for the real client's async machinery: check, tick, check —
 * bounded, never sleep-blocked.
 */
async function until(predicate: () => boolean, budget = 500): Promise<void> {
  for (let i = 0; i < budget; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  if (!predicate()) {
    throw new Error("Condition was not reached within the tick budget.");
  }
}

/** True once an assistant message carrying the given text exists. */
function hasAssistantText(
  messages: readonly UIMessage[],
  text: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) => part.type === "text" && part.content === text,
      ),
  );
}

/** The base agent config every test patches (D5: nothing preselected by default is irrelevant here — this IS a chosen configuration). */
function agentConfig(patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "openai",
    apiKeyByProvider: { openai: "k-test-browser-only" },
    modelId: "raw-typed-model",
    reasoning: null,
    systemPrompt: null,
    openAiCompatibleBaseUrl: null,
    mode: "client",
    syncEnabled: false,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    ...patch,
  };
}

/** Narrows the client arm of the transport union to its connect shape. */
function clientConnectionOf(
  transport: ChatTransport,
): ConnectConnectionAdapter {
  if (!("connection" in transport) || transport.connection === undefined) {
    throw new Error("Expected the client-direct (connection) transport.");
  }
  const connection = transport.connection;
  if (!("connect" in connection)) {
    throw new Error("Expected a connect-style connection adapter.");
  }
  return connection;
}

/** Narrows the server arm of the transport union. */
function relayFetcherOf(transport: ChatTransport): ChatFetcher {
  if (!("fetcher" in transport) || transport.fetcher === undefined) {
    throw new Error("Expected the server-relay (fetcher) transport.");
  }
  return transport.fetcher;
}

/** A fetch call as recorded by {@link recordingFetch}. */
interface RecordedFetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** An injected fetch double that records every call and answers from a factory. */
function recordingFetch(respond: () => Response): {
  calls: RecordedFetchCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: RecordedFetchCall[] = [];
  const doubled: typeof globalThis.fetch = (input, init) => {
    calls.push({
      init: init ?? {},
      url: input instanceof Request ? input.url : input.toString(),
    });
    return Promise.resolve(respond());
  };
  return { calls, fetch: doubled };
}

/** The apply-commands registry entry (the bridge tests' echo pattern). */
function applyCommandsEntry(): WebMcpToolEntry {
  return defineWebMcpTool({
    description: "Apply CAD commands (runtime hook test).",
    inputSchema: z.object({ commands: z.array(z.string()).min(1) }),
    name: "cad_apply_commands",
    execute: (input) => ({ applied: input.commands.length }),
  });
}

/** A recording executor that answers `{ applied: <command count> }`. */
function recordingApplyExecutor(): {
  readonly calls: { input: unknown; name: string }[];
  readonly execute: AgentWebMcpExecutor;
} {
  const calls: { input: unknown; name: string }[] = [];
  return {
    calls,
    execute: (name, input) => {
      calls.push({ input, name });
      const commands =
        typeof input === "object" &&
        input !== null &&
        "commands" in input &&
        Array.isArray(input.commands)
          ? input.commands.length
          : 0;
      return Promise.resolve({
        ok: true,
        result: JSON.stringify({ applied: commands }),
      });
    },
  };
}

/** The bridged tool set every transport test binds. */
function bridgedTools(executor: AgentWebMcpExecutor): readonly AgentChatTool[] {
  return createAgentTools({
    execute: executor,
    tools: [applyCommandsEntry()],
  });
}

// ---------------------------------------------------------------------------
// The scripted text adapter — the client-mode double at the Phase 1.2 seam.
// ---------------------------------------------------------------------------

/** One recorded `chatStream` call: everything the runtime hook bound into chat(). */
interface ScriptedAdapterCall {
  readonly systemPrompts: readonly string[];
  readonly modelOptions: unknown;
  readonly toolNames: readonly string[];
  readonly messageCount: number;
  readonly model: string;
}

/** A scripted model: each `chatStream` call replays the next run of chunks. */
type ScriptedTextAdapter = TextAdapter<
  "scripted-model",
  Record<string, unknown>,
  ReadonlyArray<Modality>,
  DefaultMessageMetadataByModality,
  ReadonlyArray<string>,
  unknown,
  unknown
> & {
  readonly calls: readonly ScriptedAdapterCall[];
};

/** A plain text model turn (the run ends with finishReason "stop"). */
function textTurn(text: string, ids: RunIds): AdapterYieldChunk[] {
  return [
    { type: EventType.RUN_STARTED, runId: ids.runId, threadId: ids.threadId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: `${ids.runId}-msg`,
      role: "assistant",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: `${ids.runId}-msg`,
      delta: text,
    },
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId: `${ids.runId}-msg`,
    },
    {
      type: EventType.RUN_FINISHED,
      finishReason: "stop",
      runId: ids.runId,
      threadId: ids.threadId,
    },
  ];
}

/** A model turn emitting one tool call (finishReason "tool_calls" — the loop continues). */
function toolCallTurn(
  toolName: string,
  input: unknown,
  ids: RunIds,
): AdapterYieldChunk[] {
  return [
    { type: EventType.RUN_STARTED, runId: ids.runId, threadId: ids.threadId },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: `${ids.runId}-call`,
      toolCallName: toolName,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      delta: JSON.stringify(input),
      toolCallId: `${ids.runId}-call`,
    },
    {
      type: EventType.TOOL_CALL_END,
      toolCallId: `${ids.runId}-call`,
    },
    {
      type: EventType.RUN_FINISHED,
      finishReason: "tool_calls",
      runId: ids.runId,
      threadId: ids.threadId,
    },
  ];
}

/** The correlation ids each scripted turn carries. */
interface RunIds {
  readonly runId: string;
  readonly threadId: string;
}

/**
 * Builds the scripted adapter: `runs[i]` is replayed on the i-th chatStream
 * call (an unscripted call throws loudly), each call is recorded, and with
 * `interEventTicks` the chunks yield across macrotasks so a stop() lands
 * mid-stream.
 */
function scriptedTextAdapter(
  runs: readonly (readonly AdapterYieldChunk[])[],
  options: { interEventTicks?: number } = {},
): ScriptedTextAdapter {
  const macrotasks = options.interEventTicks ?? 0;
  const calls: ScriptedAdapterCall[] = [];
  const adapter: ScriptedTextAdapter = {
    calls,
    kind: "text",
    model: "scripted-model",
    name: "scripted",
    "~types": {
      inputModalities: [],
      messageMetadataByModality: {
        audio: undefined,
        document: undefined,
        image: undefined,
        text: undefined,
        video: undefined,
      },
      providerOptions: {},
      systemPromptMetadata: undefined,
      toolCallMetadata: undefined,
      toolCapabilities: [],
    },
    async *chatStream(streamOptions) {
      const index = calls.length;
      const run = runs[index];
      if (run === undefined) {
        throw new Error(
          `scriptedTextAdapter: chatStream call ${String(index + 1)} has no scripted run.`,
        );
      }
      calls.push({
        messageCount: streamOptions.messages.length,
        model: streamOptions.model,
        modelOptions: streamOptions.modelOptions,
        systemPrompts: (streamOptions.systemPrompts ?? []).map((prompt) =>
          typeof prompt === "string" ? prompt : prompt.content,
        ),
        toolNames: (streamOptions.tools ?? []).map(
          (tool: { name: string }) => tool.name,
        ),
      });
      for (const chunk of run) {
        await Promise.resolve();
        for (let i = 0; i < macrotasks; i += 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
        }
        yield chunk;
      }
    },
    structuredOutput() {
      return Promise.reject(
        new Error("scriptedTextAdapter: structuredOutput is not scripted."),
      );
    },
  };
  return adapter;
}

/** Fresh correlation ids per scripted turn (turn N keeps them distinct). */
function runIds(turn: number): RunIds {
  return { runId: `run-${String(turn)}`, threadId: "thread-t" };
}

/** The document summary every transport test injects. */
const SUMMARY = "Workbench with 1 box (2x2x2) at the origin.";

describe("assembleAgentSystemPrompt", () => {
  it("joins the user's prompt with the delimited context block", () => {
    const prompt = assembleAgentSystemPrompt({
      documentSummary: SUMMARY,
      toolCatalogue: [
        { description: "Apply CAD commands.", name: "cad_apply_commands" },
      ],
      userPrompt: "Only metric units.",
    });

    expect(prompt.startsWith("Only metric units.\n\n")).toBe(true);
    const start = prompt.indexOf(AGENT_CONTEXT_START);
    const end = prompt.indexOf(AGENT_CONTEXT_END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(prompt).toContain(`Current document summary:\n${SUMMARY}`);
    expect(prompt).toContain(
      "Tool catalogue (the only tools you may call):\n- cad_apply_commands: Apply CAD commands.",
    );
    expect(prompt).not.toContain(AGENT_BASE_INSTRUCTION);
  });

  it("uses the base instruction while the stored prompt is unset (null)", () => {
    const prompt = assembleAgentSystemPrompt({
      documentSummary: SUMMARY,
      toolCatalogue: [],
      userPrompt: null,
    });

    expect(prompt.startsWith(`${AGENT_BASE_INSTRUCTION}\n\n`)).toBe(true);
    expect(prompt).toContain(AGENT_CONTEXT_START);
  });

  it("yields the context block alone for an explicitly empty user prompt", () => {
    for (const userPrompt of ["", "   "]) {
      const prompt = assembleAgentSystemPrompt({
        documentSummary: SUMMARY,
        toolCatalogue: [],
        userPrompt,
      });

      expect(prompt.startsWith(AGENT_CONTEXT_START)).toBe(true);
      expect(prompt.endsWith(AGENT_CONTEXT_END)).toBe(true);
      expect(prompt).not.toContain(AGENT_BASE_INSTRUCTION);
    }
  });

  it("degrades the context block's sections, never silently dropping them", () => {
    const prompt = assembleAgentSystemPrompt({
      documentSummary: "",
      toolCatalogue: [],
      userPrompt: null,
    });

    expect(prompt).toContain(
      "Current document summary:\n(the document is empty)",
    );
    expect(prompt).toContain("(no tools are bound)");
  });

  it("ships a base instruction with no model ids that frames multi-angle capture as optional", () => {
    expect(AGENT_BASE_INSTRUCTION).not.toMatch(
      /gpt|claude|gemini|sonnet|o[13]-|openrouter|anthropic/i,
    );
    expect(AGENT_BASE_INSTRUCTION).toContain("several angles");
    expect(AGENT_BASE_INSTRUCTION).toContain("single capture call");
  });

  it("derives the catalogue from the bridged tool set", () => {
    const executor = recordingApplyExecutor();
    const catalogue = agentToolCatalogue(bridgedTools(executor.execute));

    expect(catalogue).toEqual([
      {
        description: "Apply CAD commands (runtime hook test).",
        name: "cad_apply_commands",
      },
    ]);
  });
});

describe("resolveAgentModelOptions", () => {
  const effortOption: ModelReasoningOption = {
    type: "effort",
    values: ["low", "high"],
  };
  const budgetOption: ModelReasoningOption = {
    type: "budget_tokens",
    min: 1024,
  };

  it("offers nothing without a selection, a catalog option, or a configuration", () => {
    expect(
      resolveAgentModelOptions(agentConfig({ reasoning: null }), effortOption),
    ).toBeUndefined();
    expect(
      resolveAgentModelOptions(
        agentConfig({ reasoning: { type: "effort", value: "high" } }),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      resolveAgentModelOptions(
        agentConfig({
          provider: null,
          modelId: null,
          reasoning: { type: "effort", value: "high" },
        }),
        effortOption,
      ),
    ).toBeUndefined();
  });

  it("emits the provider's native shape for an offered effort value", () => {
    expect(
      resolveAgentModelOptions(
        agentConfig({ reasoning: { type: "effort", value: "high" } }),
        effortOption,
      ),
    ).toEqual({ reasoning: { effort: "high" } });
  });

  it("emits the native budget shape for an offered token budget", () => {
    expect(
      resolveAgentModelOptions(
        agentConfig({
          provider: "anthropic",
          reasoning: { type: "budget_tokens", value: 2048 },
        }),
        budgetOption,
      ),
    ).toEqual({ thinking: { type: "enabled", budget_tokens: 2048 } });
  });

  it("refuses values the catalog option does not offer", () => {
    expect(
      resolveAgentModelOptions(
        agentConfig({ reasoning: { type: "effort", value: "ultra" } }),
        effortOption,
      ),
    ).toBeUndefined();
    expect(
      resolveAgentModelOptions(
        agentConfig({
          provider: "anthropic",
          reasoning: { type: "budget_tokens", value: 8 },
        }),
        budgetOption,
      ),
    ).toBeUndefined();
  });
});

describe("createAgentChatTransport — mode selection", () => {
  it("answers the connection currency in client mode and the fetcher currency in server mode", () => {
    const client = createAgentChatTransport({
      config: agentConfig({ mode: "client" }),
      documentSummary: SUMMARY,
      tools: [],
    });
    const server = createAgentChatTransport({
      config: agentConfig({ mode: "server" }),
      documentSummary: SUMMARY,
      tools: [],
    });

    expect("fetcher" in client).toBe(false);
    expect(clientConnectionOf(client).connect).toBeTypeOf("function");
    expect("connection" in server).toBe(false);
    expect(relayFetcherOf(server)).toBeTypeOf("function");
  });

  it("refuses client-direct runs that the config cannot carry", async () => {
    const unconfigured = createAgentChatTransport({
      config: agentConfig({ modelId: null, provider: null }),
      documentSummary: SUMMARY,
      tools: [],
    });
    const keyless = createAgentChatTransport({
      config: agentConfig({ apiKeyByProvider: {} }),
      documentSummary: SUMMARY,
      tools: [],
    });
    const urlLess = createAgentChatTransport({
      config: agentConfig({
        apiKeyByProvider: { "openai-compatible": "k" },
        openAiCompatibleBaseUrl: null,
        provider: "openai-compatible",
      }),
      documentSummary: SUMMARY,
      tools: [],
    });

    await expect(
      collect(clientConnectionOf(unconfigured).connect([], undefined)),
    ).rejects.toThrow(/not configured/);
    await expect(
      collect(clientConnectionOf(keyless).connect([], undefined)),
    ).rejects.toThrow(/API key/);
    await expect(
      collect(clientConnectionOf(urlLess).connect([], undefined)),
    ).rejects.toThrow(/base URL/);
  });

  it("refuses server-relay runs while unconfigured", async () => {
    const transport = createAgentChatTransport({
      config: agentConfig({ mode: "server", modelId: null, provider: null }),
      documentSummary: SUMMARY,
      tools: [],
    });

    await expect(
      relayFetcherOf(transport)(
        { messages: [], runId: "r", threadId: "t" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/not configured/);
  });
});

describe("client-direct transport (the browser-resident chat() loop)", () => {
  function clientTransportWith(
    adapter: ScriptedTextAdapter,
    config: AgentConfig,
    tools: readonly AgentChatTool[] = [],
    reasoningOption: ModelReasoningOption | undefined = undefined,
  ): ChatTransport {
    return createAgentChatTransport(
      {
        config,
        documentSummary: SUMMARY,
        ...(reasoningOption === undefined ? {} : { reasoningOption }),
        tools,
      },
      { createAdapter: () => adapter },
    );
  }

  it("binds the assembled system prompt, native modelOptions, and the tools into chat()", async () => {
    const executor = recordingApplyExecutor();
    const adapter = scriptedTextAdapter([
      textTurn("Scripted reply.", runIds(1)),
    ]);
    const transport = clientTransportWith(
      adapter,
      agentConfig({
        reasoning: { type: "effort", value: "high" },
        systemPrompt: "Prefer solids over surfaces.",
      }),
      bridgedTools(executor.execute),
      { type: "effort", values: ["low", "high"] },
    );
    const client = new ChatClient({ ...transport });

    try {
      await client.sendMessage("Add a box.");
      await until(() =>
        hasAssistantText(client.getMessages(), "Scripted reply."),
      );

      expect(adapter.calls).toHaveLength(1);
      const call = adapter.calls[0];
      expect(call?.systemPrompts).toEqual([
        assembleAgentSystemPrompt({
          documentSummary: SUMMARY,
          toolCatalogue: agentToolCatalogue(bridgedTools(executor.execute)),
          userPrompt: "Prefer solids over surfaces.",
        }),
      ]);
      expect(call?.modelOptions).toEqual({ reasoning: { effort: "high" } });
      expect(call?.toolNames).toEqual(["cad_apply_commands"]);
      expect(call?.model).toBe("scripted-model");
      expect(call?.messageCount).toBeGreaterThan(0);
    } finally {
      client.dispose();
    }
  });

  it("executes the bridged webMCP tool inside the run and continues the loop", async () => {
    const executor = recordingApplyExecutor();
    const input = { commands: ["sphere r=1 at 0 0 0"] };
    const adapter = scriptedTextAdapter([
      toolCallTurn("cad_apply_commands", input, runIds(1)),
      textTurn("Applied one sphere.", runIds(2)),
    ]);
    const transport = clientTransportWith(
      adapter,
      agentConfig(),
      bridgedTools(executor.execute),
    );
    const client = new ChatClient({ ...transport });

    try {
      await client.sendMessage("Add a sphere.");
      await until(() =>
        hasAssistantText(client.getMessages(), "Applied one sphere."),
      );

      expect(executor.calls).toEqual([{ input, name: "cad_apply_commands" }]);
      expect(adapter.calls).toHaveLength(2);
      expect(adapter.calls[1]?.messageCount).toBeGreaterThan(
        adapter.calls[0]?.messageCount ?? 0,
      );
      expect(client.getError()).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it("honors the configured maxIterations bound (2 turns, not 3)", async () => {
    const executor = recordingApplyExecutor();
    const input = { commands: ["box 1 1 1 at 0 0 0"] };
    const adapter = scriptedTextAdapter([
      toolCallTurn("cad_apply_commands", input, runIds(1)),
      toolCallTurn("cad_apply_commands", input, runIds(2)),
      toolCallTurn("cad_apply_commands", input, runIds(3)),
    ]);
    const transport = clientTransportWith(
      adapter,
      agentConfig({ maxIterations: 2 }),
      bridgedTools(executor.execute),
    );
    const client = new ChatClient({ ...transport });

    try {
      await client.sendMessage("Keep adding boxes.");
      await until(() => !client.getIsLoading());

      expect(adapter.calls).toHaveLength(2);
      expect(executor.calls).toHaveLength(2);
    } finally {
      client.dispose();
    }
  });

  it("defaults the loop bound to TanStack's own 5 model turns", async () => {
    const executor = recordingApplyExecutor();
    const input = { commands: ["box 1 1 1 at 0 0 0"] };
    const turns = Array.from({ length: 6 }, (_, index) =>
      toolCallTurn("cad_apply_commands", input, runIds(index + 1)),
    );
    const adapter = scriptedTextAdapter(turns);
    const transport = clientTransportWith(
      adapter,
      agentConfig({ maxIterations: DEFAULT_MAX_ITERATIONS }),
      bridgedTools(executor.execute),
    );
    const client = new ChatClient({ ...transport });

    try {
      await client.sendMessage("Keep adding boxes.");
      await until(() => !client.getIsLoading());

      expect(adapter.calls).toHaveLength(DEFAULT_MAX_ITERATIONS);
    } finally {
      client.dispose();
    }
  });

  it("stop() aborts the in-flight run", async () => {
    const adapter = scriptedTextAdapter(
      [textTurn("A slow reply that never finishes.", runIds(1))],
      { interEventTicks: 1 },
    );
    const transport = clientTransportWith(adapter, agentConfig());
    const client = new ChatClient({ ...transport });

    try {
      const settled = client.sendMessage("Draw something.");
      void settled.catch(() => undefined);
      await until(() => adapter.calls.length === 1);
      client.stop();
      await until(() => !client.getIsLoading());

      expect(client.getMessages().at(0)?.role).toBe("user");
    } finally {
      client.dispose();
    }
  });

  it("retry (reload) replays the turn through the transport", async () => {
    const adapter = scriptedTextAdapter([
      textTurn("First reply.", runIds(1)),
      textTurn("Second reply.", runIds(2)),
    ]);
    const transport = clientTransportWith(adapter, agentConfig());
    const client = new ChatClient({ ...transport });

    try {
      await client.sendMessage("Say something.");
      await until(() => hasAssistantText(client.getMessages(), "First reply."));
      await client.reload();
      await until(() =>
        hasAssistantText(client.getMessages(), "Second reply."),
      );

      expect(adapter.calls).toHaveLength(2);
    } finally {
      client.dispose();
    }
  });
});

describe("server-relay transport (the keyless SSE fetcher)", () => {
  /** The fetch double answering a fixed Response while recording every call. */
  function relayTransportWith(
    config: AgentConfig,
    respond: () => Response,
    reasoningOption: ModelReasoningOption | undefined = undefined,
  ): { calls: RecordedFetchCall[]; transport: ChatTransport } {
    const recorded = recordingFetch(respond);
    return {
      calls: recorded.calls,
      transport: createAgentChatTransport(
        {
          config,
          documentSummary: SUMMARY,
          ...(reasoningOption === undefined ? {} : { reasoningOption }),
          tools: bridgedTools(recordingApplyExecutor().execute),
        },
        { fetch: recorded.fetch },
      ),
    };
  }

  /** The parsed JSON body of the n-th relay call. */
  function parsedBody(
    call: RecordedFetchCall | undefined,
  ): Record<string, unknown> {
    if (call === undefined)
      throw new Error("The relay fetch was never called.");
    const body = call.init.body;
    if (typeof body !== "string")
      throw new Error("The relay body is not a string.");
    return JSON.parse(body) as Record<string, unknown>;
  }

  it("POSTs exactly the relay contract — provider/modelId/modelOptions/maxIterations/messages, never a key", async () => {
    const { calls, transport } = relayTransportWith(
      agentConfig({
        maxIterations: 7,
        mode: "server",
        provider: "anthropic",
        reasoning: { type: "budget_tokens", value: 2048 },
        systemPrompt: "Prefer solids.",
      }),
      () => new Response('data: {"type":"RUN_FINISHED"}\n\n', { status: 200 }),
      { type: "budget_tokens", min: 1024 },
    );
    const fetcher = relayFetcherOf(transport);

    const response = await fetcher(
      {
        messages: [
          {
            id: "u1",
            parts: [{ content: "hello", type: "text" }],
            role: "user",
          },
        ],
        runId: "run-1",
        threadId: "thread-1",
      },
      { signal: new AbortController().signal },
    );

    // The fetcher's declared return admits an AsyncIterable arm; the relay
    // always hands back the SSE Response.
    if (!(response instanceof Response)) {
      throw new Error("Expected the relay fetcher to return the SSE Response.");
    }
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("/api/agent-relay");
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);

    const body = parsedBody(call);
    expect(Object.keys(body).sort()).toEqual([
      "maxIterations",
      "messages",
      "modelId",
      "modelOptions",
      "provider",
    ]);
    expect(body.provider).toBe("anthropic");
    expect(body.modelId).toBe("raw-typed-model");
    expect(body.maxIterations).toBe(7);
    expect(body.modelOptions).toEqual({
      thinking: { budget_tokens: 2048, type: "enabled" },
    });
    const messages = body.messages as unknown[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      id: "slopcad-agent-system",
      parts: [
        {
          content: assembleAgentSystemPrompt({
            documentSummary: SUMMARY,
            toolCatalogue: [
              {
                description: "Apply CAD commands (runtime hook test).",
                name: "cad_apply_commands",
              },
            ],
            userPrompt: "Prefer solids.",
          }),
          type: "text",
        },
      ],
      role: "system",
    });
    expect(messages[1]).toMatchObject({ id: "u1", role: "user" });
    // Post-fix truth (Phase 3): the exact body the fetcher emits parses
    // against the relay's OWN input schema — Anthropic's native
    // `budget_tokens` (D8's mandated shape, asserted above) included — and
    // the deep credential scan, with the relay's single structural
    // modelOptions exemption, stays clean across the whole body.
    expect(agentRelayInputSchema.safeParse(body).success).toBe(true);
    expect(
      findApiKeyLikeFields(body, "$", {
        exemptRootKeys: API_KEY_SCAN_EXEMPT_ROOT_KEYS,
      }),
    ).toEqual([]);
  });

  it("omits modelOptions when the config carries no reasoning selection (the loop bound still rides)", async () => {
    const { calls, transport } = relayTransportWith(
      agentConfig({ mode: "server", reasoning: null }),
      () => new Response('data: {"type":"RUN_FINISHED"}\n\n', { status: 200 }),
    );

    await relayFetcherOf(transport)(
      {
        messages: [
          { id: "u1", parts: [{ content: "hi", type: "text" }], role: "user" },
        ],
        runId: "run-1",
        threadId: "thread-1",
      },
      { signal: new AbortController().signal },
    );

    const body = parsedBody(calls[0]);
    expect(Object.keys(body).sort()).toEqual([
      "maxIterations",
      "messages",
      "modelId",
      "provider",
    ]);
    expect(body.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    // With no native options in play the deep credential scan agrees on the
    // whole body: the keyless contract is clean everywhere, not just at the
    // top level — and it parses against the relay's own schema.
    expect(agentRelayInputSchema.safeParse(body).success).toBe(true);
    expect(
      findApiKeyLikeFields(body, "$", {
        exemptRootKeys: API_KEY_SCAN_EXEMPT_ROOT_KEYS,
      }),
    ).toEqual([]);
  });

  it("surfaces the relay's structured failure envelope as the fetcher's error", async () => {
    const { transport } = relayTransportWith(
      agentConfig({ mode: "server" }),
      () =>
        Response.json(
          {
            code: "agent-relay/server-ai-not-permitted",
            message: "Server-emitted chat is not enabled for this account.",
            ok: false,
          },
          { status: 403 },
        ),
    );

    await expect(
      relayFetcherOf(transport)(
        {
          messages: [
            {
              id: "u1",
              parts: [{ content: "hi", type: "text" }],
              role: "user",
            },
          ],
          runId: "run-1",
          threadId: "thread-1",
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Server-emitted chat is not enabled for this account.");
  });

  it("drives the real ChatClient over the MockProvider's SSE stream", async () => {
    const provider = createMockProvider({
      script: [{ kind: "text", text: "Relayed reply." }],
    });
    const chunks = await collect(provider.connect([], undefined));
    const sseBody = `${chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}`)
      .join("\n\n")}\n\n`;
    const { calls, transport } = relayTransportWith(
      agentConfig({ mode: "server" }),
      () =>
        new Response(sseBody, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    );
    const client = new ChatClient({ ...transport });

    try {
      await client.sendMessage("hello over the relay");
      await until(() =>
        hasAssistantText(client.getMessages(), "Relayed reply."),
      );

      expect(calls).toHaveLength(1);
      expect(client.getError()).toBeUndefined();
      const body = parsedBody(calls[0]);
      const messages = body.messages as { role: string }[];
      expect(messages[0]?.role).toBe("system");
      expect(messages[1]?.role).toBe("user");
    } finally {
      client.dispose();
    }
  });
});
