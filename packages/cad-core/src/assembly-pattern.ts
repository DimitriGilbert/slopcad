/**
 * Component patterns and mirror components (Phase 52): the PURE transform
 * algebra that multiplies and reflects an occurrence's placement — the
 * assembly-level twin of the body-level pattern features.
 *
 * ## What a component pattern is
 *
 * A pattern resolves a SEED placement into the placements of the generated
 * occurrences: linear (a unit direction, a count, a spacing), circular
 * (a datum axis line, a count, an angle step, right-hand rule), or mirrored
 * (a datum plane). It never touches documents, ids, or the kernel — the
 * caller stamps the resolved placements onto new occurrences through the
 * existing `addOccurrence` door, so a patterned assembly is an ordinary
 * occurrence tree (resolution, projection, and the native format stay
 * untouched).
 *
 * ## Handedness, decided honestly
 *
 * A placement transform is RIGID (rotation det +1, translation) — it cannot
 * express a reflection. Mirror components therefore mirror the PLACEMENT:
 * the instance's position reflects across the plane and its orientation
 * composes with the reflection through a local z-flip that keeps the
 * transform's determinant +1 (the instance sits at the mirrored spot,
 * handedness preserved). MIRRORED GEOMETRY — the enantiomorph flip a kernel
 * mirror op would produce — is a structured decline with the
 * {@link ASSEMBLY_PATTERN_CAPABILITIES.mirroredGeometry} capability flag:
 * promised only when a kernel binding exposes the op (probe first).
 *
 * ## Declines
 *
 * Path-driven patterns decline with `assembly/pattern-path-unsupported`
 * (a resolved path-curve source along occurrences does not exist yet — the
 * Phase 52 block's own list places them after linear/circular). Every other
 * refusal is a structured `assembly/pattern-*` code naming the bad input.
 * All functions are deterministic pure arithmetic: identical inputs produce
 * bitwise-identical placement lists, in instance order.
 */

import type { DatumVec3 } from "./datum";

import {
  PLACEMENT_ORTHONORMAL_TOLERANCE,
  axisRotationTransform,
  composePlacementTransforms,
  type PlacementRotation,
  type PlacementTransform,
} from "./placement";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes produced by pattern and mirror resolution. */
export const ASSEMBLY_PATTERN_ERROR_CODES = {
  countInvalid: "assembly/pattern-count-invalid",
  spacingInvalid: "assembly/pattern-spacing-invalid",
  stepInvalid: "assembly/pattern-step-invalid",
  directionInvalid: "assembly/pattern-direction-invalid",
  axisInvalid: "assembly/pattern-axis-invalid",
  planeInvalid: "assembly/pattern-plane-invalid",
  pathUnsupported: "assembly/pattern-path-unsupported",
  mirrorGeometryUnsupported: "assembly/mirror-geometry-unsupported",
} as const;

export type AssemblyPatternErrorCode =
  (typeof ASSEMBLY_PATTERN_ERROR_CODES)[keyof typeof ASSEMBLY_PATTERN_ERROR_CODES];

/** Structured failure describing why a pattern could not resolve. */
export interface AssemblyPatternError extends ParseFailure {
  readonly code: AssemblyPatternErrorCode;
}

function patternError(
  code: AssemblyPatternErrorCode,
  message: string,
  input: unknown,
): AssemblyPatternError {
  return { code, message, input };
}

/**
 * What the Phase 52 pattern/mirror surface supports — the capability flags
 * the workbench reads to disable (never fake) the unsupported verbs.
 */
export const ASSEMBLY_PATTERN_CAPABILITIES = {
  /** Linear and circular patterns: supported. */
  linearCircular: true,
  /** Path-driven patterns: declined (`assembly/pattern-path-unsupported`). */
  pathDriven: false,
  /** Mirror components: placement mirroring supported. */
  mirrorPlacement: true,
  /** Mirrored GEOMETRY (the handedness flip): declined until a kernel
   * mirror op is bound (probe first — never promise the op). */
  mirroredGeometry: false,
} as const;

/**
 * The instance-count ceiling for one pattern (the hole position limit's
 * discipline): resolution is pure, but every generated occurrence rides a
 * full resolve/project/render pass, so a stray count cannot wedge a session.
 */
export const OCCURRENCE_PATTERN_INSTANCE_LIMIT = 1000;

/** Validates a finite count in `[1, OCCURRENCE_PATTERN_INSTANCE_LIMIT]`. */
function resolveCount(
  count: number,
  input: unknown,
): ParseResult<number, AssemblyPatternError> {
  if (!Number.isInteger(count) || count < 1) {
    return fail(
      patternError(
        ASSEMBLY_PATTERN_ERROR_CODES.countInvalid,
        `A pattern generates a whole number of instances between 1 and ${String(OCCURRENCE_PATTERN_INSTANCE_LIMIT)}; got ${String(count)}.`,
        input,
      ),
    );
  }
  if (count > OCCURRENCE_PATTERN_INSTANCE_LIMIT) {
    return fail(
      patternError(
        ASSEMBLY_PATTERN_ERROR_CODES.countInvalid,
        `A pattern generates at most ${String(OCCURRENCE_PATTERN_INSTANCE_LIMIT)} instances per feature; got ${String(count)}.`,
        input,
      ),
    );
  }
  return ok(count);
}

