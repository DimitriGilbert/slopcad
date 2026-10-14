/**
 * The Boussinesq buoyancy pins (Phase 65b): the force term against
 * hand values at known ΔT (the roadmap's named unit pin), the Guo
 * forcing's exact momentum injection (the per-step audit extended
 * with the body-force term), the sign honesty of the Boussinesq
 * statement (hot rises against a −Y gravity), and the unforced-path
 * bitwise identity (a β = 0 block is the Phase 63 kernel, byte for
 * byte). Node-env vitest, no network — the law-S2 stance.
 */

import { describe, expect, it } from "vitest";

import { lbmBuoyancyForceLattice } from "./buoyancy";
import { analyticOccupancy, testFluid } from "./fixtures";
import { lbmUnitSystem } from "./lattice-units";
import { createLbmStepper, type LbmStepperConfig } from "./stepper";

const NX = 24;
const NY = 16;
const DX = 0.01;
const GRAVITY: readonly [number, number] = [0, -9.81];
const BETA = 1 / 300;
const T_REF = 300;

function boxMask(): Uint8Array {
  return analyticOccupancy(NX, NY, () => false);
}

describe("the Boussinesq buoyancy force field", () => {
  it("equals the hand lattice value −β·ΔT·g·dt²/dx at every fluid node", () => {
    const solid = boxMask();
    const mask = { nx: NX, ny: NY, solid };
    const units = lbmUnitSystem({
      cellSizeM: DX,
      characteristicVelocityMPerS: 0.2,
      kinematicViscosityM2PerS: 1.5e-5,
      referenceDensityKgPerM3: 1.2,
    });
    expect(units.ok).toBe(true);
    if (!units.ok) return;
    const temperatureK = new Float64Array(NX * NY).fill(T_REF);
    // A known ΔT pattern: +10 K on the west third, −5 K on the east
    // third, reference elsewhere.
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const index = x + y * NX;
        temperatureK[index] =
          x < NX / 3 ? T_REF + 10 : x >= (2 * NX) / 3 ? T_REF - 5 : T_REF;
      }
    }
    const field = lbmBuoyancyForceLattice(
      {
        gravityMPerS2: GRAVITY,
        thermalExpansionPerK: BETA,
        referenceTemperatureK: T_REF,
        temperatureK,
      },
      mask,
      units.value,
    );
    const dt = units.value.timeStepS;
    const factor = (dt * dt) / DX;
    for (let index = 0; index < NX * NY; index += 1) {
      const deltaT = (temperatureK[index] ?? 0) - T_REF;
      // The hand statement: F = −β·ΔT·g·dt²/dx per component.
      expect(field.fx[index]).toBeCloseTo(
        -BETA * deltaT * GRAVITY[0] * factor,
        15,
      );
      expect(field.fy[index]).toBeCloseTo(
        -BETA * deltaT * GRAVITY[1] * factor,
        15,
      );
    }
    // The sign honesty on one hand value: hot (ΔT = +10) against
    // g = (0, −9.81) pushes UP (positive y), cold pushes DOWN.
    expect(field.fy[0]).toBeGreaterThan(0);
    expect(field.fy[NX * NY - 1]).toBeLessThan(0);
  });

  it("reads zero force at solid nodes and at the reference temperature", () => {
    const solid = analyticOccupancy(NX, NY, (_x, y) => y === NY / 2);
    const units = lbmUnitSystem({
      cellSizeM: DX,
      characteristicVelocityMPerS: 0.2,
      kinematicViscosityM2PerS: 1.5e-5,
      referenceDensityKgPerM3: 1.2,
    });
    if (!units.ok) return;
    const temperatureK = new Float64Array(NX * NY).fill(T_REF + 30);
    const field = lbmBuoyancyForceLattice(
      {
        gravityMPerS2: GRAVITY,
        thermalExpansionPerK: BETA,
        referenceTemperatureK: T_REF,
        temperatureK,
      },
      { nx: NX, ny: NY, solid },
      units.value,
    );
    for (let x = 0; x < NX; x += 1) {
      expect(field.fy[x + Math.floor(NY / 2) * NX]).toBe(0);
    }
    expect(field.fy[0]).not.toBe(0);
    // Uniform T_ref: no force anywhere.
    const neutral = lbmBuoyancyForceLattice(
      {
        gravityMPerS2: GRAVITY,
        thermalExpansionPerK: BETA,
        referenceTemperatureK: T_REF,
        temperatureK: new Float64Array(NX * NY).fill(T_REF),
      },
      { nx: NX, ny: NY, solid },
      units.value,
    );
    expect(neutral.fx.every((value) => value === 0)).toBe(true);
    expect(neutral.fy.every((value) => value === 0)).toBe(true);
  });
});

