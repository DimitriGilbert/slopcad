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
import {
  createFeature,
  fillLabeledField,
  openFeatureDialog,
  pickComboboxOption,
  saveSketchRecord,
  saveThrowawayLine,
} from "../feature-verbs";

// ---------------------------------------------------------------------------
// The dimension stack-up (every number below is the brief, arithmetic shown)
// ---------------------------------------------------------------------------
//
// The commission: a 3D-printable case for a 5×7 cm perfboard hosting a
// SOCKLETED NodeMCU with components on BOTH faces — clearance above and
// below, standoffs so nothing rests on the floor, a USB cutout, a lid.
//
//   board            70 × 50 × 1.6   (the 5×7 cm perfboard)
//   wall margin      3 all round  →  footprint 76 × 56
//   floor            2.5
//   cavity           70 × 50        (the board's own rectangle)
//   wall height      35             (1.6 board + ~25 of parts + air)
//   blank            76 × 56 × 37.5 (floor 2.5 + walls 35, one stock pad)
//   posts            ⌀6 × 8.5, centers inset 6 off the board's corners
//                    → (9, 9), (67, 9), (9, 47), (67, 47)
//   port window      ⌀6.5 through-drill along X, world y 28, center
//                    z 25.75 → flipped onto its floor for use it spans
//                    6..12.5 above the floor (the board's connector plus
//                    the cable's drop below it)
//   lid              76 × 56 × 2.5 plus a 70 × 50 × 2 lip (a rib grown 4
//                    thick symmetric about the bed plane: 2 merges into
//                    the plate, 2 stands proud beneath it)
//
// ## The two boundaries this chapter TEACHES instead of papering over
//
// 1. ORIENTATION. The workbench extrudes from one plane, so every pad
//    grows off the bed: the blank, the pocket tool that leaves the floor
//    ABOVE it, the posts. The model therefore comes off the bench opening
//    toward the bed; printing stands the case on its floor (the flip the
//    slicer performs), and every "in use" height in the narration reads
//    AFTER that flip — 37.5 minus the model z. The posts inherit the same
//    boundary: they grow at the bed (z 0..8.5), not at the floor they
//    seat against in the assembly; the file itself is orientation-free
//    (a bare ⌀6 × 8.5 cylinder prints exactly as it sits).
// 2. THE WINDOW IN THE EXPORT. The carve preview composes its subtract
//    from plain pads (`documentBooleanSceneRequest` pairs one extrude
//    target with ONE extrude tool; the hole scene pairs an extrude base
//    with holes — the two never compose), so the drilled window shows in
//    the document's own feature but NOT in the carved preview nor in the
//    STL that preview exports. The chapter discloses this at the carve
//    beat, the recap states exactly what the base file holds (walls and
//    floor, no window), and the finish is named: in the JSX route the
//    booleans nest freely (a Sketch on a vertical plane, a Subtract
//    whose base is the carved body), so the cut re-aims there. The
//    honest fingerprint pair: the exported base pins 37100 exactly; the
//    part WITH the window carried through would measure
//    37100 − 2·(π·3.25²·3) ≈ 36900.9 (two 3 mm wall crossings).
//
// The print set is therefore THREE files, exported at the beats where
// each body owns the viewport (the scene follows the newest solid):
//   case base   37100 mm³  (walls + floor — the window rides the document)
//   posts        240.33 mm³ (one ⌀6 × 8.5 body — print four; a drop of
//                           epoxy into the corners seats each one)
//   lid         17640 mm³  (plate + lip)
// Each export is verified against its analytic volume by summing the
// downloaded mesh's signed tetrahedra — the planar bodies land exact;
// the post carries only the cylinder tessellation's inscribed-polygon
// shortfall (a wider documented band).

/** The blank: 76 × 56 × 37.5 of stock (floor and wall material together). */
const BLANK_VOLUME = 76 * 56 * 37.5;
/**
 * The port's through-bore: ⌀6.5 drilled along X across the blank's full
 * 76 mm width (depth 76 ≥ 76 → the kernel's through semantic). The drill
 * happens while the stock is solid, so the beat's scene measures exactly
 * the blank minus one cylinder: 159600 − π·3.25²·76.
 */
