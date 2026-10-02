/**
 * The duplicate & transform wiring tests (Phase 60): the action-time
 * validation battery, the multi-copy scene reader (per-copy placements
 * from the bridge's shared T^i plan, live parameter reads so a `$var`
 * re-drives), the copy bodies' computable-operand status (the verb's
 * iterative use), the document scene's source-stays-tip rule, and the
 * engine handler's commit shape — literal auto-parameters, `$name`
 * references, `-$name` negated expressions, the identity/over-cap
 * refusals, and the by-body source reference a duplicate of a copy
 * carries.
 *
 * The engine's worker session is stubbed (the engine test's discipline):
 * the handler and the readers under test are pure document data.
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
  addBody,
  addDocumentParameter,
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
  type CadDocument,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureInputRef } from "@slopcad/cad-core";

vi.mock("../render-fixture/fixture-session", () => ({
  bootRenderFixtureSession: (): {
    dispatch(): void;
    dispatchDocument(): void;
    dispose(): void;
  } => ({
    dispatch: () => {},
    dispatchDocument: () => {},
    dispose: () => {},
  }),
  faceAnchorSurface: (): string => "[]",
}));

import { documentSceneBodies } from "./document-scene";
import {
  documentDuplicateSceneRequests,
  DUPLICATE_DEFAULTS,
  validateDuplicateSubmission,
  type DuplicateSubmission,
} from "./duplicate";
import { sceneOperandOfBody } from "./extrude";
import { useWorkbenchEngine, WorkbenchStoreProvider } from "./workbench-engine";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The seeded documents (pure cad-core builders)
// ---------------------------------------------------------------------------

const pDepth = createParameterId("param_dupw_depth");
const pDx = createParameterId("param_dupw_dx");
const pCount = createParameterId("param_dupw_count");
const pAxis = createParameterId("param_dupw_axis");
const pAngle = createParameterId("param_dupw_angle");
const bBase = createBodyId("body_dupw_base");
const fBase = createFeatureId("feat_dupw_base");
const fDuplicate = createFeatureId("feat_dupw_duplicate");

/** A 20×15 rectangle on the XY workplane, serialized. */
function rectangleSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_dupw-bottom");
  const right = createSketchEntityId("skent_dupw-right");
  const top = createSketchEntityId("skent_dupw-top");
  const left = createSketchEntityId("skent_dupw-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 0, y: 0 }, { x: 20, y: 0 }),
      createLineEntity(right, { x: 20, y: 0 }, { x: 20, y: 15 }),
      createLineEntity(top, { x: 20, y: 15 }, { x: 0, y: 15 }),
      createLineEntity(left, { x: 0, y: 15 }, { x: 0, y: 0 }),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** The base document: one saved sketch + its extrude (a computable body). */
function baseDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_workbench_dup"));
  const added = addDocumentSketch(document, {
    id: createSketchDocumentId("skd_dupw_profile"),
    name: "profile",
    sketch: rectangleSketchPayload(),
  });
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  const parameter = addDocumentParameter(document, {
    id: pDepth,
    name: "depth",
    value: length(10),
  });
  if (!parameter.ok) throw new Error(parameter.error.message);
  document = parameter.value.document;
  const body = addBody(document, { id: bBase, name: "base" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const featured = addFeature(document, {
    id: fBase,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: createSketchDocumentId("skd_dupw_profile") },
      { kind: "parameter", id: pDepth },
    ],
    outputs: [bBase],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

/** Adds a duplicate feature (+ its six parameters) over the base extrude. */
function withDuplicate(
  document: CadDocument,
  spec: {
    readonly dxMm: number;
    readonly count: number;
    readonly axis: number;
    readonly angleDeg: number;
    readonly sourceRef?: FeatureInputRef;
    readonly outputs?: readonly string[];
  },
): CadDocument {
  let worked = document;
  for (const [id, name, value] of [
    [pDx, "duplicateDx", length(spec.dxMm)],
    [pCount, "duplicateCount", dimensionless(spec.count)],
    [pAxis, "duplicateAxis", dimensionless(spec.axis)],
    [pAngle, "duplicateAngle", angle(spec.angleDeg, "deg")],
  ] as const) {
    const added = addDocumentParameter(worked, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    worked = added.value.document;
  }
  const dyAdded = addDocumentParameter(worked, {
    id: createParameterId("param_dupw_dy"),
    name: "duplicateDy",
    value: length(0),
  });
  if (!dyAdded.ok) throw new Error(dyAdded.error.message);
  worked = dyAdded.value.document;
  const dzAdded = addDocumentParameter(worked, {
    id: createParameterId("param_dupw_dz"),
    name: "duplicateDz",
    value: length(0),
  });
  if (!dzAdded.ok) throw new Error(dzAdded.error.message);
  worked = dzAdded.value.document;
  const copyBodies = (spec.outputs ?? []).map((id) => createBodyId(id));
  for (const [index, bodyId] of copyBodies.entries()) {
    const added = addBody(worked, {
      id: bodyId,
      name: `copy ${String(index + 1)}`,
    });
    if (!added.ok) throw new Error(added.error.message);
    worked = added.value.document;
  }
  const featured = addFeature(worked, {
    id: fDuplicate,
    kind: "duplicate",
    inputs: [
      spec.sourceRef ?? { kind: "feature", id: fBase },
      { kind: "parameter", id: pDx },
      { kind: "parameter", id: createParameterId("param_dupw_dy") },
      { kind: "parameter", id: createParameterId("param_dupw_dz") },
      { kind: "parameter", id: pCount },
      { kind: "parameter", id: pAxis },
      { kind: "parameter", id: pAngle },
    ],
    outputs: copyBodies,
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

// ---------------------------------------------------------------------------
// The validation battery
// ---------------------------------------------------------------------------

describe("validateDuplicateSubmission: the literal battery", () => {
  const valid: DuplicateSubmission = {
    sourceBodyId: bBase,
    dxMm: 15,
    dyMm: 0,
    dzMm: 0,
    axis: 3,
    angleDeg: 0,
    count: 3,
  };

  it("accepts the literal transform", () => {
    expect(validateDuplicateSubmission(valid)).toEqual({ ok: true });
  });

  it("refuses a non-finite offset", () => {
    const result = validateDuplicateSubmission({
      ...valid,
      dxMm: Number.NaN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("finite");
  });

  it("refuses a count outside 1..64", () => {
    const high = validateDuplicateSubmission({ ...valid, count: 65 });
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.message).toContain("between 1 and 64");
    const fractional = validateDuplicateSubmission({ ...valid, count: 2.5 });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.message).toContain("whole number");
  });

  it("refuses an off-domain axis and a missing source", () => {
    const axis = validateDuplicateSubmission({
      ...valid,
      axis: 7 as typeof valid.axis,
    });
    expect(axis.ok).toBe(false);
    if (!axis.ok) expect(axis.message).toContain("world axis");
    const source = validateDuplicateSubmission({ ...valid, sourceBodyId: "" });
    expect(source.ok).toBe(false);
    if (!source.ok) expect(source.message).toContain("source body");
  });
});

// ---------------------------------------------------------------------------
// The scene reader
// ---------------------------------------------------------------------------

describe("documentDuplicateSceneRequests: the per-copy T^i placements", () => {
  it("reads a translate ×3 as three copy scenes at 15/30/45 mm", () => {
    const document = withDuplicate(baseDocument(), {
      dxMm: 15,
      count: 3,
      axis: 3,
      angleDeg: 0,
      outputs: ["body_dupw_c1", "body_dupw_c2", "body_dupw_c3"],
    });
    const requests = documentDuplicateSceneRequests(document);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.ordinal)).toEqual([1, 2, 3]);
    expect(requests[0]?.translationMm).toEqual([15, 0, 0]);
    expect(requests[1]?.translationMm).toEqual([30, 0, 0]);
    expect(requests[2]?.translationMm).toEqual([45, 0, 0]);
    for (const request of requests) {
      expect(request.rotation).toBeUndefined();
      expect(request.base.kind).toBe("extrude");
    }
    expect(requests[2]?.bodyId).toBe(createBodyId("body_dupw_c3"));
  });

  it("reads a rotate 90° ×3 with the four-corner cumulative translations", () => {
    const document = withDuplicate(baseDocument(), {
      dxMm: 15,
      count: 3,
      axis: 3,
      angleDeg: 90,
      outputs: ["body_dupw_c1", "body_dupw_c2", "body_dupw_c3"],
    });
    const requests = documentDuplicateSceneRequests(document);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.translationMm[0]).toBeCloseTo(0, 9);
    expect(requests[0]?.translationMm[1]).toBeCloseTo(15, 9);
    expect(requests[1]?.translationMm[0]).toBeCloseTo(-15, 9);
    expect(requests[1]?.translationMm[1]).toBeCloseTo(15, 9);
    expect(requests[2]?.translationMm[0]).toBeCloseTo(-15, 9);
    expect(requests[2]?.translationMm[1]).toBeCloseTo(0, 9);
    for (const [index, request] of requests.entries()) {
      expect(request.rotation?.axis).toEqual([0, 0, 1]);
      expect(request.rotation?.angleRad).toBeCloseTo(
        ((index + 1) * Math.PI) / 2,
        12,
      );
    }
  });

  it("re-reads live parameter values: the $var re-drive moves the copies", () => {
    const document = withDuplicate(baseDocument(), {
      dxMm: 15,
      count: 3,
      axis: 3,
      angleDeg: 0,
      outputs: ["body_dupw_c1", "body_dupw_c2", "body_dupw_c3"],
    });
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pDx,
      value: length(5),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const requests = documentDuplicateSceneRequests(edited.value);
    expect(requests[2]?.translationMm).toEqual([15, 0, 0]);
  });

  it("declines a feature whose parameters no longer read", () => {
    const document = withDuplicate(baseDocument(), {
      dxMm: 15,
      count: 2,
      axis: 3,
      angleDeg: 0,
      outputs: ["body_dupw_c1", "body_dupw_c2"],
    });
    const broken = applyCommand(document, {
      type: "parameter.set",
      id: pAxis,
      value: dimensionless(9),
    });
    if (!broken.ok) throw new Error(broken.error.message);
    expect(documentDuplicateSceneRequests(broken.value)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The operand + scene integration
// ---------------------------------------------------------------------------

describe("the duplicate document's scene integration", () => {
  it("makes copy bodies computable operands — a copy can be re-duplicated", () => {
    const copies = withDuplicate(baseDocument(), {
      dxMm: 15,
      count: 3,
      axis: 3,
      angleDeg: 0,
      outputs: ["body_dupw_c1", "body_dupw_c2", "body_dupw_c3"],
    });
    const copy1 = createBodyId("body_dupw_c1");
    const operand = sceneOperandOfBody(copies, copy1);
    expect(operand).not.toBeNull();
    expect(operand?.kind).toBe("computed");
  });

  it("renders the copies AND the source beside them (the source stays a tip)", () => {
    const copies = withDuplicate(baseDocument(), {
      dxMm: 15,
      count: 3,
      axis: 3,
      angleDeg: 0,
      outputs: ["body_dupw_c1", "body_dupw_c2", "body_dupw_c3"],
    });
    const bodies = documentSceneBodies(copies, new Set(), null);
    const byId = new Map(bodies.map((body) => [body.bodyId, body.scene.kind]));
    // The source's own scene (the plain extrude) is present…
    expect(byId.get(bBase)).toBe("extrude");
    // …and every copy carries its duplicate scene.
    for (const copyId of ["body_dupw_c1", "body_dupw_c2", "body_dupw_c3"]) {
      expect(byId.get(createBodyId(copyId))).toBe("duplicate");
    }
    // Nothing was consumed: no consumedOnly entries at all.
    for (const body of bodies) {
      expect(body.consumedOnly).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The engine handler (rendered harness)
// ---------------------------------------------------------------------------

const SEED_DEPTH = createParameterId("param_duph_depth");
const SEED_SKETCH = createSketchDocumentId("skd_duph_profile");
const SEED_BODY = createBodyId("body_duph_base");
const SEED_FEATURE = createFeatureId("feat_duph_base");
const SPACING_PARAM = createParameterId("param_duph_spacing");

/** The handler probes' captured facts. */
interface DuplicateProbe {
  readonly ok: boolean;
  readonly refusal: string | null;
  readonly featureKinds: readonly string[];
  readonly lastInputs: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  /** The last feature's input NAMES in order (parameters by name). */
  readonly lastInputNames: readonly string[];
  readonly lastOutputs: readonly string[];
  readonly bodyNames: readonly string[];
  readonly parameterFacts: Readonly<
    Record<string, { readonly mm: number; readonly expression: string | null }>
  >;
}

let lastProbe: DuplicateProbe | null = null;

function probe(): DuplicateProbe {
  if (lastProbe === null) throw new Error("the duplicate probe is absent");
  return lastProbe;
}

function HandlerHarness(): ReactElement {
  const engine = useWorkbenchEngine({
    rootId: "dup-test-root",
    statusId: "dup-test-status",
    volumeId: "dup-test-volume",
    errorId: "dup-test-error",
  });
  return (
    <div>
      <button
        type="button"
        data-testid="seed-extrude"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              {
                type: "parameter.create",
                id: SEED_DEPTH,
                name: "seedDepth",
                value: length(10),
              },
              {
                type: "sketch.create",
                id: SEED_SKETCH,
                name: "dup profile",
                sketch: rectangleSketchPayload(),
              },
              { type: "body.create", id: SEED_BODY, name: "dup base" },
              {
                type: "feature.create",
                id: SEED_FEATURE,
                kind: "extrude",
                inputs: [
                  { kind: "sketch", id: SEED_SKETCH },
                  { kind: "parameter", id: SEED_DEPTH },
                ],
                outputs: [SEED_BODY],
              },
            ],
          });
          if (!applied.ok) throw new Error("the seed was refused");
        }}
      />
      <button
        type="button"
        data-testid="seed-spacing"
        onClick={() => {
          const applied = engine.documentApi.applyTransaction({
            commands: [
              {
                type: "parameter.create",
                id: SPACING_PARAM,
                name: "spacing",
                value: length(20),
              },
            ],
          });
          if (!applied.ok) throw new Error("the spacing seed was refused");
        }}
      />
      <button
        type="button"
        data-testid="run-duplicate"
        onClick={() => {
          const outcome = engine.handleDuplicate({
            sourceBodyId: "body_duph_base",
            dxMm: 15,
            dyMm: 0,
            dzMm: 0,
            axis: 3,
            angleDeg: 0,
            count: 3,
          });
          lastProbe = probeOf(engine, outcome);
        }}
      />
      <button
        type="button"
        data-testid="run-duplicate-ref"
        onClick={() => {
          const outcome = engine.handleDuplicate({
            sourceBodyId: "body_duph_base",
            dxMm: "$spacing",
            dyMm: 0,
            dzMm: 0,
            axis: 3,
            angleDeg: 0,
            count: 2,
          });
          lastProbe = probeOf(engine, outcome);
        }}
      />
      <button
        type="button"
        data-testid="run-duplicate-negated"
        onClick={() => {
          const outcome = engine.handleDuplicate({
            sourceBodyId: "body_duph_base",
            dxMm: "-$spacing",
            dyMm: 0,
            dzMm: 0,
            axis: 3,
            angleDeg: 0,
            count: 1,
          });
          lastProbe = probeOf(engine, outcome);
        }}
      />
      <button
        type="button"
        data-testid="run-duplicate-identity"
        onClick={() => {
          const outcome = engine.handleDuplicate({
            sourceBodyId: "body_duph_base",
            dxMm: 0,
            dyMm: 0,
            dzMm: 0,
            axis: 3,
            angleDeg: 0,
            count: 2,
          });
          lastProbe = probeOf(engine, outcome);
        }}
      />
      <button
        type="button"
        data-testid="run-duplicate-copy"
        onClick={() => {
          // The ITERATIVE use: duplicate copy 1 of the first duplicate.
          const outcome = engine.handleDuplicate({
            sourceBodyId: "body_dup_c1",
            dxMm: 0,
            dyMm: 10,
            dzMm: 0,
            axis: 3,
            angleDeg: 0,
            count: 1,
          });
          lastProbe = probeOf(engine, outcome);
        }}
      />
      <div data-testid="probe-scene">{engine.activeScene}</div>
    </div>
  );
}

/** Captures the post-commit document facts a duplicate button asserts on. */
function probeOf(
  engine: ReturnType<typeof useWorkbenchEngine>,
  outcome: {
    readonly ok: boolean;
    readonly code?: string;
    readonly message?: string;
  },
): DuplicateProbe {
  const doc = engine.store.getDocument();
  const parameterFacts: Record<
    string,
    { readonly mm: number; readonly expression: string | null }
  > = {};
  const nameById = new Map<string, string>();
  for (const parameter of doc.parameters.parameters) {
    parameterFacts[parameter.name] = {
      mm: parameter.value.value,
      expression:
        parameter.expression === null
          ? null
          : (() => {
              const printed = parameter.expression;
              return `${printed.kind}`;
            })(),
    };
    nameById.set(parameter.id, parameter.name);
  }
  return {
    ok: outcome.ok,
    refusal:
      outcome.ok || outcome.code === undefined || outcome.message === undefined
        ? null
        : `${outcome.code}: ${outcome.message}`,
    featureKinds: doc.features.map((feature) => feature.kind),
    lastInputs: doc.features.at(-1)?.inputs ?? [],
    lastInputNames: (doc.features.at(-1)?.inputs ?? []).map(
      (ref) => nameById.get(ref.id) ?? ref.id,
    ),
    lastOutputs: doc.features.at(-1)?.outputs ?? [],
    bodyNames: doc.bodies.map((body) => body.name),
    parameterFacts,
  };
}

describe("the engine's duplicate handler", () => {
  it("commits literal copies: one output body per copy, auto-parameters, feature ref", async () => {
    render(
      <WorkbenchStoreProvider>
        <HandlerHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-extrude"));
    fireEvent.click(screen.getByTestId("run-duplicate"));
    const captured = probe();
    expect(captured.ok).toBe(true);
    expect(captured.featureKinds.at(-1)).toBe("duplicate");
    // One output body per copy, named copy 1..3.
    expect(captured.lastOutputs).toHaveLength(3);
    expect(captured.bodyNames).toContain("copy 1");
    expect(captured.bodyNames).toContain("copy 3");
    // The input layout: source + dx/dy/dz/count/AXIS/ANGLE — the bridge's
    // documented positional order (the axis-selector-last convention) and
    // the exact regression pin: a swapped axis/angle pair reads as the
    // wrong dimensions everywhere and builds nothing.
    expect(captured.lastInputs).toHaveLength(7);
    expect(captured.lastInputNames).toEqual([
      SEED_FEATURE,
      "duplicateDx",
      "duplicateDy",
      "duplicateDz",
      "duplicateCount",
      "duplicateAxis",
      "duplicateAngle",
    ]);
    expect(captured.lastInputs[0]).toEqual({
      kind: "feature",
      id: SEED_FEATURE,
    });
    // The literal auto-parameters carry the step's values.
    expect(captured.parameterFacts.duplicateDx?.mm).toBe(15);
    expect(captured.parameterFacts.duplicateCount?.mm).toBe(3);
    expect(captured.parameterFacts.duplicateAxis?.mm).toBe(3);
    // The scene switched to the duplicate composition (React commits the
    // state asynchronously — wait for the re-render).
    await waitFor(() => {
      expect(screen.getByTestId("probe-scene").textContent).toBe("duplicate");
    });
  });

  it("carries a $name reference: no parameter created, the input rides it", () => {
    render(
      <WorkbenchStoreProvider>
        <HandlerHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-extrude"));
    fireEvent.click(screen.getByTestId("seed-spacing"));
    fireEvent.click(screen.getByTestId("run-duplicate-ref"));
    const captured = probe();
    expect(captured.ok).toBe(true);
    expect(captured.parameterFacts.spacing?.mm).toBe(20);
    expect(captured.parameterFacts.duplicateDx).toBeUndefined();
    // The dx input references the EXISTING spacing parameter.
    expect(captured.lastInputs[1]).toEqual({
      kind: "parameter",
      id: SPACING_PARAM,
    });
    expect(captured.lastOutputs).toHaveLength(2);
  });

  it("carries a -$name negated reference: an auto-parameter with the negation", () => {
    render(
      <WorkbenchStoreProvider>
        <HandlerHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-extrude"));
    fireEvent.click(screen.getByTestId("seed-spacing"));
    fireEvent.click(screen.getByTestId("run-duplicate-negated"));
    const captured = probe();
    expect(captured.ok).toBe(true);
    // The fresh auto-parameter holds the negated seed and the input
    // references THAT (the sign survives only through its expression).
    const negated = captured.parameterFacts.duplicateDx;
    expect(negated?.mm).toBe(-20);
    expect(captured.lastInputs[1]?.kind).toBe("parameter");
    expect(captured.lastInputs[1]?.id).not.toBe(SPACING_PARAM);
  });

  it("refuses the identity transform and commits nothing", () => {
    render(
      <WorkbenchStoreProvider>
        <HandlerHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-extrude"));
    fireEvent.click(screen.getByTestId("run-duplicate-identity"));
    const captured = probe();
    expect(captured.ok).toBe(false);
    expect(captured.refusal).toContain("identity");
    expect(captured.featureKinds).not.toContain("duplicate");
  });

  it("references a copy BY BODY (a multi-output producer resolves by id)", () => {
    render(
      <WorkbenchStoreProvider>
        <HandlerHarness />
      </WorkbenchStoreProvider>,
    );
    fireEvent.click(screen.getByTestId("seed-extrude"));
    fireEvent.click(screen.getByTestId("run-duplicate"));
    fireEvent.click(screen.getByTestId("run-duplicate-copy"));
    const captured = probe();
    expect(captured.ok).toBe(true);
    // The second duplicate's source input is the COPY BODY — a feature ref
    // would resolve to the first output, a different body than picked.
    expect(captured.lastInputs[0]).toEqual({
      kind: "body",
      id: createBodyId("body_dup_c1"),
    });
  });
});

describe("the duplicate form defaults", () => {
  it("step 15 mm along x, three copies, no rotation", () => {
    expect(DUPLICATE_DEFAULTS).toEqual({
      dxMm: 15,
      dyMm: 0,
      dzMm: 0,
      axis: 3,
      angleDeg: 0,
      count: 3,
    });
  });
});
