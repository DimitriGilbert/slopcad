import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";
import {
  SIM_FIXTURE_CHUNKS_PER_ROUND,
  SIM_FIXTURE_COARSE_SHAPE,
  SIM_FIXTURE_FINE_SHAPE,
} from "../src/sim-workbench/sim-grid-fixture";

/**
 * Phase 62c render baselines — the `/workbench-sim` fixture under the
 * determinism rig (SwiftShader software WebGL, fixed 1280×720, DPR 1):
 * the demo body voxelized and rendered as a simulation grid through
 * the Phase 62b overlay family. The render suite's discipline
 * (`render.spec.ts`): byte comparisons on canvas-ELEMENT screenshots,
 * numeric surface assertions beside every pixel assertion, and the
 * committed-application counters awaited — never timeouts.
 *
 *  - the boot state (fine 2 mm occupancy) settles and its overlay
 *    applied: `data-sim-applied-field-chunks` equals the authored
 *    chunk count, the grid state pins the resolved shape, and the
 *    occupied node count proves the part is IN the grid;
 *  - the settled scene is DETERMINISTIC: a full reload renders
 *    byte-identical canvas pixels (voxelization, chunking, decode, and
 *    overlay paint are all pure);
 *  - control changes re-publish and re-apply: the coarse preset and
 *    the signed-distance flag each advance the counters by another
 *    committed round and change BOTH the grid state and the pixels;
 *  - returning to the boot controls reproduces the boot pixels exactly
 *    — the strongest determinism pin (different application history,
 *    identical data).
 */

const ROOT_ID = "workbench-sim-root";
const VIEWPORT_SELECTOR = `#workbench-sim-viewport canvas`;

/** The demo plate minus its ⌀12 through bore, analytic (mm³). */
const ANALYTIC_VOLUME = 80 * 48 * 6 - Math.PI * 6 * 6 * 6;
/** Relative tolerance for worker-measured vs analytic volume. */
const VOLUME_REL_TOLERANCE = 0.005;

/** The fine occupancy grid's total node count (51 × 35 × 10). */
const FINE_TOTAL_NODES =
  SIM_FIXTURE_FINE_SHAPE[0] *
  SIM_FIXTURE_FINE_SHAPE[1] *
  SIM_FIXTURE_FINE_SHAPE[2];

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  bootShot: undefined as Buffer | undefined,
};

/** The applied grid state, parsed. */
interface GridState {
  readonly fieldId: string;
  readonly semantic: string;
  readonly rounds: number;
  readonly shape: readonly number[];
  readonly unit: string;
  readonly occupiedNodes: number | null;
}

/** Reads one root attribute. */
async function rootAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(`#${ROOT_ID}`).getAttribute(name)) ?? "";
}

/** The applied grid state, parsed. */
async function readGridState(page: Page): Promise<GridState> {
  return JSON.parse(
    await rootAttribute(page, "data-sim-grid-state"),
  ) as GridState;
}

/**
 * Waits until the committed grid state names `semantic` at `rounds`,
 * then samples two animation frames — the overlay family's invalidate
 * has flushed its demand frame by then, so a canvas screenshot
 * provably lands after the overlay was drawn (the selection-frame
 * settle protocol, restated for the grid overlay).
 */
async function waitForGridOverlay(
  page: Page,
  semantic: string,
  rounds: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const raw = await rootAttribute(page, "data-sim-grid-state");
        if (raw === "") return null;
        const state = JSON.parse(raw) as {
          readonly semantic: string;
          readonly rounds: number;
        };
        return state.semantic === semantic && state.rounds >= rounds;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

test("the sim fixture settles, applies its grid, and pins the boot numbers", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  const volumeText = await waitForSettledScene(page, ROOT_ID);

  // The demo body: the plate minus its bore, on the analytic band.
  const volume = Number(await rootAttribute(page, "data-volume"));
  expect(Number.isFinite(volume)).toBe(true);
  expect(volumeText).toBe(volume.toFixed(3));
  expect(
    Math.abs(volume - ANALYTIC_VOLUME),
    `volume ${volume} vs analytic ${ANALYTIC_VOLUME}`,
  ).toBeLessThanOrEqual(ANALYTIC_VOLUME * VOLUME_REL_TOLERANCE);
  await expect(page.getByTestId("workbench-sim-error")).toHaveText("");
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-grid-error",
    "",
  );

  // The committed application: the authored chunk count applied, the
  // occupancy grid pinned at the fine preset's resolved shape, and the
  // part provably inside the lattice.
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-applied-field-chunks",
    String(SIM_FIXTURE_CHUNKS_PER_ROUND),
  );
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-applied-notifications",
    String(SIM_FIXTURE_CHUNKS_PER_ROUND),
  );
  const state = await readGridState(page);
  expect(state.fieldId).toBe("sim-demo.occupancy");
  expect(state.semantic).toBe("occupancy");
  expect(state.rounds).toBe(1);
  expect(state.shape).toEqual([...SIM_FIXTURE_FINE_SHAPE]);
  expect(state.unit).toBe("1");
  expect(state.occupiedNodes).not.toBeNull();
  const occupied = state.occupiedNodes ?? 0;
  expect(occupied).toBeGreaterThan(0);
  // The un-bored plate owns 41 × 25 × 4 nodes (the unit battery's
  // exact count); the bore removes a bounded set around the origin.
  expect(occupied).toBeLessThanOrEqual(41 * 25 * 4);
  expect(occupied).toBeGreaterThan(41 * 25 * 4 - 400);
  expect(occupied).toBeLessThan(FINE_TOTAL_NODES);

  await waitForGridOverlay(page, "occupancy", 1);
  shared.bootShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  await saveArtifact("sim-grid-boot.png", shared.bootShot);
});

