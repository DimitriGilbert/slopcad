/**
 * The `STL/3MF/GLB` guide's runnable example (docs/guides/mesh-exchange.md):
 * the cad-io adapters round-tripping one plate tessellation — STL binary
 * export → import (browser-safe, pure JS), 3MF export → import
 * (Node-targeted: the importer inflates deflate entries through
 * `node:zlib`), and GLB export over the projection (render-oriented, one
 * named node per render object). Every adapter is deterministic: same
 * input in, same bytes out.
 */

import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type RenderObject,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";
import {
  exportGlb,
  exportStlBinary,
  exportThreeMf,
  importStl,
  importThreeMf,
} from "@slopcad/cad-io";

import { unwrap } from "../core/document";
import { GUIDE_CAMERA } from "../core/projection";

/** The example's plate body id. */
const MESH_BODY = createBodyId("body_guide_mesh");

/** The plate soup the example exchanges (canonical millimetres). */
export const EXAMPLE_TESSELLATION: Tessellation = {
  positions: [
    0, 0, 0, 30, 0, 0, 30, 20, 0, 0, 20, 0, 0, 0, 10, 30, 0, 10, 30, 20, 10, 0,
    20, 10,
  ],
  indices: [
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1,
    2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
  ],
};

/** What the example reports back to the guide and the docs page. */
export interface MeshExchangeExampleSummary {
  readonly stlBytes: number;
  readonly stlTriangles: number;
  readonly stlReimportedTriangles: number;
  readonly stlReimportFlavor: string;
  readonly stlDeterministic: boolean;
  readonly threeMfBytes: number;
  readonly threeMfUnit: string;
  readonly threeMfReimportedTriangles: number;
  readonly glbBytes: number;
  readonly glbNodeCount: number;
}

/** Runs every mesh adapter over the example soup and reports the facts. */
export function runMeshExchangeExample(): MeshExchangeExampleSummary {
  // STL: deterministic binary bytes, one file per solid, no part structure.
  const stl = exportStlBinary(EXAMPLE_TESSELLATION);
  if (!stl.ok) {
    throw new Error(`STL export failed: ${stl.error.message}`);
  }
  const stlAgain = exportStlBinary(EXAMPLE_TESSELLATION);
  if (!stlAgain.ok) {
    throw new Error(`STL re-export failed: ${stlAgain.error.message}`);
  }
  const stlReimported = importStl(stl.value);
  if (!stlReimported.ok) {
    throw new Error(`STL re-import failed: ${stlReimported.error.message}`);
  }

  // 3MF: the richer mesh interchange path (OPC ZIP package, mm model unit).
  const threeMf = exportThreeMf(EXAMPLE_TESSELLATION, {
    title: "The mesh-exchange guide example",
  });
  if (!threeMf.ok) {
    throw new Error(`3MF export failed: ${threeMf.error.message}`);
  }
  const threeMfReimported = importThreeMf(threeMf.value);
  if (!threeMfReimported.ok) {
    throw new Error(`3MF re-import failed: ${threeMfReimported.error.message}`);
  }

  // GLB: the render-oriented export over the projection, not the soup.
  const object: RenderObject = unwrap(
    projectTessellation(MESH_BODY, EXAMPLE_TESSELLATION),
    "plate render object",
  );
  const projection = unwrap(
    createRenderProjection([object], GUIDE_CAMERA),
    "guide projection",
  );
  const glb = exportGlb(projection);
  if (!glb.ok) {
    throw new Error(`GLB export failed: ${glb.error.message}`);
  }

  return {
    stlBytes: stl.value.byteLength,
    stlTriangles: EXAMPLE_TESSELLATION.indices.length / 3,
    stlReimportedTriangles: stlReimported.value.tessellation.indices.length / 3,
    stlReimportFlavor: stlReimported.value.flavor,
    stlDeterministic:
      stlAgain.value.byteLength === stl.value.byteLength &&
      stlAgain.value.every((byte, index) => byte === stl.value[index]),
    threeMfBytes: threeMf.value.byteLength,
    threeMfUnit: threeMfReimported.value.units,
    threeMfReimportedTriangles:
      threeMfReimported.value.tessellation.indices.length / 3,
    glbBytes: glb.value.byteLength,
    glbNodeCount: projection.objects.length,
  };
}
