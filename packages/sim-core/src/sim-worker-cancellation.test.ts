/**
 * Cancellation ledger tests (Phase 61b): the pinned rule as an executable
 * contract — the kernel `worker-cancellation` suite's scenarios for the
 * restated sim ledger, since the rule is identical on both protocols.
 */

import { describe, expect, it } from "vitest";

import { createSimWorkerCancellationLedger } from "./sim-worker-cancellation";
import { parseSimWorkerRequestId } from "./sim-worker-ids";

function requestId(raw: string) {
  const parsed = parseSimWorkerRequestId(raw);
  if (!parsed.ok) throw new Error("test request id must parse");
  return parsed.value;
}

describe("the pinned rule: cancellation wins ties", () => {
  it("runs a fresh request and delivers its outcome", () => {
    const ledger = createSimWorkerCancellationLedger();
    const id = requestId("req_000001");
    expect(ledger.start(id)).toBe("run");
    expect(ledger.finish(id)).toBe("deliver");
  });

  it("refuses a duplicate id — single-use, whatever its prior state", () => {
    const ledger = createSimWorkerCancellationLedger();
    const id = requestId("req_000001");
    expect(ledger.start(id)).toBe("run");
    expect(ledger.finish(id)).toBe("deliver");
    expect(ledger.start(id)).toBe("refuse-duplicate");
  });

  it("suppresses the outcome of a request cancelled while running", () => {
    const ledger = createSimWorkerCancellationLedger();
    const id = requestId("req_000001");
    expect(ledger.start(id)).toBe("run");
    expect(ledger.cancel(id)).toBe("recorded");
    expect(ledger.finish(id)).toBe("suppress");
  });

  it("refuses a request that a cancel overtook (before it arrived)", () => {
    const ledger = createSimWorkerCancellationLedger();
    const id = requestId("req_000001");
    expect(ledger.cancel(id)).toBe("recorded");
    expect(ledger.start(id)).toBe("refuse-cancelled");
    // The refused id is spent: a later bearer of the same id duplicates.
    expect(ledger.start(id)).toBe("refuse-duplicate");
  });

  it("ignores a cancel for an already-finished request", () => {
    const ledger = createSimWorkerCancellationLedger();
    const id = requestId("req_000001");
    expect(ledger.start(id)).toBe("run");
    expect(ledger.finish(id)).toBe("deliver");
    expect(ledger.cancel(id)).toBe("ignored");
  });

  it("throws on finish for a request that was never started or already finished", () => {
    const ledger = createSimWorkerCancellationLedger();
    expect(() => ledger.finish(requestId("req_000404"))).toThrow(RangeError);
    const id = requestId("req_000001");
    expect(ledger.start(id)).toBe("run");
    expect(ledger.finish(id)).toBe("deliver");
    expect(() => ledger.finish(id)).toThrow(RangeError);
  });

  it("keeps ids independent — one channel, many requests", () => {
    const ledger = createSimWorkerCancellationLedger();
    const a = requestId("req_000001");
    const b = requestId("req_000002");
    ledger.start(a);
    ledger.cancel(a);
    expect(ledger.start(b)).toBe("run");
    expect(ledger.finish(b)).toBe("deliver");
  });
});
