# Workers

Geometry is expensive, so kernels can live on worker threads behind a
versioned, serializable protocol: `@slopcad/cad-kernel`'s
`worker-protocol.ts` (envelope, `WORKER_PROTOCOL_VERSION = 1`),
`worker-operations.ts` (the operation vocabulary), `worker-ids.ts`
(per-session solid ids), `worker-errors.ts`, and the transport stack —
`worker-transport` (generic), `worker-web-transport` (browser),
`worker-node-transport` (Node), `worker-server` (hosts a kernel),
`worker-client` (promise-based caller), `worker-session` (in-memory
pair).

## The operation vocabulary

`WORKER_OPERATION_IDS` is the wire's whole vocabulary — `solid.createBox`,
`solid.createSphere`, `solid.createCylinder`, `solid.createCone`,
`solid.extrude`, `solid.revolve`, `solid.sweep`, `solid.helixSweep`, `solid.loft`,
`solid.union`, `solid.subtract`,
`solid.intersect`, `solid.transform`, `solid.bounds`, `solid.volume`,
`solid.area`, `solid.tessellate`, `solid.dispose`, `solid.fillet`,
`solid.chamfer`, `solid.shell`, `solid.mirror`, `solid.topology`,
`step.import`, `step.export`, `brep.import`, `brep.export`. Inputs and
results serialize with every length normalized to canonical millimetres
— two equal quantities always produce identical bytes.

## Node hosting

```ts
import { threadId } from "node:worker_threads";
import { createNodeManifoldWorkerChannel } from "@slopcad/cad-kernel-manifold/node-manifold-worker";

const channel = createNodeManifoldWorkerChannel();
const client = channel.client;
const box = await client.request("solid.createBox", {
  width: length(30),
  depth: length(20),
  height: length(10),
});
const volume = await client.request("solid.volume", { solid: box.solid });
await channel.close(); // settles in-flight requests with worker/transport-closed
```

The channel is a real `node:worker_threads` thread
(`channel.threadId !== threadId` proves the geometry ran off-thread);
graceful `close()` and abrupt `terminate()` both settle pending requests
structurally. The OpenCascade twin is
`@slopcad/cad-kernel-occt/node-occt-worker`.

## Browser hosting

The web entries (`manifold-worker.web.ts`, `occt-worker.web.ts`) run as
**module workers** — `vite.config.ts` pins `worker.format = "es"` — and
pin their wasm assets with `?url` imports, because the emscripten glue's
own resolution points into Vite's prebundle directory where the asset
does not exist. Both entries subscribe to the port synchronously and
buffer early messages (a request posted right after `new Worker(...)`
would otherwise be dispatched before the server exists — the Phase 10
bug this design fixed). OCCT's boot is slower and bigger: ~180 ms of
class init on top of fetching the ~23 MB asset (22,980,267 bytes), which
is why the entries post a boot report with the measured numbers.

## Stale-result protection

Rapid edits race slow kernels. The Phase 10.4 trio — `revision.ts`
(monotonic revision tags), `stale-result-guard.ts` (atomic
check-and-apply), `stale-result-coordinator.ts` (stamps, guards, and
keeps the worker's solid state leak-free) — drops superseded results
observably (`StaleDrop`), so the viewport always shows the newest
committed state, never an older frame that arrived late.

## The runnable example

`packages/docs-examples/src/kernel/workers.ts` drives the Manifold node
channel end to end — build, union, measure on another thread, and a
pending request settled by close — and the suite pins
`closeSettledPendingRequests: 1`.
