/**
 * The OpenCascade geometry-kernel adapter (Phase 21.1): a full
 * implementation of the kernel contract on top of the
 * `replicad-opencascadejs` WASM binding (OCCT 8.0).
 *
 * ## Isolation
 *
 * Every OpenCascade type stays inside this module. The public surface hands
 * out and accepts only kernel-neutral {@link KernelSolid} handles: the
 * `TopoDS_Shape` objects live in a per-instance store behind
 * {@link createSolidTag}, so no OCCT shape, class, or type ever crosses the
 * package boundary. The initialized engine arrives as an opaque
 * {@link OcctRuntime} (see `./occt-runtime`), never as a raw instance.
 *
 * ## Validation is load-bearing (the pre-spike's core warning)
 *
 * OCCT silently accepts negative, zero-with-wrong-sign, and NaN dimensions
 * — `MakeBox(-1, 2, 3)` happily builds the mirrored 1×2×3 box and NaN input
 * produces odd geometry rather than an error. Unlike Manifold, the engine
 * will NOT rescue degenerate input, so every length is converted and
 * validated BEFORE any OCCT constructor call, and a rejection never reaches
 * the WASM boundary. The validators return structured failures directly;
 * cad-core's `valueIn` throws for non-finite magnitudes (only
 * dynamically-parsed values can carry them) are caught by the validators
 * themselves and normalized into the same structured codes the sibling
 * kernels produce (`kernel/invalid-length`, plus `kernel/invalid-rotation`
 * for degenerate rotation axes/angles).
 *
 * ## Cone composition (no bound `BRepPrimAPI_MakeCone`)
 *
 * This binding ships no cone primitive, so `createCone` composes the
 * frustum exactly: a planar profile in the xz half-plane — from the axis at
 * z = 0, out to `bottomRadius`, up the slant to `topRadius` at z = height,
 * back to the axis (the sharp cone collapses the duplicate axis vertex into
 * a triangle) — is built as a wire, faced, and revolved a full 2π about
 * the z axis with `BRepPrimAPI_MakeRevol`. The revolve of a planar profile
 * produces exact analytic conical surfaces: probed volumes match the
 * analytic frustum/cone formulas to 0 and ~2e-16 relative error, and bounds
 * are exact — primitive-grade exactness, no discretization anywhere.
 *
 * ## Transform (translation + the contract's rotation extension)
 *
 * `transform` composes one `gp_Trsf`: `SetRotation` about the world-origin
 * `gp_Ax1` of the optional rotation, `SetTranslation` for the vector, then
 * `transTrsf.Multiplied(rotTrsf)` — the composition that applies the
 * rotation FIRST and the world-space translation SECOND, exactly as the
 * contract's `TransformInput` documents. `BRepBuilderAPI_Transform` with
 * `copyGeom = false` represents the rigid result as the input's shared
 * TShape under a new location (OCCT's native rigid-transform form); the
 * mesh extractor bakes the location into world-space vertices (probed on
 * translated and rotated solids).
 *
 * ## Empty solids (measurement-based detection)
 *
 * OCCT's failed/degenerate booleans return NON-null shapes: a disjoint
 * intersect is an empty compound — `IsNull()` is false, the volume measures
 * exactly 0, `BRepBndLib.AddOptimal` leaves the `Bnd_Box` void, and the
 * mesh extractor yields zero vertices. Emptiness is therefore detected by
 * measurement, never by `IsNull`: `volume` reads the measured 0,
 * `tessellate` returns the empty soup, and `bounds` fails with
 * `kernel/bounds-empty` on the void box — the contract's empty-solid rules.
 *
 * ## WASM memory discipline (the heap floor and the delete protocol)
 *
 * The runtime preallocates a 100 MB linear heap (see `./occt-runtime`);
 * it never shrinks and every bound class is an embind wrapper over it.
 * Discipline, mirroring the pre-spike findings:
 *
 * - Every builder, algorithm, `gp_*` value, property frame, and mesh frame
 *   this module constructs is `.delete()`d on its operation's success path,
 *   exactly once, after its result is extracted; payload shapes are deleted
 *   in `dispose`. Intermediate boolean/transform results are deleted as
 *   soon as the next fold step consumes them. TopoDS handles are
 *   reference-counted on the C++ side, so derived results keep shared
 *   TShapes alive after their operand wrappers are freed (probed). On the
 *   rare error path mid-operation, not-yet-deleted intermediates leak until
 *   the process ends — the accepted cost of keeping success paths exact and
 *   error paths throwing nothing.
 * - `tessellate` reads the extractor's packed arrays through views taken
 *   fresh off `oc.wasmMemory.buffer` (cached views detach when the heap
 *   grows) and copies them into plain arrays immediately, before any
 *   further call that could allocate — returned buffers never alias WASM
 *   memory.
 *
 * ## Normals
 *
 * `tessellate` emits kernel-computed vertex normals through the contract's
 * optional `normals` payload: the extractor triangulates per face
 * (crease-exact by construction — planar faces carry their one exact face
 * normal, e.g. the plate's −x face normal is exactly `[-1, 0, 0]`) and
 * provides one single-precision unit normal per vertex, copied out next to
 * the positions. Empty solids omit `normals` along with their positions.
 *
 * ## Determinism
 *
 * The single-thread build is pthread-free; identical operation chains
 * produce byte-identical buffers within a JavaScript context (probed, and
 * pinned by tests). OCCT results are not stable across OCCT *versions* —
 * the binding is pinned to `1.1.0` and upgrades are regeneration events.
 *
 * ## STEP import (Phase 21.3)
 *
 * `importStep` extends the contract surface with the `step.import` worker
 * operation's execution backend: raw file bytes in, provenance-marked
 * geometry-only solids out (each answerable to every operation above). The
 * reading mechanics — the virtual-file round trip, the structural failure
 * taxonomy, the verified unit canonicalization, and the name/color metadata
 * scope boundary — live in `./occt-step-import`; this layer only wraps the
 * extracted shapes into the instance's own handle store so they dispose
 * like any other solid.
 *
 * ## STEP export (Phase 21.4)
 *
 * `exportStep` is the `step.export` operation's execution backend: one or
 * more owned solids in, deterministic STEP Part 21 bytes out. The writing
 * mechanics — the AsIs/AP214 protocol stance, the timestamp/product-counter
 * neutralization that makes the bytes deterministic, the unit and schema
 * options with their process-global restore, and the structured
 * `step-export/*` failure taxonomy — live in `./occt-step-export`; this
 * layer resolves the handles (a foreign or disposed one fails with the
 * kernel's universal `kernel/solid-not-owned`, exactly like every other
 * operation) and owns the empty-list rejection.
 *
 * ## BREP exchange (Phase 21.5)
 *
 * `importBrep`/`exportBrep` are the `brep.import`/`brep.export` operations'
 * execution backends over OCCT's own native BREP form, and they wrap the
 * same provenance discipline as their STEP twins: imported solids carry the
 * literal `"imported-brep"` origin. The exchange mechanics — the
 * string-based `BRepToolsWrapper`, the deterministic-unneutralized output,
 * the compound multi-shape carrier, and the structured `brep-*` failure
 * taxonomy — live in `./occt-brep`; this layer resolves handles and wraps
 * extracted shapes exactly like the STEP pair.
 */