/** Validates a finite, unit (within placement tolerance) direction. */
function resolveUnitVector(
  vector: DatumVec3,
  code: AssemblyPatternErrorCode,
  noun: string,
  input: unknown,
): ParseResult<DatumVec3, AssemblyPatternError> {
  if (vector.length !== 3 || vector.some((entry) => !Number.isFinite(entry))) {
    return fail(
      patternError(
        code,
        `The pattern ${noun} must be a finite 3-vector.`,
        input,
      ),
    );
  }
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (Math.abs(length - 1) > PLACEMENT_ORTHONORMAL_TOLERANCE) {
    return fail(
      patternError(
        code,
        `The pattern ${noun} must be unit (got length ${String(length)}); normalize it before authoring the pattern.`,
        input,
      ),
    );
  }
  return ok([vector[0], vector[1], vector[2]]);
}

/**
 * Resolves a LINEAR component pattern: `count` generated placements stepped
 * from the seed along the UNIT `direction` by `spacingMm` each — instance i
 * sits at the seed translated by `direction · spacingMm · i` for i in
 * `1..count` (the seed occurrence itself already exists in the document;
 * the pattern generates its siblings). Deterministic instance order.
 */
export function resolveLinearOccurrencePattern(input: {
  readonly seed: PlacementTransform;
  readonly direction: DatumVec3;
  readonly count: number;
  readonly spacingMm: number;
}): ParseResult<readonly PlacementTransform[], AssemblyPatternError> {
  const count = resolveCount(input.count, input);
  if (!count.ok) return count;
  if (!Number.isFinite(input.spacingMm) || input.spacingMm <= 0) {
    return fail(
      patternError(
        ASSEMBLY_PATTERN_ERROR_CODES.spacingInvalid,
        `The pattern spacing must be a positive finite length in millimetres; got ${String(input.spacingMm)}.`,
        input,
      ),
    );
  }
  const direction = resolveUnitVector(
    input.direction,
    ASSEMBLY_PATTERN_ERROR_CODES.directionInvalid,
    "direction",
    input,
  );
  if (!direction.ok) return direction;
  const placements: PlacementTransform[] = [];
  for (let index = 1; index <= input.count; index += 1) {
    const step = input.spacingMm * index;
    placements.push({
      rotation: input.seed.rotation,
      translation: [
        input.seed.translation[0] + direction.value[0] * step,
        input.seed.translation[1] + direction.value[1] * step,
        input.seed.translation[2] + direction.value[2] * step,
      ],
    });
  }
  return ok(placements);
}

/**
 * Resolves a CIRCULAR component pattern about a datum axis line: `count`
 * generated placements, instance i the seed rotated about the axis by
 * `angleStepDeg · i` (right-hand rule) for i in `1..count`. A negative step
 * sweeps the other way; zero is refused (it would produce coincident
 * instances). The axis direction must be unit; the rotation composes
 * through {@link axisRotationTransform}, so the seed's orientation rides
 * along rigidly.
 */
export function resolveCircularOccurrencePattern(input: {
  readonly seed: PlacementTransform;
  readonly axisOrigin: DatumVec3;
  readonly axisDirection: DatumVec3;
  readonly count: number;
  readonly angleStepDeg: number;
}): ParseResult<readonly PlacementTransform[], AssemblyPatternError> {
  const count = resolveCount(input.count, input);
  if (!count.ok) return count;
  if (!Number.isFinite(input.angleStepDeg) || input.angleStepDeg === 0) {
    return fail(
      patternError(
        ASSEMBLY_PATTERN_ERROR_CODES.stepInvalid,
        `The circular pattern's angle step must be a non-zero finite angle in degrees; got ${String(input.angleStepDeg)}.`,
        input,
      ),
    );
  }
  const axisDirection = resolveUnitVector(
    input.axisDirection,
    ASSEMBLY_PATTERN_ERROR_CODES.axisInvalid,
    "axis direction",
    input,
  );
  if (!axisDirection.ok) return axisDirection;
  if (
    input.axisOrigin.length !== 3 ||
    input.axisOrigin.some((entry) => !Number.isFinite(entry))
  ) {
    return fail(
      patternError(
        ASSEMBLY_PATTERN_ERROR_CODES.axisInvalid,
        "The circular pattern's axis origin must be a finite point.",
        input,
      ),
    );
  }
  const placements: PlacementTransform[] = [];
  for (let index = 1; index <= input.count; index += 1) {
    const rotation = axisRotationTransform(
      input.axisOrigin,
      axisDirection.value,
      (input.angleStepDeg * index * Math.PI) / 180,
    );
    placements.push(composePlacementTransforms(rotation, input.seed));
  }
  return ok(placements);
}

