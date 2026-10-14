/**
 * Colormap slice planes (ROADMAP-SIM Phase 62b): an axis-aligned plane at
 * a document-space position, painting a decoded scalar field's values
 * through a colormap — the first of the field overlay family. Pure
 * geometry-as-data: {@link buildFieldSliceGeometry} is a deterministic
 * function of (field, slice, scale), so the same inputs always build the
 * same buffers (the byte-determinism law), and the React mount in
 * `field-overlays.tsx` owns invalidation and disposal.
 *
 * ## Construction
 *
 * The plane's vertex lattice IS the field's in-plane node lattice (the
 * node-centered convention: one vertex per in-plane extent index pair,
 * positioned at `origin + i·spacing`), with the scalar sampled trilinearly
 * at each vertex — so a slice at a node plane reads those nodes exactly,
 * and a slice between node planes reads the honest interpolation. Each
 * vertex's color is its value through the color scale (linear RGB, what a
 * three.js vertex color expects). The mesh is unlit by design: the colors
 * ARE the data, so no light rig participates and no shading can lie
 * about a value. The material draws double-sided (a slice reads from
 * both half-spaces); winding is deterministic (in-plane first axis fastest,
 * two triangles per cell in fixed corner order) but visually irrelevant
 * under `DoubleSide`.
 */

import { BufferAttribute, BufferGeometry } from "three";
import type { FieldColorScale } from "./field-colormaps";
import type { DecodedFieldGrid } from "./field-grid";

import { fieldColorRamp } from "./field-colormaps";
import { sampleFieldGrid } from "./field-grid";

/** The slice axes: the plane's normal direction (the document axes). */
export type FieldSliceAxis = "x" | "y" | "z";

/** Every slice axis (the exhaustive list constant). */
export const FIELD_SLICE_AXES: readonly FieldSliceAxis[] = ["x", "y", "z"];

/** Where a slice plane sits: an axis and the plane's document position, mm. */
export interface FieldSliceSpec {
  readonly axis: FieldSliceAxis;
  readonly positionMm: number;
}

const AXIS_INDEX: Readonly<Record<FieldSliceAxis, 0 | 1 | 2>> = Object.freeze({
  x: 0,
  y: 1,
  z: 2,
});

/**
 * Builds the slice plane's geometry: position and vertex-color float32
 * attributes plus a uint32 index, bounds precomputed. Throws on a
 * non-finite position; an empty-range field still builds (a plane
 * painted one color — the honest read of a constant field).
 */
export function buildFieldSliceGeometry(
  field: DecodedFieldGrid,
  slice: FieldSliceSpec,
  scale: FieldColorScale,
): BufferGeometry {
  if (!Number.isFinite(slice.positionMm)) {
    throw new RangeError(
      "A slice plane's position must be a finite document-space millimetre value.",
    );
  }
  const normalAxis = AXIS_INDEX[slice.axis];
  // The in-plane axes: first (fastest) then second, both ≠ the normal.
  const axisA = ((normalAxis + 1) % 3) as 0 | 1 | 2;
  const axisB = ((normalAxis + 2) % 3) as 0 | 1 | 2;
  const countA = field.shape[axisA] ?? 1;
  const countB = field.shape[axisB] ?? 1;
  const ramp = fieldColorRamp(scale, field.range);

  const vertexCount = countA * countB;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const sample: [number, number, number] = [0, 0, 0];
  for (let b = 0; b < countB; b += 1) {
    for (let a = 0; a < countA; a += 1) {
      const vertex = b * countA + a;
      sample[axisA] =
        (field.originMm[axisA] ?? 0) + a * (field.spacingMm[axisA] ?? 1);
      sample[axisB] =
        (field.originMm[axisB] ?? 0) + b * (field.spacingMm[axisB] ?? 1);
      sample[normalAxis] = slice.positionMm;
      positions[vertex * 3] = sample[0];
      positions[vertex * 3 + 1] = sample[1];
      positions[vertex * 3 + 2] = sample[2];
      const value = sampleFieldGrid(field, sample[0], sample[1], sample[2]);
      const [r, g, bl] = ramp(value);
      colors[vertex * 3] = r;
      colors[vertex * 3 + 1] = g;
      colors[vertex * 3 + 2] = bl;
    }
  }
  const cellCount = (countA - 1) * (countB - 1);
  const indices = new Uint32Array(cellCount * 6);
  let cursor = 0;
  for (let b = 0; b < countB - 1; b += 1) {
    for (let a = 0; a < countA - 1; a += 1) {
      const v00 = b * countA + a;
      const v10 = v00 + 1;
      const v01 = v00 + countA;
      const v11 = v01 + 1;
      indices[cursor] = v00;
      indices[cursor + 1] = v10;
      indices[cursor + 2] = v01;
      indices[cursor + 3] = v10;
      indices[cursor + 4] = v11;
      indices[cursor + 5] = v01;
      cursor += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
