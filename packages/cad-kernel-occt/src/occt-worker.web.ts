/**
 * The browser entry of the OpenCascade worker (Phase 21.2): runs as a module
 * Web Worker and hosts the real OpenCascade kernel as a worker-protocol
 * responder over the web transport adapter — the twin of the Manifold web
 * entry, with the same browser-specific disciplines: the WASM asset pin,
 * the synchronous buffering port subscription, the self-measured boot
 * report, and the hosting-failure bridge that reports a dead boot instead
 * of leaving the channel silent.
 *
 * Composition only — `./occt-worker` holds the shared hosting core. The
 * browser runtime pins the ~22 MB WASM asset exactly as the pre-spike proved
 * necessary (and as the Manifold entry does for its asset): `import wasmUrl
 * from "replicad-opencascadejs/wasm?url"` handed to the runtime as
 * `locateFile`, because the emscripten glue's own `new URL(...,
 * import.meta.url)` resolution points into Vite's prebundle directory where
 * the asset does not exist.
 *
 * ## A synchronous port subscription that buffers until the server is live
 *
 * The hosted server subscribes to the channel only after the WASM runtime
 * boots (its subscription awaits `createOcctRuntime`), but Chromium
 * dispatches port messages to a module worker as soon as the module graph
 * starts evaluating — a request posted immediately after `new Worker(...)`
 * arrives long before the server's listener exists and would be dispatched
 * into the void, hanging the caller's first computation forever (the
 * failure the Phase 10 phase-level browser gate surfaced for Manifold).
 * OCCT's boot is an order of magnitude slower than Manifold's (~180 ms of
 * class init in Node on top of the asset fetch, probed), which makes this
 * window wider, not narrower. The entry therefore subscribes synchronously
 * during module evaluation and buffers every message until the server goes
 * live, replaying the backlog in arrival order — a client may fire its
 * first request immediately after `new Worker(...)` with no readiness
 * handshake, mirroring the node channel's buffering semantics.
 *
 * Module evaluation completes synchronously: the hosting is *started*, not
 * awaited, and the WASM boot proceeds over the worker's normal event loop
 * while early requests buffer. A hosting failure cannot hang the channel:
 * the floated promise is caught, and while the thread can still speak the
 * failure is posted to the main thread as the boot-failure report (see
 * `@slopcad/cad-kernel`'s `worker-boot-failure-report`) — the marker
 * `bootWorkerChannel` settles every in-flight request terminally on, so the
 * hosting surface learns the failure and re-boots on the next exchange —
 * after which the entry closes itself. (Without the bridge the rejection
 * would stay inside this scope — an unhandled rejection with a channel that
 * never answers.)
 *
 * ## The boot report
 *
 * Because OCCT's boot cost is a documented, load-bearing number (the
 * pre-spike's ~176–181 ms Node init plus the ~22 MB asset fetch), the entry
 * measures its own initialization — from module evaluation to runtime
 * ready — and posts it together with the bundler-pinned URL of the asset it
 * fetched as the boot report (see `./occt-worker-boot-report`) before
 * hosting starts, so hosting surfaces (the `/worker-occt` fixture) can
 * display honest numbers instead of hiding the cost. The report is one
 * plain non-protocol message; every protocol endpoint's parse boundary
 * drops it.
 */

import wasmUrl from "replicad-opencascadejs/wasm?url";
import type {
  WebWorkerMessagePort,
  WorkerTransport,
} from "@slopcad/cad-kernel";
import {
  isWebWorkerMessagePort,
  WORKER_BOOT_FAILURE_KEY,
} from "@slopcad/cad-kernel";

import { hostOcctWorker } from "./occt-worker";
import {
  OCCT_WORKER_BOOT_REPORT_KEY,
  OCCT_WORKER_BOOT_WASM_URL_KEY,
} from "./occt-worker-boot-report";
import { createOcctRuntime } from "./occt-runtime";

/**
 * The dedicated-worker scope this entry needs: the message-port surface
 * plus `close()`, the self-termination the boot-failure bridge uses to
 * retire the thread once its report has crossed the channel.
 */
interface SelfCloseableWorkerScope extends WebWorkerMessagePort {
  close(): void;
}

function isSelfCloseableWorkerScope(
  input: unknown,
): input is SelfCloseableWorkerScope {
  if (!isWebWorkerMessagePort(input)) return false;
  return typeof (input as { readonly close?: unknown }).close === "function";
}

const scope: unknown = globalThis;
if (!isSelfCloseableWorkerScope(scope)) {
  throw new Error(
    "occt-worker.web needs the dedicated worker message scope (postMessage/addEventListener/close on self).",
  );
}

/** Port messages that arrived before the hosted server subscribed. */
const backlog: unknown[] = [];
/** The live server's delivery sink, absent until it subscribes. */
let deliver: ((data: unknown) => void) | undefined;

const transport: WorkerTransport = {
  send(data: unknown): void {
    scope.postMessage(data);
  },
  onMessage(listener: (data: unknown) => void): () => void {
    deliver = listener;
    const queued = backlog.splice(0, backlog.length);
    for (const message of queued) {
      listener(message);
    }
    return () => {
      if (deliver === listener) {
        deliver = undefined;
      }
    };
  },
};

// Subscribed during module evaluation — nothing dispatched to this port is
// ever lost, including requests that raced the worker's own script fetch.
scope.addEventListener("message", (event: { readonly data: unknown }) => {
  const message = event.data;
  if (deliver === undefined) {
    backlog.push(message);
  } else {
    deliver(message);
  }
});

const bootStartedAt = performance.now();

// Started, deliberately not awaited: module evaluation returns synchronously
// so the worker's event loop stays free for the WASM boot, while early
// requests buffer above. The `.catch` is the hosting-failure bridge: the
// rejection never fires the main thread's Worker `error` event, so it is
// reported as the boot-failure report — `bootWorkerChannel`'s marker for
// settling every in-flight request terminally — and the thread retires
// itself instead of lingering as a channel that never answers.
hostOcctWorker({
  transport,
  createRuntime: async () => {
    const runtime = await createOcctRuntime({
      locateFile: () => wasmUrl,
    });
    // The boot report rides before any protocol response can: the hosted
    // server has not subscribed yet, and the report is plain non-protocol
    // data for every protocol endpoint downstream. The asset URL rides
    // along because only this side of the channel knows it.
    transport.send({
      [OCCT_WORKER_BOOT_REPORT_KEY]: performance.now() - bootStartedAt,
      [OCCT_WORKER_BOOT_WASM_URL_KEY]: wasmUrl,
    });
    return runtime;
  },
}).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  transport.send({
    [WORKER_BOOT_FAILURE_KEY]: `hosting the OpenCascade kernel failed: ${detail}`,
  });
  scope.close();
});
