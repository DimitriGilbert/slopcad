/**
 * Named datum geometry (Phase 39): the kernel-neutral payload schema and
 * resolution of the four datum entity kinds the document records carry —
 * datum planes, datum axes, datum points, and coordinate systems.
 *
 * A datum record's payload is pure serializable data, stored verbatim by the
 * document (the sketch and persistent-reference discipline); this module
 * owns the payload's schema and its parse/serialize. Every payload is
 * canonical fixed-key-order JSON stamped with {@link DATUM_FORMAT_VERSION},
 * so vocabulary growth moves the stamp through its own version discipline
 * (exactly the sketch domain's envelope rule).
 *
 * ## The four kinds and their definitions
 *
 * - **Datum plane** — `originFrame` (an origin plus a normal and an in-plane
 *   x direction), `threePoints` (origin = p1, +x toward p2, the plane
 *   through p1/p2/p3), or `faceOffset` (a persistent face reference — the
 *   Phase 22 `TopologyEntityReference` payload verbatim — plus the face
 *   normal at definition time and a signed offset along it).
 * - **Datum axis** — `edge` (a persistent edge reference), `twoPoints`
 *   (origin = first point, direction toward the second), or `faceCylinder`
 *   (the axis of a referenced cylindrical face).
 * - **Datum point** — an explicit position.
 * - **Coordinate system** — an origin plus an orthonormal right-handed
 *   frame (x axis + z normal; y completes the frame).
 *
 * ## Resolution (pure math here, topology through the seam)
 *
 * Explicit-geometry definitions resolve entirely in this module —
 * deterministic orthonormalization (the workplane module's rules: normalize
 * the primary direction, Gram-Schmidt the secondary, y = z × x), so
 * identical input produces the identical frame bit-for-bit. Reference
 * definitions (`faceOffset`, `edge`, `faceCylinder`) route through the
 * caller-supplied {@link DatumTopologyResolver}: cad-core never interprets
 * a topology reference's geometry — the resolving layer (the executor
 * bridge's host on the kernel side, the workbench session on the scene
 * side) supplies face/edge geometry and answers with structured failures
 * that ride through verbatim. A datum whose face reference no longer
 * resolves therefore fails RESOLUTION with the resolver's structured code —
 * the moved-face battery's re-resolve-or-invalidate contract — never as a
 * guessed fallback frame.
 */

import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Version of the datum payload schema this module implements. */
export const DATUM_FORMAT_VERSION = 1;

/** A point or direction in canonical millimetres / unitless components. */
export type DatumVec3 = readonly [number, number, number];

/** Stable failure codes produced by the datum parsers and resolvers. */
export const DATUM_ERROR_CODES = {
  /** The payload was not a plain object of the expected shape. */
  malformed: "datum/malformed",
  /** The payload's formatVersion was missing or not the current one. */
  versionUnsupported: "datum/version-unsupported",
  /** The `datumType` discriminator was not one of the four kinds. */
  kindInvalid: "datum/kind-invalid",
  /** The kind's `definition` discriminator was not one of its own. */
  definitionInvalid: "datum/definition-invalid",
  /** A field of an otherwise-shaped payload was invalid. */
  fieldInvalid: "datum/field-invalid",
  /** A frame could not be orthonormalized (degenerate or parallel input). */
  frameDegenerate: "datum/frame-degenerate",
  /** A reference-dependent definition lacks a usable reference payload. */
  referenceInvalid: "datum/reference-invalid",
} as const;

export type DatumErrorCode =
  (typeof DATUM_ERROR_CODES)[keyof typeof DATUM_ERROR_CODES];

/** Structured failure describing why datum input was rejected or unresolvable. */
export interface DatumError extends ParseFailure {
  readonly code: DatumErrorCode;
}

function datumError(
  code: DatumErrorCode,
  message: string,
  input: unknown,
): DatumError {
  return { code, message, input };
}

/** The datum kinds the document records carry. */
export const DATUM_KINDS = ["plane", "axis", "point", "cSys"] as const;

export type DatumKind = (typeof DATUM_KINDS)[number];

const DATUM_KIND_SET: ReadonlySet<string> = new Set(DATUM_KINDS);

/** Whether `kind` is one of the four datum kinds. */
export function isDatumKind(kind: string): kind is DatumKind {
  return DATUM_KIND_SET.has(kind);
}

