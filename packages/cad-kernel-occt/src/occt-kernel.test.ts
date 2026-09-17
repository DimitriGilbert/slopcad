/**
 * OCCT-adapter-specific tests (Phase 21.1): everything the shared contract
 * suite does not prove — the composed-cone exactness (the binding ships no
 * cone primitive), the plate-with-hole semantic at the pre-spike-probed
 * EXACT volume band, rotation exactness and application order, the
 * load-bearing negative-dimension guard (OCCT itself silently mirrors
 * negative input), empty-solid semantics via measurement, structured error
 * paths including cross-kernel handles, kernel-computed normals,
 * determinism across fresh instances, and WASM disposal hygiene.
 *
 * The WASM runtime is initialized once in a top-level `beforeAll`; every
 * test uses fresh kernel instances from it.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { type AngleValue, type LengthValue, angle, length } from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  createFakeKernel,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  tessellationTriangleCount,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";

import { OCCT_BACKEND_ID } from "./occt-backend";
import {
  buildBooleanChain,
  buildPlateWithHole,
  PLATE_WITH_HOLE,
} from "./occt-fixtures";
import {
  createOcctKernel,
  OCCT_KERNEL_CAPABILITIES,
  occtKernelFromRuntime,
} from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

function makeKernel() {
  return occtKernelFromRuntime(runtime);
}

function box(
  kernel: ReturnType<typeof makeKernel>,
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

function rotateZ(
  kernel: ReturnType<typeof makeKernel>,
  solid: KernelSolid,
  degrees: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.transform(solid, {
      x: length(0),
      y: length(0),
      z: length(0),
      rotation: { axis: [0, 0, 1], angle: angle(degrees, "deg") },
    }),
    "rotate",
  );
}

/** A non-finite length no typed constructor can produce: the parsed-document path. */
const nanLength: LengthValue = {
  dimension: "length",
  unit: "mm",
  value: Number.NaN,
};

/** An infinite length, same provenance as {@link nanLength}. */
const infiniteLength: LengthValue = {
  dimension: "length",
  unit: "mm",
  value: Number.POSITIVE_INFINITY,
};

/** A non-finite angle, same provenance as {@link nanLength}. */
const nanAngle: AngleValue = {
  dimension: "angle",
  unit: "rad",
  value: Number.NaN,
};

describe("occt kernel identity and capabilities", () => {
  it("identifies as the opencascade backend", () => {
    expect(makeKernel().id).toBe(OCCT_BACKEND_ID);
    expect(OCCT_BACKEND_ID).toBe("opencascade");
  });

  it("declares the honest OCCT capability profile", () => {
    expect(OCCT_KERNEL_CAPABILITIES).toEqual({
      booleans: true,
      transformTranslation: true,
      transformRotation: true,
      transformScale: false,
      exactPrimitiveVolumes: true,
      exactBooleanVolumes: true,
      tightBooleanBounds: true,
      persistentTopology: true,
    });
  });

  it("creates a working kernel through the async factory", async () => {
    const kernel = await createOcctKernel();
    const solid = box(kernel, 10, 10, 10);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "factory kernel volume"),
      10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("occt primitive placement conventions", () => {
  it("places cylinder and cones on the z axis from z = 0", () => {
    const kernel = makeKernel();
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(cylinder), "cylinder bounds"),
      { min: [-4, -4, 0], max: [4, 4, 10] },
    );
    const sharpCone = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(0),
        height: length(10),
      }),
      "createCone",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(sharpCone), "sharp cone bounds"),
      { min: [-4, -4, 0], max: [4, 4, 10] },
    );
    const frustum = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(2),
        height: length(10),
      }),
      "createCone",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(frustum), "frustum bounds"),
      { min: [-4, -4, 0], max: [4, 4, 10] },
    );
  });

  it("centres the sphere on the origin with exact reach", () => {
    const kernel = makeKernel();
    const sphere = unwrapKernelResult(
      kernel.createSphere({ radius: length(10) }),
      "createSphere",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(sphere), "sphere bounds"),
      { min: [-10, -10, -10], max: [10, 10, 10] },
    );
  });

  it("composes cones with primitive-grade exact volumes (revolved profile)", () => {
    // The binding ships no BRepPrimAPI_MakeCone: createCone revolves an
    // exact planar profile, and the result must match the analytic
    // frustum/cone formulas inside the EXACT band, not a discretization
    // band — that is the composition strategy's acceptance bar.
    const kernel = makeKernel();
    const frustum = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(2),
        height: length(10),
      }),
      "createCone",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(frustum), "frustum volume"),
      (Math.PI * 10 * (4 ** 2 + 4 * 2 + 2 ** 2)) / 3,
      EXACT_VOLUME_TOLERANCE,
    );
    const sharpCone = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(0),
        height: length(10),
      }),
      "createCone",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(sharpCone), "sharp cone volume"),
      (Math.PI * 4 ** 2 * 10) / 3,
      EXACT_VOLUME_TOLERANCE,
    );
    const cylindricalFrustum = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(3),
        topRadius: length(3),
        height: length(5),
      }),
      "createCone",
    );
    assertVolumeClose(
      unwrapKernelResult(
        kernel.volume(cylindricalFrustum),
        "equal-radii cone volume",
      ),
      Math.PI * 3 ** 2 * 5,
      EXACT_VOLUME_TOLERANCE,
    );
    // Cross-operation equivalence, not just the analytic formula: the
    // revolved equal-radii cone must be the same solid the kernel's own
    // createCylinder builds — equal volume AND bounds, a stronger check
    // that two construction paths agree with each other.
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(3), height: length(5) }),
      "createCylinder",
    );
    assertVolumeClose(
      unwrapKernelResult(
        kernel.volume(cylindricalFrustum),
        "equal-radii cone volume vs cylinder",
      ),
      unwrapKernelResult(kernel.volume(cylinder), "cylinder volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(cylindricalFrustum), "cone bounds"),
      unwrapKernelResult(kernel.bounds(cylinder), "cylinder bounds"),
      EXACT_BOUNDS_TOLERANCE,
    );
  });
});

