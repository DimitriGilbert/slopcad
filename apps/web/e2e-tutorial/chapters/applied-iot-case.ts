import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  cameraAttribute,
  collectDownloads,
  DIALOG,
  OCCT_ROOT,
  VIEWPORT_COMPLETE,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import { readFaceAnchors } from "../../e2e-render/helpers";
import {
  createFeature,
  fillLabeledField,
  pickComboboxOption,
} from "../feature-verbs";

// ---------------------------------------------------------------------------
// The dimension stack-up (every number below is the brief, arithmetic shown)
// ---------------------------------------------------------------------------
//
// The commission: a 3D-printable case for a 5×7 cm perfboard hosting a
// SOCKLETED NodeMCU with components on both faces. The owner's modeling
// doctrine, locked: the case starts as ONE BLOCK you extrude and THEN
// empty the inside; the lid is ONE rectangle you extrude, then ANOTHER
// rectangle SMALLER — never one tedious extrude per wall. The model builds
// in the case's natural viewing frame: opening UP, the camera looking down
// into it — and, since the orbit band went free (61157d3), from BELOW it
// too.
//
//   lid plate        76 × 56 × 2.5, extruded UP from the bed at the
//                    footprint — the lid's first rectangle; it sits ON
//                    the case's walls (z 0..2.5 at the rim plane)
//   lid lip          69 × 49 × 3, sketched on the SAME bed plane and
//                    extruded DOWN (z 0..−3) — the doctrine's second,
//                    smaller rectangle, hanging INTO the opening: the
//                    lip is the feature that keeps the lid located. It
//                    runs HALF A MILLIMETRE small a side against the
//                    70 × 50 cavity on purpose — a 70 × 50 lip in a
//                    70 × 50 cavity is a zero-clearance fit no printer
//                    delivers; the narration says so on camera
//   block            76 × 56 × 37.5, extruded DOWN from the bed — the
//                    whole case in one solid (159600 mm³)
//   window           ⌀6.5 drilled along X through the 3 mm plug wall,
//                    center (y, z) = (28, −25.75) — the bore spans
//                    6..12.5 above the floor top (the plug line), depth 3
//                    so the bore removes exactly the wall's own material
//   pocket tool      70 × 50 × 35, extruded DOWN from the bed — the
//                    subtract that empties the block leaves a 2.5 floor
//                    at the bottom (z −37.5..−35) and 3 mm walls to the
//                    opening at z = 0. THE TOOL IS DIMENSION-CONSTRAINED,
//                    not click-placed: drawn with its far corner ON the
//                    final inset, held there by a dimension pair to a
//                    construction anchor at the origin, then its SIZE
//                    dimensions DRIVE the near corner onto (3,3) — the
//                    cavity is 70 × 50 centered at (38,28), every wall
//                    exactly 3 mm, BY CONSTRUCTION
//   standoffs        four ⌀6 × 6 posts SKETCHED ON THE CAVITY FLOOR at
//                    the corner insets (9,9), (67,9), (9,47), (67,47) —
//                    standing 6 proud of the floor top, so the board
//                    rests at z = −29 and its eight socket pins (2.5 mm
//                    apiece under the body) clear the floor for good
//
// ## The frame, and what the probes taught this time
//
// 1. THE FRAME. Extrudes ride the bed workplane, and a signed depth moves
//    either way: the block extrudes DOWN 37.5, so the bed plane IS the
//    opening rim (z = 0) and the floor lands at the case's bottom. The
//    brief's in-use heights read directly: the plug line at 6..12.5 above
//    the floor top, i.e. z −29..−22.5 — and the standoffs put the board's
//    rest plane exactly at the plug line's bottom, z = −29.
// 2. THE LID SITS ON THE BOX, THE LIP DROPS INTO IT — both PLAIN bed
//    extrudes. The plate is the full footprint UP 2.5 (it rests on the
//    rim), the lip the same plane DOWN 3 (it hangs into the cavity).
//    The old build's sketch-on-face lip (a datum-anchored pad, composed
//    into the plate) is gone: with both extrudes plain, the pad reader
//    never fires, no absorption quirk applies (probed: the block later
//    lands OVER the hanging lip and all three bodies stay their own,
//    180383 mm³ on the nose), and the lid teaches as the two rectangles
//    it is. The lid goes FIRST and steps aside through its tree eyes
//    before the block lands, so every box-beat readout counts the case
//    alone.
// 3. THE POCKET TOOL IS DIMENSION-CONSTRAINED — the posts' treatment,
//    adapted to a rectangle's corners. The solver's contract, probed:
//    a dimension whose two operands carry EQUAL normal-matrix diagonals
//    (the posts' lone circle against the lone construction point) freezes
//    one side and the other absorbs the correction; an UNEQUAL pair lets
//    the weaker side absorb — and a lone construction point ALWAYS loses
//    to a rectangle's corner (the implicit chain/parallel/perpendicular
//    rows inflate the corner's diagonal), so a corner-to-point dimension
//    can never MOVE the rectangle; it can only HOLD it. The build uses
//    exactly that: the far corner is drawn ON its final inset (73,53)
//    and HELD there by distanceX/distanceY to the anchor point at the
//    origin (committed at −73 and −53 — the measure runs second minus
//    first — and asserted on camera), while the SIZE pair (corner to
//    corner) is committed at the drawn 63 × 43 and then EDITED to
//    70 × 50: the near corner slides onto (3,3) ON CAMERA (probed: both
//    slides land on the far corners' frozen rows — 73 and 53 never move,
//    the point never moves, the solve reads under-constrained at 2 DOF,
//    the same honest state as the posts). The cavity's position no
//    longer relies on click precision: the committed dimensions say
//    70 × 50 with the far corner at (73,53) from the origin, and
//    76 − 73 = 3 is a wall BY CONSTRUCTION. One horizontal on the
//    bottom edge squares the frame to the world axes (the implicit
//    chain propagates it; a second vertical would be redundant).
//    PICK-MECHANICS NOTE: the pinned anchor picks scroll the sketch
//    surface inside its container (the band contraction the driver's
//    guard catches loudly), so the high rows are picked FIRST in each
//    dimension and re-revealed through the pinned pick itself when a
//    scroll has hidden them — the probe logged both band states and the
//    click that survives each.
// 4. THE WINDOW DRILLS ON THE BLOCK, BEFORE THE POCKET EXISTS. The hole
//    action targets the document's LAST EXTRUDE (the action was never
//    relaxed), so the beat runs while the block IS the last extrude. The
//    bore's depth is 3 — exactly the wall the window needs — because a
//    solid block offers no air to over-cut into: depth 4 would eat 4 mm
//    of solid and the analytic chain would drift. Position fields ride
//    the perpendicular plane in world-axis order — axis 1 drills along X,
//    so (holeX, holeY) = (world y, world z) = (28, −25.75); negative
//    positions commit fine (probed).
// 5. THE SUBTRACT CONSUMES A COMPUTED OPERAND. Commit 72af4ca relaxed the
//    boolean body pool to any body with a computable scene: the subtract
//    targets "holed 1" (the window-bearing block the hole feature
//    outputs) with "pad 4" (the pocket tool) as the tool — and the
//    pre-boolean window SURVIVES the cut (features applied before a
//    boolean compose into its operand solid). The tool body is consumed
//    (hidden) by the subtract; "holed 1" becomes compute-only; the
//    rendered tip is the one "subtract 1" body: the hollow box with its
//    window, 37000.451 mm³ analytic.
// 6. THE STANDOFFS SKETCH ON THE CAVITY FLOOR — the computed-face datum.
//    Commit d5c88c7 let a face picked on a COMPUTED body (the boolean's
//    output) anchor a sketch datum: the pick records the face's
//    same-normal ordinal, and the datum re-derives the floor's plane
//    (z = −35, normal +Z) from the settled scene on every dispatch. The
//    teaching path that makes the floor pickable: the standard TOP view
//    looks straight down the z axis, so the pick ray through the floor's
//    own anchor point enters the opening and hits the floor first (the
//    teaching orbit at iso can't see over the 35 mm walls — the
//    wireframe strips the skins for the EYE, the top view aims the PICK;
//    the pole collapses the elevation readout, so the azimuth's return
//    to 0 is the top view's machine truth).
//    THE ANCHOR SETS THE ORIGIN, THE DIMENSIONS SET THE PLACE. The
//    datum's origin rides the floor face's anchor — the largest
//    tessellation triangle's centroid, wherever the kernel's mesh put it
//    (measured: (46.67, 16.67) on this floor) — so the corner insets
//    land at sketch u −37.7 for the x = 9 posts, OUTSIDE the sketch
//    canvas' fixed window. Plain clicks cannot reach; the sketcher's own
//    answer is the dimension pair: draw the ⌀6 circle near the anchor,
//    mark the anchor with a construction point, commit distanceX and
//    distanceY at the drawn geometry, then edit both dimensions to the
//    signed targets — the circle/point pair is an exact diagonal tie,
//    so the solver moves the FIRST-created entity (the circle) onto the
//    inset, exact to the digit (probed end-to-end: the extruded mesh
//    lands center-dead on the dimensioned spot). One circle, one
//    dimension pair, one extrude UP 6 — four quick rounds of the same
//    trick, a fresh floor datum each round, the datum marker's z pinned
//    at −35 every time (the rim ring at z = 0 shares the floor's
//    normal — a datum resolved there would read 0 and fail the beat
//    loudly, the re-pick discipline the probes taught). The pad
//    composition DECLINES for these (unioning a post over the document's
//    first extrude would erase the pocket), so each standoff renders as
//    its own body beside the shell — the honest shell-plus-posts
//    aggregate the readouts count.
// 7. THE BELOW-PLANE BEAT IS THE ORBIT FREEDOM'S PAYOFF. Commit 61157d3
//    widened the user orbit band to −88..+88: right after the lip lands
//    (the lid alone on stage), upward drags walk the eye UNDER the world
//    plane to about −48°, and the underside reads true — the lip's
//    bottom face closest to the eye, the plate's rim around it, the
//    elevation readout's negative sign as the machine pin. The standard
//    iso view re-aims above the horizon for the lid-aside beat. The
//    case's own interior keeps the WIREFRAME treatment: its floor is
//    CLOSED, so a below-plane case view shows the slab's underside, not
//    the cavity — the wireframe still teaches that beat better.
//
// ## The document IS the scene (Phase 16) — and the chapter teaches it
//
// The applied scene renders every visible lineage. The section instrument
// beats run on the boot plate, which then HIDES through its tree eye —
// from there every readout counts what the stage actually shows. The lid's
// two bodies step out of view before the block lands and step back
// for the lid export; an export carries WHAT RENDERS, so each file is
// scoped by the same visibility control the viewer just learned.
//
//   box file    37679.035 mm³ analytic (37000.451 hollow box with window
//               + 4 × 169.646 standoffs); the mesh measures a hair under
//               analytic — the post cylinders are inscribed-polygon
//               tessellations, and each post rides as its own shell
//   lid file    20783 mm³ analytic, planar-exact (10640 plate + 10143
//               lip); z spans −3..2.5 — the lip dips BELOW the rim plane
// Each export is verified against its analytic volume by summing the
// downloaded mesh's signed tetrahedra, and the box's world bounds
// [0,0,−37.5]–[76,56,0] (the posts stand INSIDE the footprint — the
// bounds don't move) and the lid's [0,0,−3]–[76,56,2.5] are read off the
// meshes' own vertices.

