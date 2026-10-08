/**
 * The browser entry of the sim worker (Phase 61b): runs as a module Web
 * Worker and hosts the fake engine as a sim worker-protocol responder over
 * the web transport adapter — the Manifold web entry's pattern
 * (`@slopcad/cad-kernel-manifold`'s `manifold-worker.web`) minus the WASM
 * boot: sim hosting builds the engine synchronously today, so the server
 * subscribes during module evaluation and no request can race it.
 *
 * Apps host this entry with the bundler's module-worker syntax —
 * `new Worker(new URL("<path to this file>", import.meta.url),
 * { type: "module" })` — and wrap the main-thread end with
 * {@link bootSimWorkerChannel} (see `./sim-worker-boot`).
 *
 * A hosting failure cannot hang the channel: the hosting promise is caught,
 * and while the thread can still speak the failure is posted to the main
 * thread as the boot-failure report (see `./sim-boot-failure-report`) — the
 * marker `bootSimWorkerChannel` settles every in-flight request terminally
 * on — after which the entry closes itself. (Without the bridge the
 * rejection would stay inside this scope — an unhandled rejection with a
 * channel that never answers.)
 */

import type { SimWebWorkerMessagePort } from "./sim-web-transport";
import type { SimWorkerTransport } from "./sim-transport";

import { isSimWebWorkerMessagePort } from "./sim-web-transport";
import { hostSimWorker } from "./sim-worker";
import { SIM_WORKER_BOOT_FAILURE_KEY } from "./sim-boot-failure-report";

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

const scope: unknown = globalThis;
if (!isSelfCloseableWorkerScope(scope)) {
  throw new Error(
    "sim-worker.web needs the dedicated worker message scope (postMessage/addEventListener/close on self).",
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

// Started, deliberately not awaited: module evaluation returns synchronously
// so the worker's event loop stays free, while the engine builds and the
// server subscribes. The `.catch` is the hosting-failure bridge: the
// rejection never fires the main thread's Worker `error` event, so it is
// reported as the boot-failure report and the thread retires itself instead
// of lingering as a channel that never answers.
hostSimWorker({ transport }).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  transport.send({
    [SIM_WORKER_BOOT_FAILURE_KEY]: `hosting the sim engine failed: ${detail}`,
  });
  scope.close();
});
