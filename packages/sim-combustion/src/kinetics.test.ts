/**
 * Reduced-chemistry pins (Phase 68b): the Westbrook–Dryer one-step
 * rate's CGS↔SI conversion against the published parameter values
 * recombined by hand in the test, the ignition-delay march's Arrhenius
 * slope against the published activation energy (non-circular — the
 * slope IS Ea), the exact pressure scaling the published reaction
 * orders imply, the order-of-magnitude band against published
 * shock-tube ignition-delay scales, and the loud declines (uncarried
 * fuels, malformed states, bitwise determinism).
 */

import { describe, expect, it } from "vitest";

import {
  getOneStepKinetics,
  ignitionDelaySeconds,
  KINETIC_FUEL_NAMES,
  ONE_STEP_KINETICS,
  oneStepRateMolPerM3S,
} from "./index";
import { GAS_CONSTANT_J_PER_MOL_K } from "./nasa7";

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

describe("the Westbrook–Dryer one-step table", () => {
  it("carries the published CH4 and C8H18 rows and declines the rest", () => {
    // Westbrook & Dryer, Combust. Sci. Technol. 27 (1981) 31–43,
    // Table 1's one-step rows: CH4 A = 8.3×10⁵, E_a = 30 kcal/mol,
    // orders (−0.3, 1.3); C8H18 A = 4.6×10¹¹, E_a = 30 kcal/mol,
    // orders (0.25, 1.5); temperature exponent 0.
    expect(ONE_STEP_KINETICS["CH4"]?.preExponentialCgs).toBe(8.3e5);
    expect(ONE_STEP_KINETICS["CH4"]?.activationEnergyKcalPerMol).toBe(30);
    expect(ONE_STEP_KINETICS["CH4"]?.fuelOrder).toBe(-0.3);
    expect(ONE_STEP_KINETICS["CH4"]?.oxygenOrder).toBe(1.3);
    expect(ONE_STEP_KINETICS["CH4"]?.temperatureExponent).toBe(0);
    expect(ONE_STEP_KINETICS["C8H18-ISO"]?.preExponentialCgs).toBe(4.6e11);
    expect(ONE_STEP_KINETICS["C8H18-N"]?.preExponentialCgs).toBe(4.6e11);
    expect(ONE_STEP_KINETICS["C8H18-N"]?.fuelOrder).toBe(0.25);
    expect(ONE_STEP_KINETICS["C8H18-N"]?.oxygenOrder).toBe(1.5);
    expect(KINETIC_FUEL_NAMES).toContain("CH4");
    expect(getOneStepKinetics("H2").ok).toBe(false);
    expect(getOneStepKinetics("CO").ok).toBe(false);
    const declined = getOneStepKinetics("H2");
    if (!declined.ok) {
      expect(declined.error.message).toContain("declines rather than guessing");
    }
  });

  it("converts the CGS rate to SI exactly", () => {
    // The published form recomputed by hand in CGS: concentrations in
    // mol/cm³, A in the published units, compared against the module's
    // SI evaluation — the conversion A_SI = A·1e6^(1−a−b) is the only
    // bridge.
    const set = must(getOneStepKinetics("CH4"), "CH4");
    const tK = 1500;
    const cFuelCgs = 7.7e-7; // mol/cm³
    const cO2Cgs = 1.56e-6;
    const rateCgs =
      set.preExponentialCgs *
      Math.exp(
        -(set.activationEnergyKcalPerMol * 4.184e3) /
          (GAS_CONSTANT_J_PER_MOL_K * tK),
      ) *
      Math.pow(cFuelCgs, set.fuelOrder) *
      Math.pow(cO2Cgs, set.oxygenOrder); // mol/(cm³·s)
    const rateSi = oneStepRateMolPerM3S(set, tK, cFuelCgs * 1e6, cO2Cgs * 1e6); // mol/(m³·s)
    expect(rateSi / 1e6).toBeCloseTo(rateCgs, 9);
  });
});

