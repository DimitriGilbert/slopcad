/**
 * MockProvider — the deterministic stream double for the agent chat runtime
 * (PLAN-AGENT-CHAT Phase 3.2). Test double ONLY: it lives under `testing/`
 * and must never be imported by a production path (node tests and the
 * browser e2e are its only consumers).
 *
 * Construction currency (the plan's UNVERIFIED #2, decided here): the double
 * is built ENTIRELY from `@tanstack/ai` re-exports — the `EventType` enum is
 * re-exported as a VALUE (`export { EventType } from '@ag-ui/core'` in
 * `@tanstack/ai`'s types) and every AG-UI event shape it needs is exported as
 * a structural TYPE (`RunStartedEvent`, `TextMessageStartEvent`,
 * `ToolCallArgsEvent`, …), so events are plain object literals — no
 * constructors involved. `@ag-ui/core` is therefore NOT added as an explicit
 * dependency: m5's isolation concern does not arise (verified against the
 * installed `@tanstack/ai` 0.64.0 / `@tanstack/ai-client` 0.36.1 /
 * `@tanstack/ai-react` 0.29.4 type definitions, not from memory).
 *
 * Transport currency: `useChat({ connection })` takes a
 * `ConnectConnectionAdapter` whose `connect(messages, data, abortSignal,
 * runContext)` returns an `AsyncIterable<StreamChunk>` — the shape
 * `@tanstack/ai-client`'s `stream()` produces and its connect wrapper
 * consumes (that wrapper synthesizes a terminal `RUN_FINISHED` when a stream
 * ends without one and converts a thrown error into `RUN_ERROR`, so this
 * double stays honest under the real client). The complementary
 * `useChat({ fetcher })` currency is covered by {@link mockProviderFetcher}.
 * Ids echo `runContext` when the client supplies one (as a real server
 * echoes the request's ids) and fall back to fixed defaults, so a direct
 * replay of the same script yields byte-identical event sequences — the
 * determinism contract the runtime tests and the e2e rely on.
 *
 * Scripted turns model the agent loop's wire traffic: an assistant text
 * message, a model-emitted tool call (`TOOL_CALL_START/ARGS/END` — what makes
 * the browser execute a bridged webMCP tool like `cad_apply_commands` or
 * `cad_capture_views` through the Phase 2.3 bridge, via the
 * interrupt-outcome `clientExecution` handoff the TanStack orchestrator
 * emits for a pending client tool), a relay-side tool result, and a run
 * error. Tool-refusal results carry the D9 diagnostic exactly as
 * `AgentToolRefusalError` serializes it, so `parseAgentToolRefusal` recovers
 * the structured diagnostic from the resulting error-state tool-result part
 * (the Phase 4.3 interop).
 *
 * Sequencing never blocks: the default pacing between events is one
 * microtask; `interEventTicks` opts into N macrotask (`setTimeout 0`) yields
 * for tests that need the loop to visibly interleave — no real timers are
 * otherwise involved, and an aborted signal ends the stream at the next
 * event boundary.
 */

import {
  canonicalInterruptJson,
  digestInterruptJson,
  EventType,
  hashSchemaInput,
} from "@tanstack/ai";
import type {
  ModelMessage,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StreamChunk,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UIMessage,
} from "@tanstack/ai";
import type {
  ChatFetcher,
  ConnectConnectionAdapter,
} from "@tanstack/ai-client";
import type { AgentToolRefusal } from "../tools";

/** One assistant text message, streamed as `TEXT_MESSAGE_*` events. */
export interface MockTextTurn {
  readonly kind: "text";
  /** The message's full text. */
  readonly text: string;
  /**
   * Explicit content-delta segmentation. Defaults to a single delta carrying
   * the whole text. When provided, the deltas must join to exactly `text`
   * (validated at construction — a mis-segmented script is a test bug).
   */
  readonly deltas?: readonly string[];
}

/**
 * One model-emitted tool call, streamed as `TOOL_CALL_START` → arg deltas →
 * `TOOL_CALL_END`. This is the turn that makes a real chat client execute a
 * bridged client tool (the Phase 2.3 webMCP bridge) and auto-continue.
 */