import type { AngleValue, LengthValue, ParseResult } from "@slopcad/cad-core";
import { fail, ok, valueIn } from "@slopcad/cad-core";
import type { TopoDS_Edge, TopoDS_Shape } from "replicad-opencascadejs";
import {
  type BoxInput,
  type ConeInput,
  type CylinderInput,
  type GeometryKernel,
  type KernelBounds,
  type KernelCapabilities,
  type KernelError,
  type KernelErrorCode,
  type KernelResult,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  type SphereInput,
  type Tessellation,
  type TransformInput,
} from "@slopcad/cad-kernel";
import { createSolidTag } from "@slopcad/cad-kernel";

import { OCCT_BACKEND_ID } from "./occt-backend";
import {
  BREP_EXPORT_ERROR_CODES,
  BREP_IMPORT_ERROR_CODES,
  type BrepExportError,
  type BrepImportError,
  exportBrepShapes,
  importBrepShapes,
} from "./occt-brep";
import {
  createOcctRuntime,
  type OcctRuntime,
  RUNTIME_BRAND,
} from "./occt-runtime";
import {
  exportStepShapes,
  STEP_EXPORT_ERROR_CODES,
  type StepExportError,
  type StepExportOptions,
} from "./occt-step-export";
import {
  importStepShapes,
  STEP_IMPORT_ERROR_CODES,
  type StepImportError,
} from "./occt-step-import";

/**
 * Capabilities of the OpenCascade kernel, honestly declared:
 *
 * - Booleans run as exact BREP operations (`booleans`).
 * - Translation AND rotation are accepted by `transform` — rotation about
 *   the world origin, composed before the translation, exact to double
 *   precision (`transformTranslation`, `transformRotation`).
 * - Scale stays `false`: uniform scaling exists in `gp_Trsf`, but the
 *   contract carries no scale input, so there is nothing to declare — and
 *   non-uniform scaling (`BRepBuilderAPI_GTransform`) is not bound in this
 *   build at all.
 * - Volumes come from exact BREP integration (`BRepGProp`): primitives
 *   analytic, booleans exact — probed at 0 relative error on the
 *   plate-with-hole, i.e. inside the contract suite's 1e-9 exact bands
 *   (`exactPrimitiveVolumes`, `exactBooleanVolumes`).
 * - Bounds come from `BRepBndLib.AddOptimal` over exact geometry: tight for
 *   primitives and boolean results alike, including rotated bounds
 *   (`tightBooleanBounds`).
 * - The full `TopoDS` face/edge/vertex topology survives every operation
 *   (`persistentTopology`) — declared now; the reference model that
 *   consumes stable topology identities is Phase 22's work.
 */
