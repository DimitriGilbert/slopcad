/**
 * The webMCP registry → TanStack AI bridge (PLAN-AGENT-CHAT Phase 2.3): one
 * function that turns the page-bound webMCP tool set into TanStack AI CLIENT
 * tools — `toolDefinition({ … }).client(…)` — for the browser-resident agent
 * loop (the ADR's execution model: the loop runs in the browser, so every CAD
 * tool executes through `.client()`, never `.server()`).
 *
 * Shape discipline, verified against the installed `@tanstack/ai` 0.64.0 type
 * definitions (`src/activities/chat/tools/tool-definition.ts`,
 * `src/types.ts`, `src/utilities/tool-result.ts`) — not from memory:
 *
 * - `inputSchema` is REUSED from the registry entry — the same zod object,
 *   never re-declared — so the schema the model sees (via zod v4's
 *   Standard-JSON-Schema `~standard` surface), the schema that validates the
 *   model's arguments, and the schema the registry itself parses with can
 *   never drift. No `outputSchema` is declared anywhere: registry results are
 *   already validated domain payloads, and a second declaration of any tool's
 *   output shape would be exactly the drift this bridge exists to prevent.
 * - `needsApproval: false` (D4): direct execution on the existing undo stack
 *   is the safety net; there is deliberately no propose-then-apply gate.
 * - Multi-step tools run as per-step registry calls with a `progress` CUSTOM
 *   event after each step (`context.emitCustomEvent`, the
 *   `ToolExecutionContext` capability). Today `cad_capture_views` is the one
 *   multi-step tool (D10): an N-view call is split into N single-view
 *   registry executions — same tool, same executor, per-view progress — and
 *   the merged images are wrapped into TanStack AI image content parts
 *   (base64 `data` sources), the multimodal `ToolResultPart.content` form.
 *   Note the framework caveat: `@tanstack/ai-client` 0.36.1's automatic
 *   client-tool execution currently hands client tools a no-op
 *   `emitCustomEvent`; the bridge emits per the context contract so any
 *   wiring that honors it (framework upgrade, the manual `addToolResult`
 *   path) receives the events.
 *
 * Error mapping (D9): the registry never throws — it answers with the
 * structured refusal `{ ok: false, code, message }` (the same diagnostic the
 * user's status bar, timeline chips, and toasts render). The bridge converts
 * every refusal into a THROWN `AgentToolRefusalError`, because in TanStack
 * AI's client-tool path a thrown error is what produces the error-state
 * `ToolResultPart` (the chat client maps `error.message` to the part's
 * `error`, which flows back to the model on the tool message). Since the
 * message string is the only field that survives that catch, it carries the
 * whole diagnostic as JSON — `{ code, message, location? }` — losslessly
 * recoverable with {@link parseAgentToolRefusal} (the Phase 4.3 error-part
 * renderer and these tests use it).
 *
 * The module is page-agnostic by construction: the bound tool set and the
 * executor are INJECTED ({@link AgentToolsSurface}); nothing here imports a
 * page, a store, or the global registry — the Phase 3.3 runtime hook supplies
 * the page-mounted binding (`tools: createWorkbenchWebMcpTools(…)`,
 * `execute: executeWebMcpTool` in production; descriptors + a mock executor
 * in tests).
 */

import { toolDefinition } from "@tanstack/ai";
import type {
  ClientTool,
  ContentPart,
  SchemaInput,
  ToolExecutionContext,
} from "@tanstack/ai";
import type {
  WebMcpExecuteOptions,
  WebMcpToolEntry,
  WebMcpToolExecutionResult,
} from "../webmcp/registry";

/**
 * The executor seam: the registry's own execution signature
 * (`executeWebMcpTool`'s), injected so tests drive the bridge with a mock
 * and production passes the real registry function.
 */
export type AgentWebMcpExecutor = (
  name: string,
  input: unknown,
  options: WebMcpExecuteOptions,
) => Promise<WebMcpToolExecutionResult>;

/**
 * The page-agnostic binding the bridge consumes: the bound webMCP tool set
 * (the page-mounted registry content — entries carry the zod input schemas)
 * plus the executor that runs them.
 */
export interface AgentToolsSurface {
  readonly tools: readonly WebMcpToolEntry[];
  readonly execute: AgentWebMcpExecutor;
}

/**
 * Where a refusal applies, in the domain's own diagnostic-location form as
 * it survives the registry's JSON boundary (CAD ids as strings).
 */
export interface AgentToolRefusalLocation {
  readonly primary: string;
  readonly related?: readonly string[];
}

/** One structured tool refusal, D9's diagnostic contract. */
export interface AgentToolRefusal {
  readonly code: string;
  readonly message: string;
  readonly location?: AgentToolRefusalLocation;
}

/**
 * The thrown form of one refusal. `message` is the JSON encoding of the
 * whole diagnostic — the only field that survives the chat client's catch
 * into the error-state tool result part — while {@link refusal} keeps the
 * structured original (its `message` is the human-readable one) for
 * in-process catchers.
 */
