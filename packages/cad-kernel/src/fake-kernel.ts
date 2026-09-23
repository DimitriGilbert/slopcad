/**
 * The deterministic fake kernel (Phase 8): a fast, dependency-free
 * reference implementation of the kernel contract. It exists so the
 * contract, the contract suite, and the cad-core executor bridge can be
 * exercised in tests without a real geometry engine, and it defines the
 * baseline semantics every real kernel (Manifold in Phase 9, OpenCascade
 * later) must reproduce.
 *
 * ## Representation
 *
 * Solids are symbolic CSG trees of the four primitives plus boolean nodes
 * and translation nodes — every operation is a pure tree construction, so
 * the kernel is trivially deterministic: no meshes are built until
 * `tessellate` asks for one, and every measurement is a pure function of
 * the tree.
 *
 * ## Measurement semantics
 *
 * - Primitive volumes are analytic (exact): `w·d·h`, `4/3·π·r³`, `π·r²·h`,
 *   and the frustum formula `π·h·(rb²+rb·rt+rt²)/3` (which degenerates to
 *   the sharp-cone formula at `rt = 0`).
 * - Primitive bounds are exact axis-aligned boxes per the contract's
 *   placement conventions.
 * - Boolean volumes are measured by deterministic voxel quadrature: a fixed
 *   {@link FAKE_KERNEL_VOLUME_RESOLUTION}³ grid of cell-centre sample points
 *   over the node's conservative bounds, each classified by exact
 *   point-in-primitive tests, volume = inside-count × cell volume. This is
 *   exact when boolean boundaries align with the sample box (axis-aligned
 *   box booleans) and carries small documented error on curved boundaries —
 *   hence `exactBooleanVolumes: false` in the capabilities.
 * - Boolean bounds: exact (tight) for unions — the hull of operand boxes is
 *   always the tight union box; conservative (containing) for subtract (the
 *   target's box) and intersect (the operand boxes' intersection) — hence
 *   `tightBooleanBounds: false`. Translation shifts bounds exactly.
 * - An empty solid (sampled inside-count 0) has volume 0, an empty
 *   tessellation, and `bounds` fails with `kernel/bounds-empty`. Emptiness
 *   by sampling is one-sided: a non-empty sample proves the solid exists,
 *   while a solid smaller than one sample cell of its own bounds may
 *   quantify as empty.
 *
 * ## Tessellation semantics
 *
 * Primitives produce fixed canonical meshes (a 12-triangle box; a UV sphere
 * of {@link FAKE_KERNEL_TESSELLATION_SEGMENTS} segments ×
 * {@link FAKE_KERNEL_TESSELLATION_RINGS} rings; segment-based cylinder and
 * cone fans) — triangle counts are closed-form functions of those constants.
 * Every canonical triangle is wound counter-clockwise seen from outside the
 * solid, so the per-facet normal (the normalized cross product of a
 * triangle's edges) always points away from the material: honest kernel
 * normals require consistent winding, and the fake kernel's normals are
 * exactly those per-facet normals, one per triangle corner — flat shading,
 * truthful for the faceted meshes it serves. Booleans emit the depth-first
 * concatenation of their primitive leaves' triangles, keeping exactly the
 * triangles fully inside the node's conservative bounds: a deterministic
 * candidate soup that is contract-valid (indexed, finite, inside bounds)
 * but not the exact boolean surface — semantic truth for booleans lives in
 * `volume`/`bounds`, never in the soup. Translations shift triangles (and
 * their unchanged normals) exactly; mirrors (Phase 26.9) reflect triangle
 * corners and SWAP each triangle's winding — the reflection inverts
 * orientation, so the swap restores the outward-facing facet order and the
 * per-facet normals come out reflected-and-negated, outward.
 *
 * Volume is memoized per handle (WeakMap), so repeated `volume` calls are
 * cheap; `tessellate` recomputes from the tree on every call, which
 * determinism guarantees to agree.
 */

import {
  angle as angleValue,
  type LengthValue,
  length as lengthValue,
  fail,
  ok,
  valueIn,
} from "@slopcad/cad-core";
import type { KernelCapabilities } from "./capabilities";

import { type KernelBackendId } from "./backend-ids";
import {
  type BoxInput,
  type ChamferInput,
  type ConeInput,
  type CylinderInput,
  type FilletInput,
  type GeometryKernel,
  type HelixSweepInput,
  type KernelBounds,
  type KernelError,
  type KernelErrorCode,
  type KernelResult,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  type MirrorInput,
  type MoveFaceInput,
  type DeleteFaceInput,
  type ProfileExtrudeInput,
  type ProfileLoftInput,
  type ProfileRevolveInput,
  type ProfileSweepInput,
  type ProfileSweepWireInput,
  type IntersectionCurveInput,
  type ReplaceFaceInput,
  type SheetSurfaceInput,
  type DeleteFaceKeepInput,
  type SheetReplaceFaceInput,
  type SheetThickenInput,
  type SheetOffsetInput,
  type SheetFillPatchInput,
  type SheetUnstitchInput,
  type SheetKnitInput,
  type SheetExtendInput,
  type SheetUntrimInput,
  type SheetTrimInput,
  type ShellInput,
  type SectionFaceMeasure,
  type SectionInput,
  type SectionResult,
  type DeleteFaceKeepResult,
  type SphereInput,
  type Tessellation,
  type ThickenInput,
  type TransformInput,
  type KernelWire,
  type WireCurveInput,
} from "./contract";
import { planSplitCut } from "./core-bridge";
import { createSolidTag } from "./opaque";
import {
  type TransportFrame,
  canonicalizeCurve,
  curveLength,
  curvePolyline,
  curveRecordProblems,
  evaluateWire,
  parallelTransportFrames,
  wireG1FailureIndex,
} from "./curve-geometry";
import {
  type CanonicalHelixSpine,
  helixProfilePolygon,
  helixScrewContains,
  helixScrewVolume,
  helixStations,
  helixSweepProblem,
  helixTransportPoint,
  helixTurnsOverlap,
  helixUntaperedLocalBounds,
} from "./helix-geometry";
import {
  applyMatrix3,
  axisAngleMatrix,
  decomposeSweepPath,
  loftAnalyticVolume,
  loftSectionPolygons,
  loftSectionsProblem,
  loftStations,
  morphPolygons,
  normalizeRevolveAxis,
  type ProfilePoint2,
  pointInPolygon,
  polygonSignedArea,
  PROFILE_MAX_SEGMENT_ANGLE_RAD,
  profileLoopProblem,
  revolveCrossesAxis,
  revolvePappusVolume,
  REVOLVE_AXIS_TOUCH_TOLERANCE_MM,
  revolveSignedExtremes,
  sweepAnalyticVolume,
  type SweepPiece,
  sweepPathClosed,
  sweepPathProblem,
  sweepPathSelfIntersects,
  sweepPieceStations,
  sweepProfileArcAxisCrossing,
  type SweepStation,
  tessellateProfileLoop,
  tessellateRevolveProfile,
  transpose3,
} from "./profile-geometry";
import {
  insetPolygon,
  taperInsetDistanceMm,
  taperedExtrudeProblem,
} from "./taper-geometry";

/** Voxel-quadrature resolution (samples per axis) for boolean volumes. */
export const FAKE_KERNEL_VOLUME_RESOLUTION = 64;

/** Longitude segments of the fake kernel's canonical curved meshes. */
export const FAKE_KERNEL_TESSELLATION_SEGMENTS = 16;

/** Latitude rings of the fake kernel's canonical sphere mesh. */
export const FAKE_KERNEL_TESSELLATION_RINGS = 8;

/**
 * Capabilities of the fake kernel: full contract support with
 * translation-only transforms (a rotation input is rejected outright, not
 * silently dropped — the axis-aligned shape model cannot honour it);
 * primitive volumes analytic; boolean volumes voxel-quantized; boolean
 * bounds conservative outside unions; no persistent topology (that arrives
 * with the OpenCascade backend); the Phase 26.3 sweep — the analytic
 * Pappus decomposition is exact over the chord polygon, the reference
 * implementation the real kernels are judged against; the Phase 26.4
 * loft — the Simpson/prismoidal decomposition over the CCW chord polygons,
 * exact for the linear morph model, the reference the loftring kernels are
 * judged against; and the Phase 26.5 fillet — the analytic corner-fillet
 * model over its documented box-edge subset (a pristine box leaf, one
 * parallel edge group, disjoint removed quadrants), exact volume,
 * membership, and bounds, with everything outside the subset declined
 * structurally — plus the Phase 26.6 chamfer, the same subset discipline
 * over the corner-PRISM model (the right-isoceles `d²/2` cross-section the
 * symmetric distance cuts), exact everywhere it accepts — and the Phase
 * 26.7 shell, the analytic open-box model over its documented single-face
 * subset (a pristine box leaf with exactly ONE face removed: the inset
 * cavity `cross × (openExtent − t)` is exact for uniform thickness),
 * exact volume, membership, bounds, and a fully planar canonical mesh,
 * everything outside the subset declined structurally; and the Phase
 * 26.9 mirror — the pointwise reflection model (classify at the
 * reflected query, reflect the interval bounds, delegate the volume,
 * reflect the triangles and swap each winding), exact over EVERY shape
 * the tree can hold, no subset needed; and the Phase 40 helix — the
 * analytic SCREW-SOLID model (exact closed-form volume, exact
 * inverse-screw membership, exact untapered bounds, a deterministic
 * station soup at the shared deflection), declining only OVERLAPPING
 * turns with the structured `kernel/helix-turn-overlap` because the
 * multiplicity integral would overcount there — the thread tool's
 * profile-height < pitch keeps every real ISO thread inside the subset.
 */
export const FAKE_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: false,
  transformScale: true,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: false,
  tightBooleanBounds: false,
  persistentTopology: false,
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
  sheets: false,
  surfaceOps: false,
  localFaceOps: false,
  section: true,
  sweepWire: true,
  intersectionCurve: false,
});

/** The fake kernel's backend id. */
export const FAKE_KERNEL_ID: KernelBackendId = "fake";

/** The triangle count of the fake kernel's canonical box mesh. */
export const FAKE_BOX_TRIANGLE_COUNT = 12;

type Axis = 0 | 1 | 2;
type Vec3 = readonly [number, number, number];

/** Reads a canonical vector component; internal vectors are always triples. */
function at(vector: Vec3, axis: Axis): number {
  const value = vector[axis];
  if (value === undefined) {
    throw new Error(
      "Invariant violation: a canonical vector always has three components.",
    );
  }
  return value;
}

/** Reads a bounds corner component; internal bounds are always triples. */
function boundsAt(
  bounds: KernelBounds,
  corner: "min" | "max",
  axis: Axis,
): number {
  const value = bounds[corner][axis];
  if (value === undefined) {
    throw new Error(
      "Invariant violation: kernel bounds always have three components.",
    );
  }
  return value;
}

/** The four primitive tree nodes. */
type Primitive =
  | { readonly kind: "box"; readonly size: Vec3 }
  | { readonly kind: "sphere"; readonly radius: number }
  | {
      readonly kind: "cylinder";
      readonly radius: number;
      readonly height: number;
    }
  | {
      readonly kind: "cone";
      readonly bottomRadius: number;
      readonly topRadius: number;
      readonly height: number;
    };

/** The symbolic CSG tree a fake-kernel handle wraps. */
type FakeShape =
  | Primitive
  | { readonly kind: "union"; readonly operands: readonly FakeShape[] }
  | {
      readonly kind: "subtract";
      readonly target: FakeShape;
      readonly tools: readonly FakeShape[];
    }
  | { readonly kind: "intersect"; readonly operands: readonly FakeShape[] }
  | {
      readonly kind: "translate";
      readonly source: FakeShape;
      readonly offset: Vec3;
    }
  | {
      /**
       * The Phase 41 uniform scale node: `source` scaled by the strictly
       * positive `factor` about the world origin. A uniform scale is not
       * an isometry, so like the mirror node it cannot fold into a
       * rotation+translation pair and stands alone; every consumer
       * answers pointwise through it (bounds ×f, volume ×f³ via
       * delegation, membership at the inverse-scaled query, triangles
       * scaled — orientation preserved by the positive factor).
       */
      readonly kind: "scale";
      readonly source: FakeShape;
      readonly factor: number;
    }
  | {
      /**
       * The Phase 41 closed-hollow node: `target` minus its inward offset
       * by `thickness` — the complement of the shell node's open hollow.
       * Modelled exactly over the pristine box and sphere leaves (see the
       * `thicken` operation's subset docs); membership is the pointwise
       * `in target ∧ ¬(strictly inside the inset)`.
       */
      readonly kind: "thickened";
      readonly target: FakeShape;
      readonly thickness: number;
    }
  | {
      /**
       * The Phase 26.9 mirror node: the reflection of `source` through
       * the world axis plane `coordinate = planeOffset` on `axis`. Unlike
       * every other node, this one CANNOT be folded into a placement or
       * an offset — a reflection composes with rotations into orthogonal
       * transforms of negative determinant, which no rotation+translation
       * pair expresses — so it stands alone and every consumer (bounds,
       * volume, membership, tessellation) answers pointwise through it.
       */
      readonly kind: "mirror";
      readonly source: FakeShape;
      /** The reflected axis (0 = x, 1 = y, 2 = z). */
      readonly axis: Axis;
      /** The plane's signed position along the axis (mm). */
      readonly planeOffset: number;
    }
  | {
      readonly kind: "extrusion";
      /** The loop's chord polygon in the LOCAL workplane frame (mm). */
      readonly polygon: readonly ProfilePoint2[];
      /** Strictly positive extrusion length (mm). */
      readonly height: number;
      /** Local z of the base face: 0 for +1, −height for −1. */
      readonly baseZ: number;
      /** World placement: rotation (row-major) applied first, then translation. */
      readonly rotation: readonly (readonly [number, number, number])[];
      readonly translation: Vec3;
    }
  | {
      readonly kind: "revolution";
      /**
       * The loop's chord polygon in AXIS coordinates — x = axial, y =
       * signed radial — normalized CCW (mm). The profile never crosses
       * s = 0 (the crossing rejection precedes construction).
       */
      readonly polygon: readonly ProfilePoint2[];
      /** Sweep angle in radians, in (0, 2π]. */
      readonly sweep: number;
      /** Whether the profile sits on the +v side (its sweep starts at angle 0, not π). */
      readonly positiveSide: boolean;
      /** The axis frame in LOCAL coordinates: origin point, unit axial u, unit radial v (w = local +z). */
      readonly origin: Vec3;
      readonly u: Vec3;
      readonly v: Vec3;
      /** World placement: rotation (row-major) applied first, then translation. */
      readonly rotation: readonly (readonly [number, number, number])[];
      readonly translation: Vec3;
    }
  | {
      readonly kind: "sweep";
      /**
       * The loop's chord polygon in the profile's OWN (u, v) frame,
       * normalized CCW (mm) — its coordinates are invariant under the
       * fixed-binormal transport, so every piece addresses the profile
       * through this one polygon.
       */
      readonly polygon: readonly ProfilePoint2[];
      /** The validated path, decomposed into its transport pieces. */
      readonly pieces: readonly SweepPiece[];
      /** Whether the path closes on itself (a ring: the mesh has no caps). */
      readonly closed: boolean;
      /** World placement: rotation (row-major) applied first, then translation. */
      readonly rotation: readonly (readonly [number, number, number])[];
      readonly translation: Vec3;
    }
  | {
      readonly kind: "wireSweep";
      /**
       * The profile's CCW chord polygon in its OWN local (x, y) frame
       * (mm) — transported rigidly, so every station addresses the
       * profile through this one polygon.
       */
      readonly polygon: readonly ProfilePoint2[];
      /**
       * The parallel-transport frames along the spine's station polyline
       * (LOCAL space; the placement composes on top). Volume is
       * Cavalieri-exact `|A|·L`; membership is the nearest-station frame
       * projection (exact for straight spines, the documented station
       * approximation for curved ones); tessellation is the station loft
       * at the shared deflection.
       */
      readonly frames: readonly TransportFrame[];
      /** The spine's walked length (mm) — the Cavalieri L. */
      readonly spineLength: number;
      /** World placement: rotation (row-major) applied first, then translation. */
      readonly rotation: readonly (readonly [number, number, number])[];
      readonly translation: Vec3;
    }
  | {
      readonly kind: "loft";
      /**
       * The sections' CCW chord polygons (mm), in list order — the
       * validated collection carries equal vertex counts, so the morph's
       * index correspondence pairs polygon j's vertex i with polygon
       * j+1's vertex i.
       */
      readonly polygons: readonly (readonly ProfilePoint2[])[];
      /** The strictly increasing station z values (mm), in list order. */
      readonly stations: readonly number[];
      /** World placement: rotation (row-major) applied first, then translation. */
      readonly rotation: readonly (readonly [number, number, number])[];
      readonly translation: Vec3;
    }
  | {
      readonly kind: "helix";
      /**
       * The profile's CCW chord polygon in MERIDIAN coordinates —
       * `(x, y) = (radial offset, axial offset)` from the spine's start
       * point (mm). The screw-solid model addresses the profile through
       * this one polygon everywhere: volume, membership, bounds, and the
       * station soup.
       */
      readonly polygon: readonly ProfilePoint2[];
      /** The canonical analytic spine (see ./helix-geometry). */
      readonly spine: CanonicalHelixSpine;
      /** World placement: rotation (row-major) applied first, then translation. */
      readonly rotation: readonly (readonly [number, number, number])[];
      readonly translation: Vec3;
    }
  | {
      readonly kind: "fillet";
      /**
       * The filleted box's extents (mm) — the fillet node's domain is a
       * pristine box leaf (the analytic corner-fillet model's honest
       * subset; anything else the operation declines structurally).
       */
      readonly size: Vec3;
      /** The resolved selected edges, in the call's ordinal order. */
      readonly edges: readonly FakeBoxEdge[];
      /** The shared strictly positive radius (mm), validated to fit. */
      readonly radius: number;
    }
  | {
      readonly kind: "chamfer";
      /**
       * The chamfered box's extents (mm) — the chamfer node's domain is the
       * fillet subset verbatim: a pristine box leaf (the analytic
       * corner-prism model's honest subset; anything else the operation
       * declines structurally).
       */
      readonly size: Vec3;
      /** The resolved selected edges, in the call's ordinal order. */
      readonly edges: readonly FakeBoxEdge[];
      /** The shared strictly positive distance (mm), validated to fit. */
      readonly distance: number;
    }
  | {
      readonly kind: "shell";
      /**
       * The shelled box's extents (mm) — the shell node's domain is a
       * pristine box leaf with exactly ONE face removed (the analytic
       * open-box model's honest subset; anything else the operation
       * declines structurally).
       */
      readonly size: Vec3;
      /** The one removed face, resolved from the call's single ordinal. */
      readonly face: FakeBoxFace;
      /** The uniform strictly positive wall thickness (mm), validated to fit. */
      readonly thickness: number;
    };

/**
 * One box edge of the fake kernel's fillet/chamfer subset: its direction
 * axis and the box corner it passes through (the other two components
 * locate the edge; the `axis` component's coordinate is irrelevant to
 * identity and recorded as 0).
 */
interface FakeBoxEdge {
  /** The edge's direction axis (0 = x, 1 = y, 2 = z). */
  readonly axis: Axis;
  /** The box corner the edge passes through (mm; axis component 0). */
  readonly corner: Vec3;
}

/**
 * The fake kernel's box-edge ordinal table — its own documented,
 * deterministic edge numbering, the equivalent of a topology snapshot's
 * `(kind: "edge", ordinal)` addresses for the only solid the fillet and
 * chamfer subsets accept (a box). Ordinals 0-3 run along x, 4-7 along y,
 * 8-11 along z; within each axis group the two non-axis coordinates
 * enumerate in (low, high) order per axis: x-edges by (y, z), y-edges by
 * (x, z), z-edges by (x, y). This table is the fake kernel's OWN
 * convention — the OCCT snapshot's box ordinals differ (its exploration
 * order is the engine's); cross-kernel ordinal transport is meaningless by
 * design, exactly like every other within-regeneration address.
 */
export const FAKE_BOX_EDGE_TABLE: readonly {
  readonly axis: Axis;
  readonly corner: readonly [number, number, number];
}[] = Object.freeze([
  { axis: 0, corner: [0, 0, 0] },
  { axis: 0, corner: [0, 1, 0] },
  { axis: 0, corner: [0, 0, 1] },
  { axis: 0, corner: [0, 1, 1] },
  { axis: 1, corner: [0, 0, 0] },
  { axis: 1, corner: [1, 0, 0] },
  { axis: 1, corner: [0, 0, 1] },
  { axis: 1, corner: [1, 0, 1] },
  { axis: 2, corner: [0, 0, 0] },
  { axis: 2, corner: [1, 0, 0] },
  { axis: 2, corner: [0, 1, 0] },
  { axis: 2, corner: [1, 1, 0] },
]);

/**
 * One axis-aligned face of the fake kernel's box shell subset: its normal
 * `axis` and which side of the box it caps (`high` false = the low face at
 * coordinate 0, true = the high face at coordinate `size`).
 */
interface FakeBoxFace {
  /** The face's normal axis (0 = x, 1 = y, 2 = z). */
  readonly axis: Axis;
  /** Whether the face caps the box's high side along its axis. */
  readonly high: boolean;
}

/**
 * The fake kernel's box-face ordinal table — its own documented,
 * deterministic face numbering for the only solid the shell subset accepts
 * (a box): ordinals 0-5 enumerate the faces grouped by normal axis (x, y,
 * z), low side before high within each group, so ordinal 5 is the box's
 * top (the z-high face). This table is the fake kernel's OWN convention —
 * the OCCT snapshot's box face ordinals differ (its exploration order is
 * the engine's, probed: the top face lands at ordinal 5 there too, by
 * coincidence of exploration, not by contract); cross-kernel ordinal
 * transport is meaningless by design, exactly like the edge addresses.
 */
export const FAKE_BOX_FACE_TABLE: readonly {
  readonly axis: 0 | 1 | 2;
  readonly high: boolean;
}[] = Object.freeze([
  { axis: 0, high: false },
  { axis: 0, high: true },
  { axis: 1, high: false },
  { axis: 1, high: true },
  { axis: 2, high: false },
  { axis: 2, high: true },
]);

/**
 * Resolves one entry of {@link FAKE_BOX_EDGE_TABLE} against a box's actual
 * extents: the 0/1 flags in the table's corners select the low or high
 * face per axis (a corner at the high face carries `size`, at the low face
 * `0`), and the edge's own axis coordinate is pinned to 0.
 */
function boxEdgeAt(size: Vec3, ordinal: number): FakeBoxEdge {
  const entry = FAKE_BOX_EDGE_TABLE[ordinal];
  if (entry === undefined) {
    throw new Error(
      "Invariant violation: fillet ordinals are validated against the table's length before resolution.",
    );
  }
  const { axis } = entry;
  const coordinate = (i: 0 | 1 | 2): number =>
    i === axis ? 0 : entry.corner[i] === 0 ? 0 : at(size, i);
  return { axis, corner: [coordinate(0), coordinate(1), coordinate(2)] };
}

/** A triangle of three canonical-space corners. */
type Triangle = readonly [Vec3, Vec3, Vec3];

function boundsOf(min: Vec3, max: Vec3): KernelBounds {
  return { min, max };
}

function shifted(vector: Vec3, offset: Vec3): Vec3 {
  return [
    at(vector, 0) + at(offset, 0),
    at(vector, 1) + at(offset, 1),
    at(vector, 2) + at(offset, 2),
  ];
}

function hullBounds(a: KernelBounds, b: KernelBounds): KernelBounds {
  return boundsOf(
    [
      Math.min(boundsAt(a, "min", 0), boundsAt(b, "min", 0)),
      Math.min(boundsAt(a, "min", 1), boundsAt(b, "min", 1)),
      Math.min(boundsAt(a, "min", 2), boundsAt(b, "min", 2)),
    ],
    [
      Math.max(boundsAt(a, "max", 0), boundsAt(b, "max", 0)),
      Math.max(boundsAt(a, "max", 1), boundsAt(b, "max", 1)),
      Math.max(boundsAt(a, "max", 2), boundsAt(b, "max", 2)),
    ],
  );
}

