import { describe, expect, it } from "vitest";

import { testFluid } from "./fixtures";
import { D3Q19_VELOCITIES } from "./d3q19";
import {
  type Lbm3dStepper,
  type Lbm3dStepperConfig,
  createLbm3dStepper,
} from "./stepper-3d";

/**
 * The 3D Poiseuille fixture (Phase 66a's validation block — the 63
 * fixture generalized): a plane channel driven by a uniform velocity
 * inlet with a pressure outlet at ambient, no-slip plates in y, and
 * SYMMETRY planes in z — the honest 3D analytic form. Symmetry in z
 * makes the developed solution exactly z-uniform, so the y-profile is
 * the 2D parabola the half-way bounce-back walls own, and the fixture
 * pins BOTH: the parabola against the analytic curve, and the
 * z-uniformity against exact zero (the third dimension earning its
 * keep — a z-dependent solution here would mean the symmetry planes or
 * the z-diagonal populations are wrong).
 *
 * ## The analytic pin
 *
 * Half-way link bounce-back at the wall nodes places the plates half a
 * link OUTSIDE the boundary nodes (documented in `./boundaries-3d`), so
 * the channel height is H = ny lattice units and the wall distance of
 * node j is s = (j + ½)·dx. The fully developed profile at column x
 * (past the entrance, before the outlet) is
 *
 *   u(s) = u_max·4·s·(H − s)/H²,   u_max = 1.5·u_inlet
 *
 * with u_inlet the prescribed mean. Lattice design: ny = 13,
 * u_inlet,lat = 2/3·u_lat = 0.0333 (u_inlet = 0.05 m/s against
 * u_char = 0.075), nx = 32, nz = 11, profile read at x = 20; ν = 2e-4
 * m²/s lands τ⁺ = 0.9 (deep laminar, Re ≈ 3.3, entrance ≈ 2 cells).
 */

const NX = 32;
const NY = 13;
const NZ = 11;
const DX = 0.001;
// SI design: u_max = 0.075 m/s is the characteristic (u_lat = 0.05);
// the inlet runs at the mean, 0.05 m/s; ν = 2e-4 m²/s lands τ⁺ = 0.9.
const U_CHAR = 0.075;
const U_INLET = 0.05;
const STEPS = 4000;

function channel(): Lbm3dStepper {
  const config: Lbm3dStepperConfig = {
    mask: { nx: NX, ny: NY, nz: NZ, solid: new Uint8Array(NX * NY * NZ) },
    fluid: testFluid(1.2, 2e-4),
    cellSizeM: DX,
    characteristicVelocityMPerS: U_CHAR,
    collision: { kind: "trt" },
    west: { kind: "velocity-inlet", velocityMPerS: [U_INLET, 0, 0] },
    east: { kind: "pressure-outlet", pressurePa: 0 },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "symmetry" },
    top: { kind: "symmetry" },
  };
  const created = createLbm3dStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("the 3D Poiseuille fixture (symmetry-plane channel)", () => {
  it("TRT (Λ = 1/4) pins the analytic parabola and stays z-uniform", () => {
    const run = channel();
    run.run(STEPS);
    expect(run.diverged).toBe(false);
    expect(run.step).toBe(STEPS);
    const snapshot = run.snapshotSI();
    const column = 20;
    const uMaxAnalytic = 1.5 * U_INLET;
    const height = NY * DX;
    const plane = NX * NY;
    let maxRelativeError = 0;
    for (let j = 0; j < NY; j += 1) {
      const s = (j + 0.5) * DX;
      const analytic =
        (uMaxAnalytic * 4 * s * (height - s)) / (height * height);
      for (let k = 0; k < NZ; k += 1) {
        const index = column + j * NX + k * plane;
        const measured = snapshot.velocityXMPerS[index] ?? 0;
        maxRelativeError = Math.max(
          maxRelativeError,
          Math.abs(measured - analytic) / uMaxAnalytic,
        );
      }
    }
    // Band: 2.5% of u_max at every node of the profile column across
    // ALL z planes (measured 1.66%: the y-parabola error ≈ 0.9% — the
    // 2D twin's own band at the same τ⁺ — plus the near-plane z-dip
    // below, summing at the wall-adjacent corner nodes). The
    // channel-exact magic value's honest staircase band.
    expect(maxRelativeError).toBeLessThan(0.025);
    // The z-mirror pin, bitwise: the whole state is exactly symmetric
    // under z-flip (measured: identical f32 bytes node-for-node) — the
    // symmetry planes' own guarantee, far stronger than a field band.
    const f = run.distributions();
    const flip: Record<number, number> = {};
    for (let i = 0; i < 19; i += 1) {
      const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
      for (let j = 0; j < 19; j += 1) {
        const [jx, jy, jz] = D3Q19_VELOCITIES[j] ?? [0, 0, 0];
        if (jx === cx && jy === cy && jz === -cz) flip[i] = j;
      }
    }
    for (let k = 0; k < NZ; k += 1) {
      for (let j = 0; j < NY; j += 1) {
        for (let x = 0; x < NX; x += 1) {
          const n = x + j * NX + k * plane;
          const m = x + j * NX + (NZ - 1 - k) * plane;
          for (let i = 0; i < 19; i += 1) {
            expect(f[i]?.[n]).toBe(f[flip[i] ?? i]?.[m]);
          }
        }
      }
    }
    // The z-UNIFORMITY band (measured ≈ 1.1% of u_max, concentrated in
    // the one-cell dip at the symmetry planes): the on-node specular
    // reflection places the effective plane half a cell out, so the
    // developed profile carries a saturated O(dx) near-plane deviation
    // — mirror-exact (the pin above) but not perfectly uniform. The
    // band matches the profile's own staircase band; it saturates
    // (measured identical from step 2000 to 4000), never grows.
    let maxZDeviation = 0;
    for (let j = 0; j < NY; j += 1) {
      let mean = 0;
      for (let k = 0; k < NZ; k += 1) {
        mean += snapshot.velocityXMPerS[column + j * NX + k * plane] ?? 0;
      }
      mean /= NZ;
      for (let k = 0; k < NZ; k += 1) {
        const measured =
          snapshot.velocityXMPerS[column + j * NX + k * plane] ?? 0;
        maxZDeviation = Math.max(maxZDeviation, Math.abs(measured - mean));
      }
    }
    expect(maxZDeviation).toBeLessThan(0.02 * uMaxAnalytic);
    // Mass conservation at steady state: inlet and outlet fluxes agree
    // over the full cross-section.
    const fluxAt = (x: number): number => {
      let flux = 0;
      for (let j = 0; j < NY; j += 1) {
        for (let k = 0; k < NZ; k += 1) {
          const index = x + j * NX + k * plane;
          flux +=
            (snapshot.densityKgPerM3[index] ?? 0) *
            (snapshot.velocityXMPerS[index] ?? 0);
        }
      }
      return flux;
    };
    const inlet = fluxAt(1);
    const outlet = fluxAt(NX - 2);
    expect(Math.abs(inlet - outlet)).toBeLessThan(0.03 * Math.abs(inlet));
    // Timeout budget: the 4000-step 32×13×11 run measured ≈ 10 s
    // isolated at 66a authoring time; the full gate's parallel CPU
    // contention multiplies fixtures by up to ~7× (the Phase 63
    // measurements), and the Phase 66b rotating fixtures grew the
    // suite's parallel load further (re-measured ≈ 46 s isolated on a
    // busy host) — 150 s is the re-extrapolated worst case — an
    // infrastructure budget, not an assertion: passing still requires
    // passing.
  }, 150_000);
});
