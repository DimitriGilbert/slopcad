import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  saveArtifact,
  waitForSettledScene,
  waitForTreeSelectionFrame,
} from "./helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * Phase 27.4 mass-properties e2e — the plan's validation: volume and
 * surface-area measurements exposed from the kernel's capabilities, whose
 * VALUES AGREE WITH KERNEL SEMANTICS, displayed in the Measurement block
 * with correct units, and a browser test passes. Runs on the composed
 * workbench (`/workbench`) on the deterministic render harness, driving the
 * same surfaces every other measurement rides: the Measurement block's
 * Volume/Area rows and the model tree's selection picks.
 *
 *  - DISPLAY — selecting the plate body (tree) shows the kernel-measured
 *    `solid.volume` and `solid.area` (the Phase 27.4 op) in the Measurement
 *    block with `mm³`/`mm²` units; the displayed volume agrees BYTE-FOR-BYTE
 *    with the settled status-bar volume (two formatting paths over one
 *    kernel number), and both values sit inside the documented kernel band
 *    around the analytic plate truth (the polygonal bore's inscribed
 *    boundary, the mesh kernel's own exact-over-its-boundary semantics);
 *  - EXACT — the sketch → extrude pad is a PLANAR prism (no curved faces),
 *    so the kernel's numbers are the closed forms themselves:
 *    `3000.000 mm³` / `1300.000 mm²`; editing the depth regenerates and the
 *    rows follow live (`4500.000 mm³` / `1650.000 mm²`);
 *  - HONESTY — with no selection the rows show nothing rather than the
 *    scene's numbers.
 *
 * Machine surfaces: `data-mass-volume` / `data-mass-area` (the readout
 * texts, empty when nothing is displayed) and the settled `data-volume`
 * stamp. Clicks follow the house rule: tree rows and machine-derived
 * points only.
 */

const ROOT = "workbench-root";
const TREE = '[data-slot="cad-model-tree"]';
const VOLUME_READOUT = "#workbench-volume-readout";
const AREA_READOUT = "#workbench-area-readout";
const PLATE_KEY = "body|body_plate";
const PAD_KEY = "body|body_extrude";
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';
const SKETCH = "#sketch-root";

/** The sketched rectangle: workplane (10,10) → (30,25) = 20 × 15 mm. */
const RECT = { x0: 10, y0: 10, x1: 30, y1: 25 } as const;

/** Relative half-width of the documented kernel band around the analytic truth. */
const BAND = 0.01;

/** A mass readout the Measurement block displays, as data. */
async function readMass(
  page: Page,
  attribute: "data-mass-volume" | "data-mass-area",
): Promise<string> {
  return (await page.locator(`#${ROOT}`).getAttribute(attribute)) ?? "";
}

/** Waits until both mass rows display their texts. */
async function waitForMass(
  page: Page,
  volume: string,
  area?: string,
): Promise<void> {
  await page.waitForFunction(
    ({ id, wantVolume, wantArea }) => {
      const root = document.getElementById(id);
      return (
        root !== null &&
        root.getAttribute("data-mass-volume") === wantVolume &&
        (wantArea === null || root.getAttribute("data-mass-area") === wantArea)
      );
    },
    { id: ROOT, wantVolume: volume, wantArea: area ?? null },
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

test("selecting a body displays its kernel-measured volume and surface area", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // No selection, no mass properties — the rows do not invent a subject.
  expect(await readMass(page, "data-mass-volume")).toBe("");
  expect(await readMass(page, "data-mass-area")).toBe("");
  await expect(page.locator(VOLUME_READOUT)).toHaveCount(0);

  // TREE → MEASUREMENT: the plate row selects the body; the Volume/Area
  // rows show the worker's `solid.volume`/`solid.area` with their units.
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);
  await page.waitForFunction(
    ({ id }) => {
      const root = document.getElementById(id);
      return root !== null && root.getAttribute("data-mass-volume") !== "";
    },
    { id: ROOT },
  );
  const volumeText = await readMass(page, "data-mass-volume");
  const areaText = await readMass(page, "data-mass-area");

  // Units correct: value and unit render as one readout.
  expect(volumeText).toMatch(/^[\d.]+ mm³$/);
  expect(areaText).toMatch(/^[\d.]+ mm²$/);

  // Kernel-semantics agreement #1: the readout IS the settled kernel
  // volume — the Measurement block's dimensional formatting and the
  // settle stamp's `toFixed(3)` must agree byte-for-byte.
  const settledVolume =
    (await page.locator(`#${ROOT}`).getAttribute("data-volume")) ?? "";
  expect(volumeText).toBe(`${settledVolume} mm³`);

  // Kernel-semantics agreement #2: both values sit inside the documented
  // band around the analytic plate truth (30×20×10 minus a ⌀8 through
  // bore: volume w·d·h − πr²h; area box faces − 2 bore circles + wall).
  const volume = Number(volumeText.replace(" mm³", ""));
  const area = Number(areaText.replace(" mm²", ""));
  const analyticVolume = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
  const analyticArea =
    2 * (30 * 20 + 30 * 10 + 20 * 10) -
    2 * Math.PI * 4 ** 2 +
    2 * Math.PI * 4 * 10;
  expect(Math.abs(volume - analyticVolume)).toBeLessThanOrEqual(
    analyticVolume * BAND,
  );
  expect(Math.abs(area - analyticArea)).toBeLessThanOrEqual(
    analyticArea * BAND,
  );
  await expect(page.locator(VOLUME_READOUT)).toHaveText(volumeText);
  await expect(page.locator(AREA_READOUT)).toHaveText(areaText);

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact(
    "mass-properties-selected-plate.png",
    await page.screenshot(),
  );
});

test("the sketch → extrude pad measures its exact prism mass properties live", async ({
  page,
}) => {
  // The pad is a planar prism — no curved faces — so the kernel's boundary
  // is the closed form itself and the readouts are byte-exact.
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

  await treeNode(page, PAD_KEY).click();
  await waitForTreeSelectionFrame(page, PAD_KEY, ROOT);
  await waitForMass(page, "3000.000 mm³", "1300.000 mm²");
  await expect(page.locator(VOLUME_READOUT)).toHaveText("3000.000 mm³");
  await expect(page.locator(AREA_READOUT)).toHaveText("1300.000 mm²");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact(
    "mass-properties-selected-extrude.png",
    await page.screenshot(),
  );

  // LIVE: the depth edit regenerates the scene; both rows follow the new
  // kernel measurements without any further interaction.
  await page.getByLabel("extrudeDepth", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Apply" }).click();
  await waitForSettledScene(page, ROOT);
  await waitForMass(page, "4500.000 mm³", "1650.000 mm²");
  await expect(page.locator(VOLUME_READOUT)).toHaveText("4500.000 mm³");
  await expect(page.locator(AREA_READOUT)).toHaveText("1650.000 mm²");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact(
    "mass-properties-regenerated-extrude.png",
    await page.screenshot(),
  );
});