/** A finite 3-vector, accepted as a plain triple. */
function parseVec3(
  input: unknown,
  what: string,
): ParseResult<DatumVec3, DatumError> {
  if (
    !Array.isArray(input) ||
    input.length !== 3 ||
    input.some(
      (component) =>
        typeof component !== "number" || !Number.isFinite(component),
    )
  ) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.fieldInvalid,
        `A datum ${what} must be a triple of finite numbers.`,
        input,
      ),
    );
  }
  return ok([input[0] as number, input[1] as number, input[2] as number]);
}

/** A signed offset in millimetres (any finite value — a datum plane may sit anywhere). */
function parseOffsetMm(input: unknown): ParseResult<number, DatumError> {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.fieldInvalid,
        "A datum face offset must be a finite number of millimetres.",
        input,
      ),
    );
  }
  return ok(input);
}

/** The reference payload of a reference-dependent definition (stored verbatim). */
function parseReferencePayload(
  input: unknown,
): ParseResult<Readonly<Record<string, unknown>>, DatumError> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.referenceInvalid,
        "A datum reference must be a plain object (the persistent-reference module's canonical serialized form).",
        input,
      ),
    );
  }
  return ok(input as Readonly<Record<string, unknown>>);
}

// ---------------------------------------------------------------------------
// Payload shapes (canonical, fixed key order)
// ---------------------------------------------------------------------------

/** A datum plane defined by an explicit origin and frame. */
export interface DatumPlaneOriginFrame {
  readonly formatVersion: number;
  readonly datumType: "plane";
  readonly definition: "originFrame";
  readonly origin: DatumVec3;
  readonly normal: DatumVec3;
  readonly xAxis: DatumVec3;
}

/** A datum plane defined by three non-collinear points. */
export interface DatumPlaneThreePoints {
  readonly formatVersion: number;
  readonly datumType: "plane";
  readonly definition: "threePoints";
  readonly origin: DatumVec3;
  readonly xAxisPoint: DatumVec3;
  readonly yAxisPoint: DatumVec3;
}

/**
 * A datum plane anchored to a face of a body: the face's persistent
 * reference (Phase 22 payload), the face normal AT DEFINITION TIME (the
 * re-resolution alignment key — a moved face re-resolves along its current
 * position with the frame aligned to this recorded normal), and the signed
 * offset along the normal.
 */
export interface DatumPlaneFaceOffset {
  readonly formatVersion: number;
  readonly datumType: "plane";
  readonly definition: "faceOffset";
  readonly reference: Readonly<Record<string, unknown>>;
  readonly normalAtDefinition: DatumVec3;
  readonly offsetMm: number;
}

/** A datum axis defined by a persistent edge reference. */
export interface DatumAxisEdge {
  readonly formatVersion: number;
  readonly datumType: "axis";
  readonly definition: "edge";
  readonly reference: Readonly<Record<string, unknown>>;
}

/** A datum axis defined by two points. */
export interface DatumAxisTwoPoints {
  readonly formatVersion: number;
  readonly datumType: "axis";
  readonly definition: "twoPoints";
  readonly first: DatumVec3;
  readonly second: DatumVec3;
}

/** A datum axis defined as the axis of a referenced cylindrical face. */
export interface DatumAxisFaceCylinder {
  readonly formatVersion: number;
  readonly datumType: "axis";
  readonly definition: "faceCylinder";
  readonly reference: Readonly<Record<string, unknown>>;
}

/** A datum point at an explicit position. */
export interface DatumPointPosition {
  readonly formatVersion: number;
  readonly datumType: "point";
  readonly position: DatumVec3;
}

/** A coordinate system: origin plus an orthonormal right-handed frame. */
export interface DatumCSysFrame {
  readonly formatVersion: number;
  readonly datumType: "cSys";
  readonly origin: DatumVec3;
  readonly xAxis: DatumVec3;
  readonly normal: DatumVec3;
}

/** The datum payload union, discriminated by `datumType` then `definition`. */
export type DatumPayload =
  | DatumPlaneOriginFrame
  | DatumPlaneThreePoints
  | DatumPlaneFaceOffset
  | DatumAxisEdge
  | DatumAxisTwoPoints
  | DatumAxisFaceCylinder
  | DatumPointPosition
  | DatumCSysFrame;

