import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import {
  awaitWorkbenchReady,
  ROOT,
  saveA11yArtifact,
  settleForCapture,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 30 seven-state visual baselines for the complete workbench:
 * hover, focus, selected, active, disabled, error, warning — each driven
 * through the state's REAL activation path (keyboard focus for focus,
 * digit-key arming for active, a refused import for error, an
 * under-constrained sketch for warning) and captured as a settled
 * screenshot artifact under `e2e-artifacts/a11y/`.
 *
 * Theme: the workbench ships exactly one theme — the app root renders
 * `<html class="dark">` and the token sheet's light values are dormant.
 * These baselines validate what exists: the dark theme, every state.
 * Filenames carry the project name, so the Chromium and Firefox runs
 * land side by side without overwriting each other.
 *
 * Capture discipline (the workbench harness's): the scene settles before
 * any shot, the pointer parks off every surface, focus drops, and
 * transitions run out — the states' bytes are stable across repeated
 * runs, which the 3-run sha256 proof requires.
 */

const ROOT_SELECTOR = `#${ROOT}`;

/** The project-suffixed artifact name for one state capture. */
function artifactName(test: { title: string }, project: string): string {
  const slug = test.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `state-${slug}-${project}.png`;
}

async function openWorkbench(page: Page): Promise<void> {
  await page.goto("/workbench-complete");
  await awaitWorkbenchReady(page, test.info().project.name);
}

/**
 * Captures the element's region plus a small margin and files it under
 * the a11y artifacts. The margin matters: the focus ring is a box-shadow
 * spread OUTSIDE the border box, which a plain element screenshot would
 * crop — the state under test would be invisible in its own baseline.
 */
async function captureElement(
  page: Page,
  title: string,
  locator: ReturnType<Page["locator"]>,
): Promise<Buffer> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no box for ${title}`);
  const padding = 6;
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  const clip = {
    x,
    y,
    width: Math.min(box.width + padding * 2, viewport.width - x),
    height: Math.min(box.height + padding * 2, viewport.height - y),
  };
  const bytes = await page.screenshot({ clip });
  await saveA11yArtifact(
    artifactName({ title }, test.info().project.name),
    bytes,
  );
  return bytes;
}

test.beforeEach(async ({ page }) => {
  await openWorkbench(page);
});

test("fresh open (dark theme baseline)", async ({ page }) => {
  // The full-page baseline includes the WebGL canvas, so it is captured
  // only where the scene renders (Chromium's SwiftShader harness); the
  // Firefox headless build on this machine cannot create a WebGL context
  // (see helpers.awaitWorkbenchReady), and an intentionally empty canvas
  // is not a baseline of the workbench.
  test.skip(
    test.info().project.name !== "chromium",
    "the full-page baseline needs the rendered scene (Chromium only)",
  );
  await waitForSettledScene(page, ROOT);
  await settleForCapture(page);
  const bytes = await page.screenshot();
  await saveA11yArtifact(
    artifactName(
      { title: "fresh open dark baseline" },
      test.info().project.name,
    ),
    bytes,
  );
});

test("hover state on a command-row action", async ({ page }) => {
  const button = page.getByTestId("complete-export");
  await button.hover();
  await page.waitForTimeout(300);
  await captureElement(page, "hover export", button);
});

test("focus state (focus-visible ring) on a command-row action", async ({
  page,
}) => {
  // Tab once off the import trigger: the ring only renders for
  // keyboard-arrived focus, which is exactly the state under test.
  await page.getByTestId("complete-import").focus();
  await page.keyboard.press("Tab");
  const button = page.getByTestId("complete-export");
  await expect(button).toBeFocused();
  // Let the button's transition-all run out: a mid-transition ring paints
  // at partial opacity, and the baseline's bytes would differ per run.
  await page.waitForTimeout(300);
  await captureElement(page, "focus export", button);
});

test("selected state in the model tree", async ({ page }) => {
  // The plate body row (the tree spec's selection convention: the body
  // row carries the domain pick).
  const row = page
    .locator('[data-slot="cad-model-tree"] [data-node-key="body|body_plate"]')
    .first();
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(300);
  await captureElement(
    page,
    "selected tree row",
    page.locator('[data-slot="cad-model-tree"]'),
  );
});

test("active state on an armed tool", async ({ page }) => {
  const tools = page.locator('[data-slot="cad-toolbar"] button[data-tool-id]');
  await tools.first().focus();
  await page.keyboard.press("2");
  const second = tools.nth(1);
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(ROOT_SELECTOR)).toHaveAttribute(
    "data-tool-phase",
    "active",
  );
  await page.waitForTimeout(300);
  await captureElement(
    page,
    "active armed tool",
    page.locator('[data-slot="cad-toolbar"]'),
  );
});

test("disabled state on the hole action", async ({ page }) => {
  const button = page.getByTestId("complete-hole");
  await expect(button).toBeDisabled();
  await settleForCapture(page);
  await captureElement(page, "disabled hole", button);
});

test("error state: refused import in an alert region", async ({ page }) => {
  await page.getByTestId("complete-import").click();
  const dialog = page.locator("[data-cad-import-dialog]");
  await expect(dialog).toBeVisible();
  await page.getByTestId("cad-import-file").setInputFiles({
    name: "not-a-model.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("no geometry here"),
  });
  const alert = page.locator('[data-cad-import-error][role="alert"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("unsupported file type: not-a-model.txt");
  await page.waitForTimeout(300);
  await captureElement(page, "error refused import", dialog);
});

test("warning state: under-constrained sketch solver readout", async ({
  page,
}) => {
  await page.getByTestId("complete-mode-toggle").click();
  const sketchRoot = page.locator("#sketch-root");
  await expect(sketchRoot).toBeVisible();

  // Draw one free line: two point picks with the line tool leave the
  // sketch under-constrained (the amber solver readout).
  await page.locator('[data-sketch-tool-id="line"]').click();
  const surface = page.locator("#sketch-root [data-sketch-surface]");
  const toCanvas = (x: number, y: number): { x: number; y: number } => ({
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  });
  await surface.click({ position: toCanvas(10, 10) });
  await surface.click({ position: toCanvas(40, 10) });
  await expect(sketchRoot).toHaveAttribute(
    "data-sketch-solve",
    /under-constrained/,
  );
  await page.waitForTimeout(300);
  await captureElement(
    page,
    "warning under-constrained solver",
    page.locator('[data-slot="cad-sketch-inspector"]'),
  );
});
