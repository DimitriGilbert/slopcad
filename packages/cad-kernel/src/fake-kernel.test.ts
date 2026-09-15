/**
 * Fake-kernel-specific tests: exact analytic semantics, deterministic
 * triangle counts, cross-instance determinism, and the opacity mechanism —
 * everything beyond what the shared contract suite already proves.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import { type KernelSolid, tessellationTriangleCount } from "./contract";
import {
  createFakeKernel,
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
      transformScale: false,
      exactPrimitiveVolumes: true,
      exactBooleanVolumes: false,
      tightBooleanBounds: false,
      persistentTopology: false,
    });
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
          throw new Error("Invariant violation: corner list always has three entries.");
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
      kernel.createBox({ width: length(10), depth: length(10), height: length(10) }),
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
