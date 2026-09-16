import type { Locator, Page } from "@playwright/test";
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
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 15.3 `CadModelTree` e2e — the model tree's browser gate on the
 * same deterministic harness as the sibling CAD-component specs
 * (production build, SwiftShader, fixed 1280×720 DPR-1; see
 * `playwright.render.config.ts`). The fixture (`/ui-viewport`) mounts the
 * `@slopcad/ui` CadModelTree PROVIDER-DRIVEN beside the viewport (one
 * prop — the regeneration state map derived through the domain's
 * `regenerate`; document, selection, and picks all mirror the store), so
 * this spec proves the component's own wiring end to end:
 *
 *  - the tree renders ACTUAL document state: the fixture document's two
 *    features in insertion order with the plate body nested under its
 *    FIRST producer, valid statuses from the derived map, and DETERMINISTIC
 *    bytes — two fresh loads produce byte-identical tree pixels;
 *  - TREE → VIEWPORT: clicking the plate row applies the domain pick with
 *    the body reference — the viewport highlight reaches a rendered frame,
 *    the selected-state canvas capture is byte-reproducible, the overlay
 *    clear restores the exact baseline bytes, and the tree's own pixel
 *    change localizes to the body row's box;
 *  - VIEWPORT → TREE: clicking a face anchor selects the synthetic face
 *    reference — per the documented owning-body rule the OWNING body row
 *    highlights (localized tree diff), the feature rows do not;
 *  - FORCED FAILURE: a negative translation component (committed through
 *    `parameter.set`) fails the translate feature in the fixture's
 *    executor stand-in — the failed status and the executor's diagnostic
 *    message become visible while the rotate feature stays valid, and
 *    restoring the parameter returns the tree to byte-identical pixels;
 *  - COLLAPSE: the group twisty hides the body row and the change stays
 *    confined to the tree (the canvas keeps its exact baseline bytes);
 *    re-expanding restores the tree byte-identically.
 *
 * Byte comparisons use Playwright `Buffer.equals` on element screenshots
 * (tree and canvas elements). The 15.1/15.2 capture discipline applies:
 * the pointer is parked off the surfaces, focus is dropped, and CSS
 * transitions are given time to settle before every capture. Every pixel
 * assertion stands beside a numeric/DOM assertion.
 */

/** The tree in the fixture's provider-driven composition. */
const TREE = '#ui-tree-panel [data-slot="cad-model-tree"]';

/** The fixture root's mirrored domain surface. */
const ROOT = "#ui-viewport-root";

/** The canvas element inside the fixture's viewport box. */
const CANVAS = "#ui-viewport canvas";

/** The tree row for a reference key (e.g. `body|body_plate`). */
function treeNode(page: Page, key: string): Locator {
  return page.locator(`${TREE} [data-node-key="${key}"]`);
}

function translateRow(page: Page): Locator {
  return treeNode(page, "feature|feat_translate_plate");
}

function rotateRow(page: Page): Locator {
  return treeNode(page, "feature|feat_rotate_plate");
}

function plateRow(page: Page): Locator {
  return treeNode(page, "body|body_plate");
}

/** The plate body row AS A CHILD of the translate feature row. */
function plateUnderTranslate(page: Page): Locator {
  return page.locator(
    `${TREE} [data-node-key="feature|feat_translate_plate"] [data-node-key="body|body_plate"]`,
  );
}

/**
 * A row treeitem CONTAINS its children (ARIA ownership), so a mask must
 * target a row's visible header line (`> div:first-child`), never the
 * treeitem's whole box.
 */
function rowHeader(row: Locator): Locator {
  return row.locator("> div:first-child");
}

/** The tree's visible title bar. */
function treeTitle(page: Page): Locator {
  return page.locator(`${TREE} > div:first-child`);
}

/** The expansion twisty of a feature row. */
function rowToggle(row: Locator): Locator {
  return row.locator("[data-cad-tree-toggle]");
}

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  /** The settled boot-state tree — the byte baseline. */
  treeBaseline: undefined as Buffer | undefined,
  /** The settled boot-state canvas — the byte baseline. */
  canvasBaseline: undefined as Buffer | undefined,
};

