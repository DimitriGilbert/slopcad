import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/**
 * Phase 1.6 architecture spike e2e.
 * Validation criteria from the plan:
 *  - changing a parameter visibly updates the rendered model (pixels) AND
 *    semantic numbers (worker-side volume/bounds),
 *  - the rendered screenshot is reproducible across two consecutive runs
 *    under software WebGL.
 * Runs against the production build (see playwright.spike.config.ts).
 */

const BOX_WIDTH = 30;
const BOX_HEIGHT = 20;
const BOX_DEPTH = 10;

/** Relative tolerance for tessellated-vs-analytic volume (worst observed ~0.2%). */
const VOLUME_REL_TOLERANCE = 0.005;

/** Persist the exact compared bytes so artifacts never diverge from assertions. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/spike", { recursive: true });
  await writeFile(`e2e-artifacts/spike/${name}`, bytes);
}

/** Wait until the pixels on screen provably belong to the displayed numbers. */
async function waitForSettledModel(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("spike-root");
    const volume = document.getElementById("spike-volume");
    const rendered = root?.getAttribute("data-cad-rendered-volume") ?? "";
    return rendered.length > 0 && rendered === (volume?.textContent ?? "");
  });
}

async function readVolume(page: Page): Promise<number> {
  const text = await page.locator("#spike-volume").textContent();
  const value = Number(text);
  expect(Number.isFinite(value)).toBe(true);
  return value;
}

function expectWithinTolerance(
  actual: number,
  analytic: number,
  relativeTolerance: number,
): void {
  expect(Math.abs(actual - analytic)).toBeLessThanOrEqual(
    analytic * relativeTolerance,
  );
}

test("parameter change updates pixels and worker-side volume/bounds", async ({
  page,
}) => {
  await page.goto("/spike");
  await waitForSettledModel(page);

  // State A: hole diameter 8 (document defaults).
  const volumeA = await readVolume(page);
  expectWithinTolerance(
    volumeA,
    BOX_WIDTH * BOX_HEIGHT * BOX_DEPTH - Math.PI * 4 * 4 * BOX_DEPTH,
    VOLUME_REL_TOLERANCE,
  );
  await expect(page.locator("#spike-bounds")).toHaveText(
    "30.000 × 20.000 × 10.000",
  );
  await expect(page.locator("#spike-triangles")).toHaveText(/[1-9]\d*/);
  await expect(page.getByTestId("spike-error")).toHaveText("");
  const shotA = await page.locator("canvas").screenshot();

  // State B: enlarge the subtracted hole to diameter 14.
  await page.locator("#param-holeDiameter").fill("14");
  await waitForSettledModel(page);
  const volumeB = await readVolume(page);
  expectWithinTolerance(
    volumeB,
    BOX_WIDTH * BOX_HEIGHT * BOX_DEPTH - Math.PI * 7 * 7 * BOX_DEPTH,
    VOLUME_REL_TOLERANCE,
  );
  expect(volumeB).toBeLessThan(volumeA);
  await expect(page.getByTestId("spike-error")).toHaveText("");
  const shotB = await page.locator("canvas").screenshot();

  // The parameter change is visible in the rendered pixels.
  expect(shotB.equals(shotA)).toBe(false);

  await saveArtifact("state-a.png", shotA);
  await saveArtifact("state-b.png", shotB);
  await page.screenshot({
    path: "e2e-artifacts/spike/state-b-fullpage.png",
    fullPage: true,
  });
});

test("two consecutive runs render pixel-identical screenshots", async ({
  page,
}) => {
  await page.goto("/spike");
  await waitForSettledModel(page);
  const volumeFirst = await readVolume(page);
  const shotFirst = await page.locator("canvas").screenshot();

  await page.reload();
  await waitForSettledModel(page);
  const volumeSecond = await readVolume(page);
  const shotSecond = await page.locator("canvas").screenshot();

  expect(volumeSecond).toBe(volumeFirst);
  expect(shotSecond.equals(shotFirst)).toBe(true);

  await saveArtifact("determinism-run1.png", shotFirst);
  await saveArtifact("determinism-run2.png", shotSecond);
});
