import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  COMPLETE,
  COMPLETE_ROOT,
  waitForRootSettle,
} from "../../e2e-session/helpers";

/** The boot plate's analytic volume (30 × 20 × 10 with the ⌀8 bore). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** The section's analytic area at the plate's mid-height. */
const BOOT_SECTION_AREA = 30 * 20 - Math.PI * 16;

/**
 * Chapter 10 — section clipping. The Measurement block's section buttons
 * arm a clip plane at the plate's mid-height; the kernel measures the cut
 * face's true area and centroid; view cut halves the solid so you can see
 * inside (s04's section journey, on a fresh boot plate).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "section-clipping",
    title: "Section clipping",
    summary:
      "Cutting the model at a plane and reading the true face it leaves.",
    cues: [
      {
        stepId: "block",
        text: "The Measurement block ends in two small buttons: section, view cut.",
      },
      {
        stepId: "select-body",
        text: "Section rides a selected body. Pick the plate in the tree.",
      },
      {
        stepId: "arm",
        text: "Click section. The clip plane sits at the plate's mid-height.",
      },
      {
        stepId: "area",
        text: "The Section row measures the true cut face: about 550 mm².",
      },
      {
        stepId: "centroid",
        text: "The centroid line gives the face's center: x 15, y 10, z 5.",
      },
      {
        stepId: "view-cut",
        text: "View cut removes the kept half — cap faces close the solid.",
      },
      {
        stepId: "halved",
        text: "The volume readout halves: you are looking inside the plate.",
      },
      {
        stepId: "off",
        text: "Toggle section off — the rows leave with the plane.",
      },
      {
        stepId: "recap",
        text: "A section is a view state: measured, honest, and reversible.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("block");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.humanPoint(
      page.locator('[data-testid="section-clip-toggle"]'),
    );
    await driver.humanPoint(
      page.locator('[data-testid="section-view-toggle"]'),
    );
    await driver.dwell();

    await driver.step("select-body");
    await driver.pickTreeNode("body|body_plate");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "body|body_plate",
    );

    await driver.step("arm");
    const clipToggle = page.locator('[data-testid="section-clip-toggle"]');
    await expect(clipToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('[data-testid="section-area"]')).toHaveCount(0);
    await driver.humanClick(clipToggle);
    await expect(clipToggle).toHaveAttribute("aria-pressed", "true");
    await waitForRootSettle(page, COMPLETE_ROOT);

    await driver.step("area");
    const areaText =
      (await page.locator('[data-testid="section-area"]').textContent()) ?? "";
    expect(
      Number(areaText.replace(" mm²", "")),
      `section area ${areaText}`,
    ).toBeCloseTo(BOOT_SECTION_AREA, 0);
    await driver.humanPoint(page.locator('[data-testid="section-area"]'));
    await driver.dwell();

    await driver.step("centroid");
    const centroidText =
      (await page.locator('[data-testid="section-centroid"]').textContent()) ??
      "";
    expect(centroidText).toContain("x 15.000");
    expect(centroidText).toContain("y 10.000");
    expect(centroidText).toContain("z 5.000");
    await driver.humanPoint(page.locator('[data-testid="section-centroid"]'));
    await driver.dwell();

    await driver.step("view-cut");
    const viewToggle = page.locator('[data-testid="section-view-toggle"]');
    await driver.humanClick(viewToggle);
    await expect(viewToggle).toHaveAttribute("aria-pressed", "true");
    await waitForRootSettle(page, COMPLETE_ROOT);

    await driver.step("halved");
    const cutVolume = Number(
      (await page.locator(COMPLETE).getAttribute("data-cad-rendered-volume")) ??
        "0",
    );
    expect(cutVolume).toBeCloseTo(BOOT_PLATE_VOLUME / 2, -1);
    await driver.pointAtReadout(page.locator("#workbench-volume-readout"));
    await driver.dwell();

    await driver.step("off");
    await driver.humanClick(clipToggle);
    await expect(clipToggle).toHaveAttribute("aria-pressed", "false");
    await waitForRootSettle(page, COMPLETE_ROOT);
    await expect(page.locator('[data-testid="section-area"]')).toHaveCount(0);

    await driver.step("recap");
    await driver.humanPoint(
      page.locator('[data-testid="section-clip-toggle"]'),
    );
    await driver.dwell(1_200);
  },
};
