/**
 * The Node host of the Manifold worker (Phase 10.3): creates a real
 * `node:worker_threads` thread running the `./manifold-worker.node` entry
 * and returns the fully wired channel — a {@link WorkerClient} over the
 * node transport adapter, the thread's identity, and the termination rules.
 *
 * The hosting pattern itself lives in the kernel abstraction's shared
 * {@link createNodeWorkerChannel} factory (the one implementation the
 * OpenCascade twin and every later Node kernel channel consumes); this
 * module pins the Manifold-specific configuration onto it — the entry
 * file and the thread-echo environment variable — and re-exports the
 * factory's channel and exit types under this package's names, so
 * consumers keep importing the Manifold surface they always did. See the
 * factory's module doc for the two shared disciplines (termination
 * settlement, TypeScript-source loading in a plain Node worker).
 */

import type {
  NodeWorkerChannel,
  NodeWorkerChannelExit,
} from "@slopcad/cad-kernel";
import {
  createNodeWorkerChannel,
  nodeWorkerThreadEcho,
} from "@slopcad/cad-kernel";

/**
 * Environment variable enabling the node entry's test-only thread echo (see
 * the `./manifold-worker.node` module doc): `1` posts one non-protocol
 * message carrying the worker's `threadId` before hosting starts.
 */
export const NODE_MANIFOLD_WORKER_ECHO_ENV =
  "SLOPCAD_MANIFOLD_WORKER_ECHO_THREAD_ID";

/** Message key of the thread echo: maps to the worker's `threadId`. */
export const NODE_MANIFOLD_WORKER_THREAD_ECHO_KEY =
  "slopcadManifoldWorkerThreadId";

/**
 * How the Manifold worker thread ended: `code` is its exit code
 * (terminating a healthy thread yields a non-zero code; `errorMessage` is
 * set only when the thread crashed before or during hosting).
 */
export type NodeManifoldWorkerExit = NodeWorkerChannelExit;

/** Options of {@link createNodeManifoldWorkerChannel}. */
export interface NodeManifoldWorkerChannelOptions {
  /**
   * Starts the entry with the test-only thread echo enabled — for the
   * off-thread proof tests. The echo message is ignored by every protocol
   * endpoint (the client's parse boundary rejects it).
   */
  readonly echoThreadId?: boolean;
}

/** A live Manifold worker thread and the main-thread handle onto it. */
export type NodeManifoldWorkerChannel = NodeWorkerChannel;

/**
 * Reads the worker's thread echo out of a channel message, or `null` for
 * every other message (protocol traffic included — the echo is plain
 * non-protocol data the client's parse boundary drops).
 */
export function nodeManifoldWorkerThreadEcho(data: unknown): number | null {
  return nodeWorkerThreadEcho(data, NODE_MANIFOLD_WORKER_THREAD_ECHO_KEY);
}

/** Creates a real Manifold worker thread and the channel onto it. */
export function createNodeManifoldWorkerChannel(
  options: NodeManifoldWorkerChannelOptions = {},
): NodeManifoldWorkerChannel {
  return createNodeWorkerChannel({
    entryUrl: new URL("./manifold-worker.node.ts", import.meta.url),
    echoEnv:
      options.echoThreadId === true ? NODE_MANIFOLD_WORKER_ECHO_ENV : undefined,
  });
}
