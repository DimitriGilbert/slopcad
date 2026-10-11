/**
 * The Phase 65b in-phase decision fixtures: PASSIVE SCALAR vs DOUBLE
 * DISTRIBUTION for the fluid thermal field, decided on measured
 * evidence (ROADMAP-SIM Phase 65: "double-distribution vs passive
 * scalar decided in-phase with fixtures"). The decision: the
 * passive-scalar finite-volume march (`./thermal-scalar`) wins, and
 * these fixtures are the numbers the decision rests on.
 *
 * ## The rejected option, implemented honestly
 *
 * `marchDoubleDistribution` below is the double-distribution form in
 * miniature: a D1Q3 temperature lattice (w = 1/6, 2/3, 1/6; c_s² =
 * 1/3; diffusivity D = (τ − 1/2)/3) over a 1D fluid–solid chain, the
 * two regions carrying their own relaxation times (their own
 * diffusivities — the conjugate materials), coupled at the interface
 * by CONJUGATE ANTI-BOUNCE-BACK — the double-distribution interface
 * form the thermal-LBM CHT literature built on (reflected populations
 * against an interface temperature, each side updated
 * independently). Both the naive node-temperature weighting and the
 * CORRECTED form (the flux-continuity weighting of extrapolated
 * half-cell temperatures — the strongest common variant) are run.
 * Two structural defects are measured:
 *
 * 1. **The interface exchange is not conservative.** A CLOSED chain
 *    (insulated ends — the end treatment's own measured residue is
 *    ~5e-9 K·node, ten orders below the interface's drift, so the ends
 *    contribute nothing) has nothing entering or leaving, yet the
 *    inventory drifts: measured −225 and −530 K·node (≈ 3 % and 7 % of
 *    the 7200 K·node inventory destroyed over the relaxation) for the
 *    naive and corrected forms respectively — the reflected-population
 *    replacement has no pairwise-cancellation identity. The passive
 *    scalar's closed box conserves to float rounding (pinned in
 *    thermal-scalar.test.ts).
 *
 * 2. **The interface placement is wrong at contrast — structurally.**
 *    The corrected form's steady interface temperature sits 4.45 K
 *    (22 % of the 20 K wall-to-wall ΔT) off the analytic
 *    series-resistance chain at a 10:1 conductivity contrast, and the
 *    SAME physics at two relaxation times τ_f = 0.8 vs 1.4 gives the
 *    SAME wrong placement: the error is a functional of the
 *    reflected-population form, not a τ artifact a correction could
 *    tune away — and at the stove's 1700:1 contrast the stakes scale
 *    up, not down.
 *
 * τ-corrected refinements of conjugate ABB exist in the literature;
 * none makes the exchange conservative by construction — the
 * correction is an approximation, not an identity — and at a
 * staircase voxel interface the extrapolations the corrections rely
 * on break anyway.
 *
 * ## The winner, measured on the same problem
 *
 * The passive scalar + CHT coupled march on the SAME chain (air
 * columns against steel, k ratio 1700:1 — the stove's own contrast)
 * closes every defect by construction: the interface face flux is
 * ONE number (the harmonic-mean conductance), so at the coupled
 * steady state the hot wall's flux, the cold wall's flux and the
 * analytic series-resistance solution all agree to 0.1 %, the
 * interface temperatures continue the analytic chain, and the
 * ledger's closure sits at ~2e-8 of the boundary terms. That gap —
 * exact agreement against a 3–7 % inventory fabrication and a 4.45 K
 * misplacement — IS the decision.
 */

import { describe, expect, it } from "vitest";
import { SIM_FLUID_AIR, simFluidState } from "@slopcad/sim-core";
import type { LbmThermalFaceCondition } from "./thermal-scalar";

import { runChtScenario, type ChtScenario } from "./cht";
import { analyticOccupancy } from "./fixtures";

/** The D1Q3 weights: w(±1) = 1/6, w(0) = 2/3 — c_s² = 1/3. */
const W_MOVING = 1 / 6;

/** One node's three populations (−x, rest, +x directions). */
interface D1Q3Node {
  minus: number;
  rest: number;
  plus: number;
}

/** A marched double-distribution chain's steady-state measurements. */
interface DoubleDistributionSteady {
  converged: boolean;
  steps: number;
  /** The steady temperatures, K. */
  temperature: number[];
  /** The fluid region's interior flux (from its profile slope × D). */
  fluidFlux: number;
  /** The solid region's interior flux. */
  solidFlux: number;
  /** The total energy ΣT drift over the run (the conservation audit). */
  energyDrift: number;
}

