/**
 * The pure arc-length walk over the kernel contract's sweep-path chains
 * (Phase 43): total length, point-at-arclength, and unit-tangent-at-
 * arclength, all in the path's LOCAL XZ plane (the same frame
 * {@link SweepPathSegmentInput} documents — the sweep's planar-XZ
 * constraint mapping). The path pattern's instance placement is computed
 * HERE, once, so the executor bridge and the workbench's worker scene
 * compose the identical arrangement (the `planHoleCut`/`planSplitCut`
 * one-source-of-truth precedent).
 *
 * ## Conventions (documented, deterministic)
 *
 * - Arc length is the SUM of the segments' own lengths: a line is its
 *   Euclidean length; an arc is `radius · |sweep|` with the SIGNED sweep
 *   `endAngle − startAngle` the directed-path convention carries (a
 *   negative sweep walks the arc clockwise, the same material, the other
 *   way round).
 * - A station `s` clamps to `[0, total]`: the walk never leaves the chain.
 *   Callers that need a beyond-the-end refusal (the path pattern: an
 *   instance past the chain's end) compare `s` against
 *   {@link sweepPathTotalLength} themselves — the walk itself stays total.
 * - The tangent at a joint is the OUTGOING segment's tangent (the chain is
 *   G1 by contract, so the incoming tangent agrees — the pick is a
 *   determinism note, not a semantics choice).
 * - At the final endpoint (`s = total`) the tangent is the LAST segment's
 *   tangent at its end: the direction the path is heading when it stops.
 * - All arithmetic is IEEE float64; no kernel, no randomness, no clock.
 */

import { valueIn } from "@slopcad/cad-core";
import type { SweepPathSegmentInput } from "./contract";

/** One segment's own arc length (a line's span or an arc's sweep). */
function segmentLength(segment: SweepPathSegmentInput): number {
  if (segment.kind === "line") {
    const dx = segment.end[0] - segment.start[0];
    const dz = segment.end[1] - segment.start[1];
    return Math.sqrt(dx * dx + dz * dz);
  }
  const sweep =
    valueIn(segment.endAngle, "rad") - valueIn(segment.startAngle, "rad");
  return segment.radius * Math.abs(sweep);
}

/**
 * The chain's total arc length (mm in the path's local frame). An empty
 * chain is length `0` — callers reject empty paths before walking (the
 * sweep contract's own `kernel/invalid-path` battery).
 */
export function sweepPathTotalLength(
  path: readonly SweepPathSegmentInput[],
): number {
  let total = 0;
  for (const segment of path) total += segmentLength(segment);
  return total;
}

/** The station walk's outcome: the point and the unit tangent at `s`. */
export interface SweepPathStation {
  /** The point at arc length `s` in the local XZ plane. */
  readonly point: readonly [number, number];
  /** The unit tangent at `s` (the direction of travel). */
  readonly tangent: readonly [number, number];
}

/** The point and unit tangent on one line at local station `s`. */
function lineStation(
  segment: Extract<SweepPathSegmentInput, { readonly kind: "line" }>,
  s: number,
): SweepPathStation {
  const dx = segment.end[0] - segment.start[0];
  const dz = segment.end[1] - segment.start[1];
  const length = Math.sqrt(dx * dx + dz * dz);
  // A zero-length line cannot occur (the sweep contract rejects it), but
  // the walk stays total: the degenerate case reports the start with the
  // +z tangent (the contract's initial-tangent rule).
  if (length === 0) {
    return { point: [segment.start[0], segment.start[1]], tangent: [0, 1] };
  }
  const unitX = dx / length;
  const unitZ = dz / length;
  return {
    point: [segment.start[0] + unitX * s, segment.start[1] + unitZ * s],
    tangent: [unitX, unitZ],
  };
}

/** The point and unit tangent on one arc at local station `s`. */
function arcStation(
  segment: Extract<SweepPathSegmentInput, { readonly kind: "arc" }>,
  s: number,
): SweepPathStation {
  const start = valueIn(segment.startAngle, "rad");
  const end = valueIn(segment.endAngle, "rad");
  const sweep = end - start;
  const direction = sweep >= 0 ? 1 : -1;
  const theta = start + (direction * s) / segment.radius;
  const px = segment.center[0] + segment.radius * Math.cos(theta);
  const pz = segment.center[1] + segment.radius * Math.sin(theta);
  // d/dθ (cos θ, sin θ) = (−sin θ, cos θ); a negative sweep walks θ
  // backwards, which reverses the tangent.
  const tx = -Math.sin(theta) * direction;
  const tz = Math.cos(theta) * direction;
  return { point: [px, pz], tangent: [tx, tz] };
}

/**
 * The station at arc length `s` (mm along the chain, clamped to
 * `[0, total]`): the point and the unit tangent in the local XZ plane.
 * An empty chain answers the origin with the +z tangent (the contract's
 * initial-tangent rule) — the caller's own empty-path rejection is the
 * structured answer for that input; the walk stays total.
 */
export function sweepPathStationAt(
  path: readonly SweepPathSegmentInput[],
  s: number,
): SweepPathStation {
  const clamped = Math.min(Math.max(s, 0), sweepPathTotalLength(path));
  let walked = 0;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (segment === undefined) continue;
    const length = segmentLength(segment);
    // A strict boundary comparison makes the JOINT answer the outgoing
    // segment's station 0 (the documented tangent rule); the final
    // segment always answers, so the endpoint keeps its own tangent.
    if (index === path.length - 1 || clamped < walked + length) {
      return segment.kind === "line"
        ? lineStation(segment, clamped - walked)
        : arcStation(segment, clamped - walked);
    }
    walked += length;
  }
  return { point: [0, 0], tangent: [0, 1] };
}
