/**
 * The bundler-hosted entry of the real OpenCascade worker for the
 * `/worker-occt` fixture (Phase 21.2): re-hosts `@slopcad/cad-kernel-occt`'s
 * `occt-worker.web` entry so the module-worker URL stays a *relative*
 * specifier — the one form the bundler statically rewrites into its own
 * worker chunk, complete with the pinned ~22 MB OpenCascade WASM asset (the
 * same hosting contract as the Manifold fixture's entry; see the entry's
 * module doc).
 */

import "@slopcad/cad-kernel-occt/occt-worker.web";
