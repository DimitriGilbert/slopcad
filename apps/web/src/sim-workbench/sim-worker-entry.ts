/**
 * The bundler-hosted entry of the sim worker for the workbench (Phase 61b):
 * re-hosts `@slopcad/sim-core`'s `sim-worker.web` entry so the module-worker
 * URL stays a *relative* specifier — the one form the bundler statically
 * rewrites into its own worker chunk (the `manifold-worker-entry` precedent
 * from the /worker fixture, complete with the crash-settling hosting
 * contract; see the entry's module doc).
 */

import "@slopcad/sim-core/sim-worker.web";
