/**
 * The worker protocol's operation vocabulary (Phase 10.1): the kernel
 * operations a worker request can carry, as data.
 *
 * Every operation in the vocabulary is an operation of the kernel contract
 * (`./contract`) — primitives, booleans, the transform, measurements,
 * tessellation, disposal — with one translation: in-process opaque
 * {@link KernelSolid} handles cannot cross a message boundary, so the wire
 * addresses solids by {@link WorkerSolidId} (see `./worker-ids`), the ids a
 * worker session mints for the solids it holds.
 *
 * The vocabulary is a table, not a closed enum of methods. Each operation id
 * maps to four codec entries — a typed input form, a canonical serialized
 * input form, and the same pair for results — registered in the typed/wire
 * maps below. Adding an operation means adding one id to
 * {@link WORKER_OPERATION_IDS} and completing its table rows; the mapped types
 * then force every codec to exist before the package compiles. Future groups
 * (e.g. `document.*` commands for the settled worker-executes-domain
 * architecture) extend the same table without touching the envelope.
 *
 * ## Division of validation labor
 *
 * The codecs validate *structure only*: lengths must parse as cad-core
 * dimensional values of dimension length, solid references must parse as
 * worker solid ids, arrays must be arrays. Semantic rules — a radius must be
 * positive, booleans need at least two operands, an empty solid has no bounds
 * — stay in the kernel contract, whose failures reach the caller as a
 * structured `worker/operation-failed` response carrying the kernel error
 * code in `data`. This keeps the contract the single source of semantic truth
 * and the protocol layer a pure carrier.
 *
 * ## Determinism
 *
 * Serialization emits the canonical form in a fixed key order, with every
 * length normalized to canonical millimetres and every angle normalized to
 * canonical radians by cad-core's dimensional-value serializer; parsing
 * accepts any unit of the right dimension. Two equal quantities therefore
 * always produce identical bytes regardless of the units they were built
 * with. Parsing is strict on known fields and tolerant of unknown fields, so
 * newer payload versions deserialize without corruption.
 *
 * ## The transform's rotation extension (Phase 21.2)
 *
 * `solid.transform` carries the contract's optional rotation (Phase 21.1)
 * as an optional `rotation` field — axis + angle — serialized after the
 * translation in the fixed key order and normalized like every other
 * dimensional value. The field is optional on the wire exactly as in the
 * contract: a payload without it parses as translation-only, so every
 * message formed before the extension keeps its meaning unchanged.
 *
 * ## The sweep/loft extension (Phase 38) — the sketch-driven feature ops
 *
 * `solid.sweep` and `solid.loft` translate the contract's `ProfileSweepInput`
 * and `ProfileLoftInput` across the wire: the profile loop segments exactly
 * as `solid.extrude` carries them, the sweep's path chain in the local XZ
 * plane (lines and signed-sweep arcs — the contract's directed-path
 * convention, NOT the profile machinery's mod-2π loop convention), and the
 * loft's ordered section list with per-section station lengths. The codecs
 * validate structure only: a path segment kind must be line or arc, a
 * section must carry a loop and a length — every semantic rule (origin
 * attachment, G1 continuity, self-intersection, station ordering,
 * vertex-count compatibility) stays in the kernel contract, and a kernel
 * that declares neither capability (Manifold) answers the structured
 * `kernel/unsupported-operation` through the ordinary failure path.
 *
 * ## The helix sweep extension (Phase 40) — the analytic-spine twin
 *
 * `solid.helixSweep` translates the contract's `HelixSweepInput` across
 * the wire: the meridian profile loop (the same segment forms every other
 * profile op carries), the analytic spine record (radius, non-negative
 * pitch, turns, handedness sign, start angle, optional total taper — the
 * taper serialized exactly when present, mirroring the transform's
 * optional-rotation discipline), and the placement. The codec validates
 * structure only: spine degeneracy, profile validity, and axis crossing
 * stay in the kernel contract (`kernel/invalid-helix`,
 * `kernel/profile-axis-crossing`), and a kernel that declares no helix
 * capability (Manifold, JSCAD) answers the structured
 * `kernel/unsupported-operation` through the ordinary failure path.
 *
 * ## The STEP import extension (Phase 21.3) — a disclosed vocabulary group
 *
 * `step.import` is the first operation in the vocabulary that is NOT a
 * translation of a {@link GeometryKernel} method: file import is a
 * kernel-backend capability (OCCT's STEP translator), not a contract
 * operation, so there is nothing on the `GeometryKernel` interface to
 * translate. The vocabulary carries it as data all the same — the table is
 * the protocol's whole truth — and the kernel-neutral server dispatches it
 * through an optional *step-import extension* the hosting side injects
 * (see `WorkerStepImporter` and `createWorkerServer`): a host without a
 * STEP-capable kernel answers `step.import` with the structured
 * `step-import/unsupported` failure instead of pretending. The geometry
 * that crosses back is ordinary session-solid addressing — one minted
 * {@link WorkerSolidId} per imported solid, usable with every `solid.*`
 * operation thereafter — so nothing downstream needs to know the solids
 * came from a file.
 *
 * What the wire result makes explicit is provenance: every imported solid
 * rides a `{ solid, origin: "imported-step" }` ref whose literal origin is
 * the data-level marker separating imported geometry from feature-built
 * solids (the cad-io no-fabrication discipline, at the protocol layer). An
 * import mints geometry ONLY — no features, no parameters, no construction
 * history exist on the wire result or anywhere behind it.
 *
 * The input carries the file's raw bytes. JSON has no byte type, so the
 * serialized form is the strict RFC 4648 base64 text (`./worker-base64`):
 * canonical padding, no whitespace, no tolerance — a corrupted payload
 * fails with `worker/malformed-payload` before any kernel runs. Unit and
 * metadata semantics are the importing kernel's business; the protocol is
 * a pure carrier of bytes and provenance-marked solid refs.
 *
 * ## The STEP export extension (Phase 21.4) — the twin disclosed group
 *
 * `step.export` is the mirror operation: session-solid ids in, STEP file
 * bytes out. Like `step.import` it is a kernel-backend capability (OCCT's
 * STEP writer), not a contract operation, so it executes through an
 * optional hosting extension (`WorkerStepExporter`) and a host without one
 * answers with the structured `step-export/unsupported` failure. The input
 * addresses solids by {@link WorkerSolidId} (the vocabulary's universal
 * solid addressing) and carries optional `unit`/`schema` strings — the
 * codec checks structure only (they are plain strings); which units and
 * schemas a kernel's writer accepts is its semantic call, returned as a
 * structured `step-export/*` kernel code. The result is the file's bytes in
 * the same strict base64 wire form as the import's input, so an
 * export→import round trip crosses the channel as plain text twice. The
 * result mints NO session solids: exported geometry stays addressed by the
 * ids the caller passed in, which the session still owns.
 *
 * ## The BREP extension pair (Phase 21.5) — the third disclosed group
 *
 * `brep.import`/`brep.export` are the STEP pair's twins over OCCT's native
 * BREP form, wired for exactly one reason — parity: the browser /io flow
 * speaks BREP through the same worker channel it speaks STEP through, so
 * the two exchange paths stay symmetric (same bytes-in-base64 wire form,
 * same provenance-marked solid refs out, same optional-extension hosting,
 * same unsupported codes when a host lacks the capability). The one
 * deliberate asymmetry is the settings field: BREP exchange has NO unit or
 * schema options (the form's native unit IS the kernel's canonical
 * millimetre, and there is no schema to select), so `brep.export`'s input
 * carries solids and nothing else. The result provenance literal is
 * `"imported-brep"` — the same data-level no-fabrication marker as the STEP
 * twin, distinguishing imported geometry from feature-built solids.
 */

import {
  type AngleValue,
  type AnyDimensionalValue,
  type BodyId,
  type LengthValue,
  type ParseFailure,
  type ParseResult,
  type SerializedDimensionalValue,
  type TopologyEntitySnapshot,
  type TopologySnapshot,
  fail,
  ok,
  parseBodyId,
  parseDimensionalValue,
  serializeDimensionalValue,
} from "@slopcad/cad-core";
import type {
  KernelBounds,
  KernelSolid,
  MirrorPlaneAxis,
  ProfilePlacementInput,
  ProfileSegmentInput,
  SheetSurfaceInput,
  Tessellation,
} from "./contract";

import { decodeBase64Strict, encodeBase64 } from "./worker-base64";
import {
  WORKER_PROTOCOL_ERROR_CODES,
  type WorkerParseError,
  workerParseError,
} from "./worker-errors";
import { type WorkerSolidId, parseWorkerSolidId } from "./worker-ids";

/**
 * The operations the worker protocol carries. Grouped by `<group>.<name>` so
 * later groups (document commands, topology queries) extend the same
 * vocabulary without renaming anything.
 */
export const WORKER_OPERATION_IDS = [
  "solid.createBox",
  "solid.createSphere",
  "solid.createCylinder",
  "solid.createCone",
  "solid.createSheet",
  "solid.extrude",
  "solid.revolve",
  "solid.sweep",
  "solid.helixSweep",
  "solid.loft",
  "solid.union",
  "solid.subtract",
  "solid.intersect",
  "solid.transform",
  "solid.bounds",
  "solid.volume",
  "solid.area",
  "solid.tessellate",
  "solid.dispose",
  "solid.fillet",
  "solid.chamfer",
  "solid.shell",
  "solid.thicken",
  "solid.mirror",
  "solid.moveFace",
  "solid.replaceFace",
  "solid.deleteFace",
  "solid.section",
  "solid.topology",
  "step.import",
  "step.export",
  "brep.import",
  "brep.export",
] as const;

/** An operation the worker protocol knows how to carry. */
export type WorkerOperationId = (typeof WORKER_OPERATION_IDS)[number];

const OPERATION_SET: ReadonlySet<string> = new Set(WORKER_OPERATION_IDS);

/** Type guard for untrusted operation names. */
export function isWorkerOperationId(
  input: unknown,
): input is WorkerOperationId {
  return typeof input === "string" && OPERATION_SET.has(input);
}

/** Input of `solid.createBox`: the box's extents along x, y, z. */
export interface WorkerBoxInput {
  readonly width: LengthValue;
  readonly depth: LengthValue;
  readonly height: LengthValue;
}

/** Input of `solid.createSphere`: the radius. */
export interface WorkerSphereInput {
  readonly radius: LengthValue;
}

/** Input of `solid.createCylinder`: the radius and height. */
export interface WorkerCylinderInput {
  readonly radius: LengthValue;
  readonly height: LengthValue;
}

/** Input of `solid.createCone`: the frustum radii and height. */
export interface WorkerConeInput {
  readonly bottomRadius: LengthValue;
  readonly topRadius: LengthValue;
  readonly height: LengthValue;
}

/**
 * Input of `solid.extrude` (Phase 26.1): the closed profile loop, the
 * strictly positive height, the direction sign along the profile plane's
 * normal, and the placement rotation+translation — the contract's
 * `ProfileExtrudeInput` carried across the wire.
 */
export interface WorkerExtrudeInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly height: LengthValue;
  readonly direction: 1 | -1;
  readonly placement: ProfilePlacementInput;
  /**
   * The optional draft taper angle (Phase 41), in any angle unit — the
   * contract's `ProfileExtrudeInput.taper` carried across the wire.
   * Whether the angle is finite, inside ±π/2, and its far inset
   * non-degenerate is the kernel contract's semantic call
   * (`kernel/invalid-taper`); the codec checks structure only.
   */
  readonly taper?: AngleValue;
  /**
   * The Phase 48 sheet flag, carried across the wire exactly when present
   * (the taper's optional-field discipline): the product is the open
   * lateral wall set, not the closed solid.
   */
  readonly sheet?: true;
}

/**
 * The revolve axis of `solid.revolve` (Phase 26.2): a line in the profile's
 * local plane — a point (local millimetres) and a direction (dimensionless).
 * Whether the direction is normalizable is the kernel contract's semantic
 * call; the codec checks structure only.
 */
export interface WorkerRevolveAxisInput {
  readonly point: readonly [number, number];
  readonly direction: readonly [number, number];
}

/**
 * Input of `solid.revolve` (Phase 26.2): the closed profile loop, the
 * in-plane axis line, the sweep angle (contract domain `(0, 2π]`), and the
 * placement rotation+translation — the contract's `ProfileRevolveInput`
 * carried across the wire.
 */
export interface WorkerRevolveInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly axis: WorkerRevolveAxisInput;
  readonly angle: AngleValue;
  readonly placement: ProfilePlacementInput;
  /** The Phase 48 sheet flag — the open surface of revolution product. */
  readonly sheet?: true;
}

/**
 * One segment of a `solid.sweep` path (the Phase 38 wire twin of the
 * contract's `SweepPathSegmentInput`): an open chain in the LOCAL XZ plane
 * as 2D `(x, z)` millimetre pairs — lines from start to end, arcs with a
 * SIGNED sweep (`endAngle − startAngle`, magnitude in `(0, 2π]`). Whether
 * the chain starts at the local origin, keeps G1 continuity, and stays
 * self-intersection-free is the kernel contract's semantic call
 * (`kernel/invalid-path`, `kernel/path-self-intersecting`); the codec
 * checks structure only.
 */
export type WorkerSweepPathSegmentInput =
  | {
      readonly kind: "line";
      readonly start: readonly [number, number];
      readonly end: readonly [number, number];
    }
  | {
      readonly kind: "arc";
      readonly center: readonly [number, number];
      readonly radius: number;
      readonly startAngle: AngleValue;
      readonly endAngle: AngleValue;
    };

/**
 * Input of `solid.sweep` (Phase 38): the closed profile loop, the open path
 * chain in the local XZ plane, and the placement rotation+translation — the
 * contract's `ProfileSweepInput` carried across the wire. Whether the
 * profile pinches through a bend is the kernel contract's semantic call
 * (`kernel/sweep-self-intersecting`); the codec checks structure only.
 */
export interface WorkerSweepInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly path: readonly WorkerSweepPathSegmentInput[];
  readonly placement: ProfilePlacementInput;
  /** The Phase 48 sheet flag — the open swept wall product. */
  readonly sheet?: true;
}

/**
 * The wire twin of the contract's `HelixSpineInput` (Phase 40): the
 * analytic helix parameters — radius, pitch (non-negative), turns,
 * handedness sign, start angle, and the optional total taper. Whether the
 * spine is degenerate is the kernel contract's semantic call
 * (`kernel/invalid-helix`); the codec checks structure only.
 */
export interface WorkerHelixSpineInput {
  readonly radius: LengthValue;
  readonly pitch: LengthValue;
  readonly turns: number;
  readonly handedness: 1 | -1;
  readonly startAngle: AngleValue;
  readonly taper?: LengthValue;
}

/**
 * Input of `solid.helixSweep` (Phase 40): the closed profile loop in the
 * START MERIDIAN (loop coordinates `(u, v) = (radial, axial)` from the
 * spine's start point), the analytic spine, and the placement — the
 * contract's `HelixSweepInput` carried across the wire. Whether the
 * profile crosses the axis is the kernel contract's semantic call
 * (`kernel/profile-axis-crossing`); the codec checks structure only.
 */
export interface WorkerHelixSweepInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly spine: WorkerHelixSpineInput;
  readonly placement: ProfilePlacementInput;
}

/**
 * One section of a `solid.loft` (Phase 38): the closed profile loop at its
 * station — the contract's `ProfileLoftSectionInput` carried across the
 * wire, the station z as a length in any unit (canonicalized to mm).
 */
export interface WorkerLoftSectionInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly z: LengthValue;
}

/**
 * Input of `solid.loft` (Phase 38): the ORDERED section list (at least two;
 * the order IS the loft direction) and the placement rotation+translation —
 * the contract's `ProfileLoftInput` carried across the wire. Whether the
 * sections carry equal chord-polygon vertex counts and strictly increasing
 * stations is the kernel contract's semantic call
 * (`kernel/loft-incompatible-profiles`, `kernel/loft-unordered-stations`);
 * the codec checks structure only.
 */
export interface WorkerLoftInput {
  readonly sections: readonly WorkerLoftSectionInput[];
  readonly placement: ProfilePlacementInput;
  /** The Phase 48 sheet flag — the open ruled-wall product. */
  readonly sheet?: true;
}

/**
 * Input of `solid.createSheet` (Phase 48): the contract's
 * `SheetSurfaceInput` carried across the wire — one of the five analytic
 * patch kinds, the placement, and the per-kind parameter ranges. Whether
 * the parameters are in-domain is the kernel contract's semantic call;
 * the codec checks structure only.
 */
export type WorkerCreateSheetInput = SheetSurfaceInput;

/** Input of `solid.union`: the operands to unite. */
export interface WorkerUnionInput {
  readonly operands: readonly WorkerSolidId[];
}

/** Input of `solid.subtract`: the target and the tools to remove from it. */
export interface WorkerSubtractInput {
  readonly target: WorkerSolidId;
  readonly tools: readonly WorkerSolidId[];
}

/** Input of `solid.intersect`: the operands to intersect. */
export interface WorkerIntersectInput {
  readonly operands: readonly WorkerSolidId[];
}

/** A translation vector of `solid.transform`. */
export interface WorkerTranslationVector {
  readonly x: LengthValue;
  readonly y: LengthValue;
  readonly z: LengthValue;
}

/**
 * A rotation of `solid.transform` (the Phase 21.2 wire twin of the
 * contract's Phase 21.1 `RotationInput`): a dimensionless direction in the
 * canonical right-handed millimetre space plus an {@link AngleValue} in any
 * angle unit. Semantic rules — the axis must be normalizable, the angle
 * finite — stay in the kernel contract; the codec checks structure only.
 */
export interface WorkerRotationInput {
  readonly axis: readonly [number, number, number];
  readonly angle: AngleValue;
}

