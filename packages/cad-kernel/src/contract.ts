/**
 * The kernel-independent geometry contract (Phase 8): the operations, input
 * and output types every geometry kernel backend must implement. The fake
 * kernel (`./fake-kernel`) is the reference implementation; the Phase 9
 * Manifold adapter implements the same interface, and the shared contract
 * suite (`./contract-suite`) judges any implementation.
 *
 * ## Units
 *
 * Inputs are grounded in cad-core's {@link AnyDimensionalValue} family: every
 * length input is a `LengthValue`, so the unit registry in cad-core stays the
 * single source of truth and callers may pass any length unit (`mm`, `cm`,
 * `m`, `in`). Kernels convert to canonical millimetres internally.
 *
 * Outputs are plain numbers in the registry's canonical units — bounds in
 * millimetres, volume in cubic millimetres — because outputs are kernel
 * *measurements*, already normalized; converting them to another unit is a
 * cad-core concern, and canonical numbers keep results JSON-safe and
 * directly comparable across kernels.
 *
 * ## Placement conventions (canonical mm)
 *
 * - `box`: min corner at the origin; occupies `[0,width] × [0,depth] ×
 *   [0,height]`.
 * - `sphere`: centred at the origin; `x²+y²+z² ≤ radius²`.
 * - `cylinder`: circular cross-section centred on the z axis; occupies
 *   `x²+y² ≤ radius²`, `0 ≤ z ≤ height`.
 * - `cone`: frustum on the z axis; radius `bottomRadius` at `z = 0`
 *   interpolating linearly to `topRadius` at `z = height` (`topRadius` 0 is
 *   a sharp cone).
 *
 * The origin/`z = 0` footing (rather than the spike's origin-centred
 * Manifold primitives, `centered = true`) is deliberate: a primitive's
 * bounds read straight off its inputs and placing one inside an assembly is
 * a plain `transform` offset — no `width/2` half-extent bookkeeping at every
 * call site — which keeps bounds semantics and regeneration placements
 * composable from parameters alone. `transform`'s optional rotation (Phase
 * 21.1) turns a solid about an axis through the world origin before the
 * translation applies, so placements compose rigidly: parametric offsets
 * stay translations, and orientation changes are an explicit rotation.
 *
 * ## Solid semantics
 *
 * Operations are pure functions of their inputs: the same inputs produce the
 * same measurements and tessellation on every call. A solid may be *empty*
 * (e.g. a subtraction that removes everything, or an intersection of
 * disjoint operands): `volume` of an empty solid is `0`, `tessellate`
 * returns an empty soup (zero triangles), and `bounds` fails with
 * `kernel/bounds-empty` because an empty set has no bounding box.
 *
 * Every operation reports failure as a structured {@link KernelError} —
 * never a throw, never `NaN`/`Infinity` in outputs.
 */

import type {
  AngleValue,
  LengthValue,
  ParseFailure,
  ParseResult,
} from "@slopcad/cad-core";
import type { KernelBackendId } from "./backend-ids";
import type { KernelCapabilities } from "./capabilities";
import type { KernelSolid } from "./opaque";
export type { KernelSolid } from "./opaque";

/** Stable failure codes produced when a kernel operation rejects input. */
export const KERNEL_ERROR_CODES = {
  /** A length input was non-positive (or a cone's top radius negative). */
  invalidLength: "kernel/invalid-length",
  /**
   * A rotation input was degenerate: a zero or non-finite axis vector, or a
   * non-finite angle. Also the structured rejection a non-rotation-capable
   * kernel may use when `transform` carries a rotation.
   */
  invalidRotation: "kernel/invalid-rotation",
  /**
   * A profile-extrusion input was degenerate: an empty loop, a loop that
   * does not close, a zero-length line segment, a zero-radius circular
   * segment, or a non-positive height (Phase 26.1).
   */
  invalidProfile: "kernel/invalid-profile",
  /**
   * A revolve's sweep angle was outside the documented domain `(0, 2π]` —
   * angle 0 sweeps no material and angles beyond a full turn double-cover
   * it (Phase 26.2). Non-finite angle magnitudes stay on the
   * `invalid-rotation` angle-class code.
   */
  invalidSweepAngle: "kernel/invalid-sweep-angle",
  /**
   * A revolve's profile crossed its revolve axis: the boundary carries
   * material strictly on BOTH sides of the axis line (Phase 26.2). Touching
   * is legal — on-axis vertices, edges collinear with the axis, and
   * tangency all revolve cleanly — and every kernel rejects the crossing
   * BEFORE its geometry runs, because the mesh kernels would otherwise
   * silently clip the negative side (probed: Manifold keeps only the
   * positive-x part; JSCAD caps it) and OCCT builds an undefined solid.
   */
  profileAxisCrossing: "kernel/profile-axis-crossing",
  /**
   * A sweep's path was structurally invalid (Phase 26.3): an empty path, a
   * zero-length line, a zero-radius or zero-sweep arc, a gap in the chain,
   * a path that does not start at the local origin, an initial tangent that
   * is not the profile plane's normal (+z — the perpendicular-attachment
   * rule), or a tangent discontinuity (kink) at a segment joint.
   */
  invalidPath: "kernel/invalid-path",
  /**
   * A sweep's path self-intersects (Phase 26.3): the path's chord polyline
   * crosses itself away from shared joint endpoints, detected at resolution
   * time by every kernel BEFORE its geometry runs — a self-crossing spine
   * sweeps an undefined solid everywhere.
   */
  pathSelfIntersecting: "kernel/path-self-intersecting",
  /**
   * A sweep's solid would self-intersect by pinching through a bend
   * (Phase 26.3): the profile carries material strictly on BOTH sides of
   * some arc segment's centre axis — the tight-radius bend — detected
   * exactly (lines, arcs, circles) before any geometry runs. Touching the
   * axis is legal, like revolve's axis touching. Broader swept-body
   * self-intersection (the tube colliding with itself along distant path
   * portions) is NOT detected — see the sweep honesty documentation.
   */
  sweepSelfIntersecting: "kernel/sweep-self-intersecting",
  /**
   * A loft's profile collection cannot be lofted together (Phase 26.4): the
   * sections' chord polygons cannot be put in vertex correspondence — their
   * tessellated vertex counts (at the shared angular deflection) differ —
   * detected by every kernel BEFORE its geometry runs. The correspondence
   * is index-based by contract, and engines left to invent their own would
   * build DIFFERENT solids from the same input (probed: JSCAD's
   * `extrudeFromSlices` silently repartitions mismatched slices to the LCM
   * edge count with even mid-edge splits; OCCT's ThruSections compatibility
   * pass chooses its own wire origins) — the 26.1 lesson: no silent
   * acceptance of collections a kernel will mangle. Callers morph loops to
   * matching counts BEFORE the kernel (the contract documents the rule; it
   * does not guess a correspondence).
   */
  loftIncompatibleProfiles: "kernel/loft-incompatible-profiles",
  /**
   * A loft's stations are not strictly increasing along the ordered section
   * list (Phase 26.4): two sections at the same z span zero height (an
   * undefined vertical morph), and a list that folds back lofts a
   * self-overlapping solid. The section order IS the loft direction — the
   * kernel never re-sorts it.
   */
  loftUnorderedStations: "kernel/loft-unordered-stations",
  /**
   * A fillet's edge ordinal does not address an edge of the target solid's
   * topology snapshot (Phase 26.5): the `(kind: "edge", ordinal)` address
   * the call carries is well formed but names nothing in the target's
   * current edge numbering — a stale reference resolved against an older
   * regeneration, or an out-of-range ordinal. Distinct from malformed input
   * (`kernel/invalid-operands`), which covers non-integers, negatives, and
   * duplicates.
   */
  filletEdgeUnknown: "kernel/fillet-edge-unknown",
  /**
   * A fillet could not be built (Phase 26.5): the kernel's own fillet
   * algorithm failed after validation passed — canonically a radius too
   * large for the selected edges (probed: OCCT's `BRepFilletAPI_MakeFillet`
   * answers `IsDone() = false`, no throw, when the radius exceeds the
   * adjacent faces' reach), or fillets whose removed regions interfere.
   * The kernel's failure is surfaced structured, never swallowed.
   */
  filletFailed: "kernel/fillet-failed",
  /**
   * A chamfer's edge ordinal does not address an edge of the target solid's
   * topology snapshot (Phase 26.6) — the fillet's stale-reference signature,
   * verbatim, for the chamfer: a well-formed `(kind: "edge", ordinal)`
   * address that names nothing in the target's current edge numbering.
   */
  chamferEdgeUnknown: "kernel/chamfer-edge-unknown",
  /**
   * A chamfer could not be built (Phase 26.6): the kernel's own chamfer
   * algorithm failed after validation passed — canonically a distance the
   * adjacent faces cannot carry (probed: OCCT's `BRepFilletAPI_MakeChamfer`
   * answers `IsDone() = false`, no throw, for a distance that meets or
   * exceeds an adjacent face's reach, and declines interfering chamfers the
   * same way; the cylinder's seam edge throws inside the WASM boundary
   * instead, which the no-throw boundary normalizes into this same code).
   * The kernel's failure is surfaced structured, never swallowed.
   */
  chamferFailed: "kernel/chamfer-failed",
  /**
   * A shell's face ordinal does not address a face of the target solid's
   * topology snapshot (Phase 26.7) — the fillet/chamfer stale-reference
   * signature generalized to the FACE address: a well-formed
   * `(kind: "face", ordinal)` that names nothing in the target's current
   * face numbering. Distinct from malformed input (`kernel/invalid-operands`),
   * which covers non-integers, negatives, duplicates, and the empty list.
   */
  shellFaceUnknown: "kernel/shell-face-unknown",
  /**
   * A shell could not be built (Phase 26.7): the walls could not be
   * hollowed at the requested thickness — canonically TOO THICK, the walls
   * meeting or crossing before the removed face is reached. Probed, OCCT's
   * `BRepOffsetAPI_MakeThickSolid` does NOT answer `IsDone() = false` for
   * degenerate thicknesses: past the collapse it silently returns the
   * PRISTINE target (measured: the full 6000 mm³ box, its 6 faces, face
   * removal vanished), at an exact cross-collapse it returns a ZERO-volume
   * solid, and at the exact open-axis collapse `Shape()` THROWS inside the
   * WASM boundary — so the adapter enforces the semantic post-condition
   * (a hollowed shell keeps strictly positive volume, strictly below the
   * target's) and surfaces every violation and every boundary throw as this
   * structured code, never as the engine's silent degenerate answer.
   */
  shellFailed: "kernel/shell-failed",
  /**
   * The kernel's engine cannot implement an operation honestly (first
   * arriving with Phase 26.3's sweep: the Manifold adapter, whose engine
   * has no sweep primitive — probed). Distinct from an INVALID input: the
   * input may be perfectly legal, the engine simply lacks the operation.
   * The kernel's capability flags say so up front; this code is the
   * structured answer when a call goes through anyway — an adapter must
   * never silently approximate badly in place of it.
   */
  unsupportedOperation: "kernel/unsupported-operation",
  /**
   * A helix sweep's analytic spine was degenerate (Phase 40): a
   * non-positive radius, a negative pitch (handedness carries direction —
   * the advance per turn is a magnitude), a non-positive or non-finite
   * turn count, a taper that drives the radius to zero anywhere along the
   * spine, or the flat circle (zero pitch AND zero taper — a circle is a
   * revolve/sweep, not a helix). Distinct from a malformed profile loop,
   * which stays on the profile machinery's own `kernel/invalid-profile`.
   */
  invalidHelix: "kernel/invalid-helix",
  /**
   * A helix sweep's consecutive turns carry overlapping material (Phase
   * 40): the profile's axial extent exceeds one pitch with more than one
   * turn. The input is LEGAL — engines that build the union answer it with
   * their own honest solid — but kernels whose analytic volume counts the
   * swept image with multiplicity (the fake kernel's screw-solid model)
   * decline with this code rather than silently overcounting: the
   * documented per-kernel subset discipline.
   */
  helixTurnOverlap: "kernel/helix-turn-overlap",
  /** A boolean operand list was malformed (wrong operand count). */
  invalidOperands: "kernel/invalid-operands",
  /** A handle was not minted by this kernel instance (foreign or forged). */
  solidNotOwned: "kernel/solid-not-owned",
  /** Bounds were requested of an empty solid, which has no bounding box. */
  boundsEmpty: "kernel/bounds-empty",
} as const;

