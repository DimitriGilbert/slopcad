/**
 * Vite client-types asset import declaration for the Manifold WASM binary
 * (`vite/client` provides the `*?url` wildcard in Vite projects; this
 * specific declaration covers typechecks in non-Vite contexts such as the
 * authoring package's `tsc --noEmit`).
 */

declare module "manifold-3d/manifold.wasm?url" {
  const url: string;
  export default url;
}
