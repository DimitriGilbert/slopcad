/**
 * The WebMCP tool registry (Phase 7): the INTERNAL source of truth for the
 * tools this app exposes. The browser's `document.modelContext` (behind an
 * origin trial / testing flag) is only ever a MIRROR of what lives here —
 * the registry is populated unconditionally on mount, so tests, e2e, and
 * future hosts can enumerate and drive tools without the Chrome flag.
 *
 * ## Shape discipline
 *
 * A {@link WebMcpToolDefinition} is the authored, type-safe form: a zod v4
 * input schema plus a handler whose parameter is the schema's OUTPUT type.
 * {@link defineWebMcpTool} erases the generic into a flat
 * {@link WebMcpToolEntry} whose execute parses raw input through the schema
 * first — the single parse point, so the registry and the spec mirror can
 * never disagree about validation.
 *
 * ## Results discipline
 *
 * Handlers return structured JSON values (the repo's `ParseResult`
 * convention: `{ ok: true, ... }` or `{ ok: false, code, message }`).
 * {@link executeWebMcpTool} stringifies success into the DOMString the spec
 * API returns and converts every failure mode (unknown tool, invalid input,
 * handler throw, non-serializable result) into a structured error — nothing
 * ever throws across the boundary into host code.
 */

import { z, type ZodType } from "zod";
import type { ModelContextToolAnnotations } from "./model-context";

/** The annotations, shared verbatim with the spec mirror's shape. */
export type WebMcpToolAnnotations = ModelContextToolAnnotations;

/** The handler's execution options: the caller's abort signal. */
export interface WebMcpExecuteOptions {
  readonly signal: AbortSignal;
}

/**
 * The authored form of one tool: a zod input schema plus a handler typed to
 * the schema's output. Construct through {@link defineWebMcpTool}; the
 * handler may be sync or async and must return a JSON-serializable value.
 */
export interface WebMcpToolDefinition<I extends ZodType = ZodType> {
  /** 1-128 characters of `[A-Za-z0-9._-]` (the spec's name rule). */
  readonly name: string;
  /** Optional human-readable title. */
  readonly title?: string;
  /** What the tool does (required). */
  readonly description: string;
  /** The input's zod schema; its JSON Schema form is what agents see. */
  readonly inputSchema: I;
  /** Usage hints for the consuming agent (never a security boundary). */
  readonly annotations?: WebMcpToolAnnotations;
  /** The tool's effect; receives the parsed input. */
  readonly execute: (
    input: z.output<I>,
    options: WebMcpExecuteOptions,
  ) => unknown;
}

/**
 * The erased, executable form stored by the registry: the input arrives as
 * `unknown` (agents submit JSON) and is parsed through the entry's schema
 * before the handler runs.
 */
export interface WebMcpToolEntry {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: ZodType;
  readonly annotations?: WebMcpToolAnnotations;
  readonly execute: (input: unknown, options: WebMcpExecuteOptions) => unknown;
}

/** The registry's serializable snapshot entry: EVERYTHING but the handler. */
export interface WebMcpToolSnapshot {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  /** The JSON Schema form of the input schema (zod v4 `toJSONSchema`). */
  readonly inputSchema: object;
  readonly annotations: WebMcpToolAnnotations | null;
}

/** The structured outcome of {@link executeWebMcpTool}. */
export type WebMcpToolExecutionResult =
  | { readonly ok: true; readonly result: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The ownership handle {@link registerWebMcpTool} returns: the proof that
 * THIS call put the entry under its name. Registration stays replace-by-
 * name, so a later registration under the same name invalidates the
 * earlier handle — and unregistering through a stale handle is a no-op
 * that leaves the surviving registration (and the toolchange listeners)
 * untouched. A host's cleanup therefore can never delete another host's
 * live registration, which is what makes the documented multi-host role
 * of the registry safe.
 */
export interface WebMcpToolRegistration {
  /** The name this registration was filed under. */
  readonly name: string;
  /**
   * Unregisters this registration's entry if — and only if — it still
   * owns the name. True when the entry was removed (toolchange notified);
   * false when a newer registration holds the name or it is already gone
   * (a no-op, nothing notified).
   */
  readonly unregister: () => boolean;
}

/** The registered, executable tool plus its derived JSON Schema. */
interface RegisteredTool {
  readonly entry: WebMcpToolEntry;
  readonly inputJsonSchema: object;
  /** The registration that owns this entry (the stale-handle check). */
  readonly owner: WebMcpToolRegistration;
}

/** Stable failure codes the registry itself produces. */
export const WEBMCP_ERROR_CODES = {
  unknownTool: "webmcp/unknown-tool",
  invalidInput: "webmcp/invalid-input",
  toolFailure: "webmcp/tool-failure",
  nameInvalid: "webmcp/name-invalid",
} as const;

/** The name rule the spec pins: 1-128 characters of `[A-Za-z0-9._-]`. */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** The registry: name → registered tool, plus toolchange listeners. */
const registeredTools = new Map<string, RegisteredTool>();
const toolchangeListeners = new Set<() => void>();

function requireValidName(name: string): void {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new RangeError(
      `WebMCP tool names must be 1-128 characters of [A-Za-z0-9._-]; got "${name}".`,
    );
  }
}