/**
 * Input of `solid.transform`: the solid, the translation to apply, and the
 * optional rotation applied first (about the world-origin axis), exactly as
 * the contract's `TransformInput` orders the two.
 */
export interface WorkerTransformInput {
  readonly solid: WorkerSolidId;
  readonly translation: WorkerTranslationVector;
  readonly rotation?: WorkerRotationInput;
  /**
   * The optional uniform scale factor (Phase 41): a strictly positive
   * dimensionless number applied about the world origin before the
   * translation. Whether the factor is finite and positive is the kernel
   * contract's semantic call (`kernel/invalid-length`); the codec checks
   * structure only.
   */
  readonly scale?: number;
}

/**
 * Input of the single-solid operations `solid.bounds`, `solid.volume`,
 * `solid.tessellate`, and `solid.dispose`.
 */
export interface WorkerSolidRefInput {
  readonly solid: WorkerSolidId;
}

/**
 * Input of `solid.fillet` (Phase 26.5): the target solid, the edges to
 * round as the target's topology-snapshot edge ordinals (the contract's
 * `(kind: "edge", ordinal)` addresses — a caller resolves its persistent
 * edge references against the CURRENT snapshot and passes the resolved
 * ordinals), and the shared radius. Whether an ordinal names an edge, and
 * whether the radius fits, is the kernel contract's semantic call
 * (`kernel/fillet-edge-unknown`, `kernel/fillet-failed`); the codec checks
 * structure only.
 */
export interface WorkerFilletInput {
  readonly target: WorkerSolidId;
  readonly edges: readonly number[];
  readonly radius: LengthValue;
}

/**
 * Input of `solid.chamfer` (Phase 26.6): the fillet input's shape with the
 * symmetric distance in the radius's place — the target solid, the edges to
 * bevel as the target's topology-snapshot edge ordinals, and the shared
 * distance. Whether an ordinal names an edge, and whether the distance
 * fits, is the kernel contract's semantic call
 * (`kernel/chamfer-edge-unknown`, `kernel/chamfer-failed`); the codec
 * checks structure only.
 */
export interface WorkerChamferInput {
  readonly target: WorkerSolidId;
  readonly edges: readonly number[];
  readonly distance: LengthValue;
}

/**
 * Input of `solid.shell` (Phase 26.7): the target solid, the faces to
 * remove as the target's topology-snapshot FACE ordinals (the contract's
 * `(kind: "face", ordinal)` addresses — a caller resolves its persistent
 * face references against the CURRENT snapshot and passes the resolved
 * ordinals; at least one, the open hollow shell), and the uniform wall
 * thickness. Whether an ordinal names a face, and whether the thickness
 * fits, is the kernel contract's semantic call
 * (`kernel/shell-face-unknown`, `kernel/shell-failed`); the codec checks
 * structure only.
 */
export interface WorkerShellInput {
  readonly target: WorkerSolidId;
  readonly faces: readonly number[];
  readonly thickness: LengthValue;
}

/**
 * Input of `solid.mirror` (Phase 26.9): the target solid and the world
 * axis plane it reflects through — `axis` names the plane's normal axis,
 * `offset` the plane's signed position along it — the contract's
 * `MirrorInput` carried across the wire. Whether the offset magnitude is
 * finite is the kernel contract's semantic call
 * (`kernel/invalid-length`); the codec checks structure only.
 */
export interface WorkerMirrorInput {
  readonly target: WorkerSolidId;
  readonly axis: MirrorPlaneAxis;
  readonly offset: LengthValue;
}

/**
 * Input of `solid.thicken` (Phase 41): the target solid and the uniform
 * wall thickness of the CLOSED hollow — the contract's `ThickenInput`
 * carried across the wire. Whether the thickness is positive and fits
 * (the cavity must not meet itself) is the kernel contract's semantic
 * call (`kernel/invalid-length`, `kernel/thicken-failed`); the codec
 * checks structure only.
 */
export interface WorkerThickenInput {
  readonly target: WorkerSolidId;
  readonly thickness: LengthValue;
}

/**
 * Input of `solid.moveFace` (Phase 44): the target solid, the ONE face to
 * move as the target's topology-snapshot FACE ordinal, and the
 * displacement as a direction triple plus a signed distance — the
 * contract's `MoveFaceInput` carried across the wire. Whether the ordinal
 * names a face, the direction normalizes, and the move changes anything
 * is the kernel contract's semantic call
 * (`kernel/faceop-face-unknown`, `kernel/faceop-failed`); the codec
 * checks structure only.
 */
export interface WorkerMoveFaceInput {
  readonly target: WorkerSolidId;
  readonly face: number;
  readonly direction: readonly [number, number, number];
  readonly distance: LengthValue;
}

/**
 * The datum plane of `solid.replaceFace` (Phase 44) on the wire: one
 * point on the plane as canonical lengths and the plane's normal as a
 * dimensionless direction triple — the contract's
 * `ReplaceFacePlaneInput` carried across the wire.
 */
export interface WorkerReplaceFacePlaneInput {
  readonly origin: {
    readonly x: LengthValue;
    readonly y: LengthValue;
    readonly z: LengthValue;
  };
  readonly normal: readonly [number, number, number];
}

/**
 * Input of `solid.replaceFace` (Phase 44): the target solid, the ONE face
 * to replace as the target's topology-snapshot FACE ordinal, and the
 * datum plane the face is re-closed at — the contract's
 * `ReplaceFaceInput` carried across the wire. Whether the plane bounds
 * the face's region is the kernel contract's semantic call
 * (`kernel/faceop-failed`); the codec checks structure only.
 */
export interface WorkerReplaceFaceInput {
  readonly target: WorkerSolidId;
  readonly face: number;
  readonly plane: WorkerReplaceFacePlaneInput;
}

/**
 * Input of `solid.deleteFace` (Phase 44): the target solid, the ONE face
 * to delete as the target's topology-snapshot FACE ordinal, and the heal
 * flag — the contract's `DeleteFaceInput` carried across the wire. Every
 * current kernel declines the operation (the probed-out honest surface;
 * see the contract op's documentation), so the wire form exists for
 * vocabulary completeness: the structured refusal crosses back through
 * the ordinary failure path.
 */
export interface WorkerDeleteFaceInput {
  readonly target: WorkerSolidId;
  readonly face: number;
  readonly heal: boolean;
}

/**
 * Input of `solid.section` (Phase 46): the target solid, the section
 * plane's origin components and normal (the contract's `SectionInput`
 * carried across the wire), and the keep side. Whether the normal is
 * non-zero and the plane actually cuts is the kernel contract's semantic
 * call (`kernel/invalid-length`, `kernel/section-empty`); the codec
 * checks structure only.
 */
export interface WorkerSectionInput {
  readonly target: WorkerSolidId;
  readonly origin: readonly [LengthValue, LengthValue, LengthValue];
  readonly normal: readonly [number, number, number];
  readonly keepSide: 1 | -1;
}

/**
 * Input of `solid.topology` (Phase 26.5): the solid to report plus the
 * labeling context the kernel-neutral snapshot carries — the document body
 * the solid stands for and the regeneration the snapshot stands at. Both
 * are structure on the wire (a `body_…` id and a non-negative integer);
 * what the snapshot's entities mean is the Phase 22 protocol's business.
 */
export interface WorkerTopologyInput {
  readonly solid: WorkerSolidId;
  /** The labeled owning body — a parsed `body_…` id (structure only). */
  readonly bodyId: BodyId;
  readonly regeneration: number;
}

/**
 * Result of `solid.topology`: the kernel-neutral {@link TopologySnapshot}
 * verbatim — identity payloads, occurrence-collapsed ordinals, and
 * body-relative measures for every reported entity. This is the edge-
 * picking layer's data source: edge ordinals feed `solid.fillet` (and the
 * Phase 26.6 `solid.chamfer`), face ordinals feed the Phase 26.7
 * `solid.shell`, edge centroids project to the picking
 * surface.
 */
export interface WorkerTopologyResult {
  readonly snapshot: TopologySnapshot;
}

/**
 * Input of `step.import`: the raw bytes of the STEP file to import. The
 * typed form carries the bytes themselves; the serialized form is their
 * strict canonical base64 text (see `./worker-base64`). Whether the bytes
 * are a real STEP document is the importing kernel's semantic call — the
 * codec checks structure only.
 */
export interface WorkerStepImportInput {
  readonly data: Uint8Array;
}

/**
 * One imported solid of a `step.import` result: the minted session-solid id
 * plus its data-level provenance. The literal origin is the contract that
 * separates imported geometry from feature-built solids at the data level —
 * a consumer holding these refs knows the geometry has no parametric
 * history behind it, because the protocol result carries none.
 */
export interface WorkerImportedSolidRef {
  readonly solid: WorkerSolidId;
  readonly origin: "imported-step";
  /**
   * Present exactly when the ref is an OPEN SHELL (Phase 48 — the
   * `imported-step` sheet class): the STEP file carried a free-standing
   * shell, so the host's body for it is the document's sheet body kind.
   */
  readonly sheet?: true;
}

/**
 * The provenance literal of a wire imported-solid ref: the file format the
 * geometry came from. Each literal is the data-level no-fabrication marker
 * of its exchange path.
 */
export type WorkerImportedOrigin = "imported-step" | "imported-brep";

/**
 * Result of `step.import`: one provenance-marked ref per imported solid, in
 * file order. A multi-solid STEP file mints multiple session solids; the
 * geometry is canonical millimetres and pure BREP — no feature, parameter,
 * or history payload exists anywhere on the result.
 */
export interface WorkerStepImportResult {
  readonly solids: readonly WorkerImportedSolidRef[];
}

/**
 * The structured kernel-side failure of a `step.import` execution: exactly
 * the cad-core {@link ParseFailure} shape — a stable `step-import/*` cause
 * code, a message, and the rejected input retained for in-process
 * diagnostics. Only the code and message reach the wire (the server drops
 * the retained input, whose bytes the sender already holds).
 */
export type WorkerStepImportFailure = ParseFailure;

/**
 * The server's optional STEP-import extension (the Phase 21.3 vocabulary
 * extension's execution surface): turns raw STEP bytes into session solids.
 * A host whose kernel cannot import STEP omits it and answers
 * `step.import` with {@link STEP_IMPORT_UNSUPPORTED_CODE}.
 */
export type WorkerStepImporter = (
  bytes: Uint8Array,
) => ParseResult<readonly KernelSolid[], WorkerStepImportFailure>;

/**
 * The `step-import/*` failure code a server WITHOUT a STEP importer answers
 * `step.import` with (in `data.kernelCode` of the structured
 * `worker/operation-failed` response). The importing kernel's own failure
 * codes are its own registry (e.g. `STEP_IMPORT_ERROR_CODES` in the OCCT
 * package); this one belongs to the protocol, because the absence it names
 * is a hosting fact, not a parse outcome.
 */
export const STEP_IMPORT_UNSUPPORTED_CODE = "step-import/unsupported";

/**
 * The server's optional `solid.topology` execution surface (the Phase 26.5
 * vocabulary extension): one owned kernel solid plus its labeling context
 * in, the kernel-neutral {@link TopologySnapshot} out. Only hosts whose
 * kernel reports topology (the OpenCascade backend's `topologySnapshot`)
 * provide one — a server without the extension answers `solid.topology`
 * with {@link TOPOLOGY_UNSUPPORTED_CODE}. This is the edge-picking layer's
 * data source: the browser never imports kernel types, it picks from the
 * snapshot's entities and addresses `solid.fillet`/`solid.chamfer` (and
 * the Phase 26.7 `solid.shell`, by face ordinals) by the
 * same ordinals.
 */
export type WorkerTopologyReporter = (
  solid: KernelSolid,
  options: { readonly bodyId: BodyId; readonly regeneration: number },
) => ParseResult<TopologySnapshot, ParseFailure>;

/**
 * The failure code a server WITHOUT a topology reporter answers
 * `solid.topology` with — a hosting fact, like its STEP/BREP siblings.
 */
export const TOPOLOGY_UNSUPPORTED_CODE = "topology/unsupported";

/**
 * Input of `step.export`: the session solids to write into ONE STEP file,
 * plus the optional exporter settings. `unit`/`schema` are plain strings on
 * the wire — structure only; the exporting kernel validates them against
 * its writer's accepted sets and answers structured `step-export/*`
 * failures for the rest.
 */
export interface WorkerStepExportInput {
  readonly solids: readonly WorkerSolidId[];
  readonly unit?: string;
  readonly schema?: string;
}

/**
 * The exporter settings the wire carries, separated from the input's solid
 * addressing: exactly the optional `unit`/`schema` pair.
 */
export interface WorkerStepExportSettings {
  readonly unit?: string;
  readonly schema?: string;
}

/** Result of `step.export`: the STEP file's bytes. */
export interface WorkerStepExportResult {
  readonly data: Uint8Array;
}

/**
 * The server's optional STEP-export extension (the Phase 21.4 vocabulary
 * extension's execution surface): resolves to the file bytes for the given
 * owned kernel solids. A host whose kernel cannot export STEP omits it and
 * answers `step.export` with {@link STEP_EXPORT_UNSUPPORTED_CODE}.
 */
export type WorkerStepExporter = (
  solids: readonly KernelSolid[],
  settings: WorkerStepExportSettings,
) => ParseResult<Uint8Array, ParseFailure>;

/**
 * The `step-export/*` failure code a server WITHOUT a STEP exporter answers
 * `step.export` with (in `data.kernelCode` of the structured
 * `worker/operation-failed` response) — the import twin's twin: the absence
 * it names is a hosting fact, not an export outcome.
 */
export const STEP_EXPORT_UNSUPPORTED_CODE = "step-export/unsupported";

/**
 * Input of `brep.import`: the raw bytes of the OCCT BREP file to import,
 * in the same strict base64 wire form as `step.import`'s data. Whether the
 * bytes are a real BREP document is the importing kernel's semantic call —
 * the codec checks structure only.
 */
export interface WorkerBrepImportInput {
  readonly data: Uint8Array;
}

/**
 * One imported solid of a `brep.import` result: the minted session-solid id
 * plus the BREP provenance literal — the same data-level no-fabrication
 * contract as the STEP twin's ref.
 */
export interface WorkerImportedBrepSolidRef {
  readonly solid: WorkerSolidId;
  readonly origin: "imported-brep";
}

/**
 * Result of `brep.import`: one provenance-marked ref per imported solid, in
 * file order — pure geometry, no feature/parameter/history payload
 * anywhere on the result.
 */
export interface WorkerBrepImportResult {
  readonly solids: readonly WorkerImportedBrepSolidRef[];
}

/**
 * The structured kernel-side failure of a `brep.import` execution: the
 * cad-core {@link ParseFailure} shape, exactly the STEP twin's discipline.
 */
export type WorkerBrepImportFailure = ParseFailure;

/**
 * The server's optional BREP-import extension (the Phase 21.5 vocabulary
 * extension's execution surface). A host whose kernel cannot import BREP
 * omits it and answers `brep.import` with
 * {@link BREP_IMPORT_UNSUPPORTED_CODE}.
 */
export type WorkerBrepImporter = (
  bytes: Uint8Array,
) => ParseResult<readonly KernelSolid[], WorkerBrepImportFailure>;

/**
 * The `brep-import/*` failure code a server WITHOUT a BREP importer answers
 * `brep.import` with — the STEP twin's twin: the absence it names is a
 * hosting fact, not a parse outcome.
 */
export const BREP_IMPORT_UNSUPPORTED_CODE = "brep-import/unsupported";

/**
 * Input of `brep.export`: the session solids to write into ONE BREP file.
 * There are no settings fields — the BREP form has no unit or schema
 * selection (its native unit is the kernel's canonical millimetre), so the
 * solids list is the whole input.
 */
export interface WorkerBrepExportInput {
  readonly solids: readonly WorkerSolidId[];
}

/** Result of `brep.export`: the BREP file's bytes. */
export interface WorkerBrepExportResult {
  readonly data: Uint8Array;
}

/**
 * The server's optional BREP-export extension (the Phase 21.5 vocabulary
 * extension's execution surface): resolves to the file bytes for the given
 * owned kernel solids. A host whose kernel cannot export BREP omits it and
 * answers `brep.export` with {@link BREP_EXPORT_UNSUPPORTED_CODE}.
 */
export type WorkerBrepExporter = (
  solids: readonly KernelSolid[],
) => ParseResult<Uint8Array, ParseFailure>;

/**
 * The `brep-export/*` failure code a server WITHOUT a BREP exporter answers
 * `brep.export` with.
 */
export const BREP_EXPORT_UNSUPPORTED_CODE = "brep-export/unsupported";

/** Result of every solid-producing operation: the minted solid's id. */
export interface WorkerSolidResult {
  readonly solid: WorkerSolidId;
}

/** Result of `solid.bounds`: the axis-aligned bounding box in mm. */
export interface WorkerBoundsResult {
  readonly bounds: KernelBounds;
}

/** Result of `solid.volume`: the volume in mm³ (0 for an empty solid). */
export interface WorkerVolumeResult {
  readonly volume: number;
}

/**
 * Result of `solid.section`: the cut solid's worker id plus the
 * cross-section face's measurements (mm² area, mm centroid) — raw
 * canonical-unit numbers, the volume/area precedent.
 */
export interface WorkerSectionResult {
  readonly solid: WorkerSolidId;
  readonly section: {
    readonly areaMm2: number;
    readonly centroidMm: readonly [number, number, number];
  };
}

/**
 * Result of `solid.area` (Phase 27.4): the whole-solid surface area in
 * mm² (0 for an empty solid), measured with the booted kernel's own
 * semantics (see the contract's `area` documentation).
 */
export interface WorkerAreaResult {
  readonly area: number;
}

