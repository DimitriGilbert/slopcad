/**
 * The WebMCP registry's own contract: the internal source of truth for the
 * page's tools. Registration idempotency (replace by name), ownership-
 * checked unregistration (a stale handle never deletes another host's live
 * entry), the snapshot's handler-free shape, JSON Schema validity,
 * toolchange notification semantics, and the never-throws execution
 * boundary.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineWebMcpTool,
  executeWebMcpTool,
  registerWebMcpTool,
  subscribeWebMcpTools,
  unregisterWebMcpTool,
  webMcpToolNames,
  webMcpToolSnapshot,
  type WebMcpToolAnnotations,
  type WebMcpToolEntry,
} from "./registry";

/** The fresh AbortSignal every execution needs. */
function signal(): AbortSignal {
  return new AbortController().signal;
}

/** A minimal typed definition, as a host authors one. */
function probeDefinition(
  name: string,
  overrides?: {
    readonly annotations?: WebMcpToolAnnotations;
    readonly title?: string;
  },
) {
  return defineWebMcpTool({
    ...(overrides?.annotations === undefined
      ? {}
      : { annotations: overrides.annotations }),
    ...(overrides?.title === undefined ? {} : { title: overrides.title }),
    description: `The ${name} probe tool.`,
    inputSchema: z.object({ count: z.number().int().min(0) }),
    name,
    execute: (input) => ({ counted: input.count, ok: true }),
  });
}

/** Unregisters whatever a test left behind — the registry is module-global. */
function clearRegistry(): void {
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
}

afterEach(clearRegistry);

