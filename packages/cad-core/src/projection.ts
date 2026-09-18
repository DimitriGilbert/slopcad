/**
 * The renderer-neutral render projection contract (Phase 11.1): the pure,
 * serializable data a projected CAD body is rendered from. Everything a
 * renderer needs — indexed triangle buffers, optional kernel normals, an
 * AABB, stable identity, provenance metadata — and nothing it should not
 * touch: there are no Three.js, WebGL, or DOM types anywhere in this module,
 * by construction (cad-core carries no renderer dependencies at all).
 *
 * ## Placement
 *
 * This module lives in cad-core because cad-core is the one workspace
 * package that is simultaneously kernel-free and renderer-free — the kernel
 * depends on it, renderers depend on it, and it depends on neither. The
 * kernel-side input is the structural type {@link KernelTessellationSource},
 * field-for-field identical to the Phase 8 kernel contract's `Tessellation`,
 * so `@slopcad/cad-kernel` output satisfies it without cad-core importing
 * the kernel package (the dependency arrow stays kernel → core).
 *
 * ## Stable render object identity
 *
 * A {@link RenderObjectId} is `rend_<payload>` where `<payload>` is the body
 * id's payload after its `body_` prefix — `body_plate` projects to
 * `rend_plate`. Because document body ids are stable across regenerations
 * of the same body and distinct between bodies, the derived render id
 * inherits both properties with zero coordination, and it is never derived
 * from triangle indices or vertex counts (which change with every
 * tessellation). The mapping is a prefix-preserving bijection, so
 * {@link renderObjectIdBodyId} inverts it exactly; `parseRenderProjection`
 * enforces the derivation whenever a body id is present, making the rule
 * verifiable at every trust boundary.
 *
 * ## Buffers: plain arrays, float64 fidelity
 *
 * Positions, indices, and normals are plain `readonly number[]` flat xyz /
 * triangle-vertex-index arrays. Decision and rationale: (1) they are exactly
 * JSON-serializable, so the fixed-shape wire format below round-trips
 * byte-stable; (2) they structured-clone across `postMessage`, which is how
 * the Phase 10 worker boundary already moves kernel results; (3) they carry
 * the kernel's float64 values unchanged, so semantic assertions compare the
 * real numbers rather than float32-quantized ones. Zero-copy transfer
 * (`Float32Array`/`Uint32Array` + transfer lists) is deliberately NOT part
 * of the contract: quantizing to float32 is a renderer-upload optimization
 * that belongs at the GPU boundary (Phase 11.2), not a property of the
 * projection data.
 *
 * ## Bounds
 *
 * {@link RenderObject.bounds} is computed from the projected positions
 * ({@link boundsFromPositions}), not copied from kernel bounds: kernel
 * bounds of boolean results may be conservative containers (the
 * `tightBooleanBounds` capability governs that), while a render object's
 * AABB must tightly describe exactly the geometry the renderer draws —
 * computing it from the passed-through positions keeps it self-consistent
 * by construction, and the assertion utilities check that self-containment.
 *
 * ## Camera
 *
 * {@link RenderCamera} is DATA, not a matrix: position, target, up, and
 * either a vertical `fovDeg` (perspective) or an orthographic view size in
 * millimetres — the deterministic-camera half of the spike's scene rules
 * (fixed camera, geometry is the only variable). fov is degrees because
 * that is the authoring convention for camera specs; every other length is
 * canonical millimetres, matching kernel outputs. Cameras are validated
 * ({@link parseRenderCamera}) for structural well-formedness and against
 * the two degenerate configurations a data camera can encode silently: a
 * zero or view-parallel up vector, and a position coincident with the
 * target.
 *
 * ## Winding and topology
 *
 * The projection is winding-agnostic: the kernel's deterministic soup may
 * orient triangles either way depending on backend, so neither the contract
 * nor the assertion utilities check orientation. Topology metadata
 * (faces/edges/vertices) is deferred to Phase 12: both current kernels
 * advertise `persistentTopology: false`, and Phase 12 makes face/edge/vertex
 * selection synthetic and transient, so a render object carries only
 * body/feature provenance today.
 *
 * ## Wire format
 *
 * {@link serializeRenderProjection} emits a fixed-shape, fixed-key-order
 * JSON object stamped with {@link CAD_PROJECTION_FORMAT_VERSION};
 * {@link parseRenderProjection} validates every known field strictly
 * (stable `projection/*` and `render-id/*` failure codes), ignores unknown
 * fields so future versions deserialize without corruption, and round-trips
 * exactly — including stable render object ids.
 */

