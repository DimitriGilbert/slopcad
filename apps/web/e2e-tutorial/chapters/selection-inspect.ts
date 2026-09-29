import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { dispatchedCount } from "../../e2e-render/helpers";
import {
  COMPLETE,
  COMPLETE_ROOT,
  waitForRootSettle,
} from "../../e2e-session/helpers";

/** The right rail's panel surfaces (the session spec's own selectors). */
const PROPERTY = '[data-slot="cad-property-panel"]';

/**
 * Chapter 5 — selecting and inspecting. A tree pick lights up the right
 * rail, the Properties panel explains the body's provenance, the
 * Measurement block reads the solid live, and a parameter edit makes the
 * geometry follow the number (s05's select-inspect-edit journey, on a
 * fresh boot plate).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "selection-inspect",
    title: "Selecting and inspecting",
    summary:
      "Picking a body, reading the Properties and Measurement panels, and editing a parameter.",
    cues: [
      {
        stepId: "right-rail",
        text: "The right rail: Properties, Parameters, then the Measurement block.",
      },
      {
        stepId: "nothing",
        text: "With nothing selected, the Properties panel says so — honestly.",
      },
      {
        stepId: "pick-body",
        text: "In the model tree, click the plate body. It lights up selected.",
      },
      {
        stepId: "properties",
        text: "Properties answers: name, id, kind — and the feature that produces it.",
      },
      {
        stepId: "measurement",
        text: "Measurement reads the solid live: bounds, volume, area.",
      },
      {
        stepId: "parameters",
        text: "Parameters holds the driving numbers. Find holeDiameter — 8 today.",
      },
      {
        stepId: "edit",
        text: "Click the field, select all, type 10, then Apply.",
      },
      {
        stepId: "follow",
        text: "The bore widens on screen and the volume drops. Geometry follows.",
      },
      {
        stepId: "valid",
        text: "The timeline summary still reads 2 valid — the edit re-ran cleanly.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("right-rail");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.humanPoint(page.locator(PROPERTY));
    await driver.humanPoint(page.locator('[data-slot="cad-parameter-panel"]'));
    await driver.humanPoint(page.locator('section[aria-label="Measurement"]'));
    await driver.dwell();

    await driver.step("nothing");
    const emptyState = page.getByText("Nothing selected.", { exact: true });
    await expect(emptyState).toBeVisible();
    await driver.humanPoint(emptyState);
    await driver.dwell();

    await driver.step("pick-body");
    await driver.pickTreeNode("body|body_plate");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "body|body_plate",
    );

    await driver.step("properties");
    await expect(page.locator(PROPERTY)).toContainText("Produced by");
    await driver.humanPoint(page.locator(PROPERTY).getByText("Produced by"));
    await driver.dwell();

    await driver.step("measurement");
    await expect(page.locator("#workbench-volume-readout")).toContainText(
      "mm³",
    );
    await driver.pointAtReadout(page.locator("#workbench-bounds-readout"));
    await driver.pointAtReadout(page.locator("#workbench-volume-readout"));
    await driver.dwell();

    await driver.step("parameters");
    const holeDiameter = page.getByLabel("holeDiameter", { exact: true });
    await expect(holeDiameter).toHaveValue("8");
    await driver.humanPoint(holeDiameter);
    await driver.dwell();

    await driver.step("edit");
    await driver.humanClick(holeDiameter);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("10");
    const before = await dispatchedCount(page, COMPLETE_ROOT);
    await driver.humanClick(page.getByRole("button", { name: "Apply" }));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-hole-diameter",
      "10",
    );
    const edited = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: before,
    });

    await driver.step("follow");
    expect(Number(edited)).toBeLessThan(Number(bootVolume));
    await driver.pointAtReadout(page.locator("#workbench-volume-readout"));
    await driver.dwell();

    await driver.step("valid");
    await expect(page.getByTestId("timeline-summary")).toHaveText("2 valid");
    await driver.humanPoint(page.getByTestId("timeline-summary"));
    await driver.dwell();
  },
};