/**
 * Marches the D1Q3 double-distribution chain: BGK collision per node
 * at the region's own τ, streaming, anti-bounce-back Dirichlet walls
 * at the outer ends, and the conjugate anti-bounce-back interface in
 * its corrected form — the strongest common variant: the interface
 * temperature is the flux-continuity weighting of the two
 * EXTRAPOLATED half-cell temperatures
 * T_int = (k_f·T̂_f + k_s·T̂_s)/(k_f + k_s), T̂ from the interior
 * slope — each side then anti-bounces against it independently
 * (the form's structural point: no shared flux number anywhere).
 */
function marchDoubleDistribution(input: {
  fluidNodes: number;
  solidNodes: number;
  tauFluid: number;
  tauSolid: number;
  hotK: number;
  coldK: number;
  maxSteps: number;
  toleranceK: number;
  /** Closed chain: insulated ends, a transient conduction relaxation. */
  closed: boolean;
  /** The naive interface (node temperatures) vs the corrected form. */
  naiveInterface: boolean;
}): DoubleDistributionSteady {
  const { fluidNodes, solidNodes, hotK, coldK } = input;
  const n = fluidNodes + solidNodes;
  const tau = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    tau[i] = i < fluidNodes ? input.tauFluid : input.tauSolid;
  }
  // Start: uniform per region — the closed chain relaxes from the
  // step; the Dirichlet chain starts at the walls' mean.
  const fluidInitial = input.closed ? hotK : (hotK + coldK) / 2;
  const solidInitial = input.closed ? coldK : (hotK + coldK) / 2;
  let nodes: D1Q3Node[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i < fluidNodes ? fluidInitial : solidInitial;
    nodes.push({
      minus: W_MOVING * t,
      rest: (1 - 2 * W_MOVING) * t,
      plus: W_MOVING * t,
    });
  }
  const fluidEnd = fluidNodes - 1;
  const solidStart = fluidNodes;
  const temperatureOf = (field: D1Q3Node[]): number[] =>
    field.map((node) => node.minus + node.rest + node.plus);
  const diffusivityFluid = (input.tauFluid - 0.5) / 3;
  const diffusivitySolid = (input.tauSolid - 0.5) / 3;
  const totalEnergy = (field: D1Q3Node[]): number => {
    let sum = 0;
    for (const node of field) sum += node.minus + node.rest + node.plus;
    return sum;
  };
  const energy0 = totalEnergy(nodes);

  let steps = 0;
  let converged = false;
  for (; steps < input.maxSteps && !converged; steps += 1) {
    const previousT = temperatureOf(nodes);
    // Collision at every node, each region at its own τ.
    const collided: D1Q3Node[] = nodes.map((node, i) => {
      const t = node.minus + node.rest + node.plus;
      const rate = 1 / (tau[i] ?? 1);
      return {
        minus: node.minus - rate * (node.minus - W_MOVING * t),
        rest: node.rest - rate * (node.rest - (1 - 2 * W_MOVING) * t),
        plus: node.plus - rate * (node.plus - W_MOVING * t),
      };
    });
    // Streaming, then the boundary set: genuine streaming — each
    // population KEEPS its direction, so node i's −x-moving population
    // arrives from node i+1's MINUS and its +x-moving from node i−1's
    // PLUS (a pure permutation of Σg).
    const streamed: D1Q3Node[] = [];
    for (let i = 0; i < n; i += 1) {
      streamed.push({
        minus: i + 1 < n ? (collided[i + 1]?.minus ?? 0) : 0,
        rest: collided[i]?.rest ?? 0,
        plus: i - 1 >= 0 ? (collided[i - 1]?.plus ?? 0) : 0,
      });
    }
    if (input.closed) {
      // Insulated ends: specular reflection of the arrived population.
      // Not an exact Σg identity — the reflection copies the arrived
      // population while the departed one leaves — but in this fixture
      // the ends sit in the flat tails of the step initial condition,
      // and their measured residue is ~5e-9 K·node over the whole
      // relaxation, ten orders below the interface's drift: the closed
      // chain audits the interface alone.
      const west = streamed[0];
      if (west !== undefined) west.plus = west.minus;
      const east = streamed[n - 1];
      if (east !== undefined) east.minus = east.plus;
    } else {
      // Outer walls: anti-bounce-back against the wall temperature.
      const west = streamed[0];
      if (west !== undefined) west.plus = -west.minus + 2 * W_MOVING * hotK;
      const east = streamed[n - 1];
      if (east !== undefined) east.minus = -east.plus + 2 * W_MOVING * coldK;
    }
    // The conjugate interface, both sides updated independently
    // against one interface temperature — the naive form weights the
    // NODE temperatures, the corrected form the flux-continuity
    // temperature of the EXTRAPOLATED half-cell values.
    let interfaceT: number;
    if (input.naiveInterface) {
      interfaceT =
        (diffusivityFluid * (previousT[fluidEnd] ?? 0) +
          diffusivitySolid * (previousT[solidStart] ?? 0)) /
        (diffusivityFluid + diffusivitySolid);
    } else {
      const fluidSlope =
        (previousT[fluidEnd] ?? 0) - (previousT[fluidEnd - 1] ?? 0);
      const solidSlope =
        (previousT[solidStart + 1] ?? 0) - (previousT[solidStart] ?? 0);
      interfaceT =
        (diffusivityFluid * ((previousT[fluidEnd] ?? 0) + 0.5 * fluidSlope) +
          diffusivitySolid *
            ((previousT[solidStart] ?? 0) + 0.5 * solidSlope)) /
        (diffusivityFluid + diffusivitySolid);
    }
    const fluidNode = streamed[fluidEnd];
    if (fluidNode !== undefined) {
      fluidNode.minus = -fluidNode.plus + 2 * W_MOVING * interfaceT;
    }
    const solidNode = streamed[solidStart];
    if (solidNode !== undefined) {
      solidNode.plus = -solidNode.minus + 2 * W_MOVING * interfaceT;
    }
    nodes = streamed;
    // Steady detector: the field stopped moving.
    const currentT = temperatureOf(nodes);
    let worst = 0;
    for (let i = 0; i < n; i += 1) {
      worst = Math.max(
        worst,
        Math.abs((currentT[i] ?? 0) - (previousT[i] ?? 0)),
      );
    }
    if (worst < input.toleranceK) converged = true;
  }

  const temperature = temperatureOf(nodes);
  // Each region's interior is linear at steady state; the flux is the
  // profile slope times the region's diffusivity (uniform ρc).
  const interiorSlope = (from: number, to: number): number => {
    const first = temperature[from] ?? 0;
    const last = temperature[to] ?? 0;
    return (last - first) / (to - from);
  };
  return {
    converged,
    steps,
    temperature,
    fluidFlux: -diffusivityFluid * interiorSlope(1, fluidEnd - 1),
    solidFlux: -diffusivitySolid * interiorSlope(solidStart + 1, n - 2),
    energyDrift: totalEnergy(nodes) - energy0,
  };
}

