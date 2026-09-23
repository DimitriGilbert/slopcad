import { expect, test } from "@playwright/test";

// Phase 53 — Drawings I: the sheet + base views journey. The page is fully
// client-side (the drawing document is kernel-free cad-core state), so the
// journey exercises the real UI: create a sheet from the Formedible form,
// place three base views (front anchors, top and right align to it), and
// read the canvas back through its programmatic a11y surface.
test("create a sheet and place three base views on the drawing canvas", async ({
  page,
}) => {
  await page.goto("/drawings");

  await expect(page.getByRole("heading", { name: "Drawings" })).toBeVisible();

  // Empty state: the canvas names its emptiness.
  const canvas = page.getByTestId("drawing-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Drawing canvas: no sheets yet",
  );

  // Create the sheet (A3 landscape 1:1 by default).
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(page.getByRole("status")).toContainText("created");

  // Place three base views. Front first (it anchors the alignment), then
  // top and right under the third-angle default.
  await page.getByRole("button", { name: "Front", exact: true }).click();
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.getByRole("button", { name: "Right", exact: true }).click();

  // The canvas summary carries the sheet and the ordered view list, and the
  // projected geometry renders (paths on the sheet, top aligned to front).
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Drawing: A3 landscape sheet, 3 views: front, top, right",
  );
  await expect(canvas.locator('g[data-kind="top"]')).toHaveCount(1);
  await expect(canvas.locator('g[data-kind="right"]')).toHaveCount(1);
  await expect(canvas.locator('g[data-kind="front"]')).toHaveCount(1);
  // Projected edges render as stroked SVG paths (axis-aligned segments have
  // a zero-height bounding box, so visibility is asserted via the geometry
  // attribute, Playwright's bbox check being meaningless for line art).
  const firstPath = canvas.locator("path").first();
  await expect(firstPath).not.toHaveAttribute("d", "");
  const topX = await canvas
    .locator('g[data-kind="top"]')
    .getAttribute("data-x");
  const frontX = await canvas
    .locator('g[data-kind="front"]')
    .getAttribute("data-x");
  expect(topX).toBe(frontX);

  await page.screenshot({ path: "e2e-artifacts/drawings.png", fullPage: true });
});
