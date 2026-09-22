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
 * ## Profile extrusion (Phase 26.1)
 *
 * `extrude` is the EXACT prism path the contract's fidelity honesty
 * promises: each profile segment becomes an exact edge (lines between
 * points; arcs and circles from a `gp_Circ` on the local frame's
 * `gp_Ax2` trimmed by `GC_MakeArcOfCircle` at the segment's angles), the
 * wire is faced and `BRepPrimAPI_MakePrism` extrudes it along local z
 * (direction −1 sweeps toward −z), and the placement reuses the transform
 * composition (rotation first about the world-origin axis, translation
 * second). Volumes of curved profiles are therefore exact (analytic
 * cylinders), not chord-fan approximations. Structural profile validation
 * (closure, non-degeneracy) runs BEFORE any OCCT call per the
 * silent-mirror rule; the shared tessellation constant is imported only to
 * document fidelity parity with the mesh kernels, not for geometry.
 *
 * ## Profile sweep (Phase 26.3)
 *
 * `sweep` is the EXACT pipe path: the path chain becomes a spine wire of
 * exact edges in the local XZ plane (CCW in (x, z) = CCW about the −ŷ
 * circle normal, probed; clockwise arcs mirror the plane; a full-turn arc
 * is the whole-circle edge), and `BRepOffsetAPI_MakePipeShell` in
 * corrected-Frenet mode carries the exact profile wire along it — for
 * planar spines that is the contract's fixed-binormal transport, no twist.
 * Probed: a straight spine prisms to the offset-cylinder volume at 0
 * relative error, a quarter-arc spine hits the Pappus value exactly, and a
 * closed circular spine builds the exact torus. The shared validation
 * battery (path structure, chord self-intersection, the per-arc
 * bend-axis crossing) rejects BEFORE any OCCT call; a pipe OCCT cannot
 * make solid (`MakeSolid` false) throws inside the no-throw boundary and
 * maps to the structured profile failure.
 *
 * ## Profile loft (Phase 26.4)
 *
 * `loft` is the EXACT ruled-loft path: each section's loop becomes the
 * same exact wire `extrude` builds (lines, angularly-trimmed arcs, full
 * circles), lifted to its station z, and
 * `BRepOffsetAPI_ThruSections(isSolid, ruled = true)` joins consecutive
 * sections with RULED surfaces — the piecewise-linear-per-span transport
 * the contract pins (the smooth default would blend ACROSS stations, a
 * different solid). Probed: a prismatic loft equals the prism volume at 0
 * relative error, concentric circles give the exact conical frustum
 * `πh(R² + Rr + r²)/3`, the twisted square the exact Simpson
 * (prismoidal) value of the vertex morph — and a start-vertex-rotated
 * (re-phased) square→square loft the index morph's Simpson value 2000/3,
 * the correspondence the ADAPTER enforces: ThruSections' own
 * wire-compatibility pass re-origins a later wire on a PHASE shift
 * alone, identical segment structure included (probed: left at its
 * default it de-twists the re-phased square to the prism — 1000 mm³, not
 * 2000/3), so `CheckCompatibility(false)` disables the pass on
 * equal-segment-count collections and the wires rule edge i ↔ edge i in
 * authored order. With the pass off the engine no longer reconciles
 * winding either — a CW member against a CCW one silently builds an
 * EMPTY solid (probed volume 0) — so each section wire is CCW-normalized
 * first, the authored-CW wire carried REVERSED (the same normalization
 * the contract's chord polygons apply; probed to reproduce the reference
 * kernel's morph phase exactly). Collections whose segment counts differ
 * (equal chord counts: a circle and its authored 63-gon) keep the pass ON
 * for the edge repartition their correspondence needs — probed: with the
 * pass off that class silently builds volume 0 too — and the contract
 * scopes that class's correspondence to each engine's own
 * parameterization; the contract's vertex-count rule rejects mismatched
 * collections before any engine call, so the pass never sees a chord
 * count the rule has not already pinned.
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
 * ## Mirror (Phase 26.9)
 *
 * `mirror` builds one `gp_Trsf` whose `SetMirror` is the PLANE reflection
 * through the `gp_Ax2` at the offset point, normal to the selected axis,
 * and applies it with the same `BRepBuilderAPI_Transform` — the negative
 * determinant is not a rigid location, so the engine rebuilds the oriented
 * geometry itself (probed: the mirrored box measures its exact POSITIVE
 * GProp volume with outward tessellation normals).
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
 *
 * ## Topology snapshots (Phase 22)
 *
 * `topologySnapshot` is the persistent-reference resolution protocol's
 * execution backend: one owned solid in, a kernel-neutral
 * `TopologySnapshot` out (identity payloads, body-relative measures,
 * occurrence-collapsed ordinals). The exploration and measurement mechanics
 * — and the identity-stability experiments that shaped them — live in
 * `./occt-topology`; this layer resolves the handle and validates the
 * options, exactly like the exchange extensions.
 */

import type {
  AngleValue,
  BodyId,
  LengthValue,
  ParseResult,
  TopologyReferenceKind,
  TopologySnapshot,
} from "@slopcad/cad-core";
import { fail, ok, valueIn } from "@slopcad/cad-core";
import type {
  BRepBuilderAPI_MakeEdge,
  gp_Pnt,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Wire,
} from "replicad-opencascadejs";
import {
  type BoxInput,
  type ChamferInput,
  type ConeInput,
  type CylinderInput,
  type FilletInput,
  type GeometryKernel,
  type HelixSweepInput,
  type KernelBounds,
  type KernelCapabilities,
  type KernelError,
  type KernelErrorCode,
  type KernelResult,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  type MirrorInput,
  type ProfileExtrudeInput,
  type ProfileLoftInput,
  type ProfileLoftSectionInput,
  type ProfileRevolveInput,
  type ProfileSweepInput,
  type ShellInput,
  type SphereInput,
  type SweepPathSegmentInput,
  type Tessellation,
  type ThickenInput,
  type TransformInput,
} from "@slopcad/cad-kernel";
import {
  axisAngleMatrix,
  helixProfilePolygon,
  helixStations,
  helixSweepProblem,
  helixTransportPoint,
  type CanonicalHelixSpine,
  loftSectionsProblem,
  loftStations,
  normalizeRevolveAxis,
  polygonSignedArea,
  profileLoopProblem,
  revolveCrossesAxis,
  revolveSignedExtremes,
  splineBezierChain,
  sweepArcSignedSweep,
  sweepPathProblem,
  sweepPathSelfIntersects,
  sweepProfileArcAxisCrossing,
  taperedExtrudeProblem,
  tessellateProfileLoop,
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
  OCCT_TOPOLOGY_DEFAULT_KINDS,
  OCCT_TOPOLOGY_IDENTITY_SCHEMA,
  occtEdgesAtOrdinals,
  occtFacesAtOrdinals,
  occtShapeTopology,
} from "./occt-topology";
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
 * - The Phase 26.3 sweep is the exact pipe path
 *   (`BRepOffsetAPI_MakePipeShell`, probed: straight spines prism exactly,
 *   arc spines hit the Pappus values at 0 relative error, closed circular
 *   spines build exact tori) (`sweep`).
 * - The Phase 40 helical sweep rules the EXACT meridian stations and
 *   lofts between them (`BRepOffsetAPI_ThruSections` in ruled mode): every
 *   station wire is the profile transported by the contract's meridian
 *   motion, exact analytic geometry, and the ruled spans approximate the
 *   screw motion between stations — the volume sits at the derived chord
 *   band `sin(Δθ)/Δθ` of the exact screw value (the ruled span's Jacobian
 *   is `(R+u)·sinΔθ` against the true `(R+u)·Δθ` — the same 63-chord
 *   class the mesh kernels' revolves document), pinned in the fixtures.
 *   The exact analytic SPINE is buildable on this binding (a
 *   `Geom2d_Line` in `Geom_CylindricalSurface`/`Geom_ConicalSurface`
 *   parametric space through the pcurve `MakeEdge` overload — probed), but
 *   `MakePipeShell` carries section-perpendicular profiles, and the
 *   meridian profile is never perpendicular to the tangent, so the pipe
 *   over the exact spine is a provably different solid — the ruled-station
 *   route is the honest exactness the contract pins (`helix`).
 * - The Phase 26.4 loft is the exact ruled loft
 *   (`BRepOffsetAPI_ThruSections`, probed: a prism loft equals the prism,
 *   concentric circles give the exact frustum, the twisted square the
 *   exact Simpson value of the vertex morph, and the re-phased square the
 *   index morph's 2000/3 — the adapter-enforced correspondence) (`loft`).
 * - The Phase 26.5 fillet is the exact BREP fillet
 *   (`BRepFilletAPI_MakeFillet`, probed: a box corner-edge fillet measures
 *   the analytic `W·D·H − r²(1−π/4)·L` at 0 relative error, an oversized
 *   radius fails `IsDone` cleanly into the structured fillet failure, and
 *   a zero radius never reaches the engine — pre-validated) (`fillet`).
 * - The Phase 26.6 chamfer is the exact BREP chamfer
 *   (`BRepFilletAPI_MakeChamfer`, the symmetric-distance `Add`, probed: a
 *   box corner-edge chamfer measures the analytic prism
 *   `W·D·H − d²/2·L` at 0 relative error — including a distance past the
 *   edge's own length — disjoint edges sum exactly, an oversized distance
 *   and interfering same-face chamfers fail `IsDone` cleanly into the
 *   structured chamfer failure, and the cylinder's seam edge THROWS inside
 *   the WASM boundary, which the no-throw `run` boundary normalizes into
 *   the same structured code) (`chamfer`).
 * - The Phase 26.7 shell is the exact BREP hollow
 *   (`BRepOffsetAPI_MakeThickSolid.MakeThickSolidByJoin` with the INWARD
 *   offset — probed: the positive offset builds an outward-thickened solid
 *   instead — a box opened at one face measures the analytic
 *   `W·D·H − (W−2t)(D−2t)(H−t)` at 0 relative error, the empty closing
 *   list returns the offset cavity region itself rather than hollow walls
 *   so the contract requires ≥1 removed face, and degenerate thicknesses
 *   never fail `IsDone` — the post-condition volume check and the no-throw
 *   boundary surface them structured instead) (`shell`).
 * - The Phase 26.9 mirror is the exact plane reflection
 *   (`gp_Trsf.SetMirror` over the `gp_Ax2` through the offset point
 *   normal to the axis, applied by `BRepBuilderAPI_Transform`; probed:
 *   the mirrored box measures its exact volume with POSITIVE GProp mass
 *   and outward tessellation normals — the engine handles the negative
 *   determinant's orientation itself) (`mirror`).
 * - The Phase 27.4 surface-area measurement integrates the BREP's
 *   surfaces exactly (`BRepGProp.SurfaceProperties` → `GProp_GProps.Mass`,
 *   the surface sibling of the volume integration; probed: the 30×20×10
 *   box measures exactly 2200 mm², the plate-with-bore exactly
 *   2 200 + 48π mm² at delta 0, an empty compound 0) (`surfaceArea`).
 */
export const OCCT_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: true,
  transformScale: true,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: true,
  tightBooleanBounds: true,
  persistentTopology: true,
  sweep: true,
  loft: true,
  helix: true,
  fillet: true,
  chamfer: true,
  shell: true,
  thicken: true,
  extrudeTaper: true,
  mirror: true,
  surfaceArea: true,
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
 * Options of the kernel's `topologySnapshot` operation (see
 * `./occt-topology` — the producing module and the measured facts behind
 * its design).
 */
export interface OcctTopologySnapshotOptions {
  /** The document body whose regeneration topology is being reported. */
  readonly bodyId: BodyId;
  /** The regeneration the snapshot stands for (a non-negative integer). */
  readonly regeneration: number;
  /** The kinds to report; defaults to faces, edges, and vertices. */
  readonly kinds?: readonly TopologyReferenceKind[];
}

/**
 * The OpenCascade kernel's own surface: the full kernel contract plus the
 * STEP and BREP exchange extensions (`step.import`/`step.export` and
 * `brep.import`/`brep.export`'s execution backends) and the Phase 22
 * `topologySnapshot` extension that backs cad-core's persistent-reference
 * resolution protocol. OCCT types stay inside; the extensions' results are
 * kernel-neutral.
 */
export interface OcctKernel extends GeometryKernel {
  /**
   * Reports one owned solid's current topology as a kernel-neutral
   * {@link TopologySnapshot}: identity payloads (the shape hash — a
   * within-regeneration identity by the Phase 22 experiments' finding),
   * body-relative geometric descriptors, occurrence-collapsed ordinals. A
   * foreign or disposed handle fails with the kernel's universal
   * `kernel/solid-not-owned`; an invalid regeneration fails with
   * `kernel/invalid-operands`; nothing throws.
   */
  topologySnapshot(
    solid: KernelSolid,
    options: OcctTopologySnapshotOptions,
  ): ParseResult<TopologySnapshot, KernelError>;

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
   * Builds the closed profile wire (Phase 26.1; Phase 36 curved kinds):
   * profile segments → exact edges (lines, angularly-trimmed arcs, full
   * circles on the local frame's gp_Ax2, full ellipses and trimmed
   * elliptical arcs on gp_Elips, and cubic Bézier pieces as
   * Geom_BezierCurve edges — the interpolated spline flavor converts to
   * its exact per-span Bézier equivalent first) in the plane at station `z`
   * (0 for the prism/revolve/pipe paths; a loft's sections build directly
   * at their own stations, no transform round trip). Shared by the prism,
   * revolution, pipe, and loft paths; every intermediate is deleted exactly
   * once on the success path, and failures throw inside the caller's
   * no-throw boundary.
   *
   * Probed exactness (the Phase 36 probe): an 8×4.5 ellipse prisms to
   * πab·h at 1e-13 relative error; a Bézier bow's face area matches the
   * analytic Green's theorem value exactly. The wire stays analytic
   * geometry — no tessellation crosses this boundary.
   */
  const profileWire = (
    loop: ProfileExtrudeInput["loop"],
    z = 0,
  ): TopoDS_Wire => {
    const mkWire = new oc.BRepBuilderAPI_MakeWire();
    const edges: TopoDS_Edge[] = [];
    const disposeWireAndEdges = (): void => {
      mkWire.delete();
      for (const edge of edges) edge.delete();
    };
    const addEdge = (mkEdge: BRepBuilderAPI_MakeEdge): void => {
      const edge = mkEdge.Edge();
      mkEdge.delete();
      mkWire.Add(edge);
      edges.push(edge);
    };
    for (const segment of loop) {
      if (segment.kind === "line") {
        const p1 = new oc.gp_Pnt(segment.start[0], segment.start[1], z);
        const p2 = new oc.gp_Pnt(segment.end[0], segment.end[1], z);
        addEdge(new oc.BRepBuilderAPI_MakeEdge(p1, p2));
        p1.delete();
        p2.delete();
        continue;
      }
      if (segment.kind === "ellipse" || segment.kind === "ellipticalArc") {
        const rotation = valueIn(segment.rotation, "rad");
        const origin = new oc.gp_Pnt(segment.center[0], segment.center[1], z);
        const normal = new oc.gp_Dir(0, 0, 1);
        const xDir = new oc.gp_Dir(Math.cos(rotation), Math.sin(rotation), 0);
        const ax2 = new oc.gp_Ax2(origin, normal, xDir);
        const elips = new oc.gp_Elips(ax2, segment.radiusX, segment.radiusY);
        origin.delete();
        normal.delete();
        xDir.delete();
        ax2.delete();
        if (segment.kind === "ellipse") {
          addEdge(new oc.BRepBuilderAPI_MakeEdge(elips));
          elips.delete();
          continue;
        }
        const a0 = valueIn(segment.startAngle, "rad");
        const a1 = valueIn(segment.endAngle, "rad");
        const mkArc = new oc.GC_MakeArcOfEllipse(elips, a0, a1, true);
        elips.delete();
        const curve = mkArc.Value();
        mkArc.delete();
        addEdge(new oc.BRepBuilderAPI_MakeEdge(curve));
        curve.delete();
        continue;
      }
      if (segment.kind === "spline") {
        const chain = splineBezierChain(segment.flavor, segment.points);
        for (const piece of chain) {
          const array = new oc.NCollection_Array1_gp_Pnt(1, 4);
          array.SetValue(1, new oc.gp_Pnt(piece.b0.x, piece.b0.y, z));
          array.SetValue(2, new oc.gp_Pnt(piece.b1.x, piece.b1.y, z));
          array.SetValue(3, new oc.gp_Pnt(piece.b2.x, piece.b2.y, z));
          array.SetValue(4, new oc.gp_Pnt(piece.b3.x, piece.b3.y, z));
          const curve = new oc.Geom_BezierCurve(array);
          array.delete();
          addEdge(new oc.BRepBuilderAPI_MakeEdge(curve));
          curve.delete();
        }
        continue;
      }
      const origin = new oc.gp_Pnt(segment.center[0], segment.center[1], z);
      const normal = new oc.gp_Dir(0, 0, 1);
      const xDir = new oc.gp_Dir(1, 0, 0);
      const ax2 = new oc.gp_Ax2(origin, normal, xDir);
      const circle = new oc.gp_Circ(ax2, segment.radius);
      origin.delete();
      normal.delete();
      xDir.delete();
      ax2.delete();
      if (segment.kind === "circle") {
        addEdge(new oc.BRepBuilderAPI_MakeEdge(circle));
        circle.delete();
        continue;
      }
      const a0 = valueIn(segment.startAngle, "rad");
      const a1 = valueIn(segment.endAngle, "rad");
      const mkArc = new oc.GC_MakeArcOfCircle(circle, a0, a1, true);
      circle.delete();
      const curve = mkArc.Value();
      mkArc.delete();
      addEdge(new oc.BRepBuilderAPI_MakeEdge(curve));
      curve.delete();
    }
    if (!mkWire.IsDone()) {
      disposeWireAndEdges();
      throw new Error("the profile wire did not close.");
    }
    const wire = mkWire.Wire();
    mkWire.delete();
    for (const edge of edges) edge.delete();
    return wire;
  };

  /** Faces a closed profile wire, disposing the wire either way. */
  const profileFace = (wire: TopoDS_Shape): TopoDS_Shape => {
    const mkFace = new oc.BRepBuilderAPI_MakeFace(wire, true);
    if (!mkFace.IsDone()) {
      mkFace.delete();
      wire.delete();
      throw new Error("the profile face did not build.");
    }
    const face = mkFace.Face();
    mkFace.delete();
    wire.delete();
    return face;
  };

  /**
   * The exact prism (Phase 26.1): profile wire → face →
   * `BRepPrimAPI_MakePrism` along local z, then the placement transform
   * (rotation first about the world-origin axis, translation second).
   */
  const newExtrusion = (
    input: ProfileExtrudeInput,
    height: number,
  ): TopoDS_Shape => {
    const face = profileFace(profileWire(input.loop));
    const sweep =
      input.direction === -1
        ? new oc.gp_Vec(0, 0, -height)
        : new oc.gp_Vec(0, 0, height);
    const mkPrism = new oc.BRepPrimAPI_MakePrism(face, sweep, false, true);
    face.delete();
    sweep.delete();
    if (!mkPrism.IsDone()) {
      mkPrism.delete();
      throw new Error("the prism did not build.");
    }
    return buildShape(mkPrism);
  };

  /**
   * Drafts a prism's LATERAL faces by `taper` radians (Phase 41):
   * `BRepOffsetAPI_DraftAngle` over every face except the caps — the
   * neutral plane at the PROFILE plane (local z = 0, where the loop was
   * drawn) and the pull direction along the extrusion direction, the
   * probed sign convention ((pull +z, +5°) on the 30×20×10 prism narrows
   * to the exact prismatoid; the cylinder at 3° becomes the exact cone
   * frustum; the CONCAVE L-prism matches the miter quadratic — all at
   * 15-digit agreement). Caps are the planar faces whose normal is the
   * extrusion axis (their Add fails — no intersection with the neutral
   * plane); every lateral face of a line/arc/circle prism is planar or
   * cylindrical, the engine's draft domain. The caller has already run
   * the segment gate, so the surface-type classification below is a
   * defensive re-check, not the gate.
   */
  const draftPrismFaces = (
    prism: TopoDS_Shape,
    taper: number,
    direction: 1 | -1,
  ): ParseResult<TopoDS_Shape, KernelError> => {
    const neutralOrigin = new oc.gp_Pnt(0, 0, 0);
    const neutralNormal = new oc.gp_Dir(0, 0, 1);
    const neutral = new oc.gp_Pln(neutralOrigin, neutralNormal);
    neutralOrigin.delete();
    neutralNormal.delete();
    const pull = new oc.gp_Dir(0, 0, direction);
    const drafter = new oc.BRepOffsetAPI_DraftAngle(prism);
    const faces: TopoDS_Face[] = [];
    const explorer = new oc.TopExp_Explorer(
      prism,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
    );
    let failure: KernelError | null = null;
    while (explorer.More() && failure === null) {
      const face = oc.TopoDS.Face(explorer.Value());
      faces.push(face);
      const adaptor = new oc.BRepAdaptor_Surface(face);
      const surfaceType = adaptor.GetType();
      adaptor.delete();
      if (surfaceType === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        // The caps: planar faces normal to the extrusion axis — their
        // supporting planes never cross the neutral plane usefully and
        // their Add fails, so they stay out of the drafting set.
        const planeAdaptor = new oc.BRepAdaptor_Surface(face);
        const normalZ = planeAdaptor.Plane().Axis().Direction().Z();
        planeAdaptor.delete();
        if (Math.abs(normalZ) > 1 - 1e-9) {
          explorer.Next();
          continue;
        }
      } else if (
        surfaceType !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder &&
        surfaceType !== oc.GeomAbs_SurfaceType.GeomAbs_Cone
      ) {
        failure = kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "extrude declined the taper: a lateral face carries a surface the drafting engine cannot handle (only planar and cylindrical walls draft).",
        );
        explorer.Next();
        continue;
      }
      drafter.Add(face, pull, taper, neutral, true);
      if (!drafter.AddDone()) {
        failure = kernelError(
          KERNEL_ERROR_CODES.invalidTaper,
          `extrude rejected the taper of ${String(taper)} rad: the drafting engine declined a lateral face (AddDone false). Reduce the taper angle.`,
        );
      }
      explorer.Next();
    }
    explorer.delete();
    let result: ParseResult<TopoDS_Shape, KernelError>;
    if (failure !== null) {
      drafter.delete();
      result = fail(failure);
    } else {
      // buildShape extracts Shape() and deletes the drafter exactly once.
      result = ok(buildShape(drafter));
    }
    pull.delete();
    neutral.delete();
    for (const face of faces) face.delete();
    return result;
  };

  /**
   * The exact revolution (Phase 26.2): profile wire → face →
   * `BRepPrimAPI_MakeRevol` about the in-plane axis by the sweep angle —
   * the same exact-surface path `createCone` composes from — then the
   * placement transform. OCCT revolves the analytic profile: straight
   * profiles give exact Pappus volumes, curved ones exact surfaces of
   * revolution.
   */
  const newRevolution = (
    input: ProfileRevolveInput,
    sweep: number,
  ): TopoDS_Shape => {
    const face = profileFace(profileWire(input.loop));
    const [px, py] = input.axis.point;
    const [dx, dy] = input.axis.direction;
    const origin = new oc.gp_Pnt(px, py, 0);
    const direction = new oc.gp_Dir(dx, dy, 0);
    const axis = new oc.gp_Ax1(origin, direction);
    origin.delete();
    direction.delete();
    const mkRevol = new oc.BRepPrimAPI_MakeRevol(face, axis, sweep, false);
    axis.delete();
    face.delete();
    if (!mkRevol.IsDone()) {
      mkRevol.delete();
      throw new Error("the revolution did not build.");
    }
    return buildShape(mkRevol);
  };

  /**
   * Builds the sweep spine wire (Phase 26.3): the path chain's segments as
   * exact edges in the local XZ plane (y = 0) — lines between points, arcs
   * from a `gp_Circ` on the plane's `gp_Ax2` trimmed by
   * `GC_MakeArcOfCircle`. The plane convention (probed): CCW in the (x, z)
   * plane is CCW about the −ŷ normal, so a clockwise path arc mirrors the
   * plane (+ŷ normal) and negates the angles; a full-turn arc (|ψ| = 2π)
   * is the whole-circle edge — `GC_MakeArcOfCircle` cannot trim a closed
   * turn. Every intermediate is deleted exactly once on the success path.
   */
  const sweepSpineWire = (
    path: readonly SweepPathSegmentInput[],
  ): TopoDS_Wire => {
    const mkWire = new oc.BRepBuilderAPI_MakeWire();
    const edges: TopoDS_Edge[] = [];
    const disposeWireAndEdges = (): void => {
      mkWire.delete();
      for (const edge of edges) edge.delete();
    };
    for (const segment of path) {
      if (segment.kind === "line") {
        const p1 = new oc.gp_Pnt(segment.start[0], 0, segment.start[1]);
        const p2 = new oc.gp_Pnt(segment.end[0], 0, segment.end[1]);
        const mkEdge = new oc.BRepBuilderAPI_MakeEdge(p1, p2);
        p1.delete();
        p2.delete();
        const edge = mkEdge.Edge();
        mkEdge.delete();
        mkWire.Add(edge);
        edges.push(edge);
        continue;
      }
      const sweep = sweepArcSignedSweep(segment);
      const ccw = sweep > 0;
      const center = new oc.gp_Pnt(segment.center[0], 0, segment.center[1]);
      const normal = new oc.gp_Dir(0, ccw ? -1 : 1, 0);
      const xDir = new oc.gp_Dir(1, 0, 0);
      const ax2 = new oc.gp_Ax2(center, normal, xDir);
      center.delete();
      normal.delete();
      xDir.delete();
      const circle = new oc.gp_Circ(ax2, segment.radius);
      ax2.delete();
      if (Math.PI * 2 - Math.abs(sweep) <= 1e-9) {
        const mkEdge = new oc.BRepBuilderAPI_MakeEdge(circle);
        circle.delete();
        const edge = mkEdge.Edge();
        mkEdge.delete();
        mkWire.Add(edge);
        edges.push(edge);
        continue;
      }
      const a0 = valueIn(segment.startAngle, "rad");
      const a1 = valueIn(segment.endAngle, "rad");
      const mkArc = new oc.GC_MakeArcOfCircle(
        circle,
        ccw ? a0 : -a0,
        ccw ? a1 : -a1,
        true,
      );
      circle.delete();
      const curve = mkArc.Value();
      mkArc.delete();
      const mkEdge = new oc.BRepBuilderAPI_MakeEdge(curve);
      curve.delete();
      const edge = mkEdge.Edge();
      mkEdge.delete();
      mkWire.Add(edge);
      edges.push(edge);
    }
    if (!mkWire.IsDone()) {
      disposeWireAndEdges();
      throw new Error("the sweep spine wire did not close.");
    }
    const wire = mkWire.Wire();
    mkWire.delete();
    for (const edge of edges) edge.delete();
    return wire;
  };

  /**
   * The exact pipe (Phase 26.3): spine wire + profile wire →
   * `BRepOffsetAPI_MakePipeShell` in corrected-Frenet mode (the planar
   * fixed-binormal frame — no twist for planar spines, the same transport
   * the contract pins), the profile attached as-is at the spine's start
   * (`WithContact`/`WithCorrection` false — the perpendicular attachment
   * is validated before this runs), `Build` + `MakeSolid` for the closed
   * profile, then the placement transform. Probed exact: straight spines
   * prism, arc spines hit Pappus, closed circular spines torus.
   */
  const newSweep = (input: ProfileSweepInput): TopoDS_Shape => {
    const spine = sweepSpineWire(input.path);
    const profile = profileWire(input.loop);
    const mkPipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
    mkPipe.SetMode(true);
    mkPipe.Add(profile, false, false);
    const ready = mkPipe.IsReady();
    if (ready) {
      mkPipe.Build();
    }
    const solidOk = ready && mkPipe.MakeSolid();
    spine.delete();
    profile.delete();
    if (!ready || !solidOk) {
      mkPipe.delete();
      throw new Error("the swept pipe did not build into a solid.");
    }
    return buildShape(mkPipe);
  };

  /**
   * The exact ruled loft (Phase 26.4): each section's loop → the exact
   * wire at its station z → `BRepOffsetAPI_ThruSections` in SOLID, RULED
   * mode — consecutive sections join by ruled surfaces, the contract's
   * piecewise-linear-per-span transport, over the ADAPTER-ENFORCED
   * correspondence (see the module doc): on equal-segment-count
   * collections the engine's own compatibility pass is off
   * (`CheckCompatibility(false)` — the pass re-origins a later wire on a
   * phase shift ALONE, de-twisting a re-phased square→square loft to the
   * prism, probed 1000 mm³ where the authored index morph measures the
   * Simpson value 2000/3) and the CCW-normalized wires rule edge i ↔
   * edge i in authored order; authored-CW loops are carried REVERSED —
   * without the pass the engine no longer reconciles winding, and a CW
   * member against a CCW one silently builds an empty solid (probed
   * volume 0). Collections whose segment counts differ keep the pass on
   * for the edge repartition (without it that class silently builds
   * volume 0 too, probed) and their correspondence stays the engine's
   * own parameterization — the contract's documented scope. Every wire is
   * deleted exactly once after the builder consumes it; a loft OCCT
   * cannot build throws inside the caller's no-throw boundary.
   */
  const newLoft = (
    sections: readonly ProfileLoftSectionInput[],
    stations: readonly number[],
  ): TopoDS_Shape => {
    const mkLoft = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
    const segmentCount = sections[0]?.loop.length ?? 0;
    const authoredCorrespondence = sections.every(
      (section) => section.loop.length === segmentCount,
    );
    if (authoredCorrespondence) {
      mkLoft.CheckCompatibility(false);
    }
    const wires: TopoDS_Wire[] = [];
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const z = stations[i];
      if (section === undefined || z === undefined) {
        mkLoft.delete();
        for (const wire of wires) wire.delete();
        throw new Error(
          "Invariant violation: validated loft sections are dense.",
        );
      }
      let wire = profileWire(section.loop, z);
      if (
        authoredCorrespondence &&
        !(polygonSignedArea(tessellateProfileLoop(section.loop)) > 0)
      ) {
        // Authored CW: carry the wire REVERSED — the wire-level form of
        // the CCW normalization the contract's chord polygons apply,
        // starting the traversal at the normalized polygon's own first
        // vertex (probed to reproduce the reference kernel's morph).
        const oriented = wire.Oriented(oc.TopAbs_Orientation.TopAbs_REVERSED);
        const reversed = oc.TopoDS.Wire(oriented);
        oriented.delete();
        wire.delete();
        wire = reversed;
      }
      mkLoft.AddWire(wire);
      wires.push(wire);
    }
    mkLoft.Build();
    for (const wire of wires) wire.delete();
    if (!mkLoft.IsDone()) {
      mkLoft.delete();
      throw new Error("the ruled loft did not build into a solid.");
    }
    return buildShape(mkLoft);
  };

  /**
   * The ruled meridian-station helix sweep (Phase 40): the profile's CCW
   * chord polygon is transported to every station of the shared station
   * rule (one per `PROFILE_STATION_ANGLE_RAD` of swept angle — the same
   * deflection discipline every curved segment chords at) by the
   * contract's meridian motion, each station becomes an exact straight-
   * edged wire in its meridian plane, and `BRepOffsetAPI_ThruSections` in
   * ruled mode (the compatibility pass OFF — every station carries the
   * identical edge structure) lofts between them, `MakeSolid` closing the
   * shell. The ruled spans approximate the screw motion between stations
   * — the derived volume band is `sin(Δθ)/Δθ` of the exact screw value
   * (the span Jacobian is `(R+u)·sinΔθ` against the true `(R+u)·Δθ`), the
   * 63-chord class the mesh kernels' revolves already document; the
   * fixtures pin the band. Every intermediate is deleted exactly once on
   * the success path; failures throw inside the caller's no-throw
   * boundary.
   */
  const newHelixSweep = (
    polygon: readonly {
      readonly x: number;
      readonly y: number;
    }[],
    spine: CanonicalHelixSpine,
  ): TopoDS_Shape => {
    const mkLoft = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
    // Identical edge structure at every station: the engine's own
    // compatibility pass is exactly what must NOT run (it re-origins
    // wires — the loft path's probe).
    mkLoft.CheckCompatibility(false);
    const wires: TopoDS_Wire[] = [];
    try {
      for (const t of helixStations(spine)) {
        const mkWire = new oc.BRepBuilderAPI_MakeWire();
        const edges: TopoDS_Edge[] = [];
        const stationPoint = (vertex: {
          readonly x: number;
          readonly y: number;
        }): gp_Pnt => {
          const local = helixTransportPoint(spine, vertex.x, vertex.y, t);
          return new oc.gp_Pnt(local[0], local[1], local[2]);
        };
        for (let i = 0; i < polygon.length; i += 1) {
          const from = polygon[i];
          const to = polygon[(i + 1) % polygon.length];
          if (from === undefined || to === undefined) {
            mkWire.delete();
            for (const edge of edges) edge.delete();
            throw new Error(
              "Invariant violation: the transported polygon is dense.",
            );
          }
          const p1 = stationPoint(from);
          const p2 = stationPoint(to);
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
          throw new Error("a helix station wire did not close.");
        }
        const wire = mkWire.Wire();
        mkWire.delete();
        for (const edge of edges) edge.delete();
        mkLoft.AddWire(wire);
        wires.push(wire);
      }
      mkLoft.Build();
      for (const wire of wires) wire.delete();
      wires.length = 0;
      if (!mkLoft.IsDone()) {
        mkLoft.delete();
        throw new Error("the helical ruled loft did not build into a solid.");
      }
      return buildShape(mkLoft);
    } catch (error) {
      for (const wire of wires) wire.delete();
      mkLoft.delete();
      throw error;
    }
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

  /** The exact BREP surface area of a shape (Phase 27.4), in mm². */
  const areaOfShape = (shape: TopoDS_Shape): number => {
    const props = new oc.GProp_GProps();
    try {
      oc.BRepGProp.SurfaceProperties(shape, props, true, false);
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

    extrude(input: ProfileExtrudeInput): KernelResult<KernelSolid> {
      return run("extrude", KERNEL_ERROR_CODES.invalidProfile, () => {
        // Validation BEFORE any OCCT call (the silent-mirror rule): height,
        // placement rotation/translation, and the profile's structural
        // soundness (closure, non-degeneracy) all reject here.
        const height = positiveLength(input.height, "height", "extrude");
        if (!height.ok) return fail(height.error);
        const angle = angleIn(input.placement.rotation.angle, "extrude");
        if (!angle.ok) return fail(angle.error);
        const axis = axisIn(input.placement.rotation.axis, "extrude");
        if (!axis.ok) return fail(axis.error);
        const tx = lengthIn(
          input.placement.translation.x,
          "translation.x",
          "extrude",
        );
        if (!tx.ok) return fail(tx.error);
        const ty = lengthIn(
          input.placement.translation.y,
          "translation.y",
          "extrude",
        );
        if (!ty.ok) return fail(ty.error);
        const tz = lengthIn(
          input.placement.translation.z,
          "translation.z",
          "extrude",
        );
        if (!tz.ok) return fail(tz.error);
        const problem = profileLoopProblem(input.loop);
        if (problem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `extrude rejected the profile loop: ${problem}.`,
            ),
          );
        }
        // Sanity beyond structure: the tessellated boundary must bound a
        // face (the same degeneracy floor the mesh kernels enforce).
        const polygon = tessellateProfileLoop(input.loop);
        if (
          polygon.length < 3 ||
          !(Math.abs(polygonSignedArea(polygon)) > 1e-9)
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "extrude rejected the profile loop: it is degenerate (fewer than three distinct vertices or zero enclosed area).",
            ),
          );
        }
        // The Phase 41 draft taper: the shared battery first (every kernel
        // rejects identically), then the segment-domain gate —
        // BRepOffsetAPI_DraftAngle drafts planar, cylindrical, and conical
        // faces, so the loop's segments must be lines, arcs, or circles
        // (their prisms' lateral faces); an ellipse or spline wall is a
        // general extrusion surface the engine cannot draft, and the
        // adapter declines the subset structurally instead of handing the
        // engine a face whose Add would silently do nothing.
        let taper: number | undefined;
        if (input.taper !== undefined) {
          const taperAngle = angleIn(input.taper, "extrude");
          if (!taperAngle.ok) return fail(taperAngle.error);
          if (taperAngle.value !== 0) {
            const problem = taperedExtrudeProblem(
              input.loop,
              height.value,
              input.taper,
            );
            if (problem !== null) {
              return fail(
                kernelError(
                  KERNEL_ERROR_CODES.invalidTaper,
                  `extrude rejected the taper: ${problem.message}`,
                ),
              );
            }
            for (const segment of input.loop) {
              if (
                segment.kind !== "line" &&
                segment.kind !== "arc" &&
                segment.kind !== "circle"
              ) {
                return fail(
                  kernelError(
                    KERNEL_ERROR_CODES.unsupportedOperation,
                    `extrude declined the taper over a "${segment.kind}" segment: the OpenCascade drafting engine handles planar and cylindrical walls (lines, arcs, circles); elliptical and spline walls carry general surfaces it cannot draft. Model the drafted wall from arcs and lines, or taper it on a kernel whose chord model accepts every loop kind.`,
                  ),
                );
              }
            }
            taper = taperAngle.value;
          }
        }
        let prism = newExtrusion(input, height.value);
        if (taper !== undefined) {
          const drafted = draftPrismFaces(prism, taper, input.direction);
          prism.delete();
          if (!drafted.ok) return fail(drafted.error);
          prism = drafted.value;
        }
        // Placement: rotation about the world-origin axis first, then the
        // translation — the transform composition, applied via
        // BRepBuilderAPI_Transform like every placed shape here.
        const rot = axisAngleMatrix(axis.value, angle.value);
        const trsf = new oc.gp_Trsf();
        trsf.SetValues(
          rot[0]?.[0] ?? 0,
          rot[0]?.[1] ?? 0,
          rot[0]?.[2] ?? 0,
          tx.value,
          rot[1]?.[0] ?? 0,
          rot[1]?.[1] ?? 0,
          rot[1]?.[2] ?? 0,
          ty.value,
          rot[2]?.[0] ?? 0,
          rot[2]?.[1] ?? 0,
          rot[2]?.[2] ?? 0,
          tz.value,
        );
        const placed = buildShape(
          new oc.BRepBuilderAPI_Transform(prism, trsf, false, true),
        );
        trsf.delete();
        prism.delete();
        return ok(wrapSolid(placed));
      });
    },

    revolve(input: ProfileRevolveInput): KernelResult<KernelSolid> {
      return run("revolve", KERNEL_ERROR_CODES.invalidProfile, () => {
        // Validation BEFORE any OCCT call (the silent-mirror rule), in the
        // shared 26.2 battery: sweep-angle domain, axis direction,
        // placement, structural profile soundness, and the axis-crossing
        // rejection (OCCT builds an undefined solid from a crossing
        // profile — the crossing must never reach the engine).
        const sweepValue = angleIn(input.angle, "revolve");
        if (!sweepValue.ok) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "revolve rejected the sweep angle: its magnitude is not a finite number.",
            ),
          );
        }
        const sweep = sweepValue.value;
        if (!(sweep > 0) || sweep > Math.PI * 2) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidSweepAngle,
              `revolve rejected sweep angle ${String(sweep)} rad: the domain is (0, 2π] — zero sweeps no material, beyond a full turn double-covers it.`,
            ),
          );
        }
        const frame = normalizeRevolveAxis(input.axis);
        if (frame === null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              `revolve rejected an axis along [${String(input.axis.direction[0])}, ${String(input.axis.direction[1])}]: the direction must be a non-zero finite vector.`,
            ),
          );
        }
        const angle = angleIn(input.placement.rotation.angle, "revolve");
        if (!angle.ok) return fail(angle.error);
        const axis = axisIn(input.placement.rotation.axis, "revolve");
        if (!axis.ok) return fail(axis.error);
        const tx = lengthIn(
          input.placement.translation.x,
          "translation.x",
          "revolve",
        );
        if (!tx.ok) return fail(tx.error);
        const ty = lengthIn(
          input.placement.translation.y,
          "translation.y",
          "revolve",
        );
        if (!ty.ok) return fail(ty.error);
        const tz = lengthIn(
          input.placement.translation.z,
          "translation.z",
          "revolve",
        );
        if (!tz.ok) return fail(tz.error);
        const problem = profileLoopProblem(input.loop);
        if (problem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `revolve rejected the profile loop: ${problem}.`,
            ),
          );
        }
        // Sanity beyond structure: the tessellated boundary must bound a
        // face (the shared degeneracy floor).
        const polygon = tessellateProfileLoop(input.loop);
        if (
          polygon.length < 3 ||
          !(Math.abs(polygonSignedArea(polygon)) > 1e-9)
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "revolve rejected the profile loop: it is degenerate (fewer than three distinct vertices or zero enclosed area).",
            ),
          );
        }
        if (revolveCrossesAxis(input.loop, frame)) {
          const extremes = revolveSignedExtremes(input.loop, frame);
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.profileAxisCrossing,
              `revolve rejected the profile loop: it crosses the revolve axis (signed distances span [${String(extremes.min)}, ${String(extremes.max)}] mm). Move the profile fully to one side; touching the axis is allowed.`,
            ),
          );
        }
        const revolved = newRevolution(input, sweep);
        // Placement: the transform composition (rotation first, translation
        // second), applied via BRepBuilderAPI_Transform like every placed
        // shape here.
        const rot = axisAngleMatrix(axis.value, angle.value);
        const trsf = new oc.gp_Trsf();
        trsf.SetValues(
          rot[0]?.[0] ?? 0,
          rot[0]?.[1] ?? 0,
          rot[0]?.[2] ?? 0,
          tx.value,
          rot[1]?.[0] ?? 0,
          rot[1]?.[1] ?? 0,
          rot[1]?.[2] ?? 0,
          ty.value,
          rot[2]?.[0] ?? 0,
          rot[2]?.[1] ?? 0,
          rot[2]?.[2] ?? 0,
          tz.value,
        );
        const placed = buildShape(
          new oc.BRepBuilderAPI_Transform(revolved, trsf, false, true),
        );
        trsf.delete();
        revolved.delete();
        return ok(wrapSolid(placed));
      });
    },

    sweep(input: ProfileSweepInput): KernelResult<KernelSolid> {
      return run("sweep", KERNEL_ERROR_CODES.invalidProfile, () => {
        // Validation BEFORE any OCCT call (the silent-mirror rule), in the
        // shared 26.3 battery: placement, the profile's structural
        // soundness and face floor, the path's structure (origin start,
        // perpendicular attachment, G1 joints), the path's chord-polyline
        // self-intersection, and the per-arc bend-axis crossing — every
        // rejection is structured and none reaches the engine.
        const angle = angleIn(input.placement.rotation.angle, "sweep");
        if (!angle.ok) return fail(angle.error);
        const axis = axisIn(input.placement.rotation.axis, "sweep");
        if (!axis.ok) return fail(axis.error);
        const tx = lengthIn(
          input.placement.translation.x,
          "translation.x",
          "sweep",
        );
        if (!tx.ok) return fail(tx.error);
        const ty = lengthIn(
          input.placement.translation.y,
          "translation.y",
          "sweep",
        );
        if (!ty.ok) return fail(ty.error);
        const tz = lengthIn(
          input.placement.translation.z,
          "translation.z",
          "sweep",
        );
        if (!tz.ok) return fail(tz.error);
        const problem = profileLoopProblem(input.loop);
        if (problem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `sweep rejected the profile loop: ${problem}.`,
            ),
          );
        }
        const polygon = tessellateProfileLoop(input.loop);
        if (
          polygon.length < 3 ||
          !(Math.abs(polygonSignedArea(polygon)) > 1e-9)
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "sweep rejected the profile loop: it is degenerate (fewer than three distinct vertices or zero enclosed area).",
            ),
          );
        }
        const pathProblem = sweepPathProblem(input.path);
        if (pathProblem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidPath,
              `sweep rejected the path: ${pathProblem}.`,
            ),
          );
        }
        if (sweepPathSelfIntersects(input.path)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.pathSelfIntersecting,
              "sweep rejected the path: it crosses itself (detected on the path's chord polyline). A self-crossing spine sweeps an undefined solid.",
            ),
          );
        }
        const crossing = sweepProfileArcAxisCrossing(input.loop, input.path);
        if (crossing !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.sweepSelfIntersecting,
              `sweep rejected the input: the profile crosses an arc segment's centre axis at u = ${String(crossing.uAxis)} mm (signed distances span [${String(crossing.min)}, ${String(crossing.max)}]) — the tube would pinch through the bend. Move the profile fully to one side of every bend axis; touching is allowed.`,
            ),
          );
        }
        const piped = newSweep(input);
        const rot = axisAngleMatrix(axis.value, angle.value);
        const trsf = new oc.gp_Trsf();
        trsf.SetValues(
          rot[0]?.[0] ?? 0,
          rot[0]?.[1] ?? 0,
          rot[0]?.[2] ?? 0,
          tx.value,
          rot[1]?.[0] ?? 0,
          rot[1]?.[1] ?? 0,
          rot[1]?.[2] ?? 0,
          ty.value,
          rot[2]?.[0] ?? 0,
          rot[2]?.[1] ?? 0,
          rot[2]?.[2] ?? 0,
          tz.value,
        );
        const placed = buildShape(
          new oc.BRepBuilderAPI_Transform(piped, trsf, false, true),
        );
        trsf.delete();
        piped.delete();
        return ok(wrapSolid(placed));
      });
    },

    helixSweep(input: HelixSweepInput): KernelResult<KernelSolid> {
      return run("helixSweep", KERNEL_ERROR_CODES.invalidHelix, () => {
        // Validation BEFORE any OCCT call (the silent-mirror rule): the
        // placement, then the shared Phase 40 battery — spine degeneracy,
        // profile validity in meridian coordinates, axis crossing — so a
        // degenerate spine never reaches the builders.
        const angle = angleIn(input.placement.rotation.angle, "helixSweep");
        if (!angle.ok) return fail(angle.error);
        const axis = axisIn(input.placement.rotation.axis, "helixSweep");
        if (!axis.ok) return fail(axis.error);
        const tx = lengthIn(
          input.placement.translation.x,
          "translation.x",
          "helixSweep",
        );
        if (!tx.ok) return fail(tx.error);
        const ty = lengthIn(
          input.placement.translation.y,
          "translation.y",
          "helixSweep",
        );
        if (!ty.ok) return fail(ty.error);
        const tz = lengthIn(
          input.placement.translation.z,
          "translation.z",
          "helixSweep",
        );
        if (!tz.ok) return fail(tz.error);
        const radius = lengthIn(
          input.spine.radius,
          "spine.radius",
          "helixSweep",
        );
        if (!radius.ok) return fail(radius.error);
        const pitch = lengthIn(input.spine.pitch, "spine.pitch", "helixSweep");
        if (!pitch.ok) return fail(pitch.error);
        const startAngle = angleIn(input.spine.startAngle, "spine.startAngle");
        if (!startAngle.ok) return fail(startAngle.error);
        const taper =
          input.spine.taper === undefined
            ? { ok: true as const, value: 0 }
            : lengthIn(input.spine.taper, "spine.taper", "helixSweep");
        if (!taper.ok) return fail(taper.error);
        const spine: CanonicalHelixSpine = {
          radiusMm: radius.value,
          pitchMm: pitch.value,
          turns: input.spine.turns,
          handedness: input.spine.handedness,
          startAngleRad: startAngle.value,
          taperMm: taper.value,
        };
        const problem = helixSweepProblem(input.loop, spine);
        if (problem !== null) {
          return fail(
            kernelError(problem.code, `helixSweep ${problem.message}.`),
          );
        }
        const polygon = helixProfilePolygon(input.loop);
        if (
          polygon.length < 3 ||
          !(Math.abs(polygonSignedArea(polygon)) > 1e-9)
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "helixSweep rejected the profile loop: it is degenerate (fewer than three distinct vertices or zero enclosed area).",
            ),
          );
        }
        // CCW-normalize the meridian polygon before transporting: the
        // compatibility pass is off, so the winding rule is the adapter's
        // to enforce (the loft path's discipline).
        const area = polygonSignedArea(polygon);
        const ccw = area > 0 ? polygon : [...polygon].reverse();
        const swept = newHelixSweep(ccw, spine);
        const rot = axisAngleMatrix(axis.value, angle.value);
        const trsf = new oc.gp_Trsf();
        trsf.SetValues(
          rot[0]?.[0] ?? 0,
          rot[0]?.[1] ?? 0,
          rot[0]?.[2] ?? 0,
          tx.value,
          rot[1]?.[0] ?? 0,
          rot[1]?.[1] ?? 0,
          rot[1]?.[2] ?? 0,
          ty.value,
          rot[2]?.[0] ?? 0,
          rot[2]?.[1] ?? 0,
          rot[2]?.[2] ?? 0,
          tz.value,
        );
        const placed = buildShape(
          new oc.BRepBuilderAPI_Transform(swept, trsf, false, true),
        );
        trsf.delete();
        swept.delete();
        return ok(wrapSolid(placed));
      });
    },

    loft(input: ProfileLoftInput): KernelResult<KernelSolid> {
      return run("loft", KERNEL_ERROR_CODES.invalidProfile, () => {
        // Validation BEFORE any OCCT call (the silent-mirror rule), in the
        // shared 26.4 battery: the placement, then the section collection —
        // member validity, station ordering, and vertex-count compatibility
        // (the last two reject with the structured loft codes) — so a
        // mismatched collection never reaches ThruSections' own
        // compatibility pass.
        const angle = angleIn(input.placement.rotation.angle, "loft");
        if (!angle.ok) return fail(angle.error);
        const axis = axisIn(input.placement.rotation.axis, "loft");
        if (!axis.ok) return fail(axis.error);
        const tx = lengthIn(
          input.placement.translation.x,
          "translation.x",
          "loft",
        );
        if (!tx.ok) return fail(tx.error);
        const ty = lengthIn(
          input.placement.translation.y,
          "translation.y",
          "loft",
        );
        if (!ty.ok) return fail(ty.error);
        const tz = lengthIn(
          input.placement.translation.z,
          "translation.z",
          "loft",
        );
        if (!tz.ok) return fail(tz.error);
        const problem = loftSectionsProblem(input.sections);
        if (problem !== null) {
          return fail(
            kernelError(
              problem.code,
              `loft rejected the section collection: ${problem.message}.`,
            ),
          );
        }
        const lofted = newLoft(input.sections, loftStations(input.sections));
        // Placement: the transform composition (rotation first, translation
        // second), applied via BRepBuilderAPI_Transform like every placed
        // shape here.
        const rot = axisAngleMatrix(axis.value, angle.value);
        const trsf = new oc.gp_Trsf();
        trsf.SetValues(
          rot[0]?.[0] ?? 0,
          rot[0]?.[1] ?? 0,
          rot[0]?.[2] ?? 0,
          tx.value,
          rot[1]?.[0] ?? 0,
          rot[1]?.[1] ?? 0,
          rot[1]?.[2] ?? 0,
          ty.value,
          rot[2]?.[0] ?? 0,
          rot[2]?.[1] ?? 0,
          rot[2]?.[2] ?? 0,
          tz.value,
        );
        const placed = buildShape(
          new oc.BRepBuilderAPI_Transform(lofted, trsf, false, true),
        );
        trsf.delete();
        lofted.delete();
        return ok(wrapSolid(placed));
      });
    },

    fillet(input: FilletInput): KernelResult<KernelSolid> {
      return run("fillet", KERNEL_ERROR_CODES.filletFailed, () => {
        // Validation BEFORE any OCCT call (the silent-mirror rule): handle,
        // radius, and the edge-address structure; then the ordinal
        // resolution against the target's own snapshot numbering (the
        // stale-reference check), and only then the builder.
        const shape = shapeOf(input.target, "fillet");
        if (!shape.ok) return fail(shape.error);
        const radius = positiveLength(input.radius, "radius", "fillet");
        if (!radius.ok) return fail(radius.error);
        if (input.edges.length === 0) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidOperands,
              "fillet rejected the edge list: at least one edge ordinal is required.",
            ),
          );
        }
        const seen = new Set<number>();
        for (const ordinal of input.edges) {
          if (!Number.isInteger(ordinal) || ordinal < 0) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidOperands,
                `fillet rejected edge ordinal ${String(ordinal)}: ordinals are non-negative integers (snapshot edge addresses).`,
              ),
            );
          }
          if (seen.has(ordinal)) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidOperands,
                `fillet rejected the edge list: ordinal ${String(ordinal)} appears more than once.`,
              ),
            );
          }
          seen.add(ordinal);
        }
        const resolved = occtEdgesAtOrdinals(oc, shape.value, input.edges);
        if (resolved.missing.length > 0) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.filletEdgeUnknown,
              `fillet rejected edge ordinal(s) ${resolved.missing.map(String).join(", ")}: none addresses an edge of the target's current topology snapshot (a stale reference resolved against an older regeneration, or an out-of-range ordinal).`,
            ),
          );
        }
        const mkFillet = new oc.BRepFilletAPI_MakeFillet(shape.value);
        for (const edge of resolved.edges) {
          mkFillet.Add(radius.value, edge);
          edge.delete();
        }
        mkFillet.Build();
        if (!mkFillet.IsDone()) {
          mkFillet.delete();
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.filletFailed,
              `fillet failed for radius ${String(radius.value)} mm: the fillet algorithm could not build a solid (probed canonical cause: the radius outruns the faces adjacent to a selected edge; interfering fillets fail the same way). Reduce the radius or select different edges.`,
            ),
          );
        }
        return ok(wrapSolid(buildShape(mkFillet)));
      });
    },

    chamfer(input: ChamferInput): KernelResult<KernelSolid> {
      return run("chamfer", KERNEL_ERROR_CODES.chamferFailed, () => {
        // The fillet path's battery, verbatim, with the distance in the
        // radius's place: handle, distance, and the edge-address structure
        // validated BEFORE any OCCT call; then the ordinal resolution
        // against the target's own snapshot numbering (the stale-reference
        // check); and only then the builder. The no-throw boundary matters
        // more here than for the fillet: probed, a seam-edge chamfer
        // THROWS inside the WASM boundary (MakeFillet declines the same
        // edge with IsDone = false), and this boundary is what normalizes
        // that throw into the structured chamfer failure.
        const shape = shapeOf(input.target, "chamfer");
        if (!shape.ok) return fail(shape.error);
        const distance = positiveLength(input.distance, "distance", "chamfer");
        if (!distance.ok) return fail(distance.error);
        if (input.edges.length === 0) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidOperands,
              "chamfer rejected the edge list: at least one edge ordinal is required.",
            ),
          );
        }
        const seen = new Set<number>();
        for (const ordinal of input.edges) {
          if (!Number.isInteger(ordinal) || ordinal < 0) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidOperands,
                `chamfer rejected edge ordinal ${String(ordinal)}: ordinals are non-negative integers (snapshot edge addresses).`,
              ),
            );
          }
          if (seen.has(ordinal)) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidOperands,
                `chamfer rejected the edge list: ordinal ${String(ordinal)} appears more than once.`,
              ),
            );
          }
          seen.add(ordinal);
        }
        const resolved = occtEdgesAtOrdinals(oc, shape.value, input.edges);
        if (resolved.missing.length > 0) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.chamferEdgeUnknown,
              `chamfer rejected edge ordinal(s) ${resolved.missing.map(String).join(", ")}: none addresses an edge of the target's current topology snapshot (a stale reference resolved against an older regeneration, or an out-of-range ordinal).`,
            ),
          );
        }
        const mkChamfer = new oc.BRepFilletAPI_MakeChamfer(shape.value);
        for (const edge of resolved.edges) {
          mkChamfer.Add(distance.value, edge);
          edge.delete();
        }
        mkChamfer.Build();
        if (!mkChamfer.IsDone()) {
          mkChamfer.delete();
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.chamferFailed,
              `chamfer failed for distance ${String(distance.value)} mm: the chamfer algorithm could not build a solid (probed canonical causes: the distance meets or exceeds a face adjacent to a selected edge, or two chamfers' removed corners interfere). Reduce the distance or select different edges.`,
            ),
          );
        }
        return ok(wrapSolid(buildShape(mkChamfer)));
      });
    },

    shell(input: ShellInput): KernelResult<KernelSolid> {
      return run("shell", KERNEL_ERROR_CODES.shellFailed, () => {
        // The edge-cut battery's shape on the FACE address: handle,
        // thickness, and the face-list structure validated BEFORE any OCCT
        // call; then the ordinal resolution against the target's own
        // snapshot numbering (the stale-reference check); and only then
        // the builder. Two probed engine truths shape what follows: the
        // hollow runs on the INWARD (negative) offset — the positive one
        // builds an outward-thickened solid — and degenerate thicknesses
        // NEVER fail IsDone, so the no-throw boundary (the exact-collapse
        // `Shape()` throw) and the closing post-condition are what surface
        // them structured.
        const shape = shapeOf(input.target, "shell");
        if (!shape.ok) return fail(shape.error);
        const thickness = positiveLength(input.thickness, "thickness", "shell");
        if (!thickness.ok) return fail(thickness.error);
        const t = thickness.value;
        if (input.faces.length === 0) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidOperands,
              "shell rejected the face list: at least one face ordinal is required (the open hollow shell; the fully closed hollow is out of contract scope — probed, the engine's zero-face answer is the offset cavity region itself, not the walls).",
            ),
          );
        }
        const seen = new Set<number>();
        for (const ordinal of input.faces) {
          if (!Number.isInteger(ordinal) || ordinal < 0) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidOperands,
                `shell rejected face ordinal ${String(ordinal)}: ordinals are non-negative integers (snapshot face addresses).`,
              ),
            );
          }
          if (seen.has(ordinal)) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidOperands,
                `shell rejected the face list: ordinal ${String(ordinal)} appears more than once.`,
              ),
            );
          }
          seen.add(ordinal);
        }
        const resolved = occtFacesAtOrdinals(oc, shape.value, input.faces);
        if (resolved.missing.length > 0) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.shellFaceUnknown,
              `shell rejected face ordinal(s) ${resolved.missing.map(String).join(", ")}: none addresses a face of the target's current topology snapshot (a stale reference resolved against an older regeneration, or an out-of-range ordinal).`,
            ),
          );
        }
        const targetVolume = volumeOfShape(shape.value);
        const closing = new oc.NCollection_List_TopoDS_Shape();
        for (const face of resolved.faces) {
          closing.Append(face);
        }
        const maker = new oc.BRepOffsetAPI_MakeThickSolid();
        maker.MakeThickSolidByJoin(
          shape.value,
          closing,
          -t,
          1e-6,
          oc.BRepOffset_Mode.BRepOffset_Skin,
          false,
          false,
          oc.GeomAbs_JoinType.GeomAbs_Arc,
          true,
        );
        if (!maker.IsDone()) {
          maker.delete();
          closing.delete();
          for (const face of resolved.faces) face.delete();
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.shellFailed,
              `shell failed for thickness ${String(t)} mm: the hollowing algorithm could not build a solid. Reduce the thickness or change the face selection.`,
            ),
          );
        }
        // The exact-collapse fixture throws inside Shape() (probed); the
        // no-throw run boundary normalizes that into the structured shell
        // failure below.
        const hollowed = maker.Shape();
        maker.delete();
        closing.delete();
        for (const face of resolved.faces) face.delete();
        // The semantic post-condition, because the engine does not keep
        // this honesty itself (probed): a hollowed shell keeps STRICTLY
        // positive volume — an exact cross-collapse measured 0 — strictly
        // below the pristine target's — past the collapse the engine
        // silently returned the untouched box, face removal and all.
        const shellVolume = volumeOfShape(hollowed);
        if (!(shellVolume > 0) || shellVolume >= targetVolume) {
          hollowed.delete();
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.shellFailed,
              `shell failed for thickness ${String(t)} mm: the walls meet or cross before the removed face is reached, so no hollow remains (probed: the engine itself would silently return the degenerate pristine or empty solid — the structured refusal is the adapter's). Reduce the thickness.`,
            ),
          );
        }
        return ok(wrapSolid(hollowed));
      });
    },

    thicken(input: ThickenInput): KernelResult<KernelSolid> {
      // The Phase 41 closed hollow — the probed cavity composition: with an
      // EMPTY closing list, MakeThickSolidByJoin at the inward (negative)
      // offset returns the offset CAVITY REGION exactly (the 26×16×6 inner
      // box on the 30×20×10 fixture at t = 2, 0 relative error — the
      // Phase 26.7 probe's finding, re-used as the building block), and one
      // exact BRepAlgoAPI_Cut of that cavity from the target builds the
      // hollow (probed 3 504 mm³ = 6 000 − 2 496 exactly). The semantic
      // post-condition mirrors the shell's: the engine does not fail
      // degenerate input itself (probed: the positive-offset empty-list
      // answer carries a NEGATIVE volume, a silent degenerate), so the
      // adapter measures and refuses.
      return run("thicken", KERNEL_ERROR_CODES.thickenFailed, () => {
        const shape = shapeOf(input.target, "thicken");
        if (!shape.ok) return fail(shape.error);
        const thickness = positiveLength(
          input.thickness,
          "thickness",
          "thicken",
        );
        if (!thickness.ok) return fail(thickness.error);
        const t = thickness.value;
        const targetVolume = volumeOfShape(shape.value);
        const closing = new oc.NCollection_List_TopoDS_Shape();
        const maker = new oc.BRepOffsetAPI_MakeThickSolid();
        maker.MakeThickSolidByJoin(
          shape.value,
          closing,
          -t,
          1e-6,
          oc.BRepOffset_Mode.BRepOffset_Skin,
          false,
          false,
          oc.GeomAbs_JoinType.GeomAbs_Arc,
          true,
        );
        closing.delete();
        if (!maker.IsDone()) {
          maker.delete();
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.thickenFailed,
              `thicken failed for thickness ${String(t)} mm: the offset algorithm could not build the cavity. Reduce the thickness.`,
            ),
          );
        }
        const cavity = maker.Shape();
        maker.delete();
        const cut = new oc.BRepAlgoAPI_Cut(shape.value, cavity);
        cavity.delete();
        if (!cut.IsDone()) {
          cut.delete();
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.thickenFailed,
              `thicken failed for thickness ${String(t)} mm: the cavity cut did not build. Reduce the thickness.`,
            ),
          );
        }
        const hollowed = cut.Shape();
        cut.delete();
        // The closed-hollow post-condition: strictly positive volume,
        // strictly below the target's (the cavity removed material); the
        // engine's silently-degenerate answers never cross back.
        const hollowVolume = volumeOfShape(hollowed);
        if (
          !(hollowVolume > 0) ||
          hollowVolume >= targetVolume ||
          !Number.isFinite(hollowVolume)
        ) {
          hollowed.delete();
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.thickenFailed,
              `thicken failed for thickness ${String(t)} mm: the cavity meets or crosses itself, so no closed hollow remains (probed: the engine itself would silently return a degenerate solid — the structured refusal is the adapter's). Reduce the thickness below half the target's smallest extent.`,
            ),
          );
        }
        return ok(wrapSolid(hollowed));
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
        // The Phase 41 uniform scale: gp_Trsf.SetScale about the WORLD
        // ORIGIN, composed innermost (Multiplied's right factor applies
        // first), so the full mapping is p ↦ s·R·p + t — the contract's
        // order. Probed: box(30,20,10) at s = 2 measures 48 000 mm³ and
        // spans [0,60]×[0,40]×[0,20] (the ×s³ volume and ×s bounds the
        // fixtures pin); a negative factor would mirror (probed), so the
        // positivity is validated BEFORE any OCCT object exists.
        if (input.scale !== undefined) {
          if (!(input.scale > 0) || !Number.isFinite(input.scale)) {
            trsf.delete();
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidLength,
                `transform rejected the scale factor ${String(input.scale)}: it must be a finite, strictly positive number.`,
              ),
            );
          }
          const scaleOrigin = new oc.gp_Pnt(0, 0, 0);
          const scaleTrsf = new oc.gp_Trsf();
          scaleTrsf.SetScale(scaleOrigin, input.scale);
          scaleOrigin.delete();
          const combined = trsf.Multiplied(scaleTrsf);
          scaleTrsf.delete();
          trsf.delete();
          trsf = combined;
        }
        const moved = buildShape(
          new oc.BRepBuilderAPI_Transform(shape.value, trsf, false, true),
        );
        trsf.delete();
        return ok(wrapSolid(moved));
      });
    },

    mirror(solid: KernelSolid, input: MirrorInput): KernelResult<KernelSolid> {
      return run("mirror", KERNEL_ERROR_CODES.invalidLength, () => {
        const shape = shapeOf(solid, "mirror");
        if (!shape.ok) return fail(shape.error);
        // Every finite offset is a legal plane position (zero and negative
        // offsets included — the sign rules of sizes do not apply to plane
        // positions); only non-finite magnitudes reject, before any OCCT
        // object exists.
        const offset = lengthIn(input.offset, "offset", "mirror");
        if (!offset.ok) return fail(offset.error);
        // The reflection through the axis plane at the offset: gp_Ax2
        // locates the plane (its main direction N is the plane normal),
        // SetMirror makes the trsf the plane reflection, and
        // BRepBuilderAPI_Transform applies it — the negative determinant's
        // orientation handled by the engine (probed: positive GProp volume,
        // outward tessellation normals).
        const components: readonly [number, number, number] =
          input.axis === "x"
            ? [offset.value, 0, 0]
            : input.axis === "y"
              ? [0, offset.value, 0]
              : [0, 0, offset.value];
        const normal: readonly [number, number, number] =
          input.axis === "x"
            ? [1, 0, 0]
            : input.axis === "y"
              ? [0, 1, 0]
              : [0, 0, 1];
        const point = new oc.gp_Pnt(
          components[0],
          components[1],
          components[2],
        );
        const direction = new oc.gp_Dir(normal[0], normal[1], normal[2]);
        // Vx only parameterizes the plane; any unit vector perpendicular
        // to N serves — the reflection itself depends on point and N only.
        const xDirection =
          input.axis === "x" ? new oc.gp_Dir(0, 1, 0) : new oc.gp_Dir(1, 0, 0);
        const ax2 = new oc.gp_Ax2(point, direction, xDirection);
        point.delete();
        direction.delete();
        xDirection.delete();
        const trsf = new oc.gp_Trsf();
        trsf.SetMirror(ax2);
        ax2.delete();
        const mirrored = buildShape(
          new oc.BRepBuilderAPI_Transform(shape.value, trsf, false, true),
        );
        trsf.delete();
        return ok(wrapSolid(mirrored));
      });
    },

    bounds(solid: KernelSolid): KernelResult<KernelBounds> {
      // Same no-throw boundary as every operation (the read-only sibling
      // topologySnapshot's discipline): a binding-level throw out of
      // AddOptimal is normalized into the structured kernel-failure code.
      return run("bounds", KERNEL_ERROR_CODES.invalidOperands, () => {
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
      });
    },

    volume(solid: KernelSolid): KernelResult<number> {
      // Same no-throw boundary: a VolumeProperties binding throw is
      // normalized, never escaped (the props wrapper's finally stays inside).
      return run("volume", KERNEL_ERROR_CODES.invalidOperands, () => {
        const shape = shapeOf(solid, "volume");
        if (!shape.ok) return fail(shape.error);
        // Exact BREP integration; an empty solid measures exactly 0.
        return ok(volumeOfShape(shape.value));
      });
    },

    area(solid: KernelSolid): KernelResult<number> {
      // Same no-throw boundary: a SurfaceProperties binding throw is
      // normalized, never escaped.
      return run("area", KERNEL_ERROR_CODES.invalidOperands, () => {
        const shape = shapeOf(solid, "area");
        if (!shape.ok) return fail(shape.error);
        // Exact BREP surface integration (probed: analytic-exact on the
        // plate-with-bore); an empty compound measures exactly 0.
        return ok(areaOfShape(shape.value));
      });
    },

    tessellate(solid: KernelSolid): KernelResult<Tessellation> {
      // Same no-throw boundary: the mesh extractor's extract call sits
      // inside it too (a throw there must not escape the kernel raw).
      return run(
        "tessellate",
        KERNEL_ERROR_CODES.invalidOperands,
        (): KernelResult<Tessellation> => {
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
            // growth), copied out immediately — no allocation between the
            // view and the copy. Sizes are element counts (probed): float32
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
              new Float32Array(
                buffer,
                data.getNormalsPtr(),
                data.getNormalsSize(),
              ),
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
      );
    },

    dispose(solid: KernelSolid): void {
      const payload = tag.unwrap(solid);
      if (payload === undefined || payload.shape === null) return;
      payload.shape.delete();
      payload.shape = null;
    },

    topologySnapshot(
      solid: KernelSolid,
      options: OcctTopologySnapshotOptions,
    ): ParseResult<TopologySnapshot, KernelError> {
      // Same no-throw discipline as every operation: handle resolution and
      // option validation first, the topology exploration inside the
      // boundary, and anything unexpected normalized into the structured
      // kernel-failure code.
      if (!Number.isInteger(options.regeneration) || options.regeneration < 0) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidOperands,
            `topologySnapshot rejected regeneration ${String(options.regeneration)}: it must be a non-negative integer.`,
          ),
        );
      }
      try {
        const shape = shapeOf(solid, "topologySnapshot");
        if (!shape.ok) return fail(shape.error);
        return ok({
          kernelId: OCCT_BACKEND_ID,
          persistentTopology: true,
          identitySchemas: [OCCT_TOPOLOGY_IDENTITY_SCHEMA],
          bodyId: options.bodyId,
          regeneration: options.regeneration,
          entities: occtShapeTopology(
            oc,
            shape.value,
            options.kinds ?? OCCT_TOPOLOGY_DEFAULT_KINDS,
          ),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidOperands,
            `topologySnapshot failed inside the OpenCascade kernel boundary: ${detail}`,
          ),
        );
      }
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
