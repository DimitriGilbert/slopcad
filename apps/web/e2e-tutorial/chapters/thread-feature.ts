import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  OCCT_ROOT,
  readTimeline,
  REDO_BUTTON,
  UNDO_BUTTON,
} from "../../e2e-session/helpers";
import {
  applyFeatureEdit,
  createFeature,
  drawAndExtrudeRod,
  fillLabeledField,
  openFeatureDialog,
} from "../feature-verbs";

/** The ⌀6 rod's analytic volume (session s13b's base). */
const ROD_VOLUME = Math.PI * 9 * 10;
/** The ISO thread's derived tool volume (session s13b's band anchors). */
const ISO_THREAD_DEPTH_MM = (5 * Math.sqrt(3)) / 16;
const GROOVE_CENTROID_OFFSET_MM =
  (ISO_THREAD_DEPTH_MM / 3) * ((2 * (1 / 4) + 7 / 8) / (1 / 4 + 7 / 8));
const THREAD_TOOL_VOLUME =
  2 *
  Math.PI *
  6 *
  ((45 * Math.sqrt(3)) / 256) *
  (3 - GROOVE_CENTROID_OFFSET_MM);

/**
 * Chapter 16 — the thread. The rod from the sketch extrude, the Thread
 * form's containment band, the length edit that cuts deeper, and the
 * history walk that separates a parameter edit from the feature itself
 * (session s13b's journey, at teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "thread-feature",
    title: "Threads and their history",
    summary:
      "The thread feature on its containment band, a deeper re-drive, and walking it in history.",
    cues: [
      {
        stepId: "rod",
        text: "The ⌀6 rod at the origin — the thread cuts on the world Z axis.",
      },
      {
        stepId: "row",
        text: "The Thread form targets the extrusion by default. Create.",
      },
      {
        stepId: "band",
        text: "The ISO profile cuts a groove — inside the derived band.",
      },
      {
        stepId: "edit",
        text: "threadLength1 goes to 8; Apply re-drives the cut deeper.",
      },
      {
        stepId: "deeper",
        text: "Deeper thread, less material — the volume drops on schedule.",
      },
      {
        stepId: "undo-edit",
        text: "The last transaction was the edit: undo reverts just the number.",
      },
      {
        stepId: "undo-thread",
        text: "A second undo removes the thread feature itself.",
      },
      {
        stepId: "redo",
        text: "Redo restores it — valid, and back in the timeline.",
      },
      {
        stepId: "recap",
        text: "Threads are features: cut, re-drive, and walk them in history.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("rod");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeGreaterThan(0);
    // The thread cut spirals on the WORLD Z axis, so the rod must sit at
    // the origin — the hidden row the driver's pinned picks carry.
    const rod = await drawAndExtrudeRod(page, driver, OCCT_ROOT, {
      xMm: 0,
      yMm: 0,
      pinned: true,
    });
    expect(Number(rod)).toBeGreaterThan(0);

    // The cue describes the open Thread form's default target, so its
    // beat opens with the form on screen — the menu journey rides the rod
    // cue's tail.
    await openFeatureDialog(page, driver, OCCT_ROOT, "thread");
    await driver.step("row");
    const threaded = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "thread"),
    );

    await driver.step("band");
    // The s13b containment band: the tool's full cut at most, 83 % at least.
    expect(threaded).toBeGreaterThanOrEqual(ROD_VOLUME - THREAD_TOOL_VOLUME);
    expect(threaded).toBeLessThanOrEqual(
      ROD_VOLUME - THREAD_TOOL_VOLUME * 0.83,
    );
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("edit");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("threadLength1", { exact: true }),
      "8",
    );
    const redriven = Number(await applyFeatureEdit(page, driver, OCCT_ROOT));

    await driver.step("deeper");
    expect(redriven).toBeLessThan(threaded);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("undo-edit");
    // The s13b history walk: the LAST transaction was the parameter edit,
    // so the first undo reverts the number with the entries unchanged.
    const threadEntries = (await readTimeline(page, OCCT_ROOT)).entries.length;
    await driver.humanClick(page.locator(UNDO_BUTTON));
    await page.waitForFunction(
      ({ id, count }) =>
        (
          JSON.parse(
            document
              .getElementById(id)
              ?.getAttribute("data-feature-timeline") ?? "{}",
          ) as { entries: unknown[] }
        ).entries.length === count,
      { id: OCCT_ROOT, count: threadEntries },
    );

    await driver.step("undo-thread");
    await driver.humanClick(page.locator(UNDO_BUTTON));
    await page.waitForFunction(
      ({ id, count }) =>
        (
          JSON.parse(
            document
              .getElementById(id)
              ?.getAttribute("data-feature-timeline") ?? "{}",
          ) as { entries: unknown[] }
        ).entries.length ===
        count - 1,
      { id: OCCT_ROOT, count: threadEntries },
    );

    await driver.step("redo");
    await driver.humanClick(page.locator(REDO_BUTTON));
    await page.waitForFunction(
      ({ id, count, kind }) => {
        const timeline = JSON.parse(
          document.getElementById(id)?.getAttribute("data-feature-timeline") ??
            "{}",
        ) as { entries: readonly { kind: string; status: string }[] };
        return (
          timeline.entries.length === count &&
          timeline.entries.some(
            (entry) => entry.kind === kind && entry.status === "valid",
          )
        );
      },
      { id: OCCT_ROOT, count: threadEntries, kind: "thread" },
    );

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
