/**
 * The Node real-worker transport (Phase 10.3): a {@link WorkerTransport}
 * over a `node:worker_threads` message port — the parent-side `Worker` or
 * the worker-side `parentPort`. As thin as its web twin: `send` calls
 * `postMessage`, `onMessage` subscribes through the port's EventEmitter
 * surface, and delivery order to multiple listeners is subscription order.
 *
 * The port is a structural interface shaped after
 * `worker_threads.MessagePort` (its `on`/`off` listener methods), so this
 * module imports nothing from Node, typechecks in any environment, and
 * accepts the real port (or `Worker`) wherever a channel end is needed.
 */

import type { WorkerTransport } from "./worker-transport";

/**
 * The message-channel surface this adapter needs from either end of a
 * `node:worker_threads` channel (a `Worker` on the parent side, a
 * `parentPort` inside the worker).
 */
export interface NodeWorkerMessagePort {
  /** Posts `data` to the other end (structured clone, like the DOM). */
  postMessage(data: unknown): void;
  /** Subscribes to messages arriving on this end. */
  on(event: "message", listener: (data: unknown) => void): void;
  /** Unsubscribes a listener previously added with `on`. */
  off(event: "message", listener: (data: unknown) => void): void;
}

/** Wraps one end of a `node:worker_threads` channel as a transport. */
export function createNodeWorkerTransport(
  port: NodeWorkerMessagePort,
): WorkerTransport {
  return {
    send(data: unknown): void {
      port.postMessage(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      port.on("message", listener);
      return () => {
        port.off("message", listener);
      };
    },
  };
}
