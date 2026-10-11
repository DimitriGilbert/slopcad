/**
 * The CHT coupled march's pins (Phase 65b validation): the buoyant
 * differentially-heated cavity (the roadmap's named fixture — Ra in
 * the S9-qualitative laminar band, circulation direction and
 * boundary-layer trend pinned, Ra/Pr in the summary, QUALITATIVE per
 * law S9, no DNS claim), the closed-domain energy-conservation audit
 * (fluid ΔE + solid ΔE ≡ injected source to solver tolerance, both
 * boundary ledgers identically zero on adiabatic walls), bitwise
 * determinism of the coupled march, fluid–solid interface stability
 * at the stove-representative air/steel contrast with the real steel
 * volumetric capacity, the no-solid cavity path, and the door's loud
 * declines. Node-env vitest, no network — the law-S2 stance.
 */

import { describe, expect, it } from "vitest";
import { SIM_FLUID_AIR, simFluidState } from "@slopcad/sim-core";

import { CHT_HISTORY_SERIES, runChtScenario, type ChtScenario } from "./cht";
import { analyticOccupancy } from "./fixtures";
import { lbmInterfaceConductanceWPerMK } from "./thermal-scalar";

const GRAVITY: readonly [number, number] = [0, -9.81];
const WALL = { kind: "wall", slip: false } as const;
const ADIABATIC = { kind: "adiabatic" } as const;

function airFluid() {
  const state = simFluidState(SIM_FLUID_AIR, 300);
  if (!state.ok) throw new Error(state.error.message);
  return state.value;
}

type ChtRun = ReturnType<typeof runChtScenario>;
type RunOk = Extract<ChtRun, { ok: true }>;

function runOkReport(run: ChtRun): RunOk["value"] {
  if (!run.ok) throw new Error(run.error.message);
  return run.value;
}

/** The final temperature field's values (K, x-fastest). */
function temperatureValues(report: RunOk["value"]): readonly number[] {
  const field = report.fields.find((entry) => entry.id === "temperature");
  if (field === undefined) throw new Error("missing temperature field");
  return field.values;
}

function velocityYValues(report: RunOk["value"]): readonly number[] {
  const field = report.fields.find((entry) => entry.id === "velocity-y");
  if (field === undefined) throw new Error("missing velocity-y field");
  return field.values;
}

