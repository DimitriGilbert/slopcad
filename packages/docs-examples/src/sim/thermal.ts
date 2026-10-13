/**
 * The Phase 65 thermal walk (the docs guide's runnable example, the
 * `./gallery` precedent): the stove — a heated solid conducting through
 * its wall and losing to air, WITHOUT fire — authored as a document
 * scenario record, compiled through the geometry-aware door (per-body
 * tessellations + material records), and run through BOTH real engines
 * behind the Phase 61 contract:
 *
 * - the SEALED conduction mode (`@slopcad/sim-thermal`'s engine): the
 *   steady equilibrium the §7.12 ruling demands — the source meets the
 *   ambient convection + linearized radiation losses at the settled
 *   wall temperature, and the MEASURED energy balance closes;
 * - the COUPLED mode (`@slopcad/sim-flow`'s CHT engine): the transient
 *   buoyant plume — the fluid warms above its initial field and moves,
 *   and the conservative march's energy ledger rides the summary.
 *
 * Machine-verified sentences (the suite asserts each): the record is
 * kind-locked (a thermal scenario without its stance declines), the
 * settled wall sits above ambient inside a physical band, the balance
 * closes within the audit's band, the plume warms the air, and both
 * engines are deterministic (identical summaries on repeat runs).
 */

import {
  addDocumentSimulation,
  createDocument,
  createDocumentId,
} from "@slopcad/cad-core";
import {
  compileSimScenarioWithGeometry,
  type SimResult,
} from "@slopcad/sim-core";
import { createChtSimEngine } from "@slopcad/sim-flow";
import { createThermalSimEngine } from "@slopcad/sim-thermal";