function closedBoxConfig(
  temperatureK: Float64Array,
  beta: number | null,
  kinematicViscosityM2PerS = 1.5e-5,
): LbmStepperConfig {
  return {
    mask: { nx: NX, ny: NY, solid: boxMask() },
    fluid: testFluid(1.2, kinematicViscosityM2PerS),
    cellSizeM: DX,
    characteristicVelocityMPerS: 0.2,
    collision: { kind: "trt" },
    west: { kind: "wall", slip: false },
    east: { kind: "wall", slip: false },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    ...(beta === null
      ? {}
      : {
          buoyancy: {
            gravityMPerS2: GRAVITY,
            thermalExpansionPerK: beta,
            referenceTemperatureK: T_REF,
            temperatureK,
          },
        }),
  };
}

describe("the Guo-forced stepper", () => {
  it("closes the exact momentum audit with the body-force term", () => {
    // A smooth, deterministic convection-roll pattern (sinusoid in x,
    // cosinusoid in y, both signs present, zero mean by subtraction):
    // white-noise ΔT at air viscosity would force the grid scale at
    // τ ≈ 0.501 and blow the lattice up on physics the audit does not
    // need — the pin wants a stable forced march, not turbulence. The
    // 1.5e-4 m²/s viscosity (the glycol band) keeps τ safely off 1/2.
    const temperatureK = new Float64Array(NX * NY);
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const index = x + y * NX;
        const deltaT =
          5 *
          Math.sin((2 * Math.PI * (2 * x + 1)) / (2 * NX)) *
          Math.cos((Math.PI * (2 * y + 1)) / (2 * NY));
        temperatureK[index] = T_REF + deltaT;
      }
    }
    let meanDeltaT = 0;
    for (const value of temperatureK) meanDeltaT += value - T_REF;
    meanDeltaT /= temperatureK.length;
    for (let index = 0; index < temperatureK.length; index += 1) {
      temperatureK[index] = (temperatureK[index] ?? 0) - meanDeltaT;
    }
    const created = createLbmStepper(
      closedBoxConfig(temperatureK, BETA, 1.5e-4),
    );
    if (!created.ok) throw new Error(created.error.message);
    const stepper = created.value;
    let worst = 0;
    for (let step = 0; step < 400; step += 1) {
      const before = stepper.momentumLattice();
      stepper.advance();
      const books = stepper.lastStepBookkeeping();
      if (books === undefined) continue;
      const after = stepper.momentumLattice();
      const residualX =
        after.x -
        before.x -
        (books.faceDeltaX -
          books.solidImpulseX -
          books.droppedX +
          books.bodyForceX);
      const residualY =
        after.y -
        before.y -
        (books.faceDeltaY -
          books.solidImpulseY -
          books.droppedY +
          books.bodyForceY);
      worst = Math.max(worst, Math.abs(residualX), Math.abs(residualY));
    }
    expect(stepper.diverged).toBe(false);
    // The float32 storage rounding band, the cylinder fixture's
    // precedent (measured there at 1.9e-6 over a longer run).
    expect(worst).toBeLessThan(1e-4);
  });

  it("injects the summed force as momentum in a single collision-free check", () => {
    // One step from rest in the closed box: every wall reflection
    // reacts to the buoyant momentum, and the audit already closes it
    // above; here the injected amount itself is pinned against the
    // force field total (the books' bodyForce term is ΣF, not an
    // approximation of it).
    const temperatureK = new Float64Array(NX * NY).fill(T_REF + 8);
    const created = createLbmStepper(closedBoxConfig(temperatureK, BETA));
    if (!created.ok) throw new Error(created.error.message);
    const stepper = created.value;
    const units = stepper.meta.units;
    const force = lbmBuoyancyForceLattice(
      {
        gravityMPerS2: GRAVITY,
        thermalExpansionPerK: BETA,
        referenceTemperatureK: T_REF,
        temperatureK,
      },
      { nx: NX, ny: NY, solid: boxMask() },
      units,
    );
    const expectedY =
      BETA * 8 * 9.81 * ((units.timeStepS * units.timeStepS) / DX);
    let totalY = 0;
    for (const value of force.fy) totalY += value;
    expect(totalY).toBeCloseTo(expectedY * NX * NY, 10);
    stepper.advance();
    const books = stepper.lastStepBookkeeping();
    expect(books?.bodyForceX).toBeCloseTo(0, 12);
    expect(books?.bodyForceY).toBeCloseTo(totalY, 12);
  });

  it("runs bitwise identical to the unforced kernel when β = 0", () => {
    const temperatureK = new Float64Array(NX * NY).fill(T_REF + 8);
    // A block present with β = 0, vs no block at all: the force field
    // is exactly zero and every Guo term contributes +0.0 — the
    // pinned unforced path must not have moved by a byte.
    const forced = createLbmStepper(closedBoxConfig(temperatureK, 0));
    const plain = createLbmStepper(closedBoxConfig(temperatureK, null));
    if (!forced.ok || !plain.ok) throw new Error("config declined");
    forced.value.run(600);
    plain.value.run(600);
    const a = forced.value.distributions();
    const b = plain.value.distributions();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      const columnA = a[i];
      const columnB = b[i];
      if (columnA === undefined || columnB === undefined) continue;
      expect(columnA.length).toBe(columnB.length);
      for (let index = 0; index < columnA.length; index += 1) {
        expect(columnA[index]).toBe(columnB[index]);
      }
    }
  });
});