/** The analytic series-resistance steady state of the same chain. */
function analyticChain(input: {
  fluidNodes: number;
  solidNodes: number;
  fluidConductivity: number;
  solidConductivity: number;
  hotK: number;
  coldK: number;
}) {
  const {
    fluidNodes,
    solidNodes,
    fluidConductivity,
    solidConductivity,
    hotK,
    coldK,
  } = input;
  const resistance =
    fluidNodes / fluidConductivity + solidNodes / solidConductivity;
  const flux = (hotK - coldK) / resistance;
  return {
    flux,
    fluidEndK: hotK - (flux * (fluidNodes - 0.5)) / fluidConductivity,
    solidStartK: coldK + (flux * (solidNodes - 0.5)) / solidConductivity,
  };
}

describe("the double-distribution option (conjugate anti-bounce-back)", () => {
  it("fabricates energy at the interface in a closed chain, both ABB forms", () => {
    // The conservation audit in this repo's own ledger language: a
    // CLOSED chain (insulated ends — their specular treatment's own
    // measured residue is ~5e-9 K·node here, ten orders below the
    // interface's drift), hot fluid against cold solid, nothing enters
    // or leaves. A conservative interface conserves the inventory at
    // EVERY step; the anti-bounce-back replacement has no
    // pairwise-cancellation identity, and the inventory drifts —
    // measured here for both the naive node-temperature form and the
    // corrected extrapolated form. The passive scalar's closed box
    // conserves to float rounding (pinned in thermal-scalar.test.ts).
    const contrast = 10;
    const run = (naiveInterface: boolean): DoubleDistributionSteady =>
      marchDoubleDistribution({
        fluidNodes: 12,
        solidNodes: 12,
        tauFluid: 0.8,
        tauSolid: 0.5 + 3 * contrast * ((0.8 - 0.5) / 3),
        hotK: 310,
        coldK: 290,
        maxSteps: 60_000,
        toleranceK: 1e-11,
        closed: true,
        naiveInterface,
      });
    const naive = run(true);
    const corrected = run(false);
    expect(naive.converged).toBe(true);
    expect(corrected.converged).toBe(true);
    // Both forms drift the closed chain's energy — the interface
    // fabricated it: measured −225 and −530 K·node against the 7200
    // K·node inventory (≈ 3 % and 7 % destroyed over the relaxation) —
    // the numbers the decision comment above quotes, pinned to the
    // miniature's own deterministic march.
    expect(naive.energyDrift).toBeCloseTo(-224.891, 2);
    expect(corrected.energyDrift).toBeCloseTo(-529.976, 2);
  });

  it("places the interface off the analytic conjugate chain at contrast", () => {
    // The corrected form's steady profile against the analytic
    // series-resistance chain at a 10:1 conductivity contrast: the
    // interface temperature sits 4.45 K off the analytic value (22 %
    // of the 20 K wall-to-wall ΔT) — and the SAME physics at two
    // relaxation times gives the SAME wrong placement (the defect is
    // structural — a functional of the reflected-population form —
    // not a τ artifact a correction could tune away).
    const fluidNodes = 10;
    const solidNodes = 10;
    const contrast = 10;
    const run = (tauFluid: number): DoubleDistributionSteady =>
      marchDoubleDistribution({
        fluidNodes,
        solidNodes,
        tauFluid,
        tauSolid: 0.5 + 3 * contrast * ((tauFluid - 0.5) / 3),
        hotK: 310,
        coldK: 290,
        maxSteps: 400_000,
        toleranceK: 1e-10,
        closed: false,
        naiveInterface: false,
      });
    const quick = run(0.8);
    const slow = run(1.4);
    expect(quick.converged).toBe(true);
    expect(slow.converged).toBe(true);
    const interfaceT = (steady: DoubleDistributionSteady): number => {
      const fluid = steady.temperature[fluidNodes - 1] ?? 0;
      const solid = steady.temperature[fluidNodes] ?? 0;
      return (fluid + solid) / 2;
    };
    const analytic = analyticChain({
      fluidNodes,
      solidNodes,
      fluidConductivity: 0.1,
      solidConductivity: 1,
      hotK: 310,
      coldK: 290,
    });
    const analyticInterface = (analytic.fluidEndK + analytic.solidStartK) / 2;
    const quickError = Math.abs(interfaceT(quick) - analyticInterface);
    expect(quickError).toBeGreaterThan(0.5);
    expect(quickError).toBeLessThan(5);
    expect(Math.abs(interfaceT(slow) - analyticInterface)).toBeGreaterThan(0.5);
    // The two τ resolutions agree with each other to the convergence
    // tolerance — on the WRONG placement.
    expect(Math.abs(interfaceT(quick) - interfaceT(slow))).toBeLessThan(1e-6);
  });
});

