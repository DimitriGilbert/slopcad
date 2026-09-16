import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  diffElementCaptures,
  locatorMaskRect,
  type CaptureRect,
  type DiffBounds,
  saveArtifact,
  sha256,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 15.2 `CadToolbar` e2e — the toolbar's browser gate on the same
 * deterministic harness as the scene specs (production build, SwiftShader,
 * fixed 1280×720 DPR-1). The fixture (`/ui-viewport`) mounts the
 * `@slopcad/ui` CadToolbar PROVIDER-DRIVEN above the viewport (no props:
 * it mirrors the four registered tools and arms through the store's arm
 * operation), so this spec proves the component's own behavior end to end:
 *
 *  - the strip renders DETERMINISTICALLY: two fresh loads produce
 *    byte-identical toolbar pixels, with exactly the booted SELECT tool
 *    pressed (aria-pressed, and visually distinct via the pressed variant);
 *  - CLICK activation switches the live tool through the store: the
 *    fixture's mirrored tool surface (`data-tool-id`/`data-tool-phase`)
 *    follows, the pressed state moves, and a LOCALIZED pixel diff proves
 *    the visual change is confined to the switched buttons — the newly
 *    active button gains visible pressed pixels, the old one loses them;
 *  - switching back restores the EXACT baseline bytes;
 *  - KEYBOARD activation (the documented digit keys, pressed while focus
 *    sits anywhere inside the toolbar) drives the same tool surface and
 *    lands in the byte-identical visual state as the click on the same
 *    tool — one activation path, two input modes.
 *
 * Byte comparisons use Playwright `Buffer.equals` on toolbar-ELEMENT
 * screenshots. The 15.1 capture discipline applies: the pointer is parked
 * off the strip, focus is dropped, and the Button `transition-all` variant
 * swap is given time to settle before every capture — compared frames must
 * hold identical transient state. Every pixel assertion stands beside a
 * numeric/DOM assertion.
 */

/** The toolbar strip in the fixture's provider-driven composition. */
const TOOLBAR = '#ui-viewport-panel [data-slot="cad-toolbar"]';

/** The fixture root's mirrored tool surface. */
const ROOT = "#ui-viewport-root";

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  /** The settled boot-state toolbar — the byte baseline. */
  baseline: undefined as Buffer | undefined,
};

function toolButton(page: Page, toolId: string): Locator {
  return page.locator(`${TOOLBAR} [data-tool-id="${toolId}"]`);
}

/**
 * Capture discipline for toolbar element shots: park the pointer off the
 * strip (no hover fill, and a native `title` tooltip needs a dwell anyway)
 * and let the Button's `transition-all` (variant swap, hover) run out.
 */
async function settleToolbarForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
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

/** A toolbar child's box as a mask rect in toolbar-capture pixels. */
async function toolbarMaskRect(
  page: Page,
  locator: Locator,
  toolbarBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
  },
): Promise<CaptureRect> {
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  return locatorMaskRect(locator, toolbarBox, toolbarBox.width * dpr);
}

