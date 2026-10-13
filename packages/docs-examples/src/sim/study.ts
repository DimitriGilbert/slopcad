/**
 * The Phase 70 optimization walks (the docs guide's runnable examples,
 * the `./structural` and `./fan` precedents): the roadmap's two named
 * demos, each a full NSGA-II campaign over the real engines —
 *
 * 1. **The lightest bracket that survives the load** — the 69
 *    L-bracket's `thickness`/`wallHeight` genome against the coarse
 *    voxel FEM engine, minimizing the run's own MASS scalar against
 *    maximizing its FACTOR OF SAFETY, with the slenderness constraint
 *    `12 * thickness - wallHeight` declining the thin-tall corner (a
 *    structured decline the engine counts as dominated, never a crash).
 *    Every front point is a bracket that survives the load at its own
 *    weight — the light end trades FoS for grams.
 * 2. **The most efficient fan** — the 66 box-duct fan with a
 *    parametric bore and the motor record AS A GENE (two torque-speed
 *    lines), maximizing AIRFLOW PER ELECTRICAL WATT at the FOUND
 *    operating point — the §7.9 motor-in-the-loop system objective.
 *
 * Machine-verified sentences (the suite asserts each): same seed →
 * same front (law S2/S5 determinism), the bracket front's dominated
 * structure (mass and FoS strictly increase together along it), the
 * constraint's violated candidates decline loudly, the champion replays
 * to its exact objective vector, and the Pareto CSV export is
 * deterministic bytes with its objective columns headed in the run's
 * own units.
 */

import {
  EMPTY_PARAMETER_COLLECTION,
  type DocumentMotorRecord,
  type ParameterCollection,
  type SimStudy,
  type SimStudyGene,
  addParameter,
  buildDocumentMotorBody,
  buildSimStudyBody,
  createMotorId,
  createParameterId,
  createSimulationId,
  createStudyId,
  length,
  parseExpression,
} from "@slopcad/cad-core";
import {
  type SimEngine,
  type SimResult,
  type SimTessellationWire,
} from "@slopcad/sim-core";
import { createFlow3dSimEngine } from "@slopcad/sim-flow";
import { createStructuralSimEngine } from "@slopcad/sim-structural";
import {
  type SimOptimizationHostServices,
  exportSimParetoCsv,
  replaySimCandidate,
  runSimOptimization,
} from "@slopcad/sim-optimization";

/** The steel record both bracket bodies carry (textbook values). */
const STEEL_RECORD = {
  id: "mat_steel",
  name: "Steel S235",
  densityGPerCm3: 7.85,
  youngsModulusPa: 210e9,
  poissonRatio: 0.3,
  yieldStrengthPa: 250e6,
} as const;

/** The bracket genome's parameter ids (the cad-jsx model's own). */
const BRACKET_THICKNESS = createParameterId("param_thickness");
const BRACKET_WALL_HEIGHT = createParameterId("param_wall-height");

/** The fan genome's parameter id (the duct's parametric bore). */
const FAN_BORE_HALF = createParameterId("param_bore-half");

/** One axis-aligned box as the voxelizer's tessellation wire. */
function boxWire(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): SimTessellationWire {
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
  parts: readonly SimTessellationWire[],
): SimTessellationWire {
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

/** Unwraps a parse result or throws (a guide example fails loud). */
function unwrap<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The study walk rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

/** Reads one quantity's value off a result's summary. */
function quantityOf(result: SimResult, name: string): number {
  const found = result.summary.quantities.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`The run's summary carries no "${name}" quantity.`);
  }
  return found.value;
}

// ---------------------------------------------------------------------------
// Walk 1 — the lightest bracket that survives the load
// ---------------------------------------------------------------------------

/** The bracket study's serialized scenario (the peg-height load). */
function bracketScenario(): Record<string, unknown> {
  return {
    name: "bracket-study-load",
    kind: "structural",
    domain: {
      kind: "explicit",
      min: [-60, -40, 0],
      max: [60, 40, 92],
      resolutionMm: 5,
    },
    conditions: [
      { kind: "fixed-support", face: "zMin" },
      {
        kind: "point-load",
        atWorldPointMm: [0, -36, 48],
        forceN: [0, -500, 0],
      },
    ],
    fluid: "air",
    materials: [
      { bodyId: "body_bracket-base", materialId: STEEL_RECORD.id },
      { bodyId: "body_bracket-wall", materialId: STEEL_RECORD.id },
    ],
    gravityMPerS2: [0, -9.80665, 0],
    structural: { selfWeight: false },
  };
}

