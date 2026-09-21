/**
 * Per-entity constrainedness (Phase 37): the degrees-of-freedom analysis
 * behind the sketch editor's blue/black ink convention. The solver reports
 * the SYSTEM's remaining degrees of freedom; this module attributes them:
 * how many free parameter directions of EACH entity the constraint
 * Jacobian does not span. An entity with zero such directions is fully
 * constrained — the "black" ink of the CAD convention; an entity with
 * directions left is under-constrained — "blue".
 *
 * ## The exact test, not a heuristic
 *
 * The analysis reuses the solver's own compiled residual rows. At the
 * parameters the solve produced, it builds the same fixed-stripped dense
 * Jacobian the solver ranks for the system dof, then — per entity — appends
 * identity rows on that entity's free parameter slots and re-ranks: the
 * rank increase is exactly the number of that entity's directions the
 * constraints leave free, shared (coincident-type) constraints included.
 * Same elimination, same pivot tolerance, same parameter layout as the
 * solver, so the per-entity numbers partition the system's dof in the
 * documented sense (directions can be shared; the entity counts are exact
 * per entity, not a disjoint split of the system count).
 *
 * `analyzeConstrainedness` takes the SOLVED-APPLIED entities (the values a
 * solve produced — pack them the same way the solver packs), so the
 * Jacobian evaluates where the system actually settles and the module's
 * system dof equals the solver's.
 */

import type { SketchConstraint } from "./constraints";
import type { SketchEntity } from "./entities";
import type { SketchEntityId } from "./sketch-ids";

import {
  ParameterLayout,
  compileConstraintSystem,
  packInitialParameters,
} from "./residuals";
import {
  denseJacobian,
  evaluateRows,
  REFERENCE_SOLVER_RANK_TOLERANCE,
  stripFixed,
} from "./reference-solver";
import { rankOf } from "./solver-math";

/** The system-and-per-entity degrees-of-freedom readout. */
export interface SketchConstrainedness {
  /** The system's remaining degrees of freedom (the solver's number). */
  readonly dof: number;
  /** Free directions per entity id (rectangles: 0 — their edges carry them). */
  readonly entityDof: ReadonlyMap<SketchEntityId, number>;
}

/**
 * Analyzes constrainedness at the given (solved-applied) entity values, or
 * returns `null` when the constraint system does not compile (malformed
 * references — the structured diagnostics the solver returns cover the
 * reporting).
 */
export function analyzeConstrainedness(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
): SketchConstrainedness | null {
  const compiled = compileConstraintSystem(entities, constraints);
  if ("diagnostics" in compiled) return null;
  const layout = new ParameterLayout(entities);
  const fixedSlots = new Set<number>();
  for (const entity of entities) {
    if (!entity.fixed) continue;
    const slots = layout.slotsOf(entity.id);
    if (slots === undefined) continue;
    for (const slot of slots.offsets) fixedSlots.add(slot);
  }
  const parameters = packInitialParameters(entities);
  const evaluation = evaluateRows(compiled.rows, parameters);
  const jacobian = denseJacobian(
    evaluation.gradients.map((grad) => stripFixed(grad, fixedSlots)),
    layout.parameterCount,
  );
  const baseRank = rankOf(jacobian, REFERENCE_SOLVER_RANK_TOLERANCE);
  const dof = layout.parameterCount - fixedSlots.size - baseRank;
  const entityDof = new Map<SketchEntityId, number>();
  for (const entity of entities) {
    const slots = layout.slotsOf(entity.id);
    const freeSlots =
      slots === undefined
        ? []
        : slots.offsets.filter((slot) => !fixedSlots.has(slot));
    if (freeSlots.length === 0) {
      entityDof.set(entity.id, 0);
      continue;
    }
    const extended = [...jacobian];
    for (const slot of freeSlots) {
      const identity = new Array<number>(layout.parameterCount).fill(0);
      identity[slot] = 1;
      extended.push(identity);
    }
    const extendedRank = rankOf(extended, REFERENCE_SOLVER_RANK_TOLERANCE);
    entityDof.set(entity.id, extendedRank - baseRank);
  }
  return { dof, entityDof };
}
