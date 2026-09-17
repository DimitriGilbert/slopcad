/**
 * The Node host of the OpenCascade worker (Phase 21.2): creates a real
 * `node:worker_threads` thread running the `./occt-worker.node` entry and
 * returns the fully wired channel — a {@link WorkerClient} over the node
 * transport adapter, the thread's identity, and the termination rules. The
 * twin of `@slopcad/cad-kernel-manifold`'s `node-manifold-worker`; see that
 * module's doc for the two shared disciplines below, which apply verbatim.
 *
 * ## Termination settlement
 *
 * No response can ever arrive on a dead channel, so the exit of the thread —
 * deliberate (`close`/`terminate`) or a crash — settles every still-pending
 * request through the client's close: the structured
 * `worker/transport-closed` failure, never a hanging promise. `close` is
 * the graceful form (settle first, then terminate and await the exit);
 * `terminate` is the abrupt one (the exit hook does the settling).
 * {@link NodeOcctWorkerChannel.exited} reports how the thread ended: the
 * exit code plus, for a crashed worker, the captured error message (the raw
 * failure also surfaces on the thread's stderr).
 *
 * ## Loading workspace TypeScript sources in a plain Node worker
 *
 * The workspace packages are consumed as bundler-resolution TypeScript
 * source (extensionless relative imports between siblings); Node 24 loads
 * such files through its own type stripping, which requires the extension.
 * The channel therefore starts the thread with an `execArgv` that
 * pre-imports a module registering one resolve hook — append `.ts` to a
 * failed extensionless relative specifier — before the entry loads. The
 * hook lives entirely inside the spawned thread (a data-URL module, no
 * build artifacts) and changes no behavior of the packages themselves.
 */

import { type WorkerOptions, Worker } from "node:worker_threads";
import type { WorkerClient, WorkerTransport } from "@slopcad/cad-kernel";
import { createNodeWorkerTransport, createWorkerClient } from "@slopcad/cad-kernel";

/**
 * Environment variable enabling the node entry's test-only thread echo (see
 * the `./occt-worker.node` module doc): `1` posts one non-protocol message
 * carrying the worker's `threadId` before hosting starts.
 */
export const NODE_OCCT_WORKER_ECHO_ENV =
  "SLOPCAD_OCCT_WORKER_ECHO_THREAD_ID";

/** Message key of the thread echo: maps to the worker's `threadId`. */
export const NODE_OCCT_WORKER_THREAD_ECHO_KEY =
  "slopcadOcctWorkerThreadId";

/**
 * How the worker thread ended: `code` is its exit code (terminating a
 * healthy thread yields a non-zero code; `errorMessage` is set only when
 * the thread crashed before or during hosting).
 */
export interface NodeOcctWorkerExit {
  readonly code: number;
  readonly errorMessage: string | null;
}

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
export interface NodeOcctWorkerChannel {
  /** The request/cancellation surface to the hosted kernel. */
  readonly client: WorkerClient;
  /** The main-thread end of the channel (observe or inject at the wire). */
  readonly transport: WorkerTransport;
  /** The real `threadId` of the worker thread (0 is a process main thread). */
  readonly threadId: number;
  /** Resolves when the thread exits, with its exit code and crash message. */
  readonly exited: Promise<NodeOcctWorkerExit>;
  /**
   * Graceful shutdown: settles every in-flight request with
   * `worker/transport-closed`, terminates the thread, and awaits its exit.
   * Callers wanting drained work await their requests first.
   */
  close(): Promise<void>;
  /**
   * Abrupt shutdown — the honest analog of a worker dying under load:
   * terminates the thread now, with the exit hook settling in-flight
   * requests. Resolves with the exit.
   */
  terminate(): Promise<NodeOcctWorkerExit>;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Reads the worker's thread echo out of a channel message, or `null` for
 * every other message (protocol traffic included — the echo is plain
 * non-protocol data the client's parse boundary drops).
 */
export function nodeOcctWorkerThreadEcho(data: unknown): number | null {
  if (!isPlainRecord(data)) return null;
  const echoed = data[NODE_OCCT_WORKER_THREAD_ECHO_KEY];
  return typeof echoed === "number" && Number.isInteger(echoed)
    ? echoed
    : null;
}

/**
 * The resolve hook that makes the workspace's bundler-style extensionless
 * relative imports loadable in a plain Node worker (see the module doc).
 * Registered from a data-URL module pre-imported via `execArgv`, so it
 * needs no file on disk.
 */
const SOURCE_RESOLUTION_HOOKS = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".ts")) {
      return next(specifier + ".ts", context);
    }
    throw error;
  }
}
`;

const SOURCE_RESOLUTION_IMPORT = `data:text/javascript,${encodeURIComponent(
  `import { register } from "node:module";\nregister("data:text/javascript,${encodeURIComponent(
    SOURCE_RESOLUTION_HOOKS,
  )}");\n`,
)}`;

/** Creates a real OpenCascade worker thread and the channel onto it. */
export function createNodeOcctWorkerChannel(
  options: NodeOcctWorkerChannelOptions = {},
): NodeOcctWorkerChannel {
  const workerOptions: WorkerOptions = {
    execArgv: ["--import", SOURCE_RESOLUTION_IMPORT],
  };
  if (options.echoThreadId === true) {
    workerOptions.env = {
      ...process.env,
      [NODE_OCCT_WORKER_ECHO_ENV]: "1",
    };
  }
  const worker = new Worker(
    new URL("./occt-worker.node.ts", import.meta.url),
    workerOptions,
  );
  const transport = createNodeWorkerTransport(worker);
  const client = createWorkerClient({ transport });

  let crashMessage: string | null = null;
  let resolveExit: ((exit: NodeOcctWorkerExit) => void) | undefined;
  const exited = new Promise<NodeOcctWorkerExit>((resolve) => {
    resolveExit = resolve;
  });
  worker.on("error", (error: Error) => {
    // The exit event follows the error event; keep the cause for `exited`.
    crashMessage = error.message;
  });
  worker.on("exit", (code: number) => {
    // Termination settlement: the channel is dead, so nothing pending on it
    // can ever be answered — close settles it all now.
    client.close();
    resolveExit?.({ code, errorMessage: crashMessage });
  });

  return {
    client,
    transport,
    threadId: worker.threadId,
    exited,
    close(): Promise<void> {
      client.close();
      return worker.terminate().then(async () => {
        await exited;
      });
    },
    terminate(): Promise<NodeOcctWorkerExit> {
      return worker.terminate().then(() => exited);
    },
  };
}
