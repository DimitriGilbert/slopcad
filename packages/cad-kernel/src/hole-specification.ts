/**
 * The structured hole vocabulary (Phase 42): the hole-type parameter schema,
 * the shared structural validator, and the ONE tool-geometry planner of the
 * structured hole forms — `planHoleCut`'s discipline (Phase 26.10) carried to
 * the type-directed hole. Shared verbatim by the executor bridge (which
 * composes `revolve`/`helixSweep` + `subtract` on document regeneration) and
 * the workbench's worker scene (which composes the identical cut through the
 * worker operation matrix).
 *
 * ## The tool is a REVOLVED MERIDIAN, not a stack of primitives
 *
 * Every structured hole — straight with a drill tip, counterbore,
 * countersink, taper, threaded — is a SOLID OF REVOLUTION about its axis:
 * the shop drawing's turned profile. The planner builds that profile as one
 * closed MERIDIAN polygon in local coordinates (x = radius ≥ 0, y = axial
 * distance from the tool base), touching the revolve axis along its x = 0
 * edge (touching is legal revolve input everywhere; crossing is what the
 * shared validator refuses). One `revolve` op carries it into a tool solid —
 * the op's own placement (rotation + translation) places the axis, part of
 * the operation's input on every kernel, never rotation-gated (the extruded-
 * circle tool's reason verbatim) — so every type except the threaded one
 * composes from `revolve` + `subtract` alone, the all-kernel coverage the
 * flat hole form already enjoys. Straight-edge meridians revolve to EXACT
 * volumes on the fake kernel (Pappus, closed form) and OCCT (analytic
 * cylinders/cones); the mesh kernels tessellate the sweep angle at their
 * documented chord deflection — the curved band the contract suite pins.
 *
 * The threaded type adds the Phase 40 ISO ridge: a PILOT hole at the ISO
 * BASIC MINOR diameter `d₁ = d − 2·(5H/8)` (computed from the table numbers,
 * analytically exact — the table's tap-drill column is shop advice the
 * picker displays, not the modeled pilot), plus the internal-mode thread
 * tool (`planThreadCut`) swept from the entry along the hole axis. The pilot
 * and the ridge have disjoint interiors (they share only the d₁ cylinder),
 * so the removed volume is their sum; the thread delta rides Phase 40's
 * exact screw-volume band. Threaded holes therefore need the `helix`
 * capability — kernels without it decline the feature structurally (the
 * capability-gate precedent), documented in the kernels guide's matrix.
 *
 * ## Conventions (documented where the author reads them)
 *
 * - DEPTH is the hole's FULL axial extent from the entry face to the drill
 *   TIP POINT (the drill-point depth). The through/blind semantic is the
 *   flat form's one-distance rule unchanged: `depth ≥ extent` along the axis
 *   is a through hole, and the tool then spans past both faces by
 *   {@link HOLE_TOOL_OVERSHOOT_MM} (the overshoot opens the boolean cut and
 *   never defines geometry).
 * - The TIP ANGLE is the drill point's INCLUDED angle, θ ∈ (0°, 180°]:
 *   180° is the flat bottom (h = 0), 118° the shop default. The tip's axial
 *   extent is `h = (d/2)/tan(θ/2)` and must leave a cylindrical section
 *   (`h < depth`, and the entry-side features must clear it too).
 * - A COUNTERBORE is measured from the entry face: a coaxial cylinder of
 *   `cboreDiameter` down to `cboreDepth`, strictly wider than the hole.
 * - A COUNTERSINK is the entry cone from the hole's throat up to
 *   `csinkDiameter` at the INCLUDED `csinkAngle`: frustum height
 *   `h_cs = (R_cs − r)/tan(α/2)`.
 * - A TAPER hole narrows from its ENTRY diameter at the INCLUDED
 *   `taperAngle`: radius `r(z) = r₀ − z·tan(α/2)`; the tool ends at the
 *   closing point `z_close = r₀/tan(α/2)` or at the authored depth,
 *   whichever comes first (a taper that closes before the far face is a
 *   blind taper by geometry, whatever the depth says).
 * - POSITIONS live in the plane perpendicular to the hole axis, expressed in
 *   the SAME in-plane basis the flat form's positionX/positionY ride (the
 *   world-selector form: the two world axes in order, skipping the axis; the
 *   datum-axis form: the rotated frame's local x/y). A feature may carry a
 *   SKETCH whose point entities are the positions — one feature, many holes
 *   — read as in-plane (x, y) pairs in that basis; the sketch's own
 *   workplane placement does not carry (the sweep path seam's simplification
 *   precedent).
 * - Hole SERIES at assembly level are deferred to assemblies (Phase 52).
 */

