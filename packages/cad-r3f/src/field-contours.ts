/**
 * Iso-contours (ROADMAP-SIM Phase 62b): contour LINES at scalar
 * thresholds on an axis-aligned plane through a decoded field grid —
 * marching squares, the honest 2D form (iso-SURFACES in 3D are a
 * separate, later renderer decision, not a hidden half-implementation
 * here). Pure geometry-as-data: the same (field, slice, thresholds,
 * scale) always build the same segments in the same order.
 *
 * ## Construction
 *
 * The cell lattice is the slice plane's node lattice (exactly
 * `field-slice.ts`'s): values are sampled trilinearly at each in-plane
 * node — a slice on a node plane reads those nodes exactly. Each cell
 * and threshold emit the crossing segments of the linearly interpolated
 * cell edges, cells scanned in the same deterministic order as the slice
 * plane's vertices (in-plane first axis fastest) and thresholds in the
 * caller's given order. A corner counts as INSIDE the iso-region when
 * its value is `>= threshold` (the convention pinned everywhere here);
 * an edge crosses exactly when its corners disagree, at the linear
 * interpolation fraction `(threshold − from) / (to − from)`, and the
 * crossing points are emitted in the fixed edge order [bottom, right,
 * top, left] of each cell.
 *
 * ## The saddle rule
 *
 * Opposite-corner sign patterns cross all four cell edges (the classic
 * marching-squares ambiguity), and the corner mean ALONE cannot resolve
 * them: which diagonal holds the inside corners is a fact of the corner
 * signs, not of the average. This module resolves a saddle in two
 * steps that mirror the bilinear interpolant the edge crossings
 * already linearize:
 *
 * 1. The corner signs name the INSIDE DIAGONAL (c00–c11 or c10–c01) —
 *    a cell that crosses all four edges is checkerboard, so each corner
 *    shares its threshold side with its diagonal opposite.
 * 2. The corner mean — exactly the bilinear interpolant's value at the
 *    cell center — says whether the center joins that diagonal. When it
 *    does, the inside region runs through the middle and the segments
 *    isolate each OUTSIDE corner; when it does not, the inside corners
 *    sit in two separate lobes and the segments isolate each INSIDE
 *    corner. A segment always joins the two crossings adjacent to the
 *    corner it isolates: bottom+left wraps c00, bottom+right wraps c10,
 *    left+top wraps c01, right+top wraps c11.
 *
 * An exactly-equal mean puts the center ON the contour; that tie rides
 * the two-lobe pairing — documented, deterministic either way. No
 * asymptotic decimators, no look-ahead: one documented rule, pinned by
 * its own test.
 *
 * Colors: both endpoints of a segment carry the colormap color of the
 * THRESHOLD's own value (the line is the iso-level's identity), not the
 * corner values it passes between.
 */

import { BufferAttribute, BufferGeometry } from "three";
import type { FieldColorScale } from "./field-colormaps";
import type { DecodedFieldGrid } from "./field-grid";
import type { FieldSliceAxis, FieldSliceSpec } from "./field-slice";

import { fieldColorRamp } from "./field-colormaps";
import { sampleFieldGrid } from "./field-grid";

/** An iso-contour request: scalar thresholds on one slice plane. */
export interface FieldContourSpec {
  readonly slice: FieldSliceSpec;
  /** The iso-values to draw, in the caller's order (documented emission order). */
  readonly thresholds: readonly number[];
}

const AXIS_INDEX: Readonly<Record<FieldSliceAxis, 0 | 1 | 2>> = Object.freeze({
  x: 0,
  y: 1,
  z: 2,
});

/**
 * Builds the iso-contour line geometry: a `LineSegments` buffer with
 * position and vertex-color float32 attributes (per-vertex colors, the
 * threshold's colormap color). Thresholds outside the slice's value
 * range simply emit nothing (a contour that does not exist there);
 * non-finite thresholds or positions throw — a NaN iso-level is a
 * caller error, never a silently empty overlay.
 */
