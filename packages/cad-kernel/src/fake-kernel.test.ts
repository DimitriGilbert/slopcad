/**
 * Fake-kernel-specific tests: exact analytic semantics, deterministic
 * triangle counts, cross-instance determinism, and the opacity mechanism —
 * everything beyond what the shared contract suite already proves.
 */

import { describe, expect, it } from "vitest";
import { angle, length, type LengthValue } from "@slopcad/cad-core";

import {
  KERNEL_ERROR_CODES,
  type KernelSolid,
  tessellationTriangleCount,
} from "./contract";
import {
  createFakeKernel,
  FAKE_BOX_EDGE_TABLE,
  FAKE_BOX_TRIANGLE_COUNT,
  FAKE_KERNEL_CAPABILITIES,
  FAKE_KERNEL_ID,
  FAKE_KERNEL_TESSELLATION_RINGS,
  FAKE_KERNEL_TESSELLATION_SEGMENTS,
} from "./fake-kernel";
import {
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "./test-utils";

function box(w: number, d: number, h: number) {
  const kernel = createFakeKernel();
  return {
    kernel,
    solid: unwrapKernelResult(
      kernel.createBox({
        width: length(w),
        depth: length(d),
        height: length(h),
      }),
      "createBox",
    ),
  };
}

describe("fake kernel identity and capabilities", () => {
  it("identifies as the fake backend", () => {
    expect(createFakeKernel().id).toBe(FAKE_KERNEL_ID);
    expect(FAKE_KERNEL_ID).toBe("fake");
  });

  it("declares the documented capability profile", () => {
    expect(FAKE_KERNEL_CAPABILITIES).toEqual({
      booleans: true,
      transformTranslation: true,
      transformRotation: false,
      transformScale: true,
      exactPrimitiveVolumes: true,
      exactBooleanVolumes: false,
      tightBooleanBounds: false,
      persistentTopology: false,
      sweep: true,
      helix: true,
      fillet: true,
      loft: true,
      chamfer: true,
      shell: true,
      thicken: true,
      extrudeTaper: true,
      mirror: true,
      section: true,
      surfaceArea: true,
      sheets: false,
      surfaceOps: false,
      localFaceOps: false,
      sweepWire: true,
      intersectionCurve: false,
      hiddenLineRemoval: false,
    });
  });

  it("rejects rotation inputs with kernel/invalid-rotation (never silently drops them)", () => {
    // The behavioral pin of transformRotation: false — the contract allows a
    // non-rotating kernel to reject OR ignore a rotation, and the fake
    // kernel documents the stricter choice: the axis-aligned shape model
    // cannot honour rotations, so a rotation-bearing input fails outright
    // with the structured code instead of degrading to translation-only.
    // The shared contract suite judges rotation only where the flag is set,
    // so this rejection is proven here and nowhere else.
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "createBox",
    );
    expectKernelFailure(
      kernel.transform(solid, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 1], angle: angle(90, "deg") },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "rotation input to the fake kernel",
    );
  });
});

