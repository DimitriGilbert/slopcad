/**
 * The resolved-rotation tests (Phase 66b): the immersed moving
 * boundary's contract pins — the per-step mask discipline (the rotor's
 * staircase occupancy follows the authored predicate at θ = step·Ω_lat,
 * inferred through the snapshot's solid columns), the drag-torque sign
 * (a rotor spinning at Ω > 0 in still fluid feels opposing torque),
 * the substep-discipline refusals, bitwise determinism — and the
 * roadmap's cross-check: resolved-rotation torque vs MRF torque on a
 * shared tiny rotor both paths can run (the validation bullet of
 * Phase 66), banded honestly for the scheme coarseness the two paths
 * carry (frozen attitude + frame force vs the swept-attitude
 * unsteady average).
 */

import { describe, expect, it } from "vitest";

import { analyticOccupancy3d, testFluid } from "./fixtures";
import {
  createResolvedRotation3dStepper,
  type Lbm3dResolvedRotationConfig,
  type Lbm3dResolvedRotationStepper,
} from "./resolved-rotation-3d";
import { createMrf3dStepper } from "./mrf-3d";

/** The shared lattice design (the MRF tests' own). */
const DX = 0.001;
const U_CHAR = 0.075;
const NUS = 1.5e-4;

/** The shared tiny rotor: a cross paddle (hub + two blades), r_tip 3.5. */
function crossRotor(dx: number, dy: number, dz: number): boolean {
  const hub = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 1;
  const bladeY =
    Math.abs(dz) <= 0.6 && Math.abs(dy) <= 3.5 && Math.abs(dx) <= 0.6;
  const bladeX =
    Math.abs(dz) <= 0.6 && Math.abs(dx) <= 3.5 && Math.abs(dy) <= 0.6;
  return hub || bladeY || bladeX;
}

/** The rotor's lattice occupancy at θ = 0 (the MRF-side static mask). */
function crossRotorMask(nx: number, ny: number, nz: number): Uint8Array {
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const cz = (nz - 1) / 2;
  return analyticOccupancy3d(nx, ny, nz, (x, y, z) =>
    crossRotor(x - cx, y - cy, z - cz),
  );
}

function wallFaces(): Pick<
  Lbm3dResolvedRotationConfig,
  "west" | "east" | "south" | "north" | "bottom" | "top"
> {
  return {
    west: { kind: "wall", slip: false },
    east: { kind: "wall", slip: false },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "wall", slip: false },
    top: { kind: "wall", slip: false },
  };
}

const NX = 17;
const NY = 17;
const NZ = 5;
const CENTER = 8;
const OMEGA = 30; // Ω_lat = 0.02 (dt = 2/3 ms): tip 0.07, 314 steps/rev.

function resolvedConfig(omegaRadPerS: number): Lbm3dResolvedRotationConfig {
  return {
    mask: { nx: NX, ny: NY, nz: NZ, solid: new Uint8Array(NX * NY * NZ) },
    fluid: testFluid(1.2, NUS),
    cellSizeM: DX,
    characteristicVelocityMPerS: U_CHAR,
    collision: { kind: "trt" },
    ...wallFaces(),
    rotation: { kind: "resolved-rotation" },
    axis: {
      pointM: [CENTER * DX, CENTER * DX, ((NZ - 1) / 2) * DX],
      direction: [0, 0, 1],
    },
    omegaRadPerS,
    rotor: crossRotor,
  };
}

