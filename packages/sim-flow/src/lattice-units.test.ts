import { describe, expect, it } from "vitest";

import {
  LBM_DEFAULT_LATTICE_VELOCITY,
  LBM_MAX_LATTICE_VELOCITY,
  lbmUnitSystem,
} from "./lattice-units";

describe("the lattice unit closure", () => {
  const inputs = {
    cellSizeM: 0.001,
    characteristicVelocityMPerS: 0.1,
    kinematicViscosityM2PerS: 1.57e-5,
    referenceDensityKgPerM3: 1.2,
  } as const;

  it("fixes the velocity ratio: u_SI·dt/dx = u_lat at the characteristic speed", () => {
    const units = lbmUnitSystem(inputs);
    expect(units.ok).toBe(true);
    if (!units.ok) return;
    expect(
      (inputs.characteristicVelocityMPerS * units.value.timeStepS) /
        units.value.cellSizeM,
    ).toBeCloseTo(units.value.latticeVelocity, 15);
    expect(units.value.latticeVelocity).toBe(LBM_DEFAULT_LATTICE_VELOCITY);
  });

  it("derives τ⁺ from viscosity (ν_lat = c_s²(τ⁺ − ½))", () => {
    const units = lbmUnitSystem(inputs);
    if (!units.ok) throw new Error("unit system refused");
    const expectedNu =
      (inputs.kinematicViscosityM2PerS * units.value.timeStepS) /
      (inputs.cellSizeM * inputs.cellSizeM);
    expect(units.value.latticeViscosity).toBeCloseTo(expectedNu, 18);
    expect(units.value.tauPlus).toBeCloseTo(3 * expectedNu + 0.5, 15);
  });

  it("preserves Reynolds exactly (the closure's whole point)", () => {
    const units = lbmUnitSystem(inputs);
    if (!units.ok) throw new Error("unit system refused");
    const cells = 64;
    const rePhysical =
      (inputs.characteristicVelocityMPerS * (cells * inputs.cellSizeM)) /
      inputs.kinematicViscosityM2PerS;
    const reLattice =
      (units.value.latticeVelocity * cells) / units.value.latticeViscosity;
    expect(reLattice / rePhysical).toBeCloseTo(1, 12);
  });

  it("factors compose (velocity, pressure, force per depth)", () => {
    const units = lbmUnitSystem(inputs);
    if (!units.ok) throw new Error("unit system refused");
    expect(units.value.velocityFactor).toBeCloseTo(
      inputs.cellSizeM / units.value.timeStepS,
      12,
    );
    expect(units.value.pressureFactorPa).toBeCloseTo(
      (inputs.referenceDensityKgPerM3 *
        units.value.cellSizeM *
        units.value.cellSizeM) /
        (3 * units.value.timeStepS ** 2),
      12,
    );
    expect(units.value.forcePerDepthFactor).toBeCloseTo(
      (inputs.referenceDensityKgPerM3 * inputs.cellSizeM ** 3) /
        units.value.timeStepS ** 2,
      12,
    );
  });

  it("refuses a lattice velocity outside (0, 0.2]", () => {
    expect(lbmUnitSystem({ ...inputs, latticeVelocity: 0 }).ok).toBe(false);
    expect(
      lbmUnitSystem({
        ...inputs,
        latticeVelocity: LBM_MAX_LATTICE_VELOCITY + 1e-6,
      }).ok,
    ).toBe(false);
    const atCeiling = lbmUnitSystem({
      ...inputs,
      latticeVelocity: LBM_MAX_LATTICE_VELOCITY,
    });
    expect(atCeiling.ok).toBe(true);
  });

  it("refuses viscosities that push τ⁺ out of the stability band, naming the knob", () => {
    const tooThin = lbmUnitSystem({
      ...inputs,
      kinematicViscosityM2PerS: 1e-9,
    });
    expect(tooThin.ok).toBe(false);
    if (!tooThin.ok)
      expect(tooThin.error.message).toContain("lattice velocity");
    const tooThick = lbmUnitSystem({
      ...inputs,
      characteristicVelocityMPerS: 1e-4,
    });
    expect(tooThick.ok).toBe(false);
    if (!tooThick.ok) expect(tooThick.error.message).toContain("τ⁺");
  });
});
