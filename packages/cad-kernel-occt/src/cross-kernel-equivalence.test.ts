/**
 * The cross-kernel semantic-equivalence suite (Phase 21's phase-level
 * criterion: "Supported models produce equivalent semantic results within
 * documented differences"): THE same scenes are built on ALL THREE real
 * kernels — Manifold (mesh), OpenCascade (BREP), and JSCAD (BSP polygon
 * sets, Phase 23) — and compared semantically, never by buffer equality.
 *
 * It lives in the OCCT package with the other kernels' adapters available
 * as devDependencies (the cross-kernel regression seed; each adapter keeps
 * its own runtime types sealed, and scenes build through the kernel-neutral
 * fixtures the kernel packages already exercise, so no kernel-specific type
 * crosses this file).
 *
 * ## Comparison policy (mirrors the contract suite's capability honesty)
 *
 * 1. MUST AGREE EXACTLY (the contract suite's EXACT bands: 1e-9 relative
 *    volume, 1e-9 mm bounds): planar geometry — primitive box volumes,
 *    translated bounds, and boolean BOUNDS. All three kernels declare
 *    `exactPrimitiveVolumes` and `tightBooleanBounds`, and all are exact
 *    w.r.t. the SAME true planar geometry: OCCT integrates exact BREPs,
 *    Manifold's divergence-theorem volume runs over an exactly-planar
 *    boundary mesh, and JSCAD's signed-polygon sums run over exactly-planar
 *    BSP output. Measured here: disjoint-box union cross-agrees to 3.4e-16
 *    relative; translated bounds to 0; three-way plate and chain bounds to
 *    0.
 * 2. AGREES WITHIN DOCUMENTED BANDS (`CURVED_VOLUME_TOLERANCE`, 5%): curved
 *    and boolean VOLUMES. `exactBooleanVolumes` differs across the three
 *    — OCCT and Manifold declare `true` (exact w.r.t. their own exact and
 *    mesh representations), JSCAD declares `false` (its BSP output is a
 *    float-precision approximation of the true cut boundary) — so JSCAD
 *    joins the banded tier: its boolean measures are judged against the
 *    analytic truth AND against the exact kernels inside the curved band.
 *    Measured on the plate: OCCT 0 rel err vs analytic (its headline
 *    exactness result), Manifold +0.077%, JSCAD +0.059%; JSCAD vs OCCT
 *    0.059%, JSCAD vs Manifold 0.018%. Chain worst: JSCAD trimmed +0.253%
 *    vs analytic, +0.390% vs Manifold. Volumes derived from each kernel's
 *    tessellation carry their own bands: Manifold's and JSCAD's soups ARE
 *    their representations (float noise — measured 2.6e-9 and 5.0e-16),
 *    OCCT's is a 0.1 mm-deflection discretization of its exact BREP
 *    (measured +0.089%).
 * 3. LEGITIMATELY DIFFERS: tessellation structure and Manifold's transform
 *    reach. Triangle counts, vertex layout, and normals provenance are
 *    per-kernel choices — 120 tris on OCCT vs 128 on Manifold vs 208 on
 *    JSCAD for the plate (the Phase 21 pre-spike's §7 note,
 *    docs/architecture/occt-prespike-findings.md, now three-way) — so only
 *    counts > 0 and structural validity are asserted, never counts
 *    equality. Rotation is declared by OCCT AND JSCAD but not Manifold
 *    (`transformRotation` differs), which scopes the translation-only
 *    common-op comparisons; both rotating kernels are judged on the same
 *    analytic rotated bounds and agree exactly with each other, and volume
 *    is rotation-invariant so the measure still agrees cross-kernel in the
 *    curved band. `persistentTopology` likewise differs (OCCT true; the
 *    mesh/BSP kernels false) — Phase 22's concern, not compared here.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertVolumeClose,
  type GeometryKernel,
  KERNEL_BACKEND_IDS,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  tessellationTriangleCount,
  type Tessellation,
  unwrapKernelResult,
  expectKernelFailure,
} from "@slopcad/cad-kernel";
import {
  CURVED_VOLUME_TOLERANCE,
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import { createJscadKernel } from "@slopcad/cad-jscad";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";

import { buildBooleanChain, buildPlateWithHole } from "./occt-fixtures";
import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

/**
 * Relative band for mesh-derived vs kernel-measured volume on Manifold: its
 * tessellation IS its boundary representation, so the divergence theorem
 * over the soup re-derives the same measure up to float32 vertex noise
 * (measured 2.6e-9 on the plate when this suite was written).
 */
const MANIFOLD_MESH_VOLUME_TOLERANCE = 1e-6;

