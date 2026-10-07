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
  act,
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
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createRenderProjection,
  createSketchDocumentId,
  length,
  parseExpression,
  printExpression,
  projectTessellation,
  type CadSession,
  type FeatureRecord,
  type ParameterCollection,
} from "@slopcad/cad-core";
import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  createSession,
} from "@slopcad/cad-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLineEntity,
  createRectangleEntity,
  createSketch,
  createSketchEntityId,
  resolveExtrudeProfile,
  serializeSketch,
  workplaneToPlacement,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import type {
  FixtureRenderState,
  SceneDispatchOutcome,
} from "../render-fixture/fixture-session";
import type { SketchExtrudeSubmission } from "./SketchMode";

import { kernelSegment } from "./extrude";
import {
  useWorkbenchEngine,
  WorkbenchStoreProvider,
  type FeatureFormOutcome,
} from "./workbench-engine";
import { CURVE_DEFAULTS } from "./curves";

/** The last boot's captured options — the verdict and settle seams. */
const bootedOptions: {
  onSceneOutcome?: (outcome: SceneDispatchOutcome) => void;
  onApplied?: (state: FixtureRenderState, revision: number) => void;
} = {};

/** The session dispatches the stub recorded, in order — the plate-vs-
 * document decision's seam (the plate fallback regression pin). */
const dispatchCalls: { readonly method: string }[] = [];

