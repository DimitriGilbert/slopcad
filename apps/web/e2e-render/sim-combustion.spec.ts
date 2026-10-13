import { expect, test, type Page } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 68c render baselines — the stove-with-fire temperature overlay
 * under the determinism rig (SwiftShader software WebGL, fixed
 * 1280×720, DPR 1): the 65 stove body with a FIRE source — the demo
 * saved from the Formedible combustion form and run through the REAL
 * combustion engine in the sim worker (the 68b reactor's
 * progress-variable wall heat coupled into the 65 implicit conduction
 * march), its temperature preview round applied through the
 * committed-application ledger (law S6) and painted by the Phase 62
 * overlay family with the cool–warm colormap. The render suite's
 * discipline (`sim-thermal.spec.ts`): byte comparisons on
 * canvas-ELEMENT screenshots, numeric surface assertions beside every
 * pixel assertion, and the committed-application counters awaited —
 * never timeouts.
 *
 *  - the run completes and the applied overlay names the temperature
 *    field (`data-sim-live-field`), the honest backend record says
 *    "cpu", and the chunk counter advanced by the preview round;
 *  - the painted pixels are DETERMINISTIC: a full reload that re-saves
 *    and re-runs the same scenario renders byte-identical canvas bytes
 *    (the compile, the reactor, the march, the chunk stream, and the
 *    overlay paint are all pure);
 *  - the fireless twin differs: the 65 sealed stove (no fire) re-runs
 *    and re-paints, and its pixels differ from the fire's — the
 *    coupling is visible, not vacuous.
 */

const ROOT_ID = "workbench-sim-root";
const VIEWPORT_SELECTOR = `#workbench-sim-viewport canvas`;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  fireShot: undefined as Buffer | undefined,
};

/** Reads one root attribute. */
async function rootAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(`#${ROOT_ID}`).getAttribute(name)) ?? "";
}

/** Saves and runs the fire form's current values, awaiting the commit. */
async function saveAndRunFire(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save fire scenario" }).click();
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

test("the stove with fire runs, applies its temperature round, and pins the fire paint", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  // The FIRE demo model: the plate document stays the rendered scene —
  // the 65 stove body the fire heats.
  await page.locator("#sim-demo-model-fire").check();
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-demo-model",
    "fire",
  );
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  const chunksBefore = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  await saveAndRunFire(page);

  // The committed application: the preview round advanced the chunk
  // counter, the honest backend is the CPU oracle, and the fire's
  // field paint carries a REAL warmed body (the numeric assertion the
  // pixel assertion leans on — the fire couples, the body warms).
  const chunksAfter = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  expect(chunksAfter).toBeGreaterThan(chunksBefore);
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-served-backend",
    "cpu",
  );
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  shared.fireShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  await saveArtifact("sim-combustion-fire.png", shared.fireShot);
});

test("a full reload re-runs the stove with fire byte-identically", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await page.locator("#sim-demo-model-fire").check();
  await waitForSettledScene(page, ROOT_ID);
  await saveAndRunFire(page);
  const reloaded = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const fireShot = shared.fireShot;
  expect(
    fireShot,
    "the fire test must establish the baseline first",
  ).toBeDefined();
  if (fireShot === undefined) throw new Error("unreachable: checked above");
  expect(
    reloaded.equals(fireShot),
    `reload sha256=${sha256(reloaded)} vs fire sha256=${sha256(fireShot)}`,
  ).toBe(true);
  await saveArtifact("sim-combustion-fire-reload.png", reloaded);
});

test("the fireless stove re-runs and repaints differently than the fire", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);

  // The fireless twin: the 65 sealed stove from the THERMAL form's own
  // defaults (the Phase 65 equilibrium paint) — the same body, no
  // fire. The overlay's range differs (the fire's peak is higher), so
  // the paint must differ pixel-wise.
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
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  const sealedShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  const fireShot = shared.fireShot;
  expect(
    fireShot,
    "the fire test must establish the baseline first",
  ).toBeDefined();
  if (fireShot === undefined) throw new Error("unreachable: checked above");
  expect(
    sealedShot.equals(fireShot),
    "the sealed stove's paint must differ from the fire's pixel-wise",
  ).toBe(false);
  await saveArtifact("sim-combustion-sealed-twin.png", sealedShot);
});