import { angle as angleValue, length as lengthValue } from "@slopcad/cad-core";
import type {
  HelixSweepInput,
  ProfileRevolveInput,
  ProfileSegmentInput,
} from "./contract";

import { HOLE_TOOL_OVERSHOOT_MM } from "./core-bridge";
import { helixProfilePolygon, helixScrewVolume } from "./helix-geometry";
import {
  isoThreadMinorDiameter,
  isoThreadToolLoop,
  planThreadCut,
  threadHelixSpine,
} from "./thread-profile";

/** The structured hole's type selector values, as the parameter carries them. */
export const HOLE_TYPE_VALUES = {
  straight: 1,
  counterbore: 2,
  countersink: 3,
  taper: 4,
  threaded: 5,
} as const;

/** A structured hole type (see {@link HOLE_TYPE_VALUES}). */
export type StructuredHoleType = keyof typeof HOLE_TYPE_VALUES;

/** The structured hole types, in selector order. */
export const STRUCTURED_HOLE_TYPES = Object.keys(
  HOLE_TYPE_VALUES,
) as readonly StructuredHoleType[];

/** One kind of value a hole parameter role can carry. */
export type StructuredHoleRoleKind = "length" | "angle" | "dimensionless";

/** One parameter role of the structured hole schema. */
export interface StructuredHoleRole {
  /** The role's name (the parameter's documented meaning, camelCase). */
  readonly name: string;
  /** The value kind the role's parameter carries. */
  readonly kind: StructuredHoleRoleKind;
}

/**
 * The structured hole PARAMETER SCHEMA (Phase 42): the ordered, per-type
 * role lists the feature's parameter inputs follow in declared order — the
 * single source the bridge reader validates against, the workbench's hole
 * dialog builds its form fields from, and the docs cite. The shared roles:
 * `type` first (the dimensionless selector), then the type's own dimensions,
 * then `positionX`/`positionY` (absent when a SKETCH input carries the
 * positions) and `axis` (absent when a DATUM AXIS input carries it).
 */
export function structuredHoleRoles(
  type: StructuredHoleType,
  options: {
    /** The feature declares a sketch input carrying the positions. */
    readonly sketchPositions?: boolean;
    /** The feature declares a datum axis input carrying the hole axis. */
    readonly datumAxis?: boolean;
  },
): readonly StructuredHoleRole[] {
  const positions: readonly StructuredHoleRole[] = options.sketchPositions
    ? []
    : [
        { name: "positionX", kind: "length" },
        { name: "positionY", kind: "length" },
      ];
  const axis: readonly StructuredHoleRole[] = options.datumAxis
    ? []
    : [{ name: "axis", kind: "dimensionless" }];
  const head: readonly StructuredHoleRole[] = [
    { name: "type", kind: "dimensionless" },
  ];
  switch (type) {
    case "straight":
      return [
        ...head,
        { name: "diameter", kind: "length" },
        { name: "depth", kind: "length" },
        { name: "tipAngle", kind: "angle" },
        ...positions,
        ...axis,
      ];
    case "counterbore":
      return [
        ...head,
        { name: "diameter", kind: "length" },
        { name: "depth", kind: "length" },
        { name: "tipAngle", kind: "angle" },
        { name: "cboreDiameter", kind: "length" },
        { name: "cboreDepth", kind: "length" },
        ...positions,
        ...axis,
      ];
    case "countersink":
      return [
        ...head,
        { name: "diameter", kind: "length" },
        { name: "depth", kind: "length" },
        { name: "tipAngle", kind: "angle" },
        { name: "csinkDiameter", kind: "length" },
        { name: "csinkAngle", kind: "angle" },
        ...positions,
        ...axis,
      ];
    case "taper":
      return [
        ...head,
        { name: "diameter", kind: "length" },
        { name: "depth", kind: "length" },
        { name: "taperAngle", kind: "angle" },
        ...positions,
        ...axis,
      ];
    case "threaded":
      return [
        ...head,
        { name: "depth", kind: "length" },
        { name: "tipAngle", kind: "angle" },
        { name: "threadMajor", kind: "length" },
        { name: "threadPitch", kind: "length" },
        ...positions,
        ...axis,
      ];
  }
}

