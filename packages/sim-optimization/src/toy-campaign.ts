/**
 * The analytic toy document of Phase 70a's test suite (the roadmap's own
 * validation bullet: "a study whose optimum is known in closed form on a
 * toy document"). A `flow` scenario over an explicit 1 mm-resolution
 * domain; the geometry gene pair (width, height) re-drives a flat
 * rectangular plate tessellation through the host geometry seam; the toy
 * engine counts the voxelized slice's occupied cells and projects
 *
 * - `mass` = cells · cellArea · depth · density      (g, monotone ↑ in cells)
 * - `deflection` = 1e6 / cells                        (mm, monotone ↓ in cells)
 * - `air-per-watt` = 10 · stallTorque                 (dimensionless, motor-gene)
 *
 * so the single-objective story has the closed form min mass = k · min
 * cells (the constraint boundary), and the two-objective story is a
 * Schaffer front: mass · deflection = 1e6 · k constant on every
 * non-dominated point, all of them distinct cell counts. The staircase is
 * exact for integral plates aligned to the 1 mm grid — the honest
 * baseline; fractional plates step it (the caveat's own demonstration).
 */

import {
  type DocumentMotorRecord,
  type ParameterCollection,
  type SimStudy,
  type SimStudyGene,
  EMPTY_PARAMETER_COLLECTION,
  addParameter,
  buildDocumentMotorBody,
  buildSimScenarioBody,
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
  type SimEngineRequest,
  type SimError,
  SIM_ERROR_CODES,
  SIM_RESULT_SUMMARY_VERSION,
  type SimResult,
  type SimTessellationWire,
  simError,
  type SimParseResult,
} from "@slopcad/sim-core";

/** The toy domain: a 50 × 50 mm slab at 1 mm resolution, 10 mm deep. */
export const TOY_DOMAIN_MM = 50;
/** The plate depth every toy candidate extrudes to, mm. */
export const TOY_PLATE_DEPTH_MM = 10;
/** The plate material's density, g/mm³ (1 g/cm³). */
export const TOY_DENSITY_G_PER_MM3 = 0.001;
/** The toy study's parameter ids. */
export const toyWidthId = createParameterId("param_width");
export const toyHeightId = createParameterId("param_height");
/** The toy motor choices (a discrete gene's named records). */
export const toyMotorA = createMotorId("mot_torquey");
export const toyMotorB = createMotorId("mot_speedy");
export const toyScenarioId = createSimulationId("sim_toy-tunnel");
export const toyStudyId = createStudyId("study_toy");

/** The plate tessellation of a w × h mm footprint at the slab's mid-plane. */
export function toyPlateTessellation(
  widthMm: number,
  heightMm: number,
): SimTessellationWire {
  // A closed triangular-prism box (12 triangles) centered at the origin,
  // spanning the full depth so the mid-plane slice is the exact footprint.
  const w = widthMm / 2;
  const h = heightMm / 2;
  const z0 = -TOY_PLATE_DEPTH_MM / 2;
  const z1 = TOY_PLATE_DEPTH_MM / 2;
  const positions: number[] = [];
  const corner = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const a = corner(-w, -h, z0);
  const b = corner(w, -h, z0);
  const c = corner(w, h, z0);
  const d = corner(-w, h, z0);
  const e = corner(-w, -h, z1);
  const f = corner(w, -h, z1);
  const g = corner(w, h, z1);
  const i = corner(-w, h, z1);
  const indices: number[] = [
    // bottom (z0), outward −z
    a,
    c,
    b,
    a,
    d,
    c,
    // top (z1), outward +z
    e,
    f,
    g,
    e,
    g,
    i,
    // sides
    a,
    b,
    f,
    a,
    f,
    e,
    b,
    c,
    g,
    b,
    g,
    f,
    c,
    d,
    i,
    c,
    i,
    g,
    d,
    a,
    e,
    d,
    e,
    i,
  ];
  return { positions, indices };
}

/** The toy motor records. */
export function toyMotors(): readonly DocumentMotorRecord[] {
  const torquey = buildDocumentMotorBody(
    "torquey",
    "dc-brushed",
    80,
    4000,
    12,
    undefined,
    undefined,
  );
  if (!torquey.ok) throw new Error(torquey.error.message);
  const speedy = buildDocumentMotorBody(
    "speedy",
    "bldc",
    20,
    20000,
    24,
    undefined,
    undefined,
  );
  if (!speedy.ok) throw new Error(speedy.error.message);
  return [
    { ...torquey.value, id: toyMotorA },
    { ...speedy.value, id: toyMotorB },
  ];
}

/** The serialized toy scenario (a 2D flow tunnel over the slab). */
export function toyScenario(): unknown {
  const built = buildSimScenarioBody(
    "toy-tunnel",
    "flow",
    {
      kind: "explicit",
      min: [-TOY_DOMAIN_MM / 2, -TOY_DOMAIN_MM / 2, -TOY_PLATE_DEPTH_MM / 2],
      max: [TOY_DOMAIN_MM / 2, TOY_DOMAIN_MM / 2, TOY_PLATE_DEPTH_MM / 2],
      resolutionMm: 1,
    },
    [],
    "air",
    [],
    [0, -9.80665, 0],
    undefined,
    "cpu",
    24,
    undefined,
  );
  if (!built.ok) throw new Error(built.error.message);
  return {
    name: built.value.name,
    kind: built.value.kind,
    domain: built.value.domain,
    conditions: built.value.conditions,
    fluid: built.value.fluid,
    materials: built.value.materials,
    gravityMPerS2: built.value.gravityMPerS2,
    stepBudget: built.value.stepBudget,
    backend: built.value.backend,
  };
}

