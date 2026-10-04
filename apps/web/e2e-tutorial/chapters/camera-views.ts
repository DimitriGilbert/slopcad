import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ViewportPoint } from "../driver";
import type { ChapterModule } from "../narration";

import {
  cameraAttribute,
  cameraMode,
  rootAttribute,
  VIEWPORT_COMPLETE,
} from "../../e2e-session/helpers";

/**
 * Chapter 9 — the camera. Orbit by dragging the canvas, the view cube and
 * reset, the standard views (Front/Top/Iso), the first/third-angle
 * convention flip, fit, and look-at's selection gate (s04b/s04c's
 * journeys, on a fresh boot plate).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "camera-views",
    title: "The camera: orbit, views, fit",
    summary:
      "Orbiting by drag, the standard views, first and third-angle, fit, and look-at.",
    cues: [
      {
        stepId: "spec-view",
        text: "The camera opens on the document's spec view. Drag the canvas to orbit.",
      },
      {
        stepId: "orbited",
        text: "You own the camera now — the tiny cube tracks your corner.",
      },
      {
        stepId: "reset",
        text: "The reset arrow returns the camera to the document spec.",
      },
      {
        stepId: "front",
        text: "Front is exact: azimuth 270, elevation 0.",
      },
      {
        stepId: "top",
        text: "Top looks straight down the z axis.",
      },
      {
        stepId: "iso",
        text: "Iso frames the near corner — the modeling default.",
      },
      {
        stepId: "convention",
        text: "The frame icon flips the drafting convention. Click it once.",
      },
      {
        stepId: "first-angle",
        text: "First-angle moves the iso corner by ninety degrees.",
      },
      {
        stepId: "back-third",
        text: "Back to third-angle — the views keep their letters.",
      },
      {
        stepId: "fit",
        text: "Fit frames the model's bounds exactly.",
      },
      {
        stepId: "look-at-gated",
        text: "Look-at needs a selection — the crosshair is dim until one exists.",
      },
      {
        stepId: "look-at",
        text: "Pick the plate in the tree, click the crosshair — the camera centers.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("spec-view");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    expect(await rootAttribute(page, "data-viewport-camera-source")).toBe(
      "spec",
    );
    const canvas = page.locator(`#${VIEWPORT_COMPLETE} canvas`);
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      const center: ViewportPoint = {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      };
      await driver.drag(
        { x: center.x - 120, y: center.y },
        { x: center.x + 40, y: center.y - 30 },
      );
    }
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-camera-source"))
      .toBe("user");

    await driver.step("orbited");
    await expect
      .poll(async () => cameraAttribute(page, "commit-count"))
      .toBe("1");
    await driver.humanPoint(page.locator('[data-testid="viewport-view-cube"]'));
    await driver.dwell();

    await driver.step("reset");
    await driver.humanClick(page.locator('[data-testid="view-reset"]'));
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-camera-source"))
      .toBe("spec");

    await driver.step("front");
    await driver.humanClick(page.locator('[data-testid="view-front"]'));
    await expect.poll(async () => cameraMode(page)).toBe("user");
    expect(Number(await cameraAttribute(page, "azimuth-deg"))).toBe(270);
    expect(Number(await cameraAttribute(page, "elevation-deg"))).toBe(0);

    await driver.step("top");
    await driver.humanClick(page.locator('[data-testid="view-top"]'));
    await expect
      .poll(async () => cameraAttribute(page, "azimuth-deg"))
      .toBe("0");

    await driver.step("iso");
    await driver.humanClick(page.locator('[data-testid="view-iso"]'));
    const thirdAngleAzimuth = Number(
      await cameraAttribute(page, "azimuth-deg"),
    );

    await driver.step("convention");
    await driver.humanClick(
      page.locator('[data-testid="view-convention-toggle"]'),
    );
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-convention"))
      .toBe("first-angle");

    await driver.step("first-angle");
    await driver.humanClick(page.locator('[data-testid="view-iso"]'));
    const firstAngleAzimuth = Number(
      await cameraAttribute(page, "azimuth-deg"),
    );
    expect(Math.abs(firstAngleAzimuth - thirdAngleAzimuth)).toBe(90);

    await driver.step("back-third");
    await driver.humanClick(
      page.locator('[data-testid="view-convention-toggle"]'),
    );
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-convention"))
      .toBe("third-angle");

    await driver.step("fit");
    await driver.humanClick(page.locator('[data-testid="view-fit"]'));
    await expect
      .poll(async () => Number(await cameraAttribute(page, "distance-mm")))
      .toBeGreaterThan(0);

    await driver.step("look-at-gated");
    const lookAt = page.locator('[data-testid="view-look-at"]');
    await expect
      .poll(async () =>
        lookAt.evaluate((element) => (element as HTMLButtonElement).disabled),
      )
      .toBe(true);
    await driver.humanPoint(lookAt);
    await driver.dwell();

    await driver.step("look-at");
    await driver.pickTreeNode("body|body_plate");
    await expect
      .poll(async () =>
        lookAt.evaluate((element) => (element as HTMLButtonElement).disabled),
      )
      .toBe(false);
    const distanceBefore = await cameraAttribute(page, "distance-mm");
    await driver.humanClick(lookAt);
    await expect.poll(async () => cameraMode(page)).toBe("user");
    expect(await cameraAttribute(page, "distance-mm")).toBe(distanceBefore);
    await driver.dwell(1_200);
  },
};
