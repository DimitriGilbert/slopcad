/**
 * The sim worker client (Phase 61b): issues `sim.*` requests over a
 * {@link SimWorkerTransport} and settles one promise per request, correlated
 * by {@link SimWorkerRequestId} — the kernel protocol's `worker-client`
 * (`@slopcad/cad-kernel`), restated and extended with the notification
 * subscription the new message class exists for.
 *
 * ## Correlation and id discipline
 *
 * Each `request` mints (or adopts) a single-use request id, remembers how to
 * settle that request's promise, and sends the wire form built by
 * `createSimWorkerRequest`. Every arriving message crosses the protocol's
 * parse boundary; only a *response* for an id the client itself issued and
 * has not yet settled can settle a promise — late, foreign, misdirected, and
 * uncorrelatable (`requestId: null`) messages are dropped deterministically.
 * An id this client already issued is refused locally with
 * `worker/duplicate-request` without touching the channel.
 *
 * ## Notifications
 *
 * The new worker→host class: `onNotification` subscribes a handler that
 * receives every notification whose request id the client holds PENDING —
 * the streaming surface a workbench renders as committed applications per
 * law S6. A notification for an unknown or settled id is late, foreign, or
 * misdirected and dropped (the same correlation rule as responses); it never
 * settles anything.
 *
 * ## Failure shape
 *
 * The promise rejects with a {@link SimRequestFailure} carrying the
 * structured {@link SimWorkerError} of the response (or of the locally
 * decoded payload failure) — never a bare string.
 *
 * ## Cancellation, caller side
 *
 * `cancel(requestId)` implements the caller-side mirror of the pinned
 * cancellation rule: the request becomes void the moment it is cancelled —
 * its promise settles exactly then with the structured `worker/cancelled`
 * failure, and any success response that nevertheless crosses the wire
 * afterwards is discarded. The cancel message is still sent so the
 * responder can stop and acknowledge. Cancelling an unknown or
 * already-settled id is a no-op.
 *
 * ## Closure
 *
 * `close()` unsubscribes from the transport and settles every still-pending
 * request with the structured `worker/transport-closed` failure: a closed
 * channel can never deliver a response, so an in-flight promise must not
 * stay pending forever (the termination rule a real-worker host relies on
 * when its thread exits — deliberately or by crash). Closure is terminal:
 * a `request()` issued after `close()` is refused locally with the same
 * structured failure, and notification delivery stops.
 */

import type {
  SimWorkerIdGenerator,
  SimWorkerRequestId,
} from "./sim-worker-ids";
import type {
  SimWorkerOperationId,
  SimWorkerOperationInput,
  SimWorkerOperationResult,
} from "./sim-worker-operations";
import type {
  SimNotificationDelivery,
  SimWorkerResponseMessage,
} from "./sim-worker-protocol";
import type { SimWorkerTransport } from "./sim-transport";

import {
  toSimWorkerError,
  type SimWorkerError,
  SIM_WORKER_PROTOCOL_ERROR_CODES,
  simWorkerError,
} from "./sim-worker-errors";
import { createSimWorkerIdGenerator } from "./sim-worker-ids";
import {
  createSimWorkerCancel,
  createSimWorkerErrorResponse,
  createSimWorkerRequest,
  decodeSimWorkerNotification,
  decodeSimWorkerResult,
  parseSimWorkerMessage,
} from "./sim-worker-protocol";

/**
 * The structured failure a request promise rejects with: the wire
 * {@link SimWorkerError} verbatim, so callers branch on stable codes
 * (`worker/operation-failed`, `worker/cancelled`, …), not message text.
 */
export class SimRequestFailure extends Error {
  readonly error: SimWorkerError;

  constructor(error: SimWorkerError) {
    super(error.message);
    this.name = "SimRequestFailure";
    this.error = error;
  }
}

/** Options of {@link createSimWorkerClient}. */
export interface SimWorkerClientOptions {
  /** The transport end the client sends requests on. */
  readonly transport: SimWorkerTransport;
  /**
   * Mints the client's {@link SimWorkerRequestId}s. Defaults to a fresh
   * generator; pass one to pin or inspect id assignment.
   */
  readonly ids?: SimWorkerIdGenerator;
}

/** The request/notification/cancellation surface of one channel end. */
export interface SimWorkerClient {
  /**
   * Executes an operation on the hosted engine and resolves its typed
   * result. Pass `requestId` to adopt a caller-chosen id exactly as given;
   * an id this client already issued rejects with `worker/duplicate-request`
   * locally.
   */
  request<O extends SimWorkerOperationId>(
    operation: O,
    input: SimWorkerOperationInput<O>,
    requestId?: SimWorkerRequestId,
  ): Promise<SimWorkerOperationResult<O>>;
  /**
   * Subscribes a handler to the notification stream: every progress and
   * field-chunk notification whose request id this client holds pending.
   * Returns the unsubscribe function. Multiple handlers hear every
   * notification in subscription order.
   */
  onNotification(
    handler: (delivery: SimNotificationDelivery) => void,
  ): () => void;
  /**
   * Voids the in-flight request bearing `requestId`: settles its promise
   * with the structured `worker/cancelled` failure, sends the cancel
   * message, and discards any late success for it. A no-op for unknown or
   * settled ids.
   */
  cancel(requestId: SimWorkerRequestId): void;
  /**
   * Unsubscribes from the transport and settles every still-pending request
   * with `worker/transport-closed`; later responses are dropped, later
   * requests are refused locally with the same structured failure, and
   * notification delivery stops.
   */
  close(): void;
}

