import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Phase 10 worker-integration e2e — the phase-level browser gate.
 * Validation criteria from the plan:
 *  - real Manifold executes OFF-THREAD in a real browser Worker (the main
 *    thread keeps servicing animation frames while computations run),
 *  - rapid parameter updates cannot corrupt the visible result: the LAST
 *    parameter's computation is what stays visible, and superseded
 *    computations surface as observable stale drops,
 *  - the rapid-update workflow is captured on video.
 *
 * Assertions are numeric/semantic — read from the fixture's state surface
 * (`#worker-root` data attributes, written synchronously with the
 * coordinator's dispatch/settlement), never pixel-based. Expected values
 * are restated here independently of the fixture code: the spec must not
 * inherit the very numbers it is supposed to check. Runs against the
 * production build (see playwright.worker.config.ts).
 */

const PLATE_WIDTH_MM = 30;
const PLATE_DEPTH_MM = 20;
const PLATE_HEIGHT_MM = 10;

/** Relative tolerance for worker-measured vs analytic volume (spike: ≤ ~0.2%). */
const VOLUME_REL_TOLERANCE = 0.005;

/** The document default bore diameter (mm). */
const DEFAULT_HOLE_DIAMETER_MM = 8;

/**
 * The rapid-update burst: 12 distinct bore diameters dispatched as input
 * events in one synchronous browser task — faster than any computation can
 * settle (no worker response can be processed mid-task), so the first 11
 * computations are superseded by construction and the last must win.
 */
const LAST_BURST_HOLE_DIAMETER_MM = 14;
const BURST_HOLE_DIAMETERS: readonly number[] = [
  8.5,
  9,
  9.5,
  10,
  10.5,
  11,
  11.5,
  12,
  12.5,
  13,
  13.5,
  LAST_BURST_HOLE_DIAMETER_MM,
];

function analyticPlateVolume(holeDiameterMm: number): number {
  return (
    PLATE_WIDTH_MM * PLATE_DEPTH_MM * PLATE_HEIGHT_MM -
    Math.PI * (holeDiameterMm / 2) ** 2 * PLATE_HEIGHT_MM
  );
}

/**
 * Waits until the fixture's state surface proves a quiescent, consistent
 * document: no computation in flight, and the visible state standing at the
 * newest dispatched revision.
 */
async function waitForSettledSurface(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("worker-root");
    if (root === null) return false;
    const applied = root.getAttribute("data-applied-revision");
    return (
      root.getAttribute("data-in-flight") === "0" &&
      applied !== null &&
      applied !== "" &&
      applied === root.getAttribute("data-current-revision") &&
      root.getAttribute("data-volume") !== null &&
      root.getAttribute("data-volume") !== ""
    );
  });
}

/** Reads one numeric `#worker-root` data attribute. */
async function readStateInt(page: Page, attribute: string): Promise<number> {
  const value = await page.locator("#worker-root").getAttribute(attribute);
  expect(value, `#worker-root[${attribute}] present`).not.toBeNull();
  const parsed = Number(value);
  expect(Number.isFinite(parsed), `#worker-root[${attribute}]="${value}"`).toBe(
    true,
  );
  return parsed;
}

async function readVolume(page: Page): Promise<number> {
  return readStateInt(page, "data-volume");
}

function expectVolumeCloseTo(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    expected * VOLUME_REL_TOLERANCE,
  );
}

