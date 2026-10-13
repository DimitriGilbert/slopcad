/**
 * The Node entry of the sim worker (Phase 61b): runs inside a
 * `node:worker_threads` thread and hosts the fake engine as a
 * sim worker-protocol responder over the node transport adapter — the
 * Manifold node entry's pattern (`@slopcad/cad-kernel-manifold`'s
 * `manifold-worker.node`). Node 24 loads this file and the whole sim-core
 * graph as TypeScript source through type stripping; `./sim-node-worker`
 * starts the thread with the one resolve hook that makes the workspace's
 * extensionless relative imports loadable in a plain Node worker.
 *
 * Test-only hosting-failure mode: when `SLOPCAD_SIM_WORKER_FAIL_BOOT` is
 * `1` (the channel factory's `failBoot` option), the entry's engine
 * factory rejects BEFORE hosting — and the rejection is posted as the
 * boot-failure report (the discipline `bootSimWorkerChannel` settles on)
 * before the thread retires itself, so the crash/failure path is
 * exercisable over a real channel exactly as a browser hosting failure
 * would surface.
 */

import { parentPort } from "node:worker_threads";
import type { SimEngine } from "./engine";

import { createFakeSimEngine } from "./fake-engine";
import { SIM_WORKER_BOOT_FAILURE_KEY } from "./sim-boot-failure-report";
import { NODE_SIM_WORKER_FAIL_BOOT_ENV } from "./sim-node-worker";
import { createSimNodeWorkerTransport } from "./sim-node-transport";
import { hostSimWorker } from "./sim-worker";

const port = parentPort;
if (port === null) {
  throw new Error(
    "sim-worker.node must run inside a worker thread: it answers on its parent port.",
  );
}
const transport = createSimNodeWorkerTransport(port);

function createEngine(): SimEngine | Promise<SimEngine> {
  if (process.env[NODE_SIM_WORKER_FAIL_BOOT_ENV] === "1") {
    // Rejected, not thrown: the hosting core's await turns it into the
    // boot-failure report below while the thread can still speak.
    return Promise.reject(
      new Error(
        "the sim worker's test-only hosting-failure mode was enabled (SLOPCAD_SIM_WORKER_FAIL_BOOT=1)",
      ),
    );
  }
  return createFakeSimEngine();
}

try {
  await hostSimWorker({ transport, createEngine });
} catch (error) {
  // The boot-failure discipline: while the thread can still speak, the
  // failure text crosses to the main thread as the plain non-protocol
  // report the crash-settling boot terminal-settles on; then the thread
  // retires (an uncaught throw would crash the thread instead, which the
  // node channel settles through the exit hook — both settle in-flight
  // requests; the report is the graceful, message-carrying form).
  const detail = error instanceof Error ? error.message : String(error);
  transport.send({
    [SIM_WORKER_BOOT_FAILURE_KEY]: `hosting the sim engine failed: ${detail}`,
  });
  process.exit(1);
}
