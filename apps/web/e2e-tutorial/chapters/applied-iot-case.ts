import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  collectDownloads,
  OCCT_ROOT,
  VIEWPORT_COMPLETE,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import { readFaceAnchors } from "../../e2e-render/helpers";
import { fillLabeledField } from "../feature-verbs";

// ---------------------------------------------------------------------------
// The dimension stack-up (every number below is the brief, arithmetic shown)
// ---------------------------------------------------------------------------
//
// The commission: a 3D-printable case for a 5×7 cm perfboard hosting a
// SOCKLETED NodeMCU with components on BOTH faces — clearance above and
// below, standoffs so nothing rests on the floor, a USB cutout, a lid that
// registers on the walls. The model builds in the case's NATURAL viewing
// frame: opening UP, the camera looking down into it.
//
//   board            70 × 50 × 1.6   (the 5×7 cm perfboard)
//   wall margin      3 all round  →  footprint 76 × 56
//   floor            2.5 (dips BELOW the bed: the bed plane is its top)
//   walls            3 thick, 35 tall, standing ON the floor's top
//   posts            ⌀6 × 6 on the bed plane (= the floor's top), centers
//                    inset 6 off the board's corners → (9,9), (67,9),
//                    (9,47), (67,47); the board rests at 6
//   port window      ⌀6.5 through-drill along X through the plug wall,
//                    center (y, z) = (28, 9.25) → the hole spans 6..12.5
//                    above the floor (the connector plus the cable drop)
//   lid              four rim walls 3 × 5.5 at the footprint border plus a
//                    70 × 50 × 2.5 plate hung on the rims' tops — the
//                    underside slot (70 × 50 × 3) drops over the wall tops
//
// ## The frame, and the two boundaries the probes taught
//
// 1. THE FRAME. Extrudes ride the bed workplane, and a signed depth moves
//    either way (the Phase 15 finding, re-proven): the FLOOR extrudes DOWN
//    2.5, so the bed plane IS the floor's top face — every later sketch
//    (walls, posts) is a plain bed sketch and every wall stands on the
//    floor without a datum. The case models opening UP because the build
//    is upside down no more: the brief's "in use" heights read directly
//    (the plug line at 6..12.5 above the floor).
// 2. SKETCH-ON-FACE RESOLVES EXTRUSION CAPS. The datum the verb commits
//    resolves against the producing extrude's two caps — a boolean body's
//    faces and side walls refuse (the probes' structured refusal is the
//    old carve's lesson), and a buried cap never wins the pick ray. So the
//    box is BUILT, not carved: four walls as plain bed extrudes land the
//    exact shell material a blank-minus-pocket carve would leave (37100
//    analytic before the window), the rims anchor on the fourth wall's top
//    cap, and the lid's plate anchors on the first rim's top with a
//    NEGATIVE depth (down 2.5 — the recess is real, not a lip).
//
// ## The document IS the scene (Phase 16) — and the chapter teaches it
//
// The applied scene renders every visible lineage. The section instrument
// beats run on the boot plate, which then HIDES through its tree eye —
// from there every readout counts the case alone. The lid's pieces step
// out of view for the box export and the box's pieces for the lid export:
// an export carries WHAT RENDERS, so each file is scoped by the same
// visibility control the viewer just learned. The open/close beat hides
// the plate alone: top view, the posts stand INSIDE the case, in place.
//
//   box file    37679.03 mm³ analytic (37100 shell − 99.54 window
//               + 4 × 169.65 posts); the mesh measures ~37673 — the bore
//               and post cylinders are inscribed-polygon tessellations
//   lid file    12908 mm³ analytic, planar-exact (4158 rims + 8750 plate)
// Each export is verified against its analytic volume by summing the
// downloaded mesh's signed tetrahedra, and the box's world bounds
// [0,0,−2.5]–[76,56,35] and the lid's [0,0,35]–[76,56,40.5] are read off
// the meshes' own vertices.