/** The structured hole's authoring values (already type-selected). */
export interface StructuredHoleSpec {
  /** The type selector (1–5; see {@link HOLE_TYPE_VALUES}). */
  readonly type: number;
  /** The hole's nominal diameter (mm) — the threaded type derives its own. */
  readonly diameterMm: number;
  /** The FULL axial extent to the drill tip point (mm; see the module doc). */
  readonly depthMm: number;
  /** The drill tip's INCLUDED angle (deg; 180 = flat). */
  readonly tipAngleDeg: number;
  /** The counterbore diameter (mm; type 2). */
  readonly cboreDiameterMm: number;
  /** The counterbore depth from the entry face (mm; type 2). */
  readonly cboreDepthMm: number;
  /** The countersink rim diameter (mm; type 3). */
  readonly csinkDiameterMm: number;
  /** The countersink's INCLUDED angle (deg; type 3). */
  readonly csinkAngleDeg: number;
  /** The taper's INCLUDED angle (deg; type 4). */
  readonly taperAngleDeg: number;
  /** The ISO thread's major diameter (mm; type 5). */
  readonly threadMajorMm: number;
  /** The ISO thread's pitch (mm; type 5). */
  readonly threadPitchMm: number;
}

/** A structured refusal of one structured hole spec (the shared battery). */
export interface StructuredHoleProblem {
  readonly code: "kernel/parameter-invalid" | "kernel/feature-input-invalid";
  readonly message: string;
}

/** The hole type of a selector value, or `null` outside 1–5. */
export function structuredHoleTypeOf(value: number): StructuredHoleType | null {
  for (const type of STRUCTURED_HOLE_TYPES) {
    if (HOLE_TYPE_VALUES[type] === value) return type;
  }
  return null;
}

/** The drill tip's axial extent: `(radius)/tan(θ/2)`, 0 for the flat 180°. */
export function holeTipExtentMm(radiusMm: number, tipAngleDeg: number): number {
  if (tipAngleDeg >= 180) return 0;
  return radiusMm / Math.tan(((tipAngleDeg / 2) * Math.PI) / 180);
}

/**
 * The shared structural battery of every structured hole submission — the
 * feature-level bounds the bridge checks before any kernel call and the
 * workbench's action battery mirrors before any commit. `null` when the
 * spec's AUTHORING domain holds (the target-relative verdicts — tip fit,
 * feature fit against the depth, the no-op miss — belong to the planner and
 * the post-condition, which need the target's extent).
 */
