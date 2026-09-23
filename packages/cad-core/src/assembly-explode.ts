/**
 * Exploded views (Phase 52): the state, the deterministic serialization
 * round-trip, and the scrubbed application over resolved instances.
 *
 * ## The state
 *
 * An {@link AssemblyExplodeState} carries one OFFSET per occurrence path —
 * a unit direction plus a distance in millimetres, applied at factor 1 —
 * plus an optional RADIAL auto-explode rule (every instance, direction from
 * the assembly centroid through the instance's own centroid, one shared
 * distance). Authored per-occurrence offsets WIN over the radial rule for
 * their paths: the radial rule is the authoring shortcut, the explicit
 * entries the precision.
 *
 * ## The scrub is the animation
 *
 * {@link applyExplodeState} composes each instance's transform with its
 * explode translation scaled by a FACTOR t ∈ [0, 1] (clamped; linear;
 * 0 = assembled, 1 = fully exploded). Playback is parameter-driven — a
 * scrubber or a parameter graph re-derives every frame from the same pure
 * function, so identical (state, factor) inputs render bitwise-identical
 * frames (the placement module's determinism contract, the property the
 * animation scrub stands on). No clocks, no easing state, no rAF.
 *
 * ## Serialization
 *
 * {@link serializeExplodeState} emits the canonical JSON form (paths in
 * entry order, finite numbers); {@link parseExplodeState} validates it
 * back — the round-trip the Phase 52 validation names. The state persists
 * beside the document as its own record — SESSION-SCOPED until the envelope
 * grows to carry it, and that envelope growth is deferred (Phase 51's v5
 * grew for mates and joints; explode offsets and motion stations were not
 * taken along natively).
 */

import type { DatumVec3 } from "./datum";

import { parseOccurrenceId, type OccurrenceId } from "./ids";
import {
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  type PlacementTransform,
} from "./placement";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes produced by explode-state parsing and application. */
export const ASSEMBLY_EXPLODE_ERROR_CODES = {
  stateMalformed: "assembly/explode-state-malformed",
  factorInvalid: "assembly/explode-factor-invalid",
  offsetInvalid: "assembly/explode-offset-invalid",
} as const;

export type AssemblyExplodeErrorCode =
  (typeof ASSEMBLY_EXPLODE_ERROR_CODES)[keyof typeof ASSEMBLY_EXPLODE_ERROR_CODES];

/** Structured failure describing why an explode state could not be used. */
export interface AssemblyExplodeError extends ParseFailure {
  readonly code: AssemblyExplodeErrorCode;
}

function explodeError(
  code: AssemblyExplodeErrorCode,
  message: string,
  input: unknown,
): AssemblyExplodeError {
  return { code, message, input };
}

/** One authored explode offset: direction (unit) + distance (mm) at t=1. */
export interface AssemblyExplodeOffset {
  readonly direction: DatumVec3;
  readonly distanceMm: number;
}

/**
 * The stored explode state: explicit per-path offsets plus the optional
 * radial rule. Occurrence paths are OUTERMOST FIRST — the instance path
 * order the assembly ADR pins.
 */
export interface AssemblyExplodeState {
  /** Explicit per-path offsets, in authoring order (these win). */
  readonly entries: readonly {
    readonly path: readonly OccurrenceId[];
    readonly offset: AssemblyExplodeOffset;
  }[];
  /**
   * The radial auto-explode rule: every instance NOT covered by an explicit
   * entry moves radially from the assembly centroid through its own
   * centroid, by this distance at t=1. `undefined` = no radial rule.
   */
  readonly radialDistanceMm?: number;
}

/** One resolved instance's explode input: its path and placed centroid. */
export interface AssemblyExplodeInstance {
  readonly path: readonly OccurrenceId[];
  /** The instance's world-space centroid (the placed bounds' center). */
  readonly centroid: DatumVec3;
}

/**
 * The longest path length any state may address (the assembly walk's own
 * depth limit — an explode state cannot address deeper than instances can
 * nest).
 */
export const ASSEMBLY_EXPLODE_PATH_DEPTH_LIMIT = 16;

