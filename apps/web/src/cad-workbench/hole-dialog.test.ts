/**
 * The structured hole dialog's wiring tests (Phase 42): the document →
 * structured-entry derivation — the flat/structured dispatch rule, the
 * type-directed role reading (angles in the authoring degrees), the
 * positions-sketch point reading, the datum-axis resolution, and the
 * parameter re-drive path — plus the action battery's structured refusals
 * and the sketch-points resolver against real serialized sketches.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  applyCommand,
  type AnyDimensionalValue,
  type CadDocument,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  angle,
  length,
  type FeatureRecord,
} from "@slopcad/cad-core";
import {
  createPointEntity,
  createSketch,
  createSketchEntityId,
  createLineEntity,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import {
  structuredHoleRoles,
  structuredHoleTypeOf,
  type StructuredHoleSpec,
} from "@slopcad/cad-kernel";

import {
  documentHoleSceneRequest,
  isStructuredHoleFeature,
  sketchPointsResolverOf,
  structuredHoleCutInputOfFeature,
} from "./hole";
import {
  STRUCTURED_HOLE_DEFAULTS,
  validateStructuredHoleSubmission,
  type StructuredHoleSubmission,
} from "./hole-dialog";

const DOC = createDocumentId("doc_shole_wiring");
const PROFILE = createSketchDocumentId("skd_shole_profile");
const POSITIONS = createSketchDocumentId("skd_shole_positions");
const BASE_BODY = createBodyId("body_shole_pad");
const DEPTH = createParameterId("param_shole_extrude_depth");
const EXTRUDE = createFeatureId("feat_shole_extrude");
const HOLE_BODY = createBodyId("body_shole_holed");
const HOLE = createFeatureId("feat_shole_hole");
const DATUM = createDatumId("dtm_shole_axis");

/** A 20×15 rectangle sketch on the XY workplane, serialized (the payload). */
function rectangleSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_s-bottom");
  const right = createSketchEntityId("skent_s-right");
  const top = createSketchEntityId("skent_s-top");
  const left = createSketchEntityId("skent_s-left");
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

