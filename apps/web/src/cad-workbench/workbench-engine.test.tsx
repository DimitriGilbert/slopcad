/**
 * The workbench engine's stale rollback-marker clamp (the review fix for
 * the wedge): when the document regresses past the feature a marker
 * anchors — here an undo removes the anchored feature — the regeneration
 * pass must clear the marker and run the FULL timeline instead of
 * hard-failing every future pass on the dead anchor (which would wedge the
 * loop, the timeline surface, and the only marker-clearing control).
 *
 * The engine's worker session is stubbed: the clamp under test lives in
 * the regeneration derivation, which is pure document data — the boot and
 * dispatch plumbing are not under test here.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { createBodyId, createFeatureId } from "@slopcad/cad-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../render-fixture/fixture-session", () => ({
  bootRenderFixtureSession: (): {
    dispatch(): void;
    dispatchExtrude(): void;
    dispatchRevolve(): void;
    dispatchHole(): void;
    dispose(): void;
  } => ({
    dispatch: () => {},
    dispatchExtrude: () => {},
    dispatchRevolve: () => {},
    dispatchHole: () => {},
    dispose: () => {},
  }),
  faceAnchorSurface: (): string => "[]",
}));

import { useWorkbenchEngine, WorkbenchStoreProvider } from "./workbench-engine";

afterEach(cleanup);

const PROBE_FEATURE = createFeatureId("feat_probe");
const PROBE_BODY = createBodyId("body_probe");

function EngineHarness(): ReactElement {
  const engine = useWorkbenchEngine({
    rootId: "engine-test-root",
    statusId: "engine-test-status",
    volumeId: "engine-test-volume",
    errorId: "engine-test-error",
  });
  return (
    <div>
      <div
        data-testid="engine-surface"
        data-rollback={
          engine.rollback === null
            ? "none"
            : String(engine.rollback.afterFeatureId)
        }
        data-issue={engine.regenerationIssue ?? "none"}
        data-timeline={
          engine.timeline === null
            ? "none"
            : engine.timeline.map((entry) => String(entry.id)).join(",")
        }
      />
      <button
        type="button"
        data-testid="add-probe-feature"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              { type: "body.create", id: PROBE_BODY, name: "probe" },
              {
                type: "feature.create",
                id: PROBE_FEATURE,
                kind: "box",
                inputs: [],
                outputs: [PROBE_BODY],
              },
            ],
          });
          if (!applied.ok) {
            throw new Error("the probe feature commit was refused");
          }
        }}
      >
        add probe feature
      </button>
      <button
        type="button"
        data-testid="set-marker"
        onClick={() => {
          engine.setRollback({ afterFeatureId: PROBE_FEATURE });
        }}
      >
        set marker
      </button>
      <button
        type="button"
        data-testid="undo"
        onClick={() => {
          const undone = engine.historyApi.undo();
          if (!undone.ok) {
            throw new Error("the undo was refused");
          }
        }}
      >
        undo
      </button>
    </div>
  );
}

describe("the workbench engine's stale rollback-marker clamp", () => {
  it("clears a marker whose anchored feature an undo removed and keeps regenerating", async () => {
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");

    // Boot: the fixture document's two-feature timeline renders clean.
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).toContain(
        "feat_translate_plate",
      );
      expect(surface().getAttribute("data-timeline")).toContain(
        "feat_rotate_plate",
      );
      expect(surface().getAttribute("data-issue")).toBe("none");
    });

    // Commit a probe feature, then park the timeline right after it — the
    // valid-marker control: parking applies, regeneration stays green.
    fireEvent.click(screen.getByTestId("add-probe-feature"));
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).toContain("feat_probe");
    });
    fireEvent.click(screen.getByTestId("set-marker"));
    await waitFor(() => {
      expect(surface().getAttribute("data-rollback")).toBe("feat_probe");
    });
    expect(surface().getAttribute("data-issue")).toBe("none");

    // Undo removes the anchored feature: the marker auto-clears and the
    // regeneration succeeds over the reverted full timeline instead of
    // wedging on the dead anchor (issue text, no timeline, marker stuck).
    fireEvent.click(screen.getByTestId("undo"));
    await waitFor(() => {
      expect(surface().getAttribute("data-rollback")).toBe("none");
    });
    expect(surface().getAttribute("data-issue")).toBe("none");
    const timeline = surface().getAttribute("data-timeline");
    expect(timeline).not.toBe("none");
    expect(timeline).toContain("feat_translate_plate");
    expect(timeline).toContain("feat_rotate_plate");
    expect(timeline).not.toContain("feat_probe");
  });
});
