/**
 * The lightest-bracket study demo's fixture data (ROADMAP-SIM Phase 70,
 * the named deliverable): the 69 L-bracket substrate (`./bracket-demo`'s
 * cad-jsx document — its `thickness` and `wallHeight` parameters ARE the
 * genome), evolved against the structural run's own summary scalars —
 * MASS (minimize, the voxelized total the Phase 69 engine projects)
 * against FACTOR OF SAFETY (maximize), with the slenderness constraint
 * `12 * thickness - wallHeight` declining the thin-tall corner. The
 * demo's Pareto front IS the roadmap sentence: every front point is a
 * bracket that survives the load at its own weight, the light end
 * trading FoS for grams — "the lightest bracket that survives the load"
 * is the front's knee, chosen by the reader, not hard-coded.
 *
 * Everything here is FIXTURE DATA in the 62c sense: the domain (grown to
 * the genome's tallest wall), the tip-load height (pinned to a z every
 * candidate's wall covers — the load rides a fixed peg height, honestly
 * stated), the genome's bounds and lattice, the constraint, and the
 * e2e-sized NSGA-II budget (population 6 × generations 3, deterministic
 * seed 7 — the coarse-first mitigation; the resolution-ladder and
 * multi-seed caveats are the guide's studies section).
 */

import type {
  MaterialId,
  SimScenarioDraft,
  SimStudyInput,
} from "@slopcad/cad-core";
import {
  createBodyId,
  createParameterId,
  parseExpression,
} from "@slopcad/cad-core";
import { BRACKET } from "@slopcad/docs-examples/cadjsx/bracket";

import { BRACKET_DEMO } from "./bracket-demo";
import { STRUCTURAL_MATERIAL_PRESETS } from "./structural-materials";

/** The bracket genome's parameter ids (the cad-jsx model's own). */
export const BRACKET_GENES = {
  thickness: createParameterId("param_thickness"),
  wallHeight: createParameterId("param_wall-height"),
} as const;

/** The study demo's authored numbers — the form defaults' single source. */
export const BRACKET_STUDY_DEMO = {
  /** The study scenario's domain: the 69 demo domain grown to the genome. */
  domainMinMm: [-BRACKET.baseHalfX, -BRACKET.baseHalfY, 0] as const,
  domainMaxMm: [BRACKET.baseHalfX, BRACKET.baseHalfY, 92] as const,
  /** The voxel resolution, mm (the 69 demo's own honest staircase). */
  resolutionMm: BRACKET_DEMO.resolutionMm,
  /** The tip-load peg height, mm — every candidate's wall covers it. */
  loadPegZMm: 48,
  /** The genome: thickness 4…16 on a 2 mm lattice, wallHeight 56…88 on 4. */
  thicknessMin: 4,
  thicknessMax: 16,
  thicknessStep: 2,
  wallHeightMin: 56,
  wallHeightMax: 88,
  wallHeightStep: 4,
  /** The slenderness constraint (binds the thin-tall corner). */
  constraint: "12 * thickness - wallHeight",
  /** The NSGA-II budget (e2e-sized: 18 evaluations, deterministic seed). */
  population: 6,
  generations: 3,
  seed: 7,
} as const;

/** The study demo's structural scenario — the load hung at the fixed peg. */
export function bracketStudyScenarioDraft(): SimScenarioDraft {
  return {
    name: "bracket-study-load",
    kind: "structural",
    domain: {
      kind: "explicit",
      min: [...BRACKET_STUDY_DEMO.domainMinMm],
      max: [...BRACKET_STUDY_DEMO.domainMaxMm],
      resolutionMm: BRACKET_STUDY_DEMO.resolutionMm,
    },
    conditions: [
      { kind: "fixed-support", face: "zMin" },
      {
        kind: "point-load",
        atWorldPointMm: [
          BRACKET.tipPointMm[0],
          BRACKET.tipPointMm[1],
          BRACKET_STUDY_DEMO.loadPegZMm,
        ],
        forceN: [...BRACKET_DEMO.tipForceN],
      },
    ],
    fluid: "air",
    materials: [
      {
        bodyId: createBodyId("body_bracket-base"),
        materialId: studySteelMaterialId(),
      },
      {
        bodyId: createBodyId("body_bracket-wall"),
        materialId: studySteelMaterialId(),
      },
    ],
    structural: { selfWeight: false },
  };
}

/** The steel preset's branded id (the study scenario's assignments). */
function studySteelMaterialId(): MaterialId {
  const preset = STRUCTURAL_MATERIAL_PRESETS[0];
  if (preset === undefined) {
    throw new Error("The structural material presets carry no steel record.");
  }
  return preset.id;
}

/** The study demo's authored fields: the mass-vs-FoS genome. */
export function bracketStudyInput(
  scenarioId: SimStudyInput["scenarioId"],
): SimStudyInput {
  const constraint = parseExpression(BRACKET_STUDY_DEMO.constraint);
  if (!constraint.ok) {
    throw new Error(
      `The bracket study's constraint did not parse: ${constraint.error.message}`,
    );
  }
  return {
    name: "lightest-bracket",
    scenarioId,
    genes: [
      {
        kind: "parameter",
        parameterId: BRACKET_GENES.thickness,
        valueKind: "integer",
        min: BRACKET_STUDY_DEMO.thicknessMin,
        max: BRACKET_STUDY_DEMO.thicknessMax,
        step: BRACKET_STUDY_DEMO.thicknessStep,
      },
      {
        kind: "parameter",
        parameterId: BRACKET_GENES.wallHeight,
        valueKind: "integer",
        min: BRACKET_STUDY_DEMO.wallHeightMin,
        max: BRACKET_STUDY_DEMO.wallHeightMax,
        step: BRACKET_STUDY_DEMO.wallHeightStep,
      },
    ],
    objectives: [
      { quantity: "mass", direction: "minimize" },
      { quantity: "factor-of-safety", direction: "maximize" },
    ],
    constraints: [constraint.value],
    population: BRACKET_STUDY_DEMO.population,
    generations: BRACKET_STUDY_DEMO.generations,
    seed: BRACKET_STUDY_DEMO.seed,
  };
}
