/**
 * The core-executes-against-kernel bridge (Phase 8): a cad-core
 * {@link FeatureExecutor} backed by a kernel contract instance. This is the
 * seam that proves "core can execute against a kernel": cad-core's
 * regeneration orchestration stays kernel-neutral (the executor is
 * caller-supplied by design), and this module — living in cad-kernel, which
 * depends on cad-core and never the other way around — interprets a small,
 * documented set of feature kinds as kernel operations.
 *
 * Direction of dependency: kernel types flow into nothing. cad-core never
 * imports kernel types; the bridge imports cad-core (document records,
 * parameters, diagnostics, the regeneration executor signature) and the
 * kernel contract.
 *
 * ## Interpreted feature kinds and input layouts
 *
 * Every feature must declare exactly one output body. Inputs are positional
 * and typed by kind:
 *
 * - `box` — three parameter inputs: width, depth, height.
 * - `sphere` — one parameter input: radius.
 * - `cylinder` — two parameter inputs: radius, height.
 * - `cone` — three parameter inputs: bottomRadius, topRadius, height.
 * - `union` / `intersect` — two or more feature/body inputs.
 * - `subtract` — two or more feature/body inputs: first the target, then
 *   the tools.
 * - `translate` — one feature/body input followed by three parameter
 *   inputs: x, y, z.
 * - `extrude` — one SKETCH input (a document sketch record whose resolved
 *   profile supplies the loop and the workplane placement, via the
 *   caller-supplied {@link KernelExecutorContext.profiles} resolver) and
 *   one SIGNED length parameter: the distance. The parameter's magnitude is
 *   the extrusion height; its sign is the direction (+ along the sketch
 *   plane's normal, − against it), so `parameter.set` drives both distance
 *   and direction through one edit (Phase 26.1).
 * - `revolve` — the same SKETCH input, then two ANGLE parameters (Phase
 *   26.2): the sweep (kernel domain `(0, 2π]` — 2π the full revolve, less
 *   a partial capped sweep) and the axis direction, measured
 *   counter-clockwise in the sketch plane from the workplane +x axis. The
 *   axis line passes through the workplane origin along that direction —
 *   the workplane axes themselves at 0 and π/2, any origin line between —
 *   so `parameter.set` on either parameter re-drives the revolution, and
 *   the kernel's own axis validation (crossing rejection, sweep domain,
 *   direction normalizability) judges the resolved geometry.
 * - `sweep` (Phase 38) — two SKETCH inputs: the PROFILE sketch (resolved
 *   through the profile seam exactly like `extrude`) and the PATH sketch
 *   (resolved through the caller-supplied {@link KernelPathResolver}, the
 *   planar-XZ-contract mapping of the sketch's chain onto the profile
 *   frame's local XZ plane). No dimension parameters — the path determines
 *   the extent. Capability-gated on `sweep` (Manifold declines) before any
 *   resolution. See `runSweepOperation`.
 * - `loft` (Phase 38) — N SKETCH inputs (the ordered sections; the order IS
 *   the loft direction) plus N LENGTH parameter inputs (each section's
 *   station z, matched by declared position). All sections must resolve on
 *   the FIRST section's workplane frame (the contract's one-placement
 *   rule); capability-gated on `loft` (Manifold declines). See
 *   `runLoftOperation`.
 * - `helix` (Phase 40) — one SKETCH input (the meridian profile: sketch
 *   `(x, y)` → helix `(radial, axial)` from the spine's start point, the
 *   sweep path-mapping precedent — the sketch's workplane does not carry),
 *   SIX parameter inputs in declared order (radius LENGTH, pitch LENGTH,
 *   turns DIMENSIONLESS, handedness DIMENSIONLESS ±1, start angle ANGLE,
 *   taper LENGTH), and an optional DATUM AXIS input (the spine's axis;
 *   without one the spine runs on the world +z axis). See
 *   `runHelixOperation`.
 * - `thread` (Phase 40) — one FEATURE or BODY input (the target), FIVE
 *   parameter inputs in declared order (major diameter LENGTH, pitch
 *   LENGTH, thread length LENGTH, mode DIMENSIONLESS 1 external / 2
 *   internal / 3 cosmetic, handedness DIMENSIONLESS ±1), and the axis — a
 *   DATUM AXIS input or a DIMENSIONLESS world-axis selector (1 = X,
 *   2 = Y, 3 = Z). The real modes compose `planThreadCut`'s shared ISO
 *   tool geometry through `helixSweep` + subtract with the hole's no-op
 *   post-condition; the cosmetic mode passes the target through
 *   unchanged (annotation data, no geometry — every kernel runs it). See
 *   `runThreadOperation`.
 * - `fillet` (Phase 26.5) — one FEATURE or BODY input (the target solid),
 *   one or more REFERENCE inputs (the edge selection: document reference
 *   records whose payloads are the Phase 22 persistent
 *   `TopologyEntityReference`s), and one LENGTH parameter (the radius).
 *   Each reference is RESOLVED before the kernel runs: the record's
 *   payload parses through cad-core's `parseTopologyReference`, the
 *   reference must address the target's own output body, and
 *   `resolveDocumentReference` against the context's {@link TopologyView}
 *   re-resolves it against the CURRENT regeneration's topology — a moved
 *   or vanished edge surfaces as a structured diagnostic (the validity
 *   state and, for an invalid reference, its structural reason ride the
 *   diagnostic's data), never as silent re-attachment. Resolved references
 *   map through `transientSelectionOf` to snapshot edge ordinals, the
 *   addresses `kernel.fillet` consumes. `parameter.set` on the radius
 *   re-drives the fillet through regeneration.
 * - `chamfer` (Phase 26.6) — the fillet layout and resolution battery
 *   verbatim, with the LENGTH parameter naming the symmetric DISTANCE and
 *   the resolved ordinals addressing `kernel.chamfer`. `parameter.set` on
 *   the distance re-drives the chamfer through regeneration.
 * - `shell` (Phase 26.7) — the same one-target/one-length layout on FACE
 *   references: one FEATURE or BODY input (the target solid), one or more
 *   REFERENCE inputs (the face selection to remove — resolved through the
 *   same battery, on the `face` kind), and one LENGTH parameter (the wall
 *   thickness). The resolved ordinals address `kernel.shell`;
 *   `parameter.set` on the thickness re-drives the hollow through
 *   regeneration.
 * - `patternLinear` / `patternCircular` (Phase 26.8) — one FEATURE or BODY
 *   input (the solid to repeat) plus THREE parameter inputs, roles read off
 *   the parameters' declared order. Linear: count (dimensionless integer),
 *   spacing (LENGTH), direction (ANGLE — counter-clockwise in the world XY
 *   plane from +x, the revolve axis precedent). Circular: count
 *   (dimensionless integer), total angle (ANGLE), axis (dimensionless
 *   integer 1 = X, 2 = Y, 3 = Z). See `runPatternOperation` for the
 *   composition and its failure taxonomy.
 * - `mirror` (Phase 26.9) — one FEATURE or BODY input (the solid to
 *   reflect) plus TWO parameter inputs: plane (DIMENSIONLESS integer
 *   1 = YZ/x-normal, 2 = XZ/y-normal, 3 = XY/z-normal — the pattern axis
 *   precedent carried to plane selection) and offset (LENGTH, any finite
 *   value — the plane's signed position along its normal). See
 *   `runMirrorOperation` for the capability gate and the failure taxonomy.
 * - `hole` (Phase 26.10) — one FEATURE or BODY input (the target solid)
 *   plus FIVE parameter inputs, roles read off the parameters' declared
 *   order: diameter (LENGTH, strictly positive — the hole's authoring
 *   dimension; the tool radius is diameter/2), depth (LENGTH, strictly
 *   positive, measured inward from the entry face), positionX/positionY
 *   (LENGTH, the hole center in the plane perpendicular to the axis), and
 *   axis (DIMENSIONLESS integer 1 = X, 2 = Y, 3 = Z — the pattern/mirror
 *   selector precedent: the hole runs PARALLEL to that world axis and
 *   enters through the target's + face along it). See `runHoleOperation`
 *   for the composition, the through/blind semantic, and the failure
 *   taxonomy.
 * - `extrude`'s optional taper (Phase 41) — the extrude input layout gains
 *   an optional THIRD input, an ANGLE parameter: the draft taper, zero or
 *   absent meaning the plain prism. A non-zero taper is capability-gated
 *   on `extrudeTaper` BEFORE the kernel runs (Manifold declines — its
 *   extrude's top-scale is a different solid, never a wall-angle draft),
 *   and the kernel's own `kernel/invalid-taper` battery (the shared
 *   `taperedExtrudeProblem` validator) judges the geometry. `parameter.set`
 *   on the taper re-drives the draft through regeneration.
 * - `rib` (Phase 41) — one FEATURE or BODY input (the target the rib
 *   grows from), one SKETCH input (the rib's closed cross-section in its
 *   own workplane), and one LENGTH parameter (the thickness): the rib is
 *   the profile extruded SYMMETRICALLY by thickness about the sketch plane
 *   (one half-thickness extrusion each side) and UNIONED with the target —
 *   bridge-level composition of existing ops only (the pattern/hole
 *   design decision). Open-profile extend-to-next-face ribbing is
 *   structurally out of scope: the contract exposes no surface-raycast an
 *   adapter could extend a profile along, so the profile must be closed
 *   where it meets the part (documented, the per-shape honesty
 *   discipline). See `runRibOperation`.
 * - `scale` (Phase 41) — one FEATURE or BODY input (the solid to scale)
 *   and one DIMENSIONLESS parameter (the strictly positive uniform
 *   factor): the direct `kernel.transform` call carrying the Phase 41
 *   `scale` field, capability-gated on `transformScale` BEFORE the call.
 *   Volume scales by factor³ and bounds by factor — hand-derivable, the
 *   fixtures' analytic anchors. Non-uniform scaling is documented OUT
 *   until a kernel binding grows a general-transform route. See
 *   `runScaleOperation`.
 * - `thicken` (Phase 41) — one FEATURE or BODY input (the target) and one
 *   LENGTH parameter (the wall thickness): the direct `kernel.thicken`
 *   call building the CLOSED hollow (the shell's complement — a solid
 *   with an interior void), capability-gated on `thicken` BEFORE the
 *   call (Manifold and JSCAD decline; the fake kernel's pristine-leaf
 *   subset declines non-leaf targets per shape). See `runThickenOperation`.
 * - `split` (Phase 41) — one FEATURE or BODY input (the target), one
 *   DATUM PLANE input (the cutting plane), and one DIMENSIONLESS
 *   parameter (the keep side: +1 keeps the side the plane's normal points
 *   to, −1 the opposite): the composition subtracts a covering box tool
 *   built on the removed side of the plane (`planSplitCut`, the
 *   `planHoleCut` precedent — a pure planner the workbench's worker scene
 *   shares verbatim), so the cut rides `extrude` + `subtract` only and
 *   runs on every kernel with zero new contract surface. The measured
 *   post-condition refuses a split that removed nothing (the plane misses
 *   the target) or everything (it swallows the kept side) — the hole
 *   guard's both-ways form. See `runSplitOperation`.
 * - `patternFeature` (Phase 43) — ONE OR MORE FEATURE/BODY inputs (the
 *   FEATURE RANGE: every instance transforms every member as one group)
 *   plus parameter inputs read as LEG TRIPLES then SKIP ORDINALS: each
 *   leg is a direction (ANGLE, counter-clockwise in the world XY plane)
 *   + count (DIMENSIONLESS integer ≥ 2) + spacing (LENGTH > 0) triple —
 *   the ASYMMETRIC SPACING ARRAY, one leg per array direction, the
 *   instance grid the legs' cross product; the trailing DIMENSIONLESS
 *   integers name instance ordinals to SKIP. The composition unions
 *   every unskipped instance at the end. See `runPatternFeatureOperation`
 *   and the shared planner `planArrayPatternInstances`.
 * - `patternPath` (Phase 43) — one FEATURE or BODY input (the solid to
 *   repeat), one SKETCH input (the path — resolved through the same
 *   `paths` seam the sweep rides), and THREE parameters: count
 *   (DIMENSIONLESS integer ≥ 2), spacing (LENGTH > 0, the arc-length
 *   step), orientation (DIMENSIONLESS 1 = fixed, 2 = tangent-follow).
 *   Instances sit at arc length i·spacing along the resolved chain in
 *   the world XZ plane (local (x, z) → world (x, 0, z) — the identity
 *   placement, documented); tangent-follow rotates each copy's world +z
 *   onto the local tangent and is gated on `transformRotation`. See
 *   `runPatternPathOperation` and `./path-geometry` (the shared walk).
 * - `patternFace` (Phase 43) — one FEATURE or BODY input (the solid to
 *   repeat, whose own face bounds the grid), one REFERENCE input (a FACE
 *   reference addressing the target's body, resolved through the fillet
 *   battery), and SIX parameters (two leg triples: direction + count +
 *   spacing each, the RECTANGULAR grid in the face's plane from its
 *   xAxis). The face's plane resolves through the datum seam
 *   (`facePlane`); the boundary test is the tessellated point-in-region
 *   walk (the synthetic-face discipline: the target's tessellation,
 *   filtered to the plane, projected to 2D, tested per grid point).
 *   Grid points outside the face boundary drop out silently-by-design
 *   (that is the clipping the feature exists to do); a grid where NO
 *   point qualifies declines structurally. See `runPatternFaceOperation`.
 * - `patternLinear`'s direction generalization (Phase 43) — the direction
 *   may ride a DATUM AXIS input (the resolved axis's full 3D unit
 *   direction — the patternCircular datum-axis precedent) or a SKETCH
 *   input (the resolved open chain's unit end−start vector, local
 *   (x, z) → world (x, 0, z) — the path-pattern frame), replacing the
 *   ANGLE parameter's world-XY direction. The angle form is unchanged.
 * - `mirror`'s merge option (Phase 43) — the datum-plane form carries an
 *   optional DIMENSIONLESS parameter: 1 (or absent) keeps the mirrored
 *   copy STANDALONE (the feature's output is the reflection alone, the
 *   Phase 39 behavior); 2 MERGES — one `union` of the target and its
 *   reflection, the symmetric-part route. See `runMirrorOperation`.
 *
 * Feature inputs resolve to the referenced feature's (single) output body.
 * Body inputs resolve through the caller-supplied prior bodies map (solids
 * from earlier runs or imported geometry). Parameters resolve through the
 * document's parameter collection and must be lengths; any length unit
 * converts to canonical mm, so a `2 cm` width and a `20 mm` width drive
 * identical geometry (single units source of truth).
 *
 * ## The pattern design decision (Phase 26.8)
 *
 * Patterns are FEATURE-LEVEL COMPOSITION, not kernel operations: the
 * bridge executes a pattern feature by issuing `count − 1` `transform`
 * calls (translations for linear; rotations about the world origin for
 * circular) and one `union` over the target plus those copies — existing
 * kernel ops only, no contract extension. The alternative, a kernel-level
 * `pattern` op, would parallelize inside a worker-held kernel but costs
 * contract surface every adapter must implement or decline (and the fake
 * kernel's axis-aligned shape model could not implement the circular half
 * honestly, so the reference kernel would decline its own reference
 * feature). Composition regenerates naturally from `parameter.set` — the
 * bridge re-reads the parameters each regeneration, so a count or spacing
 * edit re-issues the whole arrangement — and translation+union is
 * supported by all four kernels today. The honest cost, documented below:
 * circular patterns need `transformRotation`, so they refuse structurally
 * on the kernels that do not declare it (the fake kernel rejects rotations
 * outright; the contract also permits a non-declaring kernel to IGNORE the
 * rotation, which would silently stack all copies in place — the bridge's
 * capability gate refuses before that wrong answer can be built).
 *
 * Failures are reported as structured cad-core diagnostics (severity
 * `error`, located at the feature, offending input ids attached as related)
 * with the `kernel/*` diagnostic codes, so regeneration marks the feature
 * failed and gates its dependents stale exactly like any other executor
 * failure. Use one bridge per regeneration run: outputs accumulate on the
 * bridge as the executor is called in evaluation order.
 *
 * ## The mirror design decision (Phase 26.9)
 *
 * Mirror is the ONE Phase 26 placement feature that is a DIRECT KERNEL
 * CALL, not feature-level composition: a reflection is an isometry with
 * NEGATIVE DETERMINANT — no rotation-plus-translation pair expresses it,
 * so `transform` cannot carry it and the pattern's compose-from-existing-
 * ops route is closed. The contract therefore carries a dedicated `mirror`
 * operation (implemented or declined per kernel behind the `mirror`
 * capability flag), and the bridge's job is only the feature vocabulary:
 * validate the dimensionless plane selector, gate the capability BEFORE
 * the call (a kernel that has not declared `mirror` would answer the
 * structured unsupported code — the gate surfaces that as a feature
 * diagnostic without building anything), and pass the plane through.
 *
 * ## The hole design decision (Phase 26.10)
 *
 * The hole is FEATURE-LEVEL COMPOSITION, the pattern's verdict carried one
 * step further: a hole is a positioned circular cut SUBTRACTED from a
 * target — the plate-with-hole arrangement the Phase 8 bridge fixture
 * already expressed from kernel primitives plus a subtract. The ops the
 * composition uses (`extrude` for the tool, `subtract` for the cut) are
 * contract operations every kernel implements, so the composed hole runs on
 * all four kernels with zero new contract surface; the alternative, a
 * dedicated `hole` kernel op, would cost contract surface on every adapter
 * (implement or decline) to reach exactly the same solid, and the richness
 * that could justify one — OCCT's counterbore/countersink/tapered drills —
 * is unreachable through the plan's diameter/depth/position parameter set
 * anyway. `planHoleCut` is the ONE source of the tool geometry (the
 * workbench's worker scene composes the identical cut through the worker
 * operation matrix), and the feature enforces the shell post-condition
 * precedent: a subtract whose tool misses the target returns the target
 * UNCHANGED on every kernel (the silent-no-op trap), so the bridge measures
 * the volume on both sides and refuses a cut that removed nothing as a
 * structured feature diagnostic.
 */

import {
  type AnyDimensionalValue,
  type BodyId,
  type CadDocument,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type DatumTopologyResolver,
  type DatumVec3,
  type FeatureExecutionOutcome,
  type FeatureExecutor,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  type ResolvedDatumAxis,
  type ResolvedDatumPlane,
  type TopologyView,
  angle as angleValue,
  length as lengthValue,
  type ParseFailure,
  type ParseResult,
  type SketchDocumentId,
  getDocumentDatum,
  getDocumentReference,
  parseDatumPayload,
  parseTopologyReference,
  resolveDatumPayload,
  resolveDocumentReference,
  transientSelectionOf,
  valueIn,
} from "@slopcad/cad-core";

import {
  type GeometryKernel,
  type HelixSweepInput,
  type KernelBounds,
  type MirrorPlaneAxis,
  type ProfileExtrudeInput,
  type ProfileLoftInput,
  type ProfileLoftSectionInput,
  type ProfileRevolveInput,
  type ProfileSegmentInput,
  type ProfileSweepInput,
  type KernelSolid,
  type SweepPathSegmentInput,
} from "./contract";
import { planThreadCut, rotationAligningZTo } from "./thread-profile";
import {
  type StructuredHoleSpec,
  planStructuredHoleCut,
  structuredHoleDatumInPlaneAxes,
  structuredHoleRoles,
  structuredHoleTypeOf,
  structuredHoleWorldInPlaneAxes,
} from "./hole-specification";
import { sweepPathProblem } from "./profile-geometry";
import { sweepPathStationAt, sweepPathTotalLength } from "./path-geometry";

/** The feature kinds the bridge interprets as kernel operations. */
export const BRIDGE_FEATURE_KINDS = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "union",
  "subtract",
  "intersect",
  "translate",
  "extrude",
  "revolve",
  "sweep",
  "loft",
  "helix",
  "thread",
  "fillet",
  "chamfer",
  "shell",
  "patternLinear",
  "patternCircular",
  "patternFeature",
  "patternPath",
  "patternFace",
  "mirror",
  "hole",
  "rib",
  "scale",
  "thicken",
  "split",
] as const;

/** A feature kind the bridge knows how to execute. */
export type BridgeFeatureKind = (typeof BRIDGE_FEATURE_KINDS)[number];

/**
 * The profile a sketch resolves to, in the kernel contract's extrude
 * vocabulary: the loop segments and the workplane placement. The bridge
 * never imports the sketch domain — the resolver is caller-supplied (the
 * same caller-supplied seam as the executor itself), typically backed by
 * cad-sketch's profile resolution.
 */
export interface KernelResolvedProfile {
  readonly loop: ProfileExtrudeInput["loop"];
  readonly placement: ProfileExtrudeInput["placement"];
}

/** The resolver's outcome: a resolved profile or a structured failure. */
export type KernelProfileResolution = ParseResult<
  KernelResolvedProfile,
  ParseFailure
>;

/** Resolves a document sketch record into the extrudable profile. */
export type KernelProfileResolver = (
  sketchId: SketchDocumentId,
) => KernelProfileResolution;

/**
 * The path a sketch resolves to, in the kernel contract's sweep vocabulary:
 * the ordered chain of line/arc segments in the LOCAL XZ plane (the caller
 * maps the sketch's workplane coordinates onto it — the planar-XZ contract's
 * constraint mapping; the path sketch's own workplane placement does not
 * carry, because {@link ProfileSweepInput} places the whole operation once,
 * through the profile's frame). The bridge never imports the sketch domain —
 * the resolver is caller-supplied, typically backed by cad-sketch's
 * `resolveSweepPath`.
 */
export interface KernelResolvedPath {
  readonly path: readonly SweepPathSegmentInput[];
}

/** The path resolver's outcome: a resolved chain or a structured failure. */
export type KernelPathResolution = ParseResult<
  KernelResolvedPath,
  ParseFailure
>;

/** Resolves a document sketch record into a sweepable path chain. */
export type KernelPathResolver = (
  sketchId: SketchDocumentId,
) => KernelPathResolution;

/**
 * The POINT entities a sketch resolves to, in the sketch's own workplane
 * coordinates (millimetres): the POSITION LIST a many-positions feature
 * addresses (Phase 42's structured hole). The bridge never imports the
 * sketch domain — the resolver is caller-supplied, typically backed by
 * cad-sketch's entity reader; the sketch's workplane PLACEMENT does not
 * carry (the caller maps points into the feature's own in-plane basis, the
 * path seam's simplification precedent).
 */
export interface KernelResolvedSketchPoints {
  readonly points: readonly {
    readonly x: number;
    readonly y: number;
  }[];
}

/** The points resolver's outcome: the point list or a structured failure. */
export type KernelSketchPointsResolution = ParseResult<
  KernelResolvedSketchPoints,
  ParseFailure
>;

/** Resolves a document sketch record into its point-entity positions. */
export type KernelSketchPointsResolver = (
  sketchId: SketchDocumentId,
) => KernelSketchPointsResolution;

/** Context the bridge executes against. */
export interface KernelExecutorContext {
  /** The document whose features and parameters are being regenerated. */
  readonly document: CadDocument;
  /**
   * Solids already associated with the document's bodies (from a prior run
   * or imported geometry), keyed by body id; freshly executed features'
   * outputs layer on top.
   */
  readonly bodies: ReadonlyMap<BodyId, KernelSolid>;
  /**
   * Resolves the sketch records that `extrude` features consume into
   * kernel-vocabulary profiles. A resolver failure — an unknown sketch or
   * an unresolvable profile — becomes a structured diagnostic at the
   * feature with the failure's own code carried in `data.profileCode`.
   */
  readonly profiles: KernelProfileResolver;
  /**
   * Resolves the sketch records that `sweep` features consume as PATH
   * chains ({@link KernelResolvedPath}). A context without one cannot run a
   * sweep: every `sweep` feature fails with a structured diagnostic naming
   * the missing seam instead of guessing a path. A resolver failure carries
   * the sketch domain's own code in `data.pathCode`.
   */
  readonly paths?: KernelPathResolver;
  /**
   * Resolves the sketch records whose POINT entities position features
   * ({@link KernelResolvedSketchPoints}, Phase 42's structured hole input —
   * one feature, many positions). A context without one cannot run a
   * sketch-positioned hole: the feature fails with a structured diagnostic
   * naming the missing seam instead of guessing positions. A resolver
   * failure carries the sketch domain's own code in `data.pointsCode`.
   */
  readonly points?: KernelSketchPointsResolver;
  /**
   * The optional reference-resolution view that the topology-addressed
   * features' (`fillet`, `chamfer`, `shell`) references resolve against
   * (the Phase 22
   * protocol's kernel-side gate — the persistent-topology kernel's
   * {@link TopologyView}). A context without one cannot resolve edge references:
   * every such feature carrying reference inputs fails with a structured
   * diagnostic instead of guessing. The view must stand at the CURRENT
   * regeneration — the snapshot ordinals the resolution produces are the
   * addresses the kernel's edge-cutting operations consume for this run.
   */
  readonly topology?: TopologyView;
  /**
   * The optional topology-geometry seam that reference-dependent DATUM
   * definitions (`faceOffset` planes, `edge` axes, `faceCylinder` axes)
   * resolve through (Phase 39). Explicit-geometry datums resolve from the
   * document record alone and need no seam; a datum whose definition needs
   * face/edge geometry fails with a structured diagnostic when the context
   * carries none — never a guessed frame.
   */
  readonly datumTopology?: DatumTopologyResolver;
}

/** A bridge created for one regeneration run. */
export interface KernelExecutionBridge {
  /** The cad-core executor to pass to `regenerate`. */
  readonly executor: FeatureExecutor;
  /**
   * The solid a feature produced for the given output body this run, or the
   * prior solid for bodies not rebuilt — the seam consumers use to make
   * semantic assertions about executed geometry.
   */
  solidOf(bodyId: BodyId): KernelSolid | undefined;
}

const BRIDGE_KIND_SET: ReadonlySet<string> = new Set(BRIDGE_FEATURE_KINDS);

/** One full turn in radians — the circular pattern's total-angle ceiling. */
const FULL_CIRCLE_RAD = Math.PI * 2;

/**
 * The tolerance the total-angle domain check absorbs unit-conversion float
 * noise with (a `360 deg` parameter converts to 2π within an ulp or two of
 * `Math.PI * 2`, which must stay a legal full turn).
 */
const ANGLE_DOMAIN_TOLERANCE_RAD = 1e-9;

/**
 * The pattern count ceiling (Phase 26.8): one bridge call issues
 * `count − 1` kernel transforms synchronously, so the bound keeps a stray
 * large count from wedging regeneration; larger arrays compose from
 * nested pattern features.
 */
export const PATTERN_COUNT_LIMIT = 1000;

/**
 * How far the hole tool overshoots past the faces it opens (Phase 26.10),
 * in millimetres. The overshoot exists so boolean cuts OPEN cleanly — a
 * tool face exactly coincident with a target face is a tangency the mesh
 * kernels are not required to resolve robustly — and it never defines the
 * hole's geometry: the blind bottom sits exactly at `depth` (the overshoot
 * is on the entry side and the far side only), and a through tool's extra
 * length removes no additional material. Any positive value works; 1 mm is
 * far above kernel float noise and far below any authored part dimension
 * the overshoot could conceivably reach around.
 */
export const HOLE_TOOL_OVERSHOOT_MM = 1;

/** The hole's axis selector: 1 = the world X axis, 2 = Y, 3 = Z. */
export type HoleAxisSelector = 1 | 2 | 3;

