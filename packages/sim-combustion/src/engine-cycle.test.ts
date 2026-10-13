/**
 * 0D engine-cycle pins (Phase 68b): the textbook Otto P–θ signature
 * (peak location, motored companion, EVO state), the derived burn
 * duration against the published SI band and the Wiebe form's exact
 * values, IMEP arithmetic against both the history trace and the ideal
 * Otto efficiency band (with the honest deviations stated), the
 * brake-vs-indicated family pinned on the hand-solvable Chen–Flynn
 * case (friction work over the cycle = FMEP·V_d), the closing energy
 * audit (fuel = brake + exhaust enthalpy + wall loss, friction
 * dissipation included), the Livengood–Wu knock integral's comparative
 * behavior, the transported-composition throttle fixture (the
 * researched failure mode), the adiabatic-one-entry-away rule, spray
 * declines at the door, and bitwise determinism.
 */

import { describe, expect, it } from "vitest";

import {
  CHEN_FLYNN_DEFAULT,
  chamberVolumeM3,
  chenFlynnFmepBar,
  displacementM3,
  frozenCpJPerKgK,
  frozenCvJPerKgK,
  frozenMixture,
  premixedFuelAirInlet,
  runOttoCycle,
  wiebeBurnedFraction,
  type OttoCycleResult,
  WOSCHNI_C1_CLOSED,
  woschniHeatTransferCoefficientWPerM2K,
  type OttoCycleScenario,
} from "./index";

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

// A production-shaped single-cylinder SI engine: 86 × 86 mm, rod
// 143 mm, CR 10, 1500 rpm, stoichiometric iso-octane, Woschni walls at
// 450 K (coolant-side), spark 25° BTDC.
const BASE: OttoCycleScenario = {
  combustionMode: "premixed",
  fuel: "C8H18-ISO",
  geometry: {
    boreM: 0.086,
    crankRadiusM: 0.043,
    rodLengthM: 0.143,
    compressionRatio: 10,
  },
  speedRpm: 1500,
  charge: {
    intakePressureBar: 1.01325,
    intakeTK: 298.15,
    equivalenceRatio: 1,
  },
  spark: { timingBTDCDeg: 25 },
  wallHeat: { mode: "woschni", wallTemperatureK: 450 },
};

function columnOf(run: OttoCycleResult, name: string): readonly number[] {
  const column = run.history.columns.find((c) => c.name === name);
  if (column === undefined) throw new Error(`missing history column ${name}`);
  return column.samples;
}