describe("fake kernel analytic semantics", () => {
  it("computes exact box volume from inputs given in any length unit", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(2, "cm"),
        depth: length(20, "mm"),
        height: length(0.7874015748031497, "in"),
      }),
      "createBox",
    );
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    expect(volume).toBeCloseTo(20 * 20 * 20, 9);
  });

  it("computes exact sphere volume and bounds", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createSphere({ radius: length(5) }),
      "createSphere",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "sphere volume"),
      (4 / 3) * Math.PI * 125,
      1e-12,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "sphere bounds"),
      { min: [-5, -5, -5], max: [5, 5, 5] },
      0,
    );
  });

  it("computes exact cylinder volume and bounds", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "cylinder volume"),
      Math.PI * 16 * 10,
      1e-12,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "cylinder bounds"),
      { min: [-4, -4, 0], max: [4, 4, 10] },
      0,
    );
  });

  it("computes exact cone volume (sharp and frustum) and bounds", () => {
    const kernel = createFakeKernel();
    const sharp = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(0),
        height: length(10),
      }),
      "createCone",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(sharp), "sharp cone volume"),
      (Math.PI * 16 * 10) / 3,
      1e-12,
    );
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
      (Math.PI * 10 * (16 + 8 + 4)) / 3,
      1e-12,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(frustum), "frustum bounds"),
      { min: [-4, -4, 0], max: [4, 4, 10] },
      0,
    );
  });

  it("measures axis-aligned box booleans exactly through the voxel grid", () => {
    const kernel = createFakeKernel();
    const a = unwrapKernelResult(
      kernel.createBox({
        width: length(20),
        depth: length(20),
        height: length(20),
      }),
      "createBox",
    );
    const b = unwrapKernelResult(
      kernel.transform(a, { x: length(5), y: length(5), z: length(5) }),
      "transform",
    );
    const cut = unwrapKernelResult(kernel.subtract(a, [b]), "subtract");
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(cut), "box-cut volume"),
      20 ** 3 - 15 ** 3,
      1e-9,
    );
  });
});

describe("fake kernel surface area (Phase 27.4)", () => {
  /** The closed-form surface area of one frustum (lateral + both caps). */
  function frustumArea(
    bottomRadius: number,
    topRadius: number,
    height: number,
  ): number {
    const slant = Math.hypot(bottomRadius - topRadius, height);
    return (
      Math.PI * (bottomRadius + topRadius) * slant +
      Math.PI * bottomRadius ** 2 +
      Math.PI * topRadius ** 2
    );
  }

  it("measures the exact analytic box area 2(wd + dh + wh)", () => {
    const { kernel, solid } = box(30, 20, 10);
    expect(unwrapKernelResult(kernel.area(solid), "box area")).toBeCloseTo(
      2 * (30 * 20 + 30 * 10 + 20 * 10),
      9,
    );
  });

  it("measures the exact analytic sphere area 4πr²", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createSphere({ radius: length(5) }),
      "createSphere",
    );
    expect(unwrapKernelResult(kernel.area(solid), "sphere area")).toBeCloseTo(
      4 * Math.PI * 25,
      9,
    );
  });

  it("measures the exact analytic cylinder area 2πr(r + h)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    expect(unwrapKernelResult(kernel.area(solid), "cylinder area")).toBeCloseTo(
      2 * Math.PI * 4 * (4 + 10),
      9,
    );
  });

  it("measures the exact analytic frustum area (lateral + both caps)", () => {
    const kernel = createFakeKernel();
    const sharp = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(0),
        height: length(10),
      }),
      "createCone",
    );
    expect(
      unwrapKernelResult(kernel.area(sharp), "sharp cone area"),
    ).toBeCloseTo(frustumArea(4, 0, 10), 9);
    const frustum = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(2),
        height: length(10),
      }),
      "createCone",
    );
    expect(
      unwrapKernelResult(kernel.area(frustum), "frustum area"),
    ).toBeCloseTo(frustumArea(4, 2, 10), 9);
  });

  it("delegates through translate and mirror isometries exactly", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    const analytic = 2 * Math.PI * 4 * (4 + 10);
    const moved = unwrapKernelResult(
      kernel.transform(solid, { x: length(7), y: length(-3), z: length(2) }),
      "transform",
    );
    expect(unwrapKernelResult(kernel.area(moved), "translated area")).toBe(
      unwrapKernelResult(kernel.area(solid), "source area"),
    );
    expect(
      unwrapKernelResult(kernel.area(moved), "translated area"),
    ).toBeCloseTo(analytic, 9);
    const mirrored = unwrapKernelResult(
      kernel.mirror(solid, { axis: "x", offset: length(3) }),
      "mirror",
    );
    expect(unwrapKernelResult(kernel.area(mirrored), "mirrored area")).toBe(
      unwrapKernelResult(kernel.area(solid), "source area"),
    );
  });

  it("declines boolean nodes with kernel/unsupported-operation, naming the analytic subset", () => {
    const kernel = createFakeKernel();
    const plate = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const bore = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    const drilled = unwrapKernelResult(
      kernel.transform(bore, { x: length(15), y: length(10), z: length(0) }),
      "transform",
    );
    const result = unwrapKernelResult(
      kernel.subtract(plate, [drilled]),
      "subtract",
    );
    expectKernelFailure(
      kernel.area(result),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "surface area of a fake-kernel boolean",
    );
  });

  it("declines modelled repair shapes (fillet) with kernel/unsupported-operation", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const filleted = unwrapKernelResult(
      kernel.fillet({
        target: solid,
        edges: [FAKE_BOX_EDGE_TABLE.length - 1],
        radius: length(2),
      }),
      "fillet",
    );
    expectKernelFailure(
      kernel.area(filleted),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "surface area of a fake-kernel fillet node",
    );
  });
});

