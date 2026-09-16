/**
 * The generic worker client (Phase 10.2): issues Phase 10.1 requests over a
 * {@link WorkerTransport} and settles one promise per request, correlated by
 * {@link WorkerRequestId}. Like the server, it depends only on the transport
 * interface and the protocol types — swapping the in-memory transport for the
 * Phase 10.3 real worker transport changes nothing here.
 *
 * ## Correlation and id discipline
 *
 * Each `request` mints (or adopts) a single-use request id, remembers how to
 * settle that request's promise, and sends the wire form built by
 * `createWorkerRequest`. Every arriving message crosses the protocol's parse
 * boundary; only a *response* for an id the client itself issued and has not
 * yet settled can settle a promise — late, foreign, misdirected, and
 * uncorrelatable (`requestId: null`) messages are dropped deterministically.
 * An id that this client already issued (running or settled) is refused
 * locally with the ledger's `worker/duplicate-request` structured failure
 * without touching the channel, mirroring the server's own admission rule.
 *
 * ## Failure shape
 *
 * The promise rejects with a {@link WorkerRequestFailure} carrying the
 * structured {@link WorkerError} of the response (or of the locally decoded
 * payload failure) — never a bare string, never a silently dropped error.
 *
 * ## Cancellation, caller side
 *
 * `cancel(requestId)` implements the caller-side mirror of the pinned
 * cancellation rule: the request becomes void the moment it is cancelled —
 * its promise settles exactly then with the structured `worker/cancelled`
 * failure, and any success response that nevertheless crosses the wire
 * afterwards is discarded (it lost the race at the responder and must never
 * resolve a void request — never a late success). The cancel message is still
 * sent so the responder can stop and acknowledge. Cancelling an unknown or
 * already-settled id is a no-op: an emitted response cannot be unsent, which
 * is the ledger's own "ignored" outcome.
 *
 * One hygiene rule rides that discard. A straggling success may carry a
 * freshly minted session solid that nobody will ever reference: the voided
 * request's caller is gone by definition, and the coordinator that cancelled
 * it never learns the id — without hygiene the solid stays owned invisibly
 * forever. So the client inspects each discarded success of a request *it*
 * voided and, when the operation's result mints a solid
 * (`resultMintsSolid`), issues a best-effort `solid.dispose` for it under a
 * request id derived from the voided id. Best-effort is the honest contract:
 * a refusal has no caller left to inform, so it is dropped after the attempt
 * — the alternative is a permanently owned invisible solid. The pinned rule
 * itself is untouched: the straggling success still settles nothing, and
 * successes for requests that settled normally are dropped without hygiene
 * (their solids belong to their callers).
 *
 * ## Closure
 *
 * `close()` unsubscribes from the transport and settles every still-pending
 * request with the structured `worker/transport-closed` failure: a closed
 * channel can never deliver a response, so an in-flight promise must not stay
 * pending forever (the termination rule a real-worker host relies on when its
 * thread exits). A response arriving after close correlates with nothing.
 */

import type { WorkerIdGenerator, WorkerRequestId } from "./worker-ids";
import type {
  WorkerOperationId,
  WorkerOperationInput,
  WorkerOperationResult,
} from "./worker-operations";
import type { WorkerTransport } from "./worker-transport";

import {
  toWorkerError,
  type WorkerError,
  workerError,
  WORKER_PROTOCOL_ERROR_CODES,
} from "./worker-errors";
import { createWorkerIdGenerator, parseWorkerRequestId } from "./worker-ids";
import { resultMintsSolid } from "./worker-operations";
import {
  createWorkerCancel,
  createWorkerErrorResponse,
  createWorkerRequest,
  decodeWorkerResult,
  parseWorkerMessage,
  type WorkerResponseMessage,
  type WorkerSuccessResponseMessage,
} from "./worker-protocol";


/**
 * The structured failure a request promise rejects with: the wire
 * {@link WorkerError} verbatim, so callers branch on stable codes
 * (`worker/operation-failed`, `worker/cancelled`, …), not message text.
 */