describe("the P–θ signature (textbook Otto)", () => {
  const run = must(runOttoCycle(BASE), "the base cycle");

  it("peaks shortly after TDC with textbook-level states", () => {
    // The classic SI signature: peak pressure between roughly 10 and
    // 20° ATDC at sensible spark timing (Heywood, Ch. 9–10), peak
    // burned-gas temperature in the 2200–2900 K band, EVO pressure a
    // few bar.
    expect(run.peak.pressureAngleDeg).toBeGreaterThan(5);
    expect(run.peak.pressureAngleDeg).toBeLessThan(25);
    expect(run.peak.pressureBar).toBeGreaterThan(30);
    expect(run.peak.pressureBar).toBeLessThan(100);
    expect(run.peak.burnedTemperatureK).toBeGreaterThan(2200);
    expect(run.peak.burnedTemperatureK).toBeLessThan(2900);
    const pressure = columnOf(run, "pressure");
    const last = pressure[pressure.length - 1] ?? 0;
    expect(last).toBeGreaterThan(1.5);
    expect(last).toBeLessThan(8);
  });

  it("rises monotonically to the peak and falls after it", () => {
    const pressure = columnOf(run, "pressure");
    const peakIndex = pressure.indexOf(run.peak.pressureBar);
    expect(peakIndex).toBeGreaterThan(0);
    for (let i = 1; i <= peakIndex; i += 1) {
      expect(pressure[i] ?? 0).toBeGreaterThanOrEqual(pressure[i - 1] ?? 0);
    }
    let falling = true;
    for (let i = peakIndex + 1; i < pressure.length; i += 1) {
      if ((pressure[i] ?? 0) > run.peak.pressureBar) falling = false;
    }
    expect(falling).toBe(true);
  });

  it("rides above its motored companion after the spark", () => {
    const pressure = columnOf(run, "pressure");
    const motored = columnOf(run, "pressure-motored");
    expect(motored.length).toBe(pressure.length);
    // Before the spark the two traces agree (no heat released yet).
    const sparkIndex = pressure.findIndex((_, i) => {
      const theta = (columnOf(run, "crank-angle")[i] ?? 0) + 180;
      return theta >= 180 - BASE.spark.timingBTDCDeg;
    });
    expect(sparkIndex).toBeGreaterThan(0);
    expect(
      Math.abs((pressure[sparkIndex] ?? 0) - (motored[sparkIndex] ?? 0)),
    ).toBeLessThan(0.05 * (pressure[sparkIndex] ?? 1));
    // At TDC the fired trace is well above the motored one.
    const tdcIndex = Math.floor(pressure.length / 2);
    expect(pressure[tdcIndex] ?? 0).toBeGreaterThan(
      1.5 * (motored[tdcIndex] ?? 1),
    );
    // The motored trace is a near-symmetric pumping-free loop: its
    // IMEP is an order below the fired one.
    expect(Math.abs(run.motored.imepPa)).toBeLessThan(
      0.05 * run.indicated.imepPa,
    );
    // Motored peak pressure sits in the isentropic band
    // p1·r^γ with γ ≈ 1.3–1.35 for compressed air.
    expect(run.motored.peakPressureBar).toBeGreaterThan(15);
    expect(run.motored.peakPressureBar).toBeLessThan(30);
  });
});

describe("the burn-duration grounding (flame speed, never fitted)", () => {
  const run = must(runOttoCycle(BASE), "the base cycle");

  it("derives a burn duration in the published SI band", () => {
    // The published SI burn-duration band is roughly 50–60° crank at
    // mid speeds for traditional chamber designs (Heywood's combustion
    // analysis); the DERIVED duration (chamber scale over enhanced
    // flame speed at the spark state) must land in that family with
    // the default enhancement factor.
    const durationDeg = (run.burn.burnDurationRad * 180) / Math.PI;
    expect(durationDeg).toBeGreaterThan(30);
    expect(durationDeg).toBeLessThan(90);
    expect(run.burn.flameSpeedMPerS).toBeGreaterThan(0.1);
    expect(run.burn.flameSpeedMPerS).toBeLessThan(2);
    // Grounded at the motored spark state (no heat released yet).
    expect(run.burn.groundedAt.tK).toBeGreaterThan(400);
    expect(run.burn.groundedAt.tK).toBeLessThan(800);
    expect(run.burn.groundedAt.pressureBar).toBeGreaterThan(5);
    // The M&K fit's temperature band holds at the spark state; the
    // pressure is engine-typical (outside the bomb band, flagged).
    expect(run.burn.withinFitBand.temperature).toBe(true);
    expect(run.burn.withinFitBand.pressure).toBe(false);
  });

  it("burns faster when the flame runs hotter or more enhanced", () => {
    const enhanced = must(
      runOttoCycle({
        ...BASE,
        spark: { timingBTDCDeg: 25, turbulenceSpeedMultiplier: 20 },
      }),
      "enhanced run",
    );
    expect(enhanced.burn.burnDurationRad).toBeCloseTo(
      run.burn.burnDurationRad / 2,
      6,
    );
    // The Wiebe values: 99.3% burned at the duration's end, nothing
    // before the spark, monotone through the burn.
    const xbEnd = wiebeBurnedFraction(
      run.burn,
      run.burn.sparkAngleRad + run.burn.burnDurationRad,
    );
    expect(xbEnd).toBeCloseTo(1 - Math.exp(-5), 12);
    expect(wiebeBurnedFraction(run.burn, run.burn.sparkAngleRad)).toBe(0);
    expect(wiebeBurnedFraction(run.burn, run.burn.sparkAngleRad - 1)).toBe(0);
    const fractions = columnOf(run, "burned-mass-fraction");
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i] ?? 0).toBeGreaterThanOrEqual(fractions[i - 1] ?? 0);
    }
    expect(fractions[fractions.length - 1] ?? 0).toBeGreaterThan(0.95);
  });
});

