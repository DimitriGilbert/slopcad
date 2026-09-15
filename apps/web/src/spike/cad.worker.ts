/**
 * Phase 1.6 architecture spike — NON-PRODUCTION reference code.
 * The kernel worker: loads manifold-3d WASM inside a real Vite-built Web
 * Worker and evaluates the spike document. This file is the kernel boundary.
 * See docs/architecture/spike-findings.md.
 */

import Module from "manifold-3d";
import wasmUrl from "manifold-3d/manifold.wasm?url";
import type { ManifoldToplevel } from "manifold-3d";
import type { CadRequest, CadResponse } from "./protocol";

import { plateDocument } from "./plate-document";

/**
 * Crease threshold (degrees) for kernel-computed normals: plate creases (90°)
 * stay sharp, the bore wall (~10° between facets) shades as a smooth cylinder.
 */
const MIN_SHARP_ANGLE_DEG = 30;

let kernelPromise: Promise<ManifoldToplevel> | undefined;

async function kernel(): Promise<ManifoldToplevel> {
  kernelPromise ??= (async () => {
    const mod = await Module({ locateFile: () => wasmUrl });
    mod.setup();
    return mod;
  })();
  return kernelPromise;
}

async function evaluate(request: CadRequest): Promise<CadResponse> {
  try {
    const mod = await kernel();
    const { solid, dispose } = plateDocument.evaluate(mod, request.parameters);
    // Normals come from the kernel (Manifold.calculateNormals): exact per-face
    // normals with sharp edges split into separate property vertices, so flat
    // faces shade exactly planar — the renderer never averages across creases.
    const shaded = solid.calculateNormals(0, MIN_SHARP_ANGLE_DEG);
    const mesh = shaded.getMesh();
    const bounds = solid.boundingBox();
    const response: CadResponse = {
      id: request.id,
      ok: true,
      result: {
        mesh: {
          numProp: mesh.numProp,
          positions: mesh.vertProperties.slice(),
          indices: mesh.triVerts.slice(),
        },
        volume: solid.volume(),
        boundsMin: [bounds.min[0], bounds.min[1], bounds.min[2]],
        boundsMax: [bounds.max[0], bounds.max[1], bounds.max[2]],
        triangleCount: mesh.numTri,
        vertexCount: mesh.numVert,
      },
    };
    dispose();
    shaded.delete();
    return response;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { id: request.id, ok: false, error };
  }
}

function postResponse(response: CadResponse): void {
  if (response.ok) {
    self.postMessage(response, {
      transfer: [
        response.result.mesh.positions.buffer,
        response.result.mesh.indices.buffer,
      ],
    });
  } else {
    self.postMessage(response);
  }
}

self.addEventListener("message", (event: MessageEvent<CadRequest>) => {
  const request = event.data;
  if (request.kind !== "evaluate") {
    return;
  }
  evaluate(request).then(postResponse, (error: unknown) => {
    postResponse({ id: request.id, ok: false, error: String(error) });
  });
});
