/**
 * STL export integration with the real geometry engine (Phase 18.1): the
 * strongest semantic check the plan asks for. A genuine Manifold kernel is
 * hosted behind the Phase 10 in-memory worker session (client → in-memory
 * transport → server → kernel), the plate-minus-bore scene is built through
 * session requests, the returned tessellation is exported to binary STL,
 * and the independent hand-rolled reader (`./stl-test-reader`) parses the
 * bytes back — triangle count, per-triangle vertices, bounds, normals, and
 * the divergence-theorem volume of the parsed float32 mesh against the
 * analytic plate value.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import {
  type KernelBounds,
  type Tessellation,
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  createInMemoryKernelSession,
  tessellationTriangleCount,
} from "@slopcad/cad-kernel";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  PLATE_WITH_HOLE,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";

import { exportStlBinary } from "./stl-export";
import {
  documentBounds,
  enclosedVolumeMm3,
  float32Close,
  positionsBounds,
  readBinaryStl,
} from "./stl-test-reader";

/**
 * Parsed facet normals are float32; unit length to 0.1% (the kernel
 * contract's own normal-check slack) absorbs the rounding.
 */
const NORMAL_UNIT_TOLERANCE = 1e-3;

/**
 * Volume tolerance vs the analytic plate: Manifold's polygonal bore slightly
 * undercuts πr²h and float32 quantization perturbs vertices, so 1% relative
 * is the documented band — far tighter than anything a corrupt export could
 * pass, far looser than exact-π demands.
 */
const VOLUME_RELATIVE_TOLERANCE = 0.01;

let runtime: ManifoldRuntime;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
});

/**
 * Builds the plate-minus-bore scene through a fresh in-memory session and
 * returns the tessellation the session reports for it.
 */
async function sessionPlateMinusBoreTessellation(): Promise<Tessellation> {
  const kernel = manifoldKernelFromRuntime(runtime);
  const { client } = createInMemoryKernelSession(kernel);
  const mm = (value: number) => length(value, "mm");
  const { widthMm, depthMm, heightMm, boreRadiusMm, boreCenterXYMm } =
    PLATE_WITH_HOLE;
  const [boreX, boreY] = boreCenterXYMm;
  const plate = await client.request("solid.createBox", {
    width: mm(widthMm),
    depth: mm(depthMm),
    height: mm(heightMm),
  });
  const cylinder = await client.request("solid.createCylinder", {
    radius: mm(boreRadiusMm),
    height: mm(heightMm),
  });
  const bore = await client.request("solid.transform", {
    solid: cylinder.solid,
    translation: { x: mm(boreX), y: mm(boreY), z: mm(0) },
  });
  const drilled = await client.request("solid.subtract", {
    target: plate.solid,
    tools: [bore.solid],
  });
  const { tessellation } = await client.request("solid.tessellate", {
    solid: drilled.solid,
  });
  return tessellation;
}

function analyticVolumeMm3(): number {
  const { widthMm, depthMm, heightMm, boreRadiusMm } = PLATE_WITH_HOLE;
  return widthMm * depthMm * heightMm - Math.PI * boreRadiusMm ** 2 * heightMm;
}

