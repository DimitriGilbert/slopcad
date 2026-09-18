/**
 * The workbench's mass-properties wiring (Phase 27.4): from the live
 * selection and the settled scene to the Volume and Area rows the
 * Measurement block displays — the plan's "expose volume and supported
 * area/mass-related measurements from kernel capabilities" at the browser
 * surface.
 *
 * Both values are the settled scene's kernel measurements — `solid.volume`
 * and `solid.area` through the session/worker path, each taken with the
 * booted kernel's own documented semantics — so the readout answers for
 * exactly one subject, the same discipline the bounds inspection answers
 * to: the selection must resolve to ONE body (the shared
 * `selectedBoundsBody` resolution) and that body must be the body the
 * settled scene measured. Anything else — nothing selected, an unresolved
 * multi-body selection, a selected body the current scene does not measure
 * — shows nothing rather than another body's numbers.
 *
 * Scoping honesty: mass itself has no row. The kernel contract has no
 * density model, so `mass = density × volume` is a downstream consumer's
 * unit algebra over the volume readout, not a measurement this product
 * fabricates.
 */

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
  if (input.volume === undefined || input.sceneBodyId === undefined) {
    return nothing;
  }
  const body = selectedBoundsBody(input.selected, input.features);
  if (body === undefined || body !== input.sceneBodyId) {
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
