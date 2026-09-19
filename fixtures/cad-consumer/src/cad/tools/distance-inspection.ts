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