function intersectBounds(a: KernelBounds, b: KernelBounds): KernelBounds {
  return boundsOf(
    [
      Math.max(boundsAt(a, "min", 0), boundsAt(b, "min", 0)),
      Math.max(boundsAt(a, "min", 1), boundsAt(b, "min", 1)),
      Math.max(boundsAt(a, "min", 2), boundsAt(b, "min", 2)),
    ],
    [
      Math.min(boundsAt(a, "max", 0), boundsAt(b, "max", 0)),
      Math.min(boundsAt(a, "max", 1), boundsAt(b, "max", 1)),
      Math.min(boundsAt(a, "max", 2), boundsAt(b, "max", 2)),
    ],
  );
}

function shapeBounds(shape: FakeShape): KernelBounds {
  switch (shape.kind) {
    case "box":
      return boundsOf([0, 0, 0], shape.size);
    case "fillet":
      // The fillet removes corner material only: the rounded box's tight
      // AABB is exactly the box's.
      return boundsOf([0, 0, 0], shape.size);
    case "chamfer":
      // The chamfer removes corner material only, like the fillet: the
      // beveled box's tight AABB is exactly the box's.
      return boundsOf([0, 0, 0], shape.size);
    case "shell":
      // The shell keeps the box's full footprint (the walls own the outer
      // boundary; only interior material became the cavity): the shelled
      // box's tight AABB is exactly the box's.
      return boundsOf([0, 0, 0], shape.size);
    case "sphere":
      return boundsOf(
        [-shape.radius, -shape.radius, -shape.radius],
        [shape.radius, shape.radius, shape.radius],
      );
    case "cylinder":
      return boundsOf(
        [-shape.radius, -shape.radius, 0],
        [shape.radius, shape.radius, shape.height],
      );
    case "cone": {
      const reach = Math.max(shape.bottomRadius, shape.topRadius);
      return boundsOf([-reach, -reach, 0], [reach, reach, shape.height]);
    }
    case "union":
      return shape.operands.map(shapeBounds).reduce(hullBounds);
    case "subtract":
      return shapeBounds(shape.target);
    case "intersect":
      return shape.operands.map(shapeBounds).reduce(intersectBounds);
    case "translate": {
      const source = shapeBounds(shape.source);
      return boundsOf(
        [
          boundsAt(source, "min", 0) + at(shape.offset, 0),
          boundsAt(source, "min", 1) + at(shape.offset, 1),
          boundsAt(source, "min", 2) + at(shape.offset, 2),
        ],
        [
          boundsAt(source, "max", 0) + at(shape.offset, 0),
          boundsAt(source, "max", 1) + at(shape.offset, 1),
          boundsAt(source, "max", 2) + at(shape.offset, 2),
        ],
      );
    }
    case "scale": {
      // The strictly positive factor scales both interval endpoints, so
      // min/max stay min/max — the exact scaled AABB of the source.
      const source = shapeBounds(shape.source);
      return boundsOf(
        [
          boundsAt(source, "min", 0) * shape.factor,
          boundsAt(source, "min", 1) * shape.factor,
          boundsAt(source, "min", 2) * shape.factor,
        ],
        [
          boundsAt(source, "max", 0) * shape.factor,
          boundsAt(source, "max", 1) * shape.factor,
          boundsAt(source, "max", 2) * shape.factor,
        ],
      );
    }
    case "thickened":
      // The closed hollow keeps the target's full footprint (the walls own
      // the outer boundary; only interior material became the cavity).
      return shapeBounds(shape.target);
    case "mirror": {
      // The reflected interval: [min, max] maps to [2o − max, 2o − min] on
      // the plane's axis, the other two components unchanged — the exact
      // reflection of the source bounds, hand-derivable from them alone.
      const source = shapeBounds(shape.source);
      const o = shape.planeOffset;
      const flipMin = (axis: Axis): number =>
        axis === shape.axis
          ? 2 * o - boundsAt(source, "max", axis)
          : boundsAt(source, "min", axis);
      const flipMax = (axis: Axis): number =>
        axis === shape.axis
          ? 2 * o - boundsAt(source, "min", axis)
          : boundsAt(source, "max", axis);
      return boundsOf(
        [flipMin(0), flipMin(1), flipMin(2)],
        [flipMax(0), flipMax(1), flipMax(2)],
      );
    }
    case "extrusion":
      return extrusionBounds(shape);
    case "revolution":
      return revolutionBounds(shape);
    case "sweep":
      return sweepBounds(shape);
    case "wireSweep":
      return wireSweepBounds(shape);
    case "loft":
      return loftBounds(shape);
    case "helix":
      return helixBounds(shape);
  }
}

/**
 * The placed extrusion's exact AABB: the prism's extreme points are its cap
 * vertices, so hulling the rotated+translated cap polygon vertices is tight.
 */
function extrusionBounds(shape: ExtrusionNode): KernelBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const vertex of shape.polygon) {
    for (const localZ of [shape.baseZ, shape.baseZ + shape.height]) {
      const world = applyMatrix3(shape.rotation, [vertex.x, vertex.y, localZ]);
      const x = world[0] + at(shape.translation, 0);
      const y = world[1] + at(shape.translation, 1);
      const z = world[2] + at(shape.translation, 2);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }
  return boundsOf([minX, minY, minZ], [maxX, maxY, maxZ]);
}

/** The revolution leaf node type. */
type RevolutionNode = Extract<FakeShape, { kind: "revolution" }>;

/**
 * The exact support of the swept polygon along one axis-frame direction:
 * every profile vertex (a, s) sweeps the angular interval starting at its
 * own side (0 for s ≥ 0, π for s < 0) spanning the sweep; the support along
 * direction ψ is the vertex radius weighted by the cosine of the angular
 * distance from ψ to that vertex's swept interval.
 */
function revolutionSupport(shape: RevolutionNode, psi: number): number {
  let max = -Infinity;
  const tau = Math.PI * 2;
  for (const vertex of shape.polygon) {
    const radius = Math.abs(vertex.y);
    const base = vertex.y >= 0 ? 0 : Math.PI;
    const relative = (((psi - base) % tau) + tau) % tau;
    const distance =
      relative <= shape.sweep
        ? 0
        : Math.min(relative - shape.sweep, tau - relative);
    max = Math.max(max, radius * Math.cos(distance));
  }
  return max;
}

/**
 * The revolution's bounds: EXACT in the axis frame (the support extremes
 * above are the true per-axis maxima of the swept polygon, and the axial
 * extent is the polygon's), then hulling the eight axis-frame box corners
 * mapped through the frame and the placement — tight whenever that
 * composition is axis-aligned (the workplane-axis revolves), a conservative
 * container for oblique placements (the fake kernel declares
 * `tightBooleanBounds: false` on the same honesty).
 */
function revolutionBounds(shape: RevolutionNode): KernelBounds {
  let aMin = Infinity;
  let aMax = -Infinity;
  for (const vertex of shape.polygon) {
    aMin = Math.min(aMin, vertex.x);
    aMax = Math.max(aMax, vertex.x);
  }
  const vMax = revolutionSupport(shape, 0);
  const vMin = -revolutionSupport(shape, Math.PI);
  const wMax = revolutionSupport(shape, Math.PI / 2);
  const wMin = -revolutionSupport(shape, (3 * Math.PI) / 2);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const a of [aMin, aMax]) {
    for (const s of [vMin, vMax]) {
      for (const h of [wMin, wMax]) {
        // Axis coords (a, s, h) → local: origin + a·u + s·v + h·(local z).
        const local: Vec3 = [
          at(shape.origin, 0) + a * at(shape.u, 0) + s * at(shape.v, 0),
          at(shape.origin, 1) + a * at(shape.u, 1) + s * at(shape.v, 1),
          at(shape.origin, 2) + h,
        ];
        const world = applyMatrix3(shape.rotation, local);
        const x = world[0] + at(shape.translation, 0);
        const y = world[1] + at(shape.translation, 1);
        const z = world[2] + at(shape.translation, 2);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
    }
  }
  return boundsOf([minX, minY, minZ], [maxX, maxY, maxZ]);
}

/** The sweep leaf node type. */
type SweepNode = Extract<FakeShape, { kind: "sweep" }>;

/** The loft leaf node type. */
type LoftNode = Extract<FakeShape, { kind: "loft" }>;

/** The helix leaf node type (Phase 40's screw solid). */
type HelixNode = Extract<FakeShape, { kind: "helix" }>;
type WireSweepNode = Extract<FakeShape, { kind: "wireSweep" }>;

/** The station polygon of a wire sweep at frame index i (LOCAL space). */
function wireSweepStationPolygon(
  shape: WireSweepNode,
  index: number,
): readonly Vec3[] {
  const frame = shape.frames[index];
  if (frame === undefined) return [];
  return shape.polygon.map((vertex) => [
    frame.point[0] + vertex.x * frame.normal[0] + vertex.y * frame.binormal[0],
    frame.point[1] + vertex.x * frame.normal[1] + vertex.y * frame.binormal[1],
    frame.point[2] + vertex.x * frame.normal[2] + vertex.y * frame.binormal[2],
  ]);
}

/** The tight AABB over every station polygon's vertices (LOCAL, pre-placement). */
function wireSweepBounds(shape: WireSweepNode): KernelBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < shape.frames.length; index += 1) {
    for (const vertex of wireSweepStationPolygon(shape, index)) {
      minX = Math.min(minX, vertex[0]);
      minY = Math.min(minY, vertex[1]);
      minZ = Math.min(minZ, vertex[2]);
      maxX = Math.max(maxX, vertex[0]);
      maxY = Math.max(maxY, vertex[1]);
      maxZ = Math.max(maxZ, vertex[2]);
    }
  }
  if (!Number.isFinite(minX)) {
    return boundsOf([0, 0, 0], [0, 0, 0]);
  }
  return boundsOf([minX, minY, minZ], [maxX, maxY, maxZ]);
}

/** The station loft: side quads between consecutive stations plus the two caps. */
function wireSweepTriangles(shape: WireSweepNode): readonly Triangle[] {
  const triangles: Triangle[] = [];
  const count = shape.polygon.length;
  if (count < 3 || shape.frames.length < 2) return triangles;
  const stationAt = (index: number): readonly Vec3[] =>
    wireSweepStationPolygon(shape, index);
  for (let index = 0; index + 1 < shape.frames.length; index += 1) {
    const here = stationAt(index);
    const next = stationAt(index + 1);
    for (let vertex = 0; vertex < count; vertex += 1) {
      const a = here[vertex];
      const b = here[(vertex + 1) % count];
      const c = next[(vertex + 1) % count];
      const d = next[vertex];
      if (
        a === undefined ||
        b === undefined ||
        c === undefined ||
        d === undefined
      ) {
        continue;
      }
      triangles.push([a, b, c]);
      triangles.push([a, c, d]);
    }
  }
  // Caps: the first and last station polygons, fanned from their centroid.
  for (const index of [0, shape.frames.length - 1]) {
    const polygon = stationAt(index);
    const centroid: Vec3 = [
      polygon.reduce((sum, v) => sum + v[0], 0) / count,
      polygon.reduce((sum, v) => sum + v[1], 0) / count,
      polygon.reduce((sum, v) => sum + v[2], 0) / count,
    ];
    for (let vertex = 0; vertex < count; vertex += 1) {
      const a = polygon[vertex];
      const b = polygon[(vertex + 1) % count];
      if (a === undefined || b === undefined) continue;
      // Winding: the first cap faces backwards along the spine, the last
      // forwards — the transported tube's outward normals.
      triangles.push(index === 0 ? [centroid, b, a] : [centroid, a, b]);
    }
  }
  return triangles;
}

/**
 * The nearest-station frame projection: classify the query in the frame
 * whose station point is nearest (point-in-polygon on the station's
 * transported profile, with the axial coordinate inside the station's
 * tangent span). Exact for straight spines — the projection decouples —
 * and the documented station approximation for curved ones (the node's
 * own comment states the band).
 */
function wireSweepContains(
  shape: WireSweepNode,
  x: number,
  y: number,
  z: number,
): boolean {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < shape.frames.length; index += 1) {
    const point = shape.frames[index]?.point;
    if (point === undefined) continue;
    const distance =
      (point[0] - x) ** 2 + (point[1] - y) ** 2 + (point[2] - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  const frame = shape.frames[best];
  if (frame === undefined) return false;
  // The axial coordinate: the projection of (query − point) on the local
  // tangent, accepted within the neighbouring stations' half-span.
  const delta: Vec3 = [
    x - frame.point[0],
    y - frame.point[1],
    z - frame.point[2],
  ];
  const axial =
    delta[0] * frame.tangent[0] +
    delta[1] * frame.tangent[1] +
    delta[2] * frame.tangent[2];
  const span =
    shape.frames.length > 1 ? shape.spineLength / (shape.frames.length - 1) : 0;
  if (axial < -span || axial > span) return false;
  const u =
    delta[0] * frame.normal[0] +
    delta[1] * frame.normal[1] +
    delta[2] * frame.normal[2];
  const v =
    delta[0] * frame.binormal[0] +
    delta[1] * frame.binormal[1] +
    delta[2] * frame.binormal[2];
  return pointInPolygon2(shape.polygon, u, v);
}

/** Inclusive even-odd point-in-polygon on the station's (normal, binormal) plane. */
function pointInPolygon2(
  polygon: readonly ProfilePoint2[],
  u: number,
  v: number,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    const intersects =
      a.y > v !== b.y > v && u < ((b.x - a.x) * (v - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * The 3D chord self-intersection battery for wire spines: the closest
 * approach of any two NON-ADJACENT station chords under the shared
 * tolerance rejects the spine (`kernel/path-self-intersecting`) — the
 * planar sweep's battery carried to 3D, honest at the polyline it has.
 */
function wireChordsSelfIntersect(polyline: readonly Vec3[]): boolean {
  const tolerance = 1e-9;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    for (let j = i + 2; j + 1 < polyline.length; j += 1) {
      if (
        segmentDistance(
          polyline[i],
          polyline[i + 1],
          polyline[j],
          polyline[j + 1],
        ) < tolerance
      ) {
        return true;
      }
    }
  }
  return false;
}

/** The closest distance between two 3D segments (clamped projections). */
function segmentDistance(
  p1: Vec3 | undefined,
  q1: Vec3 | undefined,
  p2: Vec3 | undefined,
  q2: Vec3 | undefined,
): number {
  if (
    p1 === undefined ||
    q1 === undefined ||
    p2 === undefined ||
    q2 === undefined
  ) {
    return Infinity;
  }
  const d1: Vec3 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]];
  const d2: Vec3 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
  const r: Vec3 = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
  const e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
  const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
  const denominator = a * e - b * b;
  let s =
    denominator !== 0
      ? Math.min(Math.max((b * f - c * e) / denominator, 0), 1)
      : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = Math.min(Math.max(-c / a, 0), 1);
  } else if (t > 1) {
    t = 1;
    s = Math.min(Math.max((b - c) / a, 0), 1);
  }
  const closest1: Vec3 = [
    p1[0] + d1[0] * s,
    p1[1] + d1[1] * s,
    p1[2] + d1[2] * s,
  ];
  const closest2: Vec3 = [
    p2[0] + d2[0] * t,
    p2[1] + d2[1] * t,
    p2[2] + d2[2] * t,
  ];
  return Math.sqrt(
    (closest1[0] - closest2[0]) ** 2 +
      (closest1[1] - closest2[1]) ** 2 +
      (closest1[2] - closest2[2]) ** 2,
  );
}

/** The local-frame position of a profile vertex (u, v) at a station. */
function sweepStationVertex(station: SweepStation, u: number, v: number): Vec3 {
  return [
    station.position.x + u * station.e1.x,
    v,
    station.position.z + u * station.e1.z,
  ];
}

/**
 * The maximum of `cos(angle − target)` over the angular interval a signed
 * sweep covers from `start` (both in radians): `1` when the interval
 * contains the target angle, else the cosine of the nearer endpoint. A
 * full-turn interval contains every angle. The interval-cosine extreme the
 * arc pieces' support bounds need — the same structure
 * `revolutionSupport` computes for revolutions, generalized to a signed
 * sweep and an arbitrary start angle.
 */
function maxCosOverSignedInterval(
  start: number,
  sweep: number,
  target: number,
): number {
  const tau = Math.PI * 2;
  if (Math.abs(sweep) >= tau - 1e-12) return 1;
  const low = sweep > 0 ? start : start + sweep;
  const span = Math.abs(sweep);
  const relative = (((target - low) % tau) + tau) % tau;
  if (relative <= span) return 1;
  return Math.max(Math.cos(target - low), Math.cos(target - (low + span)));
}

/**
 * The EXACT support (max dot product) of one line piece's swept solid
 * along a unit local-frame direction `d`: the prism's extreme points are
 * its cap polygons, so the vertex×{start,end} hull is tight.
 */
function sweepLinePieceSupport(
  piece: Extract<SweepPiece, { kind: "line" }>,
  polygon: readonly ProfilePoint2[],
  d: Vec3,
): number {
  const tangentX = -piece.e1.z;
  const tangentZ = piece.e1.x;
  let max = -Infinity;
  for (const vertex of polygon) {
    for (const w of [0, piece.length]) {
      const x = piece.from.x + w * tangentX + vertex.x * piece.e1.x;
      const z = piece.from.z + w * tangentZ + vertex.x * piece.e1.z;
      max = Math.max(max, x * at(d, 0) + vertex.y * at(d, 1) + z * at(d, 2));
    }
  }
  return max;
}

/**
 * The EXACT support of one arc piece along a unit local-frame direction
 * `d`: the piece is a partial revolution about its centre axis (along y),
 * and every profile vertex i sweeps its angular interval at constant
 * signed radius `sᵢ = R + sign(θ)·uᵢ`, contributing
 * `⟨C,d⟩ + vᵢ·d_y + ρ_d·sᵢ·cos(β − β_d)` — the interval-cosine extreme
 * above, with the negative-radius branch answered by the antipodal target.
 */
function sweepArcPieceSupport(
  piece: Extract<SweepPiece, { kind: "arc" }>,
  polygon: readonly ProfilePoint2[],
  d: Vec3,
): number {
  const radialReach = Math.hypot(at(d, 0), at(d, 2));
  const betaD = Math.atan2(at(d, 2), at(d, 0));
  const sign = piece.sweep > 0 ? 1 : -1;
  let max = -Infinity;
  for (const vertex of polygon) {
    const s = piece.radius + sign * vertex.x;
    const cosTerm =
      s >= 0
        ? s * maxCosOverSignedInterval(piece.startAngle, piece.sweep, betaD)
        : -s *
          maxCosOverSignedInterval(
            piece.startAngle,
            piece.sweep,
            betaD + Math.PI,
          );
    const dot =
      piece.center.x * at(d, 0) +
      piece.center.z * at(d, 2) +
      vertex.y * at(d, 1) +
      radialReach * cosTerm;
    max = Math.max(max, dot);
  }
  return max;
}

/**
 * The placed sweep's exact AABB: per world axis, the support along the
 * placement rotation's matching row direction is maximized over the
 * pieces' exact supports — tight, the same honesty as the extrusion and
 * revolution leaves.
 */
function sweepBounds(shape: SweepNode): KernelBounds {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis += 1) {
    for (const sign of [1, -1] as const) {
      const direction: Vec3 = [
        sign * (shape.rotation[axis]?.[0] ?? 0),
        sign * (shape.rotation[axis]?.[1] ?? 0),
        sign * (shape.rotation[axis]?.[2] ?? 0),
      ];
      let support = -Infinity;
      for (const piece of shape.pieces) {
        const pieceSupport =
          piece.kind === "line"
            ? sweepLinePieceSupport(piece, shape.polygon, direction)
            : sweepArcPieceSupport(piece, shape.polygon, direction);
        support = Math.max(support, pieceSupport);
      }
      const value = support + sign * at(shape.translation, axis);
      if (sign > 0) {
        maxs[axis] = value;
      } else {
        mins[axis] = -value;
      }
    }
  }
  return boundsOf(
    [mins[0] ?? 0, mins[1] ?? 0, mins[2] ?? 0],
    [maxs[0] ?? 0, maxs[1] ?? 0, maxs[2] ?? 0],
  );
}

/**
 * The placed loft's exact AABB: a linear morph's support along any fixed
 * direction is the max of LINEAR per-vertex functions, whose extreme over
 * a span sits at a span endpoint — so hulling every station polygon's
 * vertices is tight (the same argument the extrusion's cap hull uses).
 */
function loftBounds(shape: LoftNode): KernelBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let s = 0; s < shape.polygons.length; s += 1) {
    const polygon = shape.polygons[s];
    const stationZ = shape.stations[s] ?? 0;
    if (polygon === undefined) continue;
    for (const vertex of polygon) {
      const world = applyMatrix3(shape.rotation, [
        vertex.x,
        vertex.y,
        stationZ,
      ]);
      const x = world[0] + at(shape.translation, 0);
      const y = world[1] + at(shape.translation, 1);
      const z = world[2] + at(shape.translation, 2);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }
  return boundsOf([minX, minY, minZ], [maxX, maxY, maxZ]);
}

/** Exact point-in-shape classification (inclusive primitive boundaries). */
function contains(shape: FakeShape, x: number, y: number, z: number): boolean {
  switch (shape.kind) {
    case "box":
      return (
        x >= 0 &&
        x <= at(shape.size, 0) &&
        y >= 0 &&
        y <= at(shape.size, 1) &&
        z >= 0 &&
        z <= at(shape.size, 2)
      );
    case "fillet":
      return filletContains(shape, x, y, z);
    case "chamfer":
      return chamferContains(shape, x, y, z);
    case "shell":
      return shellContains(shape, x, y, z);
    case "sphere":
      return x * x + y * y + z * z <= shape.radius * shape.radius;
    case "cylinder":
      return (
        x * x + y * y <= shape.radius * shape.radius &&
        z >= 0 &&
        z <= shape.height
      );
    case "cone": {
      if (z < 0 || z > shape.height) return false;
      const t = shape.height === 0 ? 0 : z / shape.height;
      const radius =
        shape.bottomRadius + (shape.topRadius - shape.bottomRadius) * t;
      return x * x + y * y <= radius * radius;
    }
    case "union":
      return shape.operands.some((operand) => contains(operand, x, y, z));
    case "subtract":
      return (
        contains(shape.target, x, y, z) &&
        !shape.tools.some((tool) => contains(tool, x, y, z))
      );
    case "intersect":
      return shape.operands.every((operand) => contains(operand, x, y, z));
    case "translate":
      return contains(
        shape.source,
        x - at(shape.offset, 0),
        y - at(shape.offset, 1),
        z - at(shape.offset, 2),
      );
    case "scale":
      // The scaled solid contains p iff the source contains the
      // inverse-scaled p — the pointwise model, the mirror node's
      // discipline carried to the one non-isometry transform.
      return contains(
        shape.source,
        x / shape.factor,
        y / shape.factor,
        z / shape.factor,
      );
    case "thickened":
      return thickenedContains(shape, x, y, z);
    case "mirror": {
      // The mirrored solid contains p iff the source contains the
      // reflected p — reflection is its own inverse, so the same flip
      // maps query points down and geometry results up.
      const qx = shape.axis === 0 ? 2 * shape.planeOffset - x : x;
      const qy = shape.axis === 1 ? 2 * shape.planeOffset - y : y;
      const qz = shape.axis === 2 ? 2 * shape.planeOffset - z : z;
      return contains(shape.source, qx, qy, qz);
    }
    case "extrusion": {
      // Classify in the LOCAL frame: undo the translation, then apply the
      // rotation's inverse (its transpose).
      const local = applyMatrix3(transpose3(shape.rotation), [
        x - at(shape.translation, 0),
        y - at(shape.translation, 1),
        z - at(shape.translation, 2),
      ]);
      const lz = local[2];
      if (lz === undefined) return false;
      if (lz < shape.baseZ || lz > shape.baseZ + shape.height) return false;
      return pointInPolygon(
        { x: local[0] ?? 0, y: local[1] ?? 0 },
        shape.polygon,
      );
    }
    case "revolution":
      return revolutionContains(shape, x, y, z);
    case "sweep":
      return sweepContains(shape, x, y, z);
    case "wireSweep":
      return wireSweepContains(shape, x, y, z);
    case "loft":
      return loftContains(shape, x, y, z);
    case "helix":
      return helixContains(shape, x, y, z);
  }
}

