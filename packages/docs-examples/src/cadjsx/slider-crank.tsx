/**
 * The slider-crank demo bodies (ROADMAP-SIM Phase 67c): the
 * engine-kinematics demo's geometry — the four solids the
 * `/workbench-sim` SLIDER-CRANK mode tessellates through the real
 * Manifold worker and animates through the assembly-motion surface
 * from a dynamics run's own joint histories. Authored per the cad-jsx
 * discipline (the fan-in-tube precedent beside it), every body a
 * Sketch + Extrude, deliberately NOT unioned: the mechanism's links
 * are separate solids placed as OCCURRENCES and joined by the
 * document's joint records (the 51 vocabulary):
 *
 * - the BASE PLATE under the mechanism plane (the grounded frame; the
 *   crank axis sits at its local origin);
 * - the CRANK — a bar whose length is the crank radius, its local
 *   origin ON the main-bearing axis, extending along +x at θ = 0;
 * - the CONNECTING ROD — a bar of the rod length, its local origin at
 *   the crank-pin end, extending along +x at θ = 0;
 * - the PISTON — a block centred on its own local origin (the wrist
 *   pin), riding the mechanism's centreline.
 *
 * `crankRadius` is a parameter so the model is a real parametric
 * document (the fan demo's `boreRadius` precedent: the authored
 * record beside geometry that restates the constant). The default
 * export is what the package's `compile` CLI renders:
 * `pnpm --filter @slopcad/cad-jsx compile ../docs-examples/src/cadjsx/slider-crank.tsx`.
 */

import { Body, Extrude, Parameter, Rectangle, Sketch } from "@slopcad/cad-jsx";

/** The document id the example's native emission carries. */
export const SLIDER_CRANK_DOCUMENT_ID = "doc_slider-crank";

/**
 * The mechanism's fixed geometry, millimetres (the joint records, the
 * mass twin, and the demo scenario all restate these — the honest demo
 * scale stated once per layer, the fan demo's discipline).
 */
export const SLIDER_CRANK = {
  /** The crank radius (the crank bar's length), mm. */
  crankRadiusMm: 30,
  /** The connecting rod's length, mm. */
  rodLengthMm: 90,
  /** The link bars' thickness about the mechanism plane, mm. */
  linkThicknessMm: 4,
  /** The base plate's z offset below the links, mm. */
  baseOffsetMm: 4,
  /** The piston block's half-length along x, mm. */
  pistonHalfXMm: 12,
  /** The piston block's half-width along y, mm. */
  pistonHalfYMm: 14,
  /** The piston block's thickness along z, mm. */
  pistonThicknessMm: 16,
} as const;

/**
 * The demo body: four solids — the base plate, the crank bar, the
 * connecting rod, and the piston block — meeting only through the
 * document's joint records.
 */
export function SliderCrankModel(): React.JSX.Element {
  const linkZ = -SLIDER_CRANK.linkThicknessMm / 2;
  const baseZ = -SLIDER_CRANK.linkThicknessMm - SLIDER_CRANK.baseOffsetMm;
  const rodZ = -SLIDER_CRANK.linkThicknessMm / 2 + 0.5;
  return (
    <>
      <Parameter
        id="param_crank-radius"
        name="crankRadius"
        value={SLIDER_CRANK.crankRadiusMm}
      />
      {/* The base plate: the grounded frame under the mechanism plane. */}
      <Sketch
        id="skd_base"
        name="base plate profile"
        origin={{ x: 0, y: 0, z: baseZ }}
      >
        <Rectangle id="skent_base" x1={-10} y1={-30} x2={140} y2={30} />
      </Sketch>
      <Body id="body_base" name="base plate">
        <Extrude id="feat_base" sketch="skd_base" height={4} />
      </Body>
      {/* The crank bar: local origin on the main-bearing axis, along +x. */}
      <Sketch
        id="skd_crank"
        name="crank profile"
        origin={{ x: 0, y: 0, z: linkZ }}
      >
        <Rectangle id="skent_crank" x1={0} y1={-6} x2={30} y2={6} />
      </Sketch>
      <Body id="body_crank" name="crank">
        <Extrude
          id="feat_crank"
          sketch="skd_crank"
          height={SLIDER_CRANK.linkThicknessMm}
        />
      </Body>
      {/* The connecting rod: local origin at the crank-pin end, along +x. */}
      <Sketch id="skd_rod" name="rod profile" origin={{ x: 0, y: 0, z: rodZ }}>
        <Rectangle id="skent_rod" x1={0} y1={-5} x2={90} y2={5} />
      </Sketch>
      <Body id="body_rod" name="connecting rod">
        <Extrude
          id="feat_rod"
          sketch="skd_rod"
          height={SLIDER_CRANK.linkThicknessMm - 1}
        />
      </Body>
      {/* The piston block: centred on its own origin (the wrist pin). */}
      <Sketch
        id="skd_piston"
        name="piston profile"
        origin={{ x: 0, y: 0, z: -SLIDER_CRANK.pistonThicknessMm / 2 }}
      >
        <Rectangle
          id="skent_piston"
          x1={-SLIDER_CRANK.pistonHalfXMm}
          y1={-SLIDER_CRANK.pistonHalfYMm}
          x2={SLIDER_CRANK.pistonHalfXMm}
          y2={SLIDER_CRANK.pistonHalfYMm}
        />
      </Sketch>
      <Body id="body_piston" name="piston">
        <Extrude
          id="feat_piston"
          sketch="skd_piston"
          height={SLIDER_CRANK.pistonThicknessMm}
        />
      </Body>
    </>
  );
}

export default SliderCrankModel;
