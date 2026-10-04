import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { OCCT_ROOT, volumeNear } from "../../e2e-session/helpers";
import {
  applyFeatureEdit,
  createFeature,
  fillLabeledField,
  openFeatureDialog,
  saveSketchRecord,
} from "../feature-verbs";

/** The boot plate's analytic volume — the document-scene body that rides
 * beside the loft (the s12b pin). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** The loft's Simpson's-rule volume at a station height (session s12b). */
const loftVolume = (stationMm: number): number => (1400 * stationMm) / 6;

/**
 * Chapter 14 — the loft. Two section squares saved from one fresh OCCT
 * document, the Loft form pre-seeded with the two oldest sketches, the
 * skinned taper pinned by Simpson's rule — then the station edit lifts
 * the top section and re-drives the whole solid (session s12b's journey,
 * at teaching pace).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "loft-feature",
    title: "Loft: skinning two sections",
    summary:
      "Two section sketches, one skinned solid on Simpson's rule, and a station edit that re-drives it.",
    cues: [
      {
        stepId: "fresh",
        text: "A fresh OCCT document for the loft: two sections, one solid.",
      },
      {
        stepId: "section-wide",
        text: "Section one: a 20 × 20 square — the loft's wide end.",
      },
      {
        stepId: "section-narrow",
        text: "Section two: a 10 × 10 square, saved as the narrow end.",
      },
      {
        stepId: "row",
        text: "The Loft form pre-seeds its two oldest sketches — exactly ours.",
      },
      {
        stepId: "create",
        text: "Create, and the kernel skins a taper between the sections.",
      },
      {
        stepId: "volume",
        text: "Simpson's rule pins the taper — it lands beside the plate.",
      },
      {
        stepId: "station",
        text: "Every section is a station: loftZ_1 lifts the top to 50.",
      },
      {
        stepId: "redrive",
        text: "Apply re-drives — the taper stretches to its 50 mm pin.",
      },
      {
        stepId: "recap",
        text: "Loft: two sketches, one skinned transition, live stations.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("fresh");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.dwell();

    await driver.step("section-wide");
    // The session's ±10 / ±5 squares shifted into the visible canvas band
    // (the status bar and the surface's clipped bottom band cover workplane
    // y below roughly 5 mm) and clear of the boot plate's footprint: the
    // same 400 / 100 mm² section areas on the same center, so Simpson's
    // pins hold unchanged.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(45, 15);
    await driver.clickCanvasPoint(65, 35);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    await driver.step("section-narrow");
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(50, 20);
    await driver.clickCanvasPoint(60, 30);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    // The cue describes the Loft form's pre-seeded sections, so its beat
    // opens with the form on screen — the menu journey rides the second
    // section cue's tail.
    await openFeatureDialog(page, driver, OCCT_ROOT, "loft");
    await driver.step("row");
    await driver.dwell();

    await driver.step("create");
    const lofted = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create",
      "loft",
    );

    await driver.step("volume");
    // The boot plate rides beside the loft (the s12b document-scene pin).
    expect(volumeNear(Number(lofted), BOOT_PLATE_VOLUME + loftVolume(20))).toBe(
      true,
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("station");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("loftZ_1", { exact: true }),
      "50",
    );

    await driver.step("redrive");
    const redriven = await applyFeatureEdit(page, driver, OCCT_ROOT);
    expect(
      volumeNear(Number(redriven), BOOT_PLATE_VOLUME + loftVolume(50)),
    ).toBe(true);

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
