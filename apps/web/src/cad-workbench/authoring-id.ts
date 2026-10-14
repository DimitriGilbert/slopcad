/**
 * The minting and plan vocabulary the authoring verbs share (the
 * primitives, the topology cuts, and the face ops): ONE suffix allocator
 * over the document's taken keys, ONE `<verb><Role><suffix>` parameter
 * minting, ONE body label, and ONE ok/refusal plan shape, so every verb's
 * transaction mints collision-free, panel-drivable keys the same way and
 * every engine handler consumes its plan the same way.
 */

import { createParameterId } from "@slopcad/cad-core";
import type {
  BodyId,
  CadCommand,
  CadDocument,
  ParameterId,
} from "@slopcad/cad-core";

/**
 * The first free numeric suffix (`""`, `"2"`, `"3"`, …) for a verb's
 * minted keys in `document`: every feature, body, parameter (id and
 * name), and reference record (id and name) is checked against the keys
 * `mintedOf` lists for a suffix, so an imported or agent-authored
 * `feat_box` or `feat_fillet` never collides with the verb's next one.
 */
export function authoringSuffixOf(
  document: CadDocument,
  mintedOf: (suffix: string) => readonly string[],
): string {
  const taken = new Set<string>([
    ...document.features.map((entry) => entry.id),
    ...document.bodies.map((entry) => entry.id),
    ...document.parameters.parameters.flatMap((entry) => [
      entry.id,
      entry.name,
    ]),
    ...document.references.flatMap((entry) => [entry.id, entry.name]),
  ]);
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : String(n);
    if (!mintedOf(suffix).some((key) => taken.has(key))) return suffix;
  }
}

/** The parameter id a verb mints for one role (`param_box_width2`). */
export function authoringParameterIdOf(
  verb: string,
  role: string,
  suffix: string,
): string {
  return `param_${verb}_${role}${suffix}`;
}

/** The parameter name a verb mints for one role (`boxWidth2`). */
export function authoringParameterNameOf(
  verb: string,
  role: string,
  suffix: string,
): string {
  return `${verb}${role.charAt(0).toUpperCase()}${role.slice(1)}${suffix}`;
}

/** The `parameter.create` command a verb commits. */
export type AuthoringParameterCommand = Extract<
  CadCommand,
  { readonly type: "parameter.create" }
>;

/** The value a minted parameter carries. */
export type AuthoringParameterValue = AuthoringParameterCommand["value"];

/** One minted parameter: its id and its `parameter.create` command. */
export interface AuthoringParameter {
  readonly id: ParameterId;
  readonly command: AuthoringParameterCommand;
}

/**
 * Mints one role's parameter for a verb: the id and name above and the
 * `parameter.create` command carrying `value`.
 */
export function authoringParameterCommand(
  verb: string,
  role: string,
  suffix: string,
  value: AuthoringParameterValue,
): AuthoringParameter {
  const id = createParameterId(authoringParameterIdOf(verb, role, suffix));
  return {
    id,
    command: {
      type: "parameter.create",
      id,
      name: authoringParameterNameOf(verb, role, suffix),
      value,
    },
  };
}

/** The output body's label a verb mints (`box`, `fillet 2`). */
export function authoringLabelOf(verb: string, suffix: string): string {
  return suffix === "" ? verb : `${verb} ${suffix}`;
}

/** A structured pre-commit refusal (nothing is committed). */
export interface AuthoringRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/** Builds a structured pre-commit refusal. */
export function authoringRefusal(
  code: string,
  message: string,
): AuthoringRefusal {
  return { ok: false, code, message };
}

/**
 * The outcome of one verb's plan attempt: the structured refusal, or the
 * ONE atomic transaction plus the body it renders as (and any
 * verb-specific facts the handler needs, `Extra`).
 */
export type AuthoringPlan<Extra extends object = Record<never, never>> =
  | ({
      readonly ok: true;
      readonly commands: readonly CadCommand[];
      readonly bodyId: BodyId;
    } & Extra)
  | AuthoringRefusal;
