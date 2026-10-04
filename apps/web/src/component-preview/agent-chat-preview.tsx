/**
 * The agent-chat registry item's usage demo (PLAN-AGENT-CHAT Phase 5,
 * D12): the shipped `AgentChatPanel` driven end-to-end by a STUB
 * TRANSPORT, exactly the way a registry consumer mounts it — every
 * dynamic thing injected as props, nothing imported from the host's
 * stores or RPC client.
 *
 * The stub is deliberately LOCAL to this page (not the app's
 * `agent/testing` double, which is test-only by its own contract): a
 * minimal TanStack AI text adapter whose `chatStream` replays three
 * scripted runs — a markdown reply, a `cad_apply_commands` wire-side tool
 * call with its readable command diff and result, and a refused
 * `cad_capture_views` call rendering the diagnostics chip — cycling
 * deterministically per send. Tool results arrive ON THE WIRE (the
 * server-relay shape), so no client-tool execution machinery is involved;
 * the injected tools surface exists for the system prompt's catalogue and
 * answers through its own executor if a script ever hands off.
 *
 * The configuration is a fixed demo config (D5 applies to real pickers —
 * this page fakes a configured agent so the composer opens): the
 * "provider key" is inert because the whole transport is the stub.
 */

import { useCallback, useMemo } from "react";
import type { ReactElement } from "react";
import { EventType } from "@tanstack/ai";
import type {
  AdapterYieldChunk,
  AnyTextAdapter,
  StreamChunk,
} from "@tanstack/ai";
import { z } from "zod";
import { AgentChatPanel } from "@slopcad/ui/agent/chat/agent-chat-panel";
import type { AgentConfig } from "@slopcad/ui/agent/config/store";
import type { AgentToolsSurface } from "@slopcad/ui/agent/tools";

/** The notes section both host-affordance props scroll into view. */
const NOTES_ANCHOR_ID = "agent-chat-demo-notes";

/** The correlation ids every chunk of one run carries. */
interface DemoRunIds {
  readonly runId: string;
  readonly threadId: string;
}

/** One wire event stamped with its run's correlation ids. */
function withIds(event: StreamChunk, ids: DemoRunIds): AdapterYieldChunk {
  return { ...event, runId: ids.runId, threadId: ids.threadId };
}

/** Streams one assistant text message as AG-UI text events. */
function* textTurn(
  deltas: readonly string[],
  ids: DemoRunIds,
  messageId: string,
): Generator<AdapterYieldChunk> {
  yield withIds(
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    ids,
  );
  for (const delta of deltas) {
    yield withIds(
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta },
      ids,
    );
  }
  yield withIds({ type: EventType.TEXT_MESSAGE_END, messageId }, ids);
}

