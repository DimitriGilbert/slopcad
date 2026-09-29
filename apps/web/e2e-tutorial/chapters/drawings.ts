import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { fillLabeledField } from "../feature-verbs";

/**
 * Chapter 26 — the drawing workbench. The sheet creation recovers the
 * seed model's dimensions end to end, base and derived views anchor the
 * plate, the reference dimension and revision row author on view, the
 * template switches, and the SVG export is byte-stable across re-exports
 * (the s23 and s23b stages, at teaching pace — the BOM and its balloon
 * get their own chapter next).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "drawings",
    title: "Drawing sheets",
    summary:
      "Sheets with recovered dimensions, base and derived views, reference dimensions, revision rows, templates, and byte-stable SVG output.",
    cues: [
      {
        stepId: "boot",
        text: "Drawings turn the model into sheets. Empty until a sheet exists.",
      },
      {
        stepId: "sheet",
        text: "Create sheet recovers the model's dimensions — four, never re-typed.",
      },
      {
        stepId: "views",
        text: "Base views project the plate: Front, Top, and Right.",
      },
      {
        stepId: "section",
        text: "Section A-A cuts through — hatching marks the cut faces.",
      },
      {
        stepId: "reference",
        text: "A reference dimension annotates on top — authored, not recovered.",
      },
      {
        stepId: "revision",
        text: "The revision row logs the change: B, described, on the sheet.",
      },
      {
        stepId: "template",
        text: "Templates resheet the drawing: A4 landscape at one-to-one.",
      },
      {
        stepId: "export",
        text: "Export SVG holds the sheet as bytes — length on the status line.",
      },
      {
        stepId: "stable",
        text: "Export again: identical bytes. Deterministic output, every time.",
      },
      {
        stepId: "recap",
        text: "One drawing surface: sheet, views, annotations, stable output.",
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
    await expect(canvas).toHaveAttribute(
      "aria-label",
      "Drawing canvas: no sheets yet",
    );
    await driver.humanPoint(canvas);
    await driver.dwell();

    await driver.step("sheet");
    await driver.humanClick(page.getByRole("button", { name: "Create sheet" }));
    await expect(status).toHaveAttribute(
      "data-drawing-values",
      '["R4","20","60","40"]',
    );
    await expect(status).toHaveAttribute("data-dims-count", "4");
    await driver.dwell();

    await driver.step("views");
    await driver.humanClick(
      page.getByRole("button", { name: "Front", exact: true }),
    );
    await driver.humanClick(
      page.getByRole("button", { name: "Top", exact: true }),
    );
    await driver.humanClick(
      page.getByRole("button", { name: "Right", exact: true }),
    );
    await expect(canvas).toHaveAttribute("aria-label", /3 views/);
    await driver.dwell();

    await driver.step("section");
    await driver.humanClick(
      page.getByRole("button", { name: "Section A-A", exact: true }),
    );
    await expect(canvas).toHaveAttribute("aria-label", /4 views/);
    await driver.dwell();

    // The dialog openings ride the previous cue's tail, so each cue's beat
    // opens with the dialog it describes already on screen.
    await driver.humanClick(page.getByTestId("drawing-reference-open"));
    const referenceDialog = page.locator(
      '[data-testid="drawing-reference-dialog"]',
    );
    await expect(referenceDialog).toBeVisible();

    await driver.step("reference");
    await driver.humanClick(
      referenceDialog.getByRole("button", {
        name: "Place reference dimension",
      }),
    );
    await expect(referenceDialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-dims-count", "5");
    await driver.dwell();

    await driver.humanClick(page.getByTestId("drawing-revision-open"));
    const revisionDialog = page.locator(
      '[data-testid="drawing-revision-dialog"]',
    );
    await expect(revisionDialog).toBeVisible();

    await driver.step("revision");
    await fillLabeledField(
      page,
      driver,
      revisionDialog.getByLabel("Description"),
      "tutorial revision",
    );
    await driver.humanClick(
      revisionDialog.getByRole("button", { name: "Add revision row" }),
    );
    await expect(revisionDialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-revisions", "1");
    await driver.dwell();

    await driver.humanClick(page.getByTestId("drawing-template-open"));
    const templateDialog = page.locator(
      '[data-testid="drawing-template-dialog"]',
    );
    await expect(templateDialog).toBeVisible();

    await driver.step("template");
    await driver.humanClick(
      templateDialog.getByRole("combobox", { name: "Template" }),
    );
    await driver.humanClick(
      page.getByRole("option", { name: "A4 landscape · 1:1" }),
    );
    await driver.humanClick(
      templateDialog.getByRole("button", { name: "Apply template" }),
    );
    await expect(templateDialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-template", "a4-landscape-1-1");
    await driver.dwell();

    await driver.step("export");
    await driver.humanClick(page.getByTestId("drawing-export"));
    const first = await status.getAttribute("data-drawing-svg");
    expect(first ?? "").toContain('viewBox="0 0 297 210"');
    await driver.pointAtReadout(status);
    await driver.dwell();

    await driver.step("stable");
    await driver.humanClick(page.getByTestId("drawing-export"));
    const second = await status.getAttribute("data-drawing-svg");
    expect(second).toBe(first);
    await driver.pointAtReadout(status);
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