test("real manifold worker computes the plate off the main thread", async ({
  page,
}) => {
  await page.goto("/worker");
  await waitForSettledSurface(page);

  // The worker really computed: volume matches the analytic plate with the
  // default bore, and the bounds are the plate's exact extents.
  const volume = await readVolume(page);
  expectVolumeCloseTo(volume, analyticPlateVolume(DEFAULT_HOLE_DIAMETER_MM));
  await expect(page.locator("#worker-bounds")).toHaveText(
    `${PLATE_WIDTH_MM}.000 × ${PLATE_DEPTH_MM}.000 × ${PLATE_HEIGHT_MM}.000`,
  );

  // Tessellation crossed the wire too: the plate is a closed solid mesh.
  await expect(page.locator("#worker-triangles")).toHaveText(/[1-9]\d*/);

  // Off-thread proof: animation frames were serviced on the main thread
  // while a computation was in flight — impossible if the kernel ran there.
  const computeFrames = Number(
    await page.locator("#worker-compute-frames").textContent(),
  );
  expect(computeFrames).toBeGreaterThanOrEqual(1);
  const ticks = Number(await page.locator("#worker-ticks").textContent());
  expect(ticks).toBeGreaterThanOrEqual(1);

  // Exactly one update so far: dispatched, applied, no drops, no errors.
  expect(await readStateInt(page, "data-dispatched")).toBe(1);
  expect(await readStateInt(page, "data-settled")).toBe(1);
  expect(await readStateInt(page, "data-drops")).toBe(0);
  await expect(page.getByTestId("worker-error")).toHaveText("");
});

test("rapid parameter updates leave the newest revision visible with observable stale drops", async ({
  page,
}) => {
  await page.goto("/worker");
  await waitForSettledSurface(page);

  const dispatchedBefore = await readStateInt(page, "data-dispatched");
  const dropsBefore = await readStateInt(page, "data-drops");
  const ticksBefore = Number(await page.locator("#worker-ticks").textContent());

  // The burst: one synchronous browser task fires all 12 parameter changes
  // as native input events, each dispatching a coordinator update. No
  // worker response can be processed until the task ends, so the first 11
  // computations are cancelled-and-dropped by construction.
  await page.evaluate(
    (diameters: readonly number[]) => {
      const input = document.getElementById("param-holeDiameter");
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("#param-holeDiameter input not found");
      }
      const proto = window.HTMLInputElement.prototype;
      for (const diameter of diameters) {
        // Reflect.set with a receiver runs the prototype's own value setter
        // with `this = input` — the React-controlled-input discipline —
        // without extracting the method off its descriptor.
        const set = Reflect.set(proto, "value", String(diameter), input);
        if (!set) {
          throw new Error("setting #param-holeDiameter value failed");
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    [...BURST_HOLE_DIAMETERS],
  );

  await waitForSettledSurface(page);

  // The LAST parameter's computation is the visible one: its volume is the
  // analytic plate for the final burst diameter, and the visible state
  // stands at the newest revision.
  const volume = await readVolume(page);
  expectVolumeCloseTo(volume, analyticPlateVolume(LAST_BURST_HOLE_DIAMETER_MM));
  await expect(page.locator("#param-holeDiameter")).toHaveValue(
    String(LAST_BURST_HOLE_DIAMETER_MM),
  );
  const dispatchedAfter = await readStateInt(page, "data-dispatched");
  expect(dispatchedAfter - dispatchedBefore).toBe(BURST_HOLE_DIAMETERS.length);
  expect(await readStateInt(page, "data-applied-revision")).toBe(
    await readStateInt(page, "data-current-revision"),
  );

  // Stale-result protection is observable, not silent: every superseded
  // computation settled as a structured drop. With the burst delivered in
  // one synchronous task, none of the first 11 could finish first — the
  // drop count is exactly the superseded computations.
  const dropsAfter = await readStateInt(page, "data-drops");
  expect(dropsAfter - dropsBefore).toBe(BURST_HOLE_DIAMETERS.length - 1);

  // Main-thread responsiveness throughout the burst window: frames kept
  // being serviced across dispatch and settlement.
  const ticksAfter = Number(await page.locator("#worker-ticks").textContent());
  expect(ticksAfter).toBeGreaterThan(ticksBefore);

  // No computation failed on its own merits — drops are staleness, not error.
  await expect(page.getByTestId("worker-error")).toHaveText("");
});
