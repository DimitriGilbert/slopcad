import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  dispatchedCount,
  readFaceAnchors,
  waitForSettledScene,
} from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * Phase 42 hole-dialog workbench e2e — the roadmap's validation gate: the
 * workbench's STRUCTURED hole dialog (Formedible, schema-driven) creates
 * type-directed holes end-to-end — a counterbore at the analytically
 * derived volume, a parameter edit re-driving regeneration, and the
 * positions-sketch flow (point entities drawn with the new point tool →
 * one feature cutting MANY holes) — with the preview ghost's machine
 * surface asserted while the dialog is open.
 *
 * Route: `/workbench-complete-occt` — the helix-capable backend, so the
 * composition runs the real OCCT revolve/subtract (exact analytic volumes;
 * the threaded type additionally needs the helix capability, pinned in the
 * unit suites).
 */

const OCCT_ROOT = "workbench-complete-occt-root";
const SKETCH = "#sketch-root";
const SAVE_BUTTON = '[data-testid="sketch-save"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const DIALOG = '[data-testid="feature-form-dialog"]';

/**
 * Opens the hole dialog through the COMMAND MENU (Ctrl+K → query → Enter):
 * the toolbar's Hole-spec button yields below `2xl` so the row fits the
 * 1280 px viewport, and the palette is the dialog's always-reachable path —
 * the same route a keyboard-first author takes.
 */
async function openHoleDialog(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-command-menu-open",
    "true",
  );
  await page.keyboard.type("structured hole");
  await page.keyboard.press("Enter");
  await expect(page.locator(DIALOG)).toBeVisible();
}

/** The plate fixture: the rectangle (0, 0)–(30, 20) extruded +z 10 mm. */
const PLATE_VOLUME = 30 * 20 * 10;

/** The drill tip's axial extent at the dialog's default 118° (mm). */
const TIP = 8 / 2 / Math.tan(((118 / 2) * Math.PI) / 180);

/** The counterbore fixture's analytically derived removal (mm³): the Ø8
 * straight section to the 118° tip plus the Ø14 × 3 counterbore annulus. */
const CBORE_REMOVED =
  Math.PI * (8 / 2) ** 2 * (6 - TIP) +
  (Math.PI * (8 / 2) ** 2 * TIP) / 3 +
  Math.PI * ((14 / 2) ** 2 - (8 / 2) ** 2) * 3;

/** The deeper re-drive's removal (depth 6 → 8, same everything else). */
const CBORE_REMOVED_DEEP =
  Math.PI * (8 / 2) ** 2 * (8 - TIP) +
  (Math.PI * (8 / 2) ** 2 * TIP) / 3 +
  Math.PI * ((14 / 2) ** 2 - (8 / 2) ** 2) * 3;

/** The straight Ø8 × 6 hole with the 118° tip's removal (mm³). */
const STRAIGHT_REMOVED =
  Math.PI * (8 / 2) ** 2 * (6 - TIP) + (Math.PI * (8 / 2) ** 2 * TIP) / 3;

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

/** Enters sketch mode from the model workspace. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.locator('[data-testid="complete-mode-toggle"]').click();
  await expect(page.locator(SKETCH)).toBeVisible();
}

/** Extrudes the plate: rectangle (0, 0)–(30, 20), the default depth 10. */
async function extrudePlate(page: Page): Promise<void> {
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 30, 20);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForSettledScene(page, OCCT_ROOT);
}

/** The ghost layer's polyline `points` string (its projected geometry). */
async function ghostPolylinePoints(page: Page): Promise<string> {
  return (
    (await page
      .locator(
        '[data-hole-preview-ghost="glyphs"] [data-hole-preview-position] polyline',
      )
      .first()
      .getAttribute("points")) ?? ""
  );
}

/**
 * Asserts the command row FITS its frame (the Phase 42 validation round's
 * clip regression, pre-existing at base): the mode-toggle — the row's last
 * pinned control — stays fully on-viewport and the row never overflows,
 * in the extruded state whose feature-count span is the row's widest.
 */