export interface MockToolCallTurn {
  readonly kind: "tool-call";
  /** The registry tool name the model is calling. */
  readonly toolName: string;
  /** The call's arguments; JSON-serialized onto the wire. */
  readonly input: unknown;
  /**
   * Explicit arg-delta segmentation over the canonical serialization. Must
   * join to exactly `JSON.stringify(input)` (validated at construction).
   */
  readonly argsChunks?: readonly string[];
  /**
   * The call's id. Defaults to a deterministic generated id (`mock-call-N`,
   * numbered per run in emission order) so replays are identical.
   */
  readonly toolCallId?: string;
  /**
   * Hand the call to the browser: end the run after `TOOL_CALL_END` with the
   * interrupt-outcome `RUN_FINISHED` the TanStack orchestrator emits for a
   * pending CLIENT tool — the wire shape that makes the real chat client
   * execute a bridged webMCP tool (`cad_apply_commands`,
   * `cad_capture_views`, …) through the Phase 2.3 bridge and auto-continue.
   * The turn must be final (validated); pair it with `runs` so the
   * continuation plays the next script — under a plain repeating `script`
   * the continuation would re-emit the same call forever.
   */
  readonly clientExecution?: boolean;
}

/**
 * One tool result delivered on the stream (the server-relay shape — a
 * server-executed tool answering; client-tool results are added by the chat
 * client itself and never appear on the wire).
 */
export interface MockToolResultTurn {
  readonly kind: "tool-result";
  /**
   * The call being answered. Defaults to the most recent tool-call turn in
   * the same run; a script whose first tool-ish turn is a result refuses at
   * emission.
   */
  readonly toolCallId?: string;
  /**
   * The result payload: a string passes through verbatim, any other value is
   * JSON-serialized (the wire convention the processor JSON-parses back).
   * Exactly one of `content` / `refusal` must be set.
   */
  readonly content?: unknown;
  /**
   * The D9 diagnostic arm: a registry refusal, carried as the exact JSON
   * `AgentToolRefusalError` leaves in an error-state tool result, producing
   * an `output-error` result part recoverable with `parseAgentToolRefusal`.
   * Implies the error state.
   */
  readonly refusal?: AgentToolRefusal;
  /**
   * Marks a plain-content result as an error-state result part (`output-error`)
   * without the refusal shape — for error payloads that are not D9
   * diagnostics. Ignored when `refusal` is set (refusal implies error).
   */
  readonly error?: boolean;
}

/**
 * A run-level failure: emits `RUN_ERROR` and terminates the run (no
 * `RUN_FINISHED` follows). Must be the final turn of its script — validated
 * at construction.
 */
export interface MockErrorTurn {
  readonly kind: "error";
  readonly message: string;
  readonly code?: string;
}

/** One scripted turn of a mock run. */
export type MockScriptTurn =
  MockTextTurn | MockToolCallTurn | MockToolResultTurn | MockErrorTurn;

/** Configuration for {@link createMockProvider}. */
export interface MockProviderOptions {
  /**
   * The script EVERY `connect()` replays (each call is one run, with fresh
   * per-run id counters, so two replays are identical). Mutually exclusive
   * with `runs`; exactly one must be provided.
   */
  readonly script?: readonly MockScriptTurn[];
  /**
   * Per-run scripts, selected by `connect()` call index (0-based) — the
   * multi-run shape a tool-loop continuation needs. A `connect()` beyond the
   * configured runs throws inside the stream (an unscripted run is a bug the
   * test must see, not silently repeat the last script).
   */
  readonly runs?: readonly (readonly MockScriptTurn[])[];
  /**
   * Macrotask (`setTimeout 0`) yields between events, for tests that need
   * the stream to visibly interleave with other work. Default 0: pacing is
   * a single microtask and no real timer is ever scheduled.
   */
  readonly interEventTicks?: number;
}

