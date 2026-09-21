import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * Phase 38 sweep & loft workbench e2e — the roadmap's validation gate: the
 * workbench creates a SWEPT body and a LOFTED body end-to-end, parameter
 * edits re-drive regeneration, and undo/redo round-trips the features.
 *
 * Two compositions, one engine:
 *
 *  - `/workbench-complete-occt` — the sweep-capable route: the REAL OCCT
 *    kernel executes `solid.sweep`/`solid.loft` in the worker, and the
 *    settled volumes land on the analytic values (square profile 20×20
 *    along a 40 mm spine → 16000 mm³; square ±10 → square ±5 lofted over
 *    20 mm → the Simpson-exact 1400·h/6 = 4666.667 mm³; a station edit to
 *    50 re-drives to 11666.667 mm³).
 *  - `/workbench-complete` — the default Manifold route: the SAME sweep
 *    authoring commits the feature, and the scene settles its honest
 *    decline — the structured `kernel/unsupported-operation` on the error
 *    surface, pixels unchanged. Capability honesty is user-visible.
 *
 * The authoring journey: sketch a profile, Save (a standalone sketch
 * record), sketch the path, Save, then pick both sketches in the sweep
 * form's comboboxes. Clicks derive from the documented SKETCH_CANVAS
 * transform; assertions read the machine surfaces.
 */

const OCCT_ROOT = "workbench-complete-occt-root";
const MANIFOLD_ROOT = "workbench-complete-root";
const SKETCH = "#sketch-root";
const SAVE_BUTTON = '[data-testid="sketch-save"]';
const SWEEP_BUTTON = '[data-testid="complete-sweep"]';
const LOFT_BUTTON = '[data-testid="complete-loft"]';
const DIALOG = '[data-testid="feature-form-dialog"]';

/** Relative volume tolerance (3 dp display rounding plus kernel noise). */
const VOLUME_REL_TOLERANCE = 0.0005;

/** The profile square (workplane mm): ±10. */
const PROFILE = { x0: -10, y0: -10, x1: 10, y1: 10 } as const;

/** The path spine: sketch origin straight up 40 mm (sketch +y = path +z). */
const PATH = { x0: 0, y0: 0, x1: 0, y1: 40 } as const;

/** Analytic volumes (mm³). */
const SWEEP_VOLUME = 20 * 20 * 40;
const LOFT_VOLUME_20 = (1400 * 20) / 6;
const LOFT_VOLUME_50 = (1400 * 50) / 6;

/** Saves an artifact under the workbench artifacts directory. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/workbench", { recursive: true });
  await writeFile(`e2e-artifacts/workbench/${name}`, bytes);
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

/** Draws the ±10 profile square with the rectangle tool. */
async function drawProfileSquare(page: Page): Promise<void> {
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "rectangle",
  );
  await clickCanvasPoint(page, PROFILE.x0, PROFILE.y0);
  await clickCanvasPoint(page, PROFILE.x1, PROFILE.y1);
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { kind: string }[];
  expect(entities.filter((entity) => entity.kind === "rectangle").length).toBe(
    1,
  );
}

/** Draws the straight spine with the line tool. */
async function drawPathSpine(page: Page): Promise<void> {
  await page.locator('[data-sketch-tool-id="line"]').click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "line",
  );
  await clickCanvasPoint(page, PATH.x0, PATH.y0);
  await clickCanvasPoint(page, PATH.x1, PATH.y1);
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { kind: string }[];
  expect(entities.filter((entity) => entity.kind === "line").length).toBe(1);
}

/** Enters sketch mode and saves the current drawing as a standalone record. */
async function saveSketch(page: Page): Promise<void> {
  await page.locator(SAVE_BUTTON).click();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
}

/** The route's root element id (the two routes boot different backends). */
function pageRoot(page: Page): string {
  return page.url().includes("occt") ? `#${OCCT_ROOT}` : `#${MANIFOLD_ROOT}`;
}

