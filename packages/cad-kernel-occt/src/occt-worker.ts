/**
 * The OpenCascade worker hosting core (Phase 21.2): the twin of the Manifold
 * hosting core (`@slopcad/cad-kernel-manifold`'s `manifold-worker`), and like
 * it the one composition that turns a {@link WorkerTransport} end into a
 * hosted real-OCCT responder.
 *
 * This module is the shared body of the environment-specific worker entries
 * (see `./occt-worker.node` and `./occt-worker.web`) and contains zero
 * protocol logic of its own: it awaits the OpenCascade WASM runtime, builds
 * the kernel adapter over it, and hands both to the generic Phase 10.2
 * server — the kernel-agnostic substrate reused as-is. The entries differ
 * only in how they acquire their channel end (`node:worker_threads`
 * `parentPort` vs the browser worker `self` scope) and how the runtime pins
 * the ~22 MB WASM asset (no pin under Node; `?url` + `locateFile` in the
 * browser).
 *
 * Initialization is asynchronous — slower than Manifold's (~180 ms of class
 * init in Node, probed; the browser adds the asset fetch) — and that is safe
 * on a real channel for the same reason it is there: message ports buffer
 * messages posted before a listener subscribes, so requests sent while the
 * WASM heap boots are answered once the server subscribes here.
 */

import type {
  GeometryKernel,
  WorkerServer,
  WorkerTransport,
} from "@slopcad/cad-kernel";
import { createWorkerServer } from "@slopcad/cad-kernel";
import { fail, ok } from "@slopcad/cad-core";

import { occtKernelFromRuntime } from "./occt-kernel";
import { parseStepExportOptions } from "./occt-step-export";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

/** Options of {@link hostOcctWorker}. */
export interface OcctWorkerHostOptions {
  /** The channel end the hosted server listens on and answers from. */
  readonly transport: WorkerTransport;
  /**
   * Creates the initialized WASM runtime. Defaults to
   * {@link createOcctRuntime} (the binding's own asset resolution); the
   * browser entry passes a `locateFile`-pinned variant. Injected so no
   * entry needs to touch the runtime brand.
   */
  readonly createRuntime?: () => Promise<OcctRuntime>;
}

/**
 * Hosts a real OpenCascade kernel as a worker-protocol responder on the
 * given channel end. Resolves once the WASM runtime is initialized and the
 * server subscribed; requests that queued on the channel during
 * initialization are answered after it resolves.
 */
export async function hostOcctWorker(
  options: OcctWorkerHostOptions,
): Promise<WorkerServer> {
  const runtime = await (options.createRuntime ?? createOcctRuntime)();
  const kernel = occtKernelFromRuntime(runtime);
  const hostedKernel: GeometryKernel = kernel;
  return createWorkerServer({
    kernel: hostedKernel,
    transport: options.transport,
    // The Phase 21.3 extension: this host's kernel imports STEP, so the
    // server's `step.import` operation executes here. The model result
    // narrows to its plain solids; the provenance literal rides the wire
    // result the server assembles.
    stepImport: (bytes) => {
      const imported = kernel.importStep(bytes);
      return imported.ok
        ? ok(imported.value.solids.map((ref) => ref.solid))
        : fail(imported.error);
    },
    // The Phase 21.4 twin: this host's kernel exports STEP, so the server's
    // `step.export` operation executes here — owned solids (the session map
    // already resolved the ids) plus the wire's plain-string unit/schema
    // settings in (narrowed by the exporter's own option parser), deterministic
    // STEP bytes out.
    stepExport: (solids, settings) => {
      const options = parseStepExportOptions(settings);
      return options.ok
        ? kernel.exportStep(solids, options.value)
        : fail(options.error);
    },
    // The Phase 21.5 BREP pair: the same kernel imports and exports OCCT's
    // native form, so `brep.import`/`brep.export` execute here — the wire
    // carries no settings for BREP (no unit or schema exists to select), so
    // the extensions are direct delegations.
    brepImport: (bytes) => {
      const imported = kernel.importBrep(bytes);
      return imported.ok
        ? ok(imported.value.solids.map((ref) => ref.solid))
        : fail(imported.error);
    },
    brepExport: (solids) => kernel.exportBrep(solids),
  });
}