/** One recorded `connect()` call, the recording-context pattern of Phase 2.3. */
export interface MockProviderCall {
  /** 0-based call ordinal. */
  readonly index: number;
  /** The message history as passed (element references shared with the caller). */
  readonly messages: readonly (UIMessage | ModelMessage)[];
  /** The merged body data as passed, when the caller supplied one. */
  readonly data: Record<string, unknown> | undefined;
  /** The run correlation ids as passed, when the caller supplied them. */
  readonly threadId: string | undefined;
  readonly runId: string | undefined;
  /** The abort signal the run is streaming under. */
  readonly signal: AbortSignal | undefined;
}

/**
 * The deterministic double: a `ConnectConnectionAdapter` (the `useChat`
 * `connection` currency) that records every call for assertions.
 */
export interface MockProvider extends ConnectConnectionAdapter {
  /** Every `connect()` call so far, in order. */
  readonly calls: readonly MockProviderCall[];
}

/** The run ids a replay echoes: the caller's when given, fixed defaults else. */
interface RunIds {
  readonly threadId: string;
  readonly runId: string;
}

const DEFAULT_THREAD_ID = "mock-thread";
const DEFAULT_RUN_ID = "mock-run";

/** One pacing boundary: always a microtask, plus any configured macrotasks. */
async function pace(macrotasks: number): Promise<void> {
  await Promise.resolve();
  for (let i = 0; i < macrotasks; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Refuses a mis-built script at construction, with the offending position. */
function validateTurns(turns: readonly MockScriptTurn[], label: string): void {
  for (const [index, turn] of turns.entries()) {
    const where = `${label}[${String(index)}]`;
    if (turn.kind === "error" && index !== turns.length - 1) {
      throw new RangeError(
        `${where}: an error turn terminates its run, so it must be the script's final turn.`,
      );
    }
    if (
      turn.kind === "text" &&
      turn.deltas !== undefined &&
      turn.deltas.join("") !== turn.text
    ) {
      throw new RangeError(
        `${where}: deltas must join to exactly the turn's text.`,
      );
    }
    if (
      turn.kind === "tool-call" &&
      turn.argsChunks !== undefined &&
      turn.argsChunks.join("") !== JSON.stringify(turn.input)
    ) {
      throw new RangeError(
        `${where}: argsChunks must join to exactly JSON.stringify(input).`,
      );
    }
    if (
      turn.kind === "tool-call" &&
      turn.clientExecution === true &&
      index !== turns.length - 1
    ) {
      throw new RangeError(
        `${where}: a client-execution turn ends its run at the call, so it must be the script's final turn.`,
      );
    }
    if (turn.kind === "tool-result") {
      const hasContent = turn.content !== undefined;
      const hasRefusal = turn.refusal !== undefined;
      if (hasContent === hasRefusal) {
        throw new RangeError(
          `${where}: a tool-result turn needs exactly one of content or refusal.`,
        );
      }
    }
  }
}

/** The text deltas a text turn emits: its explicit segmentation or the whole text. */
function textDeltas(turn: MockTextTurn): readonly string[] {
  return turn.deltas ?? [turn.text];
}

/** The arg deltas a tool-call turn emits over the canonical serialization. */
function toolArgsChunks(turn: MockToolCallTurn): readonly string[] {
  return turn.argsChunks ?? [JSON.stringify(turn.input)];
}

/** The wire content of a tool-result turn (the refusal's serialized D9 form). */
function toolResultContent(turn: MockToolResultTurn): string {
  if (turn.refusal !== undefined) {
    return JSON.stringify({
      code: turn.refusal.code,
      message: turn.refusal.message,
      ...(turn.refusal.location === undefined
        ? {}
        : { location: turn.refusal.location }),
    });
  }
  const content = turn.content;
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  return serialized ?? "null";
}

/**
 * Replays one run's script as AG-UI chunks: `RUN_STARTED`, the turns' events
 * in order, then `RUN_FINISHED` — or `RUN_ERROR` and nothing after it for an
 * error turn. Ids are minted per run in emission order, so every replay of
 * the same script under the same ids is identical.
 */
async function* replayScript(
  turns: readonly MockScriptTurn[],
  ids: RunIds,
  macrotasks: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  let messageCounter = 0;
  let callCounter = 0;
  let lastToolCallId: string | undefined;

  const nextMessageId = (): string => {
    messageCounter += 1;
    return `mock-msg-${String(messageCounter)}`;
  };
  const nextToolCallId = (): string => {
    callCounter += 1;
    return `mock-call-${String(callCounter)}`;
  };
  /** Paces, then yields — unless the run was aborted at this boundary. */
  async function* paced(chunk: StreamChunk): AsyncGenerator<StreamChunk> {
    await pace(macrotasks);
    if (signal?.aborted) return;
    yield chunk;
  }
  /** The plain run end. */
  const runFinished: RunFinishedEvent = {
    type: EventType.RUN_FINISHED,
    threadId: ids.threadId,
    runId: ids.runId,
  };
  /**
   * The client-tool handoff: the interrupt-outcome `RUN_FINISHED` the
   * TanStack orchestrator emits when the model called a tool the browser
   * owns. The chat client executes the named client tool, resolves the
   * interrupt, and auto-continues — the resume entries of that continuation
   * answer `interruptId`.
   *
   * The `tanstack:interruptBinding` is the FULLY OPENED form, targeting the
   * first-party `client-tool-execution` arm of `@tanstack/ai-client`'s
   * interrupt hydration (the binding-gated `hydrateInterrupt` branch), not
   * the legacy pre-binding arm its `metadata.kind: "client_tool"` marker
   * alone would route through. `readInterruptBinding` only returns a binding
   * when every opened field parses, so the double stamps exactly what the
   * real orchestrator puts on the wire: `interruptedRunId` (the interrupted
   * run's id — echoed from the run context, as the orchestrator's
   * `completeEphemeralInterruptBindings` stamps at RUN_FINISHED) and
   * `generation: 0` (the orchestrator's per-run first generation). The hash
   * fields are stamped too because they are trivially derivable, not
   * invented: `responseSchemaHash` digests the descriptor's own
   * `responseSchema` (the empty JSON Schema the orchestrator emits for a
   * schema-less tool), and `outputSchemaHash` is `hashSchemaInput(undefined)`
   * — the library's canonical schema-less digest, exact because the Phase
   * 2.3 bridge declares no `outputSchema` on any tool. Both come from the
   * installed `@tanstack/ai`'s own deterministic digest functions, so
   * replays stay byte-identical. Should a tool one day declare an
   * `outputSchema`, the client's hash gate would no longer match and the
   * interrupt would degrade to the generic-resumable arm — still functional,
   * just no longer the typed first-party arm.
   */
  const clientHandoff = (call: {
    id: string;
    input: unknown;
    name: string;
  }): RunFinishedEvent => ({
    type: EventType.RUN_FINISHED,
    threadId: ids.threadId,
    runId: ids.runId,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: `client_tool_${call.id}`,
          message: `Client tool ${call.name} is ready to run`,
          metadata: {
            input: call.input,
            kind: "client_tool",
            "tanstack:interruptBinding": {
              interruptId: `client_tool_${call.id}`,
              kind: "client-tool-execution",
              toolCallId: call.id,
              toolName: call.name,
              v: 1,
              interruptedRunId: ids.runId,
              generation: 0,
              outputSchemaHash: hashSchemaInput(undefined),
              responseSchemaHash: digestInterruptJson(
                canonicalInterruptJson({}),
              ),
            },
            toolName: call.name,
          },
          reason: "tanstack:client_tool_execution",
          responseSchema: {},
          toolCallId: call.id,
        },
      ],
    },
  });

  const runStarted: RunStartedEvent = {
    type: EventType.RUN_STARTED,
    threadId: ids.threadId,
    runId: ids.runId,
  };
  yield* paced(runStarted);

  for (const turn of turns) {
    if (signal?.aborted) return;
    if (turn.kind === "text") {
      const messageId = nextMessageId();
      const start: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      };
      yield* paced(start);
      for (const delta of textDeltas(turn)) {
        const content: TextMessageContentEvent = {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
        };
        yield* paced(content);
      }
      const end: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      };
      yield* paced(end);
      continue;
    }
    if (turn.kind === "tool-call") {
      const toolCallId = turn.toolCallId ?? nextToolCallId();
      lastToolCallId = toolCallId;
      const start: ToolCallStartEvent = {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: turn.toolName,
      };
      yield* paced(start);
      for (const delta of toolArgsChunks(turn)) {
        const args: ToolCallArgsEvent = {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta,
        };
        yield* paced(args);
      }
      const end: ToolCallEndEvent = {
        type: EventType.TOOL_CALL_END,
        toolCallId,
      };
      yield* paced(end);
      if (turn.clientExecution === true) {
        yield* paced(
          clientHandoff({
            id: toolCallId,
            input: turn.input,
            name: turn.toolName,
          }),
        );
        return;
      }
      continue;
    }
    if (turn.kind === "tool-result") {
      const toolCallId = turn.toolCallId ?? lastToolCallId;
      if (toolCallId === undefined) {
        throw new Error(
          "MockProvider: a tool-result turn has no preceding tool call to answer.",
        );
      }
      const result: ToolCallResultEvent = {
        type: EventType.TOOL_CALL_RESULT,
        messageId: nextMessageId(),
        toolCallId,
        content: toolResultContent(turn),
        role: "tool",
        ...(turn.refusal === undefined && turn.error !== true
          ? {}
          : {
              // The chat client's processor reads the error flag from the
              // TanStack metadata extension — the spec-compliant way an
              // error-state result part is requested from the wire.
              metadata: { tanstack: { state: "output-error" } },
            }),
      };
      yield* paced(result);
      continue;
    }
    const error: RunErrorEvent = {
      type: EventType.RUN_ERROR,
      message: turn.message,
      ...(turn.code === undefined ? {} : { code: turn.code }),
    };
    yield* paced(error);
    return;
  }

  yield* paced(runFinished);
}