const BORED_VOLUME = BLANK_VOLUME - Math.PI * 3.25 * 3.25 * 76;
/** One post: ⌀6 × 8.5 — the posts file's whole content (print four). */
const POST_VOLUME = Math.PI * 9 * 8.5;
/** The lid plate: the case's own footprint, 2.5 thick. */
const LID_VOLUME = 76 * 56 * 2.5;
/**
 * The lid with its lip: the rib extrudes the 70 × 50 section symmetrically
 * about the bed plane, 4 thick total (z −2..+2). The union absorbs the
 * +2..0 half into the plate, so the added material is the −2..0 lip:
 * 70 · 50 · 2 = 7000 on top of the plate.
 */
const LID_WITH_LIP_VOLUME = LID_VOLUME + 70 * 50 * 2;
/** The pocket tool: 70 × 50 × 35 — it stops one floor thickness short. */
const POCKET_VOLUME = 70 * 50 * 35;
/** The carved case: the blank minus the pocket (floor + wall ring). */
const CASE_VOLUME = BLANK_VOLUME - POCKET_VOLUME;
/** The boot demo plate's volume (30 × 20 × 10 with the ⌀8 bore). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** The boot demo plate's section area at the mid-height plane (z = 5). */
const BOOT_SECTION_AREA = 30 * 20 - Math.PI * 16;

/**
 * The first post's center — six millimetres in from the board's corner
 * (the board's corner sits at (3, 3) inside the 3 mm wall).
 */
const FIRST_POST: readonly [number, number] = [9, 9];
/** The rest of the post grid: the other three corners, same inset. */
const OTHER_POSTS: readonly (readonly [number, number])[] = [
  [67, 9],
  [9, 47],
  [67, 47],
];

/**
 * The tessellated-cylinder band: a curved body's mesh is an inscribed
 * polygon soup, so it UNDER-measures the analytic solid — a 12-gon
 * cross-section by ~4.5%, the smoothest realistic mesh by ~0.6%. The
 * post floor sits at 0.94 of the analytic 240.33; the over-measure
 * guard stays at 1.001 for every body.
 */
const CURVED_VOLUME_FLOOR = 0.94;
/** The house band for planar (box-built, exactly tessellated) bodies. */
const PLANAR_VOLUME_FLOOR = 0.995;

/**
 * Chapter 30 — the applied capstone. ONE continuous build, blank workbench
 * to a THREE-file print set: the brief and its dimension stack-up, the
 * section instrument on the demo plate, then the case itself — the stock
 * blank, the USB pass-through drilled through the solid stock, the four
 * standoff posts, the lid with its rib-grown lip, and the pocket carve
 * that opens the room. Each part exports at the beat where it owns the
 * viewport (the scene follows the newest solid), every export verified
 * against its analytic volume from the downloaded mesh's own triangles,
 * and every workbench boundary (the one-plane pads, the pads-only carve
 * preview) is taught out loud instead of papered over.
 */
