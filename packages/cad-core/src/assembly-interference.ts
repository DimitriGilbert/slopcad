/**
 * Assembly interference detection (Phase 51): the pairwise check that
 * finds placed occurrences whose solids penetrate each other, with a
 * structured report — occurrence pairs, intersection volumes, world
 * bounding boxes — and a batch entry point over a whole resolution.
 *
 * ## The kernel seam (honesty about what computes what)
 *
 * Pairwise boolean intersection is KERNEL work (every kernel's contract
 * exposes `intersect` and `volume` today); cad-core never imports a
 * kernel. The detector consumes a host-supplied seam —
 * {@link InterferenceVolumeFn} — that answers the intersection volume of
 * two body placements (the executor binds it to the active kernel), plus
 * each occurrence's LOCAL bounds. What cad-core owns is the deterministic
 * BATCH: the fixed pair order, the analytic bounding-box rejection that
 * skips provably disjoint pairs before the kernel is ever asked, the
 * tolerance rule, and the report shape.
 *
 * `null` from the seam means "this kernel cannot answer this pair"
 * (sheets, unsupported operands) — recorded as a skipped pair, never
 * silently folded into "no interference".
 *
 * Determinism: identical instances, bounds, and seam answers produce an
 * identical report — pairs iterate in path-then-body document order.
 */

import { type DatumVec3 } from "./datum";
import { type BodyId, type OccurrenceId } from "./ids";
import { placementTransformBounds, type PlacementTransform } from "./placement";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes for the interference batch. */
export const INTERFERENCE_ERROR_CODES = {
  malformed: "assembly/interference-malformed",
} as const;

export type InterferenceErrorCode =
  (typeof INTERFERENCE_ERROR_CODES)[keyof typeof INTERFERENCE_ERROR_CODES];

/** Structured failure describing why a batch check was rejected. */
export interface InterferenceError extends ParseFailure {
  readonly code: InterferenceErrorCode;
}

/**
 * The seam the executor binds to the active kernel: the boolean
 * intersection VOLUME of two body placements in cubic millimetres, or
 * `null` when the kernel cannot answer the pair (sheets, unsupported
 * operands — recorded as skipped, never folded into "no interference").
 */
export type InterferenceVolumeFn = (
  a: { readonly bodyId: BodyId; readonly transform: PlacementTransform },
  b: { readonly bodyId: BodyId; readonly transform: PlacementTransform },
) => number | null;

/** One checked occurrence: its instance identity, transform, local bounds. */
export interface InterferenceInstance {
  /** The occurrence path, outermost first (the instance's identity). */
  readonly path: readonly OccurrenceId[];
  readonly bodyId: BodyId;
  readonly transform: PlacementTransform;
  /** The body's LOCAL-space AABB (world bounds are derived here). */
  readonly bounds: { readonly min: DatumVec3; readonly max: DatumVec3 };
}

/** One interfering pair in the report. */
export interface InterferencePair {
  /** The first instance's path, outermost first. */
  readonly firstPath: readonly OccurrenceId[];
  readonly firstBodyId: BodyId;
  readonly secondPath: readonly OccurrenceId[];
  readonly secondBodyId: BodyId;
  /** The boolean intersection volume (mm³), strictly above tolerance. */
  readonly volume: number;
  /** The two instances' WORLD bounding boxes (exact, corner-transformed). */
  readonly firstBounds: { readonly min: DatumVec3; readonly max: DatumVec3 };
  readonly secondBounds: { readonly min: DatumVec3; readonly max: DatumVec3 };
}

/** Two instances the seam could not answer (kernel declined the pair). */
export interface SkippedInterferencePair {
  readonly firstPath: readonly OccurrenceId[];
  readonly secondPath: readonly OccurrenceId[];
  readonly reason: "kernel-declined";
}

/** The batch interference report. */
export interface InterferenceReport {
  /** Interfering pairs, in fixed path-then-body document order. */
  readonly pairs: readonly InterferencePair[];
  /** Pairs the kernel seam declined (recorded, never silent). */
  readonly skipped: readonly SkippedInterferencePair[];
  /** How many pairs passed the bounding-box pre-filter untouched. */
  readonly checkedPairs: number;
  /** The volume above which a pair counts as interfering (mm³). */
  readonly tolerance: number;
}

/** The batch check's inputs. */
export interface InterferenceCheckInput {
  readonly instances: readonly InterferenceInstance[];
  /**
   * The kernel-bound intersection volume seam — required. A caller
   * without a kernel binds a seam that answers `null` for every pair,
   * which the report records as skipped pairs (reason
   * `kernel-declined`), never as "no interference".
   */
  readonly intersectVolume: InterferenceVolumeFn;
  /** Volumes at or below this (mm³) count as touching, not interfering. */
  readonly tolerance?: number;
}