/**
 * The planned tool cut of one hole (Phase 26.10): the composed feature's
 * ONE source of tool geometry, shared verbatim by the bridge (which calls
 * the kernel directly) and the workbench's worker scene (which composes the
 * identical cut through the worker operation matrix).
 *
 * ## The tool is an extruded circle, not a transformed cylinder
 *
 * The contract's `createCylinder` only builds cylinders on the +z axis;
 * turning that primitive to hole along the world X or Y axis would need a
 * `transform` ROTATION — gated behind `transformRotation`, which the fake
 * kernel and Manifold do not declare (probed), so a rotated tool would
 * break the hole's all-kernel coverage. The tool is instead a one-segment
 * `extrude` of a circle: the extrude op's PLACEMENT (rotation about the
 * world origin, then translation) is part of the operation's own input —
 * implemented by every kernel, never rotation-gated — and a circle is
 * rotationally symmetric, so the one rotation that points local +z along
 * the hole axis is all the placement needs. Axis Z is the identity
 * rotation; axis X rotates +π/2 about Y; axis Y rotates −π/2 about X.
 *
 * ## Semantics (documented where the author reads them)
 *
 * - The hole axis runs PARALLEL to the selected world axis and enters
 *   through the target's + face along it (axis Z drills the top face).
 * - The position is the hole center in the plane PERPENDICULAR to the
 *   axis, expressed in world-axis order skipping the axis itself: axis Z
 *   positions in world (x, y); axis X in (y, z); axis Y in (x, z).
 * - DEPTH is measured inward from the entry face. The through/blind
 *   semantic is honest machine-shop vocabulary, no extra flag: a depth
 *   that reaches the target's remaining extent along the axis (measured
 *   from the target's bounds — `depth ≥ extent`) IS a through hole, and
 *   the tool then spans past both faces ({@link HOLE_TOOL_OVERSHOOT_MM});
 *   a smaller depth is blind, its flat bottom exactly `depth` in.
 * - The tool radius is diameter/2 (the authoring dimension is the
 *   diameter, the plan's vocabulary).
 */
export interface HoleCutPlan {
  /** The tool circle's radius (diameter/2), in millimetres. */
  readonly toolRadiusMm: number;
  /**
   * The tool's extrusion height, in millimetres (blind: depth + overshoot;
   * through: extent + 2·overshoot).
   */
  readonly toolHeightMm: number;
  /**
   * The placement rotation pointing the tool's local +z (the extrusion
   * direction) along the hole axis: a dimensionless world-axis vector and
   * the right-hand angle in radians.
   */
  readonly toolRotationAxis: readonly [number, number, number];
  readonly toolRotationAngleRad: number;
  /**
   * The placement translation: the tool's axis base along the hole axis
   * (blind: entry − depth; through: floor − overshoot) plus the two
   * in-plane position coordinates, in world order.
   */
  readonly toolTranslationMm: readonly [number, number, number];
  /** Whether the plan drills through (`depth ≥ extent` along the axis). */
  readonly through: boolean;
}

/**
 * Plans the tool cut of one hole against the target's measured bounds (see
 * {@link HoleCutPlan} for the semantics). Pure and kernel-independent: the
 * bridge and the worker scene feed it the same five parameters and bounds
 * and get the identical cut.
 */
export function planHoleCut(input: {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly positionXMm: number;
  readonly positionYMm: number;
  readonly axis: HoleAxisSelector;
  readonly bounds: KernelBounds;
}): HoleCutPlan {
  const axisIndex = input.axis - 1;
  const entry = input.bounds.max[axisIndex] ?? 0;
  const floor = input.bounds.min[axisIndex] ?? 0;
  const extent = entry - floor;
  const through = input.depthMm >= extent;
  const toolHeightMm = through
    ? extent + 2 * HOLE_TOOL_OVERSHOOT_MM
    : input.depthMm + HOLE_TOOL_OVERSHOOT_MM;
  const axisBaseMm = through
    ? floor - HOLE_TOOL_OVERSHOOT_MM
    : entry - input.depthMm;
  // The rotation pointing local +z along the hole axis (right-hand rule):
  // identity for Z; +π/2 about Y sends +z to +x; −π/2 about X sends +z to
  // +y. The tool is rotationally symmetric, so the in-plane orientation
  // these rotations leave is irrelevant — only the axis direction matters.
  const toolRotationAxis: readonly [number, number, number] =
    input.axis === 1 ? [0, 1, 0] : input.axis === 2 ? [1, 0, 0] : [1, 0, 0];
  const toolRotationAngleRad =
    input.axis === 1 ? Math.PI / 2 : input.axis === 2 ? -Math.PI / 2 : 0;
  // The in-plane position rides the two world coordinates perpendicular to
  // the axis, in world-axis order (see HoleCutPlan's semantics).
  const toolTranslationMm: readonly [number, number, number] =
    input.axis === 1
      ? [axisBaseMm, input.positionXMm, input.positionYMm]
      : input.axis === 2
        ? [input.positionXMm, axisBaseMm, input.positionYMm]
        : [input.positionXMm, input.positionYMm, axisBaseMm];
  return {
    toolRadiusMm: input.diameterMm / 2,
    toolHeightMm,
    toolRotationAxis,
    toolRotationAngleRad,
    toolTranslationMm,
    through,
  };
}

/**
 * The planned tool cut of one hole whose axis rides a DATUM AXIS (Phase 39):
 * the generalized twin of {@link planHoleCut}. The hole runs PARALLEL to the
 * resolved datum direction and enters through the target's + face ALONG it —
 * the bounds are projected onto the axis to find the entry and floor planes,
 * and the through/blind semantic is the same one-distance rule
 * (`depth ≥ extent` is through). The tool is the same one-segment extruded
 * circle; its placement rotation points local +z along the datum direction
 * (deterministically: the rotation carrying +z onto it, half turn about +x
 * for the exact −z case), and the in-plane position rides the ROTATED
 * tool frame's local x/y axes — the datum form's own documented convention
 * (the world-selector form's position convention is unchanged; the two
 * forms are distinct input layouts and never reinterpreted between them).
 */
export interface HoleAxisCutPlan {
  /** The tool circle's radius (diameter/2), in millimetres. */
  readonly toolRadiusMm: number;
  /** The tool's extrusion height, in millimetres. */
  readonly toolHeightMm: number;
  /** The placement rotation pointing local +z along the datum direction. */
  readonly toolRotationAxis: readonly [number, number, number];
  readonly toolRotationAngleRad: number;
  /** The placement translation: the tool's axis base in world coordinates. */
  readonly toolTranslationMm: readonly [number, number, number];
  /** Whether the plan drills through (`depth ≥ extent` along the axis). */
  readonly through: boolean;
}

/**
 * Plans the datum-axis hole's tool cut against the target's measured bounds
 * (see {@link HoleAxisCutPlan} for the semantics). Pure and
 * kernel-independent; `axisDirection` must be a unit vector (the resolved
 * datum axis guarantees it).
 */
export function planHoleCutWithAxis(input: {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly positionXMm: number;
  readonly positionYMm: number;
  readonly axisDirection: readonly [number, number, number];
  readonly bounds: KernelBounds;
}): HoleAxisCutPlan {
  const d = input.axisDirection;
  const entry = extremeBoundsProjection(input.bounds, d, true);
  const floor = extremeBoundsProjection(input.bounds, d, false);
  const extent = entry - floor;
  const through = input.depthMm >= extent;
  const toolHeightMm = through
    ? extent + 2 * HOLE_TOOL_OVERSHOOT_MM
    : input.depthMm + HOLE_TOOL_OVERSHOOT_MM;
  const axisBaseMm = through
    ? floor - HOLE_TOOL_OVERSHOOT_MM
    : entry - input.depthMm;
  // The rotation carrying local +z onto the datum direction: axis = z × d,
  // angle = atan2(|z × d|, z·d); identity for +d = +z, half turn about +x
  // for the exact −z case.
  const cross = vecCross([0, 0, 1], d);
  const sin = Math.sqrt(vecDot(cross, cross));
  const cos = d[2];
  let rotationAxis: readonly [number, number, number];
  let angle: number;
  if (sin < 1e-12) {
    if (cos > 0) {
      rotationAxis = [1, 0, 0];
      angle = 0;
    } else {
      rotationAxis = [1, 0, 0];
      angle = Math.PI;
    }
  } else {
    rotationAxis = [cross[0] / sin, cross[1] / sin, cross[2] / sin];
    angle = Math.atan2(sin, cos);
  }
  // The rotated local x/y axes carry the in-plane position into the world.
  const matrix = rotationMatrix(rotationAxis, angle);
  const localX = matrixColumn(matrix, 0);
  const localY = matrixColumn(matrix, 1);
  const base = vecCombine(
    vecCombine(
      [axisBaseMm * d[0], axisBaseMm * d[1], axisBaseMm * d[2]],
      input.positionXMm,
      localX,
    ),
    input.positionYMm,
    localY,
  );
  return {
    toolRadiusMm: input.diameterMm / 2,
    toolHeightMm,
    toolRotationAxis: rotationAxis,
    toolRotationAngleRad: angle,
    toolTranslationMm: [base[0], base[1], base[2]],
    through,
  };
}

/** Column `index` of a rotation matrix, as a vector (the rotated basis axis). */
function matrixColumn(
  matrix: readonly [DatumVec3, DatumVec3, DatumVec3],
  index: 0 | 1 | 2,
): DatumVec3 {
  return [matrix[0][index], matrix[1][index], matrix[2][index]];
}

/**
 * How far the split's covering-box tool overshoots past the split plane
 * and past the target's far side (Phase 41), in millimetres — the
 * {@link HOLE_TOOL_OVERSHOOT_MM} discipline verbatim: boolean cuts open
 * cleanly when the tool's faces stand clear of tangencies, and the
 * overshoot never defines the split's geometry (the cut plane is the
 * datum plane, exactly).
 */
export const SPLIT_TOOL_OVERSHOOT_MM = 1;

/** The planned covering-box cut of one split (Phase 41). */
export interface SplitCutPlan {
  /**
   * The tool's square loop in the LOCAL workplane frame (mm), centred on
   * the local origin — sized to cover the target's bounds diagonal.
   */
  readonly toolLoop: readonly ProfileSegmentInput[];
  /** The tool's extrusion height (mm), base to cap along the remove side. */
  readonly toolHeightMm: number;
  /**
   * The placement rotation pointing the tool's local +z (the extrusion
   * direction) along the REMOVE direction (the keep side's negated
   * normal): a dimensionless axis and the right-hand angle in radians.
   */
  readonly toolRotationAxis: readonly [number, number, number];
  readonly toolRotationAngleRad: number;
  /** The tool's base-plane origin translation, in world coordinates. */
  readonly toolTranslationMm: readonly [number, number, number];
  /**
   * The farthest the target reaches along the remove direction past the
   * plane (mm; ≤ 0 when the removed side holds no target material — the
   * post-condition refuses that split, this field names why).
   */
  readonly removedExtentMm: number;
}

/**
 * Plans the covering-box cut of one split against the target's measured
 * bounds (see {@link SplitCutPlan} for the semantics). Pure and
 * kernel-independent: the bridge and the worker scene feed it the same
 * resolved plane, keep-side sign, and bounds and get the identical tool.
 *
 * The tool is an extruded SQUARE, not a transformed box, for the hole
 * tool's reason: the extrude op's placement rotation is part of the
 * operation's own input — implemented by every kernel, never
 * rotation-gated — so the split runs wherever `extrude` + `subtract` do.
 */
export function planSplitCut(input: {
  readonly planeOrigin: readonly [number, number, number];
  readonly planeNormal: readonly [number, number, number];
  /** `+1` keeps the normal's side, `−1` the opposite. */
  readonly keepSide: 1 | -1;
  readonly bounds: KernelBounds;
}): SplitCutPlan {
  const n = input.planeNormal;
  // The remove direction: away from the kept side.
  const d: DatumVec3 = [
    -input.keepSide * n[0],
    -input.keepSide * n[1],
    -input.keepSide * n[2],
  ];
  // The farthest target reach along the remove direction past the plane,
  // and the bounds' centre offsets for the covering square's half size.
  let removedExtent = -Infinity;
  let reachAlongD = -Infinity;
  const center: DatumVec3 = [
    (input.bounds.min[0] + input.bounds.max[0]) / 2,
    (input.bounds.min[1] + input.bounds.max[1]) / 2,
    (input.bounds.min[2] + input.bounds.max[2]) / 2,
  ];
  let radius = 0;
  for (const x of [input.bounds.min[0], input.bounds.max[0]]) {
    for (const y of [input.bounds.min[1], input.bounds.max[1]]) {
      for (const z of [input.bounds.min[2], input.bounds.max[2]]) {
        const offset: DatumVec3 = [
          x - input.planeOrigin[0],
          y - input.planeOrigin[1],
          z - input.planeOrigin[2],
        ];
        removedExtent = Math.max(removedExtent, vecDot(offset, d));
        reachAlongD = Math.max(reachAlongD, vecDot(offset, d));
        radius = Math.max(
          radius,
          Math.hypot(x - center[0], y - center[1], z - center[2]),
        );
      }
    }
  }
  // The covering square centres on the PLANE'S closest point to the bounds
  // centre (the projection), so its half-size covers every target point:
  // |p − c_proj| ≤ radius + |centre − c_proj| for any corner p. The tool's
  // NEAR face sits exactly ON the split plane — the resulting cut face —
  // with the overshoot reserved for the FAR side (past the target):
  // pushing the near face past the plane would remove kept-side material,
  // so the coplanar cut is the honest geometry (pointwise on the fake
  // kernel, exact mesh booleans on Manifold/JSCAD, exact BREP on OCCT —
  // all four handle a coincident tool face).
  const centerOffset = vecDot(
    [
      center[0] - input.planeOrigin[0],
      center[1] - input.planeOrigin[1],
      center[2] - input.planeOrigin[2],
    ],
    n,
  );
  // The plane's closest point to the bounds centre: drop the centre's
  // normal offset (the projection), keeping the in-plane placement.
  const projection: DatumVec3 = vecCombine(center, -centerOffset, n);
  const half = radius + Math.abs(centerOffset) + SPLIT_TOOL_OVERSHOOT_MM;
  const toolHeightMm = Math.max(reachAlongD, 0) + SPLIT_TOOL_OVERSHOOT_MM;
  const rotation = rotationAligningZTo(d);
  const base: DatumVec3 = [projection[0], projection[1], projection[2]];
  return {
    toolLoop: [
      { kind: "line", start: [-half, -half], end: [half, -half] },
      { kind: "line", start: [half, -half], end: [half, half] },
      { kind: "line", start: [half, half], end: [-half, half] },
      { kind: "line", start: [-half, half], end: [-half, -half] },
    ],
    toolHeightMm,
    toolRotationAxis: [rotation.axis[0], rotation.axis[1], rotation.axis[2]],
    toolRotationAngleRad: rotation.angleRad,
    toolTranslationMm: [base[0], base[1], base[2]],
    removedExtentMm: removedExtent,
  };
}

function isBridgeFeatureKind(kind: string): kind is BridgeFeatureKind {
  return BRIDGE_KIND_SET.has(kind);
}

// ---------------------------------------------------------------------------
// Datum resolution (Phase 39): the bridge-side half of the datum seam
// ---------------------------------------------------------------------------

/**
 * The tolerance a resolved datum plane's normal may deviate from an exact
 * world axis and still ride the DIRECT kernel.mirror call (a resolved frame
 * is unit-length by construction; the tolerance absorbs the float noise of
 * resolution). Beyond it the oblique composition path runs.
 */
const DATUM_AXIS_ALIGNMENT_TOLERANCE = 1e-9;

/** How far a revolve datum axis may lean out of the sketch plane. */
const DATUM_COPLANARITY_TOLERANCE = 1e-9;

/** Component-wise dot of two world vectors. */
function vecDot(a: DatumVec3, b: DatumVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Component-wise cross of two world vectors. */
function vecCross(a: DatumVec3, b: DatumVec3): DatumVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** `a + s·b` in world coordinates. */
function vecCombine(a: DatumVec3, s: number, b: DatumVec3): DatumVec3 {
  return [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
}

/** Normalizes a world direction; null when degenerate. */
function vecUnit(a: DatumVec3): DatumVec3 | null {
  const length = Math.sqrt(vecDot(a, a));
  if (length < 1e-12) return null;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/**
 * The world-frame bounds corner used for axis projections: among the eight
 * corners, the one whose position along `direction` is extreme. `max`
 * picks the entry face, `!max` the floor. Deterministic tie behavior is
 * irrelevant — tied corners share the same projection.
 */
function extremeBoundsProjection(
  bounds: KernelBounds,
  direction: DatumVec3,
  max: boolean,
): number {
  let best = max ? -Infinity : Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const projection =
          x * direction[0] + y * direction[1] + z * direction[2];
        best = max ? Math.max(best, projection) : Math.min(best, projection);
      }
    }
  }
  return best;
}

/**
 * The rotation matrix of a right-hand rotation about `axis` (unit) by
 `angle` radians (Rodrigues). Pure float math — the same convention the
 contract's `RotationInput` documents.
 */
function rotationMatrix(
  axis: DatumVec3,
  angle: number,
): readonly [DatumVec3, DatumVec3, DatumVec3] {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** The transpose (inverse of a rotation) applied to a vector. */
function applyMatrixTranspose(
  matrix: readonly [DatumVec3, DatumVec3, DatumVec3],
  v: DatumVec3,
): DatumVec3 {
  return [
    matrix[0][0] * v[0] + matrix[1][0] * v[1] + matrix[2][0] * v[2],
    matrix[0][1] * v[0] + matrix[1][1] * v[1] + matrix[2][1] * v[2],
    matrix[0][2] * v[0] + matrix[1][2] * v[1] + matrix[2][2] * v[2],
  ];
}

/**
 * The rotation carrying `from` onto `to` (both unit): axis = from × to,
 * angle = atan2(|axis|, from·to). Parallel vectors map to the identity
 * (angle 0); antiparallel to a half turn about `fallback` — deterministic
 * picks, never arbitrary. Shared by the executor bridge and the
 * workbench's worker scenes (the pattern kinds' tangent-follow rotation).
 */
export function rotationFromTo(
  from: DatumVec3,
  to: DatumVec3,
  fallback: DatumVec3,
): { readonly axis: DatumVec3; readonly angle: number } {
  const cross = vecCross(from, to);
  const sin = Math.sqrt(vecDot(cross, cross));
  const cos = vecDot(from, to);
  if (sin < 1e-12) {
    if (cos > 0) return { axis: fallback, angle: 0 };
    return { axis: fallback, angle: Math.PI };
  }
  return {
    axis: [cross[0] / sin, cross[1] / sin, cross[2] / sin],
    angle: Math.atan2(sin, cos),
  };
}

/** A structured datum-input diagnostic carrying the failure's own code. */
function datumInputFailure(
  feature: FeatureRecord,
  ref: FeatureInputRef,
  message: string,
  code: string,
): { readonly ok: false; readonly diagnostic: Diagnostic } {
  return {
    ok: false,
    diagnostic: {
      severity: "error",
      code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
      message,
      location: { primary: feature.id, related: [ref.id] },
      data: { datumCode: code },
    },
  };
}

/**
 * A datum kind-mismatch diagnostic: the datum resolved but its kind is not
 * the one the feature role needs (`data.datumCode` names the failure class,
 * the datum resolution seam's convention).
 */
function datumKindMismatch(
  feature: FeatureRecord,
  ref: FeatureInputRef,
  message: string,
): { readonly ok: false; readonly diagnostic: Diagnostic } {
  return {
    ok: false,
    diagnostic: {
      severity: "error",
      code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
      message,
      location: { primary: feature.id, related: [ref.id] },
      data: { datumCode: "datum/kind-invalid" },
    },
  };
}

/**
 * Resolves one `datum` input of the feature to its geometry, through the
 * document record and the caller-supplied topology seam for
 * reference-dependent definitions. Every failure is structured and carries
 * the datum layer's own code in `data.datumCode`.
 */
function resolveDatumInput(
  feature: FeatureRecord,
  ref: FeatureInputRef,
  document: CadDocument,
  seam: DatumTopologyResolver | undefined,
  what: string,
):
  | {
      readonly ok: true;
      readonly datumType: "plane" | "axis" | "point" | "cSys";
      readonly plane?: ResolvedDatumPlane;
      readonly axis?: ResolvedDatumAxis;
    }
  | {
      readonly ok: false;
      readonly diagnostic: Diagnostic;
    } {
  if (ref.kind !== "datum") {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs a datum input where a ${ref.kind} input was declared.`,
        [ref],
      ),
    };
  }
  const record = getDocumentDatum(document, ref.id);
  if (record === undefined) {
    return datumInputFailure(
      feature,
      ref,
      `Feature "${feature.id}" references datum "${ref.id}", which the document does not define.`,
      "document/not-found",
    );
  }
  const payload = parseDatumPayload(record.datum);
  if (!payload.ok) {
    return datumInputFailure(
      feature,
      ref,
      `Feature "${feature.id}" references datum "${ref.id}" whose payload does not parse: ${payload.error.message}`,
      payload.error.code,
    );
  }
  const topologySeam: DatumTopologyResolver = seam ?? {
    facePlane: () => ({
      ok: false,
      error: {
        code: "datum/reference-unresolved",
        message:
          "The executor context provides no datum topology resolver; face-referencing datum definitions cannot resolve.",
        input: null,
      },
    }),
    faceCylinderAxis: () => ({
      ok: false,
      error: {
        code: "datum/reference-unresolved",
        message:
          "The executor context provides no datum topology resolver; face-referencing datum definitions cannot resolve.",
        input: null,
      },
    }),
    edgeLine: () => ({
      ok: false,
      error: {
        code: "datum/reference-unresolved",
        message:
          "The executor context provides no datum topology resolver; edge-referencing datum definitions cannot resolve.",
        input: null,
      },
    }),
  };
  const resolved = resolveDatumPayload(payload.value, topologySeam);
  if (!resolved.ok) {
    return datumInputFailure(
      feature,
      ref,
      `Feature "${feature.id}" could not resolve datum "${ref.id}" (${what}): ${resolved.error.message}`,
      resolved.error.code,
    );
  }
  if (resolved.value.datumType === "plane") {
    return { ok: true, datumType: "plane", plane: resolved.value.plane };
  }
  if (resolved.value.datumType === "axis") {
    return { ok: true, datumType: "axis", axis: resolved.value.axis };
  }
  return datumInputFailure(
    feature,
    ref,
    `Feature "${feature.id}" needs datum "${ref.id}" to define ${what}; it defines a ${resolved.value.datumType === "point" ? "datum point" : "coordinate system"}.`,
    "datum/kind-invalid",
  );
}

/**
 * The planned reflection of a solid about an arbitrary datum plane (the
 * ONE source of the recipe, Phase 43): an AXIS-ALIGNED plane (normal ± a
 * world axis, the datum's resolved frame being exact) rides the DIRECT
 * world-axis mirror at the plane's offset; an OBLIQUE plane composes the
 * reflection from existing contract ops — translate the plane origin to
 * the world origin, rotate the plane normal onto +x, world-plane mirror,
 * rotate back, translate back. The executor bridge
 * ({@link runDatumPlaneMirror}) and the workbench's worker mirror scene
 * both consume this plan, so the two routes build the identical
 * arrangement (the `planHoleCut`/`planSplitCut` precedent).
 *
 * The composed form needs `transformRotation` in addition to `mirror`;
 * callers gate the capabilities before composing (the mirror op's own
 * documentation names the reason: a rotation-less kernel may IGNORE the
 * rotation and silently misplace the reflection).
 */
export type DatumMirrorPlan =
  | {
      readonly kind: "direct";
      readonly axis: MirrorPlaneAxis;
      readonly offsetMm: number;
    }
  | {
      readonly kind: "composed";
      /** Translate by −origin, bringing the plane through the world origin. */
      readonly toOriginMm: readonly [number, number, number];
      /** The rotation carrying the plane normal onto +x (unit axis, rad). */
      readonly align: { readonly axis: DatumVec3; readonly angleRad: number };
      /** Translate back by +origin after the reflection. */
      readonly fromOriginMm: readonly [number, number, number];
    };

/** Plans the reflection of a solid about `plane` (see {@link DatumMirrorPlan}). */
export function planDatumMirror(plane: {
  readonly origin: DatumVec3;
  readonly normal: DatumVec3;
}): DatumMirrorPlan {
  const axes: readonly {
    readonly axis: MirrorPlaneAxis;
    readonly unit: DatumVec3;
  }[] = [
    { axis: "x", unit: [1, 0, 0] },
    { axis: "y", unit: [0, 1, 0] },
    { axis: "z", unit: [0, 0, 1] },
  ];
  const aligned = axes.find(
    (entry) =>
      Math.abs(Math.abs(vecDot(plane.normal, entry.unit)) - 1) <=
      DATUM_AXIS_ALIGNMENT_TOLERANCE,
  );
  if (aligned !== undefined) {
    // Direct call: the plane {p : p·unit = p·origin} is the world-axis
    // plane at offset p·unit — identical for either normal orientation.
    return {
      kind: "direct",
      axis: aligned.axis,
      offsetMm: vecDot(plane.origin, aligned.unit),
    };
  }
  const turn = rotationFromTo(plane.normal, [1, 0, 0], [0, 1, 0]);
  return {
    kind: "composed",
    toOriginMm: [-plane.origin[0], -plane.origin[1], -plane.origin[2]],
    align: { axis: turn.axis, angleRad: turn.angle },
    fromOriginMm: [plane.origin[0], plane.origin[1], plane.origin[2]],
  };
}

/**
 * Plans one mirrored copy of `solid` about the arbitrary plane
 * {@link ResolvedDatumPlane} (Phase 39): the {@link planDatumMirror} plan
 * driven against the kernel — the direct route is one `kernel.mirror`
 * call; the composed route is the documented translate/rotate/mirror/
 * rotate/translate chain.
 *
 * The composition needs `transformRotation` in addition to `mirror`; a
 * kernel without either refuses structurally (the capability-gate
 * precedent) — the contract allows a rotation-less kernel to IGNORE a
 * rotation, which would silently misplace the reflection.
 */
function runDatumPlaneMirror(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  solid: KernelSolid,
  plane: ResolvedDatumPlane,
): OperationOutcome {
  const plan = planDatumMirror({
    origin: plane.origin,
    normal: plane.normal,
  });
  if (plan.kind === "direct") {
    const mirrored = kernel.mirror(solid, {
      axis: plan.axis,
      offset: lengthValue(plan.offsetMm),
    });
    return mirrored.ok
      ? { ok: true, solid: mirrored.value }
      : operationFailure(feature, mirrored.error.code, mirrored.error.message);
  }
  if (!kernel.capabilities.mirror || !kernel.capabilities.transformRotation) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" mirrors about an oblique datum plane, which composes rotations with a world-plane reflection, but this kernel ("${kernel.id}") does not declare the ${!kernel.capabilities.mirror ? "mirror" : "transformRotation"} capability — the gate refuses before the kernel can ignore a rotation and build a misplaced reflection.`,
      ),
    };
  }
  const toOrigin = kernel.transform(solid, {
    x: lengthValue(plan.toOriginMm[0]),
    y: lengthValue(plan.toOriginMm[1]),
    z: lengthValue(plan.toOriginMm[2]),
  });
  if (!toOrigin.ok) {
    return operationFailure(
      feature,
      toOrigin.error.code,
      toOrigin.error.message,
    );
  }
  const rotated = kernel.transform(toOrigin.value, {
    x: lengthValue(0),
    y: lengthValue(0),
    z: lengthValue(0),
    rotation: {
      axis: plan.align.axis,
      angle: angleValue(plan.align.angleRad, "rad"),
    },
  });
  if (!rotated.ok) {
    return operationFailure(feature, rotated.error.code, rotated.error.message);
  }
  const reflected = kernel.mirror(rotated.value, {
    axis: "x",
    offset: lengthValue(0),
  });
  if (!reflected.ok) {
    return operationFailure(
      feature,
      reflected.error.code,
      reflected.error.message,
    );
  }
  const backTurn = kernel.transform(reflected.value, {
    x: lengthValue(0),
    y: lengthValue(0),
    z: lengthValue(0),
    rotation: {
      axis: plan.align.axis,
      angle: angleValue(-plan.align.angleRad, "rad"),
    },
  });
  if (!backTurn.ok) {
    return operationFailure(
      feature,
      backTurn.error.code,
      backTurn.error.message,
    );
  }
  const final = kernel.transform(backTurn.value, {
    x: lengthValue(plan.fromOriginMm[0]),
    y: lengthValue(plan.fromOriginMm[1]),
    z: lengthValue(plan.fromOriginMm[2]),
  });
  return final.ok
    ? { ok: true, solid: final.value }
    : operationFailure(feature, final.error.code, final.error.message);
}