describe("the passive-scalar winner on the same conjugate chain", () => {
  const NX = 24;
  const NY = 3;
  const DX = 0.01;
  const FLUID_COLUMNS = 8;
  const HOT_K = 310;
  const COLD_K = 290;
  const K_STEEL = 45;
  const RHO_C_SOLID = 2e5;

  function chainScenario(): ChtScenario {
    const fluidState = simFluidState(SIM_FLUID_AIR, 300);
    if (!fluidState.ok) throw new Error(fluidState.error.message);
    const count = NX * NY;
    const mask = analyticOccupancy(NX, NY, (x) => x >= FLUID_COLUMNS);
    const solidK = new Float64Array(count).fill(K_STEEL);
    const solidRhoC = new Float64Array(count).fill(RHO_C_SOLID);
    const adiabatic: LbmThermalFaceCondition = { kind: "adiabatic" };
    return {
      name: "decision-conjugate-chain",
      mask: { nx: NX, ny: NY, solid: mask },
      cellSizeM: DX,
      fluid: fluidState.value,
      characteristicVelocityMPerS: 0.02,
      flowFaces: {
        west: { kind: "wall", slip: false },
        east: { kind: "wall", slip: false },
        south: { kind: "wall", slip: false },
        north: { kind: "wall", slip: false },
      },
      thermalFaces: {
        west: { kind: "fixed-temperature", temperatureK: HOT_K },
        east: adiabatic,
        south: adiabatic,
        north: adiabatic,
      },
      gravityMPerS2: [0, 0],
      referenceTemperatureK: 300,
      solidConductivityWPerMK: solidK,
      solidVolumetricHeatCapacityJPerM3K: solidRhoC,
      solidFaceConditions: {
        xMax: { kind: "fixed-temperature", temperatureK: COLD_K },
      },
      initialTemperatureK: 300,
      characteristicLengthM: NX * DX,
      // 4 s intervals over 1600 s: the coupled system's weakly damped
      // interface mode settles in ~10³ s (measured: 400 s leaves a
      // 2.4 mK offset at T8, 1600 s lands the analytic chain to all
      // printed digits) — sized once, pinned here.
      couplingIntervalSteps: 160,
      intervals: 400,
    };
  }

  it(
    "carries ONE interface flux: both walls agree with the analytic chain",
    { timeout: 30_000 },
    () => {
      const run = runChtScenario(chainScenario());
      if (!run.ok) throw new Error(run.error.message);
      const report = run.value;
      expect(report.diverged).toBe(false);
      // The books close at solver tolerance: the closure is ~2e-8 of
      // the dominant boundary term (the solid's multi-kilojoule cold-
      // wall transient; the fluid's wall gain ≈ the interface hand-off
      // at steady, both walls agreeing to the last printed digit).
      expect(Math.abs(report.ledger.closureJPerM)).toBeLessThan(
        Math.abs(report.ledger.solidBoundaryInJPerM) * 1e-7,
      );

      const temperature = report.fields.find(
        (field) => field.id === "temperature",
      );
      expect(temperature).toBeDefined();
      if (temperature === undefined) return;
      const values = temperature.values;
      const fluidState = simFluidState(SIM_FLUID_AIR, 300);
      if (!fluidState.ok) throw new Error(fluidState.error.message);
      const kFluid = fluidState.value.thermalConductivityWPerMK;

      // The measured wall fluxes, per metre of depth: the west wall's
      // Dirichlet columns (into the fluid) and the solid slab's cold
      // east wall (out of the solid).
      let westW = 0;
      let eastWallOut = 0;
      for (let y = 0; y < NY; y += 1) {
        westW += 2 * kFluid * (HOT_K - (values[y * NX] ?? 0));
        eastWallOut += 2 * K_STEEL * ((values[NX - 1 + y * NX] ?? 0) - COLD_K);
      }
      // The analytic series-resistance chain, per metre of depth (the
      // analytic helper speaks per-cell conductances k/dx — the node
      // count is then the resistance path length).
      const analytic = analyticChain({
        fluidNodes: FLUID_COLUMNS,
        solidNodes: NX - FLUID_COLUMNS,
        fluidConductivity: kFluid / DX,
        solidConductivity: K_STEEL / DX,
        hotK: HOT_K,
        coldK: COLD_K,
      });
      const analyticTotalW = analytic.flux * (NY * DX);
      // ONE flux: both walls match it (and each other) to the coupling
      // lag + solver tolerance — the conservative property the
      // double-distribution form lacks (its closed-chain drift and
      // 4.45 K placement error, measured above).
      expect(Math.abs(westW - analyticTotalW) / analyticTotalW).toBeLessThan(
        0.001,
      );
      expect(
        Math.abs(eastWallOut - analyticTotalW) / analyticTotalW,
      ).toBeLessThan(0.001);
      expect(Math.abs(westW - eastWallOut) / analyticTotalW).toBeLessThan(
        0.001,
      );
      // And the interface temperatures continue the analytic chain.
      const fluidEndMean =
        ((values[FLUID_COLUMNS - 1] ?? 0) +
          (values[FLUID_COLUMNS - 1 + NX] ?? 0) +
          (values[FLUID_COLUMNS - 1 + 2 * NX] ?? 0)) /
        3;
      const solidStartMean =
        ((values[FLUID_COLUMNS] ?? 0) +
          (values[FLUID_COLUMNS + NX] ?? 0) +
          (values[FLUID_COLUMNS + 2 * NX] ?? 0)) /
        3;
      expect(fluidEndMean).toBeCloseTo(analytic.fluidEndK, 3);
      expect(solidStartMean).toBeCloseTo(analytic.solidStartK, 3);
    },
  );
});