export type KernelErrorCode =
  (typeof KERNEL_ERROR_CODES)[keyof typeof KERNEL_ERROR_CODES];

/** Structured failure describing why a kernel operation rejected input. */
export interface KernelError extends ParseFailure {
  readonly code: KernelErrorCode;
}

/**
 * The result shape of every kernel operation: success carries the value,
 * failure carries a structured {@link KernelError}. Built on cad-core's
 * `ParseResult` so kernel failures compose with the rest of the stack's
 * result discipline.
 */
export type KernelResult<T> = ParseResult<T, KernelError>;

/** Input of `createBox`: the box's extents along x, y, z (all positive). */
export interface BoxInput {
  readonly width: LengthValue;
  readonly depth: LengthValue;
  readonly height: LengthValue;
}

/** Input of `createSphere`: the radius (positive). */
export interface SphereInput {
  readonly radius: LengthValue;
}

/** Input of `createCylinder`: the radius (positive) and height (positive). */
export interface CylinderInput {
  readonly radius: LengthValue;
  readonly height: LengthValue;
}

/**
 * Input of `createCone`: the frustum's radii at `z = 0` and `z = height`
 * (`bottomRadius` positive, `topRadius` non-negative — 0 is a sharp cone),
 * and the height (positive).
 */
export interface ConeInput {
  readonly bottomRadius: LengthValue;
  readonly topRadius: LengthValue;
  readonly height: LengthValue;
}

/** Input of `transform`: a translation vector (any finite lengths). */
export interface TranslationInput {
  readonly x: LengthValue;
  readonly y: LengthValue;
  readonly z: LengthValue;
}

/**
 * Input of `transform`'s optional rotation (the Phase 21.1 contract
 * extension that the `transformRotation` capability flag has gated since
 * Phase 8): a rotation about an axis through the world origin.
 *
 * Representation is axis + angle (not Euler angles) because it maps onto
 * every kernel's rigid-transform primitive directly and carries none of
 * Euler's ordering/gimbal ambiguities: `axis` is a dimensionless direction
 * in the canonical right-handed millimetre space — any non-zero finite
 * vector, normalized by the kernel, so callers never pre-normalize — and
 * `angle` is an {@link AngleValue} in any angle unit (canonical radian,
 * positive by the right-hand rule about the axis).
 */
export interface RotationInput {
  readonly axis: readonly [number, number, number];
  readonly angle: AngleValue;
}

/**
 * One boundary segment of an extrusion profile, in the LOCAL workplane frame
 * (millimetres; angles in any angle unit, canonicalized internally). Lines
 * run from `start` to `end`; arcs sweep counter-clockwise from `startAngle`
 * to `endAngle` about `center` (the sweep is `(end − start) mod 2π`, never
 * zero); a circle is the closed full-radius loop at `center`.
 *
 * Phase 36 adds the analytic curved kinds: `ellipse` (the closed full
 * ellipse; center + semi-axes + the rotation of the radiusX axis) and
 * `ellipticalArc` (the same parameterization with the CCW parametric sweep
 * `(end − start) mod 2π`, never zero); and `spline` (a cubic Bézier chain —
 * `flavor: "control"` points number 4, 7, 10, … with segment k spanning
 * points `3k…3k+3`; `flavor: "interpolated"` points are fit points the
 * uniform Catmull-Rom spline passes through, converted per-span to its exact
 * Bézier equivalent by every consumer). Fidelity is per-kernel and
 * documented on each profile op: the OCCT adapter builds exact
 * `gp_Elips`/`Geom_BezierCurve` edges (probed: exact ellipse areas and
 * volumes); the mesh kernels (Manifold, JSCAD) and the fake kernel chord
 * the curve at their shared deflection discipline — ellipses at the
 * turning-bounded parametric step (dφ/dt ≤ max(a/b, b/a), so every chord's
 * turning stays within `PROFILE_MAX_SEGMENT_ANGLE_RAD`), splines at the
 * convex-hull flatness bound (curve within
 * `PROFILE_SPLINE_DEFLECTION_MM` of every chord, vertices on the true
 * curve) — the same class of curved band the circular segments carry.
 */
export type ProfileSegmentInput =
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
      readonly rotation: AngleValue;
    }
  | {
      readonly kind: "ellipticalArc";
      readonly center: readonly [number, number];
      readonly radiusX: number;
      readonly radiusY: number;
      readonly rotation: AngleValue;
      readonly startAngle: AngleValue;
      readonly endAngle: AngleValue;
    }
  | {
      readonly kind: "spline";
      readonly flavor: "control" | "interpolated";
      readonly points: readonly (readonly [number, number])[];
    };

/** The spline flavors a `spline` profile segment carries. */
export const PROFILE_SPLINE_FLAVORS = ["control", "interpolated"] as const;

export type ProfileSplineFlavor = (typeof PROFILE_SPLINE_FLAVORS)[number];

/**
 * The placement of an extrusion or revolution: a rotation about the world
 * origin applied FIRST (mapping the profile's local frame onto its world
 * frame), then the translation — the same composition order `TransformInput`
 * pins.
 */
export interface ProfilePlacementInput {
  readonly rotation: RotationInput;
  readonly translation: TranslationInput;
}

/**
 * The revolve axis of `revolve` (Phase 26.2): a line IN the profile's local
 * plane, given by a point (local millimetres) and a direction (dimensionless,
 * any non-zero finite vector — the kernel normalizes it). The sweep follows
 * the right-hand rule about the normalized direction, starting at the
 * profile's own plane: a profile on the direction's left (positive cross
 * side) sweeps toward the local +z.
 */
