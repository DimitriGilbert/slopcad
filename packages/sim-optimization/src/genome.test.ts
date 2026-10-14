import { describe, expect, it } from "vitest";

import {
  authoredGenomeKey,
  clampSlot,
  createSimOptimizationRandom,
  decodeGenome,
  decodeNumericSlot,
  encodeNumericSlot,
  numericGeneLevels,
} from "./index";

describe("the deterministic PRNG", () => {
  it("reproduces its stream from the seed, exactly", () => {
    const a = createSimOptimizationRandom(123456789);
    const b = createSimOptimizationRandom(123456789);
    const streamA = Array.from({ length: 64 }, () => a.nextUnit());
    const streamB = Array.from({ length: 64 }, () => b.nextUnit());
    expect(streamA).toEqual(streamB);
    const c = createSimOptimizationRandom(123456790);
    const streamC = Array.from({ length: 64 }, () => c.nextUnit());
    expect(streamC).not.toEqual(streamA);
  });

  it("keeps draws in their declared ranges", () => {
    const random = createSimOptimizationRandom(1);
    for (let index = 0; index < 1000; index += 1) {
      const unit = random.nextUnit();
      expect(unit).toBeGreaterThanOrEqual(0);
      expect(unit).toBeLessThan(1);
      const choice = random.nextInt(7);
      expect(choice).toBeGreaterThanOrEqual(0);
      expect(choice).toBeLessThan(7);
      expect(Number.isInteger(choice)).toBe(true);
    }
    expect(() => random.nextInt(0)).toThrow(RangeError);
  });
});

describe("the genome coordinate system", () => {
  it("snaps stepped genes to their lattice and inverts exactly", () => {
    const spec = {
      kind: "numeric" as const,
      valueKind: "decimal" as const,
      min: 2,
      max: 30,
      step: 2,
    };
    // 15 levels — min + k·2 for k = 0 … 14 (floor(28/2) steps above min).
    const levels = numericGeneLevels(spec);
    expect(levels).toBe(15);
    expect(decodeNumericSlot(spec, 0)).toBe(2);
    expect(decodeNumericSlot(spec, 0.5)).toBe(16);
    expect(decodeNumericSlot(spec, 1)).toBe(30);
    // 0.34 of the range is lattice level round(4.76) = 5 → 2 + 5·2.
    expect(decodeNumericSlot(spec, 0.34)).toBe(12);
    for (let level = 0; level < levels; level += 1) {
      const value = decodeNumericSlot(spec, level / (levels - 1));
      expect(encodeNumericSlot(spec, value)).toBeCloseTo(
        level / (levels - 1),
        12,
      );
    }
  });

  it("rounds step-less integer genes onto the integer grid", () => {
    const spec = {
      kind: "numeric" as const,
      valueKind: "integer" as const,
      min: 2,
      max: 30,
    };
    // The 29 integers from ceil(2) to floor(30).
    expect(numericGeneLevels(spec)).toBe(29);
    for (let slot = 0; slot <= 20; slot += 1) {
      const value = decodeNumericSlot(spec, slot / 20);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(30);
    }
  });

  it("collapses an over-stepped gene to its single level", () => {
    const spec = {
      kind: "numeric" as const,
      valueKind: "integer" as const,
      min: 2,
      max: 3,
      step: 10,
    };
    expect(numericGeneLevels(spec)).toBe(1);
    expect(decodeNumericSlot(spec, 0)).toBe(2);
    expect(decodeNumericSlot(spec, 1)).toBe(2);
    // The collapse boundary is the TWO-step span: a range of exactly one
    // step still collapses (the pinned behavior), two steps do not.
    const oneStep = {
      kind: "numeric" as const,
      valueKind: "decimal" as const,
      min: 2,
      max: 4,
      step: 2,
    };
    expect(numericGeneLevels(oneStep)).toBe(1);
    expect(decodeNumericSlot(oneStep, 1)).toBe(2);
    const twoSteps = {
      kind: "numeric" as const,
      valueKind: "decimal" as const,
      min: 2,
      max: 6,
      step: 2,
    };
    expect(numericGeneLevels(twoSteps)).toBe(3);
    expect(decodeNumericSlot(twoSteps, 1)).toBe(6);
  });

  it("clamps slots into their ranges", () => {
    expect(
      clampSlot({ kind: "numeric", valueKind: "decimal", min: 0, max: 1 }, -3),
    ).toBe(0);
    expect(
      clampSlot({ kind: "numeric", valueKind: "decimal", min: 0, max: 1 }, 3),
    ).toBe(1);
    expect(
      clampSlot(
        { kind: "numeric", valueKind: "decimal", min: 0, max: 1 },
        Number.NaN,
      ),
    ).toBe(0);
    expect(clampSlot({ kind: "discrete", choiceCount: 3 }, 2.6)).toBe(2);
    expect(clampSlot({ kind: "discrete", choiceCount: 3 }, 1.4)).toBe(1);
    expect(clampSlot({ kind: "discrete", choiceCount: 3 }, -1)).toBe(0);
  });

  it("keys authored genomes canonically (the dedupe contract)", () => {
    const specs = [
      {
        kind: "numeric" as const,
        valueKind: "integer" as const,
        min: 2,
        max: 30,
      },
      { kind: "discrete" as const, choiceCount: 2 },
    ];
    // Both slots decode the integer gene to 5 (2 + 28·t rounds there for
    // any t in [0.0893, 0.125)) and pick choice 1 — one candidate.
    const a = decodeGenome(specs, [0.1, 1]);
    const b = decodeGenome(specs, [0.12, 0.9999]);
    expect(a.numericValues[0]).toBe(5);
    expect(b.numericValues[0]).toBe(5);
    expect(authoredGenomeKey(a)).toBe(authoredGenomeKey(b));
    const c = decodeGenome(specs, [0.5, 0.1]);
    expect(authoredGenomeKey(c)).not.toBe(authoredGenomeKey(a));
  });
});
