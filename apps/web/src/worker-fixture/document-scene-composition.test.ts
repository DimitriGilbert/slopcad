/**
 * The document pass over the tutorial's complex-document shape (Phase 32b
 * regression): bound sketches re-solving against expression parameters, a
 * duplicate whose step parameters RIDE those parameters by reference (the
 * `$name` commit — no auto-parameter), and a union chain whose tools are
 * the drawn braces and the turned copies. The chapter that found the bug
 * (e2e-tutorial's iot-applied-var) runs exactly this shape on the OCCT
 * kernel; these tests pin the composition at the unit level:
 *
 * - every dispatch composes from the CURRENT document: the duplicate's
 *   copies land on the hand-derived far corners (the `$ribStep` references
 *   read through their expressions, sign included), and a parameter edit
 *   between dispatches moves them exactly (the re-drive);
 * - a union chain over copies and braces fuses to the analytic ledger —
 *   before the fix the unions over copies silently declined (the copies
 *   admitted only after the compositions) and the chain rendered
 *   shell + 3 full stadiums + 1 open instead of shell + 4 open;
 * - a multi-tool boolean composes EVERY declared tool — the reader used to
 *   read only the first.
 *
 * The kernel is the OCCT adapter (the chapter's own backend — the rotation
 * rides a real kernel transform here; the fake kernel declines rotations
 * and the Manifold kernel honestly declares none).
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentSketch,
  addFeature,
  angle,
  applyCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
  parseExpression,
  type AnyDimensionalValue,
  type CadDocument,
  type ExpressionNode,
  type FeatureInputRef,
  type ParameterId,
} from "@slopcad/cad-core";
import {
  createDistanceXConstraint,
  createDistanceYConstraint,
  createHorizontalConstraint,
  createLineEntity,
  createPointEntity,
  createRectangleEntity,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  createStraightSlotEntity,
  pointTarget,
  serializeSketch,
  xyWorkplane,
  type SketchConstraint,
} from "@slopcad/cad-sketch";
import {
  createRevisionTag,
  createWorkerSolidId,
  type ComputationContext,
  type GeometryKernel,
  type KernelSolid,
  type WorkerOperationInput,
  type WorkerOperationId,
  type WorkerOperationResult,
  type WorkerSolidId,
} from "@slopcad/cad-kernel";
import { createOcctKernel } from "@slopcad/cad-kernel-occt";

import { documentSceneBodies } from "../cad-workbench/document-scene";
import { computeDocumentScene } from "./document-scene";

// ---------------------------------------------------------------------------
// The ledger (the chapter's own numbers, at the defaults)
// ---------------------------------------------------------------------------

/** The block: the full footprint, 35.6 tall, extruded below the bed. */
const BLOCK_VOLUME = 71.6 * 51.6 * 35.6;
/** The cavity tool: the board's footprint at the wall inset, cavityD deep. */
const CAVITY_VOLUME = 70 * 50 * 34.4;
/** The shell after the cavity subtract. */
const SHELL_VOLUME = BLOCK_VOLUME - CAVITY_VOLUME;
/** The braces' open-cavity stadium area at cap radius 0.4, reach 6√2. */
function stripArea(r: number): number {
  return (
    2 * r * (6 * Math.SQRT2) -
    (2 * Math.SQRT2 + 1) * r * r +
    (Math.PI * r * r) / 2
  );
}
/** One rib's union contribution: the open-cavity area, cavity deep. */
const STRIP_UNION_VOLUME = stripArea(0.4) * 34.4;
/** One drafted brace's own body: the FULL stadium prism, cavity deep. */
const STRIP_BODY_VOLUME = (2 * 0.4 * (6 * Math.SQRT2) + Math.PI * 0.16) * 34.4;
/** The shell with its four ribs unioned back on (the chapter's posts-why). */
const SHELL_POSTS_VOLUME = SHELL_VOLUME + 4 * STRIP_UNION_VOLUME;
void SHELL_POSTS_VOLUME;
/** One rib's trimmed-away open-cavity material (boardLift sheared off). */
const STRIP_TRIM_VOLUME = stripArea(0.4) * 25.4;
/** The case after the board-outline trim (the chapter's trims pin). */
const TRIMMED_VOLUME = SHELL_POSTS_VOLUME - 4 * STRIP_TRIM_VOLUME;