/** Result of `solid.tessellate`: the indexed triangle soup in mm. */
export interface WorkerTessellationResult {
  readonly tessellation: Tessellation;
}

/** Result of `solid.dispose`: nothing (`null` on the wire). */
export type WorkerDisposeResult = null;

/** The typed input of each operation. */
export interface WorkerOperationInputs {
  readonly "solid.createBox": WorkerBoxInput;
  readonly "solid.createSphere": WorkerSphereInput;
  readonly "solid.createCylinder": WorkerCylinderInput;
  readonly "solid.createCone": WorkerConeInput;
  readonly "solid.createSheet": WorkerCreateSheetInput;
  readonly "solid.extrude": WorkerExtrudeInput;
  readonly "solid.revolve": WorkerRevolveInput;
  readonly "solid.sweep": WorkerSweepInput;
  readonly "solid.helixSweep": WorkerHelixSweepInput;
  readonly "solid.loft": WorkerLoftInput;
  readonly "solid.union": WorkerUnionInput;
  readonly "solid.subtract": WorkerSubtractInput;
  readonly "solid.intersect": WorkerIntersectInput;
  readonly "solid.transform": WorkerTransformInput;
  readonly "solid.bounds": WorkerSolidRefInput;
  readonly "solid.volume": WorkerSolidRefInput;
  readonly "solid.area": WorkerSolidRefInput;
  readonly "solid.tessellate": WorkerSolidRefInput;
  readonly "solid.dispose": WorkerSolidRefInput;
  readonly "solid.fillet": WorkerFilletInput;
  readonly "solid.chamfer": WorkerChamferInput;
  readonly "solid.shell": WorkerShellInput;
  readonly "solid.thicken": WorkerThickenInput;
  readonly "solid.mirror": WorkerMirrorInput;
  readonly "solid.moveFace": WorkerMoveFaceInput;
  readonly "solid.replaceFace": WorkerReplaceFaceInput;
  readonly "solid.deleteFace": WorkerDeleteFaceInput;
  readonly "solid.section": WorkerSectionInput;
  readonly "solid.topology": WorkerTopologyInput;
  readonly "step.import": WorkerStepImportInput;
  readonly "step.export": WorkerStepExportInput;
  readonly "brep.import": WorkerBrepImportInput;
  readonly "brep.export": WorkerBrepExportInput;
}

/** The typed input of an operation, keyed by operation id. */
export type WorkerOperationInput<
  O extends WorkerOperationId = WorkerOperationId,
> = WorkerOperationInputs[O];

/** The typed result of each operation. */
export interface WorkerOperationResults {
  readonly "solid.createBox": WorkerSolidResult;
  readonly "solid.createSphere": WorkerSolidResult;
  readonly "solid.createCylinder": WorkerSolidResult;
  readonly "solid.createCone": WorkerSolidResult;
  readonly "solid.createSheet": WorkerSolidResult;
  readonly "solid.extrude": WorkerSolidResult;
  readonly "solid.revolve": WorkerSolidResult;
  readonly "solid.sweep": WorkerSolidResult;
  readonly "solid.helixSweep": WorkerSolidResult;
  readonly "solid.loft": WorkerSolidResult;
  readonly "solid.union": WorkerSolidResult;
  readonly "solid.subtract": WorkerSolidResult;
  readonly "solid.intersect": WorkerSolidResult;
  readonly "solid.transform": WorkerSolidResult;
  readonly "solid.bounds": WorkerBoundsResult;
  readonly "solid.volume": WorkerVolumeResult;
  readonly "solid.area": WorkerAreaResult;
  readonly "solid.tessellate": WorkerTessellationResult;
  readonly "solid.dispose": WorkerDisposeResult;
  readonly "solid.fillet": WorkerSolidResult;
  readonly "solid.chamfer": WorkerSolidResult;
  readonly "solid.shell": WorkerSolidResult;
  readonly "solid.thicken": WorkerSolidResult;
  readonly "solid.mirror": WorkerSolidResult;
  readonly "solid.moveFace": WorkerSolidResult;
  readonly "solid.replaceFace": WorkerSolidResult;
  readonly "solid.deleteFace": WorkerSolidResult;
  readonly "solid.section": WorkerSectionResult;
  readonly "solid.topology": WorkerTopologyResult;
  readonly "step.import": WorkerStepImportResult;
  readonly "step.export": WorkerStepExportResult;
  readonly "brep.import": WorkerBrepImportResult;
  readonly "brep.export": WorkerBrepExportResult;
}

/** The typed result of an operation, keyed by operation id. */
export type WorkerOperationResult<
  O extends WorkerOperationId = WorkerOperationId,
> = WorkerOperationResults[O];

/** Serialized lengths are cad-core dimensional values in canonical mm. */
export type SerializedWorkerLength = SerializedDimensionalValue;

/** Serialized angles are cad-core dimensional values in canonical radians. */
export type SerializedWorkerAngle = SerializedDimensionalValue;

/** The canonical wire form of a profile placement (rotation, then translation). */
export interface SerializedProfilePlacement {
  readonly rotation: {
    readonly axis: readonly [number, number, number];
    readonly angle: SerializedWorkerAngle;
  };
  readonly translation: {
    readonly x: SerializedWorkerLength;
    readonly y: SerializedWorkerLength;
    readonly z: SerializedWorkerLength;
  };
}

/** The canonical wire form of one `solid.sweep` path segment. */
export type SerializedWorkerSweepPathSegment =
  | {
      readonly kind: "line";
      readonly start: readonly [number, number];
      readonly end: readonly [number, number];
    }
  | {
      readonly kind: "arc";
      readonly center: readonly [number, number];
      readonly radius: number;
      readonly startAngle: SerializedWorkerAngle;
      readonly endAngle: SerializedWorkerAngle;
    };

/**
 * The canonical JSON input form of each operation, in a fixed key order.
 * Lengths are canonical (`mm`); solids are referenced by their `wsol_` ids.
 */
export interface SerializedWorkerOperationInputs {
  readonly "solid.createBox": {
    readonly width: SerializedWorkerLength;
    readonly depth: SerializedWorkerLength;
    readonly height: SerializedWorkerLength;
  };
  readonly "solid.createSphere": {
    readonly radius: SerializedWorkerLength;
  };
  readonly "solid.createCylinder": {
    readonly radius: SerializedWorkerLength;
    readonly height: SerializedWorkerLength;
  };
  readonly "solid.createCone": {
    readonly bottomRadius: SerializedWorkerLength;
    readonly topRadius: SerializedWorkerLength;
    readonly height: SerializedWorkerLength;
  };
  readonly "solid.extrude": {
    readonly loop: readonly SerializedProfileSegment[];
    readonly height: SerializedWorkerLength;
    readonly direction: 1 | -1;
    readonly placement: {
      readonly rotation: {
        readonly axis: readonly [number, number, number];
        readonly angle: SerializedWorkerAngle;
      };
      readonly translation: {
        readonly x: SerializedWorkerLength;
        readonly y: SerializedWorkerLength;
        readonly z: SerializedWorkerLength;
      };
    };
    readonly taper?: SerializedWorkerAngle;
    /** The Phase 48 sheet flag — present exactly when the input carried it. */
    readonly sheet?: true;
  };
  readonly "solid.revolve": {
    readonly loop: readonly SerializedProfileSegment[];
    readonly axis: {
      readonly point: readonly [number, number];
      readonly direction: readonly [number, number];
    };
    readonly angle: SerializedWorkerAngle;
    readonly placement: SerializedProfilePlacement;
    /** The Phase 48 sheet flag — present exactly when the input carried it. */
    readonly sheet?: true;
  };
  readonly "solid.sweep": {
    readonly loop: readonly SerializedProfileSegment[];
    readonly path: readonly SerializedWorkerSweepPathSegment[];
    readonly placement: SerializedProfilePlacement;
    /** The Phase 48 sheet flag — present exactly when the input carried it. */
    readonly sheet?: true;
  };
  readonly "solid.helixSweep": {
    readonly loop: readonly SerializedProfileSegment[];
    readonly spine: {
      readonly radius: SerializedWorkerLength;
      readonly pitch: SerializedWorkerLength;
      readonly turns: number;
      readonly handedness: 1 | -1;
      readonly startAngle: SerializedWorkerAngle;
      readonly taper?: SerializedWorkerLength;
    };
    readonly placement: SerializedProfilePlacement;
  };
  readonly "solid.loft": {
    readonly sections: readonly {
      readonly loop: readonly SerializedProfileSegment[];
      readonly z: SerializedWorkerLength;
    }[];
    readonly placement: SerializedProfilePlacement;
    /** The Phase 48 sheet flag — present exactly when the input carried it. */
    readonly sheet?: true;
  };
  readonly "solid.createSheet": {
    readonly kind: "plane" | "cylinder" | "cone" | "sphere" | "torus";
    readonly placement: SerializedProfilePlacement;
    readonly uMin?: SerializedWorkerLength;
    readonly uMax?: SerializedWorkerLength;
    readonly vMin?: SerializedWorkerLength;
    readonly vMax?: SerializedWorkerLength;
    readonly radius?: SerializedWorkerLength;
    readonly height?: SerializedWorkerLength;
    readonly uSweep?: SerializedWorkerAngle;
    readonly bottomRadius?: SerializedWorkerLength;
    readonly topRadius?: SerializedWorkerLength;
    readonly majorRadius?: SerializedWorkerLength;
    readonly minorRadius?: SerializedWorkerLength;
    readonly vSweep?: SerializedWorkerAngle;
  };
  readonly "solid.union": {
    readonly operands: readonly string[];
  };
  readonly "solid.subtract": {
    readonly target: string;
    readonly tools: readonly string[];
  };
  readonly "solid.intersect": {
    readonly operands: readonly string[];
  };
  readonly "solid.transform": {
    readonly solid: string;
    readonly translation: {
      readonly x: SerializedWorkerLength;
      readonly y: SerializedWorkerLength;
      readonly z: SerializedWorkerLength;
    };
    /**
     * The optional rotation, present exactly when the typed input carried
     * one (see the module doc's rotation-extension section). Axis first,
     * canonical-radian angle second.
     */
    readonly rotation?: {
      readonly axis: readonly [number, number, number];
      readonly angle: SerializedWorkerAngle;
    };
    /** The optional uniform scale factor (Phase 41), last in key order. */
    readonly scale?: number;
  };
  readonly "solid.bounds": {
    readonly solid: string;
  };
  readonly "solid.volume": {
    readonly solid: string;
  };
  readonly "solid.area": {
    readonly solid: string;
  };
  readonly "solid.tessellate": {
    readonly solid: string;
  };
  readonly "solid.dispose": {
    readonly solid: string;
  };
  readonly "solid.fillet": {
    readonly target: string;
    readonly edges: readonly number[];
    readonly radius: SerializedWorkerLength;
  };
  readonly "solid.chamfer": {
    readonly target: string;
    readonly edges: readonly number[];
    readonly distance: SerializedWorkerLength;
  };
  readonly "solid.shell": {
    readonly target: string;
    readonly faces: readonly number[];
    readonly thickness: SerializedWorkerLength;
  };
  readonly "solid.thicken": {
    readonly target: string;
    readonly thickness: SerializedWorkerLength;
  };
  readonly "solid.mirror": {
    readonly target: string;
    readonly axis: MirrorPlaneAxis;
    readonly offset: SerializedWorkerLength;
  };
  readonly "solid.moveFace": {
    readonly target: string;
    readonly face: number;
    readonly direction: readonly [number, number, number];
    readonly distance: SerializedWorkerLength;
  };
  readonly "solid.replaceFace": {
    readonly target: string;
    readonly face: number;
    readonly plane: {
      readonly origin: {
        readonly x: SerializedWorkerLength;
        readonly y: SerializedWorkerLength;
        readonly z: SerializedWorkerLength;
      };
      readonly normal: readonly [number, number, number];
    };
  };
  readonly "solid.deleteFace": {
    readonly target: string;
    readonly face: number;
    readonly heal: boolean;
  };
  readonly "solid.section": {
    readonly target: string;
    readonly origin: readonly [
      SerializedWorkerLength,
      SerializedWorkerLength,
      SerializedWorkerLength,
    ];
    readonly normal: readonly [number, number, number];
    readonly keepSide: 1 | -1;
  };
  readonly "solid.topology": {
    readonly solid: string;
    readonly bodyId: string;
    readonly regeneration: number;
  };
  readonly "step.import": {
    readonly data: string;
  };
  readonly "step.export": {
    readonly solids: readonly string[];
    readonly unit?: string;
    readonly schema?: string;
  };
  readonly "brep.import": {
    readonly data: string;
  };
  readonly "brep.export": {
    readonly solids: readonly string[];
  };
}

/** The canonical JSON input form of an operation, keyed by operation id. */
export type SerializedWorkerOperationInput<
  O extends WorkerOperationId = WorkerOperationId,
> = SerializedWorkerOperationInputs[O];

/** The canonical JSON result form of each operation. */
export interface SerializedWorkerOperationResults {
  readonly "solid.createBox": {
    readonly solid: string;
  };
  readonly "solid.createSphere": {
    readonly solid: string;
  };
  readonly "solid.createCylinder": {
    readonly solid: string;
  };
  readonly "solid.createCone": {
    readonly solid: string;
  };
  readonly "solid.createSheet": {
    readonly solid: string;
  };
  readonly "solid.extrude": {
    readonly solid: string;
  };
  readonly "solid.revolve": {
    readonly solid: string;
  };
  readonly "solid.sweep": {
    readonly solid: string;
  };
  readonly "solid.helixSweep": {
    readonly solid: string;
  };
  readonly "solid.loft": {
    readonly solid: string;
  };
  readonly "solid.union": {
    readonly solid: string;
  };
  readonly "solid.subtract": {
    readonly solid: string;
  };
  readonly "solid.intersect": {
    readonly solid: string;
  };
  readonly "solid.transform": {
    readonly solid: string;
  };
  readonly "solid.bounds": {
    readonly bounds: {
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    };
  };
  readonly "solid.volume": {
    readonly volume: number;
  };
  readonly "solid.area": {
    readonly area: number;
  };
  readonly "solid.tessellate": {
    readonly tessellation: {
      readonly positions: readonly number[];
      readonly indices: readonly number[];
      readonly normals?: readonly number[];
    };
  };
  readonly "solid.dispose": null;
  readonly "solid.fillet": {
    readonly solid: string;
  };
  readonly "solid.chamfer": {
    readonly solid: string;
  };
  readonly "solid.shell": {
    readonly solid: string;
  };
  readonly "solid.thicken": {
    readonly solid: string;
  };
  readonly "solid.mirror": {
    readonly solid: string;
  };
  readonly "solid.moveFace": {
    readonly solid: string;
  };
  readonly "solid.replaceFace": {
    readonly solid: string;
  };
  readonly "solid.deleteFace": {
    readonly solid: string;
  };
  readonly "solid.section": {
    readonly solid: string;
    readonly section: {
      readonly areaMm2: number;
      readonly centroidMm: readonly [number, number, number];
    };
  };
  /**
   * The snapshot is already plain kernel-neutral data (the Phase 22
   * protocol's serializable evidence), so its wire form is the type itself:
   * fixed key order comes from the producer, and the result parser
   * re-validates the structure at the trust boundary.
   */
  readonly "solid.topology": TopologySnapshot;
  readonly "step.import": {
    readonly solids: readonly {
      readonly solid: string;
      readonly origin: "imported-step";
    }[];
  };
  readonly "step.export": {
    readonly data: string;
  };
  readonly "brep.import": {
    readonly solids: readonly {
      readonly solid: string;
      readonly origin: "imported-brep";
    }[];
  };
  readonly "brep.export": {
    readonly data: string;
  };
}

/** The canonical JSON result form of an operation, keyed by operation id. */
export type SerializedWorkerOperationResult<
  O extends WorkerOperationId = WorkerOperationId,
> = SerializedWorkerOperationResults[O];

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

function payloadError(
  message: string,
  input: unknown,
): ParseResult<never, WorkerParseError> {
  return fail(
    workerParseError(
      WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
      message,
      input,
    ),
  );
}

function requirePayloadRecord(
  operation: WorkerOperationId,
  input: unknown,
): ParseResult<Record<string, unknown>, WorkerParseError> {
  if (!isPlainRecord(input)) {
    return payloadError(
      `The payload of "${operation}" must be a plain object.`,
      input,
    );
  }
  return ok(input);
}

/** Type guard narrowing a parsed dimensional value to a length. */
function isLengthValue(value: AnyDimensionalValue): value is LengthValue {
  return value.dimension === "length";
}

/** Type guard narrowing a parsed dimensional value to an angle. */
function isAngleValue(value: AnyDimensionalValue): value is AngleValue {
  return value.dimension === "angle";
}

function requireLengthField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<LengthValue, WorkerParseError> {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok) {
    return payloadError(
      `The "${operation}" field "${field}" must be a serialized length value: ${parsed.error.message}`,
      input,
    );
  }
  if (!isLengthValue(parsed.value)) {
    return payloadError(
      `The "${operation}" field "${field}" must be a length; it is a ${parsed.value.dimension}.`,
      input,
    );
  }
  return ok(parsed.value);
}

function requireAngleField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<AngleValue, WorkerParseError> {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok) {
    return payloadError(
      `The "${operation}" field "${field}" must be a serialized angle value: ${parsed.error.message}`,
      input,
    );
  }
  if (!isAngleValue(parsed.value)) {
    return payloadError(
      `The "${operation}" field "${field}" must be an angle; it is a ${parsed.value.dimension}.`,
      input,
    );
  }
  return ok(parsed.value);
}

/**
 * Parses a rotation axis: exactly three finite numbers. Structure only —
 * whether the vector is non-zero and normalizable is the kernel contract's
 * semantic call (`kernel/invalid-rotation`), not the protocol's.
 */
