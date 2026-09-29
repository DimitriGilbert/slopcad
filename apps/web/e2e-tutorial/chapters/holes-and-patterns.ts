import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { dispatchedCount } from "../../e2e-render/helpers";
import {
  DIALOG,
  OCCT_ROOT,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import {
  applyFeatureEdit,
  createFeature,
  drawAndExtrudeRod,
  fillLabeledField,
  openFeatureDialog,
  pickComboboxOption,
  saveSketchRecord,
} from "../feature-verbs";

/** The ⌀6 rod's analytic volume (the pattern/mirror base). */
const ROD_VOLUME = Math.PI * 9 * 10;
/** The 118-degree drill tip's height for a ⌀8 hole (session s15's anchor). */
const TIP_MM = 8 / 2 / Math.tan(((118 / 2) * Math.PI) / 180);
/** The straight ⌀8 through-hole's removed volume. */
const STRAIGHT_REMOVED =
  Math.PI * 16 * (6 - TIP_MM) + (Math.PI * 16 * TIP_MM) / 3;
/** The counterbore adds a ⌀7 × 3 mm recess above the straight part. */
const CBORE_REMOVED = STRAIGHT_REMOVED + Math.PI * (49 - 16) * 3;
/** The 30 × 20 × 10 teaching plate. */
const PLATE_VOLUME = 30 * 20 * 10;

/** Extrudes the 30 × 20 teaching plate at the default depth (s15's base). */
async function drawAndExtrudePlate(
  page: Page,
  driver: TutorialDriver,
): Promise<void> {
  await driver.enterSketchMode(OCCT_ROOT);
  await driver.activateSketchTool("rectangle");
  // The session's corner-origin plate shifted into the visible canvas band
  // (the status bar and the surface's clipped bottom band cover workplane
  // y below roughly 5 mm): the same 30 × 20 plate, so every hole pin holds.
  await driver.clickCanvasPoint(5, 15);
  await driver.clickCanvasPoint(35, 35);
  const before = await dispatchedCount(page, OCCT_ROOT);
  await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: before });
}

