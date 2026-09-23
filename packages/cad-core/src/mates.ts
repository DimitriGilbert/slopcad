/**
 * Assembly mate and joint vocabulary (Phase 51): the persistent, kernel-
 * neutral records that constrain and mobilize a document's occurrences.
 *
 * ## Mates address mated geometry through persistent references
 *
 * A mate ties TWO occurrences together through Phase 22 machinery
 * generalized across instance paths: each endpoint names an occurrence
 * (the instance) plus a {@link ReferenceId} — a persistent reference
 * record of the document (a face, edge, or vertex reference resolved
 * against the occurrence's source topology). The record is pure
 * structure; resolution to concrete anchor frames happens at the
 * executor boundary exactly like occurrence placement's datum anchors —
 * the same seam pattern, never a cad-core kernel import.
 *
 * ## The vocabulary
 *
 * {@link MATE_KINDS}: coincident (faces, edges, or points made to
 * coincide), concentric (axes aligned), distance, angle, parallel,
 * perpendicular, tangent. {@link JOINT_KINDS}: the motion vocabulary —
 * rigid, revolute, slider, cylindrical, planar, ball — each granting a
 * documented remainder of relative degrees of freedom
 * ({@link JOINT_REMAINING_DOF}; the DOF-accounting table the solver's
 * fixtures assert and Phase 52's motion consumes).
 *
 * ## Determinism
 *
 * Records are plain serializable data with total, ordered validation:
 * identical input parses to identical records everywhere, and the joint
 * motion algebra composes through the fixed-order placement algebra of
 * `placement.ts`, so a mated assembly solves and re-solves bitwise-
 * identically (the Phase 51 determinism gate).
 */

import { type DatumVec3 } from "./datum";
import {
  parseJointId,
  parseMateId,
  parseOccurrenceId,
  parseReferenceId,
  type JointId,
  type MateId,
  type OccurrenceId,
  type ReferenceId,
} from "./ids";
import {
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  type PlacementRotation,
  type PlacementTransform,
} from "./placement";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

// ---------------------------------------------------------------------------
// Mates
// ---------------------------------------------------------------------------

/** The mate kinds (Phase 51 vocabulary). */
export const MATE_KINDS = [
  "coincident",
  "concentric",
  "distance",
  "angle",
  "parallel",
  "perpendicular",
  "tangent",
] as const;

export type MateKind = (typeof MATE_KINDS)[number];

/**
 * One mated side: an occurrence of this document's assembly plus the
 * persistent reference (a document `references` record id) that resolves
 * — through the executor's topology seam — to the mated geometry in that
 * occurrence's local frame.
 */
export interface MateEndpoint {
  readonly occurrenceId: OccurrenceId;
  readonly referenceId: ReferenceId;
}

/**
 * An assembly mate record: two endpoints constrained by one mate kind.
 * `value` carries the mate's parameter — the offset in millimetres for
 * `distance`, the angle in degrees for `angle` — and is present exactly
 * when the kind takes one.
 */
export interface DocumentMate {
  readonly id: MateId;
  /** The mate's name (1-64 characters, the datum naming rule). */
  readonly name: string;
  readonly kind: MateKind;
  readonly first: MateEndpoint;
  readonly second: MateEndpoint;
  readonly value?: number;
}

/** Stable failure codes for mate and joint record parsing. */
export const ASSEMBLY_MATE_ERROR_CODES = {
  mateMalformed: "assembly/mate-malformed",
  mateUnknownKind: "assembly/mate-unknown-kind",
  mateReferenceMalformed: "assembly/mate-reference-malformed",
  mateValueInvalid: "assembly/mate-value-invalid",
  jointMalformed: "assembly/joint-malformed",
  jointUnknownKind: "assembly/joint-unknown-kind",
  jointFrameInvalid: "assembly/joint-frame-invalid",
} as const;

export type AssemblyMateErrorCode =
  (typeof ASSEMBLY_MATE_ERROR_CODES)[keyof typeof ASSEMBLY_MATE_ERROR_CODES];

/** Structured failure describing why a mate/joint record was rejected. */
export interface AssemblyMateError extends ParseFailure {
  readonly code: AssemblyMateErrorCode;
}

function mateError(
  code: AssemblyMateErrorCode,
  message: string,
  input: unknown,
): AssemblyMateError {
  return { code, message, input };
}

const MATE_NAME_MAX_LENGTH = 64;

function parseRecordName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MATE_NAME_MAX_LENGTH) {
    return undefined;
  }
  return trimmed;
}