export class WorkerRequestFailure extends Error {
  readonly error: WorkerError;

  constructor(error: WorkerError) {
    super(error.message);
    this.name = "WorkerRequestFailure";
    this.error = error;
  }
}

/** Options of {@link createWorkerClient}. */
export interface WorkerClientOptions {
  /** The transport end the client sends requests on. */
  readonly transport: WorkerTransport;
  /**
   * Mints the client's {@link WorkerRequestId}s. Defaults to a fresh
   * generator; pass one to pin or inspect id assignment.
   */
  readonly ids?: WorkerIdGenerator;
}

/** The request/cancellation surface of one channel end. */
export interface WorkerClient {
  /**
   * Executes an operation on the hosted kernel and resolves its typed result.
   * Pass `requestId` to adopt a caller-chosen id exactly as given; an id this
   * client already issued rejects with `worker/duplicate-request` locally.
   */
  request<O extends WorkerOperationId>(
    operation: O,
    input: WorkerOperationInput<O>,
    requestId?: WorkerRequestId,
  ): Promise<WorkerOperationResult<O>>;
  /**
   * Voids the in-flight request bearing `requestId`: settles its promise with
   * the structured `worker/cancelled` failure, sends the cancel message, and
   * discards any late success for it. A no-op for unknown or settled ids.
   */
  cancel(requestId: WorkerRequestId): void;
  /** Unsubscribes from the transport; later responses are dropped. */
  close(): void;
}

/** One in-flight request: the operation it bears, and how to settle it. */
interface PendingRequest {
  readonly operation: WorkerOperationId;
  readonly settle: (message: WorkerResponseMessage) => void;
}