import {
  CAD_ID_MAX_PAYLOAD_LENGTH,
  CAD_ID_PREFIXES,
  type BodyId,
  type FeatureId,
  createBodyId,
  parseBodyId,
  parseFeatureId,
} from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { CAD_PROJECTION_FORMAT_VERSION } from "./version";

/**
 * The kernel-side input of the projection conversion: an indexed triangle
 * soup with optional kernel vertex normals, exactly the shape of the Phase 8
 * kernel contract's `Tessellation` (flat xyz positions, flat triangle-vertex
 * indices, optional paired flat xyz unit normals). Declared structurally so
 * kernel output satisfies it without a kernel import.
 */
export interface KernelTessellationSource {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
}

/** Stable failure codes produced when projection input is rejected. */
export const PROJECTION_ERROR_CODES = {
  /** A render object id was not a string. */
  idNotAString: "render-id/not-a-string",
  /** A render object id did not start with `rend_`. */
  idWrongPrefix: "render-id/wrong-prefix",
  /** A render object id's payload violated the id payload rules. */
  idInvalidPayload: "render-id/invalid-payload",
  /** A projection, render object, or buffer field was structurally invalid. */
  malformed: "projection/malformed",
  /** A tessellation with no triangles cannot become a render object. */
  emptyTessellation: "projection/empty-tessellation",
  /** A camera spec was structurally invalid or geometrically degenerate. */
  cameraMalformed: "projection/camera-malformed",
  /** Two render objects in one projection carried the same id. */
  duplicateObjectId: "projection/duplicate-object-id",
  /** A serialized projection carried an unsupported format version. */
  versionUnsupported: "projection/version-unsupported",
} as const;

export type ProjectionErrorCode =
  (typeof PROJECTION_ERROR_CODES)[keyof typeof PROJECTION_ERROR_CODES];

/** Structured failure describing why projection input was rejected. */
export interface ProjectionError extends ParseFailure {
  readonly code: ProjectionErrorCode;
}

function projectionError(
  code: ProjectionErrorCode,
  message: string,
  input: unknown,
): ProjectionError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isUnknownArray(input: unknown): input is unknown[] {
  return Array.isArray(input);
}

function isTripleArray(input: unknown): input is unknown[] {
  return Array.isArray(input) && input.length === 3;
}

// ---------------------------------------------------------------------------
// Stable render object identity
// ---------------------------------------------------------------------------

/**
 * Sole branding site for render object ids: a plain string in the
 * `rend_<payload>` wire format, type-distinct so it cannot be confused with
 * body/feature ids while remaining serializable and comparable as a string.
 */
declare const renderObjectIdBrand: unique symbol;

/** Identifier of a rendered body (e.g. `rend_plate`), stable across regenerations. */
export type RenderObjectId = string & {
  readonly [renderObjectIdBrand]: "render-object";
};

/** Wire prefix of every {@link RenderObjectId}. */
export const RENDER_OBJECT_ID_PREFIX = "rend_";

