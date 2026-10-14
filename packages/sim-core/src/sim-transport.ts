/**
 * The generic sim worker transport (Phase 61b): the minimal interface a
 * channel must offer for the sim worker protocol's client and server to run
 * over it — the kernel protocol's `worker-transport`
 * (`@slopcad/cad-kernel`), restated under sim-core's zero-runtime-
 * dependency stance. The transport knows NOTHING about solvers or scenarios
 * — it moves messages, shaped exactly like the Web Workers API so the real
 * worker transports are thin adapters and nothing above them changes:
 *
 * - `send` posts a message to the other end. Its parameter is `unknown`,
 *   exactly like what `postMessage` delivers: senders build protocol
 *   messages with the protocol builders, and every receiver re-parses with
 *   `parseSimWorkerMessage` at its own trust boundary.
 * - `onMessage` subscribes a listener to everything arriving on this end and
 *   returns its unsubscribe function.
 *
 * ## In-memory dispatch: microtask-delayed, send-order FIFO
 *
 * {@link createSimInMemoryTransportPair} delivers every sent message inside
 * a `queueMicrotask` callback — never synchronously inside `send`. Order is
 * the environment's FIFO microtask queue (deterministic: the same send
 * sequence always produces the same delivery sequence), delivery is
 * asynchronous (mirroring `postMessage`, and preventing reentrant feedback),
 * and the cancellation windows pinned in `./sim-worker-cancellation` are
 * observable exactly as they will be over a real worker.
 */

/** One end of a sim worker channel: post to the other end, hear this end. */
export interface SimWorkerTransport {
  /**
   * Posts a message to the other end. Accepts `unknown` so senders of
   * non-protocol data stay typeable; receivers must never trust it.
   */
  send(data: unknown): void;
  /**
   * Subscribes a listener to every message arriving on this end. Returns the
   * function that unsubscribes it. Delivery order to multiple listeners is
   * subscription order.
   */
  onMessage(listener: (data: unknown) => void): () => void;
}

/**
 * The two wired ends of an in-memory sim channel: `client` is the end a
 * sim worker client sends requests on, `server` the end the worker server
 * answers from. The names are roles — mechanically each end just delivers
 * what the other sends.
 */
export interface SimInMemoryWorkerTransportPair {
  readonly client: SimWorkerTransport;
  readonly server: SimWorkerTransport;
}

type End = keyof SimInMemoryWorkerTransportPair;

/**
 * Creates a connected in-memory transport pair. Dispatch is microtask-delayed
 * and send-order FIFO. As with a real message channel, a listener hears
 * exactly the messages whose delivery runs while it is subscribed.
 */
export function createSimInMemoryTransportPair(): SimInMemoryWorkerTransportPair {
  const listeners: Record<End, Array<(data: unknown) => void>> = {
    client: [],
    server: [],
  };
  const peerOf = (end: End): End => (end === "client" ? "server" : "client");
  const makeEnd = (end: End): SimWorkerTransport => ({
    send(data: unknown): void {
      const peer = peerOf(end);
      queueMicrotask(() => {
        // Snapshot: a listener that unsubscribes while the batch is being
        // delivered must not change who else hears this message.
        for (const listener of [...listeners[peer]]) listener(data);
      });
    },
    onMessage(listener: (data: unknown) => void): () => void {
      listeners[end].push(listener);
      return () => {
        const index = listeners[end].indexOf(listener);
        if (index >= 0) listeners[end].splice(index, 1);
      };
    },
  });
  return { client: makeEnd("client"), server: makeEnd("server") };
}