function planePayload(
  formatVersion: number,
  definition: string,
  input: Record<string, unknown>,
): ParseResult<DatumPayload, DatumError> {
  if (definition === "originFrame") {
    const origin = parseVec3(input.origin, "plane origin");
    if (!origin.ok) return origin;
    const normal = parseVec3(input.normal, "plane normal");
    if (!normal.ok) return normal;
    const xAxis = parseVec3(input.xAxis, "plane xAxis");
    if (!xAxis.ok) return xAxis;
    return ok({
      formatVersion,
      datumType: "plane",
      definition: "originFrame",
      origin: origin.value,
      normal: normal.value,
      xAxis: xAxis.value,
    });
  }
  if (definition === "threePoints") {
    const origin = parseVec3(input.origin, "plane origin (the first point)");
    if (!origin.ok) return origin;
    const xAxisPoint = parseVec3(input.xAxisPoint, "plane x-axis point");
    if (!xAxisPoint.ok) return xAxisPoint;
    const yAxisPoint = parseVec3(input.yAxisPoint, "plane y-side point");
    if (!yAxisPoint.ok) return yAxisPoint;
    return ok({
      formatVersion,
      datumType: "plane",
      definition: "threePoints",
      origin: origin.value,
      xAxisPoint: xAxisPoint.value,
      yAxisPoint: yAxisPoint.value,
    });
  }
  if (definition === "faceOffset") {
    const reference = parseReferencePayload(input.reference);
    if (!reference.ok) return reference;
    const normalAtDefinition = parseVec3(
      input.normalAtDefinition,
      "face normal at definition",
    );
    if (!normalAtDefinition.ok) return normalAtDefinition;
    const offsetMm = parseOffsetMm(input.offsetMm);
    if (!offsetMm.ok) return offsetMm;
    return ok({
      formatVersion,
      datumType: "plane",
      definition: "faceOffset",
      reference: reference.value,
      normalAtDefinition: normalAtDefinition.value,
      offsetMm: offsetMm.value,
    });
  }
  return fail(
    datumError(
      DATUM_ERROR_CODES.definitionInvalid,
      "A datum plane definition must be one of: originFrame, threePoints, faceOffset.",
      input.definition,
    ),
  );
}

function axisPayload(
  formatVersion: number,
  definition: string,
  input: Record<string, unknown>,
): ParseResult<DatumPayload, DatumError> {
  if (definition === "edge") {
    const reference = parseReferencePayload(input.reference);
    if (!reference.ok) return reference;
    return ok({
      formatVersion,
      datumType: "axis",
      definition: "edge",
      reference: reference.value,
    });
  }
  if (definition === "twoPoints") {
    const first = parseVec3(input.first, "axis first point");
    if (!first.ok) return first;
    const second = parseVec3(input.second, "axis second point");
    if (!second.ok) return second;
    return ok({
      formatVersion,
      datumType: "axis",
      definition: "twoPoints",
      first: first.value,
      second: second.value,
    });
  }
  if (definition === "faceCylinder") {
    const reference = parseReferencePayload(input.reference);
    if (!reference.ok) return reference;
    return ok({
      formatVersion,
      datumType: "axis",
      definition: "faceCylinder",
      reference: reference.value,
    });
  }
  return fail(
    datumError(
      DATUM_ERROR_CODES.definitionInvalid,
      "A datum axis definition must be one of: edge, twoPoints, faceCylinder.",
      input.definition,
    ),
  );
}

/**
 * Parses untrusted input as a {@link DatumPayload}. The stamp must carry the
 * current {@link DATUM_FORMAT_VERSION} (future payloads fail predictably —
 * cad-core never guesses at a schema it does not know); unknown fields are
 * ignored so additive growth deserializes without corruption.
 */
