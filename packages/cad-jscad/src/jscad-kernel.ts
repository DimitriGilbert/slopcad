/**
 * The JSCAD geometry-kernel adapter (Phase 23): a full implementation of
 * the Phase 8 kernel contract on top of the pure-JavaScript `@jscad/modeling`
 * library — BSP-tree booleans, polygon-set geometry, no WASM, no worker
 * boot. JSCAD serves as the compatibility/reference backend (the plan
 * deliberately places it one layer lower, behind the kernel abstraction —
 * the jscad-fiber React integration is the precedent we do NOT follow), so
 * this adapter's purpose is running the shared contract and cross-kernel
 * suites against one more independent geometry engine.
 *
 * ## Isolation
 *
 * Every JSCAD type stays inside this module. The public surface hands out
 * and accepts only kernel-neutral {@link KernelSolid} handles: the `Geom3`
 * polygon sets live in a per-instance store behind {@link createSolidTag},
 * so no JSCAD shape or type ever crosses the package boundary. The library
 * is a CommonJS module; the one default import is destructured once here.
 *
 * ## Placement conventions
 *
 * The contract grounds primitives with a corner/z=0 footing; JSCAD's
 * constructors are mapped onto it with their `center` options — never by
 * re-centering at call sites:
 *
 * - box: `cuboid({size, center: [w/2, d/2, h/2]})` spans `[0,w] × [0,d] ×
 *   [0,h]` (JSCAD centers cuboids on `center`; probed exact).
 * - sphere: `sphere({radius, center: [0,0,0]})` is centred on the origin,
 *   exactly as contracted (vertices lie ON the sphere, so bounds are
 *   exactly `±radius`).
 * - cylinder: `cylinder({radius, height, center: [0,0,h/2]})` rests on
 *   `z = 0` and spans `z ∈ [0, h]` on the +z axis (JSCAD centers the
 *   height range on `center`; probed exact).
 * - cone/frustum: `cylinderElliptic({startRadius, endRadius, height,
 *   center: [0,0,h/2]})` puts `startRadius` at `z = 0` interpolating to
 *   `endRadius` at `z = h` (probed: the bottom face carries the start
 *   radius); `endRadius = [0,0]` is the sharp cone.
 * - `transform` maps to `geom3.transform` with a `mat4.fromRotation` axis
 *   matrix (rotation first, about the world origin) composed with
 *   `translate` (second, world space) — the exact application order the
 *   contract's `TransformInput` pins.
 * - `mirror` (Phase 26.9) maps to the same `geom3.transform` with the
 *   reflection matrix (−1 on the plane axis's diagonal, 2·offset
 *   translation); the library's lazy chain runs `poly3.transform`, which
 *   REVERSES polygon vertex order under `mat4.isMirroring` (probed), so
 *   the reflected facets stay outward with no adapter-side polygon
 *   surgery.
 * - `extrude` (Phase 26.1): the profile loop is tessellated at the shared
 *   mesh-kernel deflection ({@link PROFILE_MAX_SEGMENT_ANGLE_RAD} —
 *   straight polygons exact, curved segments in the measured ≈0.166%
 *   chord-fan band derived there), wound CCW, converted to a `geom2`
 *   polygon, and `extrudeLinear`-ed to `z ∈ [0, h]` (negative direction
 *   pre-translates the prism to `[−h, 0]`); the placement composes the
 *   same `fromRotation` matrix with a translate as `transform` does.
 * - `revolve` (Phase 26.2): the loop is tessellated in the axis frame at
 *   the shared deflection, mirrored to the non-negative radial side (the
 *   axis-crossing rejection guarantees one-sidedness; a mirrored profile
 *   sweeps the identical solid), wound CCW in (radial, axial), and
 *   `extrudeRotate`-ed about +z with the profile starting at +x sweeping
 *   CCW (probed) at 63 pinned segments; one composed placement
 *   (`revolutionMeshTransform`) rebases the engine frame onto the
 *   contract's axis frame before the placement rotation/translation
 *   apply. Axis crossing is rejected BEFORE the library because
 *   `extrudeRotate`'s only overflow behaviour silently caps points beyond
 *   the axis to it — a crossing contour would build a different,
 *   undiagnosed solid (probed in the library source).
 * - `sweep` (Phase 26.3): the profile chord polygon is transported to the
 *   path's stations (the contract's shared fixed-binormal frames at the
 *   shared angular deflection — G1 joints' shared stations deduplicated)
 *   and lofted between them with `extrudeFromSlices` (`repair: false` —
 *   the transported polygons are exact and need no repair; caps on open
 *   paths, none on closed rings, whose wall sequence closes itself).
 *   Fidelity: a straight path is a two-station loft — the exact prism;
 *   curved paths carry the documented station band (the same
 *   deflection-derived class as the chord tessellation), judged in the
 *   contract suite's curved tolerance.
 * - `loft` (Phase 26.4): each section's CCW chord polygon becomes one
 *   slice at its station z (placed by the same rotation-then-translation
 *   composition), and `extrudeFromSlices` walls consecutive slices
 *   vertex-to-vertex (the repair pass is a no-op — the slices are exact
 *   closed polygons) with caps at both ends — the contract's
 *   index-correspondence morph. The collection validation (member
 *   validity, station ordering, vertex-count compatibility) rejects
 *   BEFORE any JSCAD call: the library's own mismatch fallback
 *   repartitions unequal slices to the LCM edge count with even mid-edge
 *   splits (probed in the library source) — its own invented
 *   correspondence, silently a different solid than any other kernel's,
 *   exactly what the compatibility rule forbids. Fidelity: flat-triangle
 *   walls are exact wherever the ruled walls are planar (probed: prism,
 *   frustum, and multi-station fixtures agree with the fake kernel to
 *   1e-12; curved members carry the chord band); a SKEW wall (the twisted
 *   fixture) cannot flatten, so the solid built is the flat-wall one —
 *   probed 2000/3 mm³ vs the ruled model's Simpson value on the
 *   10mm-side, 45°-twist, 10mm-height square fixture — the per-kernel
 *   divergence the contract documents.
 *
 * ## Discretization and honesty of measures
 *
 * Curved primitives are polygon sets at {@link JSCAD_CURVED_SEGMENTS}
 * segments: `measureVolume` sums signed polygon volumes, so it is exact
 * w.r.t. the kernel's own representation (a box measures exactly
 * `w·d·h`; probed) but sits inside the curved band of the analytic value
 * (probed at 32 segments: sphere −1.60%, cylinder −0.64%, cone −0.64% —
 * all inside the contract suite's 5% curved tolerance). Boolean volumes
 * are BSP outputs: `measureVolume` is again exact over the polygon set,
 * but the BSP boundary itself is a float-precision approximation of the
 * true cut (coplanar/tangent faces produce near-degenerate slivers), so
 * the adapter declares `exactBooleanVolumes: false` — the fake kernel's
 * estimation-band discipline — and the suites judge boolean volumes in
 * the 5% band (probed plate-with-hole +0.059% vs analytic).
 * `measureBoundingBox` is the tight AABB of the actual polygon set (probed
 * exactly tight on union/intersect/plate), so `tightBooleanBounds: true`.
 *
 * ## Empty solids
 *
 * JSCAD represents empty results as geometry with a zero-polygon set
 * (probed: disjoint intersections and total subtractions produce 0
 * polygons). The adapter maps that onto the contract's empty-solid
 * semantics exactly: `volume` → 0 (the empty sum), `tessellate` → empty
 * soup, `bounds` → `kernel/bounds-empty` (checked BEFORE measuring —
 * JSCAD's own `measureBoundingBox` of an empty polygon set returns a
 * degenerate `[[0,0,0],[0,0,0]]` box, which would be a lie).
 *
 * ## Error normalization
 *
 * Every mutating operation runs inside a no-throw boundary mapped to the
 * contract failure code its inputs describe — primitive constructors,
 * `transform` (lengths → `kernel/invalid-length`, rotation inputs →
 * `kernel/invalid-rotation`), booleans (operand lists →
 * `kernel/invalid-operands`). Validators return structured failures
 * before any JSCAD call, so JSCAD's own throws on malformed options are
 * unreachable; thrown exceptions out of cad-core's `valueIn` (non-finite
 * magnitudes that only dynamically-parsed values can carry) or out of
 * JSCAD itself are normalized into the same structured failures, so raw
 * exceptions never escape.
 *
 * ## Determinism
 *
 * The library is pure JavaScript iterating plain arrays; the same inputs
 * rebuild identical polygon sets (probed: two independently built
 * plate-with-hole scenes serialize to identical vertex data). No worker,
 * no WASM, no clocks — determinism is pinned by the contract suite and a
 * dedicated cross-instance test.
 *
 * ## Normals
 *
 * `tessellate` omits `normals`: BSP output can contain near-degenerate
 * sliver polygons whose plane normals are numerically unreliable, and the
 * contract's honest path for kernels without trustworthy normals is to
 * omit them and let consumers compute their own.
 */

