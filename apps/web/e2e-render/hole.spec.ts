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
  HOLE_DEFAULT_DEPTH_MM,
  HOLE_DEFAULT_DIAMETER_MM,
} from "../src/cad-workbench/hole";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";

/**
 * Phase 26.10 hole e2e — the browser workflow on the deterministic render
 * harness (production build, SwiftShader, fixed 1280×720 DPR 1, one worker,
 * config-level video captures the journey). The plan's validation —
 * "parameter edits regenerate geometry" — is pinned for EVERY hole
 * parameter:
 *
 *  - GEOMETRY SEMANTICS — sketch a rectangle → Extrude → Hole: the REAL
 *    Manifold kernel composes the base pad, the planned Ø8×4 tool, and the
 *    subtract in the worker; the settled volume sits within the documented
 *    tolerance of the analytic `pad − π·r²·depth`;
 *  - DIAMETER REGENERATION — a diameter edit re-dispatches and settles at
 *    the new analytic volume;
 *  - DEPTH REGENERATION — a depth edit reaching the pad thickness drills
 *    THROUGH (the bridge's documented through/blind semantic);
 *  - POSITION REGENERATION — a position edit sliding the hole out over the
 *    side face changes the removed volume by the exact circular segment;
 *  - NO-OP GUARD — a hole moved off the body settles with the structured
 *    "removed no material" refusal on the error surface, the previous
 *    scene untouched (the silent-subtract trap, refused);
 *  - SCREENSHOT BASELINE — the settled hole scene is byte-stable across
 *    two independent browser journeys.
 *
 * Machine surfaces: `data-scene-kind`, `data-scene-bounds`, `data-error`,
 * `data-in-flight`, and the shared settle surface (`data-volume`,
 * `data-cad-rendered-volume`). Click derivation follows the house rule:
 * every canvas click comes from the documented `SKETCH_CANVAS` transform.
 */

const ROOT = "#workbench-root";
const SKETCH = "#sketch-root";
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const HOLE_BUTTON = '[data-testid="workbench-hole"]';

/** The sketched rectangle: workplane (10,10) → (30,25) = 20 × 15 mm. */
const RECT = {
  x0: 10,
  y0: 10,
  x1: 30,
  y1: 25,
} as const;

