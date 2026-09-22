/**
 * The workbench's body-management wiring (Phase 44): the validation seam
 * for the RENAME form and the reader that derives the model tree's body
 * display state. The mutations themselves ride the `body.update` command
 * (rename, visibility, isolation) through the engine's transaction
 * choreography — one command per concern, exactly the command layer's
 * partial-update design.
 */

import type { Body } from "@slopcad/cad-core";

/** The rename form's authoring input. */
export interface BodyRenameInput {
  readonly name: string;
}

/** The rename form's default (filled with the body's current name by the host). */
export const BODY_RENAME_DEFAULTS: BodyRenameInput = { name: "" };

/** The outcome of one validation attempt (the structured refusal). */
export type BodyManagementValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Refuses the impossible rename submissions BEFORE any commit: an empty
 * name (the substrate's own rule, surfaced here so the form shows it
 * before the transaction) or a name of nothing but whitespace.
 */
export function validateBodyRenameSubmission(
  input: BodyRenameInput,
): BodyManagementValidation {
  if (input.name.trim().length === 0) {
    return {
      ok: false,
      code: "document/malformed",
      message: "A body name must be a non-empty string.",
    };
  }
  return { ok: true };
}

/** The model tree's per-body display state, defaulted from the record's flags. */
export interface BodyDisplayState {
  readonly visible: boolean;
  readonly isolated: boolean;
}

/**
 * Reads a body record's display flags into the tree's defaulted form:
 * absent flags are visible-on / isolation-off (the record's own
 * documented defaults, made explicit for the affordances that render
 * them).
 */
export function bodyDisplayStateOf(body: Body): BodyDisplayState {
  return {
    visible: body.visible !== false,
    isolated: body.isolated === true,
  };
}
