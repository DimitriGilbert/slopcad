/**
 * The React binding's lifecycle contract: mount registers the entries in
 * the internal registry (and serves them through the window test seam),
 * unmount unregisters them, the binding is safe without a DOM, and the
 * window seam stays assertable without the real Chrome API.
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
  webMcpToolSnapshot,
} from "./registry";
import { bindWebMcpTools, useWebMcpTools } from "./use-webmcp-tools";

/** One registrable entry for the lifecycle assertions. */
function probeEntry(name: string) {
  return defineWebMcpTool({
    description: `The ${name} probe tool.`,
    inputSchema: z.object({}),
    name,
    execute: () => ({ ok: true }),
  });
}

/** The minimal host: mounts the hook with a stable entries array. */
function Harness({
  entries,
}: {
  readonly entries: readonly ReturnType<typeof probeEntry>[];
}): ReactElement {
  useWebMcpTools(entries);
  return <div data-testid="webmcp-harness" />;
}

/** Unregisters whatever a test left behind (the registry is module-global). */
afterEach(() => {
  cleanup();
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
  vi.unstubAllGlobals();
});

describe("useWebMcpTools", () => {
  it("registers the entries after mount (never during render)", () => {
    const entries = [probeEntry("lifecycle_probe.mounted")];
    let sawDuringRender: readonly string[] | null = null;
    function RenderProbe(): ReactElement {
      sawDuringRender = [...webMcpToolNames()];
      return <Harness entries={entries} />;
    }
    render(<RenderProbe />);
    // Registration is an effect concern: the first render saw nothing.
    expect(sawDuringRender).toEqual([]);
    expect(webMcpToolNames()).toEqual(["lifecycle_probe.mounted"]);
  });

  it("unregisters the entries on unmount", () => {
    const entries = [probeEntry("lifecycle_probe.unmount")];
    const { unmount } = render(<Harness entries={entries} />);
    expect(webMcpToolNames()).toEqual(["lifecycle_probe.unmount"]);
    unmount();
    expect(webMcpToolNames()).toEqual([]);
  });

  it("serves the window seam without the real API", () => {
    const entries = [
      probeEntry("lifecycle_probe.window_one"),
      probeEntry("lifecycle_probe.window_two"),
    ];
    const { unmount } = render(<Harness entries={entries} />);
    const seam = window.__slopcadWebMcpTools;
    expect(typeof seam).toBe("function");
    expect(seam?.().map((tool) => tool.name)).toEqual([
      "lifecycle_probe.window_one",
      "lifecycle_probe.window_two",
    ]);
    // The seam reads the LIVE registry: after unmount it serves the truth.
    unmount();
    expect(window.__slopcadWebMcpTools?.()).toEqual([]);
  });

  it("installs the window seam once, not per binding", () => {
    const first = render(
      <Harness entries={[probeEntry("lifecycle_probe.seam_one")]} />,
    );
    const seamAfterFirst = window.__slopcadWebMcpTools;
    const second = render(
      <Harness entries={[probeEntry("lifecycle_probe.seam_two")]} />,
    );
    expect(window.__slopcadWebMcpTools).toBe(seamAfterFirst);
    first.unmount();
    second.unmount();
    expect(window.__slopcadWebMcpTools).toBe(seamAfterFirst);
  });
});

describe("bindWebMcpTools without a DOM", () => {
  it("still populates the registry and cleans up (the SSR-safe path)", () => {
    vi.stubGlobal("document", undefined);
    const entries = [probeEntry("lifecycle_probe.no_dom")];
    const unbind = bindWebMcpTools(entries);
    expect(webMcpToolNames()).toEqual(["lifecycle_probe.no_dom"]);
    expect(webMcpToolSnapshot()).toHaveLength(1);
    expect(() => unbind()).not.toThrow();
    expect(webMcpToolNames()).toEqual([]);
  });
});