/** One in-flight request: the operation it bears, and how to settle it. */
interface PendingRequest {
  readonly operation: SimWorkerOperationId;
  readonly settle: (message: SimWorkerResponseMessage) => void;
}

/** Creates a sim worker-protocol client on the given transport end. */
export function createSimWorkerClient(
  options: SimWorkerClientOptions,
): SimWorkerClient {
  const { transport } = options;
  const ids = options.ids ?? createSimWorkerIdGenerator();
  // Settlers are closures created in each request's generic scope, where the
  // operation is statically known; the map only ever sees them as part of a
  // PendingRequest carrying the runtime operation id — no widening, no casts.
  const pending = new Map<SimWorkerRequestId, PendingRequest>();
  const spent = new Set<SimWorkerRequestId>();
  const notificationHandlers: Array<
    (delivery: SimNotificationDelivery) => void
  > = [];
  // Terminal once close() runs: a closed channel can never deliver a
  // response or notification, so no request issued afterwards may register
  // a pending entry. Idempotent by construction.
  let closed = false;

  function issue<O extends SimWorkerOperationId>(
    operation: O,
    input: SimWorkerOperationInput<O>,
    id: SimWorkerRequestId,
  ): Promise<SimWorkerOperationResult<O>> {
    if (closed) {
      // The channel is gone: refuse locally with the same structured
      // settlement close() gives in-flight requests, instead of stranding a
      // pending entry no surviving message can ever settle. The request is
      // void and never sent.
      return Promise.reject(
        new SimRequestFailure(
          simWorkerError(
            SIM_WORKER_PROTOCOL_ERROR_CODES.transportClosed,
            `The transport is closed; the request "${id}" was refused locally and never sent, so its outcome is void.`,
          ),
        ),
      );
    }
    if (spent.has(id)) {
      return Promise.reject(
        new SimRequestFailure(
          simWorkerError(
            SIM_WORKER_PROTOCOL_ERROR_CODES.duplicateRequest,
            `A request id is single-use per channel: "${id}" was already issued by this client.`,
          ),
        ),
      );
    }
    spent.add(id);
    return new Promise<SimWorkerOperationResult<O>>((resolve, reject) => {
      pending.set(id, {
        operation,
        settle: (message) => {
          if (message.status === "error") {
            reject(new SimRequestFailure(message.error));
            return;
          }
          const decoded = decodeSimWorkerResult(message, operation);
          if (!decoded.ok) {
            reject(new SimRequestFailure(toSimWorkerError(decoded.error)));
            return;
          }
          resolve(decoded.value);
        },
      });
      transport.send(createSimWorkerRequest(id, operation, input));
    });
  }

  function handleMessage(data: unknown): void {
    const parsed = parseSimWorkerMessage(data);
    if (!parsed.ok) return; // malformed channel data correlates with nothing.
    const message = parsed.value;
    if (message.kind === "notification") {
      if (closed) return;
      if (!pending.has(message.requestId)) {
        return; // late, foreign, or already settled: streams for nothing.
      }
      const decoded = decodeSimWorkerNotification(message);
      if (!decoded.ok) return; // a notification that cannot decode delivers nothing.
      for (const handler of [...notificationHandlers]) {
        handler(decoded.value);
      }
      return;
    }
    if (message.kind !== "response") return; // misdirected request/cancel.
    if (message.requestId === null) return; // uncorrelatable.
    const entry = pending.get(message.requestId);
    if (entry === undefined) {
      return; // late, foreign, or already void: settles nothing.
    }
    pending.delete(message.requestId);
    entry.settle(message);
  }

  const unsubscribe = transport.onMessage(handleMessage);

  return {
    request<O extends SimWorkerOperationId>(
      operation: O,
      input: SimWorkerOperationInput<O>,
      requestId?: SimWorkerRequestId,
    ): Promise<SimWorkerOperationResult<O>> {
      return issue(operation, input, requestId ?? ids.nextRequestId());
    },
    onNotification(
      handler: (delivery: SimNotificationDelivery) => void,
    ): () => void {
      notificationHandlers.push(handler);
      return () => {
        const index = notificationHandlers.indexOf(handler);
        if (index >= 0) notificationHandlers.splice(index, 1);
      };
    },
    cancel(requestId: SimWorkerRequestId): void {
      const entry = pending.get(requestId);
      if (entry === undefined) return; // unknown or settled: the ledger's "ignored".
      pending.delete(requestId);
      transport.send(createSimWorkerCancel(requestId));
      // The request is void from the caller's side exactly now; this is the
      // same structured settlement the responder's cancellation-ack produces.
      entry.settle(
        createSimWorkerErrorResponse(
          requestId,
          simWorkerError(
            SIM_WORKER_PROTOCOL_ERROR_CODES.cancelled,
            `The request "${requestId}" was cancelled by the caller; its outcome is void.`,
          ),
        ),
      );
    },
    close(): void {
      // Closed from here on, forever: requests issued after this line are
      // refused locally instead of pending (see `issue`), and notifications
      // stop delivering.
      closed = true;
      unsubscribe();
      // Closing the channel orphans every in-flight request: no response can
      // ever arrive for it anymore. Each settles now with the structured
      // `worker/transport-closed` failure instead of pending forever.
      if (pending.size === 0) return;
      const orphaned = [...pending.entries()];
      pending.clear();
      for (const [id, entry] of orphaned) {
        entry.settle(
          createSimWorkerErrorResponse(
            id,
            simWorkerError(
              SIM_WORKER_PROTOCOL_ERROR_CODES.transportClosed,
              `The transport closed while the request "${id}" was in flight; its outcome is unknown and the request is void.`,
            ),
          ),
        );
      }
    },
  };
}