/**
 * Capture discipline for element shots: park the pointer at the page
 * corner (off the tree, the canvas, and the overlay — no hover fills, and
 * a native `title` tooltip needs a dwell anyway), drop focus, and let the
 * CSS transitions (row hover, chevron rotation, the Clear button's
 * enabled/disabled opacity) run out.
 */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(300);
}

/**
 * The highlight-layer settle wait for TREE-originated picks. A viewport
 * pick keeps the pointer over the canvas, whose pointer events keep the
 * compositor servicing frames; a tree pick touches only DOM, so the
 * demand frame that must carry the selection stamp can sit unscheduled
 * under rAF starvation — the exact condition `waitForSettledScene`'s
 * clipped-screenshot nudge exists for. So this polls the fixture's state
 * surface on a timer (never rAF) and nudges a frame per poll until the
 * selection key AND the stamp agree, then samples two animation frames so
 * a screenshot provably lands after the highlight was drawn.
 */
async function waitForTreeSelectionFrame(
  page: Page,
  expectedKey: string,
  rootId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const matched = await page.evaluate(
      ({ id, expected }) => {
        const root = document.getElementById(id);
        return (
          root !== null &&
          root.getAttribute("data-selection-key") === expected &&
          root.getAttribute("data-cad-selection-frame") === expected
        );
      },
      { id: rootId, expected: expectedKey },
    );
    if (matched) break;
    if (Date.now() > deadline) {
      throw new Error(
        `The selection frame stamp never reached "${expectedKey}".`,
      );
    }
    await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
    await page.waitForTimeout(50);
  }
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
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

/** A locator's box as a mask/region rect in capture pixels, inflated. */
async function captureRectOf(
  page: Page,
  locator: Locator,
  captureBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
  },
  inflationPx = 2,
): Promise<CaptureRect> {
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  return locatorMaskRect(locator, captureBox, captureBox.width * dpr, inflationPx);
}