const VOLUME_BAND = 1e-6;

function expectVolumeNear(value: number, expected: number): void {
  expect(
    Math.abs(value - expected),
    `volume ${String(value)} against ${String(expected)}`,
  ).toBeLessThanOrEqual(expected * VOLUME_BAND);
}

// ---------------------------------------------------------------------------
// The chapter-shaped document (the same builders the pages commit through)
// ---------------------------------------------------------------------------

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Unwraps a document builder result. */
function grown(
  result:
    | { readonly ok: true; readonly value: { readonly document: CadDocument } }
    | { readonly ok: false; readonly error: { readonly message: string } },
): CadDocument {
  return requireOk(result).document;
}

/** Binds a dimensional constraint to a document parameter (Phase 26a). */
function boundTo<Constraint extends SketchConstraint>(
  constraint: Constraint,
  parameterId: ParameterId,
): Constraint {
  return { ...constraint, parameterId };
}

/**
 * A placed, dimensioned rectangle: the anchor point carries the near
 * corner's place pair (both 10 mm — the corner lands at `place`), the span
 * pair sizes it; each span optionally BOUND to a parameter (the chapter's
 * every footprint rectangle) — the exact recipe the sketcher's dimension
 * tools and the inspector's `$`-autocomplete commit.
 */
function rectangleSketch(
  id: string,
  place: { readonly x: number; readonly y: number },
  spans: { readonly x: number; readonly y: number },
  bindings: { readonly spanX?: ParameterId; readonly spanY?: ParameterId } = {},
): Record<string, unknown> {
  const bottom = createSketchEntityId(`skent_${id}-bottom`);
  const right = createSketchEntityId(`skent_${id}-right`);
  const top = createSketchEntityId(`skent_${id}-top`);
  const left = createSketchEntityId(`skent_${id}-left`);
  const anchor = createSketchEntityId(`skent_${id}-anchor`);
  const spanX = createDistanceXConstraint(
    createSketchConstraintId(`skcon_${id}-span-x`),
    pointTarget(bottom, "start"),
    pointTarget(bottom, "end"),
    length(spans.x),
  );
  const spanY = createDistanceYConstraint(
    createSketchConstraintId(`skcon_${id}-span-y`),
    pointTarget(bottom, "start"),
    pointTarget(top, "start"),
    length(spans.y),
  );
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, place, { x: place.x + spans.x, y: place.y }),
      createLineEntity(
        right,
        { x: place.x + spans.x, y: place.y },
        { x: place.x + spans.x, y: place.y + spans.y },
      ),
      createLineEntity(
        top,
        { x: place.x + spans.x, y: place.y + spans.y },
        { x: place.x, y: place.y + spans.y },
      ),
      createLineEntity(left, { x: place.x, y: place.y + spans.y }, place),
      createRectangleEntity(createSketchEntityId(`skent_${id}-rect`), [
        bottom,
        right,
        top,
        left,
      ]),
      createPointEntity(anchor, { x: place.x - 10, y: place.y - 10 }),
    ],
    [
      createHorizontalConstraint(
        createSketchConstraintId(`skcon_${id}-horiz`),
        bottom,
      ),
      createDistanceXConstraint(
        createSketchConstraintId(`skcon_${id}-place-x`),
        pointTarget(anchor, "center"),
        pointTarget(bottom, "start"),
        length(10),
      ),
      createDistanceYConstraint(
        createSketchConstraintId(`skcon_${id}-place-y`),
        pointTarget(anchor, "center"),
        pointTarget(bottom, "start"),
        length(10),
      ),
      bindings.spanX === undefined ? spanX : boundTo(spanX, bindings.spanX),
      bindings.spanY === undefined ? spanY : boundTo(spanY, bindings.spanY),
    ],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** The brace's straight slot: one closed entity, two cap centers, r 0.4. */
