import { expect, test } from "@playwright/test";

/**
 * Phase 50 assembly-tree e2e (Assemblies I): the occurrence tree and the
 * placed-instance render on `/workbench-assembly` — the production build
 * under the workbench harness's determinism setup.
 *
 * The journey:
 *  - OPEN — the fixture boots with one plate body and one occurrence; the
 *    projection carries one placed instance (the machine stamp) and the
 *    tree shows the occurrence row;
 *  - ADD — the Add instance button commits a real `addOccurrence` through
 *    the domain; the tree gains the row and the projection gains a placed
 *    object at the documented +x step;
 *  - REMOVE — the last instance leaves the document, the tree, and the
 *    projection together.
 *
 * Assertions read the machine surfaces (`data-cad-occurrence-count`,
 * `data-cad-instance-count`, tree node keys) — screenshots are artifacts.
 */

const ROOT = "assembly-workbench-root";

test("assembly instance tree and placed rendering", async ({ page }) => {
  await page.goto("/workbench-assembly");
  const root = page.locator(`#${ROOT}`);
  await expect(root).toBeVisible();

  // React hydration owns the DOM before any interaction — a click that
  // races hydration fires on the SSR button with no handlers attached.
  await expect(root).toHaveAttribute("data-cad-hydrated", "true");

  // Boot state: one occurrence in the document, one placed instance in
  // the projection (the direct body render does not count).
  await expect(root).toHaveAttribute("data-cad-occurrence-count", "1");
  await expect(root).toHaveAttribute("data-cad-instance-count", "1");
  await expect(page.locator('[data-node-key="occ_assembly_1"]')).toBeVisible();
  await expect(
    page.locator('[data-node-key="occ_assembly_1"]'),
  ).toHaveAttribute("aria-level", "1");

  // The viewport's canvas is the render surface; the placed-instance
  // pipeline itself was pixel-verified (see the fixture). The journey's
  // machine surfaces are the counts and the tree nodes.
  await expect(page.locator("canvas").first()).toBeVisible();

  // ADD: a second occurrence lands in the document, the tree, and the
  // projection — one domain add, three derived surfaces.
  await page.getByTestId("assembly-add-instance").click();
  await expect(root).toHaveAttribute("data-cad-occurrence-count", "2");
  await expect(root).toHaveAttribute("data-cad-instance-count", "2");
  await expect(page.locator('[data-node-key="occ_assembly_2"]')).toBeVisible();
  await expect(
    page.locator('[data-node-key="occ_assembly_2"]'),
  ).toHaveAttribute("data-cad-tree-occurrence", "body");

  // REMOVE: the last instance leaves every surface together.
  await page.getByTestId("assembly-remove-instance").click();
  await expect(root).toHaveAttribute("data-cad-occurrence-count", "1");
  await expect(root).toHaveAttribute("data-cad-instance-count", "1");
  await expect(page.locator('[data-node-key="occ_assembly_2"]')).toHaveCount(0);

  await page.screenshot({
    path: "e2e-artifacts/workbench/assembly-tree.png",
    fullPage: true,
  });
});