/** The floor slab: the full footprint, 2.5 thick, below the bed plane. */
const FLOOR_VOLUME = 76 * 56 * 2.5;
/** One long wall: 76 × 3 × 35. */
const WALL_LONG = 76 * 3 * 35;
/** One short wall: 3 × 50 × 35. */
const WALL_SHORT = 3 * 50 * 35;
/** The shell: floor + two long + two short walls (the carve's own number). */
const SHELL_VOLUME = FLOOR_VOLUME + 2 * WALL_LONG + 2 * WALL_SHORT;
/** The window's through-bore: ⌀6.5 through the 3 mm plug wall. */
const WINDOW_CUT = Math.PI * 3.25 * 3.25 * 3;
/** The shell with its window: the box body set's own material. */
const CASE_VOLUME = SHELL_VOLUME - WINDOW_CUT;
/** One long rim: 76 × 3 × 5.5. */
const RIM_LONG = 76 * 3 * 5.5;
/** One short rim: 3 × 50 × 5.5. */
const RIM_SHORT = 3 * 50 * 5.5;
/** The lid's mating rim: four rim walls at the footprint border. */
const RIMS_VOLUME = 2 * RIM_LONG + 2 * RIM_SHORT;
/** The lid's plate: the board's rectangle, 2.5 thick. */
const PLATE_VOLUME = 70 * 50 * 2.5;
/** The lid: rims + plate — the doctrine's own lid number. */
const LID_VOLUME = RIMS_VOLUME + PLATE_VOLUME;
/** One standoff post: ⌀6 × 6. */
const POST_VOLUME = Math.PI * 9 * 6;
/** The box file: the case, its window, and the four posts. */
const BOX_VOLUME = CASE_VOLUME + 4 * POST_VOLUME;
/** The boot demo plate's volume (30 × 20 × 10 with the ⌀8 bore). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** The boot demo plate's section area at the mid-height plane (z = 5). */
const BOOT_SECTION_AREA = 30 * 20 - Math.PI * 16;

/** The tessellated-cylinder guard: the box mesh's bore and posts land
 * within 0.1% of analytic (measured 37673.42 vs 37679.03), so the house
 * planar band covers the whole file. */
const PLANAR_VOLUME_FLOOR = 0.995;

/**
 * Chapter 30 — the applied capstone. ONE continuous build, blank workbench
 * to a TWO-file print set: the brief and its dimension stack-up, the
 * section instrument on the demo plate, then the case itself — the floor,
 * four walls in the bed's frame, the USB window drilled on the plug line,
 * the lid's mating rim sketched ON the wall tops, the lid's plate hung on
 * the rims with a real underside slot, the open/close beat with the posts
 * standing INSIDE the case, and the two view-scoped exports. Every export
 * is verified against its analytic volume and its taught world bounds from
 * the downloaded mesh's own triangles.
 */
