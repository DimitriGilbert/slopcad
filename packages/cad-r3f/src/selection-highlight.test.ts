/**
 * Unit tests for the selection highlight layer: reference-to-highlight
 * mapping (stable refs select bodies; synthetic face refs select faces of
 * the CURRENT regeneration only), and the second-pass highlight geometry
 * (compact copies, exact float32 agreement with the drawn surface,
 * deterministic ordering, loud failures).
 */

import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createFeatureId,
  groupSyntheticFaces,
} from "@slopcad/cad-core";
import type { SelectionReference } from "@slopcad/cad-core";

import { buildRenderObjectGeometry } from "./geometry";
import {
  buildFaceHighlightGeometry,
  isBodySelected,
  selectedFaceIndices,
} from "./selection-highlight";
import { FOLDED_SHEET_SHARED, makeObject } from "./render-fixtures";

const PLATE = makeObject("plate", FOLDED_SHEET_SHARED);
const PLATE_GROUPING = groupSyntheticFaces(PLATE);
const PLATE_BODY = createBodyId("body_plate");
const OTHER_BODY = createBodyId("body_block");
const FEATURE = createFeatureId("feat_pad");

function faceRef(regeneration: number, faceIndex: number): SelectionReference {
  return { kind: "face", bodyId: PLATE_BODY, regeneration, faceIndex };
}

describe("isBodySelected", () => {
  it("selects through body, solid, and matching feature references", () => {
    const selection: readonly SelectionReference[] = [
      { kind: "body", bodyId: OTHER_BODY },
      { kind: "solid", bodyId: PLATE_BODY },
      { kind: "feature", featureId: FEATURE },
    ];
    expect(isBodySelected(selection, PLATE_BODY, undefined)).toBe(true);
    expect(isBodySelected(selection, OTHER_BODY, undefined)).toBe(true);
    expect(isBodySelected([], PLATE_BODY, undefined)).toBe(false);
    // The feature reference selects the object carrying that provenance.
    const plateWithFeature = makeObject("plate", FOLDED_SHEET_SHARED);
    expect(isBodySelected(selection, plateWithFeature.bodyId, FEATURE)).toBe(
      true,
    );
    expect(isBodySelected(selection, plateWithFeature.bodyId, undefined)).toBe(
      true,
    );
  });

  it("ignores synthetic references and unprovenanced objects", () => {
    const selection: readonly SelectionReference[] = [faceRef(1, 0)];
    expect(isBodySelected(selection, PLATE_BODY, undefined)).toBe(false);
    expect(isBodySelected(selection, undefined, undefined)).toBe(false);
  });
});

describe("selectedFaceIndices", () => {
  it("collects the current-regeneration face indices, sorted and deduplicated", () => {
    const selection: readonly SelectionReference[] = [
      faceRef(7, 1),
      faceRef(7, 0),
      faceRef(7, 1),
      { kind: "face", bodyId: OTHER_BODY, regeneration: 7, faceIndex: 2 },
    ];
    expect(selectedFaceIndices(selection, PLATE_BODY, 7)).toEqual([0, 1]);
  });

  it("ignores stale synthetic references (other regeneration tags)", () => {
    const selection: readonly SelectionReference[] = [
      faceRef(6, 0),
      faceRef(8, 1),
    ];
    expect(selectedFaceIndices(selection, PLATE_BODY, 7)).toEqual([]);
  });

  it("ignores non-face references entirely", () => {
    const selection: readonly SelectionReference[] = [
      { kind: "body", bodyId: PLATE_BODY },
      { kind: "solid", bodyId: PLATE_BODY },
    ];
    expect(selectedFaceIndices(selection, PLATE_BODY, 7)).toEqual([]);
  });
});

describe("buildFaceHighlightGeometry", () => {
  it("builds a compact overlay containing exactly the selected faces", () => {
    const base = buildRenderObjectGeometry(PLATE);
    const both = buildFaceHighlightGeometry(base, PLATE_GROUPING, [0, 1]);
    // The folded sheet has 4 vertices and 2 triangles; both faces selected
    // remaps every vertex and copies both triangles.
    expect(both.getAttribute("position").count).toBe(4);
    expect(both.getIndex()?.count).toBe(6);
    const single = buildFaceHighlightGeometry(base, PLATE_GROUPING, [1]);
    expect(single.getAttribute("position").count).toBe(3);
    expect(single.getIndex()?.count).toBe(3);
  });

  it("copies base attribute values exactly (float32-stable overlay)", () => {
    const base = buildRenderObjectGeometry(PLATE);
    const overlay = buildFaceHighlightGeometry(base, PLATE_GROUPING, [1]);
    const basePosition = base.getAttribute("position");
    const overlayPosition = overlay.getAttribute("position");
    const overlayIndex = overlay.getIndex();
    const baseIndex = base.getIndex();
    if (overlayIndex === null || baseIndex === null) {
      throw new Error("Expected indices on both geometries.");
    }
    // Face 1 is base triangle 1: overlay corner i copies base corner i of
    // that triangle, whatever the compact vertex remapping in between.
    // getX/getY/getZ take vertex indices and return one component each.
    for (let corner = 0; corner < overlayIndex.count; corner += 1) {
      const overlayVertex = overlayIndex.getX(corner);
      const baseVertex = baseIndex.getX(3 + corner);
      expect(overlayPosition.getX(overlayVertex)).toBe(
        basePosition.getX(baseVertex),
      );
      expect(overlayPosition.getY(overlayVertex)).toBe(
        basePosition.getY(baseVertex),
      );
      expect(overlayPosition.getZ(overlayVertex)).toBe(
        basePosition.getZ(baseVertex),
      );
    }
  });

  it("is deterministic and leaves the base geometry untouched", () => {
    const base = buildRenderObjectGeometry(PLATE);
    const first = buildFaceHighlightGeometry(base, PLATE_GROUPING, [0, 1]);
    const second = buildFaceHighlightGeometry(base, PLATE_GROUPING, [0, 1]);
    expect(second.getIndex()?.array).toEqual(first.getIndex()?.array);
    expect(second.getAttribute("position").array).toEqual(
      first.getAttribute("position").array,
    );
    // Disposing the overlay (the component's cleanup) must not affect the
    // base: the buffers are copies, never shared.
    const before = base.getAttribute("position").getX(0);
    second.dispose();
    expect(base.getAttribute("position").getX(0)).toBe(before);
    expect(base.getAttribute("position").count).toBe(4);
  });

  it("throws loudly on an empty or out-of-range face list", () => {
    const base = buildRenderObjectGeometry(PLATE);
    expect(() => buildFaceHighlightGeometry(base, PLATE_GROUPING, [])).toThrow(
      RangeError,
    );
    expect(() => buildFaceHighlightGeometry(base, PLATE_GROUPING, [2])).toThrow(
      RangeError,
    );
  });
});
