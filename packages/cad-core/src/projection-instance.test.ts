/**
 * Placed-instance projection tests (Phase 50): instance ids, world bounds,
 * verbatim soup sharing, serialization byte-additivity, and parse rules.
 */

import { describe, expect, it } from "vitest";

import {
  createBodyId,
  createOccurrenceId,
  parseRenderProjection,
  placementRenderObjectId,
  projectPlacedInstance,
  projectTessellation,
  serializeRenderProjection,
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  type PlacementTransform,
} from "./index";

function translate(x: number, y: number, z: number): PlacementTransform {
  return {
    rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
    translation: [x, y, z],
  };
}

const TESS = {
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
  indices: [0, 1, 2],
};

describe("placed-instance projection", () => {
  it("derives stable instance ids from path and body payloads", () => {
    const id = placementRenderObjectId(
      [createOccurrenceId("occ_000001"), createOccurrenceId("occ_000002")],
      createBodyId("body_plate"),
    );
    expect(id).toBe("rend_000001.000002.plate");
  });

  it("carries the transform, shares the soup, and computes world bounds", () => {
    const base = projectTessellation(createBodyId("body_plate"), TESS);
    if (!base.ok) throw new Error("expected base object");
    const world = composePlacementTransforms(
      translate(100, 0, 0),
      translate(0, 50, 0),
    );
    const placed = projectPlacedInstance(
      base.value,
      [createOccurrenceId("occ_a")],
      world,
    );
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.value.id).toBe("rend_a.plate");
    // Soup is shared VERBATIM (same reference — no copy, no bake).
    expect(placed.value.positions).toBe(base.value.positions);
    expect(placed.value.indices).toBe(base.value.indices);
    expect(placed.value.bodyId).toBe(base.value.bodyId);
    // Bounds are the WORLD AABB: local bounds [0..10]x[0..10] + (100, 50).
    expect(placed.value.bounds.min).toEqual([100, 50, 0]);
    expect(placed.value.bounds.max).toEqual([110, 60, 0]);
    expect(placed.value.occurrencePath).toEqual([createOccurrenceId("occ_a")]);
  });

  it("serializes additively — direct objects unchanged, instances ride their pair", () => {
    const base = projectTessellation(createBodyId("body_plate"), TESS);
    if (!base.ok) throw new Error("expected base object");
    const placed = projectPlacedInstance(
      base.value,
      [createOccurrenceId("occ_a")],
      translate(5, 0, 0),
    );
    if (!placed.ok) throw new Error("expected placed object");
    const direct = serializeRenderProjection({
      objects: [base.value],
      camera: {
        kind: "perspective",
        position: [0, 0, 100],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fovDeg: 45,
      },
    });
    expect(JSON.stringify(direct.objects[0])).not.toContain("occurrence");
    const both = serializeRenderProjection({
      objects: [base.value, placed.value],
      camera: {
        kind: "perspective",
        position: [0, 0, 100],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fovDeg: 45,
      },
    });
    const revived = parseRenderProjection(JSON.parse(JSON.stringify(both)));
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.objects[1]?.occurrencePath).toEqual([
      createOccurrenceId("occ_a"),
    ]);
    expect(revived.value.objects[1]?.occurrenceTransform).toEqual({
      rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
      translation: [5, 0, 0],
    });
    expect(revived.value.objects[1]?.bounds.min).toEqual([5, 0, 0]);
  });

  it("refuses instances without provenance and mismatched instance ids", () => {
    const anonymous = projectTessellation(createBodyId("body_plate"), TESS);
    if (!anonymous.ok) throw new Error("expected base object");
    const bare: { bodyId?: undefined } & typeof anonymous.value = Object.assign(
      {},
      anonymous.value,
      { bodyId: undefined },
    );
    const refused = projectPlacedInstance(
      bare,
      [createOccurrenceId("occ_a")],
      translate(0, 0, 0),
    );
    expect(refused.ok).toBe(false);

    const base = anonymous;
    const placed = projectPlacedInstance(
      base.value,
      [createOccurrenceId("occ_a")],
      translate(0, 0, 0),
    );
    if (!placed.ok) throw new Error("expected placed object");
    const serialized = serializeRenderProjection({
      objects: [placed.value],
      camera: {
        kind: "perspective",
        position: [0, 0, 100],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fovDeg: 45,
      },
    });
    const tampered = JSON.parse(JSON.stringify(serialized)) as {
      objects: { id: string }[];
    };
    const first = tampered.objects[0];
    if (first !== undefined) {
      first.id = "rend_plate";
    }
    expect(parseRenderProjection(tampered).ok).toBe(false);
  });
});
