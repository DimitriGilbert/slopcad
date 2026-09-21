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
 *   own `translate`; `mirror` (Phase 26.9) maps to the engine's affine
 *   `transform` with the reflection matrix (−1 on the plane axis's
 *   diagonal, 2·offset translation) — the engine accepts the negative
 *   determinant and re-winds its triangles itself (probed), so the adapter
 *   does no mesh surgery.
 * - `extrude` (Phase 26.1): the profile loop is tessellated into a chord
 *   polygon at the shared mesh-kernel deflection (cad-kernel's
 *   PROFILE_MAX_SEGMENT_ANGLE_RAD, 0.1 rad ≈ 5.7° per chord — a
 *   straight-polygon profile is EXACT; a curved segment's chord
 *   fan undercuts the analytic area by the measured ≈0.166% (see
 *   PROFILE_MAX_SEGMENT_ANGLE_RAD's n=63 derivation), the documented
 *   deviation from OCCT's exact prism), wound CCW (the same winding-
 *   independence every profile op applies — Manifold's Positive fill rule
 *   treats a CW outer contour as unfilled, so an authored-CW loop is
 *   normalized before the engine sees it), fed to `Manifold.extrude` (z ∈
 *   [0,h], or translated to [−h,0] for the negative direction), and placed
 *   by one `Mat4.transform` composing the axis-angle rotation (Rodrigues,
 *   column-major 4×4) with the translation. Self-intersection is NOT
 *   detected here: `Manifold.extrude` accepts a crossing contour and
 *   yields an undefined solid without throwing (probed), so the honesty
 *   lives upstream — cad-sketch's profile resolution rejects line×line,
 *   line×arc, AND arc×arc crossings (structured
 *   `sketch/profile-self-intersecting`) before any kernel sees the loop;
 *   this adapter's own checks are closure, non-degeneracy, and a
 *   zero-area floor only.
 * - `revolve` (Phase 26.2): the loop is tessellated in the axis frame at
 *   the shared deflection, mirrored to the non-negative radial side (the
 *   axis-crossing rejection guarantees one-sidedness; a mirrored profile
 *   sweeps the identical solid), wound CCW in (radial, axial), and fed to
 *   `Manifold.revolve` with 63 pinned circular segments — the engine
 *   revolves about +z with the profile starting at +x sweeping CCW
 *   (probed), and one composed placement (`revolutionMeshTransform`)
 *   rebases that onto the contract's axis frame before the placement
 *   rotation/translation apply. Fidelity: the measured full-turn volume
 *   deficit is the documented ≈0.166% inscribed-chord band (same basis as
 *   `extrude`). Axis crossing is rejected BEFORE the engine because
 *   `Manifold.revolve` silently keeps only the positive-radial part of a
 *   crossing contour (probed, and stated in its own API docs).
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
  type ProfileExtrudeInput,
  type ProfileLoftInput,
  type ProfileRevolveInput,
  type HelixSweepInput,
  type ProfileSweepInput,
  type ShellInput,
  type SphereInput,
  type Tessellation,
  type TranslationInput,
} from "@slopcad/cad-kernel";
import {
  axisAngleMatrix,
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
  tessellateProfileLoop,
  tessellateRevolveProfile,
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
 * - The Phase 26.3 sweep is NOT implemented (`sweep: false`): the engine
 *   has no sweep or loft primitive (probed — its constructors are
 *   extrude/revolve/hull/levelSet over CrossSections, nothing that carries
 *   a profile along a path), and hand-rolling a tube mesh in the adapter
 *   would be adapter-side meshing, not a kernel operation. Every `sweep`
 *   call answers the structured `kernel/unsupported-operation` — the
 *   honest answer, never a bad approximation.
 * - The Phase 26.4 loft is NOT implemented either (`loft: false`), by the
 *   same probe: the engine has no multi-section loft constructor
 *   (extrude's twistDegrees/scaleTop cover only single-polygon
 *   two-station specials), and every `loft` call answers the structured
 *   `kernel/unsupported-operation` — the sweep convention, applied again.
 * - The Phase 40 helical sweep is NOT implemented (`helix: false`), the
 *   sweep verdict on the analytic spine: the engine has no helix
 *   constructor at all, so every `helixSweep` call answers the structured
 *   `kernel/unsupported-operation`.
 * - The Phase 26.5 fillet is NOT implemented (`fillet: false`): the engine
 *   has no fillet operation (probed — `smoothOut` interpolates shading
 *   tangents across existing triangles, geometry unchanged until refine,
 *   and its own doc calls the effect "a small fillet" only by metaphor;
 *   there is no edge selection and no exact fillet surface anywhere in the
 *   API). Every `fillet` call answers the structured
 *   `kernel/unsupported-operation` — the sweep/loft convention, applied a
 *   third time.
 * - The Phase 26.6 chamfer is NOT implemented (`chamfer: false`), the
 *   fillet's verdict verbatim: the engine has no chamfer operation either
 *   (the same probe — no edge selection and no bevel surface anywhere in
 *   the API), so every `chamfer` call answers the structured
 *   `kernel/unsupported-operation`.
 * - The Phase 26.7 shell is NOT implemented (`shell: false`): the engine
 *   has no hollowing operation (probed — `offset` exists only on the 2D
 *   CrossSection, and the 3D Manifold surface carries no offset, shell,
 *   or face selection at all), so every `shell` call answers the structured
 *   `kernel/unsupported-operation`.
 * - The Phase 26.9 mirror IS implemented (`mirror: true`) — the one new
 *   Phase 26 operation the engine itself carries: its affine `transform`
 *   accepts negative-determinant matrices and internally re-winds the
 *   triangles (probed: the reflected box measures its exact positive
 *   volume, the raw soup's signed volume stays positive, crease-aware
 *   normals point outward), so the adapter passes the reflection matrix
 *   straight through, no mesh surgery.
 * - The Phase 27.4 surface-area measurement IS implemented
 *   (`surfaceArea: true`): the engine's own `Manifold.surfaceArea()`
 *   property — exact over the exact boundary mesh representation, the same
 *   semantics class as its divergence-theorem volumes (probed: the
 *   30×20×10 box measures exactly 2200 mm², and the plate-with-bore — its
 *   r = 4 bore is the engine's 28-chord default — measures 2351.111 mm²,
 *   +0.0134% over the analytic 2 200 + 48π mm², inside the same
 *   inscribed-polygon band its volume documents; an empty manifold
 *   measures 0).
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
  sweep: false,
  helix: false,
  loft: false,
  fillet: false,
  chamfer: false,
  shell: false,
  mirror: true,
  surfaceArea: true,
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
 * Circular segments `revolve` pins for a full turn: the shared mesh-kernel
 * deflection ceiling (2π / {@link PROFILE_MAX_SEGMENT_ANGLE_RAD} = 63
 * chords, Δ ≈ 0.0997 rad) — passed explicitly per call so the engine's
 * global segment settings are never mutated and the documented deviation
 * band stays pinned. Measured on the probe fixture (radius-25,
 * height-30 axis-touching rectangle): a 0.1657% volume deficit for the
 * full turn, the same inscribed-chord band the extrude path documents.
 */
export const MANIFOLD_REVOLVE_CIRCULAR_SEGMENTS = Math.ceil(
  (Math.PI * 2) / PROFILE_MAX_SEGMENT_ANGLE_RAD,
);

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

  const wrapSolid = (manifold: Manifold): KernelSolid => tag.wrap({ manifold });

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
      positions[v * 3 + 1] = flatAt(
        mesh.vertProperties,
        base + 1,
        "position y",
      );
      positions[v * 3 + 2] = flatAt(
        mesh.vertProperties,
        base + 2,
        "position z",
      );
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

    extrude(input: ProfileExtrudeInput): KernelResult<KernelSolid> {
      return run("extrude", KERNEL_ERROR_CODES.invalidProfile, () => {
        const height = positiveLength(input.height, "height", "extrude");
        if (!height.ok) return fail(height.error);
        // Placement validation before any WASM work: a finite rotation
        // angle, a non-zero finite rotation axis, finite translation.
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
        const translation: [number, number, number] = [
          valueIn(input.placement.translation.x, "mm"),
          valueIn(input.placement.translation.y, "mm"),
          valueIn(input.placement.translation.z, "mm"),
        ];
        if (!translation.every((component) => Number.isFinite(component))) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidLength,
              "extrude rejected the placement translation: components must be finite lengths.",
            ),
          );
        }
        // Profile shape checks: closure and non-degeneracy at the
        // documented probe scope. This adapter does NOT detect
        // self-intersection (Manifold accepts a crossing contour and
        // yields an undefined solid, probed) — that rejection lives
        // upstream in cad-sketch's profile resolution (line×line,
        // line×arc, arc×arc); the floor below catches only the
        // zero-area degeneracy.
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
        if (
          polygon.length < 3 ||
          !(Math.abs(polygonSignedArea(polygon)) > 1e-9)
        ) {
          return fail(
            kernelError(
              KERNEL_ERROR_CODES.invalidProfile,
              "extrude rejected the profile loop: it is degenerate (fewer than three distinct vertices, zero area, or an unclosed boundary).",
            ),
          );
        }
        // Winding: normalize CCW (the same convention every profile op
        // applies) — Manifold.extrude wraps raw polygons in its Positive
        // fill rule, which treats a CW outer contour as unfilled and would
        // silently yield an EMPTY solid for a legally clockwise-authored
        // loop (probed: CW square → isEmpty, volume 0).
        const ordered =
          polygonSignedArea(polygon) > 0 ? polygon : [...polygon].reverse();
        const contour = ordered.map(
          (point: ProfilePoint2) => [point.x, point.y] as [number, number],
        );
        // Manifold.extrude spans z ∈ [0, height]; the negative direction
        // shifts the finished prism to [−height, 0] before placement.
        const prism = manifoldCtor.extrude([contour], height.value);
        const oriented =
          input.direction === -1 ? prism.translate(0, 0, -height.value) : prism;
        if (input.direction === -1) prism.delete();
        // Placement: one column-major 4×4 affine (rotation, then
        // translation — the contract's composition order).
        const r = axisAngleMatrix(axis, angle);
        const mat4 = [
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
          translation[0],
          translation[1],
          translation[2],
          1,
        ] as const;
        return ok(wrapSolid(oriented.transform(mat4 as never)));
      });
    },

    revolve(input: ProfileRevolveInput): KernelResult<KernelSolid> {
      return run("revolve", KERNEL_ERROR_CODES.invalidProfile, () => {
        // The shared 26.2 validation battery, before any WASM work: the
        // sweep-angle domain, the axis direction, the placement, the
        // structural profile soundness, and the axis-crossing rejection.
        // The crossing rejection is LOAD-BEARING for Manifold specifically:
        // `Manifold.revolve` silently keeps only the positive-radial part
        // of a crossing contour (probed, and documented in its own API) —
        // an undefined solid with no diagnostic. The shared validator runs
        // first so the engine never sees a crossing profile.
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
        // radial) at the shared deflection, then mirrored to the
        // non-negative radial side the engine revolves: the crossing
        // rejection guarantees the profile is one-sided, and a mirrored
        // profile sweeps the identical solid of revolution.
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
        // π-rotated −v-side placement here — 180° from the contract's
        // sweep-start semantics.
        const positiveSide =
          Math.min(...axisPolygon.map((point) => point.y)) >=
          -REVOLVE_AXIS_TOUCH_TOLERANCE_MM;
        // Winding: CCW in the (radial, axial) plane keeps the engine's
        // orientation convention (the mirroring above can flip it).
        const mirrored = axisPolygon.map((point) => ({
          x: Math.abs(point.y),
          y: point.x,
        }));
        const ordered =
          polygonSignedArea(mirrored) > 0 ? mirrored : [...mirrored].reverse();
        const contour = ordered.map(
          (point) => [point.x, point.y] as [number, number],
        );
        // Manifold.revolve spins the contour about the +z axis with the
        // profile starting at +x and sweeping counter-clockwise (probed);
        // 63 circular segments pins the shared mesh-kernel deflection
        // (2π/63 ≈ 0.0997 rad per chord) without touching the engine's
        // global segment settings. The composed placement maps the engine
        // frame onto the contract's axis frame, then applies the contract
        // placement (see revolutionMeshTransform).
        const revolved = manifoldCtor.revolve(
          [contour],
          MANIFOLD_REVOLVE_CIRCULAR_SEGMENTS,
          (sweep * 180) / Math.PI,
        );
        const placement = revolutionMeshTransform(
          frame,
          positiveSide,
          axisAngleMatrix(axis, angle),
          translation,
        );
        const r = placement.rotation;
        const t = placement.translation;
        const mat4 = [
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
        ] as const;
        return ok(wrapSolid(revolved.transform(mat4 as never)));
      });
    },

    union(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      return run("union", KERNEL_ERROR_CODES.invalidOperands, () => {
        const manifolds = operandsOf(operands, 2, "union");
        if (!manifolds.ok) return fail(manifolds.error);
        return ok(wrapSolid(manifoldCtor.union(manifolds.value)));
      });
    },

    sweep(input: ProfileSweepInput): KernelResult<KernelSolid> {
      // The declared-capability answer, structured: the Manifold engine has
      // no sweep or loft primitive (probed), so the input — valid or not —
      // cannot be executed honestly here. Never a silent approximation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "sweep is unsupported by the Manifold kernel: the engine has no sweep or loft primitive (its profile constructors are extrude and revolve only, probed), and the adapter does not hand-roll tube meshes in their place.",
        ),
      );
    },

    helixSweep(input: HelixSweepInput): KernelResult<KernelSolid> {
      // The sweep convention, applied to the analytic spine (Phase 40):
      // the Manifold engine has no helical sweep primitive (probed — its
      // constructors are extrude and revolve only), and hand-rolling a
      // station mesh would be adapter-side meshing, not a kernel
      // operation. Never a silent approximation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "helixSweep is unsupported by the Manifold kernel: the engine has no helical sweep primitive, and the adapter does not hand-roll station meshes in its place.",
        ),
      );
    },

    loft(input: ProfileLoftInput): KernelResult<KernelSolid> {
      // The sweep convention's twin (Phase 26.4): the engine has no loft
      // primitive (probed — its constructors are extrude/revolve/hull/
      // levelSet, and extrude's twistDegrees/scaleTop options cover only
      // single-polygon two-station specials, not a section collection), so
      // every `loft` call — valid input or not — answers with the
      // structured unsupported code. Hand-rolling walls between station
      // polygons would be adapter-side meshing, not a kernel operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "loft is unsupported by the Manifold kernel: the engine has no loft primitive (its profile constructors are extrude, revolve, hull, and levelSet — extrude's twist/scale options cover only single-polygon two-station specials — probed), and the adapter does not hand-roll section meshes in their place.",
        ),
      );
    },

    fillet(input: FilletInput): KernelResult<KernelSolid> {
      // The sweep/loft convention's third application (Phase 26.5): the
      // engine has no fillet primitive (probed — `smoothOut` interpolates
      // shading tangents across the existing triangles, geometry unchanged
      // until refine; its own documentation's "small fillet" is a metaphor
      // for that smoothing, not a rounding operation), so every `fillet`
      // call — valid input or not — answers with the structured unsupported
      // code. An expansions-based corner approximation would be adapter-side
      // meshing that misses the exact-volume fixtures, not a kernel
      // operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "fillet is unsupported by the Manifold kernel: the engine has no fillet operation (its smoothing is shading tangent interpolation over unchanged geometry — probed), and the adapter does not approximate corner rounding with mesh offsets in its place.",
        ),
      );
    },

    chamfer(input: ChamferInput): KernelResult<KernelSolid> {
      // The fillet verdict, verbatim (Phase 26.6): the engine has no
      // chamfer primitive either (the same probe — no edge selection and
      // no bevel surface anywhere in the API), so every `chamfer` call —
      // valid input or not — answers with the structured unsupported code.
      // A hand-cut corner mesh would be adapter-side meshing, not a kernel
      // operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "chamfer is unsupported by the Manifold kernel: the engine has no chamfer operation (the fillet verdict verbatim — no edge selection, no bevel surface — probed), and the adapter does not approximate corner cutting with mesh edits in its place.",
        ),
      );
    },

    shell(input: ShellInput): KernelResult<KernelSolid> {
      // The convention's FACE-addressed application (Phase 26.7): the
      // engine has no hollowing operation (probed — `offset` exists only
      // on the 2D CrossSection, and the 3D Manifold surface carries no
      // offset, shell, or face selection at all), so every `shell` call —
      // valid input or not — answers with the structured unsupported code.
      // Building walls by insetting an extrusion of the picked faces would
      // be adapter-side meshing, not a kernel operation.
      void input;
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.unsupportedOperation,
          "shell is unsupported by the Manifold kernel: the engine has no hollowing operation (offset exists only on its 2D CrossSection, and the 3D surface has no shell or face selection — probed), and the adapter does not approximate wall building with mesh edits in its place.",
        ),
      );
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

    mirror(solid: KernelSolid, input: MirrorInput): KernelResult<KernelSolid> {
      return run("mirror", KERNEL_ERROR_CODES.invalidLength, () => {
        const manifold = manifoldOf(solid, "mirror");
        if (!manifold.ok) return fail(manifold.error);
        // Every finite offset is a legal plane position (zero and negative
        // offsets included); valueIn's non-finite rejection normalizes into
        // the shared invalid-length failure above.
        const offset = valueIn(input.offset, "mm");
        // Column-major reflection matrix: −1 on the axis's diagonal, the
        // axis translation 2·offset (c → 2·offset − c). The engine accepts
        // the negative determinant and re-winds its triangles itself
        // (probed) — the adapter does no mesh surgery.
        const doubled = 2 * offset;
        const mat4 =
          input.axis === "x"
            ? [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, doubled, 0, 0, 1]
            : input.axis === "y"
              ? [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, doubled, 0, 1]
              : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, doubled, 1];
        return ok(wrapSolid(manifold.value.transform(mat4 as never)));
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

    area(solid: KernelSolid): KernelResult<number> {
      const manifold = manifoldOf(solid, "area");
      if (!manifold.ok) return fail(manifold.error);
      if (manifold.value.isEmpty()) return ok(0);
      return ok(manifold.value.surfaceArea());
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