export function parseDatumPayload(
  input: unknown,
): ParseResult<DatumPayload, DatumError> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.malformed,
        "A datum payload must be a plain object.",
        input,
      ),
    );
  }
  const record = input as Record<string, unknown>;
  const { formatVersion, datumType } = record;
  if (
    typeof formatVersion !== "number" ||
    !Number.isInteger(formatVersion) ||
    formatVersion !== DATUM_FORMAT_VERSION
  ) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.versionUnsupported,
        `A datum payload must carry formatVersion ${String(DATUM_FORMAT_VERSION)}; received ${String(formatVersion)}.`,
        formatVersion,
      ),
    );
  }
  if (typeof datumType !== "string" || !isDatumKind(datumType)) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.kindInvalid,
        `A datum type must be one of: ${DATUM_KINDS.join(", ")}.`,
        datumType,
      ),
    );
  }
  if (datumType === "plane") {
    const definition = record.definition;
    if (typeof definition !== "string") {
      return fail(
        datumError(
          DATUM_ERROR_CODES.definitionInvalid,
          "A datum plane payload must carry a definition string.",
          definition,
        ),
      );
    }
    return planePayload(formatVersion, definition, record);
  }
  if (datumType === "axis") {
    const definition = record.definition;
    if (typeof definition !== "string") {
      return fail(
        datumError(
          DATUM_ERROR_CODES.definitionInvalid,
          "A datum axis payload must carry a definition string.",
          definition,
        ),
      );
    }
    return axisPayload(formatVersion, definition, record);
  }
  if (datumType === "point") {
    const position = parseVec3(record.position, "point position");
    if (!position.ok) return position;
    return ok({
      formatVersion,
      datumType: "point",
      position: position.value,
    });
  }
  const origin = parseVec3(record.origin, "coordinate system origin");
  if (!origin.ok) return origin;
  const xAxis = parseVec3(record.xAxis, "coordinate system xAxis");
  if (!xAxis.ok) return xAxis;
  const normal = parseVec3(record.normal, "coordinate system normal");
  if (!normal.ok) return normal;
  return ok({
    formatVersion,
    datumType: "cSys",
    origin: origin.value,
    xAxis: xAxis.value,
    normal: normal.value,
  });
}

/**
 * Serializes a datum payload to its canonical form: the payload IS the
 * canonical shape (fixed key order by construction), copied key-for-key so
 * the stored record owns its data outright.
 */
