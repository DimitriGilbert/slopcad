/**
 * The Node host of the sim worker (Phase 61b): creates a real
 * `node:worker_threads` thread running the `./sim-worker.node` entry and
 * returns the fully wired channel — a sim {@link SimWorkerClient} over the
 * node transport adapter, the thread's identity, and the termination rules.
 *
 * The hosting pattern is the kernel abstraction's shared
 * `createNodeWorkerChannel` factory (`@slopcad/cad-kernel`'s
 * `node-worker-channel`), restated under sim-core's zero-runtime-dependency
 * stance with the one difference that matters: the channel wires the SIM
 * client (which understands the notification class), not the kernel client.
 * The two shared disciplines carry over verbatim:
 *
 * ## Termination settlement
 *
 * No response can ever arrive on a dead channel, so the exit of the thread —
 * deliberate (`close`/`terminate`) or a crash — settles every still-pending
 * request through the client's close: the structured `worker/transport-closed`
 * failure, never a hanging promise. `close` is the graceful form (settle
 * first, then terminate and await the exit); `terminate` is the abrupt one.
 * {@link SimNodeWorkerChannel.exited} reports how the thread ended: the exit
 * code plus, when the worker's entry posted a boot-failure report before
 * exiting (its test-only hosting-failure mode), the report's failure text —
 * the crash/failure discipline `bootSimWorkerChannel` settles on, surfaced
 * to Node hosts through the exit.
 *
 * ## Loading workspace TypeScript sources in a plain Node worker
 *
 * The workspace packages are consumed as bundler-resolution TypeScript
 * source (extensionless relative imports between siblings); Node 24 loads
 * such files through its own type stripping, which requires the extension.
 * The channel therefore starts the thread with an `execArgv` that pre-imports
 * a module registering one resolve hook — append `.ts` to a failed
 * extensionless relative specifier — before the entry loads. The hook lives
 * entirely inside the spawned thread (a data-URL module, no build artifacts)
 * and changes no behavior of the packages themselves.
 */

import { type WorkerOptions, Worker } from "node:worker_threads";
import type { SimWorkerClient } from "./sim-worker-client";
import type { SimWorkerTransport } from "./sim-transport";

import { parseSimWorkerBootFailureReport } from "./sim-boot-failure-report";
import { createSimWorkerClient } from "./sim-worker-client";
import { createSimNodeWorkerTransport } from "./sim-node-transport";

/**
 * Environment variable enabling the node entry's test-only hosting-failure
 * mode (see `./sim-worker.node`): `1` makes the entry's engine factory
 * reject before hosting, posting the boot-failure report and retiring —
 * the crash/failure path exercisable over a real channel.
 */
export const NODE_SIM_WORKER_FAIL_BOOT_ENV = "SLOPCAD_SIM_WORKER_FAIL_BOOT";

/**
 * How the sim worker thread ended: `code` is its exit code (terminating a
 * healthy thread yields a non-zero code; `bootFailureMessage` carries the
 * worker-side boot-failure report's text when the entry posted one before
 * exiting, else `errorMessage` a crash message).
 */
export interface SimNodeWorkerChannelExit {
  readonly code: number;
  readonly errorMessage: string | null;
  /** The boot-failure report's text, when the entry posted one. */
  readonly bootFailureMessage: string | null;
}

/** Options of {@link createSimNodeWorkerChannel}. */
export interface SimNodeWorkerChannelOptions {
  /**
   * Starts the entry with the test-only hosting-failure mode enabled — for
   * the crash/failure path tests (see {@link NODE_SIM_WORKER_FAIL_BOOT_ENV}).
   */
  readonly failBoot?: boolean;
}

/** A live sim worker thread and the main-thread handle onto it. */
export interface SimNodeWorkerChannel {
  /** The request/notification/cancellation surface to the hosted engine. */
  readonly client: SimWorkerClient;
  /** The main-thread end of the channel (observe or inject at the wire). */
  readonly transport: SimWorkerTransport;
  /** The real `threadId` of the worker thread (0 is a process main thread). */
  readonly threadId: number;
  /** Resolves when the thread exits, with its exit code and failure texts. */
  readonly exited: Promise<SimNodeWorkerChannelExit>;
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
  terminate(): Promise<SimNodeWorkerChannelExit>;
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

/**
 * Creates a real worker thread running the sim worker entry and the fully
 * wired channel onto it: a {@link SimWorkerClient} over the node transport
 * adapter, the thread's identity, and the termination rules.
 */
export function createSimNodeWorkerChannel(
  options: SimNodeWorkerChannelOptions = {},
): SimNodeWorkerChannel {
  const workerOptions: WorkerOptions = {
    execArgv: ["--import", SOURCE_RESOLUTION_IMPORT],
  };
  if (options.failBoot === true) {
    workerOptions.env = {
      ...process.env,
      [NODE_SIM_WORKER_FAIL_BOOT_ENV]: "1",
    };
  }
  const worker = new Worker(
    new URL("./sim-worker.node.ts", import.meta.url),
    workerOptions,
  );
  const transport = createSimNodeWorkerTransport(worker);
  const client = createSimWorkerClient({ transport });

  let crashMessage: string | null = null;
  let bootFailureMessage: string | null = null;
  let resolveExit: ((exit: SimNodeWorkerChannelExit) => void) | undefined;
  const exited = new Promise<SimNodeWorkerChannelExit>((resolve) => {
    resolveExit = resolve;
  });
  worker.on("message", (data: unknown) => {
    // The worker-side boot-failure report rides as plain non-protocol data;
    // every protocol endpoint drops it, and the exit event below performs
    // the settlement — the report is surfaced through `exited`.
    const report = parseSimWorkerBootFailureReport(data);
    if (report !== null && bootFailureMessage === null) {
      bootFailureMessage = report.message;
    }
  });
  worker.on("error", (error: Error) => {
    // The exit event follows the error event; keep the cause for `exited`.
    crashMessage = error.message;
  });
  worker.on("exit", (code: number) => {
    // Termination settlement: the channel is dead, so nothing pending on it
    // can ever be answered — close settles it all now.
    client.close();
    resolveExit?.({ code, errorMessage: crashMessage, bootFailureMessage });
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
    terminate(): Promise<SimNodeWorkerChannelExit> {
      return worker.terminate().then(() => exited);
    },
  };
}
