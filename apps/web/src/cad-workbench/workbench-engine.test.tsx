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
  angle,
  createBodyId,
  createDatumId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  length,
  parseExpression,
  printExpression,
  type FeatureRecord,
  type ParameterCollection,
} from "@slopcad/cad-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLineEntity,
  createRectangleEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import type { SceneDispatchOutcome } from "../render-fixture/fixture-session";

/** The last boot's captured options — the verdict seam under test. */
const bootedOptions: {
  onSceneOutcome?: (outcome: SceneDispatchOutcome) => void;
} = {};

/** The session dispatches the stub recorded, in order — the plate-vs-
 * document decision's seam (the plate fallback regression pin). */
const dispatchCalls: { readonly method: string }[] = [];

vi.mock("../render-fixture/fixture-session", () => ({
  bootRenderFixtureSession: (
    _targets: unknown,
    _onApplied: unknown,
    options?: {
      onSceneOutcome?: (outcome: SceneDispatchOutcome) => void;
    },
  ): {
    dispatch(): void;
    dispatchDocument(): void;
    dispatchExtrude(): void;
    dispatchRevolve(): void;
    dispatchSweep(): void;
    dispatchLoft(): void;
    dispatchHole(): void;
    dispose(): void;
  } => {
    bootedOptions.onSceneOutcome = options?.onSceneOutcome;
    return {
      dispatch: () => {
        dispatchCalls.push({ method: "dispatch" });
      },
      dispatchDocument: () => {
        dispatchCalls.push({ method: "dispatchDocument" });
      },
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

import {
  useWorkbenchEngine,
  WorkbenchStoreProvider,
  type FeatureFormOutcome,
} from "./workbench-engine";
import { CURVE_DEFAULTS } from "./curves";

afterEach(cleanup);

/** The last malformed-curve refusal the bad-curve button captured. */
let lastRefusal: string | null = null;

/** The Phase 21 draft-by-reference fixtures' parameter ids. */
const REF_HEIGHT_PARAM = createParameterId("param_engine_case_height");
const REF_ANGLE_PARAM = createParameterId("param_engine_case_angle");

/** What a draft button captured: the outcome plus the post-commit facts. */
interface DraftProbe {
  readonly ok: boolean;
  readonly refusal: string | null;
  /** The last feature's inputs (the draft feature, just committed). */
  readonly inputs: readonly { readonly kind: string; readonly id: string }[];
  /** The document's parameter names after the commit. */
  readonly parameterNames: readonly string[];
  /** The document's parameters (name → canonical magnitude in mm). */
  readonly parameterMm: Readonly<Record<string, number>>;
  /** The document's parameters (name → printed expression, `null` literal). */
  readonly parameterExpressions: Readonly<Record<string, string | null>>;
}

/** The last draft probe (the Phase 21 tests' capture seam). */
let lastDraft: DraftProbe | null = null;

/** The last seed transaction's refusal (the fixture seam's own honesty). */
let lastSeedRefusal: string | null = null;

/** The captured probe, or a thrown test failure when the click never landed. */
function draftProbe(): DraftProbe {
  if (lastDraft === null) throw new Error("the draft probe is absent");
  return lastDraft;
}

/** Captures the post-commit document facts a draft button asserts on. */
function draftProbeOf(
  doc: {
    readonly parameters: ParameterCollection;
    readonly features: readonly FeatureRecord[];
  },
  outcome: FeatureFormOutcome,
): DraftProbe {
  const parameterMm: Record<string, number> = {};
  const parameterExpressions: Record<string, string | null> = {};
  for (const parameter of doc.parameters.parameters) {
    parameterMm[parameter.name] = parameter.value.value;
    parameterExpressions[parameter.name] =
      parameter.expression === null
        ? null
        : printExpression(parameter.expression);
  }
  return {
    ok: outcome.ok,
    refusal: outcome.ok ? null : `${outcome.code}: ${outcome.message}`,
    inputs: doc.features.at(-1)?.inputs ?? [],
    parameterNames: doc.parameters.parameters.map(
      (parameter) => parameter.name,
    ),
    parameterMm,
    parameterExpressions,
  };
}

const PROBE_FEATURE = createFeatureId("feat_probe");
const PROBE_BODY = createBodyId("body_probe");
const AXIS_DATUM = createDatumId("dtm_engine_axis");
const PLANE_DATUM = createDatumId("dtm_engine_plane");
const EXTRUDE_SKETCH = createSketchDocumentId("skd_engine_extrude");
const EXTRUDE_DEPTH = createParameterId("param_engine_depth");
const EXTRUDE_FEATURE = createFeatureId("feat_engine_extrude");
const EXTRUDE_BODY = createBodyId("body_engine_extrude");

/** A serialized 20×15 rectangle on the XY workplane (the extrude profile). */
function extrudeSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_engine-bottom");
  const right = createSketchEntityId("skent_engine-right");
  const top = createSketchEntityId("skent_engine-top");
  const left = createSketchEntityId("skent_engine-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
      createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
      createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
      createRectangleEntity(createSketchEntityId("skent_engine-rect"), [
        bottom,
        right,
        top,
        left,
      ]),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

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
        data-curves={engine.curvesJson}
        data-scene={engine.activeScene}
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
        data-testid="add-extrude"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              {
                type: "parameter.create",
                id: EXTRUDE_DEPTH,
                name: "engineDepth",
                value: length(10),
              },
              {
                type: "sketch.create",
                id: EXTRUDE_SKETCH,
                name: "engine profile",
                sketch: extrudeSketchPayload(),
              },
              { type: "body.create", id: EXTRUDE_BODY, name: "engine pad" },
              {
                type: "feature.create",
                id: EXTRUDE_FEATURE,
                kind: "extrude",
                inputs: [
                  { kind: "sketch", id: EXTRUDE_SKETCH },
                  { kind: "parameter", id: EXTRUDE_DEPTH },
                ],
                outputs: [EXTRUDE_BODY],
              },
            ],
          });
          if (!applied.ok) {
            throw new Error("the extrude commit was refused");
          }
        }}
      >
        add extrude
      </button>
      <button
        type="button"
        data-testid="hide-all-bodies"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: engine.documentApi.document.bodies.map((body) => ({
              type: "body.update" as const,
              id: body.id,
              visible: false,
            })),
          });
          if (!applied.ok) {
            throw new Error("the hide-all commit was refused");
          }
        }}
      >
        hide all bodies
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
        data-testid="redo"
        onClick={() => {
          const redone = engine.historyApi.redo();
          if (!redone.ok) {
            throw new Error("the redo was refused");
          }
        }}
      >
        redo
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
      <button
        type="button"
        data-testid="create-curve"
        onClick={() => {
          const outcome = engine.handleCreateCurve({
            ...CURVE_DEFAULTS,
            name: "spine guide",
          });
          if (!outcome.ok) {
            throw new Error(`the curve commit was refused: ${outcome.code}`);
          }
        }}
      >
        create curve
      </button>
      <button
        type="button"
        data-testid="create-bad-curve"
        onClick={() => {
          const outcome = engine.handleCreateCurve({
            ...CURVE_DEFAULTS,
            pointsText: "0, 0, 0\nnope, 1, 2",
          });
          if (outcome.ok) {
            throw new Error("the malformed curve authoring must refuse");
          }
          lastRefusal = `${outcome.code}: ${outcome.message}`;
        }}
      >
        create bad curve
      </button>
      <button
        type="button"
        data-testid="seed-draft-fixtures"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              {
                type: "parameter.create",
                id: REF_HEIGHT_PARAM,
                name: "engineCaseHeight",
                value: length(7),
              },
              {
                type: "parameter.create",
                id: REF_ANGLE_PARAM,
                name: "engineCaseAngle",
                value: angle(0.1),
              },
              {
                type: "sketch.create",
                id: createSketchDocumentId("skd_engine_ref1"),
                name: "reference profile",
                sketch: extrudeSketchPayload(),
              },
              {
                type: "sketch.create",
                id: createSketchDocumentId("skd_engine_ref2"),
                name: "literal profile",
                sketch: extrudeSketchPayload(),
              },
            ],
          });
          lastSeedRefusal = applied.ok
            ? null
            : `${applied.error.code}: ${applied.error.message}`;
        }}
      >
        seed draft fixtures
      </button>
      <button
        type="button"
        data-testid="draft-by-reference"
        onClick={() => {
          const outcome = engine.handleDraft({
            sketchId: "skd_engine_ref1",
            distanceMm: "$engineCaseHeight",
            taperDeg: 0,
          });
          // The STORE's live getter: the hook's snapshot is one commit
          // stale inside the click's own event (React has not re-rendered
          // since this very transaction).
          lastDraft = draftProbeOf(engine.store.getDocument(), outcome);
        }}
      >
        draft by reference
      </button>
      <button
        type="button"
        data-testid="draft-literal"
        onClick={() => {
          const outcome = engine.handleDraft({
            sketchId: "skd_engine_ref2",
            distanceMm: 4,
            taperDeg: 0,
          });
          lastDraft = draftProbeOf(engine.store.getDocument(), outcome);
        }}
      >
        draft literal
      </button>
      <button
        type="button"
        data-testid="draft-unknown-ref"
        onClick={() => {
          const outcome = engine.handleDraft({
            sketchId: "skd_engine_ref1",
            distanceMm: "$engineMissing",
            taperDeg: 0,
          });
          lastDraft = {
            ok: outcome.ok,
            refusal: outcome.ok ? null : `${outcome.code}: ${outcome.message}`,
            inputs: [],
            parameterNames: [],
            parameterMm: {},
            parameterExpressions: {},
          };
        }}
      >
        draft unknown ref
      </button>
      <button
        type="button"
        data-testid="draft-wrong-dimension"
        onClick={() => {
          const outcome = engine.handleDraft({
            sketchId: "skd_engine_ref1",
            distanceMm: "$engineCaseAngle",
            taperDeg: 0,
          });
          lastDraft = {
            ok: outcome.ok,
            refusal: outcome.ok ? null : `${outcome.code}: ${outcome.message}`,
            inputs: [],
            parameterNames: [],
            parameterMm: {},
            parameterExpressions: {},
          };
        }}
      >
        draft wrong dimension
      </button>
      <button
        type="button"
        data-testid="draft-negated-ref"
        onClick={() => {
          const outcome = engine.handleDraft({
            sketchId: "skd_engine_ref1",
            distanceMm: "-$engineCaseHeight",
            taperDeg: 0,
          });
          // The STORE's live getter, as the plain reference's button uses.
          lastDraft = draftProbeOf(engine.store.getDocument(), outcome);
        }}
      >
        draft negated ref
      </button>
      <button
        type="button"
        data-testid="redrive-negated-source"
        onClick={() => {
          // The user's later edit of the source variable through the
          // EXPRESSION arm (a constant with the unit attached — the unit
          // literal keeps the parameter's dimension): the commit that runs
          // the topological recompute — the value-only arm moves the
          // source's cache and leaves driven caches stale.
          const parsed = parseExpression("9mm");
          if (!parsed.ok) throw new Error("the fixture expression rejected");
          const applied = engine.documentApi.applyTransaction({
            commands: [
              {
                type: "parameter.set" as const,
                id: REF_HEIGHT_PARAM,
                expression: parsed.value,
              },
            ],
          });
          if (!applied.ok) {
            throw new Error("the source edit was refused");
          }
          lastDraft = draftProbeOf(engine.store.getDocument(), { ok: true });
        }}
      >
        redrive negated source
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

