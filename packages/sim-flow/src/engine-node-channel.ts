/**
 * The Node host of the real-engine sim worker (Phase 63c): creates a
 * real `node:worker_threads` thread running the `./engine-worker.node`
 * entry — the routed engine (2D LBM for flow, fake for thermal) — and
 * returns the fully wired channel. This is `@slopcad/sim-core`'s
 * `createSimNodeWorkerChannel` restated against sim-flow's own entry
 * (the sim-core channel's entry is hardcoded to the fake-engine host;
 * sim-core cannot import sim-flow, so the real-engine channel lives
 * here), with the same two disciplines carried verbatim: termination
 * settlement (a dead channel settles every pending request through the
 * client's close) and the resolve hook that makes the workspace's
 * extensionless relative TypeScript imports loadable in a plain Node
 * worker. Subpath-only, never re-exported from the runtime index — it
 * imports `node:worker_threads`.
 */

import { Worker } from "node:worker_threads";
import { parseSimWorkerBootFailureReport } from "@slopcad/sim-core";
import type { SimWorkerClient } from "@slopcad/sim-core";
import { createSimWorkerClient } from "@slopcad/sim-core";
import { createSimNodeWorkerTransport } from "@slopcad/sim-core/sim-node-transport";
import type { SimNodeWorkerChannelExit } from "@slopcad/sim-core/sim-node-worker";
import type { SimWorkerTransport } from "@slopcad/sim-core";

/** A live real-engine worker thread and the main-thread handle onto it. */
export interface LbmNodeWorkerChannel {
  /** The request/notification/cancellation surface to the routed engine. */
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
   */
  close(): Promise<void>;
}

/**
 * The resolve hook that makes the workspace's bundler-style extensionless
 * relative imports loadable in a plain Node worker — sim-core's own
 * hook, restated (it is module-private there). Registered from a
 * data-URL module pre-imported via `execArgv`, so it needs no file on
 * disk.
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
 * Creates a real worker thread running the routed-engine entry and the
 * fully wired channel onto it: a {@link SimWorkerClient} over the node
 * transport adapter, the thread's identity, and the termination rules.
 */
export function createLbmNodeWorkerChannel(): LbmNodeWorkerChannel {
  const worker = new Worker(
    new URL("./engine-worker.node.ts", import.meta.url),
    { execArgv: ["--import", SOURCE_RESOLUTION_IMPORT] },
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
    const report = parseSimWorkerBootFailureReport(data);
    if (report !== null && bootFailureMessage === null) {
      bootFailureMessage = report.message;
    }
  });
  worker.on("error", (error: Error) => {
    crashMessage = error.message;
  });
  worker.on("exit", (code: number) => {
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
  };
}