describe("IMEP and the ideal Otto band", () => {
  const run = must(runOttoCycle(BASE), "the base cycle");

  it("agrees with its own trace's ∮p·dV (the arithmetic projection)", () => {
    // Recompute the closed-portion work from the history columns by
    // the trapezoid rule — an independent quadrature of the same trace
    // (the march integrates at the p̄ midpoints), so agreement to a
    // fraction of a percent pins the projection arithmetic.
    const angles = columnOf(run, "crank-angle");
    const pressure = columnOf(run, "pressure");
    let work = 0;
    for (let i = 1; i < angles.length; i += 1) {
      const v0 = chamberVolumeM3(
        run.geometry,
        ((angles[i - 1] ?? 0) * Math.PI) / 180,
      );
      const v1 = chamberVolumeM3(
        run.geometry,
        ((angles[i] ?? 0) * Math.PI) / 180,
      );
      work +=
        0.5 * ((pressure[i - 1] ?? 0) + (pressure[i] ?? 0)) * 1e5 * (v1 - v0);
    }
    expect(work / run.indicated.workJ).toBeGreaterThan(0.98);
    expect(work / run.indicated.workJ).toBeLessThan(1.02);
    expect(run.indicated.imepPa).toBeCloseTo(
      run.indicated.workJ / displacementM3(run.geometry),
      6,
    );
  });

  it("sits inside the ideal Otto band with the honest deviations", () => {
    // Near-TDC burn (100× flame enhancement), adiabatic walls: the
    // measured indicated efficiency against 1 − r^(1−γ̄) with γ̄ the
    // charge's own mid-compression cp/cv from the NASA-7 data. The
    // honest deviations — finite (small) burn duration, γ(T) rising
    // through compression, dissociation in the burned equilibrium —
    // put the real cycle a few points BELOW the constant-γ ideal.
    const fastBurn = must(
      runOttoCycle({
        ...BASE,
        wallHeat: { mode: "adiabatic" },
        spark: { timingBTDCDeg: 20, turbulenceSpeedMultiplier: 100 },
      }),
      "fast-burn adiabatic run",
    );
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "inlet",
    );
    const mix = must(frozenMixture(inlet.species), "mix");
    const gammaMid = frozenCpJPerKgK(mix, 600) / frozenCvJPerKgK(mix, 600);
    const idealOtto = 1 - BASE.geometry.compressionRatio ** (1 - gammaMid);
    const ratio = fastBurn.indicated.thermalEfficiency / idealOtto;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.02);
    // And the standard Woschni cycle sits below the adiabatic one.
    expect(run.indicated.thermalEfficiency).toBeLessThan(
      fastBurn.indicated.thermalEfficiency,
    );
  });
});

