/**
 * The sim worker server (Phase 61b): hosts one {@link SimEngine} as a
 * responder for the `sim.*` operation vocabulary over any
 * {@link SimWorkerTransport} — the kernel protocol's `worker-server`
 * (`@slopcad/cad-kernel`) adapted to the engine contract and the
 * notification class. It is a generic adapter from the engine seam to the
 * sim worker protocol and knows no solver specifics beyond the contract.
 *
 * ## The pipeline of one request
 *
 * 1. **Parse** — every arriving message crosses the protocol's trust
 *    boundary (`parseSimWorkerMessage`). An unparseable message gets one
 *    error response with `requestId: null` (correlation impossible) and
 *    never reaches the engine. A message arriving in the responder role
 *    that is a *response* or a *notification* is misdirected and dropped.
 * 2. **Admit** — a parsed request is admitted through the cancellation
 *    ledger (`start`): a duplicate id is refused with
 *    `worker/duplicate-request`, a cancelled id with the `worker/cancelled`
 *    ack, and neither executes anything. A cancel message is recorded in
 *    the ledger AND in the server's abort set (the cooperative signal the
 *    run wrappers throw from).
 * 3. **Execute** — admitted requests execute asynchronously (an engine run
 *    is async by contract). `sim.compile` runs the 61a compile boundary and
 *    holds the compiled problem; `sim.run` drives the engine with wrapped
 *    emission callbacks — progress and field-chunk notifications cross the
 *    channel as they are reported, and each callback first checks the
 *    abort set, throwing the {@link SimRunCancelledError} sentinel so a
 *    conforming engine unwinds instead of running on; `sim.finalize`
 *    returns a completed run's {@link SimResult} as its persisted form;
 *    `sim.optimize` (Phase 70a) delegates to the host-injected
 *    {@link SimOptimizationExecutor} with the same wrapped-emission
 *    discipline (progress + best-of-generation notifications). The
 *    computed outcome then runs through `ledger.finish`: a suppressed
 *    outcome is dropped and replaced by the `worker/cancelled` ack, so a
 *    late success can never be emitted after a recorded cancellation —
 *    and a suppressed run mints no run id and stores nothing.
 *
 * ## Session-state lifecycle
 *
 * The wire addresses session state by {@link SimProblemId} and
 * {@link SimRunId}; the server holds the compiled scenarios and the
 * completed results behind them. Ids are minted with a deterministic
 * generator *at delivery time* — a problem id is assigned when the compile
 * response is actually emitted, in delivery order, so the same request
 * sequence over a fresh session assigns identical ids and a cancelled
 * computation consumes none (the kernel's solid-id discipline). A run's
 * result stays addressable for the channel's lifetime: `sim.finalize` is
 * repeatable and answers identical bytes.
 *
 * Engine failures (the structured `sim/*` declines of the contract) ride
 * the `worker/operation-failed` response with the code in `data.simCode`;
 * an engine that breaks the contract and throws is converted the same way
 * instead of poisoning the channel.
 */

import type {
  SimEngine,
  SimEngineFieldChunk,
  SimEngineOptimizationGeneration,
  SimEngineProgress,
} from "./engine";
import type { SimError } from "./errors";
import type { SimParseResult } from "./result";
import type { SimResult } from "./sim-result";
import type { SimWorkerCancellationLedger } from "./sim-worker-cancellation";
import type {
  SimWorkerIdGenerator,
  SimProblemId,
  SimRunId,
  SimWorkerRequestId,
} from "./sim-worker-ids";
import type {
  DecodedSimWorkerRequest,
  SimWorkerRequestMessage,
  SimWorkerResponseMessage,
  SimWorkerSuccessResponseMessage,
} from "./sim-worker-protocol";
import type { SimWorkerTransport } from "./sim-transport";
import type { CompiledSimScenario } from "./units";
import type {
  WorkerSimOptimizeInput,
  WorkerSimOptimizeResult,
} from "./sim-worker-operations";