/** The pad's analytic volume and thickness (the extrude depth). */
const PAD_VOLUME =
  (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;
const PAD_THICKNESS = EXTRUDE_DEFAULT_DEPTH_MM;

/** Relative volume tolerance (the render suite's documented Manifold band). */
const VOLUME_REL_TOLERANCE = 0.005;

/** The analytic blind-hole volume: pad − π·r²·depth. */
function blindVolume(diameterMm: number, depthMm: number): number {
  return PAD_VOLUME - Math.PI * (diameterMm / 2) ** 2 * depthMm;
}

/** The analytic through-hole volume: pad − π·r²·thickness. */
function throughVolume(diameterMm: number): number {
  return PAD_VOLUME - Math.PI * (diameterMm / 2) ** 2 * PAD_THICKNESS;
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
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

/** Fills one hole parameter through the panel and applies it, returning the
 *  dispatch count captured BEFORE the Apply click (the settle anchor: the
 *  panel's submit pipeline and the scene's dispatch effect land in separate
 *  commits, so the caller's settle wait must be anchored on this baseline).
 *  The first hole's parameters carry their index too (the plate fixture
 *  document owns the unsuffixed `holeDiameter` name), so `holeDiameter1`
 *  etc. */
async function editHoleParameter(
  page: Page,
  name: string,
  value: string,
): Promise<number> {
  const afterDispatch = await dispatchedCount(page, "workbench-root");
  await page.getByLabel(`${name}1`, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Apply" }).click();
  return afterDispatch;
}

/**
 * Runs the sketch → extrude → hole journey and returns the settled holed
 * volume text. The pad is settled BEFORE the hole is cut — the action
 * centers its default on the rendered top face, so the pad scene must be
 * the applied one.
 */
async function runHoleJourney(page: Page): Promise<string> {
  await page.goto("/workbench");
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-sketch-mode", "model");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForSettledScene(page, "workbench-root");

  await page.locator(HOLE_BUTTON).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-scene-kind", "hole");
  return waitForSettledScene(page, "workbench-root");
}

interface SceneBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Reads the settled scene's bounds from the machine surface. */
async function readSceneBounds(page: Page): Promise<SceneBounds> {
  const raw = await page
    .locator(ROOT)
    .getAttribute("data-scene-bounds")
    .then((value) => value ?? "{}");
  const parsed = JSON.parse(raw) as Partial<SceneBounds>;
  expect(parsed.min, "scene bounds min").toBeDefined();
  expect(parsed.max, "scene bounds max").toBeDefined();
  return parsed as SceneBounds;
}

test("sketch → extrude → hole settles at the analytic pad-minus-cylinder volume", async ({
  page,
}) => {
  const volume = await runHoleJourney(page);

  // GEOMETRY SEMANTICS: the settled volume within the documented band of
  // the analytic pad − π·r²·depth (the defaults: Ø8, blind 4 mm).
  const analytic = blindVolume(HOLE_DEFAULT_DIAMETER_MM, HOLE_DEFAULT_DEPTH_MM);
  const settled = Number(volume);
  expect(
    Math.abs(settled - analytic) / analytic,
    `volume ${settled} vs analytic ${analytic}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);

  // A hole removes interior material: the pad's bounds survive.
  const bounds = await readSceneBounds(page);
  expect(bounds.min[2]).toBe(0);
  expect(bounds.max[2]).toBe(PAD_THICKNESS);

  // SCREENSHOT BASELINE: the settled holed scene's canvas bytes (the
  // repro test proves the bytes stable across independent contexts).
  const shot = await page.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("hole-baseline.png", shot);
});

test("the settled hole scene reproduces byte-identically in a second context", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const firstContext = await browser.newContext();
  const page1 = await firstContext.newPage();
  await runHoleJourney(page1);
  const first = await page1.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("hole-repro-1.png", first);
  await firstContext.close();

  const secondContext = await browser.newContext();
  const page2 = await secondContext.newPage();
  await runHoleJourney(page2);
  const second = await page2.locator("#workbench-viewport canvas").screenshot();
  await saveArtifact("hole-repro-2.png", second);
  expect(
    second.equals(first),
    `repro sha256=${sha256(second)} vs first=${sha256(first)}`,
  ).toBe(true);
  await secondContext.close();
});

test("a diameter edit regenerates the hole at the new analytic volume", async ({
  page,
}) => {
  await runHoleJourney(page);

  const afterDispatch = await editHoleParameter(page, "holeDiameter", "12");
  const regenerated = Number(
    await waitForSettledScene(page, "workbench-root", { afterDispatch }),
  );
  const analytic = blindVolume(12, HOLE_DEFAULT_DEPTH_MM);
  expect(
    Math.abs(regenerated - analytic) / analytic,
    `regenerated ${regenerated} vs analytic ${analytic}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);
});

test("a depth edit reaching the thickness drills through", async ({ page }) => {
  await runHoleJourney(page);

  // Depth 12 ≥ the pad's 10 mm thickness: the documented through semantic.
  const afterDispatch = await editHoleParameter(page, "holeDepth", "12");
  const regenerated = Number(
    await waitForSettledScene(page, "workbench-root", { afterDispatch }),
  );
  const analytic = throughVolume(HOLE_DEFAULT_DIAMETER_MM);
  expect(
    Math.abs(regenerated - analytic) / analytic,
    `regenerated ${regenerated} vs analytic ${analytic}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);
});

test("a position edit slides the hole out over the side face", async ({
  page,
}) => {
  await runHoleJourney(page);
  const bounds = await readSceneBounds(page);

  // Center 2 mm inside the +x face (r = 4, so the circle pokes 2 mm past
  // it): the removed area is the full disk MINUS the circular segment
  // beyond the face — r²·acos(d/r) − d·√(r²−d²).
  const afterDispatch = await editHoleParameter(
    page,
    "holeX",
    String(bounds.max[0] - 2),
  );
  const regenerated = Number(
    await waitForSettledScene(page, "workbench-root", { afterDispatch }),
  );
  const radius = HOLE_DEFAULT_DIAMETER_MM / 2;
  const inFace = 2;
  const segmentArea =
    radius * radius * Math.acos(inFace / radius) -
    inFace * Math.sqrt(radius * radius - inFace * inFace);
  const analytic =
    PAD_VOLUME -
    (Math.PI * radius * radius - segmentArea) * HOLE_DEFAULT_DEPTH_MM;
  expect(
    Math.abs(regenerated - analytic) / analytic,
    `regenerated ${regenerated} vs analytic ${analytic}`,
  ).toBeLessThan(VOLUME_REL_TOLERANCE);
});

test("a hole moved off the body fails structured instead of silently no-oping", async ({
  page,
}) => {
  const volume = await runHoleJourney(page);
  const settled = Number(volume);

  // NO-OP GUARD: holeX far past the +x face — the tool is disjoint, the
  // subtract would return the pad UNCHANGED, and the post-condition
  // refuses it on the error surface.
  await editHoleParameter(page, "holeX", "100");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-error",
    /removed no material/,
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-in-flight", "0");
  const afterFailureText = await page
    .locator(ROOT)
    .getAttribute("data-volume")
    .then((value) => value ?? "");
  expect(Number(afterFailureText)).toBe(settled);
});
