import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  saveArtifact,
  waitForSettledScene,
  waitForTreeSelectionFrame,
} from "./helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * Phase 27.1 bounds-measurement e2e — the plan's validation: bounds
 * measured for the selected body, displayed with correct units, and a
 * browser test passes. Runs on the composed workbench (`/workbench`) on the
 * deterministic render harness, driving the SAME surfaces every other
 * measurement rides: the Phase 13 Measurement block (the measurement home),
 * the model tree's selection picks, and the parameter panel's edits.
 *
 *  - DISPLAY — selecting the plate body (tree) or its producing feature
 *    shows the kernel-measured bounds `30.000 × 20.000 × 10.000 mm` in the
 *    Measurement block, with the kernel's declared tightness; with no
 *    selection the readout honestly shows nothing;
 *  - LIVE — after the sketch → extrude journey, selecting the pad shows
 *    ITS bounds, and editing the extrude depth through the parameter panel
 *    regenerates the scene and changes the displayed bounds live;
 *  - HONESTY — selecting a body the scene does not measure (the plate while
 *    the extrude scene is active) keeps the readout empty instead of
 *    showing another body's numbers.
 *
 * Machine surfaces: `data-bounds` (the readout text, empty when nothing is
 * displayed) and `data-bounds-tightness` (the booted kernel's declared
 * boolean-bounds tightness). Clicks follow the house rule: tree rows and
 * machine-derived points only.
 */

const ROOT = "workbench-root";
const TREE = '[data-slot="cad-model-tree"]';
const READOUT = "#workbench-bounds-readout";
const TIGHTNESS = "#workbench-bounds-tightness";
const PLATE_KEY = "body|body_plate";
const PAD_KEY = "body|body_extrude";
const ROTATE_FEATURE_KEY = "feature|feat_rotate_plate";
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';
const SKETCH = "#sketch-root";

/** The sketched rectangle: workplane (10,10) → (30,25) = 20 × 15 mm. */
const RECT = { x0: 10, y0: 10, x1: 30, y1: 25 } as const;

/** The bounds readout the Measurement block displays, as data. */
async function readBounds(page: Page): Promise<string> {
  return (await page.locator(`#${ROOT}`).getAttribute("data-bounds")) ?? "";
}

/** Waits until the bounds surface displays exactly `expected`. */
async function waitForBounds(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ id, want }) => {
      const root = document.getElementById(id);
      return root !== null && root.getAttribute("data-bounds") === want;
    },
    { id: ROOT, want: expected },
  );
}

/** Waits until the command log holds exactly `count` entries. */
async function waitForCommandCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    ({ id, expected }) => {
      const root = document.getElementById(id);
      if (root === null) return false;
      const log = JSON.parse(
        root.getAttribute("data-command-log") ?? "[]",
      ) as unknown[];
      return log.length === expected;
    },
    { id: ROOT, expected: count },
  );
}

/** The tree row for a reference key (e.g. `body|body_plate`). */
function treeNode(page: Page, key: string) {
  return page.locator(`${TREE} [data-node-key="${key}"]`);
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Draws the 20×15 rectangle with the rectangle tool (sketch mode active). */
async function drawRectangle(page: Page): Promise<void> {
  await page.locator(`[data-sketch-tool-id="rectangle"]`).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "rectangle",
  );
  for (const [x, y] of [
    [RECT.x0, RECT.y0],
    [RECT.x1, RECT.y1],
  ] as const) {
    await page.locator(`${SKETCH} [data-sketch-surface]`).click({
      position: canvasPoint(x, y),
    });
  }
}

test("selecting a body displays its kernel-measured bounds with units", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // No selection, no bounds — the readout does not invent a subject.
  expect(await readBounds(page)).toBe("");

  // TREE → MEASUREMENT: the plate row selects the body; the Measurement
  // block shows the worker's `solid.bounds` extents with the unit.
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);
  await waitForBounds(page, "30.000 × 20.000 × 10.000 mm");
  await expect(page.locator(READOUT)).toHaveText("30.000 × 20.000 × 10.000 mm");
  // Units correct: the value and its unit render as one readout.
  expect(await page.locator(READOUT).textContent()).toMatch(/ mm$/);
  // Tightness honesty: the booted kernel declares tight boolean bounds.
  await expect(page.locator(TIGHTNESS)).toHaveText("tight");
  expect(
    await page.locator(`#${ROOT}`).getAttribute("data-bounds-tightness"),
  ).toBe("tight");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact("bounds-selected-plate.png", await page.screenshot());

  // A selected FEATURE resolves through its single output body — the same
  // plate bounds under the rotate feature row.
  await treeNode(page, ROTATE_FEATURE_KEY).click();
  await waitForTreeSelectionFrame(page, ROTATE_FEATURE_KEY, ROOT);
  await waitForBounds(page, "30.000 × 20.000 × 10.000 mm");

  // A parameter edit re-measures through the worker (the volume changes);
  // the through bore never reaches the box's extremes, so the bounds stay.
  await page.getByLabel("holeDiameter", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Apply" }).click();
  await waitForCommandCount(page, 1);
  await waitForSettledScene(page, ROOT);
  await waitForBounds(page, "30.000 × 20.000 × 10.000 mm");
  await expect(page.locator(READOUT)).toHaveText("30.000 × 20.000 × 10.000 mm");
});

test("a parameter edit changes the selected body's displayed bounds live", async ({
  page,
}) => {
  // The sketch → extrude journey: the pad becomes the measured scene body.
  await page.goto("/workbench");
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await waitForSettledScene(page, ROOT);

  // Selecting the pad shows ITS kernel-measured bounds with units.
  await treeNode(page, PAD_KEY).click();
  await waitForTreeSelectionFrame(page, PAD_KEY, ROOT);
  await waitForBounds(page, "20.000 × 15.000 × 10.000 mm");
  await expect(page.locator(READOUT)).toHaveText("20.000 × 15.000 × 10.000 mm");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact("bounds-selected-extrude.png", await page.screenshot());

  // LIVE: the depth edit regenerates the scene; the readout follows the
  // new kernel measurement without any further interaction.
  await page.getByLabel("extrudeDepth", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Apply" }).click();
  await waitForCommandCount(page, 2);
  await waitForSettledScene(page, ROOT);
  await waitForBounds(page, "20.000 × 15.000 × 15.000 mm");
  await expect(page.locator(READOUT)).toHaveText("20.000 × 15.000 × 15.000 mm");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact("bounds-regenerated-extrude.png", await page.screenshot());

  // Phase 16 document-scene semantics: the plate renders as a body of the
  // document scene, so selecting it answers with ITS OWN kernel-measured
  // bounds — the readout answers for every body the settled scene
  // measured, never another body's numbers.
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);
  await waitForBounds(page, "30.000 × 20.000 × 10.000 mm");
  await expect(page.locator(READOUT)).toHaveText("30.000 × 20.000 × 10.000 mm");
});