/**
 * The overlay DOM's capture-pixel mask rects (the selection chip and the
 * Clear button) — the overlay regions composited into canvas-element
 * captures whose pixels legitimately differ between selection states.
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
 * translated into the captured canvas frame), padded by 96px — the same
 * localization discipline as the 15.1 spec.
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
  const pad = 96;
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

test("the tree renders actual document state and byte-stable pixels across two runs", async ({
  page,
}) => {
  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");

  // The derivation rule against the fixture's real document: features in
  // insertion order, the plate body under its FIRST producer only (so the
  // rotate feature — whose only output is already claimed — displays as a
  // leaf), valid statuses from the derived regeneration map, raw-kind
  // label fallback.
  await expect(translateRow(page)).toHaveAttribute("data-status", "valid");
  await expect(rotateRow(page)).toHaveAttribute("data-status", "valid");
  await expect(translateRow(page)).toHaveAttribute("aria-expanded", "true");
  expect(await rotateRow(page).getAttribute("aria-expanded")).toBeNull();
  await expect(plateUnderTranslate(page)).toHaveCount(1);
  await expect(
    page.locator(
      `${TREE} [data-node-key="feature|feat_rotate_plate"] [data-node-key="body|body_plate"]`,
    ),
  ).toHaveCount(0);
  await expect(translateRow(page)).toContainText("translate");
  await expect(translateRow(page)).toContainText("Valid");
  await expect(rotateRow(page)).toContainText("Valid");
  await expect(plateRow(page)).toContainText("plate");

  await settleForCapture(page);
  const treeFirst = await page.locator(TREE).screenshot();
  const canvasFirst = await page.locator(CANVAS).screenshot();

  // A full second run: fresh document load, fresh worker computation and
  // regeneration derivation — same tree state, so the same bytes.
  await page.reload();
  await waitForSettledScene(page, "ui-viewport-root");
  await settleForCapture(page);
  const treeSecond = await page.locator(TREE).screenshot();

  expect(
    treeSecond.equals(treeFirst),
    `run1 sha256=${sha256(treeFirst)} vs run2 sha256=${sha256(treeSecond)}`,
  ).toBe(true);

  shared.treeBaseline = treeFirst;
  shared.canvasBaseline = canvasFirst;
  await saveArtifact("ui-tree-run1.png", treeFirst);
  await saveArtifact("ui-tree-run2.png", treeSecond);
  await saveArtifact("ui-tree-canvas-baseline.png", canvasFirst);
});

test("a tree click selects the body, highlights the viewport, and reproduces byte-identically", async ({
  page,
}) => {
  const treeBaseline = shared.treeBaseline;
  const canvasBaseline = shared.canvasBaseline;
  expect(
    treeBaseline,
    "the determinism test must establish the tree baseline first",
  ).toBeDefined();
  expect(
    canvasBaseline,
    "the determinism test must establish the canvas baseline first",
  ).toBeDefined();
  if (treeBaseline === undefined || canvasBaseline === undefined) {
    throw new Error("unreachable: baselines checked above");
  }

  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");

  // TREE → VIEWPORT: the plate row applies the domain pick with the body
  // reference through the store; the highlight must reach a rendered frame
  // and the canvas must change OUTSIDE the overlay DOM, localized to the
  // model's screen region.
  await plateRow(page).click();
  await waitForTreeSelectionFrame(page, "body|body_plate", "ui-viewport-root");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-selection-key",
    "body|body_plate",
  );
  await expect(plateRow(page)).toHaveAttribute("data-selected", "true");
  await settleForCapture(page);
  const selectedShot = await page.locator(CANVAS).screenshot();
  const diff = await diffElementCaptures(
    page,
    canvasBaseline,
    selectedShot,
    await overlayMaskRects(page),
  );
  expect(
    diff.unmasked,
    "the body highlight must change canvas pixels outside the overlay DOM",
  ).toBeGreaterThan(0);
  const highlightBounds = diff.unmaskedBounds;
  expect(highlightBounds, "unmasked pixels imply bounds").not.toBeNull();
  if (highlightBounds === null) {
    throw new Error("unreachable: bounds checked above");
  }
  const anchors = await readFaceAnchors(page, "ui-viewport");
  const region = await modelRegion(page, anchors);
  expect(
    boundsWithin(highlightBounds, region),
    `highlight bounds ${JSON.stringify(highlightBounds)} must localize to the model region ${JSON.stringify(region)}`,
  ).toBe(true);

  // The tree's own change localizes to the body row's box: mask the title
  // bar, the rotate row, and the translate row's header line — anything
  // unmasked must lie inside the plate row's own box.
  const treeBox = await page.locator(TREE).boundingBox();
  expect(treeBox, "tree bounding box").not.toBeNull();
  if (treeBox === null) throw new Error("unreachable: box checked above");
  const treeShot = await page.locator(TREE).screenshot();
  const treeDiff = await diffElementCaptures(page, treeBaseline, treeShot, [
    await captureRectOf(page, treeTitle(page), treeBox),
    await captureRectOf(page, rowHeader(translateRow(page)), treeBox),
    await captureRectOf(page, rotateRow(page), treeBox),
  ]);
  const plateRect = await captureRectOf(page, plateRow(page), treeBox, 3);
  expect(
    treeDiff.unmasked,
    "the selected body row must visibly highlight",
  ).toBeGreaterThan(0);
  expect(treeDiff.unmaskedBounds, "tree diff bounds imply bounds").not.toBeNull();
  if (treeDiff.unmaskedBounds === null) {
    throw new Error("unreachable: bounds checked above");
  }
  expect(
    boundsWithin(treeDiff.unmaskedBounds, plateRect),
    `tree diff bounds ${JSON.stringify(treeDiff.unmaskedBounds)} must localize to the plate row ${JSON.stringify(plateRect)}`,
  ).toBe(true);
  await saveArtifact("ui-tree-body-selected.png", treeShot);

  // The selected-state canvas capture is byte-REPRODUCIBLE: clear through
  // the overlay (canvas back at the exact baseline bytes), re-select
  // through the same tree row, and require identical selected bytes.
  await page.locator("#ui-viewport-clear").click();
  await waitForTreeSelectionFrame(page, "", "ui-viewport-root");
  await expect(plateRow(page)).toHaveAttribute("data-selected", "false");
  await settleForCapture(page);
  const clearedShot = await page.locator(CANVAS).screenshot();
  expect(
    clearedShot.equals(canvasBaseline),
    `cleared sha256=${sha256(clearedShot)} vs baseline sha256=${sha256(canvasBaseline)}`,
  ).toBe(true);
  await saveArtifact("ui-tree-canvas-cleared.png", clearedShot);

  await plateRow(page).click();
  await waitForTreeSelectionFrame(page, "body|body_plate", "ui-viewport-root");
  await settleForCapture(page);
  const reselectedShot = await page.locator(CANVAS).screenshot();
  await saveArtifact("ui-tree-canvas-reselected.png", reselectedShot);
  expect(
    reselectedShot.equals(selectedShot),
    `reselected sha256=${sha256(reselectedShot)} vs selected sha256=${sha256(selectedShot)}`,
  ).toBe(true);
});

test("a viewport face selection highlights the owning body row in the tree", async ({
  page,
}) => {
  const treeBaseline = shared.treeBaseline;
  expect(
    treeBaseline,
    "the determinism test must establish the tree baseline first",
  ).toBeDefined();
  if (treeBaseline === undefined) {
    throw new Error("unreachable: baseline checked above");
  }

  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");

  // VIEWPORT → TREE: a face pick selects the SYNTHETIC face reference;
  // per the documented owning-body rule, the OWNING body row highlights.
  const anchors = await readFaceAnchors(page, "ui-viewport");
  const top = faceWithNormal(anchors, [0, 0, 1]);
  const revision = Number(
    await page.locator(ROOT).getAttribute("data-applied-revision"),
  );
  const key = faceSelectionKey(revision, top.faceIndex);
  await clickFaceAnchor(page, top.anchor, [], "ui-viewport");
  await waitForTreeSelectionFrame(page, key, "ui-viewport-root");

  await expect(plateRow(page)).toHaveAttribute("data-selected", "true");
  await expect(translateRow(page)).toHaveAttribute("data-selected", "false");
  await expect(rotateRow(page)).toHaveAttribute("data-selected", "false");

  await settleForCapture(page);
  const treeShot = await page.locator(TREE).screenshot();
  const treeBox = await page.locator(TREE).boundingBox();
  expect(treeBox, "tree bounding box").not.toBeNull();
  if (treeBox === null) throw new Error("unreachable: box checked above");
  const treeDiff = await diffElementCaptures(page, treeBaseline, treeShot, [
    await captureRectOf(page, treeTitle(page), treeBox),
    await captureRectOf(page, rowHeader(translateRow(page)), treeBox),
    await captureRectOf(page, rotateRow(page), treeBox),
  ]);
  const plateRect = await captureRectOf(page, plateRow(page), treeBox, 3);
  expect(
    treeDiff.unmasked,
    "the owning body row must visibly highlight",
  ).toBeGreaterThan(0);
  expect(treeDiff.unmaskedBounds, "tree diff bounds imply bounds").not.toBeNull();
  if (treeDiff.unmaskedBounds === null) {
    throw new Error("unreachable: bounds checked above");
  }
  expect(
    boundsWithin(treeDiff.unmaskedBounds, plateRect),
    `tree diff bounds ${JSON.stringify(treeDiff.unmaskedBounds)} must localize to the plate row ${JSON.stringify(plateRect)}`,
  ).toBe(true);
  await saveArtifact("ui-tree-face-owner-highlight.png", treeShot);
});

test("a forced feature failure shows the failed status and its diagnostic visibly", async ({
  page,
}) => {
  const treeBaseline = shared.treeBaseline;
  expect(
    treeBaseline,
    "the determinism test must establish the tree baseline first",
  ).toBeDefined();
  if (treeBaseline === undefined) {
    throw new Error("unreachable: baseline checked above");
  }

  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");
  await expect(translateRow(page)).toHaveAttribute("data-status", "valid");
  await settleForCapture(page);
  const before = await page.locator(TREE).screenshot();
  expect(
    before.equals(treeBaseline),
    `pre-failure sha256=${sha256(before)} vs baseline sha256=${sha256(treeBaseline)}`,
  ).toBe(true);

  // The forced-failure path: translate_x = -5 mm through `parameter.set`.
  // The fixture's executor stand-in fails the translate feature with a
  // real diagnostic; the tree must show the failed STATUS and the
  // diagnostic MESSAGE (visible, described-by linked, titled).
  await page.locator("#ui-tree-force-failure").click();
  await expect(translateRow(page)).toHaveAttribute("data-status", "failed");
  await expect(translateRow(page)).toContainText("Failed");
  await expect(rotateRow(page)).toHaveAttribute("data-status", "valid");

  const describedBy = await translateRow(page).getAttribute("aria-describedby");
  expect(describedBy, "the failed row must describe its failure").not.toBeNull();
  if (describedBy === null) {
    throw new Error("unreachable: describedBy checked above");
  }
  const message = page.locator(`#${describedBy}`);
  await expect(message).toBeVisible();
  await expect(message).toContainText("negative translation component");
  await expect(
    translateRow(page).locator("[data-cad-tree-status]"),
  ).toHaveAttribute("title", /negative translation component/);

  await settleForCapture(page);
  const failedShot = await page.locator(TREE).screenshot();
  await saveArtifact("ui-tree-failed.png", failedShot);

  // Restoring the parameter re-runs the derivation through the domain:
  // the feature returns to valid and the tree returns to EXACT baseline
  // bytes — the failure left nothing behind.
  await page.locator("#ui-tree-restore").click();
  await expect(translateRow(page)).toHaveAttribute("data-status", "valid");
  await settleForCapture(page);
  const restoredShot = await page.locator(TREE).screenshot();
  await saveArtifact("ui-tree-restored.png", restoredShot);
  expect(
    restoredShot.equals(treeBaseline),
    `restored sha256=${sha256(restoredShot)} vs baseline sha256=${sha256(treeBaseline)}`,
  ).toBe(true);
});

test("collapsing a group changes only the tree; expanding restores the bytes", async ({
  page,
}) => {
  const treeBaseline = shared.treeBaseline;
  const canvasBaseline = shared.canvasBaseline;
  expect(
    treeBaseline,
    "the determinism test must establish the tree baseline first",
  ).toBeDefined();
  expect(
    canvasBaseline,
    "the determinism test must establish the canvas baseline first",
  ).toBeDefined();
  if (treeBaseline === undefined || canvasBaseline === undefined) {
    throw new Error("unreachable: baselines checked above");
  }

  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");
  await settleForCapture(page);
  const canvasBefore = await page.locator(CANVAS).screenshot();
  expect(
    canvasBefore.equals(canvasBaseline),
    `canvas sha256=${sha256(canvasBefore)} vs baseline sha256=${sha256(canvasBaseline)}`,
  ).toBe(true);

  // Collapse the translate group: the body row disappears, the twisty
  // flips, and the tree visibly shrinks (the collapsed row's height).
  const treeBoxBefore = await page.locator(TREE).boundingBox();
  expect(treeBoxBefore, "tree bounding box").not.toBeNull();
  if (treeBoxBefore === null) throw new Error("unreachable: box checked above");
  await rowToggle(translateRow(page)).click();
  await expect(translateRow(page)).toHaveAttribute("aria-expanded", "false");
  await expect(plateRow(page)).toHaveCount(0);

  await settleForCapture(page);
  const collapsedShot = await page.locator(TREE).screenshot();
  await saveArtifact("ui-tree-collapsed.png", collapsedShot);
  const treeBoxAfter = await page.locator(TREE).boundingBox();
  expect(treeBoxAfter, "collapsed tree bounding box").not.toBeNull();
  if (treeBoxAfter === null) throw new Error("unreachable: box checked above");
  expect(
    treeBoxAfter.height,
    "collapsing must visibly shrink the tree by the hidden row",
  ).toBeLessThan(treeBoxBefore.height);

  // The change is confined to the tree: the canvas kept its exact
  // baseline bytes throughout (collapse is UI state, not document state).
  const canvasAfter = await page.locator(CANVAS).screenshot();
  expect(
    canvasAfter.equals(canvasBaseline),
    `post-collapse canvas sha256=${sha256(canvasAfter)} vs baseline sha256=${sha256(canvasBaseline)}`,
  ).toBe(true);

  // Re-expanding restores the tree byte-identically.
  await rowToggle(translateRow(page)).click();
  await expect(translateRow(page)).toHaveAttribute("aria-expanded", "true");
  await expect(plateRow(page)).toHaveCount(1);
  await settleForCapture(page);
  const expandedShot = await page.locator(TREE).screenshot();
  await saveArtifact("ui-tree-expanded.png", expandedShot);
  expect(
    expandedShot.equals(treeBaseline),
    `expanded sha256=${sha256(expandedShot)} vs baseline sha256=${sha256(treeBaseline)}`,
  ).toBe(true);
});
