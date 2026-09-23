/**
 * Motion basics (Phase 52): joint records with limits, the deterministic
 * parameter-driven animation, and the clearance probe between moving
 * occurrences — staged WITHOUT the Phase 51 mate solver.
 *
 * ## What moves, and what drives it
 *
 * An {@link AssemblyMotionJoint} pins ONE occurrence to an axis line
 * (revolute: rotation in degrees; slider: translation in millimetres) with
 * hard limits. {@link applyMotionJoint} maps a parameter (degrees or
 * millimetres, clamped into the limits) to the occurrence's LOCAL transform
 * — composed by the caller onto its resolved placement exactly like an
 * explode offset. Animation is parameter-driven: a scrubber or parameter
 * graph re-derives every frame from the same pure function, so identical
 * (joint, parameter) inputs are bitwise-identical (the placement module's
 * determinism contract). Limits are enforced at application — a parameter
 * outside them clamps, it never silences an out-of-range value into a
 * plausible one.
 *
 * ## The honest boundary against Phase 51
 *
 * Joint-DRIVEN motion — dragging an occurrence while the mate solver
 * propagates through remaining DOF — needs Phase 51's mate vocabulary and
 * solver, which is a separate phase family. It is declined with
 * {@link ASSEMBLY_MOTION_CAPABILITIES.dragDriven} = `false` and the
 * `assembly/motion-drag-pending-mates` code; parameter-driven animation is
 * fully supported and composes with the 51 solver when it lands (the joint
 * record's axis and limits vocabulary is deliberately the same shape).
 *
 * ## The clearance probe
 *
 * {@link probeMotionClearance} samples stations across the joint's limits
 * and measures the axis-aligned bounding-box distance between two
 * occurrences at each — a CONSERVATIVE FLOOR (boxes contain the solids, so
 * box distance ≤ solid distance): a positive floor proves clearance, a
 * non-positive floor flags the station for a kernel interference check
 * (Phase 51's boolean pairwise check owns the exact verdict). Named
 * honestly: clearance-floor, not interference.
 */

import type { DatumVec3 } from "./datum";

import { parseOccurrenceId, type OccurrenceId } from "./ids";
import {
  axisRotationTransform,
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  placementTransformBounds,
  type PlacementTransform,
} from "./placement";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes produced by motion joint application. */
export const ASSEMBLY_MOTION_ERROR_CODES = {
  jointMalformed: "assembly/motion-joint-malformed",
  parameterInvalid: "assembly/motion-parameter-invalid",
  probeInvalid: "assembly/motion-probe-invalid",
  dragUnsupported: "assembly/motion-drag-pending-mates",
} as const;

export type AssemblyMotionErrorCode =
  (typeof ASSEMBLY_MOTION_ERROR_CODES)[keyof typeof ASSEMBLY_MOTION_ERROR_CODES];

/** Structured failure describing why a motion joint could not be applied. */
export interface AssemblyMotionError extends ParseFailure {
  readonly code: AssemblyMotionErrorCode;
}

function motionError(
  code: AssemblyMotionErrorCode,
  message: string,
  input: unknown,
): AssemblyMotionError {
  return { code, message, input };
}

/**
 * What the Phase 52 motion surface supports — the capability flags the
 * workbench reads to disable (never fake) the unsupported verbs.
 */
export const ASSEMBLY_MOTION_CAPABILITIES = {
  /** Parameter-driven animation inside limits: supported. */
  parameterDriven: true,
  /** Joint-driven drag through the mate solver: declined until the Phase 51
   * solver exists (`assembly/motion-drag-pending-mates`). */
  dragDriven: false,
  /** Exact interference-under-motion: declined (Phase 51 owns the boolean
   * pairwise check); the bounds clearance floor is the supported probe. */
  exactInterference: false,
} as const;

/** The motion joint vocabulary Phase 52 supports (the 51 joint kinds' motion
 * subset — cylindrical/planar/ball need the solver's DOF accounting). */
export type AssemblyMotionJointKind = "revolute" | "slider";

/**
 * One occurrence's motion joint: an axis line, a kind, hard limits. For a
 * revolute joint the limits are DEGREES (right-hand rule about the axis);
 * for a slider, MILLIMETRES along it. `limitMin` may exceed `limitMax`
 * numerically — the joint sweeps the axis either way — but the range must
 * be non-empty.
 */
export interface AssemblyMotionJoint {
  readonly occurrenceId: OccurrenceId;
  readonly kind: AssemblyMotionJointKind;
  readonly axisOrigin: DatumVec3;
  readonly axisDirection: DatumVec3;
  readonly limitMin: number;
  readonly limitMax: number;
}

/**
 * Validates untrusted input as a motion joint (the fixture pages' and the
 * future persistence boundary's gate). Directions must be finite non-zero
 * (normalized here — the explode offset's discipline); limits finite with
 * a non-empty range.
 */