describe("fake kernel tessellation counts and validity", () => {
  it("tessellates a box into exactly 12 triangles", () => {
    const { kernel, solid } = box(30, 20, 10);
    const soup = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    expect(tessellationTriangleCount(soup)).toBe(FAKE_BOX_TRIANGLE_COUNT);
    expect(soup.positions.length).toBe(36 * 3);
  });

  it("tessellates a sphere into the closed-form UV-sphere count", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createSphere({ radius: length(5) }),
      "createSphere",
    );
    const soup = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    const expected =
      FAKE_KERNEL_TESSELLATION_SEGMENTS *
      (2 + 2 * (FAKE_KERNEL_TESSELLATION_RINGS - 2));
    expect(tessellationTriangleCount(soup)).toBe(expected);
    assertTessellationValid(soup, {
      bounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    });
  });

  it("tessellates cylinders and cones into the closed-form segment counts", () => {
    const kernel = createFakeKernel();
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    expect(
      tessellationTriangleCount(
        unwrapKernelResult(kernel.tessellate(cylinder), "tessellate"),
      ),
    ).toBe(4 * FAKE_KERNEL_TESSELLATION_SEGMENTS);
    const frustum = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(2),
        height: length(10),
      }),
      "createCone",
    );
    expect(
      tessellationTriangleCount(
        unwrapKernelResult(kernel.tessellate(frustum), "tessellate"),
      ),
    ).toBe(4 * FAKE_KERNEL_TESSELLATION_SEGMENTS);
    const sharp = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: length(4),
        topRadius: length(0),
        height: length(10),
      }),
      "createCone",
    );
    expect(
      tessellationTriangleCount(
        unwrapKernelResult(kernel.tessellate(sharp), "tessellate"),
      ),
    ).toBe(2 * FAKE_KERNEL_TESSELLATION_SEGMENTS);
  });

  it("tessellates the plate-with-hole into the exact leaf count (box + cylinder)", () => {
    const kernel = createFakeKernel();
    const plate = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const bore = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    const placed = unwrapKernelResult(
      kernel.transform(bore, { x: length(15), y: length(10), z: length(0) }),
      "transform",
    );
    const result = unwrapKernelResult(
      kernel.subtract(plate, [placed]),
      "subtract",
    );
    const soup = unwrapKernelResult(kernel.tessellate(result), "tessellate");
    expect(tessellationTriangleCount(soup)).toBe(
      FAKE_BOX_TRIANGLE_COUNT + 4 * FAKE_KERNEL_TESSELLATION_SEGMENTS,
    );
    assertTessellationValid(soup, {
      bounds: { min: [0, 0, 0], max: [30, 20, 10] },
    });
  });

  it("drops boolean leaf triangles that leave the node's conservative bounds", () => {
    const kernel = createFakeKernel();
    const target = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "createBox",
    );
    const outside = unwrapKernelResult(
      kernel.transform(target, { x: length(50), y: length(0), z: length(0) }),
      "transform",
    );
    const cut = unwrapKernelResult(
      kernel.subtract(target, [outside]),
      "subtract",
    );
    const soup = unwrapKernelResult(kernel.tessellate(cut), "tessellate");
    expect(tessellationTriangleCount(soup)).toBe(FAKE_BOX_TRIANGLE_COUNT);
  });

  it("tessellates a corner-overlap intersection above zero triangles (zero triangles exactly for empty solids)", () => {
    // Two 10×10×10 boxes offset by (9,9,9) intersect in a unit cube: volume
    // 1, yet every operand-mesh triangle has a corner outside the node box,
    // so the every-corner keep-filter alone would emit an EMPTY soup for a
    // positive-volume solid — the any-corner fallback is the contract's
    // "zero triangles exactly for empty solids" biconditional.
    const kernel = createFakeKernel();
    const a = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box a",
    );
    const b = unwrapKernelResult(
      kernel.transform(
        unwrapKernelResult(
          kernel.createBox({
            width: length(10),
            depth: length(10),
            height: length(10),
          }),
          "box b",
        ),
        { x: length(9), y: length(9), z: length(9) },
      ),
      "place b",
    );
    const corner = unwrapKernelResult(kernel.intersect([a, b]), "intersect");
    expect(unwrapKernelResult(kernel.volume(corner), "corner volume")).toBe(1);
    const soup = unwrapKernelResult(kernel.tessellate(corner), "tessellate");
    expect(tessellationTriangleCount(soup)).toBeGreaterThan(0);
    assertTessellationValid(soup);
  });
});