export const chapter: ChapterModule = {
  definition: {
    id: "applied-iot-case",
    title: "Applied project: an IoT case for a 5×7 perfboard",
    summary:
      "One continuous build from blank workbench to a three-file print set: stock blank, USB pass-through, standoff posts, lid with lip, the pocket carve, and the exports.",
    cues: [
      {
        stepId: "brief",
        text: "The commission: a print-ready case for a socketed board, parts on both faces.",
      },
      {
        stepId: "stackup",
        text: "The stack-up: floor 2.5, walls 3 and 35 tall, posts 8.5, lid plus lip.",
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
        text: "Section off. The instrument noted; now the case itself.",
      },
      {
        stepId: "blank-sketch",
        text: "The footprint: the board's 70 by 50 plus a 3 mm wall all round — 76 by 56.",
      },
      {
        stepId: "blank",
        text: "One pad, 37.5 tall: 159600 mm³ of stock. The pocket is carved, not built.",
      },
      {
        stepId: "port-window",
        text: "The bench models opening-down; use flips it onto its floor. Now the port.",
      },
      {
        stepId: "port-drill",
        text: "⌀6.5 through at 25.75: flipped for use that spans 6 to 12.5 — plug and cable.",
      },
      {
        stepId: "posts-why",
        text: "Four ⌀6 posts, six in from the edges: air under the board, pins and all.",
      },
      {
        stepId: "post-one",
        text: "The first post: ⌀6, 8.5 from the bed — 240.33 mm³ at the corner.",
      },
      {
        stepId: "three-more",
        text: "The same circle at three corners — the document keeps all four.",
      },
      {
        stepId: "posts-file",
        text: "The posts export as their own file: one post, print four — epoxy seats them.",
      },
      {
        stepId: "lid-why",
        text: "The lid: same footprint, its own plate, printed face-down, no supports.",
      },
      {
        stepId: "lid-plate",
        text: "76 by 56 by 2.5: the lid plate — 10640 mm³ beside the case.",
      },
      {
        stepId: "lip-why",
        text: "The lip is the fit: 70 by 50 — exactly the room — two proud under the plate.",
      },
      {
        stepId: "lip-sketch",
        text: "Trace the lip and save it: the Rib feature eats saved sections.",
      },
      {
        stepId: "lip-unlock",
        text: "The feature rows want two free sketches: a throwaway line unlocks them.",
      },
      {
        stepId: "lip-rib",
        text: "Rib, sketch 1, four thick: the plate grows two of lip — 17640 mm³.",
      },
      {
        stepId: "lid-file",
        text: "The lid exports too: plate plus lip, one file for the slicer.",
      },
      {
        stepId: "pocket-why",
        text: "The pocket tool: the board's 70 by 50, 35 deep — it stops 2.5 short: the floor.",
      },
      {
        stepId: "pocket-sketch",
        text: "Trace the cavity: seventy by fifty, the board's own rectangle.",
      },
      {
        stepId: "pocket-tool",
        text: "Extrude it 35 — 122500 of air, ordered out of the stock.",
      },
      {
        stepId: "carve-why",
        text: "Subtract. The tool leaves the floor above it — the print flips onto that floor.",
      },
      {
        stepId: "carve",
        text: "37100 mm³: floor, walls, open face — the base, carved in one subtract.",
      },
      {
        stepId: "carve-boundary",
        text: "This view composes pads only: the window stays in the document, not the file.",
      },
      {
        stepId: "inside",
        text: "Wire strips the skins: the room reads — empty: the posts are their own file.",
      },
      {
        stepId: "family",
        text: "The tree keeps every part; the viewport follows the newest solid.",
      },
      {
        stepId: "export-open",
        text: "Print-ready means bytes: the set is three files — base, posts, lid.",
      },
      {
        stepId: "export-stl",
        text: "STL out: real triangles, real bytes — the base file, walls and floor.",
      },
      {
        stepId: "print-set",
        text: "The set: the base (walls, floor — no window), four posts, the lid.",
      },
      {
        stepId: "recap",
        text: "The window's cut re-aims in the JSX route: subtract from the carved body there.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    // -- The brief and the stack-up (over the fresh boot) -------------------
    await driver.step("brief");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeGreaterThan(0);
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

    // -- The stock blank -----------------------------------------------------
    // The taught frame anchors at the world origin: the blank's far edge is
    // the y=0 row itself. That row sits in the status strips' band the raw
    // pointer cannot reach — the sweep chapter's pinned pick carries it. The
    // visible corner is picked FIRST (a raw pick maps from the unscrolled
    // canvas; the pinned pick's locator click re-scrolls the workspace, and
    // its position option stays element-exact through the scroll).
    await driver.step("blank-sketch");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(76, 56);
    await driver.pickPinnedCanvasPoint(0, 0);

    await driver.step("blank");
    await extrudeWithDepth(page, driver, "extrudeDepth", "37.5", BLANK_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The USB pass-through (drilled through the solid stock) --------------
    await driver.step("port-window");
    await driver.dwell();

    await driver.step("port-drill");
    await driver.openCommandMenu(OCCT_ROOT);
    await driver.clickCommandRow(OCCT_ROOT, "hole");
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-scene-kind",
      "hole",
    );
    await driver.dwell();
    // Axis 1 drills along X — the board's short edge faces the x-wall — so
    // the position pair rides the perpendicular plane in world-axis order:
    // (y, z) = (28, 25.75), the board's y center and the window's height.
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
      "76",
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
      "25.75",
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("holeAxis1", { exact: true }),
      "1",
    );
    await applyAndPin(page, driver, BORED_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The four standoff posts ---------------------------------------------
    await driver.step("posts-why");
    await driver.dwell();

    await driver.step("post-one");
    const [firstX, firstY] = FIRST_POST;
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("circle");
    await driver.clickCanvasPoint(firstX, firstY);
    await driver.clickCanvasPoint(firstX + 3, firstY);
    await extrudeWithDepth(page, driver, "extrudeDepth2", "8.5", POST_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("three-more");
    let postIndex = 3;
    for (const [cx, cy] of OTHER_POSTS) {
      await driver.enterSketchMode(OCCT_ROOT);
      await driver.activateSketchTool("circle");
      await driver.clickCanvasPoint(cx, cy);
      await driver.clickCanvasPoint(cx + 3, cy);
      await extrudeWithDepth(
        page,
        driver,
        `extrudeDepth${String(postIndex)}`,
        "8.5",
        POST_VOLUME,
      );
      postIndex += 1;
    }
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("posts-file");
    // The viewport owns the newest post (the scene follows the newest
    // solid), so the posts file exports here: one ⌀6 × 8.5 body — the
    // narration says print four, epoxy into the corners.
    await exportStlRound(page, driver, POST_VOLUME, CURVED_VOLUME_FLOOR);
    await driver.dwell();

    // -- The lid and its rib-grown lip ---------------------------------------
    await driver.step("lid-why");
    await driver.dwell();

    await driver.step("lid-plate");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // Same anchored frame, same band: the far corner first, the plate's
    // y=0 edge second through the pinned pick.
    await driver.clickCanvasPoint(96, 56);
    await driver.pickPinnedCanvasPoint(20, 0);
    await extrudeWithDepth(page, driver, "extrudeDepth6", "2.5", LID_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("lip-why");
    await driver.dwell();

    await driver.step("lip-sketch");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // The lip traces the cavity: far corner first, the 3 mm wall row —
    // which the band hides — second through the pinned pick.
    await driver.clickCanvasPoint(93, 53);
    await driver.pickPinnedCanvasPoint(23, 3);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    await driver.step("lip-unlock");
    await saveThrowawayLine(page, driver, OCCT_ROOT);
    await openFeatureDialog(page, driver, OCCT_ROOT, "rib");
    await pickComboboxOption(page, driver, 0, "sketch 1");
    await fillLabeledField(page, driver, page.getByLabel(/Thickness/), "4");

    await driver.step("lip-rib");
    await createFeature(page, driver, OCCT_ROOT, "Create", "rib");
    await pollVolume(page, LID_WITH_LIP_VOLUME);
    // The panel's freshly mounted ribThickness field arrives EMPTY, and one
    // invalid field blocks the panel form's Apply for every later beat —
    // re-enter the rib's own thickness (the draft-rib-scale chapter's
    // re-drive surface) so the panel form validates again.
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("ribThickness", { exact: true }),
      "4",
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("lid-file");
    await exportStlRound(
      page,
      driver,
      LID_WITH_LIP_VOLUME,
      PLANAR_VOLUME_FLOOR,
      {
        // The plate's taught anchor: the 20 offset and the y=0 edge, plus
        // the lip's two proud millimetres below the bed plane.
        min: [20, 0, -2],
        max: [96, 56, 2.5],
      },
    );

    // -- The pocket tool and the carve ---------------------------------------
    await driver.step("pocket-why");
    await driver.dwell();

    await driver.step("pocket-sketch");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // The cavity is the board's own rectangle, anchored at the (3, 3) wall
    // corner: far corner first, the band row second through the pinned pick.
    await driver.clickCanvasPoint(73, 53);
    await driver.pickPinnedCanvasPoint(3, 3);

    await driver.step("pocket-tool");
    await extrudeWithDepth(page, driver, "extrudeDepth7", "35", POCKET_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("carve-why");
    // The cue names the subtract, so its beat owns the dialog journey: the
    // target defaults to pad 1 (the blank — the first extrusion's body);
    // the tool is the pocket, the seventh pad.
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await driver.humanClick(
      page
        .locator('[data-testid="feature-form-dialog"]')
        .getByRole("checkbox", { name: "pad 7", exact: true }),
    );

    await driver.step("carve");
    await createFeature(page, driver, OCCT_ROOT, "Create", "boolean");
    await pollVolume(page, CASE_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The boundary, told on the beat where a viewer would otherwise feel
    // misled: the preview composes the subtract from plain pads, so the
    // drilled window (a real feature on pad 1) shows here neither in the
    // preview nor in the file this scene exports.
    await driver.step("carve-boundary");
    await driver.dwell();

    // -- The look inside: level the camera, strip the skins ------------------
    // The orbit's pitch clamps at the world horizon (measured: a 350 px
    // stroke lands the camera level and no further), so the cavity's
    // bottom-opening never faces the camera directly — the bench's honest
    // look-inside is the WIREFRAME display: the room reads through the
    // walls from the near-level view the drag produces. It reads EMPTY,
    // and the cue says so: the posts travel as their own file.
    await driver.step("inside");
    const canvas = await page
      .locator(`#${VIEWPORT_COMPLETE} canvas`)
      .boundingBox();
    if (canvas === null) throw new Error("the viewport canvas never mounted");
    const centerX = canvas.x + canvas.width / 2;
    const centerY = canvas.y + canvas.height / 2;
    await driver.drag(
      { x: centerX, y: centerY + 100 },
      { x: centerX, y: centerY - 250 },
    );
    await driver.humanClick(
      page.locator('[data-testid="display-mode-wireframe"]'),
    );
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-viewport-display-mode",
      "wireframe",
    );
    await driver.dwell();

    await driver.step("family");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-shaded"]'),
    );
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-viewport-display-mode",
      "shaded",
    );
    await driver.pickTreeNode("body|body_boolean");
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-selection-key",
      "body|body_boolean",
    );
    await driver.dwell();

    // -- The STL that goes to the bed ----------------------------------------
    await driver.step("export-open");
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    await driver.humanPoint(page.locator('[data-testid="cad-export-run-stl"]'));
    await driver.dwell();

    await driver.step("export-stl");
    await runStlExport(page, driver, CASE_VOLUME, PLANAR_VOLUME_FLOOR, {
      // The carved base keeps the blank's envelope: the taught frame's
      // origin rows, read off the triangles the slicer receives.
      min: [0, 0, 0],
      max: [76, 56, 37.5],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    await driver.dwell();

    await driver.step("print-set");
    // Narration only: the three files' evidence is already on the record —
    // each export round pinned its downloaded mesh's triangles against the
    // analytic solid (240.33 / 17640 / 37100 mm³). Byte COUNT follows
    // triangle topology, not part size, so it pins nothing further here.
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};

/** The settled scene volume the workbench root publishes. */
async function renderedVolume(page: Page): Promise<string> {
  return (
    (await page
      .locator(`#${OCCT_ROOT}`)
      .getAttribute("data-cad-rendered-volume")) ?? "0"
  );
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
 * carries the real number). `expected` is the re-driven analytic volume —
 * the wait's real predicate, never a dispatch-counter anchor.
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
 * taught frame's anchor rows (y 0 and the 20-offset plate edge) to the
 * cent; curved bodies never carry their silhouette extremes as vertices,
 * so the posts round passes no bounds.
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

/**
 * One full export round on the body that owns the viewport: open the
 * dialog, run the STL, verify the download's triangles against the
 * analytic volume, close. The chapter's print-set beats ride this — the
 * posts file at the post beat, the lid file at the rib beat.
 */
async function exportStlRound(
  page: Page,
  driver: TutorialDriver,
  expectedVolume: number,
  floorRatio: number,
  expectedBounds?: ExpectedMeshBounds,
): Promise<void> {
  await driver.humanClick(page.getByTestId("complete-export"));
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-export-dialog-open",
    "true",
  );
  await runStlExport(page, driver, expectedVolume, floorRatio, expectedBounds);
  await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
  await driver.dwell();
  await closeExportDialog(page);
}
