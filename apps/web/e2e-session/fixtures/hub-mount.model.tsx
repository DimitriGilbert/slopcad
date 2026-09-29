/**
 * The session journey's TSX import fixture (Phase 4): a hub mount
 * authored as a `@slopcad/cad-jsx` model — a parameterized extruded
 * plate, a revolved ring meridian, a lofted boss, and the booleans that
 * clear and join them (the guide's shape, with the timeline ids the
 * stage asserts). The session's file chooser sends these exact bytes to
 * the app server's `/api/io/import-tsx` loader, whose sandbox resolves
 * the one import a model may make.
 */

import {
  Body,
  Circle,
  Extrude,
  Loft,
  Parameter,
  Rectangle,
  Revolve,
  Sketch,
  Subtract,
  Union,
  Use,
} from "@slopcad/cad-jsx";

export default (
  <>
    <Parameter id={"param_plateHeight"} name={"plateHeight"} value={6} />
    <Sketch id={"skd_plate"} name={"plate profile"}>
      <Rectangle id={"skent_plate"} x1={-30} y1={-20} x2={30} y2={20} />
    </Sketch>
    <Extrude
      id={"feat_plate"}
      sketch={"skd_plate"}
      height={"param_plateHeight"}
    />
    <Sketch id={"skd_ring"} name={"ring meridian"}>
      <Circle id={"skent_ring"} cx={12} cy={0} radius={2} />
    </Sketch>
    <Revolve
      id={"feat_ring"}
      sketch={"skd_ring"}
      angle={Math.PI * 2}
      axis={Math.PI / 2}
    />
    <Sketch id={"skd_boss-base"} name={"boss base"}>
      <Circle id={"skent_boss-base"} cx={0} cy={0} radius={8} />
    </Sketch>
    <Sketch id={"skd_boss-top"} name={"boss top"}>
      <Circle id={"skent_boss-top"} cx={0} cy={0} radius={5} />
    </Sketch>
    <Loft
      id={"feat_boss"}
      sections={[
        { sketch: "skd_boss-base", z: 6 },
        { sketch: "skd_boss-top", z: 12 },
      ]}
    />
    <Subtract id={"feat_cleared"}>
      <Use feature={"feat_plate"} />
      <Use feature={"feat_ring"} />
    </Subtract>
    <Body id={"body_mount"} name={"mount"}>
      <Union id={"feat_mount"}>
        <Use feature={"feat_cleared"} />
        <Use feature={"feat_boss"} />
      </Union>
    </Body>
  </>
);