function notifyToolchange(): void {
  for (const listener of [...toolchangeListeners]) listener();
}

/**
 * Erases a typed definition into a registry entry: the single seam where the
 * zod schema's parse wraps the handler, so every later caller (registry
 * execution, the spec mirror) validates identically.
 */
export function defineWebMcpTool<I extends ZodType>(
  definition: WebMcpToolDefinition<I>,
): WebMcpToolEntry {
  requireValidName(definition.name);
  return {
    annotations: definition.annotations,
    description: definition.description,
    execute: (input: unknown, options: WebMcpExecuteOptions) =>
      definition.execute(definition.inputSchema.parse(input), options),
    inputSchema: definition.inputSchema,
    name: definition.name,
    ...(definition.title === undefined ? {} : { title: definition.title }),
  };
}

/**
 * Registers (or replaces — idempotent by name) one tool and notifies the
 * toolchange listeners. Returns the registration's ownership handle:
 * cleanup paths must unregister through it, so they remove the entry only
 * while it is still theirs. The JSON Schema is derived here, eagerly: an
 * unrepresentable schema is a programming error and fails loudly at
 * registration, never at agent-execution time.
 */
export function registerWebMcpTool(
  entry: WebMcpToolEntry,
): WebMcpToolRegistration {
  requireValidName(entry.name);
  const registration: WebMcpToolRegistration = {
    name: entry.name,
    unregister: () => {
      const current = registeredTools.get(entry.name);
      if (current === undefined || current.owner !== registration) {
        return false;
      }
      registeredTools.delete(entry.name);
      notifyToolchange();
      return true;
    },
  };
  registeredTools.set(entry.name, {
    entry,
    inputJsonSchema: z.toJSONSchema(entry.inputSchema),
    owner: registration,
  });
  notifyToolchange();
  return registration;
}

/**
 * Unregisters one tool by name, unconditionally — the administrative
 * removal for teardown and tests. Bindings cleaning up after themselves
 * must go through their {@link WebMcpToolRegistration} handles instead,
 * which are scoped to what they own. Idempotent: unregistering an absent
 * name is a no-op (and notifies nothing — toolchange fires only on real
 * changes).
 */
export function unregisterWebMcpTool(name: string): void {
  if (!registeredTools.delete(name)) return;
  notifyToolchange();
}

/** The registered tool names, in registration order. */
export function webMcpToolNames(): readonly string[] {
  return [...registeredTools.keys()];
}

/**
 * The serializable snapshot of every registered tool — names, titles,
 * descriptions, JSON Schemas, annotations; NO handlers. This is the exact
 * payload `window.__slopcadWebMcpTools()` serves.
 */
export function webMcpToolSnapshot(): readonly WebMcpToolSnapshot[] {
  return [...registeredTools.values()].map((tool) => ({
    annotations: tool.entry.annotations ?? null,
    description: tool.entry.description,
    inputSchema: tool.inputJsonSchema,
    name: tool.entry.name,
    title: tool.entry.title ?? null,
  }));
}

/**
 * Subscribes to toolchange semantics: the listener fires after every real
 * registration change. Returns the unsubscribe function.
 */
export function subscribeWebMcpTools(listener: () => void): () => void {
  toolchangeListeners.add(listener);
  return () => {
    toolchangeListeners.delete(listener);
  };
}

/** Converts a caught unknown into the structured execution error form. */
function executionFailure(error: unknown): WebMcpToolExecutionResult {
  return {
    code: WEBMCP_ERROR_CODES.toolFailure,
    message: error instanceof Error ? error.message : String(error),
    ok: false,
  };
}

/**
 * Executes one registered tool against raw (agent-supplied JSON) input:
 * parse → handler → stringify. Never throws — every failure mode returns
 * the structured error, exactly what the mirror passes back to the agent.
 */
export async function executeWebMcpTool(
  name: string,
  input: unknown,
  options: WebMcpExecuteOptions,
): Promise<WebMcpToolExecutionResult> {
  const tool = registeredTools.get(name);
  if (tool === undefined) {
    return {
      code: WEBMCP_ERROR_CODES.unknownTool,
      message: `No WebMCP tool named "${name}" is registered (registered: ${webMcpToolNames().join(", ") || "none"}).`,
      ok: false,
    };
  }
  let value: unknown;
  try {
    value = await tool.entry.execute(input, options);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        code: WEBMCP_ERROR_CODES.invalidInput,
        message: `Input rejected by the tool's schema: ${error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        ok: false,
      };
    }
    return executionFailure(error);
  }
  try {
    return { ok: true, result: JSON.stringify(value) };
  } catch (error) {
    return executionFailure(error);
  }
}