/** The lid's plate: the full footprint, 2.5 thick. */
const PLATE_VOLUME = 76 * 56 * 2.5;
/** The lid's lip: 69 × 49 — half a millimetre of slide clearance a side. */
const LIP_VOLUME = 69 * 49 * 3;
/** The lid file: plate + lip — the doctrine's own lid number. */
const LID_VOLUME = PLATE_VOLUME + LIP_VOLUME;
/** The block: the full footprint, 37.5 tall, extruded below the bed. */
const BLOCK_VOLUME = 76 * 56 * 37.5;
/** The window's through-bore: ⌀6.5 through the 3 mm plug wall. */
const WINDOW_CUT = Math.PI * 3.25 * 3.25 * 3;
/** The block with its window: the hole feature's own body. */
const BLOCKED_VOLUME = BLOCK_VOLUME - WINDOW_CUT;
/** The pocket tool: the board's rectangle, 35 deep. */
const POCKET_VOLUME = 70 * 50 * 35;
/** The hollow box: the subtract's output — walls, floor, window. */
const CASE_VOLUME = BLOCKED_VOLUME - POCKET_VOLUME;
/** One standoff: ⌀6 × 6, sketched on the cavity floor, six proud. */
const POST_VOLUME = Math.PI * 9 * 6;
/** The box file: the hollow box, its window, and the four standoffs. */
const BOX_VOLUME = CASE_VOLUME + 4 * POST_VOLUME;
/** The standoffs' world centers, the corner insets on the cavity floor. */
const POST_CENTERS: readonly (readonly [number, number])[] = [
  [9, 9],
  [67, 9],
  [9, 47],
  [67, 47],
];
/** The cavity floor's top plane — where the datum must resolve. */
const FLOOR_TOP_Z = -35;
/** The boot demo plate's volume (30 × 20 × 10 with the ⌀8 bore). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** The boot demo plate's section area at the mid-height plane (z = 5). */
const BOOT_SECTION_AREA = 30 * 20 - Math.PI * 16;

