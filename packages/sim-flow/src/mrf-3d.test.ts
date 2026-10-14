/**
 * The MRF tests (Phase 66b): the frozen-rotor frame physics against
 * analytic ground truth at oracle resolution, the exact extended
 * momentum audit, bitwise determinism, and every refusal the door
 * owns — including the rotation-marker routing pins (the static CPU
 * stepper and the WGSL provider both decline rotating configs loudly,
 * the provider's CPU-only posture stated in its message).
 *
 * ## The analytic fixtures — the force's exact fixed points
 *
 * The module doc's zone force F/ρ = ((Ω×r)·∇)u_h − Ω×u_h vanishes
 * identically on three states, and each vanishing is a physics
 * anchor:
 *
 * - **The rest fixed point**: every wall static, no rotor — u = 0,
 *   ρ = 1 is an exact steady state the forced kernel must HOLD (no
 *   force manufactured at rest, no spurious head).
 * - **The rigid-co-rotation fixed point**: the annulus between an
 *   inner rotor and an outer cylinder BOTH spinning at Ω (the zone
 *   covers both, so both walls carry the moving-wall velocity) spins
 *   up to rigid co-rotation u_h = Ω×r with the physical head
 *   ∇p = ρΩ²r⊥ — ρ(r) = C·exp(1.5·Ω_lat²·r²) against c_s² = 1/3, C
 *   fixed by exact mass conservation. The force vanishes there
 *   exactly (the azimuthal self-derivative of Ω×r cancels the
 *   Coriolis term identically), so nothing drives the co-rotating
 *   fluid off its rigid rotation, and the head is the physical one —
 *   not the doubled head a mis-substituted force would demand. THE
 *   pin of the frame force's exactness.
 * - **Axial through-flow through a rotorless zone**: u_h ∥ Ω is
 *   force-free (Coriolis zero, azimuthal derivative of an
 *   axisymmetric axial profile zero) — the zone must carry the flow
 *   without manufacturing swirl or radial pumping; the fan's own
 *   operating configuration, pinned at its rotorless limit.
 *
 * - **Taylor–Couette with a zone boundary**: the inner cylinder
 *   rotating, the outer stationary, the MRF zone ending at a mid-gap
 *   radius — the steady lab solution u_θ = A·r + B/r must hold across
 *   the WHOLE gap (the interface is raw population exchange; there is
 *   nothing to see there, and the profile shows exactly that), and
 *   the rotor torque must match the analytic Couette wall torque —
 *   the load-curve currency's ground truth.
 */

import { describe, expect, it } from "vitest";

import { analyticOccupancy3d, testFluid } from "./fixtures";
import { lbm3dUnitSystem } from "./lattice-units-3d";
import { lbmRelaxationRates } from "./relaxation";
import { lbm3dCollide } from "./relaxation-3d";
import {
  createMrf3dStepper,
  mrfCylindricalZonePredicate,
  type Lbm3dMrfConfig,
  type Lbm3dMrfStepper,
} from "./mrf-3d";
import { lbm3dCompileAxis } from "./rotation-3d";
import {
  createLbm3dState,
  lbm3dComputeMacroscopic,
  lbm3dTotalMomentum,
} from "./state-3d";
import { createLbm3dStepper, type Lbm3dStepperConfig } from "./stepper-3d";
import { createWgsl3dStepper } from "./wgsl-stepper-3d";
import { createWgslFakeDevice } from "./wgsl-fake-device";

/** The shared lattice design: dx = 1 mm, u_char = 0.075 m/s, dt = 2/3 ms. */
const DX = 0.001;
const U_CHAR = 0.075;
const NUS = 1.5e-4; // τ⁺ = 0.8 (TRT), ν_lat = 0.1.
/** The lattice↔SI velocity factor dt/dx (the profile pins use it). */
const SI_TO_LATTICE = (0.05 * DX) / U_CHAR;

function wallFaces(): Pick<
  Lbm3dStepperConfig,
  "west" | "east" | "south" | "north" | "bottom" | "top"
> {
  return {
    west: { kind: "wall", slip: false },
    east: { kind: "wall", slip: false },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "symmetry" },
    top: { kind: "symmetry" },
  };
}

/** The radius of a node from the domain center, lattice cells. */
function radiusFrom(x: number, y: number, cx: number, cy: number): number {
  return Math.hypot(x - cx, y - cy);
}

