/**
 * The pinned cancellation rule (Phase 10.1): cancellation wins ties. These
 * tests walk the ledger through every state transition the rule defines,
 * including the pre-arrival cancel and the no-op cancel after a terminal
 * response, so the Phase 10.2 worker server inherits pinned, executable
 * semantics instead of prose.
 */

import { describe, expect, it } from "vitest";

import { createWorkerCancellationLedger } from "./worker-cancellation";
import { createWorkerRequestId } from "./worker-ids";

const first = createWorkerRequestId("req_000001");
const second = createWorkerRequestId("req_000002");

describe("uncancelled requests", () => {
  it("runs a fresh request and delivers its outcome", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.finish(first)).toBe("deliver");
  });

  it("delivers each of several concurrent requests independently", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.start(second)).toBe("run");
    expect(ledger.finish(second)).toBe("deliver");
    expect(ledger.finish(first)).toBe("deliver");
  });
});

describe("cancellation before the request runs", () => {
  it("refuses a request cancelled before it arrived", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.cancel(first)).toBe("recorded");
    expect(ledger.start(first)).toBe("refuse-cancelled");
  });

  it("keeps a refused request terminal: no duplicate can revive it", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.cancel(first)).toBe("recorded");
    expect(ledger.start(first)).toBe("refuse-cancelled");
    expect(ledger.start(first)).toBe("refuse-duplicate");
  });
});

describe("cancellation while running", () => {
  it("suppresses the computed outcome — no late success after cancellation", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.cancel(first)).toBe("recorded");
    expect(ledger.finish(first)).toBe("suppress");
  });

  it("treats a suppressed request as terminal: finish is single-shot", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.cancel(first)).toBe("recorded");
    expect(ledger.finish(first)).toBe("suppress");
    expect(() => ledger.finish(first)).toThrow(RangeError);
  });

  it("does not let one request's cancellation affect another", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.start(second)).toBe("run");
    expect(ledger.cancel(first)).toBe("recorded");
    expect(ledger.finish(second)).toBe("deliver");
    expect(ledger.finish(first)).toBe("suppress");
  });
});

describe("cancellation after the response was emitted", () => {
  it("ignores a cancel for a request that already finished", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.finish(first)).toBe("deliver");
    expect(ledger.cancel(first)).toBe("ignored");
  });

  it("refuses a duplicate request id after it finished, keeping ids single-use", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.finish(first)).toBe("deliver");
    expect(ledger.start(first)).toBe("refuse-duplicate");
  });
});

describe("request id uniqueness", () => {
  it("refuses a duplicate request id while the first is still running", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.start(first)).toBe("refuse-duplicate");
  });

  it("refuses a duplicate even when the id was cancelled mid-flight", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.cancel(first)).toBe("recorded");
    expect(ledger.start(first)).toBe("refuse-duplicate");
  });
});

describe("ledger misuse", () => {
  it("throws RangeError when finishing a request that was never started", () => {
    const ledger = createWorkerCancellationLedger();
    expect(() => ledger.finish(first)).toThrow(RangeError);
  });

  it("throws RangeError when finishing twice", () => {
    const ledger = createWorkerCancellationLedger();
    expect(ledger.start(first)).toBe("run");
    expect(ledger.finish(first)).toBe("deliver");
    expect(() => ledger.finish(first)).toThrow(RangeError);
  });
});

describe("the guarantee, exhaustively", () => {
  it("has no path where a recorded cancel is followed by a delivered outcome", () => {
    // Mid-flight cancel: the computed outcome is suppressed and the
    // worker/cancelled error response is the terminal message.
    const midFlight = createWorkerCancellationLedger();
    expect(midFlight.start(first)).toBe("run");
    expect(midFlight.cancel(first)).toBe("recorded");
    expect(midFlight.finish(first)).toBe("suppress");

    // Cancel overtakes the request: refused outright, nothing to finish.
    const preArrival = createWorkerCancellationLedger();
    expect(preArrival.cancel(first)).toBe("recorded");
    expect(preArrival.start(first)).toBe("refuse-cancelled");

    // Cancel loses the race: the outcome was already delivered (and left the
    // responder), so the cancel is ignored — that success was not "late".
    const raced = createWorkerCancellationLedger();
    expect(raced.start(first)).toBe("run");
    expect(raced.finish(first)).toBe("deliver");
    expect(raced.cancel(first)).toBe("ignored");
  });
});
