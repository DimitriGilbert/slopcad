import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  DIALOG,
  OCCT_ROOT,
  readTimeline,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import {
  createFeature,
  fillLabeledField,
  openFeatureDialog,
  pickComboboxOption,
} from "../feature-verbs";

/** The trimmed 10 × 20 patch and its 2 mm-thick sheet (session s17b). */
const THICKENED_SHEET_VOLUME = 10 * 20 * 2;

/**
 * Chapter 21 — the surface pipeline. A datum plane, two base sheets off
 * it, the trim that keeps their 10 × 20 overlap, thicken to a real wall,
 * an offset copy along the normals, and the knit that either sews a
 * closed shell or refuses honestly — the timeline never fakes it
 * (sessions s17 and s17b, at teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "surfaces",
    title: "The surface pipeline",
    summary:
      "Base sheets, trim, thicken, offset, and knit — modeling with faces when solids are too much.",
    cues: [
      {
        stepId: "boot",
        text: "Surfaces: sheets instead of solids. The OCCT workbench, fresh.",
      },
      {
        stepId: "datum",
        text: "A datum plane first — the sheets' support. Create datum.",
      },
      {
        stepId: "sheet-one",
        text: "Base sheet one: the form's defaults, straight off the plane.",
      },
      {
        stepId: "sheet-two",
        text: "Base sheet two: u 10 to 20, v -100 to 100 — a band beside it.",
      },
      {
        stepId: "trim",
        text: "Trim keeps the overlap: a 10 × 20 patch, exactly.",
      },
      {
        stepId: "thicken",
        text: "Thicken gives the patch a 2 mm wall — 400 mm³, to the digit.",
      },
      {
        stepId: "offset",
        text: "Offset pushes a copy along the sheet's normals.",
      },
      {
        stepId: "knit",
        text: "Knit sews sheets through shared edges — shell or honest no.",
      },
      {
        stepId: "honest",
        text: "Either way the timeline tells the truth: sheets never fake it.",
      },
      {
        stepId: "recap",
        text: "Model with faces when solids are too much: the surface pipeline.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("boot");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.dwell();

    // A cue that describes a form starts only when that form is on
    // screen: each menu journey rides the previous cue's tail, and each
    // RESULT cue (trim, thicken, offset) starts once its kernel settle
    // has landed — the narration never runs ahead of the pixels.
    await openFeatureDialog(page, driver, OCCT_ROOT, "create-datum");
    await driver.step("datum");
    await fillLabeledField(page, driver, page.getByLabel("Normal z"), "1");
    await fillLabeledField(page, driver, page.getByLabel("In-plane x x"), "1");
    await createFeature(page, driver, OCCT_ROOT, "Create datum");

    await openFeatureDialog(page, driver, OCCT_ROOT, "surface-create");
    await driver.step("sheet-one");
    const created = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create base sheet",
      "sheet",
    );
    expect(created.length).toBeGreaterThan(0);

    await openFeatureDialog(page, driver, OCCT_ROOT, "surface-create");
    await driver.step("sheet-two");
    await fillLabeledField(page, driver, page.getByLabel("u min (mm)"), "10");
    await fillLabeledField(page, driver, page.getByLabel("u max (mm)"), "20");
    await fillLabeledField(page, driver, page.getByLabel("v min (mm)"), "-100");
    await fillLabeledField(page, driver, page.getByLabel("v max (mm)"), "100");
    await createFeature(page, driver, OCCT_ROOT, "Create base sheet", "sheet");

    await openFeatureDialog(page, driver, OCCT_ROOT, "surface-trim");
    await createFeature(page, driver, OCCT_ROOT, "Trim sheet", "sheet");
    await driver.step("trim");

    await openFeatureDialog(page, driver, OCCT_ROOT, "surface-thicken");
    // The sheet-name labels are descriptive, so the pick matches the
    // session's substring form.
    await pickComboboxOption(page, driver, 0, "trimmed", false);
    const thickened = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Thicken sheet",
    );
    expect(
      Math.abs(Number(thickened) - THICKENED_SHEET_VOLUME),
      `thickened ${thickened}`,
    ).toBeLessThanOrEqual(THICKENED_SHEET_VOLUME * 0.002);
    await driver.step("thicken");
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    const beforeOffset = (await readTimeline(page, OCCT_ROOT)).entries.length;
    await openFeatureDialog(page, driver, OCCT_ROOT, "surface-offset");
    const offsetOutcome = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Offset sheet",
    );
    expect(offsetOutcome.length).toBeGreaterThan(0);
    await expect
      .poll(async () => (await readTimeline(page, OCCT_ROOT)).entries.length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(beforeOffset);
    await driver.step("offset");

    await openFeatureDialog(page, driver, OCCT_ROOT, "surface-knit");
    await driver.step("knit");
    const timelineBefore = (await readTimeline(page, OCCT_ROOT)).entries.length;
    await driver.humanClick(
      page.locator(DIALOG).getByRole("button", { name: "Knit sheets" }),
    );
    await page.waitForTimeout(1_000);

    await driver.step("honest");
    // The s17b discipline: the knit's outcome is honest either way — the
    // structured refusal stays in the dialog, or the timeline grows.
    if (await page.locator(DIALOG).isVisible()) {
      await driver.humanPoint(page.locator(DIALOG));
      await page.keyboard.press("Escape");
    } else {
      const entriesAfter = (await readTimeline(page, OCCT_ROOT)).entries.length;
      expect(entriesAfter).toBeGreaterThan(timelineBefore);
    }
    const knitSettled = await waitForRootSettle(page, OCCT_ROOT);
    expect(knitSettled.length).toBeGreaterThan(0);

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
