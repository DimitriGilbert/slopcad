/**
 * The workbench Phase 43 pattern & mirror wiring tests: the document
 * readers that turn the patternFeature, patternPath, and mirror features
 * into their worker-scene requests (each paired with the LAST extrude,
 * the thread precedent), the greedy leg parse the patternFeature reader
 * shares with the bridge, and the action-time validation batteries'
 * structured refusals.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  DATUM_FORMAT_VERSION,
  dimensionless,
  length,
  type CadDocument,
  type FeatureInputRef,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

import {
  documentMirrorSceneRequest,
  documentPatternFeatureSceneRequest,
  documentPatternPathSceneRequest,
  validateMirrorSubmission,
  validatePatternPathSubmission,
  validatePatternSubmission,
} from "./pattern";

/** The straight-up path sketch: (0,0) → (0,30), the walk's +z tangent. */
function straightPathSketch(): Record<string, unknown> {
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(
        createSketchEntityId("skent_path"),
        { x: 0, y: 0 },
        { x: 0, y: 30 },
      ),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

const pDepth = createParameterId("param_p43w_depth");
const bBase = createBodyId("body_p43w_base");
const fBase = createFeatureId("feat_p43w_base");

/** The base document: one saved square sketch, one extrude feature. */
function baseDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_workbench_p43"));
  const square = createSketch(
    xyWorkplane(),
    [
      createLineEntity(
        createSketchEntityId("skent_sq-a"),
        { x: -3, y: -3 },
        { x: 3, y: -3 },
      ),
      createLineEntity(
        createSketchEntityId("skent_sq-b"),
        { x: 3, y: -3 },
        { x: 3, y: 3 },
      ),
      createLineEntity(
        createSketchEntityId("skent_sq-c"),
        { x: 3, y: 3 },
        { x: -3, y: 3 },
      ),
      createLineEntity(
        createSketchEntityId("skent_sq-d"),
        { x: -3, y: 3 },
        { x: -3, y: -3 },
      ),
    ],
    [],
  );
  if (!square.ok) throw new Error(square.error.message);
  const added = addDocumentSketch(document, {
    id: createSketchDocumentId("skd_profile"),
    name: "profile",
    sketch: serializeSketch(square.value) as unknown as Record<string, unknown>,
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
      { kind: "sketch", id: createSketchDocumentId("skd_profile") },
      { kind: "parameter", id: pDepth },
    ],
    outputs: [bBase],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

describe("documentPatternFeatureSceneRequest: the scene reader", () => {
  /** Builds the pattern document: base + leg triples + skip ordinals. */
  function patternDocument(
    legs: readonly {
      readonly directionDeg: number;
      readonly count: number;
      readonly spacingMm: number;
    }[],
    skips: readonly number[],
  ): CadDocument {
    let document = baseDocument();
    const appended: FeatureInputRef[] = [];
    let index = 0;
    for (const leg of legs) {
      for (const [role, value] of [
        ["direction", angle(leg.directionDeg, "deg")],
        ["count", dimensionless(leg.count)],
        ["spacing", length(leg.spacingMm)],
      ] as const) {
        const id = createParameterId(`param_p43w_${role}${String(index)}`);
        const added = addDocumentParameter(document, {
          id,
          name: `${role}${String(index)}`,
          value,
        });
        if (!added.ok) throw new Error(added.error.message);
        document = added.value.document;
        appended.push({ kind: "parameter", id });
      }
      index += 1;
    }
    for (const [skipIndex, skip] of skips.entries()) {
      const id = createParameterId(`param_p43w_skip${String(skipIndex)}`);
      const added = addDocumentParameter(document, {
        id,
        name: `skip${String(skipIndex)}`,
        value: dimensionless(skip),
      });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
      appended.push({ kind: "parameter", id });
    }
    const body = addBody(document, {
      id: createBodyId("body_p43w_pattern"),
      name: "pattern",
    });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const featured = addFeature(document, {
      id: createFeatureId("feat_p43w_pattern"),
      kind: "patternFeature",
      inputs: [{ kind: "feature", id: fBase }, ...appended],
      outputs: [createBodyId("body_p43w_pattern")],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    return featured.value.document;
  }

  it("reads one leg's direction, count, and spacing against the base", () => {
    const request = documentPatternFeatureSceneRequest(
      patternDocument([{ directionDeg: 0, count: 3, spacingMm: 20 }], []),
    );
    expect(request).not.toBeNull();
    expect(request?.legs).toEqual([
      { directionRad: 0, count: 3, spacingMm: 20 },
    ]);
    expect(request?.skips).toEqual([]);
    expect(request?.base.distanceMm).toBe(10);
  });

  it("greedily parses two legs then the trailing skips (the bridge's rule)", () => {
    const request = documentPatternFeatureSceneRequest(
      patternDocument(
        [
          { directionDeg: 0, count: 3, spacingMm: 20 },
          { directionDeg: 90, count: 2, spacingMm: 15 },
        ],
        [1, 4],
      ),
    );
    expect(request?.legs).toEqual([
      { directionRad: 0, count: 3, spacingMm: 20 },
      { directionRad: Math.PI / 2, count: 2, spacingMm: 15 },
    ]);
    expect(request?.skips).toEqual([1, 4]);
  });

  it("returns null without a base extrusion to repeat", () => {
    const document = createDocument(
      createDocumentId("doc_workbench_p43_empty"),
    );
    expect(documentPatternFeatureSceneRequest(document)).toBeNull();
  });
});

describe("documentPatternPathSceneRequest: the scene reader", () => {
  /** Builds the path-pattern document: base + path sketch + three numbers. */
  function pathDocument(
    count: number,
    spacingMm: number,
    orientation: number,
  ): CadDocument {
    let document = baseDocument();
    const sketch = addDocumentSketch(document, {
      id: createSketchDocumentId("skd_path"),
      name: "path",
      sketch: straightPathSketch(),
    });
    if (!sketch.ok) throw new Error(sketch.error.message);
    document = sketch.value.document;
    const numbers: FeatureInputRef[] = [];
    for (const [index, value] of [
      dimensionless(count),
      length(spacingMm),
      dimensionless(orientation),
    ].entries()) {
      const id = createParameterId(`param_p43w_path${String(index)}`);
      const added = addDocumentParameter(document, {
        id,
        name: `path${String(index)}`,
        value,
      });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
      numbers.push({ kind: "parameter", id });
    }
    const body = addBody(document, {
      id: createBodyId("body_p43w_path"),
      name: "path pattern",
    });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const featured = addFeature(document, {
      id: createFeatureId("feat_p43w_path"),
      kind: "patternPath",
      inputs: [
        { kind: "feature", id: fBase },
        { kind: "sketch", id: createSketchDocumentId("skd_path") },
        ...numbers,
      ],
      outputs: [createBodyId("body_p43w_path")],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    return featured.value.document;
  }

  it("resolves the path sketch and the three numbers against the base", () => {
    const request = documentPatternPathSceneRequest(pathDocument(4, 10, 1));
    expect(request).not.toBeNull();
    expect(request?.count).toBe(4);
    expect(request?.spacingMm).toBe(10);
    expect(request?.orientation).toBe(1);
    // The straight-up chain: one line, (0,0) → (0,30) in the local frame.
    expect(request?.path).toEqual([
      { kind: "line", start: [0, 0], end: [0, 30] },
    ]);
  });

  it("carries the tangent-follow orientation through", () => {
    const request = documentPatternPathSceneRequest(pathDocument(3, 10, 2));
    expect(request?.orientation).toBe(2);
  });

  it("returns null when the orientation no longer reads", () => {
    expect(documentPatternPathSceneRequest(pathDocument(3, 10, 3))).toBeNull();
  });
});

describe("documentMirrorSceneRequest: the scene reader", () => {
  const dtmPlane = createDatumId("dtm_p43w_plane");

  /** Builds the mirror document: base + datum plane + optional merge. */
  function mirrorDocument(merge: number | null): CadDocument {
    let document = baseDocument();
    const datum = addDocumentDatum(document, {
      id: dtmPlane,
      name: "the x = 0 plane",
      datum: {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "originFrame",
        origin: [0, 0, 0],
        normal: [1, 0, 0],
        xAxis: [0, 1, 0],
      },
    });
    if (!datum.ok) throw new Error(datum.error.message);
    document = datum.value.document;
    const mergeInputs: FeatureInputRef[] = [];
    if (merge !== null) {
      const id = createParameterId("param_p43w_merge");
      const added = addDocumentParameter(document, {
        id,
        name: "merge",
        value: dimensionless(merge),
      });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
      mergeInputs.push({ kind: "parameter", id });
    }
    const body = addBody(document, {
      id: createBodyId("body_p43w_mirror"),
      name: "mirrored",
    });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const featured = addFeature(document, {
      id: createFeatureId("feat_p43w_mirror"),
      kind: "mirror",
      inputs: [
        { kind: "feature", id: fBase },
        { kind: "datum", id: dtmPlane },
        ...mergeInputs,
      ],
      outputs: [createBodyId("body_p43w_mirror")],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    return featured.value.document;
  }

  it("resolves the datum plane and the merge option against the base", () => {
    const request = documentMirrorSceneRequest(mirrorDocument(2));
    expect(request).not.toBeNull();
    expect(request?.merge).toBe(2);
    expect(request?.plane.origin).toEqual([0, 0, 0]);
    expect(request?.plane.normal).toEqual([1, 0, 0]);
  });

  it("defaults the standalone copy when the merge parameter is absent", () => {
    const request = documentMirrorSceneRequest(mirrorDocument(null));
    expect(request?.merge).toBe(1);
  });

  it("returns null when the merge no longer reads", () => {
    expect(documentMirrorSceneRequest(mirrorDocument(5))).toBeNull();
  });
});

describe("the action-time validation batteries", () => {
  it("refuses the impossible pattern submissions", () => {
    expect(validatePatternSubmission({ legs: [], skips: [] }).ok).toBe(false);
    expect(
      validatePatternSubmission({
        legs: [{ directionDeg: 0, count: 1, spacingMm: 20 }],
        skips: [],
      }).ok,
    ).toBe(false);
    expect(
      validatePatternSubmission({
        legs: [{ directionDeg: 0, count: 3, spacingMm: 0 }],
        skips: [],
      }).ok,
    ).toBe(false);
    expect(
      validatePatternSubmission({
        legs: [{ directionDeg: 0, count: 3, spacingMm: 20 }],
        skips: [3],
      }).ok,
    ).toBe(false);
    expect(
      validatePatternSubmission({
        legs: [{ directionDeg: 0, count: 3, spacingMm: 20 }],
        skips: [1, 1],
      }).ok,
    ).toBe(false);
    expect(
      validatePatternSubmission({
        legs: [{ directionDeg: 0, count: 3, spacingMm: 20 }],
        skips: [0, 1, 2],
      }).ok,
    ).toBe(false);
    const over = validatePatternSubmission({
      legs: [{ directionDeg: 0, count: 1001, spacingMm: 1 }],
      skips: [],
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain("at most 1000");
  });

  it("accepts the honest two-leg grid with skips", () => {
    expect(
      validatePatternSubmission({
        legs: [
          { directionDeg: 0, count: 3, spacingMm: 20 },
          { directionDeg: 90, count: 2, spacingMm: 15 },
        ],
        skips: [1],
      }).ok,
    ).toBe(true);
  });

  it("refuses the impossible path-pattern and mirror submissions", () => {
    expect(
      validatePatternPathSubmission({ count: 1, spacingMm: 10, orientation: 1 })
        .ok,
    ).toBe(false);
    expect(
      validatePatternPathSubmission({ count: 3, spacingMm: 0, orientation: 1 })
        .ok,
    ).toBe(false);
    expect(
      validatePatternPathSubmission({ count: 3, spacingMm: 10, orientation: 3 })
        .ok,
    ).toBe(false);
    expect(
      validatePatternPathSubmission({ count: 3, spacingMm: 10, orientation: 2 })
        .ok,
    ).toBe(true);
    expect(validateMirrorSubmission({ merge: 3 }).ok).toBe(false);
    expect(validateMirrorSubmission({ merge: 1 }).ok).toBe(true);
    expect(validateMirrorSubmission({ merge: 2 }).ok).toBe(true);
  });
});