/** A positions sketch carrying the given points (+ a decoy line). */
function pointsSketchPayload(
  points: readonly { readonly x: number; readonly y: number }[],
): Record<string, unknown> {
  const entities = [
    ...points.map((point, index) =>
      createPointEntity(createSketchEntityId(`skent_s-p${String(index)}`), {
        x: point.x,
        y: point.y,
      }),
    ),
    createLineEntity(
      createSketchEntityId("skent_s-decoy"),
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ),
  ];
  const created = createSketch(xyWorkplane(), entities, []);
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** One authoring value of a role, as the parameter record carries it. */
function roleValue(
  spec: StructuredHoleSpec,
  role: string,
  position: { readonly x: number; readonly y: number },
  axis: number,
): AnyDimensionalValue {
  switch (role) {
    case "type":
      return dimensionless(spec.type);
    case "diameter":
      return length(spec.diameterMm);
    case "depth":
      return length(spec.depthMm);
    case "tipAngle":
      return angle(spec.tipAngleDeg, "deg");
    case "cboreDiameter":
      return length(spec.cboreDiameterMm);
    case "cboreDepth":
      return length(spec.cboreDepthMm);
    case "csinkDiameter":
      return length(spec.csinkDiameterMm);
    case "csinkAngle":
      return angle(spec.csinkAngleDeg, "deg");
    case "taperAngle":
      return angle(spec.taperAngleDeg, "deg");
    case "threadMajor":
      return length(spec.threadMajorMm);
    case "threadPitch":
      return length(spec.threadPitchMm);
    case "positionX":
      return length(position.x);
    case "positionY":
      return length(position.y);
    case "axis":
      return dimensionless(axis);
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/** Builds the sketch → extrude → structured hole document. */
function buildDocument(
  spec: StructuredHoleSpec,
  options: {
    readonly position?: { readonly x: number; readonly y: number };
    readonly axis?: number;
    readonly sketchPositions?: boolean;
    readonly datumAxis?: boolean;
    readonly sketchPoints?: readonly {
      readonly x: number;
      readonly y: number;
    }[];
  } = {},
): CadDocument {
  const position = options.position ?? { x: 10, y: 7.5 };
  const axis = options.axis ?? 3;
  const type = structuredHoleTypeOf(spec.type);
  if (type === null) throw new Error("the fixture spec type must be 1–5");
  const roles = structuredHoleRoles(type, {
    sketchPositions: options.sketchPositions === true,
    datumAxis: options.datumAxis === true,
  });
  const roleIds = roles.map((role) =>
    createParameterId(`param_shole_${role.name}`),
  );
  let document = createDocument(DOC);
  const profileSketch = addDocumentSketch(document, {
    id: PROFILE,
    name: "profile",
    sketch: rectangleSketchPayload(),
  });
  if (!profileSketch.ok) throw new Error(profileSketch.error.message);
  document = profileSketch.value.document;
  if (options.sketchPositions) {
    const positionsSketch = addDocumentSketch(document, {
      id: POSITIONS,
      name: "positions",
      sketch: pointsSketchPayload(options.sketchPoints ?? [{ x: 5, y: 5 }]),
    });
    if (!positionsSketch.ok) throw new Error(positionsSketch.error.message);
    document = positionsSketch.value.document;
  }
  if (options.datumAxis) {
    const datum = addDocumentDatum(document, {
      id: DATUM,
      name: "hole axis",
      datum: {
        formatVersion: 1,
        datumType: "axis",
        definition: "twoPoints",
        first: [0, 0, 0],
        second: [0, 0, 5],
      },
    });
    if (!datum.ok) throw new Error(datum.error.message);
    document = datum.value.document;
  }
  const extrudeDepth = addDocumentParameter(document, {
    id: DEPTH,
    name: "extrudeDepth",
    value: length(10),
  });
  if (!extrudeDepth.ok) throw new Error(extrudeDepth.error.message);
  document = extrudeDepth.value.document;
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    const id = roleIds[index];
    if (role === undefined || id === undefined) continue;
    const parameter = addDocumentParameter(document, {
      id,
      name: role.name,
      value: roleValue(spec, role.name, position, axis),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const baseBody = addBody(document, { id: BASE_BODY, name: "pad" });
  if (!baseBody.ok) throw new Error(baseBody.error.message);
  document = baseBody.value.document;
  const holeBody = addBody(document, { id: HOLE_BODY, name: "holed" });
  if (!holeBody.ok) throw new Error(holeBody.error.message);
  document = holeBody.value.document;
  const holeInputs = [
    { kind: "feature" as const, id: EXTRUDE },
    ...roleIds.map((id) => ({ kind: "parameter" as const, id })),
    ...(options.sketchPositions
      ? [{ kind: "sketch" as const, id: POSITIONS }]
      : []),
    ...(options.datumAxis ? [{ kind: "datum" as const, id: DATUM }] : []),
  ];
  const extrudeFeature = addFeature(document, {
    id: EXTRUDE,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: PROFILE },
      { kind: "parameter", id: DEPTH },
    ],
    outputs: [BASE_BODY],
  });
  if (!extrudeFeature.ok) throw new Error(extrudeFeature.error.message);
  document = extrudeFeature.value.document;
  const holeFeature = addFeature(document, {
    id: HOLE,
    kind: "hole",
    inputs: holeInputs,
    outputs: [HOLE_BODY],
  });
  if (!holeFeature.ok) throw new Error(holeFeature.error.message);
  document = holeFeature.value.document;
  return document;
}

function holeFeatureOf(document: CadDocument): FeatureRecord {
  const feature = document.features.find((entry) => entry.id === HOLE);
  if (feature === undefined) throw new Error("the hole feature is absent");
  return feature;
}

describe("sketchPointsResolverOf", () => {
  it("reads the point entities of a serialized sketch, ignoring other kinds", () => {
    const document = buildDocument(STRUCTURED_HOLE_DEFAULTS.spec, {
      sketchPositions: true,
      sketchPoints: [
        { x: 5, y: 5 },
        { x: 15, y: 10 },
      ],
    });
    const resolved = sketchPointsResolverOf(document)(POSITIONS);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.points).toEqual([
      { x: 5, y: 5 },
      { x: 15, y: 10 },
    ]);
  });

  it("declines an unknown sketch record", () => {
    const document = buildDocument(STRUCTURED_HOLE_DEFAULTS.spec);
    const resolved = sketchPointsResolverOf(document)(POSITIONS);
    expect(resolved.ok).toBe(false);
  });
});

describe("the flat/structured dispatch", () => {
  it("classifies by the first parameter's dimension (the bridge's rule)", () => {
    const structured = buildDocument(STRUCTURED_HOLE_DEFAULTS.spec);
    expect(isStructuredHoleFeature(structured, holeFeatureOf(structured))).toBe(
      true,
    );
  });
});

describe("structuredHoleCutInputOfFeature", () => {
  it("reads the world form's roles, converting angles to degrees", () => {
    const spec = { ...STRUCTURED_HOLE_DEFAULTS.spec, tipAngleDeg: 118 };
    const document = buildDocument(spec);
    const entry = structuredHoleCutInputOfFeature(
      document,
      holeFeatureOf(document),
    );
    expect(entry).not.toBeNull();
    if (entry === null) return;
    expect(entry.kind).toBe("structured");
    expect(entry.spec.type).toBe(spec.type);
    expect(entry.spec.diameterMm).toBe(spec.diameterMm);
    expect(entry.spec.tipAngleDeg).toBeCloseTo(118, 9);
    expect(entry.positions).toEqual([{ x: 10, y: 7.5 }]);
    expect(entry.axis).toBe(3);
    expect(entry.datumAxis).toBeUndefined();
  });

  it("reads the sketch-positions form's many positions", () => {
    const document = buildDocument(STRUCTURED_HOLE_DEFAULTS.spec, {
      sketchPositions: true,
      sketchPoints: [
        { x: 5, y: 5 },
        { x: 15, y: 10 },
      ],
    });
    const entry = structuredHoleCutInputOfFeature(
      document,
      holeFeatureOf(document),
    );
    if (entry === null) throw new Error("the structured entry is null");
    expect(entry.positions).toEqual([
      { x: 5, y: 5 },
      { x: 15, y: 10 },
    ]);
  });

  it("reads the datum-axis form's resolved line", () => {
    const document = buildDocument(STRUCTURED_HOLE_DEFAULTS.spec, {
      datumAxis: true,
    });
    const entry = structuredHoleCutInputOfFeature(
      document,
      holeFeatureOf(document),
    );
    if (entry === null) throw new Error("the structured entry is null");
    expect(entry.datumAxis).toBeDefined();
    expect(entry.datumAxis?.direction).toEqual([0, 0, 1]);
  });

  it("returns null for a malformed role count", () => {
    const document = buildDocument(STRUCTURED_HOLE_DEFAULTS.spec);
    const malformed: CadDocument = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === HOLE
          ? {
              ...feature,
              inputs: feature.inputs.filter(
                (ref, index) => !(index === 4 && ref.kind === "parameter"),
              ),
            }
          : feature,
      ),
    };
    expect(
      structuredHoleCutInputOfFeature(malformed, holeFeatureOf(malformed)),
    ).toBeNull();
  });
});