function requireAxisField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<readonly [number, number, number], WorkerParseError> {
  if (!Array.isArray(input) || input.length !== 3) {
    return payloadError(
      `The "${operation}" field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  const entries: readonly unknown[] = input;
  const values: number[] = [];
  for (const entry of entries) {
    if (!isFiniteNumber(entry)) {
      return payloadError(
        `The "${operation}" field "${field}" must be an array of exactly three finite numbers.`,
        input,
      );
    }
    values.push(entry);
  }
  const [x, y, z] = values;
  if (x === undefined || y === undefined || z === undefined) {
    return payloadError(
      `The "${operation}" field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  return ok([x, y, z]);
}

function requireSolidIdField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<WorkerSolidId, WorkerParseError> {
  const parsed = parseWorkerSolidId(input);
  if (!parsed.ok) {
    return payloadError(
      `The "${operation}" field "${field}" must be a worker solid id: ${parsed.error.message}`,
      input,
    );
  }
  return ok(parsed.value);
}

function requireSolidIdArrayField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<readonly WorkerSolidId[], WorkerParseError> {
  if (!Array.isArray(input)) {
    return payloadError(
      `The "${operation}" field "${field}" must be an array of worker solid ids.`,
      input,
    );
  }
  const solids: WorkerSolidId[] = [];
  for (const entry of input) {
    const parsed = requireSolidIdField(operation, field, entry);
    if (!parsed.ok) return parsed;
    solids.push(parsed.value);
  }
  return ok(solids);
}

/**
 * The canonical JSON form of a profile segment (fixed key order by kind).
 * Angles serialize as canonical radians through the shared dimensional
 * serializer, exactly like every other angle on the wire.
 */
export type SerializedProfileSegment =
  | {
      readonly kind: "line";
      readonly start: readonly [number, number];
      readonly end: readonly [number, number];
    }
  | {
      readonly kind: "arc";
      readonly center: readonly [number, number];
      readonly radius: number;
      readonly startAngle: SerializedWorkerAngle;
      readonly endAngle: SerializedWorkerAngle;
    }
  | {
      readonly kind: "circle";
      readonly center: readonly [number, number];
      readonly radius: number;
    }
  | {
      readonly kind: "ellipse";
      readonly center: readonly [number, number];
      readonly radiusX: number;
      readonly radiusY: number;
      readonly rotation: SerializedDimensionalValue;
    }
  | {
      readonly kind: "ellipticalArc";
      readonly center: readonly [number, number];
      readonly radiusX: number;
      readonly radiusY: number;
      readonly rotation: SerializedDimensionalValue;
      readonly startAngle: SerializedDimensionalValue;
      readonly endAngle: SerializedDimensionalValue;
    }
  | {
      readonly kind: "spline";
      readonly flavor: "control" | "interpolated";
      readonly points: readonly (readonly [number, number])[];
    };

/** Serializes one profile segment to its canonical wire form. */
function serializeProfileSegment(
  segment: ProfileSegmentInput,
): SerializedProfileSegment {
  if (segment.kind === "line") {
    return {
      kind: "line",
      start: [...segment.start],
      end: [...segment.end],
    };
  }
  if (segment.kind === "arc") {
    return {
      kind: "arc",
      center: [...segment.center],
      radius: segment.radius,
      startAngle: serializeDimensionalValue(segment.startAngle),
      endAngle: serializeDimensionalValue(segment.endAngle),
    };
  }
  if (segment.kind === "ellipse") {
    return {
      kind: "ellipse",
      center: [...segment.center],
      radiusX: segment.radiusX,
      radiusY: segment.radiusY,
      rotation: serializeDimensionalValue(segment.rotation),
    };
  }
  if (segment.kind === "ellipticalArc") {
    return {
      kind: "ellipticalArc",
      center: [...segment.center],
      radiusX: segment.radiusX,
      radiusY: segment.radiusY,
      rotation: serializeDimensionalValue(segment.rotation),
      startAngle: serializeDimensionalValue(segment.startAngle),
      endAngle: serializeDimensionalValue(segment.endAngle),
    };
  }
  if (segment.kind === "spline") {
    return {
      kind: "spline",
      flavor: segment.flavor,
      points: segment.points.map((point) => [...point]),
    };
  }
  return {
    kind: "circle",
    center: [...segment.center],
    radius: segment.radius,
  };
}

function parseProfilePoint2(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<readonly [number, number], WorkerParseError> {
  const values = finiteNumberArray(input);
  if (values === undefined || values.length !== 2) {
    return payloadError(
      `The "${operation}" field "${field}" must be an array of exactly two finite numbers.`,
      input,
    );
  }
  const x = values[0];
  const y = values[1];
  if (x === undefined || y === undefined) {
    return payloadError(
      `The "${operation}" field "${field}" must be an array of exactly two finite numbers.`,
      input,
    );
  }
  return ok([x, y]);
}

/** Parses one profile segment from untrusted wire input. */
function parseProfileSegment(
  operation: WorkerOperationId,
  input: unknown,
): ParseResult<ProfileSegmentInput, WorkerParseError> {
  if (!isPlainRecord(input)) {
    return payloadError(
      `The "${operation}" profile segment must be a plain object.`,
      input,
    );
  }
  if (input.kind === "line") {
    const start = parseProfilePoint2(operation, "line.start", input.start);
    if (!start.ok) return start;
    const end = parseProfilePoint2(operation, "line.end", input.end);
    if (!end.ok) return end;
    return ok({ kind: "line", start: start.value, end: end.value });
  }
  if (input.kind === "arc" || input.kind === "circle") {
    const center = parseProfilePoint2(
      operation,
      `${input.kind}.center`,
      input.center,
    );
    if (!center.ok) return center;
    const radius = input.radius;
    if (!isFiniteNumber(radius) || radius <= 0) {
      return payloadError(
        `The "${operation}" ${input.kind} radius must be a positive finite number.`,
        radius,
      );
    }
    if (input.kind === "circle") {
      return ok({ kind: "circle", center: center.value, radius });
    }
    const startAngle = requireAngleField(
      operation,
      "arc.startAngle",
      input.startAngle,
    );
    if (!startAngle.ok) return startAngle;
    const endAngle = requireAngleField(
      operation,
      "arc.endAngle",
      input.endAngle,
    );
    if (!endAngle.ok) return endAngle;
    return ok({
      kind: "arc",
      center: center.value,
      radius,
      startAngle: startAngle.value,
      endAngle: endAngle.value,
    });
  }
  if (input.kind === "ellipse" || input.kind === "ellipticalArc") {
    const center = parseProfilePoint2(
      operation,
      `${input.kind}.center`,
      input.center,
    );
    if (!center.ok) return center;
    const radiusX = input.radiusX;
    if (!isFiniteNumber(radiusX) || radiusX <= 0) {
      return payloadError(
        `The "${operation}" ${input.kind} radiusX must be a positive finite number.`,
        radiusX,
      );
    }
    const radiusY = input.radiusY;
    if (!isFiniteNumber(radiusY) || radiusY <= 0) {
      return payloadError(
        `The "${operation}" ${input.kind} radiusY must be a positive finite number.`,
        radiusY,
      );
    }
    const rotation = requireAngleField(
      operation,
      `${input.kind}.rotation`,
      input.rotation,
    );
    if (!rotation.ok) return rotation;
    if (input.kind === "ellipse") {
      return ok({
        kind: "ellipse",
        center: center.value,
        radiusX,
        radiusY,
        rotation: rotation.value,
      });
    }
    const startAngle = requireAngleField(
      operation,
      "ellipticalArc.startAngle",
      input.startAngle,
    );
    if (!startAngle.ok) return startAngle;
    const endAngle = requireAngleField(
      operation,
      "ellipticalArc.endAngle",
      input.endAngle,
    );
    if (!endAngle.ok) return endAngle;
    return ok({
      kind: "ellipticalArc",
      center: center.value,
      radiusX,
      radiusY,
      rotation: rotation.value,
      startAngle: startAngle.value,
      endAngle: endAngle.value,
    });
  }
  if (input.kind === "spline") {
    if (input.flavor !== "control" && input.flavor !== "interpolated") {
      return payloadError(
        `The "${operation}" spline flavor must be "control" or "interpolated".`,
        input.flavor,
      );
    }
    if (!Array.isArray(input.points) || input.points.length < 2) {
      return payloadError(
        `The "${operation}" spline points must be an array of at least two [x, y] pairs.`,
        input.points,
      );
    }
    const points: (readonly [number, number])[] = [];
    for (const entry of input.points) {
      const point = parseProfilePoint2(operation, "spline.points", entry);
      if (!point.ok) return point;
      points.push(point.value);
    }
    return ok({ kind: "spline", flavor: input.flavor, points });
  }
  return payloadError(
    `The "${operation}" profile segment kind must be "line", "arc", "circle", "ellipse", "ellipticalArc", or "spline".`,
    input.kind,
  );
}

function parseProfileLoop(
  operation: WorkerOperationId,
  input: unknown,
): ParseResult<readonly ProfileSegmentInput[], WorkerParseError> {
  if (!Array.isArray(input) || input.length === 0) {
    return payloadError(
      `The "${operation}" field "loop" must be a non-empty array of profile segments.`,
      input,
    );
  }
  const segments: ProfileSegmentInput[] = [];
  for (const entry of input) {
    const parsed = parseProfileSegment(operation, entry);
    if (!parsed.ok) return parsed;
    segments.push(parsed.value);
  }
  return ok(segments);
}

// ---------------------------------------------------------------------------
// Per-operation input codecs
// ---------------------------------------------------------------------------

function serializeBoxInput(
  input: WorkerBoxInput,
): SerializedWorkerOperationInput<"solid.createBox"> {
  return {
    width: serializeDimensionalValue(input.width),
    depth: serializeDimensionalValue(input.depth),
    height: serializeDimensionalValue(input.height),
  };
}

function parseBoxInput(
  payload: unknown,
): ParseResult<WorkerBoxInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createBox", payload);
  if (!record.ok) return record;
  const width = requireLengthField(
    "solid.createBox",
    "width",
    record.value.width,
  );
  if (!width.ok) return width;
  const depth = requireLengthField(
    "solid.createBox",
    "depth",
    record.value.depth,
  );
  if (!depth.ok) return depth;
  const height = requireLengthField(
    "solid.createBox",
    "height",
    record.value.height,
  );
  if (!height.ok) return height;
  return ok({ width: width.value, depth: depth.value, height: height.value });
}

function serializeSphereInput(
  input: WorkerSphereInput,
): SerializedWorkerOperationInput<"solid.createSphere"> {
  return { radius: serializeDimensionalValue(input.radius) };
}

function parseSphereInput(
  payload: unknown,
): ParseResult<WorkerSphereInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createSphere", payload);
  if (!record.ok) return record;
  const radius = requireLengthField(
    "solid.createSphere",
    "radius",
    record.value.radius,
  );
  if (!radius.ok) return radius;
  return ok({ radius: radius.value });
}

function serializeCylinderInput(
  input: WorkerCylinderInput,
): SerializedWorkerOperationInput<"solid.createCylinder"> {
  return {
    radius: serializeDimensionalValue(input.radius),
    height: serializeDimensionalValue(input.height),
  };
}

function parseCylinderInput(
  payload: unknown,
): ParseResult<WorkerCylinderInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createCylinder", payload);
  if (!record.ok) return record;
  const radius = requireLengthField(
    "solid.createCylinder",
    "radius",
    record.value.radius,
  );
  if (!radius.ok) return radius;
  const height = requireLengthField(
    "solid.createCylinder",
    "height",
    record.value.height,
  );
  if (!height.ok) return height;
  return ok({ radius: radius.value, height: height.value });
}

function serializeConeInput(
  input: WorkerConeInput,
): SerializedWorkerOperationInput<"solid.createCone"> {
  return {
    bottomRadius: serializeDimensionalValue(input.bottomRadius),
    topRadius: serializeDimensionalValue(input.topRadius),
    height: serializeDimensionalValue(input.height),
  };
}

function parseConeInput(
  payload: unknown,
): ParseResult<WorkerConeInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createCone", payload);
  if (!record.ok) return record;
  const bottomRadius = requireLengthField(
    "solid.createCone",
    "bottomRadius",
    record.value.bottomRadius,
  );
  if (!bottomRadius.ok) return bottomRadius;
  const topRadius = requireLengthField(
    "solid.createCone",
    "topRadius",
    record.value.topRadius,
  );
  if (!topRadius.ok) return topRadius;
  const height = requireLengthField(
    "solid.createCone",
    "height",
    record.value.height,
  );
  if (!height.ok) return height;
  return ok({
    bottomRadius: bottomRadius.value,
    topRadius: topRadius.value,
    height: height.value,
  });
}

function serializeCreateSheetInput(
  input: WorkerCreateSheetInput,
): SerializedWorkerOperationInput<"solid.createSheet"> {
  const placement = serializeProfilePlacement(input.placement);
  switch (input.kind) {
    case "plane":
      return {
        kind: "plane",
        placement,
        uMin: serializeDimensionalValue(input.uMin),
        uMax: serializeDimensionalValue(input.uMax),
        vMin: serializeDimensionalValue(input.vMin),
        vMax: serializeDimensionalValue(input.vMax),
      };
    case "cylinder":
      return {
        kind: "cylinder",
        placement,
        radius: serializeDimensionalValue(input.radius),
        height: serializeDimensionalValue(input.height),
        uSweep: serializeDimensionalValue(input.uSweep),
      };
    case "cone":
      return {
        kind: "cone",
        placement,
        bottomRadius: serializeDimensionalValue(input.bottomRadius),
        topRadius: serializeDimensionalValue(input.topRadius),
        height: serializeDimensionalValue(input.height),
        uSweep: serializeDimensionalValue(input.uSweep),
      };
    case "sphere":
      return {
        kind: "sphere",
        placement,
        radius: serializeDimensionalValue(input.radius),
        vMin: serializeDimensionalValue(input.vMin),
        vMax: serializeDimensionalValue(input.vMax),
        uSweep: serializeDimensionalValue(input.uSweep),
      };
    case "torus":
      return {
        kind: "torus",
        placement,
        majorRadius: serializeDimensionalValue(input.majorRadius),
        minorRadius: serializeDimensionalValue(input.minorRadius),
        uSweep: serializeDimensionalValue(input.uSweep),
        vSweep: serializeDimensionalValue(input.vSweep),
      };
  }
}

function parseCreateSheetInput(
  payload: unknown,
): ParseResult<WorkerCreateSheetInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createSheet", payload);
  if (!record.ok) return record;
  const placement = parseProfilePlacement(
    "solid.createSheet",
    record.value.placement,
  );
  if (!placement.ok) return placement;
  const lengthField = (name: string) =>
    requireLengthField("solid.createSheet", name, record.value[name]);
  const angleField = (name: string) =>
    requireAngleField("solid.createSheet", name, record.value[name]);
  switch (record.value.kind) {
    case "plane": {
      const uMin = lengthField("uMin");
      if (!uMin.ok) return uMin;
      const uMax = lengthField("uMax");
      if (!uMax.ok) return uMax;
      const vMin = lengthField("vMin");
      if (!vMin.ok) return vMin;
      const vMax = lengthField("vMax");
      if (!vMax.ok) return vMax;
      return ok({
        kind: "plane",
        placement: placement.value,
        uMin: uMin.value,
        uMax: uMax.value,
        vMin: vMin.value,
        vMax: vMax.value,
      });
    }
    case "cylinder": {
      const radius = lengthField("radius");
      if (!radius.ok) return radius;
      const height = lengthField("height");
      if (!height.ok) return height;
      const uSweep = angleField("uSweep");
      if (!uSweep.ok) return uSweep;
      return ok({
        kind: "cylinder",
        placement: placement.value,
        radius: radius.value,
        height: height.value,
        uSweep: uSweep.value,
      });
    }
    case "cone": {
      const bottomRadius = lengthField("bottomRadius");
      if (!bottomRadius.ok) return bottomRadius;
      const topRadius = lengthField("topRadius");
      if (!topRadius.ok) return topRadius;
      const height = lengthField("height");
      if (!height.ok) return height;
      const uSweep = angleField("uSweep");
      if (!uSweep.ok) return uSweep;
      return ok({
        kind: "cone",
        placement: placement.value,
        bottomRadius: bottomRadius.value,
        topRadius: topRadius.value,
        height: height.value,
        uSweep: uSweep.value,
      });
    }
    case "sphere": {
      const radius = lengthField("radius");
      if (!radius.ok) return radius;
      const vMin = angleField("vMin");
      if (!vMin.ok) return vMin;
      const vMax = angleField("vMax");
      if (!vMax.ok) return vMax;
      const uSweep = angleField("uSweep");
      if (!uSweep.ok) return uSweep;
      return ok({
        kind: "sphere",
        placement: placement.value,
        radius: radius.value,
        vMin: vMin.value,
        vMax: vMax.value,
        uSweep: uSweep.value,
      });
    }
    case "torus": {
      const majorRadius = lengthField("majorRadius");
      if (!majorRadius.ok) return majorRadius;
      const minorRadius = lengthField("minorRadius");
      if (!minorRadius.ok) return minorRadius;
      const uSweep = angleField("uSweep");
      if (!uSweep.ok) return uSweep;
      const vSweep = angleField("vSweep");
      if (!vSweep.ok) return vSweep;
      return ok({
        kind: "torus",
        placement: placement.value,
        majorRadius: majorRadius.value,
        minorRadius: minorRadius.value,
        uSweep: uSweep.value,
        vSweep: vSweep.value,
      });
    }
    default:
      return payloadError(
        'The "solid.createSheet" field "kind" must be one of plane, cylinder, cone, sphere, torus.',
        record.value.kind,
      );
  }
}

