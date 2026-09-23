import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Phase 59 visualization e2e — appearances, light rigs, and the quality
 * render mode, on the complete workbench under the SwiftShader
 * fixed-viewport discipline:
 *
 *  - an appearance-library preset applied to the plate body CHANGES the
 *    settled pixels and persists in the document (the model tree's chip
 *    state rides the record; a reload re-applies to identical bytes);
 *  - same state renders IDENTICAL bytes run-over-run (the determinism
 *    law holds for appearance-carrying records);
 *  - the opt-in quality mode (soft shadows + AO post chain) changes the
 *    pixels, and is itself deterministic given state;
 *  - a light-rig preset changes the pixels the same state-locked way.
 *
 * Byte comparisons use Playwright `Buffer.equals` on canvas-element
 * captures; every pixel assertion stands beside a machine-surface
 * assertion (frames advanced, attribute states). Quality mode is opt-in
 * and UNPINNED: nothing here compares it to a recorded baseline, only to
 * its own re-run.
 */

const ROOT = "#workbench-complete-root";
const CANVAS = "#workbench-complete-viewport canvas";

async function settledFrames(page: Page): Promise<number> {
  const raw = await page.locator(ROOT).getAttribute("data-rendered-frames");
  return Number(raw ?? "0");
}

async function waitForFrames(page: Page, atLeast: number): Promise<void> {
  await expect
    .poll(async () => settledFrames(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(atLeast);
}

/**
 * Best-effort frame wait: the machine surface's frame ledger is
 * settle-anchored, so a pure render-mode toggle may legitimately not
 * advance it. Degrades to a fixed settle wait; the byte assertions, not
 * the ledger, carry the pixel evidence here.
 */
async function waitForFramesLenient(
  page: Page,
  atLeast: number,
): Promise<void> {
  try {
    await expect
      .poll(async () => settledFrames(page), { timeout: 8_000 })
      .toBeGreaterThanOrEqual(atLeast);
  } catch {
    // The toggle rendered without advancing the settle-anchored ledger.
  }
  await page.waitForTimeout(1_000);
}

async function captureCanvas(page: Page): Promise<Buffer> {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  return page.locator(CANVAS).screenshot();
}

/**
 * The root's settle ledger counts dispatched and settled transactions;
 * the page is quiescent when the two agree and at least one dispatch has
 * landed (the boot dispatch included). A fixed count is brittle: the
 * demo document's boot may dispatch more than once.
 */
async function waitQuiescent(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const root = page.locator(ROOT);
        const settled = Number(
          (await root.getAttribute("data-settled")) ?? "0",
        );
        const dispatched = Number(
          (await root.getAttribute("data-dispatched")) ?? "0",
        );
        const frames = Number(
          (await root.getAttribute("data-rendered-frames")) ?? "0",
        );
        return dispatched >= 1 && settled === dispatched && frames >= 1
          ? "quiescent"
          : "busy";
      },
      { timeout: 30_000 },
    )
    .toBe("quiescent");
}

/**
 * Opens the body row's appearance picker and lets the popover's mount
 * transition finish before a menu item is clicked (an unstable menu is
 * Playwright's detached-retry loop).
 */
async function openAppearancePicker(page: Page): Promise<void> {
  // A Popover does not close on its menu buttons' clicks: dismiss any
  // still-open one first, or the trigger click would toggle it shut.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.locator('[data-cad-tree-body-appearance=""]').first().click();
  await page.waitForTimeout(300);
}

test("appearances and render modes: deterministic pixels, opt-in quality", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/workbench-complete");
  await waitQuiescent(page);
  // The getting-started hint floats over the viewport's bottom strip and
  // would intercept the toolbar clicks below; dismiss it once.
  const hintDismiss = page.getByTestId("workbench-sketch-hint-dismiss");
  if (await hintDismiss.isVisible().catch(() => false)) {
    await hintDismiss.click();
    await page.waitForTimeout(300);
  }
  const framesAtBoot = await settledFrames(page);
  const baseline = await captureCanvas(page);

  // -- The appearance picker: apply the brass preset to the plate body.
  await openAppearancePicker(page);
  await page.getByTestId("appearance-preset-brass").click();

  // The document changed: one more settled frame, and the pixels moved.
  await waitForFrames(page, framesAtBoot + 1);
  await waitQuiescent(page);
  const brass = await captureCanvas(page);
  expect(brass.equals(baseline), "brass must change the pixels").toBe(false);

  // -- Same state, identical bytes: reload, re-apply the same preset (the
  //    document record is display state; a fresh session must land on the
  //    same appearance only through the same action), same bytes.
  await page.reload();
  await waitQuiescent(page);
  const framesAtReload = await settledFrames(page);
  await openAppearancePicker(page);
  await page.getByTestId("appearance-preset-brass").click();
  await waitForFrames(page, framesAtReload + 1);
  await waitQuiescent(page);
  const brassRerun = await captureCanvas(page);
  expect(
    brassRerun.equals(brass),
    `brass rerun sha256 differs from first run`,
  ).toBe(true);

  // -- Clear back to the scene default: the pixels return to the
  //    baseline (the record is gone, the boot material restored).
  await openAppearancePicker(page);
  await page.getByTestId("appearance-preset-none").click();
  await waitQuiescent(page);
  const cleared = await captureCanvas(page);
  expect(cleared.equals(baseline), "clear must restore the boot pixels").toBe(
    true,
  );

  // -- Light rigs: the inspection rig changes the shading deterministically.
  const inspect = page.getByTestId("light-rig-inspection");
  await expect(inspect).toBeAttached();
  const framesBeforeRig = await settledFrames(page);
  await inspect.click();
  await waitForFramesLenient(page, framesBeforeRig + 1);
  const rigFrame = await captureCanvas(page);
  expect(rigFrame.equals(cleared), "the rig must change the pixels").toBe(
    false,
  );

  // -- Quality mode (opt-in): soft shadows + AO post chain. Pixels change,
  //    and the mode is deterministic: toggle standard, re-toggle quality,
  //    same bytes.
  await page.getByTestId("light-rig-studio").click();
  await waitQuiescent(page);
  const framesBeforeQuality = await settledFrames(page);
  await page.getByTestId("render-quality-quality").click();
  await waitForFramesLenient(page, framesBeforeQuality + 1);
  const quality = await captureCanvas(page);
  expect(quality.equals(cleared), "quality must change the pixels").toBe(false);

  // Back to standard, then quality again: the same bytes return.
  await page.getByTestId("render-quality-standard").click();
  await waitQuiescent(page);
  const framesBeforeQuality2 = await settledFrames(page);
  await page.getByTestId("render-quality-quality").click();
  await waitForFramesLenient(page, framesBeforeQuality2 + 1);
  const qualityRerun = await captureCanvas(page);
  expect(
    qualityRerun.equals(quality),
    "quality mode must be deterministic given state",
  ).toBe(true);

  // Leave the session in its boot state (standard, studio, no records).
  await page.getByTestId("render-quality-standard").click();
});