/**
 * Relative band for mesh-derived vs kernel-measured volume on JSCAD: like
 * Manifold, its tessellation IS its boundary representation (a fan
 * triangulation of the same polygon set `measureVolume` sums over), so the
 * divergence theorem over the soup re-derives the same measure up to double
 * float noise (measured 5.0e-16 on the plate).
 */
const JSCAD_MESH_VOLUME_TOLERANCE = 1e-6;

/**
 * Relative band for mesh-derived vs kernel-measured volume on OCCT: the
 * kernel integrates its exact BREP, while `tessellate` discretizes curved
 * faces at a 0.1 mm linear deflection, so the mesh volume sits slightly off
 * the exact one (measured +0.089% on the plate; the deflection error scales
 * with curvature, not model size, so 1% is the honest ceiling).
 */
const OCCT_MESH_VOLUME_TOLERANCE = 1e-2;

/** The capability flags all three real kernels must share for policy 1. */
const SHARED_EXACTNESS_FLAGS = [
  "booleans",
  "transformTranslation",
  "exactPrimitiveVolumes",
  "tightBooleanBounds",
] as const;

/**
 * Derives a mesh's volume (mm³) by the divergence theorem: one sixtet per
 * indexed triangle, summed. Winding orientation is not part of the compared
 * contract (`assertTessellationValid` judges structure, not winding), so the
 * magnitude of the signed sum is the mesh volume.
 */
function meshVolumeMm3(tessellation: Tessellation): number {
  const { positions, indices } = tessellation;
  const coordinate = (flatIndex: number): number => {
    const value = positions[flatIndex];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(
        `Mesh volume divergence read a non-finite position at flat index ${flatIndex}.`,
      );
    }
    return value;
  };
  let signedSixtets = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t];
    const ib = indices[t + 1];
    const ic = indices[t + 2];
    if (ia === undefined || ib === undefined || ic === undefined) {
      throw new Error(`Mesh volume divergence read a missing index at ${t}.`);
    }
    const ax = coordinate(ia * 3);
    const ay = coordinate(ia * 3 + 1);
    const az = coordinate(ia * 3 + 2);
    const bx = coordinate(ib * 3);
    const by = coordinate(ib * 3 + 1);
    const bz = coordinate(ib * 3 + 2);
    const cx = coordinate(ic * 3);
    const cy = coordinate(ic * 3 + 1);
    const cz = coordinate(ic * 3 + 2);
    signedSixtets +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }
  return Math.abs(signedSixtets / 6);
}

function volumeOf(kernel: GeometryKernel, solid: KernelSolid, label: string) {
  return unwrapKernelResult(kernel.volume(solid), label);
}

function boundsOf(kernel: GeometryKernel, solid: KernelSolid, label: string) {
  return unwrapKernelResult(kernel.bounds(solid), label);
}

function tessellationOf(
  kernel: GeometryKernel,
  solid: KernelSolid,
  label: string,
) {
  return unwrapKernelResult(kernel.tessellate(solid), label);
}

function boxOf(
  kernel: GeometryKernel,
  width: number,
  depth: number,
  height: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(width),
      depth: length(depth),
      height: length(height),
    }),
    "createBox",
  );
}

function translated(
  kernel: GeometryKernel,
  solid: KernelSolid,
  x: number,
  y: number,
  z: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.transform(solid, { x: length(x), y: length(y), z: length(z) }),
    "transform",
  );
}

