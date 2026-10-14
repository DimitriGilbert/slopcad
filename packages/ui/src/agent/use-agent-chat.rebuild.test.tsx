/**
 * The transport-seam stability contract (R3F2): the injected seams
 * (`createAdapter`, `fetch`, `relayUrl`) ride the hook's latest-ref and are
 * NOT transport-rebuild triggers — only the mode is. A caller-side unstable
 * `createAdapter` (a fresh inline factory per render — the naive D12-host
 * pattern) must therefore leave the chat client untouched: the thread id
 * never changes, an in-flight run is not aborted, and the transcript is
 * never reset to a stale snapshot. Rendered against the REAL `useChat`
 * because a rebuild is its client-memo behavior (`@tanstack/ai-react` keys
 * the client on the thread id alone: a new id aborts the in-flight run and
 * reseeds from the previous render's messages) — so "the one scripted run
 * still completes across re-renders" is the observable thread-id-stability
 * pin. No live network: the model is a scripted adapter at the Phase 1.2
 * seam.
 */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EventType } from "@tanstack/ai";
import type {
  AdapterYieldChunk,
  DefaultMessageMetadataByModality,
  Modality,
  TextAdapter,
} from "@tanstack/ai";

import { DEFAULT_MAX_ITERATIONS, type AgentConfig } from "./config/store";
import { useAgentChat } from "./use-agent-chat";

afterEach(cleanup);

/** Macrotask poll loop (check, tick, check) for the real client's machinery. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error("Condition was not reached within the tick budget.");
}

/** The client-mode config the test runs with (a chosen configuration). */
function agentConfig(): AgentConfig {
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
  };
}

/** One slow streamed text turn: the chunks yield across macrotasks. */
function slowTextChunks(runId: string): AdapterYieldChunk[] {
  return [
    { type: EventType.RUN_STARTED, runId, threadId: "thread-t" },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: `${runId}-msg`,
      role: "assistant",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: `${runId}-msg`,
      delta: "Still here after the re-render.",
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: `${runId}-msg` },
    {
      type: EventType.RUN_FINISHED,
      finishReason: "stop",
      runId,
      threadId: "thread-t",
    },
  ];
}

/** The scripted model shape (the Phase 1.2 seam's double). */
type SlowTextAdapter = TextAdapter<
  "scripted-model",
  Record<string, unknown>,
  ReadonlyArray<Modality>,
  DefaultMessageMetadataByModality,
  ReadonlyArray<string>,
  unknown,
  unknown
>;

/**
 * A scripted model whose chatStream turn streams slowly across macrotasks;
 * `callCount()` reports how many runs it served. A rebuilt client would
 * abort the in-flight run WITHOUT a second call — so the pin is the ONE
 * scripted call that still completes.
 */
function slowTextAdapter(): {
  readonly adapter: SlowTextAdapter;
  readonly callCount: () => number;
} {
  let calls = 0;
  const adapter: SlowTextAdapter = {
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
    async *chatStream() {
      calls += 1;
      for (const chunk of slowTextChunks(`run-${String(calls)}`)) {
        await Promise.resolve();
        // Cross several macrotasks per chunk so the stream is still
        // mid-flight when the host's re-renders land in the test below.
        for (let i = 0; i < 5; i += 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
        }
        yield chunk;
      }
    },
    structuredOutput() {
      return Promise.reject(
        new Error("slowTextAdapter: structuredOutput is not scripted."),
      );
    },
  };
  return { adapter, callCount: () => calls };
}

describe("useAgentChat transport-seam stability (R3F2)", () => {
  it("keeps the client across re-renders with an unstable createAdapter: the in-flight run survives, the transcript is not reset", async () => {
    const { adapter, callCount } = slowTextAdapter();
    const { result, rerender } = renderHook(
      (props: { readonly createAdapter: () => SlowTextAdapter }) =>
        useAgentChat({
          config: agentConfig(),
          documentSummary: "Workbench with 1 box (2x2x2) at the origin.",
          createAdapter: props.createAdapter,
          tools: [],
        }),
      { initialProps: { createAdapter: () => adapter } },
    );

    const sending = result.current.sendMessage("Draw a box.");
    void sending.catch(() => undefined);
    // The tick loop (not RTL's interval-polling waitFor) catches the run's
    // START within one macrotask, so the re-renders below land while the
    // stream is provably still mid-flight — the state a rebuild would abort.
    await until(() => callCount() === 1);

    // Host re-renders while the run streams, each passing a FRESH inline
    // factory (a new identity every time) — the pre-fix memo keyed on this
    // identity and would have minted a new thread id here, aborting the
    // run and reseeding the client from the stale snapshot.
    rerender({ createAdapter: () => adapter });
    rerender({ createAdapter: () => adapter });

    // The run was never aborted: its reply lands in the SAME client.
    await waitFor(() => {
      expect(
        result.current.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) =>
                part.type === "text" &&
                part.content === "Still here after the re-render.",
            ),
        ),
      ).toBe(true);
    });
    expect(callCount()).toBe(1);
    expect(result.current.error).toBeUndefined();

    // And later re-renders keep the transcript intact (no stale reseed, no
    // second run): exactly one user message beside the completed reply.
    rerender({ createAdapter: () => adapter });
    expect(
      result.current.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(callCount()).toBe(1);
  });
});
