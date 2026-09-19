/**
 * The Node host of the OpenCascade worker (Phase 21.2): creates a real
 * `node:worker_threads` thread running the `./occt-worker.node` entry and
 * returns the fully wired channel — a {@link WorkerClient} over the node
 * transport adapter, the thread's identity, and the termination rules.
 *
 * The hosting pattern itself lives in the kernel abstraction's shared
 * {@link createNodeWorkerChannel} factory (the one implementation the
 * Manifold twin and every later Node kernel channel consumes); this module
 * pins the OpenCascade-specific configuration onto it — the entry file and
 * the thread-echo environment variable — and re-exports the factory's
 * channel and exit types under this package's names, so consumers keep
 * importing the OCCT surface they always did. See the factory's module doc
 * for the two shared disciplines (termination settlement,
 * TypeScript-source loading in a plain Node worker).
 */

import type {
  NodeWorkerChannel,
  NodeWorkerChannelExit,
} from "@slopcad/cad-kernel/node-worker-channel";
import {
  createNodeWorkerChannel,
  nodeWorkerThreadEcho,
} from "@slopcad/cad-kernel/node-worker-channel";

/**
 * Environment variable enabling the node entry's test-only thread echo (see
 * the `./occt-worker.node` module doc): `1` posts one non-protocol message
 * carrying the worker's `threadId` before hosting starts.
 */
export const NODE_OCCT_WORKER_ECHO_ENV = "SLOPCAD_OCCT_WORKER_ECHO_THREAD_ID";

/** Message key of the thread echo: maps to the worker's `threadId`. */
export const NODE_OCCT_WORKER_THREAD_ECHO_KEY = "slopcadOcctWorkerThreadId";

/**
 * How the OpenCascade worker thread ended: `code` is its exit code
 * (terminating a healthy thread yields a non-zero code; `errorMessage` is
 * set only when the thread crashed before or during hosting).
 */
export type NodeOcctWorkerExit = NodeWorkerChannelExit;

/** Options of {@link createNodeOcctWorkerChannel}. */
export interface NodeOcctWorkerChannelOptions {
  /**
   * Starts the entry with the test-only thread echo enabled — for the
   * off-thread proof tests. The echo message is ignored by every protocol
   * endpoint (the client's parse boundary rejects it).
   */
  readonly echoThreadId?: boolean;
}

/** A live OpenCascade worker thread and the main-thread handle onto it. */
export type NodeOcctWorkerChannel = NodeWorkerChannel;

/**
 * Reads the worker's thread echo out of a channel message, or `null` for
 * every other message (protocol traffic included — the echo is plain
 * non-protocol data the client's parse boundary drops).
 */
export function nodeOcctWorkerThreadEcho(data: unknown): number | null {
  return nodeWorkerThreadEcho(data, NODE_OCCT_WORKER_THREAD_ECHO_KEY);
}

/** Creates a real OpenCascade worker thread and the channel onto it. */
export function createNodeOcctWorkerChannel(
  options: NodeOcctWorkerChannelOptions = {},
): NodeOcctWorkerChannel {
  return createNodeWorkerChannel({
    entryUrl: new URL("./occt-worker.node.ts", import.meta.url),
    echoEnv:
      options.echoThreadId === true ? NODE_OCCT_WORKER_ECHO_ENV : undefined,
  });
}