/** The tessellated-cylinder guard: the box mesh's standoff cylinders land
 * within 0.5% of analytic (the ⌀6 inscribed polygons cost under 0.1%
 * of the whole file), so the house planar band covers the whole file. */
const PLANAR_VOLUME_FLOOR = 0.995;

/**
 * Chapter 30 — the applied capstone. ONE continuous build, blank workbench
 * to a TWO-file print set: the brief and its dimension stack-up, the
 * section instrument on the demo plate, then the lid (the doctrine's two
 * rectangles — plate up, lip hanging down, shown from below the world
 * plane), then the case — the block, the USB window drilled while the
 * block is the hole's target, the dimension-constrained pocket subtract
 * that empties the block through the relaxed boolean pool, and four
 * floor-datum standoffs — and the two view-scoped exports. Every export
 * is verified against its analytic volume and its taught world bounds
 * from the downloaded mesh's own triangles.
 */
export const chapter: ChapterModule = {
  definition: {
    id: "applied-iot-case",
    title: "Applied project: an IoT case for a 5×7 perfboard",
    summary:
      "One continuous build from blank workbench to a two-file print set: the two-slab lid, the block, the window, the subtract that empties it, four sketched standoffs, and the exports.",
    cues: [
      {
        stepId: "brief",
        text: "The commission: a print-ready case for a socketed board, parts on both faces.",
      },
      {
        stepId: "stackup",
        text: "Stack-up: one block, floor 2.5, walls 3, four ⌀6 standoffs, a two-slab lid.",
      },
      {
        stepId: "section-instrument",
        text: "First, the instrument: section cuts a plane and measures the true face.",
      },
      {
        stepId: "section-cut",
        text: "View cut drops the volume to half: you are looking inside the plate.",
      },
      {
        stepId: "section-off",
        text: "Section off. Then the plate hides — the stage belongs to the build now.",
      },
      {
        stepId: "lid-why",
        text: "Start with the lid: one rectangle for the plate, a smaller one for the lip.",
      },
      {
        stepId: "lid-plate",
        text: "The plate: 76 by 56 at the footprint, extruded UP 2.5 — 10640 mm³.",
      },
      {
        stepId: "lid-lip",
        text: "The lip: 69 by 49 on the same bed plane, extruded DOWN 3 — 20783 mm³.",
      },
      {
        stepId: "lid-underside",
        text: "Below the horizon the camera is free: the lip hangs under the plate.",
      },
      {
        stepId: "lid-aside",
        text: "The lid steps aside through its tree eyes — the box gets the stage.",
      },
      {
        stepId: "block",
        text: "The block: 76 by 56 on the bed, extruded DOWN 37.5 — 159600 mm³, one solid.",
      },
      {
        stepId: "window-why",
        text: "The board's USB sits 6 to 12.5 over the floor: the plug line, at y 28.",
      },
      {
        stepId: "window-drill",
        text: "⌀6.5 drilled along X while the block is the target — 159500.451 mm³.",
      },
      {
        stepId: "pocket-why",
        text: "Now empty the inside: a 70 by 50 tool, 35 deep, leaves a 2.5 floor.",
      },
      {
        stepId: "pocket",
        text: "Drawn near the mark, held by dimensions: 70 by 50, walls 3 by construction.",
      },
      {
        stepId: "subtract-open",
        text: "The Boolean form subtracts: target holed 1, tool pad 4.",
      },
      {
        stepId: "subtract",
        text: "The hollow box: 37000.451 mm³ — floor 2.5, walls 3, window kept.",
      },
      {
        stepId: "shell-read",
        text: "Wireframe strips the skins: the cavity opens, the floor reads 2.5.",
      },
      {
        stepId: "standoffs-why",
        text: "Six tall — the socket pins run eight under the board, so nothing touches the floor.",
      },
      {
        stepId: "floor-datum",
        text: "Top view, straight down in: the cavity floor is just a face — sketch on it.",
      },
      {
        stepId: "standoff-one",
        text: "First ⌀6: draw it near the mark, dimension it onto the inset — UP 6.",
      },
      {
        stepId: "standoffs-rest",
        text: "Three more, the same trick: 37679.035 mm³. The case stands on its own floor.",
      },
      {
        stepId: "export-open",
        text: "Shaded again, and print-ready means bytes: two files, box and lid.",
      },
      {
        stepId: "box-scope",
        text: "The lid is already aside: the scene is the box alone — export it.",
      },
      {
        stepId: "export-box",
        text: "The box's STL: 37679.035 mm³ — walls, floor, window, standoffs.",
      },
      {
        stepId: "lid-scope",
        text: "The view flips: the lid alone — its plate and its lip.",
      },
      {
        stepId: "export-lid",
        text: "The lid's STL: 20783 mm³, planar-exact, z from −3 to 2.5.",
      },
      {
        stepId: "recap",
        text: "Two files, one document: box and lid, every part still editable.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    // -- The brief and the stack-up (over the fresh boot) -------------------
    await driver.step("brief");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeCloseTo(BOOT_PLATE_VOLUME, 0);
    await driver.dwell();

    await driver.step("stackup");
    await driver.humanPoint(
      page.locator('[data-testid="complete-feature-timeline"]'),
    );
    await driver.dwell();

    // -- The section instrument (the boot plate is the sectionable scene) ---
    await driver.step("section-instrument");
    await driver.pickTreeNode("body|body_plate");
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-selection-key",
      "body|body_plate",
    );
    const clipToggle = page.locator('[data-testid="section-clip-toggle"]');
    await expect(clipToggle).toHaveAttribute("aria-pressed", "false");
    await driver.humanClick(clipToggle);
    await expect(clipToggle).toHaveAttribute("aria-pressed", "true");
    await waitForRootSettle(page, OCCT_ROOT);
    const areaText =
      (await page.locator('[data-testid="section-area"]').textContent()) ?? "";
    expect(
      Number(areaText.replace(" mm²", "")),
      `section area ${areaText}`,
    ).toBeCloseTo(BOOT_SECTION_AREA, 0);
    await driver.humanPoint(page.locator('[data-testid="section-area"]'));
    await driver.dwell();

    await driver.step("section-cut");
    const viewToggle = page.locator('[data-testid="section-view-toggle"]');
    await driver.humanClick(viewToggle);
    await expect(viewToggle).toHaveAttribute("aria-pressed", "true");
    await waitForRootSettle(page, OCCT_ROOT);
    const cutVolume = Number(
      (await page
        .locator(`#${OCCT_ROOT}`)
        .getAttribute("data-cad-rendered-volume")) ?? "0",
    );
    expect(cutVolume).toBeCloseTo(BOOT_PLATE_VOLUME / 2, -1);
    await driver.pointAtReadout(page.locator("#workbench-volume-readout"));
    await driver.dwell();

    await driver.step("section-off");
    await driver.humanClick(clipToggle);
    await expect(clipToggle).toHaveAttribute("aria-pressed", "false");
    await waitForRootSettle(page, OCCT_ROOT);
    await expect(page.locator('[data-testid="section-area"]')).toHaveCount(0);
    // The stage change the document scene hands the user: the demo plate
    // would ride beside every beat of the build, so it steps offstage
    // through its tree-row eye — the readout then counts the build alone,
    // and the cue numbers and the pixels agree.
    await setBodyVisible(page, driver, "body|body_plate", false);

    // -- The lid: the doctrine's two rectangles, built first -----------------
    await driver.step("lid-why");
    await driver.dwell();

    await driver.step("lid-plate");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // The taught frame anchors at the world origin: the far corner first,
    // the y=0 row second through the pinned pick (the status bar's band).
    await driver.clickCanvasPoint(76, 56);
    await driver.pickPinnedCanvasPoint(0, 0);
    // UP 2.5: the plate starts at the bed plane — the case's rim, which
    // the finished lid will rest ON.
    await extrudeWithDepth(page, driver, "extrudeDepth", "2.5", PLATE_VOLUME, {
      kind: "extrude",
    });
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("lid-lip");
    // The doctrine's second rectangle — but a lid's lip drops INTO the
    // opening, so it extrudes DOWN from the SAME bed plane: z 0..−3,
    // hanging under the plate. 69 × 49, not 70 × 50: the cavity it must
    // enter is 70 × 50, and a zero-clearance fit is a fit no printer
    // delivers — half a millimetre a side is the honest slide fit (the
    // narration says so). A plain bed extrude, like the plate: no datum,
    // no pad composition — two rectangles, two bodies, one lid.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(72.5, 52.5);
    await driver.pickPinnedCanvasPoint(3.5, 3.5);
    await extrudeWithDepth(page, driver, "extrudeDepth2", "-3", LID_VOLUME, {
      kind: "extrude",
    });
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("lid-underside");
    // The freed orbit band's payoff (61157d3): downward drags raise the
    // eye, so upward drags walk UNDER the world plane — and the lid's
    // underside reads true: the lip's bottom face closest to the eye,
    // the plate's rim around it. The negative elevation readout is the
    // machine pin (the helper throws if the band never crosses −45).
    await orbitBelowPlane(page, driver, -45);
    expect(
      Number(await cameraAttribute(page, "elevation-deg")),
    ).toBeLessThanOrEqual(-45);
    await driver.dwell();

    await driver.step("lid-aside");
    // Back above the horizon the standard iso re-aims (the elevation
    // readout's return is the machine truth), then the file-carries-what-
    // renders rule: the lid's two bodies step offstage before the box
    // lands, so every box-beat readout counts the case alone (the
    // section-off beat's own discipline).
    await driver.humanClick(page.locator('[data-testid="view-iso"]'));
    await expect
      .poll(async () => Number(await cameraAttribute(page, "elevation-deg")), {
        timeout: 15_000,
      })
      .toBeGreaterThan(30);
    await setBodyVisible(page, driver, "body|body_extrude", false);
    await setBodyVisible(page, driver, "body|body_extrude2", false);
    await driver.dwell();

    // -- The block (the doctrine's ONE extrude) ------------------------------
    await driver.step("block");
    // The whole case in one solid, extruded DOWN 37.5 from the rim plane
    // — straight past the hanging lip (probed: the two lid bodies stay
    // their own; nothing absorbs).
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(76, 56);
    await driver.pickPinnedCanvasPoint(0, 0);
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth3",
      "-37.5",
      BLOCK_VOLUME,
      { kind: "extrude" },
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The USB window (drilled while the block IS the hole's target) ------
    await driver.step("window-why");
    await driver.dwell();

    await driver.step("window-drill");
    await driver.openCommandMenu(OCCT_ROOT);
    await driver.clickCommandRow(OCCT_ROOT, "hole");
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-scene-kind",
      "hole",
    );
    await driver.dwell();
    // Axis 1 drills along X — the plug wall faces the x-wall — so the
    // position pair rides the perpendicular plane in world-axis order:
    // (y, z) = (28, −25.75), the board's y center and the window's height
    // (6..12.5 above the floor top). Depth 3 is exactly the wall: a solid
    // block offers no air to over-cut into, so the bore removes the
    // wall's own material and nothing else.
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("holeDiameter1", { exact: true }),
      "6.5",
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("holeDepth1", { exact: true }),
      "3",
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("holeX1", { exact: true }),
      "28",
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("holeY1", { exact: true }),
      "-25.75",
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("holeAxis1", { exact: true }),
      "1",
    );
    await applyAndPin(page, driver, BLOCKED_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The pocket tool (dimension-constrained, consumed by the subtract) --
    await driver.step("pocket-why");
    await driver.dwell();

    await driver.step("pocket");
    // The posts' treatment, adapted to a rectangle's corners (the solver
    // contract in the header): the cavity rectangle is drawn with its FAR
    // corner on the final inset (73,53) — 70 × 50 centered on the case
    // would put it there, and 76 − 73 = 3 is a wall — and HELD there by
    // a dimension pair to a construction anchor at the origin. The SIZE
    // pair (corner to corner) is committed at the drawn 63 × 43, then
    // EDITED to 70 × 50: the near corner slides onto (3,3) on camera and
    // every wall lands exactly 3 mm BY CONSTRUCTION — never again
    // dependent on click precision.
    //
    // Pick mechanics: the pinned anchor pick scrolls the surface in its
    // container and the visible band contracts to v ≤ ~40 for the rest
    // of the sketch, so every high row after the anchor lands rides the
    // pinned pick itself (the same locator mechanics, mirrored — it
    // re-reveals the row it picks).
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(10, 10);
    await driver.clickCanvasPoint(73, 53);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, 0, 0);
    // One horizontal squares the frame to the world axes (the implicit
    // chain propagates it; a second vertical would be redundant).
    await driver.activateSketchTool("horizontal");
    await driver.clickCanvasPoint(40, 10);
    // The position pair: far corner first (pinned — the anchor pick has
    // scrolled the band by now), anchor second — measured −73 and −53
    // (second minus first, the posts' convention), asserted below, never
    // edited.
    await driver.activateSketchTool("distanceX");
    await driver.pickPinnedCanvasPoint(70, 53);
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("distanceY");
    await driver.pickPinnedCanvasPoint(70, 53);
    await clickDatumPoint(driver, 0, 0);
    // The size pair at the drawn geometry: near corner → far corners.
    await driver.activateSketchTool("distanceX");
    await driver.clickCanvasPoint(15, 10);
    await driver.clickCanvasPoint(68, 10);
    await driver.activateSketchTool("distanceY");
    await driver.clickCanvasPoint(10, 15);
    await driver.pickPinnedCanvasPoint(10, 48);
    // The constraint readouts on camera (the posts beat's discipline):
    // row 1 rides the position pin, then the pair of size edits drive
    // the near corner in; row 4's landed 50 is the last readout pointed
    // at. Each set pins its value off the sketch surface's constraint
    // JSON — the solve's own record.
    await driver.humanPoint(page.locator("[data-sketch-constraint-id]").nth(1));
    await setSketchDimension(page, driver, 1, -73);
    await setSketchDimension(page, driver, 2, -53);
    await setSketchDimension(page, driver, 3, 70);
    await setSketchDimension(page, driver, 4, 50);
    await driver.humanPoint(page.locator("[data-sketch-constraint-id]").nth(4));
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth4",
      "-35",
      BLOCKED_VOLUME + POCKET_VOLUME,
      { kind: "extrude" },
    );
    await driver.dwell();

    // -- The subtract, through the relaxed boolean pool ----------------------
    await driver.step("subtract-open");
    await driver.openCommandMenu(OCCT_ROOT);
    await driver.clickCommandRow(OCCT_ROOT, "boolean");
    await expect(page.locator(DIALOG)).toBeVisible();
    // The target select is the dialog's second combobox: the pool accepts
    // any body with a computable scene — the window-bearing "holed 1"
    // among them — so the window composes INTO the subtract's operand
    // solid and survives the cut (commit 72af4ca's semantics).
    await pickComboboxOption(page, driver, 1, "holed 1");
    await driver.humanClick(
      page
        .locator(DIALOG)
        .getByRole("checkbox", { name: "pad 4", exact: true }),
    );
    await driver.dwell();

    await driver.step("subtract");
    const subtracted = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "boolean"),
    );
    expect(
      volumeNear(subtracted, CASE_VOLUME),
      `the subtract settled at ${String(subtracted)}`,
    ).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The look into the open case ----------------------------------------
    // The case models opening UP, but the teaching orbit's pitch keeps the
    // walls between the eye and the cavity (the old chapter's measured
    // finding). The bench's honest look-inside is the WIREFRAME display —
    // the skins strip and every interior beat (the cavity, the window, the
    // standoffs) reads in place, while the meshes still raycast so the
    // floor picks stay exact.
    await driver.step("shell-read");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-wireframe"]'),
    );
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-viewport-display-mode",
      "wireframe",
    );
    await driver.dwell();

    // -- The standoffs, sketched ON the cavity floor ------------------------
    await driver.step("standoffs-why");
    await driver.dwell();

    await driver.step("floor-datum");
    // The standard TOP view looks straight down the z axis: through the
    // opening, the pick ray through the floor's own anchor lands on the
    // floor — the view where the computed face is pickable (the datum's
    // resolved z, pinned below, is the loud proof it wasn't the rim).
    // The pole collapses the elevation readout (the camera chapter's own
    // pin): the azimuth returning to 0 is the top view's machine truth.
    await driver.humanClick(page.locator('[data-testid="view-top"]'));
    await expect
      .poll(async () => cameraAttribute(page, "azimuth-deg"), {
        timeout: 15_000,
      })
      .toBe("0");
    await driver.dwell();
    const floorDatum = await sketchOnCavityFloor(page, driver);
    await driver.dwell();

    await driver.step("standoff-one");
    // One circle, one dimension pair, one extrude UP 6: the post stands
    // ON the cavity floor, its top at z = −29 — the board's rest plane,
    // the plug line's bottom. The pad composition declines (the post
    // stays its own body beside the shell), so the readout is the honest
    // aggregate: shell + one standoff.
    const firstCenter = POST_CENTERS[0];
    if (firstCenter === undefined) {
      throw new Error("the standoff grid is empty");
    }
    await drawPostOnDatum(page, driver, floorDatum, firstCenter);
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth5",
      "6",
      CASE_VOLUME + POST_VOLUME,
    );
    // The iso read: through the stripped skins, the post rises from the
    // floor it was sketched on.
    await driver.humanClick(page.locator('[data-testid="view-iso"]'));
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("standoffs-rest");
    // Three more rounds of the same trick — top view, floor datum,
    // circle + dimension pair, UP 6 — then the iso read of the standing
    // four. The extrude ordinals ride 6..8 (the plate, lip, block, and
    // pocket took 1..4), each post's body its own in the render.
    await driver.humanClick(page.locator('[data-testid="view-top"]'));
    await expect
      .poll(async () => cameraAttribute(page, "azimuth-deg"), {
        timeout: 15_000,
      })
      .toBe("0");
    let postDepth = 6;
    let postsVolume = 2 * POST_VOLUME;
    for (const center of POST_CENTERS.slice(1)) {
      const datum = await sketchOnCavityFloor(page, driver);
      await drawPostOnDatum(page, driver, datum, center);
      await extrudeWithDepth(
        page,
        driver,
        `extrudeDepth${String(postDepth)}`,
        "6",
        CASE_VOLUME + postsVolume,
      );
      postsVolume += POST_VOLUME;
      postDepth += 1;
    }
    await driver.humanClick(page.locator('[data-testid="view-iso"]'));
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The STLs that go to the bed ----------------------------------------
    await driver.step("export-open");
    // Back to shaded for the exports: the box is whole and the silhouette
    // is the teaching beat.
    await driver.humanClick(
      page.locator('[data-testid="display-mode-shaded"]'),
    );
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-viewport-display-mode",
      "shaded",
    );
    await driver.dwell();

    await driver.step("box-scope");
    // The lid is already aside (the lid-aside beat hid it): the scene IS
    // the box alone. The export dialog overlays the tree once open, so
    // the scoping always precedes it — the beat's teaching point.
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    await driver.humanPoint(page.locator('[data-testid="cad-export-run-stl"]'));
    await driver.dwell();

    await driver.step("export-box");
    // The scene is the box alone. The mesh pins 37679.035 inside the house
    // band (the standoff cylinders tessellate a hair under analytic), and
    // its vertices span the taught frame: the case's bottom face and the
    // rim plane — the posts stand INSIDE the footprint — read off the
    // triangles the slicer receives.
    await runStlExport(page, driver, BOX_VOLUME, PLANAR_VOLUME_FLOOR, {
      min: [0, 0, -37.5],
      max: [76, 56, 0],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    await driver.dwell();

    await driver.step("lid-scope");
    // The box's bodies step aside, the lid's step back: the same eyes,
    // the opposite file. The pocket tool is NOT touched here — the
    // subtract consumed it (its eye is the boolean's own display state),
    // and it never renders; it rides absorbed inside "subtract 1"'s
    // lineage either way.
    for (const key of [
      "body|body_extrude3",
      "body|body_hole1",
      "body|body_boolean",
      "body|body_extrude5",
      "body|body_extrude6",
      "body|body_extrude7",
      "body|body_extrude8",
    ]) {
      await setBodyVisible(page, driver, key, false);
    }
    for (const key of ["body|body_extrude", "body|body_extrude2"]) {
      await setBodyVisible(page, driver, key, true);
    }
    await driver.dwell();

    await driver.step("export-lid");
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    // The scene is the lid alone: plate + lip, planar-exact, its bounds
    // spanning the lip's dip BELOW the rim plane up through the plate.
    await runStlExport(page, driver, LID_VOLUME, PLANAR_VOLUME_FLOOR, {
      min: [0, 0, -3],
      max: [76, 56, 2.5],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    for (const key of [
      "body|body_extrude3",
      "body|body_hole1",
      "body|body_boolean",
      "body|body_extrude5",
      "body|body_extrude6",
      "body|body_extrude7",
      "body|body_extrude8",
    ]) {
      await setBodyVisible(page, driver, key, true);
    }
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};

/**
 * Orbits the camera BELOW the world plane by upward canvas drags (the
 * drag-the-model convention: downward drags raise the eye, upward drags
 * lower it through the horizon — the band 61157d3 freed to −88..+88).
 * Each round reads the elevation off the viewport's machine surface and
 * stops the moment it crosses `floorElevation`; loud when the band never
 * carries the eye that far. The teaching payoff lives at the lid beat:
 * only from below does the lip's hang read true.
 */
async function orbitBelowPlane(
  page: Page,
  driver: TutorialDriver,
  floorElevation: number,
): Promise<void> {
  const canvas = await page
    .locator(`#${VIEWPORT_COMPLETE} canvas`)
    .boundingBox();
  if (canvas === null) throw new Error("the viewport canvas never mounted");
  const centerX = canvas.x + canvas.width / 2;
  const centerY = canvas.y + canvas.height / 2;
  for (let round = 0; round < 10; round += 1) {
    const elevation = Number(await cameraAttribute(page, "elevation-deg"));
    if (elevation <= floorElevation) return;
    await driver.drag(
      { x: centerX, y: centerY + 60 },
      { x: centerX, y: centerY - 180 },
    );
  }
  throw new Error(
    `the orbit never reached ${String(floorElevation)}° after 10 drags (last read ${await cameraAttribute(page, "elevation-deg")})`,
  );
}

/**
 * One resolved datum plane marker off the workbench's datum surface: the
 * resolved frame the sketch boots on, world millimetres. The surface
 * publishes origin + normal; the sketch's in-plane axes follow the
 * session's own in-plane rule (x = world X for a +z plane, y = the
 * normal cross x — the frames the sketch editor boots on), so the
 * sketch's u/v are the world offsets along those axes.
 */
interface DatumPlaneMarker {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly origin: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  /** The derived in-plane axes (world-aligned for a +z floor). */
  readonly xAxis: readonly [number, number, number];
  readonly yAxis: readonly [number, number, number];
}

/**
 * Reads the LAST datum plane marker off the datum surface — the one the
 * sketch-on-face command just committed and booted the sketch on — with
 * its in-plane axes derived the way the session derives them.
 */
async function lastDatumPlane(page: Page): Promise<DatumPlaneMarker> {
  const raw =
    (await page.locator(`#${OCCT_ROOT}`).getAttribute("data-datums")) ?? "[]";
  const markers = JSON.parse(raw) as readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly resolved?: boolean;
    readonly origin?: readonly [number, number, number];
    readonly normal?: readonly [number, number, number];
  }[];
  const last = markers[markers.length - 1];
  if (
    last === undefined ||
    last.kind !== "plane" ||
    last.origin === undefined ||
    last.normal === undefined
  ) {
    throw new Error(
      `the datum surface holds no resolved plane marker after sketch-on-face: ${raw}`,
    );
  }
  return {
    id: last.id,
    name: last.name,
    kind: last.kind,
    origin: last.origin,
    normal: last.normal,
    xAxis: [1, 0, 0],
    yAxis: [0, 1, 0],
  };
}

/**
 * Sketch-on-face on the CAVITY FLOOR — the computed body's +z face. The
 * top view is already aimed (the caller's beat): the +z anchors of the
 * subtract's body are the rim ring (z = 0) and the floor (z = −35), and
 * the floor is the pick whose datum resolves at −35 — asserted loudly, so
 * a rim pick can never pass silently. The resolved frame rides back to
 * the caller: the circle placements offset from ITS origin.
 */
async function sketchOnCavityFloor(
  page: Page,
  driver: TutorialDriver,
): Promise<DatumPlaneMarker> {
  const anchors = await readFaceAnchors(page, OCCT_ROOT);
  const ups = Object.entries(anchors)
    .filter(([key, anchor]) => {
      if (!key.startsWith("body_boolean/")) return false;
      if (anchor.normal === null) return false;
      return (
        Math.abs(anchor.normal[0]) <= 0.05 &&
        Math.abs(anchor.normal[1]) <= 0.05 &&
        Math.abs(anchor.normal[2] - 1) <= 0.05
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));
  if (ups.length === 0) {
    throw new Error(
      `no +z face anchor on the subtract's body in [${Object.keys(anchors).join(", ")}]`,
    );
  }
  const canvas = await page
    .locator(`#${VIEWPORT_COMPLETE} canvas`)
    .boundingBox();
  if (canvas === null) throw new Error("the viewport canvas never mounted");
  const floorCandidate = ups[0];
  if (floorCandidate === undefined) {
    throw new Error("the +z anchor list collapsed");
  }
  await driver.humanClick({
    x: canvas.x + floorCandidate[1].point[0],
    y: canvas.y + floorCandidate[1].point[1],
  });
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-selection-key",
    /^face\|body_boolean\|\d+\|\d+$/,
  );
  await driver.openCommandMenu(OCCT_ROOT);
  await driver.clickCommandRow(OCCT_ROOT, "sketch-on-face");
  // The datum commits with the command; the surface's JSON lands on the
  // next render — poll the attribute, then read the LAST marker (the one
  // this command booted the sketch on).
  await expect
    .poll(
      async () =>
        (await page.locator(`#${OCCT_ROOT}`).getAttribute("data-datums")) ?? "",
      { timeout: 15_000 },
    )
    .toContain('"resolved":true');
  const datum = await lastDatumPlane(page);
  expect(
    datum.origin[2],
    `the floor datum resolved at z ${String(datum.origin[2])} — the rim ring ate the pick`,
  ).toBeCloseTo(FLOOR_TOP_Z, 1);
  // The sketch's u/v axes ride a world-aligned +z frame: the session's
  // in-plane rule pins x to world X for the floor's normal.
  expect(datum.normal[0]).toBeCloseTo(0, 3);
  expect(datum.normal[1]).toBeCloseTo(0, 3);
  expect(datum.normal[2]).toBeCloseTo(1, 3);
  return datum;
}

/**
 * Where the standoff circle is DRAWN before its dimensions carry it to
 * the corner: a clickable spot clear of the datum's origin mark.
 */
const POST_DRAW_U = 30;
const POST_DRAW_V = 20;

/**
 * Draws one ⌀6 standoff at a WORLD center on the open floor-datum sketch.
 * The datum's origin rides the floor face's own anchor (the largest
 * tessellation triangle's centroid — wherever the kernel's mesh put it),
 * so the corner insets can sit outside the sketch canvas' fixed window
 * (the floor's anchor sits at (46.67, 16.67); the x = 9 insets map to
 * sketch u −37.7, off-canvas). The surface's own answer is DIMENSIONS:
 * draw the circle near the anchor, mark the anchor with a construction
 * point, then two signed dimensions pull the circle's center onto the
 * inset — the solver moves the FIRST-picked entity (the circle) to
 * satisfy the pair (the probed contract; the point at the anchor never
 * moves). Radius rides the drawn clicks: center, then a point exactly
 * 3 mm along +u.
 */
async function drawPostOnDatum(
  page: Page,
  driver: TutorialDriver,
  datum: DatumPlaneMarker,
  world: readonly [number, number],
): Promise<void> {
  const u = world[0] - datum.origin[0];
  const v = world[1] - datum.origin[1];
  await driver.activateSketchTool("circle");
  await clickDatumPoint(driver, POST_DRAW_U, POST_DRAW_V);
  await clickDatumPoint(driver, POST_DRAW_U + 3, POST_DRAW_V);
  await driver.activateSketchTool("point");
  await clickDatumPoint(driver, 0, 0);
  // Both constraints commit at the drawn geometry (measured values),
  // while every pick is still on-canvas; the edits come after.
  await driver.activateSketchTool("distanceX");
  await clickDatumPoint(driver, POST_DRAW_U + 3, POST_DRAW_V);
  await clickDatumPoint(driver, 0, 0);
  await driver.activateSketchTool("distanceY");
  await clickDatumPoint(driver, POST_DRAW_U, POST_DRAW_V + 3);
  await clickDatumPoint(driver, 0, 0);
  // The dimension measures SECOND minus FIRST: point minus circle. The
  // circle's target center is (u, v) from the anchor at (0, 0), so the
  // signed values are the negatives.
  await setSketchDimension(page, driver, 0, -u);
  await setSketchDimension(page, driver, 1, -v);
}

/**
 * One datum-sketch point: the sketch surface's own click when it maps to
 * the visible band, the pinned pick when it hides under the status bar
 * (the same band discipline the rectangles' y = 0 rows ride).
 */
async function clickDatumPoint(
  driver: TutorialDriver,
  u: number,
  v: number,
): Promise<void> {
  if (v >= 6) {
    await driver.clickCanvasPoint(u, v);
  } else {
    await driver.pickPinnedCanvasPoint(u, v);
  }
}

/**
 * Sets one sketch dimension through the inspector (the constraint row,
 * the Dimension field, Apply) and pins the landed value off the sketch
 * surface's constraint JSON — the solve's own record that the dimension
 * carried. The solver re-solves under the new value; the circle's center
 * rides to its target.
 */
async function setSketchDimension(
  page: Page,
  driver: TutorialDriver,
  index: number,
  value: number,
): Promise<void> {
  const row = page.locator("[data-sketch-constraint-id]").nth(index);
  if ((await row.getAttribute("aria-pressed")) !== "true") {
    await driver.humanClick(row);
  }
  await fillLabeledField(
    page,
    driver,
    page.getByLabel("Dimension (mm)", { exact: true }),
    String(value),
  );
  await driver.humanClick(page.getByRole("button", { name: "Apply" }));
  await expect
    .poll(async () => {
      const raw =
        (await page
          .locator('[aria-label="Sketch workspace"]')
          .getAttribute("data-sketch-constraints")) ?? "[]";
      const parsed = JSON.parse(raw) as readonly {
        readonly value?: { readonly value?: number };
      }[];
      return parsed[index]?.value?.value ?? Number.NaN;
    })
    .toBeCloseTo(value, 6);
}

/** The settled scene volume the workbench root publishes. */
async function renderedVolume(page: Page): Promise<string> {
  return (
    (await page
      .locator(`#${OCCT_ROOT}`)
      .getAttribute("data-cad-rendered-volume")) ?? "0"
  );
}

/**
 * Toggles one body's visibility through its model-tree row's eye — the
 * display control the document scene hands the user ("the file carries
 * what renders"). Pointer-first (the glide teaches WHERE the control
 * lives), and loud on the flip: the eye's state attribute is the pin.
 */
async function setBodyVisible(
  page: Page,
  driver: TutorialDriver,
  bodyKey: string,
  visible: boolean,
): Promise<void> {
  const row = page.locator(
    `[data-slot="cad-model-tree"] [data-node-key="${bodyKey}"]`,
  );
  const eye = row.locator("[data-cad-tree-body-visibility]");
  const expected = visible ? "visible" : "hidden";
  // The glide teaches WHERE the control lives (at the row's label, the
  // affordances never eating a pick — the s05d discipline); the click
  // itself rides the locator mechanics, which stay element-exact through
  // the tree's scrolling the way the driver's pinned canvas picks do — a
  // raw pointer click here can land stale one row off and flip a
  // NEIGHBOR body's display state.
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (box === null) throw new Error(`the tree row "${bodyKey}" has no box`);
  const yOffset = Math.min(12, box.height / 2);
  await driver.humanPoint({ x: box.x + 40, y: box.y + yOffset });
  await eye.click();
  await expect(eye).toHaveAttribute("data-cad-tree-body-visibility", expected);
}

/**
 * Waits until the settled scene volume pins `expected` (the house 0.5%
 * band). The OCCT settles ride kernel round-trips whose dispatch-counter
 * anchors can race a late sibling dispatch; the ANALYTIC volume is the
 * wait's real predicate — when the readout pins the number, the feature
 * provably landed.
 */
async function pollVolume(page: Page, expected: number): Promise<string> {
  await expect
    .poll(
      async () => volumeNear(Number(await renderedVolume(page)), expected),
      { timeout: 30_000 },
    )
    .toBe(true);
  return renderedVolume(page);
}

/**
 * Applies one parameter-panel edit and waits for its analytic volume (the
 * same poll discipline as {@link pollVolume} — the Apply's re-dispatch is
 * waited for by its NUMBER, never by a counter anchor).
 */
async function applyAndPin(
  page: Page,
  driver: TutorialDriver,
  expected: number,
): Promise<string> {
  await driver.humanClick(page.getByRole("button", { name: "Apply" }));
  return pollVolume(page, expected);
}

/**
 * Extrudes the open sketch and re-drives its depth through the parameter
 * panel (the sketch extrude commits at the default 10; the panel's Apply
 * carries the real number — negative depths included, the direction edit).
 * `expected` is the re-driven analytic volume — the wait's real predicate,
 * never a dispatch-counter anchor. `opts.kind` pins the published scene
 * kind when the plain-extrude label holds; the FLOOR-DATUM extrudes omit
 * it — the workbench's honest-fallback effect reads the extrude request
 * WITHOUT the computed-face source, so a computed-anchored extrude's
 * label falls back to "hole" while the document scene itself carries the
 * new body (the volume pins below are the beat's real teeth).
 */
async function extrudeWithDepth(
  page: Page,
  driver: TutorialDriver,
  depthLabel: string,
  depth: string,
  expected: number,
  opts?: { readonly kind?: "extrude" },
): Promise<string> {
  const beforeVolume = await renderedVolume(page);
  await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
  if (opts?.kind !== undefined) {
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-scene-kind",
      opts.kind,
    );
  }
  await expect
    .poll(async () => (await renderedVolume(page)) !== beforeVolume, {
      timeout: 30_000,
    })
    .toBe(true);
  await fillLabeledField(
    page,
    driver,
    page.getByLabel(depthLabel, { exact: true }),
    depth,
  );
  return applyAndPin(page, driver, expected);
}

/**
 * The world-frame bounds a downloaded mesh must span: min corner, then
 * max. Planar bodies tessellate corner-exact, so their bounds pin the
 * taught frame's anchor rows (the floor's dip, the wall tops) to the
 * cent.
 */
interface ExpectedMeshBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * The binary STL's axis-aligned vertex bounds (float32-quantized world
 * millimetres — the same facets {@link binaryStlVolume} measures).
 */