/**
 * Linear slack (mm) of the sweep classification: prism lengths and station
 * planes accept queries up to this far outside, mirroring the inclusive
 * boundary rule of the point-in-polygon test.
 */
const SWEEP_LINEAR_EPSILON_MM = 1e-9;

/**
 * Angular slack (radians) of the arc-piece span classification: query
 * station angles within this of a piece's travel span count as inside,
 * mirroring the partial-revolve cap rule.
 */
const SWEEP_ANGULAR_EPSILON_RAD = 1e-9;

/**
 * Whether a normalized angle `[0, 2π)` lies in a piece's travel span: the
 * signed sweep `ψ` covers `[0, ψ]` (ψ > 0) or `[2π + ψ, 2π)` (ψ < 0); a
 * full-turn sweep covers every angle.
 */
function angleInSweepSpan(angle: number, sweep: number): boolean {
  if (Math.abs(sweep) >= Math.PI * 2 - 1e-12) return true;
  if (sweep > 0) return angle <= sweep + SWEEP_ANGULAR_EPSILON_RAD;
  return angle >= Math.PI * 2 + sweep - SWEEP_ANGULAR_EPSILON_RAD;
}

/**
 * Exact point-in-sweep classification. The query is un-placed into the
 * local frame, then each piece answers in its own coordinates: a line
 * piece is a prism (project onto the piece's frame — the along-length
 * coordinate must lie in `[0, L]` and the section in the polygon); an arc
 * piece is a partial revolution about its centre axis — the query's radial
 * direction picks its station plane(s) (the atan2 of the radial vector in
 * the piece's start frame), and the angular span test plus the
 * positive/negative-radius branch (the full revolution's mirror) mirror
 * `revolutionContains`.
 */
function sweepContains(
  shape: SweepNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const local = applyMatrix3(transpose3(shape.rotation), [
    x - at(shape.translation, 0),
    y - at(shape.translation, 1),
    z - at(shape.translation, 2),
  ]);
  const lx = local[0] ?? 0;
  const ly = local[1] ?? 0;
  const lz = local[2] ?? 0;
  for (const piece of shape.pieces) {
    if (piece.kind === "line") {
      const tangentX = -piece.e1.z;
      const tangentZ = piece.e1.x;
      const rx = lx - piece.from.x;
      const rz = lz - piece.from.z;
      const along = rx * tangentX + rz * tangentZ;
      if (
        along < -SWEEP_LINEAR_EPSILON_MM ||
        along > piece.length + SWEEP_LINEAR_EPSILON_MM
      ) {
        continue;
      }
      const u = rx * piece.e1.x + rz * piece.e1.z;
      if (pointInPolygon({ x: u, y: ly }, shape.polygon)) return true;
      continue;
    }
    const sign = piece.sweep > 0 ? 1 : -1;
    const e0x = sign * Math.cos(piece.startAngle);
    const e0z = sign * Math.sin(piece.startAngle);
    const t0x = -sign * Math.sin(piece.startAngle);
    const t0z = sign * Math.cos(piece.startAngle);
    const rx = lx - piece.center.x;
    const rz = lz - piece.center.z;
    const p0 = rx * e0x + rz * e0z;
    const q0 = rx * t0x + rz * t0z;
    const radius = Math.hypot(p0, q0);
    const tau = Math.PI * 2;
    const phi = ((Math.atan2(q0, p0) % tau) + tau) % tau;
    const branches: readonly { readonly angle: number; readonly u: number }[] =
      [
        { angle: phi, u: radius },
        { angle: (((phi + Math.PI) % tau) + tau) % tau, u: -radius },
      ];
    for (const branch of branches) {
      if (!angleInSweepSpan(branch.angle, piece.sweep)) continue;
      if (pointInPolygon({ x: branch.u, y: ly }, shape.polygon)) return true;
    }
  }
  return false;
}

/**
 * Exact point-in-loft classification. The query is un-placed into the
 * local frame, located in its span by z (stations are strictly
 * increasing, so the span is unique; the caps' z planes accept queries up
 * to the sweep leaf's linear slack), and classified against the span's
 * morph polygon at the exact span parameter — the same linear-morph model
 * the volume integrates and the mesh walls.
 */
function loftContains(
  shape: LoftNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const local = applyMatrix3(transpose3(shape.rotation), [
    x - at(shape.translation, 0),
    y - at(shape.translation, 1),
    z - at(shape.translation, 2),
  ]);
  const lx = local[0] ?? 0;
  const ly = local[1] ?? 0;
  const lz = local[2] ?? 0;
  const first = shape.stations[0];
  const last = shape.stations[shape.stations.length - 1];
  if (first === undefined || last === undefined) return false;
  if (
    lz < first - SWEEP_LINEAR_EPSILON_MM ||
    lz > last + SWEEP_LINEAR_EPSILON_MM
  ) {
    return false;
  }
  for (let j = 0; j + 1 < shape.stations.length; j += 1) {
    const zNext = shape.stations[j + 1];
    if (zNext === undefined || lz > zNext + SWEEP_LINEAR_EPSILON_MM) {
      continue; // above this span's ceiling — keep scanning
    }
    const zHere = shape.stations[j];
    const here = shape.polygons[j];
    const next = shape.polygons[j + 1];
    if (zHere === undefined || here === undefined || next === undefined) {
      continue;
    }
    // The first span whose ceiling covers the query owns it; clamp onto it
    // so cap-plane slack classifies at the cap polygon exactly.
    const clamped = Math.min(Math.max(lz, zHere), zNext);
    const t = (clamped - zHere) / (zNext - zHere);
    return pointInPolygon({ x: lx, y: ly }, morphPolygons(here, next, t));
  }
  return false;
}

/**
 * Angular slack (radians) of the partial-revolve classification: query
 * angles within this of a cap plane count as inside, mirroring the
 * inclusive boundary rule of the point-in-polygon test.
 */
const REVOLVE_ANGULAR_EPSILON_RAD = 1e-9; /**
 * Exact point-in-revolution classification. The query is transformed into
 * the axis frame (axial a, signed radial s, height h), and the swept solid
 * is the profile region rotated about the axis: a FULL sweep contains the
 * query when either radial branch (±ρ) of the profile covers (a, ρ); a
 * PARTIAL sweep additionally requires the query angle to sit inside the
 * swept arc, which starts at the profile's own side (0 or π).
 */
function revolutionContains(
  shape: RevolutionNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const local = applyMatrix3(transpose3(shape.rotation), [
    x - at(shape.translation, 0),
    y - at(shape.translation, 1),
    z - at(shape.translation, 2),
  ]);
  const lx = local[0] ?? 0;
  const ly = local[1] ?? 0;
  const lz = local[2] ?? 0;
  const dx = lx - at(shape.origin, 0);
  const dy = ly - at(shape.origin, 1);
  const a = dx * at(shape.u, 0) + dy * at(shape.u, 1);
  const s = dx * at(shape.v, 0) + dy * at(shape.v, 1);
  const h = lz - at(shape.origin, 2);
  const radius = Math.hypot(s, h);
  const full = shape.sweep >= Math.PI * 2;
  if (!full) {
    const tau = Math.PI * 2;
    const base = shape.positiveSide ? 0 : Math.PI;
    const offset = (((Math.atan2(h, s) - base) % tau) + tau) % tau;
    if (offset > shape.sweep + REVOLVE_ANGULAR_EPSILON_RAD) return false;
  }
  // The profile branch that sweeps to this angle: the +v side's branch
  // carries signed radial +ρ; the −v side's carries −ρ. A full sweep
  // covers both branches' circles, so either may contain the query.
  const branches = full
    ? [radius, -radius]
    : [shape.positiveSide ? radius : -radius];
  return branches.some((branch) =>
    pointInPolygon({ x: a, y: branch }, shape.polygon),
  );
}

// ---------------------------------------------------------------------------
// The fillet node (Phase 26.5): the analytic corner-fillet model
// ---------------------------------------------------------------------------

/** The fillet leaf node type. */
type FilletNode = Extract<FakeShape, { kind: "fillet" }>;

/**
 * The removed prism-quadrant of one filleted box edge, as an exact
 * membership test: the region is the edge's corner quadrant (the two cross
 * axes' bands of width `radius` toward the corner, the full edge length
 * along the edge axis) MINUS the quarter cylinder of the same radius
 * centred where the bands' inner edges cross. A query inside the quadrant
 * and strictly beyond the cylinder is corner material the fillet removed;
 * the cylinder's arc itself is the fillet surface and stays.
 */
function filletEdgeRemoves(
  node: FilletNode,
  edge: FakeBoxEdge,
  x: number,
  y: number,
  z: number,
): boolean {
  const point: Vec3 = [x, y, z];
  const u = edge.axis;
  const a = u === 0 ? 1 : 0;
  const b = u === 2 ? 1 : 2;
  const sizeU = at(node.size, u);
  const sizeA = at(node.size, a);
  const sizeB = at(node.size, b);
  const along = at(point, u);
  if (along < 0 || along > sizeU) return false;
  const cornerA = at(edge.corner, a);
  const cornerB = at(edge.corner, b);
  const band = (value: number, cornerValue: number, size: number): boolean =>
    cornerValue === 0 ? value <= node.radius : value >= size - node.radius;
  const valueA = at(point, a);
  const valueB = at(point, b);
  if (!band(valueA, cornerA, sizeA) || !band(valueB, cornerB, sizeB)) {
    return false;
  }
  const centerA = cornerA === 0 ? node.radius : cornerA - node.radius;
  const centerB = cornerB === 0 ? node.radius : cornerB - node.radius;
  const dx = valueA - centerA;
  const dy = valueB - centerB;
  return dx * dx + dy * dy > node.radius * node.radius;
}

/** Exact point-in-fillet classification: the box minus every removed quadrant. */
function filletContains(
  shape: FilletNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const insideBox =
    x >= 0 &&
    x <= at(shape.size, 0) &&
    y >= 0 &&
    y <= at(shape.size, 1) &&
    z >= 0 &&
    z <= at(shape.size, 2);
  if (!insideBox) return false;
  return !shape.edges.some((edge) => filletEdgeRemoves(shape, edge, x, y, z));
}

/**
 * The analytic corner-fillet volume: the box volume minus each edge's
 * removed prism — cross-section `r²(1 − π/4)` (the quadrant square minus
 * its quarter disc) times the edge length — exact because the selected
 * edges' removed regions were validated pairwise disjoint before the node
 * was built.
 */
function filletAnalyticVolume(shape: FilletNode): number {
  const boxVolume = at(shape.size, 0) * at(shape.size, 1) * at(shape.size, 2);
  const removed = shape.edges.reduce((sum, edge) => {
    const length = at(shape.size, edge.axis);
    return sum + shape.radius ** 2 * (1 - Math.PI / 4) * length;
  }, 0);
  return boxVolume - removed;
}

/**
 * Permutation parity of the canonical cross-axis order: the mesh maps
 * `(a, b)` planar coordinates onto xyz with the edge axis third, and the
 * only odd permutation of `(x, y, z)` in that construction is the y axis
 * (`(x, z, y)`), which flips what "CCW in the plane" means for winding.
 */
function orientationSign(u: Axis): 1 | -1 {
  return u === 1 ? -1 : 1;
}

/**
 * The filleted box's canonical mesh: every planar piece exact (the kept
 * face rectangles and cap cells), every fillet arc chorded at the shared
 * curved-mesh convention ({@link FAKE_KERNEL_TESSELLATION_SEGMENTS} per
 * full circle — 4 chords per quarter arc), the same fidelity class as the
 * canonical sphere/cylinder meshes. Winding is CCW seen from outside,
 * verified from each facet's actual normal against the face's outward
 * direction, never assumed from the construction order.
 */
function filletTriangles(shape: FilletNode): readonly Triangle[] {
  const r = shape.radius;
  const triangles: Triangle[] = [];
  const u: Axis = shape.edges[0]?.axis ?? 2;
  const a: Axis = u === 0 ? 1 : 0;
  const b: Axis = u === 2 ? 1 : 2;
  const sizeU = at(shape.size, u);
  const sizeA = at(shape.size, a);
  const sizeB = at(shape.size, b);
  const parity = orientationSign(u);

  /** Maps (aValue, bValue, uValue) onto the canonical xyz triple. */
  const to3 = (aValue: number, bValue: number, uValue: number): Vec3 => {
    const point: [number, number, number] = [0, 0, 0];
    const set = (axis: Axis, value: number): void => {
      point[axis] = value;
    };
    set(a, aValue);
    set(b, bValue);
    set(u, uValue);
    return point;
  };

  /**
   * Emits one quad as two triangles wound so the facet normal points along
   * `outward` (checked from the actual cross product, never assumed).
   */
  const emitQuad = (
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    p4: Vec3,
    outward: Vec3,
  ): void => {
    const e1: Vec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const e2: Vec3 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    const cross: Vec3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const dot =
      cross[0] * outward[0] + cross[1] * outward[1] + cross[2] * outward[2];
    if (dot >= 0) {
      triangles.push([p1, p2, p3], [p1, p3, p4]);
    } else {
      triangles.push([p1, p4, p3], [p1, p3, p2]);
    }
  };

  /** True when the selected edges' corner sits on face `side` of `axis`. */
  const cornerOn = (edge: FakeBoxEdge, axis: Axis, side: number): boolean =>
    at(edge.corner, axis) === side;
  const bandLowOf = (cornerValue: number, size: number): number =>
    cornerValue === 0 ? 0 : size - r;

  // --- side faces (one per cross-axis side): kept rectangles between the
  // fillet strips. A face ⟂ axis `cross` at coordinate `side` loses, for
  // every selected edge whose corner sits on it, the strip
  // band(corner[other]) across the face's `other` extent.
  for (const cross of [a, b] as const) {
    const other: Axis = cross === a ? b : a;
    const sizeCross = cross === a ? sizeA : sizeB;
    const sizeOther = cross === a ? sizeB : sizeA;
    for (const side of [0, sizeCross] as const) {
      const outward: Vec3 = to3(
        cross === a ? (side === 0 ? -1 : 1) : 0,
        cross === b ? (side === 0 ? -1 : 1) : 0,
        0,
      );
      const strips = shape.edges
        .filter((edge) => cornerOn(edge, cross, side))
        .map((edge) => {
          const low = bandLowOf(at(edge.corner, other), sizeOther);
          return { low, high: low + r };
        })
        .sort((p, q) => p.low - q.low);
      const cuts = new Set<number>([0, sizeOther]);
      for (const strip of strips) {
        cuts.add(strip.low);
        cuts.add(strip.high);
      }
      const ordered = [...cuts].sort((p, q) => p - q);
      for (let i = 0; i + 1 < ordered.length; i += 1) {
        const low = ordered[i];
        const high = ordered[i + 1];
        if (low === undefined || high === undefined || high - low <= 0) {
          continue;
        }
        const mid = (low + high) / 2;
        const insideStrip = strips.some(
          (strip) => mid > strip.low && mid < strip.high,
        );
        if (insideStrip) continue;
        // The kept rectangle runs `low..high` along `other`, sits in the
        // face's plane coordinate `side` along `cross`, and spans the full
        // edge-axis extent along `u`.
        const lowA = cross === a ? side : low;
        const lowB = cross === a ? low : side;
        const highA = cross === a ? side : high;
        const highB = cross === a ? high : side;
        emitQuad(
          to3(lowA, lowB, 0),
          to3(highA, highB, 0),
          to3(highA, highB, sizeU),
          to3(lowA, lowB, sizeU),
          outward,
        );
      }
    }
  }

  // --- caps (⟂ the edge axis): the section is the square minus each
  // removed corner quadrant's square, plus each edge's quarter-disc sector.
  for (const cap of [0, sizeU] as const) {
    const outward = to3(0, 0, cap === 0 ? -1 : 1);
    // Grid decomposition of the square minus quadrant squares: every
    // quadrant square is a union of grid cells (its band endpoints are
    // cuts), so cell-midpoint containment decides each cell.
    const cutA = new Set<number>([0, sizeA]);
    const cutB = new Set<number>([0, sizeB]);
    const quadrantBounds = shape.edges.map((edge) => {
      const lowA = bandLowOf(at(edge.corner, a), sizeA);
      const lowB = bandLowOf(at(edge.corner, b), sizeB);
      cutA.add(lowA);
      cutA.add(lowA + r);
      cutB.add(lowB);
      cutB.add(lowB + r);
      return { lowA, highA: lowA + r, lowB, highB: lowB + r };
    });
    const sortedA = [...cutA].sort((p, q) => p - q);
    const sortedB = [...cutB].sort((p, q) => p - q);
    for (let i = 0; i + 1 < sortedA.length; i += 1) {
      const lowA = sortedA[i];
      const highA = sortedA[i + 1];
      if (lowA === undefined || highA === undefined || highA - lowA <= 0) {
        continue;
      }
      for (let j = 0; j + 1 < sortedB.length; j += 1) {
        const lowB = sortedB[j];
        const highB = sortedB[j + 1];
        if (lowB === undefined || highB === undefined || highB - lowB <= 0) {
          continue;
        }
        const midA = (lowA + highA) / 2;
        const midB = (lowB + highB) / 2;
        const insideQuadrant = quadrantBounds.some(
          (q) =>
            midA > q.lowA && midA < q.highA && midB > q.lowB && midB < q.highB,
        );
        if (insideQuadrant) continue;
        emitQuad(
          to3(lowA, lowB, cap),
          to3(highA, lowB, cap),
          to3(highA, highB, cap),
          to3(lowA, highB, cap),
          outward,
        );
      }
    }
    // Quarter-disc sectors: a 4-chord fan per selected edge, wound with
    // the cap (the sector lies in the cap's plane, centred on the cylinder
    // axis point, which is kept material).
    const steps = Math.max(
      1,
      Math.round(FAKE_KERNEL_TESSELLATION_SEGMENTS / 4),
    );
    for (const edge of shape.edges) {
      const ca = at(edge.corner, a) === 0 ? r : sizeA - r;
      const cb = at(edge.corner, b) === 0 ? r : sizeB - r;
      const bisector = Math.atan2(
        at(edge.corner, b) === 0 ? 1 : -1,
        at(edge.corner, a) === 0 ? 1 : -1,
      );
      const sign = cap === 0 ? -parity : parity;
      const center = to3(ca, cb, cap);
      for (let i = 0; i < steps; i += 1) {
        const t0 = bisector + ((i / steps - 0.5) * Math.PI) / 2;
        const t1 = bisector + (((i + 1) / steps - 0.5) * Math.PI) / 2;
        const p0 = to3(ca + r * Math.cos(t0), cb + r * Math.sin(t0), cap);
        const p1 = to3(ca + r * Math.cos(t1), cb + r * Math.sin(t1), cap);
        if (sign > 0) triangles.push([center, p0, p1]);
        else triangles.push([center, p1, p0]);
      }
    }
  }

  // --- fillet walls: one quarter-cylinder strip per edge, 4 chord quads,
  // each wound so the facet normal leaves the cylinder's axis.
  const steps = Math.max(1, Math.round(FAKE_KERNEL_TESSELLATION_SEGMENTS / 4));
  for (const edge of shape.edges) {
    const ca = at(edge.corner, a) === 0 ? r : sizeA - r;
    const cb = at(edge.corner, b) === 0 ? r : sizeB - r;
    const bisector = Math.atan2(
      at(edge.corner, b) === 0 ? 1 : -1,
      at(edge.corner, a) === 0 ? 1 : -1,
    );
    for (let i = 0; i < steps; i += 1) {
      const t0 = bisector + ((i / steps - 0.5) * Math.PI) / 2;
      const t1 = bisector + (((i + 1) / steps - 0.5) * Math.PI) / 2;
      const p0 = to3(ca + r * Math.cos(t0), cb + r * Math.sin(t0), 0);
      const p1 = to3(ca + r * Math.cos(t1), cb + r * Math.sin(t1), 0);
      const q0 = to3(ca + r * Math.cos(t0), cb + r * Math.sin(t0), sizeU);
      const q1 = to3(ca + r * Math.cos(t1), cb + r * Math.sin(t1), sizeU);
      const midT = (t0 + t1) / 2;
      const outwardMid = to3(
        ca + r * Math.cos(midT),
        cb + r * Math.sin(midT),
        sizeU / 2,
      );
      const center = to3(ca, cb, sizeU / 2);
      const e1: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2: Vec3 = [q0[0] - p0[0], q0[1] - p0[1], q0[2] - p0[2]];
      const cross: Vec3 = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const ref: Vec3 = [
        outwardMid[0] - center[0],
        outwardMid[1] - center[1],
        outwardMid[2] - center[2],
      ];
      const dot = cross[0] * ref[0] + cross[1] * ref[1] + cross[2] * ref[2];
      if (dot >= 0) triangles.push([p0, p1, q1], [p0, q1, q0]);
      else triangles.push([p0, q1, p1], [p0, q0, q1]);
    }
  }
  return triangles;
}

// ---------------------------------------------------------------------------
// The chamfer node (Phase 26.6): the analytic corner-prism model
// ---------------------------------------------------------------------------

/** The chamfer leaf node type. */
type ChamferNode = Extract<FakeShape, { kind: "chamfer" }>;

/**
 * The removed corner prism of one chamfered box edge, as an exact
 * membership test: the region is the right-isoceles triangle with legs
 * `distance` in the two cross axes, extruded the full edge length — the
 * symmetric chamfer plane cuts `distance` from the edge along both
 * adjacent faces, so a query strictly inside the diagonal `da + db <
 * distance` (measured from the edge's corner along the cross axes) is
 * corner material the chamfer removed; the diagonal itself is the chamfer
 * surface and stays.
 */
function chamferEdgeRemoves(
  node: ChamferNode,
  edge: FakeBoxEdge,
  x: number,
  y: number,
  z: number,
): boolean {
  const point: Vec3 = [x, y, z];
  const u = edge.axis;
  const along = at(point, u);
  if (along < 0 || along > at(node.size, u)) return false;
  const a = u === 0 ? 1 : 0;
  const b = u === 2 ? 1 : 2;
  const da =
    at(edge.corner, a) === 0 ? at(point, a) : at(node.size, a) - at(point, a);
  const db =
    at(edge.corner, b) === 0 ? at(point, b) : at(node.size, b) - at(point, b);
  return da + db < node.distance;
}

/** Exact point-in-chamfer classification: the box minus every removed prism. */
function chamferContains(
  shape: ChamferNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const insideBox =
    x >= 0 &&
    x <= at(shape.size, 0) &&
    y >= 0 &&
    y <= at(shape.size, 1) &&
    z >= 0 &&
    z <= at(shape.size, 2);
  if (!insideBox) return false;
  return !shape.edges.some((edge) => chamferEdgeRemoves(shape, edge, x, y, z));
}

/**
 * The analytic corner-chamfer volume: the box volume minus each edge's
 * removed corner prism — cross-section `d²/2` (the right-isoceles triangle
 * the symmetric distance cuts) times the edge length — exact because the
 * selected edges' removed prisms were validated pairwise disjoint before
 * the node was built. Holds for a distance past the edge's own length too
 * (probed against OCCT): the prism cross-section lives in the cross plane,
 * so the edge length bounds nothing.
 */
function chamferAnalyticVolume(shape: ChamferNode): number {
  const boxVolume = at(shape.size, 0) * at(shape.size, 1) * at(shape.size, 2);
  const removed = shape.edges.reduce((sum, edge) => {
    const length = at(shape.size, edge.axis);
    return sum + (shape.distance ** 2 / 2) * length;
  }, 0);
  return boxVolume - removed;
}

/**
 * The chamfered box's canonical mesh: FULLY planar — the kept face
 * rectangles, the caps (the box section polygon with each chamfered corner
 * replaced by its two tangent points, fanned from vertex 0 — convex, since
 * cutting a rectangle's corners cannot concave it), and one flat chamfer
 * quad per edge. Every facet is exact geometry (no chording anywhere, the
 * fillet mesh's curved-piece class has no chamfer member), wound CCW seen
 * from outside via the actual-facet-normal check, never the construction
 * order.
 */
