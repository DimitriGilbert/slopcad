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
  // The settle discipline (why this journey waits before its first click):
  // the page renders client-side, so a click racing the final mount —
  // StrictMode's discard window on dev, a cold vite server's one-shot
  // dependency-discovery full reload mid-boot — lands on a form generation
  // that no longer exists, and a retrying status assertion cannot resurrect
  // a click nobody received. The page publishes `data-drawing-boot="ready"`
  // once its surviving mount's effects have run; one explicit reload pins
  // the journey to the hot module graph (a no-op stability-wise on the
  // built server), and the stamp gates every interaction that follows.
  const boot = page.locator("main[data-drawing-boot]");
  await expect(boot).toHaveAttribute("data-drawing-boot", "ready");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Drawings" })).toBeVisible();
  await expect(boot).toHaveAttribute("data-drawing-boot", "ready");

  // Empty state: the canvas names its emptiness.
  const canvas = page.getByTestId("drawing-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Drawing canvas: no sheets yet",
  );

  // Create the sheet (A3 landscape 1:2 by default).
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(page.getByRole("status")).toContainText("created");

  // Place three base views. Front first (it anchors the alignment), then
  // top and right under the third-angle default.
  await page.getByRole("button", { name: "Front", exact: true }).click();
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.getByRole("button", { name: "Right", exact: true }).click();

  // The canvas summary carries the sheet and the ordered view list, and the
  // projected geometry renders (stroked lines on the sheet, top aligned to
  // front).
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Drawing: A3 landscape sheet, 3 views: front, top, right",
  );
  await expect(canvas.locator('g[data-kind="top"]')).toHaveCount(1);
  await expect(canvas.locator('g[data-kind="right"]')).toHaveCount(1);
  await expect(canvas.locator('g[data-kind="front"]')).toHaveCount(1);
  // Projected edges render as stroked SVG lines (axis-aligned segments have
  // a zero-height bounding box, so visibility is asserted via the geometry
  // attribute, Playwright's bbox check being meaningless for line art).
  const firstLine = canvas.locator("g.dg-visible line").first();
  expect(Number(await firstLine.getAttribute("x1"))).not.toBeNaN();
  const topX = await canvas
    .locator('g[data-kind="top"]')
    .getAttribute("data-x");
  const frontX = await canvas
    .locator('g[data-kind="front"]')
    .getAttribute("data-x");
  expect(topX).toBe(frontX);

  await page.screenshot({ path: "e2e-artifacts/drawings.png", fullPage: true });
});

// Phase 55 — Drawings III: the full drawing production journey. From the
// demo assembly (three item groups, one phantom) the sheet grows every
// derived-view class — fold-line projections, a hatched section, a 2:1
// detail, a broken-out band, an auxiliary view — plus a self-numbering BOM
// table and a balloon keyed to the plate occurrence. The canvas is the
// same serialized SVG the exporters emit, so the DOM here is ground truth
// for what SVG/PDF/DXF carry as bytes.
test("produce a full drawing from the demo assembly", async ({ page }) => {
  await page.goto("/drawings");

  await page.getByRole("button", { name: "Create sheet" }).click();
  for (const name of ["Front", "Top", "Right"]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  for (const name of [
    "Projected left",
    "Projected back",
    "Section A-A",
    "Detail B",
    "Broken-out",
    "Auxiliary D",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  await page.getByRole("button", { name: "Add BOM table" }).click();
  await page.getByRole("button", { name: "Add balloon" }).click();

  const canvas = page.getByTestId("drawing-canvas");
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Drawing: A3 landscape sheet, 9 views: front, top, right, front, front, front, front, top, front, BOM 1 table, 1 balloon",
  );

  // Every derived view labels itself on the sheet.
  for (const label of [
    "Left",
    "Back",
    "SECTION A-A",
    "DETAIL B (2:1)",
    "Broken-out C-C",
    "AUX D",
  ]) {
    await expect(
      canvas.locator("text.dg-label", { hasText: label }),
    ).toHaveCount(1);
  }

  // The section and the broken-out band hatch their cut faces; the balloon
  // resolves its item number from the BOM (the plate is item 1 — the
  // phantom frame dissolves, the bolt pair groups).
  const hatch = canvas.locator("g.dg-hatch line");
  expect(await hatch.count()).toBeGreaterThan(0);
  expect(Number(await hatch.first().getAttribute("x1"))).not.toBeNaN();
  await expect(canvas.locator("g.dg-bom")).toHaveCount(1);
  await expect(canvas.locator("text.dg-balloon-item")).toHaveText("1");

  // Print layout: print media strips the app chrome (the root nav, the
  // page heading, the authoring sidebar) so the sheet prints alone, and
  // the @page box carries the sheet's exact ISO size.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Drawings" })).toBeHidden();
  await expect(page.locator("main aside")).toBeHidden();
  const pageStyle = await page.locator("main style").first().textContent();
  expect(pageStyle).toContain("@page { size: 420.00mm 297.00mm; margin: 0; }");
  await page.emulateMedia({ media: null });

  await page.screenshot({
    path: "e2e-artifacts/drawings-full.png",
    fullPage: true,
  });
});