async function assertModeToggleOnViewport(page: Page): Promise<void> {
  const fit = await page.evaluate(() => {
    const toggle = document.querySelector(
      '[data-testid="complete-mode-toggle"]',
    );
    if (toggle === null) {
      return {
        ok: false,
        right: null,
        scrollWidth: null,
        clientWidth: null,
        viewport: window.innerWidth,
      };
    }
    const row = toggle.closest("div");
    const box = toggle.getBoundingClientRect();
    return {
      ok:
        row !== null &&
        box.right <= window.innerWidth &&
        box.left >= 0 &&
        row.scrollWidth <= row.clientWidth,
      right: Math.round(box.right * 10) / 10,
      scrollWidth: row === null ? null : row.scrollWidth,
      clientWidth: row === null ? null : row.clientWidth,
      viewport: window.innerWidth,
    };
  });
  expect(
    fit.ok,
    `the command row must fit (mode-toggle right ${String(fit.right)} vs viewport ${String(fit.viewport)}, row ${String(fit.scrollWidth)}/${String(fit.clientWidth)})`,
  ).toBe(true);
}

/**
 * Asserts the ghost lands ON THE GEOMETRY at the CURRENT frame (the datum
 * overlay's live-size discipline, mirrored): the position glyph's rendered
 * footprint overlaps the solid's live-projected face-anchor span, and the
 * layer's `viewBox` is 1:1 with its own measured box — the authored
 * 800×520 fallback covers only the pre-measurement frame, so a fixed-frame
 * projection (the Phase 42 validation round's pixel-verified drift) fails
 * the pin here.
 */
async function assertGhostOnTheGeometry(page: Page): Promise<void> {
  // The live viewBox pin: 1:1 with the measured box.
  await expect
    .poll(
      async () =>
        await page
          .locator('[data-hole-preview-ghost="glyphs"]')
          .evaluate(
            (element) =>
              element.getAttribute("viewBox") ===
              `0 0 ${String(element.clientWidth)} ${String(element.clientHeight)}`,
          ),
      "the ghost's viewBox must be 1:1 with its measured live box",
    )
    .toBe(true);
  // The footprint overlap: the glyph's rendered box (screen px, post-viewBox
  // transform) against the body's own live anchor span, canvas-local.
  const anchors = await readFaceAnchors(page, OCCT_ROOT);
  const canvasBox = await page
    .locator("#workbench-complete-viewport canvas")
    .boundingBox();
  expect(canvasBox, "the viewport canvas must be laid out").not.toBeNull();
  if (canvasBox === null) return;
  const glyphBox = await page
    .locator('[data-hole-preview-ghost="glyphs"] [data-hole-preview-position]')
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  const glyph = {
    left: glyphBox.x - canvasBox.x,
    right: glyphBox.x + glyphBox.width - canvasBox.x,
    top: glyphBox.y - canvasBox.y,
    bottom: glyphBox.y + glyphBox.height - canvasBox.y,
  };
  const xs = Object.values(anchors).map((anchor) => anchor.point[0]);
  const ys = Object.values(anchors).map((anchor) => anchor.point[1]);
  const inflation = 24;
  const body = {
    left: Math.min(...xs) - inflation,
    right: Math.max(...xs) + inflation,
    top: Math.min(...ys) - inflation,
    bottom: Math.max(...ys) + inflation,
  };
  expect(glyph.right).toBeGreaterThan(body.left);
  expect(glyph.left).toBeLessThan(body.right);
  expect(glyph.bottom).toBeGreaterThan(body.top);
  expect(glyph.top).toBeLessThan(body.bottom);
}