export function structuredHoleProblem(
  spec: StructuredHoleSpec,
): StructuredHoleProblem | null {
  const type = structuredHoleTypeOf(spec.type);
  if (type === null) {
    return {
      code: "kernel/parameter-invalid",
      message: `The hole type selector must be 1 = straight, 2 = counterbore, 3 = countersink, 4 = taper, or 5 = threaded (${String(spec.type)} given).`,
    };
  }
  if (type !== "threaded" && !(spec.diameterMm > 0)) {
    return {
      code: "kernel/parameter-invalid",
      message: `The hole's diameter must be strictly positive (${String(spec.diameterMm)} mm given) — a non-positive diameter cuts nothing.`,
    };
  }
  if (!(spec.depthMm > 0)) {
    return {
      code: "kernel/parameter-invalid",
      message: `The hole's depth must be strictly positive (${String(spec.depthMm)} mm given) — a non-positive depth cuts nothing.`,
    };
  }
  if (
    type === "straight" ||
    type === "counterbore" ||
    type === "countersink" ||
    type === "threaded"
  ) {
    if (!(spec.tipAngleDeg > 0) || spec.tipAngleDeg > 180) {
      return {
        code: "kernel/parameter-invalid",
        message: `The drill tip's included angle must sit in (0°, 180°] — 180° is the flat bottom (${String(spec.tipAngleDeg)}° given).`,
      };
    }
  }
  if (type === "counterbore") {
    if (!(spec.cboreDiameterMm > spec.diameterMm)) {
      return {
        code: "kernel/parameter-invalid",
        message: `The counterbore's diameter (${String(spec.cboreDiameterMm)} mm) must EXCEED the hole's (${String(spec.diameterMm)} mm) — an equal-or-narrower counterbore is the hole itself.`,
      };
    }
    if (!(spec.cboreDepthMm > 0)) {
      return {
        code: "kernel/parameter-invalid",
        message: `The counterbore's depth must be strictly positive (${String(spec.cboreDepthMm)} mm given).`,
      };
    }
  }
  if (type === "countersink") {
    if (!(spec.csinkDiameterMm > spec.diameterMm)) {
      return {
        code: "kernel/parameter-invalid",
        message: `The countersink's rim diameter (${String(spec.csinkDiameterMm)} mm) must EXCEED the hole's (${String(spec.diameterMm)} mm) — an equal-or-narrower cone is the hole itself.`,
      };
    }
    if (!(spec.csinkAngleDeg > 0) || spec.csinkAngleDeg >= 180) {
      return {
        code: "kernel/parameter-invalid",
        message: `The countersink's included angle must sit in (0°, 180°) (${String(spec.csinkAngleDeg)}° given).`,
      };
    }
  }
  if (type === "taper") {
    if (!(spec.taperAngleDeg > 0) || spec.taperAngleDeg >= 180) {
      return {
        code: "kernel/parameter-invalid",
        message: `The taper's included angle must sit in (0°, 180°) (${String(spec.taperAngleDeg)}° given).`,
      };
    }
  }
  if (type === "threaded") {
    if (!(spec.threadMajorMm > 0)) {
      return {
        code: "kernel/parameter-invalid",
        message: `The thread's major diameter must be strictly positive (${String(spec.threadMajorMm)} mm given).`,
      };
    }
    if (!(spec.threadPitchMm > 0)) {
      return {
        code: "kernel/parameter-invalid",
        message: `The thread's pitch must be strictly positive (${String(spec.threadPitchMm)} mm given) — a zero pitch is not a thread.`,
      };
    }
  }
  return null;
}

/** One planned hole position's tool set (the revolved meridian [+ thread]). */
export interface StructuredHolePositionPlan {
  /** The revolved meridian tool (pilot for the threaded type). */
  readonly revolveTool: ProfileRevolveInput;
  /** The Phase 40 ISO ridge sweep — present for the threaded type only. */
  readonly threadTool?: HelixSweepInput;
}

/** The planned cut of one structured hole at every position. */
export interface StructuredHolePlan {
  /** One tool set per position, in the given order. */
  readonly positions: readonly StructuredHolePositionPlan[];
  /** Whether the hole drills through (`depth ≥ extent` along the axis). */
  readonly through: boolean;
  /** The threaded type's ISO minor diameter (its pilot's diameter, mm). */
  readonly threadMinorDiameterMm: number | null;
}

/**
 * The position-count ceiling (the pattern limit's discipline): one bridge
 * call issues one revolve (and for threaded holes one sweep) per position
 * synchronously, so the bound keeps a stray point-cloud sketch from wedging
 * regeneration; larger sets compose from the Phase 43 pattern features.
 */
export const HOLE_POSITION_LIMIT = 1000;

/** The rotation carrying local +y onto a unit direction (Rodrigues form). */
export function rotationAligningYTo(
  direction: readonly [number, number, number],
): {
  readonly axis: readonly [number, number, number];
  readonly angleRad: number;
} {
  // y × d = (d₂, 0, −d₀); y · d = d₁.
  const cross = [direction[2], 0, -direction[0]] as const;
  const sin = Math.hypot(cross[0], cross[1], cross[2]);
  const cos = direction[1];
  if (sin < 1e-12) {
    return cos > 0
      ? { axis: [1, 0, 0], angleRad: 0 }
      : { axis: [1, 0, 0], angleRad: Math.PI };
  }
  return {
    axis: [cross[0] / sin, cross[1] / sin, cross[2] / sin],
    angleRad: Math.atan2(sin, cos),
  };
}

