/**
 * Ambient module type for the bundler-pinned Manifold WASM asset (the Phase
 * 1.6 spike pattern): Vite's `?url` suffix import resolves the asset at
 * build time and yields its hashed URL. `vite/client` declares the same
 * shape where it is available; this package has no DOM/vite client types,
 * so the specific module is declared here.
 */

declare module "manifold-3d/manifold.wasm?url" {
  /** The bundler-emitted URL of `manifold.wasm`. */
  const url: string;
  export default url;
}
