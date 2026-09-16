/**
 * 3MF export integration with the real geometry engine (Phase 18.3): the
 * strongest semantic check the plan asks for. A genuine Manifold kernel is
 * hosted behind the Phase 10 in-memory worker session (client → in-memory
 * transport → server → kernel), the plate-minus-bore scene is built through
 * session requests, the returned tessellation is exported to a 3MF package,
 * and the independent hand-rolled reader (`./three-mf-test-reader`) parses
 * the bytes back — unit declaration, metadata, triangle count, exact vertex
 * positions (3MF decimals round-trip f64 exactly; no float32 slack needed),
 * bounds, and the divergence-theorem volume of the reconstructed mesh
 * against the analytic plate value.
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

import { exportThreeMf } from "./three-mf-export";
import {
  readThreeMfPackage,
  threeMfBounds,
  threeMfVolumeMm3,
} from "./three-mf-test-reader";
import { positionsBounds } from "./stl-test-reader";

/**
 * Volume tolerance vs the analytic plate: Manifold's polygonal bore slightly
 * undercuts πr²h, so 1% relative is the documented band — far tighter than
 * anything a corrupt export could pass, far looser than exact-π demands.
 * (Unlike the STL test there is no float32 quantization term: 3MF vertices
 * round-trip exactly.)
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

describe("3MF export of a real Manifold tessellation", () => {
  it("round-trips semantically through the independent reader", async () => {
    const tessellation = await sessionPlateMinusBoreTessellation();
    const { widthMm, depthMm, heightMm } = PLATE_WITH_HOLE;
    const tightBounds: KernelBounds = {
      min: [0, 0, 0],
      max: [widthMm, depthMm, heightMm],
    };
    assertTessellationValid(tessellation, { bounds: tightBounds });

    const exported = exportThreeMf(tessellation, {
      title: "Plate with bore",
      designer: "slopcad",
      description: "Manifold plate-minus-bore, exported for phase 18.3.",
    });
    if (!exported.ok) {
      throw new Error(
        `3MF export failed with ${exported.error.code}: ${exported.error.message}`,
      );
    }
    const document = readThreeMfPackage(exported.value);

    // Package semantics survive: unit declaration, metadata, structure.
    expect(document.model.unit).toBe("millimeter");
    expect(document.model.metadata.get("Title")).toBe("Plate with bore");
    expect(document.model.metadata.get("Designer")).toBe("slopcad");
    expect(document.model.metadata.get("Description")).toBe(
      "Manifold plate-minus-bore, exported for phase 18.3.",
    );

    // Triangle count and per-triangle indices survive exactly: every parsed
    // triple equals the source triple in order.
    const { vertices, triangles } = document.model;
    expect(triangles.length).toBe(tessellationTriangleCount(tessellation));
    expect(vertices.length).toBe(tessellation.positions.length / 3);
    for (let t = 0; t < triangles.length; t += 1) {
      const triangle = triangles[t];
      if (triangle === undefined) {
        throw new Error(`Parsed model is missing triangle ${t}.`);
      }
      for (const corner of [0, 1, 2]) {
        const parsed = triangle[corner] ?? 0;
        const source = tessellation.indices[3 * t + corner] ?? 0;
        if (parsed !== source) {
          throw new Error(
            `Triangle ${t} corner ${corner}: parsed index ${parsed} is not the source index ${source}.`,
          );
        }
      }
    }

    // 3MF's arbitrary-precision decimals round-trip the f64 soup exactly —
    // no float32 tolerance band, straight numerical identity.
    for (let v = 0; v < vertices.length; v += 1) {
      const vertex = vertices[v];
      if (vertex === undefined) {
        throw new Error(`Parsed model is missing vertex ${v}.`);
      }
      for (const axis of [0, 1, 2]) {
        const parsed = vertex[axis] ?? 0;
        const source = tessellation.positions[3 * v + axis] ?? 0;
        if (!(parsed === source)) {
          throw new Error(
            `Vertex ${v} axis ${axis}: parsed ${parsed} is not exactly the source ${source}.`,
          );
        }
      }
    }

    // Bounds of the reconstructed mesh match the source soup's bounds
    // (which the session already proved are the plate's tight bounds).
    const parsedBounds = threeMfBounds(document);
    const sourceBounds = positionsBounds(tessellation.positions);
    for (const axis of [0, 1, 2]) {
      expect(parsedBounds.min[axis]).toBe(sourceBounds.min[axis] ?? 0);
      expect(parsedBounds.max[axis]).toBe(sourceBounds.max[axis] ?? 0);
    }
    assertBoundsEqual(
      {
        min: [...sourceBounds.min],
        max: [...sourceBounds.max],
      },
      tightBounds,
    );

    // The strongest semantic check: the reconstructed mesh's enclosed
    // volume, by the divergence theorem, against the analytic plate.
    assertVolumeClose(
      threeMfVolumeMm3(document),
      analyticVolumeMm3(),
      VOLUME_RELATIVE_TOLERANCE,
    );
  });

  it("is byte-identical across repeated exports and independent sessions", async () => {
    const first = await sessionPlateMinusBoreTessellation();
    const second = await sessionPlateMinusBoreTessellation();
    const firstExport = exportThreeMf(first, { title: "Plate with bore" });
    const secondExport = exportThreeMf(second, { title: "Plate with bore" });
    if (!firstExport.ok || !secondExport.ok) {
      throw new Error("3MF export of the real scene unexpectedly failed.");
    }
    expect(firstExport.value.length).toBe(secondExport.value.length);
    for (let i = 0; i < firstExport.value.length; i += 1) {
      if (firstExport.value[i] !== secondExport.value[i]) {
        throw new Error(`Independent sessions' exports differ at byte ${i}.`);
      }
    }
  });
});
