/**
 * The composable React model API (Phase 14): a React-facing authoring
 * surface that builds its output entirely out of the Phase 7 command
 * vocabulary — `parameter.set`, `feature.create`, `feature.update`,
 * `feature.delete` — wrapped in transactions for `CadStore.applyTransaction`.
 *
 * ## No second parametric representation (the hard rule, restated)
 *
 * Everything here is a **command factory**. A descriptor is consumed at
 * build time and dies: it produces plain {@link CadCommand} data — the same
 * serializable, replayable vocabulary the domain's single interpreter
 * (`applyCommand`) executes — and never becomes a parallel model, a
 * parallel graph, or a parallel evaluator. What you author is exactly what
 * the session commits, the history records, and the command log
 * serializes; there is nothing else to keep in sync.
 *
 * The primitives are deliberately shallow: feature kinds, input references,
 * and outputs stay the domain's own data (the domain's feature kinds are
 * host-defined — "translate", "rotate", and future kernel kinds), so this
 * module adds authoring ergonomics, not semantics.
 */

import type {
  AnyDimensionalValue,
  BodyId,
  CadCommand,
  CadTransaction,
  FeatureId,
  FeatureInputRef,
  ParameterId,
} from "@slopcad/cad-core";

/** The authored fields of a `feature.create` / `feature.update` command. */
export interface FeatureAuthoring {
  /** The host-defined feature kind (domain data — passed through verbatim). */
  readonly kind: string;
  /** The feature's typed input references (parameters, features, bodies). */
  readonly inputs: readonly FeatureInputRef[];
  /** The body ids the feature declares as outputs. */
  readonly outputs: readonly BodyId[];
}

/** The authored fields of a `feature.create` command with an explicit id. */
export interface IdentifiedFeatureAuthoring extends FeatureAuthoring {
  readonly id: FeatureId;
}

/** A parameter assignment authored alongside a primitive. */
export interface ParameterAssignment {
  readonly id: ParameterId;
  readonly value: AnyDimensionalValue;
}

/** A supported primitive: its parameter assignments plus its feature record. */
export interface PrimitiveAuthoring {
  /** Parameter values committed before the feature command, in one atomic transaction. */
  readonly parameters?: readonly ParameterAssignment[];
  /** The feature record the primitive creates or updates. */
  readonly feature: IdentifiedFeatureAuthoring;
}

/** Builds a `parameter.set` command. */
export function setParameterCommand(
  id: ParameterId,
  value: AnyDimensionalValue,
): CadCommand {
  return Object.freeze({ type: "parameter.set", id, value });
}

/** Builds a `feature.create` command (id optional — replay regenerates it). */
export function createFeatureCommand(
  authoring: FeatureAuthoring & { readonly id?: FeatureId },
): CadCommand {
  return Object.freeze({
    type: "feature.create",
    ...(authoring.id !== undefined ? { id: authoring.id } : {}),
    kind: authoring.kind,
    inputs: Object.freeze([...authoring.inputs]),
    outputs: Object.freeze([...authoring.outputs]),
  });
}

/** Builds a `feature.update` command (wholesale mutable-field replacement). */
export function updateFeatureCommand(
  authoring: IdentifiedFeatureAuthoring,
): CadCommand {
  return Object.freeze({
    type: "feature.update",
    id: authoring.id,
    kind: authoring.kind,
    inputs: Object.freeze([...authoring.inputs]),
    outputs: Object.freeze([...authoring.outputs]),
  });
}

/** Builds a `feature.delete` command. */
export function deleteFeatureCommand(id: FeatureId): CadCommand {
  return Object.freeze({ type: "feature.delete", id });
}

/** Composes commands into one atomic transaction. */
export function cadTransaction(
  ...commands: readonly CadCommand[]
): CadTransaction {
  return Object.freeze({ commands: Object.freeze([...commands]) });
}

function assignmentCommands(
  parameters: readonly ParameterAssignment[] | undefined,
): readonly CadCommand[] {
  if (parameters === undefined) return [];
  return parameters.map((assignment) =>
    setParameterCommand(assignment.id, assignment.value),
  );
}

/**
 * Builds the create transaction of a primitive: its parameter assignments
 * first, then the `feature.create` — one atomic, replayable commit.
 */
export function createPrimitiveTransaction(
  primitive: PrimitiveAuthoring,
): CadTransaction {
  return cadTransaction(
    ...assignmentCommands(primitive.parameters),
    createFeatureCommand(primitive.feature),
  );
}

/**
 * Builds the update transaction of a primitive: its parameter assignments
 * first, then the `feature.update` — one atomic, replayable commit.
 */
export function updatePrimitiveTransaction(
  primitive: PrimitiveAuthoring,
): CadTransaction {
  return cadTransaction(
    ...assignmentCommands(primitive.parameters),
    updateFeatureCommand(primitive.feature),
  );
}

/** Builds the remove transaction of a feature: the single delete command. */
export function removeFeatureTransaction(id: FeatureId): CadTransaction {
  return cadTransaction(deleteFeatureCommand(id));
}

