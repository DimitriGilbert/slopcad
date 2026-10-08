import { describe, expect, it } from "vitest";

import { testFluid } from "./fixtures";
import { type LbmCollisionModel } from "./relaxation";
import {
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";

/**
 * The Poiseuille fixture (Phase 63a's validation block): a plane channel
 * driven by a uniform velocity inlet with a pressure outlet at ambient
 * and no-slip walls, compared against the analytic parabola at the
 * converged state.
 *
 * ## The analytic pin
 *
 * Half-way link bounce-back at the wall nodes places the walls half a
 * link OUTSIDE the boundary nodes (documented in `./boundaries`), so the
 * channel height is H = ny lattice units and the wall distance of node
 * j is s = (j + ½)·dx. The fully developed profile at column x (past
 * the entrance, before the outlet) is
 *
 *   u(s) = u_max·4·s·(H − s)/H²,   u_max = 1.5·u_inlet
 *
 * with u_inlet the prescribed mean. Lattice design: ny = 17,
 * u_inlet,lat = 1/30, nx = 48, profile read at x = 30; τ⁺ = 0.9 gives
 * Re ≈ 4.3 (deep laminar, entrance ≈ 3 cells).
 *
 * ## The measured bands (authoring-time measurements, stated)
 *
 * At τ⁺ = 0.9 TRT (Λ = 1/4) matches the parabola within 0.9% of u_max
 * at every node of the column; the band pins 2%. At τ⁺ = 1.8 both
 * models carry a mild amplitude (flux) bias, but the SHAPE — each
 * profile normalized by its own maximum — separates them sharply:
 * BGK's near-wall flattening reaches ≈ 2.4% shape error (the classic
 * (τ⁺ − ½)(τ⁺ − 3/2) bounce-back viscosity error) while TRT stays
 * within ≈ 0.1% at the same τ⁺: the two-regime pin that documents TRT
 * as the accuracy/stability knob. (The blow-up side of the knob — BGK
 * NaN at high Re where TRT runs — is pinned in `./stepper.test.ts`.)
 */

const NX = 48;
const NY = 17;
const DX = 0.001;
// SI design: u_max = 0.075 m/s is the characteristic (u_lat = 0.05);
// the inlet runs at the mean, 0.05 m/s. ν = 2e-4 m²/s lands τ⁺ = 0.9;
// ν = 6.5e-4 m²/s lands τ⁺ = 1.8 (the BGK-error regime).
const U_CHAR = 0.075;
const U_INLET = 0.05;

function channel(collision: LbmCollisionModel, nu: number): LbmStepper {
  const config: LbmStepperConfig = {
    mask: { nx: NX, ny: NY, solid: new Uint8Array(NX * NY) },
    fluid: testFluid(1.2, nu),
    cellSizeM: DX,
    characteristicVelocityMPerS: U_CHAR,
    collision,
    west: { kind: "velocity-inlet", velocityMPerS: [U_INLET, 0] },
    east: { kind: "pressure-outlet", pressurePa: 0 },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
  };
  const created = createLbmStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

interface ProfileReading {
  readonly maxRelativeError: number;
  readonly shapeError: number;
  readonly uMaxMeasured: number;
  readonly inletFlux: number;
  readonly outletFlux: number;
}

function readProfile(collision: LbmCollisionModel, nu: number): ProfileReading {
  const run = channel(collision, nu);
  run.run(6000);
  const snapshot = run.snapshotSI();
  const column = 30;
  const uMaxAnalytic = 1.5 * U_INLET;
  const height = NY * DX;
  const measured: number[] = [];
  const analytic: number[] = [];
  for (let j = 0; j < NY; j += 1) {
    const s = (j + 0.5) * DX;
    analytic.push((uMaxAnalytic * 4 * s * (height - s)) / (height * height));
    measured.push(snapshot.velocityXMPerS[column + j * NX] ?? 0);
  }
  const uMaxMeasured = Math.max(...measured);
  let maxRelativeError = 0;
  for (let j = 0; j < NY; j += 1) {
    maxRelativeError = Math.max(
      maxRelativeError,
      Math.abs(measured[j]! - analytic[j]!) / uMaxAnalytic,
    );
  }
  // The shape metric: each profile normalized by its own maximum — the
  // amplitude (flux) bias both models share at viscous τ⁺ divides out,
  // isolating the parabola-shape error the bounce-back viscosity term
  // drives.
  let shapeError = 0;
  for (let j = 0; j < NY; j += 1) {
    shapeError = Math.max(
      shapeError,
      Math.abs(measured[j]! / uMaxMeasured - analytic[j]! / uMaxAnalytic),
    );
  }
  const fluxAt = (x: number): number => {
    let flux = 0;
    for (let j = 0; j < NY; j += 1) {
      flux +=
        (snapshot.densityKgPerM3[x + j * NX] ?? 0) *
        (snapshot.velocityXMPerS[x + j * NX] ?? 0);
    }
    return flux;
  };
  return {
    maxRelativeError,
    shapeError,
    uMaxMeasured,
    inletFlux: fluxAt(1),
    outletFlux: fluxAt(NX - 2),
  };
}

describe("the Poiseuille fixture", () => {
  it("TRT (Λ = 1/4) pins the analytic parabola within the stated band", () => {
    const reading = readProfile({ kind: "trt" }, 2e-4);
    // Band: 2% of u_max at every node of the profile column (measured
    // 0.9%) — the channel-exact magic value's honest staircase band.
    expect(reading.maxRelativeError).toBeLessThan(0.02);
    expect(reading.uMaxMeasured).toBeGreaterThan(0.9 * 1.5 * U_INLET);
    expect(reading.uMaxMeasured).toBeLessThan(1.05 * 1.5 * U_INLET);
    // Mass conservation at steady state: inlet and outlet fluxes agree.
    expect(Math.abs(reading.inletFlux - reading.outletFlux)).toBeLessThan(
      0.03 * Math.abs(reading.inletFlux),
    );
    // Timeout budget: a 6000-step channel run measures ≈ 6.5 s
    // isolated and 18.3 s under the full gate's parallel CPU
    // contention (the two-run shape test below — the same compute
    // doubled — measured 38.5 s). 60 s is ≈ 3× that worst case — an
    // infrastructure budget, not an assertion.
  }, 60_000);

  it("BGK at a viscous τ⁺ carries the bounce-back shape error TRT cancels", () => {
    const trt = readProfile({ kind: "trt" }, 6.5e-4);
    const bgk = readProfile({ kind: "bgk" }, 6.5e-4);
    // Measured at authoring time: BGK's shape error ≈ 2.4% (peaking at
    // the wall nodes — the flattened near-wall profile of the classic
    // (τ⁺ − ½)(τ⁺ − 3/2) bounce-back viscosity error), TRT at the same
    // τ⁺ ≈ 0.1% — the magic parameter's cancellation, pinned.
    expect(bgk.shapeError).toBeGreaterThan(0.015);
    expect(bgk.shapeError).toBeGreaterThan(5 * trt.shapeError);
    expect(trt.shapeError).toBeLessThan(0.01);
    // Timeout budget: the two 6000-step runs measure ≈ 8.7 s isolated
    // and 38.5 s under the full gate's parallel CPU contention (the
    // measured Phase 63 full-gate run). 120 s is ≈ 3× that worst
    // case — an infrastructure budget, not an assertion.
  }, 120_000);
});
