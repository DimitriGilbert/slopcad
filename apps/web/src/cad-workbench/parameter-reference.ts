/**
 * The value fields' parameter-reference vocabulary (Phase 21): the submission
 * shape and the resolution seam for feature-dialog number fields that accept
 * EITHER a literal number (today's behavior, byte-identical) OR a `$name`
 * token referencing an EXISTING document parameter — optionally negated
 * (`-$name`, Phase 30).
 *
 * ## The division of labor
 * The forms (Formedible `expressionNumber` fields) carry the raw value — a
 * `number`, a `"$name"` string, or a `"-$name"` string — and their
 * field-level validation already refuses malformed or unknown tokens before
 * submit. The HANDLER resolves each value here: a literal passes through to
 * the handler's own authoring battery unchanged; a reference must name an
 * existing parameter (one more check — the document may have changed between
 * typing and submit) whose value carries the role's dimension. A refused
 * resolution commits nothing and surfaces verbatim in the dialog's alert
 * region.
 *
 * ## The commit shape
 * A literal keeps today's transaction exactly: a new `parameter.create` for
 * the role and the feature input pointing at the new parameter. A bare
 * reference emits NO `parameter.create` — the feature input points at the
 * EXISTING parameter id, so the regeneration loop re-reads its live value on
 * every dispatch (the auto-created-literal loop's own mechanism, one input
 * id different).
 *
 * ## The negated reference's emission (Phase 30)
 * A `-$name` submission cannot ride a plain reference: a feature input
 * references a parameter BY ID and the reader consumes its VALUE, so
 * binding the input to `name` would silently drop the sign. The clean route
 * mirrors the established auto-parameter pattern: the slot's `parameter.create`
 * rides the vocabulary's optional defining expression (Phase 22) — the fresh
 * auto-parameter is created with a seed value equal to the NEGATION of the
 * referenced parameter's current value (dimension preserved) and the
 * expression `-name`, and the feature input references THAT parameter. The
 * re-drive is the expression DAG's own mechanism: editing the source
 * variable re-derives the negated auto-parameter, and the feature follows on
 * the next dispatch. No negated parameter is invented by the user and none
 * is hidden — the manager's row shows it (`extrudeDepth1 = -caseDepth`,
 * `depends on caseDepth`) like any expression variable.
 */

import {
  findParameterByName,
  toCanonical,
  type AnyDimensionalValue,
  type CadCommand,
  type ExpressionNode,
  type Parameter,
  type ParameterCollection,
  type ParameterId,
} from "@slopcad/cad-core";
import {
  expressionNumberTokenName,
  expressionNumberTokenNegated,
} from "@slopcad/ui/components/formedible/fields/expression-number-field";

/** A submitted value-field value: the literal number, or a (negated) `$name` token. */
export type FeatureNumberValue = number | string;

/** The dimensional family a value role demands of a parameter. */
export type FeatureValueDimension = "length" | "angle" | "dimensionless";

/** A resolved submission: the literal, or the referenced existing parameter. */
export type ResolvedFeatureValue =
  | { readonly ok: true; readonly kind: "number"; readonly value: number }
  | {
      readonly ok: true;
      readonly kind: "reference";
      readonly parameter: Parameter;
    }
  | {
      readonly ok: true;
      readonly kind: "negatedReference";
      readonly parameter: Parameter;
    };

/** The structured refusal of one value resolution (the form outcome shape). */
export interface FeatureValueRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type FeatureValueResolution = ResolvedFeatureValue | FeatureValueRefusal;

/** The `-$name` defining expression: unary minus over the identifier node. */
function negatedReferenceExpression(name: string): ExpressionNode {
  return Object.freeze({
    kind: "unary",
    operator: "-",
    operand: Object.freeze({ kind: "identifier", name }),
  });
}

/**
 * The negation of a dimensional value: the canonical quantity's magnitude
 * flips, the dimension and unit ride unchanged (a 10 mm length negates to
 * −10 mm, not to a dimensionless −10).
 */