/**
 * The in-plane position basis of the WORLD-AXIS structured form: the two
 * world axes in order, skipping the hole axis — `planHoleCut`'s documented
 * mapping, carried to the planner's (u, v) convention. The bridge and the
 * worker scene both resolve through THIS one source.
 */
export function structuredHoleWorldInPlaneAxes(axis: 1 | 2 | 3): {
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
} {
  if (axis === 1) return { u: [0, 1, 0], v: [0, 0, 1] };
  if (axis === 2) return { u: [1, 0, 0], v: [0, 0, 1] };
  return { u: [1, 0, 0], v: [0, 1, 0] };
}

/**
 * The in-plane position basis of the DATUM-AXIS structured form: the
 * rotated frame's local x and local z axes (the frame whose +y the hole
 * axis is — `rotationAligningYTo`), the `planHoleCutWithAxis` convention's
 * twin for the revolved tool's frame. One source for the bridge and the
 * worker scene.
 */
export function structuredHoleDatumInPlaneAxes(
  direction: readonly [number, number, number],
): {
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
} {
  const rotation = rotationAligningYTo(direction);
  // The Rodrigues matrix R(k, θ) = cosθ·I + sinθ·[k]× + (1−cosθ)·kkᵀ; the
  // basis vectors are its COLUMN 0 (local x's image R·e₀) and COLUMN 2
  // (local z's image R·e₂), expanded by hand:
  //   R·e₀ = (c + (1−c)k₀²,  s·k₂ + (1−c)k₀k₁, −s·k₁ + (1−c)k₀k₂)
  //   R·e₂ = (s·k₁ + (1−c)k₀k₂, −s·k₀ + (1−c)k₁k₂,  c + (1−c)k₂²)
  const k = rotation.axis;
  const cos = Math.cos(rotation.angleRad);
  const sin = Math.sin(rotation.angleRad);
  const scale = 1 - cos;
  return {
    u: [
      cos + scale * k[0] * k[0],
      sin * k[2] + scale * k[0] * k[1],
      -sin * k[1] + scale * k[0] * k[2],
    ],
    v: [
      sin * k[1] + scale * k[0] * k[2],
      -sin * k[0] + scale * k[1] * k[2],
      cos + scale * k[2] * k[2],
    ],
  };
}

/** One meridian vertex: (x = radius ≥ 0, y = axial distance from the base). */
type MeridianPoint = readonly [number, number];

/** Builds the closed line-segment loop of a meridian polygon. */
function meridianLoop(
  points: readonly MeridianPoint[],
): readonly ProfileSegmentInput[] {
  const loop: ProfileSegmentInput[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const start = points[i];
    const end = points[(i + 1) % points.length];
    if (start === undefined || end === undefined) continue;
    loop.push({
      kind: "line",
      start: [start[0], start[1]],
      end: [end[0], end[1]],
    });
  }
  return loop;
}

/** The bounds corner projection extremes along `direction` (entry, floor). */
function projectionExtremes(
  bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  },
  direction: readonly [number, number, number],
): { readonly entry: number; readonly floor: number } {
  let entry = -Infinity;
  let floor = Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const projection =
          x * direction[0] + y * direction[1] + z * direction[2];
        entry = Math.max(entry, projection);
        floor = Math.min(floor, projection);
      }
    }
  }
  return { entry, floor };
}

/**
 * Plans one structured hole's tools against the target's measured bounds
 * (see the module doc for every convention). Pure and kernel-independent:
 * the bridge and the worker scene feed it the same spec, positions, in-plane
 * basis, axis direction, and bounds and get the identical cut.
 *
 * `positions` are in-plane (u, v) pairs in the caller-resolved basis; the
 * axis line of position (u, v) is `u·inPlaneU + v·inPlaneV + t·axis`
 * (through the world origin's plane, the flat form's axis-line convention).
 * `axisDirection` must be a unit vector pointing OUT of the entry face (the
 * callers' bounds-projected rule); `inPlaneU`/`inPlaneV` need not be unit or
 * orthogonal to float tolerance but are expected as the resolved basis.
 */