function mrfConfig(
  nx: number,
  ny: number,
  nz: number,
  solid: Uint8Array,
  axisX: number,
  axisY: number,
  omegaRadPerS: number,
  zoneRadius: number,
): Lbm3dMrfConfig {
  return {
    mask: { nx, ny, nz, solid },
    fluid: testFluid(1.2, NUS),
    cellSizeM: DX,
    characteristicVelocityMPerS: U_CHAR,
    collision: { kind: "trt" },
    ...wallFaces(),
    rotation: { kind: "mrf" },
    axis: {
      pointM: [axisX * DX, axisY * DX, 0],
      direction: [0, 0, 1],
    },
    omegaRadPerS,
    rotatingZone: (x, y) => Math.hypot(x - axisX, y - axisY) <= zoneRadius,
  };
}

function stepperOrFail(config: Lbm3dMrfConfig): Lbm3dMrfStepper {
  const created = createMrf3dStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("the Guo forcing seam (relaxation-3d's collide, exact moments)", () => {
  it("adds exactly F of momentum per node and conserves mass", () => {
    const nx = 6;
    const ny = 6;
    const nz = 3;
    const units = lbm3dUnitSystem({
      cellSizeM: DX,
      characteristicVelocityMPerS: U_CHAR,
      kinematicViscosityM2PerS: NUS,
      referenceDensityKgPerM3: 1.2,
    });
    if (!units.ok) throw new Error(units.error.message);
    const rates = lbmRelaxationRates({ kind: "trt" }, units.value.tauPlus);
    const state = createLbm3dState({
      nx,
      ny,
      nz,
      solid: new Uint8Array(nx * ny * nz),
    });
    if (!lbm3dComputeMacroscopic(state)) throw new Error("diverged at rest");
    const fx = new Float64Array(nx * ny * nz).fill(3e-4);
    const fy = new Float64Array(nx * ny * nz).fill(0);
    const fz = new Float64Array(nx * ny * nz).fill(-6e-5);
    const before = lbm3dTotalMomentum(state);
    let massBefore = 0;
    for (let index = 0; index < nx * ny * nz; index += 1) {
      massBefore += state.rho[index] ?? 0;
    }
    lbm3dCollide(state, rates, { fx, fy, fz });
    const after = lbm3dTotalMomentum(state);
    let massAfter = 0;
    for (let index = 0; index < nx * ny * nz; index += 1) {
      massAfter += state.rho[index] ?? 0;
    }
    const nodes = nx * ny * nz;
    // Per-node exactness: Σ ΔM·c = F per node (f32 storage rounding only;
    // measured residual ≈ 6.5e-7 over the 108 forced nodes).
    expect(after.x - before.x).toBeCloseTo(nodes * 3e-4, 5);
    expect(after.y - before.y).toBeCloseTo(0, 9);
    expect(after.z - before.z).toBeCloseTo(nodes * -6e-5, 5);
    expect(Math.abs(massAfter - massBefore)).toBeLessThan(1e-9 * nodes);
  });
});

describe("the rest fixed point (whole-domain zone, no rotor)", () => {
  // 17×17×3 of pure fluid (the frame force's own fixture; a zone with
  // no solid is legal, and any solid inside would be a rotor). Ω_lat
  // = 0.016 (Ω_SI = 24 rad/s at dt = 2/3 ms), zone-edge velocity
  // 0.016·11.31 ≈ 0.181 — under the ceiling.
  const N = 17;
  const NZ = 3;
  const CENTER = 8;
  const solid = new Uint8Array(N * N * NZ);
  const stepper = stepperOrFail(
    mrfConfig(N, N, NZ, solid, CENTER, CENTER, 24, 99),
  );

  it("holds u = 0 and ρ = 1 — no force manufactured at rest", () => {
    stepper.run(1200);
    expect(stepper.diverged).toBe(false);
    const snapshot = stepper.snapshotLattice();
    let maxSpeed = 0;
    let maxRhoError = 0;
    for (let index = 0; index < N * N * NZ; index += 1) {
      if (solid[index] === 1) continue;
      const speed = Math.hypot(
        snapshot.ux[index] ?? 0,
        snapshot.uy[index] ?? 0,
        snapshot.uz[index] ?? 0,
      );
      maxSpeed = Math.max(maxSpeed, speed);
      maxRhoError = Math.max(
        maxRhoError,
        Math.abs((snapshot.rho[index] ?? 0) - 1),
      );
    }
    console.log("MRF-REST maxSpeed", maxSpeed, "maxRhoError", maxRhoError);
    // Both force terms are identically zero at u = 0, so the state the
    // rest equilibrium fills is an exact fixed point of the forced
    // kernel: the run holds it bitwise (measured maxSpeed EXACTLY 0;
    // maxRhoError ≈ 1.5e-8, the f32 storage rounding of the weights'
    // sum) — no spurious head, no drift, nothing manufactured at rest.
    expect(maxSpeed).toBeLessThan(1e-8);
    expect(maxRhoError).toBeLessThan(1e-7);
  }, 60_000);
});

describe("the rigid-co-rotation fixed point (both walls spinning at Ω)", () => {
  // 27×27×3 annulus: inner rotor r ≤ 4.5, outer cylinder r ≥ 12.5,
  // the zone covering the WHOLE domain so BOTH walls are moving walls
  // at u_w = Ω×r. The exact steady state is rigid co-rotation
  // u_h = Ω×r with the physical head ρ(r) = C·exp(1.5·Ω_lat²·r²) —
  // the force vanishes on it identically (the azimuthal
  // self-derivative of the linear field Ω×r cancels the Coriolis
  // term), and the two spinning walls spin the rest-filled fluid up
  // to it. Ω_lat = 0.01467 (Ω_SI = 22 rad/s), zone-edge velocity
  // 0.01467·12 ≈ 0.176 — under the ceiling; the 4000-step budget is
  // the Couette fixture's own spin-up scale.
  const N = 27;
  const NZ = 3;
  const CENTER = 13;
  const OMEGA = 22;
  const solid = analyticOccupancy3d(N, N, NZ, (x, y) => {
    const r = radiusFrom(x, y, CENTER, CENTER);
    return r <= 4.5 || r >= 12.5;
  });
  const stepper = stepperOrFail(
    mrfConfig(N, N, NZ, solid, CENTER, CENTER, OMEGA, 99),
  );

  it("spins up to rigid co-rotation with the physical head", () => {
    stepper.run(4000);
    expect(stepper.diverged).toBe(false);
    const snapshot = stepper.snapshotLattice();
    const omegaLat = stepper.meta.omegaLattice;
    let rMax = 0;
    let sumRho = 0;
    let sumExp = 0;
    for (let z = 0; z < NZ; z += 1) {
      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const index = x + y * N + z * N * N;
          if (solid[index] === 1) continue;
          const r = radiusFrom(x, y, CENTER, CENTER);
          rMax = Math.max(rMax, r);
          sumRho += snapshot.rho[index] ?? 0;
          sumExp += Math.exp(1.5 * omegaLat * omegaLat * r * r);
        }
      }
    }
    const tip = omegaLat * rMax;
    const c = sumRho / sumExp;
    let maxThetaError = 0;
    let maxRadial = 0;
    let maxRhoError = 0;
    for (let z = 0; z < NZ; z += 1) {
      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const index = x + y * N + z * N * N;
          if (solid[index] === 1) continue;
          const rx = x - CENTER;
          const ry = y - CENTER;
          const r = Math.hypot(rx, ry);
          const vx = snapshot.ux[index] ?? 0;
          const vy = snapshot.uy[index] ?? 0;
          // Cylindrical decomposition about the axis: azimuthal speed
          // vs the rigid profile Ω·r, radial speed vs 0.
          const thetaMeasured = (rx * vy - ry * vx) / r;
          const radialMeasured = (rx * vx + ry * vy) / r;
          maxThetaError = Math.max(
            maxThetaError,
            Math.abs(thetaMeasured - omegaLat * r),
          );
          maxRadial = Math.max(maxRadial, Math.abs(radialMeasured));
          maxRhoError = Math.max(
            maxRhoError,
            Math.abs(
              (snapshot.rho[index] ?? 0) -
                c * Math.exp(1.5 * omegaLat * omegaLat * r * r),
            ),
          );
        }
      }
    }
    console.log(
      "MRF-COROTATION thetaError/tip",
      maxThetaError / tip,
      "radial/tip",
      maxRadial / tip,
      "maxRhoError",
      maxRhoError,
      "head amplitude",
      c * Math.exp(1.5 * omegaLat * omegaLat * rMax * rMax) - 1,
    );
    // Bands (measured at authoring time: theta error 1.2% of tip,
    // radial 0.08% of tip, head node-wise error 6.1e-4 against a head
    // amplitude of 2.1%): the azimuthal profile within 4% of the tip
    // speed (the staircase walls' own honesty — the first-order
    // moving-wall placement error vanishes on the rigid profile
    // between co-rotating walls), NO radial motion beyond 1.5% of the
    // tip (the force's exact zero at co-rotation — a mis-substituted
    // force drives radial outflow here), and the density head
    // node-wise within a fraction of its own amplitude.
    expect(maxThetaError / tip).toBeLessThan(0.04);
    expect(maxRadial / tip).toBeLessThan(0.015);
    expect(maxRhoError).toBeLessThan(1.5e-3);
  }, 120_000);
});

