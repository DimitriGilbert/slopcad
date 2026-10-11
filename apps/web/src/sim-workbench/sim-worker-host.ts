/**
 * The workbench's sim worker host (Phase 61b, engine upgraded 63c,
 * thermal routed 65c): boots
 * the sim worker on demand — the OCCT boot's pattern from the workbench
 * page (`bootOcctWorker` in `CompleteWorkbenchPage.tsx`) applied to the
 * simulation channel. The worker entry (`./sim-worker-entry`) hosts the
 * ROUTED DEFAULT ENGINE: the real 2D LBM reference kernel for flow
 * scenarios, the real conduction/CHT thermal engines (Phase 65c),
 * `structural` declined by the Phase 69 carve.
 *
 * The crash-settling boot (`bootSimWorkerChannel`, the Phase 35
 * hardening discipline) settles in-flight requests if the thread ever
 * dies and reports the crash through `onCrash` so the hosting surface
 * can display it through its own error conventions; a crashed channel is
 * the caller's to forget, and the next boot starts a fresh worker.
 *
 * The worker entry buffers nothing — sim hosting subscribes during module
 * evaluation — so no readiness handshake is needed: a request fired
 * immediately after `new Worker(...)` is answered once the entry loads.
 * This module is only the host: worker construction, the crash-settling
 * boot, and disposal. The module-worker URL stays an INLINE string literal
 * — the bundler statically rewrites exactly this form into its worker
 * chunks, so a variable indirection would silently break the worker
 * emission.
 */

import type {
  BootedSimWorkerChannel,
  SimWorkerBootFailure,
} from "@slopcad/sim-core";
import { bootSimWorkerChannel } from "@slopcad/sim-core";

/** Boots the sim worker channel for the workbench hosting surface. */
export function bootSimWorkbenchWorker(
  onCrash: (failure: SimWorkerBootFailure) => void,
): BootedSimWorkerChannel {
  return bootSimWorkerChannel(
    new Worker(new URL("./sim-worker-entry.ts", import.meta.url), {
      type: "module",
    }),
    onCrash,
  );
}
