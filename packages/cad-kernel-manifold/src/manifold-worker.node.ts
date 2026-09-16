/**
 * The Node entry of the Manifold worker (Phase 10.3): runs inside a
 * `node:worker_threads` thread and hosts the real Manifold kernel as a
 * worker-protocol responder over the node transport adapter.
 *
 * Composition only — `./manifold-worker` holds the shared hosting core; the
 * runtime needs no asset pin under Node (see `./manifold-runtime`). Node 24
 * loads this file and the whole kernel graph as TypeScript source through
 * type stripping; `./node-manifold-worker` starts the thread with the one
 * resolve hook that makes the workspace's extensionless relative imports
 * loadable in a plain Node worker.
 *
 * Test-only thread echo: when `SLOPCAD_MANIFOLD_WORKER_ECHO_THREAD_ID` is
 * `1` (the channel factory's `echoThreadId` option), the entry posts one
 * plain non-protocol message — `{ slopcadManifoldWorkerThreadId: <id> }` —
 * before hosting, so tests can prove over the real channel that execution
 * happens on the worker's thread and not their own. The message carries no
 * protocol shape and is dropped by every protocol endpoint's parse
 * boundary.
 */

import { parentPort, threadId } from "node:worker_threads";
import { createNodeWorkerTransport } from "@slopcad/cad-kernel";

import { hostManifoldWorker } from "./manifold-worker";
import {
  NODE_MANIFOLD_WORKER_ECHO_ENV,
  NODE_MANIFOLD_WORKER_THREAD_ECHO_KEY,
} from "./node-manifold-worker";

const port = parentPort;
if (port === null) {
  throw new Error(
    "manifold-worker.node must run inside a worker thread: it answers on its parent port.",
  );
}
const transport = createNodeWorkerTransport(port);
if (process.env[NODE_MANIFOLD_WORKER_ECHO_ENV] === "1") {
  transport.send({ [NODE_MANIFOLD_WORKER_THREAD_ECHO_KEY]: threadId });
}
await hostManifoldWorker({ transport });
