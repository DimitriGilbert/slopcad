import { describe, expect, it } from "vitest";

import { LbmMomentAccumulator } from "./averaging";

/**
 * The second-moment accumulator's correctness pins (Phase 63b, law S9's
 * time-averaging answer): an analytic fluctuating field — a per-node
 * phase-shifted sinusoid in time — has EXACT discrete mean and variance
 * over a whole number of periods, so the accumulator is validated
 * against closed-form bands, not against itself. The arbitrary-window
 * case (a non-integer period count) is validated against an
 * independently-summed two-pass computation, and the bitwise
 * determinism pin feeds two accumulators the identical sequence.
 */

const NX = 6;
const NY = 4;
const CELLS = NX * NY;

/** u_x(i, t) = A + B·sin(2π t/P + φ_i): the analytic fluctuating field. */
function sinusoidX(t: number, amplitude: number, offset: number): Float64Array {
  const field = new Float64Array(CELLS);
  for (let index = 0; index < CELLS; index += 1) {
    field[index] =
      offset + amplitude * Math.sin((2 * Math.PI * t) / 5 + index * 0.7);
  }
  return field;
}

/** u_y(i, t) = A·cos(2π t/P + φ_i): the quadrature companion. */
function sinusoidY(t: number, amplitude: number): Float64Array {
  const field = new Float64Array(CELLS);
  for (let index = 0; index < CELLS; index += 1) {
    field[index] = amplitude * Math.cos((2 * Math.PI * t) / 5 + index * 0.7);
  }
  return field;
}

describe("the moment accumulator", () => {
  it("recovers the exact sinusoid mean and variance over whole periods", () => {
    const accumulator = new LbmMomentAccumulator(NX, NY);
    // 8 exact periods of P = 5 samples: the discrete sine sums vanish and
    // the mean square is exactly 1/2, up to floating rounding.
    for (let t = 0; t < 40; t += 1) {
      accumulator.accumulate(sinusoidX(t, 0.03, 0.05), sinusoidY(t, 0.02));
    }
    const moments = accumulator.moments();
    expect(moments.count).toBe(40);
    for (let index = 0; index < CELLS; index += 1) {
      expect(Math.abs((moments.meanX[index] ?? 0) - 0.05)).toBeLessThan(1e-14);
      expect(Math.abs((moments.meanY[index] ?? 0) - 0)).toBeLessThan(1e-14);
      // Var[A + B·sin] = B²/2 and Var[B·cos] = B²/2 exactly, whole periods.
      expect(
        Math.abs((moments.varianceX[index] ?? 0) - 0.03 ** 2 / 2),
      ).toBeLessThan(1e-15);
      expect(
        Math.abs((moments.varianceY[index] ?? 0) - 0.02 ** 2 / 2),
      ).toBeLessThan(1e-15);
    }
  });

  it("matches an independently summed two-pass computation on an arbitrary window", () => {
    const accumulator = new LbmMomentAccumulator(NX, NY);
    // 17 samples: NOT a whole number of periods — the naive two-pass
    // mean/variance (sum, then squared deviations) is computed
    // independently in the test and must agree to rounding.
    const windowLength = 17;
    const xs: Float64Array[] = [];
    const ys: Float64Array[] = [];
    for (let t = 0; t < windowLength; t += 1) {
      const fieldX = sinusoidX(t, 0.11, -0.02);
      const fieldY = sinusoidY(t, 0.07);
      xs.push(fieldX);
      ys.push(fieldY);
      accumulator.accumulate(fieldX, fieldY);
    }
    const moments = accumulator.moments();
    expect(moments.count).toBe(windowLength);
    for (let index = 0; index < CELLS; index += 1) {
      let sumX = 0;
      let sumY = 0;
      for (let t = 0; t < windowLength; t += 1) {
        sumX += xs[t]?.[index] ?? 0;
        sumY += ys[t]?.[index] ?? 0;
      }
      const meanX = sumX / windowLength;
      const meanY = sumY / windowLength;
      let sumSqX = 0;
      let sumSqY = 0;
      for (let t = 0; t < windowLength; t += 1) {
        sumSqX += ((xs[t]?.[index] ?? 0) - meanX) ** 2;
        sumSqY += ((ys[t]?.[index] ?? 0) - meanY) ** 2;
      }
      expect(Math.abs((moments.meanX[index] ?? 0) - meanX)).toBeLessThan(1e-15);
      expect(Math.abs((moments.meanY[index] ?? 0) - meanY)).toBeLessThan(1e-15);
      expect(
        Math.abs((moments.varianceX[index] ?? 0) - sumSqX / windowLength),
      ).toBeLessThan(1e-14);
      expect(
        Math.abs((moments.varianceY[index] ?? 0) - sumSqY / windowLength),
      ).toBeLessThan(1e-14);
    }
  });

  it("is bitwise deterministic for identical snapshot sequences", () => {
    const first = new LbmMomentAccumulator(NX, NY);
    const second = new LbmMomentAccumulator(NX, NY);
    for (let t = 0; t < 23; t += 1) {
      const fieldX = sinusoidX(t, 0.05, 0.01);
      const fieldY = sinusoidY(t, 0.04);
      first.accumulate(fieldX, fieldY);
      second.accumulate(fieldX, fieldY);
    }
    const a = first.moments();
    const b = second.moments();
    for (const key of ["meanX", "meanY", "varianceX", "varianceY"] as const) {
      expect(
        Buffer.from(a[key].buffer, a[key].byteOffset, a[key].byteLength).equals(
          Buffer.from(b[key].buffer, b[key].byteOffset, b[key].byteLength),
        ),
      ).toBe(true);
    }
  });

  it("refuses mismatched snapshot shapes", () => {
    const accumulator = new LbmMomentAccumulator(NX, NY);
    expect(() => {
      accumulator.accumulate(new Float64Array(3), new Float64Array(3));
    }).toThrow(/exactly 24 values/);
  });
});
