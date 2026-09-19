import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  dispatchedCount,
  saveArtifact,
  sha256,
  waitForSettledScene,
} from "./helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";

/**
 * Phase 26.1 extrude e2e — the browser workflow on the deterministic render
 * harness (production build, SwiftShader, fixed 1280×720 DPR 1, one worker,
 * config-level video captures the journey). The plan's validation:
 *
 *  - GEOMETRY SEMANTICS — sketch a rectangle → Extrude → the REAL Manifold
 *    kernel executes `solid.extrude` in the worker and the settled volume is
 *    within the documented tolerance of the analytic width×height×depth;
 *  - NEGATIVE DIRECTION — a signed parameter edit (10 → −10) flips the
 *    extrusion below the sketch plane at unchanged volume;
 *  - FAILURE STATE — an open chain refuses the action with the structured
 *    `sketch/profile-open-chain` code on the machine surface and the status
 *    line, and the document is untouched;
 *  - PARAMETERIZED DISTANCE — a positive parameter edit (10 → 15)
 *    regenerates the solid at the new distance;
 *  - SCREENSHOT BASELINE — the settled extrude scene is byte-stable across
 *    two independent browser journeys.
 *
 * Machine surfaces: `data-sketch-extrude` (the action's outcome),
 * `data-scene-kind`, `data-scene-bounds`, `data-scene-extents`, and the
 * shared settle surface (`data-volume`, `data-cad-rendered-volume`). Click
 * derivation follows the house rule: every canvas click comes from the
 * documented `SKETCH_CANVAS` transform.
 */

const ROOT = "#workbench-root";
const SKETCH = "#sketch-root";
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';

/** The sketched rectangle: workplane (10,10) → (30,25) = 20 × 15 mm. */
const RECT = {
  x0: 10,
  y0: 10,
  x1: 30,
  y1: 25,
} as const;

/** The default extrusion depth the action creates the parameter with
 *  (single source of truth: the sketch mode's constant). */
const DEFAULT_DEPTH_MM = EXTRUDE_DEFAULT_DEPTH_MM;

/** The analytic volume of the extruded rectangle (mm³). */
const RECT_VOLUME = (depth: number): number =>
  (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * depth;

/** Relative volume tolerance (the render suite's documented Manifold band). */
const VOLUME_REL_TOLERANCE = 0.005;

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Enters sketch mode from a fresh workbench page. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.goto("/workbench");
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
}

/** Activates a sketch tool through the toolbar. */
async function activateTool(page: Page, toolId: string): Promise<void> {
  await page.locator(`[data-sketch-tool-id="${toolId}"]`).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    toolId,
  );
}

/** Clicks the canvas at a workplane mm point. */
async function clickCanvasPoint(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  const point = canvasPoint(x, y);
  await page.locator(`${SKETCH} [data-sketch-surface]`).click({
    position: point,
  });
}

/** Draws the 20×15 rectangle with the rectangle tool. */
async function drawRectangle(page: Page): Promise<void> {
  await activateTool(page, "rectangle");
  await clickCanvasPoint(page, RECT.x0, RECT.y0);
  await clickCanvasPoint(page, RECT.x1, RECT.y1);
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { kind: string }[];
  expect(entities.filter((entity) => entity.kind === "rectangle").length).toBe(
    1,
  );
}

/** Runs the sketch → extrude journey and returns the settled volume text. */
async function runRectangleExtrudeJourney(page: Page): Promise<string> {
  await enterSketchMode(page);
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  // The action exits to the model workspace and switches the scene.
  await expect(page.locator(ROOT)).toHaveAttribute("data-sketch-mode", "model");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  return waitForSettledScene(page, "workbench-root");
}

interface SceneSurface {
  readonly kind: string;
  readonly extents: string;
  readonly bounds: { readonly min: number[]; readonly max: number[] };
}

/** Reads the scene machine surface (kind, extents, bounds). */
async function readSceneSurface(page: Page): Promise<SceneSurface> {
  const root = page.locator(ROOT);
  return {
    kind: await root.getAttribute("data-scene-kind").then((v) => v ?? ""),
    extents: await root.getAttribute("data-scene-extents").then((v) => v ?? ""),
    bounds: JSON.parse(
      (await root.getAttribute("data-scene-bounds")) ??
        '{"min":[0,0,0],"max":[0,0,0]}',
    ) as SceneSurface["bounds"],
  };
}

