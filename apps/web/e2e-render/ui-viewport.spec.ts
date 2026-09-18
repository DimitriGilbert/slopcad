import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  clickFaceAnchor,
  type CaptureRect,
  type DiffBounds,
  diffElementCaptures,
  faceSelectionKey,
  faceWithNormal,
  type FaceAnchorSurface,
  locatorMaskRect,
  readFaceAnchors,
  saveArtifact,
  sha256,
  waitForSelectionFrame,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 15.1 `CadViewport` e2e — the component's browser gate, run by the
 * same deterministic harness as the scene specs (production build,
 * SwiftShader, fixed 1280×720 DPR-1 viewport; see
 * `playwright.render.config.ts`). The fixture (`/ui-viewport`) drives the
 * `@slopcad/ui` CadViewport in its PROVIDER-DRIVEN mode — no selection
 * props, no pick callbacks — so this spec proves the component's own
 * wiring end to end:
 *
 *  - the settled plate renders DETERMINISTICALLY: two consecutive runs
 *    (fresh document load each) produce byte-identical canvas pixels — the
 *    screenshot baseline;
 *  - pointer events flow through the viewport to the armed SELECT tool via
 *    the picking path: clicking a face anchor selects it (highlight
 *    rendered; a LOCALIZED pixel diff against the baseline — overlay DOM
 *    masked, surviving pixels confined to the model's screen region) and
 *    the overlay chip mirrors the provider state;
 *  - the selected-state capture is REPRODUCIBLE: select → capture → clear
 *    → re-select → capture yields byte-identical selected shots;
 *  - the overlay slot works: its Clear button applies the domain clear,
 *    and the canvas returns to the EXACT baseline bytes — the overlay
 *    interaction changed nothing it should not.
 *
 * Byte comparisons use Playwright `Buffer.equals` on canvas-ELEMENT
 * screenshots. Element captures exclude page chrome, but the fixture's
 * overlay DOM (status chips, Clear button) IS composited into those bytes,
 * so a byte comparison is valid exactly between frames with IDENTICAL
 * overlay state: every capture below parks the pointer off the overlay
 * and lets the Button's enabled/disabled opacity transition settle first.
 * Every pixel assertion stands beside a numeric/DOM assertion.
 */

/** The canvas-element selector inside the fixture's viewport box. */
const CANVAS = "#ui-viewport canvas";

/**
 * Padding (CSS px) around the face-anchor bounds that still counts as the
 * model's screen region: anchors are per-face sample points, and the
 * highlight's projected face area reaches the model's silhouette around
 * them (measured against the fixture's deterministic framing).
 */
const MODEL_REGION_PAD_PX = 96;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  /** The settled default-state canvas — the byte baseline. */
  baseline: undefined as Buffer | undefined,
};

/**
 * Capture discipline for element shots: park the pointer off the overlay
 * (the canvas corner — hover is data-only) and let the overlay's CSS
 * transitions (the Clear button's enabled/disabled opacity) run out. The
 * overlay DOM is composited into canvas-element captures, so compared
 * frames must hold identical overlay state.
 */
async function settleOverlayForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
}

/**
 * The overlay DOM's capture-pixel mask rects: the selection chip (its text
 * mirrors the selected count) and the Clear button (its disabled state
 * mirrors it) — the overlay regions whose pixels legitimately differ
 * between selection states.
 */
async function overlayMaskRects(page: Page): Promise<readonly CaptureRect[]> {
  const canvas = page.locator(CANVAS);
  const box = await canvas.boundingBox();
  expect(box, "canvas bounding box").not.toBeNull();
  if (box === null) throw new Error("unreachable: box checked above");
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const captureWidthPx = box.width * dpr;
  return [
    await locatorMaskRect(
      page.locator("#ui-viewport-selection-count"),
      box,
      captureWidthPx,
    ),
    await locatorMaskRect(
      page.locator("#ui-viewport-clear"),
      box,
      captureWidthPx,
    ),
  ];
}

/**
 * The model's screen region in capture pixels: the bounds of every
 * face-anchor point (published relative to the fixture's viewport box,
 * translated into the captured canvas frame), padded by
 * {@link MODEL_REGION_PAD_PX}.
 */
async function modelRegion(
  page: Page,
  anchors: FaceAnchorSurface,
): Promise<CaptureRect> {
  const canvasBox = await page.locator(CANVAS).boundingBox();
  expect(canvasBox, "canvas bounding box").not.toBeNull();
  if (canvasBox === null) throw new Error("unreachable: box checked above");
  const viewportBox = await page.locator("#ui-viewport").boundingBox();
  expect(viewportBox, "viewport bounding box").not.toBeNull();
  if (viewportBox === null) throw new Error("unreachable: box checked above");
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const offsetX = canvasBox.x - viewportBox.x;
  const offsetY = canvasBox.y - viewportBox.y;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const anchor of Object.values(anchors)) {
    const x = (anchor.point[0] + offsetX) * dpr;
    const y = (anchor.point[1] + offsetY) * dpr;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    x: minX - MODEL_REGION_PAD_PX,
    y: minY - MODEL_REGION_PAD_PX,
    width: maxX - minX + MODEL_REGION_PAD_PX * 2,
    height: maxY - minY + MODEL_REGION_PAD_PX * 2,
  };
}