/** Creates a worker-protocol client on the given transport end. */
export function createWorkerClient(options: WorkerClientOptions): WorkerClient {
  const { transport } = options;
  const ids = options.ids ?? createWorkerIdGenerator();
  // Settlers are closures created in each request's generic scope, where the
  // operation is statically known; the map only ever sees them as part of a
  // PendingRequest carrying the runtime operation id — no widening, no casts.
  const pending = new Map<WorkerRequestId, PendingRequest>();
  const spent = new Set<WorkerRequestId>();
  // Requests this client voided by cancel, keyed by id. The retained
  // operation lets the discard site decide whether a straggling success mints
  // a solid that needs releasing; an entry is consumed by the first such
  // success and outlives only cancels whose success never crossed (the
  // responder suppressed it) — bookkeeping bounded by the channel's
  // cancellation traffic, mirroring `spent`.
  const voided = new Map<WorkerRequestId, WorkerOperationId>();

  function issue<O extends WorkerOperationId>(
    operation: O,
    input: WorkerOperationInput<O>,
    id: WorkerRequestId,
  ): Promise<WorkerOperationResult<O>> {
    if (spent.has(id)) {
      return Promise.reject(
        new WorkerRequestFailure(
          workerError(
            WORKER_PROTOCOL_ERROR_CODES.duplicateRequest,
            `A request id is single-use per channel: "${id}" was already issued by this client.`,
          ),
        ),
      );
    }
    spent.add(id);
    return new Promise<WorkerOperationResult<O>>((resolve, reject) => {
      pending.set(id, {
        operation,
        settle: (message) => {
          if (message.status === "error") {
            reject(new WorkerRequestFailure(message.error));
            return;
          }
          const decoded = decodeWorkerResult(message, operation);
          if (!decoded.ok) {
            reject(new WorkerRequestFailure(toWorkerError(decoded.error)));
            return;
          }
          resolve(decoded.value);
        },
      });
      transport.send(createWorkerRequest(id, operation, input));
    });
  }

  /**
   * Hygiene for a straggling success of a request this client voided: the
   * pinned rule discards the message (it settles nothing), and if its result
   * minted a session solid, that solid is an orphan nobody else will ever
   * dispose — so it is disposed best-effort, right at the discard site.
   * Successes for foreign or normally settled ids are untouched: their
   * solids (when real) belong to whoever settled them.
   */
  function discardVoidedSuccess(message: WorkerSuccessResponseMessage): void {
    const operation = voided.get(message.requestId);
    if (operation === undefined) return; // not ours to void: "ignored".
    // One straggler per voided id: later duplicates stay plain drops, and
    // the derived disposal id below is issued at most once.
    voided.delete(message.requestId);
    const decoded = decodeWorkerResult(message, operation);
    if (!decoded.ok) return; // no trustworthy mint to release.
    const mint = resultMintsSolid(operation, decoded.value);
    if (mint === undefined) return; // the result owns no session solid.
    // The disposal id is derived from the voided id: single-use discipline
    // makes that id unique and spent, and only one straggler is processed,
    // so `<voided>.disposal` cannot collide with a generator-minted id
    // (numeric payloads) — the disposal speaks for the request whose orphan
    // it releases, whatever generators the callers layered on this client.
    const disposalId = parseWorkerRequestId(`${message.requestId}.disposal`);
    if (!disposalId.ok) return; // pathological id length: skip the hygiene.
    void issue("solid.dispose", { solid: mint }, disposalId.value).then(
      undefined,
      () => {
        // Best-effort by contract: the voided request's caller is gone, so a
        // refusal has nobody to inform. Dropped after the attempt — the
        // alternative is a permanently owned invisible solid.
      },
    );
  }

  function handleMessage(data: unknown): void {
    const parsed = parseWorkerMessage(data);
    if (!parsed.ok) return; // malformed channel data correlates with nothing.
    const message = parsed.value;
    if (message.kind !== "response") return; // misdirected request/cancel.
    if (message.requestId === null) return; // uncorrelatable.
    const entry = pending.get(message.requestId);
    if (entry === undefined) {
      // Late, foreign, or already void: correlates with no live promise. A
      // straggling success of a request this client voided still gets its
      // orphaned mint released before the message is dropped.
      if (message.status === "ok") discardVoidedSuccess(message);
      return;
    }
    pending.delete(message.requestId);
    entry.settle(message);
  }

  const unsubscribe = transport.onMessage(handleMessage);

  return {
    request<O extends WorkerOperationId>(
      operation: O,
      input: WorkerOperationInput<O>,
      requestId?: WorkerRequestId,
    ): Promise<WorkerOperationResult<O>> {
      return issue(operation, input, requestId ?? ids.nextRequestId());
    },
    cancel(requestId: WorkerRequestId): void {
      const entry = pending.get(requestId);
      if (entry === undefined) return; // unknown or settled: the ledger's "ignored".
      pending.delete(requestId);
      // Remember the void so a straggling success can be discarded WITH
      // hygiene: its mint, if any, is an orphan nobody else will dispose.
      voided.set(requestId, entry.operation);
      transport.send(createWorkerCancel(requestId));
      // The request is void from the caller's side exactly now; this is the
      // same structured settlement the responder's cancellation-ack produces.
      entry.settle(
        createWorkerErrorResponse(
          requestId,
          workerError(
            WORKER_PROTOCOL_ERROR_CODES.cancelled,
            `The request "${requestId}" was cancelled by the caller; its outcome is void.`,
          ),
        ),
      );
    },
    close(): void {
      unsubscribe();
      // Closing the channel orphans every in-flight request: no response can
      // ever arrive for it anymore. Each settles now with the structured
      // `worker/transport-closed` failure instead of pending forever — the
      // termination rule a real-worker host relies on when its thread exits
      // (deliberately or by crash).
      if (pending.size === 0) return;
      const orphaned = [...pending.entries()];
      pending.clear();
      for (const [id, entry] of orphaned) {
        entry.settle(
          createWorkerErrorResponse(
            id,
            workerError(
              WORKER_PROTOCOL_ERROR_CODES.transportClosed,
              `The transport closed while the request "${id}" was in flight; its outcome is unknown and the request is void.`,
            ),
          ),
        );
      }
    },
  };
}