describe("fake kernel no-throw length normalization (non-finite magnitudes)", () => {
  // `length(Infinity)` is refused at construction, but a structurally valid
  // LengthValue carrying a non-finite magnitude reaches the kernel through
  // dynamic boundaries (JSON round-trips) — the contract's never-a-throw
  // boundary must answer with structured kernel/invalid-length, exactly the
  // normalization mirror already applies to the same seam.
  const infLen: LengthValue = {
    dimension: "length",
    unit: "mm",
    value: Number.POSITIVE_INFINITY,
  };

  it("transform normalizes a non-finite offset (never a raw throw)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "createBox",
    );
    const failure = expectKernelFailure(
      kernel.transform(solid, { x: infLen, y: length(0), z: length(0) }),
      KERNEL_ERROR_CODES.invalidLength,
      "transform",
    );
    expect(failure.message).toContain("finite");
  });

  it("createBox and createSphere normalize non-finite lengths (never a raw throw)", () => {
    const kernel = createFakeKernel();
    const box = expectKernelFailure(
      kernel.createBox({
        width: infLen,
        depth: length(10),
        height: length(10),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "createBox",
    );
    expect(box.message).toContain("finite");
    const sphere = expectKernelFailure(
      kernel.createSphere({ radius: infLen }),
      KERNEL_ERROR_CODES.invalidLength,
      "createSphere",
    );
    expect(sphere.message).toContain("finite");
  });

  it("mirror keeps its existing structured normalization (the control)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "createBox",
    );
    const failure = expectKernelFailure(
      kernel.mirror(solid, { axis: "x", offset: infLen }),
      KERNEL_ERROR_CODES.invalidLength,
      "mirror",
    );
    expect(failure.message).toContain("finite");
  });
});

