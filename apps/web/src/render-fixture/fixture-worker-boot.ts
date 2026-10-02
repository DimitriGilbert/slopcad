/**
 * The fixture sessions' default worker construction (extracted from
 * `bootRenderFixtureSession` when the viewer's standalone export needed to
 * boot its own inlined worker): the bundler-hosted module-worker URLs stay
 * INLINE string literals per branch — the bundler statically rewrites
 * exactly this form into its worker chunks, so a variable indirection here
 * would silently break the worker emission.
 *
 * The viewer's standalone build aliases THIS module out (see
 * `vite.standalone.config.ts`): a classic-file module worker cannot load
 * from a `file://`-opened standalone HTML, so the standalone passes a
 * `workerFactory` (an inlined blob worker) to the session boot instead,
 * and this module's URLs never enter the standalone bundle.
 */

import type { FixtureSessionBackend } from "./fixture-session";

/** Boots the fixture worker for `backend` (the session boot's default). */
export function bootFixtureWorker(backend: FixtureSessionBackend): Worker {
  return backend === "occt"
    ? new Worker(
        new URL("../worker-fixture/occt-worker-entry.ts", import.meta.url),
        { type: "module" },
      )
    : new Worker(
        new URL("../worker-fixture/manifold-worker-entry.ts", import.meta.url),
        { type: "module" },
      );
}