type BridgeDiagnosticCode = Extract<
  DiagnosticCode,
  | "kernel/unknown-feature-kind"
  | "kernel/feature-input-invalid"
  | "kernel/parameter-invalid"
  | "kernel/operation-failed"
>;

function diagnostic(
  feature: FeatureRecord,
  code: BridgeDiagnosticCode,
  message: string,
  related: readonly FeatureInputRef[] = [],
): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    location: { primary: feature.id, related: related.map((ref) => ref.id) },
  };
}

type LengthOutcome =
  | { readonly ok: true; readonly mm: number }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

type AngleOutcome =
  | { readonly ok: true; readonly rad: number }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

/**
 * A dimensionless parameter's magnitude in its canonical unity unit — the
 * dimension the pattern counts and axis selectors ride (the parameter
 * model is dimensional: an integer COUNT has no length or angle dimension,
 * so it rides a dimensionless value and the consuming FEATURE validates
 * integrality — see `runPatternOperation`).
 */
type DimensionlessOutcome =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

type SolidOutcome =
  | { readonly ok: true; readonly solid: KernelSolid }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

type OperationOutcome = SolidOutcome;

/**
 * Creates a feature executor that interprets the bridge's feature kinds as
 * kernel operations through the given kernel instance. The kernel instance
 * owns every handle it mints, so use one kernel per bridge (and per run).
 */
export function createKernelFeatureExecutor(
  kernel: GeometryKernel,
  context: KernelExecutorContext,
): KernelExecutionBridge {
  const parameters = new Map<string, AnyDimensionalValue>(
    context.document.parameters.parameters.map((parameter) => [
      parameter.id,
      parameter.value,
    ]),
  );
  const featureOutputs = new Map<FeatureId, BodyId>(
    context.document.features.flatMap((feature) => {
      const output = feature.outputs[0];
      return output === undefined ? [] : [[feature.id, output] as const];
    }),
  );
  const solids = new Map<BodyId, KernelSolid>(context.bodies);

  const lengthParameter = (
    feature: FeatureRecord,
    ref: FeatureInputRef,
    name: string,
  ): LengthOutcome => {
    const value = parameters.get(ref.id);
    if (value === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" references parameter "${ref.id}" (${name}), which the document does not define.`,
          [ref],
        ),
      };
    }
    if (value.dimension !== "length") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs parameter "${ref.id}" (${name}) to be a length; it is a ${value.dimension}.`,
          [ref],
        ),
      };
    }
    return { ok: true, mm: valueIn(value, "mm") };
  };

  const angleParameter = (
    feature: FeatureRecord,
    ref: FeatureInputRef,
    name: string,
  ): AngleOutcome => {
    const value = parameters.get(ref.id);
    if (value === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" references parameter "${ref.id}" (${name}), which the document does not define.`,
          [ref],
        ),
      };
    }
    if (value.dimension !== "angle") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs parameter "${ref.id}" (${name}) to be an angle; it is a ${value.dimension}.`,
          [ref],
        ),
      };
    }
    return { ok: true, rad: valueIn(value, "rad") };
  };

  const dimensionlessParameter = (
    feature: FeatureRecord,
    ref: FeatureInputRef,
    name: string,
  ): DimensionlessOutcome => {
    const value = parameters.get(ref.id);
    if (value === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" references parameter "${ref.id}" (${name}), which the document does not define.`,
          [ref],
        ),
      };
    }
    if (value.dimension !== "dimensionless") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs parameter "${ref.id}" (${name}) to be dimensionless; it is a ${value.dimension}.`,
          [ref],
        ),
      };
    }
    return { ok: true, value: valueIn(value, "1") };
  };

  const solidInput = (
    feature: FeatureRecord,
    ref: FeatureInputRef,
  ): SolidOutcome => {
    if (ref.kind === "parameter") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs a feature or body input where parameter "${ref.id}" was declared.`,
          [ref],
        ),
      };
    }
    if (ref.kind === "sketch") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs a feature or body input where sketch "${ref.id}" was declared; sketches are profile sources, not solids.`,
          [ref],
        ),
      };
    }
    if (ref.kind === "body") {
      const solid = solids.get(ref.id);
      if (solid === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" references body "${ref.id}", which has no solid (none was produced this run and none was supplied).`,
            [ref],
          ),
        };
      }
      return { ok: true, solid };
    }
    const outputBody =
      ref.kind === "feature" ? featureOutputs.get(ref.id) : undefined;
    if (outputBody === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" references feature "${ref.id}", which declares no output body.`,
          [ref],
        ),
      };
    }
    const solid = solids.get(outputBody);
    if (solid === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" references feature "${ref.id}", whose output body "${outputBody}" has no solid yet (it did not execute before this feature).`,
          [ref],
        ),
      };
    }
    return { ok: true, solid };
  };

  const execute = (feature: FeatureRecord): FeatureExecutionOutcome => {
    const output = feature.outputs[0];
    if (feature.outputs.length !== 1 || output === undefined) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${feature.kind}" must declare exactly one output body; it declares ${feature.outputs.length}.`,
          ),
        ],
      };
    }
    const kind = feature.kind;
    if (!isBridgeFeatureKind(kind)) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelUnknownFeatureKind,
            `Feature "${feature.id}" has kind "${kind}", which the kernel executor bridge does not interpret; known kinds: ${BRIDGE_FEATURE_KINDS.join(", ")}.`,
          ),
        ],
      };
    }

    const result = runKernelOperation(kernel, feature, kind, {
      lengthParameter: (ref, name) => lengthParameter(feature, ref, name),
      angleParameter: (ref, name) => angleParameter(feature, ref, name),
      dimensionlessParameter: (ref, name) =>
        dimensionlessParameter(feature, ref, name),
      parameterValue: (ref) => parameters.get(ref.id),
      solidInput: (ref) => solidInput(feature, ref),
      resolveProfile: (ref) => context.profiles(ref.id),
      resolvePath: (ref) =>
        context.paths === undefined
          ? ({
              ok: false,
              error: {
                code: "kernel/feature-input-invalid",
                message:
                  "The executor context provides no path resolver; sweep features cannot resolve a path sketch.",
                input: ref.id,
              },
            } as const)
          : context.paths(ref.id),
      resolveSketchPoints: (ref) =>
        context.points === undefined
          ? ({
              ok: false,
              error: {
                code: "kernel/feature-input-invalid",
                message:
                  "The executor context provides no sketch-points resolver; sketch-positioned hole features cannot resolve their positions sketch.",
                input: ref.id,
              },
            } as const)
          : context.points(ref.id),
      bodyIdOf: (ref) => {
        if (ref.kind === "body") return ref.id;
        if (ref.kind === "feature") return featureOutputs.get(ref.id);
        return undefined;
      },
      document: context.document,
      topology: context.topology,
      datumTopology: context.datumTopology,
    });
    if (!result.ok) return { ok: false, diagnostics: [result.diagnostic] };
    solids.set(output, result.solid);
    return { ok: true };
  };

  return {
    executor: execute,
    solidOf: (bodyId: BodyId): KernelSolid | undefined => solids.get(bodyId),
  };
}

/** How the per-kind interpreter reads inputs. */
interface InputReaders {
  readonly lengthParameter: (
    ref: FeatureInputRef,
    name: string,
  ) => LengthOutcome;
  readonly angleParameter: (ref: FeatureInputRef, name: string) => AngleOutcome;
  readonly dimensionlessParameter: (
    ref: FeatureInputRef,
    name: string,
  ) => DimensionlessOutcome;
  /**
   * The raw parameter value a ref addresses (`undefined` when the document
   * does not define it) — the patternFeature leg parser's dimension probe:
   * the leg triple's greedy read needs each parameter's DIMENSION before
   * committing a typed reader to it.
   */
  readonly parameterValue: (
    ref: FeatureInputRef,
  ) => AnyDimensionalValue | undefined;
  readonly solidInput: (ref: FeatureInputRef) => SolidOutcome;
  readonly resolveProfile: (
    ref: FeatureInputRef & { readonly kind: "sketch" },
  ) => KernelProfileResolution;
  /** Resolves a sketch ref as a sweep path chain (the sweep kinds' seam). */
  readonly resolvePath: (
    ref: FeatureInputRef & { readonly kind: "sketch" },
  ) => KernelPathResolution;
  /**
   * Resolves a sketch ref as a POINT-position list (the structured hole's
   * seam, Phase 42 — the paths precedent's shape).
   */
  readonly resolveSketchPoints: (
    ref: FeatureInputRef & { readonly kind: "sketch" },
  ) => KernelSketchPointsResolution;
  /**
   * The output body a feature/body ref addresses: a body ref names itself,
   * a feature ref its (single) output body, anything else `undefined`. The
   * edge-cutting paths' cross-body check compares edge references against
   * it.
   */
  readonly bodyIdOf: (ref: FeatureInputRef) => BodyId | undefined;
  /** The document whose reference records the edge-cutting paths resolve. */
  readonly document: CadDocument;
  /** The reference-resolution view (see KernelExecutorContext.topology). */
  readonly topology: TopologyView | undefined;
  /**
   * The datum topology-geometry seam (see KernelExecutorContext.datumTopology):
   * reference-dependent datum definitions resolve through it.
   */
  readonly datumTopology: DatumTopologyResolver | undefined;
}

/** Reads exactly `count` length parameters named by `names`. */
function readLengths(
  feature: FeatureRecord,
  readers: InputReaders,
  refs: readonly FeatureInputRef[],
  names: readonly string[],
):
  | { readonly ok: true; readonly mm: readonly number[] }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (refs.length !== names.length) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs exactly ${names.length} parameter inputs (${names.join(", ")}); it declares ${refs.length}.`,
      ),
    };
  }
  const values: number[] = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const name = names[i];
    if (ref === undefined || name === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" has a malformed input list.`,
        ),
      };
    }
    if (ref.kind !== "parameter") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs a parameter input for ${name}; a ${ref.kind} input was declared.`,
          [ref],
        ),
      };
    }
    const value = readers.lengthParameter(ref, name);
    if (!value.ok) return value;
    values.push(value.mm);
  }
  return { ok: true, mm: values };
}

/** Reads at least `minimum` feature/body inputs as solids. */
function readSolids(
  feature: FeatureRecord,
  readers: InputReaders,
  refs: readonly FeatureInputRef[],
  minimum: number,
):
  | { readonly ok: true; readonly solids: readonly KernelSolid[] }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (refs.length < minimum) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs at least ${minimum} feature/body inputs; it declares ${refs.length}.`,
      ),
    };
  }
  const resolved: KernelSolid[] = [];
  for (const ref of refs) {
    const value = readers.solidInput(ref);
    if (!value.ok) return value;
    resolved.push(value.solid);
  }
  return { ok: true, solids: resolved };
}

function operationFailure(
  feature: FeatureRecord,
  code: string,
  message: string,
): { readonly ok: false; readonly diagnostic: Diagnostic } {
  return {
    ok: false,
    diagnostic: {
      severity: "error",
      code: DIAGNOSTIC_CODES.kernelOperationFailed,
      message: `Feature "${feature.id}" of kind "${feature.kind}" failed its kernel operation (${code}): ${message}`,
      location: { primary: feature.id },
      data: { kernelErrorCode: code },
    },
  };
}

/**
 * The reference kind each topology-addressed kind consumes: the edge cutters
 * address EDGES, the hollow addresses FACES — the one axis along which the
 * shared battery below varies.
 */
type TopologyCutKind = "fillet" | "chamfer" | "shell";

function referenceKindOf(kind: TopologyCutKind): "edge" | "face" {
  return kind === "shell" ? "face" : "edge";
}

/**
 * The shared executor path of the topology-addressed kinds — `fillet`
 * (Phase 26.5), `chamfer` (Phase 26.6), and `shell` (Phase 26.7, on the
 * FACE reference kind): the input layout is ONE feature/body input (the
 * target solid), one or more REFERENCE inputs (the topology selection —
 * edges for the cutters, faces for the hollow), and exactly one LENGTH
 * parameter (the cut size — the radius, the symmetric distance, or the
 * wall thickness). Every reference is RESOLVED before the kernel runs,
 * through the same battery either way: the record's payload parses
 * through cad-core's `parseTopologyReference`, the reference must address
 * the target's own output body, and `resolveDocumentReference` against
 * the context's {@link TopologyView} re-resolves it against the CURRENT
 * regeneration's topology — a moved or vanished entity surfaces as a
 * structured diagnostic (the validity state and, for an invalid
 * reference, its structural reason ride the diagnostic's data), never as
 * silent re-attachment. Resolved references map through
 * `transientSelectionOf` to snapshot ordinals of the call's reference
 * kind, the addresses `kernel.fillet`/`kernel.chamfer` (edges) and
 * `kernel.shell` (faces) consume. `parameter.set` on the cut size
 * re-drives the feature through regeneration.
 */
function runEdgeCutOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  kind: TopologyCutKind,
  parameterName: string,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const referenceKind = referenceKindOf(kind);
  // Input layout: ONE feature/body input (the target solid), one or more
  // REFERENCE inputs (the topology selection), and exactly one length
  // parameter (the cut size). The roles are read off the refs' kinds, so
  // declaration order within the layout is free.
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const edgeRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "reference" } =>
      ref.kind === "reference",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  const otherRefs = inputs.filter((ref) => ref.kind === "sketch");
  if (
    targetRefs.length !== 1 ||
    parameterRefs.length !== 1 ||
    edgeRefs.length < 1
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${kind}" needs exactly one feature/body input (the target solid), at least one reference input (the ${referenceKind} selection), and exactly one parameter input (the ${parameterName}); it declares ${targetRefs.length} target(s), ${edgeRefs.length} reference(s), and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  if (otherRefs.length > 0) {
    const offender = otherRefs[0];
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${kind}" needs a feature/body input as its target; a sketch input cannot be ${kind}ed.`,
        offender === undefined ? [] : [offender],
      ),
    };
  }
  const targetRef = targetRefs[0];
  const sizeRef = parameterRefs[0];
  if (targetRef === undefined || sizeRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${kind}" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;
  // sizeRef's kind is the filter-narrowed "parameter" — no runtime
  // re-check needed; only its undefined case was handled above.
  const size = readers.lengthParameter(sizeRef, parameterName);
  if (!size.ok) return { ok: false, diagnostic: size.diagnostic };
  const view = readers.topology;
  if (view === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${kind}" carries ${referenceKind} references, but the executor context provides no topology view to resolve them against; ${kind} is ${referenceKind}-addressed and cannot run without resolution.`,
      ),
    };
  }
  // Resolve every reference through the Phase 22 protocol against
  // the CURRENT regeneration: parse the stored payload, check it
  // addresses the target's own body, resolve, and require a resolved
  // (valid or repaired) entity of the call's reference KIND. Every
  // failure mode is a structured diagnostic — a stale reference fails
  // regeneration with its validity state named, it never silently
  // re-attaches.
  const ordinals: number[] = [];
  for (const edgeRef of edgeRefs) {
    const record = getDocumentReference(readers.document, edgeRef.id);
    if (record === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${kind}" references record "${edgeRef.id}", which the document does not define.`,
          [edgeRef],
        ),
      };
    }
    const parsed = parseTopologyReference(record.reference);
    if (!parsed.ok) {
      return {
        ok: false,
        diagnostic: {
          severity: "error",
          code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          message: `Feature "${feature.id}" of kind "${kind}" has an unparseable reference record ("${edgeRef.id}"): ${parsed.error.message}`,
          location: { primary: feature.id, related: [edgeRef.id] },
          data: { referenceCode: parsed.error.code },
        },
      };
    }
    if (parsed.value.kind !== referenceKind) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${kind}" needs ${referenceKind.toUpperCase()} references; reference "${edgeRef.id}" addresses a ${parsed.value.kind}.`,
          [edgeRef],
        ),
      };
    }
    const targetBody = readers.bodyIdOf(targetRef);
    if (targetBody !== undefined && parsed.value.bodyId !== targetBody) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${kind}" mixes bodies: reference "${edgeRef.id}" addresses body "${parsed.value.bodyId}", but the ${kind} target's output body is "${targetBody}".`,
          [edgeRef],
        ),
      };
    }
    const resolved = resolveDocumentReference(
      readers.document,
      parsed.value,
      view,
    );
    if (!resolved.ok) {
      return {
        ok: false,
        diagnostic: {
          severity: "error",
          code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          message: `Feature "${feature.id}" of kind "${kind}" could not resolve reference "${edgeRef.id}": ${resolved.error.message}`,
          location: { primary: feature.id, related: [edgeRef.id] },
          data: { referenceCode: resolved.error.code },
        },
      };
    }
    const { state, reason } = resolved.value.validity;
    if (state !== "valid" && state !== "repaired") {
      return {
        ok: false,
        diagnostic: {
          severity: "error",
          code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          message: `Feature "${feature.id}" of kind "${kind}" has an unresolved ${referenceKind} reference ("${edgeRef.id}"): it stands ${state}${reason === undefined ? "" : ` (${reason})`} against the current regeneration. Re-select the ${referenceKind} to mint a fresh reference.`,
          location: { primary: feature.id, related: [edgeRef.id] },
          data: {
            validityState: state,
            ...(reason !== undefined ? { reason } : {}),
          },
        },
      };
    }
    const selection = transientSelectionOf(resolved.value);
    if (!selection.ok) {
      return {
        ok: false,
        diagnostic: {
          severity: "error",
          code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          message: `Feature "${feature.id}" of kind "${kind}" could not map reference "${edgeRef.id}" to its snapshot coordinates: ${selection.error.message}`,
          location: { primary: feature.id, related: [edgeRef.id] },
          data: { referenceCode: selection.error.code },
        },
      };
    }
    if (referenceKind === "edge") {
      if (selection.value.kind !== "edge") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Invariant violation: reference "${edgeRef.id}" resolved as an edge but mapped to a ${selection.value.kind} selection.`,
            [edgeRef],
          ),
        };
      }
      ordinals.push(selection.value.edgeIndex);
    } else {
      if (selection.value.kind !== "face") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Invariant violation: reference "${edgeRef.id}" resolved as a face but mapped to a ${selection.value.kind} selection.`,
            [edgeRef],
          ),
        };
      }
      ordinals.push(selection.value.faceIndex);
    }
  }
  const cut = lengthValue(size.mm);
  const result =
    kind === "fillet"
      ? kernel.fillet({ target: target.solid, edges: ordinals, radius: cut })
      : kind === "chamfer"
        ? kernel.chamfer({
            target: target.solid,
            edges: ordinals,
            distance: cut,
          })
        : kernel.shell({
            target: target.solid,
            faces: ordinals,
            thickness: cut,
          });
  return result.ok
    ? { ok: true, solid: result.value }
    : operationFailure(feature, result.error.code, result.error.message);
}

/**
 * The pattern feature kinds' shared executor path (Phase 26.8) —
 * FEATURE-LEVEL COMPOSITION over the contract's existing ops: the bridge
 * issues `count − 1` `transform` calls and one `union` of the target plus
 * the copies (see the module doc's design-decision paragraph for why
 * composition, not a kernel-level pattern op).
 *
 * ## Input layout (roles off the refs' kinds; parameter roles in declared
 * order)
 *
 * ONE feature/body input (the solid to repeat), then exactly THREE
 * parameter inputs, read in their declared order:
 *
 * - `patternLinear`: count (DIMENSIONLESS integer ≥ 2), spacing (LENGTH >
 *   0), direction (ANGLE — counter-clockwise in the world XY plane from
 *   +x, the revolve axis precedent's plane discipline carried to world
 *   space; the direction is the unit vector `(cos θ, sin θ, 0)`, so the
 *   copy i sits at `i · spacing` along it — out-of-plane directions are
 *   not reachable from one angle and compose instead from a `translate`
 *   feature ahead of the pattern).
 * - `patternCircular`: count (DIMENSIONLESS integer ≥ 2), total angle
 *   (ANGLE in `(0, 2π]`), axis (DIMENSIONLESS integer `1` = world X,
 *   `2` = Y, `3` = Z — the revolve axis precedent, a parameter selecting
 *   the axis line; here the line is the world-axis line through the
 *   ORIGIN, the only line the transform contract rotates about).
 *
 * ## Semantics
 *
 * Linear: copy i sits at `i · spacing · (cos θ, sin θ, 0)`, `i = 0` the
 * untranslated target — `count` copies total, then one `union`. Overlapping
 * copies are LEGAL input everywhere (a pattern may interpenetrate
 * deliberately): the union is judged by each kernel's own boolean fidelity
 * (probed on the fake kernel: overlapping and even fully coincident unions
 * do not fail — the coincident union is exactly idempotent — which is why
 * zero SPACING is refused below rather than left to produce that silent
 * no-op).
 *
 * Circular: the step is `Δ = totalAngle / count` and copy i is the target
 * rotated by `i · Δ` about the axis, `i = 0` the unrotated target. Full
 * circle: `totalAngle = 2π` distributes the copies evenly at `i · 2π/count`
 * with NO duplicate at the full turn (i stops at `count − 1`). Partial:
 * `totalAngle < 2π` places the copies WITHIN `[0, totalAngle]` at pitch
 * `totalAngle / count` — the last copy stands at
 * `(count − 1)/count · totalAngle`, one pitch short of the wedge's open
 * end. `Δ = 0` is refused by the `totalAngle > 0` domain rule. The
 * rotation capability is gated BEFORE any call: a kernel that has not
 * declared `transformRotation` may per the contract IGNORE the rotation,
 * which would silently stack every copy on the target — the gate refuses
 * structurally instead of letting that wrong answer build.
 *
 * ## Count modeling (the honest dimensionless ride)
 *
 * The parameter model is dimensional (`length`, `angle`, …); an integer
 * count has no place in it as a dimension, so counts ride DIMENSIONLESS
 * values (the Phase 4 dimensionless type, canonical unit unity) and the
 * FEATURE validates what the model cannot express: integrality, the ≥ 2
 * floor, and the ≤ 1000 ceiling (regeneration is synchronous — one bridge
 * call issues `count − 1` kernel transforms — so the bound keeps a stray
 * `1e9` from wedging it; larger arrays compose from nested patterns).
 *
 * ## Failure taxonomy (all structured, before any kernel call)
 *
 * - Layout: not exactly one feature/body target or exactly three parameter
 *   inputs → `kernel/feature-input-invalid`.
 * - Count: wrong dimension, non-integer, `< 2`, or `> 1000` →
 *   `kernel/parameter-invalid`.
 * - Spacing (linear): wrong dimension or `≤ 0` → `kernel/parameter-invalid`.
 * - Direction (linear): wrong dimension → `kernel/parameter-invalid` (the
 *   direction itself is a unit vector by construction — it cannot
 *   degenerate).
 * - Total angle (circular): wrong dimension, `≤ 0`, or `> 2π` →
 *   `kernel/parameter-invalid`.
 * - Axis (circular): wrong dimension or an integer outside `1..3` →
 *   `kernel/parameter-invalid` (the selector's domain is total, so a
 *   degenerate zero/non-finite direction cannot be constructed — the
 *   mapped direction is always a unit basis vector).
 * - Rotation capability (circular): a kernel without
 *   `transformRotation` → `kernel/feature-input-invalid`.
 * - Kernel failures (a transform or the union rejecting) ride through as
 *   `kernel/operation-failed` with the kernel code in `data`.
 */
function runPatternOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  kind: "patternLinear" | "patternCircular",
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const parameterNames =
    kind === "patternLinear"
      ? (["count", "spacing", "direction"] as const)
      : (["count", "totalAngle", "axis"] as const);
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  const datumRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "datum" } =>
      ref.kind === "datum",
  );
  const otherRefs = inputs.filter(
    (ref) =>
      ref.kind !== "feature" && ref.kind !== "body" && ref.kind !== "parameter",
  );
  // Phase 39: patternCircular's axis may ride a DATUM AXIS instead of the
  // dimensionless world-axis selector — one target, count + total angle
  // parameters, and one datum input. Phase 43 generalizes patternLinear's
  // DIRECTION the same two ways: a DATUM AXIS input (the resolved axis's
  // full 3D unit direction) or a SKETCH input (the resolved open chain's
  // unit end−start vector, the path-pattern frame) replace the direction
  // angle parameter — count + spacing parameters plus the one direction
  // input.
  const sketchRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "sketch" } =>
      ref.kind === "sketch",
  );
  const linearDatumDirectionForm =
    kind === "patternLinear" &&
    datumRefs.length === 1 &&
    sketchRefs.length === 0 &&
    parameterRefs.length === 2;
  const linearSketchDirectionForm =
    kind === "patternLinear" &&
    sketchRefs.length === 1 &&
    datumRefs.length === 0 &&
    parameterRefs.length === 2;
  const datumAxisForm =
    (kind === "patternCircular" &&
      datumRefs.length === 1 &&
      parameterRefs.length === 2) ||
    linearDatumDirectionForm;
  const expectedParameters = datumAxisForm || linearSketchDirectionForm ? 2 : 3;
  if (targetRefs.length !== 1 || parameterRefs.length !== expectedParameters) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        datumAxisForm
          ? `Feature "${feature.id}" of kind "${kind}" in datum-axis form needs exactly one feature/body input (the solid to repeat), two parameter inputs (count, ${kind === "patternLinear" ? "spacing" : "totalAngle"}), and exactly one datum input (the ${kind === "patternLinear" ? "direction axis" : "axis"}); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`
          : linearSketchDirectionForm
            ? `Feature "${feature.id}" of kind "${kind}" in sketch-line form needs exactly one feature/body input (the solid to repeat), two parameter inputs (count, spacing), and exactly one sketch input (the direction line); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`
            : `Feature "${feature.id}" of kind "${kind}" needs exactly one feature/body input (the solid to repeat) and exactly three parameter inputs (${parameterNames.join(", ")}); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  // In the compat form every non-target, non-parameter input (a datum among
  // them) is a misdeclaration; in the datum-axis and sketch-line forms the
  // input list must be exactly target + two parameters + the one
  // direction input.
  if (datumAxisForm || linearSketchDirectionForm) {
    const directionKind = datumAxisForm ? "datum" : "sketch";
    if (inputs.length !== 4 || otherRefs.length !== 1) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${kind}" in ${datumAxisForm ? "datum-axis" : "sketch-line"} form must carry exactly one target input, two parameter inputs (count, ${kind === "patternLinear" ? "spacing" : "totalAngle"}), and one ${directionKind} input (the ${kind === "patternLinear" ? "direction" : "axis"}); it declares ${inputs.length} input(s).`,
        ),
      };
    }
  } else if (otherRefs.length > 0) {
    const offender = otherRefs[0];
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${kind}" needs a feature/body input as its target; a ${offender?.kind ?? "unknown"} input cannot be patterned.`,
        offender === undefined ? [] : [offender],
      ),
    };
  }
  const targetRef = targetRefs[0];
  const countRef = parameterRefs[0];
  const secondRef = parameterRefs[1];
  const thirdRef = parameterRefs[2];
  if (
    targetRef === undefined ||
    countRef === undefined ||
    secondRef === undefined ||
    (thirdRef === undefined && !datumAxisForm && !linearSketchDirectionForm)
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${kind}" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;

  // The count: dimensionless ride + feature-level integrality and bounds.
  const countValue = readers.dimensionlessParameter(countRef, "count");
  if (!countValue.ok) return { ok: false, diagnostic: countValue.diagnostic };
  const count = countValue.value;
  if (!Number.isInteger(count)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "${kind}" needs parameter "${countRef.id}" (count) to be a whole number of copies; ${count} is not an integer.`,
        [countRef],
      ),
    };
  }
  if (count < 2) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "${kind}" needs a count of at least 2 (${count} given) — a pattern of one copy is no pattern.`,
        [countRef],
      ),
    };
  }
  if (count > PATTERN_COUNT_LIMIT) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "${kind}" needs a count of at most ${PATTERN_COUNT_LIMIT} (${count} given) — regeneration issues one kernel transform per copy synchronously; compose nested patterns for larger arrays.`,
        [countRef],
      ),
    };
  }

  // The copies: copy 0 is the target itself; the bridge composes the rest.
  const copies: KernelSolid[] = [target.solid];
  if (kind === "patternLinear") {
    const spacing = readers.lengthParameter(secondRef, "spacing");
    if (!spacing.ok) return { ok: false, diagnostic: spacing.diagnostic };
    if (!(spacing.mm > 0)) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${kind}" needs a strictly positive spacing (${spacing.mm} mm given) — zero or negative spacing stacks the copies and the pattern degenerates to its target.`,
          [secondRef],
        ),
      };
    }
    // Phase 43: the direction generalizes to a resolved DATUM AXIS (a
    // full 3D unit direction) or a SKETCH LINE (the resolved open chain's
    // unit end−start vector, local (x, z) → world (x, 0, z) — the
    // path-pattern frame), each replacing the angle parameter's world-XY
    // direction.
    let unit: readonly [number, number, number] | null = null;
    if (linearDatumDirectionForm) {
      const datumRef = datumRefs[0];
      if (datumRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${kind}" has a malformed input list.`,
          ),
        };
      }
      const resolved = resolveDatumInput(
        feature,
        datumRef,
        readers.document,
        readers.datumTopology,
        "the pattern direction axis",
      );
      if (!resolved.ok) return { ok: false, diagnostic: resolved.diagnostic };
      if (resolved.datumType !== "axis" || resolved.axis === undefined) {
        return datumKindMismatch(
          feature,
          datumRef,
          `Feature "${feature.id}" of kind "${kind}" needs a datum AXIS as its pattern direction; the referenced datum defines ${resolved.datumType === "plane" ? "a plane" : resolved.datumType === "point" ? "a point" : "a coordinate system"}.`,
        );
      }
      unit = vecUnit(resolved.axis.direction);
      if (unit === null) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${kind}" resolved a degenerate direction axis (the datum's direction does not normalize); the pattern has no direction to march.`,
            [datumRef],
          ),
        };
      }
    } else if (linearSketchDirectionForm) {
      const sketchRef = sketchRefs[0];
      if (sketchRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${kind}" has a malformed input list.`,
          ),
        };
      }
      const resolvedPath = readers.resolvePath(sketchRef);
      if (!resolvedPath.ok) {
        return {
          ok: false,
          diagnostic: {
            severity: "error",
            code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            message: `Feature "${feature.id}" of kind "${kind}" could not resolve its direction sketch "${sketchRef.id}": ${resolvedPath.error.message}`,
            location: { primary: feature.id, related: [sketchRef.id] },
            data: { pathCode: resolvedPath.error.code },
          },
        };
      }
      const structural = sweepPathProblem(resolvedPath.value.path);
      if (structural !== null) {
        return {
          ok: false,
          diagnostic: {
            severity: "error",
            code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            message: `Feature "${feature.id}" of kind "${kind}" has an invalid direction sketch: ${structural}.`,
            location: { primary: feature.id, related: [sketchRef.id] },
            data: { pathCode: "kernel/invalid-path" },
          },
        };
      }
      const chain = resolvedPath.value.path;
      const start = sweepPathStationAt(chain, 0).point;
      const end = sweepPathStationAt(chain, sweepPathTotalLength(chain)).point;
      unit = vecUnit([end[0] - start[0], 0, end[1] - start[1]]);
      if (unit === null) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelParameterInvalid,
            `Feature "${feature.id}" of kind "${kind}" resolved a degenerate direction from sketch "${sketchRef.id}" — the chain's start and end coincide (a closed loop is not a direction).`,
            [sketchRef],
          ),
        };
      }
    } else {
      if (thirdRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${kind}" needs a direction parameter input.`,
          ),
        };
      }
      const direction = readers.angleParameter(thirdRef, "direction");
      if (!direction.ok) {
        return { ok: false, diagnostic: direction.diagnostic };
      }
      unit = [Math.cos(direction.rad), Math.sin(direction.rad), 0];
    }
    const dx = unit[0];
    const dy = unit[1];
    const dz = unit[2];
    for (let i = 1; i < count; i += 1) {
      const offset = i * spacing.mm;
      const placed = kernel.transform(target.solid, {
        x: lengthValue(offset * dx),
        y: lengthValue(offset * dy),
        z: lengthValue(offset * dz),
      });
      if (!placed.ok) {
        return operationFailure(
          feature,
          placed.error.code,
          placed.error.message,
        );
      }
      copies.push(placed.value);
    }
  } else {
    if (!kernel.capabilities.transformRotation) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${kind}" needs rotated copies, but this kernel ("${kernel.id}") does not declare the transformRotation capability — the contract allows such a kernel to ignore a rotation, which would silently stack every copy on the target, so the pattern refuses to run rather than build that wrong answer.`,
        ),
      };
    }
    const totalAngle = readers.angleParameter(secondRef, "totalAngle");
    if (!totalAngle.ok) {
      return { ok: false, diagnostic: totalAngle.diagnostic };
    }
    if (!(totalAngle.rad > 0)) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${kind}" needs a strictly positive total angle (${totalAngle.rad} rad given) — zero total angle steps every copy by Δ = 0 and the pattern degenerates to its target.`,
          [secondRef],
        ),
      };
    }
    if (totalAngle.rad > FULL_CIRCLE_RAD + ANGLE_DOMAIN_TOLERANCE_RAD) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${kind}" needs a total angle of at most one full turn, 2π ≈ 6.2832 rad (${totalAngle.rad} rad given) — a longer sweep double-covers the circle, the revolve sweep domain's rule.`,
          [secondRef],
        ),
      };
    }
    const step = totalAngle.rad / count;

    // The datum-axis form (Phase 39): the copies rotate about the RESOLVED
    // datum axis line. The contract rotates about the world origin only, so
    // each copy composes as translate(axis origin → 0), rotate, translate
    // back — and one `transform` call carries the last two (the contract's
    // fixed order: rotation, then translation).
    if (datumAxisForm) {
      const datumRef = datumRefs[0];
      if (datumRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${kind}" has a malformed input list.`,
          ),
        };
      }
      const resolved = resolveDatumInput(
        feature,
        datumRef,
        readers.document,
        readers.datumTopology,
        "the pattern axis",
      );
      if (!resolved.ok) return { ok: false, diagnostic: resolved.diagnostic };
      if (resolved.datumType !== "axis" || resolved.axis === undefined) {
        return datumKindMismatch(
          feature,
          datumRef,
          `Feature "${feature.id}" of kind "${kind}" needs a datum AXIS as its pattern axis; the referenced datum defines ${resolved.datumType === "plane" ? "a plane" : resolved.datumType === "point" ? "a point" : "a coordinate system"}.`,
        );
      }
      const axisOrigin = resolved.axis.origin;
      const axisDirection = resolved.axis.direction;
      for (let i = 1; i < count; i += 1) {
        const centered = kernel.transform(target.solid, {
          x: lengthValue(-axisOrigin[0]),
          y: lengthValue(-axisOrigin[1]),
          z: lengthValue(-axisOrigin[2]),
        });
        if (!centered.ok) {
          return operationFailure(
            feature,
            centered.error.code,
            centered.error.message,
          );
        }
        const placed = kernel.transform(centered.value, {
          x: lengthValue(axisOrigin[0]),
          y: lengthValue(axisOrigin[1]),
          z: lengthValue(axisOrigin[2]),
          rotation: { axis: axisDirection, angle: angleValue(i * step, "rad") },
        });
        if (!placed.ok) {
          return operationFailure(
            feature,
            placed.error.code,
            placed.error.message,
          );
        }
        copies.push(placed.value);
      }
    } else {
      if (thirdRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${kind}" needs an axis parameter input.`,
          ),
        };
      }
      const axisValue = readers.dimensionlessParameter(thirdRef, "axis");
      if (!axisValue.ok) return { ok: false, diagnostic: axisValue.diagnostic };
      if (
        !Number.isInteger(axisValue.value) ||
        axisValue.value < 1 ||
        axisValue.value > 3
      ) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelParameterInvalid,
            `Feature "${feature.id}" of kind "${kind}" needs parameter "${thirdRef.id}" (axis) to select a world axis: 1 = X, 2 = Y, 3 = Z (${axisValue.value} given).`,
            [thirdRef],
          ),
        };
      }
      const axis: readonly [number, number, number] =
        axisValue.value === 1
          ? [1, 0, 0]
          : axisValue.value === 2
            ? [0, 1, 0]
            : [0, 0, 1];
      for (let i = 1; i < count; i += 1) {
        const placed = kernel.transform(target.solid, {
          x: lengthValue(0),
          y: lengthValue(0),
          z: lengthValue(0),
          rotation: { axis, angle: angleValue(i * step, "rad") },
        });
        if (!placed.ok) {
          return operationFailure(
            feature,
            placed.error.code,
            placed.error.message,
          );
        }
        copies.push(placed.value);
      }
    }
  }
  const merged = kernel.union(copies);
  return merged.ok
    ? { ok: true, solid: merged.value }
    : operationFailure(feature, merged.error.code, merged.error.message);
}

// ---------------------------------------------------------------------------
// Phase 43: pattern & mirror completion — the feature-level pattern kinds
// ---------------------------------------------------------------------------

/**
 * One array leg of the Phase 43 feature patterns: a direction angle
 * (radians, counter-clockwise in the world XY plane from +x — the
 * `patternLinear` direction precedent), a copy count, and the spacing
 * between neighbouring copies along that direction (mm). ASYMMETRIC
 * arrays carry one leg per direction, each with its own count and
 * spacing — the roadmap's direction + count pairs.
 */
export interface ArrayPatternLeg {
  readonly directionRad: number;
  readonly count: number;
  readonly spacingMm: number;
}

/** The array planner's outcome: the instance offsets in ordinal order. */
export interface ArrayPatternPlan {
  /**
   * The world translation of every instance, `offsets[ordinal]`, the
   * ordinal numbered over the legs' cross product odometer-style with the
   * FIRST leg most significant (leg 1 picks the row, leg 2 the column
   * within it, and so on — the documented enumeration).
   */
  readonly offsets: readonly (readonly [number, number, number])[];
  /** The total instance count: the product of the legs' counts. */
  readonly total: number;
}

/**
 * Plans the instance offsets of an array pattern (Phase 43): a PURE
 * function shared verbatim by the executor bridge and the workbench's
 * worker scene (the `planHoleCut`/`planSplitCut` one-source-of-truth
 * precedent) — the same offsets, in the same order, on every route.
 * Leg counts and spacings arrive pre-validated (the bridge's own battery
 * declines the invalid input before planning); the planner itself is
 * total.
 */
export function planArrayPatternInstances(
  legs: readonly ArrayPatternLeg[],
): ArrayPatternPlan {
  let total = 1;
  for (const leg of legs) total *= leg.count;
  const offsets: (readonly [number, number, number])[] = [];
  const indices = legs.map(() => 0);
  for (let ordinal = 0; ordinal < total; ordinal += 1) {
    let x = 0;
    let y = 0;
    for (let leg = 0; leg < legs.length; leg += 1) {
      const spec = legs[leg];
      const index = indices[leg] ?? 0;
      if (spec === undefined) continue;
      const reach = index * spec.spacingMm;
      x += reach * Math.cos(spec.directionRad);
      y += reach * Math.sin(spec.directionRad);
    }
    offsets.push([x, y, 0]);
    // The odometer increments from the LAST leg (the fastest-varying
    // index), rolling into the earlier legs on overflow.
    for (let leg = legs.length - 1; leg >= 0; leg -= 1) {
      const spec = legs[leg];
      const next = (indices[leg] ?? 0) + 1;
      if (spec === undefined || next < spec.count) {
        indices[leg] = next;
        break;
      }
      indices[leg] = 0;
    }
  }
  return { offsets, total };
}

/** Reads and validates one leg triple of the feature-pattern kinds. */
function readArrayLeg(
  feature: FeatureRecord,
  readers: InputReaders,
  refs: readonly FeatureInputRef[],
  legIndex: number,
):
  | {
      readonly ok: true;
      readonly leg: ArrayPatternLeg;
    }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  const directionRef = refs[0];
  const countRef = refs[1];
  const spacingRef = refs[2];
  if (
    directionRef === undefined ||
    countRef === undefined ||
    spacingRef === undefined
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" has a malformed leg ${String(legIndex)} (a leg is three parameters: direction, count, spacing).`,
      ),
    };
  }
  const direction = readers.angleParameter(directionRef, "direction");
  if (!direction.ok) return { ok: false, diagnostic: direction.diagnostic };
  const spacing = readers.lengthParameter(spacingRef, "spacing");
  if (!spacing.ok) return { ok: false, diagnostic: spacing.diagnostic };
  if (!(spacing.mm > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs a strictly positive spacing on leg ${String(legIndex)} (${spacing.mm} mm given) — zero or negative spacing stacks the copies and the leg degenerates.`,
        [spacingRef],
      ),
    };
  }
  const countValue = readers.dimensionlessParameter(countRef, "count");
  if (!countValue.ok) return { ok: false, diagnostic: countValue.diagnostic };
  if (!Number.isInteger(countValue.value)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs leg ${String(legIndex)}'s count to be a whole number of copies; ${countValue.value} is not an integer.`,
        [countRef],
      ),
    };
  }
  if (countValue.value < 2) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs leg ${String(legIndex)}'s count to be at least 2 (${countValue.value} given) — a leg of one copy is no leg.`,
        [countRef],
      ),
    };
  }
  return {
    ok: true,
    leg: {
      directionRad: direction.rad,
      count: countValue.value,
      spacingMm: spacing.mm,
    },
  };
}

/**
 * The `patternFeature` executor path (Phase 43) — FEATURE-LEVEL ARRAYS:
 * the roadmap's "repeat a feature — or a feature range — not just a
 * body", composed from the contract's existing ops exactly the Phase
 * 26.8 pattern verdict prescribes (transforms + one union).
 *
 * ## Input layout
 *
 * ONE OR MORE feature/body inputs — the FEATURE RANGE: every instance
 * transforms every member identically and the union at the end covers
 * them all (a rib patterned together with the boss it grew on, one
 * group). Then parameter inputs read in declared order as LEG TRIPLES
 * then SKIP ORDINALS:
 *
 * - Each leg triple is direction (ANGLE), count (DIMENSIONLESS integer
 *   ≥ 2), spacing (LENGTH > 0) — the ASYMMETRIC spacing array, one leg
 *   per direction. Legs parse GREEDILY from the front: while the next
 *   three parameters' dimensions read (angle, dimensionless, length), a
 *   leg consumes them.
 * - Every remaining parameter is a SKIP ORDINAL: a DIMENSIONLESS
 *   integer in `[0, total)` naming an instance whose copies drop out of
 *   the union (instance 0 is the untranslated group). Duplicates and
 *   out-of-range ordinals decline — a skip that silently misses is a
 *   stale authoring artifact, not a pattern.
 *
 * `parameter.set` on any leg number or skip ordinal re-drives the whole
 * arrangement — the bridge re-reads the parameters each regeneration.
 *
 * ## Failure taxonomy (all structured, before any kernel call)
 *
 * - Layout: no feature/body input, fewer than three parameters, or a
 *   sketch/datum/reference input → `kernel/feature-input-invalid`.
 * - Legs: wrong dimensions anywhere in a triple, count < 2, non-integer
 *   count, spacing ≤ 0, or a trailing parameter that is neither part of
 *   a leg nor a dimensionless skip → `kernel/parameter-invalid` (the
 *   greedy parser's leftover rule).
 * - Total: the legs' product over `PATTERN_COUNT_LIMIT` →
 *   `kernel/parameter-invalid` (the synchronous-regeneration guard).
 * - Skips: non-integer, out of `[0, total)`, duplicated, or skipping
 *   EVERY instance → `kernel/parameter-invalid`.
 * - Kernel failures (a transform or the union rejecting) ride through as
 *   `kernel/operation-failed` with the kernel code in `data`.
 */
function runPatternFeatureOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  const otherRefs = inputs.filter(
    (ref) =>
      ref.kind !== "feature" && ref.kind !== "body" && ref.kind !== "parameter",
  );
  if (targetRefs.length < 1 || parameterRefs.length < 3) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFeature" needs at least one feature/body input (the feature range) and at least three parameter inputs (one leg triple: direction, count, spacing); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  if (otherRefs.length > 0) {
    const offender = otherRefs[0];
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFeature" needs feature/body and parameter inputs only; a ${offender?.kind ?? "unknown"} input cannot be patterned.`,
        offender === undefined ? [] : [offender],
      ),
    };
  }
  // The greedy leg parse: consume (angle, dimensionless, length) triples
  // from the front — the dimensions alone distinguish a leg triple from
  // the trailing skip ordinals (every leg BEGINS with an angle; every
  // skip is a lone dimensionless).
  const legRefs: FeatureInputRef[][] = [];
  let cursor = 0;
  while (cursor + 2 < parameterRefs.length) {
    const direction = readers.parameterValue(
      parameterRefs[cursor] as FeatureInputRef,
    );
    const count = readers.parameterValue(
      parameterRefs[cursor + 1] as FeatureInputRef,
    );
    const spacing = readers.parameterValue(
      parameterRefs[cursor + 2] as FeatureInputRef,
    );
    if (
      direction?.dimension === "angle" &&
      count?.dimension === "dimensionless" &&
      spacing?.dimension === "length"
    ) {
      legRefs.push([
        parameterRefs[cursor] as FeatureInputRef,
        parameterRefs[cursor + 1] as FeatureInputRef,
        parameterRefs[cursor + 2] as FeatureInputRef,
      ]);
      cursor += 3;
    } else {
      break;
    }
  }
  const skipRefs = parameterRefs.slice(cursor);
  if (legRefs.length === 0) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFeature" declares no leg triple: its leading parameters must read direction (an angle), count (dimensionless), spacing (a length) — one triple per array direction.`,
      ),
    };
  }
  const legs: ArrayPatternLeg[] = [];
  for (let index = 0; index < legRefs.length; index += 1) {
    const refs = legRefs[index];
    if (refs === undefined) continue;
    const leg = readArrayLeg(feature, readers, refs, index + 1);
    if (!leg.ok) return leg;
    legs.push(leg.leg);
  }
  let total = 1;
  for (const leg of legs) total *= leg.count;
  if (total > PATTERN_COUNT_LIMIT) {
    const countRef = legRefs[0]?.[1];
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternFeature" needs a total instance count (the legs' product) of at most ${PATTERN_COUNT_LIMIT} (${total} given) — regeneration issues one kernel transform per copy synchronously; compose nested patterns for larger arrays.`,
        countRef === undefined ? [] : [countRef],
      ),
    };
  }
  // The skip ordinals: dimensionless integers in range, no duplicates.
  const skips: number[] = [];
  for (const skipRef of skipRefs) {
    const value = readers.dimensionlessParameter(skipRef, "skip");
    if (!value.ok) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "patternFeature" has a trailing parameter that is neither part of a leg triple nor a valid skip ordinal: ${value.diagnostic.message}`,
          [skipRef],
        ),
      };
    }
    if (
      !Number.isInteger(value.value) ||
      value.value < 0 ||
      value.value >= total
    ) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "patternFeature" needs skip ordinals to be whole instance numbers in [0, ${String(total)}) (${value.value} given) — a skip that addresses no instance is a stale authoring artifact, not a pattern.`,
          [skipRef],
        ),
      };
    }
    if (skips.includes(value.value)) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "patternFeature" skips instance ${value.value} more than once — a duplicate skip is an authoring error, never a quieter pattern.`,
          [skipRef],
        ),
      };
    }
    skips.push(value.value);
  }
  if (skips.length >= total) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternFeature" skips every one of its ${String(total)} instances — nothing would remain to union.`,
        skipRefs.length > 0 && skipRefs[0] !== undefined ? [skipRefs[0]] : [],
      ),
    };
  }
  const targets = readSolids(feature, readers, targetRefs, 1);
  if (!targets.ok) return targets;
  const skipSet = new Set(skips);
  const plan = planArrayPatternInstances(legs);
  const copies: KernelSolid[] = [];
  for (let ordinal = 0; ordinal < plan.total; ordinal += 1) {
    if (skipSet.has(ordinal)) continue;
    const offset = plan.offsets[ordinal];
    if (offset === undefined) continue;
    const zero = offset[0] === 0 && offset[1] === 0 && offset[2] === 0;
    for (const solid of targets.solids) {
      if (zero) {
        copies.push(solid);
        continue;
      }
      const placed = kernel.transform(solid, {
        x: lengthValue(offset[0]),
        y: lengthValue(offset[1]),
        z: lengthValue(offset[2]),
      });
      if (!placed.ok) {
        return operationFailure(
          feature,
          placed.error.code,
          placed.error.message,
        );
      }
      copies.push(placed.value);
    }
  }
  const merged = kernel.union(copies);
  return merged.ok
    ? { ok: true, solid: merged.value }
    : operationFailure(feature, merged.error.code, merged.error.message);
}

/** The path-pattern orientation options (the DIMENSIONLESS parameter's domain). */
const PATTERN_PATH_ORIENTATION = { fixed: 1, tangentFollow: 2 } as const;

/**
 * The `patternPath` executor path (Phase 43) — instances distributed
 * along a sketch path, the Phase 36/38 path machinery's arc-length walk:
 * `./path-geometry` stations the chain, the composition translates (and
 * for tangent-follow, rotates) the target to each station.
 *
 * ## Input layout
 *
 * ONE feature/body input (the solid to repeat), ONE sketch input (the
 * path, resolved through the executor context's `paths` seam — the
 * sweep's resolver, so the sketch's workplane does not carry: the
 * resolved chain's LOCAL (x, z) plane rides the WORLD XZ plane, local
 * (x, z) → world (x, 0, z) — the identity placement, documented), and
 * exactly THREE parameters: count (DIMENSIONLESS integer ≥ 2), spacing
 * (LENGTH > 0, the arc-length step), orientation (DIMENSIONLESS: 1 =
 * fixed, 2 = tangent-follow).
 *
 * ## Semantics
 *
 * Instance i sits at arc length `i·spacing`, `i = 0` the untranslated
 * target. Fixed orientation translates only. Tangent-follow composes
 * the rotation carrying world +z (the path's initial tangent, the
 * perpendicular-attachment rule) onto the station's tangent — the
 * contract's fixed order (rotation about the world origin, then the
 * translation), the placement-composition precedent — and is gated on
 * `transformRotation` BEFORE any call (the circular pattern's gate: a
 * kernel that may ignore a rotation would silently stack every copy).
 * Every station must lie on the chain: `i·spacing` past the path's end
 * declines.
 *
 * ## Failure taxonomy
 *
 * - Layout: not exactly one target, one sketch, three parameters →
 *   `kernel/feature-input-invalid`.
 * - Count: wrong dimension, non-integer, < 2, > `PATTERN_COUNT_LIMIT` →
 *   `kernel/parameter-invalid`.
 * - Spacing: wrong dimension or ≤ 0 → `kernel/parameter-invalid`.
 * - Orientation: wrong dimension or not 1/2 → `kernel/parameter-invalid`.
 * - Path: an unresolvable sketch or a structurally invalid chain → the
 *   resolver/battery's own code in `data.pathCode`.
 * - Stations: `i·spacing` beyond the chain's total length →
 *   `kernel/parameter-invalid`.
 * - Rotation capability (tangent-follow): a kernel without
 *   `transformRotation` → `kernel/feature-input-invalid`.
 * - Kernel failures ride through as `kernel/operation-failed`.
 */
function runPatternPathOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const sketchRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "sketch" } =>
      ref.kind === "sketch",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  if (
    targetRefs.length !== 1 ||
    sketchRefs.length !== 1 ||
    parameterRefs.length !== 3
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternPath" needs exactly one feature/body input (the solid to repeat), one sketch input (the path), and three parameter inputs (count, spacing, orientation); it declares ${targetRefs.length} target(s), ${sketchRefs.length} sketch input(s), and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  const targetRef = targetRefs[0];
  const sketchRef = sketchRefs[0];
  const countRef = parameterRefs[0];
  const spacingRef = parameterRefs[1];
  const orientationRef = parameterRefs[2];
  if (
    targetRef === undefined ||
    sketchRef === undefined ||
    countRef === undefined ||
    spacingRef === undefined ||
    orientationRef === undefined
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternPath" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;
  const countValue = readers.dimensionlessParameter(countRef, "count");
  if (!countValue.ok) return { ok: false, diagnostic: countValue.diagnostic };
  if (!Number.isInteger(countValue.value) || countValue.value < 2) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternPath" needs a whole-number count of at least 2 (${countValue.value} given) — a pattern of one copy is no pattern.`,
        [countRef],
      ),
    };
  }
  if (countValue.value > PATTERN_COUNT_LIMIT) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternPath" needs a count of at most ${PATTERN_COUNT_LIMIT} (${countValue.value} given) — regeneration issues one kernel transform per copy synchronously.`,
        [countRef],
      ),
    };
  }
  const spacing = readers.lengthParameter(spacingRef, "spacing");
  if (!spacing.ok) return { ok: false, diagnostic: spacing.diagnostic };
  if (!(spacing.mm > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternPath" needs a strictly positive spacing (${spacing.mm} mm given) — zero or negative spacing stacks the copies on the path's start.`,
        [spacingRef],
      ),
    };
  }
  const orientation = readers.dimensionlessParameter(
    orientationRef,
    "orientation",
  );
  if (!orientation.ok) return { ok: false, diagnostic: orientation.diagnostic };
  const tangentFollow =
    orientation.value === PATTERN_PATH_ORIENTATION.tangentFollow;
  if (!tangentFollow && orientation.value !== PATTERN_PATH_ORIENTATION.fixed) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternPath" needs parameter "${orientationRef.id}" (orientation) to select 1 = fixed or 2 = tangent-follow (${orientation.value} given).`,
        [orientationRef],
      ),
    };
  }
  const resolvedPath = readers.resolvePath(sketchRef);
  if (!resolvedPath.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "patternPath" could not resolve its path sketch "${sketchRef.id}": ${resolvedPath.error.message}`,
        location: { primary: feature.id, related: [sketchRef.id] },
        data: { pathCode: resolvedPath.error.code },
      },
    };
  }
  const path = resolvedPath.value.path;
  const structural = sweepPathProblem(path);
  if (structural !== null) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "patternPath" has an invalid path: ${structural}.`,
        location: { primary: feature.id, related: [sketchRef.id] },
        data: { pathCode: "kernel/invalid-path" },
      },
    };
  }
  const totalLength = sweepPathTotalLength(path);
  const lastStation = (countValue.value - 1) * spacing.mm;
  if (lastStation > totalLength + 1e-9) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternPath" runs past its path: the last instance stands at ${lastStation.toFixed(6)} mm of arc length but the chain spans only ${totalLength.toFixed(6)} mm — lower the count or the spacing.`,
        [countRef, spacingRef],
      ),
    };
  }
  if (tangentFollow && !kernel.capabilities.transformRotation) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternPath" needs tangent-following orientations, but this kernel ("${kernel.id}") does not declare the transformRotation capability — the contract allows such a kernel to ignore a rotation, which would silently stack every copy, so the pattern refuses to run rather than build that wrong answer.`,
      ),
    };
  }
  const copies: KernelSolid[] = [target.solid];
  for (let i = 1; i < countValue.value; i += 1) {
    const station = sweepPathStationAt(path, i * spacing.mm);
    const translation: DatumVec3 = [station.point[0], 0, station.point[1]];
    const placed = tangentFollow
      ? kernel.transform(target.solid, {
          x: lengthValue(translation[0]),
          y: lengthValue(translation[1]),
          z: lengthValue(translation[2]),
          rotation: (() => {
            const turn = rotationFromTo(
              [0, 0, 1],
              [station.tangent[0], 0, station.tangent[1]],
              [1, 0, 0],
            );
            return {
              axis: [turn.axis[0], turn.axis[1], turn.axis[2]],
              angle: angleValue(turn.angle, "rad"),
            };
          })(),
        })
      : kernel.transform(target.solid, {
          x: lengthValue(translation[0]),
          y: lengthValue(translation[1]),
          z: lengthValue(translation[2]),
        });
    if (!placed.ok) {
      return operationFailure(feature, placed.error.code, placed.error.message);
    }
    copies.push(placed.value);
  }
  const merged = kernel.union(copies);
  return merged.ok
    ? { ok: true, solid: merged.value }
    : operationFailure(feature, merged.error.code, merged.error.message);
}