export function parseAssemblyMotionJoint(
  input: unknown,
): ParseResult<AssemblyMotionJoint, AssemblyMotionError> {
  if (typeof input !== "object" || input === null) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        "A motion joint must be an object.",
        input,
      ),
    );
  }
  const record = input as Record<string, unknown>;
  if (record.kind !== "revolute" && record.kind !== "slider") {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        'A motion joint\'s kind must be "revolute" or "slider".',
        record.kind,
      ),
    );
  }
  if (
    typeof record.occurrenceId !== "string" ||
    record.occurrenceId.length === 0
  ) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        "A motion joint must name its occurrence.",
        record.occurrenceId,
      ),
    );
  }
  const occurrenceId = parseOccurrenceId(record.occurrenceId);
  if (!occurrenceId.ok) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        `A motion joint's occurrence id is malformed: ${occurrenceId.error.message}`,
        record.occurrenceId,
      ),
    );
  }
  if (
    !Array.isArray(record.axisOrigin) ||
    record.axisOrigin.length !== 3 ||
    record.axisOrigin.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        "A motion joint's axis origin must be a finite point.",
        record.axisOrigin,
      ),
    );
  }
  const axisOriginEntries = record.axisOrigin as unknown[];
  const axisOrigin: DatumVec3 = [
    Number(axisOriginEntries[0]),
    Number(axisOriginEntries[1]),
    Number(axisOriginEntries[2]),
  ];
  if (
    !Array.isArray(record.axisDirection) ||
    record.axisDirection.length !== 3 ||
    record.axisDirection.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        "A motion joint's axis direction must be a finite 3-vector.",
        record.axisDirection,
      ),
    );
  }
  const directionEntries = record.axisDirection as unknown[];
  const direction: DatumVec3 = [
    Number(directionEntries[0]),
    Number(directionEntries[1]),
    Number(directionEntries[2]),
  ];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length < 1e-12) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        "A motion joint's axis direction must be non-zero (normalize it to unit before authoring).",
        record.axisDirection,
      ),
    );
  }
  if (
    typeof record.limitMin !== "number" ||
    typeof record.limitMax !== "number" ||
    !Number.isFinite(record.limitMin) ||
    !Number.isFinite(record.limitMax) ||
    record.limitMin === record.limitMax
  ) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.jointMalformed,
        "A motion joint's limits must be finite and non-empty (limitMin may exceed limitMax numerically; they may not be equal).",
        [record.limitMin, record.limitMax],
      ),
    );
  }
  return ok({
    occurrenceId: occurrenceId.value,
    kind: record.kind,
    axisOrigin,
    axisDirection: [
      direction[0] / length,
      direction[1] / length,
      direction[2] / length,
    ],
    limitMin: record.limitMin,
    limitMax: record.limitMax,
  });
}

/**
 * The drag decline's canonical structured result: joint-driven drag needs
 * the Phase 51 mate solver's remaining-DOF propagation; parameter-driven
 * animation is the supported motion. ONE decline, not ad-hoc messages.
 */
export function motionDragDecline(
  input: unknown,
): ParseResult<never, AssemblyMotionError> {
  return fail(
    motionError(
      ASSEMBLY_MOTION_ERROR_CODES.dragUnsupported,
      "Joint-driven drag is not supported yet: it needs the mate solver's remaining-DOF propagation (Phase 51). Drive the joint with a parameter — the animation is deterministic under scrub.",
      input,
    ),
  );
}

/**
 * Maps a joint parameter to the occurrence's LOCAL transform: revolute
 * rotates about the joint axis (right-hand rule); slider translates along
 * it. The parameter clamps into `[min(limitMin, limitMax), max(limitMin,
 * limitMax)]` — limits are hard. Deterministic pure arithmetic.
 */
export function applyMotionJoint(
  joint: AssemblyMotionJoint,
  parameter: number,
): ParseResult<PlacementTransform, AssemblyMotionError> {
  if (!Number.isFinite(parameter)) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.parameterInvalid,
        `The joint parameter must be a finite number; got ${String(parameter)}.`,
        parameter,
      ),
    );
  }
  const low = Math.min(joint.limitMin, joint.limitMax);
  const high = Math.max(joint.limitMin, joint.limitMax);
  const clamped = Math.min(high, Math.max(low, parameter));
  if (joint.kind === "slider") {
    const [ux, uy, uz] = joint.axisDirection;
    return ok({
      rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
      translation: [ux * clamped, uy * clamped, uz * clamped],
    });
  }
  return ok(
    axisRotationTransform(
      joint.axisOrigin,
      joint.axisDirection,
      (clamped * Math.PI) / 180,
    ),
  );
}