test("a full reload renders the boot overlay byte-identically", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await waitForGridOverlay(page, "occupancy", 1);
  const reloaded = await page.locator(VIEWPORT_SELECTOR).screenshot();

  const bootShot = shared.bootShot;
  expect(
    bootShot,
    "the boot test must establish the baseline first",
  ).toBeDefined();
  if (bootShot === undefined) throw new Error("unreachable: checked above");
  expect(
    reloaded.equals(bootShot),
    `reload sha256=${sha256(reloaded)} vs boot sha256=${sha256(bootShot)}`,
  ).toBe(true);
  await saveArtifact("sim-grid-reload.png", reloaded);
});

test("resolution and field controls re-apply committed rounds and move pixels", async ({
  page,
}) => {
  await page.goto("/workbench-sim");
  await waitForSettledScene(page, ROOT_ID);
  await waitForGridOverlay(page, "occupancy", 1);
  const bootState = await readGridState(page);
  const bootOccupied = bootState.occupiedNodes;
  const bootShot = await page.locator(VIEWPORT_SELECTOR).screenshot();

  // State B: the coarse preset — a new occupancy round at 26 × 18 × 5.
  await page.locator("#sim-resolution-coarse").check();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-applied-field-chunks",
    String(SIM_FIXTURE_CHUNKS_PER_ROUND * 2),
  );
  await waitForGridOverlay(page, "occupancy", 2);
  const coarseState = await readGridState(page);
  expect(coarseState.shape).toEqual([...SIM_FIXTURE_COARSE_SHAPE]);
  expect(coarseState.rounds).toBe(2);
  const coarseShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  expect(
    coarseShot.equals(bootShot),
    "the coarse grid must differ from the fine grid pixel-wise",
  ).toBe(false);
  await saveArtifact("sim-grid-coarse.png", coarseShot);

  // State C: the signed-distance field — the other semantic's stream.
  await page.locator("#sim-sdf-toggle").check();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-applied-field-chunks",
    String(SIM_FIXTURE_CHUNKS_PER_ROUND * 3),
  );
  await waitForGridOverlay(page, "signed-distance", 1);
  const distanceState = await readGridState(page);
  expect(distanceState.fieldId).toBe("sim-demo.signed-distance");
  expect(distanceState.unit).toBe("mm");
  expect(distanceState.occupiedNodes).toBeNull();
  const distanceShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  expect(
    distanceShot.equals(coarseShot),
    "the distance overlay must differ from the occupancy overlay pixel-wise",
  ).toBe(false);
  await saveArtifact("sim-grid-distance.png", distanceShot);

  // State D: the fine preset back, still on the distance field — the
  // sdf stream's second round at the fine shape.
  await page.locator("#sim-resolution-fine").check();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-applied-field-chunks",
    String(SIM_FIXTURE_CHUNKS_PER_ROUND * 4),
  );
  await waitForGridOverlay(page, "signed-distance", 2);
  expect((await readGridState(page)).shape).toEqual([
    ...SIM_FIXTURE_FINE_SHAPE,
  ]);
  const fineDistanceShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  expect(
    fineDistanceShot.equals(distanceShot),
    "the fine distance grid must differ from the coarse one pixel-wise",
  ).toBe(false);

  // State E: back to occupancy at the fine preset — the occupancy
  // stream's THIRD round re-applies the boot data, and the pixels
  // reproduce the boot bytes exactly (same inputs, same paint, a
  // different application history).
  await page.locator("#sim-sdf-toggle").uncheck();
  await expect(page.locator(`#${ROOT_ID}`)).toHaveAttribute(
    "data-sim-applied-field-chunks",
    String(SIM_FIXTURE_CHUNKS_PER_ROUND * 5),
  );
  await waitForGridOverlay(page, "occupancy", 3);
  const restoredState = await readGridState(page);
  expect(restoredState.shape).toEqual([...SIM_FIXTURE_FINE_SHAPE]);
  expect(restoredState.occupiedNodes).toBe(bootOccupied);
  const restoredShot = await page.locator(VIEWPORT_SELECTOR).screenshot();
  expect(
    restoredShot.equals(bootShot),
    `restored sha256=${sha256(restoredShot)} vs boot sha256=${sha256(bootShot)}`,
  ).toBe(true);
  await saveArtifact("sim-grid-restored.png", restoredShot);
});
