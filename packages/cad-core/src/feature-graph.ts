/**
 * Feature dependency graph (Phase 6.2): the edges between a document's
 * features and the entities they consume, the deterministic evaluation
 * order derived from those edges, independent cycle rejection, and the
 * downstream invalidation queries that Phase 6.3 regeneration consumes.
 *
 * Primary API shape: every function here is pure over a plain
 * `readonly FeatureRecord[]` — the exact type of `CadDocument.features` —
 * rather than over a document or a prebuilt graph object. A document
 * derives its graph by passing `document.features` straight through (no
 * wrapper), and any record list works standalone, which keeps the module
 * free of document dependencies (its only imports are types and the
 * result helpers). Feature ids are expected to be unique, as every
 * CadDocument guarantees; the functions stay deterministic regardless.
 *
 * Edges are derived purely from declared inputs. A feature-kind input is
 * a feature→feature edge when the referenced feature is present in the
 * list — a dangling feature reference contributes no edge, mirroring the
 * parameter graph's treatment of unresolvable names. Parameter- and
 * body-kind inputs are always source→feature edges: parameters and bodies
 * are source nodes of the graph (pure upstream, never features
 * themselves), so a changed parameter or body drives invalidation exactly
 * like a changed feature. Output bodies contribute no edges of their own:
 * a consumer of a produced body depends on the body as a source, and
 * regeneration chains feature → its output bodies → consumers through
 * {@link affectedFeatures}.
 *
 * Determinism: evaluation order breaks ties by document insertion order —
 * among the features whose feature inputs are all satisfied, the
 * earliest-inserted is emitted first — so the same input always yields the
 * same order. Cycle detection is a deterministic depth-first walk in
 * insertion order; a cycle is reported as a path of feature ids that
 * starts and ends on the same id (a self-reference is `[id, id]`),
 * consistent with `findParameterCycle`'s path style. Phase 6.1's document
 * prevents self-references at add time and admits no cyclic orderings
 * through its add/parse paths, but this module defends independently —
 * standalone record lists and future update operations are not bound by
 * those invariants.
 */

import { type FeatureInputRef, type FeatureRecord } from "./document";
import {
  type BodyId,
  type FeatureId,
  type ParameterId,
  type ReferenceId,
  type SketchDocumentId,
} from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/**
 * The source nodes of the graph: entities that features consume but that
 * no feature can depend on — parameters, bodies, sketches, and persistent
 * reference records.
 */
export type FeatureGraphSourceId =
  ParameterId | BodyId | SketchDocumentId | ReferenceId;

/**
 * Any node id accepted by affected-node queries: a feature, or a source
 * (parameter, body, sketch, or reference) whose change must drive
 * invalidation.
 */
export type FeatureGraphNodeId = FeatureId | FeatureGraphSourceId;

/** Stable failure codes produced when the feature graph rejects input. */
export const FEATURE_GRAPH_ERROR_CODES = {
  cycle: "graph/cycle",
} as const;

export type FeatureGraphErrorCode =
  (typeof FEATURE_GRAPH_ERROR_CODES)[keyof typeof FEATURE_GRAPH_ERROR_CODES];

/**
 * Structured failure describing why the feature graph rejected input: the
 * graph contains a dependency cycle. The `cycle` field carries the exact
 * path (first and last id equal) so callers can point at the offending
 * features.
 */
export interface FeatureGraphError extends ParseFailure {
  readonly code: FeatureGraphErrorCode;
  /** The dependency cycle, starting and ending on the same feature id. */
  readonly cycle: readonly FeatureId[];
}

function cycleError(
  cycle: readonly FeatureId[],
  features: readonly FeatureRecord[],
): FeatureGraphError {
  return {
    code: FEATURE_GRAPH_ERROR_CODES.cycle,
    message: `The feature graph contains a dependency cycle: ${cycle.join(" → ")}.`,
    input: features,
    cycle,
  };
}

/**
 * The dependency edges of a feature list: each feature maps to the inputs
 * it declared, in declared order with duplicates preserved. Feature inputs
 * that reference a feature absent from the list contribute no edge; every
 * feature in the list is a key.
 */
export function featureDependencyEdges(
  features: readonly FeatureRecord[],
): ReadonlyMap<FeatureId, readonly FeatureInputRef[]> {
  const present = new Set<FeatureId>(features.map((feature) => feature.id));
  const edges = new Map<FeatureId, FeatureInputRef[]>();
  for (const feature of features) {
    const inputs: FeatureInputRef[] = [];
    for (const ref of feature.inputs) {
      if (ref.kind === "feature" && !present.has(ref.id)) continue;
      inputs.push(ref);
    }
    edges.set(feature.id, inputs);
  }
  return edges;
}

