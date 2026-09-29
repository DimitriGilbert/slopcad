import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  COMPLETE_ROOT,
  RECT,
  SKETCH,
  waitForRootSettle,
} from "../../e2e-session/helpers";

/** The complete workbench's layout surfaces (the session spec's own consts). */
const TOOLBAR = '[data-slot="cad-toolbar"]';
const TREE = '[data-slot="cad-model-tree"]';

/** The four drawing tools the tour points at (s06's tool set). */
const FOUR_TOOLS = ["line", "circle", "rectangle", "point"] as const;

/**
 * Chapter 2 — the sketch workspace. Where the Sketch entry lives (the
 * command menu's row — s06's own path), what the four drawing tools are,
 * drawing a rectangle corner by corner, and what saving the sketch means.
 */
export const chapter: ChapterModule = {
  definition: {
    id: "sketch-workspace",
    title: "Drawing your first sketch",
    summary:
      "Entering the sketch workspace through the command menu, the drawing tools, and saving a rectangle.",
    cues: [
      {
        stepId: "cockpit",
        text: "The cockpit: toolbar on top, model tree left, timeline strip below.",
      },
      {
        stepId: "menu",
        text: "Every command hides behind this menu button. Click it to open the palette.",
      },
      {
        stepId: "palette",
        text: "The palette lists every verb the workbench ships. A row runs on click.",
      },
      {
        stepId: "sketch-row",
        text: "Find the Sketch row and click it: it opens the 2D drawing workspace.",
      },
      {
        stepId: "workspace",
        text: "Sketch mode: a gridded canvas replaces the 3D view. Squares are 10 mm.",
      },
      {
        stepId: "tools",
        text: "The first cluster holds the drawing tools: line, circle, rectangle, point.",
      },
      {
        stepId: "arm-rectangle",
        text: "Click the rectangle tool to arm it. The status strip confirms the tool.",
      },
      {
        stepId: "first-corner",
        text: "Click once to drop the first corner. The grid reads out in millimeters.",
      },
      {
        stepId: "second-corner",
        text: "Click the opposite corner. The rectangle commits as one closed profile.",
      },
      {
        stepId: "save",
        text: "Save returns to the model. The sketch is now a record solid features use.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    // Chapter 1 ended on the settled workbench; settle defensively.
    await waitForRootSettle(page, COMPLETE_ROOT);

    await driver.step("cockpit");
    await driver.humanPoint(page.locator(TOOLBAR));
    await driver.humanPoint(page.locator(TREE));
    await driver.humanPoint(page.locator("#workbench-complete-viewport"));
    await driver.dwell();

    await driver.step("menu");
    await driver.openCommandMenu(COMPLETE_ROOT);

    await driver.step("palette");
    await driver.dwell(1_200);

    await driver.step("sketch-row");
    await driver.clickCommandRow(COMPLETE_ROOT, "sketch");
    await expect(page.locator(SKETCH)).toBeVisible();

    await driver.step("workspace");
    await driver.dwell(1_200);

    await driver.step("tools");
    for (const toolId of FOUR_TOOLS) {
      await driver.humanPoint(
        page.locator(`[data-sketch-tool-id="${toolId}"]`),
      );
    }
    await driver.dwell();

    await driver.step("arm-rectangle");
    await driver.activateSketchTool("rectangle");

    await driver.step("first-corner");
    await driver.clickCanvasPoint(RECT.x0, RECT.y0);
    await driver.dwell();

    await driver.step("second-corner");
    await driver.clickCanvasPoint(RECT.x1, RECT.y1);
    // The rectangle landed (the session drawRectangle's own pin).
    const entities = JSON.parse(
      (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
    ) as { kind: string }[];
    expect(
      entities.filter((entity) => entity.kind === "rectangle").length,
    ).toBe(1);

    await driver.step("save");
    await driver.humanClick(page.locator('[data-testid="sketch-save"]'));
    await expect(page.locator(`#${COMPLETE_ROOT}`)).toHaveAttribute(
      "data-sketch-mode",
      "model",
    );
  },
};