import modeling from "@jscad/modeling";
import type * as ModelingTypes from "@jscad/modeling";
import { type LengthValue, fail, ok, valueIn } from "@slopcad/cad-core";
import {
  type BoxInput,
  type ChamferInput,
  type ConeInput,
  type CylinderInput,
  type FilletInput,
  type GeometryKernel,
  type KernelBounds,
  type KernelCapabilities,
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
  type HelixSweepInput,
  type ProfileSweepInput,
  type ReplaceFaceInput,
  type ShellInput,
  type SphereInput,
  type Tessellation,
  type ThickenInput,
  type TransformInput,
} from "@slopcad/cad-kernel";
import {
  applyMatrix3,
  axisAngleMatrix,
  decomposeSweepPath,
  loftSectionPolygons,
  loftSectionsProblem,
  loftStations,
  normalizeRevolveAxis,
  polygonSignedArea,
  PROFILE_MAX_SEGMENT_ANGLE_RAD,
  type ProfilePoint2,
  profileLoopProblem,
  revolveCrossesAxis,
  revolvePappusVolume,
  REVOLVE_AXIS_TOUCH_TOLERANCE_MM,
  revolveSignedExtremes,
  revolutionMeshTransform,
  sweepPathClosed,
  sweepPathProblem,
  sweepPathSelfIntersects,
  sweepPieceStations,
  sweepProfileArcAxisCrossing,
  type SweepStation,
  taperedExtrudeProblem,
  taperInsetDistanceMm,
  tessellateProfileLoop,
  tessellateRevolveProfile,
} from "@slopcad/cad-kernel";
import { insetPolygon } from "@slopcad/cad-kernel";
import { createSolidTag } from "@slopcad/cad-kernel";

import { JSCAD_BACKEND_ID } from "./jscad-backend";

/**
 * The `Geom3` polygon-set type of `@jscad/modeling`, reached through the
 * library's own namespace exports (the type-only twin of the value import
 * above) and sealed inside this module.
 */
type JscadGeom3 = ModelingTypes.geometries.geom3.Geom3;

/** The library namespaces the adapter uses, destructured once. */
const {
  booleans,
  extrusions,
  geometries,
  measurements,
  maths,
  primitives,
  transforms,
} = modeling;
const {
  union: jscadUnion,
  subtract: jscadSubtract,
  intersect: jscadIntersect,
} = booleans;
const { extrudeLinear, extrudeFromSlices, extrudeRotate, slice } = extrusions;
const { cuboid, cylinder, cylinderElliptic, sphere } = primitives;
const { translate } = transforms;
const { measureArea, measureBoundingBox, measureVolume } = measurements;
const { toPolygons, transform: transformGeom3 } = geometries.geom3;
const { fromPoints: geom2FromPoints } = geometries.geom2;
const { fromPoints: sliceFromPoints } = slice;
const {
  create: mat4Create,
  fromRotation,
  fromScaling: mat4FromScaling,
  fromValues: mat4FromValues,
} = maths.mat4;

/**
 * Curved-primitive discretization: the number of segments per full
 * rotation JSCAD builds cylinders, cones, and spheres with (the library's
 * own default, passed explicitly so the adapter's measured bands stay
 * pinned if that default ever drifts). Probed deviations from the
 * analytic volumes at 32 segments: sphere −1.60%, cylinder −0.64%, cone
 * −0.64% — all inside the contract suite's 5% curved tolerance.
 */
export const JSCAD_CURVED_SEGMENTS = 32;

/**
 * Rotate-extrude segments `revolve` pins for a full turn: the shared
 * mesh-kernel deflection ceiling (2π / {@link PROFILE_MAX_SEGMENT_ANGLE_RAD}
 * = 63 chords, Δ ≈ 0.0997 rad) — the library scales this count
 * proportionally for partial sweeps. Measured on the probe fixture
 * (radius-25, height-30 axis-touching rectangle): full-turn volume deficit
 * 0.1657%, the same inscribed-chord band `extrude` documents; partial
 * sweeps carry the proportional chord/cap band of the same deflection.
 */