describe("brake quantities (Chen–Flynn, hand-solvable)", () => {
  const run = must(runOttoCycle(BASE), "the base cycle");

  it("pins FMEP, BMEP, torque, power, and friction work by hand", () => {
    const vd = displacementM3(run.geometry);
    // Hand value from published physics, NOT the code's expression
    // (non-circular by rule): the mean piston speed is 2·stroke·N —
    // the pin sweeps the stroke twice per crank revolution (Heywood
    // Ch. 2) — so 2 × 0.086 m × (1500/60) s⁻¹ = 4.30 m/s here.
    const meanPistonSpeed = 4.3;
    // Hand: FMEP = a + b·p_max + c·v̄_p + d·v̄_p² with the default
    // published-range coefficients and the run's own peak pressure.
    const fmepBar = chenFlynnFmepBar(
      CHEN_FLYNN_DEFAULT,
      run.peak.pressureBar,
      meanPistonSpeed,
    );
    expect(run.brake.fmepPa).toBeCloseTo(fmepBar * 1e5, 6);
    // The physics LEVEL, pinned independently of the code's arithmetic:
    // mid-range coefficients with the base engine's 4.30 m/s mean
    // piston speed and ~73 bar peak land the FMEP near 1.3 bar — the
    // SIE band at this speed (≈0.5–2 bar; Heywood's friction survey),
    // not the 2.4 bar a stroke·ω "mean" would fabricate.
    expect(run.brake.fmepPa / 1e5).toBeGreaterThan(1);
    expect(run.brake.fmepPa / 1e5).toBeLessThan(1.6);
    // BMEP = IMEP − FMEP − PMEP (pumping included per the
    // correlation's standard use).
    expect(run.brake.bmepPa).toBeCloseTo(
      run.indicated.imepPa - fmepBar * 1e5 - run.brake.pmepPa,
      3,
    );
    // Friction work over the cycle = FMEP·V_d (the hand identity).
    expect(run.brake.frictionWorkJ).toBeCloseTo(
      (fmepBar * 1e5 + run.brake.pmepPa) * vd,
      0,
    );
    // Four-stroke torque and power per cycle: W/(4π), W·N/120.
    expect(run.brake.torqueNPerM).toBeCloseTo(
      (run.brake.bmepPa * vd) / (4 * Math.PI),
      0,
    );
    expect(run.brake.powerW).toBeCloseTo(
      run.brake.bmepPa * vd * (BASE.speedRpm / 120),
      0,
    );
    // Both families reported; brake below indicated.
    expect(run.brake.thermalEfficiency).toBeLessThan(
      run.indicated.thermalEfficiency,
    );
    expect(run.brake.bmepPa).toBeLessThan(run.indicated.imepPa);
  });

  it("responds to authored friction fields (the scenario-field rule)", () => {
    const lowFriction = must(
      runOttoCycle({
        ...BASE,
        friction: {
          aBar: 0.3,
          bBarPerBar: 0.005,
          cBarPerMPerS: 0.05,
          dBarPerM2S2: 0.001,
          pumpingMepBar: 0.1,
        },
      }),
      "low-friction run",
    );
    expect(lowFriction.brake.bmepPa).toBeGreaterThan(run.brake.bmepPa);
    expect(lowFriction.brake.fmepPa).toBeLessThan(run.brake.fmepPa);
  });
});

