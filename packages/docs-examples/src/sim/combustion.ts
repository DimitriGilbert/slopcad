/**
 * The Phase 68 combustion walk (the docs guide's runnable example, the
 * `./thermal` precedent): the premixed (Otto) engine — the roadmap's
 * named deliverable — authored as a document scenario record, compiled
 * through the geometry-aware door (the engine mode needs NO geometry:
 * the 0D chamber's domain is its authored slider-crank stance), and run
 * through the REAL combustion engine behind the Phase 61 contract: the
 * base case (the P-vs-crank trace, IMEP, the brake family beside the
 * indicated, the closing energy audit, the knock report) plus ONE
 * spark-timing sweep (the efficiency trend and the knock boundary).
 *
 * Machine-verified sentences (the suite asserts each): the record is
 * kind-locked (a combustion scenario without its stance declines),
 * spray is declined at the chemistry door (`sim/combustion-mode-
 * unsupported`, never approximated), IMEP lands in the SI band with
 * BMEP below it by the friction overlay, the loss family closes the
 * audit (fuel = brake + exhaust + wall), the trace carries the closed
 * cycle's samples, the sweep's rows carry the trend and the knock
 * boundary, and the engine is deterministic (identical summaries on
 * repeat runs).
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
import { runOttoCycle } from "@slopcad/sim-combustion";
import { createCombustionSimEngine } from "@slopcad/sim-combustion";

/** The serialized engine-mode record — the base Otto case. */
function ottoScenario(overrides?: {
  readonly combustion?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: "otto",
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
    ...(overrides?.combustion === undefined
      ? {}
      : { combustion: overrides.combustion }),
  };
}

/** The demo stance: the 0.5 L single at CR 10, 1500 rpm, WOT φ = 1. */
function engineStance(): Record<string, unknown> {
  return {
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
    sweep: { kind: "sparkTiming", from: 10, to: 50, steps: 6 },
  };
}

/** The combustion walk's stated facts. */
export interface SimCombustionExampleSummary {
  /** The record-boundary decline a combustion scenario without a stance earns. */
  readonly stanceDeclined: boolean;
  /** The chemistry door's spray decline code (spray declined at every level). */
  readonly sprayDeclineCode: string;
  /** The base case's gross IMEP, Pa. */
  readonly imepPa: number;
  /** The brake family's BMEP, Pa (below IMEP by the friction overlay). */
  readonly bmepPa: number;
  /** The audit residual over the fuel energy, |J|/J (the closing balance). */
  readonly auditRelative: number;
  /** The knock integral's comparative maximum (Livengood–Wu). */
  readonly knockIntegralMax: number;
  /** The P-vs-crank trace's sample count (the closed cycle's grid). */
  readonly traceSamples: number;
  /** The spark sweep's row count. */
  readonly sweepRows: number;
  /** The sweep's knock boundary — the first advance past integral 1, deg. */
  readonly knockBoundaryDeg: number | undefined;
  /** Determinism: the engine's summaries are identical on repeat runs. */
  readonly deterministic: boolean;
}

function summaryJson(result: SimResult): string {
  return JSON.stringify([
    result.summary.status,
    result.summary.quantities,
    result.histories,
  ]);
}

/** Runs the guide's combustion walk and returns the stated facts. */
export async function runSimCombustionExample(): Promise<SimCombustionExampleSummary> {
  // The kind-lock: a combustion record without its stance declines at
  // the document boundary — the sentence the suite asserts.
  const added = addDocumentSimulation(
    createDocument(createDocumentId("doc_otto")),
    {
      name: "Otto",
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
    },
  );
  const stanceDeclined = !added.ok;

  // The scope boundary: spray is declined at the chemistry door itself
  // — the 0D cycle never approximates a mixing-controlled burn.
  const spray = runOttoCycle({
    ...{
      fuel: "C8H18-ISO",
      geometry: {
        boreM: 0.086,
        crankRadiusM: 0.043,
        rodLengthM: 0.143,
        compressionRatio: 10,
      },
      speedRpm: 1500,
      charge: { intakePressureBar: 1, intakeTK: 300, equivalenceRatio: 1 },
      spark: { timingBTDCDeg: 25 },
      wallHeat: { mode: "adiabatic" },
    },
    combustionMode: "spray",
  });
  if (spray.ok) {
    throw new Error("The spray combustion mode was not declined.");
  }
  const sprayDeclineCode = spray.error.code;

  // The base case + its sweep, through the real compile door and the
  // real engine.
  const compiled = compileSimScenarioWithGeometry({
    scenario: ottoScenario({ combustion: engineStance() }),
  });
  if (!compiled.ok) {
    throw new Error(
      `The Otto case did not compile: ${compiled.error.code}: ${compiled.error.message}`,
    );
  }
  const engine = createCombustionSimEngine();
  const run = await engine.run({ compiled: compiled.value });
  if (!run.ok) {
    throw new Error(
      `The Otto case did not run: ${run.error.code}: ${run.error.message}`,
    );
  }
  const quantityOf = (name: string): number => {
    const found = run.value.summary.quantities.find(
      (quantity) => quantity.name === name,
    );
    if (found === undefined) {
      throw new Error(`The run's summary carries no "${name}" quantity.`);
    }
    return found.value;
  };
  const imepPa = quantityOf("imep");
  const bmepPa = quantityOf("bmep");
  const auditRelative =
    Math.abs(quantityOf("audit-residual")) / quantityOf("fuel-chemical-energy");
  const knockIntegralMax = quantityOf("knock-integral-max");
  const trace =
    run.value.histories.find((series) => series.name === "pressure")?.samples
      .length ?? 0;
  const sweepAxis =
    run.value.histories.find(
      (series) => series.name === "sweep:spark-timing-btdc",
    )?.samples ?? [];
  const sweepRows = sweepAxis.length;
  const sweepKnock =
    run.value.histories.find((series) => series.name === "sweep:knock-integral")
      ?.samples ?? [];
  let knockBoundaryDeg: number | undefined;
  for (const [index, integral] of sweepKnock.entries()) {
    if (integral >= 1) {
      knockBoundaryDeg = sweepAxis[index];
      break;
    }
  }

  // Determinism: the same compiled problem, the bitwise-identical
  // summary and histories.
  const repeat = await engine.run({ compiled: compiled.value });
  if (!repeat.ok) {
    throw new Error(
      `The Otto repeat did not run: ${repeat.error.code}: ${repeat.error.message}`,
    );
  }
  const deterministic = summaryJson(repeat.value) === summaryJson(run.value);

  return {
    stanceDeclined,
    sprayDeclineCode,
    imepPa,
    bmepPa,
    auditRelative,
    knockIntegralMax,
    traceSamples: trace,
    sweepRows,
    knockBoundaryDeg,
    deterministic,
  };
}
