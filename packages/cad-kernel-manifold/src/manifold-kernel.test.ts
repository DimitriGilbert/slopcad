/**
 * Manifold-adapter-specific tests (Phase 9): everything the shared contract
 * suite does not prove — placement-convention mappings onto Manifold's own
 * primitives, honest capability flags, kernel-computed normals (presence,
 * unit length, crease splitting), semantic fixtures with analytic
 * expectations, structured error paths including cross-kernel handles,
 * determinism across instances, WASM disposal hygiene, and the eager
 * deletion of every intermediate the operations construct (spy-probed on
 * the engine's own embind prototypes).
 *
 * The WASM runtime is initialized once in a top-level `beforeAll`; every
 * test uses fresh kernel instances from it.
 */

import { evaluateWire } from "@slopcad/cad-kernel";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Manifold } from "manifold-3d";
import { type LengthValue, angle, length } from "@slopcad/cad-core";
import {
  assertAreaClose,
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  assertVolumeLessThan,
  createFakeKernel,
  expectKernelFailure,
  type GeometryKernel,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  tessellationTriangleCount,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import {
  CURVED_VOLUME_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";

import { MANIFOLD_BACKEND_ID } from "./manifold-backend";
import {
  buildBooleanChain,
  buildPlateWithHole,
  PLATE_WITH_HOLE,
} from "./manifold-fixtures";
import {
  createManifoldKernel,
  MANIFOLD_KERNEL_CAPABILITIES,
  MANIFOLD_NORMALS_MIN_SHARP_ANGLE_DEGREES,
  manifoldKernelFromRuntime,
  MANIFOLD_REVOLVE_CIRCULAR_SEGMENTS,
} from "./manifold-kernel";
import {
  createManifoldRuntime,
  type ManifoldRuntime,
  RUNTIME_BRAND,
} from "./manifold-runtime";

let runtime: ManifoldRuntime;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
});

function makeKernel() {
  return manifoldKernelFromRuntime(runtime);
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

/**
 * The embind prototypes that instance calls resolve through (probed on
 * manifold-3d@3.5.3): the registered geometry methods (`transform`,
 * `translate`) are own properties of the class prototype, and `delete`
 * lives one level up on the shared handle prototype. Spying on the
 * runtime's `Manifold` export itself would miss every instance call —
 * the hygiene tests target these objects instead.
 */
interface EmbindSpyTargets {
  classProto: {
    transform: Manifold["transform"];
    translate: Manifold["translate"];
  };
  handleProto: { delete: Manifold["delete"] };
}

/** Runtime guard for the registered-geometry-method prototype shape. */
function isSpyClassProto(
  value: unknown,
): value is EmbindSpyTargets["classProto"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).transform === "function" &&
    typeof (value as Record<string, unknown>).translate === "function"
  );
}

/** Runtime guard for the shared embind handle prototype shape (`delete`). */
function isSpyHandleProto(
  value: unknown,
): value is EmbindSpyTargets["handleProto"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).delete === "function"
  );
}