export interface ProfileRevolveAxisInput {
  readonly point: readonly [number, number];
  readonly direction: readonly [number, number];
}

/**
 * Input of `extrude` (Phase 26.1): one closed profile loop, a strictly
 * positive height, the extrusion direction along the profile plane's normal
 * (`1`: local +z, so the solid spans local z ∈ [0, height]; `-1`: local −z,
 * spanning [−height, 0]), and the placement mapping the local frame into
 * world space.
 *
 * ## Profile requirements and per-kernel fidelity (the honesty contract)
 *
 * The loop must be CLOSED (each segment's endpoints meet its neighbours'
 * within double precision) and NON-DEGENERATE (no zero-length lines,
 * zero-radius circular segments, and it must bound a face). The loop should
 * be SIMPLE (non-self-intersecting): kernels are NOT required to detect
 * self-intersections — a tessellating kernel may accept a crossing contour
 * and produce an undefined solid (probed: the Manifold adapter prisms an
 * arc×arc-crossing loop into a wrong volume without any diagnostic; only a
 * zero-area contour trips its own degeneracy floor). Resolution-side
 * checks are therefore the first line of defense: cad-sketch's profile
 * resolution detects line×line, line×arc, AND arc×arc crossings and fails
 * with the structured `sketch/profile-self-intersecting` error BEFORE any
 * kernel sees the loop.
 *
 * Curved fidelity is a documented per-kernel matter: the OCCT adapter
 * prisms the exact analytic geometry (cylindrical walls, exact volumes);
 * the Manifold and fake adapters tessellate circular segments into chords
 * at their documented angular deflections, so curved-profile volumes sit
 * within the contract suite's curved band (≤ ~1%) of the analytic value,
 * while straight-polygon profiles are exact everywhere.
 */
export interface ProfileExtrudeInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly height: LengthValue;
  readonly direction: 1 | -1;
  readonly placement: ProfilePlacementInput;
}

/**
 * Input of `revolve` (Phase 26.2): one closed profile loop revolved about an
 * axis IN its own plane by a sweep angle, then placed like an extrusion.
 *
 * ## Semantics
 *
 * The profile lies in the local XY plane; the axis is a line of that plane
 * ({@link ProfileRevolveAxisInput}). The sweep starts at the profile's own
 * plane and runs by `angle` about the axis following the right-hand rule of
 * the axis direction: `angle = 2π` is the FULL revolve (a closed solid of
 * revolution), `0 < angle < 2π` a PARTIAL revolve capped at the start and
 * end planes. The domain is exactly `(0, 2π]` — zero sweeps no material,
 * beyond a full turn double-covers it.
 *
 * ## Axis validation (the honesty contract)
 *
 * The profile must NOT CROSS the axis: material strictly on both sides of
 * the axis line is rejected with `kernel/profile-axis-crossing` BEFORE any
 * geometry runs, by every kernel. Touching is legal and documented:
 * on-axis vertices, edges collinear with the axis, and tangency (an arc or
 * circle whose signed distance reaches zero but never changes sign) all
 * revolve cleanly — the mesh kernels would otherwise silently clip or cap
 * the far side (probed: Manifold keeps only the positive-radial part of a
 * crossing contour; JSCAD caps it to the axis), so the rejection is a
 * shared validator (cad-kernel's `revolveCrossesAxis`, exact over lines,
 * arcs, and circles) run by each adapter. A degenerate axis direction
 * (zero or non-finite) rejects with `kernel/invalid-rotation`, like every
 * degenerate rotation input.
 *
 * ## Fidelity (per kernel)
 *
 * The OCCT adapter revolves the exact analytic profile
 * (`BRepPrimAPI_MakeRevol`): volumes of straight-profile revolves are the
 * exact Pappus values (`V = θ·d̄·A`), curved profiles exact surfaces of
 * revolution. The Manifold and JSCAD adapters revolve the chord polygon at
 * the shared mesh-kernel deflection, so curved revolutions sit within the
 * contract suite's curved band of the analytic value (measured ≈0.166%
 * deficit at the documented 63-chord resolution for a full turn); the fake
 * kernel's revolution is analytic over the same chord polygon (Pappus
 * exactly, no quadrature).
 */
export interface ProfileRevolveInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly axis: ProfileRevolveAxisInput;
  readonly angle: AngleValue;
  readonly placement: ProfilePlacementInput;
}

/**
 * One segment of a `sweep` path (Phase 26.3): an open chain in the LOCAL
 * XZ plane, given as 2D `(x, z)` millimetre coordinates (the local y axis
 * is the path plane's binormal). Lines run from `start` to `end`; arcs run
 * about `center` with a SIGNED sweep — `endAngle − startAngle`, NOT the
 * profile machinery's mod-2π convention: positive sweeps counter-clockwise
 * in the (x, z) plane (the tube bends toward −x from the traveller's
 * viewpoint), negative sweeps clockwise (bending toward +x), and the
 * magnitude is in `(0, 2π]` (a full `2π` arc is the closed circular path —
 * only geometrically consistent as the chain's sole segment).
 *
 * The signed-sweep deviation from the profile's loop convention is
 * deliberate: a loop is a closed boundary whose traversal direction is
 * irrelevant (any direction yields the same face), while a path is a
 * directed trajectory — an S-curve needs both bend directions, and a
 * mod-2π arc type can only ever turn one way.
 */
export type SweepPathSegmentInput =
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
 * Input of `sweep` (Phase 26.3): one closed profile loop in the local XY
 * plane carried along a path chain in the local XZ plane, then placed like
 * an extrusion.
 *
 * ## Semantics — the canonical transport
 *
 * The profile lies in the local XY plane (planar by construction, like
 * every profile op) with the path starting at the local origin and running
 * along the profile plane's normal, local +z: the perpendicular-attachment
 * rule, validated up front (a path whose first tangent is not +z rejects
 * with `kernel/invalid-path` — an obliquely-attached profile sweeps a
 * different solid in every engine, so the contract pins the one canonical
 * attachment). The chain must be continuous (endpoints meet within the
 * shared closure tolerance) and G1 (tangent-continuous — no kinks): at
 * every joint the incoming and outgoing tangents agree, validated before
 * any geometry runs. A path whose final endpoint returns to the origin is
 * a CLOSED ring (the swept tube closes on itself, capped at nothing); a
 * lone full-circle arc is the canonical closed ring.
 *
 * The transport is the planar fixed-binormal frame: straight pieces
 * translate the profile along the tangent, arc pieces rotate it about the
 * arc's centre axis (the line through the arc centre along local y) by the
 * signed sweep — every arc piece is a partial revolution in disguise, and
 * the swept volume is Pappus-exact: `V = Σ A·Lᵢ + Σ θⱼ·|d̄ⱼ|·A` (line
 * pieces by Cavalieri, arc pieces by Pappus with `d̄ⱼ` the profile
 * centroid's signed distance to arc j's axis). No twist exists for planar
 * paths in this frame — it is the same sweep OCCT's corrected-Frenet pipe
 * produces (probed).
 *
 * ## Orientation and self-intersection (the honesty contract)
 *
 * Three checks run before any kernel geometry, as structured rejections:
 *
 * - The PATH must not self-intersect: `kernel/path-self-intersecting`,
 *   detected on the path's chord polyline (arcs chorded at the shared
 *   deflection) — a crossing or a collinear overlap away from shared joint
 *   endpoints. Cheap and total.
 * - The SWEEP must not pinch through a bend: `kernel/sweep-self-intersecting`
 *   when the profile carries material strictly on both sides of some arc's
 *   centre axis (the exact revolve crossing machinery, reused per arc —
 *   touching is legal). This is every self-intersection that a planar G1
 *   chain can produce LOCALLY.
 * - Broader swept-body self-intersection — the tube colliding with itself
 *   where the path returns near earlier stations with the profile wider
 *   than the clearance — is NOT detected by the kernel contract, honestly:
 *   global proximity testing is not cheap at probe scope, and the 26.1
 *   lesson (a claimed check that does not exist) forbids pretending. A
 *   document-level analyzer owns that check later; kernels that build such
 *   a sweep return their own engine's honest output (OCCT's pipe of a
 *   globally self-overlapping spine is an undefined solid, like its
 *   booleans of degenerate input — semantic judgement of those fixtures is
 *   out of contract scope).
 *
 * ## Per-kernel fidelity (the coverage matrix)
 *
 * - OCCT: exact analytic sweep (`BRepOffsetAPI_MakePipeShell` over the
 *   exact profile and spine wires; probed exact — straight spine prisms and
 *   arc/torus Pappus volumes at 0 relative error). `sweep: true`.
 * - Fake: the analytic Pappus decomposition above over the chord polygon —
 *   exact for straight-edge profiles, the documented chord band for curved
 *   ones; bounds exact per piece; tessellation per piece at the shared
 *   deflection. `sweep: true`.
 * - JSCAD: the profile chord polygon lofted between transported stations
 *   (`extrudeFromSlices`) at the shared deflection — straight paths exact,
 *   curved paths inside the documented station band. `sweep: true`.
 * - Manifold: `sweep: false` — the engine has no sweep or loft primitive
 *   (probed; its constructors are extrude/revolve/hull/levelSet only), and
 *   hand-rolling a tube mesh would be adapter-side meshing, not a kernel
 *   operation. `sweep` rejects with `kernel/unsupported-operation` — the
 *   honest structured answer, never a bad approximation.
 */