export class AgentToolRefusalError extends Error {
  readonly refusal: AgentToolRefusal;

  constructor(refusal: AgentToolRefusal) {
    super(formatAgentToolRefusal(refusal));
    this.name = "AgentToolRefusalError";
    this.refusal = refusal;
  }

  /** The refusal's stable code (`refusal.code`). */
  get code(): string {
    return this.refusal.code;
  }

  /** The refusal's diagnostic location, when it carries one. */
  get location(): AgentToolRefusalLocation | undefined {
    return this.refusal.location;
  }
}

/** One `progress` CUSTOM event payload a multi-step bridge tool emits. */
export interface AgentToolProgress {
  /** The 1-based step that just completed. */
  readonly step: number;
  /** The total number of steps this call splits into. */
  readonly total: number;
  /** The tool's registry name. */
  readonly tool: string;
}

/** The multi-step tool (D10): per-view registry calls with per-view progress. */
const CAPTURE_VIEWS_TOOL_NAME = "cad_capture_views";

/**
 * The bridge's own failure code: the executor reported success but the
 * result could not be honored (unparseable JSON, or a capture success
 * without a valid images payload). Unreachable through the real registry —
 * its results are `JSON.stringify` output — and therefore never silently
 * swallowed.
 */
const RESULT_MALFORMED = "agent/tool-bridge/result-malformed";

/** The signal tools run under when the framework provides none. */
const NEVER_ABORTED = new AbortController().signal;

/** The JSON encoding of one refusal — the error-part `error` string. */
function formatAgentToolRefusal(refusal: AgentToolRefusal): string {
  return JSON.stringify({
    code: refusal.code,
    message: refusal.message,
    ...(refusal.location === undefined ? {} : { location: refusal.location }),
  });
}

/**
 * Reads an optional diagnostic location off an untrusted value: present and
 * well-formed (`{ primary, related? }` with string ids) or `undefined`.
 */
function readLocation(value: unknown): AgentToolRefusalLocation | undefined {
  if (typeof value !== "object" || value === null || !("primary" in value)) {
    return undefined;
  }
  if (typeof value.primary !== "string") return undefined;
  if (!("related" in value)) return { primary: value.primary };
  const related = value.related;
  if (
    !Array.isArray(related) ||
    !related.every((id) => typeof id === "string")
  ) {
    return undefined;
  }
  return { primary: value.primary, related };
}

/**
 * Recovers a refusal from the JSON text an error-state tool result part
 * carries ({@link AgentToolRefusalError}'s message shape) — `null` for any
 * other text. The Phase 4.3 error-part renderer renders diagnostics chips
 * through this; tests prove the round trip.
 */
export function parseAgentToolRefusal(text: string): AgentToolRefusal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("code" in parsed) ||
    !("message" in parsed) ||
    typeof parsed.code !== "string" ||
    typeof parsed.message !== "string"
  ) {
    return null;
  }
  const location =
    "location" in parsed ? readLocation(parsed.location) : undefined;
  return {
    code: parsed.code,
    message: parsed.message,
    ...(location === undefined ? {} : { location }),
  };
}

/** The bridge's structured answer for an unhonorable executor success. */
function resultMalformed(detail: string): AgentToolRefusalError {
  return new AgentToolRefusalError({
    code: RESULT_MALFORMED,
    message: detail,
  });
}

/**
 * One captured view as the capture tool returns it — the inline form of a
 * TanStack AI image content part (`data` is base64 PNG).
 */
