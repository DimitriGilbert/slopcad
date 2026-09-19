import type { GeometryKernel } from "@slopcad/cad-kernel";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
} from "@slopcad/cad-kernel-manifold";
// Vite asset pin: the dependency optimizer breaks manifold.js's own
// `new URL("manifold.wasm", import.meta.url)` resolution, so the runtime
// receives an explicit `locateFile` (the full consumer's documented
// approach, verbatim). `./manifold-wasm.d.ts` declares the asset import
// for non-Vite typechecks.
import wasmUrl from "manifold-3d/manifold.wasm?url";

let kernelPromise: Promise<GeometryKernel> | null = null;

/**
 * Initializes the Manifold kernel once per page (the WASM heap is a
 * per-realm singleton; the runtime module memoizes behind this promise).
 */
export function getKernel(): Promise<GeometryKernel> {
  kernelPromise ??= createManifoldRuntime({
    locateFile: () => wasmUrl,
  }).then((runtime) => manifoldKernelFromRuntime(runtime));
  return kernelPromise;
}