export interface ProfileSweepInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly path: readonly SweepPathSegmentInput[];
  readonly placement: ProfilePlacementInput;
}

/**
 * The analytic helix spine of `helixSweep` (Phase 40): radius, pitch,
 * turns, handedness, start angle, and optional taper, in the operation's
 * LOCAL frame (axis = local +z, base center at the local origin).
 *
 * ## The parametrization (the convention the contract pins)
 *
 * `p(t) = R(t)·(cos θ(t)·x̂ + sin θ(t)·ŷ) + h(t)·ẑ` for `t ∈ [0, 1]` with
 * `θ(t) = θ₀ + H·2π·turns·t`, `h(t) = pitch·turns·t`,
 * `R(t) = radius + taper·t`: handedness `H` is `+1` for RIGHT-handed
 * (advancing along +z while winding counter-clockwise about it, the
 * right-hand rule) and `−1` for LEFT-handed; `pitch` is a magnitude (the
 * axial advance per full turn, ≥ 0 — direction is handedness's job);
 * `taper` is the TOTAL signed radius change over the whole spine (a cone
 * angle in linear form), and `R(t)` must stay strictly positive — a
 * radius that reaches zero is a cone tip, which a revolve builds, not a
 * helix. A zero pitch with a non-zero taper is the flat spiral (radius
 * linear in angle, z constant); zero pitch AND zero taper is a circle and
 * rejects with `kernel/invalid-helix` — the planar sweep machinery owns
 * circles.
 */
export interface HelixSpineInput {
  /** The start radius `R₀` (strictly positive). */
  readonly radius: LengthValue;
  /** The axial advance per full turn (non-negative; 0 = a flat spiral). */
  readonly pitch: LengthValue;
  /** The number of turns (strictly positive; fractional turns are legal). */
  readonly turns: number;
  /** `+1` right-handed, `−1` left-handed (the sign on the angular term). */
  readonly handedness: 1 | -1;
  /** The start angle `θ₀` in any angle unit (canonicalized internally). */
  readonly startAngle: AngleValue;
  /** The TOTAL signed radius change over the spine (R(t) stays positive). */
  readonly taper?: LengthValue;
}

/**
 * Input of `helixSweep` (Phase 40): one closed profile loop drawn in the
 * START MERIDIAN — the local xz plane through the spine's start point,
 * loop coordinates `(u, v) = (radial offset, axial offset)` measured FROM
 * that start point — carried along the analytic helix spine, then placed
 * like every profile op.
 *
 * ## The meridian transport (the frame the contract pins, and why)
 *
 * The sweep carries the profile by the rigid motion
 * `M_t(p(0) + u·r̂(θ₀) + v·ẑ) = p(t) + u·r̂(θ(t)) + v·ẑ` — a rotation
 * about the spine axis by the swept angle, plus the translation carrying
 * the start point onto the current spine point. This is THE thread
 * tooth's frame: the ISO thread profile is specified in an AXIAL plane,
 * and the meridian is that plane carried along the helix. It is
 * drift-free BY CONSTRUCTION (one fixed rotation axis; no torsion-induced
 * twist accumulates — the stability the plan demands, stated: the sweep
 * uses the meridian frame, and the only rotation is about the spine
 * axis). For comparison, the Frenet trihedron of an untapered helix
 * equals this frame rotated by the CONSTANT lead angle about the radial
 * direction — equally drift-free, but never coincident, because the
 * Frenet SECTION is perpendicular to the tangent while the meridian
 * never is: pipe builders (OCCT's `BRepOffsetAPI_MakePipeShell`) carry
 * section-perpendicular profiles and therefore cannot produce the
 * meridian solid exactly.
 *
 * ## The screw solid and the exact volume
 *
 * In cylindrical coordinates the result is the SCREW SOLID
 * `{(ρ, φ, ζ) : (ρ − R(t), ζ − h(t)) ∈ P, θ(t) ≡ φ (mod 2π)}` — the
 * material at every angle is the profile, screwed along the axis. The
 * transport's Jacobian is `|J| = (R(t) + u)·|θ′|` (the taper rate drops
 * out), so with `A` = profile area, `ū` = its centroid radial offset,
 * `R̄ = R₀ + taper/2` the mean radius:
 * `V = 2π·turns·A·(R̄ + ū)` — the multiplicity integral, which is the
 * SET volume exactly while no two turns overlap (profile axial extent ≤
 * pitch). Overlapping turns are legal input; the coverage matrix below
 * says who builds them and who declines.
 *
 * ## Validation battery (before any kernel geometry)
 *
 * - Spine degeneracy → `kernel/invalid-helix` (see {@link HelixSpineInput}).
 * - Profile validity → `kernel/invalid-profile` (the shared loop battery,
 *   over the loop as drawn in the meridian).
 * - Axis crossing → `kernel/profile-axis-crossing`: the transported
 *   profile must keep material on ONE side of the axis
 *   (`min_t (R(t) + u_min) ≥ 0`, touching legal — the revolve precedent);
 *   wrapping through the axis sweeps an undefined solid.
 * - Overlap → `kernel/helix-turn-overlap` (see the coverage matrix: a
 *   PER-KERNEL subset rule, not a contract-wide rejection).
 *
 * ## Per-kernel fidelity (the coverage matrix)
 *
 * - OCCT: the exact meridian stations ruled and lofted between
 *   (`BRepOffsetAPI_ThruSections` in ruled mode) — every station is the
 *   exact transported profile, the ruled spans approximate the screw
 *   motion between them; the volume sits inside the ruled band, which the
 *   fixtures derive and pin (convergence-checked by doubling the station
 *   rule). The exact analytic spine IS buildable on this binding
 *   (`Geom2d_Line` on `Geom_CylindricalSurface`/`Geom_ConicalSurface`
 *   parametric space, probed), but the pipe over it carries
 *   section-perpendicular profiles — a provably different solid (the
 *   meridian profile is never perpendicular to the tangent) — so the
 *   ruled-station route is the honest exactness. `helix: true`.
 * - Fake: the analytic screw solid — EXACT volume (the closed form
 *   above), EXACT membership (the inverse-screw branch test), exact
 *   untapered bounds, tapered bounds at the station resolution, and a
 *   deterministic station soup at the shared deflection. Declines
 *   OVERLAPPING turns with `kernel/helix-turn-overlap` (the multiplicity
 *   integral would overcount — the documented subset, the fillet/chamfer
 *   discipline). `helix: true`.
 * - Manifold / JSCAD: `helix: false` — no helical sweep primitive
 *   (probed/surveyed; the plan's ruling) — every call answers the
 *   structured `kernel/unsupported-operation`, never a hand-rolled
 *   approximation.
 */
export interface HelixSweepInput {
  /** The closed profile loop, in the start meridian (see the module doc). */
  readonly loop: readonly ProfileSegmentInput[];
  /** The analytic spine parameters (see {@link HelixSpineInput}). */
  readonly spine: HelixSpineInput;
  /** The placement mapping the local frame into world space. */
  readonly placement: ProfilePlacementInput;
}

/**
 * One section of `loft` (Phase 26.4): a closed profile loop in its OWN
 * station plane. The loop lies in a local XY plane exactly like an
 * extrusion profile, and `z` lifts that plane along the local z axis —
 * sections are ordered along the loft direction by their `z`.
 */
export interface ProfileLoftSectionInput {
  readonly loop: readonly ProfileSegmentInput[];
  readonly z: LengthValue;
}

