/**
 * The standalone build's replacement for `render-fixture/fixture-worker-boot`
 * (aliased in `vite.standalone.config.ts`): the default construction hosts
 * the kernel in a bundler-emitted module-worker FILE, which a
 * `file://`-opened standalone HTML can never fetch. The standalone always
 * boots through the session boot's `workerFactory` (the inlined blob
 * worker), so reaching this module is a programming error, not a fallback.
 */

import type { FixtureSessionBackend } from "../render-fixture/fixture-session";

/** Throws: the standalone boots its worker through `workerFactory`. */
export function bootFixtureWorker(backend: FixtureSessionBackend): Worker {
  throw new Error(
    `the standalone viewer boots its inlined worker through workerFactory; the default fixture worker (backend ${backend}) cannot load from a single-file export`,
  );
}
