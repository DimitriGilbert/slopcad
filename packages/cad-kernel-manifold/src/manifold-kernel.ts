/**
 * The Manifold geometry-kernel adapter (Phase 9): a full implementation of
 * the Phase 8 kernel contract on top of the `manifold-3d` WASM engine.
 *
 * ## Isolation
 *
 * Every Manifold type stays inside this module. The public surface hands
 * out and accepts only kernel-neutral {@link KernelSolid} handles: the
 * WASM `Manifold` objects live in a per-instance store behind
 * {@link createSolidTag}, so no Manifold shape, class, or type ever
 * crosses the package boundary. The initialized engine arrives as an
 * opaque {@link ManifoldRuntime} (see `./manifold-runtime`), never as a
 * raw Manifold toplevel.
 *
 * ## Placement conventions
 *
 * The contract grounds primitives with a corner/z=0 footing; Manifold's
 * constructors are mapped onto it with their own placement flags and
 * transforms — never by re-centering at call sites:
 *
 * - box: `cube([w, d, h], center = false)` already spans `[0,w] × [0,d] ×
 *   [0,h]` (first octant, touching the origin).
 * - sphere: `sphere(r)` is centred on the origin, exactly as contracted.
 * - cylinder: `cylinder(h, r, r, center = false)` rests on `z = 0` and
 *   spans `z ∈ [0, h]` on the +z axis.
 * - cone/frustum: `cylinder(h, rBottom, rTop, center = false)` interpolates
 *   the radius linearly from `z = 0` to `z = h`; `rTop = 0` is the sharp
 *   cone.
 * - `transform` (translation only, per the contract) maps to Manifold's
 *   own `translate`.
 *
 * ## Empty solids
 *
 * Manifold represents failed/degenerate geometry as *empty* manifolds
 * (`isEmpty()`): disjoint intersections, total subtractions, and even
 * invalid constructor input that slipped past validation (verified: the
 * engine returns empty results rather than throwing for degenerate
 * numbers). The adapter maps emptiness onto the contract's empty-solid
 * semantics exactly: `volume` → 0, `tessellate` → empty soup, `bounds` →
 * `kernel/bounds-empty`.
 *
 * ## Error normalization
 *
 * Every mutating operation runs entirely inside a no-throw boundary mapped
 * to the contract failure code its inputs describe — primitive constructors
 * and `transform` (lengths → `kernel/invalid-length`), booleans (operand
 * lists → `kernel/invalid-operands`). Validators return structured
 * failures directly, while thrown exceptions — cad-core's `valueIn`
 * rejecting non-finite magnitudes that only dynamically-parsed values can
 * carry, or a throw out of Manifold's WASM bindings — are normalized into
 * the same structured failures, so raw exceptions never escape. The
 * Manifold engine itself returns empty manifolds instead of throwing for
 * degenerate numeric input (verified), which the empty-solid mapping
 * below absorbs. Measurement operations (`volume`, `bounds`,
 * `tessellate`) take no free-form input and run only on owned, live,
 * non-empty payloads — the empirically verified non-throwing domain of
 * the engine — so no mis-coded catch-all is needed there.
 *
 * ## WASM memory hygiene
 *
 * Manifold objects are not garbage-collected: every handle's payload is
 * freed in `dispose` (which then reads as `kernel/solid-not-owned`,
 * matching how ownership already rejects foreign and forged handles).
 * Manifold's booleans and transforms are lazy, but its C++ side is
 * reference-counted, so lazily-evaluated results stay correct even after
 * operand handles are disposed. `tessellate` copies every value out of the
 * WASM heap into plain arrays before deleting its temporary
 * normals-bearing manifold, so returned buffers never alias WASM memory.
 *
 * ## Normals
 *
 * `tessellate` asks Manifold to compute crease-aware vertex normals
 * (`calculateNormals` with a 30° minimum sharp angle, the threshold the
 * Phase 1.6 spike proved: planar faces keep one exact normal, edges
 * sharper than 30° split their normals, curved walls shade smooth) and
 * returns them through the contract's optional `normals` payload —
 * Manifold writes the unit normals into mesh property channels 3–5, which
 * are sliced out next to the positions.
 */

