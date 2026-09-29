import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ViewportPoint } from "../driver";
import type { ChapterModule } from "../narration";

import {
  cameraAttribute,
  cameraMode,
  rootAttribute,
} from "../../e2e-session/helpers";

/**
 * Chapter 8 — display modes and the zoom window. The view panel's four
 * display modes (Shaded, +Edges, Wire, Hidden) restyle the same solid,
 * and the zoom-window tool magnifies a dragged rectangle (s04d's journey,
 * on a fresh boot plate).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "display-modes",
    title: "Display modes and the zoom window",
    summary: "Shaded, +Edges, Wire, and Hidden — plus dragging a zoom window.",
    cues: [
      {
        stepId: "panel",
        text: "The view panel sits bottom-right: navigation above, display below.",
      },
      {
        stepId: "shaded",
        text: "Shaded is the boot mode — solid faces, lit, no edges.",
      },
      {
        stepId: "edges",
        text: "Click +Edges: the model's edges overlay the faces.",
      },
      {
        stepId: "wire",
        text: "Wire strips to edges alone — pure topology.",
      },
      {
        stepId: "hidden",
        text: "Hidden-line gives the technical-drawing look.",
      },
      {
        stepId: "back-to-shaded",
        text: "Back to Shaded for the rest of the tour.",
      },
      {
        stepId: "front",
        text: "Set a standard view first — Front — then arm the zoom window.",
      },
      {
        stepId: "arm",
        text: "The magnifier arms the zoom window — the viewport says how.",
      },
      {
        stepId: "drag",
        text: "Drag a box over the plate. Release to commit.",
      },
      {
        stepId: "zoomed",
        text: "The camera halves its distance — the model fills the window.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("panel");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.humanPoint(
      page.locator('[data-testid="viewport-view-panel"]'),
    );
    await driver.dwell();

    await driver.step("shaded");
    expect(await rootAttribute(page, "data-viewport-display-mode")).toBe(
      "shaded",
    );
    await driver.humanPoint(
      page.locator('[data-testid="display-mode-shaded"]'),
    );
    await driver.dwell();

    await driver.step("edges");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-shaded-edges"]'),
    );
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
      .toBe("shaded-edges");

    await driver.step("wire");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-wireframe"]'),
    );
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
      .toBe("wireframe");

    await driver.step("hidden");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-hidden-line"]'),
    );
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
      .toBe("hidden-line");

    await driver.step("back-to-shaded");
    await driver.humanClick(
      page.locator('[data-testid="display-mode-shaded"]'),
    );
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
      .toBe("shaded");

    await driver.step("front");
    await driver.humanClick(page.locator('[data-testid="view-front"]'));
    await expect.poll(async () => cameraMode(page)).toBe("user");
    const distanceBeforeZoom = Number(
      await cameraAttribute(page, "distance-mm"),
    );

    await driver.step("arm");
    await driver.humanClick(page.locator('[data-testid="view-zoom-window"]'));
    const layer = page.locator('[data-testid="viewport-zoom-window"]');
    await expect(layer).toBeVisible();
    await driver.dwell();

    await driver.step("drag");
    const zoomBox = await layer.boundingBox();
    expect(zoomBox).not.toBeNull();
    if (zoomBox !== null) {
      const center: ViewportPoint = {
        x: zoomBox.x + zoomBox.width / 2,
        y: zoomBox.y + zoomBox.height / 2,
      };
      const quarter: ViewportPoint = {
        x: zoomBox.width / 4,
        y: zoomBox.height / 4,
      };
      const from: ViewportPoint = {
        x: center.x - quarter.x,
        y: center.y - quarter.y,
      };
      const to: ViewportPoint = {
        x: center.x + quarter.x,
        y: center.y + quarter.y,
      };
      await driver.drag(from, to);
    }

    await driver.step("zoomed");
    await expect
      .poll(async () => Number(await cameraAttribute(page, "distance-mm")))
      .toBeCloseTo(distanceBeforeZoom / 2, 0);
    await expect(layer).toHaveCount(0);
    await driver.dwell(1_200);
  },
};
