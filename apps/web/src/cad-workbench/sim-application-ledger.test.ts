/**
 * The sim committed-application ledger's law (Phase 61d, S6): the counters
 * move ONLY on applied notifications. The fake engine's emission shapes
 * drive the happy paths; hand-built violations (gaps, duplicates, header
 * disagreements, retrograde progress) pin the declines — every one of
 * them must commit NOTHING.
 */

import { describe, expect, it } from "vitest";
import type {
  SimFieldChunkNotification,
  SimProgressNotification,
} from "@slopcad/sim-core";

import {
  applySimNotification,
  createSimApplicationLedger,
  simAppliedCountersOf,
  type SimApplicationLedger,
} from "./sim-application-ledger";

/** One field-chunk notification at a fixed header, caller-chosen framing. */
function chunk(
  chunkIndex: number,
  chunkCount: number,
  overrides: Partial<SimFieldChunkNotification> = {},
): SimFieldChunkNotification {
  return {
    kind: "field-chunk",
    id: "velocity-magnitude",
    unit: "mm/s",
    extent: [4, 2, 1],
    originMm: [-500, -250, -250],
    spacingMm: [2, 2, 2],
    dataType: "float32",
    chunkIndex,
    chunkCount,
    values: [0.5, 1, 1.5, 2],
    ...overrides,
  };
}

/** A progress notification at `step`. */
function progress(step: number): SimProgressNotification {
  return { kind: "progress", step, totalSteps: 24 };
}

/** The applied-notifications counter of a ledger, for the tight asserts. */
function notificationsOf(ledger: SimApplicationLedger): number {
  return simAppliedCountersOf(ledger).notifications;
}

describe("progress applications", () => {
  it("applies strictly advancing steps and counts one notification each", () => {
    const ledger = createSimApplicationLedger();
    expect(applySimNotification(ledger, progress(1))).toEqual({
      notifications: 1,
      fieldChunks: 0,
      progressStep: 1,
    });
    expect(applySimNotification(ledger, progress(2))).toEqual({
      notifications: 2,
      fieldChunks: 0,
      progressStep: 2,
    });
    expect(applySimNotification(ledger, progress(24))).toEqual({
      notifications: 3,
      fieldChunks: 0,
      progressStep: 24,
    });
  });

  it("commits nothing for duplicate, retrograde, or non-integer steps", () => {
    const ledger = createSimApplicationLedger();
    applySimNotification(ledger, progress(7));
    const before = simAppliedCountersOf(ledger);
    expect(applySimNotification(ledger, progress(7))).toBeNull();
    expect(applySimNotification(ledger, progress(6))).toBeNull();
    expect(applySimNotification(ledger, progress(0))).toBeNull();
    expect(applySimNotification(ledger, progress(-3))).toBeNull();
    expect(applySimNotification(ledger, progress(2.5))).toBeNull();
    expect(simAppliedCountersOf(ledger)).toEqual(before);
  });
});

