/**
 * Ambient module type for the bundler-pinned OpenCascade WASM asset (the
 * Manifold `?url` spike pattern, per the Phase 21 pre-spike findings):
 * Vite's `?url` suffix import resolves the asset at build time and yields
 * its hashed URL — the exports map's `./wasm` subpath
 * (`replicad-opencascadejs/wasm`) makes the import legal. This package has
 * no DOM/vite client types, so the specific module is declared here.
 */

declare module "replicad-opencascadejs/wasm?url" {
  /** The bundler-emitted URL of `replicad_single.wasm`. */
  const url: string;
  export default url;
}
