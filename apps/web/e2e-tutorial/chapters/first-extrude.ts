import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { dispatchedCount } from "../../e2e-render/helpers";
import {
  COMPLETE,
  COMPLETE_ROOT,
  readTimeline,
  REDO_BUTTON,
  UNDO_BUTTON,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../../src/cad-workbench/SketchMode";

/** The boot plate's analytic volume (30 × 20 × 10 with the ⌀8 bore) — the
 * document-scene body that renders beside every pad (the s02/s06b pins). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;

/**
 * Chapter 3 — from profile to solid. A fresh boot plate, the top-bar Sketch
 * door, the create-journey rectangle parked beside the plate's footprint,
 * the extrude that turns it into a pad at the default depth, the timeline
 * as the recipe, and undo/redo as the safety net (s02/s06b's create
 * journey, walked at teaching pace).
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
        text: "The 20 by 15 rectangle again: arm the tool, one click per corner.",
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
    // The create-journey rectangle parked at x ∈ [40,60] — beside the boot
    // plate's footprint (the session s07 re-baseline: the document scene
    // renders the plate beside the pad, and an overlapping pad would put
    // the two top faces coplanar in the taught frame).
    await driver.clickCanvasPoint(40, 10);
    await driver.clickCanvasPoint(60, 25);

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
    // Phase 16 document-scene semantics: the plate renders BESIDE the pad,
    // so the settle is the DOCUMENT volume (plate + pad).
    const padAnalytic = 20 * 15 * EXTRUDE_DEFAULT_DEPTH_MM;
    const analytic = BOOT_PLATE_VOLUME + padAnalytic;
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