function chamferTriangles(shape: ChamferNode): readonly Triangle[] {
  const d = shape.distance;
  const triangles: Triangle[] = [];
  const u: Axis = shape.edges[0]?.axis ?? 2;
  const a: Axis = u === 0 ? 1 : 0;
  const b: Axis = u === 2 ? 1 : 2;
  const sizeU = at(shape.size, u);
  const sizeA = at(shape.size, a);
  const sizeB = at(shape.size, b);
  const parity = orientationSign(u);

  /** Maps (aValue, bValue, uValue) onto the canonical xyz triple. */
  const to3 = (aValue: number, bValue: number, uValue: number): Vec3 => {
    const point: [number, number, number] = [0, 0, 0];
    const set = (axis: Axis, value: number): void => {
      point[axis] = value;
    };
    set(a, aValue);
    set(b, bValue);
    set(u, uValue);
    return point;
  };

  /**
   * Emits one quad as two triangles wound so the facet normal points along
   * `outward` (checked from the actual cross product, never assumed).
   */
  const emitQuad = (
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    p4: Vec3,
    outward: Vec3,
  ): void => {
    const e1: Vec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const e2: Vec3 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    const cross: Vec3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const dot =
      cross[0] * outward[0] + cross[1] * outward[1] + cross[2] * outward[2];
    if (dot >= 0) {
      triangles.push([p1, p2, p3], [p1, p3, p4]);
    } else {
      triangles.push([p1, p4, p3], [p1, p3, p2]);
    }
  };

  /** True when the selected edges' corner sits on face `side` of `axis`. */
  const cornerOn = (edge: FakeBoxEdge, axis: Axis, side: number): boolean =>
    at(edge.corner, axis) === side;
  const bandLowOf = (cornerValue: number, size: number): number =>
    cornerValue === 0 ? 0 : size - d;

  // --- side faces (one per cross-axis side): kept rectangles between the
  // chamfer strips. A face ⟂ axis `cross` at coordinate `side` loses, for
  // every selected edge whose corner sits on it, the full strip of width
  // `distance` along the face's `other` extent (on the face itself the
  // chamfer plane's cut lands exactly at the tangent point) — the fillet
  // mesh's strip logic with the chamfer distance in the radius's place.
  for (const cross of [a, b] as const) {
    const other: Axis = cross === a ? b : a;
    const sizeCross = cross === a ? sizeA : sizeB;
    const sizeOther = cross === a ? sizeB : sizeA;
    for (const side of [0, sizeCross] as const) {
      const outward: Vec3 = to3(
        cross === a ? (side === 0 ? -1 : 1) : 0,
        cross === b ? (side === 0 ? -1 : 1) : 0,
        0,
      );
      const strips = shape.edges
        .filter((edge) => cornerOn(edge, cross, side))
        .map((edge) => {
          const low = bandLowOf(at(edge.corner, other), sizeOther);
          return { low, high: low + d };
        })
        .sort((p, q) => p.low - q.low);
      const cuts = new Set<number>([0, sizeOther]);
      for (const strip of strips) {
        cuts.add(strip.low);
        cuts.add(strip.high);
      }
      const ordered = [...cuts].sort((p, q) => p - q);
      for (let i = 0; i + 1 < ordered.length; i += 1) {
        const low = ordered[i];
        const high = ordered[i + 1];
        if (low === undefined || high === undefined || high - low <= 0) {
          continue;
        }
        const mid = (low + high) / 2;
        const insideStrip = strips.some(
          (strip) => mid > strip.low && mid < strip.high,
        );
        if (insideStrip) continue;
        const lowA = cross === a ? side : low;
        const lowB = cross === a ? low : side;
        const highA = cross === a ? side : high;
        const highB = cross === a ? high : side;
        emitQuad(
          to3(lowA, lowB, 0),
          to3(highA, highB, 0),
          to3(highA, highB, sizeU),
          to3(lowA, lowB, sizeU),
          outward,
        );
      }
    }
  }

  // --- caps (⟂ the edge axis): the box section with each chamfered corner
  // replaced by its two tangent points — a convex polygon in the (a, b)
  // plane, fanned from vertex 0 with the cap's outward winding.
  for (const cap of [0, sizeU] as const) {
    // The rectangle's corners CCW in (a, b), each with the corner-tangent
    // pair that replaces it when a selected edge sits there: first the
    // tangent on the incoming side, then the one on the outgoing side.
    const section: { readonly a: number; readonly b: number }[] = [];
    const cornerCut = (
      aFlag: 0 | 1,
      bFlag: 0 | 1,
    ): readonly { a: number; b: number }[] => {
      const cornerA = aFlag === 0 ? 0 : sizeA;
      const cornerB = bFlag === 0 ? 0 : sizeB;
      const chamfered = shape.edges.some(
        (edge) =>
          (at(edge.corner, a) === 0 ? 0 : 1) === aFlag &&
          (at(edge.corner, b) === 0 ? 0 : 1) === bFlag,
      );
      if (!chamfered) return [{ a: cornerA, b: cornerB }];
      // Incoming side is the b-axis edge for corners reached along +a, the
      // a-axis edge otherwise — the CCW rectangle order below fixes which.
      const onB = { a: cornerA, b: bFlag === 0 ? d : sizeB - d };
      const onA = { a: aFlag === 0 ? d : sizeA - d, b: cornerB };
      const ccwFromB = aFlag === 0 ? bFlag === 0 : bFlag === 1;
      return ccwFromB ? [onB, onA] : [onA, onB];
    };
    section.push(...cornerCut(0, 0));
    section.push(...cornerCut(1, 0));
    section.push(...cornerCut(1, 1));
    section.push(...cornerCut(0, 1));
    const anchor = section[0];
    if (anchor === undefined) {
      throw new Error(
        "Invariant violation: the chamfered section polygon always has vertices.",
      );
    }
    const sign = cap === 0 ? -parity : parity;
    for (let i = 1; i + 1 < section.length; i += 1) {
      const first = section[i];
      const second = section[i + 1];
      if (first === undefined || second === undefined) continue;
      const p1 = to3(anchor.a, anchor.b, cap);
      const p2 = to3(first.a, first.b, cap);
      const p3 = to3(second.a, second.b, cap);
      if (sign > 0) triangles.push([p1, p2, p3]);
      else triangles.push([p1, p3, p2]);
    }
  }

  // --- chamfer walls: ONE flat quad per edge, from tangent point to
  // tangent point along the full edge, wound toward the cut corner.
  for (const edge of shape.edges) {
    const cornerA = at(edge.corner, a);
    const cornerB = at(edge.corner, b);
    const tangentOnA = { a: cornerA === 0 ? d : sizeA - d, b: cornerB };
    const tangentOnB = { a: cornerA, b: cornerB === 0 ? d : sizeB - d };
    const outward = to3(cornerA === 0 ? -1 : 1, cornerB === 0 ? -1 : 1, 0);
    emitQuad(
      to3(tangentOnA.a, tangentOnA.b, 0),
      to3(tangentOnB.a, tangentOnB.b, 0),
      to3(tangentOnB.a, tangentOnB.b, sizeU),
      to3(tangentOnA.a, tangentOnA.b, sizeU),
      outward,
    );
  }
  return triangles;
}

// ---------------------------------------------------------------------------
// The shell node (Phase 26.7): the analytic open-box model
// ---------------------------------------------------------------------------

/** The shell leaf node type. */
type ShellNode = Extract<FakeShape, { kind: "shell" }>;

/** The Phase 41 closed-hollow node type. */
type ThickenedNode = Extract<FakeShape, { kind: "thickened" }>;

/**
 * Exact point-in-closed-hollow classification: inside the target leaf AND
 * not strictly inside the inset cavity (the cavity's own boundary faces
 * are material, the inclusive boundary rule the shell model uses).
 */
function thickenedContains(
  shape: ThickenedNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const target = shape.target;
  if (target.kind === "box") {
    const size = target.size;
    const insideOuter =
      x >= 0 &&
      x <= at(size, 0) &&
      y >= 0 &&
      y <= at(size, 1) &&
      z >= 0 &&
      z <= at(size, 2);
    if (!insideOuter) return false;
    const t = shape.thickness;
    return !(
      x > t &&
      x < at(size, 0) - t &&
      y > t &&
      y < at(size, 1) - t &&
      z > t &&
      z < at(size, 2) - t
    );
  }
  if (target.kind === "sphere") {
    const outer2 = x * x + y * y + z * z;
    if (outer2 > target.radius ** 2) return false;
    const inner = target.radius - shape.thickness;
    return !(outer2 < inner * inner);
  }
  throw new Error(
    "Invariant violation: the thickened node's target is the pristine box or sphere leaf the builder validated.",
  );
}

/**
 * The analytic closed-hollow volume: the pristine leaf minus its inset —
 * the box's inner box or the sphere's inner sphere — exact by the fit
 * battery's validated non-degeneracy.
 */
function thickenedAnalyticVolume(shape: ThickenedNode): number {
  const t = shape.thickness;
  const target = shape.target;
  if (target.kind === "box") {
    const size = target.size;
    return (
      at(size, 0) * at(size, 1) * at(size, 2) -
      (at(size, 0) - 2 * t) * (at(size, 1) - 2 * t) * (at(size, 2) - 2 * t)
    );
  }
  if (target.kind === "sphere") {
    return (4 / 3) * Math.PI * (target.radius ** 3 - (target.radius - t) ** 3);
  }
  throw new Error(
    "Invariant violation: the thickened node's target is the pristine box or sphere leaf the builder validated.",
  );
}

/** The closed hollow's boundary area: both surfaces, exact closed forms. */
function thickenedAnalyticArea(shape: ThickenedNode): number {
  const t = shape.thickness;
  const target = shape.target;
  if (target.kind === "box") {
    const size = target.size;
    const outer =
      2 *
      (at(size, 0) * at(size, 1) +
        at(size, 1) * at(size, 2) +
        at(size, 0) * at(size, 2));
    const inner =
      2 *
      ((at(size, 0) - 2 * t) * (at(size, 1) - 2 * t) +
        (at(size, 1) - 2 * t) * (at(size, 2) - 2 * t) +
        (at(size, 0) - 2 * t) * (at(size, 2) - 2 * t));
    return outer + inner;
  }
  if (target.kind === "sphere") {
    return 4 * Math.PI * (target.radius ** 2 + (target.radius - t) ** 2);
  }
  throw new Error(
    "Invariant violation: the thickened node's target is the pristine box or sphere leaf the builder validated.",
  );
}

/**
 * The closed hollow's canonical mesh: the leaf's own triangles (outward)
 * plus the inset's triangles REVERSED — the cavity's surface faces into
 * the void, the two-surface boundary the volume and area models integrate.
 */
function thickenedTriangles(shape: ThickenedNode): readonly Triangle[] {
  const t = shape.thickness;
  const target = shape.target;
  if (target.kind === "box") {
    const outer = boxTriangles(
      at(target.size, 0),
      at(target.size, 1),
      at(target.size, 2),
    );
    const inner = boxTriangles(
      at(target.size, 0) - 2 * t,
      at(target.size, 1) - 2 * t,
      at(target.size, 2) - 2 * t,
    ).map((triangle) => shiftedTriangle(triangle, [t, t, t]));
    return [
      ...outer,
      ...inner.map(
        (triangle) =>
          [
            cornerOf(triangle, 2),
            cornerOf(triangle, 1),
            cornerOf(triangle, 0),
          ] as Triangle,
      ),
    ];
  }
  if (target.kind === "sphere") {
    const outer = sphereTriangles(target.radius);
    const inner = sphereTriangles(target.radius - t);
    return [
      ...outer,
      ...inner.map(
        (triangle) =>
          [
            cornerOf(triangle, 2),
            cornerOf(triangle, 1),
            cornerOf(triangle, 0),
          ] as Triangle,
      ),
    ];
  }
  throw new Error(
    "Invariant violation: the thickened node's target is the pristine box or sphere leaf the builder validated.",
  );
}

/**
 * Exact point-in-shell classification: the box minus the inset cavity open
 * at the removed face. The cavity runs `[t, size−t]` along both cross axes
 * and stops one wall short of the removed side along the face's own axis —
 * a point on a cavity wall or the cavity floor belongs to the solid (the
 * inclusive-boundary convention every leaf here follows), a point strictly
 * inside the cavity does not.
 */
function shellContains(
  shape: ShellNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const insideBox =
    x >= 0 &&
    x <= at(shape.size, 0) &&
    y >= 0 &&
    y <= at(shape.size, 1) &&
    z >= 0 &&
    z <= at(shape.size, 2);
  if (!insideBox) return false;
  const u = shape.face.axis;
  const a = u === 0 ? 1 : 0;
  const b = u === 2 ? 1 : 2;
  const t = shape.thickness;
  const point: Vec3 = [x, y, z];
  const inCavityCross =
    at(point, a) >= t &&
    at(point, a) <= at(shape.size, a) - t &&
    at(point, b) >= t &&
    at(point, b) <= at(shape.size, b) - t;
  if (!inCavityCross) return true;
  const inCavityAlong = shape.face.high
    ? at(point, u) >= t
    : at(point, u) <= at(shape.size, u) - t;
  return !inCavityAlong;
}

/**
 * The analytic open-box volume: the box volume minus the inset cavity —
 * cross-section `(sizeA−2t)(sizeB−2t)` over the two cross axes, depth
 * `sizeU−t` along the removed face's own axis (one wall at the far side,
 * open at the removed side) — exact by the fit battery's validated
 * non-degeneracy.
 */
function shellAnalyticVolume(shape: ShellNode): number {
  const u = shape.face.axis;
  const a = u === 0 ? 1 : 0;
  const b = u === 2 ? 1 : 2;
  const t = shape.thickness;
  const boxVolume = at(shape.size, 0) * at(shape.size, 1) * at(shape.size, 2);
  const cavity =
    (at(shape.size, a) - 2 * t) *
    (at(shape.size, b) - 2 * t) *
    (at(shape.size, u) - t);
  return boxVolume - cavity;
}

/**
 * The shelled box's canonical mesh: FULLY planar — the five kept outer
 * faces of the box, the rim frame around the opening at the removed
 * face's plane, the four inner cavity walls, and the cavity floor — every
 * quad wound so its facet normal points away from the wall material
 * (checked from the actual cross product, never assumed from the
 * construction order, the same discipline as the fillet mesh). No curved
 * piece exists anywhere in the subset.
 */
function shellTriangles(shape: ShellNode): readonly Triangle[] {
  const t = shape.thickness;
  const u = shape.face.axis;
  const a: Axis = u === 0 ? 1 : 0;
  const b: Axis = u === 2 ? 1 : 2;
  const sizeU = at(shape.size, u);
  const sizeA = at(shape.size, a);
  const sizeB = at(shape.size, b);
  const triangles: Triangle[] = [];

  /** Maps components onto the canonical xyz triple by axis. */
  const to3 = (
    axisA: Axis,
    valueA: number,
    axisB: Axis,
    valueB: number,
    axisC: Axis,
    valueC: number,
  ): Vec3 => {
    const point: [number, number, number] = [0, 0, 0];
    point[axisA] = valueA;
    point[axisB] = valueB;
    point[axisC] = valueC;
    return point;
  };

  /** Emits one quad as two triangles wound so the facet normal points along `outward`. */
  const emitQuad = (
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    p4: Vec3,
    outward: Vec3,
  ): void => {
    const e1: Vec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const e2: Vec3 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    const cross: Vec3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const dot =
      cross[0] * outward[0] + cross[1] * outward[1] + cross[2] * outward[2];
    if (dot >= 0) {
      triangles.push([p1, p2, p3], [p1, p3, p4]);
    } else {
      triangles.push([p1, p4, p3], [p1, p3, p2]);
    }
  };

  /**
   * Emits one axis-aligned rectangle in the plane ⟂ `axis` at `coord`,
   * spanning `[o1Low, o1High] × [o2Low, o2High]` over the two non-`axis`
   * axes in their fixed (o1, o2) order.
   */
  const emitAxisRect = (
    axis: Axis,
    coord: number,
    o1Low: number,
    o1High: number,
    o2Low: number,
    o2High: number,
    outward: Vec3,
  ): void => {
    const o1: Axis = axis === 0 ? 1 : 0;
    const o2: Axis = axis === 2 ? 1 : 2;
    emitQuad(
      to3(o1, o1Low, o2, o2Low, axis, coord),
      to3(o1, o1High, o2, o2Low, axis, coord),
      to3(o1, o1High, o2, o2High, axis, coord),
      to3(o1, o1Low, o2, o2High, axis, coord),
      outward,
    );
  };

  /** The ±unit vector along `axis` toward `sign`. */
  const unit = (axis: Axis, sign: 1 | -1): Vec3 =>
    to3(axis, sign, axis, 0, axis, 0);

  // --- kept outer faces: the box's five faces minus the removed one.
  for (const axis of [0, 1, 2] as const) {
    for (const high of [false, true] as const) {
      if (axis === u && high === shape.face.high) continue;
      const o1: Axis = axis === 0 ? 1 : 0;
      const o2: Axis = axis === 2 ? 1 : 2;
      emitAxisRect(
        axis,
        high ? at(shape.size, axis) : 0,
        0,
        at(shape.size, o1),
        0,
        at(shape.size, o2),
        unit(axis, high ? 1 : -1),
      );
    }
  }

  // --- rim frame at the removed face's plane: the face's rectangle minus
  // the cavity opening, as four coplanar strips in the (a, b) frame —
  // all facing away from the wall material behind the plane.
  const openCoord = shape.face.high ? sizeU : 0;
  const openOutward = unit(u, shape.face.high ? 1 : -1);
  const rimStrips = [
    [
      [0, sizeA],
      [0, t],
    ],
    [
      [0, sizeA],
      [sizeB - t, sizeB],
    ],
    [
      [0, t],
      [t, sizeB - t],
    ],
    [
      [sizeA - t, sizeA],
      [t, sizeB - t],
    ],
  ] as const;
  for (const [[aLow, aHigh], [bLow, bHigh]] of rimStrips) {
    emitQuad(
      to3(a, aLow, b, bLow, u, openCoord),
      to3(a, aHigh, b, bLow, u, openCoord),
      to3(a, aHigh, b, bHigh, u, openCoord),
      to3(a, aLow, b, bHigh, u, openCoord),
      openOutward,
    );
  }

  // --- cavity walls: four rectangles ⟂ the cross axes, each spanning the
  // cavity's u-range and the cavity's extent along the other cross axis,
  // facing INTO the cavity (away from the surrounding wall material).
  const floorU = shape.face.high ? t : 0;
  const ceilU = shape.face.high ? sizeU : sizeU - t;
  const cavityWall = (axis: Axis, coord: number, sign: 1 | -1): void => {
    const other: Axis = axis === a ? b : a;
    const otherHigh = (axis === a ? sizeB : sizeA) - t;
    emitQuad(
      to3(axis, coord, other, t, u, floorU),
      to3(axis, coord, other, otherHigh, u, floorU),
      to3(axis, coord, other, otherHigh, u, ceilU),
      to3(axis, coord, other, t, u, ceilU),
      unit(axis, sign),
    );
  };
  cavityWall(a, t, 1);
  cavityWall(a, sizeA - t, -1);
  cavityWall(b, t, 1);
  cavityWall(b, sizeB - t, -1);

  // --- cavity floor: the cavity's closed end (one wall short of the
  // removed side), facing into the cavity.
  const floorCoord = shape.face.high ? t : sizeU - t;
  emitQuad(
    to3(a, t, b, t, u, floorCoord),
    to3(a, sizeA - t, b, t, u, floorCoord),
    to3(a, sizeA - t, b, sizeB - t, u, floorCoord),
    to3(a, t, b, sizeB - t, u, floorCoord),
    unit(u, shape.face.high ? 1 : -1),
  );
  return triangles;
}

/** Analytic volume of a primitive or translated primitive chain, else `undefined`. */
function analyticVolume(shape: FakeShape): number | undefined {
  switch (shape.kind) {
    case "box":
      return at(shape.size, 0) * at(shape.size, 1) * at(shape.size, 2);
    case "sphere":
      return (4 / 3) * Math.PI * shape.radius ** 3;
    case "cylinder":
      return Math.PI * shape.radius ** 2 * shape.height;
    case "cone":
      return (
        (Math.PI *
          shape.height *
          (shape.bottomRadius ** 2 +
            shape.bottomRadius * shape.topRadius +
            shape.topRadius ** 2)) /
        3
      );
    case "translate":
      return analyticVolume(shape.source);
    case "scale":
      // A uniform scale multiplies volume by exactly f³ — for the analytic
      // subset AND for a voxel-quantized boolean (the quantized count
      // scales with the cell volume), so the delegation never
      // double-quantizes.
      return shapeVolume(shape.source) * shape.factor ** 3;
    case "thickened":
      // The analytic closed-hollow decomposition the contract documents:
      // the pristine leaf minus its validated non-degenerate inset — no
      // quadrature anywhere.
      return thickenedAnalyticVolume(shape);
    case "mirror":
      // A reflection is an isometry: the mirrored volume IS the source
      // volume, exactly, for every source (the delegation keeps a voxel-
      // quantized boolean mirrored at its own quantized value, never
      // double-quantized).
      return shapeVolume(shape.source);
    case "extrusion":
      return Math.abs(polygonSignedArea(shape.polygon)) * shape.height;
    case "revolution":
      // Pappus's centroid theorem over the chord polygon — the EXACT swept
      // volume of the represented solid, no quadrature anywhere.
      return revolvePappusVolume(shape.polygon, shape.sweep);
    case "sweep":
      // The Pappus decomposition the contract documents: line pieces by
      // Cavalieri, arc pieces by Pappus about their centre axes — exact
      // over the chord polygon, no quadrature anywhere.
      return sweepAnalyticVolume(shape.polygon, shape.pieces);
    case "wireSweep":
      // Cavalieri over the transported perpendicular sections: a rigid
      // planar profile swept along a non-self-intersecting C1 spine has
      // V = A·L exactly (the contract's pinned reference volume).
      return Math.abs(polygonSignedArea(shape.polygon)) * shape.spineLength;
    case "loft":
      // The Simpson/prismoidal decomposition the contract documents: the
      // morph's cross-section area is quadratic in the span parameter, so
      // each span integrates exactly — no quadrature anywhere.
      return loftAnalyticVolume(shape.polygons, shape.stations);
    case "helix":
      // The screw-solid closed form the contract documents: the transport's
      // Jacobian is (R(t)+u)·|θ'|, so V = τ·A·(R̄ + ū) — exact over the
      // chord polygon, no quadrature anywhere (the node's construction
      // declined overlapping turns, where the form would overcount).
      return helixScrewVolume(shape.polygon, shape.spine);
    case "fillet":
      // The analytic corner-fillet decomposition the contract documents:
      // the box minus each edge's validated-disjoint prism quadrant — no
      // quadrature anywhere.
      return filletAnalyticVolume(shape);
    case "chamfer":
      // The analytic corner-prism decomposition the contract documents: the
      // box minus each edge's validated-disjoint corner prism — no
      // quadrature anywhere.
      return chamferAnalyticVolume(shape);
    case "shell":
      // The analytic open-box decomposition the contract documents: the
      // box minus the single validated non-degenerate inset cavity — no
      // quadrature anywhere.
      return shellAnalyticVolume(shape);
    default:
      return undefined;
  }
}

/** Deterministic voxel quadrature over the shape's conservative bounds. */
function voxelVolume(shape: FakeShape): number {
  const bounds = shapeBounds(shape);
  const minX = boundsAt(bounds, "min", 0);
  const minY = boundsAt(bounds, "min", 1);
  const minZ = boundsAt(bounds, "min", 2);
  const extentX = boundsAt(bounds, "max", 0) - minX;
  const extentY = boundsAt(bounds, "max", 1) - minY;
  const extentZ = boundsAt(bounds, "max", 2) - minZ;
  if (extentX <= 0 || extentY <= 0 || extentZ <= 0) return 0;
  const n = FAKE_KERNEL_VOLUME_RESOLUTION;
  const cellX = extentX / n;
  const cellY = extentY / n;
  const cellZ = extentZ / n;
  let inside = 0;
  for (let i = 0; i < n; i += 1) {
    const x = minX + (i + 0.5) * cellX;
    for (let j = 0; j < n; j += 1) {
      const y = minY + (j + 0.5) * cellY;
      for (let k = 0; k < n; k += 1) {
        const z = minZ + (k + 0.5) * cellZ;
        if (contains(shape, x, y, z)) inside += 1;
      }
    }
  }
  return inside * cellX * cellY * cellZ;
}

