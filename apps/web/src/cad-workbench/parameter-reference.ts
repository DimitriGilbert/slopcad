/**
 * The value fields' parameter-reference vocabulary (Phase 21): the submission
 * shape and the resolution seam for feature-dialog number fields that accept
 * EITHER a literal number (today's behavior, byte-identical) OR a `$name`
 * token referencing an EXISTING document parameter.
 *
 * ## The division of labor
 * The forms (Formedible `expressionNumber` fields) carry the raw value — a
 * `number` or a `"$name"` string — and their field-level validation already
 * refuses malformed or unknown tokens before submit. The HANDLER resolves
 * each value here: a literal passes through to the handler's own authoring
 * battery unchanged; a reference must name an existing parameter (one more
 * check — the document may have changed between typing and submit) whose
 * value carries the role's dimension. A refused resolution commits nothing
 * and surfaces verbatim in the dialog's alert region.
 *
 * ## The commit shape
 * A literal keeps today's transaction exactly: a new `parameter.create` for
 * the role and the feature input pointing at the new parameter. A reference
 * emits NO `parameter.create` — the feature input points at the EXISTING
 * parameter id, so the regeneration loop re-reads its live value on every
 * dispatch (the auto-created-literal loop's own mechanism, one input id
 * different).
 */

import {
  findParameterByName,
  type AnyDimensionalValue,
  type CadCommand,
  type Parameter,
  type ParameterCollection,
  type ParameterId,
} from "@slopcad/cad-core";
import { expressionNumberTokenName } from "@slopcad/ui/components/formedible/fields/expression-number-field";

/** A submitted value-field value: the literal number, or a `$name` token. */
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
    };

/** The structured refusal of one value resolution (the form outcome shape). */
export interface FeatureValueRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type FeatureValueResolution = ResolvedFeatureValue | FeatureValueRefusal;

/**
 * Resolves one submitted value against the document's parameters. A literal
 * number resolves as-is (the handler's own authoring battery still judges
 * it — the messages stay byte-identical); a `$name` token must name an
 * existing parameter whose value carries the demanded dimension.
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
  return { ok: true, kind: "reference", parameter };
}

/** One value slot's committed identity: its literal parameter plus the resolution. */
export interface FeatureValueSlot {
  /** The resolved submission (a literal number or an existing-parameter reference). */
  readonly resolution: ResolvedFeatureValue;
  /** The new parameter's id — the feature input on the literal path. */
  readonly literalId: ParameterId;
  /** The new parameter's name — the literal path only. */
  readonly literalName: string;
  /** Builds the literal's dimensional value from the literal number. */
  readonly toLiteralValue: (value: number) => AnyDimensionalValue;
}

/**
 * The feature input the slot contributes: the new literal's parameter id on
 * the literal path, the referenced parameter's id on the reference path.
 */
export function featureSlotInputId(slot: FeatureValueSlot): ParameterId {
  return slot.resolution.kind === "number"
    ? slot.literalId
    : slot.resolution.parameter.id;
}

/**
 * The `parameter.create` command the slot adds — `null` on the reference
 * path, where the existing parameter is referenced and nothing is created.
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
  return null;
}
