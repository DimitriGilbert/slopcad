import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { OCCT_ROOT, volumeNear } from "../../e2e-session/helpers";
import {
  applyFeatureEdit,
  createFeature,
  drawAndExtrudeRod,
  fillLabeledField,
  openFeatureDialog,
  pickComboboxOption,
  saveSketchRecord,
  saveThrowawayLine,
} from "../feature-verbs";

/** The ⌀6 rod's analytic volume (the s14 family's base body). */
const ROD_VOLUME = Math.PI * 9 * 10;
/** The 5°-taper frustum's analytic volume (session s14). */
const DEG5 = (5 * Math.PI) / 180;
const DRAFT_TOP_RADIUS = 3 - 10 * Math.tan(DEG5);
const DRAFT_VOLUME =
  (Math.PI * 10 * (9 + 3 * DRAFT_TOP_RADIUS + DRAFT_TOP_RADIUS ** 2)) / 3;

/**
 * Chapter 17 — three shaping features, one family. Draft tapers an
 * extrusion (and flattens back), a rib unions a stiffener onto the rod,
 * and scale sizes a body by exactly cubic factors — three fresh documents,
 * each feature created, pinned analytically, and re-driven by number
 * (sessions s14, s14b, and s14c, at teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "draft-rib-scale",
    title: "Draft, rib, and scale",
    summary:
      "Tapering an extrusion, unioning a rib stiffener, and scaling cubically — each re-driven.",
    cues: [
      {
        stepId: "draft-boot",
        text: "Three shaping features, one family. Draft first: a saved ⌀6 circle.",
      },
      {
        stepId: "draft-unlock",
        text: "The throwaway line sketch unlocks the feature rows.",
      },
      {
        stepId: "draft-create",
        text: "Draft extrudes the circle with a 5-degree taper — Create.",
      },
      {
        stepId: "frustum",
        text: "A frustum, not a cylinder — the taper pin says ~208 mm³.",
      },
      {
        stepId: "flatten",
        text: "extrudeTaper1 to 0 and Apply: the taper flattens to the rod.",
      },
      {
        stepId: "rib-boot",
        text: "Rib next, on a fresh rod. Sketch its section: a low 10 × 1 bar.",
      },
      {
        stepId: "rib-row",
        text: "Save, add the throwaway, open Rib, pick the section: sketch 1.",
      },
      {
        stepId: "rib-union",
        text: "The rib unions onto the rod — material added, one feature.",
      },
      {
        stepId: "rib-edit",
        text: "ribThickness to 4 re-drives: more rib, more volume.",
      },
      {
        stepId: "scale-boot",
        text: "Scale last: another fresh rod, the Scale form, Create.",
      },
      {
        stepId: "eight",
        text: "Factor 2 doubles each axis: volume × 8, exactly cubic.",
      },
      {
        stepId: "twenty-seven",
        text: "Factor 3: × 27. Apply and watch the pin land.",
      },
      {
        stepId: "recap",
        text: "Draft shapes walls, ribs stiffen, scale sizes — all parametric.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("draft-boot");
    const draftBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(draftBoot)).toBeGreaterThan(0);
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("circle");
    // The session's origin-centered circle shifted into the visible canvas
    // band (the status bar and the surface's clipped bottom band cover
    // workplane y below roughly 5 mm): the same ⌀6 circle, so the taper pin holds.
    await driver.clickCanvasPoint(10, 20);
    await driver.clickCanvasPoint(13, 20);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    await driver.step("draft-unlock");
    await saveThrowawayLine(page, driver, OCCT_ROOT);

    // The cue names the Draft form, so its beat opens with the form on
    // screen — the menu journey rides the unlock cue's tail.
    await openFeatureDialog(page, driver, OCCT_ROOT, "draft");
    await driver.step("draft-create");
    const drafted = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create",
      "extrude",
    );

    await driver.step("frustum");
    expect(volumeNear(Number(drafted), DRAFT_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("flatten");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("extrudeTaper1", { exact: true }),
      "0",
    );
    const flat = await applyFeatureEdit(page, driver, OCCT_ROOT);
    expect(volumeNear(Number(flat), ROD_VOLUME)).toBe(true);
    // The cue's taught beat is the flattened rod: point at the volume the
    // pin claims and hold it, then close the cue — the next flow's reset
    // never rides a result cue's tail as dead-air.
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The cue says "on a fresh rod" and invites the section sketch, so its
    // beat OWNS the journey it narrates: the reset and the rod's draw live
    // inside it, and the sketching stays in the beat, too.
    await driver.step("rib-boot");
    const ribBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(ribBoot)).toBeGreaterThan(0);
    await drawAndExtrudeRod(page, driver, OCCT_ROOT);
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    // The session's section bar shifted with the rod (still crossing the
    // rod's footprint — the union the band pins): 10 wide, 1 tall.
    await driver.clickCanvasPoint(5, 19.5);
    await driver.clickCanvasPoint(15, 20.5);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    await driver.step("rib-row");
    await saveThrowawayLine(page, driver, OCCT_ROOT);
    await openFeatureDialog(page, driver, OCCT_ROOT, "rib");
    await pickComboboxOption(page, driver, 0, "sketch 1");

    await driver.step("rib-union");
    const ribbed = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "rib"),
    );
    // The s14b union band: strictly more than the rod, at most 20 mm³ of rib.
    expect(ribbed).toBeGreaterThan(ROD_VOLUME);
    expect(ribbed).toBeLessThanOrEqual(ROD_VOLUME + 20);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));

    await driver.step("rib-edit");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("ribThickness", { exact: true }),
      "4",
    );
    const thicker = Number(await applyFeatureEdit(page, driver, OCCT_ROOT));
    expect(thicker).toBeGreaterThan(ribbed);
    // The re-drive's beat ends ON its result: the thicker rib held with the
    // pointer at its volume, then the cue closes — no journey tail.
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The cue names another fresh rod AND the Scale form, so its beat OWNS
    // the journey it narrates: the reset, the rod's draw, and the menu
    // journey all live inside it.
    await driver.step("scale-boot");
    const scaleBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(scaleBoot)).toBeGreaterThan(0);
    await drawAndExtrudeRod(page, driver, OCCT_ROOT);
    await openFeatureDialog(page, driver, OCCT_ROOT, "scale");

    await driver.step("eight");
    const scaled = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create",
      "scale",
    );
    expect(volumeNear(Number(scaled), ROD_VOLUME * 8)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));

    await driver.step("twenty-seven");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("scaleFactor", { exact: true }),
      "3",
    );
    const bigger = await applyFeatureEdit(page, driver, OCCT_ROOT);
    expect(volumeNear(Number(bigger), ROD_VOLUME * 27)).toBe(true);

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