function shapeVolume(shape: FakeShape): number {
  return analyticVolume(shape) ?? voxelVolume(shape);
}

/**
 * The analytic surface area of the fake kernel's measured subset — the
 * same closed forms its analytic volumes are — or `undefined` outside it:
 * the four primitives (box `2(wd+dh+wh)`, sphere `4πr²`, cylinder
 * `2πr(r+h)`, frustum lateral + both caps) and the two isometry nodes
 * (`translate`, `mirror` — a reflection preserves area exactly, so both
 * delegate like the volume's mirror delegation does). Every other node
 * declines at the `area` entry point instead of surfacing a number this
 * model cannot honest — booleans have no analytic area (their volumes are
 * the documented voxel quadrature; a voxel grid measures no surface), and
 * the modelled sweep/loft/repair shapes carry no closed form.
 */
function analyticArea(shape: FakeShape): number | undefined {
  switch (shape.kind) {
    case "box":
      return (
        2 *
        (at(shape.size, 0) * at(shape.size, 1) +
          at(shape.size, 1) * at(shape.size, 2) +
          at(shape.size, 0) * at(shape.size, 2))
      );
    case "sphere":
      return 4 * Math.PI * shape.radius ** 2;
    case "cylinder":
      return 2 * Math.PI * shape.radius * (shape.radius + shape.height);
    case "cone": {
      const slant = Math.hypot(
        shape.bottomRadius - shape.topRadius,
        shape.height,
      );
      return (
        Math.PI * (shape.bottomRadius + shape.topRadius) * slant +
        Math.PI * shape.bottomRadius ** 2 +
        Math.PI * shape.topRadius ** 2
      );
    }
    case "translate":
      return analyticArea(shape.source);
    case "mirror":
      return analyticArea(shape.source);
    case "scale": {
      // A uniform scale multiplies area by exactly f² (the isometry
      // nodes' delegation discipline, carried to the one non-isometry
      // transform); the value falls to `undefined` exactly where the
      // source's does, so the area entry point's per-shape decline
      // vocabulary is unchanged.
      const source = analyticArea(shape.source);
      return source === undefined ? undefined : source * shape.factor ** 2;
    }
    case "thickened":
      // The closed hollow's boundary is BOTH surfaces — the outer and the
      // cavity's — each an exact closed form over the pristine leaf.
      return thickenedAnalyticArea(shape);
    default:
      return undefined;
  }
}

function quad(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3): readonly Triangle[] {
  return [
    [p1, p2, p3],
    [p1, p3, p4],
  ];
}

function boxTriangles(w: number, d: number, h: number): readonly Triangle[] {
  return [
    ...quad([0, d, 0], [w, d, 0], [w, 0, 0], [0, 0, 0]),
    ...quad([0, 0, h], [w, 0, h], [w, d, h], [0, d, h]),
    ...quad([0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]),
    ...quad([w, d, 0], [0, d, 0], [0, d, h], [w, d, h]),
    ...quad([0, d, 0], [0, 0, 0], [0, 0, h], [0, d, h]),
    ...quad([w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h]),
  ];
}

function sphereTriangles(radius: number): readonly Triangle[] {
  const segments = FAKE_KERNEL_TESSELLATION_SEGMENTS;
  const rings = FAKE_KERNEL_TESSELLATION_RINGS;
  const at = (ring: number, seg: number): Vec3 => {
    const phi = (Math.PI * ring) / rings;
    const theta = (2 * Math.PI * seg) / segments;
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    ];
  };
  const top = at(0, 0);
  const bottom = at(rings, 0);
  const triangles: Triangle[] = [];
  for (let seg = 0; seg < segments; seg += 1) {
    // Cap fans are wound CCW seen from outside: increasing longitude at the
    // north pole, decreasing at the south (mirrored), so facet normals point
    // away from the sphere's centre.
    triangles.push([top, at(1, seg), at(1, seg + 1)]);
    triangles.push([bottom, at(rings - 1, seg + 1), at(rings - 1, seg)]);
    for (let ring = 1; ring < rings - 1; ring += 1) {
      triangles.push([at(ring, seg), at(ring + 1, seg), at(ring + 1, seg + 1)]);
      triangles.push([at(ring, seg), at(ring + 1, seg + 1), at(ring, seg + 1)]);
    }
  }
  return triangles;
}

function cylinderTriangles(
  radius: number,
  height: number,
): readonly Triangle[] {
  const segments = FAKE_KERNEL_TESSELLATION_SEGMENTS;
  const ringAt = (z: number, seg: number): Vec3 => {
    const theta = (2 * Math.PI * seg) / segments;
    return [radius * Math.cos(theta), radius * Math.sin(theta), z];
  };
  const triangles: Triangle[] = [];
  for (let seg = 0; seg < segments; seg += 1) {
    const bottom0 = ringAt(0, seg);
    const bottom1 = ringAt(0, seg + 1);
    const top0 = ringAt(height, seg);
    const top1 = ringAt(height, seg + 1);
    triangles.push([bottom0, bottom1, top1], [bottom0, top1, top0]);
    triangles.push([[0, 0, 0], bottom1, bottom0]);
    triangles.push([[0, 0, height], top0, top1]);
  }
  return triangles;
}

function coneTriangles(
  bottomRadius: number,
  topRadius: number,
  height: number,
): readonly Triangle[] {
  const segments = FAKE_KERNEL_TESSELLATION_SEGMENTS;
  const bottomAt = (seg: number): Vec3 => {
    const theta = (2 * Math.PI * seg) / segments;
    return [bottomRadius * Math.cos(theta), bottomRadius * Math.sin(theta), 0];
  };
  const triangles: Triangle[] = [];
  if (topRadius === 0) {
    const apex: Vec3 = [0, 0, height];
    for (let seg = 0; seg < segments; seg += 1) {
      // The apex fan follows the frustum side winding (increasing longitude)
      // so its facets face outward, away from the cone's axis.
      triangles.push([apex, bottomAt(seg), bottomAt(seg + 1)]);
      triangles.push([[0, 0, 0], bottomAt(seg + 1), bottomAt(seg)]);
    }
    return triangles;
  }
  const topAt = (seg: number): Vec3 => {
    const theta = (2 * Math.PI * seg) / segments;
    return [topRadius * Math.cos(theta), topRadius * Math.sin(theta), height];
  };
  for (let seg = 0; seg < segments; seg += 1) {
    triangles.push([bottomAt(seg), bottomAt(seg + 1), topAt(seg + 1)]);
    triangles.push([bottomAt(seg), topAt(seg + 1), topAt(seg)]);
    triangles.push([[0, 0, 0], bottomAt(seg + 1), bottomAt(seg)]);
    triangles.push([[0, 0, height], topAt(seg), topAt(seg + 1)]);
  }
  return triangles;
}

function primitiveTriangles(
  shape:
    | Primitive
    | ExtrusionNode
    | RevolutionNode
    | SweepNode
    | WireSweepNode
    | LoftNode
    | HelixNode
    | FilletNode
    | ChamferNode
    | ShellNode
    | ThickenedNode,
): readonly Triangle[] {
  switch (shape.kind) {
    case "box":
      return boxTriangles(
        at(shape.size, 0),
        at(shape.size, 1),
        at(shape.size, 2),
      );
    case "sphere":
      return sphereTriangles(shape.radius);
    case "cylinder":
      return cylinderTriangles(shape.radius, shape.height);
    case "cone":
      return coneTriangles(shape.bottomRadius, shape.topRadius, shape.height);
    case "extrusion":
      return extrusionTriangles(shape);
    case "revolution":
      return revolutionTriangles(shape);
    case "sweep":
      return sweepTriangles(shape);
    case "wireSweep":
      return wireSweepTriangles(shape);
    case "loft":
      return loftTriangles(shape);
    case "helix":
      return helixTriangles(shape);
    case "fillet":
      return filletTriangles(shape);
    case "chamfer":
      return chamferTriangles(shape);
    case "shell":
      return shellTriangles(shape);
    case "thickened":
      return thickenedTriangles(shape);
  }
}

/**
 * The placed prism's canonical mesh: the chord polygon's caps fanned from
 * vertex 0 and one quad wall per polygon edge, all vertices placed by the
 * rotation-then-translation placement. Winding is normalized to a CCW
 * polygon at construction, so every facet's outward normal follows from the
 * winding (the shared per-facet normal computation reads it off).
 */
function extrusionTriangles(shape: ExtrusionNode): readonly Triangle[] {
  const zBase = shape.baseZ;
  const zTop = shape.baseZ + shape.height;
  const world = (vertex: ProfilePoint2, z: number): Vec3 => {
    const rotated = applyMatrix3(shape.rotation, [vertex.x, vertex.y, z]);
    return [
      rotated[0] + at(shape.translation, 0),
      rotated[1] + at(shape.translation, 1),
      rotated[2] + at(shape.translation, 2),
    ];
  };
  const polygon = shape.polygon;
  const count = polygon.length;
  const triangles: Triangle[] = [];
  for (let i = 1; i < count - 1; i += 1) {
    const a = polygon[i];
    const b = polygon[i + 1];
    if (a === undefined || b === undefined) continue;
    triangles.push([
      world(polygon[0] ?? a, zTop),
      world(a, zTop),
      world(b, zTop),
    ]);
    triangles.push([
      world(polygon[0] ?? a, zBase),
      world(b, zBase),
      world(a, zBase),
    ]);
  }
  for (let i = 0; i < count; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % count];
    if (a === undefined || b === undefined) continue;
    const aBase = world(a, zBase);
    const bBase = world(b, zBase);
    const bTop = world(b, zTop);
    const aTop = world(a, zTop);
    triangles.push([aBase, bBase, bTop], [aBase, bTop, aTop]);
  }
  return triangles;
}

/**
 * The placed revolution's canonical mesh: the axis-frame chord polygon
 * revolved at the shared angular deflection (rings every
 * {@link PROFILE_MAX_SEGMENT_ANGLE_RAD} or finer), one wall quad per
 * polygon edge and ring pair, and — partial sweeps only — a fan cap per
 * end plane. Vertices on the axis degenerate some wall triangles to zero
 * area (an on-axis edge sweeps to a line, not a surface); those are
 * skipped, exactly the cone's apex-fan honesty in reverse. Winding: the
 * polygon is CCW in (axial, signed-radial); walls on the +radial branch
 * and both caps then wind outward directly, walls on the −radial branch
 * flip (the sweep embeds that branch with reversed orientation).
 */
function revolutionTriangles(shape: RevolutionNode): readonly Triangle[] {
  const sweep = shape.sweep;
  const full = sweep >= Math.PI * 2;
  const steps = Math.max(1, Math.ceil(sweep / PROFILE_MAX_SEGMENT_ANGLE_RAD));
  const delta = sweep / steps;
  const polygon = shape.polygon;
  const count = polygon.length;

  /** Local point (axial a, signed radial s) swept to angle phi, then placed. */
  const world = (a: number, s: number, phi: number): Vec3 => {
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    // Axis frame in local coordinates: (a·u) + (s·cosφ)·v + (s·sinφ)·ẑ —
    // the sweep starts in the profile plane (φ = 0) toward local +z.
    const local: Vec3 = [
      at(shape.origin, 0) + a * at(shape.u, 0) + s * cos * at(shape.v, 0),
      at(shape.origin, 1) + a * at(shape.u, 1) + s * cos * at(shape.v, 1),
      at(shape.origin, 2) + s * sin,
    ];
    const rotated = applyMatrix3(shape.rotation, local);
    return [
      rotated[0] + at(shape.translation, 0),
      rotated[1] + at(shape.translation, 1),
      rotated[2] + at(shape.translation, 2),
    ];
  };
  /** Ring `r`'s world vertices (ring 0 replayed for the full sweep's wrap). */
  const ringAt = (r: number): readonly Vec3[] => {
    const phi = r === steps ? (full ? 0 : sweep) : r * delta;
    return polygon.map((vertex) => world(vertex.x, vertex.y, phi));
  };

  const distinct = (triangle: Triangle): boolean => {
    for (let i = 0; i < 3; i += 1) {
      const p = triangle[i];
      const q = triangle[(i + 1) % 3];
      if (
        p === undefined ||
        q === undefined ||
        (at(p, 0) === at(q, 0) &&
          at(p, 1) === at(q, 1) &&
          at(p, 2) === at(q, 2))
      ) {
        return false;
      }
    }
    return true;
  };

  const triangles: Triangle[] = [];
  // An edge lies on the −radial branch exactly when its vertices do (the
  // crossing rejection forbids straddling; a touching vertex at s = 0
  // belongs to the + side, where the direct winding is already outward).
  const flippedEdge: boolean[] = polygon.map((vertex) => vertex.y < 0);
  for (let r = 0; r < steps; r += 1) {
    const ringA = ringAt(r);
    const ringB = ringAt(r + 1);
    for (let i = 0; i < count; i += 1) {
      const indexB = (i + 1) % count;
      const a = ringA[i];
      const b = ringA[indexB];
      const bNext = ringB[indexB];
      const aNext = ringB[i];
      if (
        a === undefined ||
        b === undefined ||
        bNext === undefined ||
        aNext === undefined
      ) {
        continue;
      }
      // The sweep moves +phi; on the −radial branch that direction reads
      // reversed, so the quad's winding flips to stay outward.
      const flip = flippedEdge[i] || flippedEdge[indexB];
      const quad: readonly Triangle[] = flip
        ? [
            [a, bNext, b],
            [a, aNext, bNext],
          ]
        : [
            [a, b, bNext],
            [a, bNext, aNext],
          ];
      for (const triangle of quad) {
        if (distinct(triangle)) triangles.push(triangle);
      }
    }
  }
  if (!full) {
    const start = ringAt(0);
    const end = ringAt(steps);
    for (let i = 1; i < count - 1; i += 1) {
      const a = polygon[i];
      const b = polygon[i + 1];
      if (a === undefined || b === undefined) continue;
      const first = start[0];
      const endA = end[i];
      const endB = end[i + 1];
      const startA = start[i];
      const startB = start[i + 1];
      if (
        first === undefined ||
        endA === undefined ||
        endB === undefined ||
        startA === undefined ||
        startB === undefined
      ) {
        continue;
      }
      const endCap: Triangle = [first, endA, endB];
      const startCap: Triangle = [first, startB, startA];
      for (const triangle of [endCap, startCap]) {
        if (distinct(triangle)) triangles.push(triangle);
      }
    }
  }
  return triangles;
}

/**
 * The placed sweep's canonical mesh: every piece's stations at the shared
 * angular deflection, one wall quad per polygon edge and station pair
 * (line pieces are the prism walls of `extrusionTriangles`; arc pieces the
 * revolution walls of `revolutionTriangles` with the same
 * negative-radius-branch flip — direction-independent, since a vertex at
 * positive signed radius advances along +t between stations in either
 * sweep direction), and — OPEN paths only — a fan cap at each chain end.
 * Degenerate quads (an on-axis vertex pair sweeping to a line, or a
 * station pair collapsing at a joint) are skipped exactly like the
 * revolution's. Closed rings carry no caps: the tube closes on itself.
 */
function sweepTriangles(shape: SweepNode): readonly Triangle[] {
  const triangles: Triangle[] = [];

  const world = (station: SweepStation, u: number, v: number): Vec3 => {
    const rotated = applyMatrix3(
      shape.rotation,
      sweepStationVertex(station, u, v),
    );
    return [
      rotated[0] + at(shape.translation, 0),
      rotated[1] + at(shape.translation, 1),
      rotated[2] + at(shape.translation, 2),
    ];
  };

  const distinct = (triangle: Triangle): boolean => {
    for (let i = 0; i < 3; i += 1) {
      const p = triangle[i];
      const q = triangle[(i + 1) % 3];
      if (
        p === undefined ||
        q === undefined ||
        (at(p, 0) === at(q, 0) &&
          at(p, 1) === at(q, 1) &&
          at(p, 2) === at(q, 2))
      ) {
        return false;
      }
    }
    return true;
  };

  for (const piece of shape.pieces) {
    const stations = sweepPieceStations(piece);
    for (let s = 0; s + 1 < stations.length; s += 1) {
      const here = stations[s];
      const next = stations[s + 1];
      if (here === undefined || next === undefined) continue;
      const count = shape.polygon.length;
      for (let i = 0; i < count; i += 1) {
        const a = shape.polygon[i];
        const b = shape.polygon[(i + 1) % count];
        if (a === undefined || b === undefined) continue;
        const aHere = world(here, a.x, a.y);
        const bHere = world(here, b.x, b.y);
        const bNext = world(next, b.x, b.y);
        const aNext = world(next, a.x, a.y);
        // A vertex at positive signed radius s = R + sign(θ)·u advances
        // along +t between consecutive stations in EITHER sweep
        // direction (the station frame is right-handed and rigid), so
        // the direct prism/revolution winding is outward for s > 0 in
        // both; only an edge on the negative-radius branch (s < 0, the
        // mirror side of the axis) embeds reversed — the revolution's
        // flip, direction-independent (verified numerically on both
        // bend directions).
        const flip =
          piece.kind === "arc" &&
          (piece.radius + (piece.sweep > 0 ? 1 : -1) * a.x < 0 ||
            piece.radius + (piece.sweep > 0 ? 1 : -1) * b.x < 0);
        const quad: readonly Triangle[] = flip
          ? [
              [aHere, bNext, bHere],
              [aHere, aNext, bNext],
            ]
          : [
              [aHere, bHere, bNext],
              [aHere, bNext, aNext],
            ];
        for (const triangle of quad) {
          if (distinct(triangle)) triangles.push(triangle);
        }
      }
    }
  }

  if (!shape.closed && shape.pieces.length > 0) {
    const firstPiece = shape.pieces[0];
    const lastPiece = shape.pieces[shape.pieces.length - 1];
    if (firstPiece !== undefined && lastPiece !== undefined) {
      const startStation = sweepPieceStations(firstPiece)[0];
      const lastStations = sweepPieceStations(lastPiece);
      const endStation = lastStations[lastStations.length - 1];
      if (startStation !== undefined && endStation !== undefined) {
        const count = shape.polygon.length;
        const apex = shape.polygon[0];
        if (apex !== undefined) {
          for (let i = 1; i < count - 1; i += 1) {
            const a = shape.polygon[i];
            const b = shape.polygon[i + 1];
            if (a === undefined || b === undefined) continue;
            const startApex = world(startStation, apex.x, apex.y);
            const endApex = world(endStation, apex.x, apex.y);
            // The start cap faces back along the path, the end cap forward
            // — the same polygon-vertex-0 fan pair `extrusionTriangles`
            // builds at its caps (never the frame origin: an off-origin
            // profile would fan outside its boundary).
            const startCap: Triangle = [
              startApex,
              world(startStation, b.x, b.y),
              world(startStation, a.x, a.y),
            ];
            const endCap: Triangle = [
              endApex,
              world(endStation, a.x, a.y),
              world(endStation, b.x, b.y),
            ];
            for (const triangle of [startCap, endCap]) {
              if (distinct(triangle)) triangles.push(triangle);
            }
          }
        }
      }
    }
  }
  return triangles;
}

/**
 * The placed loft's canonical mesh: per span, one wall quad per polygon
 * edge pair (station polygon j's edge i against station polygon j+1's
 * edge i — both CCW, so the direct prism winding is outward,
 * triangulated into two flat triangles), and fan caps on the FIRST and
 * LAST polygons only (the intermediate stations are interior).
 * Degenerate triangles (a wall collapsing when corresponding vertices
 * coincide) are skipped exactly like the extrusion's. Honesty: flat
 * triangles represent a ruled wall EXACTLY only where the wall is planar
 * (every untwisted loft); a SKEW (twisted) wall's bilinear patch carries
 * the flat pair as a candidate triangulation — the boolean-soup honesty
 * applied to a leaf, with the semantic truth in `volume`/`bounds` (which
 * measure the ruled model exactly).
 */
function loftTriangles(shape: LoftNode): readonly Triangle[] {
  const triangles: Triangle[] = [];

  const world = (vertex: ProfilePoint2, z: number): Vec3 => {
    const rotated = applyMatrix3(shape.rotation, [vertex.x, vertex.y, z]);
    return [
      rotated[0] + at(shape.translation, 0),
      rotated[1] + at(shape.translation, 1),
      rotated[2] + at(shape.translation, 2),
    ];
  };

  const distinct = (triangle: Triangle): boolean => {
    for (let i = 0; i < 3; i += 1) {
      const p = triangle[i];
      const q = triangle[(i + 1) % 3];
      if (
        p === undefined ||
        q === undefined ||
        (at(p, 0) === at(q, 0) &&
          at(p, 1) === at(q, 1) &&
          at(p, 2) === at(q, 2))
      ) {
        return false;
      }
    }
    return true;
  };

  for (let s = 0; s + 1 < shape.polygons.length; s += 1) {
    const here = shape.polygons[s];
    const next = shape.polygons[s + 1];
    const zHere = shape.stations[s];
    const zNext = shape.stations[s + 1];
    if (
      here === undefined ||
      next === undefined ||
      zHere === undefined ||
      zNext === undefined
    ) {
      continue;
    }
    const count = here.length;
    for (let i = 0; i < count; i += 1) {
      const a = here[i];
      const b = here[(i + 1) % count];
      const aNext = next[i];
      const bNext = next[(i + 1) % count];
      if (
        a === undefined ||
        b === undefined ||
        aNext === undefined ||
        bNext === undefined
      ) {
        continue;
      }
      const aHere = world(a, zHere);
      const bHere = world(b, zHere);
      const bTop = world(bNext, zNext);
      const aTop = world(aNext, zNext);
      const quad: readonly Triangle[] = [
        [aHere, bHere, bTop],
        [aHere, bTop, aTop],
      ];
      for (const triangle of quad) {
        if (distinct(triangle)) triangles.push(triangle);
      }
    }
  }

  const first = shape.polygons[0];
  const last = shape.polygons[shape.polygons.length - 1];
  const zFirst = shape.stations[0];
  const zLast = shape.stations[shape.stations.length - 1];
  if (
    first !== undefined &&
    last !== undefined &&
    zFirst !== undefined &&
    zLast !== undefined
  ) {
    for (const [polygon, z, flip] of [
      [first, zFirst, true],
      [last, zLast, false],
    ] as const) {
      const count = polygon.length;
      for (let i = 1; i < count - 1; i += 1) {
        const a = polygon[i];
        const b = polygon[i + 1];
        if (a === undefined || b === undefined) continue;
        const apex = world(polygon[0] ?? a, z);
        const fan: Triangle = flip
          ? [apex, world(b, z), world(a, z)]
          : [apex, world(a, z), world(b, z)];
        if (distinct(fan)) triangles.push(fan);
      }
    }
  }
  return triangles;
}

/**
 * The placed helix's bounds: the LOCAL screw-solid box (untapered: the
 * exact angular-support extremes of the radius band — see
 * `helixUntaperedLocalBounds`; tapered: the hull of the station
 * polygons' vertices at the shared station resolution, the soup's own
 * deflection) hulled through the placement's eight box corners — tight
 * whenever the placement is axis-aligned (the thread features' world-axis
 * and datum-axis placements), a conservative container for oblique ones,
 * the revolution-bounds discipline.
 */
