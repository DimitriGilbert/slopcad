/**
 * The structural demo body (ROADMAP-SIM Phase 69): the mounting
 * bracket `/workbench-sim` tessellates through the real Manifold worker
 * and voxelizes into the 3D occupancy grid the coarse voxel FEM engine
 * holds loads on — an L-bracket (a base plate bolted down at its bottom
 * face, an upright wall carrying the tip load), the substrate of the
 * Phase 70 "lightest bracket that survives the load" study. Authored
 * per the cad-jsx discipline and the SCENE pipeline's own vocabulary
 * (the fan-in-tube precedent beside it): every body is a Sketch +
 * Extrude, two solids deliberately NOT unioned — the voxelizer consumes
 * each body's OWN tessellation and the per-node material map unions
 * them in the grid, so the base plate and the upright wall meet as one
 * structure where the FEM mesh sees them.
 *
 * `thickness` (the base plate's height) and `wallHeight` (the upright's
 * stand-off) are parameters so the model is a real parametric document
 * — the two drives a Phase 70 study would evolve against the run's
 * factor-of-safety and mass scalars.
 */

import { Body, Extrude, Parameter, Rectangle, Sketch } from "@slopcad/cad-jsx";

/** The document id the example's native emission carries. */
export const BRACKET_DOCUMENT_ID = "doc_bracket";

/**
 * The bracket's fixed geometry, millimetres (the demo grid's
 * reference): the base spans x ∈ [−60, 60], y ∈ [−40, 40], z ∈ [0,
 * thickness]; the upright wall stands at y ∈ [−40, wallInnerY], z ∈ [0,
 * wallHeight]. The tip point is the wall's top-centre — where the demo
 * scenario's point load lands.
 */
export const BRACKET = {
  /** The base plate's half-extent along x, mm. */
  baseHalfX: 60,
  /** The base plate's half-extent along y, mm. */
  baseHalfY: 40,
  /** The base plate's thickness (its extrusion height), mm. */
  thickness: 8,
  /** The upright wall's stand-off height, mm. */
  wallHeight: 80,
  /** The upright wall's inner y plane (its outer plane is yMin), mm. */
  wallInnerY: -32,
  /** The tip-load application point, mm (the wall's top centre). */
  tipPointMm: [0, -36, 80] as const,
} as const;

/**
 * The demo body: the base plate and the upright wall — two sketch +
 * extrude solids meeting in the voxelizer's merged grid.
 */
export function BracketModel(): React.JSX.Element {
  return (
    <>
      <Parameter
        id="param_thickness"
        name="thickness"
        value={BRACKET.thickness}
      />
      <Parameter
        id="param_wall-height"
        name="wallHeight"
        value={BRACKET.wallHeight}
      />
      <Sketch id="skd_base" name="bracket base">
        <Rectangle
          x1={-BRACKET.baseHalfX}
          y1={-BRACKET.baseHalfY}
          x2={BRACKET.baseHalfX}
          y2={BRACKET.baseHalfY}
        />
      </Sketch>
      <Sketch id="skd_wall" name="bracket wall">
        <Rectangle
          x1={-BRACKET.baseHalfX}
          y1={-BRACKET.baseHalfY}
          x2={BRACKET.baseHalfX}
          y2={BRACKET.wallInnerY}
        />
      </Sketch>
      <Body id="body_bracket-base" name="bracket base">
        <Extrude
          id="feat_bracket-base"
          sketch="skd_base"
          height="param_thickness"
        />
      </Body>
      <Body id="body_bracket-wall" name="bracket wall">
        <Extrude
          id="feat_bracket-wall"
          sketch="skd_wall"
          height="param_wall-height"
        />
      </Body>
    </>
  );
}

export default BracketModel;