export const OCCT_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: true,
  transformScale: false,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: true,
  tightBooleanBounds: true,
  persistentTopology: true,
});

/**
 * Linear deflection (mm) passed to the mesh extractor: the maximum distance
 * a triangle edge may deviate from the true curved geometry. 0.1 mm is the
 * value the Phase 21 pre-spike probed on the plate-with-hole (120 exact
 * planar triangles, curved bores discretized within a tenth of a
 * millimetre).
 */
export const OCCT_TESSELLATION_LINEAR_DEFLECTION_MM = 0.1;

/**
 * Angular deflection (radians) passed to the mesh extractor: the maximum
 * angle between consecutive mesh segments on a curved edge. 0.5 rad is the
 * pre-spike-probed companion of the linear deflection above.
 */
export const OCCT_TESSELLATION_ANGULAR_TOLERANCE_RAD = 0.5;

/**
 * The per-handle payload: the OCCT shape, or `null` once the handle was
 * disposed (subsequent operations read as `kernel/solid-not-owned`, the
 * same code that guards foreign handles).
 */
interface SolidPayload {
  shape: TopoDS_Shape | null;
}

/**
 * One solid of a successful STEP import, with its data-level provenance:
 * `origin` is the literal the plan's "clearly distinguish imported geometry
 * from native parametric history" compiles down to. An imported solid is
 * geometry-only BREP — it answers every `GeometryKernel` operation exactly
 * like a feature-built one (bounds, volume, tessellation, dispose), but
 * NOTHING in the payload or anywhere behind it carries a feature, a
 * parameter, or construction history, and the type system makes that
 * absence part of the result: a consumer holding an
 * {@link ImportedStepSolid} knows where its geometry came from.
 */
export interface ImportedStepSolid {
  readonly solid: KernelSolid;
  readonly origin: "imported-step";
}

/**
 * The result of importing a STEP file: one provenance-marked solid per
 * `TopAbs_SOLID` in the file, in file order, in canonical millimetres (the
 * binding's unit canonicalization — see `./occt-step-import` for the
 * verified unit behavior and the name/color metadata scope boundary).
 */
export interface ImportedStepModel {
  readonly solids: readonly ImportedStepSolid[];
}

/**
 * One solid of a successful BREP import, with the same data-level
 * provenance discipline as the STEP twin: `origin` is the literal marking
 * the geometry as imported BREP — answerable to every `GeometryKernel`
 * operation, backed by no feature, parameter, or construction history
 * anywhere.
 */
export interface ImportedBrepSolid {
  readonly solid: KernelSolid;
  readonly origin: "imported-brep";
}

/**
 * The result of importing an OCCT BREP file: one provenance-marked solid
 * per `TopAbs_SOLID` in the file, in file order. The kernel's canonical
 * millimetre IS the BREP form's native unit — coordinates pass through the
 * string round trip unchanged (see `./occt-brep`).
 */
export interface ImportedBrepModel {
  readonly solids: readonly ImportedBrepSolid[];
}

/**
 * The OpenCascade kernel's own surface: the full kernel contract plus the
 * STEP and BREP exchange extensions (`step.import`/`step.export` and
 * `brep.import`/`brep.export`'s execution backends). OCCT types stay
 * inside; the extensions' results are kernel-neutral.
 */
export interface OcctKernel extends GeometryKernel {
  /**
   * Imports raw STEP file bytes into provenance-marked geometry-only
   * solids. Structured `step-import/*` failures on every rejection — no
   * throw, no fabricated history — with the virtual-file mechanics of the
   * reader handled inside the boundary.
   */
  importStep(
    bytes: Uint8Array,
  ): ParseResult<ImportedStepModel, StepImportError>;

  /**
   * Exports one or more owned solids into ONE deterministic STEP Part 21
   * file's bytes (same solids in, same bytes out — see `./occt-step-export`
   * for the neutralized writer fields). A foreign or disposed handle fails
   * with the kernel's universal `kernel/solid-not-owned`; an empty list and
   * every export-specific rejection fail with structured `step-export/*`
   * codes; nothing throws.
   */
  exportStep(
    solids: readonly KernelSolid[],
    options?: StepExportOptions,
  ): ParseResult<Uint8Array, StepExportError | KernelError>;

  /**
   * Imports raw OCCT BREP file bytes into provenance-marked geometry-only
   * solids — the STEP twin over OCCT's native form. Structured
   * `brep-import/*` failures on every rejection; nothing throws, and no
   * filesystem state is touched (the string API bypasses the virtual
   * filesystem entirely).
   */
  importBrep(
    bytes: Uint8Array,
  ): ParseResult<ImportedBrepModel, BrepImportError>;