function binaryStlBounds(bytes: Buffer): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const triangles = bytes.readUInt32LE(80);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < triangles; index += 1) {
    const base = 84 + index * 50 + 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const at = base + corner * 12;
      const x = bytes.readFloatLE(at);
      const y = bytes.readFloatLE(at + 4);
      const z = bytes.readFloatLE(at + 8);
      min[0] = Math.min(min[0], x);
      max[0] = Math.max(max[0], x);
      min[1] = Math.min(min[1], y);
      max[1] = Math.max(max[1], y);
      min[2] = Math.min(min[2], z);
      max[2] = Math.max(max[2], z);
    }
  }
  return { min, max };
}

/**
 * The binary STL's solid volume: the signed tetrahedra of every facet
 * from the origin (the divergence theorem over the triangle soup — exact
 * for closed orientable meshes, tessellation shortfall and all).
 */
function binaryStlVolume(bytes: Buffer): number {
  const triangles = bytes.readUInt32LE(80);
  let volume = 0;
  for (let index = 0; index < triangles; index += 1) {
    const base = 84 + index * 50 + 12;
    const ax = bytes.readFloatLE(base);
    const ay = bytes.readFloatLE(base + 4);
    const az = bytes.readFloatLE(base + 8);
    const bx = bytes.readFloatLE(base + 12);
    const by = bytes.readFloatLE(base + 16);
    const bz = bytes.readFloatLE(base + 20);
    const cx = bytes.readFloatLE(base + 24);
    const cy = bytes.readFloatLE(base + 28);
    const cz = bytes.readFloatLE(base + 32);
    volume +=
      (ax * (by * cz - bz * cy) +
        ay * (bz * cx - bx * cz) +
        az * (bx * cy - by * cx)) /
      6;
  }
  return Math.abs(volume);
}