function negateDimensionalValue(
  value: AnyDimensionalValue,
): AnyDimensionalValue {
  const canonical = toCanonical(value);
  return Object.freeze({ ...canonical, value: -canonical.value });
}

/**
 * The `parameter.create` command a NEGATED reference emits: the fresh
 * auto-parameter (the slot's literal identity) is created with the negated
 * seed value and the `-name` defining expression, so the feature input can
 * reference it by id while the expression DAG keeps it re-derived from the
 * source variable. Exposed for the role-slot handlers that build their own
 * command lists (the structured hole's roles); the `FeatureValueSlot`
 * consumers get it through {@link featureSlotCreateCommand}.
 */
export function negatedReferenceCreateCommand(
  parameter: Parameter,
  id: ParameterId,
  name: string,
): CadCommand {
  return {
    type: "parameter.create",
    id,
    name,
    value: negateDimensionalValue(parameter.value),
    expression: negatedReferenceExpression(parameter.name),
  };
}

/**
 * Resolves one submitted value against the document's parameters. A literal
 * number resolves as-is (the handler's own authoring battery still judges
 * it — the messages stay byte-identical); a `$name` token must name an
 * existing parameter whose value carries the demanded dimension, and a
 * `-$name` token resolves the SAME parameter with the negation carried as
 * the resolution's own kind (the emission, not the check, differs).
 */
export function resolveFeatureNumberValue(
  value: FeatureNumberValue,
  parameters: ParameterCollection,
  role: { readonly dimension: FeatureValueDimension; readonly label: string },
): FeatureValueResolution {
  if (typeof value === "number") {
    return { ok: true, kind: "number", value };
  }
  const name = expressionNumberTokenName(value);
  if (name === null) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `${role.label}: "${value}" is neither a finite number nor a $name parameter reference.`,
    };
  }
  const parameter = findParameterByName(parameters, name);
  if (parameter === undefined) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `${role.label}: the parameter "${name}" does not exist in this document.`,
    };
  }
  if (parameter.value.dimension !== role.dimension) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `${role.label}: the parameter "${name}" carries ${parameter.value.dimension}, but this role needs ${role.dimension}.`,
    };
  }
  return expressionNumberTokenNegated(value)
    ? { ok: true, kind: "negatedReference", parameter }
    : { ok: true, kind: "reference", parameter };
}

/** One value slot's committed identity: its literal parameter plus the resolution. */
export interface FeatureValueSlot {
  /** The resolved submission (a literal number or a [negated] reference). */
  readonly resolution: ResolvedFeatureValue;
  /** The new parameter's id — the feature input on the literal and negated paths. */
  readonly literalId: ParameterId;
  /** The new parameter's name — the literal and negated paths. */
  readonly literalName: string;
  /** Builds the literal's dimensional value from the literal number. */
  readonly toLiteralValue: (value: number) => AnyDimensionalValue;
}

/**
 * The feature input the slot contributes: the new literal's parameter id on
 * the literal path, the referenced parameter's id on the bare reference
 * path, and the fresh negated auto-parameter's id on the negated path (the
 * sign survives only through that parameter's expression).
 */
export function featureSlotInputId(slot: FeatureValueSlot): ParameterId {
  if (slot.resolution.kind === "number") return slot.literalId;
  return slot.resolution.kind === "reference"
    ? slot.resolution.parameter.id
    : slot.literalId;
}

/**
 * The `parameter.create` command the slot adds — `null` on the bare
 * reference path (the existing parameter is referenced and nothing is
 * created), the negated auto-parameter's create-with-expression on the
 * negated path.
 */
export function featureSlotCreateCommand(
  slot: FeatureValueSlot,
): CadCommand | null {
  if (slot.resolution.kind === "number") {
    return {
      type: "parameter.create",
      id: slot.literalId,
      name: slot.literalName,
      value: slot.toLiteralValue(slot.resolution.value),
    };
  }
  if (slot.resolution.kind === "negatedReference") {
    return negatedReferenceCreateCommand(
      slot.resolution.parameter,
      slot.literalId,
      slot.literalName,
    );
  }
  return null;
}
