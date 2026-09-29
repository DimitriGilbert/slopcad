import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { dispatchedCount } from "../../e2e-render/helpers";
import {
  DIALOG,
  OCCT_ROOT,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import {
  createFeature,
  drawAndExtrudeRod,
  fillLabeledField,
  openFeatureDialog,
  pickComboboxOption,
} from "../feature-verbs";

/** The s16d/e analytic pins: the plate-with-hole and the united slab. */
const PLATE_60_VOLUME = 60 * 40 * 10;
const PLATE_WITH_HOLE_VOLUME = PLATE_60_VOLUME - Math.PI * 25 * 10;

/** Extrudes one sketched profile at the default depth (the s16d/e body). */
async function extrudeSketch(
  page: Page,
  driver: TutorialDriver,
  toolId: "rectangle" | "circle",
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Promise<void> {
  await driver.enterSketchMode(OCCT_ROOT);
  await driver.activateSketchTool(toolId);
  await driver.clickCanvasPoint(x0, y0);
  await driver.clickCanvasPoint(x1, y1);
  const before = await dispatchedCount(page, OCCT_ROOT);
  await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: before });
}

/**
 * Chapter 20 — combining bodies. Boolean subtract carves a cylinder out of
 * a plate, union joins two touching plates into one slab, and Move body
 * slides the rod without touching its material — three fresh documents,
 * every volume pinned analytically (sessions s16d, s16e, and s16f, at
 * teaching pace on the OCCT route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "booleans",
    title: "Booleans and moving bodies",
    summary:
      "Subtract, union, and the volume-invariant body move — through the command surface.",
    cues: [
      {
        stepId: "subtract-boot",
        text: "Boolean ops. A 60 × 40 plate, then a ⌀10 cylinder inside it.",
      },
      {
        stepId: "subtract-row",
        text: "The Boolean form subtracts by default. Check pad 2, Create.",
      },
      {
        stepId: "removed",
        text: "The cylinder is gone: the plate-with-hole pin, to the digit.",
      },
      {
        stepId: "union-boot",
        text: "Union: two 30 × 40 plates that share an edge.",
      },
      {
        stepId: "union-row",
        text: "Switch the op to Union (join), check pad 2, Create.",
      },
      {
        stepId: "slab",
        text: "One slab: exactly 60 × 40 × 10 mm³.",
      },
      {
        stepId: "move-boot",
        text: "Move body: translation, not geometry. The rod again.",
      },
      {
        stepId: "move-row",
        text: "Offset x = 10, Create.",
      },
      {
        stepId: "invariant",
        text: "The body slides — the volume holds. Moves are transforms.",
      },
      {
        stepId: "recap",
        text: "Subtract removes, union joins, move transports — all features.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("subtract-boot");
    const subtractBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(subtractBoot)).toBeGreaterThan(0);
    // The session's corner-origin bodies shifted into the visible canvas
    // band (the status bar and the surface's clipped bottom band cover
    // workplane y below roughly 5 mm): congruent bodies, so both analytic pins hold.
    await extrudeSketch(page, driver, "rectangle", 5, 15, 65, 55);
    await extrudeSketch(page, driver, "circle", 35, 35, 40, 35);

    // A cue that describes a form starts only when that form is on screen:
    // the menu journey rides the previous cue's tail, which narrates the
    // two bodies the Boolean form is about to combine.
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await driver.step("subtract-row");
    await driver.humanClick(
      page
        .locator(DIALOG)
        .getByRole("checkbox", { name: "pad 2", exact: true }),
    );
    const subtracted = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "boolean"),
    );

    await driver.step("removed");
    expect(volumeNear(subtracted, PLATE_WITH_HOLE_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // The cue names the two edge-sharing plates, so its beat OWNS the
    // journey it narrates: the reset and the re-draws live inside it —
    // never on a result cue's tail, where they would bury the held pin.
    await driver.step("union-boot");
    const unionBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(unionBoot)).toBeGreaterThan(0);
    await extrudeSketch(page, driver, "rectangle", 5, 15, 35, 55);
    await extrudeSketch(page, driver, "rectangle", 35, 15, 65, 55);

    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await driver.step("union-row");
    await pickComboboxOption(page, driver, 0, "Union (join)");
    await driver.humanClick(
      page
        .locator(DIALOG)
        .getByRole("checkbox", { name: "pad 2", exact: true }),
    );
    const united = Number(
      await createFeature(page, driver, OCCT_ROOT, "Create", "boolean"),
    );

    await driver.step("slab");
    expect(volumeNear(united, PLATE_60_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // Same discipline: "The rod again" names the body its beat must show,
    // so the reset and the rod's draw live inside it — never on a result
    // cue's tail, where they would bury the slab's held pin.
    await driver.step("move-boot");
    const moveBoot = await driver.arriveAtWorkbench("occt");
    expect(Number(moveBoot)).toBeGreaterThan(0);
    const rodVolume = await drawAndExtrudeRod(page, driver, OCCT_ROOT);

    await openFeatureDialog(page, driver, OCCT_ROOT, "move-body");
    await driver.step("move-row");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("Offset x (mm)"),
      "10",
    );

    // The move's Create lands inside the invitation cue above; this cue
    // describes the moved body, so it starts once the move has settled.
    // The s16f pin: the move is a TRANSFORM, no re-execution — the plain
    // settle (no dispatch anchor) carries the volume through untouched.
    await driver.humanClick(
      page.locator(DIALOG).getByRole("button", { name: "Create" }),
    );
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-scene-kind",
      "moveBody",
    );
    const moved = await waitForRootSettle(page, OCCT_ROOT);
    expect(volumeNear(Number(moved), Number(rodVolume))).toBe(true);
    await driver.step("invariant");
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