/**
 * Wraps a profile-op input parser with the Phase 48 sheet flag's wire
 * read: a strictly-`true` `sheet` field rides onto the parsed input, any
 * other value is ignored (absent = the closed solid — the taper's
 * optional-field tolerance discipline).
 */
function withSheetFlag<P extends { readonly sheet?: true }>(
  parse: (payload: unknown) => ParseResult<P, WorkerParseError>,
): (payload: unknown) => ParseResult<P, WorkerParseError> {
  return (payload) => {
    const result = parse(payload);
    if (!result.ok) return result;
    if (isPlainRecord(payload) && payload.sheet === true) {
      return ok({ ...result.value, sheet: true });
    }
    return result;
  };
}

function serializeExtrudeInput(
  input: WorkerExtrudeInput,
): SerializedWorkerOperationInput<"solid.extrude"> {
  return {
    loop: input.loop.map(serializeProfileSegment),
    height: serializeDimensionalValue(input.height),
    direction: input.direction,
    placement: {
      rotation: {
        axis: [...input.placement.rotation.axis],
        angle: serializeDimensionalValue(input.placement.rotation.angle),
      },
      translation: {
        x: serializeDimensionalValue(input.placement.translation.x),
        y: serializeDimensionalValue(input.placement.translation.y),
        z: serializeDimensionalValue(input.placement.translation.z),
      },
    },
    // The taper rides last in the fixed key order, exactly when present —
    // the helix spine's optional-taper discipline, so an untapered input
    // serializes to the pre-extension byte shape.
    ...(input.taper === undefined
      ? {}
      : { taper: serializeDimensionalValue(input.taper) }),
    // The Phase 48 sheet flag rides last, exactly when present.
    ...(input.sheet === true ? { sheet: true } : {}),
  };
}

function parseExtrudeInput(
  payload: unknown,
): ParseResult<WorkerExtrudeInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.extrude", payload);
  if (!record.ok) return record;
  const loop = parseProfileLoop("solid.extrude", record.value.loop);
  if (!loop.ok) return loop;
  const height = requireLengthField(
    "solid.extrude",
    "height",
    record.value.height,
  );
  if (!height.ok) return height;
  const direction = record.value.direction;
  if (direction !== 1 && direction !== -1) {
    return payloadError(
      'The "solid.extrude" field "direction" must be 1 or -1.',
      direction,
    );
  }
  const placement = record.value.placement;
  if (!isPlainRecord(placement)) {
    return payloadError(
      'The "solid.extrude" field "placement" must be a plain object with rotation and translation.',
      placement,
    );
  }
  const rotation = placement.rotation;
  if (!isPlainRecord(rotation)) {
    return payloadError(
      'The "solid.extrude" placement "rotation" must be a plain object with axis and angle.',
      rotation,
    );
  }
  const axis = requireAxisField(
    "solid.extrude",
    "placement.rotation.axis",
    rotation.axis,
  );
  if (!axis.ok) return axis;
  const angle = requireAngleField(
    "solid.extrude",
    "placement.rotation.angle",
    rotation.angle,
  );
  if (!angle.ok) return angle;
  const translation = placement.translation;
  if (!isPlainRecord(translation)) {
    return payloadError(
      'The "solid.extrude" placement "translation" must be a plain object with x, y, z length fields.',
      translation,
    );
  }
  const x = requireLengthField(
    "solid.extrude",
    "placement.translation.x",
    translation.x,
  );
  if (!x.ok) return x;
  const y = requireLengthField(
    "solid.extrude",
    "placement.translation.y",
    translation.y,
  );
  if (!y.ok) return y;
  const z = requireLengthField(
    "solid.extrude",
    "placement.translation.z",
    translation.z,
  );
  if (!z.ok) return z;
  // Backward compatibility: a payload without the taper field is the plain
  // prism, byte-compatible with the pre-extension wire.
  if (record.value.taper === undefined) {
    return ok({
      loop: loop.value,
      height: height.value,
      direction,
      placement: {
        rotation: { axis: axis.value, angle: angle.value },
        translation: { x: x.value, y: y.value, z: z.value },
      },
    });
  }
  const taper = requireAngleField("solid.extrude", "taper", record.value.taper);
  if (!taper.ok) return taper;
  return ok({
    loop: loop.value,
    height: height.value,
    direction,
    placement: {
      rotation: { axis: axis.value, angle: angle.value },
      translation: { x: x.value, y: y.value, z: z.value },
    },
    taper: taper.value,
  });
}

function serializeRevolveInput(
  input: WorkerRevolveInput,
): SerializedWorkerOperationInput<"solid.revolve"> {
  return {
    loop: input.loop.map(serializeProfileSegment),
    axis: {
      point: [...input.axis.point],
      direction: [...input.axis.direction],
    },
    angle: serializeDimensionalValue(input.angle),
    placement: {
      rotation: {
        axis: [...input.placement.rotation.axis],
        angle: serializeDimensionalValue(input.placement.rotation.angle),
      },
      translation: {
        x: serializeDimensionalValue(input.placement.translation.x),
        y: serializeDimensionalValue(input.placement.translation.y),
        z: serializeDimensionalValue(input.placement.translation.z),
      },
    },
    // The Phase 48 sheet flag rides last, exactly when present.
    ...(input.sheet === true ? { sheet: true } : {}),
  };
}

function parseRevolveInput(
  payload: unknown,
): ParseResult<WorkerRevolveInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.revolve", payload);
  if (!record.ok) return record;
  const loop = parseProfileLoop("solid.revolve", record.value.loop);
  if (!loop.ok) return loop;
  const axis = record.value.axis;
  if (!isPlainRecord(axis)) {
    return payloadError(
      'The "solid.revolve" field "axis" must be a plain object with point and direction.',
      axis,
    );
  }
  const point = parseProfilePoint2("solid.revolve", "axis.point", axis.point);
  if (!point.ok) return point;
  const direction = parseProfilePoint2(
    "solid.revolve",
    "axis.direction",
    axis.direction,
  );
  if (!direction.ok) return direction;
  const angle = requireAngleField("solid.revolve", "angle", record.value.angle);
  if (!angle.ok) return angle;
  const placement = record.value.placement;
  if (!isPlainRecord(placement)) {
    return payloadError(
      'The "solid.revolve" field "placement" must be a plain object with rotation and translation.',
      placement,
    );
  }
  const rotation = placement.rotation;
  if (!isPlainRecord(rotation)) {
    return payloadError(
      'The "solid.revolve" placement "rotation" must be a plain object with axis and angle.',
      rotation,
    );
  }
  const rotationAxis = requireAxisField(
    "solid.revolve",
    "placement.rotation.axis",
    rotation.axis,
  );
  if (!rotationAxis.ok) return rotationAxis;
  const rotationAngle = requireAngleField(
    "solid.revolve",
    "placement.rotation.angle",
    rotation.angle,
  );
  if (!rotationAngle.ok) return rotationAngle;
  const translation = placement.translation;
  if (!isPlainRecord(translation)) {
    return payloadError(
      'The "solid.revolve" placement "translation" must be a plain object with x, y, z length fields.',
      translation,
    );
  }
  const x = requireLengthField(
    "solid.revolve",
    "placement.translation.x",
    translation.x,
  );
  if (!x.ok) return x;
  const y = requireLengthField(
    "solid.revolve",
    "placement.translation.y",
    translation.y,
  );
  if (!y.ok) return y;
  const z = requireLengthField(
    "solid.revolve",
    "placement.translation.z",
    translation.z,
  );
  if (!z.ok) return z;
  return ok({
    loop: loop.value,
    axis: { point: point.value, direction: direction.value },
    angle: angle.value,
    placement: {
      rotation: { axis: rotationAxis.value, angle: rotationAngle.value },
      translation: { x: x.value, y: y.value, z: z.value },
    },
  });
}

/** Serializes a profile placement to its canonical wire form. */
function serializeProfilePlacement(
  placement: ProfilePlacementInput,
): SerializedProfilePlacement {
  return {
    rotation: {
      axis: [...placement.rotation.axis],
      angle: serializeDimensionalValue(placement.rotation.angle),
    },
    translation: {
      x: serializeDimensionalValue(placement.translation.x),
      y: serializeDimensionalValue(placement.translation.y),
      z: serializeDimensionalValue(placement.translation.z),
    },
  };
}

/** Parses a profile placement from untrusted wire input. */
function parseProfilePlacement(
  operation: WorkerOperationId,
  placement: unknown,
): ParseResult<ProfilePlacementInput, WorkerParseError> {
  if (!isPlainRecord(placement)) {
    return payloadError(
      `The "${operation}" field "placement" must be a plain object with rotation and translation.`,
      placement,
    );
  }
  const rotation = placement.rotation;
  if (!isPlainRecord(rotation)) {
    return payloadError(
      `The "${operation}" placement "rotation" must be a plain object with axis and angle.`,
      rotation,
    );
  }
  const axis = requireAxisField(
    operation,
    "placement.rotation.axis",
    rotation.axis,
  );
  if (!axis.ok) return axis;
  const angle = requireAngleField(
    operation,
    "placement.rotation.angle",
    rotation.angle,
  );
  if (!angle.ok) return angle;
  const translation = placement.translation;
  if (!isPlainRecord(translation)) {
    return payloadError(
      `The "${operation}" placement "translation" must be a plain object with x, y, z length fields.`,
      translation,
    );
  }
  const x = requireLengthField(
    operation,
    "placement.translation.x",
    translation.x,
  );
  if (!x.ok) return x;
  const y = requireLengthField(
    operation,
    "placement.translation.y",
    translation.y,
  );
  if (!y.ok) return y;
  const z = requireLengthField(
    operation,
    "placement.translation.z",
    translation.z,
  );
  if (!z.ok) return z;
  return ok({
    rotation: { axis: axis.value, angle: angle.value },
    translation: { x: x.value, y: y.value, z: z.value },
  });
}

function serializeSweepInput(
  input: WorkerSweepInput,
): SerializedWorkerOperationInput<"solid.sweep"> {
  return {
    loop: input.loop.map(serializeProfileSegment),
    path: input.path.map((segment) =>
      segment.kind === "line"
        ? { kind: "line", start: [...segment.start], end: [...segment.end] }
        : {
            kind: "arc",
            center: [...segment.center],
            radius: segment.radius,
            startAngle: serializeDimensionalValue(segment.startAngle),
            endAngle: serializeDimensionalValue(segment.endAngle),
          },
    ),
    placement: serializeProfilePlacement(input.placement),
    // The Phase 48 sheet flag rides last, exactly when present.
    ...(input.sheet === true ? { sheet: true } : {}),
  };
}

function parseSweepInput(
  payload: unknown,
): ParseResult<WorkerSweepInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.sweep", payload);
  if (!record.ok) return record;
  const loop = parseProfileLoop("solid.sweep", record.value.loop);
  if (!loop.ok) return loop;
  if (!Array.isArray(record.value.path) || record.value.path.length === 0) {
    return payloadError(
      'The "solid.sweep" field "path" must be a non-empty array of path segments.',
      record.value.path,
    );
  }
  const path: WorkerSweepPathSegmentInput[] = [];
  for (const entry of record.value.path) {
    if (!isPlainRecord(entry)) {
      return payloadError(
        'The "solid.sweep" path segment must be a plain object.',
        entry,
      );
    }
    if (entry.kind === "line") {
      const start = parseProfilePoint2(
        "solid.sweep",
        "path.line.start",
        entry.start,
      );
      if (!start.ok) return start;
      const end = parseProfilePoint2("solid.sweep", "path.line.end", entry.end);
      if (!end.ok) return end;
      path.push({ kind: "line", start: start.value, end: end.value });
      continue;
    }
    if (entry.kind === "arc") {
      const center = parseProfilePoint2(
        "solid.sweep",
        "path.arc.center",
        entry.center,
      );
      if (!center.ok) return center;
      const radius = entry.radius;
      if (!isFiniteNumber(radius) || radius <= 0) {
        return payloadError(
          'The "solid.sweep" path arc radius must be a positive finite number.',
          radius,
        );
      }
      const startAngle = requireAngleField(
        "solid.sweep",
        "path.arc.startAngle",
        entry.startAngle,
      );
      if (!startAngle.ok) return startAngle;
      const endAngle = requireAngleField(
        "solid.sweep",
        "path.arc.endAngle",
        entry.endAngle,
      );
      if (!endAngle.ok) return endAngle;
      path.push({
        kind: "arc",
        center: center.value,
        radius,
        startAngle: startAngle.value,
        endAngle: endAngle.value,
      });
      continue;
    }
    return payloadError(
      'The "solid.sweep" path segment kind must be "line" or "arc".',
      entry.kind,
    );
  }
  const placement = parseProfilePlacement(
    "solid.sweep",
    record.value.placement,
  );
  if (!placement.ok) return placement;
  return ok({
    loop: loop.value,
    path,
    placement: placement.value,
  });
}

function serializeHelixSweepInput(
  input: WorkerHelixSweepInput,
): SerializedWorkerOperationInput<"solid.helixSweep"> {
  return {
    loop: input.loop.map(serializeProfileSegment),
    spine: {
      radius: serializeDimensionalValue(input.spine.radius),
      pitch: serializeDimensionalValue(input.spine.pitch),
      turns: input.spine.turns,
      handedness: input.spine.handedness,
      startAngle: serializeDimensionalValue(input.spine.startAngle),
      ...(input.spine.taper === undefined
        ? {}
        : { taper: serializeDimensionalValue(input.spine.taper) }),
    },
    placement: serializeProfilePlacement(input.placement),
  };
}

function parseHelixSweepInput(
  payload: unknown,
): ParseResult<WorkerHelixSweepInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.helixSweep", payload);
  if (!record.ok) return record;
  const loop = parseProfileLoop("solid.helixSweep", record.value.loop);
  if (!loop.ok) return loop;
  const spineEntry = record.value.spine;
  if (!isPlainRecord(spineEntry)) {
    return payloadError(
      'The "solid.helixSweep" field "spine" must be a plain object with the helix parameters.',
      spineEntry,
    );
  }
  const radius = requireLengthField(
    "solid.helixSweep",
    "spine.radius",
    spineEntry.radius,
  );
  if (!radius.ok) return radius;
  const pitch = requireLengthField(
    "solid.helixSweep",
    "spine.pitch",
    spineEntry.pitch,
  );
  if (!pitch.ok) return pitch;
  if (!isFiniteNumber(spineEntry.turns)) {
    return payloadError(
      'The "solid.helixSweep" field "spine.turns" must be a finite number.',
      spineEntry.turns,
    );
  }
  if (spineEntry.handedness !== 1 && spineEntry.handedness !== -1) {
    return payloadError(
      'The "solid.helixSweep" field "spine.handedness" must be 1 (right) or -1 (left).',
      spineEntry.handedness,
    );
  }
  const startAngle = requireAngleField(
    "solid.helixSweep",
    "spine.startAngle",
    spineEntry.startAngle,
  );
  if (!startAngle.ok) return startAngle;
  let taper: LengthValue | undefined;
  if (spineEntry.taper !== undefined) {
    const parsed = requireLengthField(
      "solid.helixSweep",
      "spine.taper",
      spineEntry.taper,
    );
    if (!parsed.ok) return parsed;
    taper = parsed.value;
  }
  const placement = parseProfilePlacement(
    "solid.helixSweep",
    record.value.placement,
  );
  if (!placement.ok) return placement;
  return ok({
    loop: loop.value,
    spine: {
      radius: radius.value,
      pitch: pitch.value,
      turns: spineEntry.turns,
      handedness: spineEntry.handedness,
      startAngle: startAngle.value,
      ...(taper === undefined ? {} : { taper }),
    },
    placement: placement.value,
  });
}

function serializeLoftInput(
  input: WorkerLoftInput,
): SerializedWorkerOperationInput<"solid.loft"> {
  return {
    sections: input.sections.map((section) => ({
      loop: section.loop.map(serializeProfileSegment),
      z: serializeDimensionalValue(section.z),
    })),
    placement: serializeProfilePlacement(input.placement),
    // The Phase 48 sheet flag rides last, exactly when present.
    ...(input.sheet === true ? { sheet: true } : {}),
  };
}

function parseLoftInput(
  payload: unknown,
): ParseResult<WorkerLoftInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.loft", payload);
  if (!record.ok) return record;
  if (
    !Array.isArray(record.value.sections) ||
    record.value.sections.length === 0
  ) {
    return payloadError(
      'The "solid.loft" field "sections" must be a non-empty array of section objects.',
      record.value.sections,
    );
  }
  const sections: WorkerLoftSectionInput[] = [];
  for (const entry of record.value.sections) {
    if (!isPlainRecord(entry)) {
      return payloadError(
        'The "solid.loft" section must be a plain object with loop and z.',
        entry,
      );
    }
    const loop = parseProfileLoop("solid.loft", entry.loop);
    if (!loop.ok) return loop;
    const z = requireLengthField("solid.loft", "section.z", entry.z);
    if (!z.ok) return z;
    sections.push({ loop: loop.value, z: z.value });
  }
  const placement = parseProfilePlacement("solid.loft", record.value.placement);
  if (!placement.ok) return placement;
  return ok({ sections, placement: placement.value });
}

function serializeOperandsInput(input: {
  readonly operands: readonly WorkerSolidId[];
}): {
  readonly operands: readonly string[];
} {
  return { operands: [...input.operands] };
}

function parseOperandsInput(
  operation: "solid.union" | "solid.intersect",
  payload: unknown,
): ParseResult<
  { readonly operands: readonly WorkerSolidId[] },
  WorkerParseError
> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const operands = requireSolidIdArrayField(
    operation,
    "operands",
    record.value.operands,
  );
  if (!operands.ok) return operands;
  return ok({ operands: operands.value });
}

function serializeSubtractInput(
  input: WorkerSubtractInput,
): SerializedWorkerOperationInput<"solid.subtract"> {
  return { target: input.target, tools: [...input.tools] };
}