describe("the buoyant differentially-heated cavity (S9-qualitative)", () => {
  // Air cavity 47 mm square, ΔT = 1 K across it: Ra ≈ 9.7e3 — the
  // steady laminar circulation band (the de Vahl Davis regime), three
  // orders below the 1e9 buoyant-turbulence threshold, no flag.
  // QUALITATIVE per law S9: a 32-voxel cavity pins structure (one
  // circulation cell, rising at the hot wall), not a DNS benchmark.
  const NX = 32;
  const NY = 32;
  const L = 0.047;
  const DX = L / NX;
  const T_COLD = 299.5;
  const T_HOT = 300.5;

  function cavityScenario(): ChtScenario {
    return {
      name: "buoyant-cavity",
      mask: { nx: NX, ny: NY, solid: analyticOccupancy(NX, NY, () => false) },
      cellSizeM: DX,
      fluid: airFluid(),
      // The buoyancy velocity √(g·β·ΔT·L) ≈ 0.039 m/s — the closure's
      // low-Mach reference.
      characteristicVelocityMPerS: 0.08,
      flowFaces: { west: WALL, east: WALL, south: WALL, north: WALL },
      thermalFaces: {
        west: { kind: "fixed-temperature", temperatureK: T_HOT },
        east: { kind: "fixed-temperature", temperatureK: T_COLD },
        south: ADIABATIC,
        north: ADIABATIC,
      },
      gravityMPerS2: GRAVITY,
      // T_ref at the cold wall: the 61a ΔT rule then sees the full
      // wall-to-wall ΔT (the Rayleigh scale).
      referenceTemperatureK: T_COLD,
      solidConductivityWPerMK: new Float64Array(NX * NY).fill(45),
      solidVolumetricHeatCapacityJPerM3K: new Float64Array(NX * NY).fill(2e5),
      initialTemperatureK: 300,
      characteristicLengthM: L,
      couplingIntervalSteps: 20,
      intervals: 800,
    };
  }

  it(
    "circulates hot-side-up with boundary layers, Ra and Pr in the summary",
    { timeout: 120_000 },
    () => {
      const report = runOkReport(runChtScenario(cavityScenario()));
      expect(report.diverged).toBe(false);
      expect(report.grid.nx).toBe(NX);
      // The S9 numbers: Ra ≈ 9.7e3 (the laminar band), Pr ≈ 0.71 for
      // air, and no advisory flag crossed (Re ~ 120, Ma ~ 1e-4,
      // Ra << 1e9) — the qualitative statement is the VOXEL
      // resolution's, not a regime flag's.
      expect(report.regime.rayleigh).toBeGreaterThan(5e3);
      expect(report.regime.rayleigh).toBeLessThan(2e4);
      expect(report.regime.prandtl).toBeCloseTo(0.71, 2);
      expect(report.regime.qualitative).toEqual([]);

      const temperature = temperatureValues(report);
      const uy = velocityYValues(report);
      const columnMeanUy = (x: number): number => {
        let sum = 0;
        for (let y = 0; y < NY; y += 1) sum += uy[x + y * NX] ?? 0;
        return sum / NY;
      };
      const columnMeanT = (x: number): number => {
        let sum = 0;
        for (let y = 0; y < NY; y += 1) sum += temperature[x + y * NX] ?? 0;
        return sum / NY;
      };
      // Circulation direction: the Boussinesq force drives fluid UP
      // the hot west wall and DOWN the cold east wall — one cell.
      let westSum = 0;
      let eastSum = 0;
      for (let x = 0; x < 10; x += 1) westSum += columnMeanUy(x);
      for (let x = 22; x < NX; x += 1) eastSum += columnMeanUy(x);
      expect(westSum).toBeGreaterThan(0);
      expect(eastSum).toBeLessThan(0);
      // The flow moves: the speed history rose off rest and settled.
      const speed = report.histories.find(
        (series) => series.name === CHT_HISTORY_SERIES.fluidSpeedMax,
      );
      expect(speed).toBeDefined();
      const speedSamples = speed?.samples ?? [];
      expect(speedSamples[0]).toBe(0);
      expect(Math.max(...speedSamples)).toBeGreaterThan(0.01);
      // Boundary-layer trend: the horizontal-mean |uy| peaks at the
      // side walls (the buoyant boundary layers), not in the core.
      let peakColumn = 0;
      let peakMagnitude = 0;
      for (let x = 0; x < NX; x += 1) {
        const magnitude = Math.abs(columnMeanUy(x));
        if (magnitude > peakMagnitude) {
          peakMagnitude = magnitude;
          peakColumn = x;
        }
      }
      expect(peakColumn < 8 || peakColumn > NX - 9).toBe(true);
      // And the temperature field: hot-west to cold-east ordering
      // through the bulk.
      expect(columnMeanT(2)).toBeGreaterThan(columnMeanT(15));
      expect(columnMeanT(15)).toBeGreaterThan(columnMeanT(29));
      // The no-solid path: no solid cells anywhere.
      expect(report.temperature.solidMeanK).toBeNull();
      expect(
        report.histories.some(
          (series) => series.name === CHT_HISTORY_SERIES.solidTemperatureMean,
        ),
      ).toBe(false);
      expect(report.histories.map((series) => series.name)).toEqual([
        CHT_HISTORY_SERIES.fluidTemperatureMean,
        CHT_HISTORY_SERIES.fluidSpeedMax,
      ]);
    },
  );
});