import type { Manifold } from "manifold-3d";
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
  type TranslationInput,
} from "@slopcad/cad-kernel";
import { createSolidTag } from "@slopcad/cad-kernel";

import { MANIFOLD_BACKEND_ID } from "./manifold-backend";
import {
  createManifoldRuntime,
  RUNTIME_BRAND,
  type ManifoldRuntime,
} from "./manifold-runtime";

/**
 * Capabilities of the Manifold kernel, honestly declared:
 *
 * - Booleans are Manifold's core competence (`booleans`).
 * - Only translation is exposed because the Phase 8 contract carries only
 *   translation; Manifold can rotate/scale, but the flags stay `false`
 *   until the contract extends to accept those inputs.
 * - Volumes are computed by the engine from the exact boundary mesh
 *   representation (divergence theorem), exact up to floating point, for
 *   primitives and boolean results alike — unlike the fake kernel's voxel
 *   quadrature, no estimation band is needed.
 * - Bounds of boolean results are the tight axis-aligned boxes of the true
 *   result meshes.
 * - Topology is rebuilt by every boolean; persistent face/edge identities
 *   arrive with a later BREP kernel, not Manifold.
 */
export const MANIFOLD_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: false,
  transformScale: false,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: true,
  tightBooleanBounds: true,
  persistentTopology: false,
});

/**
 * Minimum edge angle (degrees) at which `tessellate` splits vertex normals:
 * edges sharper than this keep distinct normals on each side (crisp
 * creases), shallower edges share smoothed normals (smooth curved walls).
 * 30° is the threshold the Phase 1.6 spike validated for CAD-style
 * box-plus-bore geometry.
 */
export const MANIFOLD_NORMALS_MIN_SHARP_ANGLE_DEGREES = 30;

/**
 * The per-handle payload: the WASM manifold, or `null` once the handle was
 * disposed (subsequent operations read as `kernel/solid-not-owned`, the
 * same code that guards foreign handles).
 */
interface SolidPayload {
  manifold: Manifold | null;
}

function kernelError(code: KernelErrorCode, message: string): KernelError {
  return { code, message, input: null };
}

/** Reads a value from a Manifold mesh flat array; in-range by construction. */
function flatAt(
  values: Float32Array | Uint32Array,
  index: number,
  what: string,
): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(
      `Invariant violation: Manifold mesh ${what} at flat index ${index} is missing.`,
    );
  }
  return value;
}

/**
 * Creates a Manifold kernel bound to an initialized runtime. Handles are
 * owned per instance; create one per evaluation context. Use
 * {@link createManifoldKernel} for the async one-call form.
 */