export function buildFieldContourGeometry(
  field: DecodedFieldGrid,
  contour: FieldContourSpec,
  scale: FieldColorScale,
): BufferGeometry {
  const { slice, thresholds } = contour;
  if (!Number.isFinite(slice.positionMm)) {
    throw new RangeError(
      "A contour plane's position must be a finite document-space millimetre value.",
    );
  }
  for (const threshold of thresholds) {
    if (!Number.isFinite(threshold)) {
      throw new RangeError(
        "A contour threshold must be a finite scalar value.",
      );
    }
  }
  const normalAxis = AXIS_INDEX[slice.axis];
  const axisA = ((normalAxis + 1) % 3) as 0 | 1 | 2;
  const axisB = ((normalAxis + 2) % 3) as 0 | 1 | 2;
  const countA = field.shape[axisA] ?? 1;
  const countB = field.shape[axisB] ?? 1;
  const spacingA = field.spacingMm[axisA] ?? 1;
  const spacingB = field.spacingMm[axisB] ?? 1;
  const ramp = fieldColorRamp(scale, field.range);

  // The slice's node values, sampled once per node (a slice's cells share
  // their edge reads across thresholds — one pass, many compares).
  const nodeValues = new Float64Array(countA * countB);
  const positionA = new Float64Array(countA);
  const positionB = new Float64Array(countB);
  for (let a = 0; a < countA; a += 1) {
    positionA[a] = (field.originMm[axisA] ?? 0) + a * spacingA;
  }
  for (let b = 0; b < countB; b += 1) {
    positionB[b] = (field.originMm[axisB] ?? 0) + b * spacingB;
  }
  const sample: [number, number, number] = [0, 0, 0];
  sample[normalAxis] = slice.positionMm;
  for (let b = 0; b < countB; b += 1) {
    for (let a = 0; a < countA; a += 1) {
      sample[axisA] = positionA[a] ?? 0;
      sample[axisB] = positionB[b] ?? 0;
      nodeValues[b * countA + a] = sampleFieldGrid(
        field,
        sample[0],
        sample[1],
        sample[2],
      );
    }
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const emitPoint = (
    a: number,
    b: number,
    fraction: number,
    alongAxisA: boolean,
  ): void => {
    sample[axisA] =
      (positionA[a] ?? 0) + (alongAxisA ? fraction * spacingA : 0);
    sample[axisB] =
      (positionB[b] ?? 0) + (alongAxisA ? 0 : fraction * spacingB);
    positions.push(sample[0], sample[1], sample[2]);
  };

  for (let b = 0; b < countB - 1; b += 1) {
    for (let a = 0; a < countA - 1; a += 1) {
      const c00 = nodeValues[b * countA + a] ?? 0;
      const c10 = nodeValues[b * countA + a + 1] ?? 0;
      const c01 = nodeValues[(b + 1) * countA + a] ?? 0;
      const c11 = nodeValues[(b + 1) * countA + a + 1] ?? 0;
      for (const threshold of thresholds) {
        // Edge crossings in the fixed order [bottom, right, top, left].
        // Corners: c00 (a,b), c10 (a+1,b), c11 (a+1,b+1), c01 (a,b+1); a
        // corner is inside the iso-region when its value is >= threshold.
        const crossings: (() => void)[] = [];
        const edge = (
          from: number,
          to: number,
          emit: (fraction: number) => void,
        ): void => {
          if (from >= threshold === to >= threshold) return;
          emit((threshold - from) / (to - from));
        };
        // bottom: c00 → c10 along axisA.
        edge(c00, c10, (fraction) => {
          crossings.push(() => emitPoint(a, b, fraction, true));
        });
        // right: c10 → c11 along axisB.
        edge(c10, c11, (fraction) => {
          crossings.push(() => emitPoint(a + 1, b, fraction, false));
        });
        // top: c01 → c11 along axisA.
        edge(c01, c11, (fraction) => {
          crossings.push(() => emitPoint(a, b + 1, fraction, true));
        });
        // left: c00 → c01 along axisB.
        edge(c00, c01, (fraction) => {
          crossings.push(() => emitPoint(a, b, fraction, false));
        });
        if (crossings.length === 2 || crossings.length === 4) {
          const [r, g, bl] = ramp(threshold);
          if (crossings.length === 2) {
            crossings[0]?.();
            crossings[1]?.();
            colors.push(r, g, bl, r, g, bl);
          } else {
            // The saddle (module doc): the corner signs fix the inside
            // diagonal (a four-crossing cell is checkerboard, so c00
            // shares its side with c11, c10 with c01); the corner mean —
            // the bilinear center value — says whether the center joins
            // it. The segments isolate whichever corner pair lies on the
            // center's far side of the threshold.
            const [bottom, right, top, left] = crossings;
            const centerInside = (c00 + c10 + c01 + c11) / 4 > threshold;
            if (c00 >= threshold !== centerInside) {
              // Isolate c00 (bottom+left) and its opposite c11 (right+top).
              bottom?.();
              left?.();
              right?.();
              top?.();
            } else {
              // Isolate c10 (bottom+right) and its opposite c01 (left+top).
              bottom?.();
              right?.();
              left?.();
              top?.();
            }
            colors.push(r, g, bl, r, g, bl, r, g, bl, r, g, bl);
          }
        }
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