/**
 * How far a tessellation vertex may sit off the referenced face's plane
 * and still belong to the plane's coplanar region (mm): planar faces
 * tessellate exactly ON their plane (the vertices are the BREP's own),
 * so a micrometre bounds honest coplanarity with orders of margin while
 * excluding every curved face's off-plane sampling.
 */
const PATTERN_FACE_COPLANAR_TOLERANCE_MM = 1e-6;

/** The 2D containment epsilon of the point-in-region test (mm² scale-free). */
const PATTERN_FACE_CONTAINMENT_EPSILON = 1e-9;

/**
 * The `patternFace` executor path (Phase 43) — a RECTANGULAR grid within
 * a face boundary: one solid repeated at the grid points that fall
 * inside the referenced face, the roadmap's pattern-on-face.
 *
 * ## Input layout
 *
 * ONE feature/body input (the solid to repeat — the face belongs to its
 * own output body, the fillet battery's same-body discipline), ONE
 * REFERENCE input (a FACE reference, resolved through the exact
 * fillet/shell battery: parse, same-body check, re-resolve against the
 * current topology, valid/repaired), and SIX parameters — TWO leg
 * triples (direction + count + spacing each): the grid lives in the
 * face's resolved plane, directions measured counter-clockwise from the
 * plane's xAxis, the grid origin at the plane's origin.
 *
 * ## The boundary test (the synthetic-face discipline, documented)
 *
 * The face's plane resolves through the executor context's datum seam
 * (`facePlane` — a curved face declines there, the seam's own verdict).
 * The boundary is the target's TESSELLATION filtered to that plane —
 * every triangle whose three vertices sit on it — projected into the
 * plane's (xAxis, normal×xAxis) frame; a grid point qualifies exactly
 * when it lies inside some triangle of that region. This is the
 * synthetic-face machinery's tessellation-derived-boundary honesty
 * (`groupSyntheticFaces` discipline): planar faces measure exactly; the
 * boundary is the plane's full coplanar material, which for a prismatic
 * solid's face is exactly the referenced face.
 *
 * Grid points OUTSIDE the boundary drop out by design — the clipping is
 * the feature — and a grid where fewer than two points qualify declines
 * structurally (a pattern of one copy is no pattern; zero copies never
 * unions).
 *
 * ## Failure taxonomy
 *
 * - Layout: not exactly one target, one reference, six parameters →
 *   `kernel/feature-input-invalid`.
 * - Legs: the `readArrayLeg` battery verbatim (dimensions, count ≥ 2,
 *   spacing > 0) → `kernel/parameter-invalid`.
 * - Grid size: `count₁·count₂` over `PATTERN_COUNT_LIMIT` →
 *   `kernel/parameter-invalid`.
 * - Reference: the fillet battery's structured failures (unknown record,
 *   unparseable payload, wrong kind, cross-body, stale validity) →
 *   `kernel/feature-input-invalid` with the reference code in `data`.
 * - Topology/datum seams: no topology view, or no datum seam →
 *   `kernel/feature-input-invalid` (the resolution seams the feature
 *   needs).
 * - Plane: `facePlane`'s structured failure (curved face, vanished face)
 *   → `kernel/feature-input-invalid` with `data.datumCode`.
 * - Region: no tessellated material on the plane, or fewer than two
 *   qualifying grid points → `kernel/operation-failed` with
 *   `data.reason = "patternFace/no-region"` / `"patternFace/no-instance"`.
 * - Kernel failures ride through as `kernel/operation-failed`.
 */
function runPatternFaceOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const referenceRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "reference" } =>
      ref.kind === "reference",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  if (
    targetRefs.length !== 1 ||
    referenceRefs.length !== 1 ||
    parameterRefs.length !== 6
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" needs exactly one feature/body input (the solid to repeat), one reference input (the bounding face), and six parameter inputs (two leg triples: direction, count, spacing each); it declares ${targetRefs.length} target(s), ${referenceRefs.length} reference(s), and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  const targetRef = targetRefs[0];
  const referenceRef = referenceRefs[0];
  if (targetRef === undefined || referenceRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;
  const legOne = readArrayLeg(feature, readers, parameterRefs.slice(0, 3), 1);
  if (!legOne.ok) return legOne;
  const legTwo = readArrayLeg(feature, readers, parameterRefs.slice(3, 6), 2);
  if (!legTwo.ok) return legTwo;
  if (legOne.leg.count * legTwo.leg.count > PATTERN_COUNT_LIMIT) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "patternFace" needs a grid of at most ${PATTERN_COUNT_LIMIT} candidate points (${legOne.leg.count} × ${legTwo.leg.count} given) — regeneration tests every candidate synchronously.`,
        [
          parameterRefs[1] as FeatureInputRef,
          parameterRefs[4] as FeatureInputRef,
        ],
      ),
    };
  }
  // The reference battery (the fillet/shell discipline): the record's
  // payload must parse as a FACE reference addressing the target's own
  // body and resolve against the CURRENT regeneration.
  const record = getDocumentReference(readers.document, referenceRef.id);
  if (record === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" references record "${referenceRef.id}", which the document does not define.`,
        [referenceRef],
      ),
    };
  }
  const parsed = parseTopologyReference(record.reference);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "patternFace" has an unparseable reference record ("${referenceRef.id}"): ${parsed.error.message}`,
        location: { primary: feature.id, related: [referenceRef.id] },
        data: { referenceCode: parsed.error.code },
      },
    };
  }
  if (parsed.value.kind !== "face") {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" needs a FACE reference to bound the grid; reference "${referenceRef.id}" addresses a ${parsed.value.kind}.`,
        [referenceRef],
      ),
    };
  }
  const targetBody = readers.bodyIdOf(targetRef);
  if (targetBody !== undefined && parsed.value.bodyId !== targetBody) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" mixes bodies: reference "${referenceRef.id}" addresses body "${parsed.value.bodyId}", but the pattern target's output body is "${targetBody}".`,
        [referenceRef],
      ),
    };
  }
  const view = readers.topology;
  if (view === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" carries a face reference, but the executor context provides no topology view to resolve it against; the bounding face cannot resolve without one.`,
      ),
    };
  }
  const resolved = resolveDocumentReference(
    readers.document,
    parsed.value,
    view,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "patternFace" could not resolve reference "${referenceRef.id}": ${resolved.error.message}`,
        location: { primary: feature.id, related: [referenceRef.id] },
        data: { referenceCode: resolved.error.code },
      },
    };
  }
  const { state, reason } = resolved.value.validity;
  if (state !== "valid" && state !== "repaired") {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "patternFace" has an unresolved face reference ("${referenceRef.id}"): it stands ${state}${reason === undefined ? "" : ` (${reason})`} against the current regeneration. Re-select the face to mint a fresh reference.`,
        location: { primary: feature.id, related: [referenceRef.id] },
        data: {
          validityState: state,
          ...(reason !== undefined ? { reason } : {}),
        },
      },
    };
  }
  const datumSeam = readers.datumTopology;
  if (datumSeam === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" needs the referenced face's plane, but the executor context provides no datum topology resolver to resolve it through.`,
      ),
    };
  }
  const planeResult = datumSeam.facePlane(record.reference);
  if (!planeResult.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "patternFace" could not resolve the bounding face's plane: ${planeResult.error.message}`,
        location: { primary: feature.id, related: [referenceRef.id] },
        data: { datumCode: planeResult.error.code },
      },
    };
  }
  const plane = planeResult.value;
  // The tessellated region on the plane: the target's tessellation
  // filtered to the triangles whose three vertices sit on it.
  const tessellated = kernel.tessellate(target.solid);
  if (!tessellated.ok) {
    return operationFailure(
      feature,
      tessellated.error.code,
      tessellated.error.message,
    );
  }
  const soup = tessellated.value;
  const xAxis = vecUnit(plane.xAxis);
  const yAxis = xAxis === null ? null : vecUnit(vecCross(plane.normal, xAxis));
  if (xAxis === null || yAxis === null) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "patternFace" resolved a degenerate plane frame (the plane's xAxis does not normalize against its normal); the grid has no in-plane axes to measure from.`,
        [referenceRef],
      ),
    };
  }
  const signedOffset = (p: readonly [number, number, number]): number =>
    (p[0] - plane.origin[0]) * plane.normal[0] +
    (p[1] - plane.origin[1]) * plane.normal[1] +
    (p[2] - plane.origin[2]) * plane.normal[2];
  const vertex = (index: number): readonly [number, number, number] => {
    const p = soup.positions;
    return [p[index * 3] ?? 0, p[index * 3 + 1] ?? 0, p[index * 3 + 2] ?? 0];
  };
  const region: (readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ])[] = [];
  for (let triangle = 0; triangle < soup.indices.length / 3; triangle += 1) {
    const a = vertex(soup.indices[triangle * 3] ?? 0);
    const b = vertex(soup.indices[triangle * 3 + 1] ?? 0);
    const c = vertex(soup.indices[triangle * 3 + 2] ?? 0);
    if (
      Math.abs(signedOffset(a)) > PATTERN_FACE_COPLANAR_TOLERANCE_MM ||
      Math.abs(signedOffset(b)) > PATTERN_FACE_COPLANAR_TOLERANCE_MM ||
      Math.abs(signedOffset(c)) > PATTERN_FACE_COPLANAR_TOLERANCE_MM
    ) {
      continue;
    }
    const project = (
      p: readonly [number, number, number],
    ): readonly [number, number] => [
      (p[0] - plane.origin[0]) * xAxis[0] +
        (p[1] - plane.origin[1]) * xAxis[1] +
        (p[2] - plane.origin[2]) * xAxis[2],
      (p[0] - plane.origin[0]) * yAxis[0] +
        (p[1] - plane.origin[1]) * yAxis[1] +
        (p[2] - plane.origin[2]) * yAxis[2],
    ];
    region.push([project(a), project(b), project(c)]);
  }
  if (region.length === 0) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelOperationFailed,
        message: `Feature "${feature.id}" of kind "patternFace" found no tessellated material on the bounding face's plane — the face's region is empty against the current solid.`,
        location: { primary: feature.id, related: [referenceRef.id] },
        data: { reason: "patternFace/no-region" },
      },
    };
  }
  const inside = (u: number, v: number): boolean => {
    for (const [a, b, c] of region) {
      const abX = b[0] - a[0];
      const abY = b[1] - a[1];
      const acX = c[0] - a[0];
      const acY = c[1] - a[1];
      const apX = u - a[0];
      const apY = v - a[1];
      const area = abX * acY - abY * acX;
      if (Math.abs(area) < 1e-18) continue;
      const w1 = (apX * acY - apY * acX) / area;
      const w2 = (abX * apY - abY * apX) / area;
      if (
        w1 >= -PATTERN_FACE_CONTAINMENT_EPSILON &&
        w2 >= -PATTERN_FACE_CONTAINMENT_EPSILON &&
        w1 + w2 <= 1 + PATTERN_FACE_CONTAINMENT_EPSILON
      ) {
        return true;
      }
    }
    return false;
  };
  const plan = planArrayPatternInstances([legOne.leg, legTwo.leg]);
  const copies: KernelSolid[] = [];
  let qualifying = 0;
  for (let ordinal = 0; ordinal < plan.total; ordinal += 1) {
    const offset = plan.offsets[ordinal];
    if (offset === undefined) continue;
    if (!inside(offset[0], offset[1])) continue;
    qualifying += 1;
    const zero = offset[0] === 0 && offset[1] === 0 && offset[2] === 0;
    if (zero) {
      copies.push(target.solid);
      continue;
    }
    const world: DatumVec3 = [
      offset[0] * xAxis[0] + offset[1] * yAxis[0],
      offset[0] * xAxis[1] + offset[1] * yAxis[1],
      offset[0] * xAxis[2] + offset[1] * yAxis[2],
    ];
    const placed = kernel.transform(target.solid, {
      x: lengthValue(world[0]),
      y: lengthValue(world[1]),
      z: lengthValue(world[2]),
    });
    if (!placed.ok) {
      return operationFailure(feature, placed.error.code, placed.error.message);
    }
    copies.push(placed.value);
  }
  if (qualifying < 2) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelOperationFailed,
        message: `Feature "${feature.id}" of kind "patternFace" placed ${String(qualifying)} grid point(s) inside the bounding face (a pattern needs at least 2) — move the grid's origin onto the face, widen its spacing, or raise its counts.`,
        location: { primary: feature.id, related: [referenceRef.id] },
        data: { reason: "patternFace/no-instance", qualifying },
      },
    };
  }
  const merged = kernel.union(copies);
  return merged.ok
    ? { ok: true, solid: merged.value }
    : operationFailure(feature, merged.error.code, merged.error.message);
}

/**
 * The mirror feature kind's executor path (Phase 26.9; datum-plane
 * generalization Phase 39; merge option Phase 43) — the DIRECT KERNEL CALL
 * the negative determinant forces, plus the datum composition for
 * arbitrary planes. THE COMPAT SHIM: the bridge validates EITHER input
 * form.
 *
 * ## Input layout — the world-axis selector form (compat)
 *
 * ONE feature/body input (the solid to reflect), then exactly TWO
 * parameter inputs:
 *
 * - plane (DIMENSIONLESS integer `1` = YZ plane, normal +x — reflects the
 *   x coordinate; `2` = XZ, normal +y; `3` = XY, normal +z — the
 *   patternCircular axis precedent, dimensionless 1/2/3, carried to plane
 *   selection).
 * - offset (LENGTH, any finite value — the plane's signed position along
 *   its normal; the reflection maps that coordinate `c → 2·offset − c`).
 *
 * `parameter.set` on either parameter re-drives the reflection through
 * regeneration — the bridge re-reads the plane and offset each run.
 *
 * ## Input layout — the datum-plane form (Phase 39; merge option Phase 43)
 *
 * ONE feature/body input (the solid to reflect — a FEATURE or a BODY, the
 * pattern vocabulary), then exactly ONE `datum` input naming a
 * datum-plane record, then at most ONE parameter: the MERGE option
 * (DIMENSIONLESS, `1` = standalone copy — the default when absent, the
 * Phase 39 behavior; `2` = merge, one `union` of the target and its
 * reflection — the symmetric-part route). The datum's RESOLVED plane
 * defines the mirror: an axis-aligned plane rides the direct
 * `kernel.mirror` call at its offset; an oblique plane composes the
 * reflection through rotations (see {@link runDatumPlaneMirror}). Editing
 * the datum record re-drives the feature — the datum is the parameter
 * plane — and `parameter.set` on the merge option re-drives the union.
 *
 * ## Failure taxonomy (all structured, before any kernel call)
 *
 * - Layout: neither exactly one target + two parameters (compat) nor
 *   exactly one target + one datum + at most one parameter (datum form),
 *   or a sketch input in the target's place →
 *   `kernel/feature-input-invalid`.
 * - Plane selector (compat): wrong dimension, non-integer, or outside
 *   `1..3` → `kernel/parameter-invalid`.
 * - Offset (compat): wrong dimension → `kernel/parameter-invalid`.
 * - Merge (datum form): wrong dimension or not `1`/`2` →
 *   `kernel/parameter-invalid`.
 * - Datum resolution (datum form): the structured failures of
 *   {@link resolveDatumInput}, `data.datumCode` carrying the datum layer's
 *   own code.
 * - Capability: a kernel that has not declared `mirror` (and, for the
 *   oblique composition, `transformRotation`) →
 *   `kernel/feature-input-invalid` (the circular pattern's rotation-gate
 *   precedent).
 * - Kernel failures ride through as `kernel/operation-failed` with the
 *   kernel code in `data`.
 */
function runMirrorOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  const datumRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "datum" } =>
      ref.kind === "datum",
  );

  // The datum-plane form: one target + one datum input + an optional MERGE
  // parameter (Phase 43).
  if (datumRefs.length > 0) {
    if (
      targetRefs.length !== 1 ||
      parameterRefs.length > 1 ||
      datumRefs.length !== 1
    ) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "mirror" in datum-plane form needs exactly one feature/body input (the solid to reflect), exactly one datum input (the mirror plane), and at most one parameter input (the merge option); it declares ${targetRefs.length} target(s), ${parameterRefs.length} parameter(s), and ${datumRefs.length} datum input(s).`,
        ),
      };
    }
    const targetRef = targetRefs[0];
    const datumRef = datumRefs[0];
    if (targetRef === undefined || datumRef === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "mirror" has a malformed input list.`,
        ),
      };
    }
    // The merge option (Phase 43): 1 (or absent) keeps the reflection
    // STANDALONE — the Phase 39 behavior; 2 MERGES, one union of the
    // target and its reflection (the symmetric-part route). `union` is a
    // contract op every kernel carries, so merge adds no capability gate.
    let merge = false;
    const mergeRef = parameterRefs[0];
    if (mergeRef !== undefined) {
      const mergeValue = readers.dimensionlessParameter(mergeRef, "merge");
      if (!mergeValue.ok)
        return { ok: false, diagnostic: mergeValue.diagnostic };
      if (mergeValue.value !== 1 && mergeValue.value !== 2) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelParameterInvalid,
            `Feature "${feature.id}" of kind "mirror" needs parameter "${mergeRef.id}" (merge) to select 1 = standalone copy or 2 = merge with the original (${mergeValue.value} given).`,
            [mergeRef],
          ),
        };
      }
      merge = mergeValue.value === 2;
    }
    const target = readers.solidInput(targetRef);
    if (!target.ok) return target;
    const resolved = resolveDatumInput(
      feature,
      datumRef,
      readers.document,
      readers.datumTopology,
      "the mirror plane",
    );
    if (!resolved.ok) return { ok: false, diagnostic: resolved.diagnostic };
    if (resolved.datumType !== "plane" || resolved.plane === undefined) {
      return datumKindMismatch(
        feature,
        datumRef,
        `Feature "${feature.id}" of kind "mirror" needs a datum PLANE as its mirror; the referenced datum defines ${resolved.datumType === "axis" ? "an axis" : resolved.datumType === "point" ? "a point" : "a coordinate system"}.`,
      );
    }
    const mirrored = runDatumPlaneMirror(
      kernel,
      feature,
      target.solid,
      resolved.plane,
    );
    if (!mirrored.ok) return mirrored;
    if (!merge) return mirrored;
    const merged = kernel.union([target.solid, mirrored.solid]);
    return merged.ok
      ? { ok: true, solid: merged.value }
      : operationFailure(feature, merged.error.code, merged.error.message);
  }

  // The world-axis selector form (compat).
  const otherRefs = inputs.filter(
    (ref) =>
      ref.kind !== "feature" && ref.kind !== "body" && ref.kind !== "parameter",
  );
  if (targetRefs.length !== 1 || parameterRefs.length !== 2) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "mirror" needs exactly one feature/body input (the solid to reflect) and exactly two parameter inputs (plane, offset); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  if (otherRefs.length > 0) {
    const offender = otherRefs[0];
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "mirror" needs a feature/body input as its target; a ${offender?.kind ?? "unknown"} input cannot be mirrored.`,
        offender === undefined ? [] : [offender],
      ),
    };
  }
  const targetRef = targetRefs[0];
  const planeRef = parameterRefs[0];
  const offsetRef = parameterRefs[1];
  if (
    targetRef === undefined ||
    planeRef === undefined ||
    offsetRef === undefined
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "mirror" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;

  // The plane selector: dimensionless ride + feature-level integrality and
  // domain, the patternCircular axis discipline verbatim.
  const planeValue = readers.dimensionlessParameter(planeRef, "plane");
  if (!planeValue.ok) return { ok: false, diagnostic: planeValue.diagnostic };
  if (
    !Number.isInteger(planeValue.value) ||
    planeValue.value < 1 ||
    planeValue.value > 3
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "mirror" needs parameter "${planeRef.id}" (plane) to select a world axis plane: 1 = YZ (normal +x), 2 = XZ (normal +y), 3 = XY (normal +z) (${planeValue.value} given).`,
        [planeRef],
      ),
    };
  }
  const axis: MirrorPlaneAxis =
    planeValue.value === 1 ? "x" : planeValue.value === 2 ? "y" : "z";

  // The capability gate: refuse structurally before the kernel can answer,
  // so an unsupported mirror is a feature diagnostic, never a silent
  // approximation (the circular pattern's rotation-gate precedent).
  if (!kernel.capabilities.mirror) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "mirror" needs a reflection, but this kernel ("${kernel.id}") does not declare the mirror capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a half-built arrangement.`,
      ),
    };
  }

  const offset = readers.lengthParameter(offsetRef, "offset");
  if (!offset.ok) return { ok: false, diagnostic: offset.diagnostic };
  const result = kernel.mirror(target.solid, {
    axis,
    offset: lengthValue(offset.mm),
  });
  return result.ok
    ? { ok: true, solid: result.value }
    : operationFailure(feature, result.error.code, result.error.message);
}

/**
 * The hole feature kind's executor path (Phase 26.10) — FEATURE-LEVEL
 * COMPOSITION, not a kernel operation (see the module doc's hole design
 * decision): one target solid, one planned extruded-circle tool, one
 * subtract, one measured post-condition.
 *
 * ## Input layout (roles off the refs' kinds; parameter roles in declared
 * order)
 *
 * ONE feature/body input (the target solid), then exactly FIVE parameter
 * inputs: diameter, depth, positionX, positionY (LENGTH), axis
 * (DIMENSIONLESS integer 1 = X, 2 = Y, 3 = Z). The tool geometry is
 * planned by {@link planHoleCut} against the target's MEASURED bounds —
 * the same function the workbench's worker scene composes from — so the
 * through/blind semantic, the in-plane position mapping, and the
 * overshoot-opened cut are one documented source of truth.
 *
 * ## The no-op guard (the shell post-condition precedent)
 *
 * A subtract whose tool misses its target returns the target UNCHANGED on
 * every kernel — the silent-no-op trap: a hole positioned off the body
 * would otherwise "succeed" while removing nothing. The bridge therefore
 * measures the target's volume before the cut and the result's volume
 * after, and refuses any cut that did not strictly remove material (within
 * a float-noise epsilon of the target volume) as a structured
 * `kernel/operation-failed` diagnostic carrying the measured volumes in
 * `data`. The post-condition — not a position-vs-bounds pre-check — is the
 * guard by choice: it is complete (it also catches a tool landing over an
 * existing void or a graze the bounds would admit), it is
 * kernel-agnostic (bounds are only a CONTAINER for boolean results on
 * kernels without the tightBooleanBounds capability), and it matches the
 * Phase 26.7 shell's answer to OCCT's silent degenerate outputs.
 *
 * ## Failure taxonomy (all structured, before or around the composition)
 *
 * - Layout: not exactly one feature/body target or exactly five parameter
 *   inputs, or a sketch input in the target's place →
 *   `kernel/feature-input-invalid`.
 * - Diameter ≤ 0 or depth ≤ 0 → `kernel/parameter-invalid` (feature-level
 *   bounds before any kernel call — the pattern's spacing precedent).
 * - Position: wrong dimension → `kernel/parameter-invalid`; any finite
 *   position is legal input — whether it removes material is the no-op
 *   guard's verdict, not a validation guess.
 * - Axis: wrong dimension, non-integer, or outside 1..3 →
 *   `kernel/parameter-invalid` (the mirror plane discipline verbatim).
 * - No-op: the cut removed no material (the tool missed the target) →
 *   `kernel/operation-failed` with `data.reason = "hole/no-op"` and the
 *   measured target/result volumes in `data`.
 * - Kernel failures (bounds on an empty target, a degenerate tool, a
 *   rejected transform or subtract) ride through as
 *   `kernel/operation-failed` with the kernel code in `data`.
 */
function runHoleOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  // Phase 42: the structured form's first parameter is the DIMENSIONLESS
  // type selector (the flat form's first parameter is the LENGTH diameter)
  // — the dimension is the dispatch, so the two forms never reinterpret
  // each other's layouts.
  const firstParameterRef = parameterRefs[0];
  const firstParameter =
    firstParameterRef === undefined
      ? undefined
      : readers.document.parameters.parameters.find(
          (candidate) => candidate.id === firstParameterRef.id,
        );
  if (
    firstParameterRef !== undefined &&
    firstParameter?.value.dimension === "dimensionless"
  ) {
    return runStructuredHoleOperation(kernel, feature, readers);
  }
  const datumRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "datum" } =>
      ref.kind === "datum",
  );
  const otherRefs = inputs.filter(
    (ref) =>
      ref.kind !== "feature" && ref.kind !== "body" && ref.kind !== "parameter",
  );
  // Phase 39: the axis may ride a DATUM AXIS instead of the dimensionless
  // world-axis selector — one target, the four dimension parameters, and
  // one datum input.
  const datumAxisForm = datumRefs.length === 1 && parameterRefs.length === 4;
  if (
    targetRefs.length !== 1 ||
    parameterRefs.length !== (datumAxisForm ? 4 : 5)
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        datumAxisForm
          ? `Feature "${feature.id}" of kind "hole" in datum-axis form needs exactly one feature/body input (the target solid), four parameter inputs (diameter, depth, positionX, positionY), and one datum input (the axis); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`
          : `Feature "${feature.id}" of kind "hole" needs exactly one feature/body input (the target solid) and exactly five parameter inputs (diameter, depth, positionX, positionY, axis); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  if (datumAxisForm) {
    if (inputs.length !== 6 || otherRefs.length !== datumRefs.length) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "hole" in datum-axis form must carry exactly one target input, four parameter inputs (diameter, depth, positionX, positionY), and one datum input (the axis); it declares ${inputs.length} input(s).`,
        ),
      };
    }
  } else if (otherRefs.length > 0) {
    const offender = otherRefs[0];
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" needs a feature/body input as its target; a ${offender?.kind ?? "unknown"} input cannot be holed.`,
        offender === undefined ? [] : [offender],
      ),
    };
  }
  const targetRef = targetRefs[0];
  const diameterRef = parameterRefs[0];
  const depthRef = parameterRefs[1];
  const xRef = parameterRefs[2];
  const yRef = parameterRefs[3];
  const axisRef = datumAxisForm ? datumRefs[0] : parameterRefs[4];
  if (
    targetRef === undefined ||
    diameterRef === undefined ||
    depthRef === undefined ||
    xRef === undefined ||
    yRef === undefined ||
    axisRef === undefined
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;

  // The authoring dimensions: strictly positive, feature-level before any
  // kernel call (the pattern's spacing discipline).
  const diameter = readers.lengthParameter(diameterRef, "diameter");
  if (!diameter.ok) return { ok: false, diagnostic: diameter.diagnostic };
  if (!(diameter.mm > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "hole" needs a strictly positive diameter (${diameter.mm} mm given) — a non-positive diameter cuts nothing and the hole degenerates.`,
        [diameterRef],
      ),
    };
  }
  const depth = readers.lengthParameter(depthRef, "depth");
  if (!depth.ok) return { ok: false, diagnostic: depth.diagnostic };
  if (!(depth.mm > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "hole" needs a strictly positive depth (${depth.mm} mm given) — a non-positive depth cuts nothing and the hole degenerates.`,
        [depthRef],
      ),
    };
  }
  // The position: lengths, any finite value legal — the no-op guard judges
  // whether the cut actually removed material.
  const positionX = readers.lengthParameter(xRef, "positionX");
  if (!positionX.ok) return { ok: false, diagnostic: positionX.diagnostic };
  const positionY = readers.lengthParameter(yRef, "positionY");
  if (!positionY.ok) return { ok: false, diagnostic: positionY.diagnostic };

  // The target's bounds drive the through/blind decision and the tool
  // placement (planHoleCut / planHoleCutWithAxis: the one tool-geometry
  // source of truth per form).
  const measured = kernel.bounds(target.solid);
  if (!measured.ok) {
    return operationFailure(
      feature,
      measured.error.code,
      measured.error.message,
    );
  }

  // The datum-axis form (Phase 39): the hole runs parallel to the resolved
  // datum direction, entering through the + face along it.
  if (datumAxisForm) {
    const resolvedDatum = resolveDatumInput(
      feature,
      axisRef,
      readers.document,
      readers.datumTopology,
      "the hole axis",
    );
    if (!resolvedDatum.ok) {
      return { ok: false, diagnostic: resolvedDatum.diagnostic };
    }
    if (
      resolvedDatum.datumType !== "axis" ||
      resolvedDatum.axis === undefined
    ) {
      return datumKindMismatch(
        feature,
        axisRef,
        `Feature "${feature.id}" of kind "hole" needs a datum AXIS as its axis; the referenced datum defines ${resolvedDatum.datumType === "plane" ? "a plane" : resolvedDatum.datumType === "point" ? "a point" : "a coordinate system"}.`,
      );
    }
    const plan = planHoleCutWithAxis({
      diameterMm: diameter.mm,
      depthMm: depth.mm,
      positionXMm: positionX.mm,
      positionYMm: positionY.mm,
      axisDirection: resolvedDatum.axis.direction,
      bounds: measured.value,
    });
    return executeHoleCut(kernel, feature, plan, {
      measured: measured.value,
      target: target.solid,
      targetRef,
      positionRefs: [xRef, yRef],
      diameterMm: diameter.mm,
      depthMm: depth.mm,
    });
  }

  // The world-axis selector form (compat).
  const axisValue = readers.dimensionlessParameter(axisRef, "axis");
  if (!axisValue.ok) return { ok: false, diagnostic: axisValue.diagnostic };
  if (
    !Number.isInteger(axisValue.value) ||
    axisValue.value < 1 ||
    axisValue.value > 3
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "hole" needs parameter "${axisRef.id}" (axis) to select a world axis: 1 = X, 2 = Y, 3 = Z (${axisValue.value} given).`,
        [axisRef],
      ),
    };
  }
  const plan = planHoleCut({
    diameterMm: diameter.mm,
    depthMm: depth.mm,
    positionXMm: positionX.mm,
    positionYMm: positionY.mm,
    axis: axisValue.value as HoleAxisSelector,
    bounds: measured.value,
  });
  return executeHoleCut(kernel, feature, plan, {
    measured: measured.value,
    target: target.solid,
    targetRef,
    positionRefs: [xRef, yRef],
    diameterMm: diameter.mm,
    depthMm: depth.mm,
  });
}

/**
 * The hole composition's shared tail (both forms): the planned extruded
 * circle is subtracted from the target and the no-op post-condition guards
 * the silent-miss trap — a cut that removed no material is a structured
 * `kernel/operation-failed` carrying the measured volumes in `data`.
 */
function executeHoleCut(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  plan: HoleCutPlan | HoleAxisCutPlan,
  context: {
    readonly measured: KernelBounds;
    readonly target: KernelSolid;
    readonly targetRef: FeatureInputRef;
    readonly positionRefs: readonly FeatureInputRef[];
    readonly diameterMm: number;
    readonly depthMm: number;
  },
): OperationOutcome {
  // The tool: a one-segment extruded circle (see HoleCutPlan — the extrude
  // op's own placement carries the axis orientation every kernel
  // implements, so no rotation-gated transform is involved).
  const tool = kernel.extrude({
    loop: [{ kind: "circle", center: [0, 0], radius: plan.toolRadiusMm }],
    height: lengthValue(plan.toolHeightMm),
    direction: 1,
    placement: {
      rotation: {
        axis: plan.toolRotationAxis,
        angle: angleValue(plan.toolRotationAngleRad, "rad"),
      },
      translation: {
        x: lengthValue(plan.toolTranslationMm[0]),
        y: lengthValue(plan.toolTranslationMm[1]),
        z: lengthValue(plan.toolTranslationMm[2]),
      },
    },
  });
  if (!tool.ok) {
    return operationFailure(feature, tool.error.code, tool.error.message);
  }

  // The no-op guard's before-side: the target's volume, measured through
  // the same kernel the cut runs on.
  const targetVolume = kernel.volume(context.target);
  if (!targetVolume.ok) {
    return operationFailure(
      feature,
      targetVolume.error.code,
      targetVolume.error.message,
    );
  }
  const cut = kernel.subtract(context.target, [tool.value]);
  if (!cut.ok) {
    return operationFailure(feature, cut.error.code, cut.error.message);
  }
  const resultVolume = kernel.volume(cut.value);
  if (!resultVolume.ok) {
    return operationFailure(
      feature,
      resultVolume.error.code,
      resultVolume.error.message,
    );
  }
  const epsilon = Math.max(1e-9, Math.abs(targetVolume.value) * 1e-9);
  if (resultVolume.value >= targetVolume.value - epsilon) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelOperationFailed,
        message: `Feature "${feature.id}" of kind "hole" removed no material: the ${plan.through ? "through" : "blind"} hole (Ø${context.diameterMm} × ${context.depthMm} mm) misses its target (bounds [${context.measured.min.join(", ")}] → [${context.measured.max.join(", ")}]). Move holeX/holeY onto the target or grow the diameter — the subtract would otherwise silently return the target unchanged.`,
        location: {
          primary: feature.id,
          related: [
            context.targetRef.id,
            ...context.positionRefs.map((ref) => ref.id),
          ],
        },
        data: {
          reason: "hole/no-op",
          holeThrough: plan.through,
          targetVolumeMm3: targetVolume.value,
          resultVolumeMm3: resultVolume.value,
        },
      },
    };
  }
  return { ok: true, solid: cut.value };
}

/**
 * The structured hole form's executor path (Phase 42) — the type-directed
 * sibling of the flat five-parameter form above, composed from the SAME
 * contract ops every kernel implements: one `revolve` per position (the
 * planned meridian tool, `planStructuredHoleCut` — the ONE tool-geometry
 * source, shared with the worker scene), one `helixSweep` per position for
 * the threaded type (Phase 40's ISO ridge, gated on the `helix`
 * capability), one `subtract` of every tool, and the same measured
 * post-condition: a cut that removed nothing refuses.
 *
 * ## Input layout (the type-directed parameter schema)
 *
 * ONE feature/body input (the target), at most ONE sketch input (whose
 * point entities are the POSITIONS — one feature, many holes), at most ONE
 * datum input (a datum AXIS the hole runs parallel to), and the
 * type-directed parameter list of {@link structuredHoleRoles} in declared
 * order: `type` first (a DIMENSIONLESS selector — its presence as the first
 * parameter's dimension is what DISPATCHES this form; the flat form's first
 * parameter is a LENGTH diameter), then the type's own dimensions, then
 * `positionX`/`positionY` (absent with a positions sketch) and the world
 * `axis` selector (absent with a datum axis).
 *
 * ## Semantics (the planner's own documented conventions)
 *
 * Depth to the drill tip, through = `depth ≥ extent`, the tip angle's
 * included convention, entry-measured counterbore/countersink, the taper's
 * geometric through verdict, the threaded pilot at the ISO basic minor —
 * every convention lives in `hole-specification.ts`'s module doc, the one
 * source both composition sites share.
 *
 * ## Failure taxonomy (all structured)
 *
 * - Layout: wrong target/sketch/datum counts, or a parameter count that
 *   does not match the type's role list → `kernel/feature-input-invalid`
 *   (the message names the expected roles).
 * - Type selector outside 1–5 → `kernel/parameter-invalid`.
 * - Role dimension mismatches ride the readers' own diagnostics.
 * - The shared structural battery (diameter/depth/angles/domains) and the
 *   target-relative verdicts (tip fit, entry-feature fit) arrive from the
 *   planner as `kernel/parameter-invalid`.
 * - A positions sketch with no points, or past the position ceiling →
 *   `kernel/feature-input-invalid`.
 * - Threaded on a kernel without the `helix` capability →
 *   `kernel/feature-input-invalid` (the mirror/scale gate precedent — the
 *   refusal is a feature diagnostic, never a silently unthreaded hole).
 * - No-op: the composed cut removed no material → `kernel/operation-failed`
 *   with `data.reason = "hole/no-op"` and the measured volumes in `data`
 *   (the flat form's post-condition verbatim — the contract of the
 *   composed cut is unchanged).
 */
function runStructuredHoleOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const sketchRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "sketch" } =>
      ref.kind === "sketch",
  );
  const datumRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "datum" } =>
      ref.kind === "datum",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  const sketchPositions = sketchRefs.length === 1;
  const datumAxisForm = datumRefs.length === 1;
  if (
    targetRefs.length !== 1 ||
    sketchRefs.length > 1 ||
    datumRefs.length > 1 ||
    inputs.length !==
      targetRefs.length +
        sketchRefs.length +
        datumRefs.length +
        parameterRefs.length
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" in structured form needs exactly one feature/body input (the target solid), at most one sketch input (the positions), at most one datum input (the axis), and its type-directed parameter list; it declares ${targetRefs.length} target(s), ${sketchRefs.length} sketch(es), ${datumRefs.length} datum(s), and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  const targetRef = targetRefs[0];
  const sketchRef = sketchRefs[0];
  const datumRef = datumRefs[0];
  const typeRef = parameterRefs[0];
  if (targetRef === undefined || typeRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" has a malformed input list.`,
      ),
    };
  }
  const typeValue = readers.dimensionlessParameter(typeRef, "type");
  if (!typeValue.ok) {
    return { ok: false, diagnostic: typeValue.diagnostic };
  }
  const type = structuredHoleTypeOf(typeValue.value);
  if (type === null) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "hole" needs parameter "${typeRef.id}" (type) to select a hole type: 1 = straight, 2 = counterbore, 3 = countersink, 4 = taper, 5 = threaded (${typeValue.value} given).`,
        [typeRef],
      ),
    };
  }

  // The type-directed role list the layout must match exactly — a parameter
  // edit that changes the type alone mismatches the count and this refusal
  // names the roles the new type needs (type changes re-create the feature,
  // the same reconfiguration every real hole dialog performs).
  const roles = structuredHoleRoles(type, {
    sketchPositions,
    datumAxis: datumAxisForm,
  });
  if (parameterRefs.length !== roles.length) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" of type "${type}" needs exactly ${String(roles.length)} parameter inputs in declared order (${roles.map((role) => role.name).join(", ")}); it declares ${String(parameterRefs.length)}.`,
      ),
    };
  }

  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;

  // The roles in order: read each by its declared kind.
  const values: Record<string, number> = {};
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    const ref = parameterRefs[index];
    if (role === undefined || ref === undefined) continue;
    if (role.kind === "length") {
      const outcome = readers.lengthParameter(ref, role.name);
      if (!outcome.ok) return { ok: false, diagnostic: outcome.diagnostic };
      values[role.name] = outcome.mm;
    } else if (role.kind === "angle") {
      const outcome = readers.angleParameter(ref, role.name);
      if (!outcome.ok) return { ok: false, diagnostic: outcome.diagnostic };
      // The planner's documented authoring unit is degrees.
      values[role.name] = (outcome.rad * 180) / Math.PI;
    } else {
      const outcome = readers.dimensionlessParameter(ref, role.name);
      if (!outcome.ok) return { ok: false, diagnostic: outcome.diagnostic };
      values[role.name] = outcome.value;
    }
  }
  const spec: StructuredHoleSpec = {
    type: values.type ?? typeValue.value,
    diameterMm: values.diameter ?? 0,
    depthMm: values.depth ?? 0,
    tipAngleDeg: values.tipAngle ?? 180,
    cboreDiameterMm: values.cboreDiameter ?? 0,
    cboreDepthMm: values.cboreDepth ?? 0,
    csinkDiameterMm: values.csinkDiameter ?? 0,
    csinkAngleDeg: values.csinkAngle ?? 0,
    taperAngleDeg: values.taperAngle ?? 0,
    threadMajorMm: values.threadMajor ?? 0,
    threadPitchMm: values.threadPitch ?? 0,
  };

  // The axis: the datum form resolves the datum axis (Phase 39's machinery,
  // the flat form's twin); the world form reads the selector. The in-plane
  // position basis rides each form's own documented convention: the world
  // form's the two world axes in order skipping the hole axis; the datum
  // form's the rotated frame's local axes (whose +y the hole axis is).
  let axisDirection: readonly [number, number, number];
  let inPlaneU: readonly [number, number, number];
  let inPlaneV: readonly [number, number, number];
  let axisRefs: readonly FeatureInputRef[] = [];
  if (datumAxisForm) {
    if (datumRef === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "hole" has a malformed datum input.`,
        ),
      };
    }
    const resolvedDatum = resolveDatumInput(
      feature,
      datumRef,
      readers.document,
      readers.datumTopology,
      "the hole axis",
    );
    if (!resolvedDatum.ok) {
      return { ok: false, diagnostic: resolvedDatum.diagnostic };
    }
    if (
      resolvedDatum.datumType !== "axis" ||
      resolvedDatum.axis === undefined
    ) {
      return datumKindMismatch(
        feature,
        datumRef,
        `Feature "${feature.id}" of kind "hole" needs a datum AXIS as its axis; the referenced datum defines ${resolvedDatum.datumType === "plane" ? "a plane" : resolvedDatum.datumType === "point" ? "a point" : "a coordinate system"}.`,
      );
    }
    axisDirection = resolvedDatum.axis.direction;
    const basis = structuredHoleDatumInPlaneAxes(axisDirection);
    inPlaneU = basis.u;
    inPlaneV = basis.v;
    axisRefs = [datumRef];
  } else {
    // The role loop above already read the world-axis selector by name; the
    // ref (the role list's last entry) rides along for diagnostics.
    const axisRef = parameterRefs[roles.length - 1];
    const axisRaw = values.axis;
    if (axisRef === undefined || axisRaw === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "hole" has a malformed input list.`,
        ),
      };
    }
    if (!Number.isInteger(axisRaw) || axisRaw < 1 || axisRaw > 3) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "hole" needs parameter "${axisRef.id}" (axis) to select a world axis: 1 = X, 2 = Y, 3 = Z (${String(axisRaw)} given).`,
          [axisRef],
        ),
      };
    }
    axisDirection =
      axisRaw === 1 ? [1, 0, 0] : axisRaw === 2 ? [0, 1, 0] : [0, 0, 1];
    // The flat world form's in-plane convention: the two world axes in
    // order, skipping the hole axis (planHoleCut's documented mapping) —
    // one shared source with the worker scene.
    const basis = structuredHoleWorldInPlaneAxes(
      axisRaw === 1 ? 1 : axisRaw === 2 ? 2 : 3,
    );
    inPlaneU = basis.u;
    inPlaneV = basis.v;
    axisRefs = [axisRef];
  }

  // The positions: the sketch's point entities (one feature, many holes)
  // or the positionX/positionY parameters — the same in-plane convention.
  let positions: readonly {
    readonly u: number;
    readonly v: number;
  }[];
  let positionRefs: readonly FeatureInputRef[] = [];
  if (sketchPositions) {
    if (sketchRef === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "hole" has a malformed sketch input.`,
        ),
      };
    }
    const resolvedPoints = readers.resolveSketchPoints(sketchRef);
    if (!resolvedPoints.ok) {
      return {
        ok: false,
        diagnostic: {
          severity: "error",
          code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          message: `Feature "${feature.id}" of kind "hole" has an unresolvable positions sketch ("${sketchRef.id}"): ${resolvedPoints.error.message}`,
          location: { primary: feature.id, related: [sketchRef.id] },
          data: { pointsCode: resolvedPoints.error.code },
        },
      };
    }
    positions = resolvedPoints.value.points.map((point) => ({
      u: point.x,
      v: point.y,
    }));
  } else {
    // The role loop above already read positionX/positionY by name; the
    // refs (the role list's trailing pair) ride along for diagnostics.
    const xRef = parameterRefs[roles.length - (datumAxisForm ? 2 : 3)];
    const yRef = parameterRefs[roles.length - (datumAxisForm ? 1 : 2)];
    if (xRef === undefined || yRef === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "hole" has a malformed input list.`,
        ),
      };
    }
    const positionX = values.positionX;
    const positionY = values.positionY;
    if (positionX === undefined || positionY === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "hole" has a malformed input list.`,
        ),
      };
    }
    positions = [{ u: positionX, v: positionY }];
    positionRefs = [xRef, yRef];
  }

  // The capability gate: the threaded type composes Phase 40's ridge sweep,
  // which kernels without the `helix` capability decline structurally — the
  // gate refuses BEFORE any geometry so the unsupported verdict is a
  // feature diagnostic (the mirror/scale precedent).
  if (type === "threaded" && !kernel.capabilities.helix) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" of type "threaded" composes an ISO thread sweep, but this kernel ("${kernel.id}") does not declare the helix capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a silently unthreaded hole. Every other hole type composes revolve + subtract and runs wherever those do.`,
      ),
    };
  }

  const measured = kernel.bounds(target.solid);
  if (!measured.ok) {
    return operationFailure(
      feature,
      measured.error.code,
      measured.error.message,
    );
  }
  const planned = planStructuredHoleCut({
    spec,
    positions,
    axisDirection,
    inPlaneU,
    inPlaneV,
    bounds: measured.value,
  });
  if (!planned.ok) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        planned.problem.code === "kernel/parameter-invalid"
          ? DIAGNOSTIC_CODES.kernelParameterInvalid
          : DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" of type "${type}": ${planned.problem.message}`,
        [...axisRefs, ...positionRefs],
      ),
    };
  }

  // The composed cut: one tool solid per position (plus the threaded
  // type's ridge sweep), ONE subtract, the measured post-condition.
  const tools: KernelSolid[] = [];
  for (const position of planned.plan.positions) {
    const tool = kernel.revolve(position.revolveTool);
    if (!tool.ok) {
      return operationFailure(feature, tool.error.code, tool.error.message);
    }
    tools.push(tool.value);
    if (position.threadTool !== undefined) {
      const thread = kernel.helixSweep(position.threadTool);
      if (!thread.ok) {
        return operationFailure(
          feature,
          thread.error.code,
          thread.error.message,
        );
      }
      tools.push(thread.value);
    }
  }
  const targetVolume = kernel.volume(target.solid);
  if (!targetVolume.ok) {
    return operationFailure(
      feature,
      targetVolume.error.code,
      targetVolume.error.message,
    );
  }
  const cut = kernel.subtract(target.solid, tools);
  if (!cut.ok) {
    return operationFailure(feature, cut.error.code, cut.error.message);
  }
  const resultVolume = kernel.volume(cut.value);
  if (!resultVolume.ok) {
    return operationFailure(
      feature,
      resultVolume.error.code,
      resultVolume.error.message,
    );
  }
  const epsilon = Math.max(1e-9, Math.abs(targetVolume.value) * 1e-9);
  if (resultVolume.value >= targetVolume.value - epsilon) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelOperationFailed,
        message: `Feature "${feature.id}" of kind "hole" of type "${type}" removed no material: the ${planned.plan.through ? "through" : "blind"} hole at ${String(positions.length)} position(s) misses its target (bounds [${measured.value.min.join(", ")}] → [${measured.value.max.join(", ")}]). Move the positions onto the target or grow the diameter — the subtract would otherwise silently return the target unchanged.`,
        location: {
          primary: feature.id,
          related: [targetRef.id, ...positionRefs.map((ref) => ref.id)],
        },
        data: {
          reason: "hole/no-op",
          holeType: type,
          holeThrough: planned.plan.through,
          targetVolumeMm3: targetVolume.value,
          resultVolumeMm3: resultVolume.value,
        },
      },
    };
  }
  return { ok: true, solid: cut.value };
}

/**
 * Canonical comparison tolerance for two profile placements standing for
 * "the same workplane frame" (the loft sections' shared-frame rule): every
 * placement value rides the dimensional model, so equality is a per-field
 * comparison in the canonical units at double-precision noise.
 */
const PLACEMENT_EQUALITY_TOLERANCE = 1e-9;

function placementMatches(
  a: ProfileExtrudeInput["placement"],
  b: ProfileExtrudeInput["placement"],
): boolean {
  const axisA = a.rotation.axis;
  const axisB = b.rotation.axis;
  const sameAxis =
    axisA.length === axisB.length &&
    axisA.every((component, index) => component === (axisB[index] ?? NaN));
  if (
    !sameAxis ||
    Math.abs(
      valueIn(a.rotation.angle, "rad") - valueIn(b.rotation.angle, "rad"),
    ) > PLACEMENT_EQUALITY_TOLERANCE
  ) {
    return false;
  }
  return (
    Math.abs(valueIn(a.translation.x, "mm") - valueIn(b.translation.x, "mm")) <=
      PLACEMENT_EQUALITY_TOLERANCE &&
    Math.abs(valueIn(a.translation.y, "mm") - valueIn(b.translation.y, "mm")) <=
      PLACEMENT_EQUALITY_TOLERANCE &&
    Math.abs(valueIn(a.translation.z, "mm") - valueIn(b.translation.z, "mm")) <=
      PLACEMENT_EQUALITY_TOLERANCE
  );
}

/**
 * The sweep feature kind's executor path (Phase 38) — the DIRECT KERNEL CALL
 * the geometry forces (a sweep is not expressible as the existing ops'
 * composition): two SKETCH inputs, the PROFILE first and the PATH second,
 * one gated call to the contract's `sweep` operation.
 *
 * ## Input layout
 *
 * Exactly two sketch inputs and nothing else — a sweep carries no dimension
 * parameters (the path itself determines the extent, unlike the extrude's
 * distance). The FIRST sketch resolves through the profile seam (loop +
 * workplane placement); the SECOND resolves through the path seam
 * ({@link KernelPathResolver}, the caller-supplied mapping of the sketch's
 * chain onto the local XZ plane — the planar-XZ contract; see the type's
 * documentation for the constraint mapping). Declared order IS the roles:
 * the kind's own diagnostic says so when the layout is wrong.
 *
 * ## The capability gate (the mirror precedent)
 *
 * A kernel that has not declared `sweep` (Manifold: no sweep or loft
 * primitive, probed) would answer the structured
 * `kernel/unsupported-operation`; the bridge gates on the capability flag
 * BEFORE any resolution and refuses as a feature diagnostic, so the
 * unsupported verdict never pretends to be an input failure.
 *
 * ## Failure taxonomy
 *
 * - Layout: not exactly two sketch inputs → `kernel/feature-input-invalid`.
 * - Gate: the kernel does not declare `sweep` →
 *   `kernel/feature-input-invalid`.
 * - Profile resolution: the sketch domain's own failure verbatim, carried
 *   in `data.profileCode` (the extrude precedent).
 * - Path resolution: the resolver's failure verbatim in `data.pathCode`,
 *   or the structured missing-seam refusal when the context has no path
 *   resolver at all.
 * - Kernel failures (path validation: origin attachment, +z initial
 *   tangent, G1 continuity, self-intersection, bend pinching) ride through
 *   as `kernel/operation-failed` with the kernel code in `data`.
 */
function runSweepOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  if (inputs.length !== 2) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "sweep" needs exactly two sketch inputs: the profile sketch and the path sketch (a sweep carries no dimension parameters — the path determines the extent).`,
      ),
    };
  }
  const profileRef = inputs[0];
  const pathRef = inputs[1];
  if (profileRef === undefined || pathRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "sweep" has a malformed input list.`,
      ),
    };
  }
  if (profileRef.kind !== "sketch" || pathRef.kind !== "sketch") {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "sweep" needs two sketch inputs (profile first, path second); a ${profileRef.kind === "sketch" ? "path" : profileRef.kind} input was declared where the ${profileRef.kind === "sketch" ? "path" : "profile"} belongs.`,
        profileRef.kind === "sketch" ? [pathRef] : [profileRef],
      ),
    };
  }
  // The capability gate: refuse structurally before any resolution, the
  // mirror/pattern precedent — an unsupported sweep is a feature diagnostic
  // naming the kernel, never a half-built attempt.
  if (!kernel.capabilities.sweep) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "sweep" needs a swept solid, but this kernel ("${kernel.id}") does not declare the sweep capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a silent approximation.`,
      ),
    };
  }
  const resolvedProfile = readers.resolveProfile(profileRef);
  if (!resolvedProfile.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "sweep" has an unresolvable sketch profile ("${profileRef.id}"): ${resolvedProfile.error.message}`,
        location: { primary: feature.id, related: [profileRef.id] },
        data: { profileCode: resolvedProfile.error.code },
      },
    };
  }
  const resolvedPath = readers.resolvePath(pathRef);
  if (!resolvedPath.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "sweep" has an unresolvable sketch path ("${pathRef.id}"): ${resolvedPath.error.message}`,
        location: { primary: feature.id, related: [pathRef.id] },
        data: { pathCode: resolvedPath.error.code },
      },
    };
  }
  const sweepInput: ProfileSweepInput = {
    loop: resolvedProfile.value.loop,
    path: resolvedPath.value.path,
    placement: resolvedProfile.value.placement,
  };
  const result = kernel.sweep(sweepInput);
  return result.ok
    ? { ok: true, solid: result.value }
    : operationFailure(feature, result.error.code, result.error.message);
}