describe("documentHoleSceneRequest (the structured entries)", () => {
  it("derives the structured entry and carries a parameter re-drive", () => {
    const spec = { ...STRUCTURED_HOLE_DEFAULTS.spec };
    const document = buildDocument(spec);
    const derived = documentHoleSceneRequest(document);
    expect(derived).not.toBeNull();
    if (derived === null) return;
    expect(derived.request.holes).toHaveLength(1);
    const entry = derived.request.holes[0];
    if (entry === undefined || !("kind" in entry)) {
      throw new Error("the entry must be structured");
    }
    expect(entry.spec.depthMm).toBe(spec.depthMm);
    // A parameter.set on the depth re-reads into the request — the
    // regeneration criterion (the flat form's precedent).
    const depthId = createParameterId("param_shole_depth");
    const set = applyCommand(document, {
      type: "parameter.set",
      id: depthId,
      value: length(9),
    });
    if (!set.ok) throw new Error(set.error.message);
    const reDriven = documentHoleSceneRequest(set.value);
    if (reDriven === null) throw new Error("the re-drive is null");
    const reEntry = reDriven.request.holes[0];
    if (reEntry === undefined || !("kind" in reEntry)) {
      throw new Error("the re-driven entry must be structured");
    }
    expect(reEntry.spec.depthMm).toBe(9);
  });
});

describe("validateStructuredHoleSubmission (the action battery)", () => {
  /** A submission over the defaults, overridable. */
  function submission(
    overrides: Partial<StructuredHoleSubmission["spec"]> = {},
  ): StructuredHoleSubmission {
    return {
      ...STRUCTURED_HOLE_DEFAULTS,
      spec: { ...STRUCTURED_HOLE_DEFAULTS.spec, ...overrides },
    };
  }

  it("accepts the defaults", () => {
    expect(validateStructuredHoleSubmission(submission())).toEqual({
      ok: true,
    });
  });

  it("refuses the shared battery's domains verbatim", () => {
    expect(
      validateStructuredHoleSubmission(submission({ depthMm: 0 })).ok,
    ).toBe(false);
    const counterbored = validateStructuredHoleSubmission(
      submission({ type: 2, cboreDiameterMm: 4 }),
    );
    expect(counterbored.ok).toBe(false);
    if (counterbored.ok) return;
    expect(counterbored.message).toContain("EXCEED");
  });

  it("refuses the axis and position domains of the submission", () => {
    const axis = validateStructuredHoleSubmission({
      ...submission(),
      axis: 9,
    });
    expect(axis.ok).toBe(false);
    if (!axis.ok) {
      expect(axis.message).toContain("X (1), Y (2), or Z (3)");
    }
    const position = validateStructuredHoleSubmission({
      ...submission(),
      positionXMm: Number.NaN,
    });
    expect(position.ok).toBe(false);
    if (!position.ok) {
      expect(position.message).toContain("finite");
    }
  });

  it("skips the spec battery for referenced roles (Phase 21) but keeps the domains", () => {
    // The diameter is a `$name` reference: its inert spec slot carries the
    // default, so the shared battery (which would judge that number) must
    // NOT run — the cross-role relations are regeneration's verdict.
    const referenced = validateStructuredHoleSubmission({
      ...submission(),
      parameterRefs: { diameter: "$caseHeight" },
    });
    expect(referenced.ok).toBe(true);
    // The submission's own domains (positions, axis) still hold on the
    // reference path.
    const withBadAxis = validateStructuredHoleSubmission({
      ...submission(),
      parameterRefs: { diameter: "$caseHeight" },
      axis: 9,
    });
    expect(withBadAxis.ok).toBe(false);
  });
});