/**
 * Creates the deterministic stream double. Every `connect()` call plays one
 * run and is recorded on `calls`; ids echo the caller's run context so the
 * double interops with the real chat client unchanged.
 */
export function createMockProvider(options: MockProviderOptions): MockProvider {
  const hasScript = options.script !== undefined;
  const hasRuns = options.runs !== undefined;
  if (hasScript === hasRuns) {
    throw new RangeError(
      "createMockProvider: provide exactly one of script or runs.",
    );
  }
  const macrotasks = options.interEventTicks ?? 0;
  if (!Number.isInteger(macrotasks) || macrotasks < 0) {
    throw new RangeError(
      "createMockProvider: interEventTicks must be a non-negative integer.",
    );
  }
  const runs = options.runs;
  if (runs !== undefined) {
    runs.forEach((turns, index) =>
      validateTurns(turns, `runs[${String(index)}]`),
    );
  } else if (options.script !== undefined) {
    validateTurns(options.script, "script");
  }

  const calls: MockProviderCall[] = [];

  const provider: MockProvider = {
    calls,
    async *connect(messages, data, abortSignal, runContext) {
      const index = calls.length;
      calls.push({
        index,
        messages: [...messages],
        data,
        threadId: runContext?.threadId,
        runId: runContext?.runId,
        signal: abortSignal,
      });
      // Script mode replays the one script for every call; runs mode selects
      // by call index, and an unconfigured run is the loud failure above.
      const turns = runs !== undefined ? runs[index] : options.script;
      if (turns === undefined) {
        throw new Error(
          `MockProvider: connect() call ${String(index + 1)} has no scripted run (runs configured: ${String(runs?.length)}).`,
        );
      }
      yield* replayScript(
        turns,
        {
          threadId: runContext?.threadId ?? DEFAULT_THREAD_ID,
          runId: runContext?.runId ?? DEFAULT_RUN_ID,
        },
        macrotasks,
        abortSignal,
      );
    },
  };
  return provider;
}

/**
 * The double's `useChat({ fetcher })` currency: wraps a {@link MockProvider}
 * as a `ChatFetcher` returning its chunk iterable, forwarding the fetcher
 * input's correlation ids as the run context (so replays echo them).
 */
export function mockProviderFetcher(provider: MockProvider): ChatFetcher {
  return (input, options) =>
    provider.connect(input.messages, input.data, options.signal, {
      threadId: input.threadId,
      runId: input.runId,
      ...(input.parentRunId === undefined
        ? {}
        : { parentRunId: input.parentRunId }),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
    });
}