describe("axial through-flow through a rotorless zone (no unforced swirl)", () => {
  // A circular tube about +z (fluid r_xy < 6.5 of the center, the
  // staircase's own circle), an axial velocity inlet at the bottom, a
  // pressure outlet at the top, and a ROTORLESS rotating zone
  // r_xy ≤ 4.5 about the same axis at Ω_SI = 30 (Ω_lat = 0.02,
  // zone-edge 0.09). Through-flow along the rotation axis is
  // u_h ∥ Ω — the exact force vanishes on an axisymmetric axial
  // profile, so the zone must carry the flow without manufacturing
  // swirl or radial pumping (the fan's operating configuration at its
  // rotorless limit; a mis-substituted force pumps the through-flow
  // radially here).
  const NXY = 17;
  const NZ = 20;
  const CENTER = 8;
  const OMEGA = 30;
  const solid = analyticOccupancy3d(
    NXY,
    NXY,
    NZ,
    (x, y) => radiusFrom(x, y, CENTER, CENTER) >= 6.5,
  );
  const stepper = stepperOrFail({
    mask: { nx: NXY, ny: NXY, nz: NZ, solid },
    fluid: testFluid(1.2, NUS),
    cellSizeM: DX,
    characteristicVelocityMPerS: U_CHAR,
    collision: { kind: "trt" },
    west: { kind: "wall", slip: false },
    east: { kind: "wall", slip: false },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "velocity-inlet", velocityMPerS: [0, 0, U_CHAR] },
    top: { kind: "pressure-outlet", pressurePa: 0 },
    rotation: { kind: "mrf" },
    axis: {
      pointM: [CENTER * DX, CENTER * DX, 0],
      direction: [0, 0, 1],
    },
    omegaRadPerS: OMEGA,
    rotatingZone: (x, y) => radiusFrom(x, y, CENTER, CENTER) <= 4.5,
  });

  it("carries the through-flow without manufacturing swirl or pumping", () => {
    stepper.run(2000);
    expect(stepper.diverged).toBe(false);
    const snapshot = stepper.snapshotLattice();
    // The inlet's lattice velocity (the unit closure's own factor).
    const inletLattice = U_CHAR * (SI_TO_LATTICE / DX);
    // The developed region only: the first quarter of the tube is the
    // inlet's own development length, where REAL radial motion lives
    // (the uniform inlet relaxes to the Poiseuille core).
    const Z_DEVELOPED = 8;
    let maxSwirl = 0;
    let maxRadial = 0;
    let sumUz = 0;
    let zoneCount = 0;
    for (let z = Z_DEVELOPED; z < NZ; z += 1) {
      for (let y = 0; y < NXY; y += 1) {
        for (let x = 0; x < NXY; x += 1) {
          const index = x + y * NXY + z * NXY * NXY;
          if (solid[index] === 1) continue;
          const rx = x - CENTER;
          const ry = y - CENTER;
          if (Math.hypot(rx, ry) > 4.5) continue;
          zoneCount += 1;
          const vx = snapshot.ux[index] ?? 0;
          const vy = snapshot.uy[index] ?? 0;
          const r = Math.hypot(rx, ry);
          sumUz += snapshot.uz[index] ?? 0;
          // The on-axis node carries no cylindrical decomposition by
          // definition (its rx·vy − ry·vx is identically 0).
          if (r < 0.5) continue;
          const theta = (rx * vy - ry * vx) / r;
          const radial = (rx * vx + ry * vy) / r;
          maxSwirl = Math.max(maxSwirl, Math.abs(theta));
          maxRadial = Math.max(maxRadial, Math.abs(radial));
        }
      }
    }
    const meanUz = sumUz / Math.max(1, zoneCount);
    console.log(
      "MRF-THROUGHFLOW maxSwirl/inlet",
      maxSwirl / inletLattice,
      "maxRadial/inlet",
      maxRadial / inletLattice,
      "meanUz/inlet",
      meanUz / inletLattice,
    );
    // Bands (measured at authoring time: swirl 0.2% of the inlet,
    // radial 3.1%, mean axial 1.60×): no swirl beyond 1% of the inlet
    // and no radial motion beyond 4% in the developed region. The
    // radial residue is the staircase tube's OWN geometry asymmetry,
    // not the frame — probed at authoring time by re-running the same
    // fixture at Ω = 1 rad/s (a 30× weaker frame force): the radial
    // maximum is unchanged (3.07% vs 3.08%), so the frame manufactures
    // none of it. The axial flow is carried through the zone at the
    // Poiseuille core's strength (the zone averages the pipe's fast
    // center: between the bulk 1× and the centerline 2× of the inlet).
    expect(maxSwirl / inletLattice).toBeLessThan(0.01);
    expect(maxRadial / inletLattice).toBeLessThan(0.04);
    expect(meanUz / inletLattice).toBeGreaterThan(1.0);
    expect(meanUz / inletLattice).toBeLessThan(2.0);
  }, 120_000);
});