/** One scripted run: what the demo answers per send, in wire order. */
function* demoRun(
  index: number,
  ids: DemoRunIds,
): Generator<AdapterYieldChunk> {
  const callId = `${ids.runId}-call`;
  yield {
    runId: ids.runId,
    threadId: ids.threadId,
    type: EventType.RUN_STARTED,
  };
  const script = index % 3;
  if (script === 0) {
    // A markdown answer: headings, a list, and a fenced code block.
    yield* textTurn(
      [
        "Here is what this panel renders without any host machinery:\n\n",
        "## The shipped surface\n\n",
        "- markdown **text** with GFM tables and code,",
        "- thinking and tool-call parts with typed renderers,",
        "- diagnostics chips for structured tool refusals.\n\n",
        "```ts\nconst panel = <AgentChatPanel config={config} /* … */ />;\n```\n",
      ],
      ids,
      `${ids.runId}-msg`,
    );
  } else if (script === 1) {
    // A wire-side cad_apply_commands call: the readable command diff in
    // the tool-call part, the JSON answer in the tool-result part.
    yield withIds(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: callId,
        toolCallName: "cad_apply_commands",
      },
      ids,
    );
    yield withIds(
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: callId,
        delta: JSON.stringify({
          commands: [
            "parameter.set $width 42mm",
            "parameter.set $height = $width * 0.5",
            'body.create "Demo Block"',
          ],
        }),
      },
      ids,
    );
    yield withIds({ type: EventType.TOOL_CALL_END, toolCallId: callId }, ids);
    yield withIds(
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${ids.runId}-result`,
        toolCallId: callId,
        role: "tool",
        content: JSON.stringify({ applied: 3 }),
      },
      ids,
    );
    yield* textTurn(
      [
        "Applied 3 commands — the diff above is display-only, exactly as ",
        "the executed audit trail would read inside the workbench.",
      ],
      ids,
      `${ids.runId}-msg`,
    );
  } else {
    // A refused cad_capture_views call: the error-state result carries
    // the structured diagnostic the chip renderer decodes.
    yield withIds(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: callId,
        toolCallName: "cad_capture_views",
      },
      ids,
    );
    yield withIds(
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: callId,
        delta: JSON.stringify({
          views: [{ preset: "front" }, { azimuth: 30, elevation: 20 }],
        }),
      },
      ids,
    );
    yield withIds({ type: EventType.TOOL_CALL_END, toolCallId: callId }, ids);
    yield withIds(
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${ids.runId}-result`,
        toolCallId: callId,
        role: "tool",
        content: JSON.stringify({
          code: "document/no-render-target",
          message:
            "This demo has no CAD viewport, so there is nothing to capture.",
        }),
        metadata: { tanstack: { state: "output-error" } },
      },
      ids,
    );
    yield* textTurn(
      [
        "That refusal renders as the diagnostics chip above — the same ",
        "structured shape the real registry tools report.",
      ],
      ids,
      `${ids.runId}-msg`,
    );
  }
  yield {
    finishReason: "stop",
    runId: ids.runId,
    threadId: ids.threadId,
    type: EventType.RUN_FINISHED,
  };
}

/**
 * Paces the demo stream between events (the mock-provider double's
 * macrotask pacing): streamed parts arrive visibly live, not as one
 * ready-made block — which is what a demo of streaming UI should show.
 */
function pace(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 30);
  });
}

/**
 * The stub transport: a `TextAdapter` whose every `chatStream` call
 * replays the next scripted run. Ids mint per call; an aborted signal
 * ends the stream at the next event boundary.
 */
function createDemoAdapter(): AnyTextAdapter {
  let calls = 0;
  return {
    kind: "text",
    name: "agent-chat-demo",
    model: "demo-model",
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
    async *chatStream(options): AsyncIterable<AdapterYieldChunk> {
      const index = calls;
      calls += 1;
      const ids = {
        runId: `demo-run-${String(index + 1)}`,
        threadId: "demo-thread",
      };
      for (const event of demoRun(index, ids)) {
        await pace();
        if (options.abortController?.signal.aborted) {
          return;
        }
        yield event;
      }
    },
    structuredOutput() {
      return Promise.reject(
        new Error(
          "The demo stub transport does not produce structured output.",
        ),
      );
    },
  };
}

/** The demo's tool catalogue: real zod schemas, a functioning executor. */
const DEMO_TOOLS: AgentToolsSurface = {
  tools: [
    {
      name: "cad_apply_commands",
      description: "Apply CAD commands to the document (demo catalogue entry).",
      inputSchema: z.object({ commands: z.array(z.string()).min(1) }),
    },
    {
      name: "cad_capture_views",
      description:
        "Capture PNG images of the current model from one or more angles (demo catalogue entry).",
      inputSchema: z.object({
        views: z
          .array(
            z.object({
              azimuth: z.number().optional(),
              elevation: z.number().optional(),
              preset: z.enum(["front", "top", "right", "iso"]).optional(),
            }),
          )
          .min(1)
          .max(16),
      }),
    },
  ],
  execute: (name, input) =>
    Promise.resolve({
      ok: true,
      result: JSON.stringify({
        demo: true,
        input,
        tool: name,
      }),
    }),
};