test("hole dialog: a counterbore lands on the derived volume, ghost and all, and a parameter edit re-drives", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await extrudePlate(page);

  // Open the structured hole dialog (the command-menu path) and select
  // the counterbore type.
  await openHoleDialog(page);
  const selects = page.locator(`${DIALOG} [data-slot=select-trigger]`);
  await selects.first().click();
  await page
    .locator("[data-slot=select-item]", { hasText: "Counterbore" })
    .click();
  await expect(page.locator(DIALOG).getByLabel(/^Counterbore Ø/)).toBeVisible();

  // The parameter position: the plate's centre (15, 10).
  await page
    .locator(DIALOG)
    .getByLabel(/Position x/)
    .fill("15");
  await page
    .locator(DIALOG)
    .getByLabel(/Position y/)
    .fill("10");

  // The preview ghost: the entry footprint over the settled scene (the
  // machine surface, not pixels).
  await expect(
    page.locator('[data-hole-preview-ghost="glyphs"]'),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-hole-preview-ghost="glyphs"] [data-hole-preview-position]',
    ),
  ).toHaveCount(1);

  // THE GHOST LANDS ON THE GEOMETRY at the suite's fixed frame first: the
  // glyph's rendered footprint overlaps the body's live anchor span and
  // the layer's viewBox is 1:1 with its measured box.
  await assertGhostOnTheGeometry(page);

  // The command row fits the 1280×720 frame with the extruded state's
  // feature-count span present (the clip regression's widest row).
  await assertModeToggleOnViewport(page);

  // RESIZE mid-test to 1600×720: the canvas reflows wider and shorter, and
  // the ghost must RE-PROJECT at the live frame — the glyph's projected
  // geometry changes with the size and still lands on the body (a fixed
  // 800×520 projection drifts off the authored position at this size; the
  // datum overlay's resize regression, mirrored).
  const glyphPointsBefore = await ghostPolylinePoints(page);
  await page.setViewportSize({ width: 1600, height: 720 });
  await expect
    .poll(
      () => ghostPolylinePoints(page),
      "the ghost must re-project at the live frame",
    )
    .not.toBe(glyphPointsBefore);
  await assertGhostOnTheGeometry(page);
  await assertModeToggleOnViewport(page);

  // Create: the counterbore commits (Ø8 × 6 with a Ø14 × 3 counterbore,
  // flat tip, world Z) and the scene composes the structured cut.
  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "hole",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  expect(
    volumeNear(volume, PLATE_VOLUME - CBORE_REMOVED, 1e-4),
    `counterbored ${volume} vs derived ${String(PLATE_VOLUME - CBORE_REMOVED)}`,
  ).toBe(true);

  // PARAMETER RE-DRIVE (the canonical `parameter.set` surface): deepening
  // the hole 6 → 8 grows the removed cylinder by 2 mm of Ø8 wall.
  const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
  await page.getByLabel("holeDepth1", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Apply" }).click();
  const reDriven = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
  );
  expect(
    volumeNear(reDriven, PLATE_VOLUME - CBORE_REMOVED_DEEP, 1e-4),
    `re-driven ${reDriven} vs derived ${String(PLATE_VOLUME - CBORE_REMOVED_DEEP)}`,
  ).toBe(true);
  expect(reDriven).toBeLessThan(volume);
});

test("hole dialog: a positions sketch cuts MANY holes from one feature", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, OCCT_ROOT);
  await extrudePlate(page);

  // The positions sketch: two point entities drawn with the point tool,
  // saved as a standalone sketch (the sketch pool).
  await enterSketchMode(page);
  await page.locator('[data-sketch-tool-id="point"]').click();
  await clickCanvasPoint(page, 10, 10);
  await clickCanvasPoint(page, 20, 10);
  await page.locator(SAVE_BUTTON).click();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );

  // The hole dialog: the straight defaults (Ø8 × 6, 118° tip, world Z)
  // with the positions sketch picked over the parameter position. The
  // straight type renders four selects (type, positions, datum, axis);
  // the pool carries the extrude's OWN profile sketch too, so the pick
  // anchors exactly on the saved "sketch 1".
  await openHoleDialog(page);
  const positionsSelect = page
    .locator(`${DIALOG} [data-slot=select-trigger]`)
    .nth(1);
  await positionsSelect.click();
  await page
    .locator("[data-slot=select-item]")
    .filter({ hasText: /^sketch 1$/ })
    .click();

  // The ghost now carries TWO position glyphs (one per point entity).
  await expect(
    page.locator('[data-hole-preview-ghost="glyphs"]'),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-hole-preview-ghost="glyphs"] [data-hole-preview-position]',
    ),
  ).toHaveCount(2);

  const before = await dispatchedCount(page, OCCT_ROOT);
  await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "hole",
  );
  const volume = Number(
    await waitForSettledScene(page, OCCT_ROOT, { afterDispatch: before }),
  );
  // One feature, two holes: the derived removal is exactly twice the
  // single hole's (the positions are 10 mm apart on a Ø8 hole — no
  // interaction).
  expect(
    volumeNear(volume, PLATE_VOLUME - 2 * STRAIGHT_REMOVED, 1e-4),
    `two-position ${volume} vs derived ${String(PLATE_VOLUME - 2 * STRAIGHT_REMOVED)}`,
  ).toBe(true);
});
