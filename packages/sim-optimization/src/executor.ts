/**
 * The Phase 70a worker-seam executor: the {@link SimOptimizationExecutor}
 * implementation a worker host injects so the `sim.optimize` operation
 * serves optimization runs. The seam exists because sim-core stays
 * runtime-dependency-free — the envelope carries the wire codecs and the
 * contract, and THIS adapter owns the document side (the cad-core parse
 * boundaries, cross-checks, and re-drive) plus the engine routing.
 *
 * The mapping of the executor callbacks is the existing discipline
 * verbatim: each distinct evaluation emits a `progress` notification
 * (step = cumulative candidates, totalSteps = the study's budget), each
 * settled generation emits an `optimization-generation` notification
 * (best-of-generation preview), and the abort poll is the server's
 * recorded-cancel set. An aborted campaign unwinds by THROWING the abort
 * sentinel — the server converts the throw and the cancellation ledger's
 * pinned rule decides the wire outcome (a recorded cancel replaces it
 * with the cancelled ack).
 */

import type {
  SimEngine,
  SimError,
  SimOptimizationExecutor,
  SimOptimizationExecutorCallbacks,
  SimParseResult,
  WorkerSimOptimizeInput,
  WorkerSimOptimizeResult,
} from "@slopcad/sim-core";
import { simFail, simOk } from "@slopcad/sim-core";

import {
  type SimOptimizationGeometryProvider,
  buildSimOptimizationRunContext,
  runSimOptimization,
} from "./evaluate";
import { SimOptimizationAbortedError } from "./nsga2";

/** Options of {@link createSimOptimizationExecutor}. */
export interface SimOptimizationExecutorOptions {
  /** The engines the campaign routes per candidate (kind, backend). */
  readonly engines: readonly SimEngine[];
  /** The host's per-candidate geometry re-drive, when one exists. */
  readonly geometry?: SimOptimizationGeometryProvider;
}

/**
 * Creates the `sim.optimize` executor: parses the wire's document context
 * (a structured `sim/study-invalid` refusal on any malformed record or
 * cross-check problem), then runs the campaign with the callbacks mapped
 * to the worker's notification discipline.
 */
export function createSimOptimizationExecutor(
  options: SimOptimizationExecutorOptions,
): SimOptimizationExecutor {
  const { engines, geometry } = options;
  return async (
    input: WorkerSimOptimizeInput,
    callbacks: SimOptimizationExecutorCallbacks,
  ): Promise<SimParseResult<WorkerSimOptimizeResult, SimError>> => {
    const context = buildSimOptimizationRunContext({
      study: input.study,
      scenario: input.scenario,
      parameters: input.parameters,
      ...(input.motors === undefined ? {} : { motors: input.motors }),
      ...(input.bodyBounds === undefined
        ? {}
        : { bodyBounds: input.bodyBounds }),
      ...(input.tessellation === undefined
        ? {}
        : { tessellation: input.tessellation }),
      ...(input.materials === undefined ? {} : { materials: input.materials }),
      ...(input.bodyTessellations === undefined
        ? {}
        : { bodyTessellations: input.bodyTessellations }),
    });
    if (!context.ok) return simFail(context.error);
    const outcome = await runSimOptimization(context.value, {
      engines,
      ...(geometry === undefined ? {} : { geometry }),
      onEvaluation: (total, budget) => {
        callbacks.onProgress({ step: total, totalSteps: budget });
      },
      onGeneration: (notice) => {
        callbacks.onOptimizationGeneration(notice);
      },
      shouldAbort: () => callbacks.shouldAbort(),
    });
    if (outcome.status === "aborted" || outcome.result === undefined) {
      // The cooperative unwind: the ledger's pinned rule replaces the
      // wire outcome when a cancellation is recorded; a host-injected
      // abort (no recorded cancel) surfaces as the operation failure.
      throw new SimOptimizationAbortedError();
    }
    return simOk(outcome.result);
  };
}
