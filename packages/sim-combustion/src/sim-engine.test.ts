/**
 * The combustion engine adapter's contract tests (Phase 68c, the
 * sim-thermal `./engine.test` precedent): the compiled combustion
 * scenario — produced by the REAL geometry-aware compile door
 * (`sim-core`'s `compileSimScenarioWithGeometry`) — runs through the
 * Phase 61 `SimEngine` contract end to end, both modes. The truths this
 * file owns:
 *
 * - ENGINE mode: the 0D Otto cycle's P-vs-crank histories, the
 *   indicated and brake families SIDE BY SIDE (IMEP the gas-path truth,
 *   BMEP below it by the Chen–Flynn friction), the loss family closing
 *   the audit (fuel = brake + exhaust + wall, residual at the float
 *   floor), the sweep series, the knock boundary quantity, and the
 *   pressure-trace preview round — bitwise the finalized history;
 * - STOVE mode: the fire couples — the reactor's progress-variable
 *   wall heat enters the 65-family march (the solid warms above its
 *   initial field), the equilibrium gas state (the 68a products)
 *   reports beside the fire's own history, the temperature field is
 *   the one overlay block, and the march's energy ledger closes;
 * - determinism: the same compiled problem produces the
 *   bitwise-identical result and notification stream (law S2);
 * - the loud declines: a geometry-less compile, the GPU preference,
 *   and the kinds this engine does not solve.
 *
 * Node-env vitest, no network, no React — the law-S2/S5 stance. The
 * heavy tests carry MEASURED timeouts (the 68b suite's discipline):
 * the engine-mode double run measured ≈ 7 s, the stove double run
 * ≈ 3 s — the timeouts carry an order of margin, not a guess.
 */

import { describe, expect, it } from "vitest";
import {
  compileSimScenario,
  compileSimScenarioWithGeometry,
  reassembleSimFieldChunks,
  type SimEngineFieldChunk,
  type SimEngineProgress,
} from "@slopcad/sim-core";

import { createCombustionSimEngine } from "./sim-engine";

/** One aligned box triangle soup, the voxelizer's wire form (flat mm). */
function boxTessellationWire(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): { readonly positions: number[]; readonly indices: number[] } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = [
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y1,
    z0,
    x0,
    y1,
    z0,
    x0,
    y0,
    z1,
    x1,
    y0,
    z1,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  ];
  const indices = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2,
    6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ];
  return { positions, indices };
}

/** The demo stove bar (the 65 engine test's own fixture numbers). */
const BAR = boxTessellationWire([40, 15, 0], [60, 25, 10]);

/** The steel material record, the wire form the 65 material door parses. */
const STEEL = {
  id: "mat_steel",
  name: "Steel",
  densityGPerCm3: 7.8,
  thermalConductivityWPerMK: 45,
  specificHeatJPerKgK: 466,
  emissivity: 0.6,
};

/** The serialized engine-mode scenario the compile door consumes. */
function engineScenario(): Record<string, unknown> {
  return {
    name: "otto-demo",
    kind: "combustion",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: [],
    fluid: "air",
    materials: [],
    combustion: {
      mode: "engine",
      fuel: "C8H18-ISO",
      geometry: {
        boreMm: 86,
        crankRadiusMm: 43,
        rodLengthMm: 143,
        compressionRatio: 10,
      },
      speedRpm: 1500,
      charge: { intakePressureBar: 1, intakeTK: 300, equivalenceRatio: 1 },
      spark: { timingBTDCDeg: 25 },
      wallHeat: { mode: "woschni", wallTemperatureK: 450 },
      sweep: { kind: "sparkTiming", from: 10, to: 50, steps: 4 },
    },
  };
}

/** The serialized stove-mode scenario the compile door consumes. */
function stoveScenario(): Record<string, unknown> {
  return {
    name: "stove-fire",
    kind: "combustion",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: [],
    fluid: "air",
    materials: [{ bodyId: "body_bar", materialId: "mat_steel" }],
    combustion: {
      mode: "stove",
      fuel: "CH4",
      equivalenceRatio: 1,
      chargeTemperatureK: 1400,
      chargePressureBar: 1,
      wallConvectionWPerM2K: 30,
      radiationMode: "linearized",
      initialTemperatureK: 293.15,
      ambientConvectionWPerM2K: 5,
      durationS: 30,
      sampleIntervalS: 1,
    },
  };
}

