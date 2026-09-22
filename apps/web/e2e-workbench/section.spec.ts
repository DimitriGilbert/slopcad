/**
 * Phase 46 section workbench e2e — the roadmap's validation gate at the
 * browser surface: the persisted mid-height section record drives the
 * whole journey. Boot is UNSECTIONED (the record persists disabled — the
 * boot-state law: no clipping planes, no section computation, the settled
 * raster byte-unchanged); enabling the section dispatches the sectioned
 * computation through the real kernel worker (`solid.section`), the
 * Measurement block renders the cross-section area/centroid rows at the
 * analytic values (the 30×20×10 plate's 8 mm bore at z = 5:
 * `30·20 − π·4² = 549.738 mm²`, centroid the plate centre), the view-cut
 * mode swaps the displayed body to the kernel's cut solid (half the
 * volume, cap faces in its boundary), and disabling restores the
 * unsectioned settle and hides the rows.
 */

import { expect, test, type Page } from "@playwright/test";

import { waitForSettledScene } from "../e2e-render/helpers";

const ROOT = "workbench-complete-root";
const CLIP_TOGGLE = '[data-testid="section-clip-toggle"]';
const VIEW_TOGGLE = '[data-testid="section-view-toggle"]';
const AREA_ROW = '[data-testid="section-area"]';
const CENTROID_ROW = '[data-testid="section-centroid"]';

/** The analytic anchors: the plate with its default 8 mm bore. */
const PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
const SECTION_AREA = 30 * 20 - Math.PI * 16;

/** Reads the DRO volume text (mm³) off the settled scene. */
async function droVolume(page: Page): Promise<number> {
  const root = page.locator(`#${ROOT}`);
  const text =
    (await root.getAttribute("data-cad-rendered-volume")) ??
    (await root.getAttribute("data-volume"));
  expect(text).not.toBeNull();
  return Number(text);
}

test("the section journey: enable → measured rows, view cut → half volume, disable → restored", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await waitForSettledScene(page, ROOT);

  // The measurement rows answer for exactly one subject: select the plate
  // body through the model tree (the readout-family discipline — the
  // volume/area rows share it).
  await page.locator('[data-node-key="body|body_plate"]').first().click();

  // Boot law: the persisted record is DISABLED — no section rows, no clip.
  await expect(page.locator(CLIP_TOGGLE)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator(AREA_ROW)).toHaveCount(0);
  const bootVolume = await droVolume(page);
  expect(bootVolume).toBeCloseTo(PLATE_VOLUME, -1);

  // Enable the section: the sectioned computation settles with the face
  // measurements at the analytic values.
  await page.locator(CLIP_TOGGLE).click();
  await expect(page.locator(CLIP_TOGGLE)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await waitForSettledScene(page, ROOT);
  const areaText = await page.locator(AREA_ROW).textContent();
  expect(areaText).not.toBeNull();
  const areaValue = Number(areaText?.replace(" mm²", ""));
  expect(areaValue).toBeCloseTo(SECTION_AREA, 0);
  const centroidText = (await page.locator(CENTROID_ROW).textContent()) ?? "";
  expect(centroidText).toContain("x 15.000");
  expect(centroidText).toContain("y 10.000");
  expect(centroidText).toContain("z 5.000");
  // The clipped display still measures the WHOLE plate.
  const clippedVolume = await droVolume(page);
  expect(clippedVolume).toBeCloseTo(PLATE_VOLUME, -1);

  // View mode: the displayed body becomes the kernel's cut solid —
  // keepSide +1 keeps the upper half, so the volume halves.
  await page.locator(VIEW_TOGGLE).click();
  await expect(page.locator(VIEW_TOGGLE)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await waitForSettledScene(page, ROOT);
  const cutVolume = await droVolume(page);
  expect(cutVolume).toBeCloseTo(PLATE_VOLUME / 2, -1);
  // The face rows persist: the cut still measures the same section face.
  expect(
    Number((await page.locator(AREA_ROW).textContent())?.replace(" mm²", "")),
  ).toBeCloseTo(SECTION_AREA, 0);

  // Disable: the unsectioned settle returns and the rows hide.
  await page.locator(CLIP_TOGGLE).click();
  await expect(page.locator(CLIP_TOGGLE)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await waitForSettledScene(page, ROOT);
  await expect(page.locator(AREA_ROW)).toHaveCount(0);
  const restoredVolume = await droVolume(page);
  expect(restoredVolume).toBeCloseTo(PLATE_VOLUME, -1);
});