/**
 * Input of `loft` (Phase 26.4): an ORDERED list of at least two sections,
 * each a closed profile loop at its station `z`, joined into one solid,
 * then placed like an extrusion.
 *
 * ## Semantics — the ruled vertex morph
 *
 * Each section's loop is tessellated into its chord polygon at the shared
 * angular deflection and normalized CCW. Between CONSECUTIVE stations the
 * solid is the RULED morph: polygon vertex i of section j corresponds to
 * vertex i of section j+1 — INDEX correspondence on the CCW chord
 * polygons, starting at each loop's own first boundary vertex — and each
 * pair of corresponding boundary edges joins by the ruled surface between
 * them (the bilinear patch), whose horizontal cross-section at span
 * parameter t is exactly the linear blend `(1−t)·Pⱼ + t·Pⱼ₊₁` of the two
 * polygons. The correspondence rule makes the twist expressible
 * (authoring a rotated second loop twists the loft; rotating its first
 * segment's start vertex re-phases it) — and it is ADAPTER-ENFORCED, not
 * an engine default: handed the authored sections alone, engines
 * re-origin them on a PHASE shift with no structural difference at all
 * (probed: OCCT's ThruSections compatibility pass de-twists a
 * start-vertex-rotated square→square loft back to the prism — 1000 mm³
 * on the h = 10 fixture where the index morph's Simpson value is
 * 2000/3), so the OCCT adapter disables that pass on equal-structure
 * collections and rules the CCW-normalized authored order itself.
 * Cross-section areas are QUADRATIC in t, so each span's volume is
 * Simpson-EXACT — `h/6·(Aⱼ + 4·A_mid + Aⱼ₊₁)` (the prismoidal
 * formula): a prismatic loft (identical sections) is the extrusion
 * definitionally, and similar concentric sections give the frustum
 * family (a circle-to-circle loft is the conical frustum
 * `πh(R² + Rr + r²)/3`).
 *
 * ## Collection validation (the honesty contract)
 *
 * Every kernel runs the shared battery BEFORE any geometry, as structured
 * rejections:
 *
 * - At least two sections: fewer rejects with `kernel/invalid-operands`
 *   (the boolean operand-list convention).
 * - Each member loop individually valid: the same shared validators
 *   `extrude` runs — closure, per-segment non-degeneracy, the ≥3-vertex
 *   and non-zero-area floors — rejecting with `kernel/invalid-profile`
 *   (the message names the offending section's 1-based index).
 * - VERTEX-COUNT COMPATIBILITY: all sections' chord polygons must carry
 *   the SAME vertex count, rejecting with
 *   `kernel/loft-incompatible-profiles`. The morph's index correspondence
 *   needs it, and the engines would otherwise each invent their own
 *   (probed: JSCAD's `extrudeFromSlices` repartitions mismatched slices
 *   to the LCM edge count with even mid-edge splits; OCCT's ThruSections
 *   compatibility pass re-originates wires) — silently building different
 *   solids from one input. Winding is NOT a compatibility rule: each loop
 *   is CCW-normalized independently (a boundary's authored direction is a
 *   convention, not shape). Equal STRUCTURE alone does not make the
 *   correspondence free either — engines re-origin on PHASE (the probe
 *   above: OCCT's pass de-twists the re-phased square→square loft), so
 *   the OCCT adapter turns the pass off there and aligns the CCW
 *   origins itself; the index correspondence is enforced by adapters
 *   wherever sections' segments correspond one-to-one. Sections with
 *   equal chord counts but different segment STRUCTURE (e.g. a circle
 *   and an authored 63-gon) pass the rule and keep the engine's
 *   compatibility pass (the edge repartition it performs); their
 *   correspondence follows each loop's own parameterization, which may
 *   differ between engines — the pinned semantic fixtures are the
 *   correspondence-unambiguous ones.
 * - STRICTLY INCREASING `z` along the list, rejecting with
 *   `kernel/loft-unordered-stations`: equal stations span zero height,
 *   and a list that folds back lofts a self-overlapping solid.
 *
 * ## Per-kernel fidelity (the coverage matrix)
 *
 * - OCCT: exact analytic loft (`BRepOffsetAPI_ThruSections` in ruled mode
 *   over the exact section wires — probed: a prism loft equals the prism
 *   volume, concentric circles give the exact conical frustum, and the
 *   twisted square the exact Simpson value, all at 0 relative error).
 *   `loft: true`.
 * - Fake: the Simpson/prismoidal decomposition over the chord polygons —
 *   exact for the ruled model (straight-edge sections), the documented
 *   chord band for curved ones; bounds exact (a linear morph's support
 *   extremes sit at span endpoints); classification exact (the morph
 *   polygon at the query's span). Its SOUP triangulates each ruled wall
 *   into two flat triangles — exact where the wall is planar (every
 *   untwisted loft) and a candidate soup on skew (twisted) walls, the
 *   boolean-soup honesty applied to a leaf: semantic truth lives in
 *   `volume`/`bounds`. `loft: true`.
 * - JSCAD: the chord polygons lofted between stations by
 *   `extrudeFromSlices` — flat-triangle walls ARE its representation,
 *   exact where the ruled walls are planar (probed: prism, frustum, and
 *   multi-station fixtures agree with the fake kernel to 1e-12; curved
 *   members carry the chord band), but a SKEW wall's bilinear patch
 *   cannot flatten: the twisted-square fixture builds the flat-wall
 *   solid (probed 2000/3 mm³ vs the ruled model's Simpson value — the
 *   per-kernel divergence), so twisted lofts are judged per kernel,
 *   never cross-kernel. `loft: true`.
 * - Manifold: `loft: false` — the engine has no loft primitive (probed;
 *   its constructors are extrude/revolve/hull/levelSet, and `extrude`'s
 *   twist/scale options cover only single-polygon two-station specials,
 *   not a section collection). `loft` rejects with
 *   `kernel/unsupported-operation` — the honest structured answer, never
 *   a hand-rolled mesh in its place.
 */
export interface ProfileLoftInput {
  readonly sections: readonly ProfileLoftSectionInput[];
  readonly placement: ProfilePlacementInput;
}

/**
 * Input of `fillet` (Phase 26.5): one target solid, the edges to round
 * addressed by ordinal, and one radius shared by all of them.
 *
 * ## Edge addressing — snapshot ordinals (the Phase 22 vocabulary)
 *
 * `edges` carries `(kind: "edge", ordinal)` addresses into the target's
 * TOPOLOGY SNAPSHOT — the same entity numbering a persistent-topology
 * kernel's snapshot operation reports (occurrence-collapsed, deterministic
 * within one regeneration; Phase 22). Ordinals are within-regeneration
 * addresses, not persistent identities: a feature resolves its persistent
 * edge references against the CURRENT regeneration's snapshot and passes
 * the resolved ordinals here. Every ordinal must be a non-negative integer
 * naming an edge of the target's snapshot numbering — a well-formed
 * ordinal that names nothing rejects with
 * `kernel/fillet-edge-unknown` (the stale-reference signature);
 * non-integers, negatives, duplicates, and an empty list reject with
 * `kernel/invalid-operands` before any geometry runs.
 *
 * ## Radius semantics
 *
 * The radius is one strictly positive length shared by every selected
 * edge (non-positive rejects with `kernel/invalid-length`, before the
 * engine — probed: a zero radius throws inside OCCT's WASM boundary). The
 * radius must FIT: each fillet consumes `radius` worth of material along
 * both faces adjacent to its edge, and a radius that outruns them is the
 * engine's structured failure (`kernel/fillet-failed` — probed: OCCT
 * answers `IsDone() = false`, no throw, for a radius past the adjacent
 * faces' reach).
 *
 * ## Smooth (seam/tangent) edges — probed, honestly scoped
 *
 * A tangent-continuous edge (a cylinder's seam) rounds no corner, and
 * the engines disagree about what to do with one: probed, OCCT REJECTS
 * the seam-edge fillet on this binding — a true cylinder seam (the
 * straight stitched edge whose measure is the height) declined at every
 * probed radius with the structured `kernel/fillet-failed` (the
 * `IsDone() = false` decline, no throw). The contract pins no seam
 * semantics ACROSS engines: fillet behaviour on smooth edges is
 * engine-specific, and only the corner/crease fixtures below are judged
 * (a cylinder's rim circles are ordinary crease edges and fillet as
 * such). Kernels whose whole engine lacks filleting decline it
 * wholesale (see the coverage matrix).
 *
 * ## Per-kernel fidelity (the coverage matrix)
 *
 * - OCCT: exact analytic fillets (`BRepFilletAPI_MakeFillet`, probed: a
 *   box corner-edge fillet measures the analytic volume
 *   `W·D·H − r²·(1 − π/4)·L` at 0 relative error, multiple disjoint edges
 *   sum exactly, and an oversized radius fails `IsDone` cleanly).
 *   `fillet: true`.
 * - Fake: the analytic corner-fillet model over its documented box-edge
 *   subset — the target must be a pristine box leaf, the selected edges
 *   parallel, and their removed prism-quadrants disjoint; the volume,
 *   membership, and bounds are then exact (`W·D·H − Σ r²(1−π/4)·Lᵢ`),
 *   everything else declines with `kernel/unsupported-operation` or the
 *   structured fillet codes rather than an approximation. `fillet: true`
 *   (honestly scoped: see {@link FakeKernelFilletDomain} in the fake
 *   kernel's documentation).
 * - Manifold: `fillet: false` — the engine has no fillet primitive
 *   (probed; its smoothing is shading tangent interpolation, not
 *   geometry). `fillet` rejects with `kernel/unsupported-operation`.
 * - JSCAD: `fillet: false` — the engine's operation set carries no fillet
 *   (probed; booleans/extrusions/hulls/minkowski/expansions only).
 *   `fillet` rejects with `kernel/unsupported-operation`.
 */
