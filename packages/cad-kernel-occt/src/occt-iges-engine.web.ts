/**
 * The browser pin of the IGES fallback engine's wasm asset (Phase 21.5):
 * resolves the hashed asset URL through the bundler's `?url` import and
 * hands it to the engine's standard emscripten `locateFile` hook — the twin
 * of `./occt-worker.web`'s replicad pin, minus the worker scope (the IGES
 * engine runs on the caller's thread; see `./occt-iges-import`). This
 * module exists separately from the engine module because the `?url`
 * import must be resolved from THIS package's context (the dependency and
 * its wasm live here), while remaining out of the Node-side module graph.
 */

import igesWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

import { createIgesEngine, type IgesEngine } from "./occt-iges-import";

/**
 * Creates (or reuses) the page's IGES engine with the wasm asset pinned to
 * the bundler-emitted URL. Under Node, use `createIgesEngine` directly —
 * the binding's own resolution works there (probed).
 */
export function createBrowserIgesEngine(): Promise<IgesEngine> {
  return createIgesEngine({
    locateFile: (path: string): string =>
      path.endsWith(".wasm") ? igesWasmUrl : path,
  });
}