function resolvedOrFail(omegaRadPerS: number): Lbm3dResolvedRotationStepper {
  const created = createResolvedRotation3dStepper(resolvedConfig(omegaRadPerS));
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

/** The windowed mean torque of a run's last samples. */
function windowedMeanTorque(
  stepper: Lbm3dResolvedRotationStepper,
  window: number,
): number {
  const samples = stepper.rotationState().history[0]?.samples ?? [];
  const start = Math.max(0, samples.length - window);
  let sum = 0;
  for (let index = start; index < samples.length; index += 1) {
    sum += samples[index] ?? 0;
  }
  return sum / Math.max(1, samples.length - start);
}

describe("the resolved-rotation stepper's contract", () => {
  it("runs, opposes the shaft, and reports the discipline facts", () => {
    const stepper = resolvedOrFail(OMEGA);
    expect(stepper.meta.omegaLattice).toBeCloseTo(0.02, 9);
    expect(stepper.meta.stepsPerRevolution).toBeCloseTo(Math.PI / 0.01, 6);
    expect(stepper.meta.rotorRadiusLattice).toBeCloseTo(3, 9);
    expect(stepper.meta.rotorNodeCount).toBeGreaterThan(0);
    stepper.run(600);
    expect(stepper.diverged).toBe(false);
    expect(stepper.step).toBe(600);
    // The drag-torque sign: with Ω > 0 about +z the fluid resists —
    // the windowed mean torque is negative and non-trivial.
    const meanTorque = windowedMeanTorque(stepper, 200);
    console.log("RESOLVED meanTorque", meanTorque);
    expect(meanTorque).toBeLessThan(0);
    // The per-step series exists for every step.
    expect(stepper.rotationState().history[0]?.samples).toHaveLength(600);
  }, 120_000);

  it("moves the staircase mask with the authored predicate", () => {
    const stepper = resolvedOrFail(OMEGA);
    stepper.run(40); // θ = 40·0.02 = 0.8 rad — no symmetry angle.
    expect(stepper.diverged).toBe(false);
    const snapshot = stepper.snapshotLattice();
    // Rebuild the expected occupancy at θ = step·Ω_lat by the same
    // Rodrigues rotation the module documents, and compare against the
    // snapshot's solid columns (rho is exactly zero at solids).
    const theta = 40 * stepper.meta.omegaLattice;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // The module's own Rodrigues expression, term for term — threshold
    // predicates are ulp-sensitive, and d·cos + d·(1−cos) ≠ d exactly.
    const oneMinusCos = 1 - cos;
    let changes = 0;
    let mismatches = 0;
    const initial = crossRotorMask(NX, NY, NZ);
    for (let z = 0; z < NZ; z += 1) {
      for (let y = 0; y < NY; y += 1) {
        for (let x = 0; x < NX; x += 1) {
          const dx = x - CENTER;
          const dy = y - CENTER;
          const dz = z - (NZ - 1) / 2;
          // R(−θ)·d = d·cosθ − (ê×d)·sinθ + ê(ê·d)(1−cosθ), ê = z.
          const along = dz;
          const expectedSolid = crossRotor(
            dx * cos - -dy * sin + 0 * along * oneMinusCos,
            dy * cos - dx * sin + 0 * along * oneMinusCos,
            dz * cos - 0 * sin + 1 * along * oneMinusCos,
          );
          const index = x + y * NX + z * NX * NY;
          const snapshotSolid = (snapshot.rho[index] ?? 1) === 0;
          if (expectedSolid !== snapshotSolid) mismatches += 1;
          if (expectedSolid !== (initial[index] === 1)) changes += 1;
        }
      }
    }
    // The paddle genuinely moved (a non-symmetry angle re-rasters the
    // blades' cells — measured 20 of the cross's cells at 0.8 rad; the
    // rotated staircase overlaps the axis-aligned one substantially)...
    expect(changes).toBeGreaterThan(10);
    // ...and the live mask matches the predicate exactly — the
    // staircase rotation is the predicate's own valuation.
    expect(mismatches).toBe(0);
    // Fresh nodes (uncovered by the rotated rotor) are born with valid
    // density — no zero-rho fluid columns. Nodes the rotor COVERED are
    // solids now and read zero by contract; they are excluded.
    const thetaFresh = theta;
    const cosF = Math.cos(thetaFresh);
    const sinF = Math.sin(thetaFresh);
    let fluidZero = 0;
    for (let z = 0; z < NZ; z += 1) {
      for (let y = 0; y < NY; y += 1) {
        for (let x = 0; x < NX; x += 1) {
          const index = x + y * NX + z * NX * NY;
          if (initial[index] === 1) continue;
          const dx = x - CENTER;
          const dy = y - CENTER;
          const dz = z - (NZ - 1) / 2;
          const alongF = dx * 0 + dy * 0 + dz * 1;
          const kxF = 0 * dz - 1 * dy;
          const kyF = 1 * dx - 0 * dz;
          const kzF = 0 * dy - 0 * dx;
          const rotated = crossRotor(
            dx * cosF - kxF * sinF + 0 * alongF * (1 - cosF),
            dy * cosF - kyF * sinF + 0 * alongF * (1 - cosF),
            dz * cosF - kzF * sinF + 1 * alongF * (1 - cosF),
          );
          if (rotated) continue;
          if ((snapshot.rho[index] ?? 1) === 0) fluidZero += 1;
        }
      }
    }
    expect(fluidZero).toBe(0);
  }, 60_000);

  it("is bitwise deterministic on repeat runs", () => {
    const first = resolvedOrFail(OMEGA);
    const second = resolvedOrFail(OMEGA);
    first.run(60);
    second.run(60);
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
    expect(first.rotationState().history[0]?.samples).toEqual(
      second.rotationState().history[0]?.samples,
    );
  }, 60_000);
});

describe("the resolved-rotation door's refusals", () => {
  it("refuses a shaft rate that breaks the substep discipline", () => {
    // Ω_SI = 600 → Ω_lat = 0.4 → tip 0.4·3.5 = 1.4 ≫ 0.2.
    const created = createResolvedRotation3dStepper(resolvedConfig(600));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("substep discipline");
  });

  it("refuses a zero shaft rate", () => {
    const created = createResolvedRotation3dStepper(resolvedConfig(0));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("non-zero");
  });

  it("refuses an empty rotor predicate", () => {
    const created = createResolvedRotation3dStepper({
      ...resolvedConfig(OMEGA),
      rotor: () => false,
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("no nodes");
  });

  it("routes the static stepper's refusal of rotating configs", async () => {
    const { createLbm3dStepper } = await import("./stepper-3d");
    const created = createLbm3dStepper(resolvedConfig(OMEGA));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("createResolvedRotation3dStepper");
    const { createWgsl3dStepper } = await import("./wgsl-stepper-3d");
    const { createWgslFakeDevice } = await import("./wgsl-fake-device");
    const wgsl = await createWgsl3dStepper(
      resolvedConfig(OMEGA),
      createWgslFakeDevice(),
      {
        stepCapacity: 4,
      },
    );
    expect(wgsl.ok).toBe(false);
    if (wgsl.ok) return;
    expect(wgsl.error.message).toContain("CPU-oracle-only");
    expect(wgsl.error.message).toContain("createResolvedRotation3dStepper");
  });
});

describe("the roadmap cross-check: resolved torque vs MRF torque", () => {
  /**
   * The same cross rotor, the same box, the same Ω — resolved rotation
   * (the moving boundary, ~8 revolutions) against MRF (the frozen
   * rotor, zone r ⊥ ≤ 5.5). The two schemes share the torque
   * machinery by construction (the frozen rotor's moving wall IS the
   * resolved rotor's wall, in lab variables) and differ in what they
   * solve: the resolved path sweeps the rotor through every staircase
   * attitude (its time-mean torque is the true unsteady average,
   * including the fresh-cell conversions at each re-raster) while MRF
   * holds ONE frozen attitude and carries the rotating-frame zone
   * force instead — steady rotating-frame physics against an unsteady
   * lab average, so the agreement band is honest scheme coarseness,
   * not discretization noise. Low Re (tip-based Re ≈ 5·… ≈ 2.5) keeps
   * the physics laminar so the comparison tests the schemes, not the
   * regime.
   */
  const STEPS = 2500;
  const WINDOW = 400;

  it("agrees within the stated band", () => {
    const resolved = resolvedOrFail(OMEGA);
    resolved.run(STEPS);
    expect(resolved.diverged).toBe(false);
    const resolvedTorque = windowedMeanTorque(resolved, WINDOW);
    const mrfCreated = createMrf3dStepper({
      mask: { nx: NX, ny: NY, nz: NZ, solid: crossRotorMask(NX, NY, NZ) },
      fluid: testFluid(1.2, NUS),
      cellSizeM: DX,
      characteristicVelocityMPerS: U_CHAR,
      collision: { kind: "trt" },
      west: { kind: "wall", slip: false },
      east: { kind: "wall", slip: false },
      south: { kind: "wall", slip: false },
      north: { kind: "wall", slip: false },
      bottom: { kind: "wall", slip: false },
      top: { kind: "wall", slip: false },
      rotation: { kind: "mrf" },
      axis: {
        pointM: [CENTER * DX, CENTER * DX, ((NZ - 1) / 2) * DX],
        direction: [0, 0, 1],
      },
      omegaRadPerS: OMEGA,
      rotatingZone: (x, y) => Math.hypot(x - CENTER, y - CENTER) <= 5.5,
    });
    if (!mrfCreated.ok) throw new Error(mrfCreated.error.message);
    mrfCreated.value.run(STEPS);
    expect(mrfCreated.value.diverged).toBe(false);
    const mrfSamples =
      mrfCreated.value.rotationState().history[0]?.samples ?? [];
    const start = Math.max(0, mrfSamples.length - WINDOW);
    let sum = 0;
    for (let index = start; index < mrfSamples.length; index += 1) {
      sum += mrfSamples[index] ?? 0;
    }
    const mrfTorque = sum / Math.max(1, mrfSamples.length - start);
    const relative = Math.abs(resolvedTorque - mrfTorque) / Math.abs(mrfTorque);
    console.log(
      "CROSS-CHECK resolved",
      resolvedTorque,
      "mrf",
      mrfTorque,
      "relative",
      relative,
    );
    // Band: measured 9.6% at authoring time (resolved −2.247e-9 vs
    // MRF −2.050e-9) — the two schemes share the moving-wall torque
    // machinery by construction (the frozen rotor's wall IS the
    // resolved rotor's wall, in lab variables), and the residue is
    // the resolved path's attitude sweep and fresh-cell conversions
    // against the frozen attitude. The band leaves room for both
    // schemes' staircase honesty.
    expect(resolvedTorque).toBeLessThan(0);
    expect(mrfTorque).toBeLessThan(0);
    expect(relative).toBeLessThan(0.15);
  }, 300_000);
});
