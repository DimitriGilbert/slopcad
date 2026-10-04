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
 *
 * The commit-time half (Phase 22): {@link installParameterExpression} is the
 * ONE gate an expression write passes — unknown identifiers are refused by
 * name, a closing cycle is refused with the chain, and the install ends in a
 * full recompute of every expression-driven cached value in topological
 * order. The command vocabulary (`parameter.set` / `parameter.create` with
 * an expression payload) is this function's only caller; the substrate
 * mutators in `parameter.ts` keep their bulk, validation-only semantics.
 * The Phase 24 rename borrows the cycle detection (not the install): its
 * rewrite is name-isomorphic, so the guard only fires on the pre-existing
 * dangling-reference corner the document layer documents.
 */

import { type AnyDimensionalValue } from "./dimensional";
import {
  type ExpressionNode,
  extractExpressionDependencies,
} from "./expression";
import { evaluateExpression } from "./expression-evaluator";
import { type ParameterId } from "./ids";
import {
  findParameterByName,
  getParameter,
  PARAMETER_ERROR_CODES,
  updateParameterExpression,
  type ParameterCollection,
  type ParameterError,
} from "./parameter";
import { type ParseResult, fail, ok } from "./result";

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

// ---------------------------------------------------------------------------
// The commit-time expression gate (Phase 22)
// ---------------------------------------------------------------------------

/** The outcome of a committed expression install. */
export interface ParameterExpressionCommit {
  /**
   * The collection with the expression installed (or cleared) and every
   * expression-driven cached value re-derived in topological order.
   */
  readonly collection: ParameterCollection;
  /**
   * The expression-driven parameters whose cached value could not be
   * re-derived — an evaluation failure at the current values, or membership
   * in (or downstream of) a pre-existing cycle that arrived through the
   * parse boundary. Each kept its prior cached value; the list is in
   * collection order. Warning-level, by contract: the install itself
   * succeeds, and nothing is fabricated in place of a value that cannot be
   * produced.
   */
  readonly stale: readonly ParameterId[];
}

/**
 * The structured `parameter/cycle` refusal for a closing chain, rendered by
 * name; `cause` names the change that would close it ("Setting this
 * expression" at the install gate, "Renaming this parameter" at the
 * document rename). Shared by both callers so the two refusals carry the
 * same shape.
 */
export function parameterCycleError(
  chain: readonly ParameterId[],
  collection: ParameterCollection,
  cause: string,
): ParameterError {
  const names = chain
    .map((id) => getParameter(collection, id)?.name ?? id)
    .join(" → ");
  return {
    code: PARAMETER_ERROR_CODES.cycle,
    message: `${cause} closes a reference cycle: ${names}. A parameter may not be defined, directly or transitively, through itself.`,
    input: chain,
  };
}

/**
 * Topologically orders the collection's expression-driven parameters and
 * re-evaluates each against the values settled so far, in one deterministic
 * pass. Literals are authoritative inputs (their stored value is read, never
 * recomputed). An expression that fails to evaluate — and any parameter the
 * ordering cannot reach because a pre-existing cycle blocks it — keeps its
 * prior cached value and is reported in `stale` (collection order);
 * downstream parameters evaluate against that kept value.
 */
