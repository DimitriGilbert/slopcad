/**
 * The bundler-hosted entry of the sim worker for the workbench (Phase
 * 61b, extended 63c): hosts the ROUTED DEFAULT ENGINE — the real 2D LBM
 * engine for flow scenarios (`@slopcad/sim-flow`, Phase 63c), the 61b
 * fake engine for thermal, `structural` declined by the Phase 69 carve —
 * as a sim worker-protocol responder over the dedicated-worker message
 * scope. This is `@slopcad/sim-core`'s `sim-worker.web` entry restated
 * with the one difference that matters: `createEngine` selects the real
 * engine. The module-worker URL stays an INLINE import — the bundler
 * statically rewrites exactly this form into its worker chunks.
 *
 * A hosting failure cannot hang the channel: the hosting promise is
 * caught, and while the thread can still speak the failure is posted to
 * the main thread as the boot-failure report the crash-settling boot
 * (`bootSimWorkbenchWorker`) settles every in-flight request terminally
 * on — after which the entry closes itself.
 */

import type { SimWorkerTransport } from "@slopcad/sim-core";
import type { SimWebWorkerMessagePort } from "@slopcad/sim-core";
import { hostSimWorker } from "@slopcad/sim-core";
import { isSimWebWorkerMessagePort } from "@slopcad/sim-core";
import { SIM_WORKER_BOOT_FAILURE_KEY } from "@slopcad/sim-core";
import { createDefaultSimEngine } from "@slopcad/sim-flow";

/**
 * The dedicated-worker scope this entry needs: the message-port surface
 * plus `close()`, the self-termination the boot-failure bridge uses to
 * retire the thread once its report has crossed the channel.
 */
interface SelfCloseableWorkerScope extends SimWebWorkerMessagePort {
  close(): void;
}

function isSelfCloseableWorkerScope(
  input: unknown,
): input is SelfCloseableWorkerScope {
  if (!isSimWebWorkerMessagePort(input)) return false;
  return typeof (input as { readonly close?: unknown }).close === "function";
}

const scope: unknown = self;
if (!isSelfCloseableWorkerScope(scope)) {
  throw new Error(
    "the workbench sim worker entry needs the dedicated worker message scope (postMessage/addEventListener/close on self).",
  );
}

const transport: SimWorkerTransport = {
  send(data: unknown): void {
    scope.postMessage(data);
  },
  onMessage(listener: (data: unknown) => void): () => void {
    const onEvent = (event: { readonly data: unknown }): void => {
      listener(event.data);
    };
    scope.addEventListener("message", onEvent);
    return () => {
      scope.removeEventListener("message", onEvent);
    };
  },
};

// Started, deliberately not awaited: module evaluation returns
// synchronously so the worker's event loop stays free, while the routed
// engine builds and the server subscribes. The `.catch` is the
// hosting-failure bridge (the sim-core web entry's own discipline).
hostSimWorker({ transport, createEngine: createDefaultSimEngine }).catch(
  (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    transport.send({
      [SIM_WORKER_BOOT_FAILURE_KEY]: `hosting the routed sim engine failed: ${detail}`,
    });
    scope.close();
  },
);
