import {
  formatRadiusMeasure,
  selectionRadius,
  type FeatureRecord,
  type RenderProjection,
  type SelectionReference,
} from "@slopcad/cad-core";

/** What the readout is computed from: the live selection and scene. */
export interface RadiusReadoutInput {
  /** The selected references, insertion order. */
  readonly selected: readonly SelectionReference[];
  /** The document's features (feature references resolve through them). */
  readonly features: readonly FeatureRecord[];
  /** The settled scene's projection, or `undefined` before a settle. */
  readonly projection: RenderProjection | undefined;
}

/** The readout the Measurement block's Radius row renders. */
export interface RadiusReadout {
  /**
   * The radius with its unit — `R 4.000 mm` — or `null` when nothing is
   * honestly displayable.
   */
  readonly text: string | null;
  /**
   * The diameter dual — `⌀ 8.000 mm` — or `null` when nothing is
   * displayed.
   */
  readonly diameterText: string | null;
  /**
   * What the number measures and how — `face (fit)` — or `null` when
   * nothing is displayed.
   */
  readonly source: string | null;
  /**
   * The structured decline code (`radius/not-single-reference`,
   * `radius/unresolvable-reference`, `radius/not-cylindrical`), or `null`
   * when the displayable state is honest silence (no request yet, no
   * scene).
   */
  readonly declined: string | null;
}

/** Computes the radius readout for the workbench's Measurement block. */
export function radiusReadout(input: RadiusReadoutInput): RadiusReadout {
  const nothing: RadiusReadout = {
    text: null,
    diameterText: null,
    source: null,
    declined: null,
  };
  if (input.projection === undefined || input.selected.length === 0) {
    return nothing;
  }
  const measured = selectionRadius(
    input.selected,
    input.projection.objects,
    input.features,
  );
  if (!measured.ok) {
    return {
      text: null,
      diameterText: null,
      source: null,
      declined: measured.error.code,
    };
  }
  const reference = input.selected[0];
  if (reference === undefined) return nothing;
  const formatted = formatRadiusMeasure(measured.value);
  return {
    text: `R ${formatted.radius} mm`,
    diameterText: `⌀ ${formatted.diameter} mm`,
    source: `${reference.kind} (${measured.value.precision === "exact" ? "exact" : "fit"})`,
    declined: null,
  };
}
