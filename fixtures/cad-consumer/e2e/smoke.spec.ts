import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The consumer fixture's browser smoke (Phases 16 + 33): every registry
 * category installed by the shadcn CLI must do real work —
 *
 * - the plate workbench EXAMPLE renders the real CAD session: the Manifold
 *   kernel builds the plate, the viewport settles frames, the tree mirrors
 *   the document, and a panel edit produces a new build + settled frame;
 * - the NEMA 17 COMPONENT preview builds real contract-driven geometry,
 *   settles frames, and a parameter edit (plateSizeMm 46 → 52) rebuilds
 *   with a changed volume and a new settled frame;
 * - the installed headless TOOLS list renders with a real outcome each.
 *
 * Full-page screenshots are always written to e2e-artifacts/.
 */

async function waitForCounter(
  page: Page,
  testId: string,
  atLeast: number,
): Promise<number> {
  await expect
    .poll(async () => {
      const raw = await page.getByTestId(testId).textContent();
      const frames = raw === null ? 0 : Number.parseInt(raw, 10);
      return Number.isNaN(frames) ? 0 : frames;
    })
    .toBeGreaterThanOrEqual(atLeast);
  const raw = await page.getByTestId(testId).textContent();
  return Number.parseInt(raw ?? "0", 10);
}

test("installed CAD components render and edit a real session", async ({
  page,
}) => {
  await page.goto("/");

  // 33.3 + 33.1: the installed example composes the installed components.
  await expect(page.locator("#consumer-root")).toBeVisible();
  await expect(page.locator("#plate-workbench-root")).toBeVisible();

  // The real kernel build finished without error and the viewport settled
  // at least one frame of the projection.
  await expect(page.getByTestId("plate-build-status")).toHaveText("ok", {
    timeout: 60_000,
  });
  const framesAfterBoot = await waitForCounter(page, "plate-settled-frames", 1);

  // The viewport hosts the R3F canvas.
  await expect(page.locator("#plate-viewport canvas").first()).toBeVisible();

  // The toolbar mirrors the four registered tools; SELECT is armed at boot.
  const toolbar = page.locator('[data-slot="cad-toolbar"]');
  await expect(toolbar.locator("button[data-tool-id]")).toHaveCount(4);
  await expect(
    toolbar.locator('button[data-tool-id="select"][data-active="true"]'),
  ).toBeAttached();

  // The model tree mirrors the document's plate body.
  await expect(page.getByText("plate", { exact: true }).first()).toBeVisible();

  // The parameter panel exposes the document's parameters, including the
  // expression-driven one (scoped: the component preview renders its own).
  const panel = page.locator(
    '#plate-workbench-root [data-slot="cad-parameter-panel"]',
  );
  await expect(panel).toBeVisible();
  const holeInput = page.getByLabel("holeDiameter", { exact: true });
  await expect(holeInput).toBeVisible();
  await expect(page.getByText("volumeHint").first()).toBeVisible();

  // The parametric round trip: edit the bore diameter through the panel,
  // apply, and observe a NEW settled frame from the rebuilt projection.
  await holeInput.fill("12");
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("plate-build-status")).toHaveText("ok");
  const framesAfterEdit = await waitForCounter(
    page,
    "plate-settled-frames",
    framesAfterBoot + 1,
  );
  expect(framesAfterEdit).toBeGreaterThan(framesAfterBoot);

  await page.screenshot({
    path: "e2e-artifacts/workbench.png",
    fullPage: true,
  });
});

test("the installed NEMA 17 component builds, renders, and rebuilds", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator("#component-preview-root")).toBeVisible();

  // The contract-driven build settled real geometry.
  await expect(page.getByTestId("component-build-status")).toHaveText("ok", {
    timeout: 60_000,
  });
  const framesAfterBoot = await waitForCounter(
    page,
    "component-settled-frames",
    1,
  );
  await expect(
    page.locator("#component-viewport canvas").first(),
  ).toBeVisible();

  // The default build's volume and the assembly example's measured total.
  const volumeDefault = await page
    .getByTestId("component-volume")
    .textContent();
  expect(volumeDefault).not.toBeNull();
  expect(volumeDefault).toMatch(/mm³$/);
  const assemblyDefault = await page
    .getByTestId("assembly-total-volume")
    .textContent();
  expect(assemblyDefault).not.toBeNull();
  expect(assemblyDefault).toMatch(/mm³$/);

  // The component's own contract parameters drive the panel; an edit
  // rebuilds with a changed volume and a new settled frame.
  const componentPanel = page
    .locator("#component-preview-root")
    .locator('[data-slot="cad-parameter-panel"]');
  const plateSizeInput = page.getByLabel("plateSizeMm", { exact: false });
  await expect(plateSizeInput).toBeVisible();
  await plateSizeInput.fill("52");
  await componentPanel.getByRole("button", { name: "Rebuild" }).click();

  await expect(page.getByTestId("component-build-status")).toHaveText("ok", {
    timeout: 60_000,
  });
  const framesAfterEdit = await waitForCounter(
    page,
    "component-settled-frames",
    framesAfterBoot + 1,
  );
  expect(framesAfterEdit).toBeGreaterThan(framesAfterBoot);
  await expect
    .poll(async () => page.getByTestId("component-volume").textContent())
    .not.toBe(volumeDefault);

  // A finite-but-out-of-range edit is refused by the apply gate itself:
  // the panel STAYS MOUNTED and renders its inline error, and the last
  // committed build is untouched (no unmounting to an unrecoverable
  // alert, no rebuild).
  await plateSizeInput.fill("10");
  await componentPanel.getByRole("button", { name: "Rebuild" }).click();
  const panelError = componentPanel.locator("[data-cad-param-panel-error]");
  await expect(panelError).toBeVisible();
  await expect(panelError).toContainText("plateSizeMm");
  await expect(panelError).toContainText("out of range");
  await expect(componentPanel).toBeVisible();
  await expect(page.getByTestId("component-build-status")).toHaveText("ok");
  await expect(
    page.getByTestId("component-volume").textContent(),
  ).resolves.not.toBe(volumeDefault);

  // 33.4: the installed headless tools list renders with real outcomes.
  await expect(page.locator("#installed-tools-root")).toBeVisible();
  const outcomes = page.locator('[data-testid="tool-outcome"]');
  await expect(outcomes).toHaveCount(7);
  await expect(outcomes.first()).toContainText("tightness=tight");

  await page.screenshot({
    path: "e2e-artifacts/component.png",
    fullPage: true,
  });
  await page.screenshot({ path: "e2e-artifacts/smoke.png", fullPage: true });
});
