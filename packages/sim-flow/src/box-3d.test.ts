import { describe, expect, it } from "vitest";

import { analyticOccupancy3d, testFluid } from "./fixtures";
import {
  type Lbm3dStepper,
  type Lbm3dStepperConfig,
  createLbm3dStepper,
} from "./stepper-3d";

/**
 * The static-box force fixture (Phase 66a's validation block — the
 * cylinder fixture's 3D generalization): uniform inflow past an
 * axis-aligned cube occupancy (the Phase 62 voxelizer's exact output
 * for an aligned box) with full-way bounce-back, integrated drag/
 * lift/side from momentum exchange, validated three ways:
 *
 * 1. the EXACT per-step momentum audit, three components — ΔM(t) over
 *    every distribution (solid-node bounce-back storage included)
 *    equals the ledger (face overwrites − solid impulses − dropped) to
 *    float32 rounding: the momentum-change sanity the 3D force
 *    integration is pinned against;
 * 2. steady-state physics — positive converged drag, lift and side ≈ 0
 *    by the geometry's exact y/z symmetry, and inlet/outlet mass flux
 *    balance;
 * 3. bitwise determinism on a repeat run.
 *
 * Lattice design: 24×12×12, cube x ∈ [8, 11], y ∈ [4, 7], z ∈ [4, 7]
 * (a 4 mm side, centered to exact four-fold symmetry about both
 * cross-flow axes), u∞ = 0.1 m/s at u_lat = 0.05, ν = 2.7e-5 m²/s →
 * τ⁺ ≈ 0.54, Re = u∞·D/ν ≈ 15 — steady regime; 8000 steps is past the
 * settling (the last two 2000-step drag windows agree to 1e-7). The
 * magic parameter is Λ = 1/12 (the advection-dominated stability value
 * `./relaxation` documents), a MEASURED 3D decision: the channel-exact
 * Λ = 1/4 diverges this scenario at step ≈ 466 (the wall-edge/cube-edge
 * resonance the 2D twin does not have at the same τ⁺ — the 2D cylinder
 * fixture runs Λ = 1/4 steadily at τ⁺ ≈ 0.54), while Λ = 1/12 runs it
 * to steady convergence. TRT's second knob doing exactly its job. The
 * outlet is the ambient PRESSURE outlet — the family's conservative
 * face (the convective outflow carries a steady first-order flux
 * offset in this condition family, measured 11.7% in the 2D twin and
 * 25% here, so the mass-balance pin belongs on the pressure door).
 */

const NX = 24;
const NY = 12;
const NZ = 12;
const DX = 0.001;
const U = 0.1;
const STEPS = 8000;
// SI facts: ρ₀ = 1.2 kg/m³, D = 4·dx = 4 mm (the cube's cross-flow
// face is a square of side D).
const DYN_PRESSURE_AREA = 0.5 * 1.2 * U * U * 4 * DX * 4 * DX;

function box(): Lbm3dStepper {
  const config: Lbm3dStepperConfig = {
    mask: {
      nx: NX,
      ny: NY,
      nz: NZ,
      solid: analyticOccupancy3d(
        NX,
        NY,
        NZ,
        (x, y, z) => x >= 8 && x <= 11 && y >= 4 && y <= 7 && z >= 4 && z <= 7,
      ),
    },
    fluid: testFluid(1.2, 2.7e-5),
    cellSizeM: DX,
    characteristicVelocityMPerS: U,
    collision: { kind: "trt", magicLambda: 1 / 12 },
    west: { kind: "velocity-inlet", velocityMPerS: [U, 0, 0] },
    east: { kind: "pressure-outlet", pressurePa: 0 },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "wall", slip: false },
    top: { kind: "wall", slip: false },
  };
  const created = createLbm3dStepper(config);
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

