import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

/** The assembly fixture's root (the session s19 machine surface). */
const ASSEMBLY_ROOT = "#assembly-workbench-root";

/**
 * Chapter 22 — the assembly structure surface. One plate body, its
 * occurrences as document records, the 80 mm placement step, the phantom
 * BOM chip, and the removes that prove tree and viewport derive from the
 * document (the s19 stage, walked at teaching pace).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "assembly-tree",
    title: "The assembly tree",
    summary:
      "Occurrences as document records: add, place, flag, and remove instances while the tree and viewport follow.",
    cues: [
      {
        stepId: "boot",
        text: "Assemblies: one part, many placed copies. This is the assembly tree.",
      },
      {
        stepId: "first",
        text: "The tree lists occurrences — document records, not copies of geometry.",
      },
      {
        stepId: "add",
        text: "Add instance stamps a new occurrence into the document.",
      },
      {
        stepId: "placed",
        text: "Each copy steps eighty millimeters along x — placement is data.",
      },
      {
        stepId: "phantom",
        text: "The third copy carries the phantom chip: assembled, never ordered.",
      },
      {
        stepId: "remove",
        text: "Remove last instance deletes the record — the copy leaves.",
      },
      {
        stepId: "one-left",
        text: "Remove again: one plate, exactly where the assembly began.",
      },
      {
        stepId: "recap",
        text: "Structure lives in the document, and the tree tells the truth.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    const root = page.locator(ASSEMBLY_ROOT);

    await driver.step("boot");
    await page.goto("/workbench-assembly");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "1");
    await expect(root).toHaveAttribute("data-cad-instance-count", "1");
    await driver.dwell();

    await driver.step("first");
    const firstRow = page.locator('[data-node-key="occ_assembly_1"]');
    await expect(firstRow).toBeVisible();
    await driver.humanPoint(firstRow);
    await driver.dwell();

    await driver.step("add");
    await driver.humanClick(page.getByTestId("assembly-add-instance"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "2");
    await expect(root).toHaveAttribute("data-cad-instance-count", "2");

    await driver.step("placed");
    const secondRow = page.locator('[data-node-key="occ_assembly_2"]');
    await expect(secondRow).toBeVisible();
    await driver.humanPoint(secondRow);
    await driver.dwell();

    await driver.step("phantom");
    await driver.humanClick(page.getByTestId("assembly-add-instance"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "3");
    const phantomChip = page.locator('[data-cad-tree-bom="phantom"]');
    await expect(phantomChip).toBeVisible();
    await driver.humanPoint(phantomChip);
    await driver.dwell();

    await driver.step("remove");
    await driver.humanClick(page.getByTestId("assembly-remove-instance"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "2");
    await expect(page.locator('[data-node-key="occ_assembly_3"]')).toHaveCount(
      0,
    );
    await expect(phantomChip).toHaveCount(0);
    await driver.humanPoint(page.locator('[data-node-key="occ_assembly_2"]'));
    await driver.dwell();

    await driver.step("one-left");
    await driver.humanClick(page.getByTestId("assembly-remove-instance"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "1");
    await expect(page.locator('[data-node-key="occ_assembly_2"]')).toHaveCount(
      0,
    );
    await driver.humanPoint(page.locator('[data-node-key="occ_assembly_1"]'));
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
