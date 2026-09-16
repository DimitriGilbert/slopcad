/**
 * The revision model (Phase 10.4): the clock is monotonic, deterministic, and
 * refuses both non-integer tags and the float64 inexactness past
 * `Number.MAX_SAFE_INTEGER` — the identity discipline every downstream
 * stale-result decision is built on.
 */

import { describe, expect, it } from "vitest";

import {
  createRevisionClock,
  createRevisionTag,
  REVISION_CLOCK_ERROR_CODES,
  RevisionClockExhaustedError,
  REVISION_ZERO,
} from "./revision";

describe("revision tag validation", () => {
  it("mints a tag that compares like the number it is", () => {
    const tag = createRevisionTag(7);
    expect(tag === 7).toBe(true);
    expect(createRevisionTag(3) < createRevisionTag(4)).toBe(true);
    expect(REVISION_ZERO === 0).toBe(true);
  });

  it("refuses non-integer and negative values with a RangeError", () => {
    expect(() => createRevisionTag(1.5)).toThrow(RangeError);
    expect(() => createRevisionTag(-1)).toThrow(RangeError);
    expect(() => createRevisionTag(Number.NaN)).toThrow(RangeError);
  });
});

describe("revision clock", () => {
  it("starts at the given revision and bumps monotonically", () => {
    const clock = createRevisionClock();
    expect(clock.current()).toBe(REVISION_ZERO);
    expect(clock.bump()).toBe(1);
    expect(clock.current()).toBe(1);
    expect(clock.bump()).toBe(2);
    expect(clock.bump()).toBe(3);
    expect(clock.current()).toBe(3);
  });

  it("accepts an initial revision for replay and diagnostics", () => {
    const clock = createRevisionClock(createRevisionTag(41));
    expect(clock.current()).toBe(41);
    expect(clock.bump()).toBe(42);
  });

  it("is deterministic: identical starts produce identical bump sequences", () => {
    const first = createRevisionClock();
    const second = createRevisionClock();
    const sequenceOf = (): number[] => [
      first.bump(),
      first.bump(),
      second.bump(),
      second.bump(),
    ];
    const [a1, a2, b1, b2] = sequenceOf();
    expect([a1, a2]).toEqual([b1, b2]);
  });

  it("refuses to cross the exact-integer limit, leaving the counter intact", () => {
    const clock = createRevisionClock(createRevisionTag(Number.MAX_SAFE_INTEGER - 1));
    expect(clock.bump()).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => clock.bump()).toThrow(RevisionClockExhaustedError);
    try {
      clock.bump();
    } catch (error) {
      if (!(error instanceof RevisionClockExhaustedError)) {
        throw new Error("Expected a RevisionClockExhaustedError.");
      }
      expect(error.code).toBe(REVISION_CLOCK_ERROR_CODES.exhausted);
    }
    expect(clock.current()).toBe(Number.MAX_SAFE_INTEGER);
  });
});
