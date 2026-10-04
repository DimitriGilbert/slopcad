/**
 * The WebMCP host API mirror (Phase 7): a minimal, local TypeScript
 * interface for the W3C Web Machine Learning CG's `document.modelContext`
 * surface (https://webmachinelearning.github.io/webmcp/) — the typed tools a
 * PAGE can expose to browser-resident AI agents.
 *
 * Why a hand-written mirror: the draft ships no published types package, the
 * Chrome implementation is behind an origin trial / testing flag (the API MAY
 * BE ABSENT — see {@link getModelContext}), and the app's rule is one source
 * of truth per type. The shapes below mirror the spec IDL exactly for the
 * members this app exercises; anything the host object carries beyond them
 * is invisible here, and anything missing degrades to "absent".
 *
 * Nothing in this module talks to the browser: it only narrows `unknown`
 * host objects into the typed interface (the discipline the CAD store's
 * `replaceSession` door established), so the binding layer stays SSR-safe.
 */

/**
 * Hints a tool can carry (the spec's `ToolAnnotations` dictionary): usage
 * guidance for the consuming agent, never a security boundary.
 */
export interface ModelContextToolAnnotations {
  /** The tool inspects state without modifying it. */
  readonly readOnlyHint?: boolean;
  /** The tool may incorporate untrusted content into its result. */
  readonly untrustedContentHint?: boolean;
  /** The tool modifies state or has external side effects. */
  readonly consequentialHint?: boolean;
  /** The tool exists for debugging/diagnostics. */
  readonly debugging?: boolean;
}

/**
 * The spec's `ToolExecuteCallbackOptions` dictionary: the abort signal the
 * host hands a running execution.
 */
export interface ModelContextExecuteOptions {
  readonly signal: AbortSignal;
}

/**
 * The spec's `ToolExecuteCallback`: receives the (already JSON-parsed) input
 * object the agent supplied against the tool's `inputSchema` and resolves to
 * any value the host stringifies back to the agent.
 */
export type ModelContextToolExecuteCallback = (
  inputObject: object,
  options: ModelContextExecuteOptions,
) => Promise<unknown>;

/** The spec's `ModelContextTool` dictionary, verbatim shape. */
export interface ModelContextTool {
  /** 1-128 characters of `[A-Za-z0-9._-]`. */
  readonly name: string;
  /** A human-readable display name. */
  readonly title?: string;
  /** What the tool does (required by the spec). */
  readonly description: string;
  /** The input's JSON Schema. */
  readonly inputSchema?: object;
  /** The tool's effect. */
  readonly execute: ModelContextToolExecuteCallback;
  /** Usage hints for the consuming agent. */
  readonly annotations?: ModelContextToolAnnotations;
}

/**
 * The spec's `RegisteredTool` dictionary, verbatim shape: the tool as
 * `getTools()` returns it — the registration's public members plus the
 * registering window and origin, without the `execute` callback — and the
 * object `executeTool` receives to run it (never a bare name).
 */
export interface RegisteredModelContextTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: object;
  /** The window that registered the tool. */
  readonly window: Window;
  /** The registering window's origin. */
  readonly origin: string;
  readonly annotations?: ModelContextToolAnnotations;
}

/** The spec's `ModelContextRegisterToolOptions` dictionary, verbatim. */
export interface ModelContextRegisterToolOptions {
  /** The agent origins the tool is exposed to (default: same-origin). */
  readonly exposedTo?: readonly string[];
  /**
   * Aborting this signal UNREGISTERS the tool — the spec's only
   * unregistration path (since Chrome 153 an abort does not interrupt a
   * running execution; the execution carries its own signal).
   */
  readonly signal?: AbortSignal;
}

/** The spec's `ModelContextGetToolOptions` dictionary, verbatim shape. */
export interface ModelContextGetToolOptions {
  /** List only tools exposed to these agent origins. */
  readonly fromOrigins?: readonly string[];
}

/** The spec's `ModelContextExecuteToolOptions` dictionary, verbatim shape. */
export interface ModelContextExecuteToolOptions {
  /** The execution's abort signal. */
  readonly signal?: AbortSignal;
}

/**
 * The `document.modelContext` surface, narrowed to the members this app
 * exercises (the `toolchange`/`toolactivated`/`toolcancel` events are
 * agent-facing and stay unmirrored — the page only registers).
 */
export interface ModelContext {
  readonly registerTool: (
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions,
  ) => Promise<undefined>;
  readonly getTools: (
    options?: ModelContextGetToolOptions,
  ) => Promise<readonly RegisteredModelContextTool[]>;
  readonly executeTool: (
    tool: RegisteredModelContextTool,
    inputObject?: unknown,
    options?: ModelContextExecuteToolOptions,
  ) => Promise<string>;
}

/** Structural guard: does `value` carry the model-context member shape? */
function isModelContextShape(value: unknown): value is ModelContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate: {
    registerTool?: unknown;
    getTools?: unknown;
    executeTool?: unknown;
  } = value;
  return (
    typeof candidate.registerTool === "function" &&
    typeof candidate.getTools === "function" &&
    typeof candidate.executeTool === "function"
  );
}

/**
 * The typed `document.modelContext` getter: the host object narrowed to the
 * spec interface, or `null` when the browser does not expose the API (every
 * browser today may be in this state — the draft is behind an origin trial
 * and a testing flag). Callers treat `null` as "do nothing": the internal
 * registry, not this API, is the source of truth.
 */
export function getModelContext(
  target: Document | null | undefined,
): ModelContext | null {
  if (typeof target !== "object" || target === null) return null;
  const host = target as { readonly modelContext?: unknown };
  return isModelContextShape(host.modelContext) ? host.modelContext : null;
}

/**
 * Whether `target` exposes a usable `document.modelContext` — the binding
 * layer's feature gate. Absent or partially-implemented (any of the three
 * methods missing) counts as absent: the page never calls a half-shape.
 */
export function isModelContextAvailable(
  target: Document | null | undefined,
): boolean {
  return getModelContext(target) !== null;
}