export function serializeDatumPayload(payload: DatumPayload): DatumPayload {
  switch (payload.datumType) {
    case "plane":
      if (payload.definition === "originFrame") {
        return {
          formatVersion: payload.formatVersion,
          datumType: "plane",
          definition: "originFrame",
          origin: [...payload.origin],
          normal: [...payload.normal],
          xAxis: [...payload.xAxis],
        };
      }
      if (payload.definition === "threePoints") {
        return {
          formatVersion: payload.formatVersion,
          datumType: "plane",
          definition: "threePoints",
          origin: [...payload.origin],
          xAxisPoint: [...payload.xAxisPoint],
          yAxisPoint: [...payload.yAxisPoint],
        };
      }
      return {
        formatVersion: payload.formatVersion,
        datumType: "plane",
        definition: "faceOffset",
        reference: payload.reference,
        normalAtDefinition: [...payload.normalAtDefinition],
        offsetMm: payload.offsetMm,
      };
    case "axis":
      if (payload.definition === "edge") {
        return {
          formatVersion: payload.formatVersion,
          datumType: "axis",
          definition: "edge",
          reference: payload.reference,
        };
      }
      if (payload.definition === "twoPoints") {
        return {
          formatVersion: payload.formatVersion,
          datumType: "axis",
          definition: "twoPoints",
          first: [...payload.first],
          second: [...payload.second],
        };
      }
      return {
        formatVersion: payload.formatVersion,
        datumType: "axis",
        definition: "faceCylinder",
        reference: payload.reference,
      };
    case "point":
      return {
        formatVersion: payload.formatVersion,
        datumType: "point",
        position: [...payload.position],
      };
    case "cSys":
      return {
        formatVersion: payload.formatVersion,
        datumType: "cSys",
        origin: [...payload.origin],
        xAxis: [...payload.xAxis],
        normal: [...payload.normal],
      };
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A resolved datum plane: origin, unit normal, in-plane unit x axis. */
export interface ResolvedDatumPlane {
  readonly origin: DatumVec3;
  readonly normal: DatumVec3;
  readonly xAxis: DatumVec3;
}

/** A resolved datum axis: a point on the line and its unit direction. */
export interface ResolvedDatumAxis {
  readonly origin: DatumVec3;
  readonly direction: DatumVec3;
}

/** A resolved datum point. */
export interface ResolvedDatumPoint {
  readonly position: DatumVec3;
}

/** A resolved coordinate system: origin plus the full right-handed frame. */
export interface ResolvedDatumCSys {
  readonly origin: DatumVec3;
  readonly xAxis: DatumVec3;
  readonly yAxis: DatumVec3;
  readonly zAxis: DatumVec3;
}

/** The resolution outcome of a datum payload, discriminated by kind. */
export type ResolvedDatum =
  | { readonly datumType: "plane"; readonly plane: ResolvedDatumPlane }
  | { readonly datumType: "axis"; readonly axis: ResolvedDatumAxis }
  | { readonly datumType: "point"; readonly point: ResolvedDatumPoint }
  | { readonly datumType: "cSys"; readonly cSys: ResolvedDatumCSys };

/**
 * The topology seam reference-dependent definitions resolve through. The
 * resolving layer owns face/edge geometry (the executor bridge's host on
 * the kernel side, the workbench session on the scene side); every failure
 * — an unparseable reference, a vanished face, a curved face where a plane
 * is needed — rides through verbatim as the resolver's structured failure.
 */
export interface DatumTopologyResolver {
  /** The plane of the referenced face (planar faces only). */
  facePlane(
    reference: Readonly<Record<string, unknown>>,
  ): ParseResult<ResolvedDatumPlane, ParseFailure>;
  /** The axis line of the referenced cylindrical face. */
  faceCylinderAxis(
    reference: Readonly<Record<string, unknown>>,
  ): ParseResult<ResolvedDatumAxis, ParseFailure>;
  /** The line of the referenced edge. */
  edgeLine(
    reference: Readonly<Record<string, unknown>>,
  ): ParseResult<ResolvedDatumAxis, ParseFailure>;
}

/** Dot product of two 3-vectors. */
export function datumDot(a: DatumVec3, b: DatumVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Cross product of two 3-vectors. */
export function datumCross(a: DatumVec3, b: DatumVec3): DatumVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Component-wise difference `a - b`. */
export function datumSubtract(a: DatumVec3, b: DatumVec3): DatumVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Component-wise sum `a + b`. */
export function datumAdd(a: DatumVec3, b: DatumVec3): DatumVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** `a + s·b` — the affine combination the offset and axis computations share. */
export function datumCombine(a: DatumVec3, s: number, b: DatumVec3): DatumVec3 {
  return [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
}

/** Squared length. */
export function datumLengthSquared(a: DatumVec3): number {
  return datumDot(a, a);
}

/** Under this length a direction counts as degenerate (the workplane epsilon). */
export const DATUM_DIRECTION_EPSILON = 1e-12;

/** Normalizes a direction, or fails with `datum/frame-degenerate`. */
export function unitDatumVec3(
  a: DatumVec3,
  what: string,
): ParseResult<DatumVec3, DatumError> {
  const lengthSquared = datumLengthSquared(a);
  if (lengthSquared < DATUM_DIRECTION_EPSILON * DATUM_DIRECTION_EPSILON) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.frameDegenerate,
        `A datum ${what} is degenerate (length ${String(Math.sqrt(lengthSquared))}); it carries no direction.`,
        a,
      ),
    );
  }
  const length = Math.sqrt(lengthSquared);
  return ok([a[0] / length, a[1] / length, a[2] / length]);
}

/**
 * Orthonormalizes a plane frame (the workplane module's rules, at datum
 * vocabulary): normalize the normal, Gram-Schmidt the x direction against
 * it, y = z × x. Parallel or degenerate input fails with
 * `datum/frame-degenerate` — never an arbitrary fallback frame.
 */
export function orthonormalDatumFrame(
  origin: DatumVec3,
  normal: DatumVec3,
  xAxis: DatumVec3,
): ParseResult<ResolvedDatumPlane, DatumError> {
  const z = unitDatumVec3(normal, "plane normal");
  if (!z.ok) return z;
  const projection = datumDot(xAxis, z.value);
  const remainder = datumSubtract(xAxis, [
    projection * z.value[0],
    projection * z.value[1],
    projection * z.value[2],
  ]);
  const xAxisUnit = unitDatumVec3(
    remainder,
    "plane xAxis (after orthogonalization)",
  );
  if (!xAxisUnit.ok) return xAxisUnit;
  return ok({ origin: [...origin], normal: z.value, xAxis: xAxisUnit.value });
}

/** Resolves an explicit-frame datum plane. */
function resolvePlaneOriginFrame(
  payload: DatumPlaneOriginFrame,
): ParseResult<ResolvedDatum, DatumError> {
  const plane = orthonormalDatumFrame(
    payload.origin,
    payload.normal,
    payload.xAxis,
  );
  if (!plane.ok) return plane;
  return ok({ datumType: "plane", plane: plane.value });
}

/** Resolves a three-point datum plane (origin p1, +x toward p2). */
function resolvePlaneThreePoints(
  payload: DatumPlaneThreePoints,
): ParseResult<ResolvedDatum, DatumError> {
  const edgeX = datumSubtract(payload.xAxisPoint, payload.origin);
  const edgeY = datumSubtract(payload.yAxisPoint, payload.origin);
  const normal = datumCross(edgeX, edgeY);
  const plane = orthonormalDatumFrame(payload.origin, normal, edgeX);
  if (!plane.ok) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.frameDegenerate,
        "A three-point datum plane needs non-collinear points: the three points carry no plane normal.",
        payload,
      ),
    );
  }
  return ok({ datumType: "plane", plane: plane.value });
}