function isFiniteTriple(
  input: unknown,
): input is readonly [number, number, number] {
  return (
    Array.isArray(input) &&
    input.length === 3 &&
    input.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/** The mate kinds that carry a scalar `value` (and its unit per kind). */
export const MATE_VALUE_UNITS: Readonly<Partial<Record<MateKind, string>>> = {
  distance: "mm",
  angle: "deg",
};

/**
 * Validates untrusted input as a {@link DocumentMate}. Strict about what
 * the vocabulary defines: endpoints must carry valid occurrence and
 * reference ids, `value` is required — finite — for `distance`/`angle`
 * and rejected for every other kind, and the record's name follows the
 * 1-64 character naming rule.
 */
export function parseAssemblyMate(
  input: unknown,
): ParseResult<DocumentMate, AssemblyMateError> {
  if (
    typeof input !== "object" ||
    input === null ||
    !("id" in input) ||
    !("kind" in input) ||
    !("first" in input) ||
    !("second" in input)
  ) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.mateMalformed,
        "A mate must be a plain object with id, name, kind, first, and second fields.",
        input,
      ),
    );
  }
  const record = input as {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    first?: unknown;
    second?: unknown;
    value?: unknown;
  };
  const id = parseMateId(record.id);
  if (!id.ok) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.mateMalformed,
        `A mate id must carry the mate id prefix and payload rules: ${id.error.message}`,
        record.id,
      ),
    );
  }
  const name = parseRecordName(record.name);
  if (name === undefined) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.mateMalformed,
        `A mate name must be a string of 1-${MATE_NAME_MAX_LENGTH} characters.`,
        record.name,
      ),
    );
  }
  if (
    typeof record.kind !== "string" ||
    !MATE_KINDS.includes(record.kind as MateKind)
  ) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.mateUnknownKind,
        `A mate kind must be one of: ${MATE_KINDS.join(", ")}.`,
        record.kind,
      ),
    );
  }
  const kind = record.kind as MateKind;
  const endpoints = [record.first, record.second];
  const parsedEndpoints: MateEndpoint[] = [];
  for (const endpoint of endpoints) {
    if (typeof endpoint !== "object" || endpoint === null) {
      return fail(
        mateError(
          ASSEMBLY_MATE_ERROR_CODES.mateReferenceMalformed,
          "A mate endpoint must be a plain object with occurrenceId and referenceId fields.",
          endpoint,
        ),
      );
    }
    const { occurrenceId, referenceId } = endpoint as {
      occurrenceId?: unknown;
      referenceId?: unknown;
    };
    const occurrence = parseOccurrenceId(occurrenceId);
    if (!occurrence.ok) {
      return fail(
        mateError(
          ASSEMBLY_MATE_ERROR_CODES.mateReferenceMalformed,
          `A mate endpoint's occurrence id must be valid: ${occurrence.error.message}`,
          occurrenceId,
        ),
      );
    }
    const reference = parseReferenceId(referenceId);
    if (!reference.ok) {
      return fail(
        mateError(
          ASSEMBLY_MATE_ERROR_CODES.mateReferenceMalformed,
          `A mate endpoint's reference id must be valid: ${reference.error.message}`,
          referenceId,
        ),
      );
    }
    parsedEndpoints.push({
      occurrenceId: occurrence.value,
      referenceId: reference.value,
    });
  }
  const [first, second] = parsedEndpoints;
  if (first === undefined || second === undefined) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.mateReferenceMalformed,
        "A mate must carry both of its endpoints.",
        input,
      ),
    );
  }
  const unit = MATE_VALUE_UNITS[kind];
  if (unit === undefined) {
    if (record.value !== undefined) {
      return fail(
        mateError(
          ASSEMBLY_MATE_ERROR_CODES.mateValueInvalid,
          `A ${kind} mate takes no value; only distance (mm) and angle (deg) mates carry one.`,
          record.value,
        ),
      );
    }
    return ok({ id: id.value, name, kind, first, second });
  }
  if (
    typeof record.value !== "number" ||
    !Number.isFinite(record.value) ||
    record.value < 0
  ) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.mateValueInvalid,
        `A ${kind} mate's value must be a finite non-negative ${unit} number.`,
        record.value,
      ),
    );
  }
  return ok({ id: id.value, name, kind, first, second, value: record.value });
}

// ---------------------------------------------------------------------------
// Joints
// ---------------------------------------------------------------------------

/** The joint kinds (the motion vocabulary). */
export const JOINT_KINDS = [
  "rigid",
  "revolute",
  "slider",
  "cylindrical",
  "planar",
  "ball",
] as const;

export type JointKind = (typeof JOINT_KINDS)[number];