describe("occt semantic fixtures", () => {
  it("drills the spike's plate-with-hole: exact volume, tight bounds", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const resultVolume = unwrapKernelResult(
      kernel.volume(fixture.result),
      "plate volume",
    );
    // The pre-spike measured 0 relative error on exactly this scene; the
    // exact band is the honest expectation for BREP integration.
    assertVolumeClose(
      resultVolume,
      fixture.analyticVolumeMm3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(fixture.result), "plate bounds"),
      fixture.tightBounds,
    );
    const soup = unwrapKernelResult(
      kernel.tessellate(fixture.result),
      "plate tessellation",
    );
    assertTessellationValid(soup, { bounds: fixture.tightBounds });
  });

  it("evaluates the boolean chain: every volume exact, bounds tight", () => {
    const kernel = makeKernel();
    const chain = buildBooleanChain(kernel);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(chain.union), "union volume"),
      chain.unionVolumeMm3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(chain.union), "union bounds"),
      chain.unionTightBounds,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(chain.cut), "cut volume"),
      chain.cutAnalyticVolumeMm3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(chain.trimmed), "trimmed volume"),
      chain.trimmedAnalyticVolumeMm3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(chain.trimmed), "trimmed bounds"),
      chain.trimmedTightBounds,
    );
    assertTessellationValid(
      unwrapKernelResult(kernel.tessellate(chain.trimmed), "trimmed soup"),
      { bounds: chain.trimmedTightBounds },
    );
  });

  it("folds n-ary booleans over the pairwise constructors", () => {
    const kernel = makeKernel();
    const a = box(kernel, 10, 10, 10);
    const b = box(kernel, 5, 5, 5);
    const c = unwrapKernelResult(
      kernel.transform(box(kernel, 5, 5, 5), {
        x: length(20),
        y: length(0),
        z: length(0),
      }),
      "transform",
    );
    const union = unwrapKernelResult(kernel.union([a, b, c]), "union");
    // a swallows the contained b; c is disjoint.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(union), "3-way union volume"),
      10 ** 3 + 5 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(union), "3-way union bounds"),
      { min: [0, 0, 0], max: [25, 10, 10] },
    );
    const cut = unwrapKernelResult(
      kernel.subtract(a, [b, c]),
      "2-tool subtract",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(cut), "2-tool subtract volume"),
      10 ** 3 - 5 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("occt rotation", () => {
  it("rotates by 90 degrees about z with exact analytic bounds", () => {
    const kernel = makeKernel();
    const rotated = rotateZ(kernel, box(kernel, 20, 10, 5), 90);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(rotated), "rotated bounds"),
      { min: [-10, 0, 0], max: [0, 20, 5] },
      EXACT_BOUNDS_TOLERANCE,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(rotated), "rotated volume"),
      20 * 10 * 5,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("rotates by 45 degrees about z with exact irrational-corner bounds", () => {
    const kernel = makeKernel();
    const rotated = rotateZ(kernel, box(kernel, 10, 10, 5), 45);
    const halfDiagonal = 10 / Math.SQRT2;
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(rotated), "rotated bounds"),
      {
        min: [-halfDiagonal, 0, 0],
        max: [halfDiagonal, 10 * Math.SQRT2, 5],
      },
      EXACT_BOUNDS_TOLERANCE,
    );
    const soup = unwrapKernelResult(
      kernel.tessellate(rotated),
      "rotated tessellation",
    );
    assertTessellationValid(soup, {
      bounds: {
        min: [-halfDiagonal, 0, 0],
        max: [halfDiagonal, 10 * Math.SQRT2, 5],
      },
      toleranceMm: 1e-5,
    });
  });

  it("rotates about non-unit and negative axes like the normalized direction", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 20, 10, 5);
    const unit = rotateZ(kernel, solid, 90);
    const scaled = unwrapKernelResult(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 25], angle: angle(90, "deg") },
      }),
      "scaled-axis rotate",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(scaled), "scaled-axis bounds"),
      unwrapKernelResult(kernel.bounds(unit), "unit-axis bounds"),
      EXACT_BOUNDS_TOLERANCE,
    );
    const reversed = unwrapKernelResult(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, -3], angle: angle(-90, "deg") },
      }),
      "reversed-axis rotate",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(reversed), "reversed-axis bounds"),
      unwrapKernelResult(kernel.bounds(unit), "unit-axis bounds"),
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("rotates about the 1e-150 fringe axis exactly like the unit axis", () => {
    // The validator's probe, pinned: [0, 0, 1e-150] sits safely above the
    // normalization floor (its squared magnitude 1e-300 is a normal double)
    // and gp_Dir normalizes it to exactly [0, 0, 1], so the accepted fringe
    // is machine-exact — its result must equal the unit-axis rotation, not
    // merely approximate it.
    const kernel = makeKernel();
    const solid = box(kernel, 20, 10, 5);
    const unit = rotateZ(kernel, solid, 90);
    const fringe = unwrapKernelResult(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 1e-150], angle: angle(90, "deg") },
      }),
      "fringe-axis rotate",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(fringe), "fringe-axis bounds"),
      unwrapKernelResult(kernel.bounds(unit), "unit-axis bounds"),
      EXACT_BOUNDS_TOLERANCE,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(fringe), "fringe-axis volume"),
      20 * 10 * 5,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("keeps triangle count and volume through rotation", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const rotated = unwrapKernelResult(
      kernel.transform(fixture.result, {
        x: length(1),
        y: length(2),
        z: length(3),
        rotation: { axis: [0, 0, 1], angle: angle(30, "deg") },
      }),
      "rotate plate",
    );
    const before = unwrapKernelResult(
      kernel.tessellate(fixture.result),
      "tessellate",
    );
    const after = unwrapKernelResult(
      kernel.tessellate(rotated),
      "tessellate",
    );
    expect(tessellationTriangleCount(after)).toBe(
      tessellationTriangleCount(before),
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(rotated), "rotated plate volume"),
      fixture.analyticVolumeMm3,
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("occt error paths (validation is load-bearing)", () => {
  it("rejects negative dimensions before OCCT can silently mirror them", () => {
    // MakeBox(-1, 2, 3) would happily build the mirrored box — the guard
    // must fire with the structured code before any constructor call.
    const kernel = makeKernel();
    expectKernelFailure(
      kernel.createBox({
        width: length(-1),
        depth: length(2),
        height: length(3),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "negative-width box",
    );
    expectKernelFailure(
      kernel.createSphere({ radius: length(-5) }),
      KERNEL_ERROR_CODES.invalidLength,
      "negative sphere radius",
    );
    expectKernelFailure(
      kernel.createCylinder({ radius: length(-4), height: length(10) }),
      KERNEL_ERROR_CODES.invalidLength,
      "negative cylinder radius",
    );
    expectKernelFailure(
      kernel.createCone({
        bottomRadius: length(-4),
        topRadius: length(2),
        height: length(10),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "negative cone bottom radius",
    );
  });

  it("rejects non-finite lengths that only dynamic paths can produce", () => {
    const kernel = makeKernel();
    expectKernelFailure(
      kernel.createSphere({ radius: nanLength }),
      KERNEL_ERROR_CODES.invalidLength,
      "NaN sphere radius",
    );
    expectKernelFailure(
      kernel.createBox({
        width: infiniteLength,
        depth: length(1),
        height: length(1),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "infinite box width",
    );
    expectKernelFailure(
      kernel.transform(box(kernel, 10, 10, 10), {
        x: nanLength,
        y: length(0),
        z: length(0),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "NaN translation",
    );
  });

  it("rejects degenerate rotations with kernel/invalid-rotation", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 10, 10, 10);
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 0], angle: angle(1) },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "zero axis",
    );
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [1, 0, Number.NaN], angle: angle(1) },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "NaN axis component",
    );
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 1], angle: nanAngle },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "NaN angle",
    );
  });

  it("rejects non-normalizable axes at the guard before any OCCT call", () => {
    // gp_Dir normalizes by sqrt(x² + y² + z²) in double precision: an axis
    // like [0, 0, 1e-300] squares to 0 and would throw inside the WASM
    // boundary, which the operation's catch-all would mis-report as
    // kernel/invalid-length. The guard must reject it first with the
    // structured rotation code — on the documented boundary: the squared
    // magnitude must be a finite NORMAL double (≥ 2⁻¹⁰²², the smallest
    // normal), so underflow-to-zero, the whole denormal range, and
    // overflow-to-Infinity all fail before OCCT is reached.
    const kernel = makeKernel();
    const solid = box(kernel, 20, 10, 5);
    const underflowing = expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 1e-300], angle: angle(90, "deg") },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "underflowing axis",
    );
    // Pin the failure to the guard's own message, not a relabelled catch-all.
    expect(underflowing.message).toContain("normalized");
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: {
          axis: [1e-300, 1e-300, 1e-300],
          angle: angle(90, "deg"),
        },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "all-components-underflowing axis",
    );
    // (2⁻⁵¹²)² = 2⁻¹⁰²⁴: a denormal squared magnitude, just below the floor.
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 2 ** -512], angle: angle(90, "deg") },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "denormal squared-magnitude axis",
    );
    // Squared magnitude overflowing to Infinity would hand gp_Dir a silently
    // NULL [0, 0, 0] direction (probed) — rejected for the same reason.
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [1e200, 0, 0], angle: angle(90, "deg") },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "overflowing axis",
    );
    // The floor itself is inclusive on its exact edge: (2⁻⁵¹¹)² = 2⁻¹⁰²² is
    // the smallest normal double, so the sqrt-of-floor magnitude passes and
    // normalizes exactly inside gp_Dir.
    const atFloor = unwrapKernelResult(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 2 ** -511], angle: angle(90, "deg") },
      }),
      "floor-magnitude rotate",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(atFloor), "floor-magnitude bounds"),
      { min: [-10, 0, 0], max: [0, 20, 5] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("rejects malformed boolean operand lists", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 10, 10, 10);
    expectKernelFailure(
      kernel.union([solid]),
      KERNEL_ERROR_CODES.invalidOperands,
      "single-operand union",
    );
    expectKernelFailure(
      kernel.intersect([solid]),
      KERNEL_ERROR_CODES.invalidOperands,
      "single-operand intersect",
    );
    expectKernelFailure(
      kernel.subtract(solid, []),
      KERNEL_ERROR_CODES.invalidOperands,
      "no-tool subtract",
    );
  });

  it("rejects handles minted by other kernels, including the fake kernel", () => {
    const kernel = makeKernel();
    const fakeSolid = unwrapKernelResult(
      createFakeKernel().createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "fake createBox",
    );
    expectKernelFailure(
      kernel.bounds(fakeSolid),
      KERNEL_ERROR_CODES.solidNotOwned,
      "fake-kernel handle bounds",
    );
    expectKernelFailure(
      kernel.union([box(kernel, 10, 10, 10), fakeSolid]),
      KERNEL_ERROR_CODES.solidNotOwned,
      "fake-kernel handle as union operand",
    );
    expectKernelFailure(
      kernel.transform(fakeSolid, {
        x: length(1),
        y: length(1),
        z: length(1),
      }),
      KERNEL_ERROR_CODES.solidNotOwned,
      "fake-kernel handle transform",
    );
  });

  it("rejects handles minted by another OCCT kernel instance", () => {
    const mine = makeKernel();
    const other = makeKernel();
    const foreign = box(other, 10, 10, 10);
    expectKernelFailure(
      mine.volume(foreign),
      KERNEL_ERROR_CODES.solidNotOwned,
      "foreign instance volume",
    );
    expectKernelFailure(
      mine.subtract(box(mine, 10, 10, 10), [foreign]),
      KERNEL_ERROR_CODES.solidNotOwned,
      "foreign instance subtract tool",
    );
  });
});

