import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * The Phase 41 verbs sit in the toolbar's full-width row (below 2xl they
 * yield to the command menu, the Hole button's discipline), so these
 * journeys run the wide viewport where the buttons live — the row's
 * authored usage. The sketch-canvas transform is viewport-independent
 * (the fixture's fixed frame).
 */
test.use({ viewport: { width: 1600, height: 900 } });

/**
 * Phase 41 feature-richness workbench e2e — the roadmap's validation gate:
 * the workbench drafts (a tapered extrusion), ribs, scales, thickens, and
 * splits a body end-to-end on the OCCT route, the settled volumes land on
 * the analytically derived values, parameter edits re-drive regeneration,
 * and the default Manifold route settles thicken's honest decline.
 *
 * Anchors (derived, mm³):
 *
 * - DRAFT: the ⌀6 circle drafted 5° over 10 mm is the cone frustum
 *   `πh(R² + Rr + r²)/3` with `r = R − h·tan α` — the miter-quadratic
 *   volume OCCT's DraftAngle hits exactly (the prespike probe).
 * - RIB: the ⌀6 × 10 rod plus a 10 × 1 rectangle swept ±1 mm about the
 *   sketch plane — the union adds strictly between the rod's volume and
 *   the rod + the rib's full 20 mm³ (the overlap is inside the rod).
 * - SCALE: ×2 scales the rod's volume by exactly 8.
 * - THICKEN: 1 mm walls hollow the rod into `90π − 32π` (the inward
 *   offset of every face: the r = 2 cavity between the z = 1 and z = 9
 *   caps — the closed hollow's exact volume).
 * - SPLIT: the z = 5 datum plane keeps exactly half the rod, 45π.
 */

const OCCT_ROOT = "workbench-complete-occt-root";
const MANIFOLD_ROOT = "workbench-complete-root";
const SKETCH = "#sketch-root";
const SAVE_BUTTON = '[data-testid="sketch-save"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const DRAFT_BUTTON = '[data-testid="complete-draft"]';
const RIB_BUTTON = '[data-testid="complete-rib"]';
const SCALE_BUTTON = '[data-testid="complete-scale"]';
const THICKEN_BUTTON = '[data-testid="complete-thicken"]';
const SPLIT_BUTTON = '[data-testid="complete-split"]';
const DATUM_BUTTON = '[data-testid="complete-datum"]';
const DIALOG = '[data-testid="feature-form-dialog"]';

/** Relative volume tolerance (display rounding plus kernel noise). */
const VOLUME_REL_TOLERANCE = 0.002;

const DEG5 = (5 * Math.PI) / 180;
const ROD_VOLUME = Math.PI * 9 * 10;
const DRAFT_TOP_RADIUS = 3 - 10 * Math.tan(DEG5);
const DRAFT_VOLUME =
  (Math.PI * 10 * (9 + 3 * DRAFT_TOP_RADIUS + DRAFT_TOP_RADIUS ** 2)) / 3;
const THICKEN_VOLUME = 90 * Math.PI - 32 * Math.PI;
const SPLIT_VOLUME = 45 * Math.PI;

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

/** The route's root element id (the two routes boot different backends). */
function pageRoot(page: Page): string {
  return page.url().includes("occt") ? `#${OCCT_ROOT}` : `#${MANIFOLD_ROOT}`;
}

/** Enters sketch mode from the model workspace. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.locator('[data-testid="complete-mode-toggle"]').click();
  await expect(page.locator(SKETCH)).toBeVisible();
}

/** Saves the current drawing as a standalone sketch record. */
async function saveSketch(page: Page): Promise<void> {
  await page.locator(SAVE_BUTTON).click();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
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
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForSettledScene(page, OCCT_ROOT);
}

test("draft: a saved circle extrudes with a 5° taper to the frustum", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);

  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="circle"]').click();
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 3, 0);
  await saveSketch(page);

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(DRAFT_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, DRAFT_VOLUME),
    `drafted ${volume} vs analytic ${String(DRAFT_VOLUME)}`,
  ).toBe(true);

  // PARAMETER RE-DRIVE: the taper flattens 5° → 0 through the parameter
  // panel — the plain prism's exact volume.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("extrudeTaper1", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Apply" }).click();
  const flat = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(volumeNear(flat, ROD_VOLUME)).toBe(true);
});