/** Compiles the scenario through the real geometry-aware door. */
function compileCombustion(
  scenario: Record<string, unknown>,
  withGeometry: boolean,
) {
  if (!withGeometry) {
    return compileSimScenario({ scenario });
  }
  return compileSimScenarioWithGeometry({
    scenario,
    materials: [STEEL],
    bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
  });
}

/** Reads one quantity's value off a result's summary. */
function quantityOf(
  result: {
    readonly summary: {
      readonly quantities: readonly {
        readonly name: string;
        readonly value: number;
      }[];
    };
  },
  name: string,
): number | undefined {
  return result.summary.quantities.find((row) => row.name === name)?.value;
}

describe("the combustion engine — engine mode (the 0D Otto cycle)", () => {
  it(
    "runs the cycle with the families side by side, the audit closed, and the sweep aboard",
    { timeout: 60_000 },
    async () => {
      const compiled = compileCombustion(engineScenario(), true);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.value.combustion?.mode).toBe("engine");
      expect(compiled.value.combustion).not.toHaveProperty("materialIndex");

      const engine = createCombustionSimEngine();
      const chunks: SimEngineFieldChunk[] = [];
      const progress: SimEngineProgress[] = [];
      const result = await engine.run(
        { compiled: compiled.value },
        (step) => progress.push(step),
        (chunk) => chunks.push(chunk),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const summary = result.value.summary;
      expect(summary.status).toBe("completed");
      expect(summary.servedBackend).toBe("cpu");
      expect(summary.scenarioSnapshotHash).toMatch(/^[0-9a-f]{8}$/);
      expect(summary.regime.prandtl).toBeGreaterThan(0.5);

      // The indicated and brake families side by side: IMEP is the
      // gas-path truth (the SI band at CR 10, φ 1, WOT), BMEP sits
      // below it by the friction + pumping overlay, and both
      // efficiencies land in the textbook SI band.
      const imep = quantityOf(result.value, "imep");
      const bmep = quantityOf(result.value, "bmep");
      const fmep = quantityOf(result.value, "fmep");
      const pmep = quantityOf(result.value, "pmep");
      const indicatedEfficiency = quantityOf(
        result.value,
        "indicated-thermal-efficiency",
      );
      const brakeEfficiency = quantityOf(
        result.value,
        "brake-thermal-efficiency",
      );
      expect(imep).toBeDefined();
      expect(bmep).toBeDefined();
      expect(fmep).toBeDefined();
      expect(pmep).toBeDefined();
      if (
        imep === undefined ||
        bmep === undefined ||
        fmep === undefined ||
        pmep === undefined
      ) {
        return;
      }
      expect(imep).toBeGreaterThan(8e5);
      expect(imep).toBeLessThan(2.5e6);
      expect(bmep).toBeGreaterThan(5e5);
      expect(bmep).toBeLessThan(imep);
      expect(Math.abs(bmep - (imep - fmep - pmep))).toBeLessThan(1e-9 * imep);
      expect(indicatedEfficiency).toBeGreaterThan(0.25);
      expect(indicatedEfficiency).toBeLessThan(0.5);
      expect(brakeEfficiency).toBeLessThan(indicatedEfficiency ?? 1);

      // The loss family closes the balance: fuel = brake + friction +
      // exhaust enthalpy + wall heat (the residual at the float floor).
      const residual = quantityOf(result.value, "audit-residual");
      const fuel = quantityOf(result.value, "fuel-chemical-energy");
      expect(residual).toBeDefined();
      expect(fuel).toBeDefined();
      if (residual !== undefined && fuel !== undefined) {
        expect(Math.abs(residual)).toBeLessThan(1e-6 * fuel);
      }

      // The knock report: the integral's comparative value and the
      // spark sweep's boundary marker (the first row past integral 1).
      expect(quantityOf(result.value, "knock-integral-max")).toBeGreaterThan(1);
      const boundary = quantityOf(result.value, "sweep-knock-boundary");
      expect(boundary).toBeDefined();
      if (boundary !== undefined) {
        expect(boundary).toBeGreaterThanOrEqual(10);
        expect(boundary).toBeLessThanOrEqual(50);
      }

      // The histories: the P-vs-crank trace (721 samples at the 0.5°
      // step) plus the motored twin, and the sweep series prefixed.
      const names = result.value.histories.map((series) => series.name);
      expect(names).toContain("crank-angle");
      expect(names).toContain("pressure");
      expect(names).toContain("pressure-motored");
      expect(names).toContain("knock-integral");
      expect(names).toContain("sweep:spark-timing-btdc");
      expect(names).toContain("sweep:imep");
      expect(names).toContain("sweep:bmep");
      const angle = result.value.histories.find(
        (series) => series.name === "crank-angle",
      );
      const pressure = result.value.histories.find(
        (series) => series.name === "pressure",
      );
      expect(angle?.samples.length).toBe(721);
      expect(pressure?.samples.length).toBe(721);

      // The preview round: the pressure trace reassembles from its
      // chunks bitwise the finalized history (the last-round law).
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const reassembled = reassembleSimFieldChunks(chunks);
      expect(reassembled.ok).toBe(true);
      if (reassembled.ok) {
        expect(reassembled.value.id).toBe("pressure-trace");
        expect(reassembled.value.unit).toBe("bar");
        expect(reassembled.value.values).toEqual(pressure?.samples ?? []);
      }
      expect(progress.at(-1)?.step).toBe(progress.at(-1)?.totalSteps);
    },
  );

  it("repeats bitwise identically (law S2)", { timeout: 60_000 }, async () => {
    const compiled = compileCombustion(engineScenario(), true);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createCombustionSimEngine();
    const first = await engine.run({ compiled: compiled.value });
    const second = await engine.run({ compiled: compiled.value });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.summary.quantities).toEqual(
      first.value.summary.quantities,
    );
    expect(second.value.histories).toEqual(first.value.histories);
  });
});