describe("fake kernel normals", () => {
  function flatAt(values: readonly number[], index: number): number {
    const value = values[index];
    if (value === undefined) {
      throw new Error(`Missing flat-array value at index ${index}.`);
    }
    return value;
  }

  it("emits per-facet unit normals paired with positions for every primitive", () => {
    const kernel = createFakeKernel();
    const cases: readonly (readonly [
      string,
      KernelSolid,
      readonly [number, number, number],
    ])[] = [
      [
        "box",
        unwrapKernelResult(
          kernel.createBox({
            width: length(30),
            depth: length(20),
            height: length(10),
          }),
          "createBox",
        ),
        [15, 10, 5],
      ],
      [
        "sphere",
        unwrapKernelResult(
          kernel.createSphere({ radius: length(5) }),
          "createSphere",
        ),
        [0, 0, 0],
      ],
      [
        "cylinder",
        unwrapKernelResult(
          kernel.createCylinder({ radius: length(4), height: length(10) }),
          "createCylinder",
        ),
        [0, 0, 5],
      ],
      [
        "sharp cone",
        unwrapKernelResult(
          kernel.createCone({
            bottomRadius: length(4),
            topRadius: length(0),
            height: length(10),
          }),
          "createCone",
        ),
        [0, 0, 2],
      ],
      [
        "frustum",
        unwrapKernelResult(
          kernel.createCone({
            bottomRadius: length(4),
            topRadius: length(2),
            height: length(10),
          }),
          "createCone",
        ),
        [0, 0, 2],
      ],
    ];
    for (const [label, solid, interior] of cases) {
      const soup = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
      assertTessellationValid(soup);
      const normals = soup.normals;
      if (normals === undefined) {
        throw new Error(`${label} tessellation carried no kernel normals.`);
      }
      expect(normals.length).toBe(soup.positions.length);
      const triangleCount = tessellationTriangleCount(soup);
      for (let tri = 0; tri < triangleCount; tri += 1) {
        const corners = [
          flatAt(soup.indices, tri * 3),
          flatAt(soup.indices, tri * 3 + 1),
          flatAt(soup.indices, tri * 3 + 2),
        ];
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (const corner of corners) {
          cx += flatAt(soup.positions, corner * 3);
          cy += flatAt(soup.positions, corner * 3 + 1);
          cz += flatAt(soup.positions, corner * 3 + 2);
        }
        cx /= 3;
        cy /= 3;
        cz /= 3;
        const normalCorner = corners[0];
        if (normalCorner === undefined) {
          throw new Error(
            "Invariant violation: corner list always has three entries.",
          );
        }
        const dot =
          flatAt(normals, normalCorner * 3) * (cx - interior[0]) +
          flatAt(normals, normalCorner * 3 + 1) * (cy - interior[1]) +
          flatAt(normals, normalCorner * 3 + 2) * (cz - interior[2]);
        if (!(dot > 0)) {
          throw new Error(
            `${label} triangle ${tri} normal points inward (dot product ${dot}).`,
          );
        }
      }
    }
  });

  it("emits exactly the six axis directions as box normals", () => {
    const { kernel, solid } = box(30, 20, 10);
    const soup = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    const normals = soup.normals;
    if (normals === undefined) {
      throw new Error("Box tessellation carried no kernel normals.");
    }
    const distinct = new Set<string>();
    for (let v = 0; v < normals.length / 3; v += 1) {
      distinct.add(
        [
          flatAt(normals, v * 3),
          flatAt(normals, v * 3 + 1),
          flatAt(normals, v * 3 + 2),
        ]
          .map((component) => Math.round(component * 1e6) / 1e6)
          .join(","),
      );
    }
    expect([...distinct].sort()).toEqual([
      "-1,0,0",
      "0,-1,0",
      "0,0,-1",
      "0,0,1",
      "0,1,0",
      "1,0,0",
    ]);
  });

  it("omits normals for empty solids alongside the empty soup", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "createBox",
    );
    const empty = unwrapKernelResult(
      kernel.subtract(solid, [solid]),
      "subtract",
    );
    const soup = unwrapKernelResult(kernel.tessellate(empty), "tessellate");
    expect(soup.positions).toEqual([]);
    expect(soup.indices).toEqual([]);
    expect(soup.normals).toBeUndefined();
  });
});

