/**
 * The browser entry of the OpenCascade worker (Phase 21.2): runs as a module
 * Web Worker and hosts the real OpenCascade kernel as a worker-protocol
 * responder over the web transport adapter — the twin of the Manifold web
 * entry, with the same two browser-specific disciplines plus one addition.
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
 * while early requests buffer. A hosting failure rejects the started
 * promise — an unhandled rejection on the worker scope (browser console
 * and error reporting) with a channel that will never answer; requests
 * dispatched to the dead channel simply never settle on their own.
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
import type { WorkerTransport } from "@slopcad/cad-kernel";
import { isWebWorkerMessagePort } from "@slopcad/cad-kernel";

import { hostOcctWorker } from "./occt-worker";
import {
  OCCT_WORKER_BOOT_REPORT_KEY,
  OCCT_WORKER_BOOT_WASM_URL_KEY,
} from "./occt-worker-boot-report";
import { createOcctRuntime } from "./occt-runtime";

const scope: unknown = globalThis;
if (!isWebWorkerMessagePort(scope)) {
  throw new Error(
    "occt-worker.web needs the dedicated worker message scope (postMessage/addEventListener on self).",
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

// Started, deliberately not awaited (the `void` operator marks the float
// explicit): module evaluation returns synchronously so the worker's event
// loop stays free for the WASM boot, while early requests buffer above. A
// hosting failure remains visible — the rejected promise reports as an
// unhandled rejection on the worker scope, and the channel never answers.
void hostOcctWorker({
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
});