interface CapturedViewImage {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

/**
 * Splits a capture-views call into per-view registry inputs. `null` whenever
 * the call should run whole: any other tool, a single view (nothing to
 * progress over), or input the tool's own schema rejects — the whole-input
 * registry call then produces the canonical `webmcp/invalid-input` refusal
 * with the model-facing issue list.
 */
function captureViewsStepInputs(
  entry: WebMcpToolEntry,
  input: unknown,
): readonly unknown[] | null {
  if (entry.name !== CAPTURE_VIEWS_TOOL_NAME) return null;
  const parsed = entry.inputSchema.safeParse(input);
  if (!parsed.success) return null;
  const data: unknown = parsed.data;
  if (typeof data !== "object" || data === null || !("views" in data)) {
    return null;
  }
  if (!Array.isArray(data.views) || data.views.length < 2) return null;
  const views: readonly unknown[] = data.views;
  return views.map((view) => ({ views: [view] }));
}

/**
 * Guards a capture tool's success payload: every element of `images` must
 * carry string `name`/`mimeType`/`data`. `null` when the payload is not that
 * shape (a future contract change refuses loudly instead of feeding the
 * model base64 inside a JSON string it cannot see).
 */
function capturedImagesOf(value: unknown): readonly CapturedViewImage[] | null {
  if (typeof value !== "object" || value === null || !("images" in value)) {
    return null;
  }
  if (!Array.isArray(value.images) || value.images.length === 0) return null;
  const images: readonly unknown[] = value.images;
  const checked: CapturedViewImage[] = [];
  for (const image of images) {
    if (
      typeof image !== "object" ||
      image === null ||
      !("name" in image) ||
      !("mimeType" in image) ||
      !("data" in image) ||
      typeof image.name !== "string" ||
      typeof image.mimeType !== "string" ||
      typeof image.data !== "string"
    ) {
      return null;
    }
    checked.push({
      data: image.data,
      mimeType: image.mimeType,
      name: image.name,
    });
  }
  return checked;
}

/**
 * Wraps captured views into the loop's multimodal content: a text part
 * carrying the view names (the only place the labels survive — image parts
 * have no name field), then one image part per view with the base64 `data`
 * verbatim.
 */
function captureContentParts(
  images: readonly CapturedViewImage[],
): ContentPart[] {
  return [
    {
      type: "text",
      content: `Captured ${String(images.length)} ${
        images.length === 1 ? "view" : "views"
      }: ${images.map((image) => image.name).join(", ")}.`,
    },
    ...images.map((image): ContentPart => ({
      type: "image",
      source: {
        type: "data",
        value: image.data,
        mimeType: image.mimeType,
      },
    })),
  ];
}

/**
 * Runs one registry call and unwraps it: success parses back into the value
 * (the registry stringifies handlers' JSON results); every refusal becomes
 * the thrown {@link AgentToolRefusalError}, preserving `code`, `message`,
 * and `location` when the failure carries one.
 */
async function executeThroughRegistry(
  surface: AgentToolsSurface,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const options: WebMcpExecuteOptions = { signal };
  const result = await surface.execute(name, input, options);
  if (!result.ok) {
    // The registry's failure arm is closed (`{ ok, code, message }`); the
    // targeted widening reads a `location` a future diagnostics-carrying
    // refusal adds, without loosening the executor's contract (the repo's
    // untrusted-JSON narrowing convention).
    const location = readLocation(
      (result as { readonly location?: unknown }).location,
    );
    throw new AgentToolRefusalError({
      code: result.code,
      message: result.message,
      ...(location === undefined ? {} : { location }),
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(result.result);
  } catch {
    throw resultMalformed(
      `Tool "${name}" reported success but its result is not valid JSON.`,
    );
  }
  return value;
}

/**
 * One bridged tool's execution: multi-step capture calls split per view with
 * progress events between steps; every result maps as the module docs
 * describe (values through, refusals thrown, captures wrapped into image
 * content parts).
 */
async function runBridgedTool(
  surface: AgentToolsSurface,
  entry: WebMcpToolEntry,
  input: unknown,
  context: ToolExecutionContext<unknown> | undefined,
): Promise<unknown> {
  const signal = context?.abortSignal ?? NEVER_ABORTED;
  const stepInputs = captureViewsStepInputs(entry, input);
  if (stepInputs !== null) {
    const images: CapturedViewImage[] = [];
    for (const [index, stepInput] of stepInputs.entries()) {
      const stepImages = capturedImagesOf(
        await executeThroughRegistry(surface, entry.name, stepInput, signal),
      );
      if (stepImages === null) {
        throw resultMalformed(
          `Tool "${entry.name}" reported success without a valid images payload (expected { images: [{ name, mimeType, data }] }).`,
        );
      }
      images.push(...stepImages);
      context?.emitCustomEvent("progress", {
        step: index + 1,
        total: stepInputs.length,
        tool: entry.name,
      });
    }
    return captureContentParts(images);
  }
  const value = await executeThroughRegistry(
    surface,
    entry.name,
    input,
    signal,
  );
  if (entry.name !== CAPTURE_VIEWS_TOOL_NAME) return value;
  const images = capturedImagesOf(value);
  if (images === null) {
    throw resultMalformed(
      `Tool "${entry.name}" reported success without a valid images payload (expected { images: [{ name, mimeType, data }] }).`,
    );
  }
  return captureContentParts(images);
}

/**
 * Bridges the bound webMCP tool set into TanStack AI client tools: one per
 * registry entry, carrying the entry's own name, description, and zod input
 * schema (reused by reference — no re-declaration), executing through the
 * injected registry executor with `needsApproval: false` (D4). Duplicate
 * names refuse at creation (a binding mistake must not silently shadow a
 * tool); an empty surface bridges to an empty tool list.
 */
export function createAgentTools(
  surface: AgentToolsSurface,
): readonly ClientTool<SchemaInput | undefined, SchemaInput | undefined>[] {
  const seen = new Set<string>();
  return surface.tools.map((entry) => {
    if (seen.has(entry.name)) {
      throw new RangeError(
        `The agent tool surface carries more than one webMCP tool named "${entry.name}"; each bound tool must appear exactly once.`,
      );
    }
    seen.add(entry.name);
    return toolDefinition({
      description: entry.description,
      inputSchema: entry.inputSchema,
      name: entry.name,
      needsApproval: false,
    }).client((input, context) =>
      runBridgedTool(surface, entry, input, context),
    );
  });
}
