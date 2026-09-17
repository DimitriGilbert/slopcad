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

import { JSCAD_BACKEND_ID } from "./jscad-backend";

/**
 * The `Geom3` polygon-set type of `@jscad/modeling`, reached through the
 * library's own namespace exports (the type-only twin of the value import
 * above) and sealed inside this module.
 */
type JscadGeom3 = ModelingTypes.geometries.geom3.Geom3;

/** The library namespaces the adapter uses, destructured once. */
const { booleans, geometries, measurements, maths, primitives, transforms } =
  modeling;
const { union: jscadUnion, subtract: jscadSubtract, intersect: jscadIntersect } =
  booleans;
const { cuboid, cylinder, cylinderElliptic, sphere } = primitives;
const { translate } = transforms;
const { measureBoundingBox, measureVolume } = measurements;
const { toPolygons, transform: transformGeom3 } = geometries.geom3;
const { create: mat4Create, fromRotation } = maths.mat4;

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
 */
export const JSCAD_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: true,
  transformScale: false,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: false,
  tightBooleanBounds: true,
  persistentTopology: false,
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
        indices.push(positions.length / 3, positions.length / 3 + 1, positions.length / 3 + 2);
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
          const matrix = fromRotation(
            mat4Create(),
            angleRad,
            [axis.value[0], axis.value[1], axis.value[2]],
          );
          // Rotation first: about the world-origin axis (probed exact on
          // the quarter-turned box), then the world-space translation.
          placed = transformGeom3(matrix, placed);
        }
        return ok(wrapSolid(translate([x, y, z], placed)));
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