vi.mock("../render-fixture/fixture-session", () => ({
  bootRenderFixtureSession: (
    _targets: unknown,
    onApplied: (state: FixtureRenderState, revision: number) => void,
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
    bootedOptions.onApplied = onApplied;
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

/** A 20×15 rectangle on the XY workplane (the extrude profile). */
function rectangleSketch() {
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
  return created.value;
}

/** A serialized 20×15 rectangle on the XY workplane (the extrude profile). */
function extrudeSketchPayload(): Record<string, unknown> {
  return serializeSketch(rectangleSketch()) as unknown as Record<
    string,
    unknown
  >;
}

/**
 * The kernel-vocabulary extrude submission the sketch machine hands the
 * host — resolved from the same rectangle profile the document fixtures
 * use, so the action's committed feature executes.
 */
function engineExtrudeSubmission(): SketchExtrudeSubmission {
  const sketch = rectangleSketch();
  const profile = resolveExtrudeProfile(sketch.entities);
  if (!profile.ok) throw new Error(profile.error.message);
  const placement = workplaneToPlacement(sketch.workplane);
  return {
    sketch: serializeSketch(sketch),
    loop: profile.value.segments.map(kernelSegment),
    placement: {
      rotation: {
        axis: placement.rotation.axis,
        angle: angle(placement.rotation.angleRad, "rad"),
      },
      translation: {
        x: length(placement.translation.x),
        y: length(placement.translation.y),
        z: length(placement.translation.z),
      },
    },
  };
}

// -- The review-fix fixtures (F4 datum zombie, F5 config side-state,
// F6 counter reseed) ------------------------------------------------------

const PLATE_BODY = createBodyId("body_plate");
const ADOPT_SKD = createSketchDocumentId("skd_extrude");
const ADOPT_PARAM = createParameterId("param_extrude_depth");
const ADOPT_BODY = createBodyId("body_extrude");
const ADOPT_FEAT = createFeatureId("feat_extrude");
const HOLE_PARAM = createParameterId("param_hole_diameter");

/** The face the sketch-on-face button addresses (mutable per test). */
let sketchOnFaceTarget: {
  readonly bodyId: string;
  readonly faceIndex: number;
} = { bodyId: "body_plate", faceIndex: 0 };

/** The last sketch-on-face outcome (or null before the first click). */
let lastSketchOnFace:
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }
  | null = null;

/** The last handleExtrude outcome (or null before the first click). */
let lastExtrudeAction: FeatureFormOutcome | null = null;

/** The document's feature ids after the last action click. */
let lastFeatureIds: readonly string[] = [];

/** The last adoption's refusal, if the store rejected the session. */
let lastAdoptionError: string | null = null;

/** The captured sketch-on-face outcome, or a thrown failure when absent. */
function sketchOnFaceOutcome():
  { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (lastSketchOnFace === null) {
    throw new Error("the sketch-on-face outcome is absent");
  }
  return lastSketchOnFace;
}

/** The captured extrude action outcome, or a thrown failure when absent. */
function extrudeActionOutcome(): FeatureFormOutcome {
  if (lastExtrudeAction === null) {
    throw new Error("the extrude action outcome is absent");
  }
  return lastExtrudeAction;
}

/**
 * One box body's two synthetic faces (top at z=10, bottom at z=0) as a
 * triangle soup — the same layout the inspection tests pin: face 0 is the
 * top face with a single +z normal.
 */
function boxSoup(
  x0: number,
  y0: number,
): {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
} {
  return {
    positions: [
      x0,
      y0,
      10,
      x0 + 30,
      y0,
      10,
      x0 + 30,
      y0 + 20,
      10,
      x0,
      y0 + 20,
      10,
      x0,
      y0,
      0,
      x0 + 30,
      y0,
      0,
      x0 + 30,
      y0 + 20,
      0,
      x0,
      y0 + 20,
      0,
    ],
    indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  };
}

/**
 * The fabricated settle the F4 tests drive through the captured
 * `onApplied` seam: the plate body and the extrude pad's boxes under one
 * projection, so the picker resolves faces for both attempts.
 */
function fabricatedSceneState(): FixtureRenderState {
  const plate = boxSoup(0, 0);
  const pad = boxSoup(40, 0);
  const plateObject = projectTessellation(createBodyId("body_plate"), plate);
  if (!plateObject.ok) throw new Error("the plate tessellation refused");
  const padObject = projectTessellation(
    createBodyId("body_engine_extrude"),
    pad,
  );
  if (!padObject.ok) throw new Error("the pad tessellation refused");
  const assembled = createRenderProjection(
    [plateObject.value, padObject.value],
    {
      kind: "perspective",
      position: [80, -80, 80],
      target: [30, 10, 5],
      up: [0, 0, 1],
      fovDeg: 40,
    },
  );
  if (!assembled.ok) throw new Error("the fabricated projection refused");
  return {
    measurement: {
      volume: 12000,
      area: 4400,
      bounds: { min: [0, 0, 0], max: [70, 20, 10] },
      triangles: 4,
      tessellation: plate,
    },
    projection: assembled.value,
  };
}

/** An adopted session whose extrude verb's ids are ALREADY taken. */
function adoptedExtrudeSession(): CadSession {
  const base = createDocument(createDocumentId("doc_adopted"));
  const withBody = addBody(base, { id: ADOPT_BODY, name: "adopted pad" });
  if (!withBody.ok) throw new Error(withBody.error.message);
  const withParam = addDocumentParameter(withBody.value.document, {
    id: ADOPT_PARAM,
    name: "extrudeDepth",
    value: length(10),
  });
  if (!withParam.ok) throw new Error(withParam.error.message);
  const withSketch = addDocumentSketch(withParam.value.document, {
    id: ADOPT_SKD,
    name: "extrude sketch",
    sketch: extrudeSketchPayload(),
  });
  if (!withSketch.ok) throw new Error(withSketch.error.message);
  const withFeature = addFeature(withSketch.value.document, {
    id: ADOPT_FEAT,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: ADOPT_SKD },
      { kind: "parameter", id: ADOPT_PARAM },
    ],
    outputs: [ADOPT_BODY],
  });
  if (!withFeature.ok) throw new Error(withFeature.error.message);
  return createSession(withFeature.value.document);
}

/**
 * An adopted session with NO engine-convention ids but a parameter NAMED
 * `extrudeDepth` — the name the first extrude action mints — so the action's
 * commit genuinely refuses (the parameter name guard) with nothing for the
 * reseed to advance past.
 */
function adoptedConflictingSession(): CadSession {
  const base = createDocument(createDocumentId("doc_conflicting"));
  const withParam = addDocumentParameter(base, {
    id: createParameterId("param_foreign_depth"),
    name: "extrudeDepth",
    value: length(1),
  });
  if (!withParam.ok) throw new Error(withParam.error.message);
  return createSession(withParam.value.document);
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
        data-configs={engine.configurationsJson}
        data-mode={engine.mode}
        data-hole={
          engine.storedHole === null ? "none" : String(engine.storedHole)
        }
        data-plate-visible={String(
          engine.documentApi.document.bodies.find(
            (body) => body.id === PLATE_BODY,
          )?.visible !== false,
        )}
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
        data-testid="sketch-on-face"
        onClick={() => {
          const outcome = engine.handleSketchOnFace({
            kind: "face",
            bodyId: sketchOnFaceTarget.bodyId,
            faceIndex: sketchOnFaceTarget.faceIndex,
          });
          lastSketchOnFace = outcome;
        }}
      >
        sketch on face
      </button>
      <button
        type="button"
        data-testid="seed-config-row"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              {
                type: "configuration.create",
                name: "Row A",
                parameterOverrides: [
                  { parameterId: HOLE_PARAM, value: length(5) },
                ],
              },
            ],
          });
          if (!applied.ok) {
            throw new Error("the configuration row commit was refused");
          }
        }}
      >
        seed config row
      </button>
      <button
        type="button"
        data-testid="apply-config-row"
        onClick={() => {
          const row = engine.documentApi.document.configurations[0];
          if (row === undefined) throw new Error("no configuration row exists");
          engine.applyConfiguration(row.id);
        }}
      >
        apply config row
      </button>
      <button
        type="button"
        data-testid="apply-base-config"
        onClick={() => {
          engine.applyConfiguration(null);
        }}
      >
        apply base config
      </button>
      <button
        type="button"
        data-testid="set-hole-12"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              { type: "parameter.set", id: HOLE_PARAM, value: length(12) },
            ],
          });
          if (!applied.ok) {
            throw new Error("the hole parameter edit was refused");
          }
        }}
      >
        set hole 12
      </button>
      <button
        type="button"
        data-testid="hide-plate"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [{ type: "body.update", id: PLATE_BODY, visible: false }],
          });
          if (!applied.ok) {
            throw new Error("the body hide was refused");
          }
        }}
      >
        hide plate
      </button>
      <button
        type="button"
        data-testid="adopt-extrude-document"
        onClick={() => {
          try {
            engine.store.replaceSession(adoptedExtrudeSession());
            engine.reseedAuthoringCounters();
            lastAdoptionError = null;
          } catch (error: unknown) {
            lastAdoptionError =
              error instanceof Error ? error.message : String(error);
          }
        }}
      >
        adopt extrude document
      </button>
      <button
        type="button"
        data-testid="adopt-conflicting-document"
        onClick={() => {
          try {
            engine.store.replaceSession(adoptedConflictingSession());
            engine.reseedAuthoringCounters();
            lastAdoptionError = null;
          } catch (error: unknown) {
            lastAdoptionError =
              error instanceof Error ? error.message : String(error);
          }
        }}
      >
        adopt conflicting document
      </button>
      <button
        type="button"
        data-testid="extrude-via-action"
        onClick={() => {
          const outcome = engine.handleExtrude(engineExtrudeSubmission());
          lastExtrudeAction = outcome;
          lastFeatureIds = engine.store
            .getDocument()
            .features.map((feature) => String(feature.id));
        }}
      >
        extrude via action
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

