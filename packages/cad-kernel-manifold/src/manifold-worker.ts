/**
 * The Manifold worker hosting core (Phase 10.3): the one composition that
 * turns a {@link WorkerTransport} end into a hosted real-Manifold responder.
 *
 * This module is the shared body of the environment-specific worker entries
 * (see `./manifold-worker.node` and `./manifold-worker.web`) and contains
 * zero protocol logic of its own: it awaits the Manifold WASM runtime,
 * builds the kernel adapter over it, and hands both to the generic Phase
 * 10.2 server. The entries differ only in how they acquire their channel
 * end (`node:worker_threads` `parentPort` vs the browser worker `self`
 * scope) and how the runtime pins the WASM asset (no pin under Node;
 * `?url` + `locateFile` in the browser).
 *
 * Initialization is asynchronous, and that is safe on a real channel:
 * message ports buffer messages posted before a listener subscribes (the
 * same property DOM message channels have), so requests sent while the
 * WASM heap boots are answered once the server subscribes here.
 */

import type {
  GeometryKernel,
  WorkerServer,
  WorkerTransport,
} from "@slopcad/cad-kernel";
import { createWorkerServer } from "@slopcad/cad-kernel";

import { manifoldKernelFromRuntime } from "./manifold-kernel";
import {
  createManifoldRuntime,
  type ManifoldRuntime,
} from "./manifold-runtime";

/** Options of {@link hostManifoldWorker}. */
export interface ManifoldWorkerHostOptions {
  /** The channel end the hosted server listens on and answers from. */
  readonly transport: WorkerTransport;
  /**
   * Creates the initialized WASM runtime. Defaults to
   * {@link createManifoldRuntime} (Node's plain `Module()`); the browser
   * entry passes a `locateFile`-pinned variant. Injected so no entry needs
   * to touch the runtime brand.
   */
  readonly createRuntime?: () => Promise<ManifoldRuntime>;
}

/**
 * Hosts a real Manifold kernel as a worker-protocol responder on the given
 * channel end. Resolves once the WASM runtime is initialized and the server
 * subscribed; requests that queued on the channel during initialization are
 * answered after it resolves.
 */
export async function hostManifoldWorker(
  options: ManifoldWorkerHostOptions,
): Promise<WorkerServer> {
  const runtime = await (options.createRuntime ?? createManifoldRuntime)();
  const kernel: GeometryKernel = manifoldKernelFromRuntime(runtime);
  return createWorkerServer({ kernel, transport: options.transport });
}