  /**
   * Exports one or more owned solids into ONE deterministic OCCT ASCII
   * BREP file's bytes (a single solid writes itself; more ride in a
   * compound — see `./occt-brep`). A foreign or disposed handle fails with
   * the kernel's universal `kernel/solid-not-owned`; an empty list and
   * every export-specific rejection fail with structured `brep-export/*`
   * codes; nothing throws.
   */
  exportBrep(
    solids: readonly KernelSolid[],
  ): ParseResult<Uint8Array, BrepExportError | KernelError>;
}

/**
 * Structural type of the pairwise boolean constructors this adapter folds
 * over (`BRepAlgoAPI_Fuse/Cut/Common`): embind classes satisfy it without
 * any casts, keeping the fold kernel-side generic.
 */
interface BooleanBuilder {
  new (
    shape1: TopoDS_Shape,
    shape2: TopoDS_Shape,
  ): {
    IsDone(): boolean;
    Shape(): TopoDS_Shape;
    delete(): void;
  };
}

function kernelError(code: KernelErrorCode, message: string): KernelError {
  return { code, message, input: null };
}

/**
 * Creates an OpenCascade kernel bound to an initialized runtime. Handles
 * are owned per instance; create one per evaluation context. Use
 * {@link createOcctKernel} for the async one-call form.
 */
