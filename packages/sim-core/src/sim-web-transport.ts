/**
 * The browser real-worker transport of the sim protocol (Phase 61b): a
 * {@link SimWorkerTransport} over a Web Workers message channel — the
 * kernel protocol's `worker-web-transport`, restated. One function serves
 * both ends of a dedicated worker channel: on the main thread pass the
 * `Worker` created with the bundler-hosted entry pattern; inside the worker
 * pass its `self` scope.
 *
 * The port is a structural interface, not the DOM `Worker` type, so this
 * module typechecks under any `lib` configuration and a fake port can drive
 * the unit tests; real `Worker` and dedicated-worker `self` satisfy it.
 */

import type { SimWorkerTransport } from "./sim-transport";

/**
 * The message-channel surface this adapter needs from either end of a
 * dedicated web worker channel (`Worker` on the main thread, `self` inside
 * the worker).
 */
export interface SimWebWorkerMessagePort {
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
 * the sim browser worker entry uses it to acquire `globalThis` honestly.
 */
export function isSimWebWorkerMessagePort(
  input: unknown,
): input is SimWebWorkerMessagePort {
  if (!isPlainRecord(input)) return false;
  return (
    typeof input.postMessage === "function" &&
    typeof input.addEventListener === "function" &&
    typeof input.removeEventListener === "function"
  );
}

/** Wraps one end of a dedicated web worker channel as a transport. */
export function createSimWebWorkerTransport(
  port: SimWebWorkerMessagePort,
): SimWorkerTransport {
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
