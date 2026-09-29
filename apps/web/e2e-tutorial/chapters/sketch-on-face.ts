import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  dispatchedCount,
  faceWithNormal,
  readFaceAnchors,
} from "../../e2e-render/helpers";
import {
  COMPLETE,
  COMPLETE_ROOT,
  RECT,
  VIEWPORT_COMPLETE,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import { applyFeatureEdit, fillLabeledField } from "../feature-verbs";

/** The pad's analytic volume at the sketch extrude's default depth (s07). */
const BASE_VOLUME = (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * 10;

/**
 * Chapter 12 — building on the solid itself. The base pad from Chapter 3,
 * then the face-selection → sketch-on-face verb: the editor boots on the
 * pad's top face, a second pad rises from it, and the driving-face edit
 * lifts the datum with the number (s07's sketch-on-face journey, walked
 * at teaching pace on the default workbench route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "sketch-on-face",
    title: "Sketching on a face",
    summary:
      "Selecting a solid face, sketching on it, and editing the driving feature by number.",
    cues: [
      {
        stepId: "base",
        text: "Fresh plate. Sketch a rectangle and extrude the base pad.",
      },
      {
        stepId: "top-face",
        text: "To build on a face, first select it: click the pad's top face.",
      },
      {
        stepId: "selection",
        text: "The selection reads face|body_extrude — a real face, addressed.",
      },
      {
        stepId: "command",
        text: "The command menu's Sketch on face keys on that face selection.",
      },
      {
        stepId: "on-face",
        text: "The sketch editor boots ON the face — its datum resolves true.",
      },
      {
        stepId: "draw",
        text: "Draw a rectangle on the face, then extrude: a pad on the pad.",
      },
      {
        stepId: "doubles",
        text: "The document settles at exactly twice the base volume.",
      },
      {
        stepId: "edit",
        text: "Driving-face edit: raise extrudeDepth to 15 and Apply.",
      },
      {
        stepId: "follows",
        text: "The datum lifts with the number — and the face's pad follows.",
      },
      {
        stepId: "recap",
        text: "Faces are anchor surfaces: select one, sketch on it, edit by number.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("base");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.enterSketchMode();
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(RECT.x0, RECT.y0);
    await driver.clickCanvasPoint(RECT.x1, RECT.y1);
    const before = await dispatchedCount(page, COMPLETE_ROOT);
    await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const base = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: before,
    });
    expect(volumeNear(Number(base), BASE_VOLUME)).toBe(true);

    await driver.step("top-face");
    // The published anchor surface names the top face in viewport pixels
    // (s07's discipline — the semantic pick, not a triangle index).
    const anchors = await readFaceAnchors(page, COMPLETE_ROOT);
    const top = faceWithNormal(anchors, [0, 0, 1]);
    const canvas = await page
      .locator(`#${VIEWPORT_COMPLETE} canvas`)
      .boundingBox();
    if (canvas === null) throw new Error("the viewport canvas never mounted");
    await driver.humanClick({
      x: canvas.x + top.anchor.point[0],
      y: canvas.y + top.anchor.point[1],
    });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      new RegExp(`^face\\|body_extrude\\|\\d+\\|${String(top.faceIndex)}$`),
    );

    await driver.step("selection");
    await driver.dwell();

    await driver.step("command");
    // A command, not a dialog: the menu row itself enters the on-face
    // sketch editor keyed on the face selection (s07's runCommand path).
    await driver.openCommandMenu(COMPLETE_ROOT);
    await driver.clickCommandRow(COMPLETE_ROOT, "sketch-on-face");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-sketch-mode",
      "sketch",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-datums",
      /^\[\{.*"resolved":true.*\}\]$/,
    );

    await driver.step("on-face");
    await driver.dwell();

    await driver.step("draw");
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(RECT.x0, RECT.y0);
    await driver.clickCanvasPoint(RECT.x1, RECT.y1);
    const beforePad = await dispatchedCount(page, COMPLETE_ROOT);
    await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-sketch-mode",
      "model",
    );
    const padded = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: beforePad,
    });
    expect(volumeNear(Number(padded), BASE_VOLUME * 2)).toBe(true);

    await driver.step("doubles");
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("edit");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("extrudeDepth", { exact: true }),
      "15",
    );
    const edited = await applyFeatureEdit(page, driver, COMPLETE_ROOT);

    await driver.step("follows");
    // The s07 pins: base + a 15 mm pad is 2.5 × base, and the datum's
    // origin rides the driving face to z = 15.
    expect(volumeNear(Number(edited), BASE_VOLUME * 2.5)).toBe(true);
    const datums = JSON.parse(
      (await page.locator(COMPLETE).getAttribute("data-datums")) ?? "[]",
    ) as { resolved: boolean; origin: readonly [number, number, number] }[];
    expect(datums).toHaveLength(1);
    expect(datums[0]?.resolved).toBe(true);
    expect(datums[0]?.origin[2]).toBeCloseTo(15, 6);

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
