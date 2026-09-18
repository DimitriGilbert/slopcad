import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 26.5 fillet e2e — the browser workflow on the deterministic render
 * harness (production build, SwiftShader, fixed 1280×720 DPR 1, one worker,
 * config-level video captures the journey). The plan's validation:
 *
 *  - EDGE SELECTION — the settled box scene publishes the topology
 *    snapshot's edges as projected anchors (`data-edge-anchors`); clicking
 *    an anchor selects that snapshot ordinal (`data-selected-edge`) — the
 *    pick-by-snapshot design, no guessed pixels;
 *  - GEOMETRY SEMANTICS — Fillet executes the REAL OCCT kernel's
 *    `solid.fillet` in the worker and the settled volume is within the
 *    exact band of the analytic corner-fillet value
 *    `W·D·H − r²(1 − π/4)·L`;
 *  - RADIUS REGENERATION — a radius edit re-dispatches and settles at the
 *    new analytic value;
 *  - FAILURE STATE — an oversized radius settles with the structured
 *    `kernel/fillet-failed` code on the error surface, the previous scene
 *    untouched;
 *  - SCREENSHOT BASELINE — the settled filleted scene is byte-stable
 *    across two independent browser journeys.
 *
 * Machine surfaces: `data-stage`, `data-selected-edge`, `data-edge-anchors`,
 * `data-volume-exact`, `data-error`, and the shared settle protocol.
 */

const ROOT = "#occt-fillet-root";
const VIEWPORT = "#occt-fillet-viewport";
const APPLY = "#fillet-apply";
const RADIUS_FIELD = "#param-fillet-radius";

/** The fixture box (see worker-fixture/fillet-scene). */
const BOX = { width: 30, depth: 20, height: 10 } as const;
const BOX_VOLUME = BOX.width * BOX.depth * BOX.height;

/** The analytic corner-fillet volume: box minus one prism-quadrant. */
function cornerFilletVolume(radiusMm: number): number {
  return BOX_VOLUME - radiusMm * radiusMm * (1 - Math.PI / 4) * BOX.height;
}

/** The OCCT fillet is exact BREP: only double-precision noise is allowed. */
const EXACT_BAND = 1e-9;

interface EdgeAnchor {
  readonly point: readonly [number, number];
  readonly lengthMm: number;
  readonly centroidMm: readonly [number, number, number];
}

/** Waits for the settled scene and returns the full-precision volume. */
async function settledExactVolume(page: Page): Promise<number> {
  await waitForSettledScene(page, "occt-fillet-root");
  const text = await page
    .locator(ROOT)
    .getAttribute("data-volume-exact")
    .then((value) => value ?? "");
  const value = Number(text);
  expect(Number.isFinite(value), `data-volume-exact="${text}"`).toBe(true);
  return value;
}

/**
 * Finds the snapshot ordinal of the vertical corner edge at (30, 20) — the
 * fillet fixture's analytic edge — straight from the published anchors.
 */
async function cornerEdgeAnchor(page: Page): Promise<{
  readonly ordinal: string;
  readonly anchor: EdgeAnchor;
}> {
  const raw = await page
    .locator(ROOT)
    .getAttribute("data-edge-anchors")
    .then((value) => value ?? "{}");
  const anchors = JSON.parse(raw) as Record<string, EdgeAnchor>;
  for (const [ordinal, anchor] of Object.entries(anchors)) {
    const vertical =
      Math.abs(anchor.centroidMm[2] - BOX.height / 2) < 1e-6 &&
      Math.abs(anchor.lengthMm - BOX.height) < 1e-6;
    const atCorner =
      Math.abs(anchor.centroidMm[0] - BOX.width) < 1e-6 &&
      Math.abs(anchor.centroidMm[1] - BOX.depth) < 1e-6;
    if (vertical && atCorner) {
      return { ordinal, anchor };
    }
  }
  throw new Error(
    `No corner vertical edge in the anchor surface: ${raw.slice(0, 400)}`,
  );
}

/** The radius the fixture's radius field boots with (the page's constant). */
const FILLET_DEFAULT_RADIUS_MM = 3;