/**
 * Samples `stationCount` stations uniformly across the joint's limits,
 * INCLUSIVE of both ends, deterministic order low parameter first (after
 * normalizing the limit order). `stationCount` must be a whole number ≥ 2
 * (the two limit ends are the minimum sampling); the clamped parameter at
 * each station rides along so callers see the limits bite.
 */
export function jointStationParameters(
  joint: AssemblyMotionJoint,
  stationCount: number,
): ParseResult<readonly number[], AssemblyMotionError> {
  if (!Number.isInteger(stationCount) || stationCount < 2) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.probeInvalid,
        "A joint's station count must be a whole number of at least 2 (both limit ends).",
        stationCount,
      ),
    );
  }
  const low = Math.min(joint.limitMin, joint.limitMax);
  const high = Math.max(joint.limitMin, joint.limitMax);
  const stations: number[] = [];
  for (let index = 0; index < stationCount; index += 1) {
    const t = index / (stationCount - 1);
    stations.push(low + (high - low) * t);
  }
  return ok(stations);
}

/** An axis-aligned box pair's world bounds (the probe's per-instance input). */
export interface MotionProbeBounds {
  readonly min: DatumVec3;
  readonly max: DatumVec3;
}

/** One clearance sample: the station's parameter and the boxes' distance. */
export interface MotionClearanceSample {
  readonly parameter: number;
  /** The bounding-box distance at this station (0 when the boxes overlap). */
  readonly clearanceMm: number;
}

/**
 * Probes the clearance FLOOR between two occurrences across a joint's
 * stations: at each station the moving occurrence's bounds re-derive from
 * its base bounds composed with the joint transform, and the axis-aligned
 * box distance measures. Conservative: box distance ≤ solid distance, so a
 * positive floor proves clearance and a non-positive one flags the station
 * for Phase 51's exact boolean interference check. Deterministic station
 * order.
 */
export function probeMotionClearance(input: {
  readonly joint: AssemblyMotionJoint;
  readonly stationCount: number;
  /** The moving occurrence's LOCAL bounds (before the joint transform). */
  readonly movingBounds: MotionProbeBounds;
  /** The moving occurrence's resolved placement (its world transform). */
  readonly movingTransform: PlacementTransform;
  /** The stationary occurrence's world bounds. */
  readonly stationaryBounds: MotionProbeBounds;
  /** Samples below this floor (inclusive) flag as contacts to re-check. */
  readonly contactFloorMm: number;
}): ParseResult<
  {
    readonly samples: readonly MotionClearanceSample[];
    readonly minClearanceMm: number;
    readonly flaggedStations: readonly number[];
  },
  AssemblyMotionError
> {
  const stations = jointStationParameters(input.joint, input.stationCount);
  if (!stations.ok) return stations;
  if (
    input.contactFloorMm === undefined ||
    !Number.isFinite(input.contactFloorMm)
  ) {
    return fail(
      motionError(
        ASSEMBLY_MOTION_ERROR_CODES.probeInvalid,
        `The contact floor must be a finite number; got ${String(input.contactFloorMm)}.`,
        input.contactFloorMm,
      ),
    );
  }
  const stationary = input.stationaryBounds;
  const samples: MotionClearanceSample[] = [];
  let minClearanceMm = Number.POSITIVE_INFINITY;
  const flagged: number[] = [];
  for (const parameter of stations.value) {
    const jointTransform = applyMotionJoint(input.joint, parameter);
    if (!jointTransform.ok) return jointTransform;
    const world = composePlacementTransforms(
      jointTransform.value,
      input.movingTransform,
    );
    const localMin: DatumVec3 = [...input.movingBounds.min];
    const localMax: DatumVec3 = [...input.movingBounds.max];
    const moved = placementTransformBounds(world, localMin, localMax);
    const clearance = boxDistanceMm(moved, stationary);
    samples.push({ parameter, clearanceMm: clearance });
    if (clearance < minClearanceMm) minClearanceMm = clearance;
    if (clearance <= input.contactFloorMm) flagged.push(parameter);
  }
  return ok({ samples, minClearanceMm, flaggedStations: flagged });
}

/**
 * The axis-aligned box distance: the largest per-axis gap (0 when the boxes
 * overlap on every axis). Deterministic pure arithmetic.
 */
function boxDistanceMm(
  a: { readonly min: DatumVec3; readonly max: DatumVec3 },
  b: { readonly min: DatumVec3; readonly max: DatumVec3 },
): number {
  const gaps = [
    Math.max(b.min[0] - a.max[0], a.min[0] - b.max[0]),
    Math.max(b.min[1] - a.max[1], a.min[1] - b.max[1]),
    Math.max(b.min[2] - a.max[2], a.min[2] - b.max[2]),
  ];
  return Math.max(0, ...gaps);
}