/** Builds the toy study over the width/height genes. */
export function toyStudy(options: {
  readonly objectives: readonly {
    quantity: string;
    direction: "minimize" | "maximize";
  }[];
  readonly constraints?: readonly string[];
  readonly motorGene?: boolean;
  readonly population?: number;
  readonly generations?: number;
  readonly seed?: number;
  readonly maxEvaluations?: number;
}): SimStudy {
  const constraints = (options.constraints ?? []).map((source) => {
    const parsed = parseExpression(source);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  });
  const genes: SimStudyGene[] = [
    {
      kind: "parameter",
      parameterId: toyWidthId,
      valueKind: "integer",
      min: 2,
      max: 30,
    },
    {
      kind: "parameter",
      parameterId: toyHeightId,
      valueKind: "integer",
      min: 2,
      max: 30,
    },
  ];
  if (options.motorGene === true) {
    genes.push({
      kind: "discrete",
      recordKind: "motor",
      choices: [toyMotorA, toyMotorB],
    });
  }
  const built = buildSimStudyBody(
    "toy study",
    toyScenarioId,
    genes,
    options.objectives,
    constraints,
    options.population ?? 12,
    options.generations ?? 6,
    undefined,
    undefined,
    options.seed ?? 7,
    options.maxEvaluations,
  );
  if (!built.ok) throw new Error(built.error.message);
  return { ...built.value, id: toyStudyId };
}

/** The toy document's literal width/height parameter table. */
export function toyParameterTable(
  widthMm: number,
  heightMm: number,
): ParameterCollection {
  const width = addParameter(EMPTY_PARAMETER_COLLECTION, {
    id: toyWidthId,
    name: "width",
    value: length(widthMm),
  });
  if (!width.ok) throw new Error(width.error.message);
  const height = addParameter(width.value, {
    id: toyHeightId,
    name: "height",
    value: length(heightMm),
  });
  if (!height.ok) throw new Error(height.error.message);
  return height.value;
}

/**
 * The toy engine: solves `flow` (cpu), counts the compiled occupancy
 * slice's occupied cells, and projects the closed-form quantities. An
 * optional refusal predicate injects structured declines (the
 * decline-handling fixtures) without ever throwing.
 */
export function createToyMassEngine(options: {
  readonly refuseWhen?: (cells: number) => boolean;
}): SimEngine {
  return {
    id: "toy-mass",
    supportedKinds: ["flow"],
    backend: "cpu",
    async run(
      request: SimEngineRequest,
      onProgress?,
    ): Promise<SimParseResult<SimResult, SimError>> {
      const compiled = request.compiled;
      if (compiled.kind !== "flow") {
        return {
          ok: false,
          error: simError(
            SIM_ERROR_CODES.scenarioKindUnsupported,
            `The toy engine does not solve "${compiled.kind}".`,
            compiled.kind,
          ),
        };
      }
      await Promise.resolve();
      onProgress?.({ step: 1, totalSteps: 1 });
      const slice = compiled.occupancySlice;
      const cells =
        slice === undefined
          ? 0
          : slice.cells.reduce((sum, value) => sum + value, 0);
      if (options.refuseWhen?.(cells) === true) {
        return {
          ok: false,
          error: simError(
            SIM_ERROR_CODES.runDiverged,
            `The toy engine refuses ${String(cells)} cells by fixture design.`,
            cells,
          ),
        };
      }
      const cellAreaMm2 = slice
        ? slice.spacingM[0] * 1000 * (slice.spacingM[1] * 1000)
        : 1;
      const mass =
        cells * cellAreaMm2 * TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3;
      const stallTorque =
        compiled.motor === undefined
          ? undefined
          : compiled.motor.kind === "tabulated"
            ? undefined
            : compiled.motor.stallTorqueNPerM;
      const result: SimResult = {
        summary: {
          schemaVersion: SIM_RESULT_SUMMARY_VERSION,
          scenarioSnapshotHash: compiled.scenarioSnapshotHash,
          status: "completed",
          regime: compiled.regime,
          quantities: [
            { name: "mass", value: mass, unit: "g" },
            {
              name: "deflection",
              value: cells === 0 ? 1e9 : 1e6 / cells,
              unit: "mm",
            },
            ...(stallTorque === undefined
              ? []
              : [
                  {
                    name: "air-per-watt",
                    value: 10 * stallTorque,
                    unit: "1",
                  },
                ]),
          ],
        },
        fields: [],
        histories: [],
      };
      return { ok: true, value: result };
    },
  };
}

/** The toy host's geometry re-drive: the plate sized by the gene values. */
export function toyGeometryProvider(): (candidate: {
  readonly parameters: ParameterCollection;
  readonly motor: DocumentMotorRecord | undefined;
}) => { readonly tessellation: SimTessellationWire } {
  return (candidate) => {
    const width =
      candidate.parameters.parameters.find((p) => p.id === toyWidthId)?.value
        .value ?? 10;
    const height =
      candidate.parameters.parameters.find((p) => p.id === toyHeightId)?.value
        .value ?? 10;
    return {
      tessellation: toyPlateTessellation(Number(width), Number(height)),
    };
  };
}
