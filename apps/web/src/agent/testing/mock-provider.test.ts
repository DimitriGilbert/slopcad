// @vitest-environment node

/**
 * The MockProvider contract (PLAN-AGENT-CHAT Phase 3.2): a scripted run
 * replays deterministically (same events, same order, twice), an error turn
 * produces the `RUN_ERROR` wire shape and terminates the run, and a
 * tool-call turn's input round-trips — both at the wire level (concatenated
 * arg deltas parse back to the input) and through the REAL chat client
 * machinery (`@tanstack/ai-client`'s `ChatClient` executing a Phase 2.3
 * bridged webMCP tool), which is the interop the Phase 3.3 runtime hook and
 * the session e2e build on.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EventType } from "@tanstack/ai";
import type { StreamChunk, ToolCallResultEvent, UIMessage } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";

import { defineWebMcpTool, type WebMcpToolEntry } from "../../webmcp/registry";
import {
  createAgentTools,
  parseAgentToolRefusal,
  type AgentWebMcpExecutor,
} from "../tools";
import {
  createMockProvider,
  mockProviderFetcher,
  type MockScriptTurn,
} from "./mock-provider";

/** Collects every chunk of a stream, in order. */
async function collect(
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The type discriminants of a chunk sequence, for order-pinning assertions. */
function chunkTypes(chunks: readonly StreamChunk[]): string[] {
  return chunks.map((chunk) => chunk.type);
}

/** The concatenated text deltas a replay streamed. */
function textDeltasOf(chunks: readonly StreamChunk[]): string {
  return chunks
    .flatMap((chunk) =>
      chunk.type === EventType.TEXT_MESSAGE_CONTENT ? [chunk.delta] : [],
    )
    .join("");
}

/** The concatenated tool-arg deltas a replay streamed. */
function argsDeltasOf(chunks: readonly StreamChunk[]): string[] {
  return chunks.flatMap((chunk) =>
    chunk.type === EventType.TOOL_CALL_ARGS ? [chunk.delta] : [],
  );
}

/** The single tool-result chunk of a replay, when present. */
function toolResultChunkOf(
  chunks: readonly StreamChunk[],
): ToolCallResultEvent | undefined {
  return chunks.find(
    (chunk): chunk is ToolCallResultEvent =>
      chunk.type === EventType.TOOL_CALL_RESULT,
  );
}

/**
 * Poll loop for the real client's async machinery (the auto-continuation
 * settles over macrotask boundaries): check, tick, check — bounded, never
 * sleep-blocked.
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

/** The full scripted conversation the determinism tests replay. */
function scriptedConversation(): readonly MockScriptTurn[] {
  return [
    { kind: "text", text: "Applying the requested geometry." },
    {
      kind: "tool-call",
      input: { commands: ["sphere r=1 at 0 0 0"] },
      toolName: "cad_apply_commands",
    },
    { kind: "tool-result", content: { applied: 1 } },
    { kind: "text", text: "Done — one sphere applied." },
  ];
}

/** The apply-commands registry entry (the bridge test's echo pattern). */
function applyCommandsEntry(): WebMcpToolEntry {
  return defineWebMcpTool({
    description: "Apply CAD commands (mock-provider test).",
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

describe("createMockProvider", () => {
  it("replays a scripted conversation deterministically, twice", async () => {
    const provider = createMockProvider({ script: scriptedConversation() });

    const first = await collect(provider.connect([], undefined));
    const second = await collect(provider.connect([], undefined));

    expect(second).toEqual(first);
    expect(chunkTypes(first)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(textDeltasOf(first)).toContain("Applying the requested geometry.");
    expect(provider.calls.map((call) => call.index)).toEqual([0, 1]);
  });

  it("echoes the caller's run context ids and records the call", async () => {
    const provider = createMockProvider({
      script: [{ kind: "text", text: "hello" }],
    });
    const controller = new AbortController();

    const chunks = await collect(
      provider.connect(
        [
          {
            id: "u1",
            parts: [{ content: "hi", type: "text" }],
            role: "user",
          },
        ],
        { source: "test" },
        controller.signal,
        { runId: "run-7", threadId: "thread-9" },
      ),
    );

    expect(
      chunks.find((chunk) => chunk.type === EventType.RUN_STARTED),
    ).toMatchObject({ runId: "run-7", threadId: "thread-9" });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      data: { source: "test" },
      index: 0,
      runId: "run-7",
      signal: controller.signal,
      threadId: "thread-9",
    });
    expect(provider.calls[0]?.messages).toHaveLength(1);
  });

  it("streams an error turn as RUN_ERROR and terminates the run", async () => {
    const provider = createMockProvider({
      script: [
        { kind: "text", text: "About to fail." },
        { code: "provider/rate-limited", kind: "error", message: "Quota hit." },
      ],
    });

    const chunks = await collect(provider.connect([], undefined));

    expect(chunkTypes(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_ERROR,
    ]);
    expect(chunks.at(-1)).toMatchObject({
      code: "provider/rate-limited",
      message: "Quota hit.",
      type: EventType.RUN_ERROR,
    });
  });

  it("round-trips a tool-call turn's input through its arg deltas", async () => {
    const input = {
      views: [{ preset: "front" }, { azimuth: 45, elevation: 30 }],
    };
    const serialized = JSON.stringify(input);
    const split = Math.ceil(serialized.length / 2);
    const provider = createMockProvider({
      script: [
        {
          argsChunks: [serialized.slice(0, split), serialized.slice(split)],
          input,
          kind: "tool-call",
          toolName: "cad_capture_views",
        },
      ],
    });

    const chunks = await collect(provider.connect([], undefined));

    expect(
      chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_START),
    ).toMatchObject({ toolCallName: "cad_capture_views" });
    const deltas = argsDeltasOf(chunks);
    expect(deltas).toHaveLength(2);
    expect(JSON.parse(deltas.join(""))).toEqual(input);
  });

  it("carries a refusal tool result as the D9 diagnostic, recoverable via parseAgentToolRefusal", async () => {
    const refusal = {
      code: "webmcp/invalid-input",
      location: { primary: "sphere.1", related: ["box.1"] },
      message: "Unknown object id.",
    };
    const provider = createMockProvider({
      script: [
        {
          input: { commands: [] },
          kind: "tool-call",
          toolName: "cad_apply_commands",
        },
        { kind: "tool-result", refusal },
      ],
    });

    const chunks = await collect(provider.connect([], undefined));
    const result = toolResultChunkOf(chunks);

    expect(result).toBeDefined();
    expect(typeof result?.content).toBe("string");
    if (typeof result?.content === "string") {
      expect(parseAgentToolRefusal(result.content)).toEqual(refusal);
    }
  });

  it("drives the real ChatClient through the Phase 2.3 bridge, round-tripping the tool input", async () => {
    const executor = recordingApplyExecutor();
    const input = { commands: ["sphere r=1 at 0 0 0", "box 2 2 2 at 3 0 0"] };
    const provider = createMockProvider({
      runs: [
        [
          {
            clientExecution: true,
            input,
            kind: "tool-call",
            toolName: "cad_apply_commands",
          },
        ],
        [{ kind: "text", text: "Applied 2 commands." }],
      ],
    });
    const client = new ChatClient({
      connection: provider,
      tools: createAgentTools({
        execute: executor.execute,
        tools: [applyCommandsEntry()],
      }),
    });

    try {
      await client.sendMessage("Add a sphere and a box.");
      await until(() =>
        hasAssistantText(client.getMessages(), "Applied 2 commands."),
      );

      expect(executor.calls).toEqual([{ input, name: "cad_apply_commands" }]);
      expect(client.getError()).toBeUndefined();

      const parts = client.getMessages().flatMap((message) => message.parts);
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        input,
        name: "cad_apply_commands",
        output: { applied: 2 },
        state: "complete",
        type: "tool-call",
      });
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        content: JSON.stringify({ applied: 2 }),
        state: "complete",
        type: "tool-result",
      });

      expect(provider.calls).toHaveLength(2);
      const firstUser = provider.calls[0]?.messages[0];
      expect(
        firstUser !== undefined && "parts" in firstUser
          ? firstUser.role
          : undefined,
      ).toBe("user");
      expect(provider.calls[0]?.runId).toBeDefined();
    } finally {
      client.dispose();
    }
  });

  it("surfaces a refusal result as an error-state tool part under the real client", async () => {
    const refusal = {
      code: "webmcp/invalid-input",
      message: "Unknown object id.",
    };
    // The relay shape: call, in-stream result, and the follow-up answer all
    // arrive in ONE run — the server keeps looping inside it (the client's
    // auto-continuation only exists for client tools).
    const provider = createMockProvider({
      script: [
        {
          input: { commands: ["nope"] },
          kind: "tool-call",
          toolName: "cad_apply_commands",
        },
        { kind: "tool-result", refusal },
        { kind: "text", text: "The command was refused." },
      ],
    });
    const client = new ChatClient({ connection: provider });

    try {
      await client.sendMessage("Do something impossible.");
      await until(() =>
        hasAssistantText(client.getMessages(), "The command was refused."),
      );

      const toolResult = client
        .getMessages()
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool-result");
      expect(toolResult).toMatchObject({
        state: "error",
        type: "tool-result",
      });
      if (toolResult?.type !== "tool-result") return;
      expect(typeof toolResult.content).toBe("string");
      if (typeof toolResult.content === "string") {
        expect(parseAgentToolRefusal(toolResult.content)).toEqual(refusal);
      }
    } finally {
      client.dispose();
    }
  });

  it("ends a client-execution run with the interrupt-outcome handoff", async () => {
    const provider = createMockProvider({
      runs: [
        [
          {
            clientExecution: true,
            input: { commands: ["a"] },
            kind: "tool-call",
            toolName: "cad_apply_commands",
          },
        ],
      ],
    });

    const chunks = await collect(provider.connect([], undefined));

    expect(chunks.at(-1)).toMatchObject({
      outcome: {
        interrupts: [
          {
            id: "client_tool_mock-call-1",
            metadata: {
              input: { commands: ["a"] },
              kind: "client_tool",
              toolName: "cad_apply_commands",
            },
            reason: "tanstack:client_tool_execution",
            toolCallId: "mock-call-1",
          },
        ],
        type: "interrupt",
      },
      type: EventType.RUN_FINISHED,
    });
  });

  it("selects per-run scripts by call index and refuses unscripted runs", async () => {
    const provider = createMockProvider({
      runs: [
        [{ kind: "text", text: "first" }],
        [{ kind: "text", text: "second" }],
      ],
    });

    const first = await collect(provider.connect([], undefined));
    const second = await collect(provider.connect([], undefined));

    expect(textDeltasOf(first)).toBe("first");
    expect(textDeltasOf(second)).toBe("second");
    await expect(collect(provider.connect([], undefined))).rejects.toThrow(
      /no scripted run/,
    );
  });

  it("refuses a tool-result turn with no preceding tool call", async () => {
    const provider = createMockProvider({
      script: [{ content: { applied: 0 }, kind: "tool-result" }],
    });

    await expect(collect(provider.connect([], undefined))).rejects.toThrow(
      /no preceding tool call/,
    );
  });

  it("ends the stream at the next event boundary when the run is aborted", async () => {
    const provider = createMockProvider({
      interEventTicks: 1,
      script: [
        { kind: "text", text: "one" },
        { kind: "text", text: "two" },
        { kind: "text", text: "three" },
      ],
    });

    const full = await collect(provider.connect([], undefined));

    // Abort the moment the first chunk lands: the next paced boundary must
    // end the stream instead of emitting the rest of the script.
    const controller = new AbortController();
    const collected: StreamChunk[] = [];
    const iteration = (async () => {
      for await (const chunk of provider.connect(
        [],
        undefined,
        controller.signal,
      )) {
        collected.push(chunk);
        controller.abort();
      }
    })();
    await iteration;

    expect(collected).toEqual([
      expect.objectContaining({ type: EventType.RUN_STARTED }),
    ]);
    expect(collected.length).toBeLessThan(full.length);
  });

  it("serves the fetcher currency, echoing the fetcher input's ids", async () => {
    const provider = createMockProvider({
      script: [{ kind: "text", text: "via fetcher" }],
    });

    const returned = await mockProviderFetcher(provider)(
      { messages: [], runId: "run-f", threadId: "thread-f" },
      { signal: new AbortController().signal },
    );
    // The fetcher's declared return admits a Response (the SSE arm); the
    // double always hands back its chunk iterable.
    if (returned instanceof Response) {
      throw new Error("Expected the mock fetcher to return a chunk iterable.");
    }
    const chunks = await collect(returned);

    expect(chunks[0]).toMatchObject({
      runId: "run-f",
      threadId: "thread-f",
      type: EventType.RUN_STARTED,
    });
    expect(chunkTypes(chunks)).toContain(EventType.RUN_FINISHED);
  });

  it("rejects mis-built configurations loudly", () => {
    expect(() =>
      createMockProvider({
        runs: [[{ kind: "text", text: "a" }]],
        script: [{ kind: "text", text: "b" }],
      }),
    ).toThrow(/exactly one of script or runs/);
    expect(() => createMockProvider({})).toThrow(
      /exactly one of script or runs/,
    );
    expect(() =>
      createMockProvider({
        script: [
          { kind: "error", message: "boom" },
          { kind: "text", text: "unreachable" },
        ],
      }),
    ).toThrow(/final turn/);
    expect(() =>
      createMockProvider({
        script: [
          {
            clientExecution: true,
            input: {},
            kind: "tool-call",
            toolName: "t",
          },
          { kind: "text", text: "unreachable" },
        ],
      }),
    ).toThrow(/final turn/);
    expect(() =>
      createMockProvider({
        script: [{ deltas: ["ab", "c"], kind: "text", text: "abc " }],
      }),
    ).toThrow(/deltas must join/);
    expect(() =>
      createMockProvider({
        script: [
          {
            argsChunks: ['{"a":1', "}"],
            input: { a: 2 },
            kind: "tool-call",
            toolName: "t",
          },
        ],
      }),
    ).toThrow(/argsChunks must join/);
    expect(() =>
      createMockProvider({
        script: [
          {
            content: { applied: 1 },
            kind: "tool-result",
            refusal: { code: "c", message: "m" },
          },
        ],
      }),
    ).toThrow(/exactly one of content or refusal/);
    expect(() =>
      createMockProvider({ interEventTicks: -1, script: [] }),
    ).toThrow(/interEventTicks/);
  });
});