describe("the combustion engine — stove mode (the stove with fire)", () => {
  it(
    "couples the reactor's wall heat into the 65-family march",
    { timeout: 60_000 },
    async () => {
      const compiled = compileCombustion(stoveScenario(), true);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.value.combustion?.mode).toBe("stove");
      expect(compiled.value.occupancySlice).toBeDefined();

      const engine = createCombustionSimEngine();
      const chunks: SimEngineFieldChunk[] = [];
      const progress: SimEngineProgress[] = [];
      const result = await engine.run(
        { compiled: compiled.value },
        (step) => progress.push(step),
        (chunk) => chunks.push(chunk),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const summary = result.value.summary;
      expect(summary.status).toBe("completed");
      expect(summary.servedBackend).toBe("cpu");

      // The fire burned: the progress variable completed and the
      // chamber's equilibrium gas state (the 68a HP products) reports
      // the methane adiabatic flame band.
      const progressFinal = quantityOf(result.value, "fire-final-progress");
      const flameTemperature = quantityOf(
        result.value,
        "adiabatic-flame-temperature",
      );
      expect(progressFinal).toBeDefined();
      expect(flameTemperature).toBeDefined();
      if (progressFinal !== undefined && flameTemperature !== undefined) {
        expect(progressFinal).toBeGreaterThan(0.99);
        // The HP flame AT THE AUTHORED INLET (1400 K sensible aboard),
        // not the 298 K table value — the band states that.
        expect(flameTemperature).toBeGreaterThan(2400);
        expect(flameTemperature).toBeLessThan(2900);
      }

      // The coupling: the fire's wall heat entered the solid (the
      // field warmed above its initial line) and the march's ledger
      // closes — source = boundary losses + stored, at the float floor.
      const maxTemperature = quantityOf(result.value, "max-temperature");
      const source = quantityOf(result.value, "fire-source-energy");
      const wallHeat = quantityOf(result.value, "fire-wall-heat");
      const closure = quantityOf(result.value, "energy-closure");
      expect(maxTemperature).toBeDefined();
      expect(source).toBeDefined();
      expect(wallHeat).toBeDefined();
      expect(closure).toBeDefined();
      if (
        maxTemperature !== undefined &&
        source !== undefined &&
        wallHeat !== undefined &&
        closure !== undefined
      ) {
        expect(maxTemperature).toBeGreaterThan(293.15);
        expect(source).toBeGreaterThan(0);
        expect(Math.abs(closure)).toBeLessThan(1e-4 * source);
        // The missing identity, now structural: the march's source
        // ledger telescopes onto the reactor's own wall-heat audit —
        // the interpolated cumulative differenced at the interval
        // boundaries, signed (never clamped), so the two agree at the
        // float-summation floor, not approximately.
        expect(Math.abs(source - wallHeat)).toBeLessThan(1e-9 * wallHeat);
      }

      // The temperature field is the one overlay block, the slice's
      // shape, and the preview round published it chunked.
      expect(result.value.fields.map((field) => field.id)).toEqual([
        "temperature",
      ]);
      const block = result.value.fields[0];
      expect(block).toBeDefined();
      if (block !== undefined) {
        expect(block.unit).toBe("K");
        expect([...block.extent]).toEqual([21, 9, 1]);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const reassembled = reassembleSimFieldChunks(chunks);
      expect(reassembled.ok).toBe(true);
      if (reassembled.ok && block !== undefined) {
        expect(reassembled.value.values).toEqual(block.values);
      }

      // The histories: the fire's own curve pair and the field triple,
      // sampled on the cadence (31 samples for 30 s at 1 s).
      const names = result.value.histories.map((series) => series.name);
      expect(names).toEqual([
        "time",
        "fire:progress",
        "fire:gas-temperature",
        "fire:wall-heat-rate",
        "temperature-max",
        "temperature-mean",
        "temperature-min",
      ]);
      const fireRate = result.value.histories.find(
        (series) => series.name === "fire:wall-heat-rate",
      );
      expect(fireRate?.samples.length).toBe(31);
      // The burn concentrated its release in the opening intervals.
      expect(Math.max(...(fireRate?.samples ?? []))).toBeGreaterThan(0);
      expect(progress.at(-1)?.step).toBe(30);
    },
  );

  it("repeats bitwise identically (law S2)", { timeout: 60_000 }, async () => {
    const compiled = compileCombustion(stoveScenario(), true);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createCombustionSimEngine();
    const first = await engine.run({ compiled: compiled.value });
    const second = await engine.run({ compiled: compiled.value });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.summary.quantities).toEqual(
      first.value.summary.quantities,
    );
    expect(second.value.histories).toEqual(first.value.histories);
    expect(second.value.fields.map((field) => field.values).join("|")).toEqual(
      first.value.fields.map((field) => field.values).join("|"),
    );
  });
});

describe("the combustion engine's loud declines", () => {
  it("declines a geometry-less compile (no combustion products)", async () => {
    const compiled = compileCombustion(engineScenario(), false);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createCombustionSimEngine();
    const result = await engine.run({ compiled: compiled.value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("sim/scenario-invalid");
    expect(result.error.message).toContain("combustion products");
  });

  it("declines the GPU preference loudly (no GPU provider exists)", async () => {
    const scenario = {
      ...engineScenario(),
      backend: "gpu",
    };
    const compiled = compileCombustion(scenario, true);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createCombustionSimEngine();
    const result = await engine.run({ compiled: compiled.value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("sim/backend-unavailable");
  });

  it("declines every other scenario kind", async () => {
    const engine = createCombustionSimEngine();
    const compiled = compileCombustion(stoveScenario(), true);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const result = await engine.run({
      compiled: { ...compiled.value, kind: "flow" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("sim/scenario-kind-unsupported");
  });
});