/** True when pixel `bounds` lie wholly inside a capture-pixel `region`. */
function boundsWithin(bounds: DiffBounds, region: CaptureRect): boolean {
  return (
    bounds.minX >= region.x &&
    bounds.minY >= region.y &&
    bounds.maxX < region.x + region.width &&
    bounds.maxY < region.y + region.height
  );
}

test("the settled plate renders byte-stable across two runs", async ({
  page,
}) => {
  await page.goto("/ui-viewport");
  const volumeFirst = await waitForSettledScene(page, "ui-viewport-root");
  expect(Number(volumeFirst)).toBeGreaterThan(0);
  const shotFirst = await page.locator(CANVAS).screenshot();

  // A full second run: fresh document load, fresh worker computation —
  // same parameters, so the same settled scene must result.
  await page.reload();
  const volumeSecond = await waitForSettledScene(page, "ui-viewport-root");
  const shotSecond = await page.locator(CANVAS).screenshot();

  expect(volumeSecond).toBe(volumeFirst);
  expect(
    shotSecond.equals(shotFirst),
    `run1 sha256=${sha256(shotFirst)} vs run2 sha256=${sha256(shotSecond)}`,
  ).toBe(true);

  shared.baseline = shotFirst;
  await saveArtifact("ui-viewport-run1.png", shotFirst);
  await saveArtifact("ui-viewport-run2.png", shotSecond);
});

test("picks select through the tool path and the overlay clear restores the baseline", async ({
  page,
}) => {
  const baseline = shared.baseline;
  expect(
    baseline,
    "the determinism test must establish the baseline first",
  ).toBeDefined();
  if (baseline === undefined) {
    throw new Error("unreachable: baseline checked above");
  }

  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");

  // Click the top face (mean normal +z — no guessed pixels): the SELECT
  // tool is armed, so the pick must land as a selection through the tool
  // surface, the highlight must reach a rendered frame, and the overlay
  // chip must mirror the provider state.
  const anchors = await readFaceAnchors(page, "ui-viewport");
  const top = faceWithNormal(anchors, [0, 0, 1]);
  const revision = Number(
    await page
      .locator("#ui-viewport-root")
      .getAttribute("data-applied-revision"),
  );
  const key = faceSelectionKey(revision, top.faceIndex);
  await clickFaceAnchor(page, top.anchor, [], "ui-viewport");
  await waitForSelectionFrame(page, key, "ui-viewport-root");
  await expect(page.locator("#ui-viewport-selection-count")).toHaveText(
    "1 selected",
  );
  // Same capture discipline as the cleared shot below: the shot must not
  // catch the Clear button's disabled → enabled opacity transition
  // mid-flight, or the selected-state bytes are irreproducible.
  await settleOverlayForCapture(page);
  const selectedShot = await page.locator(CANVAS).screenshot();

  // The selection must have changed the CANVAS, not merely the overlay DOM
  // (the chip text alone would guarantee a byte diff): mask the overlay's
  // boxes, diff pixel-wise, and require surviving pixels — the amber face
  // highlight — confined to the model's screen region.
  const diff = await diffElementCaptures(
    page,
    baseline,
    selectedShot,
    await overlayMaskRects(page),
  );
  expect(
    diff.unmasked,
    "the selection highlight must change canvas pixels outside the overlay DOM",
  ).toBeGreaterThan(0);
  const highlightBounds = diff.unmaskedBounds;
  expect(highlightBounds, "unmasked pixels imply bounds").not.toBeNull();
  if (highlightBounds === null) {
    throw new Error("unreachable: bounds checked above");
  }
  const region = await modelRegion(page, anchors);
  expect(
    boundsWithin(highlightBounds, region),
    `highlight bounds ${JSON.stringify(highlightBounds)} must localize to the model region ${JSON.stringify(region)}`,
  ).toBe(true);

  // The overlay's Clear button: an overlay interaction that applies the
  // domain clear — after which the canvas is back at the exact baseline
  // bytes (both frames hold the identical overlay state: nothing selected,
  // Clear disabled and settled, pointer parked).
  await page.locator("#ui-viewport-clear").click();
  await waitForSelectionFrame(page, "", "ui-viewport-root");
  await expect(page.locator("#ui-viewport-selection-count")).toHaveText(
    "0 selected",
  );
  await settleOverlayForCapture(page);
  const clearedShot = await page.locator(CANVAS).screenshot();
  await saveArtifact("ui-viewport-selected.png", selectedShot);
  await saveArtifact("ui-viewport-cleared.png", clearedShot);
  expect(
    clearedShot.equals(baseline),
    `cleared sha256=${sha256(clearedShot)} vs baseline sha256=${sha256(baseline)}`,
  ).toBe(true);

  // The selected-state baseline must hold beyond a single capture: the
  // clear left the scene at the baseline bytes, so re-selecting through
  // the same path (same anchor, same key, same settle discipline) must
  // reproduce the EXACT selected-state bytes.
  await clickFaceAnchor(page, top.anchor, [], "ui-viewport");
  await waitForSelectionFrame(page, key, "ui-viewport-root");
  await expect(page.locator("#ui-viewport-selection-count")).toHaveText(
    "1 selected",
  );
  await settleOverlayForCapture(page);
  const reselectedShot = await page.locator(CANVAS).screenshot();
  await saveArtifact("ui-viewport-reselected.png", reselectedShot);
  expect(
    reselectedShot.equals(selectedShot),
    `reselected sha256=${sha256(reselectedShot)} vs selected sha256=${sha256(selectedShot)}`,
  ).toBe(true);
});