function embindSpyTargets(): EmbindSpyTargets {
  const probe = runtime[RUNTIME_BRAND].Manifold.cube([1, 1, 1], false);
  const classProto: unknown = Object.getPrototypeOf(probe);
  probe.delete();
  if (!isSpyClassProto(classProto)) {
    throw new Error(
      "Invariant violation: unexpected Manifold embind class prototype — the hygiene spies cannot target it.",
    );
  }
  const handleProto: unknown = Object.getPrototypeOf(classProto);
  if (!isSpyHandleProto(handleProto)) {
    throw new Error(
      "Invariant violation: unexpected Manifold embind handle prototype — the hygiene spies cannot target it.",
    );
  }
  return { classProto, handleProto };
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

describe("manifold kernel identity and capabilities", () => {
  it("identifies as the manifold backend", () => {
    expect(makeKernel().id).toBe(MANIFOLD_BACKEND_ID);
    expect(MANIFOLD_BACKEND_ID).toBe("manifold");
  });

  it("declares the honest Manifold capability profile", () => {
    expect(MANIFOLD_KERNEL_CAPABILITIES).toEqual({
      booleans: true,
      transformTranslation: true,
      transformRotation: false,
      transformScale: true,
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
      thicken: false,
      extrudeTaper: false,
      mirror: true,
      section: true,
      surfaceArea: true,
      sheets: false,
      surfaceOps: false,
      localFaceOps: false,
      sweepWire: false,
      intersectionCurve: false,
      hiddenLineRemoval: false,
    });
  });

  it("creates a working kernel through the async factory", async () => {
    const kernel = await createManifoldKernel();
    const solid = box(kernel, 10, 10, 10);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "factory kernel volume"),
      10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("manifold primitive placement conventions", () => {
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
});

describe("manifold semantic fixtures", () => {
  it("drills the spike's plate-with-hole: tight bounds, analytic volume", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const resultVolume = unwrapKernelResult(
      kernel.volume(fixture.result),
      "plate volume",
    );
    assertVolumeClose(
      resultVolume,
      fixture.analyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeLessThan(
      resultVolume,
      unwrapKernelResult(kernel.volume(fixture.plate), "solid plate volume"),
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

  it("measures surface area: exact box, plate-with-bore within the boundary band", () => {
    // Phase 27.4: `area` is the engine's own `Manifold.surfaceArea()` —
    // exact over the exact boundary mesh, so the box measures its closed
    // form to float precision and the engine's 28-chord default bore
    // (at r = 4) lands in the same inscribed band its volume documents
    // (probed +0.0134% over the analytic 2 200 + 48π mm²).
    const kernel = makeKernel();
    const solid = box(kernel, 30, 20, 10);
    assertAreaClose(
      unwrapKernelResult(kernel.area(solid), "box area"),
      2 * (30 * 20 + 30 * 10 + 20 * 10),
      EXACT_VOLUME_TOLERANCE,
    );
    const fixture = buildPlateWithHole(kernel);
    assertAreaClose(
      unwrapKernelResult(kernel.area(fixture.result), "plate area"),
      fixture.analyticAreaMm2,
      CURVED_VOLUME_TOLERANCE,
    );
  });

  it("evaluates the boolean chain: exact union, curved cut and trim, tight bounds", () => {
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
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(chain.trimmed), "trimmed volume"),
      chain.trimmedAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
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
});

describe("manifold kernel normals", () => {
  it("returns paired unit normals for every non-empty tessellation", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const soup = unwrapKernelResult(
      kernel.tessellate(fixture.result),
      "tessellate",
    );
    assertTessellationValid(soup);
    if (soup.normals === undefined) {
      throw new Error("Manifold tessellation carried no kernel normals.");
    }
    expect(soup.normals.length).toBe(soup.positions.length);
    expect(soup.normals.length).toBeGreaterThan(0);
  });

  it("keeps planar faces' normals exactly axis-aligned via crease splitting", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const soup = unwrapKernelResult(
      kernel.tessellate(fixture.result),
      "tessellate",
    );
    const normals = soup.normals;
    if (normals === undefined) {
      throw new Error("Manifold tessellation carried no kernel normals.");
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
        Math.abs(Math.abs(nx) - 1) < 1e-9 ||
        Math.abs(Math.abs(ny) - 1) < 1e-9 ||
        Math.abs(Math.abs(nz) - 1) < 1e-9;
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
      throw new Error("Manifold tessellation carried no kernel normals.");
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
      const onWall = Math.abs(distance - radius) < 1e-3 && Math.abs(nz) < 1e-9;
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

describe("manifold error paths", () => {
  it("rejects non-positive and degenerate primitive lengths", () => {
    const kernel = makeKernel();
    expectKernelFailure(
      kernel.createBox({
        width: length(0),
        depth: length(1),
        height: length(1),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "zero-width box",
    );
    expectKernelFailure(
      kernel.createCone({
        bottomRadius: length(0),
        topRadius: length(1),
        height: length(1),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "zero bottom cone radius",
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

  it("rejects handles minted by another Manifold kernel instance", () => {
    const mine = makeKernel();
    const other = makeKernel();
    const foreign = unwrapKernelResult(
      other.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "other createBox",
    );
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

describe("manifold empty-solid semantics", () => {
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
    expect(soup.normals).toBeUndefined();
    // Phase 27.4: the surface-area measurement follows the volume's
    // empty-solid rule — an empty set has no boundary to measure.
    assertAreaClose(
      unwrapKernelResult(kernel.area(empty), "empty area"),
      0,
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("manifold determinism", () => {
  it("reproduces identical tessellation buffers for identical operation chains", () => {
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

describe("manifold disposal hygiene", () => {
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
      kernel.transform(solid, { x: length(1), y: length(1), z: length(1) }),
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

  it("keeps lazily-derived boolean results correct after operand disposal", () => {
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
  });
});

describe("manifold intermediate WASM hygiene", () => {
  // Manifold-3d's embind wrappers are never garbage-collected (no smart
  // pointer in manifold-3d@3.5.3, probed), so every intermediate an
  // operation constructs must be `.delete()`d on every path — the shared
  // per-intermediate `finally` discipline extrude, revolve, the scaled
  // transform, and `section`'s tool chain all follow. The exact delete
  // counts below are the
  // adapter's constructed-intermediate counts per call: the bare-
  // constructor probe at the start of each engine-constructor test
  // measures (and stays clear of) the delete churn the extrude/revolve
  // bindings perform on their own internal polygon vectors, which the
  // adapter cannot address and the binding already frees. The injected
  // engine faults exercise the failure paths that structured validation
  // cannot reach (every validation failure fires before any
  // construction).

  function extrudeSquare(
    direction: 1 | -1,
  ): Parameters<GeometryKernel["extrude"]>[0] {
    return {
      loop: [
        { kind: "line", start: [0, 0], end: [10, 0] },
        { kind: "line", start: [10, 0], end: [10, 10] },
        { kind: "line", start: [10, 10], end: [0, 10] },
        { kind: "line", start: [0, 10], end: [0, 0] },
      ],
      height: length(5),
      direction,
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: length(0), y: length(0), z: length(0) },
      },
    };
  }

  function quarterRevolve(): Parameters<GeometryKernel["revolve"]>[0] {
    return {
      loop: [
        { kind: "line", start: [0, 0], end: [30, 0] },
        { kind: "line", start: [30, 0], end: [30, 25] },
        { kind: "line", start: [30, 25], end: [0, 25] },
        { kind: "line", start: [0, 25], end: [0, 0] },
      ],
      axis: { point: [0, 0], direction: [1, 0] },
      angle: angle(Math.PI / 2, "rad"),
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: length(0), y: length(0), z: length(0) },
      },
    };
  }

  /** A mid-height plane through a 30 × 20 × 10 box: cap 600 mm², kept half 3000 mm³. */
  function midBoxSection(
    target: KernelSolid,
  ): Parameters<GeometryKernel["section"]>[0] {
    return {
      target,
      origin: [length(0), length(0), length(5)],
      normal: [0, 0, 1],
      keepSide: 1,
    };
  }

  it("deletes every extrude intermediate on the success path, both directions", () => {
    const kernel = makeKernel();
    const { handleProto } = embindSpyTargets();
    const deleteSpy = vi.spyOn(handleProto, "delete");
    // Binding-churn calibration (the extrude binding frees its own
    // internal polygon vectors during the constructor call itself —
    // measured before the probe prism's own delete).
    const bindingPrism = runtime[RUNTIME_BRAND].Manifold.extrude(
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
      5,
    );
    const bindingChurn = deleteSpy.mock.calls.length;
    bindingPrism.delete();
    deleteSpy.mockClear();
    try {
      const down = unwrapKernelResult(
        kernel.extrude(extrudeSquare(-1)),
        "negative extrude",
      );
      // The −1 direction constructs two intermediates — the raw prism and
      // its translated copy — and frees both.
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 2);
      deleteSpy.mockClear();
      const up = unwrapKernelResult(
        kernel.extrude(extrudeSquare(1)),
        "positive extrude",
      );
      // The +1 direction's placement aliases the raw prism: exactly one
      // intermediate, freed once.
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 1);
      // The lazily-evaluated placements survived the deletes (the C++
      // side is reference-counted): both solids stay live and measure
      // their exact volumes.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(down), "down volume"),
        500,
        1e-9,
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(up), "up volume"),
        500,
        1e-9,
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("deletes the revolve intermediate on the success path", () => {
    const kernel = makeKernel();
    const { handleProto } = embindSpyTargets();
    const deleteSpy = vi.spyOn(handleProto, "delete");
    // Binding-churn calibration (the revolve binding frees its own
    // internal polygon vectors during the constructor call itself —
    // measured before the probe sweep's own delete).
    const bindingSweep = runtime[RUNTIME_BRAND].Manifold.revolve(
      [
        [
          [0, 0],
          [30, 0],
          [30, 25],
          [0, 25],
        ],
      ],
      MANIFOLD_REVOLVE_CIRCULAR_SEGMENTS,
      90,
    );
    const bindingChurn = deleteSpy.mock.calls.length;
    bindingSweep.delete();
    deleteSpy.mockClear();
    try {
      const solid = unwrapKernelResult(
        kernel.revolve(quarterRevolve()),
        "quarter revolve",
      );
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 1);
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "quarter volume"),
        (Math.PI * 25 ** 2 * 30) / 4,
        0.001,
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("deletes the scaled transform copy but never the session-owned source", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 10, 10, 10);
    const { handleProto } = embindSpyTargets();
    const deleteSpy = vi.spyOn(handleProto, "delete");
    try {
      const scaled = unwrapKernelResult(
        kernel.transform(solid, {
          x: length(0),
          y: length(0),
          z: length(0),
          scale: 2,
        }),
        "scaled transform",
      );
      // The scale branch constructs exactly one intermediate — the scaled
      // copy — freed once; the session-owned source stays untouched.
      expect(deleteSpy.mock.calls.length).toBe(1);
      deleteSpy.mockClear();
      const moved = unwrapKernelResult(
        kernel.transform(solid, { x: length(5), y: length(0), z: length(0) }),
        "moved transform",
      );
      // The no-scale path constructs no intermediate at all.
      expect(deleteSpy.mock.calls.length).toBe(0);
      // Source and both results stay live and correct.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "source volume"),
        1000,
        1e-9,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(scaled), "scaled bounds"),
        { min: [0, 0, 0], max: [20, 20, 20] },
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(scaled), "scaled volume"),
        8000,
        1e-9,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(moved), "moved bounds"),
        { min: [5, 0, 0], max: [15, 10, 10] },
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("deletes every extrude intermediate when the placement engine call throws", () => {
    const kernel = makeKernel();
    const { classProto, handleProto } = embindSpyTargets();
    const transformSpy = vi.spyOn(classProto, "transform");
    const deleteSpy = vi.spyOn(handleProto, "delete");
    // Binding-churn calibration (the extrude binding frees its own
    // internal polygon vectors during the constructor call itself —
    // measured before the probe prism's own delete).
    const bindingPrism = runtime[RUNTIME_BRAND].Manifold.extrude(
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
      5,
    );
    const bindingChurn = deleteSpy.mock.calls.length;
    bindingPrism.delete();
    deleteSpy.mockClear();
    try {
      transformSpy.mockImplementationOnce(() => {
        throw new Error("simulated engine fault");
      });
      const failure = expectKernelFailure(
        kernel.extrude(extrudeSquare(1)),
        KERNEL_ERROR_CODES.invalidProfile,
        "faulted positive extrude",
      );
      expect(failure.message).toContain("simulated engine fault");
      // The raw prism is the +1 direction's only intermediate — freed
      // even though the placement threw (the boundary normalizes the
      // throw into the structured failure).
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 1);
      deleteSpy.mockClear();
      transformSpy.mockImplementationOnce(() => {
        throw new Error("simulated engine fault");
      });
      const negativeFailure = expectKernelFailure(
        kernel.extrude(extrudeSquare(-1)),
        KERNEL_ERROR_CODES.invalidProfile,
        "faulted negative extrude",
      );
      expect(negativeFailure.message).toContain("simulated engine fault");
      // The −1 direction: the raw prism and its translated copy both
      // exist by the time the placement throws — both freed.
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 2);
    } finally {
      deleteSpy.mockRestore();
      transformSpy.mockRestore();
    }
  });

  it("deletes the revolve intermediate when the placement engine call throws", () => {
    const kernel = makeKernel();
    const { classProto, handleProto } = embindSpyTargets();
    const transformSpy = vi.spyOn(classProto, "transform");
    const deleteSpy = vi.spyOn(handleProto, "delete");
    // Binding-churn calibration (the revolve binding frees its own
    // internal polygon vectors during the constructor call itself —
    // measured before the probe sweep's own delete).
    const bindingSweep = runtime[RUNTIME_BRAND].Manifold.revolve(
      [
        [
          [0, 0],
          [30, 0],
          [30, 25],
          [0, 25],
        ],
      ],
      MANIFOLD_REVOLVE_CIRCULAR_SEGMENTS,
      90,
    );
    const bindingChurn = deleteSpy.mock.calls.length;
    bindingSweep.delete();
    deleteSpy.mockClear();
    try {
      transformSpy.mockImplementationOnce(() => {
        throw new Error("simulated engine fault");
      });
      const failure = expectKernelFailure(
        kernel.revolve(quarterRevolve()),
        KERNEL_ERROR_CODES.invalidProfile,
        "faulted revolve",
      );
      expect(failure.message).toContain("simulated engine fault");
      // The revolved sweep is the operation's only intermediate — freed
      // even though the placement threw.
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 1);
    } finally {
      deleteSpy.mockRestore();
      transformSpy.mockRestore();
    }
  });

  it("deletes the scaled copy and keeps the source live when the translate engine call throws", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 10, 10, 10);
    const { classProto, handleProto } = embindSpyTargets();
    const translateSpy = vi.spyOn(classProto, "translate");
    translateSpy.mockImplementationOnce(() => {
      throw new Error("simulated engine fault");
    });
    const deleteSpy = vi.spyOn(handleProto, "delete");
    try {
      const failure = expectKernelFailure(
        kernel.transform(solid, {
          x: length(1),
          y: length(0),
          z: length(0),
          scale: 2,
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "faulted scaled transform",
      );
      expect(failure.message).toContain("simulated engine fault");
      // The scaled copy is freed despite the throw; the session-owned
      // source handle is not, and stays measurable.
      expect(deleteSpy.mock.calls.length).toBe(1);
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "source volume"),
        1000,
        1e-9,
      );
    } finally {
      deleteSpy.mockRestore();
      translateSpy.mockRestore();
    }
  });

  it("deletes every section intermediate on the success path and keeps the cut", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const { handleProto } = embindSpyTargets();
    const deleteSpy = vi.spyOn(handleProto, "delete");
    // Binding-churn calibration: the section chain's own binding calls —
    // cube, translate, transform, difference, and the tessellation's
    // calculateNormals — may free internal vectors of their own, measured
    // on a probe tool build before the probe handles' own deletes.
    const ctor = runtime[RUNTIME_BRAND].Manifold;
    const probeTarget = ctor.cube([30, 20, 10], false);
    const probePrism = ctor.cube([60, 60, 20], false);
    const probeShifted = probePrism.translate(-30, -30, 0);
    const probeTool = probeShifted.transform([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1,
    ]);
    const probeCut = ctor.difference([probeTarget, probeTool]);
    const probeSoup = probeCut.calculateNormals(
      0,
      MANIFOLD_NORMALS_MIN_SHARP_ANGLE_DEGREES,
    );
    const bindingChurn = deleteSpy.mock.calls.length;
    probeTarget.delete();
    probePrism.delete();
    probeShifted.delete();
    probeTool.delete();
    probeCut.delete();
    probeSoup.delete();
    deleteSpy.mockClear();
    try {
      const cut = unwrapKernelResult(
        kernel.section(midBoxSection(target)),
        "section",
      );
      // The tool chain frees its prism, shifted copy, and tool, and the
      // tessellation frees its normals-bearing copy — four deletes; the
      // cut itself survives as the returned solid's handle.
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 4);
      // The surviving cut stays live and measures its kept half exactly,
      // and the cap area reads off the same mesh.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(cut.solid), "cut volume"),
        3000,
        1e-9,
      );
      expect(cut.section.areaMm2).toBeCloseTo(600, 9);
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("deletes every section intermediate when the tool placement engine call throws", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const { classProto, handleProto } = embindSpyTargets();
    const transformSpy = vi.spyOn(classProto, "transform");
    const deleteSpy = vi.spyOn(handleProto, "delete");
    // Binding-churn calibration: the cube and translate bindings' own
    // internal deletes, if any — the faulted transform never completes,
    // so its churn is absent from the faulted call too. Measured before
    // the probe handles' own deletes.
    const ctor = runtime[RUNTIME_BRAND].Manifold;
    const probePrism = ctor.cube([60, 60, 20], false);
    const probeShifted = probePrism.translate(-30, -30, 0);
    const bindingChurn = deleteSpy.mock.calls.length;
    probePrism.delete();
    probeShifted.delete();
    deleteSpy.mockClear();
    try {
      transformSpy.mockImplementationOnce(() => {
        throw new Error("simulated engine fault");
      });
      const failure = expectKernelFailure(
        kernel.section(midBoxSection(target)),
        KERNEL_ERROR_CODES.invalidLength,
        "faulted section tool placement",
      );
      expect(failure.message).toContain("simulated engine fault");
      // The prism and its shifted copy both exist by the time the
      // placement throws — both freed by their finallys, and the boundary
      // normalizes the throw into the structured invalid-length refusal.
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 2);
      // The session-owned target never reached a boolean: still live.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(target), "target volume"),
        6000,
        1e-9,
      );
    } finally {
      deleteSpy.mockRestore();
      transformSpy.mockRestore();
    }
  });

  it("deletes the section tool chain when the boolean engine call throws", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const { classProto, handleProto } = embindSpyTargets();
    const transformSpy = vi.spyOn(classProto, "transform");
    const differenceSpy = vi.spyOn(
      runtime[RUNTIME_BRAND].Manifold,
      "difference",
    );
    const deleteSpy = vi.spyOn(handleProto, "delete");
    // Binding-churn calibration: the cube, translate, and transform
    // bindings' own internal deletes — the faulted difference never
    // starts, so its churn is absent from the faulted call too. Measured
    // before the probe handles' own deletes.
    const ctor = runtime[RUNTIME_BRAND].Manifold;
    const probePrism = ctor.cube([60, 60, 20], false);
    const probeShifted = probePrism.translate(-30, -30, 0);
    const probeTool = probeShifted.transform([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1,
    ]);
    const bindingChurn = deleteSpy.mock.calls.length;
    probePrism.delete();
    probeShifted.delete();
    probeTool.delete();
    deleteSpy.mockClear();
    try {
      differenceSpy.mockImplementationOnce(() => {
        throw new Error("simulated engine fault");
      });
      const failure = expectKernelFailure(
        kernel.section(midBoxSection(target)),
        KERNEL_ERROR_CODES.invalidLength,
        "faulted section boolean",
      );
      expect(failure.message).toContain("simulated engine fault");
      // Prism, shifted copy, and tool all exist by the time the boolean
      // throws — all three freed by their finallys.
      expect(deleteSpy.mock.calls.length).toBe(bindingChurn + 3);
      // The session-owned target never entered the faulted boolean: live.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(target), "target volume"),
        6000,
        1e-9,
      );
    } finally {
      deleteSpy.mockRestore();
      transformSpy.mockRestore();
      differenceSpy.mockRestore();
    }
  });
});

describe("manifold kernel mirror (Phase 26.9)", () => {
  it("re-winds the reflected mesh itself: crease-aware normals point outward", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 30, 20, 10);
    const mirrored = unwrapKernelResult(
      kernel.mirror(solid, { axis: "x", offset: length(5) }),
      "mirror",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(mirrored), "mirrored bounds"),
      { min: [-20, 0, 0], max: [10, 20, 10] },
    );
    // The engine accepted the negative-determinant matrix and corrected
    // the winding internally: the box's planar x = −20 face carries its
    // crease-split normal exactly (−1, 0, 0). A vertex-only reflection
    // would keep (1, 0, 0) there and shade inside-out.
    const soup = unwrapKernelResult(kernel.tessellate(mirrored), "soup");
    expect(soup.normals).toBeDefined();
    let foundOutward = false;
    for (let v = 0; v < soup.positions.length / 3; v += 1) {
      if ((soup.positions[v * 3] ?? 0) < -19.999) {
        const nx = soup.normals?.[v * 3] ?? 0;
        const ny = soup.normals?.[v * 3 + 1] ?? 0;
        const nz = soup.normals?.[v * 3 + 2] ?? 0;
        if (nx < -0.99 && Math.abs(ny) < 0.01 && Math.abs(nz) < 0.01) {
          foundOutward = true;
        }
      }
    }
    expect(foundOutward).toBe(true);
  });

  it("mirrors a boolean result exactly: the plate-with-hole keeps its measured volume", () => {
    const kernel = makeKernel();
    const plate = buildPlateWithHole(kernel).result;
    const mirrored = unwrapKernelResult(
      kernel.mirror(plate, { axis: "z", offset: length(-4) }),
      "mirror",
    );
    // Manifold volumes are exact on the boundary mesh; the reflection is
    // an isometry, so the mirrored plate measures the same value to float
    // noise — no re-quantization happens anywhere.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(mirrored), "mirrored plate volume"),
      unwrapKernelResult(kernel.volume(plate), "plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(mirrored), "mirrored plate bounds"),
      { min: [0, 0, -18], max: [30, 20, -8] },
    );
  });

  it("rejects a non-finite offset with kernel/invalid-length before the engine", () => {
    const kernel = makeKernel();
    const solid = box(kernel, 10, 10, 10);
    expectKernelFailure(
      kernel.mirror(solid, { axis: "y", offset: nanLength }),
      KERNEL_ERROR_CODES.invalidLength,
      "NaN offset",
    );
    expectKernelFailure(
      kernel.mirror(solid, { axis: "y", offset: infiniteLength }),
      KERNEL_ERROR_CODES.invalidLength,
      "infinite offset",
    );
  });

  it("declines a foreign handle with kernel/solid-not-owned", () => {
    const mine = makeKernel();
    const other = makeKernel();
    const foreign = box(other, 10, 10, 10);
    expectKernelFailure(
      mine.mirror(foreign, { axis: "x", offset: length(0) }),
      KERNEL_ERROR_CODES.solidNotOwned,
      "foreign mirror target",
    );
  });
});

describe("wire (Phase 47)", () => {
  it("answers the shared pure evaluation byte-identically", async () => {
    const kernel = await createManifoldKernel();
    const curve = {
      kind: "interpolated-spline",
      points: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 5],
      ],
    } as const;
    const viaKernel = kernel.wire(curve);
    const viaHelper = evaluateWire(curve);
    expect(viaKernel.ok).toBe(true);
    expect(viaHelper.ok).toBe(true);
    if (!viaKernel.ok || !viaHelper.ok) return;
    expect(viaKernel.value).toEqual(viaHelper.wire);
  });
});