const RENDER_ID_PAYLOAD_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${CAD_ID_MAX_PAYLOAD_LENGTH - 1}}$`,
);

/**
 * Derives the render object id of a body: `rend_` + the body id's payload.
 * Pure and total — the payload of an already-validated `body_…` id always
 * satisfies the render id payload rules, so the brand below only attaches a
 * type to input that is valid by construction.
 */
export function createRenderObjectId(bodyId: BodyId): RenderObjectId {
  const payload = bodyId.slice(CAD_ID_PREFIXES.body.length + 1);
  return `${RENDER_OBJECT_ID_PREFIX}${payload}` as RenderObjectId;
}

/** Inverts {@link createRenderObjectId}: the body id a render object id derives from. */
export function renderObjectIdBodyId(id: RenderObjectId): BodyId {
  return createBodyId(
    `${CAD_ID_PREFIXES.body}_${id.slice(RENDER_OBJECT_ID_PREFIX.length)}`,
  );
}

/**
 * Parses untrusted input as a {@link RenderObjectId} (strict `rend_` wire
 * format; stable failure codes) so ids revived from serialized projections
 * or IPC are never trusted by brand alone.
 */
export function parseRenderObjectId(
  input: unknown,
): ParseResult<RenderObjectId, ProjectionError> {
  if (typeof input !== "string") {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.idNotAString,
        "A render object id must be a string.",
        input,
      ),
    );
  }
  if (!input.startsWith(RENDER_OBJECT_ID_PREFIX)) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.idWrongPrefix,
        `A render object id must start with "${RENDER_OBJECT_ID_PREFIX}".`,
        input,
      ),
    );
  }
  const payload = input.slice(RENDER_OBJECT_ID_PREFIX.length);
  if (!RENDER_ID_PAYLOAD_PATTERN.test(payload)) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.idInvalidPayload,
        `The payload of a render object id must be 1-${CAD_ID_MAX_PAYLOAD_LENGTH} characters, start alphanumeric, and use only A-Z a-z 0-9 . _ - .`,
        input,
      ),
    );
  }
  return ok(input as RenderObjectId);
}

// ---------------------------------------------------------------------------
// Bounds and render objects
// ---------------------------------------------------------------------------

/**
 * An axis-aligned bounding box in canonical millimetres, tight over the
 * render object's positions by construction.
 */
export interface RenderBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Computes the tight AABB of a flat xyz position array. Throws a
 * `RangeError` on input that is not a non-empty, finite, flat triple array —
 * callers validate first (the projection paths do); this is a pure math
 * helper, not a trust-boundary parser.
 */
export function boundsFromPositions(
  positions: readonly number[],
): RenderBounds {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new RangeError(
      "Bounds require a non-empty flat xyz position array divisible by 3.",
    );
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (
      x === undefined ||
      y === undefined ||
      z === undefined ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z)
    ) {
      throw new RangeError("Bounds require finite positions.");
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return Object.freeze({
    min: Object.freeze([minX, minY, minZ] as const),
    max: Object.freeze([maxX, maxY, maxZ] as const),
  });
}

/**
 * How far a kernel normal may deviate from unit length and still pass
 * validation: normals arrive as single-precision floats computed inside
 * geometry kernels, so 0.1% is noise while genuinely corrupt normals fail.
 * Mirrors the kernel contract's own tolerance so the projection accepts
 * exactly what conforming kernels emit.
 */
export const RENDER_NORMAL_UNIT_TOLERANCE = 1e-3;

/**
 * One rendered body: an indexed triangle soup in canonical millimetres with
 * a stable id, a tight AABB, and optional provenance metadata.
 *
 * `positions` is flat xyz, `indices` is a flat triangle-vertex-index array,
 * and `normals` — present only when the kernel computed them — is a flat xyz
 * unit-vector array paired index-for-index with `positions`. All three pass
 * through `projectTessellation` unchanged: no quantization, no re-indexing,
 * so the kernel's deterministic soup is the renderer's soup. Winding is
 * unspecified (see the module header).
 *
 * `bodyId`/`featureId` are optional provenance: conversion always stamps the
 * body id it projected, the feature id when the caller knows it, and neither
 * is required for renderer-owned objects. Topology metadata arrives with
 * Phase 12 selection as synthetic, transient data — both current kernels
 * advertise `persistentTopology: false`.
 */
export interface RenderObject {
  readonly id: RenderObjectId;
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
  readonly bounds: RenderBounds;
  readonly bodyId?: BodyId;
  readonly featureId?: FeatureId;
}

/** The validated, copied buffer triple shared by the conversion and parse paths. */
interface ValidatedBuffers {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
}

/**
 * Validates raw buffer fields (arrays of numbers, flat triples, indices in
 * vertex range, normals paired and unit) and returns detached copies. Every
 * entry point that produces a render object funnels through here, so the
 * kernel contract's structural guarantees are re-established at the
 * projection boundary no matter where the soup came from.
 */
function validateGeometry(
  input: {
    readonly positions?: unknown;
    readonly indices?: unknown;
    readonly normals?: unknown;
  },
  label: string,
): ParseResult<ValidatedBuffers, ProjectionError> {
  const { positions, indices, normals } = input;
  const malformed = (
    message: string,
    detail: unknown,
  ): ParseResult<ValidatedBuffers, ProjectionError> =>
    fail(projectionError(PROJECTION_ERROR_CODES.malformed, message, detail));
  if (!isUnknownArray(positions)) {
    return malformed(
      `${label} positions must be an array of numbers.`,
      positions,
    );
  }
  if (!isUnknownArray(indices)) {
    return malformed(`${label} indices must be an array of numbers.`, indices);
  }
  if (positions.length === 0 || indices.length === 0) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.emptyTessellation,
        `${label} is empty: a render object needs at least one triangle (empty bodies project to no object).`,
        input,
      ),
    );
  }
  if (positions.length % 3 !== 0) {
    return malformed(
      `${label} positions length ${positions.length} is not divisible by 3.`,
      positions.length,
    );
  }
  if (indices.length % 3 !== 0) {
    return malformed(
      `${label} indices length ${indices.length} is not divisible by 3.`,
      indices.length,
    );
  }
  const copiedPositions: number[] = [];
  for (const value of positions) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return malformed(
        `${label} position ${copiedPositions.length} is not a finite number.`,
        value,
      );
    }
    copiedPositions.push(value);
  }
  const copiedIndices: number[] = [];
  for (const value of indices) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return malformed(
        `${label} index ${copiedIndices.length} is not a non-negative integer.`,
        value,
      );
    }
    copiedIndices.push(value);
  }
  const vertexCount = copiedPositions.length / 3;
  for (const index of copiedIndices) {
    if (index >= vertexCount) {
      return malformed(
        `${label} index ${index} is outside the vertex range 0..${vertexCount - 1}.`,
        index,
      );
    }
  }
  if (normals === undefined) {
    return ok({ positions: copiedPositions, indices: copiedIndices });
  }
  if (!isUnknownArray(normals)) {
    return malformed(`${label} normals must be an array of numbers.`, normals);
  }
  const copiedNormals: number[] = [];
  for (const value of normals) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return malformed(
        `${label} normal component ${copiedNormals.length} is not a finite number.`,
        value,
      );
    }
    copiedNormals.push(value);
  }
  if (copiedNormals.length !== copiedPositions.length) {
    return malformed(
      `${label} normals length ${copiedNormals.length} does not match positions length ${copiedPositions.length}.`,
      copiedNormals.length,
    );
  }
  for (let i = 0; i < copiedNormals.length; i += 3) {
    const nx = copiedNormals[i];
    const ny = copiedNormals[i + 1];
    const nz = copiedNormals[i + 2];
    if (nx === undefined || ny === undefined || nz === undefined) {
      return malformed(`${label} normals are not a flat xyz array.`, normals);
    }
    const length = Math.hypot(nx, ny, nz);
    if (Math.abs(length - 1) > RENDER_NORMAL_UNIT_TOLERANCE) {
      return malformed(
        `${label} normal ${i / 3} has length ${length}, not unit within ${RENDER_NORMAL_UNIT_TOLERANCE}.`,
        length,
      );
    }
  }
  return ok({
    positions: copiedPositions,
    indices: copiedIndices,
    normals: copiedNormals,
  });
}

/**
 * Converts a kernel tessellation into a {@link RenderObject}: the pure
 * Phase 11.1 boundary function between kernel output and render data.
 *
 * Positions, indices, and (when present) normals pass through unchanged —
 * values identical, arrays copied so the render object is detached from the
 * caller's buffers — after full structural validation (flat triples,
 * finite, indices in vertex range, normals paired and unit). Bounds are
 * computed from the positions (see the module header), the id is derived
 * from the body id (stable across regenerations), and the optional feature
 * id rides along as provenance. An empty soup fails with
 * `projection/empty-tessellation`: an empty body renders nothing, so it
 * projects to no object rather than a degenerate one.
 */
export function projectTessellation(
  bodyId: BodyId,
  tessellation: KernelTessellationSource,
  featureId?: FeatureId,
): ParseResult<RenderObject, ProjectionError> {
  const buffers = validateGeometry(
    tessellation,
    `The tessellation of body ${bodyId}`,
  );
  if (!buffers.ok) return buffers;
  const { positions, indices, normals } = buffers.value;
  const bounds = boundsFromPositions(positions);
  const id = createRenderObjectId(bodyId);
  const record: {
    id: RenderObjectId;
    positions: readonly number[];
    indices: readonly number[];
    normals?: readonly number[];
    bounds: RenderBounds;
    bodyId: BodyId;
    featureId?: FeatureId;
  } = { id, positions, indices, bounds, bodyId };
  if (normals !== undefined) record.normals = normals;
  if (featureId !== undefined) record.featureId = featureId;
  return ok(Object.freeze(record));
}

// ---------------------------------------------------------------------------
// Camera spec
// ---------------------------------------------------------------------------

/** A finite xyz triple in canonical millimetres. */
export type RenderVector3 = readonly [number, number, number];

/**
 * A deterministic camera as data: where the eye is, what it looks at, which
 * way up is, and the projection parameters. Renderers turn this into their
 * own matrix types; tests compare it with tolerance. All lengths are
 * canonical millimetres; `fovDeg` is the vertical field of view in degrees.
 */
export type RenderCamera =
  | {
      readonly kind: "perspective";
      readonly position: RenderVector3;
      readonly target: RenderVector3;
      readonly up: RenderVector3;
      /** Vertical field of view in degrees, strictly between 0 and 180. */
      readonly fovDeg: number;
    }
  | {
      readonly kind: "orthographic";
      readonly position: RenderVector3;
      readonly target: RenderVector3;
      readonly up: RenderVector3;
      /** Width of the orthographic view volume in millimetres (positive). */
      readonly viewWidth: number;
      /** Height of the orthographic view volume in millimetres (positive). */
      readonly viewHeight: number;
    };

/**
 * Cameras closer to degenerate than this (up × view axis shorter than this
 * norm) are rejected: a zero or view-parallel up, or a position coincident
 * with the target, would make a renderer's view matrix quietly undefined.
 */
const CAMERA_DEGENERACY_EPSILON = 1e-9;

function parseFiniteTriple(
  input: unknown,
  label: string,
): ParseResult<readonly [number, number, number], ProjectionError> {
  if (!isTripleArray(input)) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        `${label} must be a 3-component numeric array.`,
        input,
      ),
    );
  }
  const [x, y, z] = input;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        `${label} must contain three finite numbers.`,
        input,
      ),
    );
  }
  return ok([x, y, z]);
}

function parseCameraVector(
  input: unknown,
  field: "position" | "target" | "up",
): ParseResult<RenderVector3, ProjectionError> {
  const parsed = parseFiniteTriple(input, `A render camera ${field}`);
  if (!parsed.ok) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.cameraMalformed,
        parsed.error.message,
        input,
      ),
    );
  }
  return parsed;
}

/**
 * Parses untrusted input as a {@link RenderCamera}: structural checks (plain
 * object, known kind, finite triples, perspective fov strictly inside
 * (0, 180), positive orthographic view size) plus geometric checks (up not
 * zero, up not parallel to the view axis, position distinct from target).
 * Also the re-validation used wherever a typed camera enters a projection,
 * so a smuggled degenerate spec fails structurally instead of corrupting a
 * deterministic scene.
 */
export function parseRenderCamera(
  input: unknown,
): ParseResult<RenderCamera, ProjectionError> {
  const invalid = (
    message: string,
  ): ParseResult<RenderCamera, ProjectionError> =>
    fail(
      projectionError(PROJECTION_ERROR_CODES.cameraMalformed, message, input),
    );
  if (!isPlainRecord(input)) {
    return invalid("A render camera must be a plain object.");
  }
  const { kind } = input;
  if (kind !== "perspective" && kind !== "orthographic") {
    return invalid(
      'A render camera kind must be "perspective" or "orthographic".',
    );
  }
  const position = parseCameraVector(input.position, "position");
  if (!position.ok) return position;
  const target = parseCameraVector(input.target, "target");
  if (!target.ok) return target;
  const up = parseCameraVector(input.up, "up");
  if (!up.ok) return up;
  const [px, py, pz] = position.value;
  const [tx, ty, tz] = target.value;
  const [ux, uy, uz] = up.value;
  const vx = px - tx;
  const vy = py - ty;
  const vz = pz - tz;
  const crossNorm = Math.hypot(
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  );
  if (crossNorm <= CAMERA_DEGENERACY_EPSILON) {
    return invalid(
      "A render camera's up must be non-zero and not parallel to its view axis, and its position must differ from its target.",
    );
  }
  if (kind === "perspective") {
    const fovDeg = input.fovDeg;
    if (
      typeof fovDeg !== "number" ||
      !Number.isFinite(fovDeg) ||
      fovDeg <= 0 ||
      fovDeg >= 180
    ) {
      return invalid(
        "A perspective render camera needs a finite fovDeg strictly between 0 and 180 degrees.",
      );
    }
    return ok(
      Object.freeze({
        kind,
        position: position.value,
        target: target.value,
        up: up.value,
        fovDeg,
      }),
    );
  }
  const viewWidth = input.viewWidth;
  const viewHeight = input.viewHeight;
  if (
    typeof viewWidth !== "number" ||
    !Number.isFinite(viewWidth) ||
    viewWidth <= 0
  ) {
    return invalid(
      "An orthographic render camera needs a finite positive viewWidth.",
    );
  }
  if (
    typeof viewHeight !== "number" ||
    !Number.isFinite(viewHeight) ||
    viewHeight <= 0
  ) {
    return invalid(
      "An orthographic render camera needs a finite positive viewHeight.",
    );
  }
  return ok(
    Object.freeze({
      kind,
      position: position.value,
      target: target.value,
      up: up.value,
      viewWidth,
      viewHeight,
    }),
  );
}

// ---------------------------------------------------------------------------
// Scene-level projection
// ---------------------------------------------------------------------------

/**
 * A complete projection of the current document state for one viewport: the
 * rendered bodies plus the deterministic camera spec they are viewed with.
 * Objects are unordered — identity is the id, never array position.
 */
export interface RenderProjection {
  readonly objects: readonly RenderObject[];
  readonly camera: RenderCamera;
}

/**
 * Assembles a {@link RenderProjection} from render objects and a camera.
 * The camera is re-validated (typed input is still checked, house style) and
 * object ids must parse and be unique — a projection renders each body at
 * most once, which is what makes "replace the previous result" (Phase 11.2)
 * a keyed-by-id operation rather than a diff of anonymous buffers.
 */
export function createRenderProjection(
  objects: readonly RenderObject[],
  camera: RenderCamera,
): ParseResult<RenderProjection, ProjectionError> {
  const cameraCheck = parseRenderCamera(camera);
  if (!cameraCheck.ok) return cameraCheck;
  const seen = new Set<string>();
  for (const object of objects) {
    const idCheck = parseRenderObjectId(object.id);
    if (!idCheck.ok) {
      return fail(
        projectionError(
          PROJECTION_ERROR_CODES.malformed,
          `A render object id is invalid: ${idCheck.error.message}`,
          object.id,
        ),
      );
    }
    if (seen.has(object.id)) {
      return fail(
        projectionError(
          PROJECTION_ERROR_CODES.duplicateObjectId,
          `Duplicate render object id "${object.id}"; a projection renders each body once.`,
          object.id,
        ),
      );
    }
    seen.add(object.id);
  }
  return ok(
    Object.freeze({
      objects: Object.freeze([...objects]),
      camera: cameraCheck.value,
    }),
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Wire form of {@link RenderBounds}; min/max millimetre triples. */
export interface SerializedRenderBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Wire form of a camera. A {@link RenderCamera} is already plain data — a
 * discriminated record of tuples and numbers — so the wire type is its
 * structural twin, named for its role at the serialization boundary.
 */
export type SerializedRenderCamera = RenderCamera;

/**
 * Canonical JSON form of a render object. Fixed key order: `formatVersion`,
 * `id`, `positions`, `indices`, `bounds`, then the optional `normals`,
 * `bodyId`, `featureId` (present only when the source carries them), so
 * equal projections always serialize to identical bytes.
 */
export interface SerializedRenderObject {
  readonly formatVersion: number;
  readonly id: string;
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly bounds: SerializedRenderBounds;
  readonly normals?: readonly number[];
  readonly bodyId?: string;
  readonly featureId?: string;
}

/**
 * Canonical JSON form of a projection: fixed shape (`formatVersion`,
 * `objects`, `camera`), stamped with {@link CAD_PROJECTION_FORMAT_VERSION}.
 */
export interface SerializedRenderProjection {
  readonly formatVersion: number;
  readonly objects: readonly SerializedRenderObject[];
  readonly camera: SerializedRenderCamera;
}

function serializeBounds(bounds: RenderBounds): SerializedRenderBounds {
  return { min: bounds.min, max: bounds.max };
}

function serializeCamera(camera: RenderCamera): SerializedRenderCamera {
  if (camera.kind === "orthographic") {
    return {
      kind: camera.kind,
      position: camera.position,
      target: camera.target,
      up: camera.up,
      viewWidth: camera.viewWidth,
      viewHeight: camera.viewHeight,
    };
  }
  return {
    kind: camera.kind,
    position: camera.position,
    target: camera.target,
    up: camera.up,
    fovDeg: camera.fovDeg,
  };
}

function serializeRenderObject(object: RenderObject): SerializedRenderObject {
  const serialized: {
    formatVersion: number;
    id: string;
    positions: readonly number[];
    indices: readonly number[];
    bounds: SerializedRenderBounds;
    normals?: readonly number[];
    bodyId?: string;
    featureId?: string;
  } = {
    formatVersion: CAD_PROJECTION_FORMAT_VERSION,
    id: object.id,
    positions: [...object.positions],
    indices: [...object.indices],
    bounds: serializeBounds(object.bounds),
  };
  if (object.normals !== undefined) serialized.normals = [...object.normals];
  if (object.bodyId !== undefined) serialized.bodyId = object.bodyId;
  if (object.featureId !== undefined) {
    serialized.featureId = object.featureId;
  }
  return serialized;
}

/**
 * Serializes a projection to its canonical, deterministic JSON form. Buffer
 * arrays are copied; immutable tuples are referenced. Round-trips exactly
 * through {@link parseRenderProjection}, stable ids included.
 */
export function serializeRenderProjection(
  projection: RenderProjection,
): SerializedRenderProjection {
  return {
    formatVersion: CAD_PROJECTION_FORMAT_VERSION,
    objects: projection.objects.map(serializeRenderObject),
    camera: serializeCamera(projection.camera),
  };
}

function parseSerializedBounds(
  input: unknown,
): ParseResult<RenderBounds, ProjectionError> {
  if (!isPlainRecord(input)) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        "A serialized render object needs a bounds object with min and max.",
        input,
      ),
    );
  }
  const min = parseFiniteTriple(input.min, "Serialized bounds min");
  if (!min.ok) return min;
  const max = parseFiniteTriple(input.max, "Serialized bounds max");
  if (!max.ok) return max;
  const [minX, minY, minZ] = min.value;
  const [maxX, maxY, maxZ] = max.value;
  if (minX > maxX || minY > maxY || minZ > maxZ) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        "Serialized bounds min must not exceed max on any axis.",
        input,
      ),
    );
  }
  return ok(Object.freeze({ min: min.value, max: max.value }));
}

function parseSerializedRenderObject(
  input: unknown,
): ParseResult<RenderObject, ProjectionError> {
  if (!isPlainRecord(input)) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        "A serialized render object must be a plain object.",
        input,
      ),
    );
  }
  const id = parseRenderObjectId(input.id);
  if (!id.ok) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        `A serialized render object id is invalid: ${id.error.message}`,
        input.id,
      ),
    );
  }
  const buffers = validateGeometry(input, `Render object ${id.value}`);
  if (!buffers.ok) return buffers;
  const bounds = parseSerializedBounds(input.bounds);
  if (!bounds.ok) return bounds;
  const { positions, indices, normals } = buffers.value;
  let bodyId: BodyId | undefined;
  if (input.bodyId !== undefined) {
    const parsed = parseBodyId(input.bodyId);
    if (!parsed.ok) {
      return fail(
        projectionError(
          PROJECTION_ERROR_CODES.malformed,
          `A serialized render object bodyId is invalid: ${parsed.error.message}`,
          input.bodyId,
        ),
      );
    }
    bodyId = parsed.value;
  }
  if (bodyId !== undefined && createRenderObjectId(bodyId) !== id.value) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        `Render object id "${id.value}" does not derive from its bodyId "${bodyId}"; ids must follow the rend_<body payload> rule.`,
        input,
      ),
    );
  }
  let featureId: FeatureId | undefined;
  if (input.featureId !== undefined) {
    const parsed = parseFeatureId(input.featureId);
    if (!parsed.ok) {
      return fail(
        projectionError(
          PROJECTION_ERROR_CODES.malformed,
          `A serialized render object featureId is invalid: ${parsed.error.message}`,
          input.featureId,
        ),
      );
    }
    featureId = parsed.value;
  }
  const record: {
    id: RenderObjectId;
    positions: readonly number[];
    indices: readonly number[];
    normals?: readonly number[];
    bounds: RenderBounds;
    bodyId?: BodyId;
    featureId?: FeatureId;
  } = { id: id.value, positions, indices, bounds: bounds.value };
  if (normals !== undefined) record.normals = normals;
  if (bodyId !== undefined) record.bodyId = bodyId;
  if (featureId !== undefined) record.featureId = featureId;
  return ok(Object.freeze(record));
}

/**
 * Parses untrusted input (a projection revived from persisted JSON or
 * crossing the worker boundary) as a {@link RenderProjection}. Every known
 * field is validated strictly — format version, object ids (including the
 * id-derives-from-body rule), buffers (flat, finite, index range, paired
 * unit normals, non-empty), bounds (finite, ordered), metadata ids, camera
 * — while unknown fields are ignored so future format versions deserialize
 * without data corruption. Object ids must be unique.
 */
export function parseRenderProjection(
  input: unknown,
): ParseResult<RenderProjection, ProjectionError> {
  if (!isPlainRecord(input)) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        "A serialized render projection must be a plain object.",
        input,
      ),
    );
  }
  if (input.formatVersion !== CAD_PROJECTION_FORMAT_VERSION) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.versionUnsupported,
        `A serialized render projection must carry formatVersion ${CAD_PROJECTION_FORMAT_VERSION}.`,
        input.formatVersion,
      ),
    );
  }
  if (!isUnknownArray(input.objects)) {
    return fail(
      projectionError(
        PROJECTION_ERROR_CODES.malformed,
        "A serialized render projection's objects must be an array.",
        input.objects,
      ),
    );
  }
  const camera = parseRenderCamera(input.camera);
  if (!camera.ok) return camera;
  const objects: RenderObject[] = [];
  const seen = new Set<string>();
  for (const entry of input.objects) {
    const parsed = parseSerializedRenderObject(entry);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id)) {
      return fail(
        projectionError(
          PROJECTION_ERROR_CODES.duplicateObjectId,
          `Duplicate render object id "${parsed.value.id}"; a projection renders each body once.`,
          entry,
        ),
      );
    }
    seen.add(parsed.value.id);
    objects.push(parsed.value);
  }
  return ok(
    Object.freeze({ objects: Object.freeze(objects), camera: camera.value }),
  );
}
