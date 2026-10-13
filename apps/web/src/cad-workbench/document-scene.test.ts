/**
 * The document-scene policy's tests (Phase 16 owner fix): the pure decision
 * of which bodies the applied scene renders. The fixtures build documents
 * exactly as the pages' create actions commit them (the scene-fallback
 * suite's builder discipline), so every case names the feature set and the
 * expected body list:
 *
 * - the boot-plate document stays on the dedicated plate dispatch ([]) —
 *   its authored camera the baselines pin;
 * - the plate rides the DOCUMENT scene as one body once any solid feature
 *   exists (the boot plate never vanishes under the model);
 * - consumed lineages (hole, boolean) render only their tip — the plain
 *   operand forms are absorbed by the compositions that rebuild them;
 * - EVERY boolean feature reads, in document order, and a consumer whose
 *   operand is another composition's output admits in feature order with
 *   the consumed base riding as a COMPUTE-ONLY entry (the real-CAD
 *   operand handoff — a pocket cut from a holed block keeps the window);
 * - rollback and suppression un-absorb what the parked/suppressed feature
 *   consumed (a rolled-back state must not show later bodies);
 * - the body-display keep rule stays OUT of the request list — hidden and
 *   isolated tips remain listed (the emptiness decision is
 *   pre-display-filter, so an all-hidden scene keeps the document
 *   dispatch and the plate never re-materializes) while
 *   `renderableBodyIds` carries the keep rule to the computation;
 * - a body whose inputs no longer resolve is skipped honestly — the scene
 *   renders whatever IS valid, never a fabricated body.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
  updateBody,
  type AnyDimensionalValue,
  type CadDocument,
  type FeatureInputRef,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createRectangleEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

import { documentSceneBodies, renderableBodyIds } from "./document-scene";
import { REVOLVE_AXIS_X_RAD } from "./revolve";

const DOC = createDocumentId("doc_document_scene");
const PLATE_BODY = createBodyId("body_plate");
const HOLE_PARAMETER = createParameterId("param_hole_diameter");

/** A 20×15 rectangle on the XY workplane (the extrude profile). */
function extrudeSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_f-bottom");
  const right = createSketchEntityId("skent_f-right");
  const top = createSketchEntityId("skent_f-top");
  const left = createSketchEntityId("skent_f-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
      createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
      createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
      createRectangleEntity(createSketchEntityId("skent_f-rect"), [
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

/** A revolve profile whose X-axis revolve never crosses the axis. */
function revolveSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_rv-bottom");
  const right = createSketchEntityId("skent_rv-right");
  const top = createSketchEntityId("skent_rv-top");
  const left = createSketchEntityId("skent_rv-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 0, y: 0 }, { x: 30, y: 0 }),
      createLineEntity(right, { x: 30, y: 0 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 0, y: 25 }),
      createLineEntity(left, { x: 0, y: 25 }, { x: 0, y: 0 }),
      createRectangleEntity(createSketchEntityId("skent_rv-rect"), [
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

type StageParameters = readonly (readonly [
  ReturnType<typeof createParameterId>,
  string,
  AnyDimensionalValue,
])[];

type SolidStage =
  | { readonly kind: "extrude" }
  | { readonly kind: "revolve" }
  | { readonly kind: "hole"; readonly targetIndex: number }
  | {
      readonly kind: "boolean";
      readonly operation: "union" | "subtract" | "intersect";
      readonly targetIndex: number;
      readonly toolIndex: number;
    };

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function commit(
  document: CadDocument,
  parameters: StageParameters,
  sketch: Record<string, unknown> | null,
  sketchId: ReturnType<typeof createSketchDocumentId>,
  bodyId: ReturnType<typeof createBodyId>,
  bodyName: string,
  featureId: ReturnType<typeof createFeatureId>,
  kind: string,
  inputs: readonly FeatureInputRef[],
): CadDocument {
  let next = document;
  for (const [id, name, value] of parameters) {
    next = requireOk(addDocumentParameter(next, { id, name, value })).document;
  }
  if (sketch !== null) {
    next = requireOk(
      addDocumentSketch(next, {
        id: sketchId,
        name: `sketch ${String(next.sketches.length)}`,
        sketch,
      }),
    ).document;
  }
  next = requireOk(addBody(next, { id: bodyId, name: bodyName })).document;
  next = requireOk(
    addFeature(next, {
      id: featureId,
      kind,
      inputs,
      outputs: [bodyId],
    }),
  ).document;
  return next;
}

/** Commits parameters + a feature over an EXISTING body (the plate's
 * in-place data-only chain — translate and rotate output their input). */
function commitOverBody(
  document: CadDocument,
  parameters: StageParameters,
  bodyId: ReturnType<typeof createBodyId>,
  featureId: ReturnType<typeof createFeatureId>,
  kind: string,
  inputs: readonly FeatureInputRef[],
): CadDocument {
  let next = document;
  for (const [id, name, value] of parameters) {
    next = requireOk(addDocumentParameter(next, { id, name, value })).document;
  }
  next = requireOk(
    addFeature(next, {
      id: featureId,
      kind,
      inputs,
      outputs: [bodyId],
    }),
  ).document;
  return next;
}

/** The boot workbench document: the plate body + its data-only chain. */
function bootPlateDocument(): CadDocument {
  let document = createDocument(DOC);
  document = requireOk(
    addBody(document, { id: PLATE_BODY, name: "plate" }),
  ).document;
  document = requireOk(
    addDocumentParameter(document, {
      id: HOLE_PARAMETER,
      name: "holeDiameter",
      value: length(8),
    }),
  ).document;
  const translateParameters: StageParameters = [
    [createParameterId("param_translate_x"), "translate_x", length(0)],
    [createParameterId("param_translate_y"), "translate_y", length(0)],
    [createParameterId("param_translate_z"), "translate_z", length(0)],
  ];
  const translateFeature = createFeatureId("feat_translate_plate");
  document = commitOverBody(
    document,
    translateParameters,
    PLATE_BODY,
    translateFeature,
    "translate",
    [
      { kind: "body", id: PLATE_BODY },
      ...translateParameters.map(([id]) => ({
        kind: "parameter" as const,
        id,
      })),
    ],
  );
  const rotateParameter: StageParameters = [
    [createParameterId("param_rotate_z"), "rotate_z", angle(0)],
  ];
  document = commitOverBody(
    document,
    rotateParameter,
    PLATE_BODY,
    createFeatureId("feat_rotate_plate"),
    "rotate",
    [
      { kind: "body", id: PLATE_BODY },
      { kind: "feature", id: translateFeature },
      ...rotateParameter.map(([id]) => ({ kind: "parameter" as const, id })),
    ],
  );
  return document;
}

/**
 * Extends a document with the given solid stages (the page actions'
 * commits). Feature and body names embed their stage index, so the
 * expected body ids stay explicit in the assertions.
 */
function withStages(
  document: CadDocument,
  ...stages: readonly SolidStage[]
): CadDocument {
  let next = document;
  let count = 0;
  const bodyIds: string[] = [];
  for (const stage of stages) {
    count += 1;
    const suffix = String(count);
    const bodyId = createBodyId(`body_stage${suffix}`);
    const featureId = createFeatureId(`feat_stage${suffix}`);
    const sketchId = createSketchDocumentId(`skd_stage${suffix}`);
    if (stage.kind === "extrude") {
      bodyIds.push(bodyId);
      next = commit(
        next,
        [
          [
            createParameterId(`param_depth${suffix}`),
            `depth${suffix}`,
            length(10),
          ],
        ],
        extrudeSketchPayload(),
        sketchId,
        bodyId,
        `stage ${suffix}`,
        featureId,
        "extrude",
        [
          { kind: "sketch", id: sketchId },
          { kind: "parameter", id: createParameterId(`param_depth${suffix}`) },
        ],
      );
      continue;
    }
    if (stage.kind === "revolve") {
      bodyIds.push(bodyId);
      next = commit(
        next,
        [
          [
            createParameterId(`param_sweep${suffix}`),
            `sweep${suffix}`,
            angle(Math.PI * 2, "rad"),
          ],
          [
            createParameterId(`param_axis${suffix}`),
            `axis${suffix}`,
            angle(REVOLVE_AXIS_X_RAD, "rad"),
          ],
        ],
        revolveSketchPayload(),
        sketchId,
        bodyId,
        `stage ${suffix}`,
        featureId,
        "revolve",
        [
          { kind: "sketch", id: sketchId },
          { kind: "parameter", id: createParameterId(`param_sweep${suffix}`) },
          { kind: "parameter", id: createParameterId(`param_axis${suffix}`) },
        ],
      );
      continue;
    }
    if (stage.kind === "hole") {
      bodyIds.push(bodyId);
      next = commit(
        next,
        [
          [
            createParameterId(`param_hole_d${suffix}`),
            `holeDiameter${suffix}`,
            length(8),
          ],
          [
            createParameterId(`param_hole_depth${suffix}`),
            `holeDepth${suffix}`,
            length(4),
          ],
          [
            createParameterId(`param_hole_x${suffix}`),
            `holeX${suffix}`,
            length(15),
          ],
          [
            createParameterId(`param_hole_y${suffix}`),
            `holeY${suffix}`,
            length(12),
          ],
          [
            createParameterId(`param_hole_axis${suffix}`),
            `holeAxis${suffix}`,
            dimensionless(3),
          ],
        ],
        null,
        sketchId,
        bodyId,
        `stage ${suffix}`,
        featureId,
        "hole",
        [
          {
            kind: "feature",
            id: createFeatureId(`feat_stage${String(stage.targetIndex)}`),
          },
          { kind: "parameter", id: createParameterId(`param_hole_d${suffix}`) },
          {
            kind: "parameter",
            id: createParameterId(`param_hole_depth${suffix}`),
          },
          { kind: "parameter", id: createParameterId(`param_hole_x${suffix}`) },
          { kind: "parameter", id: createParameterId(`param_hole_y${suffix}`) },
          {
            kind: "parameter",
            id: createParameterId(`param_hole_axis${suffix}`),
          },
        ],
      );
      continue;
    }
    bodyIds.push(bodyId);
    next = commit(
      next,
      [],
      null,
      sketchId,
      bodyId,
      `stage ${suffix}`,
      featureId,
      stage.operation,
      [
        {
          kind: "feature",
          id: createFeatureId(`feat_stage${String(stage.targetIndex)}`),
        },
        {
          kind: "feature",
          id: createFeatureId(`feat_stage${String(stage.toolIndex)}`),
        },
      ],
    );
  }
  return next;
}

function requireDocument(
  result:
    | { readonly ok: true; readonly value: CadDocument }
    | { readonly ok: false; readonly error: { readonly message: string } },
): CadDocument {
  return requireOk(result);
}

function bodyIdsOf(
  document: CadDocument,
  suppressed: ReadonlySet<ReturnType<typeof createFeatureId>> = new Set(),
  rollback: Parameters<typeof documentSceneBodies>[2] = null,
): readonly {
  readonly bodyId: string;
  readonly kind: string;
  readonly consumedOnly?: true;
}[] {
  return documentSceneBodies(document, suppressed, rollback).map((entry) => ({
    bodyId: entry.bodyId,
    kind: entry.scene.kind,
    ...(entry.consumedOnly === true ? { consumedOnly: true as const } : {}),
  }));
}

describe("the document-scene policy", () => {
  it("keeps the boot-plate document on the dedicated plate dispatch", () => {
    expect(bodyIdsOf(bootPlateDocument())).toEqual([]);
  });

  it("rides the plate as one body once a solid feature exists", () => {
    const document = withStages(bootPlateDocument(), { kind: "extrude" });
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
    ]);
  });

  it("renders two independent extrusions side by side", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "extrude" },
    );
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_stage2", kind: "extrude" },
    ]);
  });

  it("absorbs the hole's base — the tip rebuilds it", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "extrude" },
      { kind: "hole", targetIndex: 2 },
    );
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_stage3", kind: "hole" },
    ]);
  });

  it("un-absorbs the base when the hole is parked behind the rollback marker", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "extrude" },
      { kind: "hole", targetIndex: 2 },
    );
    const rolled = bodyIdsOf(document, new Set(), {
      afterFeatureId: createFeatureId("feat_stage2"),
    });
    expect(rolled).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_stage2", kind: "extrude" },
    ]);
  });

  it("un-absorbs the base when the hole feature is suppressed", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "extrude" },
      { kind: "hole", targetIndex: 2 },
    );
    const suppressed = bodyIdsOf(
      document,
      new Set([createFeatureId("feat_stage3")]),
    );
    expect(suppressed).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_stage2", kind: "extrude" },
    ]);
  });

  it("a boolean consumes both operands — only the union renders", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "extrude" },
      { kind: "boolean", operation: "union", targetIndex: 1, toolIndex: 2 },
    );
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage3", kind: "boolean" },
    ]);
  });

  it("every boolean in the document reads — a chain renders the newest tip with the consumed bases compute-only", () => {
    // Block → subtract 1 → subtract 2: BOTH booleans read (the defect the
    // first-only find never rendered the second), the second consuming the
    // first's COMPUTED solid — the first's entry rides COMPUTE-ONLY, and
    // the plain tools stay absorbed without entries (their derivations
    // ride the requests).
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "extrude" },
      { kind: "boolean", operation: "subtract", targetIndex: 1, toolIndex: 2 },
      { kind: "extrude" },
      { kind: "boolean", operation: "subtract", targetIndex: 3, toolIndex: 4 },
    );
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage3", kind: "boolean", consumedOnly: true },
      { bodyId: "body_stage5", kind: "boolean" },
    ]);
  });

  it("a boolean over a composed operand keeps its prior features — the holed block's entry rides compute-only", () => {
    // Block → hole → pocket subtract: the hole's output is CONSUMED by the
    // boolean, so its scene computes only to feed the consumer its solid —
    // the render is the pocket's tip alone, whose scene cuts the holed
    // block (the window survives), never a re-derivation of the raw block.
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "hole", targetIndex: 1 },
      { kind: "extrude" },
      {
        kind: "boolean",
        operation: "subtract",
        targetIndex: 2,
        toolIndex: 3,
      },
    );
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage2", kind: "hole", consumedOnly: true },
      { bodyId: "body_stage4", kind: "boolean" },
    ]);
  });

  it("parking the second boolean un-absorbs the first's tip and its tools", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "extrude" },
      { kind: "boolean", operation: "subtract", targetIndex: 1, toolIndex: 2 },
      { kind: "extrude" },
      { kind: "boolean", operation: "subtract", targetIndex: 3, toolIndex: 4 },
    );
    const parked = bodyIdsOf(document, new Set(), {
      afterFeatureId: createFeatureId("feat_stage4"),
    });
    // The rollback drops the second subtract: the first's tip renders (no
    // longer consumed) and the notch tool renders as an independent
    // extrusion again.
    expect(parked).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage3", kind: "boolean" },
      { bodyId: "body_stage4", kind: "extrude" },
    ]);
  });

  it("a moved body renders through its own scene, never as a second plate", () => {
    // The move-body feature is ALSO a translate: the fixture-plate rule
    // must walk the producer CHAIN (the move's input reaches an extrude)
    // and leave the moved body to the moveBody scene — fabricating a
    // second plate under the moved body's id would be exactly the
    // dishonesty this module exists to prevent.
    let document = bootPlateDocument();
    document = withStages(document, { kind: "extrude" });
    // The move action's parameter layout WITH the rotation pair (five
    // parameters — the reader's >= 4 gate).
    const moveParameters: StageParameters = [
      [createParameterId("param_move_x"), "moveX", length(10)],
      [createParameterId("param_move_y"), "moveY", length(0)],
      [createParameterId("param_move_z"), "moveZ", length(0)],
      [createParameterId("param_move_axis"), "moveAxis", dimensionless(3)],
      [createParameterId("param_move_angle"), "moveAngle", angle(0)],
    ];
    for (const [id, name, value] of moveParameters) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
      ).document;
    }
    document = requireOk(
      addBody(document, { id: createBodyId("body_moved"), name: "moved" }),
    ).document;
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_move_out"),
        kind: "translate",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage1") },
          ...moveParameters.map(([id]) => ({
            kind: "parameter" as const,
            id,
          })),
        ],
        outputs: [createBodyId("body_moved")],
      }),
    ).document;
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_moved", kind: "moveBody" },
    ]);
  });

  it("the keep rule rides beside the list — hidden tips stay listed, the renderable set drops them", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "revolve" },
    );
    const hidden = requireDocument(
      updateBody(document, createBodyId("body_stage1"), { visible: false }),
    );
    // The request list is PRE-display-filter: the hidden tip stays listed
    // (the computation skips it per body), so the engine's emptiness
    // decision keeps meaning "no scene resolved".
    expect(bodyIdsOf(hidden)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_stage2", kind: "revolve" },
    ]);
    // The keep rule travels in the renderable set the engine hands the
    // session beside the list.
    expect(Array.from(renderableBodyIds(hidden))).toEqual([
      "body_plate",
      "body_stage2",
    ]);
    const isolated = requireDocument(
      updateBody(document, createBodyId("body_stage2"), { isolated: true }),
    );
    expect(bodyIdsOf(isolated)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_stage2", kind: "revolve" },
    ]);
    expect(Array.from(renderableBodyIds(isolated))).toEqual(["body_stage2"]);
  });

  it("an all-hidden scene stays a document dispatch — the plate never re-materializes", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "revolve" },
    );
    let allHidden = document;
    for (const bodyId of ["body_plate", "body_stage1", "body_stage2"]) {
      allHidden = requireDocument(
        updateBody(allHidden, createBodyId(bodyId), { visible: false }),
      );
    }
    // Non-empty request set with an EMPTY render set: the engine's
    // `bodies.length > 0` gate dispatches the document scene (whose
    // computation skips every body — the honest empty projection, the
    // truthful volume 0), never the plate fallback.
    expect(bodyIdsOf(allHidden)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_stage2", kind: "revolve" },
    ]);
    expect(renderableBodyIds(allHidden).size).toBe(0);
  });

  it("skips a body whose inputs no longer resolve — the rest still render", () => {
    const document = withStages(
      bootPlateDocument(),
      { kind: "extrude" },
      { kind: "revolve" },
    );
    // The revolve feature's sketch disappears from the document (an undo
    // or an import that dropped it): the reader declines that body alone —
    // the scene renders what IS valid, never a fabricated body.
    const feature = document.features.find((entry) => entry.kind === "revolve");
    if (feature === undefined) throw new Error("the revolve fixture broke");
    const sketchRef = feature.inputs.find((ref) => ref.kind === "sketch");
    if (sketchRef === undefined || sketchRef.kind !== "sketch") {
      throw new Error("the revolve fixture carries no sketch input");
    }
    const broken = {
      ...document,
      sketches: document.sketches.filter(
        (sketch) => sketch.id !== sketchRef.id,
      ),
    } as CadDocument;
    expect(bodyIdsOf(broken)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The duplicate-to-boolean admissions (Phase 32b): a composition may consume
// a DUPLICATE's copy (a union fusing a turned copy), so the copies must
// admit IN PRODUCING-FEATURE ORDER beside the compositions — the copies
// admitted only after them let such a consumer's operand check fail and the
// whole chain silently drop.
// ---------------------------------------------------------------------------

const DUP_DX = createParameterId("param_chain_dx");
const DUP_DY = createParameterId("param_chain_dy");
const DUP_DZ = createParameterId("param_chain_dz");
const DUP_COUNT = createParameterId("param_chain_count");
const DUP_AXIS = createParameterId("param_chain_axis");
const DUP_ANGLE = createParameterId("param_chain_angle");
const DUP_FEATURE = createFeatureId("feat_chain_duplicate");

/**
 * The chapter's posts-why shape, minimal: one extruded base, ONE duplicate
 * copy of it, then the union chain — union1 fuses the base with the copy
 * (the copy is a COMPUTED operand), union2 fuses union1's output with a
 * second extruded brace. Before the fix union1's operand check ran before
 * the duplicate's entries existed, union1 declined, and union2 cascaded.
 */
/** Unwraps one builder result's document (the fixture discipline). */
function chained(
  result:
    | {
        readonly ok: true;
        readonly value: { readonly document: CadDocument } | CadDocument;
      }
    | { readonly ok: false; readonly error: { readonly message: string } },
): CadDocument {
  if (!result.ok) throw new Error(result.error.message);
  return "document" in result.value ? result.value.document : result.value;
}

/** The duplicate chain's six auto-parameter identities. */
function chainFeature(
  document: CadDocument,
  featureId: ReturnType<typeof createFeatureId>,
  kind: string,
  inputs: readonly FeatureInputRef[],
  outputs: readonly string[],
): CadDocument {
  return chained(
    addFeature(document, {
      id: featureId,
      kind,
      inputs,
      outputs: outputs.map((output) => createBodyId(output)),
    }),
  );
}

function duplicateChainDocument(): CadDocument {
  let document = createDocument(DOC);
  document = chained(
    addDocumentParameter(document, {
      id: createParameterId("param_chain_depth"),
      name: "depth",
      value: length(10),
    }),
  );
  for (const [index, bodyName] of ["brace one", "brace two"].entries()) {
    const suffix = String(index + 1);
    const bodyId = createBodyId(`body_chain${suffix}`);
    const sketchId = createSketchDocumentId(`skd_chain${suffix}`);
    document = chained(addBody(document, { id: bodyId, name: bodyName }));
    document = chained(
      addDocumentSketch(document, {
        id: sketchId,
        name: `sketch ${suffix}`,
        sketch: extrudeSketchPayload(),
      }),
    );
    document = chainFeature(
      document,
      createFeatureId(`feat_chain_extrude${suffix}`),
      "extrude",
      [
        { kind: "sketch", id: sketchId },
        { kind: "parameter", id: createParameterId("param_chain_depth") },
      ],
      [`body_chain${suffix}`],
    );
  }
  for (const [id, name, value] of [
    [DUP_DX, "dupDx", length(25)],
    [DUP_DY, "dupDy", length(0)],
    [DUP_DZ, "dupDz", length(0)],
    [DUP_COUNT, "dupCount", dimensionless(1)],
    [DUP_AXIS, "dupAxis", dimensionless(3)],
    [DUP_ANGLE, "dupAngle", angle(0)],
  ] as const) {
    document = chained(addDocumentParameter(document, { id, name, value }));
  }
  document = chained(
    addBody(document, {
      id: createBodyId("body_chain_c1"),
      name: "copy 1",
    }),
  );
  document = chainFeature(
    document,
    DUP_FEATURE,
    "duplicate",
    [
      { kind: "feature", id: createFeatureId("feat_chain_extrude1") },
      { kind: "parameter", id: DUP_DX },
      { kind: "parameter", id: DUP_DY },
      { kind: "parameter", id: DUP_DZ },
      { kind: "parameter", id: DUP_COUNT },
      { kind: "parameter", id: DUP_AXIS },
      { kind: "parameter", id: DUP_ANGLE },
    ],
    ["body_chain_c1"],
  );
  const union = (
    featureId: string,
    targetFeature: ReturnType<typeof createFeatureId>,
    toolFeatures: readonly ReturnType<typeof createFeatureId>[],
  ): void => {
    document = chained(
      addBody(document, {
        id: createBodyId(`body_${featureId}`),
        name: `union ${featureId}`,
      }),
    );
    document = chainFeature(
      document,
      createFeatureId(featureId),
      "union",
      [
        { kind: "feature", id: targetFeature },
        ...toolFeatures.map((id) => ({ kind: "feature" as const, id })),
      ],
      [`body_${featureId}`],
    );
  };
  union("feat_chain_boolean1", createFeatureId("feat_chain_extrude1"), [
    DUP_FEATURE,
  ]);
  union("feat_chain_boolean2", createFeatureId("feat_chain_boolean1"), [
    createFeatureId("feat_chain_extrude2"),
  ]);
  return document;
}

describe("the duplicate-to-boolean admissions (Phase 32b)", () => {
  it("a union over a duplicate's copy admits — the copy rides consumed-only", () => {
    const list = bodyIdsOf(duplicateChainDocument());
    // The base brace is absorbed by union1 (its feature input); the copy is
    // union1's COMPUTED tool — it computes for the handoff and renders
    // nothing; both unions render, the second fusing union1's output with
    // the second brace.
    // Union1 itself is union2's computed target — it computes consumed-only
    // too; only the chain's tip renders plain.
    expect(list).toEqual([
      { bodyId: "body_chain_c1", kind: "duplicate", consumedOnly: true },
      {
        bodyId: "body_feat_chain_boolean1",
        kind: "boolean",
        consumedOnly: true,
      },
      { bodyId: "body_feat_chain_boolean2", kind: "boolean" },
    ]);
  });

  it("a multi-tool boolean composes EVERY declared tool — none drops", () => {
    let document = duplicateChainDocument();
    document = chained(
      addBody(document, {
        id: createBodyId("body_feat_chain_multi"),
        name: "union multi",
      }),
    );
    document = chained(
      addFeature(document, {
        id: createFeatureId("feat_chain_boolean_multi"),
        kind: "union",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_chain_boolean2") },
          { kind: "feature", id: DUP_FEATURE },
          { kind: "feature", id: createFeatureId("feat_chain_extrude1") },
          { kind: "feature", id: createFeatureId("feat_chain_extrude2") },
        ],
        outputs: [createBodyId("body_feat_chain_multi")],
      }),
    );
    const list = bodyIdsOf(document);
    expect(list).toEqual([
      { bodyId: "body_chain_c1", kind: "duplicate", consumedOnly: true },
      {
        bodyId: "body_feat_chain_boolean1",
        kind: "boolean",
        consumedOnly: true,
      },
      {
        bodyId: "body_feat_chain_boolean2",
        kind: "boolean",
        consumedOnly: true,
      },
      { bodyId: "body_feat_chain_multi", kind: "boolean" },
    ]);
    const multi = documentSceneBodies(document, new Set(), null).find(
      (entry) => entry.bodyId === "body_feat_chain_multi",
    );
    if (multi === undefined || multi.scene.kind !== "boolean") {
      throw new Error("the multi-tool union lost its scene");
    }
    // The commit keeps THREE tools (the copy, brace one, brace two); the
    // request carries all three operand sources.
    expect(multi.scene.request.tools).toHaveLength(3);
    expect(multi.scene.request.tools[0]).toEqual({
      kind: "computed",
      bodyId: "body_chain_c1",
    });
  });
});

describe("the computed-operand admissions (the cup fix)", () => {
  it("a boolean over revolves admits — each revolve rides consumed-only", () => {
    // THE regression pin for the cup: before, `sceneOperandOfBody` declined
    // every non-allowlisted producer, so union/subtract over revolved solids
    // silently rendered the fallback blob instead of the fused result.
    const document = withStages(
      bootPlateDocument(),
      { kind: "revolve" },
      { kind: "revolve" },
      { kind: "boolean", operation: "subtract", targetIndex: 1, toolIndex: 2 },
    );
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "revolve", consumedOnly: true },
      { bodyId: "body_stage2", kind: "revolve", consumedOnly: true },
      { bodyId: "body_stage3", kind: "boolean" },
    ]);
  });

  it("a patternLinear over an extrude admits — the plain target stays absorbed", () => {
    let document = withStages(bootPlateDocument(), { kind: "extrude" });
    for (const [id, name, value] of [
      [createParameterId("param_pat_count"), "patCount", dimensionless(3)],
      [createParameterId("param_pat_spacing"), "patSpacing", length(15)],
      [createParameterId("param_pat_dir"), "patDir", angle(0)],
    ] as const) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
      ).document;
    }
    document = requireOk(
      addBody(document, { id: createBodyId("body_pat1"), name: "pattern" }),
    ).document;
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_pat1"),
        kind: "patternLinear",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage1") },
          { kind: "parameter", id: createParameterId("param_pat_count") },
          { kind: "parameter", id: createParameterId("param_pat_spacing") },
          { kind: "parameter", id: createParameterId("param_pat_dir") },
        ],
        outputs: [createBodyId("body_pat1")],
      }),
    ).document;
    // The extrude target re-derives inside the request (kind "extrude"),
    // so it stays absorbed — only the pattern's own tip renders.
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_pat1", kind: "patternTransform" },
    ]);
  });

  it("a patternCircular over a revolve admits — the computed target rides consumed-only", () => {
    let document = withStages(bootPlateDocument(), { kind: "revolve" });
    for (const [id, name, value] of [
      [createParameterId("param_pc_count"), "pcCount", dimensionless(4)],
      [createParameterId("param_pc_angle"), "pcAngle", angle(Math.PI * 2)],
      [createParameterId("param_pc_axis"), "pcAxis", dimensionless(3)],
    ] as const) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
      ).document;
    }
    document = requireOk(
      addBody(document, { id: createBodyId("body_pc1"), name: "pattern" }),
    ).document;
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_pc1"),
        kind: "patternCircular",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage1") },
          { kind: "parameter", id: createParameterId("param_pc_count") },
          { kind: "parameter", id: createParameterId("param_pc_angle") },
          { kind: "parameter", id: createParameterId("param_pc_axis") },
        ],
        outputs: [createBodyId("body_pc1")],
      }),
    ).document;
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "revolve", consumedOnly: true },
      { bodyId: "body_pc1", kind: "patternTransform" },
    ]);
  });

  it("emits a consumer after its consumed operands, whatever the body insertion order", () => {
    // Regression pin for the emission pass: a consumer's `body` record
    // inserted before the bodies its feature consumes (the order a
    // command batch produces) pushed the consumer's scene entry ahead of
    // its operands — the compute pass then resolved no computed solid and
    // the consumer reported "operand-unavailable" instead of rendering.
    let document = requireOk(
      addBody(bootPlateDocument(), {
        id: createBodyId("body_cup"),
        name: "cup",
      }),
    ).document;
    document = withStages(
      document,
      { kind: "revolve" },
      { kind: "revolve" },
      { kind: "boolean", operation: "union", targetIndex: 1, toolIndex: 2 },
    );
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_cup"),
        kind: "subtract",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage3") },
          { kind: "feature", id: createFeatureId("feat_stage2") },
        ],
        outputs: [createBodyId("body_cup")],
      }),
    ).document;
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "revolve", consumedOnly: true },
      { bodyId: "body_stage2", kind: "revolve", consumedOnly: true },
      { bodyId: "body_stage3", kind: "boolean", consumedOnly: true },
      { bodyId: "body_cup", kind: "boolean" },
    ]);
  });

  /** The patternLinear builder the domain tests share (count + spacing + direction). */
  function linearPatternDocument(count: number, spacingMm: number) {
    let document = withStages(bootPlateDocument(), { kind: "extrude" });
    for (const [id, name, value] of [
      [createParameterId("param_pat_count"), "patCount", dimensionless(count)],
      [createParameterId("param_pat_spacing"), "patSpacing", length(spacingMm)],
      [createParameterId("param_pat_dir"), "patDir", angle(0)],
    ] as const) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
      ).document;
    }
    document = requireOk(
      addBody(document, { id: createBodyId("body_pat1"), name: "pattern" }),
    ).document;
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_pat1"),
        kind: "patternLinear",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage1") },
          { kind: "parameter", id: createParameterId("param_pat_count") },
          { kind: "parameter", id: createParameterId("param_pat_spacing") },
          { kind: "parameter", id: createParameterId("param_pat_dir") },
        ],
        outputs: [createBodyId("body_pat1")],
      }),
    ).document;
    return document;
  }

  it("a patternLinear with a refused count emits no scene — the bridge's domain is the reader's", () => {
    // count 1 is "a pattern of one copy is no pattern" in the bridge — a
    // refused feature must not still render a successful scene.
    expect(bodyIdsOf(linearPatternDocument(1, 15))).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
    ]);
    // The non-integer and past-limit counts ride the same gate.
    expect(bodyIdsOf(linearPatternDocument(2.5, 15))).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
    ]);
  });

  it("a patternLinear with zero spacing emits no scene — the refused feature stays refused", () => {
    expect(bodyIdsOf(linearPatternDocument(3, 0))).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
    ]);
  });

  it("a patternCircular over one full turn emits no scene — the bridge's sweep cap holds", () => {
    let document = withStages(bootPlateDocument(), { kind: "revolve" });
    for (const [id, name, value] of [
      [createParameterId("param_pc_count"), "pcCount", dimensionless(4)],
      [createParameterId("param_pc_angle"), "pcAngle", angle(7)],
      [createParameterId("param_pc_axis"), "pcAxis", dimensionless(3)],
    ] as const) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
      ).document;
    }
    document = requireOk(
      addBody(document, { id: createBodyId("body_pc1"), name: "pattern" }),
    ).document;
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_pc1"),
        kind: "patternCircular",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage1") },
          { kind: "parameter", id: createParameterId("param_pc_count") },
          { kind: "parameter", id: createParameterId("param_pc_angle") },
          { kind: "parameter", id: createParameterId("param_pc_axis") },
        ],
        outputs: [createBodyId("body_pc1")],
      }),
    ).document;
    // 7 rad > 2π double-covers the circle — the target keeps its own
    // rendered scene, unmarked compute-only (nothing consumed it).
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "revolve" },
    ]);
  });

  it("a boolean over a primitive declines — the seam never advertises an operand with no scene", () => {
    // `box` produces a real solid but NO scene entry: the operand seam
    // declines it, so the union skips honestly instead of promising a
    // computed solid the document pass cannot supply.
    let document = withStages(bootPlateDocument(), { kind: "extrude" });
    for (const [id, name, value] of [
      [createParameterId("param_box_w"), "boxW", length(10)],
      [createParameterId("param_box_d"), "boxD", length(10)],
      [createParameterId("param_box_h"), "boxH", length(10)],
    ] as const) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
      ).document;
    }
    for (const bodyId of ["body_box", "body_union"] as const) {
      document = requireOk(
        addBody(document, { id: createBodyId(bodyId), name: bodyId }),
      ).document;
    }
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_box"),
        kind: "box",
        inputs: [
          { kind: "parameter", id: createParameterId("param_box_w") },
          { kind: "parameter", id: createParameterId("param_box_d") },
          { kind: "parameter", id: createParameterId("param_box_h") },
        ],
        outputs: [createBodyId("body_box")],
      }),
    ).document;
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_union"),
        kind: "union",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage1") },
          { kind: "feature", id: createFeatureId("feat_box") },
        ],
        outputs: [createBodyId("body_union")],
      }),
    ).document;
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
    ]);
  });

  it("a second patternFeature's output is not operand-capable — the reader serves the first only", () => {
    // The legacy pattern readers compose ONE chain: the document's first
    // feature of the kind. A body produced by a second patternFeature
    // carries no scene entry, so a consumer over it declines honestly.
    let document = withStages(bootPlateDocument(), { kind: "extrude" });
    for (const [id, name, value] of [
      [createParameterId("param_pf_dir"), "pfDir", angle(0)],
      [createParameterId("param_pf_count"), "pfCount", dimensionless(2)],
      [createParameterId("param_pf_gap"), "pfGap", length(20)],
    ] as const) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
      ).document;
    }
    for (const [index, bodyId] of [
      "body_pf1",
      "body_pf2",
      "body_union",
    ].entries()) {
      document = requireOk(
        addBody(document, { id: createBodyId(bodyId), name: `pf${index}` }),
      ).document;
    }
    for (const [index, bodyId] of ["body_pf1", "body_pf2"].entries()) {
      document = requireOk(
        addFeature(document, {
          id: createFeatureId(`feat_pf${String(index + 1)}`),
          kind: "patternFeature",
          inputs: [
            { kind: "parameter", id: createParameterId("param_pf_dir") },
            { kind: "parameter", id: createParameterId("param_pf_count") },
            { kind: "parameter", id: createParameterId("param_pf_gap") },
          ],
          outputs: [createBodyId(bodyId)],
        }),
      ).document;
    }
    document = requireOk(
      addFeature(document, {
        id: createFeatureId("feat_union"),
        kind: "union",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_stage1") },
          { kind: "feature", id: createFeatureId("feat_pf2") },
        ],
        outputs: [createBodyId("body_union")],
      }),
    ).document;
    // Only the FIRST patternFeature's output carries a scene entry — the
    // union targeting the second's output declines (consuming nothing),
    // the base extrude keeps rendering unconsumed, and body_pf2 renders
    // under no scene.
    expect(bodyIdsOf(document)).toEqual([
      { bodyId: "body_plate", kind: "plate" },
      { bodyId: "body_stage1", kind: "extrude" },
      { bodyId: "body_pf1", kind: "patternFeature" },
    ]);
  });
});
