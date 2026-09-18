/**
 * Serializable workplane definition: origin + orientation, the 2D home of a
 * sketch inside 3D model space.
 *
 * Representation: `origin` (a 3D point in mm) plus a right-handed frame
 * stored as `normal` (the plane's unit normal) and `xAxis` (the in-plane unit
 * basis for workplane +x). Constructors orthonormalize input per the rules
 * documented on {@link createWorkplane}; parsing adopts a stored frame
 * verbatim after validating it is orthonormal within tolerance, so a
 * serialized workplane round-trips bit-for-bit.
 *
 * Placement into 3D is the documented transform
 * `world = origin + x·xAxis + y·yAxis` with `yAxis = normal × xAxis`; the
 * inverse maps a world point back to workplane coordinates by orthogonal
 * projection along the normal. All lengths are mm; directions are
 * unitless components. Dimensional quantities crossing this boundary as
 * cad-core values (mm) map directly onto these numbers.
 */

import { type ParseResult, fail, ok } from "@slopcad/cad-core";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";

/** Structured failure describing why input was rejected as a workplane. */
export interface WorkplaneError {
  readonly code: string;
  readonly message: string;
  readonly input: unknown;
}

/** A 3D vector or point with finite mm components. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** An orthonormal, right-handed workplane frame. */
export interface Workplane {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly xAxis: Vec3;
}

/**
 * Tolerance for accepting a stored frame as orthonormal when parsing
 * (dot products within this of 0/1). Serialization always emits frames that
 * pass exactly.
 */
export const WORKPLANE_ORTHONORMALITY_TOLERANCE = 1e-9;

/** Vectors shorter than this are treated as degenerate directions. */
export const WORKPLANE_DIRECTION_EPSILON = 1e-12;

/**
 * Component under which a Gram-Schmidt remainder counts as parallel: the
 * remainder's squared length compared against the input's squared length.
 */
const PARALLEL_EPSILON_SQUARED = 1e-24;

function isVec3(input: unknown): input is Vec3 {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.z === "number" &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number.isFinite(candidate.z)
  );
}

function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

function scale(a: Vec3, s: number): Vec3 {
  return vec3(a.x * s, a.y * s, a.z * s);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

function lengthOf(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/**
 * Orthonormalizes `normal` and `xAxis` into a right-handed frame:
 *
 * 1. Normalize `normal`; reject it as degenerate if its length is below
 *    {@link WORKPLANE_DIRECTION_EPSILON}.
 * 2. Remove the component of `xAxis` along `normal` (Gram-Schmidt); reject
 *    the remainder as parallel if its squared length is below
 *    `|xAxis|²·1e-24`, so the intended in-plane direction is not silently
 *    replaced by an arbitrary fallback.
 * 3. Normalize the remainder to unit length — that is `xAxis`.
 * 4. `yAxis = normal × xAxis`, exact by construction.
 *
 * The procedure is deterministic: identical input produces the identical
 * frame, bit-for-bit.
 */
export function orthonormalizeWorkplane(
  normal: Vec3,
  xAxis: Vec3,
): ParseResult<{ normal: Vec3; xAxis: Vec3; yAxis: Vec3 }, WorkplaneError> {
  const normalLength = lengthOf(normal);
  if (normalLength < WORKPLANE_DIRECTION_EPSILON) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneDegenerate,
      message: `Workplane normal is degenerate (length ${normalLength} < ${WORKPLANE_DIRECTION_EPSILON}).`,
      input: normal,
    });
  }
  const unitNormal = scale(normal, 1 / normalLength);
  const projection = dot(xAxis, unitNormal);
  const remainder = subtract(
    xAxis,
    vec3(
      unitNormal.x * projection,
      unitNormal.y * projection,
      unitNormal.z * projection,
    ),
  );
  const remainderSquared = dot(remainder, remainder);
  const xAxisSquared = dot(xAxis, xAxis);
  if (remainderSquared <= PARALLEL_EPSILON_SQUARED * xAxisSquared) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneDegenerate,
      message:
        "Workplane xAxis is parallel to the normal; it carries no in-plane direction to orthonormalize.",
      input: xAxis,
    });
  }
  const unitX = scale(remainder, 1 / Math.sqrt(remainderSquared));
  const yAxis = cross(unitNormal, unitX);
  return ok({ normal: unitNormal, xAxis: unitX, yAxis });
}

/**
 * Creates a workplane from an origin and raw orientation axes, orthonormalized
 * per {@link orthonormalizeWorkplane}. The origin must have finite mm
 * components.
 */
export function createWorkplane(
  origin: Vec3,
  normal: Vec3,
  xAxis: Vec3,
): ParseResult<Workplane, WorkplaneError> {
  if (!isVec3(origin)) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneMalformed,
      message:
        "Workplane origin must have finite numeric x, y, z components (mm).",
      input: origin,
    });
  }
  if (!isVec3(normal) || !isVec3(xAxis)) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneMalformed,
      message:
        "Workplane normal and xAxis must have finite numeric x, y, z components.",
      input: { normal, xAxis },
    });
  }
  const frame = orthonormalizeWorkplane(normal, xAxis);
  if (!frame.ok) return frame;
  return ok({ origin, normal: frame.value.normal, xAxis: frame.value.xAxis });
}