describe("the closing energy audit", () => {
  const run = must(runOttoCycle(BASE), "the base cycle");

  it("closes fuel = brake + exhaust enthalpy + wall/coolant + friction", () => {
    // The identity holds BY CONSTRUCTION (the march's state is the
    // zone energies); the residual is float summation only.
    expect(Math.abs(run.audit.residualJ)).toBeLessThan(1e-6);
    // The audit's fuel chemical energy (the charge's reactant-minus-
    // complete-product internal energies) against the derived LHV
    // times the fuel mass (the fuel-plus-stoichiometric-oxygen
    // reaction): two independent derivations of the same chemistry.
    // They agree to a fraction of a percent — the dry-air set's
    // carried CO₂ and argon put the charge a hair off the exact
    // stoichiometric reaction, a stated difference, not a leak.
    expect(
      Math.abs(
        run.audit.fuelChemicalJ -
          run.indicated.fuelMassKg * run.indicated.lhvJPerKg,
      ) / run.audit.fuelChemicalJ,
    ).toBeLessThan(5e-3);
    // The loss family: wall heat positive, exhaust enthalpy the
    // largest loss.
    expect(run.audit.wallHeatJ).toBeGreaterThan(0);
    expect(run.audit.exhaustEnthalpyJ).toBeGreaterThan(0);
    const fuel = run.audit.fuelChemicalJ + run.audit.intakeSensibleJ;
    const workShare = run.indicated.workJ / fuel;
    const wallShare = run.audit.wallHeatJ / fuel;
    const exhaustShare = run.audit.exhaustEnthalpyJ / fuel;
    // Measured split at the base case, re-pinned after the mean-piston-
    // speed fix (Woschni's C₁·c̄_m term carries the true 2·stroke·N, so
    // wall heat runs near half the classic third): work ≈ 0.39 (the
    // indicated share, friction's ≈ 0.04 inside it), wall ≈ 0.20,
    // exhaust ≈ 0.41 — work-and-exhaust-led, the honest signature of a
    // mid-speed Woschni cycle against Heywood's "roughly thirds"
    // energy-balance discussion (bands carry the measured ± points).
    expect(workShare).toBeGreaterThan(0.3);
    expect(workShare).toBeLessThan(0.48);
    expect(wallShare).toBeGreaterThan(0.13);
    expect(wallShare).toBeLessThan(0.26);
    expect(exhaustShare).toBeGreaterThan(0.3);
    expect(exhaustShare).toBeLessThan(0.5);
  });

  it("is exactly adiabatic one entry away (the roadmap's rule)", () => {
    const adiabatic = must(
      runOttoCycle({ ...BASE, wallHeat: { mode: "adiabatic" } }),
      "adiabatic run",
    );
    expect(adiabatic.audit.wallHeatJ).toBe(0);
    expect(Math.abs(adiabatic.audit.residualJ)).toBeLessThan(1e-6);
    // Removing the wall loss raises the work AND leaves more energy
    // in the gas at EVO — the freed wall loss splits between the two.
    expect(adiabatic.indicated.workJ).toBeGreaterThan(run.indicated.workJ);
    expect(adiabatic.audit.exhaustEnthalpyJ).toBeGreaterThan(
      run.audit.exhaustEnthalpyJ,
    );
    const wallRate = columnOf(adiabatic, "wall-heat-rate");
    for (const rate of wallRate) expect(rate).toBe(0);
  });
});

describe("knock (Livengood–Wu over the unburned zone)", () => {
  it("grows with spark advance and compression ratio (the boundary)", () => {
    const advanced = must(
      runOttoCycle({ ...BASE, spark: { timingBTDCDeg: 40 } }),
      "advanced run",
    );
    const baseline = must(runOttoCycle(BASE), "baseline");
    const retarded = must(
      runOttoCycle({ ...BASE, spark: { timingBTDCDeg: 12 } }),
      "retarded run",
    );
    expect(advanced.knock.integralMax).toBeGreaterThan(
      baseline.knock.integralMax,
    );
    expect(baseline.knock.integralMax).toBeGreaterThan(
      retarded.knock.integralMax,
    );
    const highCompression = must(
      runOttoCycle({
        ...BASE,
        geometry: { ...BASE.geometry, compressionRatio: 13 },
      }),
      "CR 13 run",
    );
    expect(highCompression.knock.integralMax).toBeGreaterThan(
      baseline.knock.integralMax,
    );
    // The integral is a positive finite number, and the history
    // column is monotone (the integral only accumulates).
    expect(baseline.knock.integralMax).toBeGreaterThan(0);
    expect(Number.isFinite(baseline.knock.integralMax)).toBe(true);
    const integral = columnOf(baseline, "knock-integral");
    for (let i = 1; i < integral.length; i += 1) {
      expect(integral[i] ?? 0).toBeGreaterThanOrEqual(integral[i - 1] ?? 0);
    }
  });
});

