/**
 * Seeded streamlines (ROADMAP-SIM Phase 62b): integral curves of a
 * decoded vector field from explicit seed points — the flow-structure
 * view of the overlay family.
 *
 * ## The integrator (documented, deterministic)
 *
 * Classic fourth-order Runge–Kutta with a FIXED spatial step, on the
 * field's NORMALIZED direction field d(p) = v(p)/|v(p)|:
 *
 * ```
 * k1 = d(p)          p' = p + (h/6)·(k1 + 2·k2 + 2·k3 + k4)
 * k2 = d(p + h/2·k1)
 * k3 = d(p + h/2·k2)
 * k4 = d(p + h·k3)
 * ```
 *
 * Streamlines are invariant under positive rescaling of the field (the
 * path is the direction field's integral curve), so the fixed spatial
 * step is the honest parameterization: each step advances the curve by
 * APPROXIMATELY `stepMm` of arc regardless of local speed — the four
 * stage directions are unit vectors, but their RK4 weighted mean is
 * unit length only along a straight run, so arc per step is `stepMm` up
 * to the integrator's O(h⁵) local error. Sampling is the
 * field's own trilinear read; the RK4 stages are a fixed evaluation
 * sequence, and {@link integrateFieldStreamline} is pure per seed —
 * curve results never depend on iteration order, only on (field, seed,
 * options). Termination: the curve stops WITHOUT the point that would
 * leave the grid's closed node bounds, and a zero-magnitude sample is a
 * stagnation point that ends it; a seed outside the field, or on a
 * stagnation point, yields the degenerate single-seed curve.
 *
 * ## Geometry
 *
 * {@link buildFieldStreamlinesGeometry} turns the per-seed curves into
 * one `LineSegments` buffer — each curve's consecutive point pairs as
 * segments, curves in seed order — with per-vertex colors from the
 * local vector magnitude through the color scale (normalized against
 * the field's `maxMagnitude`, or the scale's explicit window).
 */

import { BufferAttribute, BufferGeometry } from "three";
import type { FieldColorScale } from "./field-colormaps";
import type { DecodedVectorField } from "./field-grid";

import { fieldColorRamp } from "./field-colormaps";
import {
  fieldGridContainsPoint,
  sampleVectorField,
  sampleVectorMagnitude,
} from "./field-grid";

/** A streamline seed: a document-space point, mm. */
export type FieldStreamSeed = readonly [number, number, number];

/** Integration controls: the fixed spatial step and the step budget. */
export interface FieldStreamlineOptions {
  /** The fixed spatial integration step, document millimetres (> 0). */
  readonly stepMm: number;
  /** The maximum number of steps (≥ 0; 0 yields the seed alone). */
  readonly stepCount: number;
}

/** Adds two triples. */
function add(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Scales a triple. */
function scale(
  a: readonly [number, number, number],
  factor: number,
): [number, number, number] {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

/**
 * One fixed-step RK4 advance of the direction field, or `null` when the
 * advance is not defined (the evaluation point left the grid, or hit a
 * zero-magnitude stagnation sample). Pure arithmetic otherwise.
 */
function rk4Advance(
  field: DecodedVectorField,
  point: readonly [number, number, number],
  step: number,
): readonly [number, number, number] | null {
  const directionAt = (
    p: readonly [number, number, number],
  ): readonly [number, number, number] | null => {
    if (!fieldGridContainsPoint(field, p[0], p[1], p[2])) return null;
    const [vx, vy, vz] = sampleVectorField(field, p[0], p[1], p[2]);
    const magnitude = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (magnitude === 0) return null;
    return [vx / magnitude, vy / magnitude, vz / magnitude] as const;
  };
  const k1 = directionAt(point);
  if (k1 === null) return null;
  const k2 = directionAt(add(point, scale(k1, step / 2)));
  if (k2 === null) return null;
  const k3 = directionAt(add(point, scale(k2, step / 2)));
  if (k3 === null) return null;
  const k4 = directionAt(add(point, scale(k3, step)));
  if (k4 === null) return null;
  // p' = p + (h/6)(k1 + 2k2 + 2k3 + k4), evaluated left to right.
  const weighted = scale(
    add(add(k1, scale(k2, 2)), add(scale(k3, 2), k4)),
    step / 6,
  );
  return add(point, weighted);
}

/**
 * Integrates one streamline from a seed: the seed point followed by one
 * point per successful fixed step, terminating (without the exiting
 * point) at the grid boundary or a stagnation sample. Pure and
 * order-independent — see the module doc.
 */
export function integrateFieldStreamline(
  field: DecodedVectorField,
  seed: FieldStreamSeed,
  options: FieldStreamlineOptions,
): readonly (readonly [number, number, number])[] {
  if (!(options.stepMm > 0) || !Number.isFinite(options.stepMm)) {
    throw new RangeError(
      "A streamline's step must be a positive finite millimetre value.",
    );
  }
  if (!Number.isInteger(options.stepCount) || options.stepCount < 0) {
    throw new RangeError(
      "A streamline's step count must be a non-negative integer.",
    );
  }
  const points: (readonly [number, number, number])[] = [seed];
  let current: readonly [number, number, number] = seed;
  for (let step = 0; step < options.stepCount; step += 1) {
    const next = rk4Advance(field, current, options.stepMm);
    if (next === null) break;
    points.push(next);
    current = next;
  }
  return points;
}

/**
 * Builds every seed's streamline as one `LineSegments` buffer: position
 * and vertex-color float32 attributes, curves in seed order, consecutive
 * point pairs as segments, each vertex colored by the local vector
 * magnitude through the color scale. Curves too short to segment (a bare
 * seed) contribute nothing. Deterministic: same inputs, same buffers.
 */
export function buildFieldStreamlinesGeometry(
  field: DecodedVectorField,
  seeds: readonly FieldStreamSeed[],
  options: FieldStreamlineOptions,
  scale: FieldColorScale,
): BufferGeometry {
  const ramp = fieldColorRamp(scale, [0, field.maxMagnitude]);
  const positions: number[] = [];
  const colors: number[] = [];
  for (const seed of seeds) {
    const points = integrateFieldStreamline(field, seed, options);
    for (let index = 0; index + 1 < points.length; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (from === undefined || to === undefined) continue;
      positions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      const fromColor = ramp(
        sampleVectorMagnitude(field, from[0], from[1], from[2]),
      );
      const toColor = ramp(sampleVectorMagnitude(field, to[0], to[1], to[2]));
      colors.push(
        fromColor[0],
        fromColor[1],
        fromColor[2],
        toColor[0],
        toColor[1],
        toColor[2],
      );
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
