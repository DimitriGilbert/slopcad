/**
 * The sim worker hosting core (Phase 61b): the one composition that turns a
 * {@link SimWorkerTransport} end into a hosted {@link SimEngine} responder —
 * the Manifold worker-hosting pattern (`@slopcad/cad-kernel-manifold`'s
 * `manifold-worker`) with the WASM runtime swapped for an engine factory.
 *
 * This module is the shared body of the environment-specific sim worker
 * entries (see `./sim-worker.web` and `./sim-worker.node`) and contains
 * zero protocol logic of its own: it builds the engine and hands it to the
 * generic sim worker server. The entries differ only in how they acquire
 * their channel end (the browser worker `self` scope vs
 * `node:worker_threads` `parentPort`). Initialization is asynchronous so a
 * later engine provider may boot assets (a WGSL pipeline in Phase 64's
 * provider, say) before the server subscribes; the fake engine needs none,
 * and message ports buffer messages posted before a listener subscribes,
 * so requests sent during initialization are answered once hosting resolves.
 */

import type { SimEngine } from "./engine";
import type {
  SimOptimizationExecutor,
  SimWorkerServer,
  SimWorkerServerOptions,
} from "./sim-worker-server";
import type { SimWorkerTransport } from "./sim-transport";

import { createFakeSimEngine } from "./fake-engine";
import { createSimWorkerServer } from "./sim-worker-server";

/** Options of {@link hostSimWorker}. */
export interface SimWorkerHostOptions {
  /** The channel end the hosted server listens on and answers from. */
  readonly transport: SimWorkerTransport;
  /**
   * Creates the hosted engine. Defaults to the deterministic fake engine
   * (`./fake-engine`, the `fake-kernel` precedent: the contract exerciser
   * that stands in until the real solver phases land); inject a provider
   * engine from a later phase the same way.
   */
  readonly createEngine?: () => SimEngine | Promise<SimEngine>;
  /**
   * The Phase 70a optimization executor behind `sim.optimize` — inject the
   * NSGA-II runner (`@slopcad/sim-optimization`) to serve optimization
   * runs; absent, the operation declines `sim/optimizer-unavailable`.
   */
  readonly optimizer?: SimOptimizationExecutor;
  /** Additional server options (id generator, ledger) for pinned hosting. */
  readonly server?: Omit<SimWorkerServerOptions, "engine" | "transport">;
}

/**
 * Hosts an engine as a sim worker-protocol responder on the given channel
 * end. Resolves once the engine is built and the server subscribed;
 * requests that queued on the channel during initialization are answered
 * after it resolves.
 */
export async function hostSimWorker(
  options: SimWorkerHostOptions,
): Promise<SimWorkerServer> {
  const engine = await (options.createEngine?.() ?? createFakeSimEngine());
  return createSimWorkerServer({
    engine,
    transport: options.transport,
    ...(options.optimizer === undefined
      ? {}
      : { optimizer: options.optimizer }),
    ...(options.server ?? {}),
  });
}