/**
 * The relative degrees of freedom each joint kind LEAVES between its two
 * occurrences — the DOF-accounting table the solver's fixtures assert
 * (`revolute` leaves 1 rotational DOF; `cylindrical` leaves one of each;
 * `planar` leaves two translations plus the rotation about the normal)
 * and Phase 52's drag-driven motion consumes.
 */
export const JOINT_REMAINING_DOF: Readonly<
  Record<
    JointKind,
    { readonly rotational: number; readonly translational: number }
  >
> = Object.freeze({
  rigid: { rotational: 0, translational: 0 },
  revolute: { rotational: 1, translational: 0 },
  slider: { rotational: 0, translational: 1 },
  cylindrical: { rotational: 1, translational: 1 },
  planar: { rotational: 1, translational: 2 },
  ball: { rotational: 3, translational: 0 },
});

/**
 * A joint's frame, in the BASE occurrence's local coordinates: the origin
 * (a point on the joint, or the ball's centre) and the axis — the
 * rotation/slider direction for `revolute`/`slider`/`cylindrical`, the
 * plane normal for `planar`. Any finite non-zero vector is accepted and
 * normalized on use (the section-normal precedent); `rigid` and `ball`
 * carry no axis.
 */
export interface JointFrame {
  readonly origin: readonly [number, number, number];
  readonly axis?: readonly [number, number, number];
}

/**
 * An assembly joint record: one occurrence moves relative to a base
 * occurrence through the joint kind's remaining DOF about the joint
 * frame.
 */
export interface DocumentJoint {
  readonly id: JointId;
  /** The joint's name (1-64 characters, the datum naming rule). */
  readonly name: string;
  readonly kind: JointKind;
  /** The occurrence the motion is measured against (stays put). */
  readonly baseOccurrenceId: OccurrenceId;
  /** The occurrence the joint mobilizes. */
  readonly occurrenceId: OccurrenceId;
  readonly frame?: JointFrame;
}

/**
 * Validates untrusted input as a {@link DocumentJoint}. Axis-bearing
 * kinds require a frame with a finite origin and a finite non-zero axis;
 * `ball` requires the origin and rejects an axis; `rigid` rejects a
 * frame entirely (its wire form is frame-absent, keeping serialization
 * canonical). The two occurrences must differ — a joint of an occurrence
 * with itself is a structural contradiction, not a constraint.
 */
export function parseAssemblyJoint(
  input: unknown,
): ParseResult<DocumentJoint, AssemblyMateError> {
  if (
    typeof input !== "object" ||
    input === null ||
    !("id" in input) ||
    !("kind" in input)
  ) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointMalformed,
        "A joint must be a plain object with id, name, kind, baseOccurrenceId, and occurrenceId fields.",
        input,
      ),
    );
  }
  const record = input as {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    baseOccurrenceId?: unknown;
    occurrenceId?: unknown;
    frame?: unknown;
  };
  const id = parseJointId(record.id);
  if (!id.ok) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointMalformed,
        `A joint id must carry the joint id prefix and payload rules: ${id.error.message}`,
        record.id,
      ),
    );
  }
  const name = parseRecordName(record.name);
  if (name === undefined) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointMalformed,
        `A joint name must be a string of 1-${MATE_NAME_MAX_LENGTH} characters.`,
        record.name,
      ),
    );
  }
  if (
    typeof record.kind !== "string" ||
    !JOINT_KINDS.includes(record.kind as JointKind)
  ) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointUnknownKind,
        `A joint kind must be one of: ${JOINT_KINDS.join(", ")}.`,
        record.kind,
      ),
    );
  }
  const kind = record.kind as JointKind;
  const base = parseOccurrenceId(record.baseOccurrenceId);
  if (!base.ok) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointMalformed,
        `A joint's base occurrence id must be valid: ${base.error.message}`,
        record.baseOccurrenceId,
      ),
    );
  }
  const moved = parseOccurrenceId(record.occurrenceId);
  if (!moved.ok) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointMalformed,
        `A joint's occurrence id must be valid: ${moved.error.message}`,
        record.occurrenceId,
      ),
    );
  }
  if (base.value === moved.value) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointMalformed,
        "A joint's two occurrences must differ: a joint of an occurrence with itself constrains nothing and mobilizes nothing.",
        record,
      ),
    );
  }
  if (kind === "rigid") {
    if (record.frame !== undefined) {
      return fail(
        mateError(
          ASSEMBLY_MATE_ERROR_CODES.jointFrameInvalid,
          "A rigid joint carries no frame: it removes every relative degree of freedom, so it has no axis or origin to state.",
          record.frame,
        ),
      );
    }
    return ok({
      id: id.value,
      name,
      kind,
      baseOccurrenceId: base.value,
      occurrenceId: moved.value,
    });
  }
  if (
    typeof record.frame !== "object" ||
    record.frame === null ||
    !isFiniteTriple((record.frame as { origin?: unknown }).origin)
  ) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointFrameInvalid,
        `A ${kind} joint's frame must carry a finite origin triple.`,
        record.frame,
      ),
    );
  }
  const frameRecord = record.frame as { origin?: unknown; axis?: unknown };
  const origin = frameRecord.origin as readonly [number, number, number];
  if (kind === "ball") {
    if (frameRecord.axis !== undefined) {
      return fail(
        mateError(
          ASSEMBLY_MATE_ERROR_CODES.jointFrameInvalid,
          "A ball joint's frame carries only its centre: rotation is free about every axis through it.",
          frameRecord.axis,
        ),
      );
    }
    return ok({
      id: id.value,
      name,
      kind,
      baseOccurrenceId: base.value,
      occurrenceId: moved.value,
      frame: { origin: [...origin] },
    });
  }
  if (!isFiniteTriple(frameRecord.axis)) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointFrameInvalid,
        `A ${kind} joint's frame must carry a finite axis triple.`,
        frameRecord.axis,
      ),
    );
  }
  const axis = frameRecord.axis;
  if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) {
    return fail(
      mateError(
        ASSEMBLY_MATE_ERROR_CODES.jointFrameInvalid,
        `A ${kind} joint's axis must be a non-zero vector.`,
        axis,
      ),
    );
  }
  return ok({
    id: id.value,
    name,
    kind,
    baseOccurrenceId: base.value,
    occurrenceId: moved.value,
    frame: { origin: [...origin], axis: [...axis] },
  });
}

