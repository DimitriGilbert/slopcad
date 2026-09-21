import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * Phase 40 helix & thread workbench e2e — the roadmap's validation gate:
 * the workbench creates a HELICAL body (a meridian sketch swept along an
 * analytic spine) and a THREADED body (an ISO M6 cut on an extruded rod)
 * end-to-end, the settled volumes land on the analytically derived values,
 * a parameter edit re-drives regeneration, and undo/redo round-trips the
 * features.
 *
 * One route, the sweep spec's discipline:
 *
 *  - `/workbench-complete-occt` — the helix-capable route: the REAL OCCT
 *    kernel executes `solid.helixSweep` (and the thread composition:
 *    helixSweep + subtract) in the worker. The analytic anchors (derived
 *    in `helix-geometry.ts` and pinned in the OCCT unit suite):
 *
 *    - Helix: the meridian rectangle A = 3 mm² at centroid radius 11,
 *      3 turns → the exact screw volume 2π·3·3·11 = 198π mm³; OCCT's
 *      ruled meridian stations land at the DERIVED chord band
 *      sin(Δθ)/Δθ ≈ 0.998334 of it (the span Jacobian (R+u)·sinΔθ against
 *      the true (R+u)·Δθ — the same 63-chord class the mesh revolves
 *      document) → ≈ 620.998 mm³.
 *    - Thread: the ⌀6 × 10 rod (282.743 mm³, the sketch extrude's
 *      default depth) minus the M6×1 × 6 groove cut. The tool's exact
 *      screw volume is 2π·6·(45√3/256)·d̄ with the
 *      trapezoid centroid d̄ ≈ 2.7795 (≈ 31.87 mm³); the cut loses the
 *      tool minus the two end slivers (at most (7/8)/turns of the tool,
 *      the per-z material density argument) and the ruled band — the
 *      settled volume sits inside the derived containment band
 *      [rod − tool, rod − 0.83·tool].
 *
 *  - `/workbench-complete` — the default Manifold route: the SAME helix
 *    authoring commits the feature, and the scene settles its honest
 *    decline — the structured `kernel/unsupported-operation` on the error
 *    surface, pixels unchanged. Capability honesty is user-visible.
 */

const OCCT_ROOT = "workbench-complete-occt-root";
const MANIFOLD_ROOT = "workbench-complete-root";
const SKETCH = "#sketch-root";
const SAVE_BUTTON = '[data-testid="sketch-save"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const HELIX_BUTTON = '[data-testid="complete-helix"]';
const THREAD_BUTTON = '[data-testid="complete-thread"]';
const DIALOG = '[data-testid="feature-form-dialog"]';

/** The OCCT ruled-station band factor at the shared 0.1 rad station rule. */
const RULED_BAND = Math.sin(0.1) / 0.1;

/** The helix fixture's analytically derived values (see the module doc). */
const HELIX_EXACT = 2 * Math.PI * 3 * 3 * 11;
const HELIX_OCCT = HELIX_EXACT * RULED_BAND;

/** The thread fixture's derived containment band (see the module doc).
 * The rod is the sketch-extrude default depth of 10 mm (the journey
 * draws the ⌀6 circle and presses the sketch extrude button — its
 * committed depth parameter is the default 10), so the M6×1 × 6 thread
 * cuts the top 6 mm of a ⌀6 × 10 rod. */
const ROD_VOLUME = Math.PI * 9 * 10;
// The groove trapezoid's centroid radius from the axis: R₀ minus the
// centroid offset INTO the groove — the trapezoid centroid rule
// (depth/3)·(2·w_in + w_out)/(w_in + w_out) with the ISO depth of
// engagement 5√3/16·P, w_out = 7P/8, w_in = P/4 at P = 1 — exactly
// (11/27)·5√3/16 ≈ 0.220516 mm, so d̄ = 3 − 0.220516.
const ISO_THREAD_DEPTH_MM = (5 * Math.sqrt(3)) / 16;
const GROOVE_WIDTH_OUTER = 7 / 8;
const GROOVE_WIDTH_INNER = 1 / 4;
const GROOVE_CENTROID_OFFSET_MM =
  (ISO_THREAD_DEPTH_MM / 3) *
  ((2 * GROOVE_WIDTH_INNER + GROOVE_WIDTH_OUTER) /
    (GROOVE_WIDTH_INNER + GROOVE_WIDTH_OUTER));
const THREAD_TOOL_VOLUME =
  2 *
  Math.PI *
  6 *
  ((45 * Math.sqrt(3)) / 256) *
  (3 - GROOVE_CENTROID_OFFSET_MM);