/** The stove's bar: an aligned box inside the room domain, mm. */
function boxTessellationWire(
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

const BAR = boxTessellationWire([40, 15, 0], [60, 25, 10]);

/** The steel record the scenario's assignment names (textbook values). */
const STEEL_RECORD = {
  id: "mat_steel",
  name: "Steel",
  densityGPerCm3: 7.8,
  thermalConductivityWPerMK: 45,
  specificHeatJPerKgK: 466,
  emissivity: 0.6,
};

/** The serialized stove record — the sealed steady stance. */
function stoveScenario(overrides?: {
  readonly thermal?: Record<string, unknown>;
  readonly conditions?: readonly unknown[];
}): Record<string, unknown> {
  return {
    name: "stove",
    kind: "thermal",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: overrides?.conditions ?? [],
    fluid: "air",
    materials: [{ bodyId: "body_bar", materialId: "mat_steel" }],
    thermal: overrides?.thermal ?? {
      radiationMode: "linearized",
      solveMode: "steady",
      cht: false,
      sourceW: 8,
      initialTemperatureK: 293.15,
      ambientConvectionWPerM2K: 5,
    },
  };
}

function compileStove(
  scenario: Record<string, unknown>,
): ReturnType<typeof compileSimScenarioWithGeometry> {
  return compileSimScenarioWithGeometry({
    scenario,
    materials: [STEEL_RECORD],
    bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
  });
}

/** The sealed-stove facts the guide states and the suite asserts. */
export interface SimThermalExampleSummary {
  /** The record-boundary decline a thermal scenario without a stance earns. */
  readonly stanceDeclined: boolean;
  /** The settled wall's maximum temperature, K. */
  readonly settledMaxK: number;
  /** The measured net heat imbalance over the source power, |W|/W. */
  readonly balanceRelative: number;
  /** The temperature field block's id. */
  readonly fieldId: string;
  /** The coupled plume's peak fluid temperature, K. */
  readonly plumeFluidMaxK: number;
  /** The coupled march's measured ledger closure over its term scale. */
  readonly plumeClosureRelative: number;
  /** Determinism: both engines' summaries are identical on repeat runs. */
  readonly deterministic: boolean;
}

function summaryJson(result: SimResult): string {
  return JSON.stringify([
    result.summary.status,
    result.summary.quantities,
    result.fields.map((field) => field.values),
  ]);
}

/** Runs the guide's thermal walk and returns the stated facts. */
export async function runSimThermalExample(): Promise<SimThermalExampleSummary> {
  // The kind-lock: a thermal record without its stance declines at the
  // document boundary — the sentence the suite asserts.
  const added = addDocumentSimulation(
    createDocument(createDocumentId("doc_stove")),
    {
      name: "Stove",
      kind: "thermal",
      domain: {
        kind: "explicit",
        min: [0, 0, 0],
        max: [100, 40, 10],
        resolutionMm: 5,
      },
      conditions: [],
      fluid: "air",
      materials: [],
    },
  );
  const stanceDeclined = !added.ok;

  // The sealed equilibrium: source = convection + radiation at the
  // settled wall, measured by the audit the engine persists.
  const sealed = compileStove(stoveScenario());
  if (!sealed.ok) {
    throw new Error(
      `The sealed stove did not compile: ${sealed.error.code}: ${sealed.error.message}`,
    );
  }
  const thermalEngine = createThermalSimEngine();
  const sealedRun = await thermalEngine.run({ compiled: sealed.value });
  if (!sealedRun.ok) {
    throw new Error(
      `The sealed stove did not run: ${sealedRun.error.code}: ${sealedRun.error.message}`,
    );
  }
  const quantityOf = (result: SimResult, name: string): number => {
    const found = result.summary.quantities.find(
      (quantity) => quantity.name === name,
    );
    if (found === undefined) {
      throw new Error(`The run's summary carries no "${name}" quantity.`);
    }
    return found.value;
  };
  const settledMaxK = quantityOf(sealedRun.value, "max-temperature");
  const sourceW = quantityOf(sealedRun.value, "source-power");
  const imbalanceW = Math.abs(
    quantityOf(sealedRun.value, "net-heat-imbalance"),
  );
  const fieldId = sealedRun.value.fields[0]?.id ?? "";

  // The coupled plume: the same stove with the buoyancy flag — the
  // fixed-temperature room walls at ambient are its loss path.
  const coupled = compileStove(
    stoveScenario({
      thermal: {
        radiationMode: "off",
        solveMode: "transient",
        cht: true,
        sourceW: 8,
        initialTemperatureK: 293.15,
        ambientConvectionWPerM2K: 5,
        durationS: 10,
        sampleIntervalS: 2,
      },
      conditions: [
        { kind: "fixed-temperature", face: "xMin", temperatureK: 293.15 },
        { kind: "fixed-temperature", face: "xMax", temperatureK: 293.15 },
        { kind: "fixed-temperature", face: "yMin", temperatureK: 293.15 },
        { kind: "fixed-temperature", face: "yMax", temperatureK: 293.15 },
      ],
    }),
  );
  if (!coupled.ok) {
    throw new Error(
      `The coupled stove did not compile: ${coupled.error.code}: ${coupled.error.message}`,
    );
  }
  const chtEngine = createChtSimEngine();
  const coupledRun = await chtEngine.run({ compiled: coupled.value });
  if (!coupledRun.ok) {
    throw new Error(
      `The coupled stove did not run: ${coupledRun.error.code}: ${coupledRun.error.message}`,
    );
  }
  const plumeFluidMaxK = quantityOf(coupledRun.value, "fluid-temperature-max");
  const closure = Math.abs(quantityOf(coupledRun.value, "energy-closure"));
  const plumeScale =
    Math.abs(quantityOf(coupledRun.value, "solid-source-energy")) +
    Math.abs(quantityOf(coupledRun.value, "fluid-boundary-energy-in"));

  // Determinism: both engines, repeated, produce identical summaries.
  const sealedRepeat = await thermalEngine.run({ compiled: sealed.value });
  const coupledRepeat = await chtEngine.run({ compiled: coupled.value });
  const deterministic =
    sealedRepeat.ok &&
    coupledRepeat.ok &&
    summaryJson(sealedRepeat.value) === summaryJson(sealedRun.value) &&
    summaryJson(coupledRepeat.value) === summaryJson(coupledRun.value);

  return {
    stanceDeclined,
    settledMaxK,
    balanceRelative: imbalanceW / sourceW,
    fieldId,
    plumeFluidMaxK,
    plumeClosureRelative: plumeScale > 0 ? closure / plumeScale : 0,
    deterministic,
  };
}