// ---------------------------------------------------------------------------
// Joint motion (the remaining-DOF algebra)
// ---------------------------------------------------------------------------

/** Normalizes a non-zero vector to unit length (pure, fixed-order). */
export function normalizeJointAxis(axis: DatumVec3): DatumVec3 {
  const length = Math.sqrt(
    axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2],
  );
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

/** The rotation matrix of `angle` radians about a UNIT axis (Rodrigues). */
function rotationAboutUnitAxis(
  axis: DatumVec3,
  angle: number,
): PlacementRotation {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  // Row-major Rodrigues.
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

/** The transpose of a row-major rotation (its inverse). */
function transposeRotation(rotation: PlacementRotation): PlacementRotation {
  return [
    rotation[0],
    rotation[3],
    rotation[6],
    rotation[1],
    rotation[4],
    rotation[7],
    rotation[2],
    rotation[5],
    rotation[8],
  ];
}

/**
 * The rigid-motion transform a joint's remaining DOF produces at one
 * motion station, expressed in the BASE occurrence's local frame: the
 * moved occurrence's world placement composes as
 * `baseWorld ∘ frame ∘ motion ∘ frame⁻¹ ∘ movedWorld` — the conjugation
 * that pivots the motion about the joint frame. `motion.rotation` is the
 * rotation angle in radians about the frame axis (zero for joints
 * without one), `motion.translation` the displacement along it in
 * millimetres. Deterministic pure arithmetic over the placement algebra.
 */
export function jointMotionTransform(
  joint: DocumentJoint,
  motion: { readonly rotation: number; readonly translation: number },
): PlacementTransform {
  if (joint.kind === "rigid" || joint.frame === undefined) {
    return IDENTITY_PLACEMENT_TRANSFORM;
  }
  const origin = joint.frame.origin;
  const toJoint: PlacementTransform = {
    rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
    translation: [-origin[0], -origin[1], -origin[2]],
  };
  const back: PlacementTransform = {
    rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
    translation: [origin[0], origin[1], origin[2]],
  };
  const axis =
    joint.frame.axis === undefined
      ? ([0, 0, 1] as const)
      : normalizeJointAxis(joint.frame.axis);
  const free: PlacementTransform = {
    rotation:
      joint.kind === "slider"
        ? IDENTITY_PLACEMENT_TRANSFORM.rotation
        : rotationAboutUnitAxis(axis, motion.rotation),
    translation:
      joint.kind === "revolute" || joint.kind === "ball"
        ? [0, 0, 0]
        : [
            axis[0] * motion.translation,
            axis[1] * motion.translation,
            axis[2] * motion.translation,
          ],
  };
  // frame ∘ free ∘ frame⁻¹, conjugated so the motion pivots about the
  // joint frame rather than the document origin.
  return composePlacementTransforms(
    back,
    composePlacementTransforms(free, toJoint),
  );
}

/** Transposes a placement rotation — exported for the solver's use. */
export function transposePlacementRotation(
  rotation: PlacementRotation,
): PlacementRotation {
  return transposeRotation(rotation);
}
