import { expect, test } from "@playwright/test";

import {
  readVolume,
  saveArtifact,
  sha256,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 11.3 deterministic-scene e2e — the phase-level browser gate.
 * Validation criteria from the plan:
 *  - the settled scene is DETERMINISTIC: two consecutive full runs render
 *    byte-identical canvas pixels under SwiftShader software WebGL;
 *  - the screenshot BASELINE is stable: a second browser context (and, per
 *    the spike's evidence semantics, a separate capture in the first
 *    context) reproduces the same bytes;
 *  - a parameter change alters BOTH the rendered pixels (pixel-diff > 0)
 *    and the numeric surface (volume) — model update replaces the previous
 *    result;
 *  - the creation/update workflow is captured on video (config-level
 *    `video: "on"` + the video-artifact reporter).
 *
 * Byte comparisons use Playwright `Buffer.equals` on canvas-ELEMENT
 * screenshots (the spike's masking lesson: element captures exclude page
 * chrome and scrollbars, so no non-determinism can leak in from outside the
 * canvas), and every pixel assertion stands beside the numeric volume
 * assertions — geometry correctness is proven by the numbers, pixels cover
 * the composed scene. Runs against the production build (see
 * playwright.render.config.ts). Shared waits/artifact helpers live in
 * `./helpers` (also used by the Phase 12 selection spec).
 */

const PLATE_WIDTH_MM = 30;
const PLATE_DEPTH_MM = 20;
const PLATE_HEIGHT_MM = 10;

/** Relative tolerance for worker-measured vs analytic volume (spike: ≤ ~0.5%). */
const VOLUME_REL_TOLERANCE = 0.005;

/** The document default bore diameter (mm): the spike's original 8 mm. */
const DEFAULT_HOLE_DIAMETER_MM = 8;
/** The enlarged bore diameter (mm) the update test drills. */
const ENLARGED_HOLE_DIAMETER_MM = 14;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  /** State-A capture from the creation/update test (defaults, settled). */
  stateA: undefined as Buffer | undefined,
  /** The first determinism run's bytes — the baseline other runs reproduce. */
  determinismRun1: undefined as Buffer | undefined,
};

function analyticPlateVolume(holeDiameterMm: number): number {
  return (
    PLATE_WIDTH_MM * PLATE_DEPTH_MM * PLATE_HEIGHT_MM -
    Math.PI * (holeDiameterMm / 2) ** 2 * PLATE_HEIGHT_MM
  );
}

function expectVolumeCloseTo(actual: number, expected: number): void {
  expect(
    Math.abs(actual - expected),
    `volume ${actual} vs analytic ${expected}`,
  ).toBeLessThanOrEqual(expected * VOLUME_REL_TOLERANCE);
}

test("parameter change recomputes the projection and updates pixels and volume", async ({
  page,
}) => {
  await page.goto("/render");
  const volumeTextA = await waitForSettledScene(page);

  // State A: hole diameter 8 (document defaults). The scene's settle stamp
  // matches the settled volume, and that volume is the analytic plate.
  expect(volumeTextA).toBe((await readVolume(page)).toFixed(3));
  const volumeA = await readVolume(page);
  expectVolumeCloseTo(volumeA, analyticPlateVolume(DEFAULT_HOLE_DIAMETER_MM));
  await expect(page.locator("#render-bounds")).toHaveText(
    `${PLATE_WIDTH_MM}.000 × ${PLATE_DEPTH_MM}.000 × ${PLATE_HEIGHT_MM}.000`,
  );
  await expect(page.locator("#render-triangles")).toHaveText(/[1-9]\d*/);
  await expect(page.getByTestId("render-error")).toHaveText("");
  const shotA = await page.locator("#render-viewport canvas").screenshot();
  shared.stateA = shotA;
  await saveArtifact("state-a.png", shotA);

  // State B: enlarge the bore to diameter 14 through the parameter input —
  // a full model update through worker → projection → scene.
  await page
    .locator("#param-holeDiameter")
    .fill(String(ENLARGED_HOLE_DIAMETER_MM));
  const volumeTextB = await waitForSettledScene(page);
  expect(volumeTextB).not.toBe(volumeTextA);
  const volumeB = await readVolume(page);
  expectVolumeCloseTo(volumeB, analyticPlateVolume(ENLARGED_HOLE_DIAMETER_MM));
  expect(volumeB).toBeLessThan(volumeA);
  await expect(page.getByTestId("render-error")).toHaveText("");
  const shotB = await page.locator("#render-viewport canvas").screenshot();

  // The parameter change is visible in the rendered pixels: pixel-diff > 0.
  expect(
    shotB.equals(shotA),
    "state B canvas must differ from state A pixel-wise",
  ).toBe(false);

  await saveArtifact("state-b.png", shotB);
  await page.screenshot({
    path: "e2e-artifacts/render/state-b-fullpage.png",
    fullPage: true,
  });
});

test("two consecutive full runs render byte-identical scenes", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const volumeFirst = await readVolume(page);
  const shotFirst = await page.locator("#render-viewport canvas").screenshot();

  // A full second run: fresh document load, fresh worker, fresh kernel
  // computation — same parameters, so the same settled scene must result.
  await page.reload();
  await waitForSettledScene(page);
  const volumeSecond = await readVolume(page);
  const shotSecond = await page.locator("#render-viewport canvas").screenshot();

  expect(volumeSecond).toBe(volumeFirst);
  expect(
    shotSecond.equals(shotFirst),
    `run1 sha256=${sha256(shotFirst)} vs run2 sha256=${sha256(shotSecond)}`,
  ).toBe(true);

  shared.determinismRun1 = shotFirst;
  await saveArtifact("determinism-run1.png", shotFirst);
  await saveArtifact("determinism-run2.png", shotSecond);
});

test("a second browser context reproduces the baseline bytes", async ({
  page,
}) => {
  // Fresh browser context (Playwright default per test), same parameters.
  await page.goto("/render");
  await waitForSettledScene(page);
  const baselineShot = await page
    .locator("#render-viewport canvas")
    .screenshot();

  const determinismRun1 = shared.determinismRun1;
  expect(
    determinismRun1,
    "the determinism test must establish the baseline first",
  ).toBeDefined();
  if (determinismRun1 === undefined) {
    throw new Error("unreachable: baseline checked above");
  }
  expect(
    baselineShot.equals(determinismRun1),
    `baseline sha256=${sha256(baselineShot)} vs run1 sha256=${sha256(determinismRun1)}`,
  ).toBe(true);

  // Cross-check against the creation/update test's state-A capture too:
  // same parameters in a different context earlier in the run.
  const stateA = shared.stateA;
  if (stateA !== undefined) {
    expect(baselineShot.equals(stateA)).toBe(true);
  }

  await saveArtifact("baseline-context.png", baselineShot);
});
