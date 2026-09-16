/**
 * The browser entry of the Manifold worker (Phase 10.3): runs as a module
 * Web Worker and hosts the real Manifold kernel as a worker-protocol
 * responder over the web transport adapter.
 *
 * Composition only — `./manifold-worker` holds the shared hosting core. The
 * browser runtime pins the WASM asset exactly as the Phase 1.6 spike proved
 * necessary under Vite dependency optimization: `import wasmUrl from
 * "manifold-3d/manifold.wasm?url"` handed to the runtime as `locateFile`,
 * because manifold.js's own `new URL("manifold.wasm", import.meta.url)`
 * resolution points into the prebundle directory where the asset does not
 * exist.
 *
 * Apps host this entry with the bundler's module-worker syntax —
 * `new Worker(new URL("<path to this file>", import.meta.url),
 * { type: "module" })` — and wrap either end with
 * `createWebWorkerTransport` (see `@slopcad/cad-kernel`'s
 * `worker-web-transport`).
 *
 * ## A synchronous port subscription that buffers until the server is live
 *
 * The hosted server subscribes to the channel only after the WASM runtime
 * boots (its subscription awaits `createManifoldRuntime`), but Chromium
 * dispatches port messages to a module worker as soon as the module graph
 * starts evaluating — a request posted immediately after `new Worker(...)`
 * arrives long before the server's listener exists and would be dispatched
 * into the void, hanging the caller's first computation forever (the
 * failure the Phase 10 phase-level browser gate surfaced). The entry
 * therefore subscribes synchronously during module evaluation and buffers
 * every message until the server goes live, replaying the backlog in
 * arrival order — a client may fire its first request immediately after
 * `new Worker(...)` with no readiness handshake, mirroring the node
 * channel's buffering semantics (see `./manifold-worker` tests).
 *
 * Module evaluation completes synchronously: the hosting is *started*, not
 * awaited, and the WASM boot proceeds over the worker's normal event loop
 * while early requests buffer. A hosting failure rejects the started
 * promise — an unhandled rejection on the worker scope (browser console
 * and error reporting) with a channel that will never answer; requests
 * dispatched to the dead channel simply never settle on their own.
 */

import wasmUrl from "manifold-3d/manifold.wasm?url";
import type { WorkerTransport } from "@slopcad/cad-kernel";
import { isWebWorkerMessagePort } from "@slopcad/cad-kernel";

import { hostManifoldWorker } from "./manifold-worker";
import { createManifoldRuntime } from "./manifold-runtime";

const scope: unknown = globalThis;
if (!isWebWorkerMessagePort(scope)) {
  throw new Error(
    "manifold-worker.web needs the dedicated worker message scope (postMessage/addEventListener on self).",
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

// Started, deliberately not awaited (the `void` operator marks the float
// explicit): module evaluation returns synchronously so the worker's event
// loop stays free for the WASM boot, while early requests buffer above. A
// hosting failure remains visible — the rejected promise reports as an
// unhandled rejection on the worker scope, and the channel never answers.
void hostManifoldWorker({
  transport,
  createRuntime: () => createManifoldRuntime({ locateFile: () => wasmUrl }),
});