import { createSimWorkerCancellationLedger } from "./sim-worker-cancellation";
import { createSimWorkerIdGenerator } from "./sim-worker-ids";
import {
  createSimFieldChunkNotification,
  createSimOptimizationGenerationNotification,
  createSimProgressNotification,
  createSimWorkerErrorResponse,
  createSimWorkerSuccessResponse,
  decodeSimWorkerRequest,
  parseSimWorkerMessage,
} from "./sim-worker-protocol";
import {
  type SimWorkerError,
  SIM_WORKER_PROTOCOL_ERROR_CODES,
  simWorkerError,
} from "./sim-worker-errors";
import { simResultToFinalizeResult } from "./sim-worker-operations";
import { compileSimScenarioWithGeometry } from "./compile-geometry";

/**
 * The sentinel the run wrappers throw to deliver cooperative cancellation
 * through the engine contract's emission callbacks (a conforming engine
 * does not catch callback throws; see `./engine`). Internal to the server —
 * it never crosses the wire; the wire sees the ordinary `worker/cancelled`
 * ack the pinned rule produces.
 */
class SimRunCancelledError extends Error {
  constructor(requestId: SimWorkerRequestId) {
    super(
      `The run request "${requestId}" was cancelled while running; the engine unwound cooperatively.`,
    );
    this.name = "SimRunCancelledError";
  }
}

/** What executing a request produced, before the ledger decides delivery. */
type SimExecutionOutcome =
  | {
      readonly status: "compiled";
      readonly compiled: CompiledSimScenario;
    }
  | {
      readonly status: "ran";
      readonly steps: number;
      readonly chunks: number;
      readonly result: SimResult;
    }
  | {
      readonly status: "finalized";
      readonly response: SimWorkerSuccessResponseMessage;
    }
  | {
      readonly status: "optimized";
      readonly result: WorkerSimOptimizeResult;
    }
  | { readonly status: "failed"; readonly error: SimWorkerError };

/**
 * The streaming + cooperation surface an optimization executor receives
 * (Phase 70a): progress emissions (candidate counts), generation notices
 * (best-of-generation previews), and the abort poll — the same
 * cooperative-cancellation discipline the engine contract's callbacks
 * carry. The executor unwinds by THROWING when `shouldAbort` turns true;
 * the ledger's pinned rule decides the wire outcome (a recorded cancel
 * replaces any computed outcome with the cancelled ack).
 */
export interface SimOptimizationExecutorCallbacks {
  readonly onProgress: (progress: SimEngineProgress) => void;
  readonly onOptimizationGeneration: (
    notice: SimEngineOptimizationGeneration,
  ) => void;
  readonly shouldAbort: () => boolean;
}

/**
 * The Phase 70a executor seam: the host-injected optimization runner
 * behind the `sim.optimize` operation. sim-core stays
 * runtime-dependency-free, so the NSGA-II driver (which needs the
 * document parameter machinery) is an INJECTION, never an import — the
 * worker envelope carries the wire codecs and this contract, and
 * `@slopcad/sim-optimization` provides the implementation. Structured
 * `sim/*` declines ride the ordinary `worker/operation-failed` response.
 */
export interface SimOptimizationExecutor {
  (
    input: WorkerSimOptimizeInput,
    callbacks: SimOptimizationExecutorCallbacks,
  ): Promise<SimParseResult<WorkerSimOptimizeResult, SimError>>;
}

/** Options of {@link createSimWorkerServer}. */
export interface SimWorkerServerOptions {
  /** The engine that executes runs — any contract implementation. */
  readonly engine: SimEngine;
  /** The transport end the server listens on and answers from. */
  readonly transport: SimWorkerTransport;
  /**
   * The optimization executor behind `sim.optimize` (Phase 70a) — an
   * injected runner (see {@link SimOptimizationExecutor}); absent, the
   * operation declines `sim/optimizer-unavailable` loudly.
   */
  readonly optimizer?: SimOptimizationExecutor;
  /** Mints the session's ids. Defaults to a fresh generator. */
  readonly ids?: SimWorkerIdGenerator;
  /** The responder-side cancellation ledger. Defaults to a fresh one. */
  readonly ledger?: SimWorkerCancellationLedger;
}

/** A hosted engine: subscribed to its transport until closed. */
export interface SimWorkerServer {
  /** Unsubscribes from the transport; later messages are ignored. */
  close(): void;
}

