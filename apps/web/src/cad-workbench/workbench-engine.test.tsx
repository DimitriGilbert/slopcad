/**
 * The workbench engine's page-level derivations:
 *
 * - the stale rollback-marker clamp (the review fix for the wedge): when
 *   the document regresses past the feature a marker anchors — here an
 *   undo removes the anchored feature — the regeneration pass must clear
 *   the marker and run the FULL timeline instead of hard-failing every
 *   future pass on the dead anchor (which would wedge the loop, the
 *   timeline surface, and the only marker-clearing control);
 * - the worker-verdict → timeline-status mapping (Phase 38 capability
 *   honesty): a refused scene dispatch (Manifold's sweep
 *   `kernel/unsupported-operation`) must read Failed on the owning
 *   feature's chip, recover on a successful re-drive, and map onto
 *   nothing once the feature is gone.
 *
 * The engine's worker session is stubbed: the derivations under test live
 * in the regeneration join, which is pure document data — the boot's
 * verdict callback is captured so the tests can drive outcomes through the
 * same seam the real session reports on.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import {
  createBodyId,
  createDatumId,
  createFeatureId,
} from "@slopcad/cad-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneDispatchOutcome } from "../render-fixture/fixture-session";

/** The last boot's captured options — the verdict seam under test. */
const bootedOptions: {
  onSceneOutcome?: (outcome: SceneDispatchOutcome) => void;
} = {};

vi.mock("../render-fixture/fixture-session", () => ({
  bootRenderFixtureSession: (
    _targets: unknown,
    _onApplied: unknown,
    options?: {
      onSceneOutcome?: (outcome: SceneDispatchOutcome) => void;
    },
  ): {
    dispatch(): void;
    dispatchExtrude(): void;
    dispatchRevolve(): void;
    dispatchSweep(): void;
    dispatchLoft(): void;
    dispatchHole(): void;
    dispose(): void;
  } => {
    bootedOptions.onSceneOutcome = options?.onSceneOutcome;
    return {
      dispatch: () => {},
      dispatchExtrude: () => {},
      dispatchRevolve: () => {},
      dispatchSweep: () => {},
      dispatchLoft: () => {},
      dispatchHole: () => {},
      dispose: () => {},
    };
  },
  faceAnchorSurface: (): string => "[]",
}));

import { useWorkbenchEngine, WorkbenchStoreProvider } from "./workbench-engine";

afterEach(cleanup);

const PROBE_FEATURE = createFeatureId("feat_probe");
const PROBE_BODY = createBodyId("body_probe");
const AXIS_DATUM = createDatumId("dtm_engine_axis");
const PLANE_DATUM = createDatumId("dtm_engine_plane");

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
        data-datums={engine.datumsJson}
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
        data-timeline-statuses={
          engine.timeline === null
            ? "none"
            : engine.timeline
                .map((entry) => `${String(entry.id)}=${entry.status}`)
                .join(",")
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
      <button
        type="button"
        data-testid="add-datums"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              {
                type: "datum.create",
                id: AXIS_DATUM,
                name: "bore axis",
                datum: {
                  formatVersion: 1,
                  datumType: "axis",
                  definition: "twoPoints",
                  first: [0, 0, 0],
                  second: [0, 0, 10],
                },
              },
              {
                type: "datum.create",
                id: PLANE_DATUM,
                name: "ground plane",
                datum: {
                  formatVersion: 1,
                  datumType: "plane",
                  definition: "originFrame",
                  origin: [0, 0, 0],
                  normal: [0, 0, 1],
                  xAxis: [1, 0, 0],
                },
              },
            ],
          });
          if (!applied.ok) {
            throw new Error("the datum commits were refused");
          }
        }}
      >
        add datums
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

  it("maps a refused worker build onto the feature's timeline status and recovers on success", async () => {
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    const statuses = (): string =>
      surface().getAttribute("data-timeline-statuses") ?? "";

    // A committed feature reads valid from the document-data executor.
    fireEvent.click(screen.getByTestId("add-probe-feature"));
    await waitFor(() => {
      expect(statuses()).toContain("feat_probe=valid");
    });

    // The worker declines the build (Manifold's sweep refusal, verbatim):
    // the chip must read failed — never valid beside the error surface.
    const refusal =
      "worker/operation-failed [kernel/unsupported-operation]: The Manifold kernel cannot sweep a profile along a path.";
    expect(bootedOptions.onSceneOutcome).toBeDefined();
    bootedOptions.onSceneOutcome?.({
      ok: false,
      scene: "sweep",
      bodyId: PROBE_BODY,
      text: refusal,
    });
    await waitFor(() => {
      expect(statuses()).toContain("feat_probe=failed");
    });
    // The refusal rides as the chip's diagnostic (the timeline entry JSON).
    expect(statuses()).not.toContain("feat_probe=valid");

    // A successful re-drive clears the verdict: the chip recovers.
    bootedOptions.onSceneOutcome?.({
      ok: true,
      scene: "sweep",
      bodyId: PROBE_BODY,
    });
    await waitFor(() => {
      expect(statuses()).toContain("feat_probe=valid");
    });

    // A refusal for a body the document no longer declares (an undo
    // removed the feature) maps onto nothing — no phantom failures, and
    // the surviving timeline stays untouched.
    fireEvent.click(screen.getByTestId("undo"));
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).not.toContain(
        "feat_probe",
      );
    });
    bootedOptions.onSceneOutcome?.({
      ok: false,
      scene: "sweep",
      bodyId: PROBE_BODY,
      text: refusal,
    });
    expect(surface().getAttribute("data-timeline")).not.toContain("feat_probe");
    expect(statuses()).toContain("feat_translate_plate=valid");
    expect(statuses()).toContain("feat_rotate_plate=valid");
  });
});

describe("the datums machine surface's per-kind semantics", () => {
  it("reports a healthy axis datum as kind-marked non-applicable, not a failed plane", async () => {
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    expect(surface().getAttribute("data-datums")).toBe("[]");

    fireEvent.click(screen.getByTestId("add-datums"));
    type DatumEntry = {
      readonly kind?: string;
      readonly resolved?: boolean | null;
      readonly code?: string;
    };
    const entries = await waitFor(() => {
      const parsed = JSON.parse(
        surface().getAttribute("data-datums") ?? "[]",
      ) as DatumEntry[];
      expect(parsed).toHaveLength(2);
      return parsed;
    });

    // The plane resolves: boolean `resolved` with geometry, as before.
    const plane = entries.find((entry) => entry.kind === "plane");
    expect(plane?.resolved).toBe(true);
    expect(plane?.code).toBeUndefined();

    // The axis is NOT a failed plane resolution: the surface is plane-only,
    // so a healthy axis datum reports its kind and a null applicability —
    // no `session/datum-not-a-plane` failure for geometry that is fine.
    const axis = entries.find((entry) => entry.kind === "axis");
    expect(axis).toBeDefined();
    expect(axis?.resolved).toBeNull();
    expect(axis?.code).toBeUndefined();
  });
});
