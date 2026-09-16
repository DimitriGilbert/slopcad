/**
 * The bundler-hosted entry of the real Manifold worker for the `/worker`
 * fixture (Phase 10): re-hosts `@slopcad/cad-kernel-manifold`'s
 * `manifold-worker.web` entry so the module-worker URL stays a *relative*
 * specifier — the one form the bundler statically rewrites into its own
 * worker chunk, complete with the pinned Manifold WASM asset (the Phase 1.6
 * spike pattern; see the entry's module doc for the hosting contract).
 */

import "@slopcad/cad-kernel-manifold/manifold-worker.web";
