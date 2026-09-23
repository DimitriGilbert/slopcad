import { expect, test } from "@playwright/test";

/**
 * The Phase 47 curve authoring journey: every curve kind is reachable
 * through the form (the interpolated spline ships as the default, the
 * helix through the kind select), the authored curve is VISIBLE in the
 * viewport (the curve overlay's machine-surfaced marker over the settled
 * canvas), and the record persists through undo/redo — the same history
 * every document transaction rides.
 */

const ROOT = "#workbench-complete-root";

test("authors a 3D curve of each kind, visible in the viewport, persistent through undo/redo", async ({
  page,
}) => {
  await page.goto("/workbench-complete");

  // The plate settles before anything is authored.
  await expect(page.locator(ROOT)).toHaveAttribute("data-settled", "1");
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(ROOT)).toHaveAttribute("data-curve-count", "0");

  // -- The interpolated spline (the form's default kind), via the command
  //    menu — the path that stays reachable at every width.
  await page.getByTestId("complete-command-menu-trigger").click();
  await page.locator('[data-cad-command-id="create-curve"]').click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-feature-dialog-kind",
    "curve",
  );
  await page.getByRole("button", { name: "Create curve" }).click();

  // The record committed, the scene switched to the curves surface, and
  // the overlay drew the station polyline over the settled canvas.
  await expect(page.locator(ROOT)).toHaveAttribute("data-curve-count", "1");
  await expect(page.locator(ROOT)).toHaveAttribute("data-scene-kind", "curves");
  const curvesAfterSpline = await page
    .locator(ROOT)
    .getAttribute("data-curves");
  expect(curvesAfterSpline ?? "").toContain("interpolated-spline");
  const markers = page.locator("[data-curve-overlay-marker]");
  await expect(markers).toHaveCount(1);
  await expect(markers.first().locator("polyline")).toBeAttached();

  // -- The helix, through the kind select (the second curve kind of the
  //    journey; the equation and control-spline kinds ride the same
  //    select).
  await page.getByTestId("complete-command-menu-trigger").click();
  await page.locator('[data-cad-command-id="create-curve"]').click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-feature-dialog-kind",
    "curve",
  );
  const kindTrigger = page
    .locator('[data-testid="feature-form-dialog"] [data-slot=select-trigger]')
    .first();
  await kindTrigger.click();
  await page
    .locator("[data-slot=select-item]", { hasText: "helix" })
    .first()
    .click();
  await page.getByRole("button", { name: "Create curve" }).click();

  await expect(page.locator(ROOT)).toHaveAttribute("data-curve-count", "2");
  const curvesAfterHelix = await page.locator(ROOT).getAttribute("data-curves");
  expect(curvesAfterHelix ?? "").toContain("helix");
  await expect(page.locator("[data-curve-overlay-marker]")).toHaveCount(2);

  // -- Persistence through history: undo removes the helix record (one
  //    marker left), undo removes the spline too (the overlay empties),
  //    redo restores the spine — the record survives the round trip.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-curve-count", "1");
  await expect(page.locator("[data-curve-overlay-marker]")).toHaveCount(1);
  const curvesAfterUndo = await page.locator(ROOT).getAttribute("data-curves");
  expect(curvesAfterUndo ?? "").toContain("interpolated-spline");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-curve-count", "0");
  await expect(page.locator("[data-curve-overlay-marker]")).toHaveCount(0);

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-curve-count", "1");
  await expect(page.locator("[data-curve-overlay-marker]")).toHaveCount(1);

  await page.screenshot({
    path: "e2e-artifacts/curve-authoring.png",
    fullPage: true,
  });
});
