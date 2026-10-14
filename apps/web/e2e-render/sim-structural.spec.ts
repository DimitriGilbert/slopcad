import { expect, test, type Page } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 69 render baselines — the displacement overlay under the
 * determinism rig (SwiftShader software WebGL, fixed 1280×720, DPR 1):
 * the demo bracket (the bolted L-bracket with the −y tip load) saved
 * from the Formedible structural form and run through the REAL coarse
 * voxel FEM engine in the sim worker, its displacement preview round
 * applied through the committed-application ledger (law S6) and painted
 * by the Phase 62 overlay family with the viridis colormap over the
 * field's own range. The render suite's discipline (`sim-grid.spec.ts`
 * and `sim-thermal.spec.ts`): byte comparisons on canvas-ELEMENT
 * screenshots, numeric surface assertions beside every pixel
 * assertion, and the committed-application counters awaited — never
 * timeouts.
 *
 *  - the run completes and the applied overlay names the displacement
 *    field (`data-sim-live-field`), the honest backend record says
 *    "cpu", and the chunk counter advanced by the preview rounds;
 *  - the painted pixels are DETERMINISTIC: a full reload that re-saves
 *    and re-runs the same scenario renders byte-identical canvas bytes
 *    (the compile, the voxelization, the solve, the chunk stream, and
 *    the overlay paint are all pure);
 *  - the second stance is reachable and changes the paint: the
 *    self-weight variant (the body-force switch on) re-runs and
 *    repaints, and its pixels differ from the dry bracket's.
 */

const ROOT_ID = "workbench-sim-root";
const VIEWPORT_SELECTOR = `#workbench-sim-viewport canvas`;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  bracketShot: undefined as Buffer | undefined,
};

/** Reads one root attribute. */
async function rootAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(`#${ROOT_ID}`).getAttribute(name)) ?? "";
}

/** Switches to the bracket model, saves the form's values, and runs to completion. */
async function saveAndRunBracket(page: Page): Promise<void> {
  await page.locator("#sim-demo-model-bracket").check();
  await waitForSettledScene(page, ROOT_ID);
  await page.getByRole("button", { name: "Save structural scenario" }).click();
  await page.locator("#workbench-sim-run").click();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-run-status",
    "completed",
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-live-field",
    "displacement",
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

test("the dry bracket runs, applies its displacement round, and pins the paint", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  const chunksBefore = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  await saveAndRunBracket(page);

  // The committed application: both preview rounds (von Mises, then the
  // displacement block applied last) advanced the chunk counter, the
  // honest backend is the CPU oracle, and the run persisted.
  const chunksAfter = Number(
    await rootAttribute(page, "data-sim-applied-field-chunks"),
  );
  expect(chunksAfter).toBeGreaterThan(chunksBefore);
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-served-backend",
    "cpu",
  );
  const deflection = Number(
    await rootAttribute(page, "data-sim-structural-deflection-mm"),
  );
  expect(deflection).toBeGreaterThan(0);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");

  shared.bracketShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  await saveArtifact("sim-structural-bracket.png", shared.bracketShot);
});

test("a full reload re-runs the dry bracket byte-identically", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await saveAndRunBracket(page);
  const reloaded = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const bracketShot = shared.bracketShot;
  expect(
    bracketShot,
    "the dry-bracket test must establish the baseline first",
  ).toBeDefined();
  if (bracketShot === undefined) throw new Error("unreachable: checked above");
  expect(
    reloaded.equals(bracketShot),
    `reload sha256=${sha256(reloaded)} vs bracket sha256=${sha256(bracketShot)}`,
  ).toBe(true);
  await saveArtifact("sim-structural-bracket-reload.png", reloaded);
});

test("the self-weight stance re-runs and repaints differently", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);

  // The self-weight variant from the same form: the body-force switch
  // on, a distinct name — gravity's share of the load bends the wall a
  // little more, and the paint (over the field's own range) follows.
  await page.locator("#sim-demo-model-bracket").check();
  await waitForSettledScene(page, ROOT_ID);
  await page.getByLabel("Structural scenario name").fill("bracket-heavy");
  await page
    .getByRole("checkbox", {
      name: "Self-weight (the scenario's gravity vector)",
    })
    .click();
  await page.getByRole("button", { name: "Save structural scenario" }).click();
  await page.locator("#workbench-sim-run").click();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-run-status",
    "completed",
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-live-field",
    "displacement",
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
  const heavyShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  const bracketShot = shared.bracketShot;
  expect(
    bracketShot,
    "the dry-bracket test must establish the baseline first",
  ).toBeDefined();
  if (bracketShot === undefined) throw new Error("unreachable: checked above");
  expect(
    heavyShot.equals(bracketShot),
    "the self-weight paint must differ from the dry bracket pixel-wise",
  ).toBe(false);
  await saveArtifact("sim-structural-bracket-heavy.png", heavyShot);
});