test("sketch → extrude produces the real solid at the analytic volume, byte-stably", async ({
  page,
}, testInfo) => {
  const volume = await runRectangleExtrudeJourney(page);

  // GEOMETRY SEMANTICS: settled volume within the documented band of the
  // analytic width×height×depth (Manifold's polygon extrusion of a
  // rectangle is exact up to float, far inside the band).
  const analytic = RECT_VOLUME(DEFAULT_DEPTH_MM);
  const settled = Number(volume);
  expect(
    Math.abs(settled - analytic) / analytic,
    `volume ${settled} vs analytic ${analytic}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);
  const scene = await readSceneSurface(page);
  expect(scene.extents).toBe("20.000 × 15.000 × 10.000");
  expect(scene.bounds.min[2]).toBe(0);
  expect(scene.bounds.max[2]).toBe(10);

  // SCREENSHOT BASELINE: a second, independent journey reproduces the
  // settled scene's exact canvas bytes.
  const shot = await page.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact(
    `${testInfo.title.match(/^\w+/)?.[0] ?? "extrude"}-baseline.png`,
    shot,
  );
});

test("the settled extrude scene reproduces byte-identically in a second context", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const firstContext = await browser.newContext();
  const page1 = await firstContext.newPage();
  await runRectangleExtrudeJourney(page1);
  const first = await page1.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("extrude-repro-1.png", first);
  await firstContext.close();

  const secondContext = await browser.newContext();
  const page2 = await secondContext.newPage();
  await runRectangleExtrudeJourney(page2);
  const second = await page2.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("extrude-repro-2.png", second);
  expect(
    second.equals(first),
    `repro sha256=${sha256(second)} vs first=${sha256(first)}`,
  ).toBe(true);
  await secondContext.close();
});

test("a negative parameter edit flips the extrusion below the plane at unchanged volume", async ({
  page,
}) => {
  const volume = await runRectangleExtrudeJourney(page);
  const settled = Number(volume);
  const analytic = RECT_VOLUME(DEFAULT_DEPTH_MM);
  expect(Math.abs(settled - analytic) / analytic).toBeLessThan(
    VOLUME_REL_TOLERANCE,
  );

  // NEGATIVE DIRECTION: sign flip through the parameter panel (the same
  // `parameter.set` surface every dimension edit rides). The settle is
  // ANCHORED on the dispatch counter captured before the Apply click: the
  // edit's document change and its dispatch effect land in separate
  // commits, so an unanchored wait could accept the pre-edit settled state.
  const beforeFlip = await dispatchedCount(page, "workbench-root");
  await page.getByLabel("extrudeDepth", { exact: true }).fill("-10");
  await page.getByRole("button", { name: "Apply" }).click();
  const flipped = Number(
    await waitForSettledScene(page, "workbench-root", {
      afterDispatch: beforeFlip,
    }),
  );
  expect(Math.abs(flipped - analytic) / analytic).toBeLessThan(
    VOLUME_REL_TOLERANCE,
  );
  const scene = await readSceneSurface(page);
  expect(scene.bounds.min[2]).toBe(-10);
  expect(scene.bounds.max[2]).toBe(0);
});

test("an open chain refuses the extrude with a structured failure and no scene change", async ({
  page,
}) => {
  await enterSketchMode(page);
  await activateTool(page, "line");
  // Two disconnected strokes: (0,0)→(10,0), then (0,10)→(10,10).
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 10, 0);
  await clickCanvasPoint(page, 0, 10);
  await clickCanvasPoint(page, 10, 10);
  await page.locator(EXTRUDE_BUTTON).click();

  // FAILURE STATE: the structured code on the machine surface, the message
  // on the status line, and the sketch session is UNTOUCHED (no document
  // commit, no mode switch).
  const extrudeSurface = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-extrude")) ?? "{}",
  ) as { status: string; code?: string };
  expect(extrudeSurface.status).toBe("failed");
  expect(extrudeSurface.code).toBe("sketch/profile-open-chain");
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-scene-kind", "plate");
  const statusText = await page
    .locator('[data-testid="sketch-status-message"]')
    .textContent();
  expect(statusText).toContain("open");
});

test("a positive parameter edit regenerates the solid at the new distance", async ({
  page,
}) => {
  await runRectangleExtrudeJourney(page);

  // Same anchored discipline as the negative edit: the settle must belong
  // to the dispatch this edit triggers, never the pre-edit state.
  const beforeEdit = await dispatchedCount(page, "workbench-root");
  await page.getByLabel("extrudeDepth", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Apply" }).click();
  const regenerated = Number(
    await waitForSettledScene(page, "workbench-root", {
      afterDispatch: beforeEdit,
    }),
  );
  const analytic = RECT_VOLUME(15);
  expect(
    Math.abs(regenerated - analytic) / analytic,
    `regenerated ${regenerated} vs analytic ${analytic}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);
  const scene = await readSceneSurface(page);
  expect(scene.extents).toBe("20.000 × 15.000 × 15.000");
  expect(scene.bounds.max[2]).toBe(15);
});
