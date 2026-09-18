/**
 * The workbench's bounds-inspection wiring (Phase 27.1): from the live
 * selection and the settled scene to the readout the Measurement block
 * displays.
 *
 * The measured bounds are the worker session's `solid.bounds` result — the
 * scene solid's axis-aligned box in canonical millimetres, measured by the
 * real kernel through the session/worker path. The readout therefore
 * answers for exactly one subject: the selection must resolve to ONE body
 * (see `selectedBoundsBody`) and that body must be the body the settled
 * scene measured. Anything else — nothing selected, an unresolved
 * multi-body selection, a selected body the current scene does not
 * measure — shows nothing rather than another body's numbers.
 *
 * Tightness honesty: `tightBooleanBounds` is the booted kernel's own
 * declaration. A kernel that declares it reports the tight axis-aligned
 * boxes of its boolean results; a kernel that does not may report
 * conservative containers, and the readout says so instead of implying a
 * precision the kernel never promised.
 */

import {
  formatBoundsExtents,
  type FeatureRecord,
  type RenderBounds,
  selectedBoundsBody,
  type SelectionReference,
  type BodyId,
} from "@slopcad/cad-core";

/** The booted kernel's bounds-tightness declaration, as displayed. */
export type BoundsTightness = "tight" | "possibly-conservative";

/** What the readout is computed from: the live selection and scene. */
export interface BoundsReadoutInput {
  /** The selected references, insertion order. */
  readonly selected: readonly SelectionReference[];
  /** The document's features (feature references resolve through them). */
  readonly features: readonly FeatureRecord[];
  /** The body the settled scene measured, or `undefined` before a settle. */
  readonly sceneBodyId: BodyId | undefined;
  /** The scene measurement's kernel bounds, or `undefined` before a settle. */
  readonly bounds: RenderBounds | undefined;
  /** The booted kernel's declared `tightBooleanBounds`. */
  readonly tightBooleanBounds: boolean;
}

/** The readout the Measurement block renders. */
export interface BoundsReadout {
  /**
   * The bounding dimensions with their unit — `30.000 × 20.000 × 10.000
   * mm` — or `null` when nothing is honestly displayable.
   */
  readonly text: string | null;
  /** The kernel's declared bounds tightness. */
  readonly tightness: BoundsTightness;
}

/** Computes the bounds readout for the workbench's Measurement block. */
export function boundsReadout(input: BoundsReadoutInput): BoundsReadout {
  const tightness: BoundsTightness = input.tightBooleanBounds
    ? "tight"
    : "possibly-conservative";
  if (input.bounds === undefined || input.sceneBodyId === undefined) {
    return { text: null, tightness };
  }
  const body = selectedBoundsBody(input.selected, input.features);
  if (body === undefined || body !== input.sceneBodyId) {
    return { text: null, tightness };
  }
  return { text: `${formatBoundsExtents(input.bounds)} mm`, tightness };
}