describe("cross-kernel semantic equivalence: manifold, opencascade, and jscad", () => {
  let occtRuntime: OcctRuntime;
  let manifoldRuntime: ManifoldRuntime;

  beforeAll(async () => {
    // Both WASM runtimes boot once (~180 ms OCCT, ~12 ms Manifold); every
    // test still creates FRESH kernel instances, preserving per-instance
    // ownership semantics on all three sides. JSCAD is pure JavaScript —
    // no boot, a fresh instance per call.
    [occtRuntime, manifoldRuntime] = await Promise.all([
      createOcctRuntime(),
      createManifoldRuntime(),
    ]);
  });

  const makeOcct = (): GeometryKernel => occtKernelFromRuntime(occtRuntime);
  const makeManifold = (): GeometryKernel =>
    manifoldKernelFromRuntime(manifoldRuntime);
  const makeJscad = (): GeometryKernel => createJscadKernel();

  it("declares the shared exactness ground the policy branches on, and the documented divergences", () => {
    const occt = makeOcct();
    const manifold = makeManifold();
    const jscad = makeJscad();
    // Three distinct, registry-known backends — the comparison is real.
    expect(manifold.id).not.toBe(occt.id);
    expect(jscad.id).not.toBe(occt.id);
    expect(jscad.id).not.toBe(manifold.id);
    expect(KERNEL_BACKEND_IDS).toContain(manifold.id);
    expect(KERNEL_BACKEND_IDS).toContain(occt.id);
    expect(KERNEL_BACKEND_IDS).toContain(jscad.id);
    // Policy 1's precondition: all three declare the planar-exactness
    // flags, so exact-to-exact agreement is owed on planar geometry
    // (bounds of booleans included — every kernel's boolean bounds are the
    // tight boxes of its own planar output).
    for (const flag of SHARED_EXACTNESS_FLAGS) {
      expect(manifold.capabilities[flag]).toBe(true);
      expect(occt.capabilities[flag]).toBe(true);
      expect(jscad.capabilities[flag]).toBe(true);
    }
    // Boolean-volume exactness splits: OCCT and Manifold integrate their
    // own representations exactly; JSCAD's BSP output is a float-precision
    // approximation of the true cut, declared estimated (the fake kernel's
    // discipline) — the tier split policy 2 branches on.
    expect(occt.capabilities.exactBooleanVolumes).toBe(true);
    expect(manifold.capabilities.exactBooleanVolumes).toBe(true);
    expect(jscad.capabilities.exactBooleanVolumes).toBe(false);
    // Documented divergences: rotation is declared by OCCT and JSCAD but
    // not Manifold, which scopes cross-kernel equivalence to the
    // translation-only common ops between the pairs that include Manifold;
    // persistent topology is OCCT-only (Phase 22's concern); the Phase
    // 26.3 sweep is implemented by OCCT (exact pipe) and JSCAD (station
    // loft) but honestly declined by Manifold (no sweep or loft primitive
    // in the engine, probed) — the first operation whose coverage matrix
    // is not universal; and the Phase 26.4 loft follows the same matrix
    // (OCCT exact ruled ThruSections, JSCAD slice loft, Manifold
    // declined — no multi-section constructor in the engine, probed).
    expect(manifold.capabilities.transformRotation).toBe(false);
    expect(occt.capabilities.transformRotation).toBe(true);
    expect(jscad.capabilities.transformRotation).toBe(true);
    expect(manifold.capabilities.persistentTopology).toBe(false);
    expect(occt.capabilities.persistentTopology).toBe(true);
    expect(jscad.capabilities.persistentTopology).toBe(false);
    expect(manifold.capabilities.sweep).toBe(false);
    expect(occt.capabilities.sweep).toBe(true);
    expect(jscad.capabilities.sweep).toBe(true);
    expect(manifold.capabilities.loft).toBe(false);
    expect(occt.capabilities.loft).toBe(true);
    expect(jscad.capabilities.loft).toBe(true);
  });

  it("lofts agree across kernels where walls are planar, and Manifold declines honestly", () => {
    // The Phase 26.4 cross-kernel band discipline: planar-wall lofts
    // (every untwisted fixture) agree exactly-to-exactly — OCCT's ruled
    // surfaces and JSCAD's flat walls represent the same boundary over
    // the same chord vertices; curved members carry the documented chord
    // band (measured −0.166% on the frustum); and a skew wall (the
    // twisted square) diverges by construction — ruled surfaces vs flat
    // triangles, probed and documented per kernel, never compared here.
    const occt = makeOcct();
    const jscad = makeJscad();
    const manifold = makeManifold();
    const square = (side: number, z: number) => {
      const h = side / 2;
      return {
        loop: [
          {
            kind: "line" as const,
            start: [-h, -h] as [number, number],
            end: [h, -h] as [number, number],
          },
          {
            kind: "line" as const,
            start: [h, -h] as [number, number],
            end: [h, h] as [number, number],
          },
          {
            kind: "line" as const,
            start: [h, h] as [number, number],
            end: [-h, h] as [number, number],
          },
          {
            kind: "line" as const,
            start: [-h, h] as [number, number],
            end: [-h, -h] as [number, number],
          },
        ],
        z: length(z),
      };
    };
    const multiLoft = (kernel: GeometryKernel): KernelSolid =>
      unwrapKernelResult(
        kernel.loft({
          sections: [square(10, 0), square(10, 10), square(5, 20)],
          placement: {
            rotation: { axis: [0, 0, 1], angle: angle(0) },
            translation: { x: length(0), y: length(0), z: length(0) },
          },
        }),
        "multi-station loft",
      );
    // Planar walls: both loftring kernels reach the piecewise analytic sum
    // exactly and agree with each other at the exact band (measured
    // 1e-12 relative).
    const piecewise = 100 * 10 + (10 / 6) * (100 + 4 * 56.25 + 25);
    const occtMulti = volumeOf(occt, multiLoft(occt), "occt multi volume");
    const jscadMulti = volumeOf(jscad, multiLoft(jscad), "jscad multi volume");
    assertVolumeClose(occtMulti, piecewise, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(jscadMulti, piecewise, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(jscadMulti, occtMulti, EXACT_VOLUME_TOLERANCE);
    // The curved member (concentric circles → conical frustum): OCCT exact
    // against the analytic frustum (probed −3e-16), JSCAD inside the
    // chord band (probed −0.166%), cross-agreement in the same band.
    const frustumLoft = (kernel: GeometryKernel): KernelSolid =>
      unwrapKernelResult(
        kernel.loft({
          sections: [
            {
              loop: [{ kind: "circle", center: [0, 0], radius: 6 }],
              z: length(0),
            },
            {
              loop: [{ kind: "circle", center: [0, 0], radius: 3 }],
              z: length(10),
            },
          ],
          placement: {
            rotation: { axis: [0, 0, 1], angle: angle(0) },
            translation: { x: length(0), y: length(0), z: length(0) },
          },
        }),
        "frustum loft",
      );
    const analyticFrustum = (Math.PI * 10 * (36 + 18 + 9)) / 3;
    const occtFrustum = volumeOf(
      occt,
      frustumLoft(occt),
      "occt frustum volume",
    );
    const jscadFrustum = volumeOf(
      jscad,
      frustumLoft(jscad),
      "jscad frustum volume",
    );
    assertVolumeClose(occtFrustum, analyticFrustum, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(jscadFrustum, analyticFrustum, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadFrustum, occtFrustum, CURVED_VOLUME_TOLERANCE);
    // Bounds agree within the chord band: OCCT's are the exact circle's
    // (±6, with its 1e-7 AddOptimal margin), JSCAD's are its chord
    // polygon's (vertices ON the circle at the axis crossings, extremes
    // between them — measured 0.0075 mm short on the far side), the same
    // inscribed-chord class every curved mesh member carries.
    assertBoundsEqual(
      boundsOf(jscad, frustumLoft(jscad), "jscad frustum bounds"),
      boundsOf(occt, frustumLoft(occt), "occt frustum bounds"),
      0.05,
    );
    // And the honesty pin: Manifold's structured decline, even for the
    // perfectly valid collection above.
    expectKernelFailure(
      manifold.loft({
        sections: [square(10, 0), square(5, 10)],
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(0) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "loft on Manifold",
    );
  });

  it("builds the plate-with-hole on all three kernels: exact bounds, curved-band volumes, non-empty meshes", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const jscad = makeJscad();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const j = buildPlateWithHole(jscad);
    const manifoldVolume = volumeOf(
      manifold,
      m.result,
      "manifold plate volume",
    );
    const occtVolume = volumeOf(occt, o.result, "occt plate volume");
    const jscadVolume = volumeOf(jscad, j.result, "jscad plate volume");
    // OCCT integrates the true curved bore: exact against the analytic value
    // (measured 0 rel err; the pre-spike's headline exactness result).
    assertVolumeClose(occtVolume, o.analyticVolumeMm3, EXACT_VOLUME_TOLERANCE);
    // Manifold is exact for its own polygonal-bore representation, so its
    // measure sits inside the documented curved band of the analytic value
    // (measured +0.077%, the pre-spike's mesh-divergence number).
    assertVolumeClose(
      manifoldVolume,
      m.analyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    // JSCAD's BSP bore is its own polygonal approximation: same banded tier
    // (measured +0.059% vs analytic).
    assertVolumeClose(
      jscadVolume,
      j.analyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    // Cross-kernel agreement carries the same documented band (measured
    // JSCAD vs OCCT 0.059%, JSCAD vs Manifold 0.018%).
    assertVolumeClose(manifoldVolume, occtVolume, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadVolume, occtVolume, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadVolume, manifoldVolume, CURVED_VOLUME_TOLERANCE);
    // Bounds: all three kernels declare tight boolean bounds and every face
    // of the true result lies on the plate's box — exact three-way equality.
    const manifoldBounds = boundsOf(
      manifold,
      m.result,
      "manifold plate bounds",
    );
    const occtBounds = boundsOf(occt, o.result, "occt plate bounds");
    const jscadBounds = boundsOf(jscad, j.result, "jscad plate bounds");
    assertBoundsEqual(manifoldBounds, m.tightBounds, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(occtBounds, o.tightBounds, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(jscadBounds, j.tightBounds, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(manifoldBounds, occtBounds, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(jscadBounds, occtBounds, EXACT_BOUNDS_TOLERANCE);
    // Meshes: structurally different by design (measured 128 tris on
    // Manifold, 120 on OCCT, 208 on JSCAD), so only presence is owed;
    // structure is policy 3's legitimate difference.
    expect(
      tessellationTriangleCount(
        tessellationOf(manifold, m.result, "manifold plate tessellation"),
      ),
    ).toBeGreaterThan(0);
    expect(
      tessellationTriangleCount(
        tessellationOf(occt, o.result, "occt plate tessellation"),
      ),
    ).toBeGreaterThan(0);
    expect(
      tessellationTriangleCount(
        tessellationOf(jscad, j.result, "jscad plate tessellation"),
      ),
    ).toBeGreaterThan(0);
  });

  it("agrees exactly on the planar boolean common ops: disjoint union and overlapping intersect", () => {
    // The planar halves of the contract suite's boolean battery, run on all
    // three kernels: bounds are exact-to-exact everywhere (policy 1,
    // measured 0 deltas three-way), while volumes are exact-to-exact
    // between the two exact kernels (worst observed delta 3.4e-16 relative)
    // and banded for JSCAD against both (policy 2, measured 1.1e-16 and 0 —
    // JSCAD's planar BSP booleans are float-exact in practice, but the
    // band is what its declaration owes).
    const manifold = makeManifold();
    const occt = makeOcct();
    const jscad = makeJscad();
    const unionOf = (kernel: GeometryKernel) => {
      const left = boxOf(kernel, 10, 10, 10);
      const right = translated(kernel, boxOf(kernel, 10, 10, 10), 30, 0, 0);
      const union = unwrapKernelResult(kernel.union([left, right]), "union");
      return {
        volume: volumeOf(kernel, union, "union volume"),
        bounds: boundsOf(kernel, union, "union bounds"),
      };
    };
    const overlapVolumeOf = (kernel: GeometryKernel) => {
      const big = boxOf(kernel, 20, 20, 10);
      const small = translated(kernel, boxOf(kernel, 10, 10, 10), 5, 5, 0);
      const overlap = unwrapKernelResult(
        kernel.intersect([big, small]),
        "intersect",
      );
      return volumeOf(kernel, overlap, "intersect volume");
    };
    const manifoldUnion = unionOf(manifold);
    const occtUnion = unionOf(occt);
    const jscadUnion = unionOf(jscad);
    assertVolumeClose(manifoldUnion.volume, 2000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(occtUnion.volume, 2000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(
      manifoldUnion.volume,
      occtUnion.volume,
      EXACT_VOLUME_TOLERANCE,
    );
    // JSCAD joins the banded tier for boolean volumes (measured 1.1e-16).
    assertVolumeClose(jscadUnion.volume, 2000, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(
      jscadUnion.volume,
      occtUnion.volume,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      jscadUnion.volume,
      manifoldUnion.volume,
      CURVED_VOLUME_TOLERANCE,
    );
    const unionTight = { min: [0, 0, 0], max: [40, 10, 10] } as const;
    assertBoundsEqual(manifoldUnion.bounds, unionTight, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(occtUnion.bounds, unionTight, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(jscadUnion.bounds, unionTight, EXACT_BOUNDS_TOLERANCE);
    const manifoldOverlap = overlapVolumeOf(manifold);
    const occtOverlap = overlapVolumeOf(occt);
    const jscadOverlap = overlapVolumeOf(jscad);
    assertVolumeClose(manifoldOverlap, 1000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(occtOverlap, 1000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(manifoldOverlap, occtOverlap, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(jscadOverlap, 1000, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadOverlap, occtOverlap, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadOverlap, manifoldOverlap, CURVED_VOLUME_TOLERANCE);
  });

  it("agrees step-by-step on the boolean chain within the documented bands", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const jscad = makeJscad();
    const m = buildBooleanChain(manifold);
    const o = buildBooleanChain(occt);
    const j = buildBooleanChain(jscad);
    // Union step: planar, so exact-to-exact cross-kernel agreement is owed
    // between the exact kernels, and JSCAD's measure agrees in the band
    // (measured 1.1e-16 relative — float noise).
    const manifoldUnion = volumeOf(manifold, m.union, "manifold union volume");
    const occtUnion = volumeOf(occt, o.union, "occt union volume");
    const jscadUnion = volumeOf(jscad, j.union, "jscad union volume");
    assertVolumeClose(manifoldUnion, m.unionVolumeMm3, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(occtUnion, o.unionVolumeMm3, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(manifoldUnion, occtUnion, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(jscadUnion, j.unionVolumeMm3, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadUnion, occtUnion, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadUnion, manifoldUnion, CURVED_VOLUME_TOLERANCE);
    assertBoundsEqual(
      boundsOf(manifold, m.union, "manifold union bounds"),
      m.unionTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(occt, o.union, "occt union bounds"),
      o.unionTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(jscad, j.union, "jscad union bounds"),
      j.unionTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    // Drilled and trimmed steps carry the curved bore: OCCT stays exact
    // against the analytic values, Manifold and JSCAD sit in the curved
    // band, and the cross-kernel deltas stay inside the same band
    // (measured worst +0.65% Manifold trimmed, +0.253% JSCAD trimmed vs
    // analytic; JSCAD vs Manifold +0.390% on the trimmed step).
    const manifoldCut = volumeOf(manifold, m.cut, "manifold cut volume");
    const occtCut = volumeOf(occt, o.cut, "occt cut volume");
    const jscadCut = volumeOf(jscad, j.cut, "jscad cut volume");
    assertVolumeClose(occtCut, o.cutAnalyticVolumeMm3, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(
      manifoldCut,
      m.cutAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      jscadCut,
      j.cutAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(manifoldCut, occtCut, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadCut, occtCut, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadCut, manifoldCut, CURVED_VOLUME_TOLERANCE);
    const manifoldTrimmed = volumeOf(
      manifold,
      m.trimmed,
      "manifold trimmed volume",
    );
    const occtTrimmed = volumeOf(occt, o.trimmed, "occt trimmed volume");
    const jscadTrimmed = volumeOf(jscad, j.trimmed, "jscad trimmed volume");
    assertVolumeClose(
      occtTrimmed,
      o.trimmedAnalyticVolumeMm3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      manifoldTrimmed,
      m.trimmedAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      jscadTrimmed,
      j.trimmedAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(manifoldTrimmed, occtTrimmed, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadTrimmed, occtTrimmed, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(jscadTrimmed, manifoldTrimmed, CURVED_VOLUME_TOLERANCE);
    // The trimmed result is the left block alone: every face planar and on
    // the block's box, so bounds agree exactly three-way.
    assertBoundsEqual(
      boundsOf(manifold, m.trimmed, "manifold trimmed bounds"),
      m.trimmedTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(occt, o.trimmed, "occt trimmed bounds"),
      o.trimmedTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(jscad, j.trimmed, "jscad trimmed bounds"),
      j.trimmedTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("derives agreeing volumes from each kernel's own tessellation within the mesh bands", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const jscad = makeJscad();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const j = buildPlateWithHole(jscad);
    const manifoldMesh = tessellationOf(
      manifold,
      m.result,
      "manifold plate tessellation",
    );
    const occtMesh = tessellationOf(occt, o.result, "occt plate tessellation");
    const jscadMesh = tessellationOf(
      jscad,
      j.result,
      "jscad plate tessellation",
    );
    // Divergence-theorem volume of each soup vs its own kernel's measure:
    // Manifold's and JSCAD's soups ARE their representations (float noise
    // bands), OCCT's is a 0.1 mm-deflection discretization of an
    // exactly-integrated BREP (curved-deflection band).
    assertVolumeClose(
      meshVolumeMm3(manifoldMesh),
      volumeOf(manifold, m.result, "manifold plate volume"),
      MANIFOLD_MESH_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      meshVolumeMm3(jscadMesh),
      volumeOf(jscad, j.result, "jscad plate volume"),
      JSCAD_MESH_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      meshVolumeMm3(occtMesh),
      volumeOf(occt, o.result, "occt plate volume"),
      OCCT_MESH_VOLUME_TOLERANCE,
    );
    // The three independent discretizations of the same plate agree with
    // each other inside the documented curved band (measured Manifold–OCCT
    // 1.2e-4 relative; the meshes agree more closely than the kernel
    // measures themselves, because all under-approximate the bore
    // similarly).
    assertVolumeClose(
      meshVolumeMm3(manifoldMesh),
      meshVolumeMm3(occtMesh),
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      meshVolumeMm3(jscadMesh),
      meshVolumeMm3(occtMesh),
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      meshVolumeMm3(jscadMesh),
      meshVolumeMm3(manifoldMesh),
      CURVED_VOLUME_TOLERANCE,
    );
  });

  it("preserves equivalence under the translation-only common op", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const jscad = makeJscad();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const j = buildPlateWithHole(jscad);
    // The one transform all three kernels declare: the same translation
    // applied to the same model shifts all three kernels' bounds
    // identically (exact) and preserves each kernel's own volume exactly
    // (measured 0 delta on all three).
    const moved = { x: length(5), y: length(-2), z: length(7) };
    const manifoldMoved = unwrapKernelResult(
      manifold.transform(m.result, moved),
      "manifold translate",
    );
    const occtMoved = unwrapKernelResult(
      occt.transform(o.result, moved),
      "occt translate",
    );
    const jscadMoved = unwrapKernelResult(
      jscad.transform(j.result, moved),
      "jscad translate",
    );
    const shifted = { min: [5, -2, 7], max: [35, 18, 17] } as const;
    const manifoldBounds = boundsOf(
      manifold,
      manifoldMoved,
      "manifold translated bounds",
    );
    const occtBounds = boundsOf(occt, occtMoved, "occt translated bounds");
    const jscadBounds = boundsOf(jscad, jscadMoved, "jscad translated bounds");
    assertBoundsEqual(manifoldBounds, shifted, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(occtBounds, shifted, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(jscadBounds, shifted, EXACT_BOUNDS_TOLERANCE);
    assertVolumeClose(
      volumeOf(manifold, manifoldMoved, "manifold translated volume"),
      volumeOf(manifold, m.result, "manifold plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      volumeOf(occt, occtMoved, "occt translated volume"),
      volumeOf(occt, o.result, "occt plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      volumeOf(jscad, jscadMoved, "jscad translated volume"),
      volumeOf(jscad, j.result, "jscad plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("keeps rotation a Manifold-absent extension whose measure and bounds still agree cross-kernel", () => {
    // Manifold does not declare transformRotation (asserted by the
    // capability test), so the rotated scene has no Manifold twin — the
    // documented difference, not a comparison gap. OCCT and JSCAD BOTH
    // rotate: each is judged on its own invariants (volume preserved
    // exactly, tight bounds equal to the analytically rotated plate,
    // x ∈ [-20, 0], y ∈ [0, 30]), the two rotating kernels agree exactly
    // with each other on those bounds, and because volume is
    // rotation-invariant the rotated measures still agree with Manifold's
    // unrotated one inside the curved band — the cross-kernel volume
    // criterion survives rigid motion on all three kernels.
    const manifold = makeManifold();
    const occt = makeOcct();
    const jscad = makeJscad();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const j = buildPlateWithHole(jscad);
    const quarterTurn = {
      x: length(0),
      y: length(0),
      z: length(0),
      rotation: { axis: [0, 0, 1] as const, angle: angle(90, "deg") },
    };
    const rotatedBounds = { min: [-20, 0, 0], max: [0, 30, 10] } as const;
    const occtRotated = unwrapKernelResult(
      occt.transform(o.result, quarterTurn),
      "occt rotate",
    );
    const jscadRotated = unwrapKernelResult(
      jscad.transform(j.result, quarterTurn),
      "jscad rotate",
    );
    const occtRotatedVolume = volumeOf(
      occt,
      occtRotated,
      "occt rotated volume",
    );
    const jscadRotatedVolume = volumeOf(
      jscad,
      jscadRotated,
      "jscad rotated volume",
    );
    // Each rotating kernel preserves its own volume exactly.
    assertVolumeClose(
      occtRotatedVolume,
      volumeOf(occt, o.result, "occt plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      jscadRotatedVolume,
      volumeOf(jscad, j.result, "jscad plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    // Both rotating kernels hit the analytic rotated bounds exactly, and
    // therefore agree exactly with each other.
    assertBoundsEqual(
      boundsOf(occt, occtRotated, "occt rotated bounds"),
      rotatedBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(jscad, jscadRotated, "jscad rotated bounds"),
      rotatedBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(occt, occtRotated, "occt rotated bounds"),
      boundsOf(jscad, jscadRotated, "jscad rotated bounds"),
      EXACT_BOUNDS_TOLERANCE,
    );
    // Rotation-invariant measures agree cross-kernel inside the curved
    // band, Manifold's unrotated twin included.
    assertVolumeClose(
      occtRotatedVolume,
      volumeOf(manifold, m.result, "manifold plate volume"),
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      jscadRotatedVolume,
      volumeOf(manifold, m.result, "manifold plate volume"),
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      occtRotatedVolume,
      jscadRotatedVolume,
      CURVED_VOLUME_TOLERANCE,
    );
  });

  it("sweeps the quarter torus equivalently on the implementing kernels, with Manifold declining honestly", () => {
    const occt = makeOcct();
    const jscad = makeJscad();
    const manifold = makeManifold();
    // The shared fixture: the 6×4 section carried around a radius-30
    // quarter bend — Pappus gives (π/2)·30·24.
    const analytic = (Math.PI / 2) * 30 * 24;
    const sweepInput = {
      loop: [
        { kind: "line", start: [-3, -2], end: [3, -2] },
        { kind: "line", start: [3, -2], end: [3, 2] },
        { kind: "line", start: [3, 2], end: [-3, 2] },
        { kind: "line", start: [-3, 2], end: [-3, -2] },
      ],
      path: [
        {
          kind: "arc",
          center: [-30, 0],
          radius: 30,
          startAngle: angle(0),
          endAngle: angle(Math.PI / 2),
        },
      ],
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: length(0), y: length(0), z: length(0) },
      },
    } as const;
    // OCCT pipes the exact analytic geometry: the exact Pappus value.
    const occtSolid = unwrapKernelResult(occt.sweep(sweepInput), "occt sweep");
    assertVolumeClose(
      volumeOf(occt, occtSolid, "occt sweep volume"),
      analytic,
      EXACT_VOLUME_TOLERANCE,
    );
    // JSCAD lofts the transported stations: the documented band of the
    // same value, and of OCCT's exact measure.
    const jscadSolid = unwrapKernelResult(
      jscad.sweep(sweepInput),
      "jscad sweep",
    );
    const jscadVolume = volumeOf(jscad, jscadSolid, "jscad sweep volume");
    assertVolumeClose(jscadVolume, analytic, CURVED_VOLUME_TOLERANCE);
    assertVolumeClose(
      jscadVolume,
      volumeOf(occt, occtSolid, "occt sweep volume"),
      CURVED_VOLUME_TOLERANCE,
    );
    // Bounds agree inside the station/chord band on both implementing
    // kernels.
    const sweepBounds = {
      min: [-30, -2, 0] as const,
      max: [3, 2, 33] as const,
    };
    assertBoundsEqual(
      boundsOf(occt, occtSolid, "occt sweep bounds"),
      sweepBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(jscad, jscadSolid, "jscad sweep bounds"),
      sweepBounds,
      0.05,
    );
    // Manifold's answer is the structured unsupported operation — the
    // honest divergence the capability matrix declares, not a failure to
    // agree.
    const declined = manifold.sweep(sweepInput);
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.error.code).toBe(KERNEL_ERROR_CODES.unsupportedOperation);
    }
  });

  it("mirrors the plate equivalently on all three kernels (the first Phase 26 op with full coverage)", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const jscad = makeJscad();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const j = buildPlateWithHole(jscad);
    // Unlike sweep/loft/fillet/chamfer/shell (each declined by some
    // engine), every kernel implements mirror honestly — the capability
    // the three assertions below walk through.
    expect(manifold.capabilities.mirror).toBe(true);
    expect(occt.capabilities.mirror).toBe(true);
    expect(jscad.capabilities.mirror).toBe(true);
    const plane = { axis: "x" as const, offset: length(-10) };
    const manifoldMirrored = unwrapKernelResult(
      manifold.mirror(m.result, plane),
      "manifold mirror",
    );
    const occtMirrored = unwrapKernelResult(
      occt.mirror(o.result, plane),
      "occt mirror",
    );
    const jscadMirrored = unwrapKernelResult(
      jscad.mirror(j.result, plane),
      "jscad mirror",
    );
    // x ∈ [0, 30] through the plane x = −10 flips to [−50, −20]; y and z
    // keep their intervals — every kernel declares tight bounds, so the
    // three reflected bounds agree exactly with each other and with the
    // hand-derived flip.
    const reflectedBounds = { min: [-50, 0, 0], max: [-20, 20, 10] } as const;
    assertBoundsEqual(
      boundsOf(manifold, manifoldMirrored, "manifold mirrored bounds"),
      reflectedBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(occt, occtMirrored, "occt mirrored bounds"),
      reflectedBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(jscad, jscadMirrored, "jscad mirrored bounds"),
      reflectedBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    // Each kernel preserves its own measure exactly (an isometry; measured
    // 0 delta on all three)...
    assertVolumeClose(
      volumeOf(manifold, manifoldMirrored, "manifold mirrored volume"),
      volumeOf(manifold, m.result, "manifold plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      volumeOf(occt, occtMirrored, "occt mirrored volume"),
      volumeOf(occt, o.result, "occt plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      volumeOf(jscad, jscadMirrored, "jscad mirrored volume"),
      volumeOf(jscad, j.result, "jscad plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    // ...and the mirror-invariant measures still agree cross-kernel inside
    // the curved band, exactly as the unmirrored ones do.
    assertVolumeClose(
      volumeOf(manifold, manifoldMirrored, "manifold mirrored volume"),
      volumeOf(occt, occtMirrored, "occt mirrored volume"),
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      volumeOf(jscad, jscadMirrored, "jscad mirrored volume"),
      volumeOf(occt, occtMirrored, "occt mirrored volume"),
      CURVED_VOLUME_TOLERANCE,
    );
  });
});