function recomputeAll(
  collection: ParameterCollection,
): ParameterExpressionCommit {
  const driven = collection.parameters.filter(
    (parameter) => parameter.expression !== null,
  );
  const drivenIds = new Set(driven.map((parameter) => parameter.id));
  const byId = new Map(collection.parameters.map((p) => [p.id, p]));
  // Working values: literals pass through; expressions overwrite as they are
  // re-derived. Every parameter of the collection is present from the start,
  // so name resolution reads the freshest settled value.
  const working = new Map<ParameterId, AnyDimensionalValue>(
    collection.parameters.map((parameter) => [parameter.id, parameter.value]),
  );
  const byName = new Map(collection.parameters.map((p) => [p.name, p]));
  const stale: ParameterId[] = [];

  // Ordering constraints among the driven parameters only: an edge to a
  // literal carries no ordering (the literal's value is already settled).
  const edges = parameterDependencyEdges(collection);
  const indegree = new Map<ParameterId, number>();
  const dependents = new Map<ParameterId, ParameterId[]>();
  for (const parameter of driven) {
    let count = 0;
    for (const dependency of edges.get(parameter.id) ?? []) {
      if (!drivenIds.has(dependency)) continue;
      count += 1;
      const list = dependents.get(dependency);
      if (list === undefined) dependents.set(dependency, [parameter.id]);
      else list.push(parameter.id);
    }
    indegree.set(parameter.id, count);
  }

  // Kahn's queue in collection order: the recompute order is a pure function
  // of the collection, never of Map iteration luck.
  const queue: ParameterId[] = [];
  for (const parameter of driven) {
    if ((indegree.get(parameter.id) ?? 0) === 0) queue.push(parameter.id);
  }
  const reached = new Set<ParameterId>();
  // A for..of over the growing queue visits every entry appended while the
  // pass runs (the language-defined behavior the Kahn walk needs); a node
  // enters the queue exactly once — its indegree reaches zero on a single
  // decrement — so each parameter is evaluated at most once.
  for (const id of queue) {
    reached.add(id);
    const parameter = byId.get(id);
    if (parameter === undefined || parameter.expression === null) continue;
    const evaluated = evaluateExpression(parameter.expression, (name) => {
      const resolved = byName.get(name);
      return resolved === undefined ? undefined : working.get(resolved.id);
    });
    if (evaluated.ok) {
      working.set(id, evaluated.value);
    } else {
      stale.push(id);
    }
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  // Unreached driven parameters (inside, or downstream of, a pre-existing
  // cycle the parse boundary let through) keep their prior values and join
  // the stale list.
  for (const parameter of driven) {
    if (!reached.has(parameter.id)) stale.push(parameter.id);
  }
  // The Kahn walk appends evaluation failures in topological order; the
  // commit contract reports `stale` in collection order, so sort before
  // freezing.
  const position = new Map(
    collection.parameters.map((parameter, index) => [parameter.id, index]),
  );
  stale.sort(
    (left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0),
  );

  const parameters = collection.parameters.map((parameter) => {
    const value = working.get(parameter.id);
    return value === undefined || value === parameter.value
      ? parameter
      : Object.freeze({ ...parameter, value });
  });
  return {
    collection: Object.freeze({
      parameters: Object.freeze(parameters),
    }),
    stale: Object.freeze(stale),
  };
}

/**
 * The commit gate for an expression write: installs `expression` on the
 * parameter (`null` clears it back to a literal) and re-derives every
 * expression-driven cached value in the same pure transition.
 *
 * Refusals, before any state changes: the parameter must exist
 * (`parameter/not-found`); every identifier the expression references must
 * resolve to a parameter of the collection, refused by name
 * (`parameter/unknown-identifier`); and the collection with the expression
 * installed must remain acyclic, refused with the closing chain rendered by
 * name (`parameter/cycle`). Clearing needs none of those checks — removing
 * an expression can only remove edges.
 *
 * The recompute covers every expression-driven parameter, not only the
 * target's transitive dependents: one uniform topological pass, so a commit
 * deterministically heals pre-existing staleness instead of leaving values
 * whose freshness depends on edit history. Failures are warning-level (see
 * {@link ParameterExpressionCommit.stale}); the install itself never fails
 * on an evaluation.
 */
export function installParameterExpression(
  collection: ParameterCollection,
  id: ParameterId,
  expression: ExpressionNode | null,
): ParseResult<ParameterExpressionCommit, ParameterError> {
  const target = getParameter(collection, id);
  if (target === undefined) {
    return fail({
      code: PARAMETER_ERROR_CODES.notFound,
      message: `No parameter with id "${id}" exists.`,
      input: id,
    });
  }
  if (expression !== null) {
    for (const name of extractExpressionDependencies(expression)) {
      if (findParameterByName(collection, name) === undefined) {
        return fail({
          code: PARAMETER_ERROR_CODES.unknownIdentifier,
          message: `The expression references "${name}", which is not a parameter of this document.`,
          input: name,
        });
      }
    }
  }
  const installed = updateParameterExpression(collection, id, expression);
  if (!installed.ok) return installed;
  if (expression !== null) {
    const cycle = findParameterCycle(installed.value);
    if (cycle !== null) {
      return fail(
        parameterCycleError(cycle, installed.value, "Setting this expression"),
      );
    }
  }
  return ok(recomputeAll(installed.value));
}
