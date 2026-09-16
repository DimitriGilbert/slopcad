/**
 * GLB export integration with the real geometry engine (Phase 19): the
 * strongest semantic check the plan asks for. A genuine Manifold kernel is
 * hosted behind the Phase 10 in-memory worker session (client → in-memory
 * transport → server → kernel), the plate-minus-bore scene is built through
 * session requests, the returned tessellation — kernel crease-aware normals
 * included — is projected through the public cad-core projection boundary
 * into a {@link RenderProjection} and exported to GLB, and the independent
 * hand-rolled reader (`./glb-test-reader`) parses the bytes back: node
 * naming from the body id, triangle/vertex counts, per-vertex float32
 * fidelity against the source soup, the POSITION accessor's min/max, the
 * documented CadScene material, the divergence-theorem volume of the
 * decoded mesh against the analytic plate value, and byte-determinism
 * across independent sessions.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type RenderCamera,
  type RenderProjection,
} from "@slopcad/cad-core";
import {
  type KernelBounds,
  assertBoundsEqual,
  assertVolumeClose,
  createInMemoryKernelSession,
} from "@slopcad/cad-kernel";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  PLATE_WITH_HOLE,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";

import {
  GLB_BASE_COLOR_SRGB,
  GLB_GENERATOR,
  GLB_MATERIAL_NAME,
  GLB_METALLIC_FACTOR,
  GLB_ROUGHNESS_FACTOR,
  exportGlb,
} from "./glb-export";
import {
  type GlbReadDocument,
  glbBounds,
  glbVolumeMm3,
  readGlb,
} from "./glb-test-reader";

/**
 * Volume tolerance vs the analytic plate: Manifold's polygonal bore slightly
 * undercuts πr²h, so 1% relative is the documented band — far tighter than
 * anything a corrupt export could pass; float32 quantization contributes
 * ~1e-7 relative and is invisible inside it.
 */
const VOLUME_RELATIVE_TOLERANCE = 0.01;

/**
 * The fixture camera: the render fixture's documented home-view spec
 * (`apps/web/src/render-fixture/plate-render-scene.ts`), authored as data.
 * GLB export deliberately does not read it — createRenderProjection merely
 * requires a valid one.
 */
const FIXTURE_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

let runtime: ManifoldRuntime;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
});

/**
 * Builds the plate-minus-bore scene through a fresh in-memory session and
 * projects the returned tessellation (normals included) into a render
 * projection — the exporter's input surface.
 */
async function sessionPlateProjection(): Promise<RenderProjection> {
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
  if (tessellation.normals === undefined) {
    throw new Error(
      "The Manifold session returned a tessellation without kernel normals; the GLB path needs them.",
    );
  }
  const object = projectTessellation(createBodyId("body_plate"), tessellation);
  if (!object.ok) {
    throw new Error(`Projection rejected the plate soup: ${object.error.message}`);
  }
  const projection = createRenderProjection([object.value], FIXTURE_CAMERA);
  if (!projection.ok) {
    throw new Error(
      `Projection assembly rejected: ${projection.error.message}`,
    );
  }
  return projection.value;
}

function analyticVolumeMm3(): number {
  const { widthMm, depthMm, heightMm, boreRadiusMm } = PLATE_WITH_HOLE;
  return widthMm * depthMm * heightMm - Math.PI * boreRadiusMm ** 2 * heightMm;
}

/** The exported bytes of the session plate projection (unwrapped). */
function exportPlateBytes(projection: RenderProjection): Uint8Array {
  const exported = exportGlb(projection);
  if (!exported.ok) {
    throw new Error(
      `GLB export failed with ${exported.error.code}: ${exported.error.message}`,
    );
  }
  return exported.value;
}

/** The expected glTF linear base color of #8aadf4 (independent derivation). */
function expectedBaseColorLinear(): [number, number, number, number] {
  const linear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const hex = GLB_BASE_COLOR_SRGB.slice(1);
  return [
    linear(Number.parseInt(hex.slice(0, 2), 16)),
    linear(Number.parseInt(hex.slice(2, 4), 16)),
    linear(Number.parseInt(hex.slice(4, 6), 16)),
    1,
  ];
}

