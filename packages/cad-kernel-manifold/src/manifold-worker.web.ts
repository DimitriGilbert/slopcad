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
 * Phase 29's performance baselines made Manifold's boot cost a documented,
 * load-bearing number (the WASM-startup baseline and budget), so the entry
 * measures its own initialization — from module evaluation to runtime
 * ready — and posts it together with the bundler-pinned URL of the asset it
 * fetched as the boot report (see `./manifold-worker-boot-report`, the twin
 * of the OCCT entry's report) before hosting starts, so hosting surfaces
 * (the `/perf` fixture) can read honest numbers instead of hiding the
 * cost. The report is one plain non-protocol message; every protocol
 * endpoint's parse boundary drops it.
 */

import wasmUrl from "manifold-3d/manifold.wasm?url";
import type {
  WebWorkerMessagePort,
  WorkerTransport,
} from "@slopcad/cad-kernel";
import {
  isWebWorkerMessagePort,
  WORKER_BOOT_FAILURE_KEY,
} from "@slopcad/cad-kernel";

import { hostManifoldWorker } from "./manifold-worker";
import {
  MANIFOLD_WORKER_BOOT_REPORT_KEY,
  MANIFOLD_WORKER_BOOT_WASM_URL_KEY,
} from "./manifold-worker-boot-report";
import { createManifoldRuntime } from "./manifold-runtime";

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
    "manifold-worker.web needs the dedicated worker message scope (postMessage/addEventListener/close on self).",
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

// Started, deliberately not awaited: module evaluation returns synchronously
// so the worker's event loop stays free for the WASM boot, while early
// requests buffer above. The `.catch` is the hosting-failure bridge: the
// rejection never fires the main thread's Worker `error` event, so it is
// reported as the boot-failure report — `bootWorkerChannel`'s marker for
// settling every in-flight request terminally — and the thread retires
// itself instead of lingering as a channel that never answers.
const bootStartedAt = performance.now();
hostManifoldWorker({
  transport,
  createRuntime: async () => {
    const runtime = await createManifoldRuntime({ locateFile: () => wasmUrl });
    // The boot report rides before any protocol response can: the hosted
    // server has not subscribed yet, and the report is plain non-protocol
    // data for every protocol endpoint downstream. The asset URL rides
    // along because only this side of the channel knows it.
    transport.send({
      [MANIFOLD_WORKER_BOOT_REPORT_KEY]: performance.now() - bootStartedAt,
      [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: wasmUrl,
    });
    return runtime;
  },
}).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  transport.send({
    [WORKER_BOOT_FAILURE_KEY]: `hosting the Manifold kernel failed: ${detail}`,
  });
  scope.close();
});