/** The bracket walk's facts the guide states and the suite asserts. */
export interface SimStudyBracketSummary {
  /** The front's candidate count (≥ 2: the trade-off exists). */
  readonly frontSize: number;
  /** The campaign's evaluation and declined counts. */
  readonly evaluations: number;
  readonly declined: number;
  /** The constraint's decline code among the dominated candidates. */
  readonly constraintDeclineSeen: boolean;
  /** The front's mass span, kg (light end first, strictly increasing). */
  readonly massMinKg: number;
  readonly massMaxKg: number;
  /** The front's FoS span (strictly increasing with the mass). */
  readonly factorOfSafetyMin: number;
  readonly factorOfSafetyMax: number;
  /** The dominated-front structure: both orders strictly monotone. */
  readonly frontMonotone: boolean;
  /** Same seed → same front (law S2/S5). */
  readonly deterministic: boolean;
  /** The champion replays to its exact objective vector. */
  readonly replayIdentical: boolean;
  /** The Pareto CSV's header row (the objective columns in run units). */
  readonly csvHeader: string;
  /** The CSV's row count (one per front candidate). */
  readonly csvRows: number;
}

/** The bracket parameter table (the genome's address space). */
function bracketParameters(): ParameterCollection {
  const thickness = unwrap(
    addParameter(EMPTY_PARAMETER_COLLECTION, {
      id: BRACKET_THICKNESS,
      name: "thickness",
      value: length(8),
    }),
    "the thickness parameter",
  );
  return unwrap(
    addParameter(thickness, {
      id: BRACKET_WALL_HEIGHT,
      name: "wallHeight",
      value: length(80),
    }),
    "the wall-height parameter",
  );
}

/** The bracket study record: the mass-vs-FoS genome with the constraint. */
function bracketStudy(): SimStudy {
  const constraint = unwrap(
    parseExpression("12 * thickness - wallHeight"),
    "the slenderness constraint",
  );
  const built = unwrap(
    buildSimStudyBody(
      "lightest-bracket",
      createSimulationId("sim_bracket-study"),
      [
        {
          kind: "parameter",
          parameterId: BRACKET_THICKNESS,
          valueKind: "integer",
          min: 4,
          max: 16,
          step: 2,
        },
        {
          kind: "parameter",
          parameterId: BRACKET_WALL_HEIGHT,
          valueKind: "integer",
          min: 56,
          max: 88,
          step: 4,
        },
      ] satisfies readonly SimStudyGene[],
      [
        { quantity: "mass", direction: "minimize" },
        { quantity: "factor-of-safety", direction: "maximize" },
      ],
      [constraint],
      6,
      3,
      undefined,
      undefined,
      7,
      18,
    ),
    "the bracket study",
  );
  return { ...built, id: createStudyId("study_lightest-bracket") };
}

/** The bracket walk's host: the structural engine + the box-twin re-drive. */
function bracketHost(): SimOptimizationHostServices {
  return {
    engines: [createStructuralSimEngine() satisfies SimEngine],
    geometry: (candidate) => {
      const valueOf = (id: string): number =>
        candidate.parameters.parameters.find((entry) => entry.id === id)?.value
          .value ?? 0;
      return {
        bodyTessellations: [
          {
            bodyId: "body_bracket-base",
            tessellation: boxWire(
              [-60, -40, 0],
              [60, 40, valueOf(BRACKET_THICKNESS)],
            ),
          },
          {
            bodyId: "body_bracket-wall",
            tessellation: boxWire(
              [-60, -40, 0],
              [60, -32, valueOf(BRACKET_WALL_HEIGHT)],
            ),
          },
        ],
      };
    },
  };
}

/**
 * Runs one campaign through the 70a driver and returns its result — a
 * campaign that aborted (no front) fails loud (the docs convention).
 */
async function campaignOf(
  context: Parameters<typeof runSimOptimization>[0],
  host: SimOptimizationHostServices,
): Promise<
  NonNullable<Awaited<ReturnType<typeof runSimOptimization>>["result"]>
> {
  const outcome = await runSimOptimization(context, host);
  if (outcome.result === undefined) {
    throw new Error("The campaign aborted before a front settled.");
  }
  return outcome.result;
}