describe("GLB export of a real Manifold plate projection", () => {
  it("round-trips semantically through the independent reader", async () => {
    const projection = await sessionPlateProjection();
    const object = projection.objects[0];
    if (object === undefined) throw new Error("the fixture projection is empty");
    const { positions, indices, normals } = object;
    if (normals === undefined) throw new Error("the projected object lost its normals");

    const document: GlbReadDocument = readGlb(exportPlateBytes(projection));

    // Structure: exactly one node, named from the body id; generator stamp.
    expect(document.nodeNames).toEqual(["body_plate"]);
    expect(document.generator).toBe(GLB_GENERATOR);
    const primitive = document.nodes[0]?.primitive;
    if (primitive === undefined) throw new Error("the parsed GLB has no node");

    // Counts survive exactly.
    const triangleCount = indices.length / 3;
    expect(primitive.indices.length).toBe(triangleCount * 3);
    expect(primitive.positions.length).toBe(positions.length / 3);
    expect(primitive.normals).not.toBeNull();
    expect(primitive.normals?.length).toBe(normals.length / 3);

    // Every index and every float32-converted position/normal component
    // decodes back exactly (float32 of the source f64 — no other drift).
    for (let i = 0; i < primitive.indices.length; i += 1) {
      expect(primitive.indices[i]).toBe(indices[i]);
    }
    for (let v = 0; v < primitive.positions.length; v += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        expect(primitive.positions[v]?.[axis]).toBe(
          Math.fround(positions[3 * v + axis] ?? 0),
        );
        expect(primitive.normals?.[v]?.[axis]).toBe(
          Math.fround(normals[3 * v + axis] ?? 0),
        );
      }
    }

    // The POSITION accessor's min/max describe the converted data — and
    // equal the fround bounds of the source soup per axis.
    const axisExtreme = (axis: number, maximise: boolean): number => {
      let extreme = maximise ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      for (let i = axis; i < positions.length; i += 3) {
        const value = positions[i] ?? 0;
        extreme = maximise ? Math.max(extreme, value) : Math.min(extreme, value);
      }
      return Math.fround(extreme);
    };
    const minExpected = [0, 1, 2].map((axis) => axisExtreme(axis, false));
    const maxExpected = [0, 1, 2].map((axis) => axisExtreme(axis, true));
    expect(primitive.positionMin).toEqual(minExpected);
    expect(primitive.positionMax).toEqual(maxExpected);

    // The documented CadScene material travels as linear factors.
    expect(document.materialName).toBe(GLB_MATERIAL_NAME);
    expect(document.baseColorFactor).toEqual(expectedBaseColorLinear());
    expect(document.metallicFactor).toBe(GLB_METALLIC_FACTOR);
    expect(document.roughnessFactor).toBe(GLB_ROUGHNESS_FACTOR);

    // Bounds semantics: the decoded mesh is the plate-with-bore, inside the
    // kernel's tight box (allowing float32 rounding at the edges).
    const parsedBounds = glbBounds(primitive);
    const { widthMm, depthMm, heightMm } = PLATE_WITH_HOLE;
    const tightBounds: KernelBounds = {
      min: [0, 0, 0],
      max: [widthMm, depthMm, heightMm],
    };
    assertBoundsEqual(
      { min: [...parsedBounds.min], max: [...parsedBounds.max] },
      tightBounds,
      1e-6,
    );

    // The strongest semantic check: the decoded mesh's enclosed volume, by
    // the divergence theorem, against the analytic plate.
    assertVolumeClose(
      glbVolumeMm3(primitive),
      analyticVolumeMm3(),
      VOLUME_RELATIVE_TOLERANCE,
    );
  });

  it("is byte-identical across repeated exports of independent sessions", async () => {
    const first = exportPlateBytes(await sessionPlateProjection());
    const second = exportPlateBytes(await sessionPlateProjection());
    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length; i += 1) {
      if (first[i] !== second[i]) {
        throw new Error(`Independent sessions' exports differ at byte ${i}.`);
      }
    }
  });
});
