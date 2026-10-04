// @vitest-environment node

/**
 * The webMCP → TanStack AI bridge contract (PLAN-AGENT-CHAT Phase 2.3):
 * the bridge drives the injected registry executor and maps its structured
 * outcomes — success values and `{ ok: false, code, message }` refusals —
 * into what TanStack AI's client-tool path turns into complete and error
 * result parts. The registry surface is mocked exactly as production
 * supplies it: plain `AgentToolEntry` descriptors (name, description, zod
 * input schema) plus an executor answering `AgentToolExecutionResult`s —
 * the app's richer `WebMcpToolEntry` rows (with their server-side execute)
 * satisfy the same structural contract.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolExecutionContext } from "@tanstack/ai";

import {
  AgentToolRefusalError,
  createAgentTools,
  parseAgentToolRefusal,
  type AgentToolEntry,
  type AgentToolExecutionResult,
  type AgentToolExecutor,
  type AgentToolProgress,
  type AgentToolsSurface,
} from "./tools";

/** One executor call as the recording mock saw it. */
interface RecordedCall {
  readonly name: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
}

/**
 * The mock registry executor: records every call, answers from the injected
 * responder (by call index).
 */
function recordingExecutor(
  respond: (
    name: string,
    input: unknown,
    index: number,
  ) => AgentToolExecutionResult,
): { readonly execute: AgentToolExecutor; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    execute: (name, input, options) => {
      const index = calls.length;
      calls.push({ input, name, signal: options.signal });
      return Promise.resolve(respond(name, input, index));
    },
  };
}

/** The registry's success arm over one JSON value. */
function okResult(value: unknown): AgentToolExecutionResult {
  return { ok: true, result: JSON.stringify(value) };
}

/** One captured view, the capture tool's own inline image form. */
function capturedImage(label: string): {
  data: string;
  mimeType: string;
  name: string;
} {
  return {
    data: `png-${label}`,
    mimeType: "image/png",
    name: `view-${label}.png`,
  };
}

/** An echo entry: answers the parsed input back (the executor is what runs). */
function echoEntry(): AgentToolEntry {
  return {
    description: "Echo the input back (bridge test).",
    inputSchema: z.object({ value: z.string() }),
    name: "cad_echo",
  };
}

/** The capture entry with the real tool's input contract (bridge test). */
function captureEntry(): AgentToolEntry {
  return {
    description: "Capture PNG images of the current model (bridge test).",
    inputSchema: z.object({
      views: z
        .array(
          z.object({
            preset: z.enum(["front", "top", "right", "iso"]).optional(),
          }),
        )
        .min(1)
        .max(16),
    }),
    name: "cad_capture_views",
  };
}

/** One bridged tool, exactly as `createAgentTools` produces it. */
type BridgedTool = ReturnType<typeof createAgentTools>[number];

/** Bridges one surface and returns its single tool. */
function oneTool(surface: AgentToolsSurface): BridgedTool {
  const [tool] = createAgentTools(surface);
  if (tool === undefined) {
    throw new Error("Expected exactly one bridged tool.");
  }
  return tool;
}

/** Runs one bridged tool's client execution, refusing an absent handler. */
async function run(
  tool: BridgedTool,
  input: unknown,
  context?: ToolExecutionContext<unknown>,
): Promise<unknown> {
  const execute = tool.execute;
  if (execute === undefined) {
    throw new Error(`Tool ${tool.name} bridged without an execute handler.`);
  }
  return await execute(input, context);
}

/** Captures the thrown refusal of one run (null when it resolves). */
async function refusalOf(
  tool: BridgedTool,
  input: unknown,
  context?: ToolExecutionContext<unknown>,
): Promise<AgentToolRefusalError | null> {
  return run(tool, input, context).then(
    () => null,
    (rejection: unknown) => rejection as AgentToolRefusalError,
  );
}

/** A context that records every emitted custom event. */
function recordingContext(): {
  readonly context: ToolExecutionContext<unknown>;
  readonly events: ReadonlyArray<{ name: string; value: unknown }>;
} {
  const events: Array<{ name: string; value: unknown }> = [];
  return {
    context: {
      emitCustomEvent: (name: string, value: unknown) => {
        events.push({ name, value });
      },
    },
    events,
  };
}

