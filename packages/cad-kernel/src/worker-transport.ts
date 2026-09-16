/**
 * The generic worker transport (Phase 10.2): the minimal interface a channel
 * must offer for the worker protocol's client and server to run over it.
 *
 * The transport knows NOTHING about Manifold or geometry — it moves messages.
 * Its shape is deliberately the shape of the Web Workers API, so the Phase
 * 10.3 real-worker transport is a thin adapter and nothing above it changes:
 *
 * - `send` posts a message to the other end. Its parameter is `unknown`,
 *   exactly like what `postMessage` delivers: senders build protocol messages
 *   with the Phase 10.1 builders, and every receiver re-parses with
 *   `parseWorkerMessage` at its own trust boundary — so the in-memory
 *   transport exercises the same parse discipline a real channel will.
 * - `onMessage` subscribes a listener to everything arriving on this end and
 *   returns its unsubscribe function.
 *
 * ## In-memory dispatch: microtask-delayed, send-order FIFO
 *
 * {@link createInMemoryTransportPair} delivers every sent message inside a
 * `queueMicrotask` callback — never synchronously inside `send`. Three
 * properties follow, and determinism is the bar for all of them:
 *
 * 1. **Order** — the environment's microtask queue is FIFO, so messages are
 *    delivered in exactly the order they were sent, across both directions of
 *    the pair. No timers, no randomness, no scheduler dependence; the same
 *    send sequence always produces the same delivery sequence.
 * 2. **Asynchrony** — delivery happens after `send` returns, mirroring
 *    `postMessage` (a message is never observed inside the call that posted
 *    it) and preventing reentrant feedback between the two ends.
 * 3. **Fidelity** — because delivery is asynchronous, the cancellation
 *    windows pinned in `./worker-cancellation` (a cancel processed while a
 *    request sits between `start` and `finish`) are observable over this
 *    transport exactly as they will be over a real worker.
 *
 * The pair passes each message by reference; protocol payloads are plain
 * serializable data (pinned by the Phase 10.1 tests), and cloning is a
 * transport-implementation concern, not an interface one.
 */

/** One end of a worker channel: post to the other end, hear this end. */
export interface WorkerTransport {
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
 * The two wired ends of an in-memory channel: `client` is the end a
 * {@link WorkerClient} sends requests on, `server` the end a
 * {@link WorkerServer} answers from. The names are roles — mechanically each
 * end just delivers what the other sends.
 */
export interface InMemoryWorkerTransportPair {
  readonly client: WorkerTransport;
  readonly server: WorkerTransport;
}

type End = keyof InMemoryWorkerTransportPair;

/**
 * Creates a connected in-memory transport pair. Dispatch is microtask-delayed
 * and send-order FIFO (see the module doc). As with a real message channel, a
 * listener hears exactly the messages whose delivery runs while it is
 * subscribed — subscribe before sending to observe a message, and a listener
 * attached after a message was delivered never sees it replayed.
 */
export function createInMemoryTransportPair(): InMemoryWorkerTransportPair {
  const listeners: Record<End, Array<(data: unknown) => void>> = {
    client: [],
    server: [],
  };
  const peerOf = (end: End): End => (end === "client" ? "server" : "client");
  const makeEnd = (end: End): WorkerTransport => ({
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