describe("Taylor–Couette across the zone boundary (the MRF analytic pin)", () => {
  // 27×27×3, inner cylinder r ≤ 4.5 (the rotor, moving at Ω in the lab
  // variables the frozen-rotor form carries), outer cylinder r ≥ 12.5
  // (static), zone boundary r = 8.5 — a raw population interface. Ω_lat
  // = 0.02 (Ω_SI = 30 rad/s); Re_gap = U_i·gap/ν ≈ 7 — laminar.
  const N = 27;
  const NZ = 3;
  const CENTER = 13;
  const R_IN = 4.5;
  const R_OUT = 12.5;
  const R_ZONE = 8.5;
  const OMEGA = 30;
  const solid = analyticOccupancy3d(N, N, NZ, (x, y) => {
    const r = radiusFrom(x, y, CENTER, CENTER);
    return r <= R_IN || r >= R_OUT;
  });
  const stepper = stepperOrFail(
    mrfConfig(N, N, NZ, solid, CENTER, CENTER, OMEGA, R_ZONE),
  );

  it("recovers the Couette profile across the whole gap", () => {
    stepper.run(4000);
    expect(stepper.diverged).toBe(false);
    const snapshot = stepper.snapshotLattice();
    // Effective walls (half-way bounce-back: half a link outside the
    // extreme fluid nodes) and the analytic A·r + B/r between them.
    let rFirst = Infinity;
    let rLast = 0;
    let fluidCount = 0;
    let mass = 0;
    const rhoSnapshot = stepper.snapshotLattice();
    for (let z = 0; z < NZ; z += 1) {
      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const index = x + y * N + z * N * N;
          if (solid[index] === 1) continue;
          fluidCount += 1;
          mass += rhoSnapshot.rho[index] ?? 0;
          const r = radiusFrom(x, y, CENTER, CENTER);
          rFirst = Math.min(rFirst, r);
          rLast = Math.max(rLast, r);
        }
      }
    }
    const ri = (rFirst - 0.5) * DX;
    const ro = (rLast + 0.5) * DX;
    const a = (0 - OMEGA * ri * ri) / (ro * ro - ri * ri);
    const b = (OMEGA * ri * ri * ro * ro) / (ro * ro - ri * ri);
    // The wall speed sets the error scale (u_i = Ω·ri).
    const wallSpeedLattice = (OMEGA * ri * SI_TO_LATTICE) / DX;
    let maxError = 0;
    let errorAt = "";
    for (let z = 0; z < NZ; z += 1) {
      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const index = x + y * N + z * N * N;
          if (solid[index] === 1) continue;
          const rLat = radiusFrom(x, y, CENTER, CENTER);
          const rM = rLat * DX;
          const rx = x - CENTER;
          const ry = y - CENTER;
          const vx = snapshot.ux[index] ?? 0;
          const vy = snapshot.uy[index] ?? 0;
          const thetaMeasured = (rx * vy - ry * vx) / rLat;
          const analytic = ((a * rM + b / rM) / DX) * SI_TO_LATTICE;
          const error = Math.abs(thetaMeasured - analytic);
          if (error > maxError) {
            maxError = error;
            errorAt = `r=${rLat.toFixed(2)}`;
          }
        }
      }
    }
    console.log(
      "MRF-COUETTE maxError",
      maxError,
      "at",
      errorAt,
      "relative-to-wall",
      maxError / wallSpeedLattice,
      "massDrift",
      mass / fluidCount - 1,
    );
    // The moving-wall parked correction's stated O(u_w) mass residual:
    // measured 0.7% over 4000 steps — the full-way moving-boundary
    // family's own coarseness (the module contract's stated drift).
    expect(Math.abs(mass / fluidCount - 1)).toBeLessThan(1.5e-2);
    // The profile across the WHOLE gap within 10% of the wall speed
    // (measured 7.7%, worst at the first fluid shell where the
    // staircase corners and the mass drift sit; the raw interface
    // itself is invisible — the mid-gap shells match to a fraction of
    // a percent).
    expect(maxError / wallSpeedLattice).toBeLessThan(0.1);
  }, 120_000);

  it("matches the analytic Couette wall torque (the load currency)", () => {
    const samples = stepper.rotationState().history[0]?.samples ?? [];
    const start = Math.max(0, samples.length - 400);
    let sum = 0;
    for (let index = start; index < samples.length; index += 1) {
      sum += samples[index] ?? 0;
    }
    const measured = sum / Math.max(1, samples.length - start);
    // The effective radii the profile test derives (half-way walls).
    let rFirst = Infinity;
    let rLast = 0;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const index = x + y * N;
        if (solid[index] === 1) continue;
        const r = radiusFrom(x, y, CENTER, CENTER);
        rFirst = Math.min(rFirst, r);
        rLast = Math.max(rLast, r);
      }
    }
    const ri = (rFirst - 0.5) * DX;
    const ro = (rLast + 0.5) * DX;
    const mu = 1.2 * NUS;
    const analytic =
      -((4 * Math.PI * mu * OMEGA * ri * ri * ro * ro) / (ro * ro - ri * ri)) *
      (NZ * DX);
    console.log("MRF-TORQUE measured", measured, "analytic", analytic);
    // Measured 0.8% at authoring time (the corrected force is
    // identically zero on the Couette profile up to the difference
    // stencil's O(dx²) residue, so the wall shear carries the load
    // alone); the band leaves room for the staircase corners and the
    // moving-wall first-order correction.
    expect(measured).toBeLessThan(0);
    expect(Math.abs(measured / analytic - 1)).toBeLessThan(0.1);
  }, 60_000);

  it("closes the extended momentum audit over a fresh run", () => {
    const audit = stepperOrFail(
      mrfConfig(N, N, NZ, solid, CENTER, CENTER, OMEGA, R_ZONE),
    );
    const before = audit.momentumLattice();
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let scale = 0;
    for (let step = 0; step < 60; step += 1) {
      audit.advance();
      const books = audit.lastStepBookkeeping();
      if (books === undefined) throw new Error("no bookkeeping");
      sumX +=
        books.frameForceX +
        books.faceDeltaX -
        books.solidImpulseX -
        books.droppedX;
      sumY +=
        books.frameForceY +
        books.faceDeltaY -
        books.solidImpulseY -
        books.droppedY;
      sumZ +=
        books.frameForceZ +
        books.faceDeltaZ -
        books.solidImpulseZ -
        books.droppedZ;
      scale = Math.max(
        scale,
        Math.abs(books.frameForceX),
        Math.abs(books.solidImpulseY),
      );
    }
    const after = audit.momentumLattice();
    const residualX = after.x - before.x - sumX;
    const residualY = after.y - before.y - sumY;
    const residualZ = after.z - before.z - sumZ;
    console.log("MRF-AUDIT residuals", residualX, residualY, residualZ);
    expect(Math.abs(residualX)).toBeLessThan(1e-6 * Math.max(scale, 1));
    expect(Math.abs(residualY)).toBeLessThan(1e-6 * Math.max(scale, 1));
    expect(Math.abs(residualZ)).toBeLessThan(1e-6 * Math.max(scale, 1));
  }, 60_000);

  it("is bitwise deterministic on repeat runs", () => {
    const first = stepperOrFail(
      mrfConfig(N, N, NZ, solid, CENTER, CENTER, OMEGA, R_ZONE),
    );
    const second = stepperOrFail(
      mrfConfig(N, N, NZ, solid, CENTER, CENTER, OMEGA, R_ZONE),
    );
    first.run(40);
    second.run(40);
    expect(first.diverged).toBe(false);
    const fa = first.distributions();
    const fb = second.distributions();
    for (let i = 0; i < fa.length; i += 1) {
      expect(
        Buffer.from(fa[i]!.buffer, fa[i]!.byteOffset, fa[i]!.byteLength).equals(
          Buffer.from(fb[i]!.buffer, fb[i]!.byteOffset, fb[i]!.byteLength),
        ),
      ).toBe(true);
    }
    const ta = first.rotationState().history[0]?.samples ?? [];
    const tb = second.rotationState().history[0]?.samples ?? [];
    expect(ta).toEqual(tb);
  }, 60_000);
});