/**
 * Resolves a face-offset datum plane through the topology seam, then
 * applies the signed offset along the (re-resolved) normal. The resolved
 * frame is ALIGNED to `normalAtDefinition`: a re-resolved face whose mesh
 * normal points against the recorded one flips the frame deterministically
 * (normal and xAxis together, keeping the frame right-handed), so a moved
 * face re-resolves to the same material side the author defined the datum
 * on — never to a silently flipped plane.
 */
function resolvePlaneFaceOffset(
  payload: DatumPlaneFaceOffset,
  resolver: DatumTopologyResolver,
): ParseResult<ResolvedDatum, DatumError> {
  const face = resolver.facePlane(payload.reference);
  if (!face.ok) {
    return fail(
      datumError(
        DATUM_ERROR_CODES.referenceInvalid,
        `The datum's face reference did not resolve: ${face.error.message}`,
        payload.reference,
      ),
    );
  }
  const alignment = datumDot(face.value.normal, payload.normalAtDefinition);
  const flipped = alignment < 0;
  const normal: DatumVec3 = flipped
    ? [-face.value.normal[0], -face.value.normal[1], -face.value.normal[2]]
    : face.value.normal;
  const xAxis: DatumVec3 = flipped
    ? [-face.value.xAxis[0], -face.value.xAxis[1], -face.value.xAxis[2]]
    : face.value.xAxis;
  const origin = datumCombine(face.value.origin, payload.offsetMm, normal);
  return ok({
    datumType: "plane",
    plane: { origin, normal, xAxis },
  });
}

/** Resolves a two-point datum axis. */
function resolveAxisTwoPoints(
  payload: DatumAxisTwoPoints,
): ParseResult<ResolvedDatum, DatumError> {
  const direction = datumSubtract(payload.second, payload.first);
  const unit = unitDatumVec3(
    direction,
    "axis direction (between the two points)",
  );
  if (!unit.ok) return unit;
  return ok({
    datumType: "axis",
    axis: { origin: [...payload.first], direction: unit.value },
  });
}

/**
 * Resolves a datum payload to its geometry. Explicit definitions resolve
 * entirely here (deterministic orthonormalization); reference definitions
 * route through the caller-supplied {@link DatumTopologyResolver} — a
 * reference the resolver cannot re-resolve fails with the resolver's own
 * structured code, the moved-face battery's re-resolve-or-invalidate
 * contract.
 */
export function resolveDatumPayload(
  payload: DatumPayload,
  resolver: DatumTopologyResolver,
): ParseResult<ResolvedDatum, DatumError | ParseFailure> {
  switch (payload.datumType) {
    case "plane":
      if (payload.definition === "originFrame") {
        return resolvePlaneOriginFrame(payload);
      }
      if (payload.definition === "threePoints") {
        return resolvePlaneThreePoints(payload);
      }
      return resolvePlaneFaceOffset(payload, resolver);
    case "axis":
      if (payload.definition === "twoPoints") {
        return resolveAxisTwoPoints(payload);
      }
      if (payload.definition === "edge") {
        const edge = resolver.edgeLine(payload.reference);
        if (!edge.ok) return edge;
        return ok({ datumType: "axis", axis: edge.value });
      }
      {
        const cylinder = resolver.faceCylinderAxis(payload.reference);
        if (!cylinder.ok) return cylinder;
        return ok({ datumType: "axis", axis: cylinder.value });
      }
    case "point":
      return ok({
        datumType: "point",
        point: { position: [...payload.position] },
      });
    case "cSys": {
      const frame = orthonormalDatumFrame(
        payload.origin,
        payload.normal,
        payload.xAxis,
      );
      if (!frame.ok) return frame;
      const yAxis = datumCross(frame.value.normal, frame.value.xAxis);
      return ok({
        datumType: "cSys",
        cSys: {
          origin: frame.value.origin,
          xAxis: frame.value.xAxis,
          yAxis,
          zAxis: frame.value.normal,
        },
      });
    }
  }
}
