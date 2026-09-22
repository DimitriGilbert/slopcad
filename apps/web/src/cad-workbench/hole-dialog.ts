/**
 * The structured hole dialog's wiring (Phase 42): the submission vocabulary
 * the Formedible form produces, the shared defaults, and the action-time
 * battery — the thread module's discipline. The form itself lives in
 * `./feature-forms` (schema-driven from the kernel's
 * `structuredHoleRoles` parameter schema); the engine's create action
 * consumes a {@link StructuredHoleSubmission}, refuses doomed submissions
 * BEFORE any commit, and commits the type-directed transaction.
 *
 * The tool geometry is `planStructuredHoleCut`'s ONE source of truth (the
 * bridge and the worker scene compose the identical cut); this module only
 * carries the dialog's values and refuses the authoring-domain failures.
 */

import {
  structuredHoleProblem,
  type StructuredHoleSpec,
} from "@slopcad/cad-kernel";

/** What the hole dialog submits: the spec, the positions, and the axis. */
export interface StructuredHoleSubmission {
  /** The structured specification (every field; the type selects roles). */
  readonly spec: StructuredHoleSpec;
  /** The parameter position (mm, in-plane) — unused with a positions sketch. */
  readonly positionXMm: number;
  readonly positionYMm: number;
  /** The world-axis selector (1–3) — unused with a datum axis. */
  readonly axis: number;
  /** The positions sketch record id, or `null` for the parameter position. */
  readonly positionsSketchId: string | null;
  /** The datum axis record id, or `null` for the world-axis selector. */
  readonly datumAxisId: string | null;
}

/** The dialog's defaults: a Ø8 straight blind hole, 118° tip, on +z. */
export const STRUCTURED_HOLE_DEFAULTS: StructuredHoleSubmission = {
  spec: {
    type: 1,
    diameterMm: 8,
    depthMm: 6,
    tipAngleDeg: 118,
    cboreDiameterMm: 14,
    cboreDepthMm: 3,
    csinkDiameterMm: 14,
    csinkAngleDeg: 90,
    taperAngleDeg: 10,
    threadMajorMm: 6,
    threadPitchMm: 1,
  },
  positionXMm: 15,
  positionYMm: 10,
  axis: 3,
  positionsSketchId: null,
  datumAxisId: null,
};

/** The outcome of one structured hole validation attempt. */
export type StructuredHoleValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The action-time battery: the shared structural spec check (the kernel's
 * own `structuredHoleProblem`, one source) plus the submission's own
 * domains — finite position numbers, the axis selector, and the sketch
 * pick's shape. Target-relative verdicts (tip fit, the no-op miss) belong
 * to the planner at dispatch and the post-condition, never to the form.
 */
export function validateStructuredHoleSubmission(
  submission: StructuredHoleSubmission,
): StructuredHoleValidation {
  const problem = structuredHoleProblem(submission.spec);
  if (problem !== null) {
    return { ok: false, code: problem.code, message: problem.message };
  }
  if (submission.positionsSketchId === null) {
    if (
      !Number.isFinite(submission.positionXMm) ||
      !Number.isFinite(submission.positionYMm)
    ) {
      return {
        ok: false,
        code: "kernel/parameter-invalid",
        message: "The hole's position must be finite in-plane coordinates.",
      };
    }
  }
  if (submission.datumAxisId === null) {
    if (
      submission.axis !== 1 &&
      submission.axis !== 2 &&
      submission.axis !== 3
    ) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message: "The hole's axis selector must be X (1), Y (2), or Z (3).",
      };
    }
  }
  return { ok: true };
}