function helixBounds(shape: HelixNode): KernelBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const hullLocal = (local: readonly [number, number, number]): void => {
    const world = applyMatrix3(shape.rotation, local);
    const x = world[0] + at(shape.translation, 0);
    const y = world[1] + at(shape.translation, 1);
    const z = world[2] + at(shape.translation, 2);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  };
  if (shape.spine.taperMm === 0) {
    const box = helixUntaperedLocalBounds(shape.polygon, shape.spine);
    for (const x of [box.min[0], box.max[0]]) {
      for (const y of [box.min[1], box.max[1]]) {
        for (const z of [box.min[2], box.max[2]]) {
          hullLocal([x, y, z]);
        }
      }
    }
    return boundsOf([minX, minY, minZ], [maxX, maxY, maxZ]);
  }
  for (const t of helixStations(shape.spine)) {
    for (const vertex of shape.polygon) {
      hullLocal(helixTransportPoint(shape.spine, vertex.x, vertex.y, t));
    }
  }
  return boundsOf([minX, minY, minZ], [maxX, maxY, maxZ]);
}

/**
 * Exact point-in-helix classification: the query is un-placed into the
 * local frame, read in cylindrical coordinates, and the screw-solid
 * branch test checks every 2π branch the swept angle range covers (see
 * `helixScrewContains`). The linear slack mirrors the sweep classification.
 */
function helixContains(
  shape: HelixNode,
  x: number,
  y: number,
  z: number,
): boolean {
  const local = applyMatrix3(transpose3(shape.rotation), [
    x - at(shape.translation, 0),
    y - at(shape.translation, 1),
    z - at(shape.translation, 2),
  ]);
  const lx = local[0] ?? 0;
  const ly = local[1] ?? 0;
  const lz = local[2] ?? 0;
  const radius = Math.hypot(lx, ly);
  const angle = Math.atan2(ly, lx);
  return helixScrewContains(
    shape.polygon,
    shape.spine,
    radius,
    angle,
    lz,
    SWEEP_LINEAR_EPSILON_MM,
  );
}

/**
 * The placed helix's canonical mesh: the exact transported profile polygon
 * at every station of the shared station rule (one per
 * `PROFILE_STATION_ANGLE_RAD` of swept angle), one wall quad per
 * consecutive-station edge pair (the polygon is CCW and the transport is a
 * rigid motion per station, so the direct prism winding is outward),
 * fanned caps on the FIRST and LAST stations, degenerate triangles
 * skipped. Honesty: the walls are the RULED approximation of the screw
 * motion between stations — the same class of chord band every curved
 * segment carries — while `volume`/`bounds`/`contains` measure the exact
 * screw solid; deterministic by the fixed station rule, which is what the
 * byte-determinism pins ride on.
 */
function helixTriangles(shape: HelixNode): readonly Triangle[] {
  const triangles: Triangle[] = [];
  const stations = helixStations(shape.spine);
  const world = (vertex: ProfilePoint2, t: number): Vec3 => {
    const local = helixTransportPoint(shape.spine, vertex.x, vertex.y, t);
    const rotated = applyMatrix3(shape.rotation, [
      local[0],
      local[1],
      local[2],
    ]);
    return [
      rotated[0] + at(shape.translation, 0),
      rotated[1] + at(shape.translation, 1),
      rotated[2] + at(shape.translation, 2),
    ];
  };
  const distinct = (triangle: Triangle): boolean => {
    for (let i = 0; i < 3; i += 1) {
      const p = triangle[i];
      const q = triangle[(i + 1) % 3];
      if (
        p === undefined ||
        q === undefined ||
        (at(p, 0) === at(q, 0) &&
          at(p, 1) === at(q, 1) &&
          at(p, 2) === at(q, 2))
      ) {
        return false;
      }
    }
    return true;
  };
  for (let s = 0; s + 1 < stations.length; s += 1) {
    const here = stations[s];
    const next = stations[s + 1];
    if (here === undefined || next === undefined) continue;
    const count = shape.polygon.length;
    for (let i = 0; i < count; i += 1) {
      const a = shape.polygon[i];
      const b = shape.polygon[(i + 1) % count];
      if (a === undefined || b === undefined) continue;
      const aHere = world(a, here);
      const bHere = world(b, here);
      const bTop = world(b, next);
      const aTop = world(a, next);
      const quad: readonly Triangle[] = [
        [aHere, bHere, bTop],
        [aHere, bTop, aTop],
      ];
      for (const triangle of quad) {
        if (distinct(triangle)) triangles.push(triangle);
      }
    }
  }
  const first = stations[0];
  const last = stations[stations.length - 1];
  if (first !== undefined && last !== undefined) {
    for (const [t, flip] of [
      [first, true],
      [last, false],
    ] as const) {
      const count = shape.polygon.length;
      for (let i = 1; i < count - 1; i += 1) {
        const a = shape.polygon[i];
        const b = shape.polygon[i + 1];
        if (a === undefined || b === undefined) continue;
        const apex = world(shape.polygon[0] ?? a, t);
        const fan: Triangle = flip
          ? [apex, world(b, t), world(a, t)]
          : [apex, world(a, t), world(b, t)];
        if (distinct(fan)) triangles.push(fan);
      }
    }
  }
  return triangles;
}

/**
 * One affine step on a leaf's path from its primitive mesh to world space:
 * a translation (the `translate` node's) or a reflection (the Phase 26.9
 * `mirror` node's). Translations alone commute, so they once folded into a
 * single offset vector; a reflection composes with them ORDER-SENSITIVELY,
 * so the leaf now carries its steps as an ordered chain, applied
 * innermost-first (the array is ordered outermost-first, exactly the
 * encounter order of the walk that built it).
 */
type LeafStep =
  | { readonly kind: "shift"; readonly offset: Vec3 }
  | {
      readonly kind: "reflect";
      readonly axis: Axis;
      readonly planeOffset: number;
    }
  | { readonly kind: "scale"; readonly factor: number };

/** A primitive leaf paired with the affine chain accumulated along its path. */
interface Leaf {
  readonly primitive:
    | Primitive
    | ExtrusionNode
    | RevolutionNode
    | SweepNode
    | WireSweepNode
    | LoftNode
    | HelixNode
    | FilletNode
    | ChamferNode
    | ShellNode
    | ThickenedNode;
  readonly steps: readonly LeafStep[];
}

/** The extrusion leaf node type. */
type ExtrusionNode = Extract<FakeShape, { kind: "extrusion" }>;

function collectLeaves(
  shape: FakeShape,
  steps: readonly LeafStep[],
  out: Leaf[],
): void {
  switch (shape.kind) {
    case "box":
    case "sphere":
    case "cylinder":
    case "cone":
    case "extrusion":
    case "revolution":
    case "sweep":
    case "wireSweep":
    case "loft":
    case "helix":
    case "fillet":
    case "chamfer":
    case "shell":
    case "thickened":
      out.push({ primitive: shape, steps });
      return;
    case "union":
      for (const operand of shape.operands) collectLeaves(operand, steps, out);
      return;
    case "subtract":
      collectLeaves(shape.target, steps, out);
      for (const tool of shape.tools) collectLeaves(tool, steps, out);
      return;
    case "intersect":
      for (const operand of shape.operands) collectLeaves(operand, steps, out);
      return;
    case "translate":
      collectLeaves(
        shape.source,
        [...steps, { kind: "shift", offset: shape.offset }],
        out,
      );
      return;
    case "scale":
      collectLeaves(
        shape.source,
        [...steps, { kind: "scale", factor: shape.factor }],
        out,
      );
      return;
    case "mirror":
      collectLeaves(
        shape.source,
        [
          ...steps,
          { kind: "reflect", axis: shape.axis, planeOffset: shape.planeOffset },
        ],
        out,
      );
      return;
  }
}

const KEEP_EPSILON_MM = 1e-9;

function pointWithinBox(point: Vec3, bounds: KernelBounds): boolean {
  for (const axis of [0, 1, 2] as const) {
    const value = at(point, axis);
    if (
      value < boundsAt(bounds, "min", axis) - KEEP_EPSILON_MM ||
      value > boundsAt(bounds, "max", axis) + KEEP_EPSILON_MM
    ) {
      return false;
    }
  }
  return true;
}

function cornerOf(triangle: Triangle, corner: 0 | 1 | 2): Vec3 {
  const value = triangle[corner];
  if (value === undefined) {
    throw new Error(
      "Invariant violation: a canonical triangle always has three corners.",
    );
  }
  return value;
}

function shiftedTriangle(triangle: Triangle, offset: Vec3): Triangle {
  return [
    shifted(cornerOf(triangle, 0), offset),
    shifted(cornerOf(triangle, 1), offset),
    shifted(cornerOf(triangle, 2), offset),
  ] as Triangle;
}

/** Scales a triangle's corners by the strictly positive factor (winding kept). */
function scaledTriangle(triangle: Triangle, factor: number): Triangle {
  return [
    [
      cornerOf(triangle, 0)[0] * factor,
      cornerOf(triangle, 0)[1] * factor,
      cornerOf(triangle, 0)[2] * factor,
    ],
    [
      cornerOf(triangle, 1)[0] * factor,
      cornerOf(triangle, 1)[1] * factor,
      cornerOf(triangle, 1)[2] * factor,
    ],
    [
      cornerOf(triangle, 2)[0] * factor,
      cornerOf(triangle, 2)[1] * factor,
      cornerOf(triangle, 2)[2] * factor,
    ],
  ] as Triangle;
}

/**
 * The reflected triangle: corners flip on the plane's axis
 * (`c → 2·planeOffset − c`) and the winding SWAPS — a reflection inverts
 * orientation, so restoring the corner order restores the outward-facing
 * winding (and with it the per-facet normal, which the tessellation
 * derives from the winding).
 */
function reflectedTriangle(
  triangle: Triangle,
  axis: Axis,
  planeOffset: number,
): Triangle {
  const flip = (point: Vec3): Vec3 => [
    axis === 0 ? 2 * planeOffset - at(point, 0) : at(point, 0),
    axis === 1 ? 2 * planeOffset - at(point, 1) : at(point, 1),
    axis === 2 ? 2 * planeOffset - at(point, 2) : at(point, 2),
  ];
  return [
    flip(cornerOf(triangle, 0)),
    flip(cornerOf(triangle, 2)),
    flip(cornerOf(triangle, 1)),
  ];
}

/**
 * The final triangle list of a shape's tessellation: canonical primitive
 * meshes, exactly shifted by translations and reflected by mirrors, and
 * for booleans the filtered leaf concatenation (empty when the boolean
 * quantifies as empty).
 */
function renderTriangles(shape: FakeShape): readonly Triangle[] {
  switch (shape.kind) {
    case "box":
    case "sphere":
    case "cylinder":
    case "cone":
      return primitiveTriangles(shape);
    case "extrusion":
      return extrusionTriangles(shape);
    case "revolution":
      return revolutionTriangles(shape);
    case "sweep":
      return sweepTriangles(shape);
    case "wireSweep":
      return wireSweepTriangles(shape);
    case "loft":
      return loftTriangles(shape);
    case "fillet":
      return filletTriangles(shape);
    case "chamfer":
      return chamferTriangles(shape);
    case "shell":
      return shellTriangles(shape);
    case "translate":
      return renderTriangles(shape.source).map((triangle) =>
        shiftedTriangle(triangle, shape.offset),
      );
    case "scale":
      // The strictly positive factor preserves orientation, so the scaled
      // triangles keep their winding — outward stays outward.
      return renderTriangles(shape.source).map((triangle) =>
        scaledTriangle(triangle, shape.factor),
      );
    case "thickened":
      return thickenedTriangles(shape);
    case "mirror":
      return renderTriangles(shape.source).map((triangle) =>
        reflectedTriangle(triangle, shape.axis, shape.planeOffset),
      );
    default:
      break;
  }
  if (voxelVolume(shape) === 0) return [];
  const bounds = shapeBounds(shape);
  const leaves: Leaf[] = [];
  collectLeaves(shape, [], leaves);
  const candidates: Triangle[] = [];
  for (const leaf of leaves) {
    for (const triangle of primitiveTriangles(leaf.primitive)) {
      // Apply the leaf's affine chain innermost-first: the steps array is
      // ordered outermost-first (the walk's encounter order), so reverse it.
      let candidate = triangle;
      for (let i = leaf.steps.length - 1; i >= 0; i -= 1) {
        const step = leaf.steps[i];
        if (step === undefined) continue;
        candidate =
          step.kind === "shift"
            ? shiftedTriangle(candidate, step.offset)
            : step.kind === "scale"
              ? scaledTriangle(candidate, step.factor)
              : reflectedTriangle(candidate, step.axis, step.planeOffset);
      }
      candidates.push(candidate);
    }
  }
  // The every-corner filter keeps the deterministic subset soup; when it
  // keeps NOTHING for a positive-volume boolean (a small corner-overlap
  // intersection whose every operand triangle has a corner outside the
  // node box), fall back to any-corner so the contract's "zero triangles
  // exactly for empty solids" biconditional holds.
  const kept = candidates.filter((triangle) =>
    triangle.every((corner) => pointWithinBox(corner, bounds)),
  );
  if (kept.length > 0) return kept;
  return candidates.filter((triangle) =>
    triangle.some((corner) => pointWithinBox(corner, bounds)),
  );
}

/**
 * The outward unit normal of a canonical triangle: the normalized cross
 * product of two edge vectors, following the triangle's (consistently
 * outward, CCW-seen-from-outside) winding. Canonical meshes never contain
 * degenerate triangles, so the cross product is always non-zero.
 */
function triangleNormal(triangle: Triangle): Vec3 {
  const p1 = cornerOf(triangle, 0);
  const p2 = cornerOf(triangle, 1);
  const p3 = cornerOf(triangle, 2);
  const e1: Vec3 = [
    at(p2, 0) - at(p1, 0),
    at(p2, 1) - at(p1, 1),
    at(p2, 2) - at(p1, 2),
  ];
  const e2: Vec3 = [
    at(p3, 0) - at(p1, 0),
    at(p3, 1) - at(p1, 1),
    at(p3, 2) - at(p1, 2),
  ];
  const cx = at(e1, 1) * at(e2, 2) - at(e1, 2) * at(e2, 1);
  const cy = at(e1, 2) * at(e2, 0) - at(e1, 0) * at(e2, 2);
  const cz = at(e1, 0) * at(e2, 1) - at(e1, 1) * at(e2, 0);
  const length = Math.hypot(cx, cy, cz);
  if (!(length > 0)) {
    throw new Error(
      "Invariant violation: canonical triangles are never degenerate.",
    );
  }
  return [cx / length, cy / length, cz / length];
}

function shapeTessellation(shape: FakeShape): Tessellation {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const triangle of renderTriangles(shape)) {
    const normal = triangleNormal(triangle);
    const base = positions.length / 3;
    for (const corner of triangle) {
      positions.push(at(corner, 0), at(corner, 1), at(corner, 2));
      normals.push(at(normal, 0), at(normal, 1), at(normal, 2));
    }
    indices.push(base, base + 1, base + 2);
  }
  return normals.length > 0
    ? { positions, indices, normals }
    : { positions, indices };
}

function kernelError(code: KernelErrorCode, message: string): KernelError {
  return { code, message, input: null };
}

/**
 * Creates a fresh fake kernel instance. Handles are owned per instance;
 * create one per evaluation context (the executor bridge does).
 */
