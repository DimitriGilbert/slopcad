/**
 * The Phase 69 structural walk (the docs guide's runnable example, the
 * `./thermal` precedent): the L-bracket — the same two-body geometry
 * the `/workbench-sim` bracket demo voxelizes (`./cadjsx/bracket`'s
 * authored numbers) — authored as a document scenario record, compiled
 * through the geometry-aware door (the FULL-3D per-body voxelization
 * with its per-node material map), and run through the real coarse
 * voxel FEM engine behind the Phase 61 contract.
 *
 * Machine-verified sentences (the suite asserts each): the record is
 * kind-locked (a structural scenario without its stance declines), the
 * run reports the machine-readable scalar family Phase 70 optimizes
 * against (max deflection, von Mises, the factor of safety against
 * yield), both overlay blocks persist (displacement in mm, von Mises in
 * Pa), the thermal chain makes the bracket HOT (the CHT→structural
 * seam: a supplied temperature field as ΔT against the reference), the
 * centrifugal stance spins the body force (ω from the authored rpm),
 * and the engine is deterministic (the identical summary on a repeat
 * run — law S2).
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
import { createStructuralSimEngine } from "@slopcad/sim-structural";

import { BRACKET } from "../cadjsx/bracket";

/** An axis-aligned box's triangle soup, mm (the voxelizer's wire form). */
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

/** The steel record the scenario's assignments name (textbook values). */
const STEEL_RECORD = {
  id: "mat_steel",
  name: "Steel S235",
  densityGPerCm3: 7.85,
  youngsModulusPa: 210e9,
  poissonRatio: 0.3,
  yieldStrengthPa: 250e6,
  thermalExpansionPerK: 1.2e-5,
} as const;

/** The serialized bracket record — the dry demo stance. */
function bracketScenario(overrides?: {
  readonly structural?: Record<string, unknown>;
  readonly conditions?: readonly unknown[];
}): Record<string, unknown> {
  return {
    name: "bracket",
    kind: "structural",
    domain: {
      kind: "explicit",
      min: [-BRACKET.baseHalfX, -BRACKET.baseHalfY, 0],
      max: [BRACKET.baseHalfX, BRACKET.baseHalfY, BRACKET.wallHeight],
      resolutionMm: 5,
    },
    conditions:
      overrides?.conditions ??
      ([
        { kind: "fixed-support", face: "zMin" },
        {
          kind: "point-load",
          atWorldPointMm: [...BRACKET.tipPointMm],
          forceN: [0, -500, 0],
        },
      ] as const),
    fluid: "air",
    materials: [
      { bodyId: "body_bracket-base", materialId: STEEL_RECORD.id },
      { bodyId: "body_bracket-wall", materialId: STEEL_RECORD.id },
    ],
    gravityMPerS2: [0, -9.80665, 0],
    structural: overrides?.structural ?? { selfWeight: false },
  };
}

function compileBracket(
  scenario: Record<string, unknown>,
  structuralChain?: Record<string, unknown>,
): ReturnType<typeof compileSimScenarioWithGeometry> {
  return compileSimScenarioWithGeometry({
    scenario,
    materials: [STEEL_RECORD],
    bodyTessellations: [
      {
        bodyId: "body_bracket-base",
        tessellation: boxTessellationWire(
          [-BRACKET.baseHalfX, -BRACKET.baseHalfY, 0],
          [BRACKET.baseHalfX, BRACKET.baseHalfY, BRACKET.thickness],
        ),
      },
      {
        bodyId: "body_bracket-wall",
        tessellation: boxTessellationWire(
          [-BRACKET.baseHalfX, -BRACKET.baseHalfY, 0],
          [BRACKET.baseHalfX, BRACKET.wallInnerY, BRACKET.wallHeight],
        ),
      },
    ],
    ...(structuralChain === undefined ? {} : { structuralChain }),
  });
}

/** The bracket facts the guide states and the suite asserts. */
export interface SimStructuralExampleSummary {
  /** The record-boundary decline a structural scenario without a stance earns. */
  readonly stanceDeclined: boolean;
  /** The dry run's max deflection, mm. */
  readonly deflectionMm: number;
  /** The dry run's max von Mises, Pa. */
  readonly vonMisesPa: number;
  /** The factor of safety against yield (the machine-readable scalar). */
  readonly factorOfSafety: number;
  /** The FoS arithmetic: yield strength / max von Mises. */
  readonly fosArithmeticHolds: boolean;
  /**
   * The persisted overlay blocks, displacement first in the result's own
   * field array (the preview stream publishes von Mises first — the
   * live-overlay order; the persisted order is its own truth).
   */
  readonly fieldIds: readonly string[];
  /** The hot-bracket chain's max von Mises, Pa (ΔT = +100 K uniform). */
  readonly hotVonMisesPa: number;
  /** The centrifugal stance's max von Mises, Pa (a 3000 rpm fixed rate). */
  readonly spunVonMisesPa: number;
  /** Determinism: the repeat run's summary is identical (law S2). */
  readonly deterministic: boolean;
}

