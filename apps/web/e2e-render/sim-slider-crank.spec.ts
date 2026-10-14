import { expect, test, type Page } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 67c render baselines — the slider-crank mechanism under the
 * determinism rig (SwiftShader software WebGL, fixed 1280×720, DPR 1):
 * the slider-crank demo (the demo-model radio's third preset) saved
 * from the Formedible dynamics form and run through the REAL dynamics
 * engine in the sim worker — the mechanism wire across the compile
 * seam, the 2000-step march, and the dissipated-power preview round
 * applied through the committed-application ledger (law S6). The
 * render suite's discipline (`sim-grid.spec.ts`): byte comparisons on
 * canvas-ELEMENT screenshots, numeric surface assertions beside every
 * pixel assertion, and the committed-application counters awaited —
 * never timeouts.
 *
 *  - the run completes, the honest backend record says "cpu", the
 *    applied overlay names the dissipated-power field, and the
 *    mechanism-motion surface is ready with its full sample ladder;
 *  - the painted pixels are DETERMINISTIC: a full reload that
 *    re-selects, re-saves, and re-runs the same scenario renders
 *    byte-identical canvas bytes (the compile, the mechanism door, the
 *    march, the chunk stream, and the overlay paint are all pure);
 *  - the scrub changes the SURFACE but not the canvas: scrubbing the
 *    motion panel's samples moves the SVG mechanism (the plan-view
 *    polygons), while the settled 3D paint stays byte-identical — the
 *    animation is SVG-as-data, never an ambient render loop (law S6).
 */

const ROOT_ID = "workbench-sim-root";
const VIEWPORT_SELECTOR = `#workbench-sim-viewport canvas`;
const MOTION_SVG = `[data-testid='workbench-sim-mechanism-motion'] svg`;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  crankShot: undefined as Buffer | undefined,
};

/** Reads one root attribute. */
async function rootAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(`#${ROOT_ID}`).getAttribute(name)) ?? "";
}

/** Selects the slider-crank demo, waits for its scene, and settles its form. */
async function selectSliderModel(page: Page): Promise<void> {
  await page.locator("#sim-demo-model-slider").check();
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
}

/** Saves the dynamics form's current values and runs, awaiting the commit. */
async function saveAndRunDynamics(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save dynamics scenario" }).click();
  await page.locator("#workbench-sim-run").click();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-run-status",
    "completed",
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-live-field",
    "dissipated-power",
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

test("the slider-crank runs, applies its dissipation round, and mounts the motion surface", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
  await selectSliderModel(page);

  const chunksBefore = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  await saveAndRunDynamics(page);

  // The committed application: the dissipation preview round advanced
  // the chunk counter, the honest backend is the CPU oracle, and the
  // march's full step ladder applied (2000 steps of 1 ms).
  const chunksAfter = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  expect(chunksAfter).toBeGreaterThan(chunksBefore);
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-served-backend",
    "cpu",
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-applied-progress-step",
    "2000",
  );

  // The mechanism-motion surface: ready, the full sample ladder (50
  // samples of the 40 ms cadence over 2 s), the crank turned and the
  // piston retracted at the mid-march sample.
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-motion",
    "ready",
  );
  await expect(page.locator(MOTION_SVG)).toHaveAttribute(
    "data-sim-motion-samples",
    "50",
  );
  await page.getByTestId("workbench-sim-motion-scrub").fill("25");
  await expect(page.locator(MOTION_SVG)).toHaveAttribute(
    "data-sim-motion-sample",
    "25",
  );
  const crankDeg = Number(
    await page.locator(MOTION_SVG).getAttribute("data-sim-motion-crank-deg"),
  );
  expect(crankDeg).toBeGreaterThan(360);
  const slideMm = Number(
    await page.locator(MOTION_SVG).getAttribute("data-sim-motion-slide-mm"),
  );
  expect(slideMm).toBeLessThan(0);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  shared.crankShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  await saveArtifact("sim-slider-crank-run.png", shared.crankShot);
});

test("a full reload re-runs the slider-crank demo and renders byte-identical pixels", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await selectSliderModel(page);
  await saveAndRunDynamics(page);
  await page.getByTestId("workbench-sim-motion-scrub").fill("25");
  const reloaded = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const crankShot = shared.crankShot;
  expect(
    crankShot,
    "the run test must establish the baseline first",
  ).toBeDefined();
  if (crankShot === undefined) throw new Error("unreachable: checked above");
  expect(
    reloaded.equals(crankShot),
    `reload sha256=${sha256(reloaded)} vs run sha256=${sha256(crankShot)}`,
  ).toBe(true);
  await saveArtifact("sim-slider-crank-reload.png", reloaded);
});

test("scrubbing the motion panel moves the SVG, not the settled canvas", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await selectSliderModel(page);
  await saveAndRunDynamics(page);

  await page.getByTestId("workbench-sim-motion-scrub").fill("0");
  const settled = await page.locator(VIEWPORT_SELECTOR).screenshot();
  const rodAtStart = await page
    .locator(`${MOTION_SVG} polygon[data-part='rod']`)
    .getAttribute("points");
  await page.getByTestId("workbench-sim-motion-scrub").fill("37");
  const rodAtLate = await page
    .locator(`${MOTION_SVG} polygon[data-part='rod']`)
    .getAttribute("points");
  expect(rodAtStart, "the rod polygon must carry its points").toBeDefined();
  expect(rodAtLate).not.toBe(rodAtStart);
  const scrubbed = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const crankShot = shared.crankShot;
  expect(
    crankShot,
    "the run test must establish the baseline first",
  ).toBeDefined();
  if (crankShot === undefined) throw new Error("unreachable: checked above");
  expect(
    scrubbed.equals(settled),
    "the SVG scrub must not repaint the settled canvas",
  ).toBe(true);
  await saveArtifact("sim-slider-crank-scrub.png", scrubbed);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
});