/** Runs the lightest-bracket walk and returns the stated facts. */
export async function runSimStudyBracketExample(): Promise<SimStudyBracketSummary> {
  const study = bracketStudy();
  const context = {
    study,
    scenario: bracketScenario(),
    parameters: bracketParameters(),
    motors: [] as readonly DocumentMotorRecord[],
    materials: [STEEL_RECORD],
  };
  const host = bracketHost();
  const first = await campaignOf(context, host);
  const front = [...first.pareto].sort(
    (left, right) => (left.objectives[0] ?? 0) - (right.objectives[0] ?? 0),
  );
  const frontMonotone = front.every((candidate, index) => {
    if (index === 0) return true;
    const previous = front[index - 1];
    if (previous === undefined) return false;
    return (
      (candidate.objectives[0] ?? 0) > (previous.objectives[0] ?? 0) &&
      (candidate.objectives[1] ?? 0) > (previous.objectives[1] ?? 0)
    );
  });
  // Determinism: the same seed re-runs to the identical front bytes.
  const repeat = await campaignOf(context, bracketHost());
  const deterministic =
    JSON.stringify(repeat.pareto) === JSON.stringify(first.pareto);
  // Replay: the champion (the lightest survivor) re-produces its vector.
  const champion = front[0];
  if (champion === undefined) throw new Error("The bracket front is empty.");
  const replay = await replaySimCandidate(context, host, champion);
  const replayIdentical =
    replay.ok &&
    replay.value.status === "ok" &&
    replay.value.objectives.length === champion.objectives.length &&
    replay.value.objectives.every(
      (value, index) => value === champion.objectives[index],
    );
  // The constraint's decline among the campaign's dominated candidates.
  const constraintDeclineSeen = first.generations.some((generation) =>
    generation.candidates.some(
      (candidate) =>
        candidate.status === "declined" &&
        candidate.declineCode === "sim/optimization-constraint-violated",
    ),
  );
  const csv = unwrap(
    exportSimParetoCsv(first.pareto, {
      objectives: [
        { name: "mass", unit: "kg" },
        { name: "factor-of-safety", unit: "1" },
      ],
      geneParameters: [BRACKET_THICKNESS, BRACKET_WALL_HEIGHT],
      geneRecords: [],
    }),
    "the bracket Pareto CSV",
  );
  const championMass = champion.objectives[0] ?? 0;
  const heaviest = front[front.length - 1];
  return {
    frontSize: front.length,
    evaluations: first.evaluations,
    declined: first.declined,
    constraintDeclineSeen,
    massMinKg: championMass,
    massMaxKg: heaviest?.objectives[0] ?? championMass,
    factorOfSafetyMin: champion.objectives[1] ?? 0,
    factorOfSafetyMax: heaviest?.objectives[1] ?? 0,
    frontMonotone,
    deterministic,
    replayIdentical,
    csvHeader: csv.split("\n")[0] ?? "",
    csvRows: csv.trimEnd().split("\n").length - 1,
  };
}

// ---------------------------------------------------------------------------
// Walk 2 — the most efficient fan (motor + fan co-optimization)
// ---------------------------------------------------------------------------

/** The fan example's torque-speed pair: the §7.9 motor gene's choices. */
function fanStudyMotors(): readonly DocumentMotorRecord[] {
  const speedy = unwrap(
    buildDocumentMotorBody(
      "example speedy motor",
      "dc-brushed",
      8e-7,
      80,
      12,
      undefined,
      undefined,
    ),
    "the speedy motor",
  );
  const torquey = unwrap(
    buildDocumentMotorBody(
      "example torquey motor",
      "dc-brushed",
      1.6e-6,
      40,
      12,
      undefined,
      undefined,
    ),
    "the torquey motor",
  );
  return [
    { ...speedy, id: createMotorId("mot_speedy") },
    { ...torquey, id: createMotorId("mot_torquey") },
  ];
}

/** The fan study's serialized scenario (the 3D motor-driven stance). */
function fanScenario(motorId: string): Record<string, unknown> {
  return {
    name: "fan-study",
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
        axisPointMm: [12, 6, 6],
        axisDirection: [1, 0, 0],
        zoneRadiusMm: 3.5,
        rpmMode: "motor",
        bladeCount: 4,
      },
    },
    motorId,
  };
}

/** The fan walk's facts the guide states and the suite asserts. */
export interface SimStudyFanSummary {
  /** The campaign's evaluation count and declined count. */
  readonly evaluations: number;
  readonly declined: number;
  /** The champion's air-per-electrical-watt, m³/J (the objective). */
  readonly championAirPerWatt: number;
  /** The champion's found operating point, rpm. */
  readonly championOperatingRpm: number;
  /** The champion's motor choice (the gene's record id). */
  readonly championMotorId: string;
  /** Every scored candidate's summary carries the objective quantity. */
  readonly objectiveProjected: boolean;
  /** Same seed → same front (law S2/S5). */
  readonly deterministic: boolean;
  /** The champion replays to its exact objective vector. */
  readonly replayIdentical: boolean;
}