/**
 * The loft feature kind's executor path (Phase 38) — the sweep's sibling
 * direct kernel call: N SKETCH inputs (the ordered sections) and N LENGTH
 * parameter inputs (each section's station z, in the SAME declared order),
 * one gated call to the contract's `loft` operation.
 *
 * ## Input layout (roles off the refs' kinds, per-role declared order)
 *
 * Every `sketch` input is a section, in declared order (the order IS the
 * loft direction — the contract never re-sorts stations); every `parameter`
 * input is that section's station z (LENGTH, any value — the kernel's
 * strictly-increasing rule judges the collection), matched by position.
 * The counts must agree and be at least two.
 *
 * ## One frame (the placement rule)
 *
 * The contract's `ProfileLoftInput` carries ONE placement; the bridge uses
 * the FIRST section's resolved workplane placement and requires every other
 * section to resolve against the SAME frame (per-field canonical equality
 * at double-precision noise) — a collection of sections on differing
 * workplanes refuses with `kernel/feature-input-invalid` naming the first
 * diverging section, instead of silently flattening them into one frame.
 *
 * ## Failure taxonomy
 *
 * - Layout: fewer than two sections, sketch/parameter count mismatch, or a
 *   non-sketch/non-parameter ref in the list →
 *   `kernel/feature-input-invalid`.
 * - Gate: the kernel does not declare `loft` →
 *   `kernel/feature-input-invalid` (the sweep gate's twin).
 * - Section resolution: the sketch domain's failure verbatim in
   `data.profileCode`, naming the section's 1-based index.
 * - Station dimension: a non-length station → `kernel/parameter-invalid`
 *   (the shared parameter battery).
 * - Frame divergence: a section off the first section's workplane →
 *   `kernel/feature-input-invalid`.
 * - Kernel failures (member validity, vertex-count compatibility, station
 *   ordering) ride through as `kernel/operation-failed` with the kernel
 *   code in `data`.
 */
function runLoftOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const sketchRefs: (FeatureInputRef & { readonly kind: "sketch" })[] = [];
  const parameterRefs: (FeatureInputRef & { readonly kind: "parameter" })[] =
    [];
  for (const ref of inputs) {
    if (ref.kind === "sketch") sketchRefs.push(ref);
    else if (ref.kind === "parameter") parameterRefs.push(ref);
  }
  if (
    sketchRefs.length < 2 ||
    parameterRefs.length !== sketchRefs.length ||
    sketchRefs.length + parameterRefs.length !== inputs.length
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "loft" needs at least two sketch inputs (the ordered sections) and exactly as many length parameter inputs (each section's station z); it declares ${String(sketchRefs.length)} sketch(es) and ${String(parameterRefs.length)} parameter(s) across ${String(inputs.length)} input(s).`,
      ),
    };
  }
  if (!kernel.capabilities.loft) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "loft" needs a lofted solid, but this kernel ("${kernel.id}") does not declare the loft capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a silent approximation.`,
      ),
    };
  }
  const sections: ProfileLoftSectionInput[] = [];
  let placement: ProfileExtrudeInput["placement"] | null = null;
  for (let index = 0; index < sketchRefs.length; index += 1) {
    const sketchRef = sketchRefs[index];
    const stationRef = parameterRefs[index];
    if (sketchRef === undefined || stationRef === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "loft" has a malformed input list at section ${String(index + 1)}.`,
        ),
      };
    }
    const resolvedProfile = readers.resolveProfile(sketchRef);
    if (!resolvedProfile.ok) {
      return {
        ok: false,
        diagnostic: {
          severity: "error",
          code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          message: `Feature "${feature.id}" of kind "loft" has an unresolvable section sketch ("${sketchRef.id}", section ${String(index + 1)}): ${resolvedProfile.error.message}`,
          location: { primary: feature.id, related: [sketchRef.id] },
          data: { profileCode: resolvedProfile.error.code },
        },
      };
    }
    if (placement === null) {
      placement = resolvedProfile.value.placement;
    } else if (!placementMatches(placement, resolvedProfile.value.placement)) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "loft" section ${String(index + 1)} ("${sketchRef.id}") resolves on a different workplane frame than section 1; a loft places ALL sections through ONE frame — re-sketch the sections on a shared workplane.`,
          [sketchRef],
        ),
      };
    }
    const station = readers.lengthParameter(stationRef, "stationZ");
    if (!station.ok) return { ok: false, diagnostic: station.diagnostic };
    sections.push({
      loop: resolvedProfile.value.loop,
      z: lengthValue(station.mm),
    });
  }
  const loftInput: ProfileLoftInput = {
    sections,
    placement: placement ?? {
      rotation: { axis: [0, 0, 1], angle: angleValue(0, "rad") },
      translation: { x: lengthValue(0), y: lengthValue(0), z: lengthValue(0) },
    },
  };
  const result = kernel.loft(loftInput);
  return result.ok
    ? { ok: true, solid: result.value }
    : operationFailure(feature, result.error.code, result.error.message);
}

/**
 * The helix feature kind's executor path (Phase 40) — the sweep's direct
 * kernel call on the ANALYTIC spine: one SKETCH input (the meridian
 * profile), SIX parameter inputs in declared order (radius, pitch, turns,
 * handedness, start angle, taper), and an optional DATUM AXIS input (the
 * spine's axis — Phase 39 reuse).
 *
 * ## Input layout
 *
 * - The sketch resolves through the profile seam for its LOOP only: sketch
 *   `(x, y)` becomes the meridian `(u, v) = (radial, axial)` offset from
 *   the spine's start point — coordinate identity, the sweep's path-mapping
 *   precedent. The sketch's own workplane placement DOES NOT carry (the
 *   helix frame is the spine's, not the drawing's): without a datum the
 *   spine axis is the world +z axis through the world origin; with one it
 *   is the datum's resolved line, the frame built by the deterministic
 *   rotation carrying local +z onto the datum direction.
 * - Parameters, by declared order: radius (LENGTH, strictly positive),
 *   pitch (LENGTH, non-negative — handedness carries direction), turns
 *   (DIMENSIONLESS, strictly positive; fractional legal), handedness
 *   (DIMENSIONLESS, +1 right / −1 left), startAngle (ANGLE, any), taper
 *   (LENGTH, the total signed radius change).
 *
 * ## Failure taxonomy
 *
 * - Layout / parameter kinds → `kernel/feature-input-invalid`.
 * - Gate: a kernel without `helix` → `kernel/feature-input-invalid` naming
 *   the kernel (the sweep gate's twin — never a half-built attempt).
 * - Handedness outside ±1 → `kernel/feature-input-invalid`.
 * - Profile resolution: the sketch domain's failure verbatim in
 *   `data.profileCode`.
 * - Kernel failures (spine degeneracy `kernel/invalid-helix`, profile
 *   validity, axis crossing, the fake kernel's overlap subset) ride
 *   through as `kernel/operation-failed` with the kernel code in `data`.
 */
function runHelixOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const sketchRefs: (FeatureInputRef & { readonly kind: "sketch" })[] = [];
  const datumRefs: (FeatureInputRef & { readonly kind: "datum" })[] = [];
  const parameterRefs: (FeatureInputRef & { readonly kind: "parameter" })[] =
    [];
  for (const ref of inputs) {
    if (ref.kind === "sketch") sketchRefs.push(ref);
    else if (ref.kind === "datum") datumRefs.push(ref);
    else if (ref.kind === "parameter") parameterRefs.push(ref);
  }
  if (
    sketchRefs.length !== 1 ||
    parameterRefs.length !== 6 ||
    datumRefs.length > 1 ||
    sketchRefs.length + parameterRefs.length + datumRefs.length !==
      inputs.length
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "helix" needs exactly one sketch input (the meridian profile) and six parameter inputs (radius, pitch, turns, handedness, start angle, taper), plus at most one datum axis input; it declares ${String(sketchRefs.length)} sketch(es), ${String(parameterRefs.length)} parameter(s), and ${String(datumRefs.length)} datum input(s).`,
      ),
    };
  }
  const sketchRef = sketchRefs[0];
  if (sketchRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "helix" has a malformed input list.`,
      ),
    };
  }
  if (!kernel.capabilities.helix) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "helix" needs a helical sweep, but this kernel ("${kernel.id}") does not declare the helix capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a silent approximation.`,
      ),
    };
  }
  const resolvedProfile = readers.resolveProfile(sketchRef);
  if (!resolvedProfile.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "helix" has an unresolvable meridian profile ("${sketchRef.id}"): ${resolvedProfile.error.message}`,
        location: { primary: feature.id, related: [sketchRef.id] },
        data: { profileCode: resolvedProfile.error.code },
      },
    };
  }
  const [
    radiusRef,
    pitchRef,
    turnsRef,
    handednessRef,
    startAngleRef,
    taperRef,
  ] = parameterRefs;
  if (
    radiusRef === undefined ||
    pitchRef === undefined ||
    turnsRef === undefined ||
    handednessRef === undefined ||
    startAngleRef === undefined ||
    taperRef === undefined
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "helix" has a malformed parameter list.`,
      ),
    };
  }
  const radius = readers.lengthParameter(radiusRef, "radius");
  if (!radius.ok) return { ok: false, diagnostic: radius.diagnostic };
  const pitch = readers.lengthParameter(pitchRef, "pitch");
  if (!pitch.ok) return { ok: false, diagnostic: pitch.diagnostic };
  const turns = readers.dimensionlessParameter(turnsRef, "turns");
  if (!turns.ok) return { ok: false, diagnostic: turns.diagnostic };
  const handedness = readers.dimensionlessParameter(
    handednessRef,
    "handedness",
  );
  if (!handedness.ok) {
    return { ok: false, diagnostic: handedness.diagnostic };
  }
  const startAngle = readers.angleParameter(startAngleRef, "startAngle");
  if (!startAngle.ok) {
    return { ok: false, diagnostic: startAngle.diagnostic };
  }
  const taper = readers.lengthParameter(taperRef, "taper");
  if (!taper.ok) return { ok: false, diagnostic: taper.diagnostic };
  if (handedness.value !== 1 && handedness.value !== -1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "helix" needs its handedness parameter to be +1 (right-handed) or -1 (left-handed); it carries ${String(handedness.value)}.`,
        [handednessRef],
      ),
    };
  }
  // The helix frame: the datum axis when one is declared, else the world
  // +z axis through the origin. The datum form reuses the Phase 39 seam
  // (resolveDatumInput) and the deterministic rotation carrying local +z
  // onto the resolved direction (the planHoleCutWithAxis construction).
  let placement: ProfileExtrudeInput["placement"];
  const datumRef = datumRefs[0];
  if (datumRef === undefined) {
    placement = {
      rotation: { axis: [0, 0, 1], angle: angleValue(0, "rad") },
      translation: { x: lengthValue(0), y: lengthValue(0), z: lengthValue(0) },
    };
  } else {
    const resolvedDatum = resolveDatumInput(
      feature,
      datumRef,
      readers.document,
      readers.datumTopology,
      "the helix axis",
    );
    if (!resolvedDatum.ok) {
      return { ok: false, diagnostic: resolvedDatum.diagnostic };
    }
    if (
      resolvedDatum.datumType !== "axis" ||
      resolvedDatum.axis === undefined
    ) {
      return datumKindMismatch(
        feature,
        datumRef,
        `Feature "${feature.id}" of kind "helix" needs a datum AXIS as its spine axis; the referenced datum defines ${resolvedDatum.datumType === "plane" ? "a plane" : resolvedDatum.datumType === "point" ? "a point" : "a coordinate system"}.`,
      );
    }
    const turn = rotationFromTo(
      [0, 0, 1],
      resolvedDatum.axis.direction,
      [0, 1, 0],
    );
    placement = {
      rotation: {
        axis: [turn.axis[0], turn.axis[1], turn.axis[2]],
        angle: angleValue(turn.angle, "rad"),
      },
      translation: {
        x: lengthValue(resolvedDatum.axis.origin[0]),
        y: lengthValue(resolvedDatum.axis.origin[1]),
        z: lengthValue(resolvedDatum.axis.origin[2]),
      },
    };
  }
  const helixInput: HelixSweepInput = {
    loop: resolvedProfile.value.loop,
    spine: {
      radius: lengthValue(radius.mm),
      pitch: lengthValue(pitch.mm),
      turns: turns.value,
      handedness: handedness.value,
      startAngle: angleValue(startAngle.rad, "rad"),
      taper: lengthValue(taper.mm),
    },
    placement,
  };
  const result = kernel.helixSweep(helixInput);
  return result.ok
    ? { ok: true, solid: result.value }
    : operationFailure(feature, result.error.code, result.error.message);
}

/**
 * The thread feature kind's executor path (Phase 40) — the hole's composed
 * discipline on the helical tool: one FEATURE or BODY input (the target)
 * plus FIVE parameter inputs in declared order (major diameter, pitch,
 * thread length, mode, handedness) plus the axis — a DATUM AXIS input or a
 * DIMENSIONLESS world-axis selector parameter (1 = X, 2 = Y, 3 = Z, the
 * hole/mirror precedent; the revolve form-switch pattern picks the shape).
 *
 * ## Modes (the DIMENSIONLESS mode parameter)
 *
 * - `1` EXTERNAL — cuts the ISO grooves from a rod at the major diameter
 *   (the shop convention: model the nominal, then thread it).
 * - `2` INTERNAL — cuts the ISO ridge-shaped grooves from a hole wall out
 *   to the major diameter (the tap's complement).
 * - `3` COSMETIC — the annotation-driven mode: NO geometry (the target
 *   passes through unchanged; the thread specification rides the feature's
 *   own parameters), so every kernel runs it — no capability gate.
 *
 * ## Semantics
 *
 * The thread enters through the target's + face along the axis (the bounds
 * projection — the hole precedent) and advances exactly `length` (its
 * axial extent; `turns = length / pitch`, fractional final turns honest).
 * The tool is `planThreadCut`'s ONE shared geometry (the bridge and the
 * workbench's worker scene compose the identical cut), swept by the
 * contract's `helixSweep` and subtracted. The hole's post-condition guard
 * applies verbatim: a cut that removed nothing (a tool that misses the
 * target — a major diameter entirely inside a thinner rod) refuses as a
 * structured feature diagnostic, never a silent no-op.
 *
 * ## Failure taxonomy
 *
 * - Layout / parameter kinds → `kernel/feature-input-invalid`.
 * - Dimensions: major diameter, pitch, or length non-positive →
 *   `kernel/parameter-invalid` (the shared battery) — zero pitch, zero
 *   radius, and non-positive length are the roadmap's named declines.
 * - Mode outside 1/2/3 or handedness outside ±1 →
 *   `kernel/feature-input-invalid`.
 * - Gate: real modes on a kernel without `helix` →
 *   `kernel/feature-input-invalid` naming the kernel.
 * - Datum resolution failures ride the datum seam's own codes in
 *   `data.datumCode`; a non-axis datum is the kind mismatch.
 * - The no-op post-condition → `kernel/operation-failed` with the
 *   kernel code in `data` (the diagnostic message names the trap).
 */
function runThreadOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const solidRefs: FeatureInputRef[] = [];
  const datumRefs: (FeatureInputRef & { readonly kind: "datum" })[] = [];
  const parameterRefs: (FeatureInputRef & { readonly kind: "parameter" })[] =
    [];
  for (const ref of inputs) {
    if (
      (ref.kind === "feature" || ref.kind === "body") &&
      solidRefs.length === 0
    ) {
      solidRefs.push(ref);
    } else if (ref.kind === "datum") {
      datumRefs.push(ref);
    } else if (ref.kind === "parameter") {
      parameterRefs.push(ref);
    } else {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "thread" needs one feature or body input (the target), five parameter inputs (major diameter, pitch, length, mode, handedness), and at most one datum axis input; a ${ref.kind} input was declared where the roles do not allow one.`,
          [ref],
        ),
      };
    }
  }
  const axisParameterCount = datumRefs.length === 0 ? 1 : 0;
  if (
    solidRefs.length !== 1 ||
    parameterRefs.length !== 5 + axisParameterCount ||
    datumRefs.length > 1
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thread" needs one target input, five parameter inputs (major diameter, pitch, length, mode, handedness)${datumRefs.length === 0 ? ", and a world-axis selector parameter" : ", and at most one datum axis input"}; it declares ${String(solidRefs.length)} target(s), ${String(parameterRefs.length)} parameter(s), and ${String(datumRefs.length)} datum input(s).`,
      ),
    };
  }
  const solidRef = solidRefs[0];
  if (solidRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thread" has a malformed input list.`,
      ),
    };
  }
  // The five fixed parameters come first in declared order; the axis
  // selector parameter (when present) is the LAST parameter input.
  const [
    diameterRef,
    pitchRef,
    lengthRef,
    modeRef,
    handednessRef,
    selectorRef,
  ] = parameterRefs;
  if (
    diameterRef === undefined ||
    pitchRef === undefined ||
    lengthRef === undefined ||
    modeRef === undefined ||
    handednessRef === undefined ||
    (axisParameterCount === 1 && selectorRef === undefined)
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thread" has a malformed parameter list.`,
      ),
    };
  }
  const diameter = readers.lengthParameter(diameterRef, "majorDiameter");
  if (!diameter.ok) return { ok: false, diagnostic: diameter.diagnostic };
  const pitch = readers.lengthParameter(pitchRef, "pitch");
  if (!pitch.ok) return { ok: false, diagnostic: pitch.diagnostic };
  const threadLength = readers.lengthParameter(lengthRef, "length");
  if (!threadLength.ok) {
    return { ok: false, diagnostic: threadLength.diagnostic };
  }
  const mode = readers.dimensionlessParameter(modeRef, "mode");
  if (!mode.ok) return { ok: false, diagnostic: mode.diagnostic };
  const handedness = readers.dimensionlessParameter(
    handednessRef,
    "handedness",
  );
  if (!handedness.ok) {
    return { ok: false, diagnostic: handedness.diagnostic };
  }
  if (diameter.mm <= 0) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "thread" needs a strictly positive major diameter (got ${String(diameter.mm)} mm).`,
        [diameterRef],
      ),
    };
  }
  if (pitch.mm <= 0) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "thread" needs a strictly positive pitch (got ${String(pitch.mm)} mm) — a zero pitch is not a thread.`,
        [pitchRef],
      ),
    };
  }
  if (threadLength.mm <= 0) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "thread" needs a strictly positive thread length (got ${String(threadLength.mm)} mm).`,
        [lengthRef],
      ),
    };
  }
  if (mode.value !== 1 && mode.value !== 2 && mode.value !== 3) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thread" needs its mode parameter to be 1 (external), 2 (internal), or 3 (cosmetic); it carries ${String(mode.value)}.`,
        [modeRef],
      ),
    };
  }
  if (handedness.value !== 1 && handedness.value !== -1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thread" needs its handedness parameter to be +1 (right-handed) or -1 (left-handed); it carries ${String(handedness.value)}.`,
        [handednessRef],
      ),
    };
  }
  const cosmetic = mode.value === 3;
  // The cosmetic mode runs on EVERY kernel: it is annotation data riding
  // the feature's own parameters — the target passes through unchanged.
  const target = readers.solidInput(solidRef);
  if (!target.ok) return { ok: false, diagnostic: target.diagnostic };
  if (cosmetic) {
    return { ok: true, solid: target.solid };
  }
  if (!kernel.capabilities.helix) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thread" needs a real helical thread cut, but this kernel ("${kernel.id}") does not declare the helix capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a silent approximation. The COSMETIC thread mode (3) runs on every kernel.`,
      ),
    };
  }
  // The axis: the datum's resolved line, or the world-axis selector's
  // axis through the world origin.
  let axisDirection: DatumVec3;
  let axisThrough: DatumVec3;
  if (datumRefs.length === 1) {
    const datumRef = datumRefs[0];
    if (datumRef === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "thread" has a malformed datum input.`,
        ),
      };
    }
    const resolvedDatum = resolveDatumInput(
      feature,
      datumRef,
      readers.document,
      readers.datumTopology,
      "the thread axis",
    );
    if (!resolvedDatum.ok) {
      return { ok: false, diagnostic: resolvedDatum.diagnostic };
    }
    if (
      resolvedDatum.datumType !== "axis" ||
      resolvedDatum.axis === undefined
    ) {
      return datumKindMismatch(
        feature,
        datumRef,
        `Feature "${feature.id}" of kind "thread" needs a datum AXIS as its thread axis; the referenced datum defines ${resolvedDatum.datumType === "plane" ? "a plane" : resolvedDatum.datumType === "point" ? "a point" : "a coordinate system"}.`,
      );
    }
    axisDirection = resolvedDatum.axis.direction;
    axisThrough = resolvedDatum.axis.origin;
  } else {
    if (selectorRef === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "thread" has a malformed axis selector parameter.`,
        ),
      };
    }
    const selector = readers.dimensionlessParameter(selectorRef, "axis");
    if (!selector.ok) {
      return { ok: false, diagnostic: selector.diagnostic };
    }
    if (selector.value !== 1 && selector.value !== 2 && selector.value !== 3) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "thread" needs its axis selector parameter to be 1 (X), 2 (Y), or 3 (Z); it carries ${String(selector.value)}.`,
          [selectorRef],
        ),
      };
    }
    axisDirection =
      selector.value === 1
        ? [1, 0, 0]
        : selector.value === 2
          ? [0, 1, 0]
          : [0, 0, 1];
    axisThrough = [0, 0, 0];
  }
  // Entry face: the target's bounds project onto the axis; the thread
  // enters through the + face and advances IN (the hole precedent).
  const bounds = kernel.bounds(target.solid);
  if (!bounds.ok) {
    return operationFailure(feature, bounds.error.code, bounds.error.message);
  }
  const entry = extremeBoundsProjection(bounds.value, axisDirection, true);
  const advance: DatumVec3 = [
    -axisDirection[0],
    -axisDirection[1],
    -axisDirection[2],
  ];
  const axisBase: DatumVec3 = [
    axisThrough[0] + entry * axisDirection[0],
    axisThrough[1] + entry * axisDirection[1],
    axisThrough[2] + entry * axisDirection[2],
  ];
  const plan = planThreadCut({
    majorDiameterMm: diameter.mm,
    pitchMm: pitch.mm,
    lengthMm: threadLength.mm,
    mode: mode.value === 1 ? "external" : "internal",
    handedness: handedness.value,
    startAngleRad: 0,
    advanceDirection: advance,
    axisBaseMm: axisBase,
  });
  const tool = kernel.helixSweep(plan.tool);
  if (!tool.ok) {
    return operationFailure(feature, tool.error.code, tool.error.message);
  }
  const cut = kernel.subtract(target.solid, [tool.value]);
  if (!cut.ok) {
    return operationFailure(feature, cut.error.code, cut.error.message);
  }
  // The hole's no-op post-condition: a cut that removed nothing is the
  // silent-miss trap — measure both sides and refuse.
  const before = kernel.volume(target.solid);
  const after = kernel.volume(cut.value);
  if (!before.ok) {
    return operationFailure(feature, before.error.code, before.error.message);
  }
  if (!after.ok) {
    return operationFailure(feature, after.error.code, after.error.message);
  }
  if (after.value >= before.value) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelOperationFailed,
        `Feature "${feature.id}" of kind "thread" cut nothing: the thread tool (major diameter ${String(diameter.mm)} mm) misses the target solid — the volume is unchanged. Check the thread's major diameter against the target's size, or its axis against the target's position.`,
      ),
    };
  }
  return { ok: true, solid: cut.value };
}

/**
 * The rib feature kind's executor path (Phase 41) — FEATURE-LEVEL
 * COMPOSITION (the hole/pattern design decision): the picked sketch's
 * closed cross-section extrudes by HALF the thickness on each side of its
 * own workplane (the symmetric footing CAD ribbing pins), and the pair
 * unions with the target.
 *
 * ## Input layout
 *
 * ONE feature/body input (the target the rib grows from), ONE sketch
 * input (the rib's closed cross-section, resolved through the extrude
 * profile seam — its workplane IS the rib's plane of symmetry), and ONE
 * LENGTH parameter (the thickness, strictly positive).
 *
 * ## The no-op guard (the hole precedent, inverted)
 *
 * A union whose added solid lies entirely inside the target returns the
 * target UNCHANGED on every kernel — a rib that merges with nothing
 * would "succeed" while adding nothing. The bridge measures the volumes
 * on both sides and refuses a union that did not strictly add material,
 * with `data.reason = "rib/no-op"` and the measured volumes in `data`.
 *
 * ## Failure taxonomy (all structured)
 *
 * - Layout: not exactly one target, one sketch, one parameter →
 *   `kernel/feature-input-invalid`.
 * - Thickness ≤ 0 → `kernel/parameter-invalid` before any kernel call.
 * - Profile resolution failures carry the sketch domain's own code in
 *   `data.profileCode` (the extrude precedent).
 * - Kernel failures ride through as `kernel/operation-failed`.
 */
function runRibOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const sketchRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "sketch" } =>
      ref.kind === "sketch",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  if (
    targetRefs.length !== 1 ||
    sketchRefs.length !== 1 ||
    parameterRefs.length !== 1
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "rib" needs exactly one feature/body input (the target), one sketch input (the rib's cross-section), and one parameter input (the thickness); it declares ${targetRefs.length} target(s), ${sketchRefs.length} sketch(es), and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  const targetRef = targetRefs[0];
  const sketchRef = sketchRefs[0];
  const thicknessRef = parameterRefs[0];
  if (
    targetRef === undefined ||
    sketchRef === undefined ||
    thicknessRef === undefined
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "rib" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;
  const resolvedProfile = readers.resolveProfile(sketchRef);
  if (!resolvedProfile.ok) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `Feature "${feature.id}" of kind "rib" has an unresolvable sketch profile ("${sketchRef.id}"): ${resolvedProfile.error.message}`,
        location: { primary: feature.id, related: [sketchRef.id] },
        data: { profileCode: resolvedProfile.error.code },
      },
    };
  }
  const thickness = readers.lengthParameter(thicknessRef, "thickness");
  if (!thickness.ok) return { ok: false, diagnostic: thickness.diagnostic };
  if (!(thickness.mm > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "rib" needs a strictly positive thickness (${thickness.mm} mm given) — a non-positive thickness extrudes nothing and the rib degenerates.`,
        [thicknessRef],
      ),
    };
  }
  const half = thickness.mm / 2;
  const ribUp = kernel.extrude({
    loop: resolvedProfile.value.loop,
    height: lengthValue(half),
    direction: 1,
    placement: resolvedProfile.value.placement,
  });
  if (!ribUp.ok) {
    return operationFailure(feature, ribUp.error.code, ribUp.error.message);
  }
  const ribDown = kernel.extrude({
    loop: resolvedProfile.value.loop,
    height: lengthValue(half),
    direction: -1,
    placement: resolvedProfile.value.placement,
  });
  if (!ribDown.ok) {
    return operationFailure(feature, ribDown.error.code, ribDown.error.message);
  }
  const before = kernel.volume(target.solid);
  if (!before.ok) {
    return operationFailure(feature, before.error.code, before.error.message);
  }
  const merged = kernel.union([target.solid, ribUp.value, ribDown.value]);
  if (!merged.ok) {
    return operationFailure(feature, merged.error.code, merged.error.message);
  }
  const after = kernel.volume(merged.value);
  if (!after.ok) {
    return operationFailure(feature, after.error.code, after.error.message);
  }
  if (after.value <= before.value) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelOperationFailed,
        `Feature "${feature.id}" of kind "rib" added nothing: the rib cross-section lies entirely inside the target — the union's volume did not grow. Draw the rib's profile reaching outside the part it strengthens.`,
        [targetRef],
      ),
    };
  }
  return { ok: true, solid: merged.value };
}

/**
 * The scale feature kind's executor path (Phase 41) — the DIRECT KERNEL
 * CALL the transform's Phase 41 `scale` field carries: one target, one
 * dimensionless factor, capability-gated on `transformScale` BEFORE the
 * call (the mirror gate precedent — the refusal is a feature diagnostic,
 * never a silently unscaled solid).
 *
 * ## Failure taxonomy (all structured)
 *
 * - Layout: not exactly one feature/body input and one parameter →
 *   `kernel/feature-input-invalid`.
 * - Factor: wrong dimension, non-finite, or non-positive →
 *   `kernel/parameter-invalid` (feature-level bounds before any kernel
 *   call — a zero or negative factor mirrors or annihilates the solid).
 * - Capability: `transformScale` not declared →
 *   `kernel/feature-input-invalid`, the gate refusing before the kernel
 *   can ignore the field.
 */
function runScaleOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  if (targetRefs.length !== 1 || parameterRefs.length !== 1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "scale" needs exactly one feature/body input (the solid to scale) and exactly one parameter input (the factor); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  const targetRef = targetRefs[0];
  const factorRef = parameterRefs[0];
  if (targetRef === undefined || factorRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "scale" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;
  const factor = readers.dimensionlessParameter(factorRef, "factor");
  if (!factor.ok) return { ok: false, diagnostic: factor.diagnostic };
  if (!Number.isFinite(factor.value) || !(factor.value > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "scale" needs a finite, strictly positive factor (${factor.value} given) — a non-positive factor mirrors or annihilates the solid, and uniform scaling is all the contract carries (non-uniform needs a general-transform route no binding exposes).`,
        [factorRef],
      ),
    };
  }
  if (!kernel.capabilities.transformScale) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "scale" needs a uniform scale, but this kernel ("${kernel.id}") does not declare the transformScale capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a silently unscaled solid.`,
      ),
    };
  }
  const result = kernel.transform(target.solid, {
    x: lengthValue(0),
    y: lengthValue(0),
    z: lengthValue(0),
    scale: factor.value,
  });
  return result.ok
    ? { ok: true, solid: result.value }
    : operationFailure(feature, result.error.code, result.error.message);
}

/**
 * The thicken feature kind's executor path (Phase 41) — the DIRECT KERNEL
 * CALL building the closed hollow: one target, one wall thickness,
 * capability-gated on `thicken` BEFORE the call. The kernel's own
 * structured battery owns the geometry verdicts: the too-thick refusal
 * (`kernel/thicken-failed`) and the per-shape subset declines
 * (`kernel/unsupported-operation` on the fake kernel's non-leaf targets).
 *
 * ## Failure taxonomy (all structured)
 *
 * - Layout: not exactly one feature/body input and one parameter →
 *   `kernel/feature-input-invalid`.
 * - Thickness ≤ 0 → `kernel/parameter-invalid` before any kernel call.
 * - Capability: `thicken` not declared → `kernel/feature-input-invalid`
 *   (the gate, the scale/mirror precedent).
 * - Kernel failures ride through as `kernel/operation-failed` with the
 *   kernel code in `data`.
 */
function runThickenOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  if (targetRefs.length !== 1 || parameterRefs.length !== 1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thicken" needs exactly one feature/body input (the target) and exactly one parameter input (the wall thickness); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  const targetRef = targetRefs[0];
  const thicknessRef = parameterRefs[0];
  if (targetRef === undefined || thicknessRef === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thicken" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;
  const thickness = readers.lengthParameter(thicknessRef, "thickness");
  if (!thickness.ok) return { ok: false, diagnostic: thickness.diagnostic };
  if (!(thickness.mm > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "thicken" needs a strictly positive wall thickness (${thickness.mm} mm given) — a non-positive thickness hollows nothing.`,
        [thicknessRef],
      ),
    };
  }
  if (!kernel.capabilities.thicken) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "thicken" needs a closed hollow, but this kernel ("${kernel.id}") does not declare the thicken capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a half-built shell.`,
      ),
    };
  }
  const result = kernel.thicken({
    target: target.solid,
    thickness: lengthValue(thickness.mm),
  });
  return result.ok
    ? { ok: true, solid: result.value }
    : operationFailure(feature, result.error.code, result.error.message);
}

/**
 * The split feature kind's executor path (Phase 41) — FEATURE-LEVEL
 * COMPOSITION (the roadmap's "composition or dedicated op per probe",
 * resolved to composition): `planSplitCut` builds a covering box tool on
 * the removed side of the resolved datum plane (the hole tool's
 * overshoot and one-source-of-truth disciplines), one `extrude` builds
 * it, one `subtract` cuts, and the measured post-condition guards both
 * degenerate outcomes. The half-space the probe validated on OCCT
 * (`BRepPrimAPI_MakeHalfSpace` + `BRepAlgoAPI_Cut`, exact) stays
 * OCCT-internal knowledge: the composition runs on EVERY kernel through
 * ops they all implement.
 *
 * ## Input layout
 *
 * ONE feature/body input (the target), ONE datum input (the split plane
 * — a datum PLANE, any other datum kind is a structured mismatch), and
 * ONE dimensionless parameter (the keep side: `+1` keeps the side the
 * plane's normal points to, `−1` the opposite).
 *
 * ## The measured post-condition (the hole guard, both ways)
 *
 * A split that removed nothing (the plane misses the target — the kept
 * side is the whole solid) and a split that removed everything (the kept
 * side is empty) are both refused with `kernel/operation-failed` and the
 * measured volumes in `data`: the feature promises ONE output body with
 * strictly positive, strictly-diminished volume.
 *
 * ## Failure taxonomy (all structured)
 *
 * - Layout: not exactly one target, one datum, one parameter →
 *   `kernel/feature-input-invalid`.
 * - Datum resolution: the structured failures of `resolveDatumInput`
 *   (`data.datumCode`), and a non-plane datum kind is a
 *   `datum/definition-invalid` mismatch.
 * - Side: wrong dimension or outside ±1 → `kernel/parameter-invalid`.
 * - No-op / remove-all: `kernel/operation-failed` with
 *   `data.reason = "split/no-op"` / `"split/removed-everything"`.
 * - Kernel failures ride through as `kernel/operation-failed`.
 */
function runSplitOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  const targetRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "feature" | "body" } =>
      ref.kind === "feature" || ref.kind === "body",
  );
  const datumRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "datum" } =>
      ref.kind === "datum",
  );
  const parameterRefs = inputs.filter(
    (ref): ref is FeatureInputRef & { readonly kind: "parameter" } =>
      ref.kind === "parameter",
  );
  if (
    targetRefs.length !== 1 ||
    datumRefs.length !== 1 ||
    parameterRefs.length !== 1
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "split" needs exactly one feature/body input (the target), one datum input (the split plane), and one parameter input (the keep side); it declares ${targetRefs.length} target(s), ${datumRefs.length} datum input(s), and ${parameterRefs.length} parameter(s).`,
      ),
    };
  }
  const targetRef = targetRefs[0];
  const datumRef = datumRefs[0];
  const sideRef = parameterRefs[0];
  if (
    targetRef === undefined ||
    datumRef === undefined ||
    sideRef === undefined
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "split" has a malformed input list.`,
      ),
    };
  }
  const target = readers.solidInput(targetRef);
  if (!target.ok) return target;
  const resolvedDatum = resolveDatumInput(
    feature,
    datumRef,
    readers.document,
    readers.datumTopology,
    "the split plane",
  );
  if (!resolvedDatum.ok)
    return { ok: false, diagnostic: resolvedDatum.diagnostic };
  if (
    resolvedDatum.datumType !== "plane" ||
    resolvedDatum.plane === undefined
  ) {
    return datumKindMismatch(
      feature,
      datumRef,
      `Feature "${feature.id}" of kind "split" needs a datum PLANE as its cutting plane; the referenced datum defines ${resolvedDatum.datumType === "axis" ? "an axis" : resolvedDatum.datumType === "point" ? "a point" : "a coordinate system"}.`,
    );
  }
  const sideValue = readers.dimensionlessParameter(sideRef, "side");
  if (!sideValue.ok) return { ok: false, diagnostic: sideValue.diagnostic };
  if (sideValue.value !== 1 && sideValue.value !== -1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelParameterInvalid,
        `Feature "${feature.id}" of kind "split" needs parameter "${sideRef.id}" (side) to select the kept half: +1 keeps the side the plane's normal points to, −1 the opposite (${sideValue.value} given).`,
        [sideRef],
      ),
    };
  }
  const before = kernel.volume(target.solid);
  if (!before.ok) {
    return operationFailure(feature, before.error.code, before.error.message);
  }
  const measured = kernel.bounds(target.solid);
  if (!measured.ok) {
    return operationFailure(
      feature,
      measured.error.code,
      measured.error.message,
    );
  }
  const plan = planSplitCut({
    planeOrigin: resolvedDatum.plane.origin,
    planeNormal: resolvedDatum.plane.normal,
    keepSide: sideValue.value,
    bounds: measured.value,
  });
  const tool = kernel.extrude({
    loop: plan.toolLoop,
    height: lengthValue(plan.toolHeightMm),
    direction: 1,
    placement: {
      rotation: {
        axis: plan.toolRotationAxis,
        angle: angleValue(plan.toolRotationAngleRad),
      },
      translation: {
        x: lengthValue(plan.toolTranslationMm[0]),
        y: lengthValue(plan.toolTranslationMm[1]),
        z: lengthValue(plan.toolTranslationMm[2]),
      },
    },
  });
  if (!tool.ok) {
    return operationFailure(feature, tool.error.code, tool.error.message);
  }
  const cut = kernel.subtract(target.solid, [tool.value]);
  if (!cut.ok) {
    return operationFailure(feature, cut.error.code, cut.error.message);
  }
  const after = kernel.volume(cut.value);
  if (!after.ok) {
    return operationFailure(feature, after.error.code, after.error.message);
  }
  if (after.value >= before.value) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelOperationFailed,
        `Feature "${feature.id}" of kind "split" removed nothing: the plane's removed side holds no target material — flip the keep side or move the datum plane through the solid. (Removed-side reach: ${String(plan.removedExtentMm)} mm past the plane.)`,
        [datumRef, sideRef],
      ),
    };
  }
  if (!(after.value > 0)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelOperationFailed,
        `Feature "${feature.id}" of kind "split" removed everything: the kept side of the datum plane holds no target material — flip the keep side or move the datum plane through the solid.`,
        [datumRef, sideRef],
      ),
    };
  }
  return { ok: true, solid: cut.value };
}

function runKernelOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  kind: BridgeFeatureKind,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  switch (kind) {
    case "box": {
      const lengths = readLengths(feature, readers, inputs, [
        "width",
        "depth",
        "height",
      ]);
      if (!lengths.ok) return lengths;
      const [width, depth, height] = lengths.mm;
      if (width === undefined || depth === undefined || height === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "box" needs exactly three parameter inputs.`,
          ),
        };
      }
      const result = kernel.createBox({
        width: lengthValue(width),
        depth: lengthValue(depth),
        height: lengthValue(height),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "sphere": {
      const lengths = readLengths(feature, readers, inputs, ["radius"]);
      if (!lengths.ok) return lengths;
      const radius = lengths.mm[0];
      if (radius === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "sphere" needs exactly one parameter input.`,
          ),
        };
      }
      const result = kernel.createSphere({ radius: lengthValue(radius) });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "cylinder": {
      const lengths = readLengths(feature, readers, inputs, [
        "radius",
        "height",
      ]);
      if (!lengths.ok) return lengths;
      const [radius, height] = lengths.mm;
      if (radius === undefined || height === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "cylinder" needs exactly two parameter inputs.`,
          ),
        };
      }
      const result = kernel.createCylinder({
        radius: lengthValue(radius),
        height: lengthValue(height),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "cone": {
      const lengths = readLengths(feature, readers, inputs, [
        "bottomRadius",
        "topRadius",
        "height",
      ]);
      if (!lengths.ok) return lengths;
      const [bottomRadius, topRadius, height] = lengths.mm;
      if (
        bottomRadius === undefined ||
        topRadius === undefined ||
        height === undefined
      ) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "cone" needs exactly three parameter inputs.`,
          ),
        };
      }
      const result = kernel.createCone({
        bottomRadius: lengthValue(bottomRadius),
        topRadius: lengthValue(topRadius),
        height: lengthValue(height),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "union": {
      const resolved = readSolids(feature, readers, inputs, 2);
      if (!resolved.ok) return resolved;
      const result = kernel.union(resolved.solids);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "subtract": {
      const resolved = readSolids(feature, readers, inputs, 2);
      if (!resolved.ok) return resolved;
      const [target, ...tools] = resolved.solids;
      if (target === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "subtract" needs a target input.`,
          ),
        };
      }
      const result = kernel.subtract(target, tools);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "intersect": {
      const resolved = readSolids(feature, readers, inputs, 2);
      if (!resolved.ok) return resolved;
      const result = kernel.intersect(resolved.solids);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "translate": {
      const solidRef = inputs[0];
      if (solidRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "translate" needs one feature/body input followed by three parameter inputs.`,
          ),
        };
      }
      const solid = readers.solidInput(solidRef);
      if (!solid.ok) return solid;
      const lengths = readLengths(feature, readers, inputs.slice(1), [
        "x",
        "y",
        "z",
      ]);
      if (!lengths.ok) return lengths;
      const [x, y, z] = lengths.mm;
      if (x === undefined || y === undefined || z === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "translate" needs exactly three translation parameter inputs.`,
          ),
        };
      }
      const result = kernel.transform(solid.solid, {
        x: lengthValue(x),
        y: lengthValue(y),
        z: lengthValue(z),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "extrude": {
      // Input layout: one sketch input (the profile source), one signed
      // length parameter (the distance; sign = direction), and an
      // OPTIONAL third angle parameter (the Phase 41 draft taper — zero
      // or absent meaning the plain prism).
      if (inputs.length !== 2 && inputs.length !== 3) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "extrude" needs two or three inputs: a sketch input (the profile source), a signed length parameter (the distance), and an optional angle parameter (the draft taper).`,
          ),
        };
      }
      const sketchRef = inputs[0];
      const distanceRef = inputs[1];
      const taperRef = inputs[2];
      if (sketchRef === undefined || distanceRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "extrude" has a malformed input list.`,
          ),
        };
      }
      if (sketchRef.kind !== "sketch") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "extrude" needs a sketch input as its profile source; a ${sketchRef.kind} input was declared.`,
            [sketchRef],
          ),
        };
      }
      if (distanceRef.kind !== "parameter") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "extrude" needs a parameter input as its distance; a ${distanceRef.kind} input was declared.`,
            [distanceRef],
          ),
        };
      }
      if (taperRef !== undefined && taperRef.kind !== "parameter") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "extrude" needs a parameter input as its draft taper; a ${taperRef.kind} input was declared.`,
            [taperRef],
          ),
        };
      }
      const resolvedProfile = readers.resolveProfile(sketchRef);
      if (!resolvedProfile.ok) {
        return {
          ok: false,
          diagnostic: {
            severity: "error",
            code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            message: `Feature "${feature.id}" of kind "extrude" has an unresolvable sketch profile ("${sketchRef.id}"): ${resolvedProfile.error.message}`,
            location: { primary: feature.id, related: [sketchRef.id] },
            data: { profileCode: resolvedProfile.error.code },
          },
        };
      }
      // Signed distance: magnitude is the height, sign is the direction.
      const distance = readers.lengthParameter(distanceRef, "distance");
      if (!distance.ok) return { ok: false, diagnostic: distance.diagnostic };
      if (distance.mm === 0) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelParameterInvalid,
            `Feature "${feature.id}" of kind "extrude" needs a non-zero distance; zero cannot determine an extrusion direction.`,
            [distanceRef],
          ),
        };
      }
      // The Phase 41 draft taper: absent or zero = the plain prism (the
      // compat footing — pre-Phase 41 documents execute unchanged); a
      // non-zero taper is capability-gated before the kernel runs.
      let taper: ReturnType<typeof angleValue> | undefined;
      if (taperRef !== undefined) {
        const taperValue = readers.angleParameter(taperRef, "taper");
        if (!taperValue.ok) {
          return { ok: false, diagnostic: taperValue.diagnostic };
        }
        if (taperValue.rad !== 0) {
          if (!kernel.capabilities.extrudeTaper) {
            return {
              ok: false,
              diagnostic: diagnostic(
                feature,
                DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
                `Feature "${feature.id}" of kind "extrude" drafts its walls by a taper angle, but this kernel ("${kernel.id}") does not declare the extrudeTaper capability — the gate refuses before the kernel can answer, so the unsupported verdict is a feature diagnostic rather than a differently-shaped solid wearing the feature's name.`,
                [taperRef],
              ),
            };
          }
          taper = angleValue(taperValue.rad);
        }
      }
      const result = kernel.extrude({
        loop: resolvedProfile.value.loop,
        height: lengthValue(Math.abs(distance.mm)),
        direction: distance.mm > 0 ? 1 : -1,
        placement: resolvedProfile.value.placement,
        ...(taper === undefined ? {} : { taper }),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "revolve": {
      // Input layout — COMPAT form: one sketch input (the profile source),
      // one angle parameter (the sweep), one angle parameter (the axis
      // direction in the sketch plane, CCW from the workplane x axis — the
      // axis line runs through the workplane origin along it).
      // DATUM form (Phase 39): the third input is a DATUM AXIS; the axis
      // line is the datum's resolved line, which must lie IN the sketch
      // plane (its out-of-plane lean above the coplanarity tolerance is a
      // structured refusal — the contract's axis is in-plane).
      const datumAxisRefs = inputs.filter(
        (ref): ref is FeatureInputRef & { readonly kind: "datum" } =>
          ref.kind === "datum",
      );
      const datumAxisForm = datumAxisRefs.length === 1;
      if (inputs.length !== 3) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "revolve" needs exactly three inputs: a sketch input (the profile source), a sweep angle parameter, and ${datumAxisForm ? "a datum axis input" : "an axis direction parameter"}.`,
          ),
        };
      }
      const sketchRef = inputs[0];
      const sweepRef = inputs[1];
      const axisRef = inputs[2];
      if (
        sketchRef === undefined ||
        sweepRef === undefined ||
        axisRef === undefined
      ) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "revolve" has a malformed input list.`,
          ),
        };
      }
      if (sketchRef.kind !== "sketch") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "revolve" needs a sketch input as its profile source; a ${sketchRef.kind} input was declared.`,
            [sketchRef],
          ),
        };
      }
      if (sweepRef.kind !== "parameter") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "revolve" needs a parameter input as its sweep; a ${sweepRef.kind} input was declared.`,
            [sweepRef],
          ),
        };
      }
      if (
        datumAxisForm ? axisRef.kind !== "datum" : axisRef.kind !== "parameter"
      ) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            datumAxisForm
              ? `Feature "${feature.id}" of kind "revolve" needs a datum input as its axis; a ${axisRef.kind} input was declared.`
              : `Feature "${feature.id}" of kind "revolve" needs a parameter input as its axis direction; a ${axisRef.kind} input was declared.`,
            [axisRef],
          ),
        };
      }
      const resolvedProfile = readers.resolveProfile(sketchRef);
      if (!resolvedProfile.ok) {
        return {
          ok: false,
          diagnostic: {
            severity: "error",
            code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            message: `Feature "${feature.id}" of kind "revolve" has an unresolvable sketch profile ("${sketchRef.id}"): ${resolvedProfile.error.message}`,
            location: { primary: feature.id, related: [sketchRef.id] },
            data: { profileCode: resolvedProfile.error.code },
          },
        };
      }
      const sweep = readers.angleParameter(sweepRef, "sweep");
      if (!sweep.ok) return { ok: false, diagnostic: sweep.diagnostic };

      let axisPoint: readonly [number, number];
      let axisDirection: readonly [number, number];
      if (datumAxisForm) {
        const resolvedDatum = resolveDatumInput(
          feature,
          axisRef,
          readers.document,
          readers.datumTopology,
          "the revolve axis",
        );
        if (!resolvedDatum.ok) {
          return { ok: false, diagnostic: resolvedDatum.diagnostic };
        }
        if (
          resolvedDatum.datumType !== "axis" ||
          resolvedDatum.axis === undefined
        ) {
          return datumKindMismatch(
            feature,
            axisRef,
            `Feature "${feature.id}" of kind "revolve" needs a datum AXIS as its revolve axis; the referenced datum defines ${resolvedDatum.datumType === "plane" ? "a plane" : resolvedDatum.datumType === "point" ? "a point" : "a coordinate system"}.`,
          );
        }
        // Map the world axis into the sketch frame: the placement is a
        // rotation about the world origin then a translation, so the local
        // form of a world point p is R⁻¹·(p − t).
        const placement = resolvedProfile.value.placement;
        const rotationAngle = valueIn(placement.rotation.angle, "rad");
        const matrix = rotationMatrix(
          [
            placement.rotation.axis[0],
            placement.rotation.axis[1],
            placement.rotation.axis[2],
          ],
          rotationAngle,
        );
        const translation: DatumVec3 = [
          valueIn(placement.translation.x, "mm"),
          valueIn(placement.translation.y, "mm"),
          valueIn(placement.translation.z, "mm"),
        ];
        const worldOrigin = resolvedDatum.axis.origin;
        const localOrigin = applyMatrixTranspose(matrix, [
          worldOrigin[0] - translation[0],
          worldOrigin[1] - translation[1],
          worldOrigin[2] - translation[2],
        ]);
        const localDirection = applyMatrixTranspose(
          matrix,
          resolvedDatum.axis.direction,
        );
        if (Math.abs(localDirection[2]) > DATUM_COPLANARITY_TOLERANCE) {
          return {
            ok: false,
            diagnostic: diagnostic(
              feature,
              DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
              `Feature "${feature.id}" of kind "revolve" needs its datum axis to lie IN the sketch plane; the resolved axis leans ${String(Math.abs(localDirection[2]))} out of plane along the sketch normal. Revolving about an out-of-plane line is not a sketch-plane operation — re-define the datum axis in the sketch's plane.`,
              [axisRef],
            ),
          };
        }
        // A direction IN the plane is not enough: the axis ORIGIN must also
        // sit in the plane. An axis parallel to the plane but offset along
        // its normal is a legal datum yet revolving about its projected
        // in-plane shadow would silently displace the solid — the exact
        // silent-misgeometry class this bridge refuses elsewhere.
        if (Math.abs(localOrigin[2]) > DATUM_COPLANARITY_TOLERANCE) {
          return datumInputFailure(
            feature,
            axisRef,
            `Feature "${feature.id}" of kind "revolve" needs its datum axis to lie IN the sketch plane; the resolved axis is parallel to the plane but its origin is offset ${String(Math.abs(localOrigin[2]))} along the sketch normal. Revolving about the projected in-plane line would silently displace the solid — re-define the datum axis in the sketch's plane.`,
            "datum/definition-invalid",
          );
        }
        const inPlane = vecUnit([localDirection[0], localDirection[1], 0]);
        if (inPlane === null) {
          return {
            ok: false,
            diagnostic: diagnostic(
              feature,
              DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
              `Feature "${feature.id}" of kind "revolve" resolved a datum axis whose in-plane direction is degenerate.`,
              [axisRef],
            ),
          };
        }
        axisPoint = [localOrigin[0], localOrigin[1]];
        axisDirection = [inPlane[0], inPlane[1]];
      } else {
        const axisAngle = readers.angleParameter(axisRef, "axisDirection");
        if (!axisAngle.ok) {
          return { ok: false, diagnostic: axisAngle.diagnostic };
        }
        axisPoint = [0, 0];
        axisDirection = [Math.cos(axisAngle.rad), Math.sin(axisAngle.rad)];
      }
      const revolveInput: ProfileRevolveInput = {
        loop: resolvedProfile.value.loop,
        axis: {
          point: [...axisPoint],
          direction: [...axisDirection],
        },
        angle: angleValue(sweep.rad, "rad"),
        placement: resolvedProfile.value.placement,
      };
      const result = kernel.revolve(revolveInput);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "sweep":
      // The Phase 38 sweep: two sketch inputs (profile, path) through the
      // path seam, capability-gated, one direct kernel sweep call (see
      // runSweepOperation).
      return runSweepOperation(kernel, feature, readers);
    case "loft":
      // The Phase 38 loft: ordered section sketches + their station-z
      // parameters through ONE frame, capability-gated, one direct kernel
      // loft call (see runLoftOperation).
      return runLoftOperation(kernel, feature, readers);
    case "helix":
      // The Phase 40 helix: a meridian profile sketch + six spine
      // parameters (+ optional datum axis), capability-gated, one direct
      // helixSweep call (see runHelixOperation).
      return runHelixOperation(kernel, feature, readers);
    case "thread":
      // The Phase 40 thread: the composed ISO-tool cut — planThreadCut's
      // shared geometry swept by helixSweep and subtracted, with the
      // no-op post-condition guard (see runThreadOperation).
      return runThreadOperation(kernel, feature, readers);
    case "fillet":
      // The Phase 26.5 edge-cutting kind: the shared resolution battery
      // plus the fillet kernel call (see runEdgeCutOperation).
      return runEdgeCutOperation(kernel, feature, "fillet", "radius", readers);
    case "chamfer":
      // The Phase 26.6 edge-cutting kind: the same battery, the chamfer
      // kernel call, and the symmetric distance in the radius's place.
      return runEdgeCutOperation(
        kernel,
        feature,
        "chamfer",
        "distance",
        readers,
      );
    case "shell":
      // The Phase 26.7 hollow: the same battery on the FACE reference kind
      // and the wall thickness in the cut size's place.
      return runEdgeCutOperation(
        kernel,
        feature,
        "shell",
        "thickness",
        readers,
      );
    case "patternLinear":
      // The Phase 26.8 linear pattern: count × spacing along a direction
      // angle in the world XY plane, composed as transforms + one union.
      return runPatternOperation(kernel, feature, "patternLinear", readers);
    case "patternCircular":
      // The Phase 26.8 circular pattern: count copies at i·Δ about a world
      // axis, composed as origin-axis rotations + one union (capability-
      // gated — see runPatternOperation).
      return runPatternOperation(kernel, feature, "patternCircular", readers);
    case "patternFeature":
      // The Phase 43 feature-level array: the feature RANGE repeated over
      // asymmetric direction+count+spacing legs with a skip-instance list,
      // one union at the end (see runPatternFeatureOperation).
      return runPatternFeatureOperation(kernel, feature, readers);
    case "patternPath":
      // The Phase 43 path pattern: instances at i·spacing arc length along
      // a sketch path, fixed or tangent-following (see
      // runPatternPathOperation).
      return runPatternPathOperation(kernel, feature, readers);
    case "patternFace":
      // The Phase 43 face-bounded grid: the target repeated at the grid
      // points inside the referenced face's tessellated boundary (see
      // runPatternFaceOperation).
      return runPatternFaceOperation(kernel, feature, readers);
    case "mirror":
      // The Phase 26.9 reflection: the direct kernel call the negative
      // determinant forces — plane selector validated, capability gated,
      // one world-axis-plane mirror (see runMirrorOperation).
      return runMirrorOperation(kernel, feature, readers);
    case "hole":
      // The Phase 26.10 hole: the composed cut — planned cylinder tool
      // subtracted from the target, with the no-op post-condition guarding
      // the silent-miss trap (see runHoleOperation).
      return runHoleOperation(kernel, feature, readers);
    case "rib":
      // The Phase 41 rib: the symmetric double extrusion of the picked
      // cross-section unioned with the target, with the no-op guard in
      // its adding direction (see runRibOperation).
      return runRibOperation(kernel, feature, readers);
    case "scale":
      // The Phase 41 uniform scale: the direct transform call the scale
      // field carries, capability-gated (see runScaleOperation).
      return runScaleOperation(kernel, feature, readers);
    case "thicken":
      // The Phase 41 closed hollow: the direct thicken call, gated on the
      // thicken capability (see runThickenOperation).
      return runThickenOperation(kernel, feature, readers);
    case "split":
      // The Phase 41 split: the composed covering-box cut on the removed
      // side of the datum plane, with the both-ways post-condition (see
      // runSplitOperation).
      return runSplitOperation(kernel, feature, readers);
  }
}
