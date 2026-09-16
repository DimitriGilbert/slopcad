/**
 * The generic worker server (Phase 10.2): hosts the Phase 10.1 operation
 * vocabulary against any {@link GeometryKernel} — the fake kernel today, the
 * Manifold adapter in Phase 10.3 — over any {@link WorkerTransport}. It is a
 * generic adapter from the kernel contract to the worker protocol, and knows
 * no kernel specifics beyond the contract itself.
 *
 * ## The pipeline of one request
 *
 * 1. **Parse** — every arriving message crosses the Phase 10.1 trust boundary
 *    (`parseWorkerMessage`). An unparseable message gets one error response
 *    with `requestId: null` (correlation impossible — a version-gate failure
 *    cannot even trust the id field) and never reaches the kernel.
 * 2. **Admit** — a parsed request is admitted through the cancellation ledger
 *    (`start`): a duplicate id is refused with `worker/duplicate-request`,
 *    a cancelled id with the `worker/cancelled` ack, and neither executes
 *    anything. A cancel message is recorded in the ledger (`cancel`) and
 *    answered with nothing — the ack, when there is one, is the refused or
 *    suppressed request's own terminal error response. A message arriving in
 *    the responder role that is a *response* is misdirected and dropped.
 * 3. **Execute** — admitted requests execute in a separate microtask, after
 *    the receive callback returns (mirroring a real worker's non-reentrant
 *    message loop, and making the ledger's cancellation window observable:
 *    a cancel queued behind a request is recorded before the request runs).
 *    Execution decodes the operation (`decodeWorkerRequest`), resolves every
 *    {@link WorkerSolidId} input against the session's solid map, calls the
 *    kernel, and runs the computed outcome through `ledger.finish`: a
 *    suppressed outcome is dropped and replaced by the `worker/cancelled`
 *    ack, so a late success can never be emitted after a recorded
 *    cancellation.
 *
 * ## Solid-id mapping lifecycle
 *
 * The wire addresses solids by {@link WorkerSolidId}; the kernel by its
 * opaque `KernelSolid` handles. The server keeps the session's mapping and
 * mints ids with a deterministic {@link WorkerIdGenerator} *at delivery
 * time*: a solid id is assigned when a result is actually emitted, in
 * delivery order, so the same request sequence over a fresh session assigns
 * identical ids and a cancelled computation consumes none. `solid.dispose`
 * releases the mapping (after the kernel's own `dispose`); an input
 * referencing an unknown or disposed id fails before the kernel is called,
 * with the solid-not-owned equivalent structured error:
 * `worker/operation-failed` carrying `data.kernelCode = kernel/solid-not-owned`.
 * Every other kernel failure rides the same `worker/operation-failed` shape
 * with its kernel code in `data`; a kernel that breaks the contract and
 * throws is converted the same way instead of poisoning the channel.
 */

import type { WorkerCancellationLedger } from "./worker-cancellation";
import type { WorkerIdGenerator, WorkerSolidId } from "./worker-ids";
import type {
  DecodedWorkerRequest,
  WorkerRequestMessage,
  WorkerResponseMessage,
  WorkerSuccessResponseMessage,
} from "./worker-protocol";
import type { WorkerTransport } from "./worker-transport";

import {
  KERNEL_ERROR_CODES,
  type GeometryKernel,
  type KernelError,
  type KernelSolid,
} from "./contract";
import { createWorkerCancellationLedger } from "./worker-cancellation";
import {
  toWorkerError,
  type WorkerError,
  workerError,
  WORKER_PROTOCOL_ERROR_CODES,
} from "./worker-errors";
import { createWorkerIdGenerator } from "./worker-ids";
import {
  createWorkerErrorResponse,
  createWorkerSuccessResponse,
  decodeWorkerRequest,
  parseWorkerMessage,
} from "./worker-protocol";


/** The operations whose success mints a new session solid. */
type SolidProducingOperation =
  | "solid.createBox"
  | "solid.createSphere"
  | "solid.createCylinder"
  | "solid.createCone"
  | "solid.union"
  | "solid.subtract"
  | "solid.intersect"
  | "solid.transform";

/** What executing a request produced, before the ledger decides delivery. */
type ExecutionOutcome =
  | {
      readonly status: "solid";
      readonly operation: SolidProducingOperation;
      readonly handle: KernelSolid;
    }
  | { readonly status: "value"; readonly response: WorkerSuccessResponseMessage }
  | { readonly status: "failed"; readonly error: WorkerError };

