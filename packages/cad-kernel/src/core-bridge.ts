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
  type FeatureExecutionOutcome,
  type FeatureExecutor,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  type TopologyView,
  angle as angleValue,
  length as lengthValue,
  type ParseFailure,
  type ParseResult,
  type SketchDocumentId,
  getDocumentReference,
  parseTopologyReference,
  resolveDocumentReference,
  transientSelectionOf,
  valueIn,
} from "@slopcad/cad-core";

import {
  type GeometryKernel,
  type KernelBounds,
  type MirrorPlaneAxis,
  type ProfileExtrudeInput,
  type ProfileRevolveInput,
  type KernelSolid,
} from "./contract";

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
  "fillet",
  "chamfer",
  "shell",
  "patternLinear",
  "patternCircular",
  "mirror",
  "hole",
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
   * The optional reference-resolution view that the topology-addressed
   * features' (`fillet`, `chamfer`, `shell`) references resolve against
   * (the Phase 22
   * protocol's kernel-side gate — the persistent-topology kernel's
   * `TopologyView`). A context without one cannot resolve edge references:
   * every such feature carrying reference inputs fails with a structured
   * diagnostic instead of guessing. The view must stand at the CURRENT
   * regeneration — the snapshot ordinals the resolution produces are the
   * addresses the kernel's edge-cutting operations consume for this run.
   */
  readonly topology?: TopologyView;
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