/**
 * Chapter 19 — structuring repetition. A counterbore cut through the
 * structured Hole form (with its preview ghost), a positions sketch that
 * cuts many holes from one feature, a linear pattern with a skipped
 * instance, and a mirror across a datum plane (sessions s15, s15b, s16,
 * and s16c, at teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "holes-and-patterns",
    title: "Holes and patterns",
    summary:
      "The structured hole form and its ghost, positions sketches, linear patterns, and mirrors.",
    cues: [
      {
        stepId: "plate",
        text: "Holes and repeats. First a 30 × 20 plate, extruded ten.",
      },
      {
        stepId: "hole-form",
        text: "The Hole form is structured: type, size, position — no sketch.",
      },
      {
        stepId: "counterbore",
        text: "Pick Counterbore, set the position to 20, 25.",
      },
      {
        stepId: "ghost-and-cut",
        text: "A ghost previews the cut; Create lands the analytic pin.",
      },
      {
        stepId: "positions",
        text: "Fresh plate, and a sketch of two points — holes by position.",
      },
      {
        stepId: "two-ghosts",
        text: "Point the form at the sketch: two glyphs, one feature.",
      },
      {
        stepId: "many",
        text: "Create cuts both holes — one feature, many positions.",
      },
      {
        stepId: "pattern-boot",
        text: "Patterns: a fresh rod, the Pattern form, skip one instance.",
      },
      {
        stepId: "array",
        text: "Three placed, one skipped: two rods at 2 × the volume.",
      },
      {
        stepId: "redrive",
        text: "Count 5, spacing 30 — the array re-drives to four rods.",
      },
      {
        stepId: "mirror-boot",
        text: "Mirror last: a fresh rod, a datum plane at x = 5.",
      },
      {
        stepId: "merge",
        text: "The Mirror form with merge on: the reflection unions in.",
      },
      {
        stepId: "standalone",
        text: "mirrorMerge to 1: Apply leaves the reflection standing alone.",
      },
      {
        stepId: "recap",
        text: "Structure the hole, sketch the positions, pattern the bodies.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("plate");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await drawAndExtrudePlate(page, driver);

    // The cue describes the structured form, so its beat opens with the
    // form on screen — the menu journey rides the plate cue's tail.
    await openFeatureDialog(page, driver, OCCT_ROOT, "hole-spec");
    await driver.step("hole-form");
    await driver.humanPoint(page.locator(DIALOG));
    await driver.dwell();

    await driver.step("counterbore");
    await driver.humanClick(
      page.locator(`${DIALOG} [data-slot=select-trigger]`).first(),
    );
    await driver.humanClick(
      page.locator("[data-slot=select-item]", { hasText: "Counterbore" }),
    );
    await expect(
      page.locator(DIALOG).getByLabel(/^Counterbore Ø/),
    ).toBeVisible();
    await fillLabeledField(
      page,
      driver,
      page.locator(DIALOG).getByLabel(/Position x/),
      "20",
    );
    await fillLabeledField(
      page,
      driver,
      page.locator(DIALOG).getByLabel(/Position y/),
      "25",
    );

    await driver.step("ghost-and-cut");
    await expect(
      page.locator('[data-hole-preview-ghost="glyphs"]'),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-hole-preview-ghost="glyphs"] [data-hole-preview-position]',
      ),
    ).toHaveCount(1);
    const counterbored = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "hole"),
    );
    // The s15 pin at its own 1e-4 band: plate minus the derived counterbore.
    expect(
      Math.abs(counterbored - (PLATE_VOLUME - CBORE_REMOVED)) /
        (PLATE_VOLUME - CBORE_REMOVED),
    ).toBeLessThanOrEqual(1e-4);
    // The cue's taught beat is the landed pin: point at the analytic
    // volume and hold it, then close the cue — the reset to the next
    // flow never rides a result cue's tail as dead-air.
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The cue names the fresh plate AND narrates the two-point sketch, so
    // its beat owns both: the reset and the re-extrusion live inside it,
    // and the sketching itself stays in the beat it describes.
    await driver.step("positions");
    const secondBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(secondBoot)).toBeGreaterThan(0);
    await drawAndExtrudePlate(page, driver);
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("point");
    // The session's two points shifted with the plate — both still land
    // inside it, ten millimeters apart.
    await driver.clickCanvasPoint(15, 25);
    await driver.clickCanvasPoint(25, 25);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    // Action-worded invitation: the picking itself is the narration.
    await driver.step("two-ghosts");
    await openFeatureDialog(page, driver, OCCT_ROOT, "hole-spec");
    await driver.humanClick(
      page.locator(`${DIALOG} [data-slot=select-trigger]`).nth(1),
    );
    await driver.humanClick(
      page.locator("[data-slot=select-item]").filter({ hasText: /^sketch 1$/ }),
    );
    await expect(
      page.locator(
        '[data-hole-preview-ghost="glyphs"] [data-hole-preview-position]',
      ),
    ).toHaveCount(2);

    await driver.step("many");
    const twoHoles = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "hole"),
    );
    expect(
      Math.abs(twoHoles - (PLATE_VOLUME - 2 * STRAIGHT_REMOVED)) /
        (PLATE_VOLUME - 2 * STRAIGHT_REMOVED),
    ).toBeLessThanOrEqual(1e-4);
    // The narration claims the cut, so the cue rides the result it names:
    // settle (inside Create), point at the volume the two holes produced,
    // and hold it — chapter 20's pin discipline.
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The cue names the fresh rod and the Pattern form, so its beat OWNS
    // the journey it narrates: the reset, the rod's draw, and the menu
    // journey all live inside it — never inside a result cue's tail,
    // where they would bury the pin the viewer just saw pointed at.
    await driver.step("pattern-boot");
    const patternBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(patternBoot)).toBeGreaterThan(0);
    await drawAndExtrudeRod(page, driver, OCCT_ROOT);
    await openFeatureDialog(page, driver, OCCT_ROOT, "pattern");
    await driver.humanClick(
      page.locator(DIALOG).getByRole("button", { name: "Skip an instance" }),
    );

    await driver.step("array");
    const patterned = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "patternFeature"),
    );
    expect(volumeNear(patterned, 2 * ROD_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));

    await driver.step("redrive");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("patternCount1", { exact: true }),
      "5",
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("patternSpacing1", { exact: true }),
      "30",
    );
    const redriven = Number(await applyFeatureEdit(page, driver, OCCT_ROOT));
    expect(volumeNear(redriven, 4 * ROD_VOLUME)).toBe(true);
    // The re-drive's beat ends ON its result: the four rods held with the
    // pointer at their volume, then the cue closes — no journey tail.
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The cue names the fresh rod and its datum plane, so its beat owns
    // the journey it narrates: the reset, the rod's draw, and the datum
    // creation all live inside it.
    await driver.step("mirror-boot");
    const mirrorBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(mirrorBoot)).toBeGreaterThan(0);
    await drawAndExtrudeRod(page, driver, OCCT_ROOT);
    await openFeatureDialog(page, driver, OCCT_ROOT, "create-datum");
    await fillLabeledField(page, driver, page.getByLabel("Origin x (mm)"), "5");
    await fillLabeledField(page, driver, page.getByLabel("Normal x"), "1");
    await fillLabeledField(page, driver, page.getByLabel("Normal z"), "0");
    await fillLabeledField(page, driver, page.getByLabel("In-plane x x"), "0");
    await fillLabeledField(page, driver, page.getByLabel("In-plane x y"), "1");
    await createFeature(page, driver, OCCT_ROOT, "Create datum");

    // The cue describes the open Mirror form's merge option, so its beat
    // opens with the form on screen.
    await openFeatureDialog(page, driver, OCCT_ROOT, "mirror");
    await driver.step("merge");
    await pickComboboxOption(page, driver, 1, "Merge with the original");
    const mirrored = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "mirror"),
    );
    expect(volumeNear(mirrored, 2 * ROD_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));

    await driver.step("standalone");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("mirrorMerge", { exact: true }),
      "1",
    );
    const standalone = Number(await applyFeatureEdit(page, driver, OCCT_ROOT));
    expect(volumeNear(standalone, ROD_VOLUME)).toBe(true);

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
