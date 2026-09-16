/**
 * The browser real-worker transport (Phase 10.3): a {@link WorkerTransport}
 * over a Web Workers message channel — the API shape the Phase 10.2
 * interface was modeled on, so this adapter is message moving only: `send`
 * calls `postMessage`, `onMessage` subscribes through
 * `addEventListener("message")` and unwraps `event.data`.
 *
 * One function serves both ends of a dedicated worker channel: on the main
 * thread pass the `Worker` created with the bundler-hosted entry pattern
 * (`new Worker(new URL(<entry>, import.meta.url), { type: "module" })`, the
 * Phase 1.6 spike syntax); inside the worker pass its `self` scope.
 * Delivery order to multiple listeners is subscription order, as the DOM
 * dispatches.
 *
 * The port is a structural interface, not the DOM `Worker` type, so this
 * module typechecks under any `lib` configuration and a fake port can drive
 * the unit tests; real `Worker` and dedicated-worker `self` satisfy it.
 *
 * Browser hosting note for apps/web (the Phase 10 phase-wide gate, not this
 * module): the worker entry — `@slopcad/cad-kernel-manifold`'s
 * `manifold-worker.web` — pins the Manifold WASM asset itself (`?url` +
 * `locateFile`, per the spike findings); the app only creates the Worker on
 * that entry with the module-worker syntax and wraps it here.
 */

import type { WorkerTransport } from "./worker-transport";

/**
 * The message-channel surface this adapter needs from either end of a
 * dedicated web worker channel (`Worker` on the main thread, `self` inside
 * the worker).
 */
export interface WebWorkerMessagePort {
  /** Posts `data` to the other end (the single-argument `postMessage`). */
  postMessage(data: unknown): void;
  /** Subscribes to messages arriving on this end, as DOM listeners do. */
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  /** Unsubscribes a listener previously added with `addEventListener`. */
  removeEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Type guard for an untrusted scope claiming the web worker port shape —
 * the browser worker entry uses it to acquire `globalThis` honestly.
 */
export function isWebWorkerMessagePort(
  input: unknown,
): input is WebWorkerMessagePort {
  if (!isPlainRecord(input)) return false;
  return (
    typeof input.postMessage === "function" &&
    typeof input.addEventListener === "function" &&
    typeof input.removeEventListener === "function"
  );
}

/** Wraps one end of a dedicated web worker channel as a transport. */
export function createWebWorkerTransport(
  port: WebWorkerMessagePort,
): WorkerTransport {
  return {
    send(data: unknown): void {
      port.postMessage(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      const onEvent = (event: { readonly data: unknown }): void => {
        listener(event.data);
      };
      port.addEventListener("message", onEvent);
      return () => {
        port.removeEventListener("message", onEvent);
      };
    },
  };
}