export function manifoldKernelFromRuntime(
  runtime: ManifoldRuntime,
): GeometryKernel {
  const { Manifold: manifoldCtor } = runtime[RUNTIME_BRAND];
  const tag = createSolidTag<SolidPayload>();

  const wrapSolid = (manifold: Manifold): KernelSolid =>
    tag.wrap({ manifold });

  const manifoldOf = (
    solid: KernelSolid,
    operation: string,
  ): KernelResult<Manifold> => {
    const payload = tag.unwrap(solid);
    if (payload === undefined || payload.manifold === null) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.solidNotOwned,
          `${operation} rejected a solid handle that this kernel instance did not create (or has already disposed).`,
        ),
      );
    }
    return ok(payload.manifold);
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

  const operandsOf = (
    solids: readonly KernelSolid[],
    minimum: number,
    operation: string,
  ): KernelResult<readonly Manifold[]> => {
    if (solids.length < minimum) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          `${operation} rejected ${solids.length} operand(s): at least ${minimum} are required.`,
        ),
      );
    }
    const manifolds: Manifold[] = [];
    for (const solid of solids) {
      const manifold = manifoldOf(solid, operation);
      if (!manifold.ok) return fail(manifold.error);
      manifolds.push(manifold.value);
    }
    return ok(manifolds);
  };

  /**
   * Runs one whole kernel operation inside the no-throw boundary: value
   * failures returned by validators pass through, and any thrown exception
   * — cad-core's `valueIn` rejecting non-finite magnitudes, or an engine
   * throw inside Manifold's WASM bindings — is normalized into the
   * structured failure the operation's inputs map to. Raw exceptions never
   * escape a kernel operation.
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
          `${operation} failed inside the Manifold kernel boundary: ${detail}`,
        ),
      );
    }
  };

  const tessellateManifold = (manifold: Manifold): Tessellation => {
    // Kernel-computed normals: Manifold writes unit normals into property
    // channels 3-5 (numProp >= 6); everything is copied out of the WASM
    // heap before the temporary normals-bearing manifold is deleted.
    const withNormals = manifold.calculateNormals(
      0,
      MANIFOLD_NORMALS_MIN_SHARP_ANGLE_DEGREES,
    );
    const mesh = withNormals.getMesh();
    const numProp = mesh.numProp;
    const vertexCount = mesh.numVert;
    const positions: number[] = new Array<number>(vertexCount * 3);
    const normals: number[] | undefined =
      numProp >= 6 ? new Array<number>(vertexCount * 3) : undefined;
    for (let v = 0; v < vertexCount; v += 1) {
      const base = v * numProp;
      positions[v * 3] = flatAt(mesh.vertProperties, base, "position x");
      positions[v * 3 + 1] = flatAt(mesh.vertProperties, base + 1, "position y");
      positions[v * 3 + 2] = flatAt(mesh.vertProperties, base + 2, "position z");
      if (normals !== undefined) {
        normals[v * 3] = flatAt(mesh.vertProperties, base + 3, "normal x");
        normals[v * 3 + 1] = flatAt(mesh.vertProperties, base + 4, "normal y");
        normals[v * 3 + 2] = flatAt(mesh.vertProperties, base + 5, "normal z");
      }
    }
    const triangleCount = mesh.numTri;
    const indices: number[] = new Array<number>(triangleCount * 3);
    for (let i = 0; i < triangleCount * 3; i += 1) {
      indices[i] = flatAt(mesh.triVerts, i, "triangle index");
    }
    withNormals.delete();
    return normals === undefined
      ? { positions, indices }
      : { positions, indices, normals };
  };

  return {
    id: MANIFOLD_BACKEND_ID,
    capabilities: MANIFOLD_KERNEL_CAPABILITIES,

    createBox(input: BoxInput): KernelResult<KernelSolid> {
      return run("createBox", KERNEL_ERROR_CODES.invalidLength, () => {
        const width = positiveLength(input.width, "width", "createBox");
        if (!width.ok) return fail(width.error);
        const depth = positiveLength(input.depth, "depth", "createBox");
        if (!depth.ok) return fail(depth.error);
        const height = positiveLength(input.height, "height", "createBox");
        if (!height.ok) return fail(height.error);
        return ok(
          wrapSolid(
            manifoldCtor.cube([width.value, depth.value, height.value], false),
          ),
        );
      });
    },

    createSphere(input: SphereInput): KernelResult<KernelSolid> {
      return run("createSphere", KERNEL_ERROR_CODES.invalidLength, () => {
        const radius = positiveLength(input.radius, "radius", "createSphere");
        if (!radius.ok) return fail(radius.error);
        return ok(wrapSolid(manifoldCtor.sphere(radius.value)));
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
            manifoldCtor.cylinder(
              height.value,
              radius.value,
              radius.value,
              undefined,
              false,
            ),
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
            manifoldCtor.cylinder(
              height.value,
              bottomRadius.value,
              topRadius.value,
              undefined,
              false,
            ),
          ),
        );
      });
    },

    union(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      return run("union", KERNEL_ERROR_CODES.invalidOperands, () => {
        const manifolds = operandsOf(operands, 2, "union");
        if (!manifolds.ok) return fail(manifolds.error);
        return ok(wrapSolid(manifoldCtor.union(manifolds.value)));
      });
    },

    subtract(
      target: KernelSolid,
      tools: readonly KernelSolid[],
    ): KernelResult<KernelSolid> {
      return run("subtract", KERNEL_ERROR_CODES.invalidOperands, () => {
        const targetManifold = manifoldOf(target, "subtract");
        if (!targetManifold.ok) return fail(targetManifold.error);
        const toolManifolds = operandsOf(tools, 1, "subtract");
        if (!toolManifolds.ok) return fail(toolManifolds.error);
        return ok(
          wrapSolid(
            manifoldCtor.difference([
              targetManifold.value,
              ...toolManifolds.value,
            ]),
          ),
        );
      });
    },

    intersect(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      return run("intersect", KERNEL_ERROR_CODES.invalidOperands, () => {
        const manifolds = operandsOf(operands, 2, "intersect");
        if (!manifolds.ok) return fail(manifolds.error);
        return ok(wrapSolid(manifoldCtor.intersection(manifolds.value)));
      });
    },

    transform(
      solid: KernelSolid,
      translation: TranslationInput,
    ): KernelResult<KernelSolid> {
      return run("transform", KERNEL_ERROR_CODES.invalidLength, () => {
        const manifold = manifoldOf(solid, "transform");
        if (!manifold.ok) return fail(manifold.error);
        // valueIn rejects non-finite magnitudes (normalized above); every
        // finite length, of any sign, is a legal translation component.
        const x = valueIn(translation.x, "mm");
        const y = valueIn(translation.y, "mm");
        const z = valueIn(translation.z, "mm");
        return ok(wrapSolid(manifold.value.translate(x, y, z)));
      });
    },

    bounds(solid: KernelSolid): KernelResult<KernelBounds> {
      const manifold = manifoldOf(solid, "bounds");
      if (!manifold.ok) return fail(manifold.error);
      if (manifold.value.isEmpty()) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.boundsEmpty,
            "bounds rejected an empty solid: an empty set has no bounding box.",
          ),
        );
      }
      const box = manifold.value.boundingBox();
      return ok({
        min: [box.min[0], box.min[1], box.min[2]],
        max: [box.max[0], box.max[1], box.max[2]],
      });
    },

    volume(solid: KernelSolid): KernelResult<number> {
      const manifold = manifoldOf(solid, "volume");
      if (!manifold.ok) return fail(manifold.error);
      if (manifold.value.isEmpty()) return ok(0);
      return ok(manifold.value.volume());
    },

    tessellate(solid: KernelSolid): KernelResult<Tessellation> {
      const manifold = manifoldOf(solid, "tessellate");
      if (!manifold.ok) return fail(manifold.error);
      if (manifold.value.isEmpty()) return ok({ positions: [], indices: [] });
      return ok(tessellateManifold(manifold.value));
    },

    dispose(solid: KernelSolid): void {
      const payload = tag.unwrap(solid);
      if (payload === undefined || payload.manifold === null) return;
      payload.manifold.delete();
      payload.manifold = null;
    },
  };
}

/**
 * Creates a fresh Manifold kernel, initializing (or reusing) the shared
 * WASM runtime first. The canonical entry for callers without a
 * pre-initialized runtime; tests that create many kernels should
 * pre-initialize via `createManifoldRuntime()` and close over
 * {@link manifoldKernelFromRuntime} instead.
 */
export async function createManifoldKernel(): Promise<GeometryKernel> {
  const runtime = await createManifoldRuntime();
  return manifoldKernelFromRuntime(runtime);
}
