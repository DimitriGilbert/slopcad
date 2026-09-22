/**
 * Phase 43 pattern & mirror workbench e2e — the roadmap's validation gate:
 * the pattern editor arrays the rod end-to-end on the OCCT route (a leg
 * with a skip instance), the settled volume lands on the analytic value,
 * SKIP INSTANCES RE-DRIVE through the parameter panel (the count edit
 * re-composes the arrangement around the standing skip), the path pattern
 * distributes the rod along a saved straight path sketch, and the datum-
 * plane mirror MERGES the reflection with the original (and re-drives
 * back to the standalone copy).
 *
 * Anchors (derived, mm³): the ⌀6 × 10 rod is 90π. The pattern's copies
 * stay disjoint (spacing past the rod's 6 mm extent), so N instances
 * measure exactly N·90π — the same arithmetic the kernel fixtures pin.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * The Phase 43 verbs sit in the toolbar's full-width row (below 2xl they
 * yield to the command menu), so these journeys run a wide viewport —
 * the row's authored usage. The row grew by three verbs that phase and
 * two more in Phase 44 (Boolean and Move, both yielding below 1800), so
 * 2080 is the width that keeps the Sketch toggle (the row's last button)
 * inside the viewport.
 */
test.use({ viewport: { width: 2080, height: 1080 } });

const OCCT_ROOT = "workbench-complete-occt-root";
const SKETCH = "#sketch-root";
const SAVE_BUTTON = '[data-testid="sketch-save"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const PATTERN_BUTTON = '[data-testid="complete-pattern"]';
const PATH_BUTTON = '[data-testid="complete-pattern-path"]';
const MIRROR_BUTTON = '[data-testid="complete-mirror"]';
const DATUM_BUTTON = '[data-testid="complete-datum"]';
const DIALOG = '[data-testid="feature-form-dialog"]';

/** Relative volume tolerance (display rounding plus kernel noise). */
const VOLUME_REL_TOLERANCE = 0.002;

const ROD_VOLUME = 90 * Math.PI;

/** Volume proximity inside the documented band. */
function volumeNear(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= expected * VOLUME_REL_TOLERANCE;
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Clicks the sketch canvas at a workplane mm point. */
async function clickCanvasPoint(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page
    .locator(`${SKETCH} [data-sketch-surface]`)
    .click({ position: canvasPoint(x, y) });
}

/** The route's root element id (the OCCT route boots the OCCT backend). */
const PAGE_ROOT = `#${OCCT_ROOT}`;

/** Enters sketch mode from the model workspace. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.locator('[data-testid="complete-mode-toggle"]').click();
  await expect(page.locator(SKETCH)).toBeVisible();
}

/** Saves the current drawing as a standalone sketch record. */
async function saveSketch(page: Page): Promise<void> {
  await page.locator(SAVE_BUTTON).click();
  await expect(page.locator(PAGE_ROOT)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
}

/** Draws and extrudes the ⌀6 rod (the sketch extrude button's depth 10). */
async function drawRod(page: Page): Promise<void> {
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="circle"]').click();
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 3, 0);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(PAGE_ROOT)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForSettledScene(page, OCCT_ROOT);
}

test("pattern: the editor arrays the rod with a skip and re-drives around it", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await drawRod(page);

  // The pattern editor: one leg (0°, 3 copies, 20 mm) with instance 1
  // skipped — two disjoint copies of the rod.
  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(PATTERN_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page
    .locator(DIALOG)
    .getByRole("button", { name: "Skip an instance" })
    .click();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(PAGE_ROOT)).toHaveAttribute(
    "data-scene-kind",
    "patternFeature",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, 2 * ROD_VOLUME),
    `patterned ${volume} vs analytic ${String(2 * ROD_VOLUME)}`,
  ).toBe(true);

  // SKIP-INSTANCES RE-DRIVE (the roadmap's validation criterion): the
  // count 3 → 5 and the spacing 20 → 30 re-compose the arrangement
  // around the STANDING skip — four copies at 0/60/90/120, disjoint.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("patternCount1", { exact: true }).fill("5");
  await page.getByLabel("patternSpacing1", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Apply" }).click();
  const redriven = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(
    volumeNear(redriven, 4 * ROD_VOLUME),
    `re-driven ${redriven} vs analytic ${String(4 * ROD_VOLUME)}`,
  ).toBe(true);
});

test("path pattern: the rod repeats along a saved straight path", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await drawRod(page);

  // The path sketch: one line from the origin straight up, (0,0) →
  // (0,30) — the walk's +z tangent in the world XZ frame.
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="line"]').click();
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 0, 30);
  await saveSketch(page);

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(PATH_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  // The pool's first entry is the extrude-committed circle profile; pick
  // the SAVED line sketch (the path the pattern walks).
  await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
  await page.getByRole("option", { name: "sketch 1", exact: true }).click();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(PAGE_ROOT)).toHaveAttribute(
    "data-scene-kind",
    "patternPath",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  // Four copies stacked every 10 mm along +z: disjoint, exactly 4·90π.
  expect(
    volumeNear(volume, 4 * ROD_VOLUME),
    `path patterned ${volume} vs analytic ${String(4 * ROD_VOLUME)}`,
  ).toBe(true);
});

test("mirror: a datum plane merges the reflection and re-drives standalone", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await drawRod(page);

  // The datum plane at x = 5 (normal +x, in-plane +y): the rod's
  // reflection x → 10 − x lands at x ∈ [7, 13], disjoint from the rod.
  await page.locator(DATUM_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.getByLabel("Origin x (mm)").fill("5");
  await page.getByLabel("Normal x").fill("1");
  await page.getByLabel("Normal z").fill("0");
  await page.getByLabel("In-plane x x").fill("0");
  await page.getByLabel("In-plane x y").fill("1");
  await page
    .locator(DIALOG)
    .getByRole("button", { name: "Create datum" })
    .click();
  await expect(page.locator(DIALOG)).toBeHidden();

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(MIRROR_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(`${DIALOG} [role="combobox"]`).nth(1).click();
  await page.getByRole("option", { name: "Merge with the original" }).click();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(PAGE_ROOT)).toHaveAttribute(
    "data-scene-kind",
    "mirror",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, 2 * ROD_VOLUME),
    `merged ${volume} vs analytic ${String(2 * ROD_VOLUME)}`,
  ).toBe(true);

  // PARAMETER RE-DRIVE: the merge option 2 → 1 returns the standalone
  // reflection's exact volume.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("mirrorMerge", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Apply" }).click();
  const standalone = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(volumeNear(standalone, ROD_VOLUME)).toBe(true);
});