test("the toolbar renders byte-stable across two runs with the booted tool pressed", async ({
  page,
}) => {
  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");
  const toolbar = page.locator(TOOLBAR);

  // Boot state: the fixture arms SELECT, so exactly that button is pressed.
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-id", "select");
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-phase", "active");
  await expect(toolButton(page, "select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const toolId of ["measure", "translate", "rotate"]) {
    await expect(toolButton(page, toolId)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  }
  // The pressed button must be VISIBLY distinct, not just semantically:
  // the pressed variant paints the primary fill the outline variant lacks.
  const pressedClasses = await toolButton(page, "select").getAttribute("class");
  expect(pressedClasses, "pressed button classes").toContain("bg-primary");
  const idleClasses = await toolButton(page, "measure").getAttribute("class");
  expect(idleClasses, "idle button classes").toContain("bg-background");

  await settleToolbarForCapture(page);
  const first = await toolbar.screenshot();

  // A full second run: fresh document load — same strip state, so the
  // same bytes must result.
  await page.reload();
  await waitForSettledScene(page, "ui-viewport-root");
  await settleToolbarForCapture(page);
  const second = await toolbar.screenshot();

  expect(
    second.equals(first),
    `run1 sha256=${sha256(first)} vs run2 sha256=${sha256(second)}`,
  ).toBe(true);

  shared.baseline = first;
  await saveArtifact("ui-toolbar-run1.png", first);
  await saveArtifact("ui-toolbar-run2.png", second);
});

test("click activation presses the tool and the change localizes to the switched buttons", async ({
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

  await toolButton(page, "measure").click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-id", "measure");
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-phase", "active");
  await expect(toolButton(page, "measure")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(toolButton(page, "select")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await settleToolbarForCapture(page);
  const activeShot = await page.locator(TOOLBAR).screenshot();
  await saveArtifact("ui-toolbar-measure-active.png", activeShot);

  // Localized-diff proof: mask every button EXCEPT the newly active one.
  // The masked region must still differ (the old tool visibly unpressed),
  // the unmasked differences must be nonzero, and they must lie inside
  // the activated button's box — the strip changed exactly where it
  // claims to have changed.
  const toolbarBox = await page.locator(TOOLBAR).boundingBox();
  expect(toolbarBox, "toolbar bounding box").not.toBeNull();
  if (toolbarBox === null) throw new Error("unreachable: box checked above");
  const measureRect = await toolbarMaskRect(
    page,
    toolButton(page, "measure"),
    toolbarBox,
  );
  const unchangedRects: CaptureRect[] = [];
  for (const toolId of ["select", "translate", "rotate"]) {
    unchangedRects.push(
      await toolbarMaskRect(page, toolButton(page, toolId), toolbarBox),
    );
  }
  const diff = await diffElementCaptures(page, baseline, activeShot, [
    ...unchangedRects,
  ]);
  expect(
    diff.masked,
    "the previously pressed button must visibly unpress",
  ).toBeGreaterThan(0);
  expect(
    diff.unmasked,
    "the activated button must visibly press",
  ).toBeGreaterThan(0);
  const activeBounds = diff.unmaskedBounds;
  expect(activeBounds, "unmasked pixels imply bounds").not.toBeNull();
  if (activeBounds === null) {
    throw new Error("unreachable: bounds checked above");
  }
  expect(
    boundsWithin(activeBounds, measureRect),
    `activated-button diff bounds ${JSON.stringify(activeBounds)} must localize to the measure button ${JSON.stringify(measureRect)}`,
  ).toBe(true);

  // Switching back restores the EXACT baseline bytes: the strip is a pure
  // mirror of the tool surface, nothing leaks.
  await toolButton(page, "select").click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-id", "select");
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-phase", "active");
  await settleToolbarForCapture(page);
  const restoredShot = await page.locator(TOOLBAR).screenshot();
  await saveArtifact("ui-toolbar-restored.png", restoredShot);
  expect(
    restoredShot.equals(baseline),
    `restored sha256=${sha256(restoredShot)} vs baseline sha256=${sha256(baseline)}`,
  ).toBe(true);
});

test("keyboard digit activation drives the same surface and bytes as the click", async ({
  page,
}) => {
  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");

  // Focus sits on a DIFFERENT button; "4" is the fourth registry entry
  // (rotate). The digit handler lives on the toolbar container, so the
  // key activates through the toolbar from any focus inside it.
  await toolButton(page, "select").focus();
  await page.keyboard.press("4");
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-id", "rotate");
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-phase", "active");
  await expect(toolButton(page, "rotate")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(toolButton(page, "select")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // The keyboard focus ring is transient test state, not strip state:
  // drop focus, then settle for the byte comparison.
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await settleToolbarForCapture(page);
  const keyboardShot = await page.locator(TOOLBAR).screenshot();
  await saveArtifact("ui-toolbar-rotate-keyboard.png", keyboardShot);

  // The click on the same tool must land in the IDENTICAL visual state —
  // keyboard and click are one activation path, so the resulting strip
  // bytes cannot differ.
  await toolButton(page, "rotate").click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-id", "rotate");
  await expect(page.locator(ROOT)).toHaveAttribute("data-tool-phase", "active");
  await settleToolbarForCapture(page);
  const clickShot = await page.locator(TOOLBAR).screenshot();
  await saveArtifact("ui-toolbar-rotate-click.png", clickShot);
  expect(
    clickShot.equals(keyboardShot),
    `keyboard sha256=${sha256(keyboardShot)} vs click sha256=${sha256(clickShot)}`,
  ).toBe(true);
});
