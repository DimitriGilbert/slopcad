/**
 * The stale-result guard (Phase 10.4): the gatekeeper's hard rule — a stale
 * result can never replace newer state — pinned from every angle. Races are
 * staged deterministically with a hand-controlled scheduler (deferred
 * resolutions resolved in an explicitly chosen order) and direct adversarial
 * apply orders; there is no clock, no timer, no thread anywhere in these
 * tests.
 */

import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_LOG_CAPACITY } from "./diagnostic-log";
import { createRevisionClock, createRevisionTag } from "./revision";
import {
  createRevisionedState,
  type RevisionedResult,
} from "./stale-result-guard";

interface Box {
  readonly width: number;
}

const candidate = (revision: number, width: number): RevisionedResult<Box> => ({
  revision: createRevisionTag(revision),
  state: { width },
});

/** A hand-controlled scheduler: the promise settles exactly when told to. */
function deferred(): { resolve: () => void; settled: Promise<void> } {
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, settled };
}

describe("guarded visible state", () => {
  it("starts empty at the clock's current revision", () => {
    const clock = createRevisionClock();
    const state = createRevisionedState<Box>({ clock });
    expect(state.visible()).toBeNull();
    expect(state.drops()).toEqual([]);
    expect(state.currentRevision()).toBe(0);
  });

  it("applies a current candidate and exposes exactly it", () => {
    const clock = createRevisionClock();
    clock.bump();
    const state = createRevisionedState<Box>({ clock });
    const newest = candidate(1, 5);

    const decision = state.apply(newest);

    expect(decision).toEqual({ outcome: "applied", revision: 1 });
    expect(state.visible()).toBe(newest); // identity: the whole candidate
    expect(state.drops()).toEqual([]);
  });

  it("drops a superseded candidate with a structured, observable record", () => {
    const clock = createRevisionClock();
    clock.bump();
    clock.bump();
    const state = createRevisionedState<Box>({ clock });
    const applied = candidate(2, 6);

    state.apply(applied);
    const decision = state.apply(candidate(1, 5));

    expect(decision).toEqual({
      outcome: "dropped",
      reason: "superseded",
      resultRevision: 1,
      currentRevision: 2,
    });
    expect(state.visible()).toBe(applied); // untouched, not merged, not replaced
    expect(state.drops()).toEqual([
      { reason: "superseded", resultRevision: 1, currentRevision: 2 },
    ]);
  });

  it("drops an unrelated future candidate instead of adopting it", () => {
    const clock = createRevisionClock();
    clock.bump();
    const state = createRevisionedState<Box>({ clock });
    const applied = candidate(1, 5);

    state.apply(applied);
    const decision = state.apply(candidate(9, 50));

    expect(decision).toEqual({
      outcome: "dropped",
      reason: "unrelated",
      resultRevision: 9,
      currentRevision: 1,
    });
    expect(state.visible()).toBe(applied);
    expect(state.drops()).toEqual([
      { reason: "unrelated", resultRevision: 9, currentRevision: 1 },
    ]);
  });

  it("never lets an older result replace a newer one, in adversarial order", () => {
    const clock = createRevisionClock();
    const state = createRevisionedState<Box>({ clock });

    // Adversarial: the oldest result arrives last, after the newest applied.
    clock.bump(); // revision 1 dispatched
    clock.bump(); // revision 2 dispatched — revision 1 is stale already
    const newest = candidate(2, 7);
    expect(state.apply(newest)).toEqual({ outcome: "applied", revision: 2 });
    expect(state.apply(candidate(1, 3)).outcome).toBe("dropped");

    // And in the mirrored order: the older one applies first because it was
    // still current, and is then replaced by exactly the newer one.
    clock.bump(); // revision 3
    const older = candidate(3, 8);
    expect(state.apply(older)).toEqual({ outcome: "applied", revision: 3 });
    clock.bump(); // revision 4 — revision 3 becomes stale only now
    const newer = candidate(4, 9);
    expect(state.apply(newer)).toEqual({ outcome: "applied", revision: 4 });
    expect(state.visible()).toBe(newer);
    expect(state.visible()).not.toBe(older);
    expect(state.drops()).toHaveLength(1); // only revision 1 was ever dropped
  });
});

