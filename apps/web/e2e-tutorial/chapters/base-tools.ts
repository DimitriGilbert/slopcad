import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { COMPLETE, VIEWPORT_COMPLETE } from "../../e2e-session/helpers";

/** The toolbar's tool strip (the session spec's own surface). */
const TOOLBAR = '[data-slot="cad-toolbar"]';

/**
 * Chapter 4 — the base tools. The toolbar's three verbs (Select, Measure,
 * Rotate), the digit shortcuts printed on each button, the status bar's
 * live tool readout, and Escape as the universal cancel (s05b's journey,
 * walked at teaching pace on a fresh boot plate).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "base-tools",
    title: "The base tools",
    summary:
      "Select, Measure, and Rotate in the toolbar, the digit shortcuts, and Escape to cancel.",
    cues: [
      {
        stepId: "strip",
        text: "Three verbs live beside the document plate: Select, Measure, Rotate.",
      },
      {
        stepId: "digits",
        text: "Each button wears its digit. One, two, three arm the tools in order.",
      },
      {
        stepId: "status",
        text: "The status bar echoes the live tool: tool = select (active).",
      },
      {
        stepId: "arm-measure",
        text: "Click Measure. The button stays pressed while the tool is live.",
      },
      {
        stepId: "status-flip",
        text: "The status bar flips too: tool = measure (active).",
      },
      {
        stepId: "cancel",
        text: "Escape cancels a live tool. Focus the viewport, then press it.",
      },
      {
        stepId: "arm-rotate",
        text: "Rotate arms the same way — click it and the pressed state moves.",
      },
      {
        stepId: "shortcut",
        text: "Now the shortcut: with the toolbar focused, press the digit.",
      },
      {
        stepId: "recap",
        text: "Any tool, any time: click it, press its digit, or Escape away.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("strip");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    for (const toolId of ["select", "measure", "rotate"]) {
      await driver.humanPoint(
        page.locator(`${TOOLBAR} button[data-tool-id="${toolId}"]`),
      );
    }
    await driver.dwell();

    await driver.step("digits");
    for (const toolId of ["select", "measure", "rotate"]) {
      await driver.humanPoint(
        page.locator(`${TOOLBAR} button[data-tool-id="${toolId}"] kbd`),
      );
    }
    await driver.dwell();

    await driver.step("status");
    const statusBar = page.locator('[data-slot="cad-status-bar"]');
    await expect(statusBar).toContainText("tool = select (active)");
    await driver.humanPoint(statusBar);
    await driver.dwell();

    await driver.step("arm-measure");
    await driver.humanClick(
      page.locator(`${TOOLBAR} button[data-tool-id="measure"]`),
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-id",
      "measure",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-phase",
      "active",
    );

    await driver.step("status-flip");
    await expect(statusBar).toContainText("tool = measure (active)");
    await driver.humanPoint(statusBar);
    await driver.dwell();

    await driver.step("cancel");
    const viewport = page.locator(
      `#${VIEWPORT_COMPLETE} [aria-label="CAD viewport"]`,
    );
    await driver.humanPoint(viewport);
    await viewport.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-phase",
      "cancelled",
    );

    await driver.step("arm-rotate");
    await driver.humanClick(
      page.locator(`${TOOLBAR} button[data-tool-id="rotate"]`),
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-id",
      "rotate",
    );

    await driver.step("shortcut");
    const selectButton = page.locator(
      `${TOOLBAR} button[data-tool-id="select"]`,
    );
    await driver.humanPoint(selectButton);
    await selectButton.focus();
    await page.keyboard.press("1");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-id",
      "select",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-phase",
      "active",
    );

    await driver.step("recap");
    await driver.humanPoint(
      page.locator(`${TOOLBAR} button[data-tool-id="select"]`),
    );
    await driver.dwell(1_200);
  },
};
