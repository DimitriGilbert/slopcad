import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { OCCT_ROOT, readTimeline, volumeNear } from "../../e2e-session/helpers";
import {
  createFeature,
  openFeatureDialog,
  pickComboboxOption,
  saveSketchRecord,
} from "../feature-verbs";

/** The swept tube's analytic volume: the 20 × 20 profile × the 40 mm spine. */
const SWEEP_VOLUME = 20 * 20 * 40;

/**
 * Chapter 13 — the sweep. The OpenCascade workbench (same composition, a
 * BREP kernel that executes what Manifold honestly declines), a profile
 * square and a path spine saved as two sketches, the Sweep form pointed
 * at each, and the undo/redo round trip (session s12's journey, walked
 * at teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "sweep-feature",
    title: "Sweep: profile along a path",
    summary:
      "Saving a profile and a path sketch, sweeping them into a tube, and undo/redo on features.",
    cues: [
      {
        stepId: "occt-route",
        text: "The OpenCascade workbench: same tools, a kernel that sweeps.",
      },
      {
        stepId: "profile",
        text: "Sketch one: a 20 × 20 square. Save it — sweeps need a profile.",
      },
      {
        stepId: "spine-start",
        text: "The path must START at the sketch origin — the tool pins it there.",
      },
      {
        stepId: "spine-end",
        text: "Then run it straight up 40 millimeters — the sweep's spine.",
      },
      {
        stepId: "row",
        text: "Two sketches saved, the Sweep row unlocks. Profile and path: its inputs.",
      },
      {
        stepId: "pick",
        text: "Point the form at sketch 1 for the profile, sketch 2 for the path.",
      },
      {
        stepId: "create",
        text: "Create. The kernel sweeps the square along the spine.",
      },
      {
        stepId: "tube",
        text: "The tube lands on the analytic pin: 20 × 20 × 40 mm³.",
      },
      {
        stepId: "timeline",
        text: "The timeline chip says sweep — a real feature, not a mesh.",
      },
      {
        stepId: "undo",
        text: "Undo removes the sweep; the timeline falls back a chip.",
      },
      {
        stepId: "redo",
        text: "Redo brings the tube straight back — history holds features.",
      },
      {
        stepId: "recap",
        text: "Profile plus path: the sweep recipe. Next, lofts join two profiles.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("occt-route");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.dwell();

    await driver.step("profile");
    // The session's ±10 square shifted into the visible canvas band (the
    // status bar and the surface's clipped bottom band cover workplane
    // y below roughly 5 mm): the same 20 × 20 area, so the same analytic pin.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await driver.clickCanvasPoint(5, 15);
    await driver.clickCanvasPoint(25, 35);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    await driver.step("spine-start");
    // The sweep contract pins the path's start to the sketch origin (the
    // structured refusal says so verbatim), and the origin row sits in
    // the status bar's band — the driver's pinned pick carries it.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("line");
    await driver.pickPinnedCanvasPoint(0, 0);

    await driver.step("spine-end");
    await driver.clickCanvasPoint(0, 40);
    await saveSketchRecord(page, driver, OCCT_ROOT);

    // The cue describes the unlocked Sweep form and its inputs, so its
    // beat opens with the form on screen — the menu journey rides the
    // spine cue's tail.
    await openFeatureDialog(page, driver, OCCT_ROOT, "sweep");
    await driver.step("row");
    await driver.dwell();

    await driver.step("pick");
    await pickComboboxOption(page, driver, 0, "sketch 1");
    await pickComboboxOption(page, driver, 1, "sketch 2");

    await driver.step("create");
    const swept = await createFeature(
      page,
      driver,
      OCCT_ROOT,
      "Create",
      "sweep",
    );

    await driver.step("tube");
    // The s12 pin: the profile's area × the spine's length, exactly.
    expect(volumeNear(Number(swept), SWEEP_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));

    await driver.step("timeline");
    const kinds = async (): Promise<string[]> =>
      (await readTimeline(page, OCCT_ROOT)).entries.map((entry) => entry.kind);
    await expect.poll(kinds, { timeout: 20_000 }).toContain("sweep");
    await driver.humanPoint(
      page.locator('[data-testid="complete-feature-timeline"]'),
    );
    await driver.dwell();

    await driver.step("undo");
    await driver.humanClick(page.locator('button[aria-label="Undo"]'));
    await expect.poll(kinds, { timeout: 20_000 }).not.toContain("sweep");

    await driver.step("redo");
    await driver.humanClick(page.locator('button[aria-label="Redo"]'));
    await expect.poll(kinds, { timeout: 20_000 }).toContain("sweep");

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