describe("registration", () => {
  it("registers a tool and lists it by name", () => {
    registerWebMcpTool(probeDefinition("registry_probe.list"));
    expect(webMcpToolNames()).toEqual(["registry_probe.list"]);
  });

  it("is idempotent: re-registering a name replaces, never duplicates", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWebMcpTools(listener);
    registerWebMcpTool(probeDefinition("registry_probe.replace"));
    registerWebMcpTool(
      defineWebMcpTool({
        description: "The replacement description.",
        inputSchema: z.object({}),
        name: "registry_probe.replace",
        execute: () => null,
      }),
    );
    expect(webMcpToolNames()).toEqual(["registry_probe.replace"]);
    expect(webMcpToolSnapshot()).toHaveLength(1);
    expect(webMcpToolSnapshot()[0]?.description).toBe(
      "The replacement description.",
    );
    // Both the initial registration and the replacement are real changes.
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("unregisters idempotently: an absent name is a no-op", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWebMcpTools(listener);
    registerWebMcpTool(probeDefinition("registry_probe.remove"));
    expect(listener).toHaveBeenCalledTimes(1);
    unregisterWebMcpTool("registry_probe.remove");
    unregisterWebMcpTool("registry_probe.remove");
    expect(webMcpToolNames()).toEqual([]);
    // toolchange fired once — for the real removal only.
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("rejects names outside the spec's 1-128 [A-Za-z0-9._-] rule", () => {
    expect(() => probeDefinition("invalid name!")).toThrow(RangeError);
    expect(() => probeDefinition("")).toThrow(RangeError);
    expect(() => probeDefinition("slash/name")).toThrow(RangeError);
  });
});

describe("registration ownership", () => {
  it("returns a handle that unregisters exactly its own registration", () => {
    const registration = registerWebMcpTool(
      probeDefinition("registry_probe.owned"),
    );
    expect(registration.name).toBe("registry_probe.owned");
    expect(webMcpToolNames()).toEqual(["registry_probe.owned"]);
    expect(registration.unregister()).toBe(true);
    expect(webMcpToolNames()).toEqual([]);
    // Idempotent: the entry is already gone.
    expect(registration.unregister()).toBe(false);
  });

  it("a stale handle is a no-op once another registration owns the name", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWebMcpTools(listener);
    const stale = registerWebMcpTool(probeDefinition("registry_probe.stale"));
    registerWebMcpTool(
      defineWebMcpTool({
        description: "The surviving replacement.",
        inputSchema: z.object({}),
        name: "registry_probe.stale",
        execute: () => ({ owner: "replacement" }),
      }),
    );
    listener.mockClear();
    // The stale handle must not delete the replacement's live entry…
    expect(stale.unregister()).toBe(false);
    expect(webMcpToolNames()).toEqual(["registry_probe.stale"]);
    expect(webMcpToolSnapshot()).toHaveLength(1);
    expect(webMcpToolSnapshot()[0]?.description).toBe(
      "The surviving replacement.",
    );
    // …and a no-op is not a registry change: toolchange stays silent.
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("the snapshot", () => {
  it("carries names, titles, descriptions, annotations, and JSON Schemas", () => {
    registerWebMcpTool(
      probeDefinition("registry_probe.snapshot", {
        annotations: { readOnlyHint: true },
        title: "Probe",
      }),
    );
    registerWebMcpTool(probeDefinition("registry_probe.untitled"));
    const snapshot = webMcpToolSnapshot();
    expect(snapshot.map((tool) => tool.name)).toEqual([
      "registry_probe.snapshot",
      "registry_probe.untitled",
    ]);
    expect(snapshot[0]).toMatchObject({
      annotations: { readOnlyHint: true },
      description: "The registry_probe.snapshot probe tool.",
      title: "Probe",
    });
    expect(snapshot[1]?.title).toBeNull();
    expect(snapshot[1]?.annotations).toBeNull();
  });

  it("derives a valid JSON Schema with type and properties per tool", () => {
    registerWebMcpTool(probeDefinition("registry_probe.schema"));
    const schema = webMcpToolSnapshot()[0]?.inputSchema;
    expect(typeof schema === "object" && schema !== null).toBe(true);
    const jsonSchema = schema as {
      readonly type?: unknown;
      readonly properties?: unknown;
      readonly required?: unknown;
    };
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toHaveProperty("count");
    expect(jsonSchema.required).toContain("count");
  });

  it("is fully serializable: no handler ever rides along", () => {
    registerWebMcpTool(probeDefinition("registry_probe.serializable"));
    const parsed: unknown = JSON.parse(JSON.stringify(webMcpToolSnapshot()));
    expect(JSON.stringify(parsed)).not.toContain("execute");
    const roundTrip = parsed as readonly { readonly name: string }[];
    expect(roundTrip[0]?.name).toBe("registry_probe.serializable");
  });
});

describe("subscription", () => {
  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWebMcpTools(listener);
    registerWebMcpTool(probeDefinition("registry_probe.subscribe"));
    unsubscribe();
    registerWebMcpTool(probeDefinition("registry_probe.after"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("execution boundary", () => {
  /** Registers the probe and returns its name for the assertions. */
  function registerProbe(name: string): string {
    registerWebMcpTool(probeDefinition(name));
    return name;
  }

  it("parses input through the schema, then returns the stringified result", async () => {
    const name = registerProbe("registry_probe.execute");
    const outcome = await executeWebMcpTool(
      name,
      { count: 7 },
      {
        signal: signal(),
      },
    );
    expect(outcome).toEqual({ ok: true, result: '{"counted":7,"ok":true}' });
  });

  it("reports an unknown tool structurally", async () => {
    const outcome = await executeWebMcpTool(
      "registry_probe.absent",
      {},
      {
        signal: signal(),
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("webmcp/unknown-tool");
      expect(outcome.message).toContain("registry_probe.absent");
    }
  });

  it("reports schema-invalid input as webmcp/invalid-input", async () => {
    const name = registerProbe("registry_probe.invalid");
    const outcome = await executeWebMcpTool(
      name,
      { count: -1 },
      {
        signal: signal(),
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("webmcp/invalid-input");
  });

  it("converts a throwing handler into webmcp/tool-failure", async () => {
    registerWebMcpTool(
      defineWebMcpTool({
        description: "Always refuses to run.",
        inputSchema: z.object({}),
        name: "registry_probe.throws",
        execute: () => {
          throw new Error("handler exploded");
        },
      }),
    );
    const outcome = await executeWebMcpTool(
      "registry_probe.throws",
      {},
      {
        signal: signal(),
      },
    );
    expect(outcome).toMatchObject({
      code: "webmcp/tool-failure",
      message: "handler exploded",
      ok: false,
    });
  });

  it("converts a non-serializable handler result into a failure", async () => {
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;
    registerWebMcpTool(
      defineWebMcpTool({
        description: "Returns an unserializable value.",
        inputSchema: z.object({}),
        name: "registry_probe.circular",
        execute: () => circular,
      }),
    );
    const outcome = await executeWebMcpTool(
      "registry_probe.circular",
      {},
      {
        signal: signal(),
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("webmcp/tool-failure");
  });

  it("forwards the caller's abort signal to the handler", async () => {
    let observed: AbortSignal | null = null;
    registerWebMcpTool(
      defineWebMcpTool({
        description: "Echoes the execution signal.",
        inputSchema: z.object({}),
        name: "registry_probe.signal",
        execute: (_input, options) => {
          observed = options.signal;
          return { ok: true };
        },
      }),
    );
    const controller = new AbortController();
    await executeWebMcpTool(
      "registry_probe.signal",
      {},
      {
        signal: controller.signal,
      },
    );
    expect(observed).toBe(controller.signal);
  });
});

describe("defineWebMcpTool erasure", () => {
  it("keeps the authored members on the flat entry", () => {
    const entry: WebMcpToolEntry = probeDefinition("registry_probe.entry", {
      annotations: { consequentialHint: true },
      title: "Titled",
    });
    expect(entry.name).toBe("registry_probe.entry");
    expect(entry.title).toBe("Titled");
    expect(entry.annotations).toEqual({ consequentialHint: true });
    expect(typeof entry.execute).toBe("function");
  });
});