describe("createAgentTools", () => {
  it("reuses the registry entry's own schema, name, and description", () => {
    const entry = echoEntry();
    const { calls, execute } = recordingExecutor(() =>
      okResult({ got: "x", ok: true }),
    );
    const tool = oneTool({ execute, tools: [entry] });
    expect(calls).toHaveLength(0);
    expect(tool.name).toBe(entry.name);
    expect(tool.description).toBe(entry.description);
    // Identity, not equivalence: the registry's own schema object is what
    // the toolDefinition carries — no re-declaration, so no drift is even
    // expressible between the registry's parse and the model's schema.
    expect(tool.inputSchema).toBe(entry.inputSchema);
  });

  it("bridges every entry as a direct-execution client tool", () => {
    const { execute } = recordingExecutor(() => okResult({ ok: true }));
    const tools = createAgentTools({
      execute,
      tools: [echoEntry(), captureEntry()],
    });
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.__toolSide).toBe("client");
      expect(tool.needsApproval).toBe(false);
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("bridges an empty surface to an empty tool list", () => {
    const { execute } = recordingExecutor(() => okResult({ ok: true }));
    expect(createAgentTools({ execute, tools: [] })).toHaveLength(0);
  });

  it("refuses a surface that binds one name twice", () => {
    const { execute } = recordingExecutor(() => okResult({ ok: true }));
    expect(() =>
      createAgentTools({ execute, tools: [echoEntry(), echoEntry()] }),
    ).toThrow(RangeError);
  });
});

describe("bridged execution", () => {
  it("resolves the executor's parsed JSON value", async () => {
    const { execute } = recordingExecutor(() =>
      okResult({ got: "hello", ok: true }),
    );
    const tool = oneTool({ execute, tools: [echoEntry()] });
    await expect(run(tool, { value: "hello" })).resolves.toEqual({
      got: "hello",
      ok: true,
    });
  });

  it("forwards the caller's abort signal to the executor", async () => {
    const { calls, execute } = recordingExecutor(() =>
      okResult({ got: "x", ok: true }),
    );
    const tool = oneTool({ execute, tools: [echoEntry()] });
    const controller = new AbortController();
    await run(
      tool,
      { value: "x" },
      {
        abortSignal: controller.signal,
        emitCustomEvent: () => {},
      },
    );
    expect(calls[0]?.name).toBe("cad_echo");
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("runs under a live signal when the framework provides none", async () => {
    const { calls, execute } = recordingExecutor(() =>
      okResult({ got: "x", ok: true }),
    );
    const tool = oneTool({ execute, tools: [echoEntry()] });
    await run(tool, { value: "x" });
    expect(calls[0]?.signal.aborted).toBe(false);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a refusal to a thrown error preserving code and message", async () => {
    const { execute } = recordingExecutor(() => ({
      code: "workbench/parameter-unknown",
      message: 'No parameter "p1" in the document.',
      ok: false,
    }));
    const tool = oneTool({ execute, tools: [echoEntry()] });
    const error = await refusalOf(tool, { value: "x" });
    expect(error).toBeInstanceOf(AgentToolRefusalError);
    expect(error?.code).toBe("workbench/parameter-unknown");
    expect(error?.refusal.message).toContain('No parameter "p1"');
  });

  it("encodes the refusal so the error part's text round-trips", async () => {
    const { execute } = recordingExecutor(() => ({
      code: "webmcp/invalid-input",
      message: "Input rejected by the tool's schema: value: Required.",
      ok: false,
    }));
    const tool = oneTool({ execute, tools: [echoEntry()] });
    const error = await refusalOf(tool, { value: 7 });
    expect(error).not.toBeNull();
    // The thrown message is the only field that reaches the error-state
    // tool result part's `error` — it must carry the whole diagnostic.
    expect(parseAgentToolRefusal(error?.message ?? "")).toEqual({
      code: "webmcp/invalid-input",
      message: "Input rejected by the tool's schema: value: Required.",
    });
  });

  it("preserves location when the failure carries one", async () => {
    const { execute } = recordingExecutor(() => {
      const failure: AgentToolExecutionResult & {
        readonly location?: unknown;
      } = {
        code: "document/mate-unresolved",
        location: { primary: "mat_1", related: ["occ_2"] },
        message: "The mate has no anchors.",
        ok: false,
      };
      return failure;
    });
    const tool = oneTool({ execute, tools: [echoEntry()] });
    const error = await refusalOf(tool, { value: "x" });
    expect(error?.location).toEqual({ primary: "mat_1", related: ["occ_2"] });
    expect(parseAgentToolRefusal(error?.message ?? "")).toEqual({
      code: "document/mate-unresolved",
      location: { primary: "mat_1", related: ["occ_2"] },
      message: "The mate has no anchors.",
    });
  });

  it("maps an unparseable success result to the bridge's refusal", async () => {
    const { execute } = recordingExecutor(() => ({
      ok: true,
      result: "{not json",
    }));
    const tool = oneTool({ execute, tools: [echoEntry()] });
    const error = await refusalOf(tool, { value: "x" });
    expect(error?.code).toBe("agent/tool-bridge/result-malformed");
    expect(parseAgentToolRefusal(error?.message ?? "")).toMatchObject({
      code: "agent/tool-bridge/result-malformed",
    });
  });
});

describe("parseAgentToolRefusal", () => {
  it("rejects non-refusal error text", () => {
    expect(parseAgentToolRefusal("Error executing tool: boom")).toBeNull();
    expect(
      parseAgentToolRefusal(JSON.stringify({ code: 7, message: "x" })),
    ).toBeNull();
    expect(parseAgentToolRefusal("")).toBeNull();
  });
});

describe("cad_capture_views bridging", () => {
  /** Bridges the capture entry over a recording executor. */
  function captureSurface(
    respond: (
      name: string,
      input: unknown,
      index: number,
    ) => AgentToolExecutionResult,
  ): { calls: RecordedCall[]; tool: BridgedTool } {
    const { calls, execute } = recordingExecutor(respond);
    return { calls, tool: oneTool({ execute, tools: [captureEntry()] }) };
  }

  /** Answers one captured image naming the single requested view. */
  function respondOneView(
    name: string,
    input: unknown,
  ): AgentToolExecutionResult {
    expect(name).toBe("cad_capture_views");
    const view = (input as { views: [{ preset?: string }] }).views[0];
    return okResult({
      images: [capturedImage(view.preset ?? "custom")],
      ok: true,
    });
  }

  it("runs one registry call per view, in order, with per-view progress", async () => {
    const { calls, tool } = captureSurface((name, input) =>
      respondOneView(name, input),
    );
    const { context, events } = recordingContext();
    const parts = (await run(
      tool,
      { views: [{ preset: "front" }, { preset: "top" }, { preset: "iso" }] },
      context,
    )) as Array<{ type: string }>;

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.input)).toEqual([
      { views: [{ preset: "front" }] },
      { views: [{ preset: "top" }] },
      { views: [{ preset: "iso" }] },
    ]);
    const progress: AgentToolProgress[] = events.map((event) => {
      expect(event.name).toBe("progress");
      return event.value as AgentToolProgress;
    });
    expect(progress).toEqual([
      { step: 1, total: 3, tool: "cad_capture_views" },
      { step: 2, total: 3, tool: "cad_capture_views" },
      { step: 3, total: 3, tool: "cad_capture_views" },
    ]);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({
      type: "text",
      content: "Captured 3 views: view-front.png, view-top.png, view-iso.png.",
    });
    expect(parts.slice(1)).toEqual([
      {
        type: "image",
        source: { type: "data", value: "png-front", mimeType: "image/png" },
      },
      {
        type: "image",
        source: { type: "data", value: "png-top", mimeType: "image/png" },
      },
      {
        type: "image",
        source: { type: "data", value: "png-iso", mimeType: "image/png" },
      },
    ]);
  });

  it("rejects with the refusing step's code and stops progressing", async () => {
    const { calls, tool } = captureSurface((name, input, index) =>
      index === 1
        ? {
            code: "workbench/capture-failed",
            message: "views[1]: the canvas could not be encoded as PNG.",
            ok: false,
          }
        : respondOneView(name, input),
    );
    const { context, events } = recordingContext();
    const error = await refusalOf(
      tool,
      { views: [{ preset: "front" }, { preset: "top" }, { preset: "iso" }] },
      context,
    );
    expect(error?.code).toBe("workbench/capture-failed");
    expect(parseAgentToolRefusal(error?.message ?? "")).toMatchObject({
      code: "workbench/capture-failed",
    });
    expect(calls).toHaveLength(2);
    expect(events).toEqual([
      {
        name: "progress",
        value: { step: 1, total: 3, tool: "cad_capture_views" },
      },
    ]);
  });

  it("runs a single-view call whole, still wrapped as image parts", async () => {
    const { calls, tool } = captureSurface((name, input) =>
      respondOneView(name, input),
    );
    const { context, events } = recordingContext();
    const input = { views: [{ preset: "front" }] };
    const parts = (await run(tool, input, context)) as Array<{ type: string }>;
    expect(calls).toHaveLength(1);
    // The unsplit input — same reference, unmodified.
    expect(calls[0]?.input).toBe(input);
    expect(events).toEqual([]);
    expect(parts).toEqual([
      { type: "text", content: "Captured 1 view: view-front.png." },
      {
        type: "image",
        source: { type: "data", value: "png-front", mimeType: "image/png" },
      },
    ]);
  });

  it("falls back to the whole-input call when the schema rejects it", async () => {
    const { calls, tool } = captureSurface(() => ({
      code: "webmcp/invalid-input",
      message:
        "Input rejected by the tool's schema: views: Array must contain at least 1 element.",
      ok: false,
    }));
    const input = { views: [] };
    const error = await refusalOf(tool, input);
    // One call, carrying the raw input so the registry produces the
    // canonical invalid-input refusal with the model-facing issue list.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(input);
    expect(error?.code).toBe("webmcp/invalid-input");
  });

  it("refuses a capture success without a valid images payload", async () => {
    const { tool } = captureSurface(() => okResult({ ok: true }));
    const error = await refusalOf(tool, { views: [{ preset: "front" }] });
    expect(error?.code).toBe("agent/tool-bridge/result-malformed");
  });
});