describe("the sketch-on-face datum zombie fix (review)", () => {
  it("commits nothing for an unresolvable face-plane pick and the next pick works", async () => {
    lastSketchOnFace = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).toContain(
        "feat_translate_plate",
      );
    });
    // The fabricated settle: both bodies' boxes under one projection.
    act(() => {
      bootedOptions.onApplied?.(fabricatedSceneState(), 1);
    });

    // Attempt 1: the plate's top face picks fine (planar, +z), but the
    // plate has no producing extrude — the resolution refuses. The fix
    // resolves BEFORE the commit: no datum in the tree, no anchor, the
    // counter untouched.
    fireEvent.click(screen.getByTestId("sketch-on-face"));
    await waitFor(() => {
      expect(lastSketchOnFace).not.toBeNull();
    });
    const refused = sketchOnFaceOutcome();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("no resolvable extrude faces");
    }
    expect(surface().getAttribute("data-datums")).toBe("[]");
    expect(surface().getAttribute("data-mode")).toBe("model");

    // Attempt 2: extrude a profile (the document gains a real extrude
    // body), then sketch on ITS top face — the same verb, the SAME
    // first-occurrence datum id, and it must succeed: no zombie, no wedged
    // counter, the model tree and the document agree.
    fireEvent.click(screen.getByTestId("add-extrude"));
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).toContain(
        "feat_engine_extrude",
      );
    });
    sketchOnFaceTarget = { bodyId: "body_engine_extrude", faceIndex: 0 };
    lastSketchOnFace = null;
    fireEvent.click(screen.getByTestId("sketch-on-face"));
    await waitFor(() => {
      expect(lastSketchOnFace).not.toBeNull();
    });
    expect(sketchOnFaceOutcome().ok).toBe(true);
    expect(surface().getAttribute("data-mode")).toBe("sketch");
    type DatumEntry = { readonly id?: string; readonly resolved?: boolean };
    const datums = JSON.parse(
      surface().getAttribute("data-datums") ?? "[]",
    ) as DatumEntry[];
    expect(datums).toHaveLength(1);
    // The engine's first-occurrence convention: the suffix is EMPTY for n=1.
    expect(datums[0]?.id).toBe("dtm_face_plane");
    expect(datums[0]?.resolved).toBe(true);
  });
});

