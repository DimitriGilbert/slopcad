import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { OCCT_ROOT } from "../../e2e-session/helpers";
import {
  createFeature,
  openFeatureDialog,
  pickComboboxOption,
  saveSketchRecord,
  saveThrowawayLine,
} from "../feature-verbs";

/** The derived helix band's center (session s13): 11 turns of the 3 mm
 * pitch-radius meridian, corrected by the ruled-surface factor. */
const RULED_BAND = Math.sin(0.1) / 0.1;
const HELIX_OCCT = 2 * Math.PI * 3 * 3 * 11 * RULED_BAND;
/** The boot plate's analytic volume — the document-scene body that rides
 * beside the coil (the s13 pin). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;

/**
 * Chapter 15 — the helix. A tiny meridian rectangle beside the axis, the
 * two-sketch unlock for the feature rows, the explicit meridian pick, and
 * the swept coil landing inside its derived band (session s13's journey,
 * at teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "helix-feature",
    title: "Helix: a swept coil",
    summary:
      "The meridian cross-section, the sketch-pool gate, and the helical sweep on its derived band.",
    cues: [
      {
        stepId: "occt-route",
        text: "The OCCT workbench again — this time a helical sweep.",
      },
      {
        stepId: "meridian",
        text: "Draw a tiny rectangle beside the axis: the thread's cross-section.",
      },
      {
        stepId: "save",
        text: "Save it. Feature rows gate on a pool of two sketches or more.",
      },
      {
        stepId: "throwaway",
        text: "A one-line throwaway sketch unlocks the gate.",
      },
      {
        stepId: "pick",
        text: "Open Helix and point it at the meridian explicitly: sketch 1.",
      },
      {
        stepId: "create",
        text: "Create. The meridian sweeps helically around the axis.",
      },
      {
        stepId: "coil",
        text: "The coil lands inside its derived band — turns, radius, meridian.",
      },
      {
        stepId: "recap",
        text: "One cross-section plus turns: screw geometry. Threads come next.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("occt-route");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.dwell();

    await driver.step("meridian");
    // The session's meridian lifted 15 mm up the workplane (the status bar
    // covers y below roughly 5 mm): sketch y is the
    // thread's axial direction, so the radial geometry — what the derived
    // band pins — is untouched.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(0, 14.25);
    await driver.clickCanvasPoint(2, 15.75);

    await driver.step("save");
    await saveSketchRecord(page, driver, OCCT_ROOT);
    await driver.dwell();

    await driver.step("throwaway");
    await saveThrowawayLine(page, driver, OCCT_ROOT);

    await driver.step("pick");
    await openFeatureDialog(page, driver, OCCT_ROOT, "helix");
    await pickComboboxOption(page, driver, 0, "sketch 1");

    await driver.step("create");
    const helical = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create",
      "helix",
    );

    await driver.step("coil");
    // The s13 band, document-scoped: the OCCT coil within 0.2 % of the
    // derived screw, with the boot plate riding beside it (Phase 16).
    const coilDocument = BOOT_PLATE_VOLUME + HELIX_OCCT;
    expect(
      Math.abs(Number(helical) - coilDocument) / coilDocument,
    ).toBeLessThan(2e-3);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
