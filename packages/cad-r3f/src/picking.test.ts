/**
 * Unit tests for the Phase 12 picking bridge: the spec→screen projection is
 * pinned against three.js camera projection (the same mapping the scene
 * camera uses), and pick resolution maps raycast triangle indices to domain
 * references — body via stable id, face via the synthetic grouping with the
 * regeneration tag — while failing structurally on unresolvable hits.
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { groupSyntheticFaces, type ParseResult } from "@slopcad/cad-core";
import type { PickError } from "./picking";

import {
  PICK_ERROR_CODES,
  renderCameraScreenPoint,
  resolvePickReference,
} from "./picking";
import {
  FOLDED_SHEET_SHARED,
  makeObject,
  TEST_CAMERA,
} from "./render-fixtures";
import { createSceneCamera } from "./scene-camera";

const PLATE = makeObject("plate", FOLDED_SHEET_SHARED);
const PLATE_GROUPING = groupSyntheticFaces(PLATE);

const ORTHO_CAMERA = {
  kind: "orthographic",
  position: [46, 34, 48],
  target: [0, 0, 0],
  up: [0, 1, 0],
  viewWidth: 80,
  viewHeight: 52,
} as const;

const VIEWPORT = { width: 800, height: 520 };

function unwrap<T>(result: ParseResult<T, PickError>): T {
  if (!result.ok)
    throw new Error(`Expected ok, received: ${result.error.message}`);
  return result.value;
}

describe("renderCameraScreenPoint", () => {
  const points: readonly [number, number, number][] = [
    [0, 0, 0],
    [15, 10, 5],
    [-12, 3, 8],
    [30, -20, 2],
    [1.25, 0.5, -3.75],
  ];

  it("matches three.js perspective camera projection exactly", () => {
    const aspect = VIEWPORT.width / VIEWPORT.height;
    const camera = createSceneCamera(TEST_CAMERA, aspect);
    for (const point of points) {
      const ndc = new THREE.Vector3(...point).project(camera).clone();
      const expected: [number, number] = [
        ((ndc.x + 1) / 2) * VIEWPORT.width,
        ((1 - ndc.y) / 2) * VIEWPORT.height,
      ];
      const actual = renderCameraScreenPoint(
        TEST_CAMERA,
        point,
        VIEWPORT.width,
        VIEWPORT.height,
      );
      expect(actual[0]).toBeCloseTo(expected[0], 6);
      expect(actual[1]).toBeCloseTo(expected[1], 6);
    }
  });

  it("matches three.js orthographic camera projection exactly", () => {
    const aspect = VIEWPORT.width / VIEWPORT.height;
    const camera = createSceneCamera(ORTHO_CAMERA, aspect);
    for (const point of points) {
      const ndc = new THREE.Vector3(...point).project(camera).clone();
      const expected: [number, number] = [
        ((ndc.x + 1) / 2) * VIEWPORT.width,
        ((1 - ndc.y) / 2) * VIEWPORT.height,
      ];
      const actual = renderCameraScreenPoint(
        ORTHO_CAMERA,
        point,
        VIEWPORT.width,
        VIEWPORT.height,
      );
      expect(actual[0]).toBeCloseTo(expected[0], 6);
      expect(actual[1]).toBeCloseTo(expected[1], 6);
    }
  });

  it("is deterministic and viewport-origin oriented (y down)", () => {
    const a = renderCameraScreenPoint(TEST_CAMERA, [0, 0, 0], 800, 520);
    const b = renderCameraScreenPoint(TEST_CAMERA, [0, 0, 0], 800, 520);
    expect(a).toEqual(b);
    // A point above the target (world +y) must land higher on screen
    // (smaller CSS y) for an up-corrected camera.
    const above = renderCameraScreenPoint(TEST_CAMERA, [0, 5, 0], 800, 520);
    expect(above[1]).toBeLessThan(a[1]);
  });
});

describe("resolvePickReference", () => {
  it("resolves the body category to the stable body reference", () => {
    const pick = unwrap(
      resolvePickReference({
        object: PLATE,
        grouping: PLATE_GROUPING,
        triangleIndex: 0,
        regeneration: 4,
        category: "body",
      }),
    );
    expect(pick).toEqual({ kind: "body", bodyId: "body_plate" });
  });

  it("resolves the face category through the grouping, tagging the regeneration", () => {
    const face0 = unwrap(
      resolvePickReference({
        object: PLATE,
        grouping: PLATE_GROUPING,
        triangleIndex: 0,
        regeneration: 4,
        category: "face",
      }),
    );
    const face1 = unwrap(
      resolvePickReference({
        object: PLATE,
        grouping: PLATE_GROUPING,
        triangleIndex: 1,
        regeneration: 4,
        category: "face",
      }),
    );
    // The folded sheet's two triangles are adjacent but 90° apart: separate
    // synthetic faces, mapped by triangle index.
    expect(face0).toEqual({
      kind: "face",
      bodyId: "body_plate",
      regeneration: 4,
      faceIndex: 0,
    });
    expect(face1).toEqual({
      kind: "face",
      bodyId: "body_plate",
      regeneration: 4,
      faceIndex: 1,
    });
  });

  it("pins the id-derivation contract that makes body resolution total", () => {
    // projectTessellation always stamps bodyId; the pick resolver's
    // id-derived fallback (for renderer-owned objects) relies on the
    // projection contract that the render id always derives from a body id.
    const anonymous = makeObject("anonymous", FOLDED_SHEET_SHARED);
    expect(anonymous.bodyId).toBe("body_anonymous");
    const pick = unwrap(
      resolvePickReference({
        object: anonymous,
        grouping: PLATE_GROUPING,
        triangleIndex: 0,
        regeneration: 4,
        category: "body",
      }),
    );
    expect(pick).toEqual({ kind: "body", bodyId: "body_anonymous" });
  });

  it("fails structurally on a triangle index outside the object", () => {
    const result = resolvePickReference({
      object: PLATE,
      grouping: PLATE_GROUPING,
      triangleIndex: 99,
      regeneration: 4,
      category: "face",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a failure.");
    expect(result.error.code).toBe(PICK_ERROR_CODES.triangleOutOfRange);
  });
});
