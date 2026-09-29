import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { DIALOG, OCCT_ROOT, volumeNear } from "../../e2e-session/helpers";
import {
  applyFeatureEdit,
  createFeature,
  drawAndExtrudeRod,
  fillLabeledField,
  openFeatureDialog,
} from "../feature-verbs";

/** The 1 mm wall's exact closed shell and the rod's analytic half (s14d/e). */
const THICKEN_VOLUME = 90 * Math.PI - 32 * Math.PI;
const SPLIT_VOLUME = 45 * Math.PI;

/**
 * Chapter 18 — hollowing and dividing. Thicken turns the rod into its own
 * 1 mm shell at the exact volume; split cuts a fresh rod by a z = 5 datum
 * plane — exactly half stays, and flipping the kept side keeps the other
 * half (sessions s14d and s14e, at teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "thicken-split",
    title: "Thicken and split",
    summary:
      "Hollowing a rod into its exact shell, and splitting a body by a datum plane.",
    cues: [
      {
        stepId: "thicken-boot",
        text: "Hollow and cut. First the ⌀6 rod, then the Thicken form.",
      },
      {
        stepId: "wall",
        text: "Wall thickness 1 mm — Create.",
      },
      {
        stepId: "shell",
        text: "The rod becomes its own shell: exactly 58π mm³.",
      },
      {
        stepId: "split-boot",
        text: "Split next: a fresh rod and a datum plane at z = 5.",
      },
      {
        stepId: "datum",
        text: "Origin z = 5, Create datum — a cutting plane through the mid.",
      },
      {
        stepId: "split-row",
        text: "The Split form cuts by the plane. Create keeps one side.",
      },
      {
        stepId: "half",
        text: "Exactly half the rod stays: 45π mm³.",
      },
      {
        stepId: "flip",
        text: "splitSide -1 flips the kept half — same volume, other side.",
      },
      {
        stepId: "recap",
        text: "Thicken hollows, split divides — both re-drivable by number.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("thicken-boot");
    const thickenBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(thickenBoot)).toBeGreaterThan(0);
    await drawAndExtrudeRod(page, driver, OCCT_ROOT);

    // The cue's beat opens with the Thicken form on screen (a cue that
    // describes a form starts only when that form is visible): the menu
    // journey rides the previous cue's tail, which narrates the arrival.
    await openFeatureDialog(page, driver, OCCT_ROOT, "thicken");
    await driver.step("wall");
    await fillLabeledField(
      page,
      driver,
      page.locator(DIALOG).getByLabel("Wall thickness (mm)"),
      "1",
    );
    const hollowed = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create",
      "thicken",
    );

    await driver.step("shell");
    expect(volumeNear(Number(hollowed), THICKEN_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The cue names the fresh rod, so its beat OWNS the journey it
    // narrates: the reset and the re-draw live inside it — never on a
    // result cue's tail, where they would bury the shell's held pin.
    await driver.step("split-boot");
    const splitBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(splitBoot)).toBeGreaterThan(0);
    await drawAndExtrudeRod(page, driver, OCCT_ROOT);

    await openFeatureDialog(page, driver, OCCT_ROOT, "create-datum");
    await driver.step("datum");
    await fillLabeledField(page, driver, page.getByLabel("Origin z (mm)"), "5");
    await createFeature(page, driver, OCCT_ROOT, "Create datum");

    await openFeatureDialog(page, driver, OCCT_ROOT, "split");
    await driver.step("split-row");
    const split = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create",
      "split",
    );

    await driver.step("half");
    expect(volumeNear(Number(split), SPLIT_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("flip");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("splitSide", { exact: true }),
      "-1",
    );
    const flipped = await applyFeatureEdit(page, driver, OCCT_ROOT);
    expect(volumeNear(Number(flipped), SPLIT_VOLUME)).toBe(true);

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