/** Volume proximity inside a derived relative band. */
function volumeNear(value: number, expected: number, band: number): boolean {
  return Math.abs(value - expected) <= expected * band;
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

test("helix: a saved meridian sketch sweeps to the derived screw volume", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);

  // Sketch 1: the meridian rectangle — sketch (x, y) are the helix's
  // (radial, axial) offsets from the spine's start point.
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, 0, -0.75);
  await clickCanvasPoint(page, 2, 0.75);
  await saveSketch(page);

  // The helix form's defaults (radius 10, pitch 4, 3 turns, right-handed,
  // world Z) already match the fixture: Create commits the feature.
  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(HELIX_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "helix",
  );
  const volume = await waitForSettledScene(page, OCCT_ROOT, {
    afterDispatch: before,
  });
  expect(
    volumeNear(Number(volume), HELIX_OCCT, 2e-3),
    `helical ${volume} vs derived ${String(HELIX_OCCT)}`,
  ).toBe(true);

  // UNDO removes the helix feature; the scene falls back honestly. REDO
  // restores the feature into the document (the timeline carries it
  // again, valid).
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
  expect(undone.entries.map((entry) => entry.kind)).not.toContain("helix");
  await page.locator('button[aria-label="Redo"]').click();
  const redone = JSON.parse(
    (await page
      .locator(pageRoot(page))
      .getAttribute("data-feature-timeline")) ?? "{}",
  ) as { entries: { kind: string; status: string }[] };
  expect(redone.entries.map((entry) => entry.kind)).toContain("helix");
  expect(redone.entries.find((entry) => entry.kind === "helix")?.status).toBe(
    "valid",
  );
});

test("thread: an extruded M6 rod threads inside the derived containment band", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);

  // The rod: a ⌀6 circle (radius 3 at the origin) extruded 10 mm — the
  // sketch extrude button's default depth (EXTRUDE_DEFAULT_DEPTH_MM = 10),
  // the M6 major cylinder, the shop convention.
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

  // The thread form defaults to the M6×1 external thread, 6 mm long, on
  // the world Z axis: Create commits the feature and the scene composes
  // the helixSweep'd ISO tool's subtract.
  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(THREAD_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "thread",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  // The derived containment band: the cut removes at most the full tool
  // volume (the tool sits strictly inside the major cylinder) and at
  // least the tool minus the end slivers and the ruled band.
  expect(
    volume,
    `threaded ${volume} vs band [${String(ROD_VOLUME - THREAD_TOOL_VOLUME)}, ${String(
      ROD_VOLUME - THREAD_TOOL_VOLUME * 0.83,
    )}]`,
  ).toBeGreaterThanOrEqual(ROD_VOLUME - THREAD_TOOL_VOLUME);
  expect(volume).toBeLessThanOrEqual(ROD_VOLUME - THREAD_TOOL_VOLUME * 0.83);
  expect(volume).toBeGreaterThan(0);

  // PARAMETER RE-DRIVE: the thread lengthens 6 → 8 through the parameter
  // panel (the canonical `parameter.set` surface) — two more M6 turns of
  // groove, measurably less material.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("threadLength1", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Apply" }).click();
  const redriven = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(redriven).toBeLessThan(volume);
  // Two more turns of groove remove at most a third again of the tool's
  // per-turn material (the re-drive band: the 8 mm thread's cut is
  // bounded above by the full tool at 8 turns ≈ 4/3 of the 6-turn tool).
  expect(redriven).toBeGreaterThan(
    ROD_VOLUME - (THREAD_TOOL_VOLUME * 4) / 3 - THREAD_TOOL_VOLUME * 0.2,
  );

  // UNDO/redo round-trips the thread feature: the first undo reverts
  // the parameter edit above, the second the thread's own transaction.
  await page.locator('button[aria-label="Undo"]').click();
  await page.locator('button[aria-label="Undo"]').click();
  const undone = JSON.parse(
    (await page
      .locator(pageRoot(page))
      .getAttribute("data-feature-timeline")) ?? "{}",
  ) as { entries: { kind: string }[] };
  expect(undone.entries.map((entry) => entry.kind)).not.toContain("thread");
  await page.locator('button[aria-label="Redo"]').click();
  const redone = JSON.parse(
    (await page
      .locator(pageRoot(page))
      .getAttribute("data-feature-timeline")) ?? "{}",
  ) as { entries: { kind: string; status: string }[] };
  expect(redone.entries.map((entry) => entry.kind)).toContain("thread");
});

test("helix on the default Manifold workbench commits and declines honestly", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await waitForSettledScene(page, MANIFOLD_ROOT);
  const plateVolume = await waitForSettledScene(page, MANIFOLD_ROOT);

  // The same authoring journey: meridian sketch, save, helix form with
  // its defaults.
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, 0, -0.75);
  await clickCanvasPoint(page, 2, 0.75);
  await saveSketch(page);
  await page.locator(HELIX_BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(pageRoot(page))).toHaveAttribute(
    "data-scene-kind",
    "helix",
  );

  // The structured decline lands on the error surface; the pixels stay
  // the last honest scene (no fabricated helical body from a kernel that
  // cannot build one).
  await expect(page.locator("#workbench-complete-error")).toContainText(
    "kernel/unsupported-operation",
    { timeout: 30_000 },
  );
  const stalled = await page
    .locator(pageRoot(page))
    .getAttribute("data-cad-rendered-volume");
  expect(stalled).toBe(plateVolume);

  // The timeline chip follows the same verdict: the helix feature reads
  // Failed with the refusal's own text as its diagnostic.
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
            kind: "helix",
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