/** The right-handed basis vectors of a workplane. */
export function workplaneBasis(workplane: Workplane): {
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly normal: Vec3;
} {
  const yAxis = cross(workplane.normal, workplane.xAxis);
  return { xAxis: workplane.xAxis, yAxis, normal: workplane.normal };
}

/**
 * Places a workplane point (mm) into 3D model space:
 * `world = origin + x·xAxis + y·yAxis`.
 */
export function workplaneToWorld(
  workplane: Workplane,
  point: { readonly x: number; readonly y: number },
): Vec3 {
  const { xAxis, yAxis } = workplaneBasis(workplane);
  return vec3(
    workplane.origin.x + point.x * xAxis.x + point.y * yAxis.x,
    workplane.origin.y + point.x * xAxis.y + point.y * yAxis.y,
    workplane.origin.z + point.x * xAxis.z + point.y * yAxis.z,
  );
}

/**
 * Maps a 3D point back to workplane coordinates by orthogonal projection
 * along the plane normal. The signed out-of-plane offset (mm, positive along
 * the normal) is returned alongside so callers can detect off-plane input.
 */
export function worldToWorkplane(
  workplane: Workplane,
  point: Vec3,
): { readonly x: number; readonly y: number; readonly offset: number } {
  const { xAxis, yAxis, normal } = workplaneBasis(workplane);
  const delta = subtract(point, workplane.origin);
  return {
    x: dot(delta, xAxis),
    y: dot(delta, yAxis),
    offset: dot(delta, normal),
  };
}

/**
 * Canonical JSON form of a workplane: origin, then normal, then xAxis, each
 * with x, y, z in that order. Serialization emits the stored frame verbatim;
 * because constructors produce orthonormal frames, serialized output is
 * always canonical.
 */
export interface SerializedWorkplane {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly xAxis: Vec3;
}

/** Serializes a workplane to its canonical JSON form. */
export function serializeWorkplane(workplane: Workplane): SerializedWorkplane {
  return {
    origin: vec3(workplane.origin.x, workplane.origin.y, workplane.origin.z),
    normal: vec3(workplane.normal.x, workplane.normal.y, workplane.normal.z),
    xAxis: vec3(workplane.xAxis.x, workplane.xAxis.y, workplane.xAxis.z),
  };
}

/**
 * Parses untrusted input as a {@link Workplane}. The stored frame is adopted
 * verbatim (so round-trips are exact) after validating that it is
 * orthonormal within {@link WORKPLANE_ORTHONORMALITY_TOLERANCE} — a stored
 * frame that is not a valid right-handed orthonormal frame is rejected with
 * `sketch/workplane-not-orthonormal` rather than silently re-canonicalized.
 * Unknown extra fields are ignored so future format versions deserialize
 * without data corruption.
 */
export function parseWorkplane(
  input: unknown,
): ParseResult<Workplane, WorkplaneError> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneMalformed,
      message: "A serialized workplane must be a plain object.",
      input,
    });
  }
  const { origin, normal, xAxis } = input as Record<string, unknown>;
  if (!isVec3(origin) || !isVec3(normal) || !isVec3(xAxis)) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneMalformed,
      message:
        "Workplane origin, normal, and xAxis must each have finite numeric x, y, z components.",
      input,
    });
  }
  const tolerance = WORKPLANE_ORTHONORMALITY_TOLERANCE;
  const unit = (value: number) => Math.abs(value - 1) <= tolerance;
  const zero = (value: number) => Math.abs(value) <= tolerance;
  if (!unit(lengthOf(normal)) || !unit(lengthOf(xAxis))) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneNotOrthonormal,
      message:
        "Workplane normal and xAxis must be unit vectors within 1e-9; re-create the workplane to canonicalize it.",
      input,
    });
  }
  if (!zero(dot(normal, xAxis))) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneNotOrthonormal,
      message:
        "Workplane normal and xAxis must be perpendicular within 1e-9; re-create the workplane to canonicalize it.",
      input,
    });
  }
  const yAxis = cross(normal, xAxis);
  if (!unit(lengthOf(yAxis))) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.workplaneNotOrthonormal,
      message:
        "Workplane normal × xAxis must be a unit vector within 1e-9 (right-handed frame).",
      input,
    });
  }
  return ok({ origin, normal, xAxis });
}

/**
 * The XY plane (z = 0): the default sketch home. Normal +z, xAxis +x.
 */
export function xyWorkplane(): Workplane {
  return {
    origin: vec3(0, 0, 0),
    normal: vec3(0, 0, 1),
    xAxis: vec3(1, 0, 0),
  };
}

/**
 * A front workplane (the x-z plane of model space): origin at the given model
 * y, normal -y, xAxis +x — workplane +y maps to model +z.
 */
export function frontWorkplane(offsetY: number): Workplane {
  return {
    origin: vec3(0, offsetY, 0),
    normal: vec3(0, -1, 0),
    xAxis: vec3(1, 0, 0),
  };
}
