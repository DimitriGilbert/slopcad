/**
 * The workbench's distance-inspection wiring (Phase 27.2): from the live
 * selection and the settled scene to the readout the Measurement block's
 * Distance row displays.
 *
 * The distance request IS the selection: exactly two selected references
 * measure as a pair (see `selectionDistance`), resolved against the
 * settled scene's render objects — the same current-scene honesty the
 * bounds inspection answers to. Anything else — no request yet (fewer than
 * two references, or no settled scene), a selection larger than a pair, a
 * reference the surfaces cannot resolve — shows nothing, and the
 * structured decline is carried as data (`declined`) so the machine
 * surfaces can distinguish "not requested" from "declined".
 *
 * The Phase 13 measure tool stays the quick point-pair gesture; this
 * readout is the reference matrix. The Distance row prefers this readout
 * and falls back to the tool's completion when no pair is selected (see
 * the page wiring).
 */

import {
  formatMeasureDistance,
  selectionDistance,
  type FeatureRecord,
  type RenderProjection,
  type SelectionReference,
} from "@slopcad/cad-core";

/** What the readout is computed from: the live selection and scene. */
export interface DistanceReadoutInput {
  /** The selected references, insertion order. */
  readonly selected: readonly SelectionReference[];
  /** The document's features (feature references resolve through them). */
  readonly features: readonly FeatureRecord[];
  /** The settled scene's projection, or `undefined` before a settle. */
  readonly projection: RenderProjection | undefined;
}

/** The readout the Measurement block's Distance row renders. */
export interface DistanceReadout {
  /**
   * The pair's distance with its unit — `10.000 mm` — or `null` when
   * nothing is honestly displayable.
   */
  readonly text: string | null;
  /**
   * What the number measures, as the pair's reference kinds —
   * `face ↔ face` — or `null` when nothing is displayed.
   */
  readonly source: string | null;
  /**
   * The structured decline code (`distance/not-a-pair`,
   * `distance/unresolvable-reference`), or `null` when the displayable
   * state is honest silence (no request yet, no scene).
   */
  readonly declined: string | null;
}

/** Computes the distance readout for the workbench's Measurement block. */
export function distanceReadout(input: DistanceReadoutInput): DistanceReadout {
  const nothing: DistanceReadout = {
    text: null,
    source: null,
    declined: null,
  };
  if (input.projection === undefined || input.selected.length < 2) {
    return nothing;
  }
  const measured = selectionDistance(
    input.selected,
    input.projection.objects,
    input.features,
  );
  if (!measured.ok) {
    return { text: null, source: null, declined: measured.error.code };
  }
  const [first, second] = input.selected;
  if (first === undefined || second === undefined) return nothing;
  return {
    text: `${formatMeasureDistance(measured.value)} mm`,
    source: `${first.kind} ↔ ${second.kind}`,
    declined: null,
  };
}