describe("fake kernel determinism", () => {
  it("produces identical tessellations from equal inputs across instances", () => {
    const first = createFakeKernel();
    const second = createFakeKernel();
    const make = (kernel: typeof first) =>
      unwrapKernelResult(
        kernel.tessellate(
          unwrapKernelResult(
            kernel.createSphere({ radius: length(7) }),
            "createSphere",
          ),
        ),
        "tessellate",
      );
    expect(make(second)).toEqual(make(first));
  });

  it("produces identical boolean volumes across instances", () => {
    const { kernel, solid } = box(30, 20, 10);
    const other = createFakeKernel();
    const otherSolid = unwrapKernelResult(
      other.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const hole = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    const otherHole = unwrapKernelResult(
      other.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    const plate = unwrapKernelResult(
      kernel.subtract(solid, [
        unwrapKernelResult(
          kernel.transform(hole, {
            x: length(15),
            y: length(10),
            z: length(0),
          }),
          "transform",
        ),
      ]),
      "subtract",
    );
    const otherPlate = unwrapKernelResult(
      other.subtract(otherSolid, [
        unwrapKernelResult(
          other.transform(otherHole, {
            x: length(15),
            y: length(10),
            z: length(0),
          }),
          "transform",
        ),
      ]),
      "subtract",
    );
    expect(unwrapKernelResult(other.volume(otherPlate), "volume")).toBe(
      unwrapKernelResult(kernel.volume(plate), "volume"),
    );
  });

  it("reports the plate-with-hole volume within the documented voxel error", () => {
    const kernel = createFakeKernel();
    const plate = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const bore = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    const result = unwrapKernelResult(
      kernel.subtract(plate, [
        unwrapKernelResult(
          kernel.transform(bore, {
            x: length(15),
            y: length(10),
            z: length(0),
          }),
          "transform",
        ),
      ]),
      "subtract",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(result), "plate volume"),
      30 * 20 * 10 - Math.PI * 16 * 10,
      0.02,
    );
  });
});

describe("fake kernel mirror (Phase 26.9)", () => {
  it("mirrors a box leaf to reflected bounds, identical volume, and outward-reflected normals", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const mirrored = unwrapKernelResult(
      kernel.mirror(solid, { axis: "x", offset: length(5) }),
      "mirror",
    );
    // x ∈ [0, 30] through the plane x = 5 flips to [2·5 − 30, 2·5 − 0].
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(mirrored), "mirrored bounds"),
      { min: [-20, 0, 0], max: [10, 20, 10] },
      1e-9,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(mirrored), "mirrored volume"),
      6000,
      1e-9,
    );
    // The reflected mesh's normals are the reflected normals: the face at
    // x = −20 carries exactly (−1, 0, 0) — the winding swap restores the
    // facet orientation a bare vertex reflection would invert.
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

  it("classifies membership through the reflection pointwise (mirrored query)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createSphere({ radius: length(5) }),
      "createSphere",
    );
    // The mirrored sphere centred at (10, 0, 0)... the source sphere at
    // (−10, 0, 0) is mirrored through x = 0; both classify the same points.
    const placed = unwrapKernelResult(
      kernel.transform(solid, { x: length(-10), y: length(0), z: length(0) }),
      "transform",
    );
    const mirrored = unwrapKernelResult(
      kernel.mirror(placed, { axis: "x", offset: length(0) }),
      "mirror",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(mirrored), "mirrored sphere bounds"),
      { min: [5, -5, -5], max: [15, 5, 5] },
      1e-9,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(mirrored), "mirrored sphere volume"),
      (4 / 3) * Math.PI * 125,
      1e-9,
    );
  });

  it("mirrors a boolean tree to the same quantized volume and reflected container", () => {
    const kernel = createFakeKernel();
    const plate = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const bore = unwrapKernelResult(
      kernel.createCylinder({ radius: length(4), height: length(10) }),
      "createCylinder",
    );
    const drilled = unwrapKernelResult(
      kernel.subtract(plate, [
        unwrapKernelResult(
          kernel.transform(bore, {
            x: length(15),
            y: length(10),
            z: length(0),
          }),
          "transform",
        ),
      ]),
      "subtract",
    );
    const mirrored = unwrapKernelResult(
      kernel.mirror(drilled, { axis: "y", offset: length(0) }),
      "mirror",
    );
    // Isometry by delegation: the mirrored boolean measures exactly the
    // boolean's own (voxel-quantized) volume, never double-quantized.
    expect(unwrapKernelResult(kernel.volume(mirrored), "volume")).toBe(
      unwrapKernelResult(kernel.volume(drilled), "volume"),
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(mirrored), "mirrored bounds"),
      { min: [0, -20, 0], max: [30, 0, 10] },
      1e-9,
    );
  });

  it("tessellates a boolean whose operand is a mirror (the ordered leaf-step chain)", () => {
    const kernel = createFakeKernel();
    const left = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "createBox",
    );
    const mirroredRight = unwrapKernelResult(
      kernel.mirror(left, { axis: "x", offset: length(25) }),
      "mirror",
    );
    const union = unwrapKernelResult(
      kernel.union([left, mirroredRight]),
      "union",
    );
    // x ∈ [0, 10] through x = 25 flips to [40, 50]: disjoint union volume
    // doubles and the bounds hull spans both — the leaf under the mirror
    // reaches the soup through its reflected affine chain, exact. Volume
    // rides the fake kernel's voxel band (union volumes are quantized,
    // exactBooleanVolumes: false).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(union), "union volume"),
      2000,
      0.05,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(union), "union bounds"),
      { min: [0, 0, 0], max: [50, 10, 10] },
      1e-9,
    );
    const soup = unwrapKernelResult(kernel.tessellate(union), "union soup");
    assertTessellationValid(soup, {
      bounds: { min: [0, 0, 0], max: [50, 10, 10] },
    });
    // Every kept triangle of the mirrored leaf sits in the mirrored half.
    for (let i = 0; i < soup.indices.length / 3; i += 1) {
      const i0 = soup.indices[i * 3];
      const i1 = soup.indices[i * 3 + 1];
      const i2 = soup.indices[i * 3 + 2];
      if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
      const xs = [i0, i1, i2].map((index) => soup.positions[index * 3] ?? 0);
      expect(xs.every((x) => x >= 39.999) || xs.every((x) => x <= 10.001)).toBe(
        true,
      );
    }
  });

  it("mirrors a placed extrusion to the reflected placement bounds (rotation interaction)", () => {
    const kernel = createFakeKernel();
    // A rectangle extruded under a 90° z placement spans x ∈ [−25, −10],
    // y ∈ [10, 30], z ∈ [0, 10]; mirroring through x = 0 flips x to
    // [10, 25] and leaves y, z alone — the mirror composes with the
    // rotation's transform, no folding into a placement.
    const extruded = unwrapKernelResult(
      kernel.extrude({
        loop: [
          { kind: "line", start: [10, 10], end: [30, 10] },
          { kind: "line", start: [30, 10], end: [30, 25] },
          { kind: "line", start: [30, 25], end: [10, 25] },
          { kind: "line", start: [10, 25], end: [10, 10] },
        ],
        height: length(10),
        direction: 1,
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
      }),
      "extrude",
    );
    const mirrored = unwrapKernelResult(
      kernel.mirror(extruded, { axis: "x", offset: length(0) }),
      "mirror",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(mirrored), "mirrored bounds"),
      { min: [10, 10, 0], max: [25, 30, 10] },
      1e-9,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(mirrored), "mirrored volume"),
      20 * 15 * 10,
      1e-9,
    );
  });

  it("is an involution: the same mirror twice restores the source bounds exactly", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const once = unwrapKernelResult(
      kernel.mirror(solid, { axis: "z", offset: length(-3) }),
      "mirror",
    );
    const twice = unwrapKernelResult(
      kernel.mirror(once, { axis: "z", offset: length(-3) }),
      "mirror",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(twice), "twice-mirrored bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      1e-9,
    );
  });
});

describe("fake kernel handle opacity", () => {
  it("mints handles with no enumerable state to introspect", () => {
    const { solid } = box(10, 10, 10);
    expect(Object.keys(solid)).toEqual([]);
    expect(Object.getOwnPropertySymbols(solid).length).toBe(1);
    expect(JSON.stringify(solid)).toBe("{}");
  });

  it("freezes handles against mutation", () => {
    const { solid } = box(10, 10, 10);
    expect(Object.isFrozen(solid)).toBe(true);
  });
});
