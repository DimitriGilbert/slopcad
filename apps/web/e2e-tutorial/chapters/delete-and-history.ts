import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  COMPLETE,
  COMPLETE_ROOT,
  readTimeline,
  UNDO_BUTTON,
} from "../../e2e-session/helpers";

/** The right rail's property panel (the session spec's own selector). */
const PROPERTY = '[data-slot="cad-property-panel"]';

/**
 * Chapter 7 — deleting features. The boot plate's upstream feature refuses
 * deletion (its consumer still references it) while the leaf deletes
 * through the command vocabulary — and undo restores it exactly (s05d's
 * refusal-and-delete journey, on a fresh document).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "delete-and-history",
    title: "Deleting features",
    summary:
      "Upstream features refuse deletion; leaves delete; undo restores them exactly.",
    cues: [
      {
        stepId: "recipe",
        text: "The boot plate is a recipe: translate, then rotate, both feeding the plate.",
      },
      {
        stepId: "pick-upstream",
        text: "Select the translate feature — the upstream step — in the tree.",
      },
      {
        stepId: "delete-action",
        text: "Properties shows a Delete feature action for the selected feature.",
      },
      {
        stepId: "refusal",
        text: "Click it — and the domain refuses: rotate references this feature.",
      },
      {
        stepId: "refusal-honest",
        text: "The refusal is verbatim, and nothing was issued — the log stands.",
      },
      {
        stepId: "pick-leaf",
        text: "Now the leaf: select the rotate feature.",
      },
      {
        stepId: "delete-leaf",
        text: "Delete feature commits. The timeline falls to translate alone.",
      },
      {
        stepId: "recompute",
        text: "The document recomputes: the plate now depends on translate alone.",
      },
      {
        stepId: "undo",
        text: "Undo restores the leaf exactly — deletes are history too.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("recipe");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.humanPoint(
      page.locator('[data-testid="complete-feature-timeline"]'),
    );
    await driver.dwell();

    await driver.step("pick-upstream");
    await driver.pickTreeNode("feature|feat_translate_plate");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "feature|feat_translate_plate",
    );

    await driver.step("delete-action");
    const deleteFeature = page
      .locator(PROPERTY)
      .getByRole("button", { name: "Delete feature" });
    await expect(deleteFeature).toBeVisible();
    await driver.humanPoint(deleteFeature);
    await driver.dwell();

    await driver.step("refusal");
    const logBeforeRefusal =
      (await page.locator(COMPLETE).getAttribute("data-command-log")) ?? "[]";
    await driver.humanClick(deleteFeature);
    await expect(page.locator(PROPERTY)).toContainText("document/in-use");
    await expect(page.locator(PROPERTY)).toContainText(
      'referenced by feature "feat_rotate_plate"',
    );

    await driver.step("refusal-honest");
    expect(await page.locator(COMPLETE).getAttribute("data-command-log")).toBe(
      logBeforeRefusal,
    );
    await driver.humanPoint(
      page.locator(PROPERTY).getByText("document/in-use"),
    );
    await driver.dwell();

    await driver.step("pick-leaf");
    await driver.pickTreeNode("feature|feat_rotate_plate");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "feature|feat_rotate_plate",
    );

    await driver.step("delete-leaf");
    await driver.humanClick(deleteFeature);
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-command-log",
      /feature\.delete/,
    );
    await expect
      .poll(async () =>
        (await readTimeline(page, COMPLETE_ROOT)).entries.map(
          (entry) => entry.kind,
        ),
      )
      .toEqual(["translate"]);

    await driver.step("recompute");
    await driver.humanPoint(
      page.locator('[data-testid="complete-feature-timeline"]'),
    );
    await driver.dwell();

    await driver.step("undo");
    await driver.humanClick(page.locator(UNDO_BUTTON));
    await expect
      .poll(async () =>
        (await readTimeline(page, COMPLETE_ROOT)).entries.map(
          (entry) => entry.kind,
        ),
      )
      .toEqual(["translate", "rotate"]);
    await driver.dwell(1_200);
  },
};
