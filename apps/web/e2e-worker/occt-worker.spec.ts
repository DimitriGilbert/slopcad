import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Phase 21.2 OCCT worker-integration e2e — the phase-level browser gate
 * ("Browser can execute a supported OCCT operation without UI freeze").
 * Mirrors the Phase 10 Manifold spec against the separate `/worker-occt`
 * fixture (the shared config and production-build harness in
 * playwright.worker.config.ts; the Manifold fixture and spec stay
 * untouched). Validation criteria:
 *
 *  - real OpenCascade executes OFF-THREAD in a real browser Worker: the
 *    main thread keeps servicing animation frames while the 12-bore
 *    boolean scene (and the boot itself) runs in the worker;
 *  - the exact volume is surfaced: OCCT's BREP integration is exact, so
 *    the measured volume matches the analytic plate-minus-twelve-cylinders
 *    value inside the exact band (1e-9), and the rotation placement's
 *    bounds are the analytic rotated extents;
 *  - boot cost is data, not a footnote: the worker's own init measurement
 *    and the ~22 MB WASM asset size are surfaced by the fixture and
 *    asserted finite/honest here;
 *  - termination settlement: a request pending on a deliberately killed
 *    channel settles with the structured `worker/transport-closed` failure.
 *
 * Assertions are numeric/semantic — read from the fixture's state surface
 * (`#occt-worker-root` data attributes, written synchronously with the
 * coordinator's dispatch/settlement), never pixel-based. Expected values
 * are restated here independently of the fixture code.
 */

const PLATE_WIDTH_MM = 60;
const PLATE_DEPTH_MM = 40;
const PLATE_HEIGHT_MM = 10;
const BORE_COUNT = 12;

/** The exact band OCCT's BREP integration holds (probed at 0 relative error). */
const EXACT_VOLUME_REL_TOLERANCE = 1e-9;

/** Relative tolerance for last-ulp rounding in rotated bounds text. */
const BOUNDS_EXTENT_ABS_TOLERANCE_MM = 1e-6;

/** The document default bore diameter (mm). */
const DEFAULT_HOLE_DIAMETER_MM = 6;

/** A second, distinct diameter the spec drives the input to. */
const FOLLOW_UP_HOLE_DIAMETER_MM = 4;

/** The documented asset class: the pre-spike measured ~22.98 MB. */
const MIN_WASM_BYTES = 20_000_000;

function analyticPlateVolume(holeDiameterMm: number): number {
  return (
    PLATE_WIDTH_MM * PLATE_DEPTH_MM * PLATE_HEIGHT_MM -
    BORE_COUNT * Math.PI * (holeDiameterMm / 2) ** 2 * PLATE_HEIGHT_MM
  );
}

/**
 * The analytic placed bounds (extents): the 60×40 footprint rotated 90°
 * about z spans 40 × 60 in xy; z is untouched.
 */
const PLACED_EXTENTS_MM: readonly [number, number, number] = [40, 60, 10];

/**
 * Waits until the fixture's state surface proves a quiescent, consistent
 * document: no computation in flight, and the visible state standing at the
 * newest dispatched revision.
 */
async function waitForSettledSurface(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("occt-worker-root");
    if (root === null) return false;
    const applied = root.getAttribute("data-applied-revision");
    return (
      root.getAttribute("data-in-flight") === "0" &&
      applied !== null &&
      applied !== "" &&
      applied === root.getAttribute("data-current-revision") &&
      root.getAttribute("data-volume-exact") !== null &&
      root.getAttribute("data-volume-exact") !== ""
    );
  });
}

/** Reads one numeric `#occt-worker-root` data attribute. */
async function readStateNumber(page: Page, attribute: string): Promise<number> {
  const value = await page.locator("#occt-worker-root").getAttribute(attribute);
  expect(value, `#occt-worker-root[${attribute}] present`).not.toBeNull();
  const parsed = Number(value);
  expect(
    Number.isFinite(parsed),
    `#occt-worker-root[${attribute}]="${value}"`,
  ).toBe(true);
  return parsed;
}

/** Reads the full-precision volume (the display value is 3-decimal text). */
async function readVolume(page: Page): Promise<number> {
  return readStateNumber(page, "data-volume-exact");
}

function expectExactVolume(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    expected * EXACT_VOLUME_REL_TOLERANCE,
  );
}