/**
 * Runs the open export dialog's STL row and verifies the download is a
 * real binary STL whose own triangles measure `expectedVolume` inside a
 * `floorRatio` band under the analytic number (an inscribed-polygon
 * tessellation never over-measures a convex body; planar bodies land
 * exact). When `expectedBounds` is given, the mesh's own vertices must
 * span those world millimetres — the taught frame's anchor, read off the
 * file the slicer receives. Leaves the dialog OPEN.
 */
async function runStlExport(
  page: Page,
  driver: TutorialDriver,
  expectedVolume: number,
  floorRatio: number,
  expectedBounds?: ExpectedMeshBounds,
): Promise<void> {
  await driver.humanClick(page.getByTestId("cad-export-run-stl"));
  const entry = page.locator('[data-cad-export-entry="stl"]');
  await expect(entry).toContainText("triangles");
  const held = JSON.parse(
    (await page.locator(`#${OCCT_ROOT}`).getAttribute("data-export-held")) ??
      "{}",
  ) as Record<string, number>;
  if (held.stl === undefined) {
    throw new Error("the STL export held no bytes");
  }
  expect(
    held.stl,
    "the STL export must hold real, sized bytes",
  ).toBeGreaterThan(0);
  const downloads = await collectDownloads(
    page,
    () => driver.humanClick(page.getByTestId("cad-export-download-stl")),
    1,
    15_000,
  );
  const stlPath = await downloads[0]?.path();
  if (stlPath === undefined) {
    throw new Error("the STL export did not land");
  }
  const bytes = await readFile(stlPath);
  const triangles = bytes.readUInt32LE(80);
  expect(
    bytes.length,
    "a binary STL is the 84-byte head plus 50 bytes per triangle",
  ).toBe(84 + 50 * triangles);
  const meshVolume = binaryStlVolume(bytes);
  expect(
    meshVolume,
    `the downloaded mesh measures ${meshVolume.toFixed(2)} mm³ against ${expectedVolume.toFixed(2)}`,
  ).toBeGreaterThanOrEqual(expectedVolume * floorRatio);
  expect(meshVolume).toBeLessThanOrEqual(expectedVolume * 1.001);
  if (expectedBounds !== undefined) {
    // The taught frame, read off the mesh's own vertices: planar facets
    // land corner-exact, so the cent of slack only absorbs float32.
    const { min, max } = binaryStlBounds(bytes);
    for (const axis of [0, 1, 2] as const) {
      expect(
        min[axis],
        `mesh min axis ${axis} at ${min[axis].toFixed(4)}`,
      ).toBeGreaterThanOrEqual(expectedBounds.min[axis] - 0.01);
      expect(
        min[axis],
        `mesh min axis ${axis} at ${min[axis].toFixed(4)}`,
      ).toBeLessThanOrEqual(expectedBounds.min[axis] + 0.01);
      expect(
        max[axis],
        `mesh max axis ${axis} at ${max[axis].toFixed(4)}`,
      ).toBeGreaterThanOrEqual(expectedBounds.max[axis] - 0.01);
      expect(
        max[axis],
        `mesh max axis ${axis} at ${max[axis].toFixed(4)}`,
      ).toBeLessThanOrEqual(expectedBounds.max[axis] + 0.01);
    }
  }
}

/** Closes the export dialog with the same Escape the dialog owns. */
async function closeExportDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-export-dialog-open",
    "false",
  );
}
