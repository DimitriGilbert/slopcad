import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  dispatchedCount,
  saveArtifact,
  sha256,
  waitForSettledScene,
} from "./helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import {
  REVOLVE_AXIS_X_RAD,
  REVOLVE_AXIS_Y_RAD,
} from "../src/cad-workbench/revolve";

/**
 * Phase 26.2 revolve e2e — the browser workflow on the deterministic render
 * harness (production build, SwiftShader, fixed 1280×720 DPR 1, one worker,
 * config-level video captures the journey). The plan's validation:
 *
 *  - GEOMETRY SEMANTICS — sketch a rectangle touching the axis → Revolve →
 *    the REAL Manifold kernel executes `solid.revolve` in the worker and the
 *    settled volume is within the documented tolerance of the analytic
 *    cylinder (height × radius² × π);
 *  - FULL / PARTIAL — a sweep parameter edit (2π → π rad, the canonical
 *    unit the parameter panel edits in) halves the volume within tolerance;
 *  - INVALID AXIS — a profile straddling the chosen axis refuses the action
 *    with the structured `kernel/profile-axis-crossing` code on the machine
 *    surface and the status line, and the document is untouched;
 *  - SCREENSHOT BASELINE — the settled revolve scene is byte-stable across
 *    two independent browser journeys.
 *
 * Axis selection UX: a workplane-axis selector (X/Y — the axis line runs
 * through the workplane origin along the picked axis, pinned as the axis
 * parameter) beside the Revolve button; custom line picks are a later
 * interaction, documented in cad-workbench/revolve.ts.
 *
 * Machine surfaces: `data-sketch-revolve` (the action's outcome),
 * `data-sketch-revolve-axis` (the selector state), `data-scene-kind`,
 * `data-scene-bounds`, and the shared settle surface. Click derivation
 * follows the house rule: every canvas click comes from the documented
 * `SKETCH_CANVAS` transform.
 */

const ROOT = "#workbench-root";
const SKETCH = "#sketch-root";
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';
const REVOLVE_BUTTON = '[data-testid="sketch-revolve"]';
const AXIS_X_BUTTON = '[data-testid="revolve-axis-x"]';
const AXIS_Y_BUTTON = '[data-testid="revolve-axis-y"]';

/**
 * The revolved rectangle: workplane (0,0) → (30,25), touching the x axis
 * along its bottom edge — a full revolve about X is a cylinder, radius 25,
 * length 30.
 */
const RECT = {
  x0: 0,
  y0: 0,
  x1: 30,
  y1: 25,
} as const;

/** The analytic cylinder volume of the full revolve (mm³). */
const CYLINDER_VOLUME = Math.PI * 25 ** 2 * 30;

/** The half-turn sweep, in the parameter panel's canonical unit (rad). */
const HALF_SWEEP_RAD_TEXT = String(Math.PI);

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

/** Draws the 30×25 axis-touching rectangle with the rectangle tool. */
async function drawRectangle(page: Page): Promise<void> {
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "rectangle",
  );
  await clickCanvasPoint(page, RECT.x0, RECT.y0);
  await clickCanvasPoint(page, RECT.x1, RECT.y1);
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { kind: string }[];
  expect(entities.filter((entity) => entity.kind === "rectangle").length).toBe(
    1,
  );
}

/** Draws the straddling rectangle (−10,5) → (10,20): both sides of the y axis. */
async function drawStraddlingRectangle(page: Page): Promise<void> {
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, -10, 5);
  await clickCanvasPoint(page, 10, 20);
}

/** Runs the sketch → revolve journey and returns the settled volume text. */
async function runRectangleRevolveJourney(page: Page): Promise<string> {
  await enterSketchMode(page);
  await drawRectangle(page);
  await page.locator(REVOLVE_BUTTON).click();
  // The action exits to the model workspace and switches the scene.
  await expect(page.locator(ROOT)).toHaveAttribute("data-sketch-mode", "model");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-scene-kind",
    "revolve",
  );
  return waitForSettledScene(page, "workbench-root");
}

interface SceneSurface {
  readonly bounds: { readonly min: number[]; readonly max: number[] };
}

/** Reads the scene machine surface (bounds). */
async function readSceneSurface(page: Page): Promise<SceneSurface> {
  const root = page.locator(ROOT);
  return {
    bounds: JSON.parse(
      (await root.getAttribute("data-scene-bounds")) ??
        '{"min":[0,0,0],"max":[0,0,0]}',
    ) as SceneSurface["bounds"],
  };
}

/** One bounds component, NaN when the surface is malformed (assert later). */
function boundAt(
  scene: SceneSurface,
  corner: "min" | "max",
  axis: number,
): number {
  return scene.bounds[corner]?.[axis] ?? Number.NaN;
}