/** Validates untrusted parsed input as one explode offset. */
function parseOffset(
  input: unknown,
): ParseResult<AssemblyExplodeOffset, AssemblyExplodeError> {
  if (typeof input !== "object" || input === null) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
        "An explode offset must be an object with a direction and a distanceMm.",
        input,
      ),
    );
  }
  const record = input as { direction?: unknown; distanceMm?: unknown };
  if (
    !Array.isArray(record.direction) ||
    record.direction.length !== 3 ||
    record.direction.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
        "An explode offset's direction must be a finite 3-vector.",
        input,
      ),
    );
  }
  const directionEntries = record.direction as unknown[];
  const x = Number(directionEntries[0]);
  const y = Number(directionEntries[1]);
  const z = Number(directionEntries[2]);
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.offsetInvalid,
        "An explode offset's direction must be non-zero (normalize it to unit before authoring).",
        input,
      ),
    );
  }
  if (
    typeof record.distanceMm !== "number" ||
    !Number.isFinite(record.distanceMm) ||
    record.distanceMm < 0
  ) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
        "An explode offset's distanceMm must be a non-negative finite number.",
        input,
      ),
    );
  }
  return ok({
    direction: [x / length, y / length, z / length],
    distanceMm: record.distanceMm,
  });
}

/**
 * Parses untrusted input (the canonical JSON form) into a validated
 * {@link AssemblyExplodeState}. The round-trip's reading half: paths come
 * back as occurrence-id strings, directions normalized unit, entries in
 * file order.
 */
export function parseExplodeState(
  input: unknown,
): ParseResult<AssemblyExplodeState, AssemblyExplodeError> {
  if (typeof input !== "object" || input === null || !("entries" in input)) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
        'An explode state must be an object with an "entries" array (and an optional radialDistanceMm).',
        input,
      ),
    );
  }
  const record = input as {
    entries?: unknown;
    radialDistanceMm?: unknown;
  };
  if (!Array.isArray(record.entries)) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
        "An explode state's entries must be an array of { path, offset } records.",
        input,
      ),
    );
  }
  const entries: AssemblyExplodeState["entries"][number][] = [];
  for (const entry of record.entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      !("offset" in entry)
    ) {
      return fail(
        explodeError(
          ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
          "An explode entry must be an object with a path and an offset.",
          entry,
        ),
      );
    }
    const entryRecord = entry as { path?: unknown; offset?: unknown };
    if (
      !Array.isArray(entryRecord.path) ||
      entryRecord.path.length > ASSEMBLY_EXPLODE_PATH_DEPTH_LIMIT
    ) {
      return fail(
        explodeError(
          ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
          `An explode entry's path must be an array of occurrence-id strings, at most ${String(ASSEMBLY_EXPLODE_PATH_DEPTH_LIMIT)} deep.`,
          entryRecord.path,
        ),
      );
    }
    const path: OccurrenceId[] = [];
    for (const id of entryRecord.path) {
      const parsed = parseOccurrenceId(id);
      if (!parsed.ok) {
        return fail(
          explodeError(
            ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
            `An explode entry's path must carry valid occurrence ids: ${parsed.error.message}`,
            id,
          ),
        );
      }
      path.push(parsed.value);
    }
    const offset = parseOffset(entryRecord.offset);
    if (!offset.ok) return offset;
    entries.push({ path, offset: offset.value });
  }
  if (
    record.radialDistanceMm !== undefined &&
    (typeof record.radialDistanceMm !== "number" ||
      !Number.isFinite(record.radialDistanceMm) ||
      record.radialDistanceMm < 0)
  ) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
        "An explode state's radialDistanceMm must be a non-negative finite number when present.",
        record.radialDistanceMm,
      ),
    );
  }
  return ok({
    entries,
    radialDistanceMm: record.radialDistanceMm,
  });
}

/**
 * Serializes a state to the canonical JSON value: paths as occurrence-id
 * strings in entry order, directions normalized unit, `radialDistanceMm`
 * present exactly when authored. `JSON.stringify` of this value (with the
 * same state) is byte-identical across runs.
 */