describe("the configuration switch's honest side-state (review)", () => {
  it("reports active honestly after history moves and never clobbers manual edits", async () => {
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("8");
    });
    const activeId = (): string | null => {
      const parsed = JSON.parse(
        surface().getAttribute("data-configs") ?? "{}",
      ) as { readonly active?: string | null };
      return parsed.active ?? null;
    };

    // Row A overrides the hole diameter to 5; applying commits it.
    fireEvent.click(screen.getByTestId("seed-config-row"));
    fireEvent.click(screen.getByTestId("apply-config-row"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("5");
    });
    const rowId = activeId();
    expect(rowId).not.toBeNull();

    // UNDO reverts the apply: the marker would lie — it resets, and the
    // baseline with it.
    fireEvent.click(screen.getByTestId("undo"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("8");
    });
    expect(activeId()).toBeNull();

    // REDO re-lands the values on a NEW document identity: the marker
    // stays honestly off (one click re-applies the row).
    fireEvent.click(screen.getByTestId("redo"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("5");
    });
    expect(activeId()).toBeNull();

    // A manual parameter edit, then apply: the row's override wins (5),
    // and the LIVE value (12) becomes the tracked base — never a stale
    // snapshot from the first apply.
    fireEvent.click(screen.getByTestId("set-hole-12"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("12");
    });
    fireEvent.click(screen.getByTestId("apply-config-row"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("5");
    });
    expect(activeId()).toBe(rowId);

    // Apply → undo → manual HIDE → apply: the stale tracking would
    // force-unhide the manually hidden body; the live-derived baseline
    // leaves the user's edit alone.
    fireEvent.click(screen.getByTestId("undo"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("12");
    });
    expect(activeId()).toBeNull();
    fireEvent.click(screen.getByTestId("hide-plate"));
    await waitFor(() => {
      expect(surface().getAttribute("data-plate-visible")).toBe("false");
    });
    fireEvent.click(screen.getByTestId("apply-config-row"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("5");
    });
    expect(surface().getAttribute("data-plate-visible")).toBe("false");
    expect(activeId()).toBe(rowId);

    // Return to base with NO divergence since that apply: the trusted
    // baseline restores the live-captured value (12) and still respects
    // the manual hide.
    fireEvent.click(screen.getByTestId("apply-base-config"));
    await waitFor(() => {
      expect(surface().getAttribute("data-hole")).toBe("12");
    });
    expect(surface().getAttribute("data-plate-visible")).toBe("false");
    expect(activeId()).toBeNull();
  });
});

describe("the authoring-counter reseed at the adoption door (review)", () => {
  it("mints past an adopted document's explicit engine-convention ids", async () => {
    lastExtrudeAction = null;
    lastAdoptionError = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).toContain(
        "feat_translate_plate",
      );
    });

    // The TSX import door's shape: a whole session swaps in carrying
    // skd_extrude/param_extrude_depth/body_extrude/feat_extrude (what the
    // exporter emits), then the engine reseeds.
    fireEvent.click(screen.getByTestId("adopt-extrude-document"));
    expect(lastAdoptionError).toBeNull();

    // The next extrude must MINT PAST the adopted ids — before the fix it
    // re-minted feat_extrude, the atomic guard refused the whole
    // transaction, and the action swallowed it.
    fireEvent.click(screen.getByTestId("extrude-via-action"));
    await waitFor(() => {
      expect(lastExtrudeAction).not.toBeNull();
    });
    expect(extrudeActionOutcome().ok).toBe(true);
    expect(lastFeatureIds).toContain("feat_extrude2");
    expect(surface().getAttribute("data-scene")).toBe("extrude");
  });

  it("surfaces a refused extrude commit through the action's outcome", async () => {
    lastExtrudeAction = null;
    lastAdoptionError = null;
    render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("engine-surface");
    await waitFor(() => {
      expect(surface().getAttribute("data-timeline")).toContain(
        "feat_translate_plate",
      );
    });

    // No engine-convention ids (the reseed has nothing to advance past)
    // but the parameter NAME the first extrude mints is taken: the commit
    // genuinely refuses — and must SAY so, committing nothing.
    fireEvent.click(screen.getByTestId("adopt-conflicting-document"));
    expect(lastAdoptionError).toBeNull();
    fireEvent.click(screen.getByTestId("extrude-via-action"));
    await waitFor(() => {
      expect(lastExtrudeAction).not.toBeNull();
    });
    const refusal = extrudeActionOutcome();
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      // The transaction layer's wrapper code; the cause rides the message.
      expect(refusal.code).toBe("transaction/command-failed");
      expect(refusal.message).toContain("extrudeDepth");
    }
    // Nothing committed: the adopted document keeps its one feature.
    expect(lastFeatureIds).toHaveLength(0);
    expect(surface().getAttribute("data-scene")).not.toBe("extrude");
  });
});