function summaryJson(result: SimResult): string {
  return JSON.stringify([
    result.summary.status,
    result.summary.quantities,
    result.fields.map((field) => field.values),
  ]);
}

/** Runs the guide's structural walk and returns the stated facts. */
export async function runSimStructuralExample(): Promise<SimStructuralExampleSummary> {
  // The kind-lock: a structural record without its stance declines at
  // the document boundary — the sentence the suite asserts.
  const added = addDocumentSimulation(
    createDocument(createDocumentId("doc_bracket_walk")),
    {
      name: "Bracket",
      kind: "structural",
      domain: {
        kind: "explicit",
        min: [-60, -40, 0],
        max: [60, 40, 80],
        resolutionMm: 5,
      },
      conditions: [{ kind: "fixed-support", face: "zMin" }],
      fluid: "air",
      materials: [],
    },
  );
  const stanceDeclined = !added.ok;

  const engine = createStructuralSimEngine();
  const quantityOf = (result: SimResult, name: string): number => {
    const found = result.summary.quantities.find(
      (quantity) => quantity.name === name,
    );
    if (found === undefined) {
      throw new Error(`The run's summary carries no "${name}" quantity.`);
    }
    return found.value;
  };

  // The dry run: the bolted base, the −y tip load, no body forces.
  const dry = compileBracket(bracketScenario());
  if (!dry.ok) {
    throw new Error(
      `The bracket did not compile: ${dry.error.code}: ${dry.error.message}`,
    );
  }
  const dryRun = await engine.run({ compiled: dry.value });
  if (!dryRun.ok) {
    throw new Error(
      `The bracket did not run: ${dryRun.error.code}: ${dryRun.error.message}`,
    );
  }
  const deflectionMm = quantityOf(dryRun.value, "max-deflection");
  const vonMisesPa = quantityOf(dryRun.value, "von-mises-max");
  const factorOfSafety = quantityOf(dryRun.value, "factor-of-safety");
  const fosArithmeticHolds =
    Math.abs(STEEL_RECORD.yieldStrengthPa / vonMisesPa - factorOfSafety) <
    1e-9 * factorOfSafety;
  const fieldIds = dryRun.value.fields.map((field) => field.id);

  // The hot bracket (the CHT→structural seam): a uniform +100 K block
  // referenced at 293.15 K becomes the per-node ΔT of thermal loading.
  const hot = compileBracket(
    bracketScenario({
      structural: {
        selfWeight: false,
        thermal: { referenceTemperatureK: 293.15 },
      },
    }),
    {
      thermal: {
        field: {
          originMm: [-60, -40, 0],
          spacingMm: [5, 5, 5],
          extent: [25, 17, 1],
          values: new Array<number>(25 * 17).fill(393.15),
        },
      },
    },
  );
  if (!hot.ok) {
    throw new Error(
      `The hot bracket did not compile: ${hot.error.code}: ${hot.error.message}`,
    );
  }
  const hotRun = await engine.run({ compiled: hot.value });
  if (!hotRun.ok) {
    throw new Error(
      `The hot bracket did not run: ${hotRun.error.code}: ${hotRun.error.message}`,
    );
  }
  const hotVonMisesPa = quantityOf(hotRun.value, "von-mises-max");

  // The spun bracket (the fan-blade root case): a fixed 3000 rpm about
  // the demo axis becomes ω²·r⊥ through the compile door.
  const spun = compileBracket(
    bracketScenario({
      structural: {
        selfWeight: false,
        centrifugal: {
          axisPointMm: [0, 0, 0],
          axisDirection: [0, 0, 1],
          rpmMode: "fixed",
          fixedRpm: 3000,
        },
      },
    }),
  );
  if (!spun.ok) {
    throw new Error(
      `The spun bracket did not compile: ${spun.error.code}: ${spun.error.message}`,
    );
  }
  const spunRun = await engine.run({ compiled: spun.value });
  if (!spunRun.ok) {
    throw new Error(
      `The spun bracket did not run: ${spunRun.error.code}: ${spunRun.error.message}`,
    );
  }
  const spunVonMisesPa = quantityOf(spunRun.value, "von-mises-max");

  // Determinism (law S2): the same compiled problem, the identical
  // summary and fields.
  const repeat = await engine.run({ compiled: dry.value });
  if (!repeat.ok) {
    throw new Error(
      `The repeat run failed: ${repeat.error.code}: ${repeat.error.message}`,
    );
  }
  const deterministic = summaryJson(repeat.value) === summaryJson(dryRun.value);

  return {
    stanceDeclined,
    deflectionMm,
    vonMisesPa,
    factorOfSafety,
    fosArithmeticHolds,
    fieldIds,
    hotVonMisesPa,
    spunVonMisesPa,
    deterministic,
  };
}
