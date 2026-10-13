/**
 * The bundler-hosted entry of the sim worker for the workbench (Phase
 * 61b, extended 63c, 65c, 67c, and 68c): hosts the ROUTED DEFAULT
 * ENGINE — the real 2D LBM engine for flow scenarios (`@slopcad/sim-flow`,
 * Phase 63c), the real conduction/CHT thermal engines (Phase 65c),
 * the real dynamics engine (`@slopcad/sim-dynamics`, Phase 67c),
 * the real combustion engine (`@slopcad/sim-combustion`, Phase 68c),
 * `structural` declined by the Phase 69 carve —
 * as a sim worker-protocol responder over the dedicated-worker message
 * scope. This is `@slopcad/sim-core`'s `sim-worker.web` entry restated
 * with the one difference that matters: `createEngine` selects the real
 * engine. The module-worker URL stays an INLINE import — the bundler
 * statically rewrites exactly this form into its worker chunks.
 *
 * The dynamics and combustion routing compose at THIS host (the
 * layering rule: the flow package routes flow/thermal, the dynamics
 * package owns its own engine, the combustion package owns its own,
 * and the workbench's worker entry is the one place all are known):
 * a dynamics-kind request goes to the dynamics engine, a
 * combustion-kind request to the combustion engine, every other kind
 * to the flow package's routed default — each engine declining the
 * kinds it does not solve, never a silent misroute.
 *
 * A hosting failure cannot hang the channel: the hosting promise is
 * caught, and while the thread can still speak the failure is posted to
 * the main thread as the boot-failure report the crash-settling boot
 * (`bootSimWorkbenchWorker`) settles every in-flight request terminally
 * on — after which the entry closes itself.
 */

import type { SimEngine } from "@slopcad/sim-core";
import type { SimWorkerTransport } from "@slopcad/sim-core";
import type { SimWebWorkerMessagePort } from "@slopcad/sim-core";
import { hostSimWorker } from "@slopcad/sim-core";
import { isSimWebWorkerMessagePort } from "@slopcad/sim-core";
import { SIM_WORKER_BOOT_FAILURE_KEY } from "@slopcad/sim-core";
import { createDefaultSimEngine } from "@slopcad/sim-flow";
import { createCombustionSimEngine } from "@slopcad/sim-combustion";
import { createDynamicsSimEngine } from "@slopcad/sim-dynamics";

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

// The workbench's routed engine: the flow package's default (flow +
// thermal) with the dynamics and combustion engines composed in front
// — the kind router the hosting below serves (each engine declining
// the kinds it does not solve, never a silent misroute).
function createWorkbenchEngine(): SimEngine {
  const routed = createDefaultSimEngine();
  const dynamics = createDynamicsSimEngine();
  const combustion = createCombustionSimEngine();
  return {
    id: "workbench-routed-sim",
    supportedKinds: [
      ...new Set([
        ...routed.supportedKinds,
        ...dynamics.supportedKinds,
        ...combustion.supportedKinds,
      ]),
    ],
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) => {
      if (dynamics.supportedKinds.includes(request.compiled.kind)) {
        return dynamics.run(request, onProgress, onFieldChunk);
      }
      if (combustion.supportedKinds.includes(request.compiled.kind)) {
        return combustion.run(request, onProgress, onFieldChunk);
      }
      return routed.run(request, onProgress, onFieldChunk);
    },
  };
}

// Started, deliberately not awaited: module evaluation returns
// synchronously so the worker's event loop stays free, while the routed
// engine builds and the server subscribes. The `.catch` is the
// hosting-failure bridge (the sim-core web entry's own discipline).
hostSimWorker({ transport, createEngine: createWorkbenchEngine }).catch(
  (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    transport.send({
      [SIM_WORKER_BOOT_FAILURE_KEY]: `hosting the routed sim engine failed: ${detail}`,
    });
    scope.close();
  },
);