function parseSubtractInput(
  payload: unknown,
): ParseResult<WorkerSubtractInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.subtract", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.subtract",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const tools = requireSolidIdArrayField(
    "solid.subtract",
    "tools",
    record.value.tools,
  );
  if (!tools.ok) return tools;
  return ok({ target: target.value, tools: tools.value });
}

function serializeTransformInput(
  input: WorkerTransformInput,
): SerializedWorkerOperationInput<"solid.transform"> {
  const translation = {
    x: serializeDimensionalValue(input.translation.x),
    y: serializeDimensionalValue(input.translation.y),
    z: serializeDimensionalValue(input.translation.z),
  };
  // The rotation rides before the scale, both exactly when present — a
  // translation-only input serializes to the pre-extension byte shape.
  if (input.rotation === undefined && input.scale === undefined) {
    return { solid: input.solid, translation };
  }
  const withScale = input.scale === undefined ? {} : { scale: input.scale };
  if (input.rotation === undefined) {
    return { solid: input.solid, translation, ...withScale };
  }
  return {
    solid: input.solid,
    translation,
    rotation: {
      axis: [...input.rotation.axis],
      angle: serializeDimensionalValue(input.rotation.angle),
    },
    ...withScale,
  };
}

function parseTransformInput(
  payload: unknown,
): ParseResult<WorkerTransformInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.transform", payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(
    "solid.transform",
    "solid",
    record.value.solid,
  );
  if (!solid.ok) return solid;
  if (!isPlainRecord(record.value.translation)) {
    return payloadError(
      'The "solid.transform" field "translation" must be a plain object with x, y, z length fields.',
      record.value.translation,
    );
  }
  const x = requireLengthField(
    "solid.transform",
    "translation.x",
    record.value.translation.x,
  );
  if (!x.ok) return x;
  const y = requireLengthField(
    "solid.transform",
    "translation.y",
    record.value.translation.y,
  );
  if (!y.ok) return y;
  const z = requireLengthField(
    "solid.transform",
    "translation.z",
    record.value.translation.z,
  );
  if (!z.ok) return z;
  // Backward compatibility: a payload without the rotation field is a
  // translation-only transform (the optional Phase 41 scale may still
  // ride alone), byte-compatible with the pre-extension wire.
  if (record.value.rotation === undefined) {
    const scale = optionalScaleField(record.value.scale);
    if (scale === null) {
      return payloadError(
        'The "solid.transform" field "scale" must be a finite number.',
        record.value.scale,
      );
    }
    if (scale !== undefined) {
      return ok({
        solid: solid.value,
        translation: { x: x.value, y: y.value, z: z.value },
        scale,
      });
    }
    return ok({
      solid: solid.value,
      translation: { x: x.value, y: y.value, z: z.value },
    });
  }
  if (!isPlainRecord(record.value.rotation)) {
    return payloadError(
      'The "solid.transform" field "rotation" must be a plain object with axis and angle fields.',
      record.value.rotation,
    );
  }
  const axis = requireAxisField(
    "solid.transform",
    "rotation.axis",
    record.value.rotation.axis,
  );
  if (!axis.ok) return axis;
  const angle = requireAngleField(
    "solid.transform",
    "rotation.angle",
    record.value.rotation.angle,
  );
  if (!angle.ok) return angle;
  const scale = optionalScaleField(record.value.scale);
  if (scale === null) {
    return payloadError(
      'The "solid.transform" field "scale" must be a finite number.',
      record.value.scale,
    );
  }
  if (scale !== undefined) {
    return ok({
      solid: solid.value,
      translation: { x: x.value, y: y.value, z: z.value },
      rotation: { axis: axis.value, angle: angle.value },
      scale,
    });
  }
  return ok({
    solid: solid.value,
    translation: { x: x.value, y: y.value, z: z.value },
    rotation: { axis: axis.value, angle: angle.value },
  });
}

function serializeSolidRefInput(input: WorkerSolidRefInput): {
  readonly solid: string;
} {
  return { solid: input.solid };
}

function parseSolidRefInput(
  operation:
    | "solid.bounds"
    | "solid.volume"
    | "solid.area"
    | "solid.tessellate"
    | "solid.dispose",
  payload: unknown,
): ParseResult<WorkerSolidRefInput, WorkerParseError> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(operation, "solid", record.value.solid);
  if (!solid.ok) return solid;
  return ok({ solid: solid.value });
}

function serializeStepImportInput(
  input: WorkerStepImportInput,
): SerializedWorkerOperationInput<"step.import"> {
  return { data: encodeBase64(input.data) };
}

/**
 * Parses a file-bytes input field shared by `step.import` and `brep.import`:
 * strict canonical base64 text or `worker/malformed-payload`.
 */
function parseFileBytesInput(
  operation: "step.import" | "brep.import",
  payload: unknown,
): ParseResult<{ readonly data: Uint8Array }, WorkerParseError> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const { data } = record.value;
  if (typeof data !== "string") {
    return payloadError(
      `The "${operation}" field "data" must be the file's canonical base64 text.`,
      data,
    );
  }
  const bytes = decodeBase64Strict(data);
  if (bytes === null) {
    return payloadError(
      `The "${operation}" field "data" must be strict canonical base64: standard alphabet, padded, no whitespace.`,
      data,
    );
  }
  return ok({ data: bytes });
}

function parseStepImportInput(
  payload: unknown,
): ParseResult<WorkerStepImportInput, WorkerParseError> {
  return parseFileBytesInput("step.import", payload);
}

/** Parses an optional plain-string settings field (`unit`/`schema`). */
function requireOptionalStringField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<string | undefined, WorkerParseError> {
  if (input === undefined) return ok(undefined);
  if (typeof input !== "string") {
    return payloadError(
      `The "${operation}" field "${field}" must be a string when present.`,
      input,
    );
  }
  return ok(input);
}

function serializeStepExportInput(
  input: WorkerStepExportInput,
): SerializedWorkerOperationInput<"step.export"> {
  // The settings ride after the solid list in the fixed key order, exactly
  // when present — a solids-only input serializes to the minimal form.
  if (input.unit === undefined && input.schema === undefined) {
    return { solids: [...input.solids] };
  }
  return {
    solids: [...input.solids],
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    ...(input.schema === undefined ? {} : { schema: input.schema }),
  };
}

function parseStepExportInput(
  payload: unknown,
): ParseResult<WorkerStepExportInput, WorkerParseError> {
  const record = requirePayloadRecord("step.export", payload);
  if (!record.ok) return record;
  const solids = requireSolidIdArrayField(
    "step.export",
    "solids",
    record.value.solids,
  );
  if (!solids.ok) return solids;
  const unit = requireOptionalStringField(
    "step.export",
    "unit",
    record.value.unit,
  );
  if (!unit.ok) return unit;
  const schema = requireOptionalStringField(
    "step.export",
    "schema",
    record.value.schema,
  );
  if (!schema.ok) return schema;
  if (unit.value === undefined && schema.value === undefined) {
    return ok({ solids: solids.value });
  }
  return ok({
    solids: solids.value,
    ...(unit.value === undefined ? {} : { unit: unit.value }),
    ...(schema.value === undefined ? {} : { schema: schema.value }),
  });
}

function serializeStepExportResult(
  result: WorkerStepExportResult,
): SerializedWorkerOperationResult<"step.export"> {
  return { data: encodeBase64(result.data) };
}

function parseStepExportResult(
  payload: unknown,
): ParseResult<WorkerStepExportResult, WorkerParseError> {
  const record = requirePayloadRecord("step.export", payload);
  if (!record.ok) return record;
  const { data } = record.value;
  if (typeof data !== "string") {
    return payloadError(
      'The "step.export" result field "data" must be the file\'s canonical base64 text.',
      data,
    );
  }
  const bytes = decodeBase64Strict(data);
  if (bytes === null) {
    return payloadError(
      'The "step.export" result field "data" must be strict canonical base64: standard alphabet, padded, no whitespace.',
      data,
    );
  }
  return ok({ data: bytes });
}

function serializeBrepImportInput(
  input: WorkerBrepImportInput,
): SerializedWorkerOperationInput<"brep.import"> {
  return { data: encodeBase64(input.data) };
}

function parseBrepImportInput(
  payload: unknown,
): ParseResult<WorkerBrepImportInput, WorkerParseError> {
  return parseFileBytesInput("brep.import", payload);
}

function serializeBrepExportInput(
  input: WorkerBrepExportInput,
): SerializedWorkerOperationInput<"brep.export"> {
  return { solids: [...input.solids] };
}

function parseBrepExportInput(
  payload: unknown,
): ParseResult<WorkerBrepExportInput, WorkerParseError> {
  const record = requirePayloadRecord("brep.export", payload);
  if (!record.ok) return record;
  const solids = requireSolidIdArrayField(
    "brep.export",
    "solids",
    record.value.solids,
  );
  if (!solids.ok) return solids;
  return ok({ solids: solids.value });
}

function serializeBrepImportResult(
  result: WorkerBrepImportResult,
): SerializedWorkerOperationResult<"brep.import"> {
  return {
    solids: result.solids.map((ref) => ({
      solid: ref.solid,
      origin: ref.origin,
    })),
  };
}

/**
 * Parses an imported-solid-refs result shared by `step.import` and
 * `brep.import`: an array of `{solid, origin}` refs whose origin must be
 * the operation's own provenance literal, with the caller building each
 * typed ref from a validated solid id.
 */
function parseImportedSolidsResult<R>(
  operation: "step.import" | "brep.import",
  origin: WorkerImportedOrigin,
  makeRef: (solid: WorkerSolidId) => R,
  payload: unknown,
): ParseResult<{ readonly solids: readonly R[] }, WorkerParseError> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const solids = record.value.solids;
  if (!Array.isArray(solids)) {
    return payloadError(
      `The "${operation}" result field "solids" must be an array of imported-solid refs.`,
      solids,
    );
  }
  const refs: R[] = [];
  for (const entry of solids) {
    if (!isPlainRecord(entry)) {
      return payloadError(
        `Each "${operation}" solid ref must be a plain object with "solid" and "origin".`,
        entry,
      );
    }
    const solid = requireSolidIdField(operation, "solids[].solid", entry.solid);
    if (!solid.ok) return solid;
    if (entry.origin !== origin) {
      return payloadError(
        `The "${operation}" solid ref "origin" must be the literal "${origin}".`,
        entry.origin,
      );
    }
    refs.push(makeRef(solid.value));
  }
  return ok({ solids: refs });
}

function parseStepImportResult(
  payload: unknown,
): ParseResult<WorkerStepImportResult, WorkerParseError> {
  return parseImportedSolidsResult(
    "step.import",
    "imported-step",
    (solid): WorkerImportedSolidRef => ({ solid, origin: "imported-step" }),
    payload,
  );
}

function parseBrepImportResult(
  payload: unknown,
): ParseResult<WorkerBrepImportResult, WorkerParseError> {
  return parseImportedSolidsResult(
    "brep.import",
    "imported-brep",
    (solid): WorkerImportedBrepSolidRef => ({ solid, origin: "imported-brep" }),
    payload,
  );
}

function serializeBrepExportResult(
  result: WorkerBrepExportResult,
): SerializedWorkerOperationResult<"brep.export"> {
  return { data: encodeBase64(result.data) };
}

function parseBrepExportResult(
  payload: unknown,
): ParseResult<WorkerBrepExportResult, WorkerParseError> {
  const record = requirePayloadRecord("brep.export", payload);
  if (!record.ok) return record;
  const { data } = record.value;
  if (typeof data !== "string") {
    return payloadError(
      'The "brep.export" result field "data" must be the file\'s canonical base64 text.',
      data,
    );
  }
  const bytes = decodeBase64Strict(data);
  if (bytes === null) {
    return payloadError(
      'The "brep.export" result field "data" must be strict canonical base64: standard alphabet, padded, no whitespace.',
      data,
    );
  }
  return ok({ data: bytes });
}

function serializeFilletInput(
  input: WorkerFilletInput,
): SerializedWorkerOperationInput<"solid.fillet"> {
  return {
    target: input.target,
    edges: [...input.edges],
    radius: serializeDimensionalValue(input.radius),
  };
}

function parseFilletInput(
  payload: unknown,
): ParseResult<WorkerFilletInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.fillet", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.fillet",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const edges = nonNegativeIntegerArray(record.value.edges);
  if (edges === undefined) {
    return payloadError(
      'The "solid.fillet" field "edges" must be an array of non-negative integer ordinals.',
      record.value.edges,
    );
  }
  const radius = requireLengthField(
    "solid.fillet",
    "radius",
    record.value.radius,
  );
  if (!radius.ok) return radius;
  return ok({ target: target.value, edges, radius: radius.value });
}

function serializeChamferInput(
  input: WorkerChamferInput,
): SerializedWorkerOperationInput<"solid.chamfer"> {
  return {
    target: input.target,
    edges: [...input.edges],
    distance: serializeDimensionalValue(input.distance),
  };
}

function parseChamferInput(
  payload: unknown,
): ParseResult<WorkerChamferInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.chamfer", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.chamfer",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const edges = nonNegativeIntegerArray(record.value.edges);
  if (edges === undefined) {
    return payloadError(
      'The "solid.chamfer" field "edges" must be an array of non-negative integer ordinals.',
      record.value.edges,
    );
  }
  const distance = requireLengthField(
    "solid.chamfer",
    "distance",
    record.value.distance,
  );
  if (!distance.ok) return distance;
  return ok({ target: target.value, edges, distance: distance.value });
}

function serializeShellInput(
  input: WorkerShellInput,
): SerializedWorkerOperationInput<"solid.shell"> {
  return {
    target: input.target,
    faces: [...input.faces],
    thickness: serializeDimensionalValue(input.thickness),
  };
}

function parseShellInput(
  payload: unknown,
): ParseResult<WorkerShellInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.shell", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.shell",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const faces = nonNegativeIntegerArray(record.value.faces);
  if (faces === undefined) {
    return payloadError(
      'The "solid.shell" field "faces" must be an array of non-negative integer ordinals.',
      record.value.faces,
    );
  }
  const thickness = requireLengthField(
    "solid.shell",
    "thickness",
    record.value.thickness,
  );
  if (!thickness.ok) return thickness;
  return ok({ target: target.value, faces, thickness: thickness.value });
}

function serializeThickenInput(
  input: WorkerThickenInput,
): SerializedWorkerOperationInput<"solid.thicken"> {
  return {
    target: input.target,
    thickness: serializeDimensionalValue(input.thickness),
  };
}

function parseThickenInput(
  payload: unknown,
): ParseResult<WorkerThickenInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.thicken", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.thicken",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const thickness = requireLengthField(
    "solid.thicken",
    "thickness",
    record.value.thickness,
  );
  if (!thickness.ok) return thickness;
  return ok({ target: target.value, thickness: thickness.value });
}

/** A single non-negative integer ordinal, or `undefined` when malformed. */
function nonNegativeOrdinal(field: unknown): number | undefined {
  return typeof field === "number" && Number.isInteger(field) && field >= 0
    ? field
    : undefined;
}

function serializeMoveFaceInput(
  input: WorkerMoveFaceInput,
): SerializedWorkerOperationInput<"solid.moveFace"> {
  return {
    target: input.target,
    face: input.face,
    direction: [...input.direction],
    distance: serializeDimensionalValue(input.distance),
  };
}

function parseMoveFaceInput(
  payload: unknown,
): ParseResult<WorkerMoveFaceInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.moveFace", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.moveFace",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const face = nonNegativeOrdinal(record.value.face);
  if (face === undefined) {
    return payloadError(
      'The "solid.moveFace" field "face" must be a non-negative integer ordinal.',
      record.value.face,
    );
  }
  const direction = requireAxisField(
    "solid.moveFace",
    "direction",
    record.value.direction,
  );
  if (!direction.ok) return direction;
  const distance = requireLengthField(
    "solid.moveFace",
    "distance",
    record.value.distance,
  );
  if (!distance.ok) return distance;
  return ok({
    target: target.value,
    face,
    direction: direction.value,
    distance: distance.value,
  });
}

function serializeReplaceFaceInput(
  input: WorkerReplaceFaceInput,
): SerializedWorkerOperationInput<"solid.replaceFace"> {
  return {
    target: input.target,
    face: input.face,
    plane: {
      origin: {
        x: serializeDimensionalValue(input.plane.origin.x),
        y: serializeDimensionalValue(input.plane.origin.y),
        z: serializeDimensionalValue(input.plane.origin.z),
      },
      normal: [...input.plane.normal],
    },
  };
}

function parseReplaceFaceInput(
  payload: unknown,
): ParseResult<WorkerReplaceFaceInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.replaceFace", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.replaceFace",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const face = nonNegativeOrdinal(record.value.face);
  if (face === undefined) {
    return payloadError(
      'The "solid.replaceFace" field "face" must be a non-negative integer ordinal.',
      record.value.face,
    );
  }
  if (!isPlainRecord(record.value.plane)) {
    return payloadError(
      'The "solid.replaceFace" field "plane" must be a plain object with origin and normal fields.',
      record.value.plane,
    );
  }
  if (!isPlainRecord(record.value.plane.origin)) {
    return payloadError(
      'The "solid.replaceFace" field "plane.origin" must be a plain object with x, y, z length fields.',
      record.value.plane.origin,
    );
  }
  const ox = requireLengthField(
    "solid.replaceFace",
    "plane.origin.x",
    record.value.plane.origin.x,
  );
  if (!ox.ok) return ox;
  const oy = requireLengthField(
    "solid.replaceFace",
    "plane.origin.y",
    record.value.plane.origin.y,
  );
  if (!oy.ok) return oy;
  const oz = requireLengthField(
    "solid.replaceFace",
    "plane.origin.z",
    record.value.plane.origin.z,
  );
  if (!oz.ok) return oz;
  const normal = requireAxisField(
    "solid.replaceFace",
    "plane.normal",
    record.value.plane.normal,
  );
  if (!normal.ok) return normal;
  return ok({
    target: target.value,
    face,
    plane: {
      origin: { x: ox.value, y: oy.value, z: oz.value },
      normal: normal.value,
    },
  });
}

