/**
 * Parameter dependency graph (Phase 5): which parameters an expression
 * references, and whether those references form a cycle.
 *
 * Edges are derived purely from data — a parameter's expression identifiers,
 * resolved to parameter ids by name through the collection. Names that
 * resolve to no parameter contribute no edge (rejecting them is the
 * evaluator's job). Cycle detection is a deterministic depth-first search in
 * collection order; a cycle is reported as a path of parameter ids that
 * starts and ends on the same id (a self-reference is `[id, id]`).
 */

import { extractExpressionDependencies } from "./expression";
import { type ParameterId } from "./ids";
import { type ParameterCollection } from "./parameter";

/**
 * The dependency edges of a collection: each parameter maps to the ids of
 * the parameters its expression references (empty for literal-only
 * parameters and for references that resolve to nothing). Every parameter in
 * the collection is a key.
 */
export function parameterDependencyEdges(
  collection: ParameterCollection,
): ReadonlyMap<ParameterId, readonly ParameterId[]> {
  const edges = new Map<ParameterId, ParameterId[]>();
  for (const parameter of collection.parameters) {
    edges.set(parameter.id, []);
  }
  for (const parameter of collection.parameters) {
    const targets = edges.get(parameter.id);
    if (targets === undefined || parameter.expression === null) continue;
    for (const name of extractExpressionDependencies(parameter.expression)) {
      const referenced = collection.parameters.find((p) => p.name === name);
      if (referenced !== undefined) {
        targets.push(referenced.id);
      }
    }
  }
  return edges;
}

/**
 * Finds a reference cycle among the collection's expressions, or null when
 * the collection is acyclic. The result is the path of the first cycle
 * encountered by a deterministic depth-first walk in collection order,
 * starting and ending on the same parameter id.
 */
export function findParameterCycle(
  collection: ParameterCollection,
): readonly ParameterId[] | null {
  const edges = parameterDependencyEdges(collection);
  const visited = new Set<ParameterId>();
  const onStack = new Set<ParameterId>();
  const stack: ParameterId[] = [];

  const walk = (id: ParameterId): readonly ParameterId[] | null => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visited.add(id);
    onStack.add(id);
    stack.push(id);
    const targets = edges.get(id) ?? [];
    for (const target of targets) {
      const cycle = walk(target);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    onStack.delete(id);
    return null;
  };

  for (const parameter of collection.parameters) {
    const cycle = walk(parameter.id);
    if (cycle !== null) return cycle;
  }
  return null;
}
