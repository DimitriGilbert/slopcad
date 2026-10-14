import { expect, test, type Page } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 65c render baselines — the temperature overlay under the
 * determinism rig (SwiftShader software WebGL, fixed 1280×720, DPR 1):
 * the demo stove (the heated plate conducting through its wall and
 * losing to air) saved from the Formedible thermal form and run through
 * the REAL thermal engine in the sim worker, its temperature preview
 * round applied through the committed-application ledger (law S6) and
 * painted by the Phase 62 overlay family with the cool–warm colormap.
 * The render suite's discipline (`sim-grid.spec.ts`): byte comparisons
 * on canvas-ELEMENT screenshots, numeric surface assertions beside
 * every pixel assertion, and the committed-application counters
 * awaited — never timeouts.
 *
 *  - the run completes and the applied overlay names the temperature
 *    field (`data-sim-live-field`), the honest backend record says
 *    "cpu", and the chunk counter advanced by the preview round;
 *  - the painted pixels are DETERMINISTIC: a full reload that re-saves
 *    and re-runs the same scenario renders byte-identical canvas bytes
 *    (the compile, the solve, the chunk stream, and the overlay paint
 *    are all pure);
 *  - the second mode is reachable and changes the paint: the coupled
 *    transient stance (the buoyant plume) re-runs and re-paints, and
 *    its pixels differ from the sealed equilibrium's.
 */

const ROOT_ID = "workbench-sim-root";
const VIEWPORT_SELECTOR = `#workbench-sim-viewport canvas`;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  stoveShot: undefined as Buffer | undefined,
};

/** Reads one root attribute. */
async function rootAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(`#${ROOT_ID}`).getAttribute(name)) ?? "";
}

/** Saves and runs the thermal form's current values, awaiting the commit. */
async function saveAndRunThermal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save thermal scenario" }).click();
  await page.locator("#workbench-sim-run").click();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-run-status",
    "completed",
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-live-field",
    "temperature",
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

test("the sealed stove runs, applies its temperature round, and pins the equilibrium paint", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  const chunksBefore = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  await saveAndRunThermal(page);

  // The committed application: the preview round advanced the chunk
  // counter by at least its own chunks (the round's), the honest
  // backend is the CPU oracle, and the run persisted through the store.
  const chunksAfter = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  expect(chunksAfter).toBeGreaterThan(chunksBefore);
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-served-backend",
    "cpu",
  );
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  shared.stoveShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  await saveArtifact("sim-thermal-stove.png", shared.stoveShot);
});

test("a full reload re-runs the sealed stove byte-identically", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await saveAndRunThermal(page);
  const reloaded = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const stoveShot = shared.stoveShot;
  expect(
    stoveShot,
    "the sealed-stove test must establish the baseline first",
  ).toBeDefined();
  if (stoveShot === undefined) throw new Error("unreachable: checked above");
  expect(
    reloaded.equals(stoveShot),
    `reload sha256=${sha256(reloaded)} vs stove sha256=${sha256(stoveShot)}`,
  ).toBe(true);
  await saveArtifact("sim-thermal-stove-reload.png", reloaded);
});

test("the coupled stance re-runs and repaints the plume differently", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);

  // The coupled mode from the same form: transient + the buoyancy flag,
  // a shorter budget so the plume stage stays interactive. The checkbox
  // is the Base UI styled control (the hidden native twin carries the
  // same label — the ROLE query resolves the visible one alone).
  await page.getByLabel("Thermal scenario name").fill("stove-plume");
  await page.getByRole("radio", { name: "Transient march" }).click();
  await page
    .getByRole("checkbox", {
      name: "Conjugate: convect to the fluid (buoyant plume)",
    })
    .click();
  await page.getByLabel("Transient duration (s)").fill("20");
  await page.getByLabel("Sample interval (s)").fill("5");
  await saveAndRunThermal(page);

  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
  const plumeShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  const stoveShot = shared.stoveShot;
  expect(
    stoveShot,
    "the sealed-stove test must establish the baseline first",
  ).toBeDefined();
  if (stoveShot === undefined) throw new Error("unreachable: checked above");
  expect(
    plumeShot.equals(stoveShot),
    "the plume paint must differ from the sealed equilibrium pixel-wise",
  ).toBe(false);
  await saveArtifact("sim-thermal-plume.png", plumeShot);
});