function serializeDeleteFaceInput(
  input: WorkerDeleteFaceInput,
): SerializedWorkerOperationInput<"solid.deleteFace"> {
  return {
    target: input.target,
    face: input.face,
    heal: input.heal,
  };
}

function parseDeleteFaceInput(
  payload: unknown,
): ParseResult<WorkerDeleteFaceInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.deleteFace", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.deleteFace",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const face = nonNegativeOrdinal(record.value.face);
  if (face === undefined) {
    return payloadError(
      'The "solid.deleteFace" field "face" must be a non-negative integer ordinal.',
      record.value.face,
    );
  }
  if (typeof record.value.heal !== "boolean") {
    return payloadError(
      'The "solid.deleteFace" field "heal" must be a boolean.',
      record.value.heal,
    );
  }
  return ok({ target: target.value, face, heal: record.value.heal });
}

/**
 * Reads the optional `solid.transform` scale field: `undefined` when
 * absent (the pre-extension wire), the finite number when present, and
 * `null` when malformed (the caller's structured refusal).
 */
function optionalScaleField(field: unknown): number | undefined | null {
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isFinite(field)) return null;
  return field;
}

function serializeMirrorInput(
  input: WorkerMirrorInput,
): SerializedWorkerOperationInput<"solid.mirror"> {
  return {
    target: input.target,
    axis: input.axis,
    offset: serializeDimensionalValue(input.offset),
  };
}

function parseMirrorInput(
  payload: unknown,
): ParseResult<WorkerMirrorInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.mirror", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.mirror",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const axis: unknown = record.value.axis;
  if (axis !== "x" && axis !== "y" && axis !== "z") {
    return payloadError(
      'The "solid.mirror" field "axis" must be one of "x", "y", "z" (the plane\'s normal axis).',
      axis,
    );
  }
  const offset = requireLengthField(
    "solid.mirror",
    "offset",
    record.value.offset,
  );
  if (!offset.ok) return offset;
  return ok({ target: target.value, axis, offset: offset.value });
}

function serializeSectionInput(
  input: WorkerSectionInput,
): SerializedWorkerOperationInput<"solid.section"> {
  return {
    target: input.target,
    origin: [
      serializeDimensionalValue(input.origin[0]),
      serializeDimensionalValue(input.origin[1]),
      serializeDimensionalValue(input.origin[2]),
    ],
    normal: [...input.normal],
    keepSide: input.keepSide,
  };
}

function parseSectionInput(
  payload: unknown,
): ParseResult<WorkerSectionInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.section", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.section",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const originInput = record.value.origin;
  if (!Array.isArray(originInput) || originInput.length !== 3) {
    return payloadError(
      'The "solid.section" field "origin" must be an array of exactly three lengths.',
      originInput,
    );
  }
  const ox = requireLengthField("solid.section", "origin.x", originInput[0]);
  if (!ox.ok) return ox;
  const oy = requireLengthField("solid.section", "origin.y", originInput[1]);
  if (!oy.ok) return oy;
  const oz = requireLengthField("solid.section", "origin.z", originInput[2]);
  if (!oz.ok) return oz;
  const normal = finiteNumberArray(record.value.normal);
  if (normal === undefined || normal.length !== 3) {
    return payloadError(
      'The "solid.section" field "normal" must be an array of exactly three finite numbers.',
      record.value.normal,
    );
  }
  const nx = normal[0];
  const ny = normal[1];
  const nz = normal[2];
  if (nx === undefined || ny === undefined || nz === undefined) {
    return payloadError(
      'The "solid.section" field "normal" must be an array of exactly three finite numbers.',
      record.value.normal,
    );
  }
  const keepSide = record.value.keepSide;
  if (keepSide !== 1 && keepSide !== -1) {
    return payloadError(
      'The "solid.section" field "keepSide" must be 1 or -1.',
      keepSide,
    );
  }
  return ok({
    target: target.value,
    origin: [ox.value, oy.value, oz.value],
    normal: [nx, ny, nz],
    keepSide,
  });
}

function serializeTopologyInput(
  input: WorkerTopologyInput,
): SerializedWorkerOperationInput<"solid.topology"> {
  return {
    solid: input.solid,
    bodyId: input.bodyId,
    regeneration: input.regeneration,
  };
}

function parseTopologyInput(
  payload: unknown,
): ParseResult<WorkerTopologyInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.topology", payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(
    "solid.topology",
    "solid",
    record.value.solid,
  );
  if (!solid.ok) return solid;
  const bodyId = parseBodyId(record.value.bodyId);
  if (!bodyId.ok) {
    return payloadError(
      'The "solid.topology" field "bodyId" must be a valid body id.',
      record.value.bodyId,
    );
  }
  const regeneration = record.value.regeneration;
  if (
    !isFiniteNumber(regeneration) ||
    !Number.isInteger(regeneration) ||
    regeneration < 0
  ) {
    return payloadError(
      'The "solid.topology" field "regeneration" must be a non-negative integer.',
      record.value.regeneration,
    );
  }
  return ok({
    solid: solid.value,
    bodyId: bodyId.value,
    regeneration,
  });
}

/**
 * Structural validation of a topology snapshot crossing the wire back: the
 * protocol checks the Phase 22 payload's SHAPE (identity schemas present,
 * entity records well formed, ordinals non-negative integers) — what the
 * entities MEAN stays the reference-resolution protocol's business.
 */
function parseTopologySnapshot(
  input: unknown,
): ParseResult<TopologySnapshot, WorkerParseError> {
  const record = requirePayloadRecord("solid.topology", input);
  if (!record.ok) return record;
  const value = record.value;
  const {
    kernelId,
    persistentTopology,
    identitySchemas,
    bodyId,
    regeneration,
    entities,
  } = value;
  if (typeof kernelId !== "string" || kernelId.length === 0) {
    return payloadError(
      'The "solid.topology" snapshot field "kernelId" must be a non-empty string.',
      kernelId,
    );
  }
  if (typeof persistentTopology !== "boolean") {
    return payloadError(
      'The "solid.topology" snapshot field "persistentTopology" must be a boolean.',
      persistentTopology,
    );
  }
  if (
    !Array.isArray(identitySchemas) ||
    !identitySchemas.every((schema) => typeof schema === "string")
  ) {
    return payloadError(
      'The "solid.topology" snapshot field "identitySchemas" must be an array of strings.',
      identitySchemas,
    );
  }
  if (typeof bodyId !== "string") {
    return payloadError(
      'The "solid.topology" snapshot field "bodyId" must be a string.',
      bodyId,
    );
  }
  if (
    !isFiniteNumber(regeneration) ||
    !Number.isInteger(regeneration) ||
    regeneration < 0
  ) {
    return payloadError(
      'The "solid.topology" snapshot field "regeneration" must be a non-negative integer.',
      regeneration,
    );
  }
  if (!Array.isArray(entities)) {
    return payloadError(
      'The "solid.topology" snapshot field "entities" must be an array.',
      entities,
    );
  }
  const parsedEntities: TopologyEntitySnapshot[] = [];
  for (const entry of entities) {
    if (!isPlainRecord(entry)) {
      return payloadError(
        'Each "solid.topology" snapshot entity must be a plain object.',
        entry,
      );
    }
    const { kind, ordinal, identity, geometry } = entry;
    if (kind !== "face" && kind !== "edge" && kind !== "vertex") {
      return payloadError(
        'A "solid.topology" snapshot entity "kind" must be "face", "edge", or "vertex".',
        kind,
      );
    }
    if (!isFiniteNumber(ordinal) || !Number.isInteger(ordinal) || ordinal < 0) {
      return payloadError(
        'A "solid.topology" snapshot entity "ordinal" must be a non-negative integer.',
        ordinal,
      );
    }
    let parsedIdentity: TopologySnapshot["entities"][number]["identity"] = null;
    if (identity !== null) {
      if (!isPlainRecord(identity)) {
        return payloadError(
          'A "solid.topology" snapshot entity "identity" must be null or a plain object.',
          identity,
        );
      }
      const { kernelId: identityKernelId, schema, data } = identity;
      if (
        typeof identityKernelId !== "string" ||
        identityKernelId.length === 0 ||
        typeof schema !== "string" ||
        schema.length === 0 ||
        !isPlainRecord(data)
      ) {
        return payloadError(
          'A "solid.topology" snapshot entity identity must carry a non-empty kernelId, a schema, and a data record.',
          identity,
        );
      }
      const dataRecord: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(data)) {
        if (
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          return payloadError(
            'A "solid.topology" snapshot entity identity data values must be primitives.',
            value,
          );
        }
        dataRecord[key] = value;
      }
      parsedIdentity = {
        kernelId: identityKernelId,
        schema,
        data: dataRecord,
      };
    }
    const parsedGeometry = parseSnapshotGeometry(geometry);
    if (!parsedGeometry.ok) return parsedGeometry;
    parsedEntities.push({
      kind,
      ordinal,
      identity: parsedIdentity,
      geometry: parsedGeometry.value,
    });
  }
  const parsedBodyId = parseBodyId(record.value.bodyId);
  if (!parsedBodyId.ok) {
    return payloadError(
      'The "solid.topology" snapshot field "bodyId" must be a valid body id.',
      record.value.bodyId,
    );
  }
  return ok({
    kernelId,
    persistentTopology,
    identitySchemas: [...identitySchemas],
    bodyId: parsedBodyId.value,
    regeneration,
    entities: parsedEntities,
  });
}

/**
 * Structural validation of one snapshot entity's geometry descriptor: every
 * present field must carry the right shape (a finite measure or a
 * three-number position); absent fields stay absent.
 */
function parseSnapshotGeometry(
  input: unknown,
): ParseResult<
  TopologySnapshot["entities"][number]["geometry"],
  WorkerParseError
> {
  if (!isPlainRecord(input)) {
    return payloadError(
      'A "solid.topology" snapshot entity "geometry" must be a plain object.',
      input,
    );
  }
  const measure = (
    field: string,
  ): ParseResult<number | undefined, WorkerParseError> => {
    const value = input[field];
    if (value === undefined) return ok(undefined);
    if (!isFiniteNumber(value)) {
      return payloadError(
        `A "solid.topology" snapshot geometry "${field}" must be a finite number.`,
        value,
      );
    }
    return ok(value);
  };
  const areaMm2 = measure("areaMm2");
  if (!areaMm2.ok) return areaMm2;
  const lengthMm = measure("lengthMm");
  if (!lengthMm.ok) return lengthMm;
  const positions: Partial<Record<string, readonly [number, number, number]>> =
    {};
  for (const field of [
    "centroidAbsoluteMm",
    "centroidRelativeMm",
    "pointAbsoluteMm",
    "pointRelativeMm",
  ]) {
    const value = input[field];
    if (value === undefined) continue;
    const vector = finiteNumberArray(value);
    if (vector === undefined || vector.length !== 3) {
      return payloadError(
        `A "solid.topology" snapshot geometry "${field}" must be an array of exactly three finite numbers.`,
        value,
      );
    }
    const [x, y, z] = vector;
    if (x === undefined || y === undefined || z === undefined) {
      return payloadError(
        `A "solid.topology" snapshot geometry "${field}" must be dense.`,
        value,
      );
    }
    positions[field] = [x, y, z];
  }
  return ok({
    ...(areaMm2.value !== undefined ? { areaMm2: areaMm2.value } : {}),
    ...(lengthMm.value !== undefined ? { lengthMm: lengthMm.value } : {}),
    ...(positions.centroidAbsoluteMm !== undefined
      ? { centroidAbsoluteMm: positions.centroidAbsoluteMm }
      : {}),
    ...(positions.centroidRelativeMm !== undefined
      ? { centroidRelativeMm: positions.centroidRelativeMm }
      : {}),
    ...(positions.pointAbsoluteMm !== undefined
      ? { pointAbsoluteMm: positions.pointAbsoluteMm }
      : {}),
    ...(positions.pointRelativeMm !== undefined
      ? { pointRelativeMm: positions.pointRelativeMm }
      : {}),
  });
}

function serializeTopologyResult(
  result: WorkerTopologyResult,
): SerializedWorkerOperationResult<"solid.topology"> {
  const { snapshot } = result;
  return {
    kernelId: snapshot.kernelId,
    persistentTopology: snapshot.persistentTopology,
    identitySchemas: [...snapshot.identitySchemas],
    bodyId: snapshot.bodyId,
    regeneration: snapshot.regeneration,
    entities: snapshot.entities.map((entity) => ({
      kind: entity.kind,
      ordinal: entity.ordinal,
      identity:
        entity.identity === null
          ? null
          : {
              kernelId: entity.identity.kernelId,
              schema: entity.identity.schema,
              data: { ...entity.identity.data },
            },
      geometry:
        entity.geometry.areaMm2 !== undefined ||
        entity.geometry.lengthMm !== undefined ||
        entity.geometry.centroidAbsoluteMm !== undefined ||
        entity.geometry.centroidRelativeMm !== undefined ||
        entity.geometry.pointAbsoluteMm !== undefined ||
        entity.geometry.pointRelativeMm !== undefined
          ? {
              ...(entity.geometry.areaMm2 !== undefined
                ? { areaMm2: entity.geometry.areaMm2 }
                : {}),
              ...(entity.geometry.lengthMm !== undefined
                ? { lengthMm: entity.geometry.lengthMm }
                : {}),
              ...(entity.geometry.centroidAbsoluteMm !== undefined
                ? {
                    centroidAbsoluteMm: [...entity.geometry.centroidAbsoluteMm],
                  }
                : {}),
              ...(entity.geometry.centroidRelativeMm !== undefined
                ? {
                    centroidRelativeMm: [...entity.geometry.centroidRelativeMm],
                  }
                : {}),
              ...(entity.geometry.pointAbsoluteMm !== undefined
                ? { pointAbsoluteMm: [...entity.geometry.pointAbsoluteMm] }
                : {}),
              ...(entity.geometry.pointRelativeMm !== undefined
                ? { pointRelativeMm: [...entity.geometry.pointRelativeMm] }
                : {}),
            }
          : {},
    })),
  };
}

function parseTopologyResult(
  payload: unknown,
): ParseResult<WorkerTopologyResult, WorkerParseError> {
  const snapshot = parseTopologySnapshot(payload);
  if (!snapshot.ok) return snapshot;
  return ok({ snapshot: snapshot.value });
}

/**
 * The input codec table: one serializer and one parser per operation. This
 * registry is the operation vocabulary as data — adding an operation without
 * registering its codecs fails to compile.
 */
const INPUT_SERIALIZERS: {
  readonly [O in WorkerOperationId]: (
    input: WorkerOperationInput<O>,
  ) => SerializedWorkerOperationInput<O>;
} = {
  "solid.createBox": serializeBoxInput,
  "solid.createSphere": serializeSphereInput,
  "solid.createCylinder": serializeCylinderInput,
  "solid.createCone": serializeConeInput,
  "solid.createSheet": serializeCreateSheetInput,
  "solid.extrude": serializeExtrudeInput,
  "solid.revolve": serializeRevolveInput,
  "solid.sweep": serializeSweepInput,
  "solid.helixSweep": serializeHelixSweepInput,
  "solid.loft": serializeLoftInput,
  "solid.union": serializeOperandsInput,
  "solid.subtract": serializeSubtractInput,
  "solid.intersect": serializeOperandsInput,
  "solid.transform": serializeTransformInput,
  "solid.bounds": serializeSolidRefInput,
  "solid.volume": serializeSolidRefInput,
  "solid.area": serializeSolidRefInput,
  "solid.tessellate": serializeSolidRefInput,
  "solid.dispose": serializeSolidRefInput,
  "solid.fillet": serializeFilletInput,
  "solid.chamfer": serializeChamferInput,
  "solid.shell": serializeShellInput,
  "solid.thicken": serializeThickenInput,
  "solid.mirror": serializeMirrorInput,
  "solid.moveFace": serializeMoveFaceInput,
  "solid.replaceFace": serializeReplaceFaceInput,
  "solid.deleteFace": serializeDeleteFaceInput,
  "solid.section": serializeSectionInput,
  "solid.topology": serializeTopologyInput,
  "step.import": serializeStepImportInput,
  "step.export": serializeStepExportInput,
  "brep.import": serializeBrepImportInput,
  "brep.export": serializeBrepExportInput,
};

const INPUT_PARSERS: {
  readonly [O in WorkerOperationId]: (
    payload: unknown,
  ) => ParseResult<WorkerOperationInput<O>, WorkerParseError>;
} = {
  "solid.createBox": parseBoxInput,
  "solid.createSphere": parseSphereInput,
  "solid.createCylinder": parseCylinderInput,
  "solid.createCone": parseConeInput,
  "solid.createSheet": parseCreateSheetInput,
  "solid.extrude": withSheetFlag(parseExtrudeInput),
  "solid.revolve": withSheetFlag(parseRevolveInput),
  "solid.sweep": withSheetFlag(parseSweepInput),
  "solid.helixSweep": parseHelixSweepInput,
  "solid.loft": withSheetFlag(parseLoftInput),
  "solid.union": (payload) => parseOperandsInput("solid.union", payload),
  "solid.subtract": parseSubtractInput,
  "solid.intersect": (payload) =>
    parseOperandsInput("solid.intersect", payload),
  "solid.transform": parseTransformInput,
  "solid.bounds": (payload) => parseSolidRefInput("solid.bounds", payload),
  "solid.volume": (payload) => parseSolidRefInput("solid.volume", payload),
  "solid.area": (payload) => parseSolidRefInput("solid.area", payload),
  "solid.tessellate": (payload) =>
    parseSolidRefInput("solid.tessellate", payload),
  "solid.dispose": (payload) => parseSolidRefInput("solid.dispose", payload),
  "solid.fillet": parseFilletInput,
  "solid.chamfer": parseChamferInput,
  "solid.shell": parseShellInput,
  "solid.thicken": parseThickenInput,
  "solid.mirror": parseMirrorInput,
  "solid.moveFace": parseMoveFaceInput,
  "solid.replaceFace": parseReplaceFaceInput,
  "solid.deleteFace": parseDeleteFaceInput,
  "solid.section": parseSectionInput,
  "solid.topology": parseTopologyInput,
  "step.import": parseStepImportInput,
  "step.export": parseStepExportInput,
  "brep.import": parseBrepImportInput,
  "brep.export": parseBrepExportInput,
};