/** Hosts `options.engine` as a sim worker-protocol responder on its transport. */
export function createSimWorkerServer(
  options: SimWorkerServerOptions,
): SimWorkerServer {
  const { engine, transport } = options;
  const optimizer = options.optimizer;
  const ids = options.ids ?? createSimWorkerIdGenerator();
  const ledger = options.ledger ?? createSimWorkerCancellationLedger();
  const problems = new Map<SimProblemId, CompiledSimScenario>();
  const runs = new Map<SimRunId, SimResult>();
  // Request ids whose cancellation arrived while they were running: the
  // cooperative signal the emission wrappers check. Entries are cleared at
  // finish, so the set is bounded by in-flight runs.
  const aborted = new Set<SimWorkerRequestId>();

  function cancelledAck(
    requestId: SimWorkerRequestId,
    reason: string,
  ): SimWorkerResponseMessage {
    return createSimWorkerErrorResponse(
      requestId,
      simWorkerError(
        SIM_WORKER_PROTOCOL_ERROR_CODES.cancelled,
        `The request "${requestId}" was cancelled (${reason}); its outcome is void.`,
      ),
    );
  }

  function simDecline(
    operation: DecodedSimWorkerRequest["operation"],
    error: SimError,
  ): SimWorkerError {
    return simWorkerError(
      SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" operation failed: ${error.message}`,
      { simCode: error.code },
    );
  }

  function unexpectedThrow(
    operation: DecodedSimWorkerRequest["operation"],
    error: unknown,
  ): SimWorkerError {
    const detail = error instanceof Error ? error.message : String(error);
    return simWorkerError(
      SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" operation threw unexpectedly: ${detail}`,
      { thrown: true },
    );
  }

  async function execute(
    requestId: SimWorkerRequestId,
    request: DecodedSimWorkerRequest,
  ): Promise<SimExecutionOutcome> {
    // The outer guard mirrors the kernel server's: an implementation that
    // breaks its own contract and throws is converted into a structured
    // operation failure instead of poisoning the channel (the run case
    // keeps its own finer-grained catch for the cancellation sentinel).
    try {
      switch (request.operation) {
        case "sim.compile": {
          // The Phase 63c geometry-aware door: the 61a compile plus the
          // tessellation's voxelized occupancy slice (and run controls) when
          // the request carries geometry — and, Phase 65c, the thermal
          // branch's per-body tessellations and material records —
          // identical to the 61a compile otherwise, so every existing
          // path keeps its exact behavior.
          const compiled = compileSimScenarioWithGeometry({
            scenario: request.input.scenario,
            ...(request.input.motor === undefined
              ? {}
              : { motor: request.input.motor }),
            ...(request.input.bodyBounds === undefined
              ? {}
              : { bodyBounds: request.input.bodyBounds }),
            ...(request.input.tessellation === undefined
              ? {}
              : { tessellation: request.input.tessellation }),
            ...(request.input.materials === undefined
              ? {}
              : { materials: request.input.materials }),
            ...(request.input.bodyTessellations === undefined
              ? {}
              : { bodyTessellations: request.input.bodyTessellations }),
            ...(request.input.mechanism === undefined
              ? {}
              : { mechanism: request.input.mechanism }),
            ...(request.input.structuralChain === undefined
              ? {}
              : { structuralChain: request.input.structuralChain }),
          });
          return compiled.ok
            ? { status: "compiled", compiled: compiled.value }
            : {
                status: "failed",
                error: simDecline("sim.compile", compiled.error),
              };
        }
        case "sim.run": {
          const problem = problems.get(request.input.problem);
          if (problem === undefined) {
            return {
              status: "failed",
              error: simWorkerError(
                SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The "sim.run" input references problem "${request.input.problem}" that this worker session does not own (unknown, or from another channel).`,
                { simCode: "sim/problem-unknown" },
              ),
            };
          }
          if (!engine.supportedKinds.includes(problem.kind)) {
            return {
              status: "failed",
              error: simWorkerError(
                SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The hosted engine "${engine.id}" does not solve the "${problem.kind}" scenario kind.`,
                { simCode: "sim/scenario-kind-unsupported" },
              ),
            };
          }
          let steps = 0;
          let chunks = 0;
          // Each emission callback first checks the abort set: a run whose
          // cancellation arrived mid-run unwinds at the next emission (the
          // cooperative fast path), and no notification crosses the channel
          // after the cancellation took effect.
          const onProgress = (progress: SimEngineProgress): void => {
            if (aborted.has(requestId))
              throw new SimRunCancelledError(requestId);
            steps = Math.max(steps, progress.step);
            transport.send(createSimProgressNotification(requestId, progress));
          };
          const onFieldChunk = (chunk: SimEngineFieldChunk): void => {
            if (aborted.has(requestId))
              throw new SimRunCancelledError(requestId);
            chunks += 1;
            transport.send(createSimFieldChunkNotification(requestId, chunk));
          };
          try {
            const result = await engine.run(
              { compiled: problem },
              onProgress,
              onFieldChunk,
            );
            if (!result.ok) {
              return {
                status: "failed",
                error: simDecline("sim.run", result.error),
              };
            }
            return {
              status: "ran",
              steps,
              chunks,
              result: result.value,
            };
          } catch (error) {
            if (error instanceof SimRunCancelledError) {
              // The cooperative-unwind sentinel: an internal stand-in for the
              // cancellation the ledger already recorded. It routes through
              // finish as a failure so the pinned rule replaces it with the
              // cancelled ack (suppress) — and the defensive deliver branch
              // below answers it as an operation failure, never a success.
              return {
                status: "failed",
                error: simWorkerError(
                  SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                  `The "sim.run" operation unwound after its cancellation: ${error.message}`,
                  { simCode: "worker/cancelled" },
                ),
              };
            }
            return {
              status: "failed",
              error: unexpectedThrow("sim.run", error),
            };
          }
        }
        case "sim.finalize": {
          const result = runs.get(request.input.run);
          if (result === undefined) {
            return {
              status: "failed",
              error: simWorkerError(
                SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The "sim.finalize" input references run "${request.input.run}" that this worker session does not own (unknown, failed, or cancelled — nothing finalized).`,
                { simCode: "sim/run-unknown" },
              ),
            };
          }
          const finalized = simResultToFinalizeResult(result);
          return finalized.ok
            ? {
                status: "finalized",
                response: createSimWorkerSuccessResponse(
                  requestId,
                  "sim.finalize",
                  finalized.value,
                ),
              }
            : {
                status: "failed",
                error: simWorkerError(
                  SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                  `The "sim.finalize" operation failed: ${finalized.error.message}`,
                  { simCode: "sim/result-payload-malformed" },
                ),
              };
        }
        case "sim.optimize": {
          // The Phase 70a seam: the optimization runner is an injection
          // (sim-core stays runtime-dependency-free); a host that did not
          // inject one declines loudly, never fabricates a campaign.
          if (optimizer === undefined) {
            return {
              status: "failed",
              error: simWorkerError(
                SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                'The "sim.optimize" operation needs an optimization executor this worker does not host (the NSGA-II driver is an injected seam, never an assumption).',
                { simCode: "sim/optimizer-unavailable" },
              ),
            };
          }
          // The emission wrappers mirror the run case: each checks the
          // abort set first (the cooperative window), then streams.
          const onProgress = (progress: SimEngineProgress): void => {
            if (aborted.has(requestId))
              throw new SimRunCancelledError(requestId);
            transport.send(createSimProgressNotification(requestId, progress));
          };
          const onOptimizationGeneration = (
            notice: SimEngineOptimizationGeneration,
          ): void => {
            if (aborted.has(requestId))
              throw new SimRunCancelledError(requestId);
            transport.send(
              createSimOptimizationGenerationNotification(requestId, notice),
            );
          };
          const outcome = await optimizer(request.input, {
            onProgress,
            onOptimizationGeneration,
            shouldAbort: () => aborted.has(requestId),
          });
          return outcome.ok
            ? { status: "optimized", result: outcome.value }
            : {
                status: "failed",
                error: simDecline("sim.optimize", outcome.error),
              };
        }
      }
    } catch (error) {
      return {
        status: "failed",
        error: unexpectedThrow(request.operation, error),
      };
    }
  }

  function finishAndRespond(
    requestId: SimWorkerRequestId,
    outcome: SimExecutionOutcome,
  ): void {
    const decision = ledger.finish(requestId);
    aborted.delete(requestId);
    if (decision === "suppress") {
      // Cancellation wins ties: drop the computed outcome. A suppressed run
      // mints no run id and stores no result, exactly as a suppressed
      // kernel computation mints no solid id.
      transport.send(cancelledAck(requestId, "while the request was running"));
      return;
    }
    if (outcome.status === "compiled") {
      const problem = ids.nextProblemId();
      problems.set(problem, outcome.compiled);
      transport.send(
        createSimWorkerSuccessResponse(requestId, "sim.compile", {
          problem,
          compiled: outcome.compiled,
        }),
      );
      return;
    }
    if (outcome.status === "ran") {
      const run = ids.nextRunId();
      runs.set(run, outcome.result);
      transport.send(
        createSimWorkerSuccessResponse(requestId, "sim.run", {
          run,
          steps: outcome.steps,
          chunks: outcome.chunks,
        }),
      );
      return;
    }
    if (outcome.status === "optimized") {
      // The campaign identity is deterministic (study content + seed hash),
      // so the response mints no session id — the campaign re-runs
      // identically and persists through the store, never the session.
      transport.send(
        createSimWorkerSuccessResponse(requestId, "sim.optimize", {
          campaign: outcome.result.campaign,
          generations: outcome.result.generations,
          evaluations: outcome.result.evaluations,
          declined: outcome.result.declined,
          pareto: outcome.result.pareto,
        }),
      );
      return;
    }
    transport.send(
      outcome.status === "finalized"
        ? outcome.response
        : createSimWorkerErrorResponse(requestId, outcome.error),
    );
  }

  async function respondExecuted(
    message: SimWorkerRequestMessage,
  ): Promise<void> {
    // Decode failure is a computed outcome too: it routes through finish, so
    // a cancellation recorded between admission and execution still wins.
    const decoded = decodeSimWorkerRequest(message);
    const outcome: SimExecutionOutcome = decoded.ok
      ? await execute(message.requestId, decoded.value)
      : {
          status: "failed",
          error: simWorkerError(decoded.error.code, decoded.error.message),
        };
    finishAndRespond(message.requestId, outcome);
  }

  function receive(data: unknown): void {
    const parsed = parseSimWorkerMessage(data);
    if (!parsed.ok) {
      // Correlation is impossible for an unparseable message: answer with a
      // null request id so the sender can only log, never mis-correlate.
      transport.send(
        createSimWorkerErrorResponse(
          null,
          simWorkerError(parsed.error.code, parsed.error.message),
        ),
      );
      return;
    }
    const message = parsed.value;
    if (message.kind === "response" || message.kind === "notification") {
      // A response or notification arriving in the responder role is
      // misdirected; the protocol gives this end no way to act on it.
      return;
    }
    if (message.kind === "cancel") {
      // Best-effort: record the intent for the pinned rule and, while the
      // request still runs, for the cooperative unwinding at its next
      // emission.
      ledger.cancel(message.requestId);
      aborted.add(message.requestId);
      return;
    }
    const decision = ledger.start(message.requestId);
    if (decision === "refuse-duplicate") {
      transport.send(
        createSimWorkerErrorResponse(
          message.requestId,
          simWorkerError(
            SIM_WORKER_PROTOCOL_ERROR_CODES.duplicateRequest,
            `A request id is single-use per channel: "${message.requestId}" was already used (running, answered, or refused).`,
          ),
        ),
      );
      return;
    }
    if (decision === "refuse-cancelled") {
      transport.send(
        cancelledAck(message.requestId, "before the request arrived"),
      );
      return;
    }
    // Asynchronous by contract (an engine run rides a worker's event loop);
    // the ledger's cancellation window stays open for cancels arriving
    // while the engine computes.
    void respondExecuted(message);
  }

  const unsubscribe = transport.onMessage(receive);
  return {
    close(): void {
      unsubscribe();
    },
  };
}