test("sketch → revolve produces the real cylinder at the analytic volume, byte-stably", async ({
  page,
}) => {
  const volume = await runRectangleRevolveJourney(page);

  // GEOMETRY SEMANTICS: settled volume within the documented band of the
  // analytic cylinder (Manifold's 63-segment revolution measured at
  // ≈0.167% deficit — well inside the band).
  const settled = Number(volume);
  expect(
    Math.abs(settled - CYLINDER_VOLUME) / CYLINDER_VOLUME,
    `volume ${settled} vs analytic ${CYLINDER_VOLUME}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);
  const scene = await readSceneSurface(page);
  // The solid spans x ∈ [0,30], radially ±25 (chord vertices keep the true
  // radius; per-axis extremes fall within the documented 0.05 mm band).
  expect(boundAt(scene, "min", 0)).toBe(0);
  expect(boundAt(scene, "max", 0)).toBe(30);
  expect(Math.abs(boundAt(scene, "min", 1) + 25)).toBeLessThan(0.05);
  expect(Math.abs(boundAt(scene, "max", 1) - 25)).toBeLessThan(0.05);
  expect(Math.abs(boundAt(scene, "min", 2) + 25)).toBeLessThan(0.05);
  expect(Math.abs(boundAt(scene, "max", 2) - 25)).toBeLessThan(0.05);

  // SCREENSHOT BASELINE: the settled scene's exact canvas bytes (a literal
  // name — the extrude spec's title-derived `sketch-baseline.png` must not
  // be clobbered by this spec's artifact).
  const shot = await page.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("revolve-baseline.png", shot);
});

test("the settled revolve scene reproduces byte-identically in a second context", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const firstContext = await browser.newContext();
  const page1 = await firstContext.newPage();
  await runRectangleRevolveJourney(page1);
  const first = await page1.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("revolve-repro-1.png", first);
  await firstContext.close();

  const secondContext = await browser.newContext();
  const page2 = await secondContext.newPage();
  await runRectangleRevolveJourney(page2);
  const second = await page2.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("revolve-repro-2.png", second);
  expect(
    second.equals(first),
    `repro sha256=${sha256(second)} vs first=${sha256(first)}`,
  ).toBe(true);
  await secondContext.close();
});

test("a partial sweep parameter edit halves the volume", async ({ page }) => {
  const volume = await runRectangleRevolveJourney(page);
  const settled = Number(volume);
  expect(Math.abs(settled - CYLINDER_VOLUME) / CYLINDER_VOLUME).toBeLessThan(
    VOLUME_REL_TOLERANCE,
  );

  // FULL / PARTIAL: the sweep parameter edits in its canonical unit (rad)
  // through the same `parameter.set` surface every dimension edit rides.
  // The settle is ANCHORED on the dispatch counter captured before the
  // Apply click (the edit and its dispatch effect land in separate
  // commits), so the wait can never accept the pre-edit settled state.
  const beforeSweep = await dispatchedCount(page, "workbench-root");
  await page
    .getByLabel("revolveSweep", { exact: true })
    .fill(HALF_SWEEP_RAD_TEXT);
  await page.getByRole("button", { name: "Apply" }).click();
  const regenerated = Number(
    await waitForSettledScene(page, "workbench-root", {
      afterDispatch: beforeSweep,
    }),
  );
  const analytic = CYLINDER_VOLUME / 2;
  expect(
    Math.abs(regenerated - analytic) / analytic,
    `partial ${regenerated} vs analytic ${analytic}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);
  // The half cylinder's radial z extent shrinks to the +z half.
  const scene = await readSceneSurface(page);
  expect(Math.abs(boundAt(scene, "min", 2) - 0)).toBeLessThan(0.05);
  expect(Math.abs(boundAt(scene, "max", 2) - 25)).toBeLessThan(0.05);
});

test("a profile crossing the axis refuses the revolve with a structured failure and no scene change", async ({
  page,
}) => {
  await enterSketchMode(page);
  await drawStraddlingRectangle(page);
  // Select the Y axis: the straddling rectangle has material on both sides.
  await page.locator(AXIS_Y_BUTTON).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-revolve-axis",
    "y",
  );
  await page.locator(REVOLVE_BUTTON).click();

  // FAILURE STATE: the structured code on the machine surface, the message
  // on the status line, and the sketch session is UNTOUCHED (no document
  // commit, no mode switch).
  const revolveSurface = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-revolve")) ?? "{}",
  ) as { status: string; code?: string };
  expect(revolveSurface.status).toBe("failed");
  expect(revolveSurface.code).toBe("kernel/profile-axis-crossing");
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-scene-kind", "plate");
  const statusText = await page
    .locator('[data-testid="sketch-status-message"]')
    .textContent();
  expect(statusText).toContain("crosses");
});

test("the axis selector switches the pinned workplane axis", async ({
  page,
}) => {
  await enterSketchMode(page);
  // The X axis is the selector's default.
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-revolve-axis",
    "x",
  );
  await page.locator(AXIS_Y_BUTTON).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-revolve-axis",
    "y",
  );
  await page.locator(AXIS_X_BUTTON).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-revolve-axis",
    "x",
  );
  // The pinned angles stay the documented constants (selector ↔ axis line).
  expect(REVOLVE_AXIS_X_RAD).toBe(0);
  expect(REVOLVE_AXIS_Y_RAD).toBe(Math.PI / 2);
});
