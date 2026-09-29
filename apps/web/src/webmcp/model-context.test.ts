/**
 * The WebMCP host-API binding's contract: the feature detection against a
 * faked `document.modelContext` (the API is a draft — no browser ships it
 * by default), the spec-shape adaptation the mirror performs, the spec's
 * request surface (`getTools`/`executeTool` reached through the same
 * unknown-narrowing getter), and the failure honesty (a rejected
 * registration never propagates into app code).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  getModelContext,
  isModelContextAvailable,
  type ModelContext,
  type ModelContextExecuteToolOptions,
  type ModelContextGetToolOptions,
  type ModelContextRegisterToolOptions,
  type ModelContextTool,
  type RegisteredModelContextTool,
} from "./model-context";
import {
  defineWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
} from "./registry";
import { bindWebMcpTools, webMcpMirrorDiagnostics } from "./use-webmcp-tools";

/** One captured `executeTool` call, verbatim. */
interface CapturedExecution {
  readonly inputObject: unknown;
  readonly options: ModelContextExecuteToolOptions | undefined;
  readonly tool: RegisteredModelContextTool;
}

/** The captured activity one fake model context observed. */
interface FakeModelContext {
  readonly context: ModelContext;
  readonly executions: CapturedExecution[];
  readonly getToolsCalls: (ModelContextGetToolOptions | undefined)[];
  readonly registrations: {
    readonly options: ModelContextRegisterToolOptions | undefined;
    readonly tool: ModelContextTool;
  }[];
}

/**
 * Installs a fake `document.modelContext` (jsdom ships none). `behavior`
 * controls what `registerTool` resolves or rejects with and what `getTools`
 * lists; the fake records every registration, listing, and execution
 * verbatim, with `getTools`/`executeTool` typed exactly as the spec's IDL
 * shapes them.
 */
function installFakeModelContext(behavior?: {
  readonly rejectWith?: Error;
  readonly tools?: readonly RegisteredModelContextTool[];
}): FakeModelContext {
  const executions: CapturedExecution[] = [];
  const getToolsCalls: FakeModelContext["getToolsCalls"] = [];
  const registrations: FakeModelContext["registrations"] = [];
  const context: ModelContext = {
    executeTool: (
      tool: RegisteredModelContextTool,
      inputObject?: unknown,
      options?: ModelContextExecuteToolOptions,
    ): Promise<string> => {
      executions.push({ inputObject, options, tool });
      return Promise.resolve(`executed:${tool.name}`);
    },
    getTools: (
      options?: ModelContextGetToolOptions,
    ): Promise<readonly RegisteredModelContextTool[]> => {
      getToolsCalls.push(options);
      return Promise.resolve(behavior?.tools ?? []);
    },
    registerTool: (
      tool: ModelContextTool,
      options?: ModelContextRegisterToolOptions,
    ): Promise<undefined> => {
      registrations.push({ options, tool });
      if (behavior?.rejectWith !== undefined) {
        return Promise.reject(behavior.rejectWith);
      }
      return Promise.resolve(undefined);
    },
  };
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    get: () => context,
  });
  return { context, executions, getToolsCalls, registrations };
}

/**
 * One spec-shaped `RegisteredTool`: the full `getTools()` entry, including
 * the registering window and origin `executeTool` relies on.
 */
function registeredTool(name: string): RegisteredModelContextTool {
  return {
    annotations: { readOnlyHint: true },
    description: `The ${name} registered tool.`,
    name,
    origin: window.location.origin,
    window,
  };
}

/** Removes any fake the test installed. */
function uninstallFakeModelContext(): void {
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    get: () => undefined,
  });
}

/** One registrable entry, spec-shaped through the real erasure seam. */
function probeEntry(name: string) {
  return defineWebMcpTool({
    annotations: { readOnlyHint: true },
    description: `The ${name} probe tool.`,
    inputSchema: z.object({ id: z.string() }),
    name,
    execute: (input) => ({ echo: input.id, ok: true }),
  });
}

/** Removes any fake and unregisters whatever a test left behind. */
afterEach(() => {
  uninstallFakeModelContext();
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
  vi.unstubAllGlobals();
});

describe("feature detection", () => {
  it("reports absent without the API (the default browser state)", () => {
    uninstallFakeModelContext();
    expect(isModelContextAvailable(document)).toBe(false);
    expect(getModelContext(document)).toBeNull();
  });

  it("reports absent for a partial implementation", () => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      get: () => ({ registerTool: () => Promise.resolve(undefined) }),
    });
    expect(isModelContextAvailable(document)).toBe(false);
  });

  it("reports present and returns the typed context for a full fake", () => {
    const fake = installFakeModelContext();
    expect(isModelContextAvailable(document)).toBe(true);
    expect(getModelContext(document)).toBe(fake.context);
  });

  it("tolerates null and undefined targets", () => {
    expect(isModelContextAvailable(null)).toBe(false);
    expect(isModelContextAvailable(undefined)).toBe(false);
    expect(getModelContext(undefined)).toBeNull();
  });
});

