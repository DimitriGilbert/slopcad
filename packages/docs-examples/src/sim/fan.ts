/**
 * The Phase 66 fan walk (the docs guide's runnable example, the
 * `./thermal` precedent): the motor-driven fan-in-a-duct — a scenario
 * record with a 3D stance (MRF rotation, the motor selection),
 * compiled through the geometry-aware door (the merged tessellation
 * voxelizes into the FULL-3D occupancy grid), and run through the 3D
 * reference engine behind the Phase 61 contract. The geometry is a
 * BOX DUCT with a box paddle rotor (merged tessellation wire — the
 * honest runnable form; `/workbench-sim`'s fan demo renders the
 * cad-jsx tube twin of the same workflow).
 *
 * Machine-verified sentences (the suite asserts each): the stance is
 * kind-locked and cut-cell reserves loudly, the run FINDS its
 * operating point inside the swept ladder (never assumes an rpm), the
 * performance (airflow, ΔP) is extracted AT the found point, the BPF
 * is the authored-blades arithmetic, the S9 fan Re guidance line flags
 * the low-Re regime, the published chart's history pair rides along,
 * and the engine is deterministic (identical summaries on repeat
 * runs).
 */

import {
  compileSimScenarioWithGeometry,
  type SimResult,
} from "@slopcad/sim-core";
import { createFlow3dSimEngine } from "@slopcad/sim-flow";

/** One axis-aligned box as the voxelizer's tessellation wire. */
function boxWire(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): { readonly positions: number[]; readonly indices: number[] } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: [
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
    ],
    indices: [
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 2, 6, 3, 6, 7, 0,
      3, 7, 0, 7, 4, 1, 2, 6, 1, 6, 5,
    ],
  };
}

/** Several box soups merged into one tessellation wire. */
function mergedWire(
  parts: readonly {
    readonly positions: readonly number[];
    readonly indices: readonly number[];
  }[],
): { readonly positions: number[]; readonly indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    for (const index of part.indices) {
      indices.push(index + offset);
    }
  }
  return { positions, indices };
}

/**
 * The example's geometry, mm: a square duct (a box with a through
 * bore) on x ∈ [0, 20], the flow along +X, and a paddle rotor (a hub
 * plus two cross-bars) at mid-length.
 */
const ROTOR_X = 12;
const FAN_EXAMPLE_GEOMETRY = mergedWire([
  // The duct walls: floor, roof, and the two side walls.
  boxWire([0, 0, 0], [24, 2, 12]),
  boxWire([0, 10, 0], [24, 12, 12]),
  boxWire([0, 2, 0], [24, 10, 2]),
  boxWire([0, 2, 10], [24, 10, 12]),
  // The rotor: a hub plus cross-bars inside the duct's bore.
  boxWire([11, 4.6, 4.6], [13, 7.4, 7.4]),
  boxWire([11.4, 3.4, 5.6], [12.6, 8.6, 6.4]),
  boxWire([11.4, 5.6, 3.4], [12.6, 6.4, 8.6]),
]);

/** The serialized motor record (document wire form, mN·m and rpm). */
const FAN_EXAMPLE_MOTOR = {
  id: "mot_example",
  name: "example fan motor",
  kind: "dc-brushed",
  stallTorqueMNm: 8e-7,
  noLoadSpeedRpm: 80,
  nominalVoltageV: 12,
};

/** The serialized fan scenario record — the 3D stance inside. */
function fanExampleScenario(): Record<string, unknown> {
  return {
    name: "fan-in-duct",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [24, 12, 12],
      resolutionMm: 1,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 0.025,
        direction: [1, 0, 0],
      },
    ],
    fluid: "air",
    stepBudget: 60,
    flow3d: {
      rotation: {
        kind: "mrf",
        axisPointMm: [ROTOR_X, 6, 6],
        axisDirection: [1, 0, 0],
        zoneRadiusMm: 3.5,
        rpmMode: "motor",
        bladeCount: 4,
      },
    },
    motorId: "mot_example",
  };
}

