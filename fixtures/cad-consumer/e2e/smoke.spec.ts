import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The consumer fixture's browser smoke (Phase 16): the registry-installed
 * components must render a REAL CAD session — the Manifold kernel builds
 * the plate, the viewport settles frames of the projection, the model tree
 * mirrors the document, and a parameter edit through the panel produces a
 * new document, a new build, and a new settled frame. A full-page
 * screenshot is always written to `e2e-artifacts/smoke.png`.
 */

async function waitForSettledFrames(
  page: Page,
  atLeast: number,
): Promise<number> {
  await expect
    .poll(async () => {
      const raw = await page.getByTestId("settled-frames").textContent();
      const frames = raw === null ? 0 : Number.parseInt(raw, 10);
      return Number.isNaN(frames) ? 0 : frames;
    })
    .toBeGreaterThanOrEqual(atLeast);
  const raw = await page.getByTestId("settled-frames").textContent();
  return Number.parseInt(raw ?? "0", 10);
}

test("installed CAD components render and edit a real session", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator("#consumer-root")).toBeVisible();

  // The real kernel build finished without error and the viewport settled
  // at least one frame of the projection.
  await expect(page.getByTestId("build-status")).toHaveText("ok", {
    timeout: 60_000,
  });
  const framesAfterBoot = await waitForSettledFrames(page, 1);

  // The viewport hosts the R3F canvas.
  await expect(page.locator("#consumer-viewport canvas").first()).toBeVisible();

  // The toolbar mirrors the four registered tools; SELECT is armed at boot.
  const toolbar = page.locator('[data-slot="cad-toolbar"]');
  await expect(toolbar.locator("button[data-tool-id]")).toHaveCount(4);
  await expect(
    toolbar.locator('button[data-tool-id="select"][data-active="true"]'),
  ).toBeAttached();

  // The model tree mirrors the document's plate body.
  await expect(page.getByText("plate", { exact: true }).first()).toBeVisible();

  // The parameter panel exposes the document's parameters, including the
  // expression-driven one.
  const panel = page.locator('[data-slot="cad-parameter-panel"]');
  await expect(panel).toBeVisible();
  const holeInput = page.getByLabel("holeDiameter");
  await expect(holeInput).toBeVisible();
  await expect(page.getByText("volumeHint").first()).toBeVisible();

  // The parametric round trip: edit the bore diameter through the panel,
  // apply, and observe a NEW settled frame from the rebuilt projection.
  await holeInput.fill("12");
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("build-status")).toHaveText("ok");
  const framesAfterEdit = await waitForSettledFrames(page, framesAfterBoot + 1);
  expect(framesAfterEdit).toBeGreaterThan(framesAfterBoot);

  // Artifact: the composed CAD usage, for visual inspection.
  await page.screenshot({ path: "e2e-artifacts/smoke.png", fullPage: true });
});
