/**
 * Worker cancellation semantics (Phase 10.1), pinned as an executable rule.
 *
 * ## The wire
 *
 * Cancellation is a cancel message — `{ protocolVersion, kind: "cancel",
 * requestId }` (see `./worker-protocol`) — referencing the request id being
 * cancelled. It is best-effort on the responder side: a responder that is
 * already computing may finish anyway; nothing in the protocol requires
 * preemption.
 *
 * ## The pinned rule: cancellation wins ties
 *
 * The responder keeps a {@link WorkerCancellationLedger} and consults it at
 * the two moments a request changes state:
 *
 * 1. **Start** — when a request arrives (before executing). A request whose
 *    id was cancelled — by a cancel that already arrived, or that arrived
 *    *before the request itself* (cancels may overtake requests on the
 *    channel) — is refused: the responder emits one error response with code
 *    `worker/cancelled` and executes nothing. A request id that was already
 *    used — running, answered, or refused by cancellation — is refused with
 *    `worker/duplicate-request`; request ids are single-use, or correlation
 *    would be ambiguous.
 * 2. **Finish** — when the outcome is ready to emit. If the request was
 *    cancelled while running, the computed outcome is suppressed: the
 *    responder emits one error response with code `worker/cancelled` in its
 *    place and never the computed result — so a late success can never be
 *    delivered after a recorded cancellation.
 *
 * A cancel for a request that already finished is a no-op (the ledger reports
 * `"ignored"`): an emitted response cannot be unsent, and by channel ordering
 * it left before the cancel was processed, so it is not "late".
 *
 * The caller-side mirror of the same rule: once the caller has sent
 * `cancel(R)`, any success response for `R` it nevertheless receives lost
 * the race at the responder and must be discarded — the request is void.
 *
 * ## The guarantee
 *
 * For every request the responder starts, it emits exactly one terminal
 * response. After a `cancel(R)` the ledger has recorded, no code path lets a
 * success for `R` be emitted: `start` refuses it, and `finish` suppresses it.
 * The only terminal messages a cancelled request can produce are the
 * structured `worker/cancelled` error response (the cancellation-ack) or, for
 * a cancel that overtook a request which never arrived, nothing at all.
 *
 * The ledger is pure bookkeeping — no transport, no clocks — so the rule is
 * deterministic and testable; the Phase 10.2 worker server embeds it at its
 * request boundary.
 */

import type { WorkerRequestId } from "./worker-ids";

/**
 * What `start` tells the responder to do with an arriving request:
 * `"run"` (execute it), `"refuse-cancelled"` (answer `worker/cancelled`),
 * or `"refuse-duplicate"` (answer `worker/duplicate-request`).
 */
export type WorkerCancellationStartDecision =
  "run" | "refuse-cancelled" | "refuse-duplicate";

/**
 * What `finish` tells the responder to do with a computed outcome:
 * `"deliver"` (emit it), or `"suppress"` (drop it and emit the
 * `worker/cancelled` error response instead).
 */
export type WorkerCancellationFinishDecision = "deliver" | "suppress";

/**
 * What `cancel` reports: `"recorded"` (the cancellation can still take
 * effect) or `"ignored"` (the request already finished; its emitted response
 * stands).
 */
export type WorkerCancellationRecordOutcome = "recorded" | "ignored";

/** The responder-side record of request states and cancellation intents. */
export interface WorkerCancellationLedger {
  /**
   * Records intent to cancel the request bearing `requestId`. Registering an
   * id that has not arrived yet is allowed and encouraged — a cancel that
   * overtakes its request must still void it.
   */
  cancel(requestId: WorkerRequestId): WorkerCancellationRecordOutcome;
  /**
   * Decides what to do with an arriving request. Must be called exactly once
   * per received request, before executing it.
   */
  start(requestId: WorkerRequestId): WorkerCancellationStartDecision;
  /**
   * Decides whether a computed outcome may be emitted. Must be called
   * exactly once per request that was started and not refused, after its
   * outcome is ready. Throws `RangeError` on a request that was never
   * started or already finished — that is responder misuse, not protocol
   * input.
   */
  finish(requestId: WorkerRequestId): WorkerCancellationFinishDecision;
}

type RequestState = "running" | "terminal";

/**
 * Creates the cancellation ledger for one responder session. All state is
 * per channel; a request id is single-use for the ledger's lifetime.
 */
export function createWorkerCancellationLedger(): WorkerCancellationLedger {
  const states = new Map<WorkerRequestId, RequestState>();
  const cancelled = new Set<WorkerRequestId>();
  return {
    cancel(requestId) {
      if (states.get(requestId) === "terminal") return "ignored";
      cancelled.add(requestId);
      return "recorded";
    },
    start(requestId) {
      if (states.has(requestId)) return "refuse-duplicate";
      if (cancelled.has(requestId)) {
        // A refused id is spent: the cancellation-ack was its one terminal
        // message, so a later bearer of the same id is a duplicate.
        states.set(requestId, "terminal");
        return "refuse-cancelled";
      }
      states.set(requestId, "running");
      return "run";
    },
    finish(requestId) {
      if (states.get(requestId) !== "running") {
        throw new RangeError(
          `finish() was called for request "${requestId}" that was never started or already finished.`,
        );
      }
      states.set(requestId, "terminal");
      return cancelled.has(requestId) ? "suppress" : "deliver";
    },
  };
}