describe("the closed-domain energy-conservation audit", () => {
  // A sealed adiabatic box with a heated steel block: both boundary
  // ledgers are identically zero, so the audit reduces to fluid ΔE +
  // solid ΔE ≡ injected source — the by-construction closure measured,
  // not assumed. Gravity on: the block's plume is the coupling's
  // physical driver, exercised, not bypassed. The source is sized for
  // a LAMINAR plume (quasi-steady block excess ~1 K → plume
  // Reynolds ~100): a hotter block goes supercritical on a 32-voxel
  // no-RANS lattice by physics, not by scheme (measured: sources
  // past ~5e3 W/m³ blew the plume's lattice velocity past 0.1 within
  // a second at every coupling resolution tried).
  const NX = 32;
  const NY = 32;
  const DX = 0.0075;
  const BLOCK = { x0: 12, x1: 19, y0: 12, y1: 19 };
  const SOURCE_W_PER_M3 = 500;

  function closedScenario(): ChtScenario {
    const count = NX * NY;
    const solid = analyticOccupancy(
      NX,
      NY,
      (x, y) =>
        x >= BLOCK.x0 && x <= BLOCK.x1 && y >= BLOCK.y0 && y <= BLOCK.y1,
    );
    const source = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      if (solid[index] === 1) source[index] = SOURCE_W_PER_M3;
    }
    return {
      name: "sealed-heated-block",
      mask: { nx: NX, ny: NY, solid },
      cellSizeM: DX,
      fluid: airFluid(),
      characteristicVelocityMPerS: 0.12,
      flowFaces: { west: WALL, east: WALL, south: WALL, north: WALL },
      thermalFaces: {
        west: ADIABATIC,
        east: ADIABATIC,
        south: ADIABATIC,
        north: ADIABATIC,
      },
      gravityMPerS2: GRAVITY,
      referenceTemperatureK: 300,
      solidConductivityWPerMK: new Float64Array(count).fill(45),
      solidVolumetricHeatCapacityJPerM3K: new Float64Array(count).fill(2e5),
      sourceWPerM3: source,
      initialTemperatureK: 300,
      characteristicLengthM: NX * DX,
      couplingIntervalSteps: 30,
      intervals: 600,
    };
  }

  it(
    "closes fluidΔE + solidΔE ≡ source with zero boundary ledgers, plume rising",
    { timeout: 120_000 },
    () => {
      const report = runOkReport(runChtScenario(closedScenario()));
      expect(report.diverged).toBe(false);
      // Adiabatic everywhere: both boundary ledgers are EXACTLY zero.
      expect(report.ledger.fluidBoundaryInJPerM).toBe(0);
      expect(report.ledger.solidBoundaryInJPerM).toBe(0);
      // The audit: everything injected resides, to solver tolerance.
      const injected = report.ledger.solidSourceJPerM;
      expect(injected).toBeGreaterThan(0);
      expect(
        Math.abs(report.ledger.closureJPerM) / Math.abs(injected),
      ).toBeLessThan(1e-7);
      expect(
        Math.abs(
          report.ledger.fluidChangeJPerM +
            report.ledger.solidChangeJPerM -
            injected,
        ) / Math.abs(injected),
      ).toBeLessThan(1e-7);
      // Both halves hold energy (the block heated, the fluid took its
      // share through the interface).
      expect(report.ledger.solidChangeJPerM).toBeGreaterThan(0);
      expect(report.ledger.fluidChangeJPerM).toBeGreaterThan(0);
      // The plume: mean vertical velocity above the block is positive
      // — the Boussinesq force consuming the gravity vector, driving
      // the coupling's flow (zero it would stay at rest).
      const uy = velocityYValues(report);
      let plumeSum = 0;
      let plumeCount = 0;
      for (let y = BLOCK.y1 + 2; y < NY; y += 1) {
        for (let x = BLOCK.x0; x <= BLOCK.x1; x += 1) {
          plumeSum += uy[x + y * NX] ?? 0;
          plumeCount += 1;
        }
      }
      expect(plumeSum / plumeCount).toBeGreaterThan(0.001);
      // No fixed-temperature wall anywhere: the buoyancy gate stays
      // closed honestly — Ra absent, Pr still reported (law S9).
      expect(report.regime.rayleigh).toBeUndefined();
      expect(report.regime.prandtl).toBeCloseTo(0.71, 2);
    },
  );
});