export const JSCAD_REVOLVE_SEGMENTS = Math.ceil(
  (Math.PI * 2) / PROFILE_MAX_SEGMENT_ANGLE_RAD,
);

/**
 * Capabilities of the JSCAD kernel, honestly declared (the fake kernel's
 * declaration discipline — exact primitives, estimated booleans):
 *
 * - Booleans are BSP-tree CSG, the library's core (`booleans`).
 * - Translation AND rotation are accepted by `transform` — rotation about
 *   the world origin, composed before the translation (`transformRotation`);
 *   probed exact on quarter-turned box bounds.
 * - Scale stays `false`: JSCAD has a `scale` transform, but the contract
 *   carries no scale input, so there is nothing to declare — the same
 *   discipline the OCCT adapter states in its declaration.
 * - Primitive volumes are exact w.r.t. the kernel's own polygon-set
 *   representation — a box measures exactly `w·d·h` (probed) — like
 *   Manifold's divergence-theorem declaration; curved primitives sit in
 *   the curved band of the analytic values (probed, see above).
 * - Boolean volumes are BSP float-approximation outputs, declared
 *   estimated (`exactBooleanVolumes: false`) — the fake kernel's pattern.
 * - Bounds of boolean results are the tight AABBs of the actual result
 *   polygon sets (probed exactly tight on union/intersect/plate).
 * - Topology is a polygon set rebuilt by every BSP boolean; there is no
 *   BREP and no face/edge identity to keep (`persistentTopology: false`).
 * - The Phase 26.3 sweep lofts the transported profile polygon between
 *   path stations at the shared deflection (`extrudeFromSlices`) — the
 *   same fidelity class as the chord tessellation: straight paths exact
 *   (a two-station loft is the prism), curved paths inside the documented
 *   station band (`sweep: true`).
 * - The Phase 26.4 loft walls the sections' CCW chord polygons between
 *   their stations with the same `extrudeFromSlices` machinery — the
 *   contract's vertex-morph exactly where the ruled walls are planar
 *   (validated counts; probed agreeing with the fake kernel to 1e-12),
 *   with the skew-wall (twisted) divergence documented per kernel
 *   (`loft: true`).
 * - The Phase 26.5 fillet is NOT implemented (`fillet: false`): the engine's
 *   operation set carries no fillet (probed — `@jscad/modeling` ships
 *   booleans, extrusions, hulls, minkowski, expansions, and modifiers; an
 *   expansions-based corner approximation would be an adapter-side mesh
 *   hack, not a kernel operation, and would not meet the exact-volume
 *   fixtures). Every `fillet` call answers the structured
 *   `kernel/unsupported-operation` — the Manifold twin's convention.
 * - The Phase 26.6 chamfer is NOT implemented (`chamfer: false`), the
 *   fillet's verdict verbatim: the engine's operation set carries no
 *   chamfer either (the same probe), so every `chamfer` call answers the
 *   structured `kernel/unsupported-operation`.
 * - The Phase 26.7 shell is NOT implemented (`shell: false`): the engine's
 *   operation set carries no hollowing (probed — `expandShell` is the
 *   outward Minkowski expansion's internal helper: no face selection, no
 *   wall building), so every `shell` call answers the structured
 *   `kernel/unsupported-operation`.
 * - The Phase 26.9 mirror IS implemented (`mirror: true`): the library's
 *   own `geom3.transform` of the reflection matrix, whose lazy chain runs
 *   `poly3.transform` — that helper reverses polygon vertex order under
 *   `mat4.isMirroring`, keeping the reflected facets outward (probed:
 *   `measureVolume` stays positive and the min-face facet normal points
 *   away), so the adapter only passes the matrix.
 * - The Phase 27.4 surface-area measurement IS implemented
 *   (`surfaceArea: true`): the library's own `measureArea` — the polygon
 *   set's total facet area, exact w.r.t. the kernel's polygon-set
 *   representation, the same semantics class as its `measureVolume`
 *   volumes (probed: the corner-origin box measures exactly 2200 mm²; the
 *   32-segment plate-with-bore lands at the inscribed band of the analytic
 *   2 200 + 48π mm², to +0.010%; boolean outputs measure over their BSP
 *   polygon sets, the declared-estimated honesty class of their volumes;
 *   an empty polygon set measures 0).
 */
export const JSCAD_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: true,
  transformScale: true,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: false,
  tightBooleanBounds: true,
  persistentTopology: false,
  sweep: true,
  helix: false,
  loft: true,
  fillet: false,
  chamfer: false,
  shell: false,
  thicken: false,
  extrudeTaper: true,
  mirror: true,
  surfaceArea: true,
  localFaceOps: false,
});

/**
 * The per-handle payload: the JSCAD polygon set, or `null` once the handle
 * was disposed (subsequent operations read as `kernel/solid-not-owned`,
 * the same code that guards foreign handles).
 */
interface SolidPayload {
  geometry: JscadGeom3 | null;
}

function kernelError(code: KernelErrorCode, message: string): KernelError {
  return { code, message, input: null };
}

/**
 * The smallest squared magnitude a rotation axis may carry: JSCAD's
 * `mat4.fromRotation` silently degrades an axis with squared magnitude
 * below its `EPS` (1e-5) to the identity matrix — a silent mis-apply the
 * contract forbids — so the adapter rejects such axes up front with
 * `kernel/invalid-rotation` instead (the OCCT adapter's normalizability
 * discipline, thresholded at the measured library constant).
 */
const NORMALIZABLE_AXIS_MIN_SQUARED_MAGNITUDE = maths.constants.EPS;