describe("composition as transported state (the throttle fixture)", () => {
  it("scales the trapped fuel exactly with intake pressure", () => {
    const throttled = must(
      runOttoCycle({
        ...BASE,
        charge: { ...BASE.charge, intakePressureBar: 0.5 },
      }),
      "throttled run",
    );
    const run = must(runOttoCycle(BASE), "baseline");
    // At fixed φ, the trapped fuel mass is the ideal-gas charge mass —
    // composition transported, the researched failure mode's fix: a
    // half-throttled charge carries exactly half the fuel energy.
    const ratio = throttled.indicated.fuelMassKg / run.indicated.fuelMassKg;
    expect(ratio).toBeCloseTo(0.5 / 1.01325, 6);
    // And the gas-path work falls with it (the brake side falls
    // further — part-load friction honesty, the physics the friction
    // ruling named).
    expect(throttled.indicated.imepPa).toBeLessThan(
      0.65 * run.indicated.imepPa,
    );
    expect(throttled.brake.thermalEfficiency).toBeLessThan(
      run.brake.thermalEfficiency,
    );
  });

  it("declines mixture states outside the flame fit's span loudly", () => {
    // Far off-stoichiometric φ leaves the M&K parabola's fitted
    // branch — the burn-duration grounding declines rather than
    // extrapolating a flame speed (an honest misfire-shaped refusal:
    // the closed-throttle/ultra-lean failure mode can never fabricate
    // combustion).
    for (const phi of [0.45, 2.2]) {
      const declined = runOttoCycle({
        ...BASE,
        charge: { ...BASE.charge, equivalenceRatio: phi },
      });
      expect(declined.ok, `phi ${String(phi)}`).toBe(false);
    }
  });
});

describe("the Woschni correlation's plumbing", () => {
  it("reproduces the published expression by hand", () => {
    // h = 3.26·B^−0.2·p_kPa^0.8·T^−0.55·w^0.8, recomputed here. The gas
    // velocity's C₁·c̄_m part uses the base engine's true mean piston
    // speed 2·stroke·N = 4.30 m/s (hand value, as in the Chen–Flynn
    // pin above).
    const bore = 0.086;
    const pBar = 12;
    const tK = 900;
    const w = WOSCHNI_C1_CLOSED * 4.3;
    const hand =
      3.26 *
      Math.pow(bore, -0.2) *
      Math.pow(pBar * 100, 0.8) *
      Math.pow(tK, -0.55) *
      Math.pow(w, 0.8);
    expect(
      woschniHeatTransferCoefficientWPerM2K({
        boreM: bore,
        pressureBar: pBar,
        gasTK: tK,
        gasVelocityMPerS: w,
      }),
    ).toBeCloseTo(hand, 9);
  });
});

describe("declines and determinism", () => {
  it("declines spray loud at the cycle door", () => {
    const spray = runOttoCycle({
      ...BASE,
      combustionMode: "spray",
    });
    expect(spray.ok).toBe(false);
    if (!spray.ok) {
      expect(spray.error.code).toBe("sim/combustion-mode-unsupported");
      expect(spray.error.message).toContain("fitted burn curve");
    }
  });

  it("declines malformed scenarios structurally", () => {
    expect(runOttoCycle({ ...BASE, speedRpm: 0 }).ok).toBe(false);
    expect(runOttoCycle({ ...BASE, spark: { timingBTDCDeg: 200 } }).ok).toBe(
      false,
    );
    expect(
      runOttoCycle({
        ...BASE,
        geometry: { ...BASE.geometry, compressionRatio: 0.5 },
      }).ok,
    ).toBe(false);
    expect(runOttoCycle({ ...BASE, fuel: "CH4" }).ok).toBe(false);
  });

  it("is bitwise deterministic on repeat runs (law S2)", () => {
    const first = must(runOttoCycle(BASE), "first");
    const second = must(runOttoCycle(BASE), "second");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Coarser resolution changes the answer (a real integration, not a
    // lookup) but converges toward it.
    const coarse = must(
      runOttoCycle({ ...BASE, integration: { crankStepDeg: 1 } }),
      "coarse run",
    );
    expect(coarse.indicated.imepPa).not.toBe(first.indicated.imepPa);
    expect(
      Math.abs(coarse.indicated.imepPa - first.indicated.imepPa),
    ).toBeLessThan(0.03 * first.indicated.imepPa);
  });
});