describe("guard atomicity under interleaved application attempts", () => {
  it("a late-resolving older computation cannot interleave past a newer apply", async () => {
    const clock = createRevisionClock();
    const state = createRevisionedState<Box>({ clock });

    // Two "computations" scheduled by a hand-controlled scheduler: each
    // applies its result only when its gate resolves. The older one's gate is
    // resolved LAST — the pinned adversarial order.
    const olderGate = deferred();
    const newerGate = deferred();
    const attempts: Array<Promise<void>> = [
      olderGate.settled.then(() => {
        state.apply(candidate(1, 3));
      }),
      newerGate.settled.then(() => {
        state.apply(candidate(2, 7));
      }),
    ];

    clock.bump(); // revision 1 dispatched
    clock.bump(); // revision 2 dispatched; 1 is stale from here on
    newerGate.resolve();
    await attempts[1];
    olderGate.resolve();
    await attempts[0];

    const visible = state.visible();
    expect(visible?.revision).toBe(2);
    expect(visible?.state.width).toBe(7);
    expect(state.drops()).toEqual([
      { reason: "superseded", resultRevision: 1, currentRevision: 2 },
    ]);
  });

  it("the visible state is always exactly one candidate — never torn or partial", async () => {
    const clock = createRevisionClock();
    const state = createRevisionedState<Box>({ clock });

    // Interleave the gates so each application attempt's continuation runs
    // between the other's steps; the committed state must still be exactly
    // one of the candidates, decided only by revision comparison.
    const gates = [deferred(), deferred(), deferred()];
    const [oldest, middle, newest] = [
      candidate(1, 10),
      candidate(2, 20),
      candidate(3, 30),
    ];
    const candidates = [oldest, middle, newest];
    const attempts = gates.map((gate, index) =>
      gate.settled.then(() => {
        const attempt = candidates[index];
        if (attempt === undefined) {
          throw new Error("Expected a candidate for every gate.");
        }
        state.apply(attempt);
      }),
    );

    clock.bump();
    clock.bump();
    clock.bump(); // revision 3 current; 1 and 2 are stale

    // Resolutions in an order where the newest settles in the middle.
    gates[0]?.resolve();
    gates[2]?.resolve();
    gates[1]?.resolve();
    await Promise.all(attempts);

    expect(state.visible()).toBe(newest); // identity, not a merge
    expect(state.drops()).toEqual([
      { reason: "superseded", resultRevision: 1, currentRevision: 3 },
      { reason: "superseded", resultRevision: 2, currentRevision: 3 },
    ]);
  });
});

describe("guard under a burst of revisions with shuffled application order", () => {
  it("leaves exactly the newest revision's result visible and records every stale drop", () => {
    const clock = createRevisionClock();
    const state = createRevisionedState<Box>({ clock });

    const count = 12;
    // A fixed adversarial permutation of the eleven stale revisions,
    // delivered before the newest one applies last.
    const shuffle = [12, 3, 7, 1, 11, 2, 9, 4, 10, 6, 5, 8];
    for (let bump = 0; bump < count; bump += 1) clock.bump();
    for (const revision of shuffle.filter((r) => r !== count)) {
      state.apply(candidate(revision, revision));
    }
    const newest = candidate(count, 100);
    state.apply(newest);

    expect(state.visible()).toBe(newest);
    const droppedRevisions = state
      .drops()
      .map((drop) => drop.resultRevision)
      .sort((a, b) => a - b);
    expect(droppedRevisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const drop of state.drops()) {
      expect(drop.reason).toBe("superseded");
      expect(drop.currentRevision).toBe(count);
    }
  });
});

describe("bounded drop log", () => {
  it("keeps only the most recent DIAGNOSTIC_LOG_CAPACITY drops — a window, not a trail", () => {
    const clock = createRevisionClock();
    const state = createRevisionedState<Box>({ clock });

    const total = DIAGNOSTIC_LOG_CAPACITY + 20;
    for (let bump = 0; bump < total; bump += 1) clock.bump();
    // Every candidate but the newest's revision is stale; applying them all
    // floods the log past its capacity.
    for (let revision = 1; revision <= total - 1; revision += 1) {
      state.apply(candidate(revision, revision));
    }

    const drops = state.drops();
    expect(drops).toHaveLength(DIAGNOSTIC_LOG_CAPACITY);
    // The newest window survived in push order; the oldest 20 were
    // superseded by the bound.
    expect(drops[0]?.resultRevision).toBe(total - DIAGNOSTIC_LOG_CAPACITY);
    expect(drops[drops.length - 1]?.resultRevision).toBe(total - 1);
    expect(state.visible()).toBeNull(); // nothing stale ever applied
  });
});