/** Enters sketch mode from the model workspace. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.locator('[data-testid="complete-mode-toggle"]').click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
}

/** Opens the sweep dialog and picks the profile and path by sketch name. */
async function runSweepDialog(
  page: Page,
  profileName: string,
  pathName: string,
): Promise<void> {
  await page.locator(SWEEP_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  const comboboxes = page.locator(`${DIALOG} [role="combobox"]`);
  await comboboxes.nth(0).click();
  await page.getByRole("option", { name: profileName }).click();
  await comboboxes.nth(1).click();
  await page.getByRole("option", { name: pathName }).click();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
}

/** Volume proximity inside the documented band. */
function volumeNear(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= expected * VOLUME_REL_TOLERANCE;
}

test("sweep: two saved sketches sweep into the analytic tube on OCCT", async ({
  page,
}) => {
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);

  // Sketch 1: the profile.
  await enterSketchMode(page);
  await drawProfileSquare(page);
  await saveSketch(page);

  // Sketch 2: the path spine.
  await enterSketchMode(page);
  await drawPathSpine(page);
  await saveSketch(page);

  // The sweep form picks the pair; the scene switches to the swept tube.
  const beforeSweep = await dispatchedCount(page, OCCT_ROOT);
  await runSweepDialog(page, "sketch 1", "sketch 2");
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "sweep",
  );
  const volume = await waitForSettledScene(page, OCCT_ROOT, {
    afterDispatch: beforeSweep,
  });
  expect(
    volumeNear(Number(volume), SWEEP_VOLUME),
    `swept ${volume} vs analytic ${String(SWEEP_VOLUME)}`,
  ).toBe(true);

  await page.mouse.move(4, 4);
  await saveArtifact("workbench-sweep-occt.png", await page.screenshot());

  // UNDO removes the sweep feature; the scene falls back honestly to the
  // plate. REDO restores the feature into the document (the timeline
  // carries it again) — the scene stays the fallback by contract: a
  // re-deepening never rides the fallback effect, only an authoring
  // action.
  await page.locator('button[aria-label="Undo"]').click();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "plate",
  );
  const undone = JSON.parse(
    (await page
      .locator(pageRoot(page))
      .getAttribute("data-feature-timeline")) ?? "{}",
  ) as { entries: { kind: string }[] };
  expect(undone.entries.map((entry) => entry.kind)).not.toContain("sweep");
  await page.locator('button[aria-label="Redo"]').click();
  const redone = JSON.parse(
    (await page
      .locator(pageRoot(page))
      .getAttribute("data-feature-timeline")) ?? "{}",
  ) as { entries: { kind: string; status: string }[] };
  expect(redone.entries.map((entry) => entry.kind)).toContain("sweep");
  expect(redone.entries.find((entry) => entry.kind === "sweep")?.status).toBe(
    "valid",
  );
});

test("loft: ordered sections loft to the Simpson volume and a station edit re-drives", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);

  // Two saved section sketches: ±10 and ±5 squares.
  await enterSketchMode(page);
  await drawProfileSquare(page);
  await saveSketch(page);
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, -5, -5);
  await clickCanvasPoint(page, 5, 5);
  await saveSketch(page);

  // The loft form pre-seeds the two oldest sketches at stations 0 / 20;
  // Create commits the feature.
  const beforeLoft = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(LOFT_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "loft",
  );
  const volume = await waitForSettledScene(page, OCCT_ROOT, {
    afterDispatch: beforeLoft,
  });
  expect(
    volumeNear(Number(volume), LOFT_VOLUME_20),
    `lofted ${volume} vs analytic ${String(LOFT_VOLUME_20)}`,
  ).toBe(true);

  // PARAMETER RE-DRIVE: the station parameter edits through the parameter
  // panel (the canonical `parameter.set` surface) and the loft re-executes.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("loftZ_1", { exact: true }).fill("50");
  await page.getByRole("button", { name: "Apply" }).click();
  const redriven = await waitForSettledScene(page, OCCT_ROOT, {
    afterDispatch: beforeEdit,
  });
  expect(
    volumeNear(Number(redriven), LOFT_VOLUME_50),
    `re-driven ${redriven} vs analytic ${String(LOFT_VOLUME_50)}`,
  ).toBe(true);

  await page.mouse.move(4, 4);
  await saveArtifact("workbench-loft-occt.png", await page.screenshot());
});

test("sweep on the default Manifold workbench commits and declines honestly", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await waitForSettledScene(page, MANIFOLD_ROOT);
  const plateVolume = await waitForSettledScene(page, MANIFOLD_ROOT);

  // The same authoring journey: profile, save; path, save; sweep form.
  await enterSketchMode(page);
  await drawProfileSquare(page);
  await saveSketch(page);
  await enterSketchMode(page);
  await drawPathSpine(page);
  await saveSketch(page);
  await runSweepDialog(page, "sketch 1", "sketch 2");
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "sweep",
  );

  // The structured decline lands on the error surface; the pixels stay the
  // last honest scene (no fabricated swept body from a kernel that cannot
  // build one).
  await expect(page.locator("#workbench-complete-error")).toContainText(
    "kernel/unsupported-operation",
    { timeout: 30_000 },
  );
  const stalled = await page
    .locator(pageRoot(page))
    .getAttribute("data-cad-rendered-volume");
  expect(stalled).toBe(plateVolume);

  // The timeline chip follows the same verdict: the sweep feature reads
  // Failed with the refusal's own text as its diagnostic — never a Valid
  // chip beside the error surface that carries the decline.
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await page
            .locator(pageRoot(page))
            .getAttribute("data-feature-timeline")) ?? "{}",
        ) as {
          entries: {
            kind: string;
            status: string;
            diagnostics?: { message: string }[];
          }[];
        },
    )
    .toEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({
            kind: "sweep",
            status: "failed",
            diagnostics: expect.arrayContaining([
              expect.objectContaining({
                message: expect.stringContaining(
                  "kernel/unsupported-operation",
                ),
              }),
            ]),
          }),
        ]),
      }),
    );
});
