import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "./driver";

import { dispatchedCount } from "../e2e-render/helpers";
import { DIALOG, waitForRootSettle } from "../e2e-session/helpers";

/**
 * The feature-authoring batch's shared teaching verbs: the session helpers'
 * dialog step library (`openDialogViaMenu`, `submitDialogAndSettle`, the
 * sketch-pool unlocks) re-walked at pointer-first tutorial pace. Every
 * interaction still flows through the driver — these composites only
 * sequence glides, clicks, and the session's own machine-paced settle
 * waits, so the recorded video shows WHERE each dialog input lives.
 */

/**
 * Opens a feature dialog through its exact command-menu row (the session
 * `openDialogViaMenu` journey, human-paced — never a fuzzy query).
 */
export async function openFeatureDialog(
  page: Page,
  driver: TutorialDriver,
  rootId: string,
  commandId: string,
): Promise<void> {
  await driver.openCommandMenu(rootId);
  await driver.clickCommandRow(rootId, commandId);
  await expect(page.locator(DIALOG)).toBeVisible();
}

/**
 * Fills one labeled dialog/panel field the way a viewer learns it: glide
 * into the field, click it, select all, type the value.
 */
export async function fillLabeledField(
  page: Page,
  driver: TutorialDriver,
  field: Locator,
  value: string,
): Promise<void> {
  await driver.humanClick(field);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(value);
}

/**
 * Picks one option out of a dialog combobox: open the list, glide to the
 * row, click it. `exact` defaults to true (the sketch picks must not
 * substring-match "sketch 11"); the surface-thicken sheet names are
 * descriptive labels, so that pick passes false — the session's own
 * substring match.
 */
export async function pickComboboxOption(
  page: Page,
  driver: TutorialDriver,
  index: number,
  optionName: string,
  exact = true,
): Promise<void> {
  await driver.humanClick(
    page.locator(`${DIALOG} [role="combobox"]`).nth(index),
  );
  await driver.humanClick(
    page.getByRole("option", { name: optionName, exact }),
  );
}

/**
 * Submits the open feature dialog (Create / Create datum / Trim sheet …)
 * and settles the re-dispatched scene. Asserts the scene kind when given;
 * the surface ops keep the kind they came with, so they pass none.
 */
export async function createFeature(
  page: Page,
  driver: TutorialDriver,
  rootId: string,
  submitLabel: string,
  sceneKind?: string,
): Promise<string> {
  const before = await dispatchedCount(page, rootId);
  await driver.humanClick(
    page.locator(DIALOG).getByRole("button", { name: submitLabel }),
  );
  await expect(page.locator(DIALOG)).toBeHidden();
  if (sceneKind !== undefined) {
    await expect(page.locator(`#${rootId}`)).toHaveAttribute(
      "data-scene-kind",
      sceneKind,
    );
  }
  return waitForRootSettle(page, rootId, { afterDispatch: before });
}

/**
 * Applies the parameter-panel edit of the last feature (the session's
 * fill-then-Apply journey, pointer-first on the Apply click).
 */
export async function applyFeatureEdit(
  page: Page,
  driver: TutorialDriver,
  rootId: string,
): Promise<string> {
  const before = await dispatchedCount(page, rootId);
  await driver.humanClick(page.getByRole("button", { name: "Apply" }));
  return waitForRootSettle(page, rootId, { afterDispatch: before });
}

/**
 * Saves the current sketch drawing as a standalone record (the session
 * `saveSketch` step, human-paced).
 */
export async function saveSketchRecord(
  page: Page,
  driver: TutorialDriver,
  rootId: string,
): Promise<void> {
  await driver.humanClick(page.locator('[data-testid="sketch-save"]'));
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
}

/**
 * Saves a throwaway one-line sketch: the sketch-feature command rows gate
 * on a pool of two sketches or more, so a document teaching helix/rib/
 * draft needs its unlock line (the session `saveThrowawaySketch` step).
 */
export async function saveThrowawayLine(
  page: Page,
  driver: TutorialDriver,
  rootId: string,
): Promise<void> {
  await driver.enterSketchMode(rootId);
  await driver.activateSketchTool("line");
  await driver.clickCanvasPoint(40, 40);
  await driver.clickCanvasPoint(45, 45);
  await saveSketchRecord(page, driver, rootId);
}

/** Where the teaching rod's circle is centered (workplane mm). */
export interface RodPlacement {
  readonly xMm: number;
  readonly yMm: number;
  /**
   * True when the placement sits in the status bar's hidden band — the
   * picks ride the driver's pinned-point verb (the thread cut is pinned
   * to the world-Z axis at the origin, so its rod must live there).
   */
  readonly pinned?: boolean;
}

/**
 * Draws and extrudes the ⌀6 rod (the session `drawAndExtrudeRod` step):
 * a circle through (center + 3, center), extruded at the default depth —
 * the base body the thread/rib/scale/pattern journeys stand on. The
 * default placement sits in the visible canvas band; the thread's
 * origin-pinned placement rides the pinned picks.
 */
export async function drawAndExtrudeRod(
  page: Page,
  driver: TutorialDriver,
  rootId: string,
  placement: RodPlacement = { xMm: 10, yMm: 20 },
): Promise<string> {
  await driver.enterSketchMode(rootId);
  await driver.activateSketchTool("circle");
  if (placement.pinned === true) {
    await driver.pickPinnedCanvasPoint(placement.xMm, placement.yMm);
    await driver.pickPinnedCanvasPoint(placement.xMm + 3, placement.yMm);
  } else {
    await driver.clickCanvasPoint(placement.xMm, placement.yMm);
    await driver.clickCanvasPoint(placement.xMm + 3, placement.yMm);
  }
  const before = await dispatchedCount(page, rootId);
  await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  return waitForRootSettle(page, rootId, { afterDispatch: before });
}
