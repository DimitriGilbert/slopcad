/**
 * 0D reactor pins (Phase 68b): the energy audit identity at the float
 * floor in both the adiabatic and wall-loss variants (conservative by
 * construction — the kinetic-energy-state discipline), the adiabatic
 * end state against the Phase 68a adiabatic-flame equilibrium (the
 * frozen complete-combustion reactor must land near the HP
 * equilibrium on lean mixtures, dissociation the stated deviation),
 * the transported-composition behavior (heat release exactly the
 * fuel energy present — the researched failure mode's fix), ignition
 * behavior shared with the induction definition, spray declines, and
 * bitwise determinism.
 */

import { describe, expect, it } from "vitest";

import {
  adiabaticFlame,
  ignitionDelaySeconds,
  runConstantVolumeReactor,
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

describe("the 0D constant-volume reactor", () => {
  it("conserves energy by construction, adiabatic and with wall loss", () => {
    // The audit identity U₀ = U_end + Q_removed holds by construction:
    // the march's state IS U, so the residual is float summation only.
    const adiabatic = must(
      runConstantVolumeReactor({
        combustionMode: "premixed",
        fuel: "CH4",
        equivalenceRatio: 1,
        initialTK: 1200,
        pressureBar: 1,
        durationS: 0.02,
        steps: 4000,
      }),
      "adiabatic run",
    );
    expect(adiabatic.audit.residualJ).toBeCloseTo(0, 30);
    expect(adiabatic.audit.wallHeatRemovedJ).toBe(0);
    expect(adiabatic.finalProgress).toBeGreaterThan(0.999);

    const cooled = must(
      runConstantVolumeReactor({
        combustionMode: "premixed",
        fuel: "CH4",
        equivalenceRatio: 1,
        initialTK: 1200,
        pressureBar: 1,
        durationS: 0.02,
        steps: 4000,
        wall: {
          temperatureK: 500,
          areaM2: 0.01,
          heatTransferCoefficientWPerM2K: 50,
        },
      }),
      "wall-loss run",
    );
    expect(Math.abs(cooled.audit.residualJ)).toBeLessThan(1e-6);
    expect(cooled.audit.wallHeatRemovedJ).toBeGreaterThan(0);
    expect(cooled.peakTemperatureK).toBeLessThan(adiabatic.peakTemperatureK);
  });

  it("lands near the 68a adiabatic-flame equilibrium on a lean charge", () => {
    // The reactor's frozen complete-combustion end state is CONSTANT
    // VOLUME and dissociation-free, so on a lean charge it must sit
    // ABOVE the HP (constant-pressure, equilibrium) flame temperature
    // — the CV/CP work difference plus the frozen/equilibrium
    // dissociation difference, together a 10–40% excess stated here
    // rather than hidden.
    const phi = 0.8;
    const equilibrium = must(
      adiabaticFlame({
        fuel: "CH4",
        equivalenceRatio: phi,
        inletTK: 1200,
        pressureBar: 1,
      }),
      "equilibrium flame",
    );
    const reactor = must(
      runConstantVolumeReactor({
        combustionMode: "premixed",
        fuel: "CH4",
        equivalenceRatio: phi,
        initialTK: 1200,
        pressureBar: 1,
        durationS: 0.1,
        steps: 8000,
      }),
      "reactor run",
    );
    expect(reactor.finalProgress).toBeGreaterThan(0.999);
    const tEq = equilibrium.solution.temperatureK;
    expect(reactor.peakTemperatureK).toBeGreaterThan(tEq * 1.1);
    expect(reactor.peakTemperatureK).toBeLessThan(tEq * 1.4);
  });

  it("releases exactly the fuel energy present (composition is state)", () => {
    // The researched failure mode: a P/T/V-only chamber "ran with the
    // throttle closed". Here the heat release rides the TRANSPORTED
    // composition — peak temperature tracks the fuel actually in the
    // vessel (monotone in φ up to stoichiometric, then falling as the
    // excess fuel absorbs heat it cannot burn for lack of oxygen).
    const peakAt = (phi: number): number =>
      must(
        runConstantVolumeReactor({
          combustionMode: "premixed",
          fuel: "CH4",
          equivalenceRatio: phi,
          initialTK: 1200,
          pressureBar: 1,
          durationS: 0.02,
          steps: 3000,
        }),
        `phi ${String(phi)}`,
      ).peakTemperatureK;
    const riseAt = (phi: number): number => peakAt(phi) - 1200;
    const rich = peakAt(1.3);
    const stoich = peakAt(1);
    const lean = peakAt(0.7);
    const veryLean = peakAt(0.4);
    expect(stoich).toBeGreaterThan(rich);
    expect(stoich).toBeGreaterThan(lean);
    expect(lean).toBeGreaterThan(veryLean);
    // The lean extremes release proportionally little: the temperature
    // RISE over the initial state shrinks monotonically with the fuel
    // actually present.
    const riseVeryLean = riseAt(0.4);
    const riseLean = riseAt(0.7);
    expect(riseLean).toBeGreaterThan(riseVeryLean);
    expect(riseVeryLean).toBeGreaterThan(0);
  });

  it("ignites at the shared induction definition's delay", () => {
    const input = {
      fuel: "CH4",
      equivalenceRatio: 1,
      initialTK: 1200,
      pressureBar: 1,
    };
    const march = must(
      ignitionDelaySeconds({
        fuel: input.fuel,
        equivalenceRatio: 1,
        temperatureK: 1200,
        pressureBar: 1,
      }),
      "induction",
    );
    const reactor = must(
      runConstantVolumeReactor({
        combustionMode: "premixed",
        ...input,
        equivalenceRatio: 1,
        durationS: 0.02,
        steps: 4000,
      }),
      "reactor",
    );
    expect(reactor.ignitionDelayS).toBeDefined();
    const reactorDelay = reactor.ignitionDelayS ?? 0;
    // Both integrate the same rate law to the same 5% threshold; the
    // reactor is ADIABATIC, so self-heating accelerates the Arrhenius
    // factor and it crosses SOONER than the isothermal induction
    // march — the ratio below 1 (and above a third) pins the shared
    // definition without pretending they are identical problems.
    expect(reactorDelay / march.ignitionDelayS).toBeGreaterThan(0.3);
    expect(reactorDelay / march.ignitionDelayS).toBeLessThan(1.05);
  });

  it("declines spray loud, and malformed inputs structurally", () => {
    const spray = runConstantVolumeReactor({
      combustionMode: "spray",
      fuel: "C8H18-N",
      equivalenceRatio: 1,
      initialTK: 1000,
      pressureBar: 10,
      durationS: 0.01,
    });
    expect(spray.ok).toBe(false);
    if (!spray.ok) {
      expect(spray.error.code).toBe("sim/combustion-mode-unsupported");
      expect(spray.error.message).toContain("declined at every level");
    }
    expect(
      runConstantVolumeReactor({
        combustionMode: "premixed",
        fuel: "H2",
        equivalenceRatio: 1,
        initialTK: 1000,
        pressureBar: 10,
        durationS: 0.01,
      }).ok,
    ).toBe(false);
    expect(
      runConstantVolumeReactor({
        combustionMode: "premixed",
        fuel: "CH4",
        equivalenceRatio: 1,
        initialTK: 1000,
        pressureBar: 10,
        durationS: -1,
      }).ok,
    ).toBe(false);
    expect(
      runConstantVolumeReactor({
        combustionMode: "premixed",
        fuel: "CH4",
        equivalenceRatio: 1,
        initialTK: 1000,
        pressureBar: 10,
        durationS: 0.01,
        steps: 2,
      }).ok,
    ).toBe(false);
  });

  // MEASURED timeout, the 68b suite's discipline: the ladder runs
  // ≈ 8 s serial but 38–42 s under the full-gate turbo fan-out
  // (`pnpm run verify`'s parallel package tests contending for cores —
  // contention, not the algorithm), past the 20 s default. 120 s (the
  // docs-examples Phase 69 precedent) carries ~3x over the worst
  // measured loaded run, not a guess.
  it(
    "converges the wall-heat integral at the stove adapter's march resolution",
    { timeout: 120_000 },
    () => {
      // The ladder fixture behind the 68c stove adapter's resolution
      // claim (sim-engine.ts): the reactor runs the demo fire's own
      // wall-loss shape (CH4, φ 1, a 1400 K lit charge at 1 bar over
      // 30 s, h = 30 W/(m²·K) over the bar fixture's ~0.06 m²/m wetted
      // interface at the authored 293.15 K wall) on a step ladder. The
      // MEASURED band: every rung from 1000 steps upward lands within
      // 0.02% of the 4000-step integral, and the 4000-step default sits
      // within half a hundred-thousandth of the 8000/16000 refinements —
      // the number the adapter's comment states, pinned here instead of
      // asserted from nowhere.
      const wallHeatAt = (steps: number): number =>
        must(
          runConstantVolumeReactor({
            combustionMode: "premixed",
            fuel: "CH4",
            equivalenceRatio: 1,
            initialTK: 1400,
            pressureBar: 1,
            durationS: 30,
            steps,
            wall: {
              temperatureK: 293.15,
              areaM2: 0.06,
              heatTransferCoefficientWPerM2K: 30,
            },
          }),
          `ladder rung ${String(steps)}`,
        ).audit.wallHeatRemovedJ;
      const ladder = [1000, 2000, 4000, 8000, 16000].map(wallHeatAt);
      const reference = ladder[2] ?? 0;
      // The scale anchor: the demo fire's own integral class, J.
      for (const value of ladder) {
        expect(value).toBeGreaterThan(1.65e5);
        expect(value).toBeLessThan(1.75e5);
        expect(Math.abs(value - reference) / reference).toBeLessThan(2e-4);
      }
      // The ladder climbs monotonically onto its plateau at this scale.
      for (let index = 1; index < ladder.length; index += 1) {
        expect(ladder[index]).toBeGreaterThanOrEqual(ladder[index - 1] ?? 0);
      }
      // The convergence claim itself: the 4000-step default is within
      // 0.005% of both refinements (measured 0.0036% and 0.0045%).
      for (const value of [ladder[3], ladder[4]]) {
        expect(Math.abs((value ?? 0) - reference) / reference).toBeLessThan(
          5e-5,
        );
      }
    },
  );

  it("is bitwise deterministic on repeat runs (law S2)", () => {
    const input = {
      combustionMode: "premixed" as const,
      fuel: "C8H18-ISO",
      equivalenceRatio: 0.95,
      initialTK: 1150,
      pressureBar: 12,
      durationS: 0.01,
      steps: 2000,
      samplesOut: 10,
    };
    const first = must(runConstantVolumeReactor(input), "first");
    const second = must(runConstantVolumeReactor(input), "second");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
