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
  waitForRootSettle,
} from "../../e2e-session/helpers";

/**
 * Chapter 6 — undo, redo, and the rollback point. A quick pad gives the
 * history something to walk; the History buttons step the document's
 * cursor, the timeline's gaps park everything after a marker, and the
 * command menu clears both marker and selection (s05c's journey, plus
 * s02's history round-trip, on a fresh document).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "undo-redo-rollback",
    title: "Undo, redo, and rollback",
    summary:
      "The history buttons, the timeline's rollback points, and clearing a selection.",
    cues: [
      {
        stepId: "build",
        text: "One quick pad gives the history something to walk. Sketch, draw, extrude.",
      },
      {
        stepId: "history-buttons",
        text: "The History group holds Undo and Redo — the document's cursor.",
      },
      {
        stepId: "undo",
        text: "Undo: the pad leaves, the timeline falls back a chip.",
      },
      {
        stepId: "redo",
        text: "Redo brings it straight back — no rework, no loss.",
      },
      {
        stepId: "gaps",
        text: "Between the timeline chips sit gaps — each a rollback point.",
      },
      {
        stepId: "set-rollback",
        text: "Click the gap after translate. The marker drops in.",
      },
      {
        stepId: "parked",
        text: "Everything after the marker parks — dashed, out of the recipe.",
      },
      {
        stepId: "clear-rollback",
        text: "The command menu's History group: Remove rollback point.",
      },
      {
        stepId: "recovers",
        text: "The chain re-executes — 3 valid — and the pad is back.",
      },
      {
        stepId: "pick-body",
        text: "One more history verb: pick the plate body in the tree.",
      },
      {
        stepId: "clear-selection",
        text: "Clear selection — the menu's deselect — empties the panels again.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("build");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.enterSketchMode();
    await driver.activateSketchTool("rectangle");
    // The create-journey rectangle parked beside the boot plate's footprint
    // (the document scene renders the plate beside the pad — the s07
    // re-baseline; an overlapping pad would bury half its faces in the
    // plate the video must show).
    await driver.clickCanvasPoint(40, 10);
    await driver.clickCanvasPoint(60, 25);
    const before = await dispatchedCount(page, COMPLETE_ROOT);
    await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    await waitForRootSettle(page, COMPLETE_ROOT, { afterDispatch: before });

    const timelineKinds = async (): Promise<string[]> =>
      (await readTimeline(page, COMPLETE_ROOT)).entries.map(
        (entry) => entry.kind,
      );
    await expect
      .poll(timelineKinds, { timeout: 20_000 })
      .toEqual(["translate", "rotate", "extrude"]);

    await driver.step("history-buttons");
    await driver.humanPoint(page.locator(UNDO_BUTTON));
    await driver.humanPoint(page.locator(REDO_BUTTON));
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

    await driver.step("gaps");
    const gaps = page.locator('button[aria-label^="Roll back"]');
    await expect(gaps.first()).toBeAttached();
    await driver.humanPoint(gaps.first());
    await driver.humanPoint(gaps.nth(1));
    await driver.dwell();

    await driver.step("set-rollback");
    await driver.humanClick(
      page.locator('button[aria-label="Roll back after translate"]'),
    );
    await expect(page.locator('[data-testid="rollback-marker"]')).toBeVisible();
    await expect
      .poll(async () => (await readTimeline(page, COMPLETE_ROOT)).rollback)
      .not.toBeNull();

    await driver.step("parked");
    const parkedChips = page.locator(
      '[data-testid="timeline-chip"][data-timeline-status="beyond-rollback"]',
    );
    await expect.poll(async () => parkedChips.count()).toBe(2);
    await expect(page.getByTestId("timeline-summary")).toHaveText(
      "rollback · 1 valid · 2 parked",
    );
    await driver.humanPoint(
      page.locator('[data-testid="timeline-chip"]').nth(2),
    );
    await driver.dwell();

    await driver.step("clear-rollback");
    await driver.openCommandMenu(COMPLETE_ROOT);
    await driver.clickCommandRow(COMPLETE_ROOT, "clear-rollback");

    await driver.step("recovers");
    await expect(page.locator('[data-testid="rollback-marker"]')).toHaveCount(
      0,
    );
    await expect
      .poll(async () => (await readTimeline(page, COMPLETE_ROOT)).rollback)
      .toBeNull();
    await expect(page.getByTestId("timeline-summary")).toHaveText("3 valid");
    await driver.dwell();

    await driver.step("pick-body");
    await driver.pickTreeNode("body|body_plate");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "body|body_plate",
    );

    await driver.step("clear-selection");
    await driver.openCommandMenu(COMPLETE_ROOT);
    await driver.clickCommandRow(COMPLETE_ROOT, "clear-selection");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "",
    );
    await driver.dwell(1_200);
  },
};
