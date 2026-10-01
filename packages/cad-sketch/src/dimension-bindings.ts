/**
 * Dimension bindings to document parameters: the caller-supplied parameter
 * environment a bound dimensional constraint resolves against, and the one
 * pure resolution pass that turns a sketch's constraints into the
 * solver-ready literal list.
 *
 * ## The division of labor (why this module exists)
 *
 * A sketch stays deterministic data: a bound constraint stores WHICH
 * parameter it follows (a `parameterId` on the record, see
 * `constraints.ts`), never a live link. The environment — the actual
 * parameter values — arrives at solve/profile time exactly like a solver
 * implementation does: injected by the caller. {@link
 * resolveSketchDimensionBindings} is the single door between the two: it
 * walks the constraint list once, replaces every bound constraint with its
 * resolved literal copy (binding stripped, value canonical), and refuses
 * with a structured `sketch/*` diagnostic when a binding cannot produce a
 * legal value — the parameter is unknown (`sketch/dimension-binding-unresolved`),
 * or its value carries the wrong dimension or falls outside the kind's
 * range (`sketch/dimension-binding-invalid`). The list is returned
 * reference-identical when nothing is bound, so callers that thread the
 * result into memo/effect dependencies keep today's identity semantics for
 * every unbound sketch.
 *
 * ## The contract with the solver
 *
 * The solver's compile step refuses constraints that still carry a binding
 * (`sketch/dimension-binding-unresolved`) — a caller that skips this pass
 * fails loudly instead of silently solving a stale cached literal.
 * Determinism: identical (constraints, lookup) produce identical output;
 * nothing here consults the clock, randomness, or any document.
 */

import {
  type AnyDimensionalValue,
  type ParameterId,
  angle,
  length,
  toCanonical,
  valueIn,
} from "@slopcad/cad-core";

import {
  type SketchConstraint,
  boundDimensionParameterId,
} from "./constraints";
import { SKETCH_DIAGNOSTIC_CODES, type SketchDiagnostic } from "./diagnostics";

/**
 * The outcome of one resolution pass: the solver-ready constraint list, or
 * the structured diagnostic that refused it (the caller surfaces it with
 * the sketch's other solver diagnostics — the solve status carries it).
 */
export type SketchDimensionResolution =
  | { readonly ok: true; readonly value: readonly SketchConstraint[] }
  | { readonly ok: false; readonly error: SketchDiagnostic };

/**
 * The caller-supplied parameter environment: a lookup from a document
 * parameter's id to its current value. Deliberately minimal and local —
 * the sketch domain never imports a document or parameter collection; a
 * host adapts its own parameter store to this shape (typically a one-line
 * find-by-id).
 */
export type SketchParameterLookup = (
  parameterId: ParameterId,
) => { readonly value: AnyDimensionalValue } | undefined;

/** The range rule a resolved dimension must satisfy, per constraint kind. */
function resolvedValueProblem(
  constraint: SketchConstraint,
  value: AnyDimensionalValue,
): string | null {
  switch (constraint.kind) {
    case "angle": {
      if (value.dimension !== "angle") {
        return `carries ${value.dimension}, but an angle constraint needs an angle parameter`;
      }
      const degrees = valueIn(toCanonical(value), "deg");
      if (!(degrees > 0 && degrees < 180)) {
        return `resolves to ${String(degrees)}°, and an angle constraint must be strictly between 0° and 180°`;
      }
      return null;
    }
    case "distance":
    case "radius":
    case "diameter": {
      if (value.dimension !== "length") {
        return `carries ${value.dimension}, but a ${constraint.kind} constraint needs a length parameter`;
      }
      const mm = valueIn(toCanonical(value), "mm");
      if (!(mm > 0)) {
        return `resolves to ${String(mm)} mm, and a ${constraint.kind} constraint must be strictly positive`;
      }
      return null;
    }
    case "distanceX":
    case "distanceY": {
      if (value.dimension !== "length") {
        return `carries ${value.dimension}, but a ${constraint.kind} constraint needs a length parameter`;
      }
      const mm = valueIn(toCanonical(value), "mm");
      if (!Number.isFinite(mm)) {
        return `resolves to a non-finite mm value, and a ${constraint.kind} constraint must be finite`;
      }
      return null;
    }
    default:
      return `constraint ${constraint.id} (${constraint.kind}) carries no dimensional value`;
  }
}