/** The fan walk's facts the guide states and the suite asserts. */
export interface SimFanExampleSummary {
  /** The cut-cell reserve declines loudly (the 66c decision). */
  readonly cutCellDeclined: boolean;
  /** The found operating point's speed, rad/s. */
  readonly operatingOmegaRadPerS: number;
  /** The motor's no-load speed, rad/s (the ladder's span). */
  readonly noLoadRadPerS: number;
  /** The BPF, Hz — blades × rpm / 60 at the found point. */
  readonly bladePassFrequencyHz: number;
  /** The extracted airflow at the found point, m³/s. */
  readonly airflowM3PerS: number;
  /** The extracted pressure rise at the found point, Pa. */
  readonly pressureRisePa: number;
  /** The S9 fan Re guidance line at the found point. */
  readonly fanReynoldsTip: number;
  /** The run's qualitative flags. */
  readonly flags: readonly string[];
  /** The chart's history pair lengths (load, motor). */
  readonly loadCurveSamples: number;
  /** Determinism: the repeat run's summary is identical. */
  readonly deterministic: boolean;
}

function summaryJson(result: SimResult): string {
  return JSON.stringify([
    result.summary.status,
    result.summary.quantities,
    result.fields.map((field) => field.values),
    result.histories,
  ]);
}

function quantityOf(result: SimResult, name: string): number {
  const found = result.summary.quantities.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`the fan example result carries no "${name}"`);
  }
  return found.value;
}

/**
 * Runs the motor-driven fan walk: the cut-cell reserve's decline, the
 * compile through the geometry-aware door, and the 3D engine's
 * motor-driven run twice (determinism).
 */
export async function runSimFanExample(): Promise<SimFanExampleSummary> {
  const cutCell = compileSimScenarioWithGeometry({
    scenario: {
      ...fanExampleScenario(),
      flow3d: {
        boundaryTreatment: "cut-cell",
        rotation: {
          kind: "mrf",
          axisPointMm: [ROTOR_X, 5, 5],
          axisDirection: [1, 0, 0],
          zoneRadiusMm: 3.5,
          rpmMode: "motor",
          bladeCount: 4,
        },
      },
    },
    motor: FAN_EXAMPLE_MOTOR,
    tessellation: FAN_EXAMPLE_GEOMETRY,
  });
  const compiled = compileSimScenarioWithGeometry({
    scenario: fanExampleScenario(),
    motor: FAN_EXAMPLE_MOTOR,
    tessellation: FAN_EXAMPLE_GEOMETRY,
  });
  if (!compiled.ok) {
    throw new Error(
      `the fan example compile failed: ${compiled.error.message}`,
    );
  }
  const engine = createFlow3dSimEngine();
  const first = await engine.run({ compiled: compiled.value });
  if (!first.ok) {
    throw new Error(`the fan example run failed: ${first.error.message}`);
  }
  const second = await engine.run({ compiled: compiled.value });
  if (!second.ok) {
    throw new Error(
      `the fan example repeat run failed: ${second.error.message}`,
    );
  }
  const noLoadRadPerS = (FAN_EXAMPLE_MOTOR.noLoadSpeedRpm * 2 * Math.PI) / 60;
  return {
    cutCellDeclined: !cutCell.ok,
    operatingOmegaRadPerS: quantityOf(first.value, "operating-speed"),
    noLoadRadPerS,
    bladePassFrequencyHz: quantityOf(first.value, "blade-pass-frequency"),
    airflowM3PerS: quantityOf(first.value, "airflow"),
    pressureRisePa: quantityOf(first.value, "pressure-rise"),
    fanReynoldsTip: quantityOf(first.value, "fan-reynolds-tip"),
    flags: [...first.value.summary.regime.qualitative],
    loadCurveSamples:
      first.value.histories.find((series) => series.name === "load-torque")
        ?.samples.length ?? 0,
    deterministic: summaryJson(first.value) === summaryJson(second.value),
  };
}
