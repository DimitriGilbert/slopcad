/**
 * Manifold WASM runtime initialization (Phase 9).
 *
 * `manifold-3d` is an emscripten module: before any geometry call, the
 * factory must run `Module()` (which instantiates the WASM heap) and
 * `setup()` (which installs the `Manifold`/`CrossSection`/`Mesh` classes and
 * quality settings on the returned toplevel). Both are async-capable, so
 * this module exposes a {@link ManifoldRuntime} handle that the kernel
 * constructor closes over — kernels are then created synchronously from an
 * already-initialized runtime.
 *
 * Environment resolution of `manifold.wasm`:
 *
 * - Node / vitest (this package's test environment): `manifold.js` resolves
 *   the `.wasm` next to itself through its own Node detection path, so a
 *   plain `Module()` call with no `locateFile` works — verified against
 *   `manifold-3d@3.5.3` under Node ESM.
 * - Browser bundling (the Phase 10 worker): Vite's dependency optimizer
 *   breaks `manifold.js`'s default `new URL("manifold.wasm",
 *   import.meta.url)` resolution, so the worker phase must pin the asset
 *   (`import wasmUrl from "manifold-3d/manifold.wasm?url"` plus
 *   `Module({ locateFile: () => wasmUrl })`, per the Phase 1.6 spike
 *   findings) and will carry its own thin init around this module.
 *
 * The runtime is memoized per JavaScript context: the WASM module is a
 * per-realm singleton (quality settings and mesh IDs are global state), and
 * re-instantiating the heap per kernel would waste hundreds of
 * milliseconds per test. A failed initialization clears the memo so an
 * environment fix can be retried.
 */

import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";

/**
 * Module-private brand of {@link ManifoldRuntime}. Exported for the sibling
 * kernel module (the only consumer allowed to read the toplevel) but NOT
 * re-exported from the package index — no Manifold type crosses the
 * package's public surface.
 */
export const RUNTIME_BRAND = Symbol(
  "slopcad.cad-kernel-manifold/ManifoldRuntime",
);

/**
 * An initialized Manifold WASM runtime. Opaque by construction: the brand
 * key never leaves this package, so consumers can pass the handle around
 * but cannot touch the Manifold toplevel inside it.
 */
export interface ManifoldRuntime {
  readonly [RUNTIME_BRAND]: ManifoldToplevel;
}

let runtimePromise: Promise<ManifoldRuntime> | undefined;

/**
 * Returns the shared, initialized Manifold runtime of this JavaScript
 * context, instantiating the WASM module and running `setup()` on first
 * call. Concurrent callers await the same initialization.
 */
export function createManifoldRuntime(): Promise<ManifoldRuntime> {
  if (runtimePromise === undefined) {
    runtimePromise = Module()
      .then((toplevel) => {
        toplevel.setup();
        const runtime: ManifoldRuntime = { [RUNTIME_BRAND]: toplevel };
        return runtime;
      })
      .catch((error: unknown) => {
        runtimePromise = undefined;
        throw error;
      });
  }
  return runtimePromise;
}