describe("the static-box force fixture", () => {
  it("closes the exact three-component momentum audit every step", () => {
    const run = box();
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
      const residualZ =
        after.z -
        before.z -
        (bookkeeping.faceDeltaZ -
          bookkeeping.solidImpulseZ -
          bookkeeping.droppedZ);
      worstResidual = Math.max(
        worstResidual,
        Math.abs(residualX),
        Math.abs(residualY),
        Math.abs(residualZ),
      );
    }
    // The float32 storage rounding of the collision's exact
    // conservation (the 2D twin measured 1.9e-6); the band leaves an
    // order of magnitude of headroom without going slack.
    expect(worstResidual).toBeLessThan(1e-4);
    // Timeout budget: the 300-step audit (each step costs two full
    // momentum sums) measures ≈ 3.8 s isolated; the full gate's
    // parallel contention multiplies by up to ~7× — 45 s is ≈ 1.7×
    // that worst case — an infrastructure budget, not an assertion.
  }, 45_000);

  it("integrates steady positive drag, zero lift and side, and conserved mass", () => {
    const run = box();
    run.run(STEPS);
    expect(run.diverged).toBe(false);
    expect(run.step).toBe(STEPS);
    const { history } = run.forceState();
    const drag = history[0]?.samples ?? [];
    const lift = history[1]?.samples ?? [];
    const side = history[2]?.samples ?? [];
    expect(drag.length).toBe(STEPS);
    const dragLate = meanWindow(drag, STEPS - 2000);
    const dragEarlier = meanWindow(drag, STEPS - 4000);
    expect(dragLate).toBeGreaterThan(0);
    // Converged: the last two 2000-step windows agree within 0.5%
    // (measured 1.2e-7 — an order past the band, which leaves machine
    // headroom without going slack).
    expect(Math.abs(dragLate - dragEarlier)).toBeLessThan(0.005 * dragLate);
    // The cube is centered to exact four-fold symmetry about the
    // cross-flow axes: no lift, no side force (measured identically
    // zero — the symmetry is bitwise).
    expect(Math.abs(meanWindow(lift, STEPS - 2000))).toBeLessThan(
      1e-6 * dragLate,
    );
    expect(Math.abs(meanWindow(side, STEPS - 2000))).toBeLessThan(
      1e-6 * dragLate,
    );
    const cd = dragLate / DYN_PRESSURE_AREA;
    // The measured coarse-fixture band (11.07 at authoring time): this
    // tunnel is deliberately coarse — a FOUR-cell staircase cube at
    // Re ≈ 15 in a duct — and the unconfined published cube Cd at this
    // Re is ≈ 1.5–3; the inflation is the documented staircase +
    // confinement posture of the 63a cylinder fixture (measured 5.9
    // against a published ≈ 2 there), stronger here because the body
    // is coarser still. The EXACT audit identity above is this
    // fixture's precision pin; the Cd band only fences gross physics.
    expect(cd).toBeGreaterThan(8);
    expect(cd).toBeLessThan(14);
    const snapshot = run.snapshotSI();
    const plane = NX * NY;
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
    expect(Math.abs(inlet - outlet)).toBeLessThan(0.001 * inlet);
    // The flow genuinely went around the body: directly behind the
    // cube the stream runs at half the free stream (measured 0.051
    // m/s), clearly slower than the bypass just above the cube's top
    // face (measured 0.082 m/s) — a solid node would read exactly 0
    // and fail both.
    const wakeSpeed = snapshot.velocityXMPerS[14 + 6 * NX + 6 * plane] ?? 0;
    const bypassSpeed = snapshot.velocityXMPerS[9 + 8 * NX + 6 * plane] ?? 0;
    expect(wakeSpeed).toBeGreaterThan(0);
    expect(wakeSpeed).toBeLessThan(0.7 * U);
    expect(bypassSpeed).toBeGreaterThan(wakeSpeed);
    // Timeout budget: the 8000-step 24×12×12 run measures ≈ 65 s
    // isolated and ≈ 107 s inside the full scoped suite on this
    // machine (a 130 s-wall session); the grown 3D suite's run-to-run
    // contention spread runs that same suite at up to ≈ 1.35× the
    // wall (measured 176 s), which carried the fixture past the
    // former 120 s budget — 240 s is ≈ 1.6× that extrapolated worst
    // case — an infrastructure budget, not an assertion: passing still
    // requires passing.
  }, 240_000);

  it("is bitwise deterministic on a repeat box run", () => {
    const first = box();
    const second = box();
    first.run(400);
    second.run(400);
    const fa = first.distributions();
    const fb = second.distributions();
    expect(first.step).toBe(second.step);
    for (let i = 0; i < 19; i += 1) {
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