function slotSketch(
  id: string,
  near: { readonly x: number; readonly y: number },
  far: { readonly x: number; readonly y: number },
): Record<string, unknown> {
  const created = createSketch(
    xyWorkplane(),
    [
      createStraightSlotEntity(
        createSketchEntityId(`skent_${id}-slot`),
        near,
        far,
        0.4,
      ),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

// The stable identities (the chapter's own naming rhythm).
const DOC = createDocumentId("doc_scene_composition");
const BOARD_L = createParameterId("param_comp_boardL");
const BOARD_W = createParameterId("param_comp_boardW");
const CASE_L = createParameterId("param_comp_caseL");
const CASE_W = createParameterId("param_comp_caseW");
const RIB_STEP_X = createParameterId("param_comp_ribStepX");
const RIB_STEP_Y = createParameterId("param_comp_ribStepY");
const HALF_TURN = createParameterId("param_comp_halfTurn");

/** Which unions the build appends (the pins need different tails). */
type ChainTail =
  | { readonly kind: "none" }
  | { readonly kind: "four" }
  | { readonly kind: "multi" };

interface ChainBuilders {
  readonly parameter: (
    id: ParameterId,
    name: string,
    value: AnyDimensionalValue,
    expression?: ExpressionNode,
  ) => void;
  readonly sketch: (
    id: ReturnType<typeof createSketchDocumentId>,
    name: string,
    payload: Record<string, unknown>,
  ) => void;
  readonly body: (id: string, name: string) => void;
  readonly feature: (
    id: ReturnType<typeof createFeatureId>,
    kind: string,
    inputs: readonly FeatureInputRef[],
    outputs: readonly string[],
  ) => void;
}

/**
 * The chapter's build through posts-two (`four` adds the posts-why unions,
 * `multi` replaces them with ONE three-tool union, `none` stops at the
 * duplicates): block (spans bound to caseL/caseW), cavity, the shell
 * subtract, drawn brace one, duplicate one (its step fields ride the
 * EXISTING parameters — the `$name` commit shape), drawn brace two,
 * duplicate two.
 */
function chapterDocument(tail: ChainTail): CadDocument {
  let document = createDocument(DOC);
  const builders: ChainBuilders = {
    parameter: (id, name, value, expression) => {
      // The commands' own commit (what the manager and the create actions
      // apply): parameter.create installs the defining expression into the
      // dependency graph and recomputes — the raw collection builder would
      // store the expression without the graph edges.
      document = requireOk(
        applyCommand(document, {
          type: "parameter.create",
          id,
          name,
          value,
          ...(expression === undefined ? {} : { expression }),
        }),
      );
    },
    sketch: (id, name, payload) => {
      document = grown(
        addDocumentSketch(document, { id, name, sketch: payload }),
      );
    },
    body: (id, name) => {
      document = grown(addBody(document, { id: createBodyId(id), name }));
    },
    feature: (id, kind, inputs, outputs) => {
      document = grown(
        addFeature(document, {
          id,
          kind,
          inputs,
          outputs: outputs.map((output) => createBodyId(output)),
        }),
      );
    },
  };
  // The variable system first (the manager's build order): the roots, the
  // derived case spans, the duplicate's named negative step, the half turn.
  builders.parameter(BOARD_L, "boardL", length(70));
  builders.parameter(BOARD_W, "boardW", length(50));
  builders.parameter(
    CASE_L,
    "caseL",
    length(71.6),
    requireOk(parseExpression("boardL + 2 * 0.8mm")),
  );
  builders.parameter(
    CASE_W,
    "caseW",
    length(51.6),
    requireOk(parseExpression("boardW + 2 * 0.8mm")),
  );
  builders.parameter(
    RIB_STEP_X,
    "ribStepX",
    length(-71.6),
    requireOk(parseExpression("-caseL")),
  );
  builders.parameter(
    RIB_STEP_Y,
    "ribStepY",
    length(-51.6),
    requireOk(parseExpression("-caseW")),
  );
  builders.parameter(HALF_TURN, "halfTurn", angle(180, "deg"));

  const depthBlock = createParameterId("param_comp_caseDrop");
  builders.parameter(depthBlock, "caseDrop", length(-35.6));
  const skdBlock = createSketchDocumentId("skd_comp_block");
  builders.sketch(
    skdBlock,
    "sketch 1",
    rectangleSketch(
      "comp-block",
      { x: 0, y: 0 },
      { x: 71.6, y: 51.6 },
      { spanX: CASE_L, spanY: CASE_W },
    ),
  );
  builders.body("body_comp_block", "drafted 1");
  builders.feature(
    createFeatureId("feat_comp_block"),
    "extrude",
    [
      { kind: "sketch", id: skdBlock },
      { kind: "parameter", id: depthBlock },
    ],
    ["body_comp_block"],
  );

  const depthCavity = createParameterId("param_comp_cavityDrop");
  builders.parameter(depthCavity, "cavityDrop", length(-34.4));
  const skdCavity = createSketchDocumentId("skd_comp_cavity");
  builders.sketch(
    skdCavity,
    "sketch 2",
    rectangleSketch("comp-cavity", { x: 0.8, y: 0.8 }, { x: 70, y: 50 }),
  );
  builders.body("body_comp_cavity", "drafted 2");
  builders.feature(
    createFeatureId("feat_comp_cavity"),
    "extrude",
    [
      { kind: "sketch", id: skdCavity },
      { kind: "parameter", id: depthCavity },
    ],
    ["body_comp_cavity"],
  );

  builders.body("body_comp_shell", "subtract 1");
  builders.feature(
    createFeatureId("feat_comp_shell"),
    "subtract",
    [
      { kind: "feature", id: createFeatureId("feat_comp_block") },
      { kind: "feature", id: createFeatureId("feat_comp_cavity") },
    ],
    ["body_comp_shell"],
  );

  const depthBrace = createParameterId("param_comp_braceDrop");
  builders.parameter(depthBrace, "braceDrop", length(-34.4));
  const skdBrace1 = createSketchDocumentId("skd_comp_brace1");
  builders.sketch(
    skdBrace1,
    "sketch 3",
    slotSketch("comp-brace1", { x: 0.4, y: 0.4 }, { x: 6.4, y: 6.4 }),
  );
  builders.body("body_comp_brace1", "drafted 3");
  builders.feature(
    createFeatureId("feat_comp_brace1"),
    "extrude",
    [
      { kind: "sketch", id: skdBrace1 },
      { kind: "parameter", id: depthBrace },
    ],
    ["body_comp_brace1"],
  );

  const dupDz = createParameterId("param_comp_dupDz");
  const dupCount = createParameterId("param_comp_dupCount");
  const dupAxis = createParameterId("param_comp_dupAxis");
  builders.parameter(dupDz, "duplicateDz", length(0));
  builders.parameter(dupCount, "duplicateCount", dimensionless(1));
  builders.parameter(dupAxis, "duplicateAxis", dimensionless(3));
  builders.body("body_comp_c1", "copy 1");
  builders.feature(
    createFeatureId("feat_comp_duplicate1"),
    "duplicate",
    [
      { kind: "feature", id: createFeatureId("feat_comp_brace1") },
      { kind: "parameter", id: RIB_STEP_X },
      { kind: "parameter", id: RIB_STEP_Y },
      { kind: "parameter", id: dupDz },
      { kind: "parameter", id: dupCount },
      { kind: "parameter", id: dupAxis },
      { kind: "parameter", id: HALF_TURN },
    ],
    ["body_comp_c1"],
  );

  const skdBrace2 = createSketchDocumentId("skd_comp_brace2");
  builders.sketch(
    skdBrace2,
    "sketch 4",
    slotSketch("comp-brace2", { x: 71.2, y: 0.4 }, { x: 65.2, y: 6.4 }),
  );
  builders.body("body_comp_brace2", "drafted 4");
  builders.feature(
    createFeatureId("feat_comp_brace2"),
    "extrude",
    [
      { kind: "sketch", id: skdBrace2 },
      { kind: "parameter", id: depthBrace },
    ],
    ["body_comp_brace2"],
  );

  builders.body("body_comp_c2", "copy 1");
  builders.feature(
    createFeatureId("feat_comp_duplicate2"),
    "duplicate",
    [
      { kind: "feature", id: createFeatureId("feat_comp_brace2") },
      { kind: "parameter", id: RIB_STEP_X },
      { kind: "parameter", id: RIB_STEP_Y },
      { kind: "parameter", id: dupDz },
      { kind: "parameter", id: dupCount },
      { kind: "parameter", id: dupAxis },
      { kind: "parameter", id: HALF_TURN },
    ],
    ["body_comp_c2"],
  );

  if (tail.kind === "none") return document;
  if (tail.kind === "four") {
    const unions: readonly (readonly [string, string, string])[] = [
      ["feat_comp_union1", "feat_comp_shell", "feat_comp_brace1"],
      ["feat_comp_union2", "feat_comp_union1", "feat_comp_duplicate1"],
      ["feat_comp_union3", "feat_comp_union2", "feat_comp_brace2"],
      ["feat_comp_union4", "feat_comp_union3", "feat_comp_duplicate2"],
    ];
    for (const [featureId, targetId, toolId] of unions) {
      builders.body(`body_comp_${featureId}`, "union");
      builders.feature(
        createFeatureId(featureId),
        "union",
        [
          { kind: "feature", id: createFeatureId(targetId) },
          { kind: "feature", id: createFeatureId(toolId) },
        ],
        [`body_comp_${featureId}`],
      );
    }
    // The board-outline trim (the chapter's trims step): the board's own
    // outline, wall-inset, extruded down postDropDown, subtracted once
    // from the fused chain.
    const depthTrim = createParameterId("param_comp_postDropDown");
    builders.parameter(depthTrim, "postDropDown", length(-25.4));
    const skdTrim = createSketchDocumentId("skd_comp_trim");
    builders.sketch(
      skdTrim,
      "sketch 5",
      rectangleSketch("comp-trim", { x: 0.8, y: 0.8 }, { x: 70, y: 50 }),
    );
    builders.body("body_comp_trim", "drafted 5");
    builders.feature(
      createFeatureId("feat_comp_trim"),
      "extrude",
      [
        { kind: "sketch", id: skdTrim },
        { kind: "parameter", id: depthTrim },
      ],
      ["body_comp_trim"],
    );
    builders.body("body_comp_trim_cut", "subtract 6");
    builders.feature(
      createFeatureId("feat_comp_trim_cut"),
      "subtract",
      [
        { kind: "feature", id: createFeatureId("feat_comp_union4") },
        { kind: "feature", id: createFeatureId("feat_comp_trim") },
      ],
      ["body_comp_trim_cut"],
    );
    return document;
  }
  // The multi tail: ONE union whose tools are brace one, its turned copy,
  // and brace two (the dialog's own multi-select shape).
  builders.body("body_comp_union_multi", "union multi");
  builders.feature(
    createFeatureId("feat_comp_union_multi"),
    "union",
    [
      { kind: "feature", id: createFeatureId("feat_comp_shell") },
      { kind: "feature", id: createFeatureId("feat_comp_brace1") },
      { kind: "feature", id: createFeatureId("feat_comp_duplicate1") },
      { kind: "feature", id: createFeatureId("feat_comp_brace2") },
    ],
    ["body_comp_union_multi"],
  );
  return document;
}

// ---------------------------------------------------------------------------
// The in-process OCCT pass harness (the real worker's operation matrix)
// ---------------------------------------------------------------------------

let kernel: GeometryKernel;

beforeAll(async () => {
  kernel = await createOcctKernel();
});

function sceneContext(): ComputationContext {
  const solids = new Map<WorkerSolidId, KernelSolid>();
  let minted = 0;
  const mint = (handle: KernelSolid): WorkerSolidId => {
    minted += 1;
    const id = createWorkerSolidId(`wsol_comp_${String(minted)}`);
    solids.set(id, handle);
    return id;
  };
  const owned = (id: WorkerSolidId): KernelSolid => {
    const handle = solids.get(id);
    if (handle === undefined) throw new Error(`unknown solid ${id}`);
    return handle;
  };
  type SceneRequest = {
    [O in WorkerOperationId]: readonly [
      operation: O,
      input: WorkerOperationInput<O>,
    ];
  }[WorkerOperationId];
  const answer = (
    request: SceneRequest,
  ): WorkerOperationResult<SceneRequest[0]> => {
    const [operation, input] = request;
    switch (operation) {
      case "solid.extrude": {
        const extruded = kernel.extrude(input);
        if (!extruded.ok) throw new Error(extruded.error.message);
        return { solid: mint(extruded.value) };
      }
      case "solid.union": {
        const merged = kernel.union(input.operands.map(owned));
        if (!merged.ok) throw new Error(merged.error.message);
        return { solid: mint(merged.value) };
      }
      case "solid.subtract": {
        const cut = kernel.subtract(
          owned(input.target),
          input.tools.map(owned),
        );
        if (!cut.ok) throw new Error(cut.error.message);
        return { solid: mint(cut.value) };
      }
      case "solid.transform": {
        const moved = kernel.transform(owned(input.solid), {
          x: input.translation.x,
          y: input.translation.y,
          z: input.translation.z,
          ...(input.rotation === undefined
            ? {}
            : {
                rotation: {
                  axis: input.rotation.axis,
                  angle: input.rotation.angle,
                },
              }),
        });
        if (!moved.ok) throw new Error(moved.error.message);
        return { solid: mint(moved.value) };
      }
      case "solid.volume": {
        const measured = kernel.volume(owned(input.solid));
        if (!measured.ok) throw new Error(measured.error.message);
        return { volume: measured.value };
      }
      case "solid.area": {
        const measured = kernel.area(owned(input.solid));
        if (!measured.ok) throw new Error(measured.error.message);
        return { area: measured.value };
      }
      case "solid.bounds": {
        const measured = kernel.bounds(owned(input.solid));
        if (!measured.ok) throw new Error(measured.error.message);
        return { bounds: measured.value };
      }
      case "solid.tessellate": {
        const tessellated = kernel.tessellate(owned(input.solid));
        if (!tessellated.ok) throw new Error(tessellated.error.message);
        return { tessellation: tessellated.value };
      }
      default:
        throw new Error(`the composition harness lacks ${operation}`);
    }
  };
  return {
    revision: createRevisionTag(0),
    request: <O extends WorkerOperationId>(
      operation: O,
      input: WorkerOperationInput<O>,
    ): Promise<WorkerOperationResult<O>> =>
      Promise.resolve(
        answer([operation, input] as SceneRequest) as WorkerOperationResult<O>,
      ),
  };
}

type PassResult = Awaited<ReturnType<typeof computeDocumentScene>>;

/** One full pass: the request list of `document`, computed and measured. */
async function runPass(document: CadDocument): Promise<PassResult> {
  const bodies = documentSceneBodies(document, new Set(), null);
  return computeDocumentScene(
    sceneContext(),
    bodies,
    new Set(document.bodies.map((body) => body.id)),
  );
}

/** The per-body measurement of one body id in a pass result. */
function bodyOf(
  result: PassResult,
  bodyId: string,
): {
  readonly volume: number;
  readonly min: readonly number[];
  readonly max: readonly number[];
} {
  const body = result.bodies.find((entry) => entry.bodyId === bodyId);
  if (body === undefined) {
    throw new Error(`body ${bodyId} rendered nothing this pass`);
  }
  return {
    volume: body.measurement.volume,
    min: body.measurement.bounds.min,
    max: body.measurement.bounds.max,
  };
}

function expectBoundsClose(
  actual: readonly number[],
  expected: readonly number[],
): void {
  for (const [index, value] of expected.entries()) {
    expect(actual[index]).toBeCloseTo(value, 6);
  }
}

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

describe("the document pass over the chapter's complex shape (Phase 32b)", () => {
  it("composes the variables and expressions onto the document", () => {
    // The variable system rides EVERY build; asserting it here keeps the
    // other tests' parameter-edit re-drive honest about what it edits.
    const document = chapterDocument({ kind: "none" });
    const read = (id: ParameterId): number => {
      const parameter = document.parameters.parameters.find(
        (entry) => entry.id === id,
      );
      if (parameter === undefined) throw new Error("parameter vanished");
      return parameter.value.value;
    };
    expect(read(CASE_L)).toBeCloseTo(71.6, 9);
    expect(read(RIB_STEP_X)).toBeCloseTo(-71.6, 9);
    expect(read(RIB_STEP_Y)).toBeCloseTo(-51.6, 9);
  });

  it("the posts-two scene lands both turned copies on their far corners", async () => {
    const document = chapterDocument({ kind: "none" });
    const result = await runPass(document);
    expect(result.failures).toEqual([]);
    // The copies must sit exactly at T(p) = (caseL − px, caseW − py) — the
    // displaced landing the record's probes caught read bounds min
    // (−143.2, −58.4); the correct copy one is [64.8, 44.8]..[71.6, 51.6].
    const copy1 = bodyOf(result, "body_comp_c1");
    expectBoundsClose(copy1.min, [64.8, 44.8, -34.4]);
    expectBoundsClose(copy1.max, [71.6, 51.6, 0]);
    const copy2 = bodyOf(result, "body_comp_c2");
    // T maps brace two's near cap (71.2, 0.4) to (0.4, 51.2) and its far
    // cap (65.2, 6.4) to (6.4, 45.2): the y-far corner's flipped diagonal.
    expectBoundsClose(copy2.min, [0, 44.8, -34.4]);
    expectBoundsClose(copy2.max, [6.8, 51.6, 0]);
  });

  it("the fused chain trims to the ledger: four open ribs sheared to boardLift", async () => {
    const document = chapterDocument({ kind: "four" });
    const result = await runPass(document);
    expect(result.failures).toEqual([]);
    // Before the fix the unions over the copies silently declined: the
    // copies and brace two rendered as independent FULL stadiums and the
    // aggregate read shell + 3 full + 1 open (12,099.844 in the chapter).
    // The composed truth: every union admits, the copies ride consumed-
    // only, and ONE trimmed tip renders at the chapter's ledger volume
    // (12,010.693 fused, 11,357.708 after the board-outline shear).
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]?.bodyId).toBe("body_comp_trim_cut");
    expectVolumeNear(result.volume, TRIMMED_VOLUME);
  });

  it("a multi-tool union composes every declared tool in one scene", async () => {
    const document = chapterDocument({ kind: "multi" });
    const bodies = documentSceneBodies(document, new Set(), null);
    const multi = bodies.find(
      (entry) => entry.bodyId === "body_comp_union_multi",
    );
    if (multi === undefined || multi.scene.kind !== "boolean") {
      throw new Error("the multi-tool union lost its scene");
    }
    expect(multi.scene.request.tools).toHaveLength(3);
    // Tool order follows the commit: brace one (a plain-extrude
    // derivation), the turned copy (the computed handoff), brace two.
    expect(multi.scene.request.tools[0]?.kind).toBe("extrude");
    expect(multi.scene.request.tools[1]).toEqual({
      kind: "computed",
      bodyId: "body_comp_c1",
    });
    expect(multi.scene.request.tools[2]?.kind).toBe("extrude");
    const result = await computeDocumentScene(
      sceneContext(),
      bodies,
      new Set(document.bodies.map((body) => body.id)),
    );
    expect(result.failures).toEqual([]);
    // Two rendered bodies: the fused multi-tool union AND brace two's
    // turned copy (the multi tail leaves the second duplicate unconsumed —
    // it renders beside the fusion as its own tip, full stadium).
    expect(result.bodies.map((body) => body.bodyId)).toEqual([
      "body_comp_c2",
      "body_comp_union_multi",
    ]);
    // The shell plus the three tools' open-cavity material (brace one, its
    // turned copy, brace two — the fourth corner's brace is absent here),
    // and copy two's own full stadium on the stage.
    expectVolumeNear(
      result.volume,
      SHELL_VOLUME + 3 * STRIP_UNION_VOLUME + STRIP_BODY_VOLUME,
    );
  });

  it("the re-drive moves the copies: parameter edits between dispatches", async () => {
    // The union-free tail renders the copies as tips, so the passes can
    // pin their placed bounds across the edit.
    const document = chapterDocument({ kind: "none" });
    const before = await runPass(document);
    expect(before.failures).toEqual([]);
    const copy1Before = bodyOf(before, "body_comp_c1");
    expectBoundsClose(copy1Before.min, [64.8, 44.8, -34.4]);

    // The chapter's demo commit: the manager's expression editor sets the
    // ROOT's expression to a constant (85mm) — the commit that runs the
    // topological recompute — so caseL re-derives to 86.6 and the
    // duplicate's `$ribStepX` follows on the next dispatch.
    const edited = requireOk(
      applyCommand(document, {
        type: "parameter.set",
        id: BOARD_L,
        expression: requireOk(parseExpression("85mm")),
      }),
    );
    const caseL = edited.parameters.parameters.find(
      (parameter) => parameter.id === CASE_L,
    );
    if (caseL === undefined) throw new Error("caseL vanished");
    expect(caseL.value.value).toBeCloseTo(86.6, 9);

    const after = await runPass(edited);
    expect(after.failures).toEqual([]);
    // The block's x-span re-solved to 86.6 (boardW is untouched — caseW
    // stays 51.6), and the copy follows the case's new step: the plan
    // translation rides R·d = (86.6, 51.6) with the half turn, so
    // T(p) = (86.6 − px, 51.6 − py).
    const copy1After = bodyOf(after, "body_comp_c1");
    expectBoundsClose(copy1After.min, [86.6 - 6.8, 51.6 - 6.8, -34.4]);
    expectBoundsClose(copy1After.max, [86.6, 51.6, 0]);
  });
});