/** The fan study record: the bore gene + the motor gene, one objective. */
function fanStudy(): SimStudy {
  const built = unwrap(
    buildSimStudyBody(
      "most-efficient-fan",
      createSimulationId("sim_fan-study"),
      [
        {
          kind: "parameter",
          parameterId: FAN_BORE_HALF,
          valueKind: "decimal",
          min: 2.5,
          max: 4,
          step: 0.5,
        },
        {
          kind: "discrete",
          recordKind: "motor",
          choices: [createMotorId("mot_speedy"), createMotorId("mot_torquey")],
        },
      ] satisfies readonly SimStudyGene[],
      [{ quantity: "airflow-per-electrical-watt", direction: "maximize" }],
      [],
      4,
      2,
      undefined,
      undefined,
      11,
      12,
    ),
    "the fan study",
  );
  return { ...built, id: createStudyId("study_most-efficient-fan") };
}

/** The fan parameter table (the bore's literal). */
function fanParameters(): ParameterCollection {
  return unwrap(
    addParameter(EMPTY_PARAMETER_COLLECTION, {
      id: FAN_BORE_HALF,
      name: "boreHalf",
      value: length(4),
    }),
    "the bore parameter",
  );
}

/**
 * The fan walk's geometry re-drive: the box duct's walls positioned by
 * the re-driven bore half-width around the duct's 6 mm centre — the
 * bore gene's honest effect (the rotor stays fixed, the duct breathes).
 */
function fanGeometry(
  candidate: Parameters<
    NonNullable<SimOptimizationHostServices["geometry"]>
  >[0],
): { readonly tessellation: SimTessellationWire } {
  const boreHalf =
    candidate.parameters.parameters.find((entry) => entry.id === FAN_BORE_HALF)
      ?.value.value ?? 4;
  const inner = 6 - boreHalf;
  const outer = 6 + boreHalf;
  return {
    tessellation: mergedWire([
      boxWire([0, 0, 0], [24, inner, 12]),
      boxWire([0, outer, 0], [24, 12, 12]),
      boxWire([0, inner, 0], [24, outer, inner]),
      boxWire([0, inner, outer], [24, outer, 12]),
      boxWire([11, 4.6, 4.6], [13, 7.4, 7.4]),
      boxWire([11.4, 3.4, 5.6], [12.6, 8.6, 6.4]),
      boxWire([11.4, 5.6, 3.4], [12.6, 6.4, 8.6]),
    ]),
  };
}

/** Runs the most-efficient-fan walk and returns the stated facts. */
export async function runSimStudyFanExample(): Promise<SimStudyFanSummary> {
  const motors = fanStudyMotors();
  const study = fanStudy();
  const context = {
    study,
    scenario: fanScenario("mot_speedy"),
    parameters: fanParameters(),
    motors,
  };
  const host: SimOptimizationHostServices = {
    engines: [createFlow3dSimEngine()],
    geometry: fanGeometry,
  };
  const outcome = await runSimOptimization(context, host);
  if (outcome.result === undefined || outcome.candidateResults === undefined) {
    throw new Error("The fan campaign aborted before a front settled.");
  }
  const first = outcome.result;
  const scored = first.pareto.filter((candidate) => candidate.status === "ok");
  const champion = [...scored].sort(
    (left, right) => (right.objectives[0] ?? 0) - (left.objectives[0] ?? 0),
  )[0];
  if (champion === undefined) {
    throw new Error("The fan campaign scored no candidate.");
  }
  const championResult = outcome.candidateResults.get(champion.index);
  if (championResult === undefined) {
    throw new Error("The fan champion carries no solve result.");
  }
  const objectiveProjected = scored.every((candidate) => {
    const result = outcome.candidateResults?.get(candidate.index);
    return (
      result !== undefined &&
      result.summary.quantities.some(
        (entry) => entry.name === "airflow-per-electrical-watt",
      )
    );
  });
  const repeat = await campaignOf(context, {
    engines: [createFlow3dSimEngine()],
    geometry: fanGeometry,
  });
  const deterministic =
    JSON.stringify(repeat.pareto) === JSON.stringify(first.pareto);
  const replay = await replaySimCandidate(context, host, champion);
  const replayIdentical =
    replay.ok &&
    replay.value.status === "ok" &&
    replay.value.objectives.length === champion.objectives.length &&
    replay.value.objectives.every(
      (value, index) => value === champion.objectives[index],
    );
  return {
    evaluations: first.evaluations,
    declined: first.declined,
    championAirPerWatt: champion.objectives[0] ?? 0,
    championOperatingRpm: quantityOf(championResult, "operating-rpm"),
    championMotorId: champion.genomeRecords[0]?.recordId ?? "",
    objectiveProjected,
    deterministic,
    replayIdentical,
  };
}