describe("STL export of a real Manifold tessellation", () => {
  it("round-trips semantically through the independent reader", async () => {
    const tessellation = await sessionPlateMinusBoreTessellation();
    const { widthMm, depthMm, heightMm } = PLATE_WITH_HOLE;
    const tightBounds: KernelBounds = {
      min: [0, 0, 0],
      max: [widthMm, depthMm, heightMm],
    };
    assertTessellationValid(tessellation, { bounds: tightBounds });

    const exported = exportStlBinary(tessellation);
    if (!exported.ok) {
      throw new Error(
        `STL export failed with ${exported.error.code}: ${exported.error.message}`,
      );
    }
    const document = readBinaryStl(exported.value);

    // Triangle count and per-triangle vertices survive the f64 → float32
    // boundary: every parsed corner matches the source position its index
    // points at, within float32 tolerance.
    expect(document.triangleCount).toBe(
      tessellationTriangleCount(tessellation),
    );
    for (let t = 0; t < document.triangleCount; t += 1) {
      const triangle = document.triangles[t];
      if (triangle === undefined) {
        throw new Error(`Parsed document is missing triangle ${t}.`);
      }
      for (let corner = 0; corner < 3; corner += 1) {
        const index = tessellation.indices[3 * t + corner];
        const vertex = triangle.vertices[corner];
        if (index === undefined || vertex === undefined) {
          throw new Error(`Triangle ${t} corner ${corner} is missing a side.`);
        }
        for (const axis of [0, 1, 2]) {
          const parsed = vertex[axis] ?? 0;
          const source = tessellation.positions[3 * index + axis] ?? 0;
          if (!float32Close(parsed, source)) {
            throw new Error(
              `Triangle ${t} corner ${corner} axis ${axis}: parsed ${parsed} does not match source ${source} within float32 tolerance.`,
            );
          }
        }
      }
      expect(triangle.attributeByteCount).toBe(0);
    }

    // Bounds of the parsed mesh match the source soup's bounds (which the
    // session already proved are the plate's tight bounds).
    const parsedBounds = documentBounds(document);
    const sourceBounds = positionsBounds(tessellation.positions);
    for (const axis of [0, 1, 2]) {
      expect(
        float32Close(parsedBounds.min[axis] ?? 0, sourceBounds.min[axis] ?? 0),
      ).toBe(true);
      expect(
        float32Close(parsedBounds.max[axis] ?? 0, sourceBounds.max[axis] ?? 0),
      ).toBe(true);
    }
    assertBoundsEqual(
      {
        min: [...sourceBounds.min],
        max: [...sourceBounds.max],
      },
      tightBounds,
    );

    // Manifold computes vertex normals; the collapsed facet normals stay
    // unit-length after float32 rounding.
    expect(tessellation.normals).toBeDefined();
    for (const triangle of document.triangles) {
      const { normal } = triangle;
      const normLength = Math.hypot(normal[0], normal[1], normal[2]);
      if (Math.abs(normLength - 1) > NORMAL_UNIT_TOLERANCE) {
        throw new Error(
          `Facet normal has length ${normLength}, not unit within ${NORMAL_UNIT_TOLERANCE}: [${normal.join(", ")}].`,
        );
      }
    }

    // The strongest semantic check: the parsed float32 mesh's enclosed
    // volume, by the divergence theorem, against the analytic plate.
    assertVolumeClose(
      enclosedVolumeMm3(document),
      analyticVolumeMm3(),
      VOLUME_RELATIVE_TOLERANCE,
    );
  });

  it("is byte-identical across repeated exports and independent sessions", async () => {
    const first = await sessionPlateMinusBoreTessellation();
    const second = await sessionPlateMinusBoreTessellation();
    const firstExport = exportStlBinary(first);
    const secondExport = exportStlBinary(second);
    if (!firstExport.ok || !secondExport.ok) {
      throw new Error("STL export of the real scene unexpectedly failed.");
    }
    expect(firstExport.value.length).toBe(secondExport.value.length);
    for (let i = 0; i < firstExport.value.length; i += 1) {
      if (firstExport.value[i] !== secondExport.value[i]) {
        throw new Error(`Independent sessions' exports differ at byte ${i}.`);
      }
    }
  });

  it("exports the winding-normal path of the same real geometry", async () => {
    const tessellation = await sessionPlateMinusBoreTessellation();
    const withoutNormals: Tessellation = {
      positions: tessellation.positions,
      indices: tessellation.indices,
    };
    const exported = exportStlBinary(withoutNormals);
    if (!exported.ok) {
      throw new Error(
        `STL export failed with ${exported.error.code}: ${exported.error.message}`,
      );
    }
    const document = readBinaryStl(exported.value);
    expect(document.triangleCount).toBe(
      tessellationTriangleCount(withoutNormals),
    );
    for (const triangle of document.triangles) {
      const { normal } = triangle;
      const normLength = Math.hypot(normal[0], normal[1], normal[2]);
      if (Math.abs(normLength - 1) > NORMAL_UNIT_TOLERANCE) {
        throw new Error(
          `Winding facet normal has length ${normLength}, not unit within ${NORMAL_UNIT_TOLERANCE}: [${normal.join(", ")}].`,
        );
      }
    }
    assertVolumeClose(
      enclosedVolumeMm3(document),
      analyticVolumeMm3(),
      VOLUME_RELATIVE_TOLERANCE,
    );
  });
});
