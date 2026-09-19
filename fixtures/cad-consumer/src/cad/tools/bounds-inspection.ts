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