describe("occt empty-solid semantics (detected by measurement)", () => {
  it("maps total subtraction onto the contract's empty-solid behaviour", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 10, 10, 10);
    const empty = unwrapKernelResult(
      kernel.subtract(solid, [solid]),
      "self-subtract",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(empty), "empty volume"),
      0,
      EXACT_VOLUME_TOLERANCE,
    );
    expectKernelFailure(
      kernel.bounds(empty),
      KERNEL_ERROR_CODES.boundsEmpty,
      "bounds of empty solid",
    );
    const soup = unwrapKernelResult(
      kernel.tessellate(empty),
      "tessellate of empty solid",
    );
    expect(tessellationTriangleCount(soup)).toBe(0);
    expect(soup.positions.length).toBe(0);
    expect(soup.normals).toBeUndefined();
  });

  it("maps disjoint intersection onto the contract's empty-solid behaviour", () => {
    const kernel = makeKernel();
    const left = box(kernel, 10, 10, 10);
    const right = unwrapKernelResult(
      kernel.transform(box(kernel, 10, 10, 10), {
        x: length(50),
        y: length(0),
        z: length(0),
      }),
      "transform",
    );
    const empty = unwrapKernelResult(
      kernel.intersect([left, right]),
      "disjoint intersect",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(empty), "empty volume"),
      0,
      EXACT_VOLUME_TOLERANCE,
    );
    expectKernelFailure(
      kernel.bounds(empty),
      KERNEL_ERROR_CODES.boundsEmpty,
      "bounds of empty solid",
    );
    expect(
      tessellationTriangleCount(
        unwrapKernelResult(kernel.tessellate(empty), "tessellate"),
      ),
    ).toBe(0);
  });
});