export function serializeExplodeState(state: AssemblyExplodeState): unknown {
  return {
    entries: state.entries.map((entry) => ({
      path: entry.path.map((id) => String(id)),
      offset: {
        // Normalize on write too, so a round-trip is stable even from a
        // hand-built state whose direction was not unit.
        direction: normalizedDirection(entry.offset.direction),
        distanceMm: entry.offset.distanceMm,
      },
    })),
    ...(state.radialDistanceMm === undefined
      ? {}
      : { radialDistanceMm: state.radialDistanceMm }),
  };
}

function normalizedDirection(direction: DatumVec3): DatumVec3 {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length < 1e-12) return [0, 0, 0];
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

/**
 * Derives the radial rule's per-instance directions: from the assembly
 * centroid THROUGH each instance's centroid (normalized). An instance AT
 * the centroid gets no radial direction — it cannot move radially, so it
 * stays (a structured no-entry, never a NaN).
 */
export function radialExplodeOffsets(
  instances: readonly AssemblyExplodeInstance[],
  centroid: DatumVec3,
  distanceMm: number,
): ReadonlyMap<string, AssemblyExplodeOffset> {
  const offsets = new Map<string, AssemblyExplodeOffset>();
  for (const instance of instances) {
    const direction: DatumVec3 = [
      instance.centroid[0] - centroid[0],
      instance.centroid[1] - centroid[1],
      instance.centroid[2] - centroid[2],
    ];
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (length < 1e-12) continue;
    offsets.set(instance.path.map((id) => String(id)).join(">"), {
      direction: [
        direction[0] / length,
        direction[1] / length,
        direction[2] / length,
      ],
      distanceMm,
    });
  }
  return offsets;
}

/**
 * Applies the state at scrub factor `factor` (clamped to [0, 1], linear):
 * each instance's transform composes with its explode translation —
 * explicit entries first (path match), the radial rule for the rest. The
 * returned map is keyed by the instance's joined path; instances with no
 * applicable offset map to their input transform unchanged. Deterministic:
 * identical inputs produce bitwise-identical transforms.
 */
export function applyExplodeState(input: {
  readonly state: AssemblyExplodeState;
  readonly instances: readonly AssemblyExplodeInstance[];
  readonly transforms: ReadonlyMap<string, PlacementTransform>;
  readonly factor: number;
  readonly centroid: DatumVec3;
}): ParseResult<ReadonlyMap<string, PlacementTransform>, AssemblyExplodeError> {
  if (!Number.isFinite(input.factor)) {
    return fail(
      explodeError(
        ASSEMBLY_EXPLODE_ERROR_CODES.factorInvalid,
        `The explode factor must be a finite number; got ${String(input.factor)}.`,
        input.factor,
      ),
    );
  }
  const factor = Math.min(1, Math.max(0, input.factor));
  const explicit = new Map<string, AssemblyExplodeOffset>();
  for (const entry of input.state.entries) {
    explicit.set(entry.path.map((id) => String(id)).join(">"), entry.offset);
  }
  const radial =
    input.state.radialDistanceMm === undefined
      ? null
      : radialExplodeOffsets(
          input.instances,
          input.centroid,
          input.state.radialDistanceMm,
        );
  const applied = new Map<string, PlacementTransform>();
  for (const instance of input.instances) {
    const key = instance.path.map((id) => String(id)).join(">");
    const transform = input.transforms.get(key);
    if (transform === undefined) {
      return fail(
        explodeError(
          ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed,
          `The instance at path "${key}" has no resolved transform to explode.`,
          key,
        ),
      );
    }
    const offset = explicit.get(key) ?? radial?.get(key);
    if (offset === undefined) {
      applied.set(key, transform);
      continue;
    }
    applied.set(
      key,
      composePlacementTransforms(
        {
          rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
          translation: [
            offset.direction[0] * offset.distanceMm * factor,
            offset.direction[1] * offset.distanceMm * factor,
            offset.direction[2] * offset.distanceMm * factor,
          ],
        },
        transform,
      ),
    );
  }
  return ok(applied);
}