export function createFakeKernel(): GeometryKernel {
  const tag = createSolidTag<FakeShape>();
  const volumeCache = new WeakMap<KernelSolid, number>();

  const shapeOf = (
    solid: KernelSolid,
    operation: string,
  ): KernelResult<FakeShape> => {
    const shape = tag.unwrap(solid);
    if (shape === undefined) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.solidNotOwned,
          `${operation} rejected a solid handle that this kernel instance did not create.`,
        ),
      );
    }
    return ok(shape);
  };

  const volumeOf = (solid: KernelSolid): KernelResult<number> => {
    const shape = tag.unwrap(solid);
    if (shape === undefined) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.solidNotOwned,
          "volume rejected a solid handle that this kernel instance did not create.",
        ),
      );
    }
    const cached = volumeCache.get(solid);
    if (cached !== undefined) return ok(cached);
    const measured = shapeVolume(shape);
    volumeCache.set(solid, measured);
    return ok(measured);
  };

  const positiveLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    // The throwing seam is only valueIn's non-finite-magnitude parse; the
    // same normalization mirror applies (mirror's documented discipline).
    try {
      const mm = valueIn(value, "mm");
      if (!(mm > 0)) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `${operation} rejected ${name} ${mm} mm: it must be strictly positive.`,
          ),
        );
      }
      return ok(mm);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidLength,
          `${operation} rejected ${name}: ${detail}`,
        ),
      );
    }
  };

  const nonNegativeLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    // The same no-throw normalization as positiveLength.
    try {
      const mm = valueIn(value, "mm");
      if (!(mm >= 0)) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `${operation} rejected ${name} ${mm} mm: it must not be negative.`,
          ),
        );
      }
      return ok(mm);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidLength,
          `${operation} rejected ${name}: ${detail}`,
        ),
      );
    }
  };

  /**
   * Builds the fillet node (Phase 26.5): the documented subset, validated
   * BEFORE anything is constructed — the target must be a pristine box
   * leaf (the analytic corner-fillet model's honest domain; a filleted
   * fillet, a boolean, or any other node shape declines structurally
   * rather than approximating); the radius strictly positive; the edge
   * list well formed and resolvable against the fake's own box-edge table;
   * the selected edges parallel; the radius within every edge's adjacent
   * faces; and the removed prism-quadrants pairwise disjoint. Anything
   * past this battery is exact by construction.
   */
  const buildFillet = (input: FilletInput): KernelResult<KernelSolid> => {
    const target = shapeOf(input.target, "fillet");
    if (!target.ok) return fail(target.error);
    if (target.value.kind !== "box") {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          `fillet rejected the target: the fake kernel's fillet domain is a pristine box leaf (the analytic corner-fillet model); this solid is a "${target.value.kind}". The general fillet reference kernel is the OpenCascade backend.`,
        ),
      );
    }
    const radius = positiveLength(input.radius, "radius", "fillet");
    if (!radius.ok) return fail(radius.error);
    const r = radius.value;
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
            `fillet rejected edge ordinal ${String(ordinal)}: ordinals are non-negative integers (the kernel's box-edge table addresses).`,
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
    const size = target.value.size;
    const resolved = input.edges.map((ordinal) => {
      const entry = FAKE_BOX_EDGE_TABLE[ordinal];
      if (entry === undefined) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.filletEdgeUnknown,
            `fillet rejected edge ordinal ${String(ordinal)}: it addresses no edge of the box (the fake kernel's box-edge table has ${String(FAKE_BOX_EDGE_TABLE.length)} entries).`,
          ),
        );
      }
      return ok(boxEdgeAt(size, ordinal));
    });
    if (resolved.some((edge) => !edge.ok)) {
      const failure = resolved.find((edge) => !edge.ok);
      if (failure !== undefined && !failure.ok) return failure;
    }
    const edges = resolved.flatMap((edge) => (edge.ok ? [edge.value] : []));
    const axes = new Set(edges.map((edge) => edge.axis));
    if (axes.size > 1) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "fillet rejected the edge selection: the fake kernel's fillet subset rounds one PARALLEL edge group per call; select edges that share their direction axis.",
        ),
      );
    }
    const u = edges[0]?.axis;
    if (u === undefined) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          "Invariant violation: a non-empty validated edge list always carries an axis.",
        ),
      );
    }
    const a: Axis = u === 0 ? 1 : 0;
    const b: Axis = u === 2 ? 1 : 2;
    const sizeA = at(size, a);
    const sizeB = at(size, b);
    // Radius fit: on a box, every edge of a parallel group shares the same
    // two cross-section extents, so one check covers the group.
    if (r >= sizeA || r >= sizeB) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.filletFailed,
          `fillet rejected radius ${String(r)} mm: it outruns a face adjacent to the selected edge (the cross-section extents are ${String(sizeA)} mm and ${String(sizeB)} mm). Reduce the radius.`,
        ),
      );
    }
    // Pairwise disjointness of the removed regions: every removed region
    // lies inside its quadrant box (the two cross bands times the edge
    // length), so disjoint quadrant boxes prove disjoint removals — and
    // overlapping ones MAY still be disjoint but are refused rather than
    // analysed (the OCCT reference fails interfering fillets the same way,
    // probed as IsDone = false).
    for (let i = 0; i < edges.length; i += 1) {
      for (let j = i + 1; j < edges.length; j += 1) {
        const first = edges[i];
        const second = edges[j];
        if (first === undefined || second === undefined) continue;
        const bandOverlaps = (axis: Axis): boolean => {
          const firstLow =
            at(first.corner, axis) === 0 ? 0 : at(size, axis) - r;
          const secondLow =
            at(second.corner, axis) === 0 ? 0 : at(size, axis) - r;
          return (
            Math.min(firstLow + r, secondLow + r) -
              Math.max(firstLow, secondLow) >
            0
          );
        };
        if (bandOverlaps(a) && bandOverlaps(b)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.filletFailed,
              "fillet rejected the edge selection: two fillets' corner quadrants overlap (both cross-axis bands intersect), so the removed regions may interfere. Reduce the radius or select non-interfering edges.",
            ),
          );
        }
      }
    }
    return ok(tag.wrap({ kind: "fillet", size, edges, radius: r }));
  };

  /**
   * Builds the chamfer node (Phase 26.6): the fillet subset's battery,
   * verbatim, with the distance in the radius's place — the target must be
   * a pristine box leaf (the analytic corner-prism model's honest domain; a
   * chamfered chamfer, a boolean, or any other node shape declines
   * structurally rather than approximating); the distance strictly
   * positive; the edge list well formed and resolvable against the fake's
   * own box-edge table; the selected edges parallel; the distance within
   * every edge's adjacent faces; and the removed corner prisms pairwise
   * disjoint. Anything past this battery is exact by construction.
   */
  const buildChamfer = (input: ChamferInput): KernelResult<KernelSolid> => {
    const target = shapeOf(input.target, "chamfer");
    if (!target.ok) return fail(target.error);
    if (target.value.kind !== "box") {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          `chamfer rejected the target: the fake kernel's chamfer domain is a pristine box leaf (the analytic corner-prism model); this solid is a "${target.value.kind}". The general chamfer reference kernel is the OpenCascade backend.`,
        ),
      );
    }
    const distance = positiveLength(input.distance, "distance", "chamfer");
    if (!distance.ok) return fail(distance.error);
    const d = distance.value;
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
            `chamfer rejected edge ordinal ${String(ordinal)}: ordinals are non-negative integers (the kernel's box-edge table addresses).`,
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
    const size = target.value.size;
    const resolved = input.edges.map((ordinal) => {
      const entry = FAKE_BOX_EDGE_TABLE[ordinal];
      if (entry === undefined) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.chamferEdgeUnknown,
            `chamfer rejected edge ordinal ${String(ordinal)}: it addresses no edge of the box (the fake kernel's box-edge table has ${String(FAKE_BOX_EDGE_TABLE.length)} entries).`,
          ),
        );
      }
      return ok(boxEdgeAt(size, ordinal));
    });
    if (resolved.some((edge) => !edge.ok)) {
      const failure = resolved.find((edge) => !edge.ok);
      if (failure !== undefined && !failure.ok) return failure;
    }
    const edges = resolved.flatMap((edge) => (edge.ok ? [edge.value] : []));
    const axes = new Set(edges.map((edge) => edge.axis));
    if (axes.size > 1) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "chamfer rejected the edge selection: the fake kernel's chamfer subset bevels one PARALLEL edge group per call; select edges that share their direction axis.",
        ),
      );
    }
    const u = edges[0]?.axis;
    if (u === undefined) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          "Invariant violation: a non-empty validated edge list always carries an axis.",
        ),
      );
    }
    const a: Axis = u === 0 ? 1 : 0;
    const b: Axis = u === 2 ? 1 : 2;
    const sizeA = at(size, a);
    const sizeB = at(size, b);
    // Distance fit: on a box, every edge of a parallel group shares the same
    // two cross-section extents, so one check covers the group — and the
    // edge's own length bounds nothing (probed against OCCT: a distance
    // past the edge length still measures the exact corner prism).
    if (d >= sizeA || d >= sizeB) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.chamferFailed,
          `chamfer rejected distance ${String(d)} mm: it outruns a face adjacent to the selected edge (the cross-section extents are ${String(sizeA)} mm and ${String(sizeB)} mm). Reduce the distance.`,
        ),
      );
    }
    // Pairwise disjointness of the removed regions, the fillet rule with
    // the prism's own containment box (the two cross bands times the edge
    // length): disjoint band boxes prove disjoint removals — overlapping
    // ones MAY still be disjoint but are refused rather than analysed (the
    // OCCT reference declines interfering chamfers the same way, probed as
    // IsDone = false).
    for (let i = 0; i < edges.length; i += 1) {
      for (let j = i + 1; j < edges.length; j += 1) {
        const first = edges[i];
        const second = edges[j];
        if (first === undefined || second === undefined) continue;
        const bandOverlaps = (axis: Axis): boolean => {
          const firstLow =
            at(first.corner, axis) === 0 ? 0 : at(size, axis) - d;
          const secondLow =
            at(second.corner, axis) === 0 ? 0 : at(size, axis) - d;
          return (
            Math.min(firstLow + d, secondLow + d) -
              Math.max(firstLow, secondLow) >
            0
          );
        };
        if (bandOverlaps(a) && bandOverlaps(b)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.chamferFailed,
              "chamfer rejected the edge selection: two chamfers' corner prisms overlap (both cross-axis bands intersect), so the removed regions may interfere. Reduce the distance or select non-interfering edges.",
            ),
          );
        }
      }
    }
    return ok(tag.wrap({ kind: "chamfer", size, edges, distance: d }));
  };

  /**
   * Builds the shell node (Phase 26.7): the documented single-face subset,
   * validated BEFORE anything is constructed — the target must be a
   * pristine box leaf (the analytic open-box model's honest domain; a
   * shelled shell, a boolean, or any other node shape declines
   * structurally rather than approximating); the thickness strictly
   * positive; the face list well formed and carrying EXACTLY ONE ordinal
   * resolvable against the fake's own box-face table (the two-face cavity
   * of the general operation declines with the structured unsupported
   * code — the reference kernel for it is the OpenCascade backend); and
   * the cavity non-degenerate (the thickness clears both cross extents by
   * a factor of two and the open axis by one). Anything past this battery
   * is exact by construction.
   */
  const buildShell = (input: ShellInput): KernelResult<KernelSolid> => {
    const target = shapeOf(input.target, "shell");
    if (!target.ok) return fail(target.error);
    if (target.value.kind !== "box") {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          `shell rejected the target: the fake kernel's shell domain is a pristine box leaf (the analytic open-box model); this solid is a "${target.value.kind}". The general shell reference kernel is the OpenCascade backend.`,
        ),
      );
    }
    const thickness = positiveLength(input.thickness, "thickness", "shell");
    if (!thickness.ok) return fail(thickness.error);
    const t = thickness.value;
    for (const ordinal of input.faces) {
      if (!Number.isInteger(ordinal) || ordinal < 0) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidOperands,
            `shell rejected face ordinal ${String(ordinal)}: ordinals are non-negative integers (the kernel's box-face table addresses).`,
          ),
        );
      }
    }
    const seenFaces = new Set<number>();
    for (const ordinal of input.faces) {
      if (seenFaces.has(ordinal)) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidOperands,
            `shell rejected the face list: ordinal ${String(ordinal)} appears more than once.`,
          ),
        );
      }
      seenFaces.add(ordinal);
    }
    if (input.faces.length === 0) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          "shell rejected the face list: at least one face ordinal is required (the open hollow shell; the fully closed hollow is out of contract scope).",
        ),
      );
    }
    if (input.faces.length > 1) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "shell rejected the face selection: the fake kernel's shell subset opens ONE face per call; the general multi-face shell reference kernel is the OpenCascade backend.",
        ),
      );
    }
    const ordinal = input.faces[0];
    const entry =
      ordinal === undefined ? undefined : FAKE_BOX_FACE_TABLE[ordinal];
    if (entry === undefined) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.shellFaceUnknown,
          `shell rejected face ordinal ${String(ordinal)}: it addresses no face of the box (the fake kernel's box-face table has ${String(FAKE_BOX_FACE_TABLE.length)} entries).`,
        ),
      );
    }
    const size = target.value.size;
    const u = entry.axis;
    const a: Axis = u === 0 ? 1 : 0;
    const b: Axis = u === 2 ? 1 : 2;
    // Cavity fit: the inset cavity must be non-degenerate — strictly
    // inside both cross extents (walls of thickness t on BOTH sides) and
    // strictly short of the removed side along its own axis. At or past
    // either boundary the walls meet and the hollow is gone, the same
    // structured refusal the OCCT reference's post-condition gives its
    // engine's silently-degenerate answers.
    if (2 * t >= at(size, a) || 2 * t >= at(size, b) || t >= at(size, u)) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.shellFailed,
          `shell rejected thickness ${String(t)} mm: the walls meet or cross before the removed face is reached (the cross extents are ${String(at(size, a))} mm and ${String(at(size, b))} mm, the open axis extent ${String(at(size, u))} mm). Reduce the thickness.`,
        ),
      );
    }
    return ok(
      tag.wrap({
        kind: "shell",
        size,
        face: { axis: u, high: entry.high },
        thickness: t,
      }),
    );
  };

  /**
   * The Phase 41 closed hollow over the fake kernel's PRISTINE-LEAF
   * subset — a box or sphere target (the shell node's domain discipline
   * verbatim): exact volume (target minus its inset), exact membership
   * (`in target ∧ ¬(strictly inside the inset)`), bounds equal to the
   * target's own (the walls own the outer boundary), and a deterministic
   * two-surface mesh (the target's canonical triangles plus the inset's,
   * reversed so the cavity faces inward). Anything else declines
   * structurally with `kernel/unsupported-operation`, and a thickness at
   * or past half the target's smallest extent — where the cavity meets
   * itself — refuses with `kernel/thicken-failed` (the shell's
   * post-condition discipline, feature-level).
   */
  const buildThicken = (input: ThickenInput): KernelResult<KernelSolid> => {
    const target = shapeOf(input.target, "thicken");
    if (!target.ok) return fail(target.error);
    if (target.value.kind !== "box" && target.value.kind !== "sphere") {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          `thicken rejected the target: the fake kernel's thicken domain is the pristine box and sphere leaves (the analytic closed-hollow model); this solid is a "${target.value.kind}". The general thicken reference kernel is the OpenCascade backend.`,
        ),
      );
    }
    const thickness = positiveLength(input.thickness, "thickness", "thicken");
    if (!thickness.ok) return fail(thickness.error);
    const t = thickness.value;
    if (target.value.kind === "box") {
      const size = target.value.size;
      const smallest = Math.min(at(size, 0), at(size, 1), at(size, 2));
      if (2 * t >= smallest) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.thickenFailed,
            `thicken rejected thickness ${String(t)} mm: the cavity meets or crosses itself (the box's smallest extent is ${String(smallest)} mm; the walls need strictly less than half of it). Reduce the thickness.`,
          ),
        );
      }
    } else if (2 * t >= 2 * target.value.radius) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.thickenFailed,
          `thicken rejected thickness ${String(t)} mm: the cavity meets or crosses itself (the sphere's diameter is ${String(2 * target.value.radius)} mm; the walls need strictly less than half of it). Reduce the thickness.`,
        ),
      );
    }
    return ok(
      tag.wrap({ kind: "thickened", target: target.value, thickness: t }),
    );
  };

  const operandsOf = (
    solids: readonly KernelSolid[],
    minimum: number,
    operation: string,
  ): KernelResult<readonly FakeShape[]> => {
    if (solids.length < minimum) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          `${operation} rejected ${solids.length} operand(s): at least ${minimum} are required.`,
        ),
      );
    }
    const shapes: FakeShape[] = [];
    for (const solid of solids) {
      const shape = shapeOf(solid, operation);
      if (!shape.ok) return fail(shape.error);
      shapes.push(shape.value);
    }
    return ok(shapes);
  };

  const kernel: GeometryKernel = {
    id: FAKE_KERNEL_ID,
    capabilities: FAKE_KERNEL_CAPABILITIES,

    createBox(input: BoxInput): KernelResult<KernelSolid> {
      const width = positiveLength(input.width, "width", "createBox");
      if (!width.ok) return fail(width.error);
      const depth = positiveLength(input.depth, "depth", "createBox");
      if (!depth.ok) return fail(depth.error);
      const height = positiveLength(input.height, "height", "createBox");
      if (!height.ok) return fail(height.error);
      return ok(
        tag.wrap({
          kind: "box",
          size: [width.value, depth.value, height.value],
        }),
      );
    },

    createSphere(input: SphereInput): KernelResult<KernelSolid> {
      const radius = positiveLength(input.radius, "radius", "createSphere");
      if (!radius.ok) return fail(radius.error);
      return ok(tag.wrap({ kind: "sphere", radius: radius.value }));
    },

    createCylinder(input: CylinderInput): KernelResult<KernelSolid> {
      const radius = positiveLength(input.radius, "radius", "createCylinder");
      if (!radius.ok) return fail(radius.error);
      const height = positiveLength(input.height, "height", "createCylinder");
      if (!height.ok) return fail(height.error);
      return ok(
        tag.wrap({
          kind: "cylinder",
          radius: radius.value,
          height: height.value,
        }),
      );
    },

    createCone(input: ConeInput): KernelResult<KernelSolid> {
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
        tag.wrap({
          kind: "cone",
          bottomRadius: bottomRadius.value,
          topRadius: topRadius.value,
          height: height.value,
        }),
      );
    },

    union(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      const shapes = operandsOf(operands, 2, "union");
      if (!shapes.ok) return fail(shapes.error);
      return ok(tag.wrap({ kind: "union", operands: shapes.value }));
    },

    subtract(
      target: KernelSolid,
      tools: readonly KernelSolid[],
    ): KernelResult<KernelSolid> {
      const targetShape = shapeOf(target, "subtract");
      if (!targetShape.ok) return fail(targetShape.error);
      const toolShapes = operandsOf(tools, 1, "subtract");
      if (!toolShapes.ok) return fail(toolShapes.error);
      return ok(
        tag.wrap({
          kind: "subtract",
          target: targetShape.value,
          tools: toolShapes.value,
        }),
      );
    },

    intersect(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      const shapes = operandsOf(operands, 2, "intersect");
      if (!shapes.ok) return fail(shapes.error);
      return ok(tag.wrap({ kind: "intersect", operands: shapes.value }));
    },

    createSheet(input: SheetSurfaceInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined createSheet: the engine is closed-solid — its currency carries a volume and an inside, and an open sheet has neither (the sheets capability is false; the Phase 48 probe).",
        ),
      );
    },
    trimSheet(input: SheetTrimInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined trimSheet: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    untrimSheet(input: SheetUntrimInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined untrimSheet: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    extendSheet(input: SheetExtendInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined extendSheet: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    knit(input: SheetKnitInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined knit: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    unstitch(input: SheetUnstitchInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined unstitch: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    fillPatch(input: SheetFillPatchInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined fillPatch: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    offsetSheet(input: SheetOffsetInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined offsetSheet: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    thickenSheet(input: SheetThickenInput): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined thickenSheet: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    replaceFaceWithSheet(
      input: SheetReplaceFaceInput,
    ): KernelResult<KernelSolid> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined replaceFaceWithSheet: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },
    deleteFaceKeepSurface(
      input: DeleteFaceKeepInput,
    ): KernelResult<DeleteFaceKeepResult> {
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "the fake kernel declined deleteFaceKeepSurface: the surface-operation family is OCCT-only on this stack — the engine's currency is closed solids and the Phase 49 surface scope ships no fake-model sheet route (the surfaceOps capability is false).",
        ),
      );
    },

    extrude(input: ProfileExtrudeInput): KernelResult<KernelSolid> {
      if (input.sheet === true) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.unsupportedOperation,
            "the fake kernel declined a sheet extrude: the engine is closed-solid — its currency carries a volume and an inside, and an open shell has neither (the sheets capability is false; the Phase 48 probe).",
          ),
        );
      }
      // The whole construction runs inside the no-throw boundary: validation
      // failures return structured codes, and a dynamically-parsed
      // non-finite value (which makes valueIn throw) normalizes into
      // kernel/invalid-profile like any other degenerate profile input.
      try {
        const height = valueIn(input.height, "mm");
        if (!(height > 0)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              `extrude rejected height ${height} mm: it must be strictly positive.`,
            ),
          );
        }
        const angle = valueIn(input.placement.rotation.angle, "rad");
        if (!Number.isFinite(angle)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "extrude rejected the placement rotation: its angle magnitude is not a finite number.",
            ),
          );
        }
        const axis = input.placement.rotation.axis;
        const axisSquared =
          axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
        if (
          !Number.isFinite(axisSquared) ||
          axisSquared === 0 ||
          !Number.isFinite(axis[0]) ||
          !Number.isFinite(axis[1]) ||
          !Number.isFinite(axis[2])
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              `extrude rejected a rotation about [${String(axis[0])}, ${String(axis[1])}, ${String(axis[2])}]: the axis must be a non-zero finite vector.`,
            ),
          );
        }
        const translation: Vec3 = [
          valueIn(input.placement.translation.x, "mm"),
          valueIn(input.placement.translation.y, "mm"),
          valueIn(input.placement.translation.z, "mm"),
        ];
        if (
          !translation.every((component) => Number.isFinite(component)) ||
          !Number.isFinite(angle)
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "extrude rejected the placement translation: components must be finite lengths.",
            ),
          );
        }
        // Per-segment degeneracy checks plus pairwise closure: the shared
        // contract-scope validator (the same probe the Manifold, JSCAD, and
        // OCCT adapters run before their geometry), not a local
        // re-implementation — empty loop, zero-length lines, non-positive
        // radii, zero-sweep arcs, non-finite fields, and consecutive
        // segment (and last-to-first) endpoint gaps.
        const problem = profileLoopProblem(input.loop);
        if (problem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `extrude rejected the profile loop: ${problem}.`,
            ),
          );
        }
        const polygon = tessellateProfileLoop(input.loop);
        if (polygon.length < 3) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "extrude rejected the profile loop: a face needs at least three distinct boundary vertices.",
            ),
          );
        }
        const area = polygonSignedArea(polygon);
        if (!(Math.abs(area) > 1e-9)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "extrude rejected the profile loop: its boundary encloses no area.",
            ),
          );
        }
        const ccw = area > 0 ? polygon : [...polygon].reverse();
        const rotation = axisAngleMatrix(axis, angle);
        // The Phase 41 draft taper: the solid becomes the two-station loft
        // between the loop's chord polygon and its far inset — the ruled
        // morph the contract pins (the inset corner moves linearly, so the
        // blend IS the inset family at every parameter while the far inset
        // stays valid; the shared battery above guaranteed it does). The
        // existing Simpson-exact loft node then answers volume, bounds,
        // membership, and the canonical mesh with no new model code.
        if (input.taper !== undefined) {
          const problem = taperedExtrudeProblem(
            input.loop,
            height,
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
          const inset = taperInsetDistanceMm(height, input.taper) ?? 0;
          if (inset !== 0) {
            const far = insetPolygon(ccw, inset);
            if (far === null) {
              return fail(
                kernelError(
                  KERNEL_ERROR_CODES.invalidTaper,
                  "extrude rejected the taper: the far-end inset degenerates the chord polygon.",
                ),
              );
            }
            return ok(
              tag.wrap({
                kind: "loft",
                polygons:
                  input.direction === -1
                    ? [far, ccw.map((point) => ({ x: point.x, y: point.y }))]
                    : [ccw.map((point) => ({ x: point.x, y: point.y })), far],
                stations: input.direction === -1 ? [-height, 0] : [0, height],
                rotation,
                translation,
              }),
            );
          }
        }
        return ok(
          tag.wrap({
            kind: "extrusion",
            polygon: ccw,
            height,
            baseZ: input.direction === -1 ? -height : 0,
            rotation,
            translation,
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidProfile,
            `extrude rejected its input: ${detail}`,
          ),
        );
      }
    },

    revolve(input: ProfileRevolveInput): KernelResult<KernelSolid> {
      if (input.sheet === true) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.unsupportedOperation,
            "the fake kernel declined a sheet revolve: the engine is closed-solid — its currency carries a volume and an inside, and an open shell has neither (the sheets capability is false; the Phase 48 probe).",
          ),
        );
      }
      // The same no-throw discipline as extrude: structured codes for every
      // degenerate input, shared validators before any shape is built.
      try {
        const sweep = valueIn(input.angle, "rad");
        if (!Number.isFinite(sweep)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "revolve rejected the sweep angle: its magnitude is not a finite number.",
            ),
          );
        }
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
              `revolve rejected an axis through [${String(input.axis.point[0])}, ${String(input.axis.point[1])}] along [${String(input.axis.direction[0])}, ${String(input.axis.direction[1])}]: the direction must be a non-zero finite vector.`,
            ),
          );
        }
        const angle = valueIn(input.placement.rotation.angle, "rad");
        if (!Number.isFinite(angle)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "revolve rejected the placement rotation: its angle magnitude is not a finite number.",
            ),
          );
        }
        const axis = input.placement.rotation.axis;
        const axisSquared =
          axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
        if (
          !Number.isFinite(axisSquared) ||
          axisSquared === 0 ||
          !Number.isFinite(axis[0]) ||
          !Number.isFinite(axis[1]) ||
          !Number.isFinite(axis[2])
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              `revolve rejected a rotation about [${String(axis[0])}, ${String(axis[1])}, ${String(axis[2])}]: the axis must be a non-zero finite vector.`,
            ),
          );
        }
        const translation: Vec3 = [
          valueIn(input.placement.translation.x, "mm"),
          valueIn(input.placement.translation.y, "mm"),
          valueIn(input.placement.translation.z, "mm"),
        ];
        if (!translation.every((component) => Number.isFinite(component))) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "revolve rejected the placement translation: components must be finite lengths.",
            ),
          );
        }
        const problem = profileLoopProblem(input.loop);
        if (problem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `revolve rejected the profile loop: ${problem}.`,
            ),
          );
        }
        // The axis-validation core (Phase 26.2): the profile must not CROSS
        // the revolve axis — material strictly on both sides is rejected
        // with the structured crossing code before any geometry exists
        // (touching is legal and documented; the mesh engines would
        // otherwise silently clip or cap the far side).
        if (revolveCrossesAxis(input.loop, frame)) {
          const extremes = revolveSignedExtremes(input.loop, frame);
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.profileAxisCrossing,
              `revolve rejected the profile loop: it crosses the revolve axis (signed distances span [${extremes.min}, ${extremes.max}] mm). Move the profile fully to one side; touching the axis is allowed.`,
            ),
          );
        }
        const polygon = tessellateRevolveProfile(input.loop, frame);
        if (polygon.length < 3) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "revolve rejected the profile loop: a face needs at least three distinct boundary vertices.",
            ),
          );
        }
        if (!(Math.abs(polygonSignedArea(polygon)) > 1e-9)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "revolve rejected the profile loop: its boundary encloses no area.",
            ),
          );
        }
        // Normalize the polygon CCW so the mesh winding is uniform.
        const ccw =
          polygonSignedArea(polygon) > 0 ? polygon : [...polygon].reverse();
        const volume = revolvePappusVolume(ccw, sweep);
        if (!(volume > 1e-9)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "revolve rejected the profile loop: it encloses no material away from the axis, so the sweep has zero volume.",
            ),
          );
        }
        // The shared touch tolerance (not an exact >= 0): a legal touching
        // profile whose on-axis vertex rounds to −ε must keep the +v-side
        // placement — the same tolerance revolveCrossesAxis admits it by.
        const positiveSide =
          Math.min(...ccw.map((vertex) => vertex.y)) >=
          -REVOLVE_AXIS_TOUCH_TOLERANCE_MM;
        return ok(
          tag.wrap({
            kind: "revolution",
            polygon: ccw,
            sweep,
            positiveSide,
            origin: [frame.origin.x, frame.origin.y, 0],
            u: [frame.u.x, frame.u.y, 0],
            v: [frame.v.x, frame.v.y, 0],
            rotation: axisAngleMatrix(axis, angle),
            translation,
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidProfile,
            `revolve rejected its input: ${detail}`,
          ),
        );
      }
    },

    sweep(input: ProfileSweepInput): KernelResult<KernelSolid> {
      if (input.sheet === true) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.unsupportedOperation,
            "the fake kernel declined a sheet sweep: the engine is closed-solid — its currency carries a volume and an inside, and an open shell has neither (the sheets capability is false; the Phase 48 probe).",
          ),
        );
      }
      // The same no-throw discipline as extrude and revolve: shared
      // validators before any geometry, structured codes for every
      // degenerate input.
      try {
        const angle = valueIn(input.placement.rotation.angle, "rad");
        if (!Number.isFinite(angle)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "sweep rejected the placement rotation: its angle magnitude is not a finite number.",
            ),
          );
        }
        const rotationAxis = input.placement.rotation.axis;
        const axisSquared =
          rotationAxis[0] * rotationAxis[0] +
          rotationAxis[1] * rotationAxis[1] +
          rotationAxis[2] * rotationAxis[2];
        if (
          !Number.isFinite(axisSquared) ||
          axisSquared === 0 ||
          !Number.isFinite(rotationAxis[0]) ||
          !Number.isFinite(rotationAxis[1]) ||
          !Number.isFinite(rotationAxis[2])
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              `sweep rejected a rotation about [${String(rotationAxis[0])}, ${String(rotationAxis[1])}, ${String(rotationAxis[2])}]: the axis must be a non-zero finite vector.`,
            ),
          );
        }
        const translation: Vec3 = [
          valueIn(input.placement.translation.x, "mm"),
          valueIn(input.placement.translation.y, "mm"),
          valueIn(input.placement.translation.z, "mm"),
        ];
        if (!translation.every((component) => Number.isFinite(component))) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "sweep rejected the placement translation: components must be finite lengths.",
            ),
          );
        }
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
        const area = polygonSignedArea(polygon);
        if (polygon.length < 3 || !(Math.abs(area) > 1e-9)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "sweep rejected the profile loop: it is degenerate (fewer than three distinct boundary vertices or no enclosed area).",
            ),
          );
        }
        // The 26.3 path battery, before any geometry: structure (start at
        // the origin, perpendicular attachment, G1 joints), then the
        // chord-polyline self-intersection, then the per-arc axis
        // crossing — the cheap exact detections the contract promises.
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
        const ccw = area > 0 ? polygon : [...polygon].reverse();
        return ok(
          tag.wrap({
            kind: "sweep",
            polygon: ccw,
            pieces: decomposeSweepPath(input.path),
            closed: sweepPathClosed(input.path),
            rotation: axisAngleMatrix(rotationAxis, angle),
            translation,
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidProfile,
            `sweep rejected its input: ${detail}`,
          ),
        );
      }
    },

    wire(input: WireCurveInput): KernelResult<KernelWire> {
      // Pure shared math (Phase 47): canonicalize, validate, and walk the
      // deterministic stations — identical in every kernel by construction,
      // so this adapter simply answers the shared evaluation.
      const evaluated = evaluateWire(input);
      if (!evaluated.ok) {
        return fail(
          kernelError(KERNEL_ERROR_CODES.invalidProfile, evaluated.message),
        );
      }
      return ok({
        polyline: evaluated.wire.polyline,
        chains: [evaluated.wire.polyline],
        length: evaluated.wire.length,
        bounds: evaluated.wire.bounds,
      });
    },
    sweepWire(input: ProfileSweepWireInput): KernelResult<KernelSolid> {
      // The no-throw discipline: placement validation, the shared profile
      // battery, the spine's own semantic battery, the generalized G1 and
      // self-intersection checks — then the analytic Cavalieri node.
      try {
        const angle = valueIn(input.placement.rotation.angle, "rad");
        if (!Number.isFinite(angle)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "sweepWire rejected the placement rotation: its angle magnitude is not a finite number.",
            ),
          );
        }
        const rotationAxis = input.placement.rotation.axis;
        const axisSquared =
          rotationAxis[0] * rotationAxis[0] +
          rotationAxis[1] * rotationAxis[1] +
          rotationAxis[2] * rotationAxis[2];
        if (
          !Number.isFinite(axisSquared) ||
          axisSquared === 0 ||
          !Number.isFinite(rotationAxis[0]) ||
          !Number.isFinite(rotationAxis[1]) ||
          !Number.isFinite(rotationAxis[2])
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              `sweepWire rejected a rotation about [${String(rotationAxis[0])}, ${String(rotationAxis[1])}, ${String(rotationAxis[2])}]: the axis must be a non-zero finite vector.`,
            ),
          );
        }
        const translation: Vec3 = [
          valueIn(input.placement.translation.x, "mm"),
          valueIn(input.placement.translation.y, "mm"),
          valueIn(input.placement.translation.z, "mm"),
        ];
        if (!translation.every((component) => Number.isFinite(component))) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "sweepWire rejected the placement translation: components must be finite lengths.",
            ),
          );
        }
        const loopProblem = profileLoopProblem(input.loop);
        if (loopProblem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `sweepWire rejected the profile loop: ${loopProblem}.`,
            ),
          );
        }
        const polygon = tessellateProfileLoop(input.loop);
        const area = polygonSignedArea(polygon);
        if (polygon.length < 3 || !(Math.abs(area) > 1e-9)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "sweepWire rejected the profile loop: it is degenerate (fewer than three distinct boundary vertices or no enclosed area).",
            ),
          );
        }
        const spineProblems = curveRecordProblems(input.spine);
        if (spineProblems.length > 0) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `sweepWire rejected the spine: ${spineProblems[0]?.message ?? "the curve is semantically invalid."}`,
            ),
          );
        }
        const canonical = canonicalizeCurve(input.spine);
        if (!canonical.ok) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `sweepWire rejected the spine: ${canonical.error.message}`,
            ),
          );
        }
        const polyline = curvePolyline(canonical.value);
        for (const point of polyline) {
          if (
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]) ||
            !Number.isFinite(point[2])
          ) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidProfile,
                "sweepWire rejected the spine: its station walk produced a non-finite point.",
              ),
            );
          }
        }
        if (polyline.length < 2) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidPath,
              "sweepWire rejected the spine: its station polyline is degenerate.",
            ),
          );
        }
        const g1Failure = wireG1FailureIndex(polyline);
        if (g1Failure !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidPath,
              `sweepWire rejected the spine: station ${String(g1Failure)} is a tangent-continuity violation (a kinked spine sweeps a different solid in every engine).`,
            ),
          );
        }
        if (wireChordsSelfIntersect(polyline)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.pathSelfIntersecting,
              "sweepWire rejected the spine: its chord polyline crosses itself (non-adjacent chords touch within the shared tolerance).",
            ),
          );
        }
        const ccw = area > 0 ? polygon : [...polygon].reverse();
        return ok(
          tag.wrap({
            kind: "wireSweep",
            polygon: ccw,
            frames: parallelTransportFrames(polyline),
            spineLength: curveLength(canonical.value),
            rotation: axisAngleMatrix(rotationAxis, angle),
            translation,
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidProfile,
            `sweepWire rejected its input: ${detail}`,
          ),
        );
      }
    },

    intersectionCurve(input: IntersectionCurveInput): KernelResult<KernelWire> {
      void input;
      // The capability-flag discipline: the fake kernel's solids are
      // analytic primitives and boolean nodes without exact section
      // edges — an intersection CURVE would be a tessellated guess, so
      // the structured decline is the honest answer.
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "intersectionCurve is not implemented by the fake kernel: its solids carry no exact section-edge geometry (the OpenCascade backend is the exact producer).",
        ),
      );
    },

    helixSweep(input: HelixSweepInput): KernelResult<KernelSolid> {
      // The same no-throw discipline: placement validation, the shared
      // Phase 40 battery (spine degeneracy, profile validity, axis
      // crossing), then the model's documented overlap subset — before the
      // exact screw-solid node is built.
      try {
        const angle = valueIn(input.placement.rotation.angle, "rad");
        if (!Number.isFinite(angle)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "helixSweep rejected the placement rotation: its angle magnitude is not a finite number.",
            ),
          );
        }
        const rotationAxis = input.placement.rotation.axis;
        const axisSquared =
          rotationAxis[0] * rotationAxis[0] +
          rotationAxis[1] * rotationAxis[1] +
          rotationAxis[2] * rotationAxis[2];
        if (
          !Number.isFinite(axisSquared) ||
          axisSquared === 0 ||
          !Number.isFinite(rotationAxis[0]) ||
          !Number.isFinite(rotationAxis[1]) ||
          !Number.isFinite(rotationAxis[2])
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              `helixSweep rejected a rotation about [${String(rotationAxis[0])}, ${String(rotationAxis[1])}, ${String(rotationAxis[2])}]: the axis must be a non-zero finite vector.`,
            ),
          );
        }
        const translation: Vec3 = [
          valueIn(input.placement.translation.x, "mm"),
          valueIn(input.placement.translation.y, "mm"),
          valueIn(input.placement.translation.z, "mm"),
        ];
        if (!translation.every((component) => Number.isFinite(component))) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "helixSweep rejected the placement translation: components must be finite lengths.",
            ),
          );
        }
        const spine: CanonicalHelixSpine = {
          radiusMm: valueIn(input.spine.radius, "mm"),
          pitchMm: valueIn(input.spine.pitch, "mm"),
          turns: input.spine.turns,
          handedness: input.spine.handedness,
          startAngleRad: valueIn(input.spine.startAngle, "rad"),
          taperMm:
            input.spine.taper === undefined
              ? 0
              : valueIn(input.spine.taper, "mm"),
        };
        const problem = helixSweepProblem(input.loop, spine);
        if (problem !== null) {
          return fail(
            kernelError(problem.code, `helixSweep ${problem.message}.`),
          );
        }
        const polygon = helixProfilePolygon(input.loop);
        const area = polygonSignedArea(polygon);
        if (polygon.length < 3 || !(Math.abs(area) > 1e-9)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "helixSweep rejected the profile loop: it is degenerate (fewer than three distinct boundary vertices or no enclosed area).",
            ),
          );
        }
        // The model's documented subset: overlapping turns would make the
        // multiplicity integral overcount the set volume, so the analytic
        // reference declines them structurally (the fillet/chamfer subset
        // discipline) — the general helix kernel is the OpenCascade
        // backend.
        if (helixTurnsOverlap(input.loop, spine)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.helixTurnOverlap,
              `helixSweep rejected the input: the profile's axial extent exceeds one pitch over ${String(spine.turns)} turns, so consecutive turns' material overlaps — the analytic screw-solid model would overcount the union. Reduce the profile height or the turn count.`,
            ),
          );
        }
        const ccw = area > 0 ? polygon : [...polygon].reverse();
        return ok(
          tag.wrap({
            kind: "helix",
            polygon: ccw,
            spine,
            rotation: axisAngleMatrix(rotationAxis, angle),
            translation,
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidHelix,
            `helixSweep rejected its input: ${detail}`,
          ),
        );
      }
    },

    loft(input: ProfileLoftInput): KernelResult<KernelSolid> {
      if (input.sheet === true) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.unsupportedOperation,
            "the fake kernel declined a sheet loft: the engine is closed-solid — its currency carries a volume and an inside, and an open shell has neither (the sheets capability is false; the Phase 48 probe).",
          ),
        );
      }
      // The same no-throw discipline as the other profile ops: placement
      // validation, then the shared 26.4 collection battery — member
      // validity, station ordering, vertex-count compatibility — before
      // any shape is built.
      try {
        const angle = valueIn(input.placement.rotation.angle, "rad");
        if (!Number.isFinite(angle)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "loft rejected the placement rotation: its angle magnitude is not a finite number.",
            ),
          );
        }
        const rotationAxis = input.placement.rotation.axis;
        const axisSquared =
          rotationAxis[0] * rotationAxis[0] +
          rotationAxis[1] * rotationAxis[1] +
          rotationAxis[2] * rotationAxis[2];
        if (
          !Number.isFinite(axisSquared) ||
          axisSquared === 0 ||
          !Number.isFinite(rotationAxis[0]) ||
          !Number.isFinite(rotationAxis[1]) ||
          !Number.isFinite(rotationAxis[2])
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              `loft rejected a rotation about [${String(rotationAxis[0])}, ${String(rotationAxis[1])}, ${String(rotationAxis[2])}]: the axis must be a non-zero finite vector.`,
            ),
          );
        }
        const translation: Vec3 = [
          valueIn(input.placement.translation.x, "mm"),
          valueIn(input.placement.translation.y, "mm"),
          valueIn(input.placement.translation.z, "mm"),
        ];
        if (!translation.every((component) => Number.isFinite(component))) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "loft rejected the placement translation: components must be finite lengths.",
            ),
          );
        }
        const problem = loftSectionsProblem(input.sections);
        if (problem !== null) {
          return fail(
            kernelError(
              problem.code,
              `loft rejected the section collection: ${problem.message}.`,
            ),
          );
        }
        return ok(
          tag.wrap({
            kind: "loft",
            polygons: loftSectionPolygons(input.sections),
            stations: loftStations(input.sections),
            rotation: axisAngleMatrix(rotationAxis, angle),
            translation,
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidProfile,
            `loft rejected its input: ${detail}`,
          ),
        );
      }
    },

    fillet(input: FilletInput): KernelResult<KernelSolid> {
      // The throwing seam is only the radius's valueIn parse (non-finite
      // magnitudes); everything else returns structured failures.
      try {
        return buildFillet(input);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `fillet rejected its input: ${detail}`,
          ),
        );
      }
    },

    chamfer(input: ChamferInput): KernelResult<KernelSolid> {
      // The throwing seam is only the distance's valueIn parse (non-finite
      // magnitudes); everything else returns structured failures.
      try {
        return buildChamfer(input);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `chamfer rejected its input: ${detail}`,
          ),
        );
      }
    },

    shell(input: ShellInput): KernelResult<KernelSolid> {
      // The throwing seam is only the thickness's valueIn parse (non-finite
      // magnitudes); everything else returns structured failures.
      try {
        return buildShell(input);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `shell rejected its input: ${detail}`,
          ),
        );
      }
    },

    thicken(input: ThickenInput): KernelResult<KernelSolid> {
      // The throwing seam is only the thickness's valueIn parse; the
      // subset and fit rules return structured failures (the shell
      // discipline verbatim).
      try {
        return buildThicken(input);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `thicken rejected its input: ${detail}`,
          ),
        );
      }
    },

    moveFace(input: MoveFaceInput): KernelResult<KernelSolid> {
      // Phase 44: the local face ops are OCCT's family — the fake
      // kernel's analytic shape model carries no face identity to address
      // (its `persistentTopology` is false; there is no snapshot ordinal
      // vocabulary to resolve against), and modelling the swept prism of
      // a boolean node's boundary would be an approximation over an
      // approximation. The structured decline, never that.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "moveFace is unsupported by the fake kernel: its analytic shape model carries no face identity to address (persistentTopology is false), and no honest swept-prism model exists over its boolean nodes.",
        ),
      );
    },

    replaceFace(input: ReplaceFaceInput): KernelResult<KernelSolid> {
      // The move's verdict, verbatim, on the datum-plane re-close.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "replaceFace is unsupported by the fake kernel: its analytic shape model carries no face identity to address (persistentTopology is false), and no honest re-closing model exists over its boolean nodes.",
        ),
      );
    },

    deleteFace(input: DeleteFaceInput): KernelResult<KernelSolid> {
      // The move's verdict, verbatim, on the removal — with the probe's
      // extra honesty: no kernel builds this one today (see the contract
      // op's documentation for the OCCT binding's invalid-shell probe).
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "deleteFace is unsupported by the fake kernel: its analytic shape model carries no face identity to address (persistentTopology is false), and no honest open-shell or healed model exists over its boolean nodes.",
        ),
      );
    },

    transform(
      solid: KernelSolid,
      input: TransformInput,
    ): KernelResult<KernelSolid> {
      const shape = shapeOf(solid, "transform");
      if (!shape.ok) return fail(shape.error);
      if (input.rotation !== undefined) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidRotation,
            "transform rejected a rotation: the fake kernel's axis-aligned shape model cannot honour rotations (transformRotation is false).",
          ),
        );
      }
      // The same discipline as mirror: the throwing seam is only the
      // offset's valueIn parse (non-finite magnitudes), normalized into
      // the invalid-length failure every degenerate transform input shares.
      try {
        const offset: Vec3 = [
          valueIn(input.x, "mm"),
          valueIn(input.y, "mm"),
          valueIn(input.z, "mm"),
        ];
        // The Phase 41 uniform scale: strictly positive and finite, folded
        // through its own node (a scale is not an isometry — the mirror
        // node's rationale verbatim — so it cannot ride the translate
        // node). A factor of exactly 1 is the identity: no node at all.
        // The contract's composition `p ↦ s·R·p + t` still applies the
        // translation after the scale, so a nonzero offset wraps the
        // scaled source in the translate node.
        if (input.scale !== undefined) {
          if (!(input.scale > 0) || !Number.isFinite(input.scale)) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidLength,
                `transform rejected the scale factor ${String(input.scale)}: it must be a finite, strictly positive number.`,
              ),
            );
          }
          if (input.scale !== 1) {
            const scaled: FakeShape = {
              kind: "scale",
              source: shape.value,
              factor: input.scale,
            };
            const zeroOffset =
              offset[0] === 0 && offset[1] === 0 && offset[2] === 0;
            return ok(
              tag.wrap(
                zeroOffset
                  ? scaled
                  : { kind: "translate", source: scaled, offset },
              ),
            );
          }
        }
        return ok(tag.wrap({ kind: "translate", source: shape.value, offset }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `transform rejected its input: ${detail}`,
          ),
        );
      }
    },

    mirror(solid: KernelSolid, input: MirrorInput): KernelResult<KernelSolid> {
      // The same discipline as transform: the throwing seam is only the
      // offset's valueIn parse (non-finite magnitudes), normalized into
      // the invalid-length failure every degenerate mirror input shares.
      // Unlike transform's translation, EVERY finite offset is a legal
      // plane position — zero and negative offsets are good mirrors.
      try {
        const shape = shapeOf(solid, "mirror");
        if (!shape.ok) return fail(shape.error);
        const planeOffset = valueIn(input.offset, "mm");
        return ok(
          tag.wrap({
            kind: "mirror",
            source: shape.value,
            axis: input.axis === "x" ? 0 : input.axis === "y" ? 1 : 2,
            planeOffset,
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `mirror rejected its input: ${detail}`,
          ),
        );
      }
    },

    bounds(solid: KernelSolid): KernelResult<KernelBounds> {
      const shape = shapeOf(solid, "bounds");
      if (!shape.ok) return fail(shape.error);
      const volume = volumeOf(solid);
      if (!volume.ok) return fail(volume.error);
      if (volume.value === 0) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.boundsEmpty,
            "bounds rejected an empty solid: an empty set has no bounding box.",
          ),
        );
      }
      return ok(shapeBounds(shape.value));
    },

    volume(solid: KernelSolid): KernelResult<number> {
      return volumeOf(solid);
    },

    area(solid: KernelSolid): KernelResult<number> {
      const shape = shapeOf(solid, "area");
      if (!shape.ok) return fail(shape.error);
      const area = analyticArea(shape.value);
      if (area === undefined) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.unsupportedOperation,
            `area rejected the solid: the fake kernel's surface-area domain is its analytic primitive subset (box, sphere, cylinder, cone, and their translate/mirror isometries); this solid is a "${shape.value.kind}" node, whose area has no closed form in the fake model. The general surface-area reference kernel is the OpenCascade backend.`,
          ),
        );
      }
      return ok(area);
    },

    tessellate(solid: KernelSolid): KernelResult<Tessellation> {
      const shape = shapeOf(solid, "tessellate");
      if (!shape.ok) return fail(shape.error);
      const volume = volumeOf(solid);
      if (!volume.ok) return fail(volume.error);
      if (volume.value === 0) return ok({ positions: [], indices: [] });
      return ok(shapeTessellation(shape.value));
    },

    dispose(solid: KernelSolid): void {
      volumeCache.delete(solid);
    },

    section(input: SectionInput): KernelResult<SectionResult> {
      // The throwing seams are only the valueIn parses of the plane's
      // origin (non-finite magnitudes), normalized into the shared
      // invalid-length failure; the subset and emptiness rules return
      // structured failures (the shell/thicken discipline).
      try {
        const shape = shapeOf(input.target, "section");
        if (!shape.ok) return fail(shape.error);
        const origin: Vec3 = [
          valueIn(input.origin[0], "mm"),
          valueIn(input.origin[1], "mm"),
          valueIn(input.origin[2], "mm"),
        ];
        if (!origin.every((c) => Number.isFinite(c))) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "section rejected the plane origin: components must be finite lengths.",
            ),
          );
        }
        const raw = input.normal;
        const squared = raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2];
        if (
          !Number.isFinite(squared) ||
          squared === 0 ||
          !Number.isFinite(raw[0]) ||
          !Number.isFinite(raw[1]) ||
          !Number.isFinite(raw[2])
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              `section rejected a normal [${String(raw[0])}, ${String(raw[1])}, ${String(raw[2])}]: it must be a non-zero finite vector.`,
            ),
          );
        }
        const magnitude = Math.sqrt(squared);
        const normal: Vec3 = [
          raw[0] / magnitude,
          raw[1] / magnitude,
          raw[2] / magnitude,
        ];
        // The analytic face model's honest subset: a pristine box leaf
        // (the fillet/chamfer/shell subset discipline — the cross-section
        // polygon has a closed form exactly there).
        if (shape.value.kind !== "box") {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.unsupportedOperation,
              `section declined the solid: the fake kernel's cross-section model is its pristine-box subset; this solid is a "${shape.value.kind}" node. The general section reference kernel is the OpenCascade backend.`,
            ),
          );
        }
        const face = boxSectionFace(
          shape.value.size,
          origin,
          normal,
          input.keepSide,
        );
        if (!face.ok) return fail(face.error);
        // The cut solid rides the split's own covering-box composition —
        // extrude + subtract, every step an existing operation of THIS
        // kernel (no adapter-side geometry), so the cut answers volume,
        // bounds, membership, and tessellation with the kernel's own
        // documented boolean semantics.
        const plan = planSplitCut({
          planeOrigin: origin,
          planeNormal: normal,
          keepSide: input.keepSide,
          bounds: shapeBounds(shape.value),
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
        if (!tool.ok) return fail(tool.error);
        const cut = kernel.subtract(input.target, [tool.value]);
        if (!cut.ok) return fail(cut.error);
        return ok({ solid: cut.value, section: face.value });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidLength,
            `section rejected its input: ${detail}`,
          ),
        );
      }
    },
  };
  return kernel;
}