export const chapter: ChapterModule = {
  definition: {
    id: "applied-iot-case",
    title: "Applied project: an IoT case for a 5×7 perfboard",
    summary:
      "One continuous build from blank workbench to a two-file print set: floor, walls, USB window, the lid's mating rim and slotted plate, posts inside, and the exports.",
    cues: [
      {
        stepId: "brief",
        text: "The commission: a print-ready case for a socketed board, parts on both faces.",
      },
      {
        stepId: "stackup",
        text: "The stack-up: floor 2.5, walls 3 and 35, posts 6, a lid that slots on top.",
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
        text: "Section off. Then the plate hides — the stage belongs to the case now.",
      },
      {
        stepId: "floor",
        text: "The floor: 76 by 56, 2.5 thick, extruded DOWN — its top face is the bed.",
      },
      {
        stepId: "wall-one",
        text: "The first wall rides the bed plane — the floor's own top: 3 by 35.",
      },
      {
        stepId: "wall-two",
        text: "The second wall, the same plane. The case builds in the bed's frame.",
      },
      {
        stepId: "wall-three",
        text: "Three walls: 31850 mm³. The fourth waits — the window comes first.",
      },
      {
        stepId: "window-why",
        text: "The board's USB sits 6 to 12.5 above the floor: the plug line, at 9.25.",
      },
      {
        stepId: "window-drill",
        text: "⌀6.5 through the plug wall at the plug line — 31750.5 mm³.",
      },
      {
        stepId: "wall-four",
        text: "The fourth wall closes the ring: 76 by 56, 35 tall — 37000.5 mm³. The case stands.",
      },
      {
        stepId: "shell-read",
        text: "The wireframe strips the skins — the case reads open.",
      },
      {
        stepId: "rim-why",
        text: "The lid registers on the walls: a 3 mm rim, 5.5 tall, all round the top.",
      },
      {
        stepId: "rim-one",
        text: "The first rim is sketched ON a wall's top face — select it, sketch on it.",
      },
      {
        stepId: "rim-rest",
        text: "Three rims more, each on a wall top: 4158 mm³ of mating band.",
      },
      {
        stepId: "plate-why",
        text: "The plate: 70 by 50, hung 3 below the rim tops — the slot for the walls.",
      },
      {
        stepId: "plate",
        text: "Sketched on the rim's top, extruded down 2.5: the lid reads 12908 mm³.",
      },
      {
        stepId: "open-case",
        text: "The lid's plate steps off — the case opens: floor and walls.",
      },
      {
        stepId: "post-why",
        text: "Four ⌀6 posts, six in from the edges: air under the board, pins and all.",
      },
      {
        stepId: "post-one",
        text: "The first post rises on the bed plane — 6 tall, at the corner inset.",
      },
      {
        stepId: "posts-rest",
        text: "Three more at the corners: the board rests at 6, touching nothing.",
      },
      {
        stepId: "close-case",
        text: "The lid returns: rim on the walls, plate on top — the case is closed.",
      },
      {
        stepId: "export-open",
        text: "Print-ready means bytes: the set is two files — the box and the lid.",
      },
      {
        stepId: "box-scope",
        text: "The lid's bodies step out of view: the scene is the box alone.",
      },
      {
        stepId: "export-box",
        text: "The box's STL: 37679 mm³ of mesh — walls, floor, window, posts.",
      },
      {
        stepId: "lid-scope",
        text: "The view flips: the lid alone — its rim ring and its plate.",
      },
      {
        stepId: "export-lid",
        text: "The lid's STL: 12908 mm³, the slot read straight off the triangles.",
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
    // The stage change the document scene hands the user: the case's
    // 76 × 56 footprint would bury the demo plate whole, so the plate
    // steps offstage through its tree-row eye — the readout then counts
    // the case alone, and the cue numbers and the pixels agree.
    await setBodyVisible(page, driver, "body|body_plate", false);

    // -- The floor (the blank's role): full footprint, dipping below -------
    await driver.step("floor");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // The taught frame anchors at the world origin: the far corner first,
    // the y=0 row second through the pinned pick (the status bar's band).
    await driver.clickCanvasPoint(76, 56);
    await driver.pickPinnedCanvasPoint(0, 0);
    await extrudeWithDepth(page, driver, "extrudeDepth", "-2.5", FLOOR_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The walls: plain bed extrudes standing on the floor's top ---------
    await driver.step("wall-one");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // The first wall's band spans y 0..3 — BOTH corners live in the
    // status bar's hidden rows, so both corners ride the pinned pick.
    await driver.pickPinnedCanvasPoint(76, 3);
    await driver.pickPinnedCanvasPoint(0, 0);
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth2",
      "35",
      FLOOR_VOLUME + WALL_LONG,
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("wall-two");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(76, 56);
    await driver.clickCanvasPoint(0, 53);
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth3",
      "35",
      FLOOR_VOLUME + 2 * WALL_LONG,
    );
    await driver.dwell();

    await driver.step("wall-three");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // The cavity is the board's own rectangle: far corner first, the 3 mm
    // band row second through the pinned pick.
    await driver.clickCanvasPoint(3, 53);
    await driver.pickPinnedCanvasPoint(0, 3);
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth4",
      "35",
      FLOOR_VOLUME + 2 * WALL_LONG + WALL_SHORT,
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The USB window (drilled before the fourth wall exists: the hole
    // consumes its target wall, and the fourth wall's top face then hosts
    // every rim datum) ------------------------------------------------------
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
    // (y, z) = (28, 9.25), the board's y center and the window's height
    // (6..12.5 above the floor's top). Depth 4 crosses the 3 mm wall.
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
      "4",
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
      "9.25",
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("holeAxis1", { exact: true }),
      "1",
    );
    await applyAndPin(
      page,
      driver,
      FLOOR_VOLUME + 2 * WALL_LONG + WALL_SHORT - WINDOW_CUT,
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("wall-four");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(76, 53);
    await driver.pickPinnedCanvasPoint(73, 3);
    await extrudeWithDepth(page, driver, "extrudeDepth5", "35", CASE_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The look into the open case ----------------------------------------
    // The case models opening UP, but the orbit's pitch clamps at the world
    // horizon (the old chapter's measured finding): no reachable camera
    // looks steeply enough to see over the 35 mm walls. The bench's honest
    // look-inside is the WIREFRAME display — the skins strip and every
    // interior beat (the rims, the slot, the posts) reads in place, while
    // the meshes still raycast so the face picks stay exact.
    await driver.step("shell-read");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-wireframe"]'),
    );
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-viewport-display-mode",
      "wireframe",
    );
    await driver.dwell();

    // -- The lid's mating rim: sketched ON the wall tops --------------------
    await driver.step("rim-why");
    await driver.dwell();

    await driver.step("rim-one");
    // The verb the owner asked for: select a real face, sketch ON it. The
    // fourth wall's top cap hosts every rim datum — it is never consumed
    // (the hole's target was the third wall) and only its OWN rim, which
    // lands last, ever covers it.
    await sketchOnFaceAt(page, driver, "body_extrude5/", [0, 0, 1]);
    await driver.activateSketchTool("rectangle");
    // The rim's band spans y 0..3 — both corners ride the pinned pick.
    await driver.pickPinnedCanvasPoint(76, 3);
    await driver.pickPinnedCanvasPoint(0, 0);
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth6",
      "5.5",
      CASE_VOLUME + RIM_LONG,
    );
    await driver.dwell();

    await driver.step("rim-rest");
    let rimRunning = CASE_VOLUME + RIM_LONG;
    for (const [body, depthLabel, corners, added] of [
      ["body_extrude5/", "extrudeDepth7", [76, 56, 0, 53], RIM_LONG],
      ["body_extrude5/", "extrudeDepth8", [3, 53, 0, 3], RIM_SHORT],
      ["body_extrude5/", "extrudeDepth9", [76, 53, 73, 3], RIM_SHORT],
    ] as const) {
      await sketchOnFaceAt(page, driver, body, [0, 0, 1]);
      await driver.activateSketchTool("rectangle");
      await driver.clickCanvasPoint(corners[0], corners[1]);
      if (corners[3] <= 5) {
        await driver.pickPinnedCanvasPoint(corners[2], corners[3]);
      } else {
        await driver.clickCanvasPoint(corners[2], corners[3]);
      }
      rimRunning += added;
      await extrudeWithDepth(page, driver, depthLabel, "5.5", rimRunning);
    }
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The lid's plate: hung on the rims' tops, a real underside slot ----
    await driver.step("plate-why");
    await driver.dwell();

    await driver.step("plate");
    await sketchOnFaceAt(page, driver, "body_extrude6/", [0, 0, 1]);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(73, 53);
    await driver.pickPinnedCanvasPoint(3, 3);
    // NEGATIVE depth on the datum: the plate hangs DOWN 2.5 from the
    // rims' tops — its underside slot (70 × 50 × 3) drops over the walls.
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth10",
      "-2.5",
      CASE_VOLUME + RIMS_VOLUME + PLATE_VOLUME,
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The open case, and the posts standing INSIDE it --------------------
    await driver.step("open-case");
    await setBodyVisible(page, driver, "body|body_extrude10", false);
    await driver.dwell();

    await driver.step("post-why");
    await driver.dwell();

    await driver.step("post-one");
    // The bed plane IS the floor's top: the posts are plain bed sketches,
    // standing on the floor with no datum at all.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("circle");
    await driver.clickCanvasPoint(9, 9);
    await driver.clickCanvasPoint(12, 9);
    // The readout counts WHAT RENDERS: the plate is hidden in this beat,
    // so the pin excludes it until the close-case beat brings it back.
    await extrudeWithDepth(
      page,
      driver,
      "extrudeDepth11",
      "6",
      CASE_VOLUME + RIMS_VOLUME + POST_VOLUME,
    );
    await driver.dwell();

    await driver.step("posts-rest");
    const restPosts: readonly (readonly [number, number])[] = [
      [67, 9],
      [9, 47],
      [67, 47],
    ];
    let postDepth = 12;
    let postsVolume = 2 * POST_VOLUME;
    for (const [cx, cy] of restPosts) {
      await driver.enterSketchMode(OCCT_ROOT);
      await driver.activateSketchTool("circle");
      await driver.clickCanvasPoint(cx, cy);
      await driver.clickCanvasPoint(cx + 3, cy);
      await extrudeWithDepth(
        page,
        driver,
        `extrudeDepth${String(postDepth)}`,
        "6",
        CASE_VOLUME + RIMS_VOLUME + postsVolume,
      );
      postsVolume += POST_VOLUME;
      postDepth += 1;
    }
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("close-case");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-shaded"]'),
    );
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-viewport-display-mode",
      "shaded",
    );
    await setBodyVisible(page, driver, "body|body_extrude10", true);
    await driver.dwell();

    // -- The STLs that go to the bed ----------------------------------------
    await driver.step("export-open");
    await driver.dwell();

    await driver.step("box-scope");
    // The file carries what renders: hide the lid's five bodies FIRST
    // (the dialog overlays the tree once open), then export.
    for (const key of [
      "body|body_extrude6",
      "body|body_extrude7",
      "body|body_extrude8",
      "body|body_extrude9",
      "body|body_extrude10",
    ]) {
      await setBodyVisible(page, driver, key, false);
    }
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    await driver.humanPoint(page.locator('[data-testid="cad-export-run-stl"]'));
    await driver.dwell();

    await driver.step("export-box");
    // The scene is the box alone. The mesh pins 37679.03 inside the house
    // band (the bore and post cylinders tessellate at ~99.99% analytic),
    // and its vertices span the taught frame: the floor's dip and the
    // wall tops, read off the triangles the slicer receives.
    await runStlExport(page, driver, BOX_VOLUME, PLANAR_VOLUME_FLOOR, {
      min: [0, 0, -2.5],
      max: [76, 56, 35],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    await driver.dwell();

    await driver.step("lid-scope");
    // The box's bodies step back in, the lid's stay alone.
    for (const key of [
      "body|body_extrude6",
      "body|body_extrude7",
      "body|body_extrude8",
      "body|body_extrude9",
      "body|body_extrude10",
    ]) {
      await setBodyVisible(page, driver, key, true);
    }
    for (const key of [
      "body|body_extrude",
      "body|body_extrude2",
      "body|body_extrude3",
      "body|body_extrude4",
      "body|body_extrude5",
      "body|body_extrude11",
      "body|body_extrude12",
      "body|body_extrude13",
      "body|body_extrude14",
    ]) {
      await setBodyVisible(page, driver, key, false);
    }
    await setBodyVisible(page, driver, "body|body_hole1", false);
    await driver.dwell();

    await driver.step("export-lid");
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    // The scene is the lid alone: rim ring + plate, planar-exact, its
    // bounds riding the walls' tops (the frame's +35 shift).
    await runStlExport(page, driver, LID_VOLUME, PLANAR_VOLUME_FLOOR, {
      min: [0, 0, 35],
      max: [76, 56, 40.5],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    for (const key of [
      "body|body_extrude",
      "body|body_extrude2",
      "body|body_extrude3",
      "body|body_extrude4",
      "body|body_extrude5",
      "body|body_extrude11",
      "body|body_extrude12",
      "body|body_extrude13",
      "body|body_extrude14",
    ]) {
      await setBodyVisible(page, driver, key, true);
    }
    await setBodyVisible(page, driver, "body|body_hole1", true);
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};

/**
 * Selects one published face anchor and runs sketch-on-face on it: the
 * semantic pick (body prefix + mean normal, never a triangle index), the
 * glide teaching where the face lives, then the command row's datum
 * resolution as the pin.
 */
async function sketchOnFaceAt(
  page: Page,
  driver: TutorialDriver,
  bodyPrefix: string,
  normal: readonly [number, number, number],
): Promise<void> {
  const anchors = await readFaceAnchors(page, OCCT_ROOT);
  const matches = Object.entries(anchors).filter(([key, anchor]) => {
    if (!key.startsWith(bodyPrefix)) return false;
    if (anchor.normal === null) return false;
    return (
      Math.abs(anchor.normal[0] - normal[0]) <= 0.05 &&
      Math.abs(anchor.normal[1] - normal[1]) <= 0.05 &&
      Math.abs(anchor.normal[2] - normal[2]) <= 0.05
    );
  });
  const entry = matches[0];
  if (entry === undefined) {
    throw new Error(
      `no face anchor ${bodyPrefix}* normal [${normal.join(", ")}] in [${Object.keys(anchors).join(", ")}]`,
    );
  }
  const canvas = await page
    .locator(`#${VIEWPORT_COMPLETE} canvas`)
    .boundingBox();
  if (canvas === null) throw new Error("the viewport canvas never mounted");
  await driver.humanClick({
    x: canvas.x + entry[1].point[0],
    y: canvas.y + entry[1].point[1],
  });
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-selection-key",
    new RegExp(`^face\\|${bodyPrefix.slice(0, -1)}\\|\\d+\\|\\d+$`),
  );
  await driver.openCommandMenu(OCCT_ROOT);
  await driver.clickCommandRow(OCCT_ROOT, "sketch-on-face");
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-datums",
    /^\[\{.*"resolved":true.*\}\]$/,
  );
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
 * never a dispatch-counter anchor.
 */
async function extrudeWithDepth(
  page: Page,
  driver: TutorialDriver,
  depthLabel: string,
  depth: string,
  expected: number,
): Promise<string> {
  const beforeVolume = await renderedVolume(page);
  await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
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