const DEFAULT_INTERFERENCE_TOLERANCE = 1e-9;

/**
 * Validates the batch's instances (paths non-empty, bounds well-formed)
 * at the trust boundary, then runs the deterministic pairwise check.
 */
export function checkAssemblyInterference(
  input: InterferenceCheckInput,
): ParseResult<InterferenceReport, InterferenceError> {
  for (const instance of input.instances) {
    if (
      instance.path.length === 0 ||
      instance.path.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      return fail({
        code: INTERFERENCE_ERROR_CODES.malformed,
        message:
          "An interference instance must carry a non-empty occurrence path.",
        input: instance,
      });
    }
    const { min, max } = instance.bounds;
    const finitePairs: [number, number][] = [
      [min[0], max[0]],
      [min[1], max[1]],
      [min[2], max[2]],
    ];
    if (
      finitePairs.some(
        ([low, high]) =>
          !Number.isFinite(low) || !Number.isFinite(high) || low > high,
      )
    ) {
      return fail({
        code: INTERFERENCE_ERROR_CODES.malformed,
        message:
          "An interference instance's bounds must be finite triples with min <= max per axis.",
        input: instance,
      });
    }
  }
  const tolerance = input.tolerance ?? DEFAULT_INTERFERENCE_TOLERANCE;

  const worldBounds = input.instances.map((instance) =>
    placementTransformBounds(
      instance.transform,
      instance.bounds.min,
      instance.bounds.max,
    ),
  );

  const pairs: InterferencePair[] = [];
  const skipped: SkippedInterferencePair[] = [];
  let checkedPairs = 0;
  for (let i = 0; i < input.instances.length; i += 1) {
    const first = input.instances[i];
    if (first === undefined) continue;
    const firstWorld = worldBounds[i];
    if (firstWorld === undefined) continue;
    for (let j = i + 1; j < input.instances.length; j += 1) {
      const second = input.instances[j];
      if (second === undefined) continue;
      const secondWorld = worldBounds[j];
      if (secondWorld === undefined) continue;
      if (!boxesOverlap(firstWorld, secondWorld)) continue;
      checkedPairs += 1;
      const volume = input.intersectVolume(
        { bodyId: first.bodyId, transform: first.transform },
        { bodyId: second.bodyId, transform: second.transform },
      );
      if (volume === null) {
        skipped.push({
          firstPath: [...first.path],
          secondPath: [...second.path],
          reason: "kernel-declined",
        });
        continue;
      }
      if (volume <= tolerance) continue;
      pairs.push({
        firstPath: [...first.path],
        firstBodyId: first.bodyId,
        secondPath: [...second.path],
        secondBodyId: second.bodyId,
        volume,
        firstBounds: firstWorld,
        secondBounds: secondWorld,
      });
    }
  }
  return ok({ pairs, skipped, checkedPairs, tolerance });
}

function boxesOverlap(
  a: { readonly min: DatumVec3; readonly max: DatumVec3 },
  b: { readonly min: DatumVec3; readonly max: DatumVec3 },
): boolean {
  return (
    a.min[0] <= b.max[0] &&
    b.min[0] <= a.max[0] &&
    a.min[1] <= b.max[1] &&
    b.min[1] <= a.max[1] &&
    a.min[2] <= b.max[2] &&
    b.min[2] <= a.max[2]
  );
}

/**
 * The batch check over a whole RESOLUTION: binds Phase 50's instance
 * walk to the detector. Local bounds come from the host per body (the
 * projection's bounds before placement); instances of bodies the host
 * has no bounds for are declined structurally.
 */
export function checkResolvedAssemblyInterference(input: {
  readonly instances: readonly {
    readonly path: readonly OccurrenceId[];
    readonly bodyId: BodyId;
    readonly transform: PlacementTransform;
  }[];
  readonly boundsOf: (
    bodyId: BodyId,
  ) => { readonly min: DatumVec3; readonly max: DatumVec3 } | undefined;
  readonly intersectVolume: InterferenceVolumeFn;
  readonly tolerance?: number;
}): ParseResult<InterferenceReport, InterferenceError> {
  const checks: InterferenceInstance[] = [];
  for (const instance of input.instances) {
    const bounds = input.boundsOf(instance.bodyId);
    if (bounds === undefined) {
      return fail({
        code: INTERFERENCE_ERROR_CODES.malformed,
        message: `No local bounds were supplied for body ${instance.bodyId}; the interference batch refuses to guess them.`,
        input: instance,
      });
    }
    checks.push({ ...instance, bounds });
  }
  return checkAssemblyInterference({
    instances: checks,
    intersectVolume: input.intersectVolume,
    tolerance: input.tolerance,
  });
}