/**
 * Finds a dependency cycle among the feature inputs, or null when the
 * list is acyclic. The result is the path of the first cycle encountered
 * by a deterministic depth-first walk in insertion order, starting and
 * ending on the same feature id.
 */
export function findFeatureCycle(
  features: readonly FeatureRecord[],
): readonly FeatureId[] | null {
  const edges = featureDependencyEdges(features);
  const visited = new Set<FeatureId>();
  const onStack = new Set<FeatureId>();
  const stack: FeatureId[] = [];

  const walk = (id: FeatureId): readonly FeatureId[] | null => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visited.add(id);
    onStack.add(id);
    stack.push(id);
    for (const ref of edges.get(id) ?? []) {
      if (ref.kind !== "feature") continue;
      const cycle = walk(ref.id);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    onStack.delete(id);
    return null;
  };

  for (const feature of features) {
    const cycle = walk(feature.id);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * The evaluation order of a feature list: every feature exactly once, with
 * each feature placed after every feature it declares as an input. Ties
 * are broken by document insertion order — among the features whose
 * feature inputs are all emitted, the earliest-inserted is emitted first —
 * so disconnected components interleave deterministically and independent
 * features keep their document order. A cycle is rejected with a
 * structured `graph/cycle` failure carrying the cycle path.
 */
export function featureEvaluationOrder(
  features: readonly FeatureRecord[],
): ParseResult<readonly FeatureId[], FeatureGraphError> {
  const edges = featureDependencyEdges(features);
  const remaining = new Set<FeatureId>(features.map((feature) => feature.id));
  const order: FeatureId[] = [];
  while (remaining.size > 0) {
    let next: FeatureId | undefined;
    for (const feature of features) {
      if (!remaining.has(feature.id)) continue;
      const ready = (edges.get(feature.id) ?? []).every(
        (ref) => ref.kind !== "feature" || !remaining.has(ref.id),
      );
      if (ready) {
        next = feature.id;
        break;
      }
    }
    if (next === undefined) {
      const cycle = findFeatureCycle(features);
      if (cycle === null) {
        throw new Error(
          "Invariant violation: an acyclic feature list always has a feature whose inputs are emitted.",
        );
      }
      return fail(cycleError(cycle, features));
    }
    remaining.delete(next);
    order.push(next);
  }
  return ok(order);
}

/**
 * Reverse edges of the graph: for every node (feature, parameter, or
 * body), the features that declare it as an input, in document insertion
 * order and free of duplicates. This is what represents parameters and
 * bodies as source nodes of the graph.
 */
function featureConsumers(
  features: readonly FeatureRecord[],
): ReadonlyMap<FeatureGraphNodeId, readonly FeatureId[]> {
  const consumers = new Map<FeatureGraphNodeId, FeatureId[]>();
  for (const feature of features) {
    for (const ref of feature.inputs) {
      const existing = consumers.get(ref.id);
      if (existing === undefined) {
        consumers.set(ref.id, [feature.id]);
      } else if (!existing.includes(feature.id)) {
        existing.push(feature.id);
      }
    }
  }
  return consumers;
}

/**
 * The downstream invalidation set of a changed node (parameter, body, or
 * feature): exactly the features that depend on it, directly or
 * transitively — each once, never the changed node itself (a
 * self-referencing feature's self-loop is filtered out of its own set),
 * and never a feature from an unaffected branch, because traversal only follows
 * declared-input edges out of the changed node. The result is in
 * deterministic breadth-first discovery order (document insertion order at
 * each level); consumers that need an evaluation order apply
 * {@link featureEvaluationOrder}. The query is total: a node nothing
 * depends on — including one absent from the graph — invalidates nothing.
 */
export function affectedFeatures(
  features: readonly FeatureRecord[],
  changed: FeatureGraphNodeId,
): readonly FeatureId[] {
  const consumers = featureConsumers(features);
  // A self-referencing feature is its own direct consumer; the changed node
  // must not invalidate itself, so seed the set with it filtered out.
  const affected = (consumers.get(changed) ?? []).filter(
    (id) => id !== changed,
  );
  const visited = new Set<FeatureGraphNodeId>([changed, ...affected]);
  // Iterating the live array visits entries pushed during the loop, which
  // is exactly the breadth-first discovery order.
  for (const id of affected) {
    for (const consumer of consumers.get(id) ?? []) {
      if (visited.has(consumer)) continue;
      visited.add(consumer);
      affected.push(consumer);
    }
  }
  return affected;
}