describe("the scene dispatch's plate fallback", () => {
  it("keeps the document dispatch for an all-hidden scene — the plate never re-materializes", async () => {
    dispatchCalls.length = 0;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");

    // Boot: the featureless plate document has no resolved scene, so the
    // dedicated plate dispatch fires (its authored camera the baselines pin).
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).toContain(
        "feat_translate_plate",
      );
    });
    expect(dispatchCalls.at(-1)?.method).toBe("dispatch");

    // A real extrude resolves a document scene: the boot plate rides it as
    // one body beside the extrude (the document dispatch takes over).
    fireEvent.click(screen.getByTestId("add-extrude"));
    const documentDispatches = (): number =>
      dispatchCalls.filter((call) => call.method === "dispatchDocument").length;
    await waitFor(() => {
      expect(documentDispatches()).toBeGreaterThan(0);
    });
    const firstDocumentDispatch = dispatchCalls.length - 1;

    // Hiding EVERY body must keep the document dispatch — the emptiness
    // decision is pre-display-filter, so "the user hid everything" never
    // re-materializes the fixture plate. The computation renders the
    // honest empty scene; the engine's part of that contract is this seam.
    const beforeHide = dispatchCalls.length;
    fireEvent.click(screen.getByTestId("hide-all-bodies"));
    await waitFor(() => {
      expect(dispatchCalls.length).toBeGreaterThan(beforeHide);
      expect(dispatchCalls.at(-1)?.method).toBe("dispatchDocument");
    });
    const sinceExtrude = dispatchCalls.slice(firstDocumentDispatch);
    expect(
      sinceExtrude.every((call) => call.method === "dispatchDocument"),
    ).toBe(true);
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

describe("the curve creation action (Phase 47)", () => {
  it("commits a curve record, renders it on the curves scene, and persists through undo/redo", async () => {
    lastRefusal = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    expect(surface().getAttribute("data-curves")).toBe("[]");

    // The form's defaults (an interpolated spline) commit through the
    // engine's creation action and switch the scene to the curves surface.
    fireEvent.click(screen.getByTestId("create-curve"));
    type CurveEntry = {
      readonly id?: string;
      readonly kind?: string;
      readonly name?: string;
      readonly segments?: number;
    };
    const entry = await waitFor(() => {
      const parsed = JSON.parse(
        surface().getAttribute("data-curves") ?? "[]",
      ) as CurveEntry[];
      expect(parsed).toHaveLength(1);
      return parsed[0] as CurveEntry;
    });
    expect(entry.kind).toBe("interpolated-spline");
    expect(entry.name).toBe("spine guide");
    expect(entry.segments).toBeGreaterThan(2);
    expect(surface().getAttribute("data-scene")).toBe("curves");

    // Undo removes the record (the transaction rides the history) and the
    // curves scene falls back; redo restores it — the persistence journey
    // the e2e drives.
    fireEvent.click(screen.getByTestId("undo"));
    await waitFor(() => {
      expect(surface().getAttribute("data-curves")).toBe("[]");
    });
    const restored = await waitFor(() => {
      fireEvent.click(screen.getByTestId("redo"));
      const parsed = JSON.parse(
        surface().getAttribute("data-curves") ?? "[]",
      ) as CurveEntry[];
      expect(parsed).toHaveLength(1);
      return parsed[0] as CurveEntry;
    });
    expect(restored.id).toBe(entry.id);
  });

  it("refuses malformed authoring structurally and commits nothing", async () => {
    lastRefusal = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    expect(surface().getAttribute("data-curves")).toBe("[]");

    fireEvent.click(screen.getByTestId("create-bad-curve"));
    await waitFor(() => {
      expect(lastRefusal).not.toBeNull();
    });
    expect(lastRefusal).toContain("workbench/curve-invalid");
    // Nothing committed: the machine surface stays empty.
    expect(surface().getAttribute("data-curves")).toBe("[]");
  });
});

describe("the draft action's $name parameter references (Phase 21)", () => {
  it("commits a reference to the EXISTING parameter and creates no literal for the role", async () => {
    lastDraft = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-draft-fixtures"));
    await waitFor(() => {
      expect(lastSeedRefusal).toBeNull();
    });
    fireEvent.click(screen.getByTestId("draft-by-reference"));
    await waitFor(() => {
      expect(lastDraft).not.toBeNull();
    });
    const draft = draftProbe();
    expect(draft.ok).toBe(true);
    // The distance input references the EXISTING parameter by its id, and
    // no `extrudeDepth1` literal was created for the role.
    expect(draft.inputs[0]).toEqual({
      kind: "sketch",
      id: createSketchDocumentId("skd_engine_ref1"),
    });
    expect(draft.inputs[1]).toEqual({
      kind: "parameter",
      id: REF_HEIGHT_PARAM,
    });
    // The literal taper still creates its own parameter (mixed reference +
    // literal in ONE submission).
    expect(draft.parameterNames).toContain("engineCaseHeight");
    expect(draft.parameterNames).toContain("extrudeTaper1");
    expect(draft.parameterNames).not.toContain("extrudeDepth1");
    expect(draft.parameterMm["engineCaseHeight"]).toBe(7);
  });

  it("keeps literal submissions byte-identical: both parameters created, values verbatim", async () => {
    lastDraft = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-draft-fixtures"));
    await waitFor(() => {
      expect(lastSeedRefusal).toBeNull();
    });
    fireEvent.click(screen.getByTestId("draft-literal"));
    await waitFor(() => {
      expect(lastDraft).not.toBeNull();
    });
    const draft = draftProbe();
    expect(draft.ok).toBe(true);
    expect(draft.parameterNames).toContain("extrudeDepth1");
    expect(draft.parameterNames).toContain("extrudeTaper1");
    // The literal magnitudes: 4 mm depth, a 0 rad taper.
    expect(draft.parameterMm["extrudeDepth1"]).toBe(4);
    expect(draft.parameterMm["extrudeTaper1"]).toBe(0);
    // Both feature inputs point at the freshly created literal parameters.
    expect(draft.inputs).toHaveLength(3);
    expect(draft.inputs[1]?.kind).toBe("parameter");
    expect(draft.inputs[2]?.kind).toBe("parameter");
  });

  it("refuses an unknown $name structurally before any commit", async () => {
    lastDraft = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-draft-fixtures"));
    await waitFor(() => {
      expect(lastSeedRefusal).toBeNull();
    });
    fireEvent.click(screen.getByTestId("draft-unknown-ref"));
    await waitFor(() => {
      expect(lastDraft).not.toBeNull();
    });
    const draft = draftProbe();
    expect(draft.ok).toBe(false);
    expect(draft.refusal).toContain("kernel/parameter-invalid");
    expect(draft.refusal).toContain('"engineMissing"');
  });

  it("refuses a reference whose parameter carries the wrong dimension", async () => {
    lastDraft = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-draft-fixtures"));
    await waitFor(() => {
      expect(lastSeedRefusal).toBeNull();
    });
    fireEvent.click(screen.getByTestId("draft-wrong-dimension"));
    await waitFor(() => {
      expect(lastDraft).not.toBeNull();
    });
    const draft = draftProbe();
    expect(draft.ok).toBe(false);
    expect(draft.refusal).toContain("kernel/parameter-invalid");
    expect(draft.refusal).toContain('"engineCaseAngle"');
    expect(draft.refusal).toContain("angle");
    expect(draft.refusal).toContain("length");
  });

  it("emits a negated reference as an auto-parameter carrying the -name expression", async () => {
    lastDraft = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-draft-fixtures"));
    await waitFor(() => {
      expect(lastSeedRefusal).toBeNull();
    });
    fireEvent.click(screen.getByTestId("draft-negated-ref"));
    await waitFor(() => {
      expect(lastDraft).not.toBeNull();
    });
    const draft = draftProbe();
    expect(draft.ok).toBe(true);
    // The sign cannot ride a plain reference (the input reads the
    // parameter's VALUE), so the distance input points at the FRESH
    // auto-parameter, never at the source.
    expect(draft.inputs[1]).toEqual({
      kind: "parameter",
      id: "param_extrude_depth1",
    });
    expect(draft.inputs[1]).not.toEqual({
      kind: "parameter",
      id: REF_HEIGHT_PARAM,
    });
    // The auto-parameter carries the negated cache (−7) and the stored
    // `-engineCaseHeight` expression; the taper literal is unchanged.
    expect(draft.parameterMm["extrudeDepth1"]).toBe(-7);
    expect(draft.parameterExpressions["extrudeDepth1"]).toBe(
      "-engineCaseHeight",
    );
    expect(draft.parameterMm["extrudeTaper1"]).toBe(0);
  });

  it("re-drives the negated auto-parameter when the source variable is edited", async () => {
    lastDraft = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-draft-fixtures"));
    await waitFor(() => {
      expect(lastSeedRefusal).toBeNull();
    });
    fireEvent.click(screen.getByTestId("draft-negated-ref"));
    await waitFor(() => {
      expect(lastDraft).not.toBeNull();
    });
    expect(draftProbe().parameterMm["extrudeDepth1"]).toBe(-7);
    // The source's literal edit (7 → 9) re-derives the negated cache
    // through the expression DAG — the re-drive the feature rides.
    fireEvent.click(screen.getByTestId("redrive-negated-source"));
    await waitFor(() => {
      expect(draftProbe().parameterMm["extrudeDepth1"]).toBe(-9);
    });
    expect(draftProbe().parameterMm["engineCaseHeight"]).toBe(9);
    expect(draftProbe().parameterExpressions["extrudeDepth1"]).toBe(
      "-engineCaseHeight",
    );
  });
});
