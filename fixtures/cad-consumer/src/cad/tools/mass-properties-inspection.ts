import {
  area,
  formatSurfaceArea,
  formatVolume,
  type FeatureRecord,
  type BodyId,
  type SelectionReference,
  selectedBoundsBody,
  volume,
} from "@slopcad/cad-core";

/** What the readout is computed from: the live selection and scene. */
export interface MassPropertiesReadoutInput {
  /** The selected references, insertion order. */
  readonly selected: readonly SelectionReference[];
  /** The document's features (feature references resolve through them). */
  readonly features: readonly FeatureRecord[];
  /** The body the settled scene measured, or `undefined` before a settle. */
  readonly sceneBodyId: BodyId | undefined;
  /** The scene measurement's kernel volume (mm³), or `undefined`. */
  readonly volume: number | undefined;
  /** The scene measurement's kernel surface area (mm²), or `undefined`. */
  readonly area: number | undefined;
  /**
   * The document scene's per-body measurements (Phase 16): when present,
   * the readout answers for EVERY body the settled scene measured — the
   * selected body's OWN kernel volume and area — instead of the
   * single-scene aggregate.
   */
  readonly measuredBodies?:
    | ReadonlyMap<
        string,
        { readonly volume: number; readonly area: number | undefined }
      >
    | undefined;
}

/** The readout the Measurement block's Volume/Area rows render. */
export interface MassPropertiesReadout {
  /**
   * The volume with its unit — `5500.569 mm³` — or `null` when nothing is
   * honestly displayable.
   */
  readonly volumeText: string | null;
  /**
   * The surface area with its unit — `2351.038 mm²` — or `null` when the
   * scene carries no area measurement.
   */
  readonly areaText: string | null;
}

/** Computes the mass-properties readout for the workbench's Measurement block. */
export function massPropertiesReadout(
  input: MassPropertiesReadoutInput,
): MassPropertiesReadout {
  const nothing: MassPropertiesReadout = {
    volumeText: null,
    areaText: null,
  };
  const body = selectedBoundsBody(input.selected, input.features);
  if (body === undefined) return nothing;
  // The document scene: the selected body's own kernel measurement.
  const measured = input.measuredBodies?.get(String(body));
  if (measured !== undefined) {
    return {
      volumeText: `${formatVolume(volume(measured.volume))} mm³`,
      areaText:
        measured.area === undefined
          ? null
          : `${formatSurfaceArea(area(measured.area))} mm²`,
    };
  }
  if (input.volume === undefined || input.sceneBodyId === undefined) {
    return nothing;
  }
  if (body !== input.sceneBodyId) {
    return nothing;
  }
  return {
    volumeText: `${formatVolume(volume(input.volume))} mm³`,
    areaText:
      input.area === undefined
        ? null
        : `${formatSurfaceArea(area(input.area))} mm²`,
  };
}