describe("the spec's request surface (via the unknown-narrowing getter)", () => {
  it("lists RegisteredTool objects under the fromOrigins option", async () => {
    const tool = registeredTool("spec_probe.listed");
    const fake = installFakeModelContext({ tools: [tool] });
    const context = getModelContext(document);
    if (context === null) throw new Error("model context absent");
    const listed = await context.getTools({
      fromOrigins: ["https://agent.example"],
    });
    expect(listed).toEqual([tool]);
    expect(fake.getToolsCalls).toEqual([
      { fromOrigins: ["https://agent.example"] },
    ]);
    const first = listed[0];
    if (first === undefined) throw new Error("no listed tool");
    // The entry is the full RegisteredTool dictionary: the registering
    // window and origin ride along — what executeTool consumes.
    expect(first.window).toBe(window);
    expect(first.origin).toBe(window.location.origin);
  });

  it("executes a RegisteredTool object (never a bare name), stringifying the DOMString", async () => {
    const tool = registeredTool("spec_probe.execute");
    const fake = installFakeModelContext({ tools: [tool] });
    const context = getModelContext(document);
    if (context === null) throw new Error("model context absent");
    const signal = new AbortController().signal;
    const result = await context.executeTool(tool, { id: "abc" }, { signal });
    expect(result).toBe("executed:spec_probe.execute");
    expect(fake.executions).toEqual([
      { inputObject: { id: "abc" }, options: { signal }, tool },
    ]);
  });

  it("accepts the spec's minimal call shape: the tool object alone", async () => {
    const tool = registeredTool("spec_probe.minimal");
    const fake = installFakeModelContext({ tools: [tool] });
    const context = getModelContext(document);
    if (context === null) throw new Error("model context absent");
    await expect(context.executeTool(tool)).resolves.toBe(
      "executed:spec_probe.minimal",
    );
    expect(fake.executions).toEqual([
      { inputObject: undefined, options: undefined, tool },
    ]);
  });
});

describe("the mirror", () => {
  it("adapts every entry to the spec shape when the API is present", async () => {
    const fake = installFakeModelContext();
    const unbind = bindWebMcpTools([probeEntry("mirror_probe.adapt")]);
    await vi.waitFor(() => expect(fake.registrations).toHaveLength(1));
    const registration = fake.registrations[0];
    if (registration === undefined) throw new Error("no registration");
    const tool = registration.tool;
    expect(tool.name).toBe("mirror_probe.adapt");
    expect(tool.description).toBe("The mirror_probe.adapt probe tool.");
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(typeof tool.execute).toBe("function");
    const schema = tool.inputSchema as { properties?: unknown; type?: string };
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("id");
    // The registration carries the spec's unregistration path: a signal.
    expect(registration.options?.signal).toBeInstanceOf(AbortSignal);
    unbind();
  });

  it("mirrors NOTHING when the API is absent, yet registers internally", () => {
    uninstallFakeModelContext();
    const unbind = bindWebMcpTools([probeEntry("mirror_probe.absent")]);
    expect(webMcpToolNames()).toEqual(["mirror_probe.absent"]);
    unbind();
  });

  it("never propagates a registration rejection into the caller", async () => {
    installFakeModelContext({
      rejectWith: new Error("origin trial expired"),
    });
    const before = webMcpMirrorDiagnostics();
    const unbind = bindWebMcpTools([probeEntry("mirror_probe.rejected")]);
    expect(() => unbind()).not.toThrow();
    await vi.waitFor(() =>
      expect(webMcpMirrorDiagnostics().failures).toBe(before.failures + 1),
    );
    expect(webMcpMirrorDiagnostics().attempts).toBe(before.attempts + 1);
  });

  it("stringifies the executed result as the spec's DOMString", async () => {
    const fake = installFakeModelContext();
    const unbind = bindWebMcpTools([probeEntry("mirror_probe.execute")]);
    await vi.waitFor(() => expect(fake.registrations).toHaveLength(1));
    const tool = fake.registrations[0]?.tool;
    if (tool === undefined) throw new Error("no registration");
    const result = await tool.execute(
      { id: "abc" },
      { signal: new AbortController().signal },
    );
    expect(result).toBe('{"echo":"abc","ok":true}');
    unbind();
  });

  it("aborts the registration signals on unbind (the spec's unregister)", async () => {
    const fake = installFakeModelContext();
    const unbind = bindWebMcpTools([
      probeEntry("mirror_probe.abort_one"),
      probeEntry("mirror_probe.abort_two"),
    ]);
    await vi.waitFor(() => expect(fake.registrations).toHaveLength(2));
    unbind();
    for (const registration of fake.registrations) {
      expect(registration.options?.signal?.aborted).toBe(true);
    }
    expect(webMcpToolNames()).toEqual([]);
  });
});
