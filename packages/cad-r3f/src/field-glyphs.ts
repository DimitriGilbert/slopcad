/**
 * Vector glyphs (ROADMAP-SIM Phase 62b): needle glyphs subsampled from a
 * decoded vector field on a deterministic decimation pattern — the
 * pointwise direction-and-magnitude view that complements streamlines.
 *
 * ## The decimation pattern (documented, deterministic)
 *
 * A glyph rides every `stride`-th node per axis, counting from the
 * lattice's origin: extent indices `0, stride, 2·stride, …` on each of
 * x, y, z — a fixed lattice pattern, never a hash, a random skip, or an
 * iteration-order artifact. Zero-magnitude nodes are skipped (a needle
 * needs a direction; there is nothing honest to draw for still fluid).
 *
 * ## The needle form
 *
 * One line segment per glyph, rooted at the node's position, pointing
 * along the node's vector, its length `scaleMm · |v| / max|v|` —
 * magnitude normalized against the FIELD's own maximum (the whole-lattice
 * max, not the decimated subset), so glyph lengths are comparable across
 * strides and consistent with any legend built on the same window. The
 * vertex colors paint the same normalized magnitude through the color
 * scale, so direction reads from the needle and magnitude from both its
 * length and its color.
 */

import { BufferAttribute, BufferGeometry } from "three";
import type { FieldColorScale } from "./field-colormaps";
import type { DecodedVectorField } from "./field-grid";

import { fieldColorRamp } from "./field-colormaps";
import { fieldGridSamplePositionMm } from "./field-grid";

/** Glyph controls: the decimation stride and the length scale. */
export interface FieldGlyphOptions {
  /** Keep every `stride`-th node per axis (a positive integer). */
  readonly stride: number;
  /** The needle length at the field's maximum magnitude, document mm (> 0). */
  readonly scaleMm: number;
}

/**
 * The decimated glyph node indices for one axis: `0, stride, 2·stride, …`
 * below the extent count (the documented pattern).
 */
export function fieldGlyphNodeIndices(
  count: number,
  stride: number,
): readonly number[] {
  const indices: number[] = [];
  for (let index = 0; index < count; index += stride) {
    indices.push(index);
  }
  return indices;
}

/**
 * Builds the glyph field as one `LineSegments` buffer: position and
 * vertex-color float32 attributes, one segment per decimated non-zero
 * node, nodes emitted in the fixed x-fastest lattice order (x indices
 * outermost loop is k, then j, then i — the value order's own). Throws
 * on a non-positive stride or scale.
 */
export function buildFieldGlyphGeometry(
  field: DecodedVectorField,
  options: FieldGlyphOptions,
  scale: FieldColorScale,
): BufferGeometry {
  if (!Number.isInteger(options.stride) || options.stride < 1) {
    throw new RangeError("A glyph field's stride must be a positive integer.");
  }
  if (!(options.scaleMm > 0) || !Number.isFinite(options.scaleMm)) {
    throw new RangeError(
      "A glyph field's scale must be a positive finite millimetre value.",
    );
  }
  const [nx, ny, nz] = field.shape;
  const ramp = fieldColorRamp(scale, [0, field.maxMagnitude]);
  const positions: number[] = [];
  const colors: number[] = [];
  const maxMagnitude = field.maxMagnitude;
  for (const k of fieldGlyphNodeIndices(nz ?? 1, options.stride)) {
    for (const j of fieldGlyphNodeIndices(ny ?? 1, options.stride)) {
      for (const i of fieldGlyphNodeIndices(nx ?? 1, options.stride)) {
        const flat = i + (nx ?? 1) * (j + (ny ?? 1) * k);
        const vx = field.x[flat] ?? 0;
        const vy = field.y[flat] ?? 0;
        const vz = field.z[flat] ?? 0;
        const magnitude = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (magnitude === 0) continue;
        const [px, py, pz] = fieldGridSamplePositionMm(field, i, j, k);
        // Length: scaleMm at the field's own maximum, proportional below.
        const length =
          maxMagnitude > 0 ? options.scaleMm * (magnitude / maxMagnitude) : 0;
        const qx = px + (vx / magnitude) * length;
        const qy = py + (vy / magnitude) * length;
        const qz = pz + (vz / magnitude) * length;
        positions.push(px, py, pz, qx, qy, qz);
        const [r, g, b] = ramp(magnitude);
        colors.push(r, g, b, r, g, b);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    "color",
    new BufferAttribute(new Float32Array(colors), 3),
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