/** Options of {@link createWorkerServer}. */
export interface WorkerServerOptions {
  /** The kernel that executes the operations — any contract implementation. */
  readonly kernel: GeometryKernel;
  /** The transport end the server listens on and answers from. */
  readonly transport: WorkerTransport;
  /**
   * Mints the session's {@link WorkerSolidId}s. Defaults to a fresh
   * generator; pass one to pin or inspect id assignment.
   */
  readonly ids?: WorkerIdGenerator;
  /** The responder-side cancellation ledger. Defaults to a fresh one. */
  readonly ledger?: WorkerCancellationLedger;
}

/** A hosted kernel: subscribed to its transport until closed. */
export interface WorkerServer {
  /** Unsubscribes from the transport; later messages are ignored. */
  close(): void;
}

/** Hosts `options.kernel` as a worker-protocol responder on its transport. */
export function createWorkerServer(options: WorkerServerOptions): WorkerServer {
  const { kernel, transport } = options;
  const ids = options.ids ?? createWorkerIdGenerator();
  const ledger = options.ledger ?? createWorkerCancellationLedger();
  const solids = new Map<WorkerSolidId, KernelSolid>();

  function cancelledAck(
    requestId: WorkerRequestMessage["requestId"],
    reason: string,
  ): WorkerResponseMessage {
    return createWorkerErrorResponse(
      requestId,
      workerError(
        WORKER_PROTOCOL_ERROR_CODES.cancelled,
        `The request "${requestId}" was cancelled (${reason}); its outcome is void.`,
      ),
    );
  }

  function solidNotOwnedError(
    operation: DecodedWorkerRequest["operation"],
    id: WorkerSolidId,
  ): WorkerError {
    return workerError(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" input references solid "${id}" that this worker session does not own (unknown or already disposed).`,
      { kernelCode: KERNEL_ERROR_CODES.solidNotOwned },
    );
  }

  function kernelFailure(
    operation: DecodedWorkerRequest["operation"],
    error: KernelError,
  ): WorkerError {
    return workerError(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" operation failed: ${error.message}`,
      { kernelCode: error.code },
    );
  }

  function unexpectedThrow(
    operation: DecodedWorkerRequest["operation"],
    error: unknown,
  ): WorkerError {
    const detail = error instanceof Error ? error.message : String(error);
    return workerError(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" operation threw unexpectedly: ${detail}`,
      { thrown: true },
    );
  }

  type SolidLookup =
    | { readonly status: "owned"; readonly handle: KernelSolid }
    | { readonly status: "failed"; readonly error: WorkerError };

  function ownedSolid(
    operation: DecodedWorkerRequest["operation"],
    id: WorkerSolidId,
  ): SolidLookup {
    const handle = solids.get(id);
    return handle === undefined
      ? { status: "failed", error: solidNotOwnedError(operation, id) }
      : { status: "owned", handle };
  }

  function execute(
    requestId: WorkerRequestMessage["requestId"],
    request: DecodedWorkerRequest,
  ): ExecutionOutcome {
    try {
      switch (request.operation) {
        case "solid.createBox": {
          const result = kernel.createBox(request.input);
          return result.ok
            ? { status: "solid", operation: "solid.createBox", handle: result.value }
            : { status: "failed", error: kernelFailure("solid.createBox", result.error) };
        }
        case "solid.createSphere": {
          const result = kernel.createSphere(request.input);
          return result.ok
            ? { status: "solid", operation: "solid.createSphere", handle: result.value }
            : { status: "failed", error: kernelFailure("solid.createSphere", result.error) };
        }
        case "solid.createCylinder": {
          const result = kernel.createCylinder(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.createCylinder",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.createCylinder", result.error),
              };
        }
        case "solid.createCone": {
          const result = kernel.createCone(request.input);
          return result.ok
            ? { status: "solid", operation: "solid.createCone", handle: result.value }
            : { status: "failed", error: kernelFailure("solid.createCone", result.error) };
        }
        case "solid.union": {
          const operands: KernelSolid[] = [];
          for (const id of request.input.operands) {
            const lookup = ownedSolid("solid.union", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            operands.push(lookup.handle);
          }
          const result = kernel.union(operands);
          return result.ok
            ? { status: "solid", operation: "solid.union", handle: result.value }
            : { status: "failed", error: kernelFailure("solid.union", result.error) };
        }
        case "solid.subtract": {
          const target = ownedSolid("solid.subtract", request.input.target);
          if (target.status === "failed") {
            return { status: "failed", error: target.error };
          }
          const tools: KernelSolid[] = [];
          for (const id of request.input.tools) {
            const lookup = ownedSolid("solid.subtract", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            tools.push(lookup.handle);
          }
          const result = kernel.subtract(target.handle, tools);
          return result.ok
            ? { status: "solid", operation: "solid.subtract", handle: result.value }
            : { status: "failed", error: kernelFailure("solid.subtract", result.error) };
        }
        case "solid.intersect": {
          const operands: KernelSolid[] = [];
          for (const id of request.input.operands) {
            const lookup = ownedSolid("solid.intersect", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            operands.push(lookup.handle);
          }
          const result = kernel.intersect(operands);
          return result.ok
            ? { status: "solid", operation: "solid.intersect", handle: result.value }
            : { status: "failed", error: kernelFailure("solid.intersect", result.error) };
        }
        case "solid.transform": {
          const solid = ownedSolid("solid.transform", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.transform(solid.handle, request.input.translation);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.transform",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.transform", result.error),
              };
        }
        case "solid.bounds": {
          const solid = ownedSolid("solid.bounds", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.bounds(solid.handle);
          return result.ok
            ? {
                status: "value",
                response: createWorkerSuccessResponse(requestId, "solid.bounds", {
                  bounds: result.value,
                }),
              }
            : { status: "failed", error: kernelFailure("solid.bounds", result.error) };
        }
        case "solid.volume": {
          const solid = ownedSolid("solid.volume", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.volume(solid.handle);
          return result.ok
            ? {
                status: "value",
                response: createWorkerSuccessResponse(requestId, "solid.volume", {
                  volume: result.value,
                }),
              }
            : { status: "failed", error: kernelFailure("solid.volume", result.error) };
        }
        case "solid.tessellate": {
          const solid = ownedSolid("solid.tessellate", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.tessellate(solid.handle);
          return result.ok
            ? {
                status: "value",
                response: createWorkerSuccessResponse(requestId, "solid.tessellate", {
                  tessellation: result.value,
                }),
              }
            : {
                status: "failed",
                error: kernelFailure("solid.tessellate", result.error),
              };
        }
        case "solid.dispose": {
          const solid = ownedSolid("solid.dispose", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          kernel.dispose(solid.handle);
          solids.delete(request.input.solid);
          return {
            status: "value",
            response: createWorkerSuccessResponse(requestId, "solid.dispose", null),
          };
        }
      }
    } catch (error) {
      return { status: "failed", error: unexpectedThrow(request.operation, error) };
    }
  }

  function finishAndRespond(
    requestId: WorkerRequestMessage["requestId"],
    outcome: ExecutionOutcome,
  ): void {
    const decision = ledger.finish(requestId);
    if (decision === "suppress") {
      // Cancellation wins ties: drop the computed outcome. A computed solid
      // that will never be addressed is released, so nothing leaks past the
      // void request — and no id is minted for it.
      if (outcome.status === "solid") kernel.dispose(outcome.handle);
      transport.send(cancelledAck(requestId, "while the request was running"));
      return;
    }
    if (outcome.status === "solid") {
      const id = ids.nextSolidId();
      solids.set(id, outcome.handle);
      transport.send(
        createWorkerSuccessResponse(requestId, outcome.operation, { solid: id }),
      );
      return;
    }
    transport.send(
      outcome.status === "value"
        ? outcome.response
        : createWorkerErrorResponse(requestId, outcome.error),
    );
  }

  function respondExecuted(message: WorkerRequestMessage): void {
    // Decode failure is a computed outcome too: it routes through finish, so
    // a cancellation recorded between admission and execution still wins.
    const decoded = decodeWorkerRequest(message);
    const outcome: ExecutionOutcome = decoded.ok
      ? execute(message.requestId, decoded.value)
      : { status: "failed", error: toWorkerError(decoded.error) };
    finishAndRespond(message.requestId, outcome);
  }

  function receive(data: unknown): void {
    const parsed = parseWorkerMessage(data);
    if (!parsed.ok) {
      // Correlation is impossible for an unparseable message: answer with a
      // null request id so the sender can only log, never mis-correlate.
      transport.send(createWorkerErrorResponse(null, toWorkerError(parsed.error)));
      return;
    }
    const message = parsed.value;
    if (message.kind === "response") {
      // A response arriving in the responder role is misdirected; the
      // protocol gives this end no way to act on it, so it is dropped.
      return;
    }
    if (message.kind === "cancel") {
      // Best-effort: record the intent; the cancelled request's own
      // terminal response is the acknowledgement, and a cancel for an
      // already-finished request reports "ignored" with no emission.
      ledger.cancel(message.requestId);
      return;
    }
    const decision = ledger.start(message.requestId);
    if (decision === "refuse-duplicate") {
      transport.send(
        createWorkerErrorResponse(
          message.requestId,
          workerError(
            WORKER_PROTOCOL_ERROR_CODES.duplicateRequest,
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
    // Execute after the receive callback returns, mirroring a real worker's
    // non-reentrant message loop and keeping the cancellation window open
    // for cancels queued behind this request.
    queueMicrotask(() => respondExecuted(message));
  }

  const unsubscribe = transport.onMessage(receive);
  return {
    close(): void {
      unsubscribe();
    },
  };
}