export function occtKernelFromRuntime(runtime: OcctRuntime): OcctKernel {
  const oc = runtime[RUNTIME_BRAND];
  const tag = createSolidTag<SolidPayload>();

  const wrapSolid = (shape: TopoDS_Shape): KernelSolid => tag.wrap({ shape });

  const shapeOf = (
    solid: KernelSolid,
    operation: string,
  ): KernelResult<TopoDS_Shape> => {
    const payload = tag.unwrap(solid);
    if (payload === undefined || payload.shape === null) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.solidNotOwned,
          `${operation} rejected a solid handle that this kernel instance did not create (or has already disposed).`,
        ),
      );
    }
    return ok(payload.shape);
  };

  // --- input validators: run BEFORE any OCCT call (the silent-mirror trap)

  /**
   * Normalizes a `valueIn` throw (non-finite magnitude — only dynamically
   * parsed values can carry one) into the structured invalid-length
   * failure, so degenerate input never reaches an OCCT constructor.
   */
  const lengthIn = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    try {
      return ok(valueIn(value, "mm"));
    } catch {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidLength,
          `${operation} rejected ${name}: its magnitude is not a finite number.`,
        ),
      );
    }
  };

  const positiveLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    const mm = lengthIn(value, name, operation);
    if (!mm.ok) return fail(mm.error);
    if (!(mm.value > 0)) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidLength,
          `${operation} rejected ${name} ${mm.value} mm: it must be strictly positive.`,
        ),
      );
    }
    return mm;
  };

  const nonNegativeLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    const mm = lengthIn(value, name, operation);
    if (!mm.ok) return fail(mm.error);
    if (!(mm.value >= 0)) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidLength,
          `${operation} rejected ${name} ${mm.value} mm: it must not be negative.`,
        ),
      );
    }
    return mm;
  };

  const angleIn = (
    value: AngleValue,
    operation: string,
  ): KernelResult<number> => {
    try {
      return ok(valueIn(value, "rad"));
    } catch {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidRotation,
          `${operation} rejected a rotation whose angle magnitude is not a finite number.`,
        ),
      );
    }
  };

  /**
   * The smallest positive NORMAL double (2⁻¹⁰²² ≈ 2.225e-308): the floor a
   * rotation axis's squared magnitude must clear for OCCT's `gp_Dir`
   * normalization to preserve direction. `gp_Dir` normalizes by
   * `sqrt(x² + y² + z²)` computed in double precision (probed on this WASM
   * binding): an axis whose squared magnitude underflows to 0 — e.g.
   * `[0, 0, 1e-300]` — throws `Standard_ConstructionError` inside the WASM
   * boundary, one whose squared magnitude lands in the denormal range below
   * this floor is accepted but its direction comes out off-unit (probed:
   * `[0, 0, 1e-161]` yields direction z = 1.006, degrading without bound
   * toward the floor's bottom), and one whose squared magnitude overflows
   * to Infinity — e.g. `[1e200, 0, 0]` — yields a silent NULL direction
   * `[0, 0, 0]`. Every axis at or above the floor normalizes exactly (probed:
   * `[0, 0, m]` yields direction z === 1 down to m = 2⁻⁵¹¹ = sqrt(2⁻¹⁰²²) ≈
   * 1.49e-154, including `[0, 0, 1e-150]`), so the guard admits exactly the
   * machine-exact fringe and rejects everything that would throw or silently
   * mis-normalize — before any OCCT call.
   */
  const NORMALIZABLE_AXIS_MIN_SQUARED_MAGNITUDE = 2 ** -1022;

  const axisIn = (
    axis: readonly [number, number, number],
    operation: string,
  ): KernelResult<readonly [number, number, number]> => {
    const [x, y, z] = axis;
    if (
      x === undefined ||
      y === undefined ||
      z === undefined ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      (x === 0 && y === 0 && z === 0)
    ) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidRotation,
          `${operation} rejected a rotation about [${String(x)}, ${String(y)}, ${String(z)}]: the axis must be a non-zero finite vector.`,
        ),
      );
    }
    const squaredMagnitude = x * x + y * y + z * z;
    if (
      !Number.isFinite(squaredMagnitude) ||
      squaredMagnitude < NORMALIZABLE_AXIS_MIN_SQUARED_MAGNITUDE
    ) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidRotation,
          `${operation} rejected a rotation about [${String(x)}, ${String(y)}, ${String(z)}]: the axis magnitude cannot be normalized in double precision (squared magnitude ${squaredMagnitude} is zero, denormal, or infinite).`,
        ),
      );
    }
    return ok(axis);
  };

  const operandsOf = (
    solids: readonly KernelSolid[],
    minimum: number,
    operation: string,
  ): KernelResult<readonly TopoDS_Shape[]> => {
    if (solids.length < minimum) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          `${operation} rejected ${solids.length} operand(s): at least ${minimum} are required.`,
        ),
      );
    }
    const shapes: TopoDS_Shape[] = [];
    for (const solid of solids) {
      const shape = shapeOf(solid, operation);
      if (!shape.ok) return fail(shape.error);
      shapes.push(shape.value);
    }
    return ok(shapes);
  };

  /**
   * Runs one whole kernel operation inside the no-throw boundary: value
   * failures returned by validators pass through, and any thrown exception
   * — a binding-level error inside the WASM glue (catchable
   * `BindingError`s) included — is normalized into the structured failure
   * the operation's inputs map to. Raw exceptions never escape a kernel
   * operation.
   */
  const run = <T>(
    operation: string,
    code: KernelErrorCode,
    body: () => KernelResult<T>,
  ): KernelResult<T> => {
    try {
      return body();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(
        kernelError(
          code,
          `${operation} failed inside the OpenCascade kernel boundary: ${detail}`,
        ),
      );
    }
  };

  // --- geometry helpers (full .delete() discipline on success paths)

  /** Extracts a builder's result shape, then frees the builder. */
  const buildShape = (maker: {
    Shape(): TopoDS_Shape;
    delete(): void;
  }): TopoDS_Shape => {
    const shape = maker.Shape();
    maker.delete();
    return shape;
  };

  const newBox = (width: number, depth: number, height: number) =>
    buildShape(new oc.BRepPrimAPI_MakeBox(width, depth, height));

  const newSphere = (radius: number) =>
    buildShape(new oc.BRepPrimAPI_MakeSphere(radius));

  const newCylinder = (radius: number, height: number) =>
    buildShape(new oc.BRepPrimAPI_MakeCylinder(radius, height));

  /**
   * The cone composition (see the module doc): profile wire → face → full
   * revolve about z. Exact analytic result; every intermediate (points,
   * edges, wire, face, axis) is deleted as soon as it is consumed.
   */
  const newCone = (
    bottomRadius: number,
    topRadius: number,
    height: number,
  ): TopoDS_Shape => {
    const profile: readonly (readonly [number, number, number])[] =
      topRadius > 0
        ? [
            [0, 0, 0],
            [bottomRadius, 0, 0],
            [topRadius, 0, height],
            [0, 0, height],
          ]
        : [
            [0, 0, 0],
            [bottomRadius, 0, 0],
            [0, 0, height],
          ];
    const mkWire = new oc.BRepBuilderAPI_MakeWire();
    const edges: TopoDS_Edge[] = [];
    for (let i = 0; i < profile.length; i += 1) {
      const from = profile[i];
      const to = profile[(i + 1) % profile.length];
      if (from === undefined || to === undefined) {
        mkWire.delete();
        for (const edge of edges) edge.delete();
        throw new Error(
          "Invariant violation: the cone profile always yields point pairs.",
        );
      }
      const p1 = new oc.gp_Pnt(from[0], from[1], from[2]);
      const p2 = new oc.gp_Pnt(to[0], to[1], to[2]);
      const mkEdge = new oc.BRepBuilderAPI_MakeEdge(p1, p2);
      p1.delete();
      p2.delete();
      const edge = mkEdge.Edge();
      mkEdge.delete();
      mkWire.Add(edge);
      edges.push(edge);
    }
    if (!mkWire.IsDone()) {
      mkWire.delete();
      for (const edge of edges) edge.delete();
      throw new Error("cone profile wire did not close.");
    }
    const wire = mkWire.Wire();
    mkWire.delete();
    for (const edge of edges) edge.delete();
    const mkFace = new oc.BRepBuilderAPI_MakeFace(wire, true);
    if (!mkFace.IsDone()) {
      mkFace.delete();
      wire.delete();
      throw new Error("cone profile face did not build.");
    }
    const face = mkFace.Face();
    mkFace.delete();
    wire.delete();
    const origin = new oc.gp_Pnt(0, 0, 0);
    const direction = new oc.gp_Dir(0, 0, 1);
    const axis = new oc.gp_Ax1(origin, direction);
    origin.delete();
    direction.delete();
    const mkRevol = new oc.BRepPrimAPI_MakeRevol(
      face,
      axis,
      Math.PI * 2,
      false,
    );
    axis.delete();
    face.delete();
    if (!mkRevol.IsDone()) {
      mkRevol.delete();
      throw new Error("cone revolve did not build.");
    }
    return buildShape(mkRevol);
  };

  /**
   * Folds a pairwise boolean constructor over the operands (the binding has
   * no n-ary builder): `b(b(b(a₀, a₁), a₂), …)`. Operand payloads are never
   * deleted here — only fold intermediates, each as soon as the next step
   * has consumed it.
   */
  const foldBoolean = (
    shapes: readonly TopoDS_Shape[],
    Builder: BooleanBuilder,
    operation: string,
  ): TopoDS_Shape => {
    const first = shapes[0];
    if (first === undefined) {
      throw new Error(
        "Invariant violation: operand validation guarantees a non-empty list.",
      );
    }
    let acc = first;
    for (let i = 1; i < shapes.length; i += 1) {
      const operand = shapes[i];
      if (operand === undefined) {
        if (i > 1) acc.delete();
        throw new Error(
          "Invariant violation: the operand list was validated to be dense.",
        );
      }
      const algo = new Builder(acc, operand);
      if (!algo.IsDone()) {
        algo.delete();
        if (i > 1) acc.delete();
        throw new Error(
          `${operation}: the boolean build of operand ${i + 1} did not complete.`,
        );
      }
      const next = algo.Shape();
      algo.delete();
      if (i > 1) acc.delete();
      acc = next;
    }
    return acc;
  };

  const volumeOfShape = (shape: TopoDS_Shape): number => {
    const props = new oc.GProp_GProps();
    try {
      oc.BRepGProp.VolumeProperties(shape, props, true, false, false);
      return props.Mass();
    } finally {
      props.delete();
    }
  };

  return {
    id: OCCT_BACKEND_ID,
    capabilities: OCCT_KERNEL_CAPABILITIES,

    createBox(input: BoxInput): KernelResult<KernelSolid> {
      return run("createBox", KERNEL_ERROR_CODES.invalidLength, () => {
        const width = positiveLength(input.width, "width", "createBox");
        if (!width.ok) return fail(width.error);
        const depth = positiveLength(input.depth, "depth", "createBox");
        if (!depth.ok) return fail(depth.error);
        const height = positiveLength(input.height, "height", "createBox");
        if (!height.ok) return fail(height.error);
        return ok(wrapSolid(newBox(width.value, depth.value, height.value)));
      });
    },

    createSphere(input: SphereInput): KernelResult<KernelSolid> {
      return run("createSphere", KERNEL_ERROR_CODES.invalidLength, () => {
        const radius = positiveLength(input.radius, "radius", "createSphere");
        if (!radius.ok) return fail(radius.error);
        return ok(wrapSolid(newSphere(radius.value)));
      });
    },

    createCylinder(input: CylinderInput): KernelResult<KernelSolid> {
      return run("createCylinder", KERNEL_ERROR_CODES.invalidLength, () => {
        const radius = positiveLength(input.radius, "radius", "createCylinder");
        if (!radius.ok) return fail(radius.error);
        const height = positiveLength(input.height, "height", "createCylinder");
        if (!height.ok) return fail(height.error);
        return ok(wrapSolid(newCylinder(radius.value, height.value)));
      });
    },

    createCone(input: ConeInput): KernelResult<KernelSolid> {
      return run("createCone", KERNEL_ERROR_CODES.invalidLength, () => {
        const bottomRadius = positiveLength(
          input.bottomRadius,
          "bottomRadius",
          "createCone",
        );
        if (!bottomRadius.ok) return fail(bottomRadius.error);
        const topRadius = nonNegativeLength(
          input.topRadius,
          "topRadius",
          "createCone",
        );
        if (!topRadius.ok) return fail(topRadius.error);
        const height = positiveLength(input.height, "height", "createCone");
        if (!height.ok) return fail(height.error);
        return ok(
          wrapSolid(newCone(bottomRadius.value, topRadius.value, height.value)),
        );
      });
    },

    union(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      return run("union", KERNEL_ERROR_CODES.invalidOperands, () => {
        const shapes = operandsOf(operands, 2, "union");
        if (!shapes.ok) return fail(shapes.error);
        return ok(
          wrapSolid(foldBoolean(shapes.value, oc.BRepAlgoAPI_Fuse, "union")),
        );
      });
    },

    subtract(
      target: KernelSolid,
      tools: readonly KernelSolid[],
    ): KernelResult<KernelSolid> {
      return run("subtract", KERNEL_ERROR_CODES.invalidOperands, () => {
        const targetShape = shapeOf(target, "subtract");
        if (!targetShape.ok) return fail(targetShape.error);
        const toolShapes = operandsOf(tools, 1, "subtract");
        if (!toolShapes.ok) return fail(toolShapes.error);
        return ok(
          wrapSolid(
            foldBoolean(
              [targetShape.value, ...toolShapes.value],
              oc.BRepAlgoAPI_Cut,
              "subtract",
            ),
          ),
        );
      });
    },

    intersect(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      return run("intersect", KERNEL_ERROR_CODES.invalidOperands, () => {
        const shapes = operandsOf(operands, 2, "intersect");
        if (!shapes.ok) return fail(shapes.error);
        return ok(
          wrapSolid(
            foldBoolean(shapes.value, oc.BRepAlgoAPI_Common, "intersect"),
          ),
        );
      });
    },

    transform(
      solid: KernelSolid,
      input: TransformInput,
    ): KernelResult<KernelSolid> {
      return run("transform", KERNEL_ERROR_CODES.invalidLength, () => {
        const shape = shapeOf(solid, "transform");
        if (!shape.ok) return fail(shape.error);
        // Every component is validated before any OCCT object exists.
        const x = lengthIn(input.x, "x", "transform");
        if (!x.ok) return fail(x.error);
        const y = lengthIn(input.y, "y", "transform");
        if (!y.ok) return fail(y.error);
        const z = lengthIn(input.z, "z", "transform");
        if (!z.ok) return fail(z.error);
        const vec = new oc.gp_Vec(x.value, y.value, z.value);
        const translationTrsf = new oc.gp_Trsf();
        translationTrsf.SetTranslation(vec);
        vec.delete();
        let trsf = translationTrsf;
        if (input.rotation !== undefined) {
          const axis = axisIn(input.rotation.axis, "transform");
          if (!axis.ok) {
            trsf.delete();
            return fail(axis.error);
          }
          const angle = angleIn(input.rotation.angle, "transform");
          if (!angle.ok) {
            trsf.delete();
            return fail(angle.error);
          }
          const origin = new oc.gp_Pnt(0, 0, 0);
          const direction = new oc.gp_Dir(
            axis.value[0],
            axis.value[1],
            axis.value[2],
          );
          const rotationAxis = new oc.gp_Ax1(origin, direction);
          origin.delete();
          direction.delete();
          const rotationTrsf = new oc.gp_Trsf();
          rotationTrsf.SetRotation(rotationAxis, angle.value);
          rotationAxis.delete();
          // Multiplied composes so the RIGHT factor applies first: the
          // rotation about the world-origin axis, then the world-space
          // translation — exactly the order the contract's TransformInput
          // pins (probed: box(30,20,10) rotated 90° about z then translated
          // by (5,5,0) spans x ∈ [-15,5], y ∈ [5,35]).
          const combined = translationTrsf.Multiplied(rotationTrsf);
          rotationTrsf.delete();
          translationTrsf.delete();
          trsf = combined;
        }
        const moved = buildShape(
          new oc.BRepBuilderAPI_Transform(shape.value, trsf, false, true),
        );
        trsf.delete();
        return ok(wrapSolid(moved));
      });
    },

    bounds(solid: KernelSolid): KernelResult<KernelBounds> {
      const shape = shapeOf(solid, "bounds");
      if (!shape.ok) return fail(shape.error);
      const box = new oc.Bnd_Box();
      try {
        oc.BRepBndLib.AddOptimal(shape.value, box, false, false);
        // A void box is the measured signature of an empty solid (disjoint
        // booleans return non-null empty shapes) — IsNull is not.
        if (box.IsVoid()) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.boundsEmpty,
              "bounds rejected an empty solid: an empty set has no bounding box.",
            ),
          );
        }
        return ok({
          min: [box.GetXMin(), box.GetYMin(), box.GetZMin()],
          max: [box.GetXMax(), box.GetYMax(), box.GetZMax()],
        });
      } finally {
        box.delete();
      }
    },

    volume(solid: KernelSolid): KernelResult<number> {
      const shape = shapeOf(solid, "volume");
      if (!shape.ok) return fail(shape.error);
      // Exact BREP integration; an empty solid measures exactly 0.
      return ok(volumeOfShape(shape.value));
    },

    tessellate(solid: KernelSolid): KernelResult<Tessellation> {
      const shape = shapeOf(solid, "tessellate");
      if (!shape.ok) return fail(shape.error);
      const data = oc.ReplicadMeshExtractor.extract(
        shape.value,
        OCCT_TESSELLATION_LINEAR_DEFLECTION_MM,
        OCCT_TESSELLATION_ANGULAR_TOLERANCE_RAD,
        false,
      );
      try {
        if (data.getTrianglesSize() === 0) {
          return ok({ positions: [], indices: [] });
        }
        // Fresh views off the live wasmMemory (cached views detach on
        // growth), copied out immediately — no allocation between the view
        // and the copy. Sizes are element counts (probed): float32
        // positions/normals, uint32 triangle indices.
        const buffer = oc.wasmMemory.buffer;
        const positions = Array.from(
          new Float32Array(
            buffer,
            data.getVerticesPtr(),
            data.getVerticesSize(),
          ),
        );
        const normals = Array.from(
          new Float32Array(buffer, data.getNormalsPtr(), data.getNormalsSize()),
        );
        const indices = Array.from(
          new Uint32Array(
            buffer,
            data.getTrianglesPtr(),
            data.getTrianglesSize(),
          ),
        );
        return ok({ positions, indices, normals });
      } finally {
        data.delete();
      }
    },

    dispose(solid: KernelSolid): void {
      const payload = tag.unwrap(solid);
      if (payload === undefined || payload.shape === null) return;
      payload.shape.delete();
      payload.shape = null;
    },

    importStep(
      bytes: Uint8Array,
    ): ParseResult<ImportedStepModel, StepImportError> {
      // Same no-throw discipline as every operation: the reader boundary is
      // already total, and anything unexpected out of it is normalized into
      // the structured kernel-failure code rather than escaping.
      try {
        const shapes = importStepShapes(oc, bytes);
        if (!shapes.ok) return shapes;
        return ok({
          solids: shapes.value.shapes.map((shape) => ({
            solid: wrapSolid(shape),
            origin: "imported-step",
          })),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail({
          code: STEP_IMPORT_ERROR_CODES.kernelFailure,
          message: `STEP import failed inside the OpenCascade kernel boundary: ${detail}`,
          input: bytes,
        });
      }
    },

    exportStep(
      solids: readonly KernelSolid[],
      options?: StepExportOptions,
    ): ParseResult<Uint8Array, StepExportError | KernelError> {
      // Same no-throw discipline as every operation: handle resolution and
      // the writer boundary are both total, and anything unexpected out of
      // them is normalized into a structured step-export failure.
      if (solids.length === 0) {
        return fail({
          code: STEP_EXPORT_ERROR_CODES.empty,
          message:
            "exportStep rejected zero solids: there is no geometry to export.",
          input: null,
        });
      }
      try {
        const shapes: TopoDS_Shape[] = [];
        for (const solid of solids) {
          const shape = shapeOf(solid, "exportStep");
          if (!shape.ok) return fail(shape.error);
          shapes.push(shape.value);
        }
        return exportStepShapes(oc, shapes, options);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail({
          code: STEP_EXPORT_ERROR_CODES.kernelFailure,
          message: `STEP export failed inside the OpenCascade kernel boundary: ${detail}`,
          input: null,
        });
      }
    },

    importBrep(
      bytes: Uint8Array,
    ): ParseResult<ImportedBrepModel, BrepImportError> {
      // The STEP twin's no-throw discipline: the reader boundary is total,
      // and anything unexpected out of it is normalized into the structured
      // kernel-failure code rather than escaping.
      try {
        const shapes = importBrepShapes(oc, bytes);
        if (!shapes.ok) return shapes;
        return ok({
          solids: shapes.value.shapes.map((shape) => ({
            solid: wrapSolid(shape),
            origin: "imported-brep",
          })),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail({
          code: BREP_IMPORT_ERROR_CODES.kernelFailure,
          message: `BREP import failed inside the OpenCascade kernel boundary: ${detail}`,
          input: bytes,
        });
      }
    },

    exportBrep(
      solids: readonly KernelSolid[],
    ): ParseResult<Uint8Array, BrepExportError | KernelError> {
      if (solids.length === 0) {
        return fail({
          code: BREP_EXPORT_ERROR_CODES.empty,
          message:
            "exportBrep rejected zero solids: there is no geometry to export.",
          input: null,
        });
      }
      try {
        const shapes: TopoDS_Shape[] = [];
        for (const solid of solids) {
          const shape = shapeOf(solid, "exportBrep");
          if (!shape.ok) return fail(shape.error);
          shapes.push(shape.value);
        }
        return exportBrepShapes(oc, shapes);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail({
          code: BREP_EXPORT_ERROR_CODES.kernelFailure,
          message: `BREP export failed inside the OpenCascade kernel boundary: ${detail}`,
          input: null,
        });
      }
    },
  };
}

/**
 * Creates a fresh OpenCascade kernel, initializing (or reusing) the shared
 * WASM runtime first. The canonical entry for callers without a
 * pre-initialized runtime; tests that create many kernels should
 * pre-initialize via `createOcctRuntime()` and close over
 * {@link occtKernelFromRuntime} instead.
 */
export async function createOcctKernel(): Promise<OcctKernel> {
  const runtime = await createOcctRuntime();
  return occtKernelFromRuntime(runtime);
}