export interface FilletInput {
  /** The solid whose edges are rounded. */
  readonly target: KernelSolid;
  /**
   * The edges to round, as the target's topology-snapshot edge ordinals
   * (see the module doc). At least one; no duplicates.
   */
  readonly edges: readonly number[];
  /** The fillet radius (strictly positive), shared by every selected edge. */
  readonly radius: LengthValue;
}

/**
 * Input of `chamfer` (Phase 26.6): one target solid, the edges to bevel
 * addressed by ordinal, and one distance shared by all of them — the
 * fillet's discipline (Phase 26.5) carried to the chamfer.
 *
 * ## Edge addressing — snapshot ordinals (the fillet rules, verbatim)
 *
 * `edges` carries `(kind: "edge", ordinal)` addresses into the target's
 * TOPOLOGY SNAPSHOT, exactly like `fillet`: ordinals are
 * within-regeneration addresses a feature resolves against the CURRENT
 * regeneration's snapshot before calling here. Every ordinal must be a
 * non-negative integer naming an edge of the target's snapshot numbering —
 * a well-formed ordinal that names nothing rejects with
 * `kernel/chamfer-edge-unknown` (the stale-reference signature);
 * non-integers, negatives, duplicates, and an empty list reject with
 * `kernel/invalid-operands` before any geometry runs.
 *
 * ## Distance semantics — the symmetric chamfer
 *
 * The distance is one strictly positive length shared by every selected
 * edge, and the chamfer is SYMMETRIC: the chamfer plane cuts `distance`
 * from the edge along BOTH adjacent faces (a 45° bevel where the faces meet
 * perpendicular, as every selected edge of the box fixtures does).
 * Non-positive distances reject with `kernel/invalid-length` before the
 * engine (probed: OCCT's `MakeChamfer` answers `IsDone() = false` for a
 * zero distance — never a degenerate solid, but the structured rejection
 * is the contract's answer). The distance must FIT the cross-section: each
 * chamfer consumes `distance` worth of material along both faces adjacent
 * to its edge, and a distance that meets or exceeds either adjacent face's
 * reach is the engine's structured failure (`kernel/chamfer-failed` —
 * probed: OCCT answers `IsDone() = false` at exactly the smaller adjacent
 * extent). A distance PAST the edge's own length stays legal and stays
 * exact (probed: OCCT measures the analytic prism `W·D·H − d²/2·L` at
 * 0 relative error for d beyond the edge length — the removed corner prism
 * lives in the cross plane, so the edge length bounds nothing).
 *
 * ## Smooth (seam/tangent) edges — probed, honestly scoped
 *
 * A tangent-continuous edge (a cylinder's seam) bevels no corner, and the
 * engines disagree about what to do with one: probed, OCCT's
 * `MakeChamfer` on a true cylinder seam (the straight stitched edge whose
 * measure is the height) THROWS inside the WASM boundary at every probed
 * distance (0.1 to 2 mm) — a DIFFERENT decline than `MakeFillet`'s clean
 * `IsDone() = false` on the same edge — and the adapter's no-throw
 * boundary normalizes that throw into the structured
 * `kernel/chamfer-failed`, never a raw exception. The contract pins no
 * seam semantics ACROSS engines: chamfer behaviour on smooth edges is
 * engine-specific, and only the corner/crease fixtures are judged (a
 * cylinder's rim circles are ordinary crease edges and chamfer as such).
 * Kernels whose whole engine lacks chamfering decline it wholesale (see
 * the coverage matrix).
 *
 * ## Per-kernel fidelity (the coverage matrix)
 *
 * - OCCT: exact analytic chamfers (`BRepFilletAPI_MakeChamfer`, probed: a
 *   box corner-edge chamfer measures the analytic prism volume
 *   `W·D·H − d²/2·L` at 0 relative error, multiple disjoint edges sum
 *   exactly, an oversized distance fails `IsDone` cleanly, and
 *   interfering same-face chamfers fail `IsDone` the same way).
 *   `chamfer: true`.
 * - Fake: the analytic corner-prism model over its documented box-edge
 *   subset — the same domain the fillet model scopes (a pristine box
 *   leaf, one parallel edge group, pairwise-disjoint removed prisms); the
 *   volume, membership, and bounds are then exact (`W·D·H − Σ d²/2·Lᵢ`),
 *   everything else declines with `kernel/unsupported-operation` or the
 *   structured chamfer codes rather than an approximation. `chamfer: true`
 *   (honestly scoped: see the fake kernel's fillet/chamfer subset docs).
 * - Manifold: `chamfer: false` — the engine has no chamfer primitive
 *   (probed; the same verdict as its fillet: the smoothing is shading
 *   tangent interpolation, not geometry). `chamfer` rejects with
 *   `kernel/unsupported-operation`.
 * - JSCAD: `chamfer: false` — the engine's operation set carries no
 *   chamfer (probed; the fillet's verdict verbatim: booleans, extrusions,
 *   hulls, minkowski, expansions, modifiers only). `chamfer` rejects with
 *   `kernel/unsupported-operation`.
 */
export interface ChamferInput {
  /** The solid whose edges are beveled. */
  readonly target: KernelSolid;
  /**
   * The edges to chamfer, as the target's topology-snapshot edge ordinals
   * (see the module doc). At least one; no duplicates.
   */
  readonly edges: readonly number[];
  /**
   * The symmetric chamfer distance (strictly positive), shared by every
   * selected edge.
   */
  readonly distance: LengthValue;
}

/**
 * Input of `shell` (Phase 26.7): one target solid, the faces to REMOVE
 * addressed by ordinal, and one wall thickness — the hollowing operation.
 *
 * ## Face addressing — snapshot ordinals (the 26.5/26.6 edge rules, on the
 * FACE kind)
 *
 * `faces` carries `(kind: "face", ordinal)` addresses into the target's
 * TOPOLOGY SNAPSHOT — the same within-regeneration numbering the fillet and
 * chamfer consume on the edge kind (Phase 22). Ordinals are
 * within-regeneration addresses, not persistent identities: a feature
 * resolves its persistent face references against the CURRENT
 * regeneration's snapshot and passes the resolved ordinals here. Every
 * ordinal must be a non-negative integer naming a face of the target's
 * snapshot numbering — a well-formed ordinal that names nothing rejects
 * with `kernel/shell-face-unknown` (the stale-reference signature);
 * non-integers, negatives, duplicates, and the EMPTY list reject with
 * `kernel/invalid-operands` before any geometry runs.
 *
 * ## Face-removal semantics — the open hollow shell (the probed scope)
 *
 * At least one face must be removed: the result is the target hollowed to
 * uniform `thickness` walls, OPEN at every removed face (an interior
 * cavity reachable through the openings). A FULLY CLOSED hollow (zero faces
 * removed — a solid with an interior void) is NOT supported by the
 * contract, a probed truth, not a guess: handed an empty closing list,
 * OCCT's `BRepOffsetAPI_MakeThickSolid.MakeThickSolidByJoin` does not
 * build the hollow walls at all — it returns the offset CAVITY region
 * itself (probed on the 30×20×10 box at t = 2: volume 2496 mm³, the
 * 26×16×6 inner box, 6 faces — the closed hollow would measure 3504 mm³),
 * a different solid wearing the operation's name. The empty list therefore
 * rejects with `kernel/invalid-operands`, and the closed hollow stays out
 * of scope until a kernel is probed to build it honestly.
 *
 * ## Thickness semantics
 *
 * The thickness is one strictly positive length shared by every wall
 * (non-positive rejects with `kernel/invalid-length` before the engine —
 * probed: a zero thickness is the one input OCCT's `MakeThickSolidByJoin`
 * answers `IsDone() = false` for, and the structured rejection keeps even
 * that from the engine). The thickness must FIT: the walls must not meet or
 * cross before a removed face is reached, and a too-thick shell is the
 * structured `kernel/shell-failed` — see that code's probed degeneracy
 * taxonomy (the engine does NOT fail degenerate input itself; the adapter's
 * post-condition does).
 *
 * ## Per-kernel fidelity (the coverage matrix)
 *
 * - OCCT: the exact BREP hollow (`BRepOffsetAPI_MakeThickSolid` in
 *   `MakeThickSolidByJoin` mode with the INWARD offset — probed: the
 *   positive offset builds an outward-thickened solid instead, so the
 *   adapter passes `−thickness`; a box opened at one face measures the
 *   analytic `W·D·H − (W−2t)(D−2t)(H−t)` at 0 relative error, an opening
 *   pair at two faces the analogous exact value, and the shelled solid
 *   reports full topology for chained features — probed 11 faces, 24
 *   edges, 16 vertices on the one-face fixture). `shell: true`.
 * - Fake: the analytic open-box model over its documented single-face
 *   subset — the target must be a pristine box leaf and exactly ONE face
 *   removed (the inset cavity is then exact: uniform thickness t walls,
 *   open at the removed face); volume, membership, and bounds are exact,
 *   everything else declines with `kernel/unsupported-operation` or the
 *   structured shell codes rather than an approximation. `shell: true`
 *   (honestly scoped: see the fake kernel's shell subset docs).
 * - Manifold: `shell: false` — the engine has no hollowing operation
 *   (probed; `offset` exists only on the 2D `CrossSection`, and the 3D
 *   `Manifold` surface carries no offset, shell, or face selection at
 *   all). `shell` rejects with `kernel/unsupported-operation`.
 * - JSCAD: `shell: false` — the engine's operation set carries no
 *   hollowing (probed; `expandShell` is the outward Minkowski expansion's
 *   internal helper — no face selection, no wall building). `shell`
 *   rejects with `kernel/unsupported-operation`.
 */
