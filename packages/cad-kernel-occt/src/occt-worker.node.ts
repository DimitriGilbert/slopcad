/**
 * The Node entry of the OpenCascade worker (Phase 21.2): runs inside a
 * `node:worker_threads` thread and hosts the real OpenCascade kernel as a
 * worker-protocol responder over the node transport adapter — the twin of
 * the Manifold node entry.
 *
 * Composition only — `./occt-worker` holds the shared hosting core; the
 * runtime needs no asset pin under Node (see `./occt-runtime`). Node 24
 * loads this file and the whole kernel graph as TypeScript source through
 * type stripping; `./node-occt-worker` starts the thread with the one
 * resolve hook that makes the workspace's extensionless relative imports
 * loadable in a plain Node worker.
 *
 * Test-only thread echo: when `SLOPCAD_OCCT_WORKER_ECHO_THREAD_ID` is `1`
 * (the channel factory's `echoThreadId` option), the entry posts one plain
 * non-protocol message — `{ slopcadOcctWorkerThreadId: <id> }` — before
 * hosting, so tests can prove over the real channel that execution happens
 * on the worker's thread and not their own. The message carries no protocol
 * shape and is dropped by every protocol endpoint's parse boundary.
 */

import { parentPort, threadId } from "node:worker_threads";
import { createNodeWorkerTransport } from "@slopcad/cad-kernel";

import { hostOcctWorker } from "./occt-worker";
import {
  NODE_OCCT_WORKER_ECHO_ENV,
  NODE_OCCT_WORKER_THREAD_ECHO_KEY,
} from "./node-occt-worker";

const port = parentPort;
if (port === null) {
  throw new Error(
    "occt-worker.node must run inside a worker thread: it answers on its parent port.",
  );
}
const transport = createNodeWorkerTransport(port);
if (process.env[NODE_OCCT_WORKER_ECHO_ENV] === "1") {
  transport.send({ [NODE_OCCT_WORKER_THREAD_ECHO_KEY]: threadId });
}
await hostOcctWorker({ transport });