describe("the coupled march's determinism (law S2)", () => {
  it("marches bitwise-identically on a repeat run", () => {
    const scenario = (): ChtScenario => {
      const nx = 16;
      const ny = 16;
      const dx = 0.01;
      const count = nx * ny;
      const solid = analyticOccupancy(
        nx,
        ny,
        (x, y) => x >= 5 && x <= 9 && y >= 5 && y <= 9,
      );
      const source = new Float64Array(count);
      for (let index = 0; index < count; index += 1) {
        if (solid[index] === 1) source[index] = 3e4;
      }
      return {
        name: "determinism-block",
        mask: { nx, ny, solid },
        cellSizeM: dx,
        fluid: airFluid(),
        characteristicVelocityMPerS: 0.1,
        flowFaces: { west: WALL, east: WALL, south: WALL, north: WALL },
        thermalFaces: {
          west: ADIABATIC,
          east: ADIABATIC,
          south: ADIABATIC,
          north: ADIABATIC,
        },
        gravityMPerS2: GRAVITY,
        referenceTemperatureK: 300,
        solidConductivityWPerMK: new Float64Array(count).fill(45),
        solidVolumetricHeatCapacityJPerM3K: new Float64Array(count).fill(2e5),
        sourceWPerM3: source,
        initialTemperatureK: 300,
        characteristicLengthM: nx * dx,
        couplingIntervalSteps: 20,
        intervals: 5,
      };
    };
    const first = runOkReport(runChtScenario(scenario()));
    const second = runOkReport(runChtScenario(scenario()));
    expect(first.fields.length).toBe(second.fields.length);
    for (let f = 0; f < first.fields.length; f += 1) {
      const a = first.fields[f];
      const b = second.fields[f];
      expect(a?.id).toBe(b?.id);
      expect(a?.values.length).toBe(b?.values.length);
      for (let index = 0; index < (a?.values.length ?? 0); index += 1) {
        expect(a?.values[index]).toBe(b?.values[index]);
      }
    }
    expect(first.histories.length).toBe(second.histories.length);
    for (let s = 0; s < first.histories.length; s += 1) {
      expect(first.histories[s]?.name).toBe(second.histories[s]?.name);
      expect(first.histories[s]?.samples).toEqual(second.histories[s]?.samples);
    }
    expect(first.ledger.closureJPerM).toBe(second.ledger.closureJPerM);
  });
});

describe("fluid–solid interface stability at the stove's contrast", () => {
  it("is fluid-side dominated (the physical gentleness)", () => {
    const air = airFluid();
    const g = lbmInterfaceConductanceWPerMK(air.thermalConductivityWPerMK, 45);
    // harmonic(0.0263, 45) ≈ 2·k_f·(1 − k_f/k_s): the interface
    // conductance sits within 0.1 % of the FLUID cell's own — the
    // row-sum stability limit barely notices the steel.
    expect(g / air.thermalConductivityWPerMK).toBeGreaterThan(1.99);
    expect(g / air.thermalConductivityWPerMK).toBeLessThan(2.0);
  });

  it(
    "holds a heated real-steel block in air without divergence",
    { timeout: 60_000 },
    () => {
      // Real steel ρc (3.9e6 J/(m³·K), the stove's thermal mass) at
      // the full 1700:1 contrast, driven hard: the interface the risk
      // note worried about, run in place. The huge capacity keeps the
      // block's excess small (capacity-limited, not quasi-steady), so
      // the plume stays laminar even at this source density.
      const nx = 24;
      const ny = 24;
      const dx = 0.01;
      const count = nx * ny;
      const solid = analyticOccupancy(
        nx,
        ny,
        (x, y) => x >= 8 && x <= 15 && y >= 8 && y <= 15,
      );
      const source = new Float64Array(count);
      for (let index = 0; index < count; index += 1) {
        if (solid[index] === 1) source[index] = 6.5e4;
      }
      const report = runOkReport(
        runChtScenario({
          name: "stove-contrast",
          mask: { nx, ny, solid },
          cellSizeM: dx,
          fluid: airFluid(),
          characteristicVelocityMPerS: 0.15,
          flowFaces: { west: WALL, east: WALL, south: WALL, north: WALL },
          thermalFaces: {
            west: ADIABATIC,
            east: ADIABATIC,
            south: ADIABATIC,
            north: ADIABATIC,
          },
          gravityMPerS2: GRAVITY,
          referenceTemperatureK: 300,
          solidConductivityWPerMK: new Float64Array(count).fill(45),
          solidVolumetricHeatCapacityJPerM3K: new Float64Array(count).fill(
            3.9e6,
          ),
          sourceWPerM3: source,
          initialTemperatureK: 300,
          characteristicLengthM: nx * dx,
          couplingIntervalSteps: 50,
          intervals: 60,
        }),
      );
      expect(report.diverged).toBe(false);
      expect(Number.isFinite(report.temperature.fluidMeanK)).toBe(true);
      expect(report.temperature.solidMeanK).not.toBeNull();
      expect(report.temperature.solidMeanK ?? 0).toBeGreaterThan(300);
      expect(
        Math.abs(report.ledger.closureJPerM) /
          Math.abs(report.ledger.solidSourceJPerM),
      ).toBeLessThan(1e-7);
    },
  );
});