export interface ShellInput {
  /** The solid to hollow. */
  readonly target: KernelSolid;
  /**
   * The faces to remove, as the target's topology-snapshot face ordinals
   * (see the module doc). At least one; no duplicates.
   */
  readonly faces: readonly number[];
  /** The uniform wall thickness (strictly positive). */
  readonly thickness: LengthValue;
}

/**
 * The full input of `transform`: a translation vector plus an optional
 * rotation. Application order is fixed by the contract: the rotation is
 * applied first, about the world-origin axis, and the translation second,
 * in world space — so the two never interact and each is independently
 * observable in the result's bounds. Rotation is meaningful only for
 * kernels that declare `transformRotation: true`; a kernel that has not
 * declared it must never silently mis-apply a rotation — it rejects the
 * input with `kernel/invalid-rotation` or ignores the field outright
 * (the suite judges rotation only where the flag is set).
 */
export interface TransformInput extends TranslationInput {
  readonly rotation?: RotationInput;
}

/**
 * The world axis a mirror plane stands perpendicular to (Phase 26.9):
 * `"x"` is the YZ plane family (normal along x — the plane reflects the
 * x coordinate), `"y"` the XZ family, `"z"` the XY family.
 */
export type MirrorPlaneAxis = "x" | "y" | "z";

/**
 * Input of `mirror` (Phase 26.9): one target solid and the world axis
 * plane it reflects through — `axis` names the plane's NORMAL axis and
 * `offset` the plane's signed position along it, so the plane is
 * `{ coordinate = offset }` on that axis and the reflection maps that
 * coordinate `c → 2·offset − c`, leaving the other two unchanged.
 *
 * ## Why a dedicated operation (the design decision)
 *
 * A reflection is an ISOMETRY WITH NEGATIVE DETERMINANT: it is not a
 * rotation-plus-translation, so `transform`'s `TransformInput` (axis +
 * angle + translation) cannot carry it, and the Phase 26.8 pattern's
 * composition route (existing ops only) is closed. The honest path is
 * this kernel-level operation, implemented or declined per kernel by
 * the `mirror` capability flag.
 *
 * ## Plane scope (the revolve precedent)
 *
 * The mirror plane is one of the three WORLD AXIS PLANES at a signed
 * offset — the pattern's dimensionless axis precedent (1 = x, 2 = y,
 * 3 = z) carried to plane selection at the feature level. An ARBITRARY
 * plane (any normal, any point) is deliberately out of scope: it needs
 * the datum concept (named reference geometry) the revolve axis's
 * generalization also defers; compose a `transform` rotation with a
 * world-plane mirror to reach oblique planes today.
 *
 * ## Semantics
 *
 * Volume is IDENTICAL (a reflection is an isometry — measured exact on
 * every kernel). Bounds are the REFLECTED bounds: the `axis` interval
 * `[min, max]` maps to `[2·offset − max, 2·offset − min]`, the other
 * two unchanged — hand-derivable from the input bounds alone.
 * Membership is exact: the mirrored solid contains `p` iff the target
 * contains the reflected `p`. An empty target mirrors to the empty
 * solid (volume 0, empty soup, `kernel/bounds-empty`).
 *
 * WINDING (orientation) is preserved OUTWARD by every implementing
 * kernel — a naive vertex reflection would invert facet orientation
 * and render the solid inside-out, so each engine's own correction is
 * load-bearing, probed per kernel: OCCT's `BRepBuilderAPI_Transform`
 * of a `gp_Trsf.SetMirror` plane reflection yields a positive-volume
 * solid with outward tessellation normals; Manifold's `transform`
 * accepts the negative-determinant matrix and internally re-winds its
 * triangles (the raw soup's signed volume stays positive); JSCAD's
 * lazy `geom3.transform` runs `poly3.transform`, which reverses
 * polygon vertex order under `mat4.isMirroring`; the fake kernel
 * reflects its canonical triangles and swaps each triangle's winding
 * (so its per-facet normals come out negated-and-reflected, outward).
 *
 * ## Failure taxonomy
 *
 * - A handle not minted by this kernel instance →
 *   `kernel/solid-not-owned` (the uniform discipline).
 * - A non-finite `offset` magnitude → `kernel/invalid-length`. Unlike
 *   most length inputs, EVERY finite offset is legal — zero (the
 *   plane through the world origin) and negative offsets (a plane at
 *   x = −10) are perfectly good mirror planes, so no sign rule exists.
 * - The axis is a closed type union; callers select it from structured
 *   input (the bridge validates its dimensionless selector before
 *   mapping here), so the kernel trusts it like `extrude`'s direction.
 *
 * ## Per-kernel fidelity (the coverage matrix)
 *
 * - OCCT: exact BREP reflection (`gp_Trsf.SetMirror(gp_Ax2)` — the
 *   plane through the offset point normal to the axis — applied by
 *   `BRepBuilderAPI_Transform`; probed: the mirrored box measures its
 *   exact volume with outward normals). `mirror: true`.
 * - Fake: exact pointwise model — classification at the reflected
 *   query, reflected interval bounds, delegated volume, reflected
 *   triangles with swapped winding. `mirror: true`.
 * - Manifold: the reflection matrix (diagonal −1 on the axis, 2·offset
 *   translation) through the engine's own affine `transform`, whose
 *   negative-determinant winding correction is probed. `mirror: true`.
 * - JSCAD: the same matrix through `geom3.transform`, whose
 *   `mat4.isMirroring` vertex reversal is probed. `mirror: true`.
 *
 * The first Phase 26 operation every kernel implements honestly.
 */
export interface MirrorInput {
  /** The world axis the mirror plane is normal to (see the module doc). */
  readonly axis: MirrorPlaneAxis;
  /**
   * The plane's signed position along the normal axis (any finite
   * length; the reflection maps the axis coordinate `c → 2·offset − c`).
   */
  readonly offset: LengthValue;
}

/**
 * An axis-aligned bounding box in canonical millimetres. Tight for
 * primitives, and for boolean results a *container* whose tightness is
 * declared by the kernel's `tightBooleanBounds` capability.
 */
export interface KernelBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * An indexed triangle soup in canonical millimetres: `positions` is a flat
 * xyz vertex array and `indices` a flat triangle-vertex-index array. The
 * contract guarantees: lengths divisible by 3, indices within vertex range,
 * finite coordinates, deterministic output for the same solid, and zero
 * triangles exactly for empty solids. It does NOT promise a specific
 * triangulation — correctness criteria are semantic (bounds, volume,
 * validity), never exact buffer equality.
 *
 * `normals` carries optional kernel-computed vertex normals (Phase 9
 * extension): a flat xyz unit-vector array, one normal per position triple,
 * paired index-for-index with `positions`. Kernels that can compute normals
 * honestly provide them — the Manifold adapter emits crease-aware normals
 * (edges sharper than a documented threshold get split normals, so planar
 * faces keep one exact normal and curved surfaces shade smooth); the fake
 * kernel emits the exact per-facet normals of its canonical meshes. Kernels
 * that cannot compute normals omit the field entirely — consumers must
 * treat `undefined` as "compute your own" and never synthesize kernel
 * normals elsewhere. When present, normals are finite, unit length, exactly
 * as long as `positions`, and deterministic with the rest of the soup.
 * Empty solids omit `normals` along with their (empty) positions.
 */
export interface Tessellation {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
}

/** The number of triangles in a tessellation (`indices.length / 3`). */
export function tessellationTriangleCount(tessellation: Tessellation): number {
  return tessellation.indices.length / 3;
}

/**
 * A geometry kernel backend. Handles are owned by the instance that created
 * them; passing a handle to any other instance fails with
 * `kernel/solid-not-owned`. `dispose` releases kernel-side resources for
 * kernels that need explicit cleanup (WASM-backed kernels); for
 * garbage-collected kernels it is a no-op that keeps the contract uniform.
 */
export interface GeometryKernel {
  /** The backend this kernel implements (e.g. `"fake"`, `"manifold"`). */
  readonly id: KernelBackendId;
  /** What this kernel can actually promise; see {@link KernelCapabilities}. */
  readonly capabilities: KernelCapabilities;