/** Creates a fresh JSCAD kernel; handles are owned per instance. */
export function createJscadKernel(): GeometryKernel {
  const tag = createSolidTag<SolidPayload>();

  const wrapSolid = (geometry: JscadGeom3): KernelSolid =>
    tag.wrap({ geometry });

  const geometryOf = (
    solid: KernelSolid,
    operation: string,
  ): KernelResult<JscadGeom3> => {
    const payload = tag.unwrap(solid);
    if (payload === undefined || payload.geometry === null) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.solidNotOwned,
          `${operation} rejected a solid handle that this kernel instance did not create (or has already disposed).`,
        ),
      );
    }
    return ok(payload.geometry);
  };

  const positiveLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    // valueIn throws for non-finite magnitudes; the operation-level
    // normalizer maps that to the same invalid-length failure.
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
  };

  const nonNegativeLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
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
  };

  const rotationAxisIn = (
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
          `${operation} rejected a rotation about [${String(x)}, ${String(y)}, ${String(z)}]: the axis magnitude cannot be normalized above JSCAD's EPS (squared magnitude ${squaredMagnitude} is zero, denormal, or below the library's silent-identity threshold).`,
        ),
      );
    }
    return ok(axis);
  };

  const operandsOf = (
    solids: readonly KernelSolid[],
    minimum: number,
    operation: string,
  ): KernelResult<readonly JscadGeom3[]> => {
    if (solids.length < minimum) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          `${operation} rejected ${solids.length} operand(s): at least ${minimum} are required.`,
        ),
      );
    }
    const geometriesOut: JscadGeom3[] = [];
    for (const solid of solids) {
      const geometry = geometryOf(solid, operation);
      if (!geometry.ok) return fail(geometry.error);
      geometriesOut.push(geometry.value);
    }
    return ok(geometriesOut);
  };

  /**
   * Runs one whole kernel operation inside the no-throw boundary: value
   * failures returned by validators pass through, and any thrown exception
   * — cad-core's `valueIn` rejecting non-finite magnitudes, or a throw out
   * of JSCAD — is normalized into the structured failure the operation's
   * inputs map to. Raw exceptions never escape a kernel operation.
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
          `${operation} failed inside the JSCAD kernel boundary: ${detail}`,
        ),
      );
    }
  };

  /** A solid is empty exactly when its polygon set is empty (probed). */
  const isEmpty = (geometry: JscadGeom3): boolean =>
    toPolygons(geometry).length === 0;

  /**
   * Converts a polygon set into the contract's indexed triangle soup: one
   * fan triangulation per convex BSP polygon (BSP retesselation emits
   * convex polygons — probed max 4 vertices on the drilled plate), each
   * triangle carrying its own three vertices (no dedup, so no float
   * equality pitfalls), indices counting vertices sequentially.
   */
  const tessellateGeometry = (geometry: JscadGeom3): Tessellation => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const polygon of toPolygons(geometry)) {
      for (let v = 1; v < polygon.vertices.length - 1; v += 1) {
        const a = polygon.vertices[0];
        const b = polygon.vertices[v];
        const c = polygon.vertices[v + 1];
        if (a === undefined || b === undefined || c === undefined) continue;
        indices.push(
          positions.length / 3,
          positions.length / 3 + 1,
          positions.length / 3 + 2,
        );
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      }
    }
    return { positions, indices };
  };

  return {
    id: JSCAD_BACKEND_ID,
    capabilities: JSCAD_KERNEL_CAPABILITIES,

    createBox(input: BoxInput): KernelResult<KernelSolid> {
      return run("createBox", KERNEL_ERROR_CODES.invalidLength, () => {
        const width = positiveLength(input.width, "width", "createBox");
        if (!width.ok) return fail(width.error);
        const depth = positiveLength(input.depth, "depth", "createBox");
        if (!depth.ok) return fail(depth.error);
        const height = positiveLength(input.height, "height", "createBox");
        if (!height.ok) return fail(height.error);
        const { value: w } = width;
        const { value: d } = depth;
        const { value: h } = height;
        return ok(
          wrapSolid(cuboid({ size: [w, d, h], center: [w / 2, d / 2, h / 2] })),
        );
      });
    },

    createSphere(input: SphereInput): KernelResult<KernelSolid> {
      return run("createSphere", KERNEL_ERROR_CODES.invalidLength, () => {
        const radius = positiveLength(input.radius, "radius", "createSphere");
        if (!radius.ok) return fail(radius.error);
        return ok(
          wrapSolid(
            sphere({
              radius: radius.value,
              center: [0, 0, 0],
              segments: JSCAD_CURVED_SEGMENTS,
            }),
          ),
        );
      });
    },

    createCylinder(input: CylinderInput): KernelResult<KernelSolid> {
      return run("createCylinder", KERNEL_ERROR_CODES.invalidLength, () => {
        const radius = positiveLength(input.radius, "radius", "createCylinder");
        if (!radius.ok) return fail(radius.error);
        const height = positiveLength(input.height, "height", "createCylinder");
        if (!height.ok) return fail(height.error);
        return ok(
          wrapSolid(
            cylinder({
              radius: radius.value,
              height: height.value,
              center: [0, 0, height.value / 2],
              segments: JSCAD_CURVED_SEGMENTS,
            }),
          ),
        );
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
          wrapSolid(
            cylinderElliptic({
              startRadius: [bottomRadius.value, bottomRadius.value],
              endRadius: [topRadius.value, topRadius.value],
              height: height.value,
              center: [0, 0, height.value / 2],
              segments: JSCAD_CURVED_SEGMENTS,
            }),
          ),
        );
      });
    },

    extrude(input: ProfileExtrudeInput): KernelResult<KernelSolid> {
      return run("extrude", KERNEL_ERROR_CODES.invalidProfile, () => {
        const height = positiveLength(input.height, "height", "extrude");
        if (!height.ok) return fail(height.error);
        // Placement validation before any JSCAD work (same thresholds and
        // codes as transform's rotation path).
        const axis = rotationAxisIn(input.placement.rotation.axis, "extrude");
        if (!axis.ok) return fail(axis.error);
        let angleRad: number;
        try {
          angleRad = valueIn(input.placement.rotation.angle, "rad");
        } catch {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "extrude rejected a rotation whose angle magnitude is not a finite number.",
            ),
          );
        }
        if (!Number.isFinite(angleRad)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "extrude rejected a rotation whose angle magnitude is not a finite number.",
            ),
          );
        }
        const tx = valueIn(input.placement.translation.x, "mm");
        const ty = valueIn(input.placement.translation.y, "mm");
        const tz = valueIn(input.placement.translation.z, "mm");
        // Structural profile checks: closure, degeneracy (documented probe
        // scope), and the face floor.
        const problem = profileLoopProblem(input.loop);
        if (problem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `extrude rejected the profile loop: ${problem}.`,
            ),
          );
        }
        const polygon: readonly ProfilePoint2[] = tessellateProfileLoop(
          input.loop,
        );
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
        // CCW winding keeps extrudeLinear's side normals outward.
        const ccw =
          polygonSignedArea(polygon) > 0 ? polygon : [...polygon].reverse();
        // The Phase 41 draft taper: the shared battery first, then the
        // two-slice route the contract pins — the chord polygon and its
        // far miter inset become the two slices, and extrudeFromSlices
        // walls them vertex-to-vertex (the index morph). For straight-
        // edged loops the blend IS the inset family at every parameter
        // (the inset corner moves linearly), so the solid is exact; curved
        // loops carry the same chord band as the plain prism.
        if (input.taper !== undefined) {
          const taperProblem = taperedExtrudeProblem(
            input.loop,
            height.value,
            input.taper,
          );
          if (taperProblem !== null) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidTaper,
                `extrude rejected the taper: ${taperProblem.message}`,
              ),
            );
          }
          const inset = taperInsetDistanceMm(height.value, input.taper) ?? 0;
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
            const farZ = input.direction === -1 ? -height.value : height.value;
            // Each slice carries its own station z (the loft route): the
            // base at the profile plane, the far inset at the extrusion's
            // end — extrudeFromSlices walls them at their authored heights.
            const slices = [
              ccw.map(
                (vertex) => [vertex.x, vertex.y, 0] as [number, number, number],
              ),
              far.map(
                (vertex) =>
                  [vertex.x, vertex.y, farZ] as [number, number, number],
              ),
            ].map((section) => sliceFromPoints(section));
            const firstSlice = slices[0];
            if (firstSlice === undefined) {
              return fail(
                kernelError(
                  KERNEL_ERROR_CODES.invalidProfile,
                  "extrude rejected the profile loop: the chord polygon did not build.",
                ),
              );
            }
            const tapered = extrudeFromSlices(
              {
                numberOfSlices: 2,
                capStart: true,
                capEnd: true,
                close: false,
                callback: (_progress: number, index: number) => {
                  const sectionSlice = slices[index];
                  if (sectionSlice === undefined) {
                    throw new Error(
                      "Invariant violation: both taper slices exist for every index extrudeFromSlices requests.",
                    );
                  }
                  return sectionSlice;
                },
              },
              firstSlice,
            );
            const matrix = fromRotation(mat4Create(), angleRad, [
              axis.value[0],
              axis.value[1],
              axis.value[2],
            ]);
            const placed = transformGeom3(matrix, tapered);
            return ok(wrapSolid(translate([tx, ty, tz], placed)));
          }
        }
        const footprint = geom2FromPoints(
          ccw.map((point) => [point.x, point.y] as [number, number]),
        );
        const prism = extrudeLinear({ height: height.value }, footprint);
        const oriented =
          input.direction === -1
            ? translate([0, 0, -height.value], prism)
            : prism;
        const matrix = fromRotation(mat4Create(), angleRad, [
          axis.value[0],
          axis.value[1],
          axis.value[2],
        ]);
        const placed = transformGeom3(matrix, oriented);
        return ok(wrapSolid(translate([tx, ty, tz], placed)));
      });
    },

    revolve(input: ProfileRevolveInput): KernelResult<KernelSolid> {
      return run("revolve", KERNEL_ERROR_CODES.invalidProfile, () => {
        // The shared 26.2 validation battery, before any JSCAD work: the
        // sweep-angle domain, the axis direction, the placement, the
        // structural profile soundness, and the axis-crossing rejection.
        // The crossing rejection is LOAD-BEARING for JSCAD specifically:
        // `extrudeRotate`'s only overflow behaviour silently CAPS points
        // beyond the axis to it (probed in the library source) — a
        // crossing contour would build a different, undiagnosed solid.
        let sweep: number;
        try {
          sweep = valueIn(input.angle, "rad");
        } catch {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "revolve rejected the sweep angle: its magnitude is not a finite number.",
            ),
          );
        }
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
              `revolve rejected an axis along [${String(input.axis.direction[0])}, ${String(input.axis.direction[1])}]: the direction must be a non-zero finite vector.`,
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
        const translation: [number, number, number] = [
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
        if (revolveCrossesAxis(input.loop, frame)) {
          const extremes = revolveSignedExtremes(input.loop, frame);
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.profileAxisCrossing,
              `revolve rejected the profile loop: it crosses the revolve axis (signed distances span [${String(extremes.min)}, ${String(extremes.max)}] mm). Move the profile fully to one side; touching the axis is allowed.`,
            ),
          );
        }
        // The chord polygon in axis coordinates (x = axial, y = signed
        // radial) at the shared deflection, mirrored to the non-negative
        // radial side `extrudeRotate` revolves (one-sidedness guaranteed by
        // the crossing rejection; the mirror sweeps the identical solid).
        const axisPolygon = tessellateRevolveProfile(input.loop, frame);
        if (
          axisPolygon.length < 3 ||
          !(Math.abs(polygonSignedArea(axisPolygon)) > 1e-9)
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "revolve rejected the profile loop: it is degenerate (fewer than three distinct vertices, zero area, or an unclosed boundary).",
            ),
          );
        }
        if (!(revolvePappusVolume(axisPolygon, sweep) > 1e-9)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "revolve rejected the profile loop: it encloses no material away from the axis, so the sweep has zero volume.",
            ),
          );
        }
        // The shared touch tolerance (not an exact >= 0): a legal touching
        // profile whose on-axis vertex rounds to −ε (oblique axes, decimal
        // arithmetic) passes the crossing validator yet would take the
        // π-rotated −v-side placement — 180° from the contract's sweep-start
        // semantics.
        const positiveSide =
          Math.min(...axisPolygon.map((point) => point.y)) >=
          -REVOLVE_AXIS_TOUCH_TOLERANCE_MM;
        // Winding: CCW in the (radial, axial) plane (the mirroring above
        // can flip it).
        const mirrored = axisPolygon.map((point) => ({
          x: Math.abs(point.y),
          y: point.x,
        }));
        const ordered =
          polygonSignedArea(mirrored) > 0 ? mirrored : [...mirrored].reverse();
        const footprint = geom2FromPoints(
          ordered.map((point) => [point.x, point.y] as [number, number]),
        );
        // `extrudeRotate` spins the footprint about the +z axis with the
        // profile starting at +x and sweeping counter-clockwise (probed);
        // 63 segments pins the shared mesh-kernel deflection for a full
        // turn, scaled proportionally by the library for partial sweeps.
        const revolved = extrudeRotate(
          {
            angle: sweep,
            overflow: "cap",
            segments: JSCAD_REVOLVE_SEGMENTS,
            startAngle: 0,
          },
          footprint,
        );
        // One composed placement: the engine frame rebases onto the
        // contract's axis frame, then the contract placement applies
        // (rotation first about the world origin, translation second).
        const placement = revolutionMeshTransform(
          frame,
          positiveSide,
          axisAngleMatrix(axis, angle),
          translation,
        );
        const r = placement.rotation;
        const t = placement.translation;
        // JSCAD mat4 is column-major.
        const matrix = mat4FromValues(
          r[0]?.[0] ?? 0,
          r[1]?.[0] ?? 0,
          r[2]?.[0] ?? 0,
          0,
          r[0]?.[1] ?? 0,
          r[1]?.[1] ?? 0,
          r[2]?.[1] ?? 0,
          0,
          r[0]?.[2] ?? 0,
          r[1]?.[2] ?? 0,
          r[2]?.[2] ?? 0,
          0,
          t[0],
          t[1],
          t[2],
          1,
        );
        return ok(wrapSolid(transformGeom3(matrix, revolved)));
      });
    },

    sweep(input: ProfileSweepInput): KernelResult<KernelSolid> {
      return run("sweep", KERNEL_ERROR_CODES.invalidProfile, () => {
        // The shared 26.3 validation battery, before any JSCAD work — the
        // same structured rejections every implementing kernel runs.
        const rotationAxis = rotationAxisIn(
          input.placement.rotation.axis,
          "sweep",
        );
        if (!rotationAxis.ok) return fail(rotationAxis.error);
        let angleRad: number;
        try {
          angleRad = valueIn(input.placement.rotation.angle, "rad");
        } catch {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "sweep rejected a rotation whose angle magnitude is not a finite number.",
            ),
          );
        }
        if (!Number.isFinite(angleRad)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "sweep rejected a rotation whose angle magnitude is not a finite number.",
            ),
          );
        }
        const tx = valueIn(input.placement.translation.x, "mm");
        const ty = valueIn(input.placement.translation.y, "mm");
        const tz = valueIn(input.placement.translation.z, "mm");
        const problem = profileLoopProblem(input.loop);
        if (problem !== null) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              `sweep rejected the profile loop: ${problem}.`,
            ),
          );
        }
        const polygon: readonly ProfilePoint2[] = tessellateProfileLoop(
          input.loop,
        );
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
        // The station loft: the CCW chord polygon transported to every
        // path station (the shared fixed-binormal frames at the shared
        // angular deflection), placed in world space, and lofted by
        // JSCAD's extrudeFromSlices. Consecutive pieces share their joint
        // station exactly (G1) — deduplicated so the loft never walls
        // across a zero-length gap. A closed ring caps nothing: its wall
        // sequence closes on itself; an open path caps both ends.
        const ccw =
          polygonSignedArea(polygon) > 0 ? polygon : [...polygon].reverse();
        const closed = sweepPathClosed(input.path);
        const stations: SweepStation[] = [];
        for (const piece of decomposeSweepPath(input.path)) {
          for (const station of sweepPieceStations(piece)) {
            const last = stations[stations.length - 1];
            const shared =
              last !== undefined &&
              Math.hypot(
                last.position.x - station.position.x,
                last.position.z - station.position.z,
              ) <= 1e-9 &&
              Math.hypot(last.e1.x - station.e1.x, last.e1.z - station.e1.z) <=
                1e-9;
            if (shared) continue;
            stations.push(station);
          }
        }
        const rotation = axisAngleMatrix(rotationAxis.value, angleRad);
        const slices = stations.map((station) =>
          sliceFromPoints(
            ccw.map((vertex) => {
              const world = applyMatrix3(rotation, [
                station.position.x + vertex.x * station.e1.x,
                vertex.y,
                station.position.z + vertex.x * station.e1.z,
              ]);
              return [world[0] + tx, world[1] + ty, world[2] + tz] as [
                number,
                number,
                number,
              ];
            }),
          ),
        );
        const swept = extrudeFromSlices(
          {
            numberOfSlices: slices.length,
            capStart: !closed,
            capEnd: !closed,
            close: false,
            callback: (_progress: number, index: number) => {
              const stationSlice = slices[index];
              if (stationSlice === undefined) {
                throw new Error(
                  "Invariant violation: station slices exist for every index extrudeFromSlices requests.",
                );
              }
              return stationSlice;
            },
          },
          // The library's default repair pass runs on this base only, and
          // is a no-op on the station slices: each is an exact closed
          // polygon (a rigid image of the CCW chord polygon), so there is
          // no gap to mend and no vertex to merge.
          slices[0],
        );
        return ok(wrapSolid(swept));
      });
    },

    helixSweep(input: HelixSweepInput): KernelResult<KernelSolid> {
      // The structured decline (Phase 40): the JSCAD engine's operation
      // set carries no helical sweep primitive, and the plan's ruling is
      // that helical sweeps are OCCT territory — a station-loft rolled in
      // the adapter would be adapter-side meshing wearing a kernel name.
      // Never a silent approximation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "helixSweep is unsupported by the JSCAD kernel: the engine has no helical sweep primitive, and helical sweeps are the BREP kernel's territory (the capability plan's ruling).",
        ),
      );
    },

    loft(input: ProfileLoftInput): KernelResult<KernelSolid> {
      return run("loft", KERNEL_ERROR_CODES.invalidProfile, () => {
        // The shared 26.4 validation battery, before any JSCAD work — the
        // same structured rejections every implementing kernel runs. The
        // vertex-count rule is LOAD-BEARING for JSCAD specifically: with
        // unequal slices the library's extrudeWalls silently repartitions
        // both to the LCM edge count (even mid-edge splits, probed in the
        // library source) — its own invented correspondence, a different
        // solid than the contract's index morph, with no diagnostic.
        const rotationAxis = rotationAxisIn(
          input.placement.rotation.axis,
          "loft",
        );
        if (!rotationAxis.ok) return fail(rotationAxis.error);
        let angleRad: number;
        try {
          angleRad = valueIn(input.placement.rotation.angle, "rad");
        } catch {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "loft rejected a rotation whose angle magnitude is not a finite number.",
            ),
          );
        }
        if (!Number.isFinite(angleRad)) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidRotation,
              "loft rejected a rotation whose angle magnitude is not a finite number.",
            ),
          );
        }
        const tx = valueIn(input.placement.translation.x, "mm");
        const ty = valueIn(input.placement.translation.y, "mm");
        const tz = valueIn(input.placement.translation.z, "mm");
        const problem = loftSectionsProblem(input.sections);
        if (problem !== null) {
          return fail(
            kernelError(
              problem.code,
              `loft rejected the section collection: ${problem.message}.`,
            ),
          );
        }
        // The section loft: each CCW chord polygon becomes one slice at
        // its station z (placed by the rotation-then-translation
        // composition), and extrudeFromSlices walls consecutive slices
        // vertex-to-vertex — the contract's index morph exactly — with
        // caps at both ends. Validated equal counts mean the library's
        // repartition fallback never runs.
        const rotation = axisAngleMatrix(rotationAxis.value, angleRad);
        const stations = loftStations(input.sections);
        const polygons = loftSectionPolygons(input.sections);
        const slices = polygons.map((polygon, index) =>
          sliceFromPoints(
            polygon.map((vertex) => {
              const z = stations[index] ?? 0;
              const world = applyMatrix3(rotation, [vertex.x, vertex.y, z]);
              return [world[0] + tx, world[1] + ty, world[2] + tz] as [
                number,
                number,
                number,
              ];
            }),
          ),
        );
        const firstSlice = slices[0];
        if (firstSlice === undefined) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidOperands,
              "loft rejected the section collection: at least 2 are required.",
            ),
          );
        }
        const lofted = extrudeFromSlices(
          {
            numberOfSlices: slices.length,
            capStart: true,
            capEnd: true,
            close: false,
            callback: (_progress: number, index: number) => {
              const sectionSlice = slices[index];
              if (sectionSlice === undefined) {
                throw new Error(
                  "Invariant violation: section slices exist for every index extrudeFromSlices requests.",
                );
              }
              return sectionSlice;
            },
          },
          // The library's default repair pass runs on this base only, and
          // the callback ignores the base entirely (each slice is an exact
          // closed polygon — a rigid image of a CCW chord polygon at its
          // station), so there is no gap to mend and no vertex to merge.
          firstSlice,
        );
        return ok(wrapSolid(lofted));
      });
    },

    fillet(input: FilletInput): KernelResult<KernelSolid> {
      // The Manifold twin's convention (Phase 26.5): the engine has no
      // fillet operation (probed — `@jscad/modeling` ships booleans,
      // extrusions, hulls, minkowski, expansions, and modifiers; there is
      // no edge selection and no rounding surface anywhere in the API), so
      // every `fillet` call — valid input or not — answers with the
      // structured unsupported code. An expansions-based corner
      // approximation would be adapter-side meshing that misses the exact
      // fixtures, not a kernel operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "fillet is unsupported by the JSCAD kernel: the engine's operation set carries no fillet (booleans, extrusions, hulls, minkowski, expansions, modifiers only — probed), and the adapter does not approximate corner rounding in its place.",
        ),
      );
    },

    chamfer(input: ChamferInput): KernelResult<KernelSolid> {
      // The fillet verdict, verbatim (Phase 26.6): the engine's operation
      // set carries no chamfer either (the same probe), so every `chamfer`
      // call — valid input or not — answers with the structured unsupported
      // code. A boolean-cut corner approximation would be adapter-side
      // meshing, not a kernel operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "chamfer is unsupported by the JSCAD kernel: the engine's operation set carries no chamfer (the fillet verdict verbatim — booleans, extrusions, hulls, minkowski, expansions, modifiers only — probed), and the adapter does not approximate corner cutting in its place.",
        ),
      );
    },

    shell(input: ShellInput): KernelResult<KernelSolid> {
      // The convention's FACE-addressed application (Phase 26.7): the
      // engine's operation set carries no hollowing (probed — `expandShell`
      // is the outward Minkowski expansion's internal helper: no face
      // selection, no wall building), so every `shell` call — valid input
      // or not — answers with the structured unsupported code. Subtraction-
      // based wall carving would be adapter-side meshing, not a kernel
      // operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "shell is unsupported by the JSCAD kernel: the engine's operation set carries no hollowing (expandShell is the outward expansion's internal helper — no face selection, no wall building — probed), and the adapter does not approximate wall carving in its place.",
        ),
      );
    },

    thicken(input: ThickenInput): KernelResult<KernelSolid> {
      // The Phase 41 closed hollow: the shell's verdict verbatim — the
      // engine carries no 3D offset (its `expandShell` is the outward
      // Minkowski expansion's internal helper, probed), so the cavity the
      // closed hollow needs cannot be built, and carving it with
      // subtraction would be adapter-side meshing, not a kernel operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "thicken is unsupported by the JSCAD kernel: the engine carries no 3D offset or hollowing operation (the shell verdict, probed), so the closed hollow's cavity cannot be built honestly.",
        ),
      );
    },

    moveFace(input: MoveFaceInput): KernelResult<KernelSolid> {
      // Phase 44: the local face ops need face-addressed geometry — a
      // face identity to sweep and re-close against. The JSCAD engine
      // carries no face selection or face identity at all (the shell's
      // probed verdict), and re-meshing a moved face's neighbourhood by
      // hand would be adapter-side meshing, not a kernel operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "moveFace is unsupported by the JSCAD kernel: the engine has no face identity or face selection to address (the shell verdict, probed), so the local face move cannot be built honestly.",
        ),
      );
    },

    replaceFace(input: ReplaceFaceInput): KernelResult<KernelSolid> {
      // The move's verdict, verbatim, on the datum-plane re-close.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "replaceFace is unsupported by the JSCAD kernel: the engine has no face identity or face selection to address (the shell verdict, probed), so the local re-close cannot be built honestly.",
        ),
      );
    },

    deleteFace(input: DeleteFaceInput): KernelResult<KernelSolid> {
      // The move's verdict, verbatim, on the removal.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "deleteFace is unsupported by the JSCAD kernel: the engine has no face identity or face selection to address (the shell verdict, probed), so the local removal cannot be built honestly.",
        ),
      );
    },

    union(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      return run("union", KERNEL_ERROR_CODES.invalidOperands, () => {
        const geometriesIn = operandsOf(operands, 2, "union");
        if (!geometriesIn.ok) return fail(geometriesIn.error);
        return ok(wrapSolid(jscadUnion(...geometriesIn.value)));
      });
    },

    subtract(
      target: KernelSolid,
      tools: readonly KernelSolid[],
    ): KernelResult<KernelSolid> {
      return run("subtract", KERNEL_ERROR_CODES.invalidOperands, () => {
        const targetGeometry = geometryOf(target, "subtract");
        if (!targetGeometry.ok) return fail(targetGeometry.error);
        const toolGeometries = operandsOf(tools, 1, "subtract");
        if (!toolGeometries.ok) return fail(toolGeometries.error);
        return ok(
          wrapSolid(
            jscadSubtract(targetGeometry.value, ...toolGeometries.value),
          ),
        );
      });
    },

    intersect(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      return run("intersect", KERNEL_ERROR_CODES.invalidOperands, () => {
        const geometriesIn = operandsOf(operands, 2, "intersect");
        if (!geometriesIn.ok) return fail(geometriesIn.error);
        return ok(wrapSolid(jscadIntersect(...geometriesIn.value)));
      });
    },

    transform(
      solid: KernelSolid,
      input: TransformInput,
    ): KernelResult<KernelSolid> {
      return run("transform", KERNEL_ERROR_CODES.invalidLength, () => {
        const geometry = geometryOf(solid, "transform");
        if (!geometry.ok) return fail(geometry.error);
        // valueIn rejects non-finite magnitudes (normalized above); every
        // finite length, of any sign, is a legal translation component.
        const x = valueIn(input.x, "mm");
        const y = valueIn(input.y, "mm");
        const z = valueIn(input.z, "mm");
        let placed = geometry.value;
        if (input.rotation !== undefined) {
          const axis = rotationAxisIn(input.rotation.axis, "transform");
          if (!axis.ok) return fail(axis.error);
          // valueIn of an AngleValue throws on non-finite magnitudes;
          // normalize that into the rotation failure code the contract
          // assigns degenerate rotation inputs.
          let angleRad: number;
          try {
            angleRad = valueIn(input.rotation.angle, "rad");
          } catch {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidRotation,
                "transform rejected a rotation whose angle magnitude is not a finite number.",
              ),
            );
          }
          if (!Number.isFinite(angleRad)) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidRotation,
                "transform rejected a rotation whose angle magnitude is not a finite number.",
              ),
            );
          }
          const matrix = fromRotation(mat4Create(), angleRad, [
            axis.value[0],
            axis.value[1],
            axis.value[2],
          ]);
          // Rotation first: about the world-origin axis (probed exact on
          // the quarter-turned box), then the world-space translation.
          placed = transformGeom3(matrix, placed);
        }
        // The Phase 41 uniform scale: `mat4.fromScaling` about the world
        // origin, applied before the world-space translation — the
        // contract's p ↦ s·R·p + t order (a uniform scale commutes past
        // the rotation, so either composition builds the same solid). A
        // strictly positive factor never trips the library's mirroring
        // vertex reversal, so the facets stay outward untouched.
        if (input.scale !== undefined) {
          if (!(input.scale > 0) || !Number.isFinite(input.scale)) {
            return fail(
              kernelError(
                KERNEL_ERROR_CODES.invalidLength,
                `transform rejected the scale factor ${String(input.scale)}: it must be a finite, strictly positive number.`,
              ),
            );
          }
          placed = transformGeom3(
            mat4FromScaling(mat4Create(), [
              input.scale,
              input.scale,
              input.scale,
            ]),
            placed,
          );
        }
        return ok(wrapSolid(translate([x, y, z], placed)));
      });
    },

    mirror(solid: KernelSolid, input: MirrorInput): KernelResult<KernelSolid> {
      return run("mirror", KERNEL_ERROR_CODES.invalidLength, () => {
        const geometry = geometryOf(solid, "mirror");
        if (!geometry.ok) return fail(geometry.error);
        // Every finite offset is a legal plane position (zero and negative
        // offsets included); valueIn's non-finite throw normalizes into
        // the shared invalid-length failure above.
        const offset = valueIn(input.offset, "mm");
        // Column-major reflection matrix (JSCAD's convention): −1 on the
        // axis's diagonal, the axis translation 2·offset. The lazy
        // transform chain's poly3.transform reverses vertex order under
        // mat4.isMirroring (probed), keeping the facets outward — the
        // adapter does no polygon surgery itself.
        const doubled = 2 * offset;
        const matrix =
          input.axis === "x"
            ? mat4FromValues(
                -1,
                0,
                0,
                0,
                0,
                1,
                0,
                0,
                0,
                0,
                1,
                0,
                doubled,
                0,
                0,
                1,
              )
            : input.axis === "y"
              ? mat4FromValues(
                  1,
                  0,
                  0,
                  0,
                  0,
                  -1,
                  0,
                  0,
                  0,
                  0,
                  1,
                  0,
                  0,
                  doubled,
                  0,
                  1,
                )
              : mat4FromValues(
                  1,
                  0,
                  0,
                  0,
                  0,
                  1,
                  0,
                  0,
                  0,
                  0,
                  -1,
                  0,
                  0,
                  0,
                  doubled,
                  1,
                );
        return ok(wrapSolid(transformGeom3(matrix, geometry.value)));
      });
    },

    bounds(solid: KernelSolid): KernelResult<KernelBounds> {
      const geometry = geometryOf(solid, "bounds");
      if (!geometry.ok) return fail(geometry.error);
      if (isEmpty(geometry.value)) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.boundsEmpty,
            "bounds rejected an empty solid: an empty set has no bounding box.",
          ),
        );
      }
      const [min, max] = measureBoundingBox(geometry.value);
      return ok({
        min: [min[0], min[1], min[2]],
        max: [max[0], max[1], max[2]],
      });
    },

    volume(solid: KernelSolid): KernelResult<number> {
      const geometry = geometryOf(solid, "volume");
      if (!geometry.ok) return fail(geometry.error);
      if (isEmpty(geometry.value)) return ok(0);
      return ok(measureVolume(geometry.value));
    },

    area(solid: KernelSolid): KernelResult<number> {
      const geometry = geometryOf(solid, "area");
      if (!geometry.ok) return fail(geometry.error);
      if (isEmpty(geometry.value)) return ok(0);
      return ok(measureArea(geometry.value));
    },

    tessellate(solid: KernelSolid): KernelResult<Tessellation> {
      const geometry = geometryOf(solid, "tessellate");
      if (!geometry.ok) return fail(geometry.error);
      if (isEmpty(geometry.value)) return ok({ positions: [], indices: [] });
      return ok(tessellateGeometry(geometry.value));
    },

    dispose(solid: KernelSolid): void {
      const payload = tag.unwrap(solid);
      if (payload === undefined || payload.geometry === null) return;
      // Pure-JS payloads are garbage-collected; dropping the reference IS
      // the release, and the null read keeps dispose observable as
      // kernel/solid-not-owned, matching the contract's uniform discipline.
      payload.geometry = null;
    },
  };
}
