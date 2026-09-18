import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createFeatureId,
  createRenderProjection,
  type BodyId,
  type FeatureRecord,
  type RenderProjection,
  type SelectionReference,
  projectTessellation,
} from "@slopcad/cad-core";

import { distanceReadout } from "./distance-inspection";

const PLATE_BODY: BodyId = createBodyId("body_plate");
const PAD_FEATURE = createFeatureId("feat_extrude");
const SPLIT_FEATURE = createFeatureId("feat_split");
const MISSING_BODY = createBodyId("body_missing");

const FEATURES: readonly FeatureRecord[] = [
  { id: PAD_FEATURE, kind: "extrude", inputs: [], outputs: [PLATE_BODY] },
  {
    id: SPLIT_FEATURE,
    kind: "split",
    inputs: [],
    outputs: [PLATE_BODY, MISSING_BODY],
  },
];

/**
 * The plate scene's measured geometry: two parallel 30 × 20 quads — top at
 * z=10, bottom at z=0 — as the one rendered body. The synthetic grouping
 * yields face 0 (top) and face 1 (bottom), exactly 10 mm apart.
 */
const PLATE_PROJECTION: RenderProjection = (() => {
  const projected = projectTessellation(PLATE_BODY, {
    positions: [
      0, 0, 10, 30, 0, 10, 30, 20, 10, 0, 20, 10, 0, 0, 0, 30, 0, 0, 30, 20, 0,
      0, 20, 0,
    ],
    indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: plate object asserted");
  const assembled = createRenderProjection([projected.value], {
    kind: "perspective",
    position: [80, -80, 80],
    target: [15, 10, 5],
    up: [0, 0, 1],
    fovDeg: 40,
  });
  expect(assembled.ok).toBe(true);
  if (!assembled.ok) throw new Error("unreachable: projection asserted");
  return assembled.value;
})();

function faceRef(faceIndex: number): SelectionReference {
  return { kind: "face", bodyId: PLATE_BODY, regeneration: 0, faceIndex };
}

function readout(
  selected: readonly SelectionReference[],
  overrides: Partial<Parameters<typeof distanceReadout>[0]> = {},
): ReturnType<typeof distanceReadout> {
  return distanceReadout({
    selected,
    features: FEATURES,
    projection: PLATE_PROJECTION,
    ...overrides,
  });
}

describe("distanceReadout", () => {
  it("measures two selected faces with the unit suffix", () => {
    expect(readout([faceRef(0), faceRef(1)])).toEqual({
      text: "10.000 mm",
      source: "face ↔ face",
      declined: null,
    });
  });

  it("resolves a feature through its single output body", () => {
    const state = readout([
      { kind: "feature", featureId: PAD_FEATURE },
      faceRef(0),
    ]);
    expect(state.text).toBe("0.000 mm");
    expect(state.source).toBe("feature ↔ face");
    expect(state.declined).toBeNull();
  });

  it("measures a body against a face of itself as zero", () => {
    const state = readout([{ kind: "body", bodyId: PLATE_BODY }, faceRef(1)]);
    expect(state.text).toBe("0.000 mm");
    expect(state.source).toBe("body ↔ face");
  });

  it("shows nothing before the first settled scene", () => {
    expect(
      readout([faceRef(0), faceRef(1)], { projection: undefined }),
    ).toEqual({ text: null, source: null, declined: null });
  });

  it("shows nothing while the selection is no distance request yet", () => {
    for (const selected of [[], [faceRef(0)]]) {
      expect(readout(selected)).toEqual({
        text: null,
        source: null,
        declined: null,
      });
    }
  });

  it("declines a selection larger than a pair, structurally", () => {
    const state = readout([
      faceRef(0),
      faceRef(1),
      { kind: "body", bodyId: PLATE_BODY },
    ]);
    expect(state.text).toBeNull();
    expect(state.declined).toBe("distance/not-a-pair");
  });

  it("declines a pair the surfaces cannot resolve, structurally", () => {
    const state = readout([
      faceRef(0),
      { kind: "edge", bodyId: PLATE_BODY, regeneration: 0, edgeIndex: 0 },
    ]);
    expect(state.text).toBeNull();
    expect(state.declined).toBe("distance/unresolvable-reference");
  });

  it("declines a multi-output feature rather than guessing its body", () => {
    const state = readout([
      { kind: "feature", featureId: SPLIT_FEATURE },
      faceRef(0),
    ]);
    expect(state.text).toBeNull();
    expect(state.declined).toBe("distance/unresolvable-reference");
  });

  it("declines a face on a body the scene does not carry", () => {
    const state = readout([
      faceRef(0),
      { kind: "face", bodyId: MISSING_BODY, regeneration: 0, faceIndex: 0 },
    ]);
    expect(state.text).toBeNull();
    expect(state.declined).toBe("distance/unresolvable-reference");
  });
});
