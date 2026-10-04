import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

/**
 * Chapter 27 — the drawing's output furniture: the BOM table that numbers
 * itself from the assembly structure, the balloon that pins an item to
 * its view, the canvas summary that states both, and the SVG export that
 * holds the furnished sheet (the s23 output flow, at teaching pace).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "bom-output",
    title: "BOM and output",
    summary:
      "The self-numbering BOM table, its balloon callout, and the furnished sheet held as deterministic SVG bytes.",
    cues: [
      {
        stepId: "boot",
        text: "Back on Drawings, fresh: a sheet and a view for the BOM.",
      },
      {
        stepId: "bom",
        text: "Add BOM table: the sheet numbers the assembly's parts itself.",
      },
      {
        stepId: "balloon",
        text: "The balloon pins item one to its view — table and callout agree.",
      },
      {
        stepId: "canvas",
        text: "The canvas states it plainly: one BOM table, one balloon.",
      },
      {
        stepId: "export",
        text: "SVG output holds the furnished sheet — the deliverable a shop reads.",
      },
      {
        stepId: "recap",
        text: "From model to manufacturing paperwork in a handful of clicks.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    const boot = page.locator("main[data-drawing-boot]");
    const status = page.locator('[data-testid="drawing-status"]');
    const canvas = page.getByTestId("drawing-canvas");

    await driver.step("boot");
    await page.goto("/drawings");
    await expect(boot).toHaveAttribute("data-drawing-boot", "ready");
    await driver.humanClick(page.getByRole("button", { name: "Create sheet" }));
    await expect(status).toHaveAttribute("data-dims-count", "4");
    await driver.humanClick(
      page.getByRole("button", { name: "Front", exact: true }),
    );
    await expect(canvas).toHaveAttribute("aria-label", /1 view/);
    await driver.dwell();

    await driver.step("bom");
    await driver.humanClick(
      page.getByRole("button", { name: "Add BOM table" }),
    );
    await expect(canvas.locator("g.dg-bom")).toHaveCount(1);
    await driver.humanPoint(canvas.locator("g.dg-bom"));
    await driver.dwell();

    await driver.step("balloon");
    const balloon = canvas.locator("text.dg-balloon-item");
    await driver.humanClick(page.getByRole("button", { name: "Add balloon" }));
    await expect(balloon).toHaveText("1");
    await driver.humanPoint(balloon);
    await driver.dwell();

    await driver.step("canvas");
    await expect(canvas).toHaveAttribute(
      "aria-label",
      /BOM 1 table, 1 balloon/,
    );
    await driver.humanPoint(canvas);
    await driver.dwell();

    await driver.step("export");
    await driver.humanClick(page.getByTestId("drawing-export"));
    const svg = await status.getAttribute("data-drawing-svg");
    expect(svg ?? "").toContain('viewBox="0 0 420 297"');
    await driver.pointAtReadout(status);
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