test("rib: a cross-section sketch unions into the rod and re-drives", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await drawRod(page);

  // The rib's cross-section: a 10 × 1 rectangle through the rod's mid-
  // plane, saved as a standalone sketch record.
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, -5, -0.5);
  await clickCanvasPoint(page, 5, 0.5);
  await saveSketch(page);

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(RIB_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
  await page.getByRole("option", { name: "sketch 1", exact: true }).click();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "rib",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  // The union adds strictly between the rod and the rod + the rib's full
  // 20 mm³ (the rib's overlap with the rod adds nothing).
  expect(volume).toBeGreaterThan(ROD_VOLUME);
  expect(volume).toBeLessThanOrEqual(ROD_VOLUME + 20);

  // PARAMETER RE-DRIVE: the thickness doubles 2 → 4; the union grows.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("ribThickness", { exact: true }).fill("4");
  await page.getByRole("button", { name: "Apply" }).click();
  const thicker = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(thicker).toBeGreaterThan(volume);
});

test("scale: the rod scales by exactly 8 at factor 2 and re-drives to 27", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await drawRod(page);

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(SCALE_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "scale",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(volumeNear(volume, ROD_VOLUME * 8)).toBe(true);

  // PARAMETER RE-DRIVE: factor 2 → 3; volume scales by 27.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("scaleFactor", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Apply" }).click();
  const bigger = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(volumeNear(bigger, ROD_VOLUME * 27)).toBe(true);
});

test("thicken: the rod hollows into the exact closed shell and re-drives", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await drawRod(page);

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(THICKEN_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  // The form's authored default is 2 mm walls (THICKEN_DEFAULTS, the unit
  // suite's anchor); this journey pins 1 mm — the docblock's analytic band.
  await page.getByLabel("Wall thickness (mm)").fill("1");
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "thicken",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, THICKEN_VOLUME),
    `hollowed ${volume} vs analytic ${String(THICKEN_VOLUME)}`,
  ).toBe(true);

  // PARAMETER RE-DRIVE: walls 1 → 2 shrink the hollow to 90π − 6π.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("wallThickness", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Apply" }).click();
  const thinner = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(volumeNear(thinner, 90 * Math.PI - 6 * Math.PI)).toBe(true);
});

test("split: the z = 5 datum plane keeps half the rod", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await drawRod(page);

  // The cutting plane: a datum at the rod's mid-height.
  await page.locator(DATUM_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.getByLabel("Origin z (mm)").fill("5");
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(SPLIT_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "split",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, SPLIT_VOLUME),
    `split ${volume} vs analytic ${String(SPLIT_VOLUME)}`,
  ).toBe(true);

  // PARAMETER RE-DRIVE: flipping the keep side keeps the other half of
  // the symmetric rod — the same volume, a genuinely re-driven cut.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("splitSide", { exact: true }).fill("-1");
  await page.getByRole("button", { name: "Apply" }).click();
  const flipped = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(volumeNear(flipped, SPLIT_VOLUME)).toBe(true);
});

test("thicken on the default Manifold workbench declines honestly", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete");
  await waitForSettledScene(page, MANIFOLD_ROOT);

  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="circle"]').click();
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 3, 0);
  await page.locator(EXTRUDE_BUTTON).click();
  const rodVolume = await waitForSettledScene(page, MANIFOLD_ROOT);

  await page.locator(THICKEN_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "thicken",
  );

  // The structured decline lands on the error surface; the pixels stay
  // the last honest scene (the extruded rod — no fabricated hollow from
  // a kernel that cannot build one).
  await expect(page.locator("#workbench-complete-error")).toContainText(
    "kernel/unsupported-operation",
    { timeout: 30_000 },
  );
  const stalled = await page
    .locator(pageRoot(page))
    .getAttribute("data-cad-rendered-volume");
  expect(stalled).toBe(rodVolume);
});