/** The fixed, inert demo config (the stub replaces the provider call). */
const DEMO_CONFIG: AgentConfig = {
  provider: "openrouter",
  apiKeyByProvider: {
    openrouter: "demo-key-inert-the-stub-owns-the-transport",
  },
  modelId: "demo-model",
  reasoning: null,
  systemPrompt: null,
  openAiCompatibleBaseUrl: null,
  mode: "client",
  syncEnabled: false,
  maxIterations: 5,
};

/** Scrolls the host-contract notes into view (the two affordance props). */
function scrollNotesIntoView(): void {
  document
    .getElementById(NOTES_ANCHOR_ID)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * The component-preview page for the `agent-chat-panel` registry item:
 * the shipped panel, a stub transport, and the host-contract notes.
 */
export function AgentChatPreview(): ReactElement {
  const createAdapter = useCallback(() => createDemoAdapter(), []);
  const getDocumentSummary = useCallback(
    () =>
      "The demo host has no live CAD document; a real host injects its document outline here.",
    [],
  );

  const emptyState = useMemo(
    () => (
      <p className="text-muted-foreground px-1 py-6 text-center text-sm leading-relaxed">
        Send a message — the stub transport replies with a scripted run:
        markdown, a command diff, then a refused capture. Nothing leaves this
        page.
      </p>
    ),
    [],
  );

  return (
    <div
      className="mx-auto w-full max-w-7xl space-y-5 p-6"
      data-testid="agent-chat-demo-root"
    >
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
            Registry item preview
          </p>
          <p className="border-border text-muted-foreground rounded-sm border bg-card/60 px-1.5 py-0.5 font-mono text-[11px]">
            agent-chat-panel
          </p>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Agent chat</h1>
        <p className="text-muted-foreground max-w-4xl text-sm leading-relaxed">
          The shipped chat panel driven by a stub transport — the same props a
          registry consumer injects: config, tool surface, document summary,
          persistence (here <code>null</code>, ephemeral), and the transport
          itself (here an adapter factory; hosts can instead let the shipped
          BYOK providers or the relay handler run).
        </p>
      </header>

      <div className="flex flex-wrap items-start gap-6">
        <div className="border-border/80 bg-card/60 h-[560px] w-full max-w-[560px] shrink-0 overflow-hidden rounded-lg border">
          <AgentChatPanel
            config={DEMO_CONFIG}
            createAdapter={createAdapter}
            emptyState={emptyState}
            getDocumentSummary={getDocumentSummary}
            onForceRefreshCatalog={scrollNotesIntoView}
            onOpenSettings={scrollNotesIntoView}
            sessionSlot={null}
            store={null}
            toolsSurface={DEMO_TOOLS}
          />
        </div>

        <section
          id={NOTES_ANCHOR_ID}
          aria-label="The host contract"
          className="border-border bg-card/60 max-w-md flex-1 space-y-3 rounded-lg border p-4 text-sm leading-relaxed"
        >
          <h2 className="text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
            The host contract
          </h2>
          <p>
            The component never imports the host&apos;s stores or RPC client.
            Every dynamic value is a prop: the agent <strong>config</strong>,
            the <strong>tool surface</strong> (name, description, zod schema,
            executor), the <strong>persistence store</strong> (or{" "}
            <code>null</code> for ephemeral chat), the{" "}
            <strong>session slot</strong> for command dispatch, and the{" "}
            <strong>transport</strong> — a <code>fetch</code>, a relay URL, or a
            whole adapter factory as this demo injects.
          </p>
          <p>
            Shipped alongside the panel: the BYOK provider runtime
            (browser-direct OpenAI, Anthropic, Google, OpenRouter, and any
            OpenAI-compatible endpoint) and the keyless server-relay handler a
            host mounts as its own endpoint for server-emitted mode.
          </p>
          <p className="text-muted-foreground">
            The settings and catalog affordances in this demo scroll here
            because the demo host has neither surface; a real host opens its
            settings sheet and refreshes its catalog.
          </p>
        </section>
      </div>
    </div>
  );
}