describe("field-chunk applications", () => {
  it("establishes a stream at chunk 0 and extends it contiguously", () => {
    const ledger = createSimApplicationLedger();
    expect(applySimNotification(ledger, chunk(0, 4))).toEqual({
      notifications: 1,
      fieldChunks: 1,
      progressStep: null,
    });
    applySimNotification(ledger, chunk(1, 4));
    applySimNotification(ledger, chunk(2, 4));
    expect(applySimNotification(ledger, chunk(3, 4))).toEqual({
      notifications: 4,
      fieldChunks: 4,
      progressStep: null,
    });
    const field = ledger.fields.get("velocity-magnitude");
    expect(field?.appliedChunks).toBe(4);
    expect(field?.roundsCompleted).toBe(1);
  });

  it("declines a mid-stream chunk for an unestablished field", () => {
    const ledger = createSimApplicationLedger();
    expect(applySimNotification(ledger, chunk(1, 4))).toBeNull();
    expect(notificationsOf(ledger)).toBe(0);
    expect(ledger.fields.size).toBe(0);
  });

  it("declines gaps, duplicate indices, and framing violations", () => {
    const ledger = createSimApplicationLedger();
    applySimNotification(ledger, chunk(0, 4));
    applySimNotification(ledger, chunk(1, 4));
    const before = simAppliedCountersOf(ledger);
    // A gap (index 3 while 2 is next), a duplicate (1 again), an
    // out-of-range index, a zero chunk count, and an empty slice.
    expect(applySimNotification(ledger, chunk(3, 4))).toBeNull();
    expect(applySimNotification(ledger, chunk(1, 4))).toBeNull();
    expect(applySimNotification(ledger, chunk(4, 4))).toBeNull();
    expect(applySimNotification(ledger, chunk(2, 0))).toBeNull();
    expect(
      applySimNotification(ledger, chunk(2, 4, { values: [] })),
    ).toBeNull();
    expect(simAppliedCountersOf(ledger)).toEqual(before);
  });

  it("declines a mid-stream header or chunk-count disagreement", () => {
    const ledger = createSimApplicationLedger();
    applySimNotification(ledger, chunk(0, 4));
    const before = simAppliedCountersOf(ledger);
    expect(
      applySimNotification(ledger, chunk(1, 4, { unit: "Pa" })),
    ).toBeNull();
    expect(
      applySimNotification(ledger, chunk(1, 4, { extent: [8, 2, 1] })),
    ).toBeNull();
    expect(
      applySimNotification(ledger, chunk(1, 4, { originMm: [0, 0, 0] })),
    ).toBeNull();
    expect(
      applySimNotification(ledger, chunk(1, 4, { spacingMm: [1, 1, 1] })),
    ).toBeNull();
    expect(
      applySimNotification(ledger, chunk(1, 4, { dataType: "float64" })),
    ).toBeNull();
    expect(applySimNotification(ledger, chunk(1, 5))).toBeNull();
    expect(simAppliedCountersOf(ledger)).toEqual(before);
  });

  it("re-establishes at chunk 0 for a new round and counts completed rounds", () => {
    const ledger = createSimApplicationLedger();
    for (let index = 0; index < 4; index += 1) {
      applySimNotification(ledger, chunk(index, 4));
    }
    // The second round: chunk 0 re-establishes, the rest extend.
    for (let index = 0; index < 4; index += 1) {
      expect(applySimNotification(ledger, chunk(index, 4))).not.toBeNull();
    }
    const field = ledger.fields.get("velocity-magnitude");
    expect(field?.appliedChunks).toBe(4);
    expect(field?.roundsCompleted).toBe(2);
    expect(simAppliedCountersOf(ledger)).toEqual({
      notifications: 8,
      fieldChunks: 8,
      progressStep: null,
    });
  });

  it("tracks interleaved fields independently", () => {
    const ledger = createSimApplicationLedger();
    applySimNotification(ledger, chunk(0, 2));
    applySimNotification(ledger, chunk(0, 2, { id: "pressure", unit: "Pa" }));
    expect(
      applySimNotification(ledger, chunk(1, 2, { id: "pressure", unit: "Pa" })),
    ).not.toBeNull();
    // The velocity stream is still waiting on its own index 1.
    expect(applySimNotification(ledger, chunk(1, 2))).not.toBeNull();
    expect(ledger.fields.get("velocity-magnitude")?.roundsCompleted).toBe(1);
    expect(ledger.fields.get("pressure")?.roundsCompleted).toBe(1);
    expect(simAppliedCountersOf(ledger)).toEqual({
      notifications: 4,
      fieldChunks: 4,
      progressStep: null,
    });
  });

  it("adopts a republished header when a round restarts at chunk 0", () => {
    const ledger = createSimApplicationLedger();
    applySimNotification(ledger, chunk(0, 4));
    // The engine republished the field on a finer grid: chunk 0 with a NEW
    // header re-establishes (the newest truth), a mid-stream disagreement
    // never could.
    const republished = chunk(0, 2, { extent: [8, 2, 1] });
    expect(applySimNotification(ledger, republished)).not.toBeNull();
    expect(ledger.fields.get("velocity-magnitude")?.chunkCount).toBe(2);
    expect(
      applySimNotification(ledger, chunk(1, 2, { extent: [8, 2, 1] })),
    ).not.toBeNull();
    expect(ledger.fields.get("velocity-magnitude")?.roundsCompleted).toBe(1);
  });
});