describe("the MRF door's refusals and the rotation-marker routing", () => {
  const tinyWithRotor = mrfConfig(
    9,
    9,
    3,
    analyticOccupancy3d(9, 9, 3, (x, y) => Math.hypot(x - 4, y - 4) <= 1.5),
    4,
    4,
    24,
    3,
  );

  it("refuses a zero frame rate (the static stepper's own door)", () => {
    const created = createMrf3dStepper({ ...tinyWithRotor, omegaRadPerS: 0 });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("sim/scenario-invalid");
    expect(created.error.message).toContain("non-zero");
  });

  it("refuses a rotating zone with no fluid nodes", () => {
    const solidAll = analyticOccupancy3d(9, 9, 3, () => true);
    const created = createMrf3dStepper({
      ...tinyWithRotor,
      mask: { nx: 9, ny: 9, nz: 3, solid: solidAll },
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("fluid nodes");
  });

  it("refuses a frame whose zone-edge lattice velocity passes the ceiling", () => {
    const created = createMrf3dStepper({
      ...tinyWithRotor,
      omegaRadPerS: 4000,
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("low-Mach ceiling");
  });

  it("routes the static CPU stepper's refusal of rotating configs", () => {
    const created = createLbm3dStepper(tinyWithRotor);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("sim/scenario-invalid");
    expect(created.error.message).toContain("createMrf3dStepper");
  });

  it("pins the WGSL provider's loud CPU-only decline", async () => {
    const created = await createWgsl3dStepper(
      tinyWithRotor,
      createWgslFakeDevice(),
      {
        stepCapacity: 4,
      },
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("sim/scenario-invalid");
    expect(created.error.message).toContain("CPU-oracle-only");
    expect(created.error.message).toContain("createMrf3dStepper");
  });

  it("refuses a foreign rotation marker at its own door", () => {
    // The marker mismatch is compile-time protection for typed callers;
    // the runtime refusal guards untrusted wiring (the worker boundary
    // hands over parsed payloads), so the fixture arrives via a JSON
    // round-trip — the typed shape deliberately violated.
    const foreign = JSON.parse(
      JSON.stringify({
        ...tinyWithRotor,
        rotation: { kind: "resolved-rotation" },
      }),
    ) as Lbm3dMrfConfig;
    const created = createMrf3dStepper(foreign);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain('"mrf"');
  });

  it("exposes the cylindrical zone helper (the fan zone shape)", () => {
    const axis = lbm3dCompileAxis(
      { pointM: [0.004, 0.004, 0], direction: [0, 0, 1] },
      [0, 0, 0],
      DX,
    );
    if (!axis.ok) throw new Error(axis.error.message);
    const predicate = mrfCylindricalZonePredicate(axis.value, 2);
    expect(predicate(4, 4, 0)).toBe(true);
    expect(predicate(5, 4, 0)).toBe(true);
    expect(predicate(7, 4, 0)).toBe(false);
  });
});
