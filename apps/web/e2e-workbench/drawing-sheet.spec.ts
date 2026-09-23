/**
 * Phase 54 drawing sheet e2e — the roadmap's validation gate at the
 * browser surface, migrated in Phase 55 round 2 onto the UNIFIED drawing
 * route (`/drawings` — the one drawing surface): a feature's dimension is
 * recovered END-TO-END from the parametric source (never re-typed) when
 * the first sheet is created, reference dimensions are authored on-view
 * through the Formedible dialogs, the title block and revision table are
 * edited, the template switches, and the SVG export preview is
 * byte-identical across re-exports (the byte-determinism law, asserted
 * against the exact bytes the page publishes).
 *
 * No kernel session runs: recovery reads document records — the page
 * boots one deterministic seed (a 2 cm-deep extrude, a 4 mm fillet, a
 * threaded M8 structured hole, a 60x40 dimensioned rectangle sketch), so
 * the recovered "20" IS the extrude parameter unit-converted from
 * centimetres.
 */

import { expect, test } from "@playwright/test";

const STATUS = '[data-testid="drawing-status"]';

test.describe("drawing sheet (Phase 54, unified route)", () => {
  test("recovers a feature dimension end-to-end and exports byte-stable SVG", async ({
    page,
  }) => {
    await page.goto("/drawings");

    // The first sheet's creation runs the deterministic recovery — the
    // 20 mm extrude depth (authored as 2 cm) leads the value surface.
    await page.getByRole("button", { name: "Create sheet" }).click();
    const status = page.locator(STATUS);
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute(
      "data-drawing-values",
      '["R4","20","60","40"]',
    );
    await expect(status).toHaveAttribute("data-dims-count", "4");
    await expect(status).toHaveAttribute("data-annotations-count", "1");

    // The canvas renders the composed sheet: furniture (frame, title
    // block, the recovered dimensions) AND the drawing's view content,
    // with exactly ONE frame (the furniture's).
    const canvas = page.locator('[data-testid="drawing-canvas"]');
    await expect(canvas).toBeVisible();
    await expect(canvas.locator("g.dg-furniture")).toHaveCount(1);
    await expect(canvas.locator("rect.dg-frame")).toHaveCount(1);
    await expect(canvas.locator("g.dg-frame")).toHaveCount(0);
    await expect(canvas.locator("polygon").first()).toBeAttached();

    // The title block carries the seed's fields; the sheet is the
    // default pinned template's.
    const titleBlock = JSON.parse(
      (await status.getAttribute("data-titleblock")) ?? "{}",
    ) as { title?: string; scale?: string };
    expect(titleBlock.title).toBe("Bracket plate");
    expect(titleBlock.scale).toBe("1:2");
    await expect(status).toHaveAttribute("data-template", "a3-landscape-1-2");
    await expect(status).toHaveAttribute("data-sheet", "420x297");

    // EXPORT: the preview's bytes are published on the root and a
    // re-export is byte-identical (run-1-green, no state change between).
    await page.click('[data-testid="drawing-export"]');
    await expect(status).not.toHaveAttribute("data-svg-length", "");
    const first = await status.getAttribute("data-drawing-svg");
    expect(first).not.toBeNull();
    expect(first).toContain('viewBox="0 0 420 297"');
    // The composed picture carries the recovered dimension text (the
    // extrude's model-origin value) inside the furniture group.
    expect(first).toContain(">20</text>");
    expect(first).toContain('class="dg-furniture"');
    await page.click('[data-testid="drawing-export"]');
    const second = await status.getAttribute("data-drawing-svg");
    expect(second).toBe(first);
  });

  test("authors a reference dimension and a revision row on-view", async ({
    page,
  }) => {
    await page.goto("/drawings");
    await page.getByRole("button", { name: "Create sheet" }).click();
    const status = page.locator(STATUS);
    await expect(status).toBeVisible();
    // Interactions need hydration: the canvas mounts client-side only.
    await expect(page.locator('[data-testid="drawing-canvas"]')).toBeVisible();

    // Reference dimension: the dialog's submission battery passes, the
    // dimension lands with reference provenance (presented in parens).
    await page.click('[data-testid="drawing-reference-open"]');
    const dialog = page.locator('[data-testid="drawing-reference-dialog"]');
    await expect(dialog).toBeVisible();
    await page
      .getByRole("button", { name: "Place reference dimension" })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-dims-count", "5");
    await expect(status).toHaveAttribute(
      "data-drawing-values",
      '["R4","20","25","60","40"]',
    );

    // Revision row: the table grows by one.
    await page.click('[data-testid="drawing-revision-open"]');
    const revisionDialog = page.locator(
      '[data-testid="drawing-revision-dialog"]',
    );
    await expect(revisionDialog).toBeVisible();
    await page.getByLabel("Description").fill("pin holes added per review");
    await page.getByRole("button", { name: "Add revision row" }).click();
    await expect(revisionDialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-revisions", "1");
  });

  test("switches the sheet template through the picker", async ({ page }) => {
    await page.goto("/drawings");
    await page.getByRole("button", { name: "Create sheet" }).click();
    const status = page.locator(STATUS);
    await expect(status).toBeVisible();
    // Interactions need hydration: the canvas mounts client-side only.
    await expect(page.locator('[data-testid="drawing-canvas"]')).toBeVisible();
    await expect(status).toHaveAttribute("data-template", "a3-landscape-1-2");

    await page.click('[data-testid="drawing-template-open"]');
    const dialog = page.locator('[data-testid="drawing-template-dialog"]');
    await expect(dialog).toBeVisible();
    // Base UI's select is a combobox: the options exist only once expanded.
    await page.getByRole("combobox", { name: "Template" }).click();
    await page.getByRole("option", { name: "A4 landscape · 1:1" }).click();
    await page.getByRole("button", { name: "Apply template" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-template", "a4-landscape-1-1");
    await expect(status).toHaveAttribute("data-sheet", "297x210");

    // The canvas re-renders at the new sheet size (viewBox follows).
    const canvas = page.locator('[data-testid="drawing-canvas"]');
    await expect(canvas).toBeVisible();
    await page.click('[data-testid="drawing-export"]');
    await expect(status).toHaveAttribute(
      "data-drawing-svg",
      /viewBox="0 0 297 210"/,
    );
  });
});