  /** Creates an axis-aligned box from the min corner at the origin. */
  createBox(input: BoxInput): KernelResult<KernelSolid>;
  /** Creates a sphere centred at the origin. */
  createSphere(input: SphereInput): KernelResult<KernelSolid>;
  /** Creates a cylinder on the +z axis from `z = 0` to `z = height`. */
  createCylinder(input: CylinderInput): KernelResult<KernelSolid>;
  /** Creates a cone/frustum on the +z axis from `z = 0` to `z = height`. */
  createCone(input: ConeInput): KernelResult<KernelSolid>;

  /**
   * Extrudes one closed profile loop into a prismatic solid (Phase 26.1):
   * the profile lies in the local XY plane, the extrusion runs along the
   * local z axis by `height` in `direction`, and `placement` (rotation
   * first about the world origin, then translation) maps the result into
   * world space. See {@link ProfileExtrudeInput} for the profile contract
   * and the per-kernel fidelity honesty.
   */
  extrude(input: ProfileExtrudeInput): KernelResult<KernelSolid>;

  /**
   * Revolves one closed profile loop about an axis in its own plane
   * (Phase 26.2): the sweep starts at the profile plane and runs by
   * `angle` — `2π` the full solid of revolution, less a partial capped
   * sweep — following the axis direction's right-hand rule, then the same
   * `placement` composition maps the result into world space. See
   * {@link ProfileRevolveInput} for the angle domain, the axis-validation
   * honesty, and the per-kernel fidelity.
   */
  revolve(input: ProfileRevolveInput): KernelResult<KernelSolid>;

  /**
   * Sweeps one closed profile loop along a path chain in the local XZ
   * plane (Phase 26.3): the path starts at the local origin along the
   * profile plane's normal (the perpendicular-attachment rule), the
   * planar fixed-binormal frame carries the profile along it, and the same
   * `placement` composition maps the result into world space. See
   * {@link ProfileSweepInput} for the path model, the three-tier
   * self-intersection honesty, and the per-kernel coverage matrix — a
   * kernel declaring `sweep: false` answers every call with the structured
   * `kernel/unsupported-operation`, never a silent bad approximation.
   */
  sweep(input: ProfileSweepInput): KernelResult<KernelSolid>;

  /**
   * Sweeps one closed profile loop along an ANALYTIC helix spine (Phase
   * 40): the profile lies in the start meridian (the local xz plane
   * through the spine's start point, `(u, v) = (radial, axial)` from that
   * point), the meridian transport carries it — rotation about the spine
   * axis by the swept angle plus the start-point translation, the thread
   * tooth's frame, drift-free by construction — and the same `placement`
   * composition maps the screw solid into world space. See
   * {@link HelixSweepInput} for the parametrization, the validation
   * battery, the exact screw-volume derivation, and the per-kernel
   * coverage matrix — a kernel declaring `helix: false` answers every
   * call with the structured `kernel/unsupported-operation`, never a
   * silent approximation.
   */
  helixSweep(input: HelixSweepInput): KernelResult<KernelSolid>;

  /**
   * Lofts an ordered collection of at least two profile loops — each at
   * its station z along the local axis — into one solid by the piecewise
   * ruled vertex morph between consecutive stations (Phase 26.4), then the
   * same `placement` composition maps the result into world space. See
   * {@link ProfileLoftInput} for the morph semantics, the collection
   * validation battery (member validity, vertex-count compatibility,
   * station ordering), and the per-kernel coverage matrix — a kernel
   * declaring `loft: false` answers every call with the structured
   * `kernel/unsupported-operation`, never a silent bad approximation.
   */
  loft(input: ProfileLoftInput): KernelResult<KernelSolid>;

  /**
   * Fillets the selected edges of one solid to a shared radius
   * (Phase 26.5): the edges are addressed by the target's topology-snapshot
   * edge ordinals — the Phase 22 `(kind: "edge", ordinal)` vocabulary — and
   * the radius must be strictly positive and fit the selected edges. See
   * {@link FilletInput} for the addressing rules, the smooth-edge scope
   * boundary, and the per-kernel coverage matrix — a kernel declaring
   * `fillet: false` answers every call with the structured
   * `kernel/unsupported-operation`, never a silent bad approximation.
   */
  fillet(input: FilletInput): KernelResult<KernelSolid>;

  /**
   * Chamfers the selected edges of one solid to a shared symmetric distance
   * (Phase 26.6): the same snapshot-ordinal edge addressing `fillet` uses,
   * and a distance that must be strictly positive and fit the selected
   * edges' adjacent faces. See {@link ChamferInput} for the addressing
   * rules, the seam-edge scope boundary, and the per-kernel coverage matrix
   * — a kernel declaring `chamfer: false` answers every call with the
   * structured `kernel/unsupported-operation`, never a silent bad
   * approximation.
   */
  chamfer(input: ChamferInput): KernelResult<KernelSolid>;

  /**
   * Hollows one solid to uniform-thickness walls, open at the selected
   * faces (Phase 26.7): the faces are addressed by the target's
   * topology-snapshot FACE ordinals — the Phase 22 `(kind: "face",
   * ordinal)` vocabulary — and the thickness must be strictly positive and
   * fit (the walls must not meet). See {@link ShellInput} for the
   * addressing rules, the open-shell scope boundary (the probed
   * empty-list verdict), and the per-kernel coverage matrix — a kernel
   * declaring `shell: false` answers every call with the structured
   * `kernel/unsupported-operation`, never a silent bad approximation.
   */
  shell(input: ShellInput): KernelResult<KernelSolid>;

  /** Unions two or more solids. */
  union(operands: readonly KernelSolid[]): KernelResult<KernelSolid>;
  /** Subtracts the tools (at least one) from the target solid. */
  subtract(
    target: KernelSolid,
    tools: readonly KernelSolid[],
  ): KernelResult<KernelSolid>;
  /** Intersects two or more solids; disjoint operands produce an empty solid. */
  intersect(operands: readonly KernelSolid[]): KernelResult<KernelSolid>;

  /**
   * Places a solid: rotates it first (about the world-origin axis of the
   * optional `rotation`, right-handed) and translates it second, in world
   * space. Rotation requires the `transformRotation` capability (Phase 8
   * transform, Phase 21.1 extension).
   */
  transform(
    solid: KernelSolid,
    input: TransformInput,
  ): KernelResult<KernelSolid>;

  /**
   * Reflects one solid through a world axis plane at a signed offset
   * (Phase 26.9): the dedicated reflection operation, because a mirror
   * is an isometry with negative determinant — not expressible as the
   * rotation-plus-translation `transform` carries. See
   * {@link MirrorInput} for the plane scope, the reflected-bounds and
   * preserved-winding semantics (probed per kernel), the failure
   * taxonomy, and the coverage matrix — a kernel declaring `mirror:
   * false` answers every call with the structured
   * `kernel/unsupported-operation`, never a silent bad approximation.
   */
  mirror(solid: KernelSolid, input: MirrorInput): KernelResult<KernelSolid>;

  /**
   * The solid's axis-aligned bounding box in mm; fails with
   * `kernel/bounds-empty` for an empty solid.
   */
  bounds(solid: KernelSolid): KernelResult<KernelBounds>;
  /** The solid's volume in mm³ (0 for an empty solid). */
  volume(solid: KernelSolid): KernelResult<number>;
  /**
   * The solid's total surface area in mm² (0 for an empty solid); requires
   * the `surfaceArea` capability (Phase 27.4). Each kernel measures with
   * its own honest semantics, the same exact/banded classes its volumes
   * use: the OpenCascade backend integrates the BREP's surfaces exactly
   * (`BRepGProp.SurfaceProperties` — probed delta 0 from the analytic
   * plate-with-bore value); the mesh kernels (Manifold, JSCAD) measure
   * their own boundary representation exactly — for curved primitives
   * that boundary is the kernel's documented discretization, so the value
   * sits in the same band as its volume; the fake kernel answers its
   * analytic primitive subset exactly and declines every other node
   * (booleans, sweeps, lofts, the modelled repair shapes) with the
   * structured `kernel/unsupported-operation`, naming its subset — never
   * a silently approximate number. A kernel declaring `surfaceArea:
   * false` answers every call with the structured
   * `kernel/unsupported-operation`, like every capability-gated
   * operation. Surface area is the mass-property pair of `volume`; MASS
   * itself is deliberately absent — the contract has no density model,
   * and `mass = density × volume` is a downstream consumer's unit
   * algebra, not a kernel measurement.
   */
  area(solid: KernelSolid): KernelResult<number>;
  /**
   * A deterministic, valid, indexed triangle soup of the solid (empty for
   * an empty solid). Not promised to be the exact boundary of boolean
   * results — kernels without exact boolean surfaces emit a deterministic
   * candidate soup; semantic truth lives in `volume`/`bounds`.
   */
  tessellate(solid: KernelSolid): KernelResult<Tessellation>;

  /** Releases the handle's kernel-side resources; never fails. */
  dispose(solid: KernelSolid): void;
}
