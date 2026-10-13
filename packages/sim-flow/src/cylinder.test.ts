import { describe, expect, it } from "vitest";

import { analyticOccupancy, testFluid } from "./fixtures";
import {
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";

/**
 * The static-cylinder force fixture (Phase 63a's validation block):
 * uniform inflow past an analytic circle occupancy (a sphere-slice in
 * the 62a vocabulary) with full-way bounce-back, integrated lift/drag
 * from momentum exchange, validated three ways:
 *
 * 1. the EXACT per-step momentum audit — ΔM(t) over every distribution
 *    (solid-node bounce-back storage included) equals the ledger
 *    (face overwrites − solid impulses − dropped) to float32 rounding:
 *    the momentum-change sanity the force integration is pinned
 *    against;
 * 2. steady-state physics — positive drag that has converged (two
 *    late windows agree within 2%), lift ≈ 0 by the geometry's exact
 *    top-bottom symmetry, and inlet/outlet mass flux balance within 1%;
 * 3. the drag coefficient, banded HONESTLY: Cd ≈ 5.9 measured against
 *    the unconfined published ≈ 2 at this Reynolds number — the tunnel
 *    here is deliberately coarse (blockage D/H = 9/24 = 37.5%, nine
 *    cells of diameter, staircase walls), and blockage at that level
 *    inflates Cd by the usual confinement factors. The known-cases
 *    gallery at honest resolutions is Phase 63's fixture; this 63a pin
 *    states the band it measures, never pretends it is unconfined.
 *
 * Lattice design: 48×24, circle at (16, 11.5) r = 4.5 (D = 9 cells =
 * 9 mm), u∞ = 0.1 m/s at u_lat = 0.05, ν = 2.7e-5 m²/s → τ⁺ ≈ 0.54,
 * TRT Λ = 1/4 (τ⁻ ≈ 6.7), Re = u∞D/ν ≈ 33 — the steady attached-wake
 * regime; 12000 steps is past the D²/ν ≈ 6000-step viscous settling.
 */

const NX = 48;
const NY = 24;
const CX = 16;
const CY = 11.5;
const R = 4.5;
const DX = 0.001;
const U = 0.1;
const STEPS = 12000;
// SI facts: ρ₀ = 1.2 kg/m³, D = 2·R·dx = 9 mm.
const DYN_PRESSURE_AREA = 0.5 * 1.2 * U * U * 2 * R * DX;

function cylinder(): LbmStepper {
  const config: LbmStepperConfig = {
    mask: {
      nx: NX,
      ny: NY,
      solid: analyticOccupancy(
        NX,
        NY,
        (x, y) => (x - CX) ** 2 + (y - CY) ** 2 <= R * R,
      ),
    },
    fluid: testFluid(1.2, 2.7e-5),
    cellSizeM: DX,
    characteristicVelocityMPerS: U,
    collision: { kind: "trt" },
    west: { kind: "velocity-inlet", velocityMPerS: [U, 0] },
    east: { kind: "pressure-outlet", pressurePa: 0 },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
  };
  const created = createLbmStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function meanWindow(samples: readonly number[], from: number): number {
  let sum = 0;
  let count = 0;
  for (let index = from; index < samples.length; index += 1) {
    sum += samples[index] ?? 0;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

describe("the static-cylinder force fixture", () => {
  it("closes the exact momentum audit every step (force vs momentum change)", () => {
    const run = cylinder();
    let worstResidual = 0;
    for (let step = 0; step < 300; step += 1) {
      const before = run.momentumLattice();
      run.advance();
      const after = run.momentumLattice();
      const bookkeeping = run.lastStepBookkeeping();
      if (bookkeeping === undefined) continue;
      const residualX =
        after.x -
        before.x -
        (bookkeeping.faceDeltaX -
          bookkeeping.solidImpulseX -
          bookkeeping.droppedX);
      const residualY =
        after.y -
        before.y -
        (bookkeeping.faceDeltaY -
          bookkeeping.solidImpulseY -
          bookkeeping.droppedY);
      worstResidual = Math.max(
        worstResidual,
        Math.abs(residualX),
        Math.abs(residualY),
      );
    }
    // Measured at authoring time: 1.9e-6 over a full run (the float32
    // storage rounding of the collision's exact conservation); the band
    // leaves an order of magnitude of headroom without going slack.
    expect(worstResidual).toBeLessThan(1e-4);
  });

  it("integrates steady positive drag, zero lift, and conserved mass", () => {
    const run = cylinder();
    run.run(STEPS);
    expect(run.diverged).toBe(false);
    expect(run.step).toBe(STEPS);
    const { history } = run.forceState();
    const drag = history[0]?.samples ?? [];
    const lift = history[1]?.samples ?? [];
    expect(drag.length).toBe(STEPS);
    expect(lift.length).toBe(STEPS);
    const dragLate = meanWindow(drag, STEPS - 2000);
    const dragEarlier = meanWindow(drag, STEPS - 4000);
    expect(dragLate).toBeGreaterThan(0);
    // Converged: the last two 2000-step windows agree within 2%.
    expect(Math.abs(dragLate - dragEarlier)).toBeLessThan(0.02 * dragLate);
    // The circle is centered to exact top-bottom symmetry: no lift.
    expect(Math.abs(meanWindow(lift, STEPS - 2000))).toBeLessThan(
      1e-3 * dragLate,
    );
    const cd = dragLate / DYN_PRESSURE_AREA;
    // The measured band (5.9 at authoring time), blockage-inflated as
    // documented above; the unconfined published value is ≈ 2.
    expect(cd).toBeGreaterThan(4.5);
    expect(cd).toBeLessThan(7.5);
    const snapshot = run.snapshotSI();
    const fluxAt = (x: number): number => {
      let flux = 0;
      for (let j = 0; j < NY; j += 1) {
        flux +=
          (snapshot.densityKgPerM3[x + j * NX] ?? 0) *
          (snapshot.velocityXMPerS[x + j * NX] ?? 0);
      }
      return flux;
    };
    const inlet = fluxAt(1);
    const outlet = fluxAt(NX - 2);
    expect(Math.abs(inlet - outlet)).toBeLessThan(0.01 * inlet);
    // The flow genuinely went around the body, pinned at two fluid
    // probes (a solid node reads exactly 0, which fails both signs):
    // the near wake just behind the cylinder recirculates — u_x < 0,
    // the steady attached eddy pair of this Re ≈ 33 regime (measured
    // ≈ −0.009 m/s) — while the bypass just above the widest row of
    // the circle accelerates past the free stream (measured ≈ 1.6·U;
    // the row's mirror below reads identically by the geometry's
    // exact top-bottom symmetry).
    const wakeSpeed = snapshot.velocityXMPerS[23 + 11 * NX] ?? 0;
    expect(wakeSpeed).toBeLessThan(0);
    const bypassSpeed = snapshot.velocityXMPerS[CX + 17 * NX] ?? 0;
    expect(bypassSpeed).toBeGreaterThan(U);
    // Timeout budget: the 12000-step run measures ≈ 14 s isolated, but
    // the full gate runs every package suite at once and its parallel
    // CPU contention (docs-examples' multi-minute gallery runs overlap)
    // multiplied this package's fixtures by up to 6.7× — this test was
    // killed at a 60 s mid-sizing budget. 150 s is ≈ 1.6× the 6.7×-
    // extrapolated worst case (≈ 95 s) — an infrastructure budget, not
    // an assertion: passing still requires passing.
  }, 150_000);

  it("is bitwise deterministic on a repeat cylinder run", () => {
    const first = cylinder();
    const second = cylinder();
    first.run(500);
    second.run(500);
    const fa = first.distributions();
    const fb = second.distributions();
    expect(first.step).toBe(second.step);
    for (let i = 0; i < 9; i += 1) {
      expect(
        Buffer.from(fa[i]!.buffer, fa[i]!.byteOffset, fa[i]!.byteLength).equals(
          Buffer.from(fb[i]!.buffer, fb[i]!.byteOffset, fb[i]!.byteLength),
        ),
      ).toBe(true);
    }
    expect(first.forceState().history[0]?.samples).toEqual(
      second.forceState().history[0]?.samples,
    );
  });
});
