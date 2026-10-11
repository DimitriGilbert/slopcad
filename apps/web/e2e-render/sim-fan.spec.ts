import { expect, test, type Page } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 66c render baselines — the fan velocity overlay under the
 * determinism rig (SwiftShader software WebGL, fixed 1280×720, DPR 1):
 * the fan-in-tube demo (the demo-model radio's second preset) saved
 * from the Formedible fan form and run through the REAL 3D engine in
 * the sim worker — the motor-driven path that sweeps the ladder,
 * solves the operating point, and streams the verification rung's 3D
 * speed field. The overlay applies through the committed-application
 * ledger (law S6) and paints the 3D block's mid-height slice (the
 * rotor's plane) with the viridis colormap. The render suite's
 * discipline (`sim-grid.spec.ts`): byte comparisons on canvas-ELEMENT
 * screenshots, numeric surface assertions beside every pixel
 * assertion, and the committed-application counters awaited — never
 * timeouts.
 *
 *  - the run completes, the honest backend record says "cpu", the
 *    applied overlay names the speed field, and the operating-point
 *    family is visible on the surface (the found rpm inside the
 *    motor's domain, the chart rendered);
 *  - the painted pixels are DETERMINISTIC: a full reload that
 *    re-selects, re-saves, and re-runs the same scenario renders
 *    byte-identical canvas bytes (the compile, the voxelization, the
 *    ladder sweep, the solve, the chunk stream, and the overlay paint
 *    are all pure);
 *  - the fixed-rpm mode is reachable and changes the paint: the
 *    authored-rate stance re-runs and re-paints, and its pixels
 *    differ from the motor-driven run's.
 */

const ROOT_ID = "workbench-sim-root";
const VIEWPORT_SELECTOR = `#workbench-sim-viewport canvas`;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  fanShot: undefined as Buffer | undefined,
};

/** Reads one root attribute. */
async function rootAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(`#${ROOT_ID}`).getAttribute(name)) ?? "";
}

/** Selects the fan demo, waits for its scene, and settles its form. */
async function selectFanModel(page: Page): Promise<void> {
  await page.locator("#sim-demo-model-fan").check();
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
}

/** Saves the fan form's current values and runs, awaiting the commit. */
async function saveAndRunFan(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save fan scenario" }).click();
  await page.locator("#workbench-sim-run").click();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-run-status",
    "completed",
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-live-field",
    "speed",
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

test("the motor-driven fan runs, applies its 3D speed round, and paints the operating point's field", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
  await selectFanModel(page);

  const chunksBefore = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  await saveAndRunFan(page);

  // The committed application: the verification rung's preview rounds
  // advanced the chunk counter, the honest backend is the CPU oracle,
  // and the operating-point family is on the surface (the found rpm
  // strictly inside the demo motor's 40 rpm domain, the chart ready).
  const chunksAfter = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  expect(chunksAfter).toBeGreaterThan(chunksBefore);
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-served-backend",
    "cpu",
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-fan-chart",
    "ready",
  );
  const foundRpm = Number(await rootAttribute(page, "data-sim-fan-op-rpm"));
  expect(foundRpm).toBeGreaterThan(1);
  expect(foundRpm).toBeLessThan(39);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  shared.fanShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  await saveArtifact("sim-fan-motor-driven.png", shared.fanShot);
});

test("a full reload re-runs the fan demo and renders byte-identical pixels", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await selectFanModel(page);
  await saveAndRunFan(page);
  const reloaded = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const fanShot = shared.fanShot;
  expect(
    fanShot,
    "the motor-driven test must establish the baseline first",
  ).toBeDefined();
  if (fanShot === undefined) throw new Error("unreachable: checked above");
  expect(
    reloaded.equals(fanShot),
    `reload sha256=${sha256(reloaded)} vs motor-driven sha256=${sha256(fanShot)}`,
  ).toBe(true);
  await saveArtifact("sim-fan-reload.png", reloaded);
});

test("the fixed-rpm stance re-runs and changes the paint", async ({ page }) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await selectFanModel(page);

  // Flip the RPM mode to the fixed rate (the motor-less door) and
  // re-run: a single MRF rung at the authored rate — different physics,
  // different paint.
  await page.getByRole("radio", { name: "Fixed rpm (motor-less)" }).click();
  await saveAndRunFan(page);
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-fan-chart",
    "",
  );
  const fixedShot = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const fanShot = shared.fanShot;
  expect(
    fanShot,
    "the motor-driven test must establish the baseline first",
  ).toBeDefined();
  if (fanShot === undefined) throw new Error("unreachable: checked above");
  expect(
    fixedShot.equals(fanShot),
    "the fixed-rpm paint must differ from the motor-driven paint pixel-wise",
  ).toBe(false);
  await saveArtifact("sim-fan-fixed-rpm.png", fixedShot);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
});