/** Runs the pick → fillet journey and returns the settled exact volume. */
async function runFilletJourney(page: Page, radiusMm: number): Promise<number> {
  await page.goto("/worker-fillet");
  const boxVolume = await settledExactVolume(page);
  expect(
    Math.abs(boxVolume - BOX_VOLUME) / BOX_VOLUME,
    `box volume ${String(boxVolume)}`,
  ).toBeLessThan(EXACT_BAND);
  await expect(page.locator(ROOT)).toHaveAttribute("data-stage", "picking");

  // EDGE SELECTION: click the projected anchor of the snapshot's corner
  // vertical — the pick is the snapshot ordinal itself.
  const { ordinal, anchor } = await cornerEdgeAnchor(page);
  await page.locator(VIEWPORT).click({
    position: { x: anchor.point[0], y: anchor.point[1] },
  });
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-selected-edge",
    ordinal,
  );

  // FILLET: dispatch through the apply control; the worker executes the
  // real kernel op and the scene settles on the filleted solid.
  if (radiusMm !== FILLET_DEFAULT_RADIUS_MM) {
    await page.locator(RADIUS_FIELD).fill(String(radiusMm));
  }
  await page.locator(APPLY).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-stage", "filleted");
  return settledExactVolume(page);
}

test("pick an edge on the snapshot anchors → fillet → the exact analytic corner-fillet volume", async ({
  page,
}) => {
  const volume = await runFilletJourney(page, FILLET_DEFAULT_RADIUS_MM);
  const analytic = cornerFilletVolume(FILLET_DEFAULT_RADIUS_MM);
  expect(
    Math.abs(volume - analytic) / analytic,
    `fillet volume ${String(volume)} vs analytic ${String(analytic)}`,
  ).toBeLessThan(EXACT_BAND);

  // SCREENSHOT BASELINE: the settled filleted scene's canvas bytes.
  const shot = await page.locator(`${VIEWPORT} canvas`).screenshot();
  await saveArtifact("fillet-baseline.png", shot);
});

test("the settled filleted scene reproduces byte-identically in a second context", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const firstContext = await browser.newContext();
  const page1 = await firstContext.newPage();
  await runFilletJourney(page1, FILLET_DEFAULT_RADIUS_MM);
  const first = await page1.locator(`${VIEWPORT} canvas`).screenshot();
  await saveArtifact("fillet-repro-1.png", first);
  await firstContext.close();

  const secondContext = await browser.newContext();
  const page2 = await secondContext.newPage();
  await runFilletJourney(page2, FILLET_DEFAULT_RADIUS_MM);
  const second = await page2.locator(`${VIEWPORT} canvas`).screenshot();
  await saveArtifact("fillet-repro-2.png", second);
  expect(
    second.equals(first),
    `repro sha256=${sha256(second)} vs first=${sha256(first)}`,
  ).toBe(true);
  await secondContext.close();
});

test("a radius edit regenerates the fillet at the new analytic volume", async ({
  page,
}) => {
  await runFilletJourney(page, FILLET_DEFAULT_RADIUS_MM);

  // RADIUS REGENERATION: the same picked edge, a new radius — the apply
  // re-dispatches the whole chain (box → topology → fillet) and the scene
  // settles at the new analytic value.
  await page.locator(RADIUS_FIELD).fill("5");
  await page.locator(APPLY).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-stage", "filleted");
  const volume = await settledExactVolume(page);
  const analytic = cornerFilletVolume(5);
  expect(
    Math.abs(volume - analytic) / analytic,
    `regenerated volume ${String(volume)} vs analytic ${String(analytic)}`,
  ).toBeLessThan(EXACT_BAND);
});

test("an oversized radius settles with the structured kernel failure, scene untouched", async ({
  page,
}) => {
  await runFilletJourney(page, FILLET_DEFAULT_RADIUS_MM);
  const settledVolume = await settledExactVolume(page);

  // FAILURE STATE: r = 25 outruns both faces adjacent to the corner edge —
  // probed, OCCT answers IsDone = false and the adapter maps that to
  // kernel/fillet-failed. The dispatch rejects; the surface carries the
  // structured code and the PREVIOUS scene stays visible.
  await page.locator(RADIUS_FIELD).fill("25");
  await page.locator(APPLY).click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-error",
    /kernel\/fillet-failed/,
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-stage", "filleted");
  await expect(page.locator(ROOT)).toHaveAttribute("data-in-flight", "0");
  // The failed dispatch consumed a revision without applying: the previous
  // scene stays the visible one — same full-precision volume, same canvas.
  const afterFailureText = await page
    .locator(ROOT)
    .getAttribute("data-volume-exact")
    .then((value) => value ?? "");
  expect(Number(afterFailureText)).toBe(settledVolume);
});
