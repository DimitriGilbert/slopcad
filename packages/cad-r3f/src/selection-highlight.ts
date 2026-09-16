/**
 * Selection highlight (Phase 12): the deterministic visual layer that shows
 * the domain selection state on the rendered scene. Two documented
 * mechanisms, both pure functions of (projection, selection):
 *
 * - **Body-level selection** (body/feature/solid references) changes the
 *   base mesh's standard material: color and emissive move to
 *   {@link CAD_SELECTION_HIGHLIGHT_COLOR} with
 *   {@link CAD_BODY_SELECTION_EMISSIVE_INTENSITY}. A deterministic color/
 *   emissive change — no new objects, same geometry.
 * - **Face-level selection** (synthetic face references) renders a SECOND
 *   HIGHLIGHT PASS: one extra mesh per affected render object, its geometry
 *   containing ONLY the selected faces' triangles ({@link
 *   buildFaceHighlightGeometry} — compact, own vertex buffers copied from
 *   the base geometry's float32 values, so the overlay coincides with the
 *   drawn surface exactly), drawn with an unlit
 *   {@link CAD_SELECTION_HIGHLIGHT_COLOR} basic material and a small
 *   negative polygon offset. The offset is what keeps the overlay from
 *   z-fighting the base surface it lies on; depth-test stays on, so a
 *   highlighted face on the far side of the solid still hides correctly.
 *
 * Determinism: colors, intensities, and offsets are constants; geometry is
 * built in ascending face/triangle order; no clock, no randomness — the
 * same (projection, selection) pair always produces the same pixels.
 *
 * Transience guard: synthetic references tagged for any regeneration other
 * than the renderer's current one are ignored here — they are stale, and
 * the domain model guarantees they cannot be in a live selection state; the
 * renderer re-checks rather than paint a dead face.
 */

import * as THREE from "three";
import type {
  BodyId,
  FeatureId,
  SelectionReference,
  SyntheticFaceGrouping,
} from "@slopcad/cad-core";

/**
 * The documented selection highlight color (amber, chosen for contrast
 * against the default `#8aadf4` body material and the neutral scene).
 */
export const CAD_SELECTION_HIGHLIGHT_COLOR = "#f59e0b";

/**
 * Emissive intensity applied to a body-selected mesh's standard material
 * (with {@link CAD_SELECTION_HIGHLIGHT_COLOR} as the emissive color) — the
 * "glow" that marks a whole selected body without a second pass.
 */
export const CAD_BODY_SELECTION_EMISSIVE_INTENSITY = 0.35;

/**
 * Polygon offset pulling the face-highlight overlay toward the camera, in
 * three.js units. Small enough to be invisible, large enough to win the
 * depth test against the exactly-coplanar base surface.
 */
export const CAD_FACE_HIGHLIGHT_POLYGON_OFFSET = -2;

/** Whether a stable reference selects the given body/feature. */
export function isBodySelected(
  selection: readonly SelectionReference[],
  bodyId: BodyId | undefined,
  featureId: FeatureId | undefined,
): boolean {
  return selection.some((reference) => {
    if (reference.kind === "body" || reference.kind === "solid") {
      return bodyId !== undefined && reference.bodyId === bodyId;
    }
    if (reference.kind === "feature") {
      return featureId !== undefined && reference.featureId === featureId;
    }
    return false;
  });
}

/**
 * The face ordinals of `bodyId`'s synthetic faces that the selection marks
 * for the CURRENT regeneration — ascending, deduplicated. Stale synthetic
 * references (other regeneration tags) and references for other bodies are
 * ignored (see the module header).
 */
export function selectedFaceIndices(
  selection: readonly SelectionReference[],
  bodyId: BodyId,
  regeneration: number,
): readonly number[] {
  const indices = new Set<number>();
  for (const reference of selection) {
    if (reference.kind !== "face") continue;
    if (reference.bodyId !== bodyId) continue;
    if (reference.regeneration !== regeneration) continue;
    indices.add(reference.faceIndex);
  }
  return [...indices].sort((a, b) => a - b);
}

/**
 * Builds the second-pass highlight geometry for the given faces of one
 * render object's base geometry: own compact position/normal buffers whose
 * values are COPIES of the base geometry's float32 attribute values (the
 * overlay coincides with the drawn surface by construction, and disposing
 * the overlay can never touch the base buffers), an index listing the
 * faces' triangles in ascending face/triangle order, and precomputed
 * bounds. Deterministic; empty face lists throw — a highlight mesh is only
 * ever created for at least one selected face.
 */
export function buildFaceHighlightGeometry(
  base: THREE.BufferGeometry,
  grouping: SyntheticFaceGrouping,
  faceIndices: readonly number[],
): THREE.BufferGeometry {
  if (faceIndices.length === 0) {
    throw new RangeError("A face highlight needs at least one face index.");
  }
  const triangles: number[] = [];
  for (const faceIndex of faceIndices) {
    const face = grouping.faces[faceIndex];
    if (face === undefined || face.index !== faceIndex) {
      throw new RangeError(
        `Face index ${String(faceIndex)} is outside the grouping's 0..${String(grouping.faceCount - 1)} range.`,
      );
    }
    for (const triangle of face.triangleIndices) {
      triangles.push(triangle);
    }
  }
  const position = base.getAttribute("position");
  const normal = base.getAttribute("normal");
  if (position === null || normal === null) {
    throw new TypeError(
      "Render geometry is missing position or normal attributes; cannot build a face highlight.",
    );
  }
  const remap = new Map<number, number>();
  const used: number[] = [];
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = base.getIndex()?.getX(triangle * 3 + corner);
      if (vertex === undefined) {
        throw new TypeError(
          "Render geometry is missing its index; cannot build a face highlight.",
        );
      }
      if (!remap.has(vertex)) {
        remap.set(vertex, used.length);
        used.push(vertex);
      }
    }
  }
  const positions = new Float32Array(used.length * 3);
  const normals = new Float32Array(used.length * 3);
  for (const [vertex, mapped] of remap) {
    positions[mapped * 3] = position.getX(vertex);
    positions[mapped * 3 + 1] = position.getY(vertex);
    positions[mapped * 3 + 2] = position.getZ(vertex);
    normals[mapped * 3] = normal.getX(vertex);
    normals[mapped * 3 + 1] = normal.getY(vertex);
    normals[mapped * 3 + 2] = normal.getZ(vertex);
  }
  const indices = new Uint32Array(triangles.length * 3);
  let cursor = 0;
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = base.getIndex()?.getX(triangle * 3 + corner);
      if (vertex === undefined) {
        throw new TypeError(
          "Render geometry lost its index while building a face highlight.",
        );
      }
      const mapped = remap.get(vertex);
      if (mapped === undefined) {
        throw new TypeError(
          "Face highlight vertex remap lost a vertex while writing indices.",
        );
      }
      indices[cursor] = mapped;
      cursor += 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
