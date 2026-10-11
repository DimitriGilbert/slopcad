/**
 * The fan-in-a-tube demo body (ROADMAP-SIM Phase 66c): the motor-driven
 * fan demo's geometry — the part `/workbench-sim` tessellates through
 * the real Manifold worker and voxelizes into the 3D occupancy grid the
 * D3Q19 engine spins. Authored per the cad-jsx discipline (the
 * sim-demo-body precedent beside it), and per the SCENE pipeline's own
 * vocabulary: every body is a Sketch + Extrude (the tube's bore a Hole
 * feature — the demo plate's exact pattern), the workbench's
 * document-scene computation serving the sketch-based feature kinds the
 * rendered documents of this repo use. Four bodies, deliberately NOT
 * unioned: the sim's voxelizer consumes the MERGED tessellation of
 * every body, so the duct, the hub, and the two cross-bars are separate
 * solids that meet in the grid:
 *
 * - the DUCT along +Z (an extruded disc with a through bore — the flow
 *   duct; the domain's inlet is the zMin face, the outlet zMax);
 * - the paddle ROTOR on the duct's centreline at mid-height: a hub
 *   cylinder plus two cross-bars (the honest staircase blade form —
 *   the blade COUNT the BPF arithmetic consumes is an authored
 *   scenario field, never counted off the voxels).
 *
 * `boreRadius` is a parameter so the model is a real parametric
 * document — one `parameter.set` re-drives the duct's wall. The default
 * export is what the package's `compile` CLI renders:
 * `pnpm --filter @slopcad/cad-jsx compile ../docs-examples/src/cadjsx/fan-in-tube.tsx`.
 */

import {
  angle,
  Body,
  Circle,
  Extrude,
  Hole,
  Parameter,
  Rectangle,
  Sketch,
} from "@slopcad/cad-jsx";

/** The document id the example's native emission carries. */
export const FAN_IN_TUBE_DOCUMENT_ID = "doc_fan-in-tube";

/**
 * The duct's and rotor's fixed geometry, millimetres (the demo grid's
 * reference).
 */
export const FAN_IN_TUBE = {
  /** The duct shell's outer radius, mm. */
  outerRadius: 14,
  /** The duct's bore (the rotor's tip clearance boundary), mm radius. */
  boreRadius: 10,
  /** The duct's length along +Z, mm (from z = 0). */
  length: 36,
  /** The rotor hub's radius, mm. */
  hubRadius: 2,
  /** The rotor's thickness along Z, mm. */
  rotorThickness: 4,
  /** The rotor's mid-plane height, mm (the shaft axis point's z). */
  rotorZ: 18,
  /** The cross-bars' half-length (the rotor tip radius), mm. */
  barHalfLength: 7,
  /** The cross-bars' thickness (the literal the sketch pairs with), mm. */
  bladeThickness: 2,
  /** The authored blade count the demo scenario's BPF consumes. */
  bladeCount: 4,
} as const;

/**
 * The demo body: four solids — the bored duct, the hub, and the two
 * cross-bars — meeting in the voxelizer's merged grid.
 */
export function FanInTubeModel(): React.JSX.Element {
  const rotorBottom = FAN_IN_TUBE.rotorZ - FAN_IN_TUBE.rotorThickness / 2;
  return (
    <>
      <Parameter
        id="param_bore-radius"
        name="boreRadius"
        value={FAN_IN_TUBE.boreRadius}
      />
      {/* The duct: an extruded disc with a through bore (the bore
          parameter re-drives the wall — outer is fixed, the bore
          moves). */}
      <Sketch id="skd_duct" name="duct profile">
        <Circle
          id="skent_duct-outer"
          cx={0}
          cy={0}
          radius={FAN_IN_TUBE.outerRadius}
        />
      </Sketch>
      <Body id="body_duct" name="duct">
        <Hole
          id="feat_duct-bore"
          type="straight"
          diameter={2 * FAN_IN_TUBE.boreRadius}
          depth={FAN_IN_TUBE.length + 4}
          tipAngle={angle(118, "deg")}
          positionX={0}
          positionY={0}
        >
          <Extrude
            id="feat_duct-shell"
            sketch="skd_duct"
            height={FAN_IN_TUBE.length}
          />
        </Hole>
      </Body>
      {/* The rotor's hub, on the duct's centreline at mid-height. */}
      <Sketch
        id="skd_hub"
        name="hub profile"
        origin={{ x: 0, y: 0, z: rotorBottom }}
      >
        <Circle id="skent_hub" cx={0} cy={0} radius={FAN_IN_TUBE.hubRadius} />
      </Sketch>
      <Body id="body_hub" name="rotor hub">
        <Extrude
          id="feat_hub"
          sketch="skd_hub"
          height={FAN_IN_TUBE.rotorThickness}
        />
      </Body>
      {/* The cross-bars: one along Y, one along X — the four-blade
          paddle (the scenario's authored blade count). */}
      <Sketch
        id="skd_bar-y"
        name="bar along y"
        origin={{ x: 0, y: 0, z: rotorBottom }}
      >
        <Rectangle
          id="skent_bar-y"
          x1={-FAN_IN_TUBE.bladeThickness / 2}
          y1={-FAN_IN_TUBE.barHalfLength}
          x2={FAN_IN_TUBE.bladeThickness / 2}
          y2={FAN_IN_TUBE.barHalfLength}
        />
      </Sketch>
      <Body id="body_bar-y" name="rotor bar y">
        <Extrude
          id="feat_bar-y"
          sketch="skd_bar-y"
          height={FAN_IN_TUBE.rotorThickness}
        />
      </Body>
      <Sketch
        id="skd_bar-x"
        name="bar along x"
        origin={{ x: 0, y: 0, z: rotorBottom }}
      >
        <Rectangle
          id="skent_bar-x"
          x1={-FAN_IN_TUBE.barHalfLength}
          y1={-FAN_IN_TUBE.bladeThickness / 2}
          x2={FAN_IN_TUBE.barHalfLength}
          y2={FAN_IN_TUBE.bladeThickness / 2}
        />
      </Sketch>
      <Body id="body_bar-x" name="rotor bar x">
        <Extrude
          id="feat_bar-x"
          sketch="skd_bar-x"
          height={FAN_IN_TUBE.rotorThickness}
        />
      </Body>
    </>
  );
}

export default FanInTubeModel;