describe("occt kernel normals", () => {
  it("returns paired unit normals for every non-empty tessellation", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const soup = unwrapKernelResult(
      kernel.tessellate(fixture.result),
      "tessellate",
    );
    assertTessellationValid(soup);
    if (soup.normals === undefined) {
      throw new Error("OCCT tessellation carried no kernel normals.");
    }
    expect(soup.normals.length).toBe(soup.positions.length);
    expect(soup.normals.length).toBeGreaterThan(0);
  });

  it("keeps planar faces' normals exactly axis-aligned (per-face extraction)", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const soup = unwrapKernelResult(
      kernel.tessellate(fixture.result),
      "tessellate",
    );
    const normals = soup.normals;
    if (normals === undefined) {
      throw new Error("OCCT tessellation carried no kernel normals.");
    }
    let axisAligned = 0;
    for (let v = 0; v < normals.length / 3; v += 1) {
      const nx = normals[v * 3];
      const ny = normals[v * 3 + 1];
      const nz = normals[v * 3 + 2];
      if (nx === undefined || ny === undefined || nz === undefined) {
        throw new Error(`Missing normal components at vertex ${v}.`);
      }
      const isAxisAligned =
        Math.abs(Math.abs(nx) - 1) < 1e-6 ||
        Math.abs(Math.abs(ny) - 1) < 1e-6 ||
        Math.abs(Math.abs(nz) - 1) < 1e-6;
      if (isAxisAligned) axisAligned += 1;
    }
    expect(axisAligned).toBeGreaterThan(0);
  });

  it("points bore-wall normals radially inward toward the bore axis", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const soup = unwrapKernelResult(
      kernel.tessellate(fixture.result),
      "tessellate",
    );
    const { positions, normals } = soup;
    if (normals === undefined) {
      throw new Error("OCCT tessellation carried no kernel normals.");
    }
    const [boreX, boreY] = PLATE_WITH_HOLE.boreCenterXYMm;
    const radius = PLATE_WITH_HOLE.boreRadiusMm;
    let wallNormals = 0;
    for (let v = 0; v < positions.length / 3; v += 1) {
      const x = positions[v * 3];
      const y = positions[v * 3 + 1];
      const nx = normals[v * 3];
      const ny = normals[v * 3 + 1];
      const nz = normals[v * 3 + 2];
      if (
        x === undefined ||
        y === undefined ||
        nx === undefined ||
        ny === undefined ||
        nz === undefined
      ) {
        throw new Error(`Missing components at vertex ${v}.`);
      }
      const dx = x - boreX;
      const dy = y - boreY;
      const distance = Math.hypot(dx, dy);
      const onWall =
        Math.abs(distance - radius) < 1e-3 && Math.abs(nz) < 1e-6;
      if (!onWall) continue;
      const radialDot = (nx * dx + ny * dy) / distance;
      if (radialDot > -0.99) {
        throw new Error(
          `Bore-wall normal at [${x}, ${y}] is not radially inward (radial component ${radialDot}).`,
        );
      }
      wallNormals += 1;
    }
    expect(wallNormals).toBeGreaterThan(0);
  });
});

