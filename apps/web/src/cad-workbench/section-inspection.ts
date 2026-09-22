/**
 * The workbench's section-mass-properties wiring (Phase 46): from the
 * live selection, the settled scene, and the ACTIVE section plane's
 * kernel measurement to the Section Area / Section COG rows the
 * Measurement block displays — the roadmap's "section-area/COG on the
 * active section plane" at the browser surface.
 *
 * Both values are the settled scene's kernel measurements — `solid.section`
 * through the session/worker path, taken with the booted kernel's own
 * documented semantics (exact BREP integration on OCCT, the analytic
 * box subset on the fake kernel, the cap-face mesh sum on the mesh
 * kernels) — so the readout answers for exactly one subject, the same
 * discipline the mass-properties readout answers to: the selection must
 * resolve to ONE body, that body must be the body the settled scene
 * measured, and the section measurement must belong to the same
 * regeneration. Anything else — nothing selected, an unresolved
 * multi-body selection, a measurement from a stale scene, a plane the
 * kernel declined (section-empty carries NO numbers) — shows nothing
 * rather than another body's or another cut's numbers.
 */

import {
  area,
  formatSectionCentroid,
  formatSurfaceArea,
  type BodyId,
  type FeatureRecord,
  length,
  type SelectionReference,
  selectedBoundsBody,
} from "@slopcad/cad-core";

/** What the section readout is computed from: the live scene state. */
export interface SectionInspectionReadoutInput {
  /** The selected references, insertion order. */
  readonly selected: readonly SelectionReference[];
  /** The document's features (feature references resolve through them). */
  readonly features: readonly FeatureRecord[];
  /** The body the settled scene measured, or `undefined` before a settle. */
  readonly sceneBodyId: BodyId | undefined;
  /**
   * The section measurement's kernel area (mm²) on the active plane, or
   * `undefined` when the scene carries none (no active plane, or the
   * kernel declined the cut — a declined section never loans numbers).
   */
  readonly sectionArea: number | undefined;
  /** The section centroid's world millimetres, same scoping as the area. */
  readonly sectionCentroid: readonly [number, number, number] | undefined;
}

/** The readout the Measurement block's section rows render. */
export interface SectionInspectionReadout {
  /**
   * The cross-section area with its unit — `600.000 mm²` — or `null`
   * when nothing is honestly displayable.
   */
  readonly areaText: string | null;
  /**
   * The centroid as labelled components — `x 15.000 y 10.000 z 5.000`
   * — or `null` under the same honesty rule.
   */
  readonly centroidText: string | null;
}

/** Computes the section readout for the workbench's Measurement block. */
export function sectionInspectionReadout(
  input: SectionInspectionReadoutInput,
): SectionInspectionReadout {
  const nothing: SectionInspectionReadout = {
    areaText: null,
    centroidText: null,
  };
  if (
    input.sectionArea === undefined ||
    input.sectionCentroid === undefined ||
    input.sceneBodyId === undefined
  ) {
    return nothing;
  }
  const body = selectedBoundsBody(input.selected, input.features);
  if (body === undefined || body !== input.sceneBodyId) {
    return nothing;
  }
  const centroid = formatSectionCentroid([
    length(input.sectionCentroid[0]),
    length(input.sectionCentroid[1]),
    length(input.sectionCentroid[2]),
  ]);
  return {
    areaText: `${formatSurfaceArea(area(input.sectionArea))} mm²`,
    centroidText: `x ${centroid[0]} y ${centroid[1]} z ${centroid[2]}`,
  };
}