export function planStructuredHoleCut(input: {
  readonly spec: StructuredHoleSpec;
  readonly positions: readonly {
    readonly u: number;
    readonly v: number;
  }[];
  readonly axisDirection: readonly [number, number, number];
  readonly inPlaneU: readonly [number, number, number];
  readonly inPlaneV: readonly [number, number, number];
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
}):
  | { readonly ok: true; readonly plan: StructuredHolePlan }
  | { readonly ok: false; readonly problem: StructuredHoleProblem } {
  const structural = structuredHoleProblem(input.spec);
  if (structural !== null) return { ok: false, problem: structural };
  const type = structuredHoleTypeOf(input.spec.type);
  if (type === null) {
    return {
      ok: false,
      problem: {
        code: "kernel/parameter-invalid",
        message: "The hole type selector is outside 1–5.",
      },
    };
  }
  if (input.positions.length === 0) {
    return {
      ok: false,
      problem: {
        code: "kernel/feature-input-invalid",
        message:
          "The hole declares no positions: a positions sketch must carry at least one point, or the feature must carry positionX/positionY parameters.",
      },
    };
  }
  if (input.positions.length > HOLE_POSITION_LIMIT) {
    return {
      ok: false,
      problem: {
        code: "kernel/feature-input-invalid",
        message: `The hole declares ${String(input.positions.length)} positions; the ceiling is ${String(HOLE_POSITION_LIMIT)} per feature (larger sets compose from pattern features).`,
      },
    };
  }

  const d = input.axisDirection;
  const { entry, floor } = projectionExtremes(input.bounds, d);
  const extent = entry - floor;
  const degreesToRad = (deg: number) => (deg * Math.PI) / 180;

  // The threaded type's pilot rides the ISO basic minor diameter; every
  // other type's hole radius is its own diameter's half.
  const pilotDiameterMm =
    type === "threaded"
      ? isoThreadMinorDiameter(
          input.spec.threadMajorMm,
          input.spec.threadPitchMm,
        )
      : input.spec.diameterMm;
  const r = pilotDiameterMm / 2;

  // The tip extent and the entry-side feature extents (computed now; judged
  // against the tool's own depth below).
  const hTip = holeTipExtentMm(r, input.spec.tipAngleDeg);
  const hCs =
    type === "countersink"
      ? (input.spec.csinkDiameterMm / 2 - r) /
        Math.tan(degreesToRad(input.spec.csinkAngleDeg / 2))
      : 0;
  let entryFeatureMm = 0;
  if (type === "counterbore") entryFeatureMm = input.spec.cboreDepthMm;
  if (type === "countersink") entryFeatureMm = hCs;

  // The tool's axial extent below the entry face and the through/blind
  // verdict. A through hole (`depth ≥ extent`) spans `extent + overshoot`
  // below the entry so the cut opens cleanly past the far face — the
  // authored depth has then done its job (the through test) and the tool's
  // own depth bounds the meridian. A blind hole's base is the authored
  // depth (to the tip point). The TAPER's walls may close first: its
  // effective depth is `min(depth, close)`, its through verdict is
  // GEOMETRIC (the walls reached the far face), and a through taper whose
  // walls survive the far face extends to `extent + overshoot` (clamped to
  // the closing point).
  const ov = HOLE_TOOL_OVERSHOOT_MM;
  let toolDepth: number;
  let through: boolean;
  let rTopExtra = 0;
  if (type === "taper") {
    const slope = Math.tan(degreesToRad(input.spec.taperAngleDeg / 2));
    const closeMm = r / slope;
    const depthEff = Math.min(input.spec.depthMm, closeMm);
    through = depthEff >= extent;
    toolDepth = through
      ? Math.min(Math.max(depthEff, extent + ov), closeMm)
      : depthEff;
    // Above the entry face the taper line continues widening through the
    // overshoot collar (outside the material — it removes nothing there).
    rTopExtra = ov * slope;
  } else {
    through = input.spec.depthMm >= extent;
    toolDepth = through ? extent + ov : input.spec.depthMm;
  }
  // The tip below and the entry feature above must BOTH fit the tool with a
  // straight hole section between them — on a blind hole this is the
  // authored depth's own arithmetic; on a through hole the tool's span past
  // the far face is the bound (a tip or counterbore deeper than the target
  // is a taper/cone by geometry, a different hole — refuse, named).
  if (type !== "taper" && hTip + entryFeatureMm >= toolDepth) {
    const feature =
      type === "counterbore"
        ? `the counterbore's ${String(input.spec.cboreDepthMm)} mm`
        : type === "countersink"
          ? `the countersink's ${String(hCs.toFixed(6))} mm cone`
          : "the tip";
    return {
      ok: false,
      problem: {
        code: "kernel/parameter-invalid",
        message: `The hole cannot hold ${feature} plus the ${String(hTip.toFixed(6))} mm drill tip inside its ${String(toolDepth.toFixed(6))} mm tool depth and still cut a straight section — deepen the hole, shallow the entry feature, or widen the tip angle.`,
      },
    };
  }
  const span = toolDepth + ov;
  const baseT = entry - toolDepth;
  // The entry face's meridian height (the y the entry sits at).
  const zEntry = span - ov;

  // The meridian, CCW from the base-centre vertex.
  let points: readonly MeridianPoint[];
  switch (type) {
    case "straight":
    case "threaded":
    case "counterbore":
    case "countersink": {
      const tipVertex: MeridianPoint = hTip === 0 ? [r, 0] : [r, hTip];
      if (type === "counterbore") {
        const R = input.spec.cboreDiameterMm / 2;
        const yCb = zEntry - input.spec.cboreDepthMm;
        points = [[0, 0], tipVertex, [r, yCb], [R, yCb], [R, span], [0, span]];
      } else if (type === "countersink") {
        const Rcs = input.spec.csinkDiameterMm / 2;
        const yCs = zEntry - hCs;
        points = [
          [0, 0],
          tipVertex,
          [r, yCs],
          [Rcs, zEntry],
          [Rcs, span],
          [0, span],
        ];
      } else {
        points = [[0, 0], tipVertex, [r, span], [0, span]];
      }
      break;
    }
    case "taper": {
      const slope = Math.tan(degreesToRad(input.spec.taperAngleDeg / 2));
      const rTop = input.spec.diameterMm / 2 + rTopExtra;
      const rBase = r - toolDepth * slope;
      // The truncated taper keeps a small flat base; the closing taper ends
      // at its point (a zero-length base edge would be degenerate input —
      // sub-nanometre remainders round to the closing form).
      points =
        rBase > 1e-9
          ? [
              [0, 0],
              [rBase, 0],
              [rTop, span],
              [0, span],
            ]
          : [
              [0, 0],
              [rTop, span],
              [0, span],
            ];
      break;
    }
  }

  // The placement shared by every position: the rotation pointing the
  // meridian's local +y (its revolve axis) along the hole axis, then the
  // per-position translation onto the position's axis line at the tool base.
  const rotation = rotationAligningYTo(d);
  const loop = meridianLoop(points);

  // The threaded type's ridge sweep: Phase 40's internal-mode tool from the
  // entry point on each position's axis line, advancing INTO the material
  // (the thread's own documented convention), along the cylindrical section
  // (blind) or the authored depth (through — the extra turns remove nothing
  // past the far face). Right-handed, start angle 0 (deterministic picks).
  const threadLengthMm =
    type === "threaded"
      ? through
        ? input.spec.depthMm
        : input.spec.depthMm - hTip
      : 0;

  const positions: StructuredHolePositionPlan[] = input.positions.map(
    (position) => {
      const translation: readonly [number, number, number] = [
        baseT * d[0] +
          position.u * input.inPlaneU[0] +
          position.v * input.inPlaneV[0],
        baseT * d[1] +
          position.u * input.inPlaneU[1] +
          position.v * input.inPlaneV[1],
        baseT * d[2] +
          position.u * input.inPlaneU[2] +
          position.v * input.inPlaneV[2],
      ];
      const revolveTool: ProfileRevolveInput = {
        loop,
        axis: { point: [0, 0], direction: [0, 1] },
        angle: angleValue(2 * Math.PI),
        placement: {
          rotation: {
            axis: rotation.axis,
            angle: angleValue(rotation.angleRad, "rad"),
          },
          translation: {
            x: lengthValue(translation[0]),
            y: lengthValue(translation[1]),
            z: lengthValue(translation[2]),
          },
        },
      };
      if (type !== "threaded") return { revolveTool };
      const entryPoint: readonly [number, number, number] = [
        translation[0] + zEntry * d[0],
        translation[1] + zEntry * d[1],
        translation[2] + zEntry * d[2],
      ];
      const thread = planThreadCut({
        majorDiameterMm: input.spec.threadMajorMm,
        pitchMm: input.spec.threadPitchMm,
        lengthMm: threadLengthMm,
        mode: "internal",
        handedness: 1,
        startAngleRad: 0,
        advanceDirection: [-d[0], -d[1], -d[2]],
        axisBaseMm: entryPoint,
      });
      return { revolveTool, threadTool: thread.tool };
    },
  );

  return {
    ok: true,
    plan: {
      positions,
      through,
      threadMinorDiameterMm:
        type === "threaded"
          ? isoThreadMinorDiameter(
              input.spec.threadMajorMm,
              input.spec.threadPitchMm,
            )
          : null,
    },
  };
}