describe("occt determinism", () => {
  it("reproduces identical tessellation buffers across fresh kernel instances", () => {
    const first = makeKernel();
    const second = makeKernel();
    const make = (kernel: ReturnType<typeof makeKernel>) => {
      const soup = unwrapKernelResult(
        kernel.tessellate(buildPlateWithHole(kernel).result),
        "tessellate",
      );
      return {
        positions: [...soup.positions],
        indices: [...soup.indices],
        normals: soup.normals === undefined ? [] : [...soup.normals],
      };
    };
    expect(make(second)).toEqual(make(first));
  });

  it("tessellates the same solid identically on repeated calls", () => {
    const kernel = makeKernel();
    const solid = buildBooleanChain(kernel).cut;
    const first = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    const second = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    expect(second).toEqual(first);
  });
});

describe("occt disposal hygiene", () => {
  it("fails operations on disposed handles cleanly as unowned", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 10, 10, 10);
    kernel.dispose(solid);
    expectKernelFailure(
      kernel.volume(solid),
      KERNEL_ERROR_CODES.solidNotOwned,
      "volume of disposed solid",
    );
    expectKernelFailure(
      kernel.bounds(solid),
      KERNEL_ERROR_CODES.solidNotOwned,
      "bounds of disposed solid",
    );
    expectKernelFailure(
      kernel.tessellate(solid),
      KERNEL_ERROR_CODES.solidNotOwned,
      "tessellate of disposed solid",
    );
    expectKernelFailure(
      kernel.union([box(kernel, 10, 10, 10), solid]),
      KERNEL_ERROR_CODES.solidNotOwned,
      "disposed solid as union operand",
    );
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(1),
        y: length(1),
        z: length(1),
        rotation: { axis: [0, 0, 1], angle: angle(1) },
      }),
      KERNEL_ERROR_CODES.solidNotOwned,
      "transform of disposed solid",
    );
  });

  it("never throws on redundant or foreign disposal and keeps other solids live", () => {
    const kernel = makeKernel();
    const keep = box(kernel, 10, 10, 10);
    const drop = box(kernel, 20, 20, 20);
    const foreign = unwrapKernelResult(
      createFakeKernel().createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "fake createBox",
    );
    expect(() => {
      kernel.dispose(drop);
      kernel.dispose(drop);
      kernel.dispose(foreign);
    }).not.toThrow();
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(keep), "surviving solid volume"),
      10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("keeps boolean results correct after operand disposal (refcounted TShapes)", () => {
    const kernel = makeKernel();
    const left = box(kernel, 10, 10, 10);
    const right = unwrapKernelResult(
      kernel.transform(box(kernel, 10, 10, 10), {
        x: length(30),
        y: length(0),
        z: length(0),
      }),
      "transform",
    );
    const union = unwrapKernelResult(kernel.union([left, right]), "union");
    kernel.dispose(left);
    kernel.dispose(right);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(union), "union volume"),
      2 * 10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(union), "union bounds"),
      { min: [0, 0, 0], max: [40, 10, 10] },
    );
    assertTessellationValid(
      unwrapKernelResult(kernel.tessellate(union), "union soup"),
      { bounds: { min: [0, 0, 0], max: [40, 10, 10] } },
    );
  });

  it("keeps transform results correct after source disposal (shared TShape under a location)", () => {
    const kernel = makeKernel();
    const source = box(kernel, 10, 10, 10);
    const moved = unwrapKernelResult(
      kernel.transform(source, {
        x: length(5),
        y: length(-2),
        z: length(7),
        rotation: { axis: [0, 0, 1], angle: angle(90, "deg") },
      }),
      "transform",
    );
    kernel.dispose(source);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(moved), "moved volume"),
      10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    // Rotate first: x ∈ [-10, 0], y ∈ [0, 10]; translate second by
    // (5, -2, 7): x ∈ [-5, 5], y ∈ [-2, 8], z ∈ [7, 17].
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(moved), "moved bounds"),
      { min: [-5, -2, 7], max: [5, 8, 17] },
    );
  });
});