/**
 * Serializes an operation's typed input to its canonical wire form: fixed key
 * order, lengths normalized to millimetres.
 */
export function serializeWorkerOperationInput<O extends WorkerOperationId>(
  operation: O,
  input: WorkerOperationInput<O>,
): SerializedWorkerOperationInput<O> {
  return INPUT_SERIALIZERS[operation](input);
}

/**
 * Parses untrusted input as the given operation's input payload. Strict on
 * known fields, tolerant of unknown fields; rejects with
 * `worker/malformed-payload`.
 */
export function parseWorkerOperationInput<O extends WorkerOperationId>(
  operation: O,
  payload: unknown,
): ParseResult<WorkerOperationInput<O>, WorkerParseError> {
  return INPUT_PARSERS[operation](payload);
}

// ---------------------------------------------------------------------------
// Per-operation result codecs
// ---------------------------------------------------------------------------

function serializeSolidResult(result: WorkerSolidResult): {
  readonly solid: string;
} {
  return { solid: result.solid };
}

function parseSolidResult(
  operation: WorkerOperationId,
  payload: unknown,
): ParseResult<WorkerSolidResult, WorkerParseError> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(operation, "solid", record.value.solid);
  if (!solid.ok) return solid;
  return ok({ solid: solid.value });
}

/** Copies input into a finite-number array, or `undefined` if it is not one. */
function finiteNumberArray(input: unknown): readonly number[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries: readonly unknown[] = input;
  const values: number[] = [];
  for (const entry of entries) {
    if (!isFiniteNumber(entry)) return undefined;
    values.push(entry);
  }
  return values;
}

/** Copies input into a non-negative integer array, or `undefined` if it is not one. */
function nonNegativeIntegerArray(
  input: unknown,
): readonly number[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries: readonly unknown[] = input;
  const values: number[] = [];
  for (const entry of entries) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      return undefined;
    }
    values.push(entry);
  }
  return values;
}

function parsePoint3(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<readonly [number, number, number], WorkerParseError> {
  const values = finiteNumberArray(input);
  if (values === undefined || values.length !== 3) {
    return payloadError(
      `The "${operation}" bounds field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  const [x, y, z] = values;
  if (x === undefined || y === undefined || z === undefined) {
    return payloadError(
      `The "${operation}" bounds field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  return ok([x, y, z]);
}

function serializeBoundsResult(
  result: WorkerBoundsResult,
): SerializedWorkerOperationResult<"solid.bounds"> {
  return {
    bounds: {
      min: [...result.bounds.min],
      max: [...result.bounds.max],
    },
  };
}

function parseBoundsResult(
  payload: unknown,
): ParseResult<WorkerBoundsResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.bounds", payload);
  if (!record.ok) return record;
  if (!isPlainRecord(record.value.bounds)) {
    return payloadError(
      'The "solid.bounds" result field "bounds" must be a plain object with min and max points.',
      record.value.bounds,
    );
  }
  const min = parsePoint3("solid.bounds", "min", record.value.bounds.min);
  if (!min.ok) return min;
  const max = parsePoint3("solid.bounds", "max", record.value.bounds.max);
  if (!max.ok) return max;
  return ok({ bounds: { min: min.value, max: max.value } });
}

function serializeVolumeResult(
  result: WorkerVolumeResult,
): SerializedWorkerOperationResult<"solid.volume"> {
  return { volume: result.volume };
}

function parseVolumeResult(
  payload: unknown,
): ParseResult<WorkerVolumeResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.volume", payload);
  if (!record.ok) return record;
  const volume = record.value.volume;
  if (!isFiniteNumber(volume) || volume < 0) {
    return payloadError(
      'The "solid.volume" result field "volume" must be a finite, non-negative number.',
      volume,
    );
  }
  return ok({ volume });
}

function serializeSectionResult(
  result: WorkerSectionResult,
): SerializedWorkerOperationResult<"solid.section"> {
  return {
    solid: result.solid,
    section: {
      areaMm2: result.section.areaMm2,
      centroidMm: [...result.section.centroidMm],
    },
  };
}

function parseSectionResult(
  payload: unknown,
): ParseResult<WorkerSectionResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.section", payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(
    "solid.section",
    "solid",
    record.value.solid,
  );
  if (!solid.ok) return solid;
  if (!isPlainRecord(record.value.section)) {
    return payloadError(
      'The "solid.section" result field "section" must be a plain object with areaMm2 and centroidMm.',
      record.value.section,
    );
  }
  const areaMm2 = record.value.section.areaMm2;
  if (!isFiniteNumber(areaMm2) || !(areaMm2 > 0)) {
    return payloadError(
      'The "solid.section" result field "section.areaMm2" must be a finite, strictly positive number (an empty section rejects kernel-side).',
      areaMm2,
    );
  }
  const centroidMm = parsePoint3(
    "solid.section",
    "section.centroidMm",
    record.value.section.centroidMm,
  );
  if (!centroidMm.ok) return centroidMm;
  return ok({
    solid: solid.value,
    section: { areaMm2, centroidMm: centroidMm.value },
  });
}

/**
 * Serializes `solid.area`'s result: the mm² value carried verbatim (the
 * kernel already reports canonical-unit numbers).
 */
function serializeAreaResult(
  result: WorkerAreaResult,
): SerializedWorkerOperationResult<"solid.area"> {
  return { area: result.area };
}

/**
 * Parses `solid.area`'s result at the trust boundary: a finite,
 * non-negative number, the volume parser's discipline over mm².
 */
function parseAreaResult(
  payload: unknown,
): ParseResult<WorkerAreaResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.area", payload);
  if (!record.ok) return record;
  const area = record.value.area;
  if (!isFiniteNumber(area) || area < 0) {
    return payloadError(
      'The "solid.area" result field "area" must be a finite, non-negative number.',
      area,
    );
  }
  return ok({ area });
}

function serializeTessellationResult(
  result: WorkerTessellationResult,
): SerializedWorkerOperationResult<"solid.tessellate"> {
  const tessellation = result.tessellation;
  if (tessellation.normals === undefined) {
    return {
      tessellation: {
        positions: [...tessellation.positions],
        indices: [...tessellation.indices],
      },
    };
  }
  return {
    tessellation: {
      positions: [...tessellation.positions],
      indices: [...tessellation.indices],
      normals: [...tessellation.normals],
    },
  };
}

function parseTessellationResult(
  payload: unknown,
): ParseResult<WorkerTessellationResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.tessellate", payload);
  if (!record.ok) return record;
  if (!isPlainRecord(record.value.tessellation)) {
    return payloadError(
      'The "solid.tessellate" result field "tessellation" must be a plain object with positions and indices arrays.',
      record.value.tessellation,
    );
  }
  const { positions, indices, normals } = record.value.tessellation;
  const parsedPositions = finiteNumberArray(positions);
  if (parsedPositions === undefined) {
    return payloadError(
      'The "solid.tessellate" tessellation "positions" must be an array of finite numbers.',
      positions,
    );
  }
  if (parsedPositions.length % 3 !== 0) {
    return payloadError(
      'The "solid.tessellate" tessellation "positions" length must be divisible by 3.',
      positions,
    );
  }
  const parsedIndices = nonNegativeIntegerArray(indices);
  if (parsedIndices === undefined) {
    return payloadError(
      'The "solid.tessellate" tessellation "indices" must be an array of non-negative integers.',
      indices,
    );
  }
  if (parsedIndices.length % 3 !== 0) {
    return payloadError(
      'The "solid.tessellate" tessellation "indices" length must be divisible by 3.',
      indices,
    );
  }
  const vertexCount = parsedPositions.length / 3;
  if (parsedIndices.some((index) => index >= vertexCount)) {
    return payloadError(
      'The "solid.tessellate" tessellation "indices" must reference existing vertices.',
      indices,
    );
  }
  if (normals === undefined) {
    return ok({
      tessellation: { positions: parsedPositions, indices: parsedIndices },
    });
  }
  const parsedNormals = finiteNumberArray(normals);
  if (parsedNormals === undefined) {
    return payloadError(
      'The "solid.tessellate" tessellation "normals" must be an array of finite numbers.',
      normals,
    );
  }
  if (parsedNormals.length !== parsedPositions.length) {
    return payloadError(
      'The "solid.tessellate" tessellation "normals" must pair index-for-index with "positions".',
      normals,
    );
  }
  return ok({
    tessellation: {
      positions: parsedPositions,
      indices: parsedIndices,
      normals: parsedNormals,
    },
  });
}

function serializeDisposeResult(): null {
  return null;
}

function parseDisposeResult(
  payload: unknown,
): ParseResult<WorkerDisposeResult, WorkerParseError> {
  if (payload !== null) {
    return payloadError('The "solid.dispose" result must be null.', payload);
  }
  return ok(null);
}

function serializeStepImportResult(
  result: WorkerStepImportResult,
): SerializedWorkerOperationResult<"step.import"> {
  return {
    solids: result.solids.map((ref) => ({
      solid: ref.solid,
      origin: ref.origin,
    })),
  };
}

/**
 * The result codec table, the input table's twin: one serializer and one
 * parser per operation.
 */
const RESULT_SERIALIZERS: {
  readonly [O in WorkerOperationId]: (
    result: WorkerOperationResult<O>,
  ) => SerializedWorkerOperationResult<O>;
} = {
  "solid.createBox": serializeSolidResult,
  "solid.createSphere": serializeSolidResult,
  "solid.createCylinder": serializeSolidResult,
  "solid.createCone": serializeSolidResult,
  "solid.createSheet": serializeSolidResult,
  "solid.extrude": serializeSolidResult,
  "solid.revolve": serializeSolidResult,
  "solid.sweep": serializeSolidResult,
  "solid.helixSweep": serializeSolidResult,
  "solid.loft": serializeSolidResult,
  "solid.union": serializeSolidResult,
  "solid.subtract": serializeSolidResult,
  "solid.intersect": serializeSolidResult,
  "solid.transform": serializeSolidResult,
  "solid.bounds": serializeBoundsResult,
  "solid.volume": serializeVolumeResult,
  "solid.area": serializeAreaResult,
  "solid.tessellate": serializeTessellationResult,
  "solid.dispose": serializeDisposeResult,
  "solid.fillet": serializeSolidResult,
  "solid.chamfer": serializeSolidResult,
  "solid.shell": serializeSolidResult,
  "solid.thicken": serializeSolidResult,
  "solid.mirror": serializeSolidResult,
  "solid.moveFace": serializeSolidResult,
  "solid.replaceFace": serializeSolidResult,
  "solid.deleteFace": serializeSolidResult,
  "solid.section": serializeSectionResult,
  "solid.topology": serializeTopologyResult,
  "step.import": serializeStepImportResult,
  "step.export": serializeStepExportResult,
  "brep.import": serializeBrepImportResult,
  "brep.export": serializeBrepExportResult,
};

const RESULT_PARSERS: {
  readonly [O in WorkerOperationId]: (
    payload: unknown,
  ) => ParseResult<WorkerOperationResult<O>, WorkerParseError>;
} = {
  "solid.createBox": (payload) => parseSolidResult("solid.createBox", payload),
  "solid.createSphere": (payload) =>
    parseSolidResult("solid.createSphere", payload),
  "solid.createCylinder": (payload) =>
    parseSolidResult("solid.createCylinder", payload),
  "solid.createCone": (payload) =>
    parseSolidResult("solid.createCone", payload),
  "solid.createSheet": (payload) =>
    parseSolidResult("solid.createSheet", payload),
  "solid.extrude": (payload) => parseSolidResult("solid.extrude", payload),
  "solid.revolve": (payload) => parseSolidResult("solid.revolve", payload),
  "solid.sweep": (payload) => parseSolidResult("solid.sweep", payload),
  "solid.helixSweep": (payload) =>
    parseSolidResult("solid.helixSweep", payload),
  "solid.loft": (payload) => parseSolidResult("solid.loft", payload),
  "solid.union": (payload) => parseSolidResult("solid.union", payload),
  "solid.subtract": (payload) => parseSolidResult("solid.subtract", payload),
  "solid.intersect": (payload) => parseSolidResult("solid.intersect", payload),
  "solid.transform": (payload) => parseSolidResult("solid.transform", payload),
  "solid.bounds": parseBoundsResult,
  "solid.volume": parseVolumeResult,
  "solid.area": parseAreaResult,
  "solid.tessellate": parseTessellationResult,
  "solid.dispose": parseDisposeResult,
  "solid.fillet": (payload) => parseSolidResult("solid.fillet", payload),
  "solid.chamfer": (payload) => parseSolidResult("solid.chamfer", payload),
  "solid.shell": (payload) => parseSolidResult("solid.shell", payload),
  "solid.thicken": (payload) => parseSolidResult("solid.thicken", payload),
  "solid.mirror": (payload) => parseSolidResult("solid.mirror", payload),
  "solid.moveFace": (payload) => parseSolidResult("solid.moveFace", payload),
  "solid.replaceFace": (payload) =>
    parseSolidResult("solid.replaceFace", payload),
  "solid.deleteFace": (payload) =>
    parseSolidResult("solid.deleteFace", payload),
  "solid.section": parseSectionResult,
  "solid.topology": parseTopologyResult,
  "step.import": parseStepImportResult,
  "step.export": parseStepExportResult,
  "brep.import": parseBrepImportResult,
  "brep.export": parseBrepExportResult,
};

/**
 * Serializes an operation's typed result to its canonical wire form: fixed
 * key order, plain arrays for the triangle soup.
 */
export function serializeWorkerOperationResult<O extends WorkerOperationId>(
  operation: O,
  result: WorkerOperationResult<O>,
): SerializedWorkerOperationResult<O> {
  return RESULT_SERIALIZERS[operation](result);
}

/**
 * Parses untrusted input as the given operation's result payload. Enforces
 * the kernel contract's structural guarantees at the trust boundary —
 * divisible-by-3 soup arrays, in-range vertex indices, normals paired
 * index-for-index with positions, finite numbers throughout — and rejects
 * with `worker/malformed-payload`.
 */
export function parseWorkerOperationResult<O extends WorkerOperationId>(
  operation: O,
  payload: unknown,
): ParseResult<WorkerOperationResult<O>, WorkerParseError> {
  return RESULT_PARSERS[operation](payload);
}

/**
 * The mint-extraction table: for each operation, the session solids its
 * result mints — the single-solid producers' results carry exactly one
 * {@link WorkerSolidId}, `step.import` carries one per imported solid, and
 * every measurement/tessellation/disposal result owns none. Registered like
 * the codec tables above, so adding an operation forces a decision here at
 * compile time.
 */
const RESULT_MINTS: {
  readonly [O in WorkerOperationId]: (
    result: WorkerOperationResult<O>,
  ) => readonly WorkerSolidId[];
} = {
  "solid.createBox": (result) => [result.solid],
  "solid.createSphere": (result) => [result.solid],
  "solid.createCylinder": (result) => [result.solid],
  "solid.createSheet": (result) => [result.solid],
  "solid.createCone": (result) => [result.solid],
  "solid.extrude": (result) => [result.solid],
  "solid.revolve": (result) => [result.solid],
  "solid.sweep": (result) => [result.solid],
  "solid.helixSweep": (result) => [result.solid],
  "solid.loft": (result) => [result.solid],
  "solid.union": (result) => [result.solid],
  "solid.subtract": (result) => [result.solid],
  "solid.intersect": (result) => [result.solid],
  "solid.transform": (result) => [result.solid],
  "solid.bounds": () => [],
  "solid.volume": () => [],
  "solid.area": () => [],
  "solid.tessellate": () => [],
  "solid.dispose": () => [],
  "solid.fillet": (result) => [result.solid],
  "solid.chamfer": (result) => [result.solid],
  "solid.shell": (result) => [result.solid],
  "solid.thicken": (result) => [result.solid],
  "solid.mirror": (result) => [result.solid],
  "solid.moveFace": (result) => [result.solid],
  "solid.replaceFace": (result) => [result.solid],
  "solid.deleteFace": (result) => [result.solid],
  "solid.section": (result) => [result.solid],
  "solid.topology": () => [],
  "step.import": (result) => result.solids.map((ref) => ref.solid),
  "step.export": () => [],
  "brep.import": (result) => result.solids.map((ref) => ref.solid),
  "brep.export": () => [],
};

/**
 * The session solids `operation`'s `result` minted, in mint order — empty
 * when the result owns no solid. This is the codec-table answer to "which
 * solid ids does this result carry" — the single source of truth, so callers
 * (the stale-result coordinator recording mints, the worker client releasing
 * a voided request's orphaned mints) never re-derive it by probing result
 * shapes.
 */
export function resultMintsSolids<O extends WorkerOperationId>(
  operation: O,
  result: WorkerOperationResult<O>,
): readonly WorkerSolidId[] {
  return RESULT_MINTS[operation](result);
}