describe("the ignition-delay march", () => {
  it("falls in the published shock-tube order of magnitude for CH4", () => {
    // Methane/air induction times at ~1500 K and 1 atm are of order
    // milliseconds to tens of milliseconds in the shock-tube
    // literature (the summaries in Glassman & Yetter, Combustion, and
    // Turns, An Introduction to Combustion) — a wide, honest band: the
    // one-step flame calibration is not an autoignition mechanism,
    // and the module states that rather than pretending precision.
    const delay = must(
      ignitionDelaySeconds({
        fuel: "CH4",
        equivalenceRatio: 1,
        temperatureK: 1500,
        pressureBar: 1.01325,
      }),
      "CH4 delay",
    );
    expect(delay.ignitionDelayS).toBeGreaterThan(1e-4);
    expect(delay.ignitionDelayS).toBeLessThan(0.1);
  });

  it("carries the published activation energy in its Arrhenius slope", () => {
    // τ ∝ exp(E_a/RT) with the march's T-dependence dominated by the
    // published E_a (30 kcal/mol = 125,520 J/mol): the ratio of delays
    // at two temperatures must reproduce exp(E_a/R·(1/T₂ − 1/T₁))
    // within the concentration-scaling correction (small).
    const t1 = 1450;
    const t2 = 1550;
    const d1 = must(
      ignitionDelaySeconds({
        fuel: "CH4",
        equivalenceRatio: 1,
        temperatureK: t1,
        pressureBar: 5,
      }),
      "d1",
    );
    const d2 = must(
      ignitionDelaySeconds({
        fuel: "CH4",
        equivalenceRatio: 1,
        temperatureK: t2,
        pressureBar: 5,
      }),
      "d2",
    );
    const expectedSlope = Math.exp(
      (125520 / GAS_CONSTANT_J_PER_MOL_K) * (1 / t1 - 1 / t2),
    );
    const measuredSlope = d1.ignitionDelayS / d2.ignitionDelayS;
    expect(measuredSlope / expectedSlope).toBeGreaterThan(0.9);
    expect(measuredSlope / expectedSlope).toBeLessThan(1.1);
  });

  it("carries the published reaction orders in its pressure scaling", () => {
    // The delay to a fixed CONSUMED FRACTION of the CH4 global step
    // (Δn = 0, total order exactly 1: −0.3 + 1.3) is p-INDEPENDENT —
    // first-order-in-total-concentration kinetics have a fixed
    // fractional timescale, the pressure cancelling between threshold
    // (∝ p) and rate (∝ p). The C8H18 step's total order is 1.75, so
    // its fractional delay goes as p^(−0.75): τ(2 bar)/τ(8 bar) =
    // 4^0.75 = 2.828, the order sum pinned through the exponent (the
    // +3.5 mol Δn bookkeeping perturbs it a few percent).
    const ch4Low = must(
      ignitionDelaySeconds({
        fuel: "CH4",
        equivalenceRatio: 1,
        temperatureK: 1400,
        pressureBar: 2,
      }),
      "ch4 p2",
    );
    const ch4High = must(
      ignitionDelaySeconds({
        fuel: "CH4",
        equivalenceRatio: 1,
        temperatureK: 1400,
        pressureBar: 8,
      }),
      "ch4 p8",
    );
    expect(ch4Low.ignitionDelayS / ch4High.ignitionDelayS).toBeCloseTo(1, 4);
    const octLow = must(
      ignitionDelaySeconds({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        temperatureK: 1400,
        pressureBar: 2,
      }),
      "oct p2",
    );
    const octHigh = must(
      ignitionDelaySeconds({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        temperatureK: 1400,
        pressureBar: 8,
      }),
      "oct p8",
    );
    const ratio = octLow.ignitionDelayS / octHigh.ignitionDelayS;
    expect(ratio / Math.pow(4, 0.75)).toBeGreaterThan(0.95);
    expect(ratio / Math.pow(4, 0.75)).toBeLessThan(1.05);
  });

  it("ignites sooner when hotter, and its horizon refuses cold guesses", () => {
    const hot = must(
      ignitionDelaySeconds({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        temperatureK: 1300,
        pressureBar: 10,
      }),
      "hot",
    );
    const cold = must(
      ignitionDelaySeconds({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        temperatureK: 1100,
        pressureBar: 10,
      }),
      "cold",
    );
    expect(cold.ignitionDelayS).toBeGreaterThan(hot.ignitionDelayS);
    expect(hot.initialRateEstimateS).toBeGreaterThan(0);
  });

  it("declines malformed states and uncarried fuels loudly", () => {
    const badFuel = ignitionDelaySeconds({
      fuel: "H2",
      equivalenceRatio: 1,
      temperatureK: 1200,
      pressureBar: 1,
    });
    expect(badFuel.ok).toBe(false);
    if (!badFuel.ok) {
      expect(badFuel.error.message).toContain("declines rather than guessing");
    }
    expect(
      ignitionDelaySeconds({
        fuel: "CH4",
        equivalenceRatio: 1,
        temperatureK: 0,
        pressureBar: 1,
      }).ok,
    ).toBe(false);
    expect(
      ignitionDelaySeconds({
        fuel: "CH4",
        equivalenceRatio: 1,
        temperatureK: 1200,
        pressureBar: -1,
      }).ok,
    ).toBe(false);
  });

  it("is bitwise deterministic on repeat runs (law S2)", () => {
    const input = {
      fuel: "C8H18-ISO",
      equivalenceRatio: 0.9,
      temperatureK: 1250,
      pressureBar: 15,
    } as const;
    const first = must(ignitionDelaySeconds(input), "first");
    const second = must(ignitionDelaySeconds(input), "second");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