/**
 * The analytic removed volume of one structured hole position in DEEP
 * stock (material everywhere the tool touches): the authoring fixtures'
 * shared expectation — cylinders, cones, and frustums by their closed
 * forms, the threaded pilot plus Phase 40's exact screw volume. Straight-
 * edge meridians make this the TRUE removed volume on the exact kernels
 * (fake Pappus, OCCT analytic); the mesh kernels sit inside their
 * documented chord band.
 */
export function structuredHoleAnalyticVolumeMm3(
  spec: StructuredHoleSpec,
): number {
  const type = structuredHoleTypeOf(spec.type);
  const cylinder = (radius: number, height: number) =>
    Math.PI * radius * radius * height;
  const coneFrustrum = (rSmall: number, rLarge: number, height: number) =>
    (Math.PI * height * (rSmall * rSmall + rSmall * rLarge + rLarge * rLarge)) /
    3;
  if (type === "taper") {
    const r0 = spec.diameterMm / 2;
    const slope = Math.tan(((spec.taperAngleDeg / 2) * Math.PI) / 180);
    const depthEff = Math.min(spec.depthMm, r0 / slope);
    return coneFrustrum(r0 - depthEff * slope, r0, depthEff);
  }
  const pilotDiameterMm =
    type === "threaded"
      ? isoThreadMinorDiameter(spec.threadMajorMm, spec.threadPitchMm)
      : spec.diameterMm;
  const r = pilotDiameterMm / 2;
  const hTip = holeTipExtentMm(r, spec.tipAngleDeg);
  // The tip cone plus the cylindrical remainder of the authored depth.
  let volume = coneFrustrum(0, r, hTip) + cylinder(r, spec.depthMm - hTip);
  if (type === "counterbore") {
    volume +=
      cylinder(spec.cboreDiameterMm / 2, spec.cboreDepthMm) -
      cylinder(r, spec.cboreDepthMm);
  }
  if (type === "countersink") {
    const hCs =
      (spec.csinkDiameterMm / 2 - r) /
      Math.tan(((spec.csinkAngleDeg / 2) * Math.PI) / 180);
    volume += coneFrustrum(r, spec.csinkDiameterMm / 2, hCs) - cylinder(r, hCs);
  }
  if (type === "threaded") {
    // The ISO ridge's exact screw volume — Phase 40's own closed form over
    // the ridge trapezoid (`τ·A·(R̄ + ū)`), swept the cylindrical section's
    // length (the tip's height off the authored depth, the planner's own
    // blind-thread length).
    volume += helixScrewVolume(
      helixProfilePolygon(
        isoThreadToolLoop({ pitchMm: spec.threadPitchMm, mode: "internal" }),
      ),
      threadHelixSpine({
        majorDiameterMm: spec.threadMajorMm,
        pitchMm: spec.threadPitchMm,
        lengthMm: spec.depthMm - hTip,
        handedness: 1,
        startAngleRad: 0,
      }),
    );
  }
  return volume;
}
