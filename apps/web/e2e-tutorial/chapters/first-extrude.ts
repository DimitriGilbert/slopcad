import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { dispatchedCount } from "../../e2e-render/helpers";
import {
  COMPLETE,
  COMPLETE_ROOT,
  readTimeline,
  RECT,
  REDO_BUTTON,
  UNDO_BUTTON,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../../src/cad-workbench/SketchMode";

/**
 * Chapter 3 — from profile to solid. A fresh boot plate, the top-bar Sketch
 * door, the same rectangle, the extrude that turns it into a pad at the
 * default depth, the timeline as the recipe, and undo/redo as the safety
 * net (s02/s06b's create journey, walked at teaching pace).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "first-extrude",
    title: "From profile to solid",
    summary:
      "Turning a sketch into a 3D pad, reading the timeline, and undo/redo as the safety net.",
    cues: [
      {
        stepId: "fresh-plate",
        text: "Start from the fresh boot plate. Every session opens on this document.",
      },
      {
        stepId: "sketch-button",
        text: "The Sketch button in the top bar is the second door into the workspace.",
      },
      {
        stepId: "draw-again",
        text: "Same rectangle as before: arm the tool, then one click per corner.",
      },
      {
        stepId: "extrude",
        text: "With a closed profile in place, Extrude turns the sketch into a solid.",
      },
      {
        stepId: "the-pad",
        text: "The pad rises at the default depth of ten millimeters, back in 3D.",
      },
      {
        stepId: "timeline",
        text: "The timeline is the recipe: translate, rotate, extrude. Every chip is editable.",
      },
      {
        stepId: "undo",
        text: "Undo removes the pad. The document falls back to the plate, nothing lost.",
      },
      {
        stepId: "redo",
        text: "Redo brings the pad straight back. History is the safety net while you explore.",
      },
      {
        stepId: "loop",
        text: "That is the core loop: sketch a profile, extrude it, then edit via history.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("fresh-plate");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);

    await driver.step("sketch-button");
    await driver.enterSketchMode();

    await driver.step("draw-again");
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(RECT.x0, RECT.y0);
    await driver.clickCanvasPoint(RECT.x1, RECT.y1);

    await driver.step("extrude");
    const before = await dispatchedCount(page, COMPLETE_ROOT);
    await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const extruded = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: before,
    });

    await driver.step("the-pad");
    // The pad lands on the analytic volume (the s06b pin): area × depth.
    const analytic =
      (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;
    expect(
      volumeNear(Number(extruded), analytic),
      `extruded ${extruded} vs analytic ${String(analytic)}`,
    ).toBe(true);

    await driver.step("timeline");
    const timelineKinds = async (): Promise<string[]> =>
      (await readTimeline(page, COMPLETE_ROOT)).entries.map(
        (entry) => entry.kind,
      );
    await expect
      .poll(timelineKinds, { timeout: 20_000 })
      .toEqual(["translate", "rotate", "extrude"]);
    await driver.humanPoint(
      page.locator('[data-testid="complete-feature-timeline"]'),
    );
    await driver.dwell();

    await driver.step("undo");
    await driver.humanClick(page.locator(UNDO_BUTTON));
    await expect
      .poll(timelineKinds, { timeout: 20_000 })
      .toEqual(["translate", "rotate"]);

    await driver.step("redo");
    await driver.humanClick(page.locator(REDO_BUTTON));
    await expect
      .poll(timelineKinds, { timeout: 20_000 })
      .toEqual(["translate", "rotate", "extrude"]);

    await driver.step("loop");
    await driver.dwell(1_200);
  },
};
