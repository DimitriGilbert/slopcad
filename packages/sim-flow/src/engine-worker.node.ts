/**
 * The Node entry of the real-engine sim worker (Phase 63c): runs inside
 * a `node:worker_threads` thread and hosts the DEFAULT ROUTED engine —
 * the real 2D LBM engine for flow scenarios, the real conduction/CHT
 * thermal engines (Phase 65c) — as a sim worker-protocol responder
 * over the node transport adapter. This is `@slopcad/sim-core`'s `sim-worker.node` entry with the
 * one difference that matters: the engine. sim-core cannot host the real
 * engine (sim-flow depends on it — the dependency arrow points the other
 * way), so the real-engine node entry lives HERE, subpath-only, never
 * re-exported from the runtime index (the sim-core precedent for node
 * builtins).
 *
 * Node 24 loads this file and the whole sim-flow graph as TypeScript
 * source through type stripping; `./engine-node-channel` starts the
 * thread with the one resolve hook that makes the workspace's
 * extensionless relative imports loadable in a plain Node worker.
 */

import { parentPort } from "node:worker_threads";
import { SIM_WORKER_BOOT_FAILURE_KEY } from "@slopcad/sim-core";
import { createSimNodeWorkerTransport } from "@slopcad/sim-core/sim-node-transport";
import { hostSimWorker } from "@slopcad/sim-core";

import { createDefaultSimEngine } from "./engine";

const port = parentPort;
if (port === null) {
  throw new Error(
    "engine-worker.node must run inside a worker thread: it answers on its parent port.",
  );
}
const transport = createSimNodeWorkerTransport(port);

try {
  await hostSimWorker({ transport, createEngine: createDefaultSimEngine });
} catch (error) {
  // The boot-failure discipline (the sim-core node entry's own): while
  // the thread can still speak, the failure text crosses to the main
  // thread as the plain non-protocol report the crash-settling boot
  // terminal-settles on; then the thread retires.
  const detail = error instanceof Error ? error.message : String(error);
  transport.send({
    [SIM_WORKER_BOOT_FAILURE_KEY]: `hosting the routed sim engine failed: ${detail}`,
  });
  process.exit(1);
}