/**
 * The analytic cross-section of a pristine box leaf by an arbitrary plane
 * (Phase 46): the box's twelve edge/plane intersection points, hulled in
 * the plane's own 2D frame (an angular sort around the centroid — the
 * region is convex, so the sort IS the hull), measured by the shoelace
 * area and the polygon-centroid formula, exact. A plane that misses the
 * box (one side holds every corner) or grazes it (fewer than three
 * intersection points, a tangent or edge-touching cut) has no face: the
 * structured `kernel/section-empty` refusal.
 */
function boxSectionFace(
  size: Vec3,
  origin: Vec3,
  normal: Vec3,
  keepSide: 1 | -1,
): KernelResult<SectionFaceMeasure> {
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push([
      i & 1 ? at(size, 0) : 0,
      i & 2 ? at(size, 1) : 0,
      i & 4 ? at(size, 2) : 0,
    ]);
  }
  const distanceOf = (point: Vec3): number =>
    normal[0] * (point[0] - origin[0]) +
    normal[1] * (point[1] - origin[1]) +
    normal[2] * (point[2] - origin[2]);
  const distances = corners.map(distanceOf);
  let kept = 0;
  let removed = 0;
  for (const distance of distances) {
    if (keepSide * distance > 0) kept += 1;
    else if (keepSide * distance < 0) removed += 1;
  }
  if (removed === 0 || kept === 0) {
    return fail(
      kernelError(
        KERNEL_ERROR_CODES.sectionEmpty,
        "section rejected the plane: it misses the target (one side holds the whole solid), so there is no cross-section face to measure.",
      ),
    );
  }
  // The twelve cube edges as corner-index pairs differing in one bit.
  const edgePoints: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    for (const bit of [1, 2, 4]) {
      const j = i ^ bit;
      if (j <= i) continue;
      const di = distances[i];
      const dj = distances[j];
      if (di === undefined || dj === undefined) continue;
      if (di * dj < 0) {
        const t = di / (di - dj);
        const pi = corners[i];
        const pj = corners[j];
        if (pi === undefined || pj === undefined) continue;
        edgePoints.push([
          pi[0] + t * (pj[0] - pi[0]),
          pi[1] + t * (pj[1] - pi[1]),
          pi[2] + t * (pj[2] - pi[2]),
        ]);
      }
    }
  }
  if (edgePoints.length < 3) {
    return fail(
      kernelError(
        KERNEL_ERROR_CODES.sectionEmpty,
        "section rejected the plane: it grazes the target (the cut region degenerates), so there is no cross-section face to measure.",
      ),
    );
  }
  // A deterministic in-plane frame: the world axis least aligned with the
  // normal seeds the u axis; v completes the right-handed pair.
  const axis: Axis =
    Math.abs(normal[0]) <= Math.abs(normal[1]) &&
    Math.abs(normal[0]) <= Math.abs(normal[2])
      ? 0
      : Math.abs(normal[1]) <= Math.abs(normal[2])
        ? 1
        : 2;
  const seed: Vec3 = [
    axis === 0 ? 1 : 0,
    axis === 1 ? 1 : 0,
    axis === 2 ? 1 : 0,
  ];
  const crossNS = [
    normal[1] * seed[2] - normal[2] * seed[1],
    normal[2] * seed[0] - normal[0] * seed[2],
    normal[0] * seed[1] - normal[1] * seed[0],
  ];
  const crossLength = Math.hypot(
    crossNS[0] ?? 0,
    crossNS[1] ?? 0,
    crossNS[2] ?? 0,
  );
  if (!(crossLength > 0)) {
    return fail(
      kernelError(
        KERNEL_ERROR_CODES.invalidLength,
        "section rejected the plane: its in-plane frame degenerated.",
      ),
    );
  }
  const u: Vec3 = [
    (crossNS[0] ?? 0) / crossLength,
    (crossNS[1] ?? 0) / crossLength,
    (crossNS[2] ?? 0) / crossLength,
  ];
  const v: Vec3 = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ];
  const flat = edgePoints.map((point) => ({
    a:
      u[0] * (point[0] - origin[0]) +
      u[1] * (point[1] - origin[1]) +
      u[2] * (point[2] - origin[2]),
    b:
      v[0] * (point[0] - origin[0]) +
      v[1] * (point[1] - origin[1]) +
      v[2] * (point[2] - origin[2]),
  }));
  const centroidA = flat.reduce((sum, point) => sum + point.a, 0) / flat.length;
  const centroidB = flat.reduce((sum, point) => sum + point.b, 0) / flat.length;
  flat.sort(
    (p, q) =>
      Math.atan2(p.b - centroidB, p.a - centroidA) -
      Math.atan2(q.b - centroidB, q.a - centroidA),
  );
  let doubleArea = 0;
  let centroidXA = 0;
  let centroidXB = 0;
  for (let i = 0; i < flat.length; i += 1) {
    const p = flat[i];
    const q = flat[(i + 1) % flat.length];
    if (p === undefined || q === undefined) continue;
    const cross = p.a * q.b - q.a * p.b;
    doubleArea += cross;
    centroidXA += (p.a + q.a) * cross;
    centroidXB += (p.b + q.b) * cross;
  }
  const area = Math.abs(doubleArea) / 2;
  if (!(area > 1e-9)) {
    return fail(
      kernelError(
        KERNEL_ERROR_CODES.sectionEmpty,
        "section rejected the plane: it grazes the target (the cut region degenerates), so there is no cross-section face to measure.",
      ),
    );
  }
  const centroidMm: Vec3 = [
    origin[0] + (u[0] * centroidXA + v[0] * centroidXB) / (3 * doubleArea),
    origin[1] + (u[1] * centroidXA + v[1] * centroidXB) / (3 * doubleArea),
    origin[2] + (u[2] * centroidXA + v[2] * centroidXB) / (3 * doubleArea),
  ];
  return ok({ areaMm2: area, centroidMm: centroidMm });
}
