// @vitest-environment node
import { describe, expect, it } from "vitest";

import { inspectorRailPanelsClassName } from "./workbench-inspector-rail";

/**
 * The view-switch restore semantics (D16), as the rail's pure wiring:
 * while the chat is active the panels column is HIDDEN (`display:none` —
 * the mounted tree and all its state survive), never unmounted; the chat
 * view is the side that mounts/unmounts, restoring through the
 * persistence store. The class mapping is the load-bearing half — a
 * conditional-render mapping would read `null`, not `"hidden"`.
 */
describe("inspectorRailPanelsClassName (D16 restore semantics)", () => {
  it("keeps the panels column displayed in the sidebar view", () => {
    expect(inspectorRailPanelsClassName("sidebar")).toBe("flex");
  });

  it("hides (never unmounts) the panels column while chat is active", () => {
    expect(inspectorRailPanelsClassName("chat")).toBe("hidden");
  });

  it("answers one of exactly the two display classes", () => {
    for (const view of ["sidebar", "chat"] as const) {
      expect(["flex", "hidden"]).toContain(inspectorRailPanelsClassName(view));
    }
  });
});
