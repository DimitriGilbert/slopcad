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
 *
 * ## The raster half (the empty-canvas regression)
 *
 * The DOM/data assertions below all passed while the canvas showed grid
 * only: the section transitions used to REMOVE the material's
 * `clippingPlanes` host prop, and R3F's removed-prop reset writes a
 * literal `0` into `material.clippingPlanes` (its memoized-default path
 * only covers zero-argument constructors), which breaks three's
 * local-clipping state so badly the mesh stops drawing. The raster
 * assertions pin the pixels, not the data: the on→off transition must
 * restore the boot raster BYTE-FOR-BYTE (same projection content, same
 * camera, same selection), and view-cut must carry real model pixels
 * (the amber selected-plate family, counted in-page) — an empty canvas
 * has none.
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

/** The absolute floor of selected-plate pixels a model-bearing frame carries. */
const GOLDEN_MODEL_FLOOR = 2000;
/** View-cut keeps the upper half: at least this share of the boot pixels. */
const GOLDEN_VIEW_CUT_SHARE = 0.4;

/** Reads the DRO volume text (mm³) off the settled scene. */
async function droVolume(page: Page): Promise<number> {
  const root = page.locator(`#${ROOT}`);
  const text =
    (await root.getAttribute("data-cad-rendered-volume")) ??
    (await root.getAttribute("data-volume"));
  expect(text).not.toBeNull();
  return Number(text);
}

/** Two animation frames past the settle, so a capture samples drawn pixels. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

/** Captures the workbench canvas's bytes (DPR-1 SwiftShader, deterministic). */
async function canvasBytes(page: Page): Promise<Buffer> {
  await settleFrames(page);
  return page.locator(`#${ROOT} canvas`).first().screenshot();
}

/**
 * Counts the selected plate's amber-family pixels IN THE PAGE (the same
 * browser renderer that produced the bytes decodes them — the
 * `diffElementCaptures` discipline). The body-selection highlight is the
 * only saturated amber in the scene: the graphite backdrop, gray grid,
 * and pure-hue axes all fall outside the family, so the count IS the
 * model's screen presence.
 */
async function goldenPixels(page: Page, bytes: Buffer): Promise<number> {
  return page.evaluate(async (png) => {
    const binary = atob(png);
    const raw = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      raw[index] = binary.charCodeAt(index);
    }
    const bitmap = await createImageBitmap(
      new Blob([raw], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("golden-pixel decode requires a 2D canvas context");
    }
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let golden = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      if (r >= 100 && r > b + 80 && g > b + 30 && g < r) golden += 1;
    }
    return golden;
  }, bytes.toString("base64"));
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

  // The boot raster is the byte-pinned baseline the disable transition
  // must return to: the selected amber plate is provably on screen (the
  // empty-canvas class would fail here already at boot).
  const bootBytes = await canvasBytes(page);
  const bootGolden = await goldenPixels(page, bootBytes);
  expect(
    bootGolden,
    "the settled boot canvas carries the selected plate",
  ).toBeGreaterThan(GOLDEN_MODEL_FLOOR);

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
  // Raster: the cut solid is ON SCREEN — real model pixels, not the
  // grid-only canvas the DOM-only assertions of the regression showed.
  const cutGolden = await goldenPixels(page, await canvasBytes(page));
  expect(
    cutGolden,
    "the view-cut canvas carries the cut solid's pixels",
  ).toBeGreaterThan(bootGolden * GOLDEN_VIEW_CUT_SHARE);

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
  // Raster: full geometry restored — the disable transition returns the
  // boot raster byte-for-byte (same projection content, same camera,
  // same selection; anything else is a rendering regression, however
  // correct the DRO reads).
  const restoredBytes = await canvasBytes(page);
  expect(
    restoredBytes.equals(bootBytes),
    "clip on→off restores the boot canvas bytes exactly",
  ).toBe(true);
});