describe("the CHT door's loud declines", () => {
  const base = (): ChtScenario => {
    const nx = 8;
    const ny = 8;
    const count = nx * ny;
    return {
      name: "declines-base",
      mask: { nx, ny, solid: analyticOccupancy(nx, ny, () => false) },
      cellSizeM: 0.01,
      fluid: airFluid(),
      characteristicVelocityMPerS: 0.05,
      flowFaces: { west: WALL, east: WALL, south: WALL, north: WALL },
      thermalFaces: {
        west: ADIABATIC,
        east: ADIABATIC,
        south: ADIABATIC,
        north: ADIABATIC,
      },
      gravityMPerS2: GRAVITY,
      referenceTemperatureK: 300,
      solidConductivityWPerMK: new Float64Array(count).fill(45),
      solidVolumetricHeatCapacityJPerM3K: new Float64Array(count).fill(2e5),
      initialTemperatureK: 300,
      characteristicLengthM: 0.08,
      couplingIntervalSteps: 2,
      intervals: 1,
    };
  };

  it("refuses the shapes and inputs an honest march cannot run", () => {
    const zeroInterval = runChtScenario({
      ...base(),
      couplingIntervalSteps: 0,
    });
    expect(zeroInterval.ok).toBe(false);

    const zeroIntervals = runChtScenario({ ...base(), intervals: 0 });
    expect(zeroIntervals.ok).toBe(false);

    const emptyName = runChtScenario({ ...base(), name: "" });
    expect(emptyName.ok).toBe(false);

    const shortArray = runChtScenario({
      ...base(),
      solidConductivityWPerMK: new Float64Array(3),
    });
    expect(shortArray.ok).toBe(false);

    const badGravity = runChtScenario({
      ...base(),
      gravityMPerS2: [Number.NaN, -9.81],
    });
    expect(badGravity.ok).toBe(false);

    const badReference = runChtScenario({
      ...base(),
      referenceTemperatureK: 0,
    });
    expect(badReference.ok).toBe(false);
  });

  it("requires ρc on every solid cell (the implicit capacity)", () => {
    const nx = 8;
    const ny = 8;
    const count = nx * ny;
    const rhoC = new Float64Array(count).fill(2e5);
    rhoC[27] = Number.NaN;
    const declined = runChtScenario({
      ...base(),
      mask: {
        nx,
        ny,
        solid: analyticOccupancy(nx, ny, (x, y) => x === 3 && y === 3),
      },
      solidVolumetricHeatCapacityJPerM3K: rhoC,
    });
    expect(declined.ok).toBe(false);
  });
});
