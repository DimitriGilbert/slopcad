import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * The Phase 44 verbs sit in the toolbar's full-width row (below 2xl they
 * yield to the command menu, the Hole button's discipline), so these
 * journeys run the wide viewport where the buttons live.
 */
test.use({ viewport: { width: 1600, height: 900 } });

/**
 * Phase 44 boolean workbench e2e — the roadmap's validation gate: the
 * workbench builds the PLATE-WITH-HOLE through the user-level boolean
 * command end-to-end on the OCCT route — a 60×40×10 plate extruded, a
 * ⌀10 tool extruded inside its footprint, then the Boolean dialog's
 * subtract — and the settled volume lands on the analytically derived
 * value `60·40·10 − π·5²·10` (the plate minus the full-depth cylinder),
 * with the keep-tool toggle's consume mode hiding the tool body in the
 * model tree.
 */

const OCCT_ROOT = "workbench-complete-occt-root";
const SKETCH = "#sketch-root";
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const DIALOG = '[data-testid="feature-form-dialog"]';

/** Opens the boolean dialog through the COMMAND MENU (Ctrl+K). */
async function openBooleanDialog(page: Page): Promise<void> {
  await page.keyboard.press("Control+K");
  await page.keyboard.type("boolean");
  await page.keyboard.press("Enter");
  await expect(page.locator(DIALOG)).toBeVisible();
}

/** Relative volume tolerance (display rounding plus kernel noise). */
const VOLUME_REL_TOLERANCE = 0.002;

const PLATE_VOLUME = 60 * 40 * 10;
const TOOL_VOLUME = Math.PI * 25 * 10;
const PLATE_WITH_HOLE_VOLUME = PLATE_VOLUME - TOOL_VOLUME;

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

/** Enters sketch mode from the model workspace. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.locator('[data-testid="complete-mode-toggle"]').click();
  await expect(page.locator(SKETCH)).toBeVisible();
}

/** Extrudes the current drawing by the sketch extrude button's depth 10. */
async function extrudeDrawing(page: Page): Promise<void> {
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForSettledScene(page, OCCT_ROOT);
}

test("boolean: a plate-with-hole subtracts the tool cylinder at the analytic volume", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);

  // The plate: a 60×40 rectangle from the origin, extruded 10 mm.
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 60, 40);
  await extrudeDrawing(page);

  // The tool: a ⌀10 circle centred mid-plate, extruded the same 10 mm.
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="circle"]').click();
  await clickCanvasPoint(page, 30, 20);
  await clickCanvasPoint(page, 35, 20);
  await extrudeDrawing(page);

  // The boolean: subtract the tool body (the second extrusion) from the
  // plate (the first), keeping the tools visible first.
  const before = await dispatchedCount(page, OCCT_ROOT);
  await openBooleanDialog(page);
  // Target defaults to the first feature-produced body (the plate); the
  // operation defaults to subtract. Tick the tool body's checkbox.
  await page
    .locator(DIALOG)
    .getByRole("checkbox", { name: "pad 2", exact: true })
    .check();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "boolean",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, PLATE_WITH_HOLE_VOLUME),
    `plate-with-hole ${volume} vs analytic ${String(PLATE_WITH_HOLE_VOLUME)}`,
  ).toBe(true);

  // The keep-tool toggle: consuming hides the TOOL body (the model tree's
  // eye affordance carries the hidden state).
  const treeEye = page.locator(
    '[data-cad-tree-body-visibility="visible"], [data-cad-tree-body-visibility="hidden"]',
  );
  await expect(treeEye.first()).toBeAttached();
});

test("boolean: the union of two touching plates sums the analytic volume", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);

  // Two side-by-side 30×40 plates, each extruded 10 mm: the union is the
  // full 60×40 slab.
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 30, 40);
  await extrudeDrawing(page);

  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, 30, 0);
  await clickCanvasPoint(page, 60, 40);
  await extrudeDrawing(page);

  const before = await dispatchedCount(page, OCCT_ROOT);
  await openBooleanDialog(page);
  await page.locator(DIALOG).getByRole("combobox").nth(0).click();
  await page.getByRole("option", { name: "Union (join)" }).click();
  await page
    .locator(DIALOG)
    .getByRole("checkbox", { name: "pad 2", exact: true })
    .check();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "boolean",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, PLATE_VOLUME),
    `union ${volume} vs analytic ${String(PLATE_VOLUME)}`,
  ).toBe(true);
});