test("real occt worker computes the drilled, rotated plate off the main thread", async ({
  page,
}) => {
  await page.goto("/worker-occt");
  await waitForSettledSurface(page);

  // The worker really computed, exactly: OCCT's BREP volume for the plate
  // with twelve default bores, placed by the rotation transform.
  const volume = await readVolume(page);
  expectExactVolume(volume, analyticPlateVolume(DEFAULT_HOLE_DIAMETER_MM));

  // The rotation placement's bounds are the analytic rotated extents (the
  // fixture renders extents with last-ulp-level rounding).
  const boundsText = await page.locator("#occt-worker-bounds").textContent();
  expect(boundsText).not.toBeNull();
  const extents = (boundsText ?? "")
    .split("×")
    .map((part) => Number(part.trim()));
  expect(extents).toHaveLength(3);
  for (let axis = 0; axis < 3; axis += 1) {
    const extent = extents[axis];
    const expected = PLACED_EXTENTS_MM[axis];
    expect(extent).toBeDefined();
    expect(expected).toBeDefined();
    expect(Math.abs((extent ?? 0) - (expected ?? 0))).toBeLessThan(
      BOUNDS_EXTENT_ABS_TOLERANCE_MM,
    );
  }

  // Tessellation crossed the wire too: the plate is a closed solid mesh.
  await expect(page.locator("#occt-worker-triangles")).toHaveText(/[1-9]\d*/);

  // Off-thread proof: animation frames were serviced on the main thread
  // while work was in flight — impossible if the kernel (or the ~22 MB
  // WASM boot) ran there.
  const computeFrames = Number(
    await page.locator("#occt-worker-compute-frames").textContent(),
  );
  expect(computeFrames).toBeGreaterThanOrEqual(1);
  const ticks = Number(await page.locator("#occt-worker-ticks").textContent());
  expect(ticks).toBeGreaterThanOrEqual(1);

  // Boot cost surfaced as data: the worker's own init measurement and the
  // wall-clock ready time are finite positive numbers, and the asset is in
  // the documented ~23 MB class (not hidden, not zero).
  const bootMs = await readStateNumber(page, "data-boot-ms");
  expect(bootMs).toBeGreaterThan(0);
  const readyMs = await readStateNumber(page, "data-ready-ms");
  expect(readyMs).toBeGreaterThan(0);
  const wasmBytes = await readStateNumber(page, "data-wasm-bytes");
  expect(wasmBytes).toBeGreaterThanOrEqual(MIN_WASM_BYTES);

  // Exactly one update so far: dispatched, applied, no drops, no errors.
  expect(await readStateNumber(page, "data-dispatched")).toBe(1);
  expect(await readStateNumber(page, "data-settled")).toBe(1);
  expect(await readStateNumber(page, "data-drops")).toBe(0);
  await expect(page.getByTestId("occt-worker-error")).toHaveText("");
});

test("a parameter change recomputes exactly and stays responsive", async ({
  page,
}) => {
  await page.goto("/worker-occt");
  await waitForSettledSurface(page);

  const ticksBefore = Number(
    await page.locator("#occt-worker-ticks").textContent(),
  );

  await page
    .locator("#param-occt-hole-diameter")
    .fill(String(FOLLOW_UP_HOLE_DIAMETER_MM));
  await waitForSettledSurface(page);

  const volume = await readVolume(page);
  expectExactVolume(volume, analyticPlateVolume(FOLLOW_UP_HOLE_DIAMETER_MM));
  expect(await readStateNumber(page, "data-dispatched")).toBe(2);
  expect(await readStateNumber(page, "data-settled")).toBe(2);
  expect(await readStateNumber(page, "data-drops")).toBe(0);

  // Frames kept being serviced across the second computation.
  const ticksAfter = Number(
    await page.locator("#occt-worker-ticks").textContent(),
  );
  expect(ticksAfter).toBeGreaterThan(ticksBefore);
  await expect(page.getByTestId("occt-worker-error")).toHaveText("");
});

test("terminating the worker settles its in-flight request with worker/transport-closed", async ({
  page,
}) => {
  await page.goto("/worker-occt");
  await waitForSettledSurface(page);

  // The dispose control dispatches one request and kills the channel in
  // the same synchronous browser task — the settlement is deterministic.
  await page.locator("#occt-worker-dispose").click();

  await page.waitForFunction(() => {
    const root = document.getElementById("occt-worker-root");
    if (root === null) return false;
    return (
      root.getAttribute("data-disposed") === "1" &&
      root.getAttribute("data-dispose-settlement") !== ""
    );
  });

  const settlement = await page
    .locator("#occt-worker-root")
    .getAttribute("data-dispose-settlement");
  expect(settlement).toBe("worker/transport-closed");
  await expect(page.locator("#occt-worker-status")).toHaveText("disposed");
});