/**
 * A path-driven pattern's input record — accepted ONLY to be declined with
 * `assembly/pattern-path-unsupported`, so a caller wiring the verb today
 * gets the structured refusal (and the capability flag's `false`) instead
 * of a silent linear fallback.
 */
export interface PathOccurrencePatternInput {
  readonly kind: "path";
  readonly seed: PlacementTransform;
}

/**
 * Resolves a path-driven component pattern: ALWAYS a structured decline in
 * Phase 52 (`assembly/pattern-path-unsupported`) — a resolved path-curve
 * source along occurrences does not exist yet. The typed input keeps the
 * decline honest: the caller cannot mistake it for an unimplemented branch.
 */
export function resolvePathOccurrencePattern(
  input: PathOccurrencePatternInput,
): ParseResult<readonly PlacementTransform[], AssemblyPatternError> {
  return fail(
    patternError(
      ASSEMBLY_PATTERN_ERROR_CODES.pathUnsupported,
      "Path-driven component patterns are not supported yet: the path-curve source along occurrences has no resolved representation. Use a linear or circular pattern, or compose instances from a parameter graph.",
      input,
    ),
  );
}

/**
 * Resolves one MIRRORED component placement across a datum plane: the
 * seed's position reflects across the plane (origin + unit normal), and the
 * orientation composes with the plane reflection through a LOCAL Z-FLIP so
 * the resulting transform stays rigid (det +1) — mirrored PLACEMENT, not
 * mirrored geometry (see the module doc's handedness decision).
 *
 * The flip is about the plane frame's z (the normal): the mirrored frame's
 * x and y ride the reflection (swapping handedness), z is re-flipped back,
 * which as a rotation is exactly `S · R · diag(1, 1, −1)` with
 * `S = I − 2nnᵀ` — orthonormal, det +1, bitwise-deterministic.
 */
export function resolveMirroredOccurrencePlacement(input: {
  readonly seed: PlacementTransform;
  readonly planeOrigin: DatumVec3;
  readonly planeNormal: DatumVec3;
}): ParseResult<PlacementTransform, AssemblyPatternError> {
  const planeNormal = resolveUnitVector(
    input.planeNormal,
    ASSEMBLY_PATTERN_ERROR_CODES.planeInvalid,
    "plane normal",
    input,
  );
  if (!planeNormal.ok) return planeNormal;
  if (
    input.planeOrigin.length !== 3 ||
    input.planeOrigin.some((entry) => !Number.isFinite(entry))
  ) {
    return fail(
      patternError(
        ASSEMBLY_PATTERN_ERROR_CODES.planeInvalid,
        "The mirror plane's origin must be a finite point.",
        input,
      ),
    );
  }
  const [nx, ny, nz] = planeNormal.value;
  const [sx, sy, sz] = input.seed.translation;
  // Signed distance from the plane, then reflect: p' = p − 2 (n·(p−o)) n.
  const distance =
    (sx - input.planeOrigin[0]) * nx +
    (sy - input.planeOrigin[1]) * ny +
    (sz - input.planeOrigin[2]) * nz;
  const reflectedTranslation: DatumVec3 = [
    sx - 2 * distance * nx,
    sy - 2 * distance * ny,
    sz - 2 * distance * nz,
  ];
  // R' = S · R · F, with S the plane reflection and F the local z-flip. The
  // z-flip's composition order matters only up to sign placement here — the
  // product below is computed entry-wise from the closed form:
  //   S·R = R − 2 n (nᵀR)  (subtract twice each row's n-projection),
  // then right-multiply by diag(1,1,−1): negate the THIRD COLUMN.
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = input.seed.rotation;
  const dot0 = nx * r0 + ny * r3 + nz * r6;
  const dot1 = nx * r1 + ny * r4 + nz * r7;
  const dot2 = nx * r2 + ny * r5 + nz * r8;
  const rotation: PlacementRotation = [
    r0 - 2 * nx * dot0,
    r1 - 2 * nx * dot1,
    -(r2 - 2 * nx * dot2),
    r3 - 2 * ny * dot0,
    r4 - 2 * ny * dot1,
    -(r5 - 2 * ny * dot2),
    r6 - 2 * nz * dot0,
    r7 - 2 * nz * dot1,
    -(r8 - 2 * nz * dot2),
  ];
  return ok({ rotation, translation: reflectedTranslation });
}

/**
 * The mirror-geometry decline's canonical structured result: mirrored
 * GEOMETRY (the enantiomorph — a kernel mirror op's output) is not
 * supported; the capability flag names it. Exposed so callers surface ONE
 * decline, not ad-hoc messages.
 */
export function mirrorGeometryDecline(
  input: unknown,
): ParseResult<never, AssemblyPatternError> {
  return fail(
    patternError(
      ASSEMBLY_PATTERN_ERROR_CODES.mirrorGeometryUnsupported,
      "Mirrored GEOMETRY (the handedness-flipped solid a kernel mirror op produces) is not supported yet — mirror components mirror the PLACEMENT only. Bind a kernel mirror op (probe first) before promising the flip.",
      input,
    ),
  );
}