function isBridgeFeatureKind(kind: string): kind is BridgeFeatureKind {
  return BRIDGE_KIND_SET.has(kind);
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
      solidInput: (ref) => solidInput(feature, ref),
      resolveProfile: (ref) => context.profiles(ref.id),
      bodyIdOf: (ref) => {
        if (ref.kind === "body") return ref.id;
        if (ref.kind === "feature") return featureOutputs.get(ref.id);
        return undefined;
      },
      document: context.document,
      topology: context.topology,
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
  readonly solidInput: (ref: FeatureInputRef) => SolidOutcome;
  readonly resolveProfile: (
    ref: FeatureInputRef & { readonly kind: "sketch" },
  ) => KernelProfileResolution;
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
  const otherRefs = inputs.filter(
    (ref) =>
      ref.kind !== "feature" && ref.kind !== "body" && ref.kind !== "parameter",
  );
  if (targetRefs.length !== 1 || parameterRefs.length !== 3) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${kind}" needs exactly one feature/body input (the solid to repeat) and exactly three parameter inputs (${parameterNames.join(", ")}); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
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
    thirdRef === undefined
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
    const direction = readers.angleParameter(thirdRef, "direction");
    if (!direction.ok) {
      return { ok: false, diagnostic: direction.diagnostic };
    }
    const dx = Math.cos(direction.rad);
    const dy = Math.sin(direction.rad);
    for (let i = 1; i < count; i += 1) {
      const offset = i * spacing.mm;
      const placed = kernel.transform(target.solid, {
        x: lengthValue(offset * dx),
        y: lengthValue(offset * dy),
        z: lengthValue(0),
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
    const step = totalAngle.rad / count;
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
  const merged = kernel.union(copies);
  return merged.ok
    ? { ok: true, solid: merged.value }
    : operationFailure(feature, merged.error.code, merged.error.message);
}

/**
 * The mirror feature kind's executor path (Phase 26.9) — the DIRECT KERNEL
 * CALL the negative determinant forces (see the module doc's mirror design
 * decision): one target solid, one world axis plane, one call to the
 * contract's dedicated `mirror` operation.
 *
 * ## Input layout (roles off the refs' kinds; parameter roles in declared
 * order)
 *
 * ONE feature/body input (the solid to reflect), then exactly TWO
 * parameter inputs:
 *
 * - plane (DIMENSIONLESS integer `1` = YZ plane, normal +x — reflects the
 *   x coordinate; `2` = XZ, normal +y; `3` = XY, normal +z — the
 *   patternCircular axis precedent, dimensionless 1/2/3, carried to plane
 *   selection). Arbitrary planes are OUT OF SCOPE here by the revolve
 *   precedent: they need the datum concept (named reference geometry), the
 *   same generalization the revolve axis defers; an oblique mirror
 *   composes today from a `transform` rotation ahead of the feature.
 * - offset (LENGTH, any finite value — the plane's signed position along
 *   its normal; the reflection maps that coordinate `c → 2·offset − c`).
 *   Unlike size-like lengths, EVERY finite offset is a legal plane
 *   position: zero (the world plane itself) and negative offsets are good
 *   mirrors, so no sign rule exists.
 *
 * `parameter.set` on either parameter re-drives the reflection through
 * regeneration — the bridge re-reads the plane and offset each run.
 *
 * ## Failure taxonomy (all structured, before any kernel call)
 *
 * - Layout: not exactly one feature/body target or exactly two parameter
 *   inputs, or a sketch input in the target's place →
 *   `kernel/feature-input-invalid`.
 * - Plane: wrong dimension, non-integer, or outside `1..3` →
 *   `kernel/parameter-invalid`.
 * - Offset: wrong dimension → `kernel/parameter-invalid` (any finite
 *   magnitude is legal; a non-finite one cannot ride the typed parameter
 *   model, and the kernel's own no-throw boundary owns it anyway).
 * - Capability: a kernel that has not declared `mirror` →
 *   `kernel/feature-input-invalid` (the circular pattern's rotation-gate
 *   precedent: refuse structurally before the kernel can answer, so the
 *   unsupported verdict is a feature diagnostic, never a half-built
 *   arrangement).
 * - Kernel failures (the mirror call rejecting) ride through as
 *   `kernel/operation-failed` with the kernel code in `data`.
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
  const otherRefs = inputs.filter(
    (ref) =>
      ref.kind !== "feature" && ref.kind !== "body" && ref.kind !== "parameter",
  );
  if (targetRefs.length !== 1 || parameterRefs.length !== 5) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "hole" needs exactly one feature/body input (the target solid) and exactly five parameter inputs (diameter, depth, positionX, positionY, axis); it declares ${targetRefs.length} target(s) and ${parameterRefs.length} parameter(s).`,
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
  const axisRef = parameterRefs[4];
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
  // The axis selector: the mirror plane's dimensionless discipline.
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

  // The target's bounds drive the through/blind decision and the tool
  // placement (planHoleCut: the one tool-geometry source of truth).
  const measured = kernel.bounds(target.solid);
  if (!measured.ok) {
    return operationFailure(
      feature,
      measured.error.code,
      measured.error.message,
    );
  }
  const plan = planHoleCut({
    diameterMm: diameter.mm,
    depthMm: depth.mm,
    positionXMm: positionX.mm,
    positionYMm: positionY.mm,
    axis: axisValue.value as HoleAxisSelector,
    bounds: measured.value,
  });
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
  const targetVolume = kernel.volume(target.solid);
  if (!targetVolume.ok) {
    return operationFailure(
      feature,
      targetVolume.error.code,
      targetVolume.error.message,
    );
  }
  const cut = kernel.subtract(target.solid, [tool.value]);
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
        message: `Feature "${feature.id}" of kind "hole" removed no material: the ${plan.through ? "through" : "blind"} hole (Ø${diameter.mm} × ${depth.mm} mm at in-plane (${positionX.mm}, ${positionY.mm})) misses its target (bounds [${measured.value.min.join(", ")}] → [${measured.value.max.join(", ")}]). Move holeX/holeY onto the target or grow the diameter — the subtract would otherwise silently return the target unchanged.`,
        location: {
          primary: feature.id,
          related: [targetRef.id, xRef.id, yRef.id],
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
      // length parameter (the distance; sign = direction).
      if (inputs.length !== 2) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "extrude" needs exactly two inputs: a sketch input (the profile source) and a signed length parameter (the distance).`,
          ),
        };
      }
      const sketchRef = inputs[0];
      const distanceRef = inputs[1];
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
      const result = kernel.extrude({
        loop: resolvedProfile.value.loop,
        height: lengthValue(Math.abs(distance.mm)),
        direction: distance.mm > 0 ? 1 : -1,
        placement: resolvedProfile.value.placement,
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "revolve": {
      // Input layout: one sketch input (the profile source), one angle
      // parameter (the sweep), one angle parameter (the axis direction in
      // the sketch plane, CCW from the workplane x axis — the axis line
      // runs through the workplane origin along it).
      if (inputs.length !== 3) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "revolve" needs exactly three inputs: a sketch input (the profile source), a sweep angle parameter, and an axis direction parameter.`,
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
      if (axisRef.kind !== "parameter") {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "revolve" needs a parameter input as its axis direction; a ${axisRef.kind} input was declared.`,
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
      const axisDirection = readers.angleParameter(axisRef, "axisDirection");
      if (!axisDirection.ok) {
        return { ok: false, diagnostic: axisDirection.diagnostic };
      }
      const revolveInput: ProfileRevolveInput = {
        loop: resolvedProfile.value.loop,
        axis: {
          point: [0, 0],
          direction: [Math.cos(axisDirection.rad), Math.sin(axisDirection.rad)],
        },
        angle: angleValue(sweep.rad, "rad"),
        placement: resolvedProfile.value.placement,
      };
      const result = kernel.revolve(revolveInput);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
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
  }
}
