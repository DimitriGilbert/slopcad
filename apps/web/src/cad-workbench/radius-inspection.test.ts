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

import { radiusReadout } from "./radius-inspection";

const BORE_BODY: BodyId = createBodyId("body_plate");
const PAD_FEATURE = createFeatureId("feat_extrude");
const MISSING_BODY = createBodyId("body_missing");

const FEATURES: readonly FeatureRecord[] = [
  { id: PAD_FEATURE, kind: "extrude", inputs: [], outputs: [BORE_BODY] },
];

/**
 * The measured geometry: a ⌀8 bore wall (radius 4, 63 chords per turn at
 * the shared profile convention, height 10) as the one rendered body — the
 * workbench's cylindrical pick surface. Face 0 is the wall.
 */
const BORE_PROJECTION: RenderProjection = (() => {
  const segments = 63;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (2 * Math.PI * i) / segments;
    positions.push(4 * Math.cos(angle), 4 * Math.sin(angle), 0);
  }
  for (let i = 0; i < segments; i += 1) {
    const angle = (2 * Math.PI * i) / segments;
    positions.push(4 * Math.cos(angle), 4 * Math.sin(angle), 10);
  }
  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    indices.push(i, next, segments + next, i, segments + next, segments + i);
  }
  const projected = projectTessellation(BORE_BODY, { positions, indices });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: bore object asserted");
  const assembled = createRenderProjection([projected.value], {
    kind: "perspective",
    position: [80, -80, 80],
    target: [0, 0, 5],
    up: [0, 0, 1],
    fovDeg: 40,
  });
  expect(assembled.ok).toBe(true);
  if (!assembled.ok) throw new Error("unreachable: projection asserted");
  return assembled.value;
})();

/**
 * A planar plate top (30 × 20 at z=10) as the one rendered body — the
 * not-cylindrical decline fixture. Face 0 is the plane.
 */
const PLANE_PROJECTION: RenderProjection = (() => {
  const projected = projectTessellation(BORE_BODY, {
    positions: [0, 0, 10, 30, 0, 10, 30, 20, 10, 0, 20, 10],
    indices: [0, 1, 2, 0, 2, 3],
  });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: plane object asserted");
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
  return { kind: "face", bodyId: BORE_BODY, regeneration: 0, faceIndex };
}

function readout(
  selected: readonly SelectionReference[],
  overrides: Partial<Parameters<typeof radiusReadout>[0]> = {},
): ReturnType<typeof radiusReadout> {
  return radiusReadout({
    selected,
    features: FEATURES,
    projection: BORE_PROJECTION,
    ...overrides,
  });
}

describe("radiusReadout", () => {
  it("measures one selected cylindrical face with the dual presentation and units", () => {
    expect(readout([faceRef(0)])).toEqual({
      text: "R 4.000 mm",
      diameterText: "⌀ 8.000 mm",
      source: "face (fit)",
      declined: null,
    });
  });

  it("shows nothing before the first settled scene", () => {
    expect(readout([faceRef(0)], { projection: undefined })).toEqual({
      text: null,
      diameterText: null,
      source: null,
      declined: null,
    });
  });

  it("shows nothing while the selection is empty — silence, not refusal", () => {
    expect(readout([])).toEqual({
      text: null,
      diameterText: null,
      source: null,
      declined: null,
    });
  });

  it("declines a multi-reference selection, structurally", () => {
    const state = readout([faceRef(0), faceRef(0)]);
    expect(state.text).toBeNull();
    expect(state.declined).toBe("radius/not-single-reference");
  });

  it("declines body and feature references — a body is not one circle", () => {
    const selections: readonly (readonly SelectionReference[])[] = [
      [{ kind: "body", bodyId: BORE_BODY }],
      [{ kind: "feature", featureId: PAD_FEATURE }],
    ];
    for (const selected of selections) {
      const state = readout(selected);
      expect(state.text).toBeNull();
      expect(state.declined).toBe("radius/unresolvable-reference");
    }
  });

  it("declines synthetic edge references — no producing surface", () => {
    const state = readout([
      {
        kind: "edge",
        bodyId: BORE_BODY,
        regeneration: 0,
        edgeIndex: 0,
      },
    ]);
    expect(state.text).toBeNull();
    expect(state.declined).toBe("radius/unresolvable-reference");
  });

  it("declines a face the scene does not carry", () => {
    const state = readout([
      { kind: "face", bodyId: MISSING_BODY, regeneration: 0, faceIndex: 0 },
    ]);
    expect(state.text).toBeNull();
    expect(state.declined).toBe("radius/unresolvable-reference");
  });

  it("declines a planar face as not cylindrical", () => {
    const state = radiusReadout({
      selected: [faceRef(0)],
      features: FEATURES,
      projection: PLANE_PROJECTION,
    });
    expect(state.text).toBeNull();
    expect(state.declined).toBe("radius/not-cylindrical");
  });
});