/**
 * Resolves every bound dimensional constraint in `constraints` against
 * `lookup`, returning the solver-ready list: bound constraints become
 * plain literal records (binding stripped, value the resolved canonical
 * quantity), everything else passes through by reference. The input list
 * is returned as-is (same reference) when nothing is bound. Fails with a
 * structured `sketch/dimension-binding-unresolved` diagnostic naming the
 * constraint when a bound parameter is absent from the lookup, and
 * `sketch/dimension-binding-invalid` when it resolves to a value of the
 * wrong dimension or outside the kind's range.
 */
export function resolveSketchDimensionBindings(
  constraints: readonly SketchConstraint[],
  lookup: SketchParameterLookup,
): SketchDimensionResolution {
  const unresolved = (): boolean => {
    for (const constraint of constraints) {
      if (boundDimensionParameterId(constraint) !== null) return true;
    }
    return false;
  };
  // Fast path: an unbound list resolves to itself, reference-identical.
  if (!unresolved()) return { ok: true, value: constraints };

  const resolved: SketchConstraint[] = [];
  for (const constraint of constraints) {
    const parameterId = boundDimensionParameterId(constraint);
    if (parameterId === null) {
      resolved.push(constraint);
      continue;
    }
    const parameter = lookup(parameterId);
    if (parameter === undefined) {
      return {
        ok: false,
        error: {
          severity: "error",
          code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingUnresolved,
          message: `Constraint ${constraint.id} (${constraint.kind}) is bound to parameter "${parameterId}", which does not resolve in the given parameter environment; the dimension cannot be re-driven.`,
          location: { primary: constraint.id },
        },
      };
    }
    const problem = resolvedValueProblem(constraint, parameter.value);
    if (problem !== null) {
      return {
        ok: false,
        error: {
          severity: "error",
          code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingInvalid,
          message: `Constraint ${constraint.id} (${constraint.kind}) is bound to parameter "${parameterId}", which ${problem}.`,
          location: { primary: constraint.id },
        },
      };
    }
    const canonical = toCanonical(parameter.value);
    switch (constraint.kind) {
      case "distance":
        resolved.push({
          id: constraint.id,
          kind: "distance",
          first: constraint.first,
          second: constraint.second,
          value: length(valueIn(canonical, "mm")),
        });
        continue;
      case "distanceX":
        resolved.push({
          id: constraint.id,
          kind: "distanceX",
          first: constraint.first,
          second: constraint.second,
          value: length(valueIn(canonical, "mm")),
        });
        continue;
      case "distanceY":
        resolved.push({
          id: constraint.id,
          kind: "distanceY",
          first: constraint.first,
          second: constraint.second,
          value: length(valueIn(canonical, "mm")),
        });
        continue;
      case "radius":
        resolved.push({
          id: constraint.id,
          kind: "radius",
          entity: constraint.entity,
          value: length(valueIn(canonical, "mm")),
        });
        continue;
      case "diameter":
        resolved.push({
          id: constraint.id,
          kind: "diameter",
          entity: constraint.entity,
          value: length(valueIn(canonical, "mm")),
        });
        continue;
      case "angle":
        resolved.push({
          id: constraint.id,
          kind: "angle",
          first: constraint.first,
          second: constraint.second,
          value: angle(valueIn(canonical, "rad")),
          ...(constraint.at === undefined ? {} : { at: constraint.at }),
        });
        continue;
      default:
        // Unreachable: boundDimensionParameterId is non-null only for the
        // six dimensional kinds handled above.
        resolved.push(constraint);
    }
  }
  return { ok: true, value: resolved };
}
