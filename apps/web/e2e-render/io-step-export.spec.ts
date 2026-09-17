import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  readIoImportSurface,
  saveArtifact,
  sha256,
  waitForImportedMeshSettled,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 21.4 browser gate — the STEP export workflow on the /io fixture
 * (the plan's "Exported STEP reimports successfully" in the browser).
 *
 * The honest production shape: the /io source plate is Manifold-built and
 * STEP export is OpenCascade-only, so the fixture's Export STEP button
 * REBUILDS the same plate on the lazily-booted real OpenCascade worker
 * through the worker protocol's own operations, exports it with
 * `step.export`, and holds the bytes (a real `plate.step` download). The
 * Import held STEP button then round-trips exactly those bytes through the
 * 21.3 import path (`step.import` → tessellate → dispose) and renders the
 * re-imported solids in the imported-mesh viewport — a full OCCT
 * export→import cycle through the browser.
 *
 * Semantic assertions read the machine surfaces: the held file's byte
 * count and solid count, the neutralized deterministic header inside the
 * browser-produced bytes themselves (the fixed epoch stamp is the only
 * ISO-8601 stamp; the AP214 FILE_SCHEMA rides the header), the imported
 * extents, and the re-imported soup's divergence-theorem volume within the
 * established 0.5% band of the /io SOURCE solid's kernel volume (the
 * rebuilt plate IS the source plate's geometry: 30×20×10 minus a ⌀8
 * through-bore).
 *
 * Determinism pins: two full runs (fresh page loads, fresh OCCT workers —
 * the ~22 MB asset boots per run) must produce byte-identical .step files
 * (the spec fetches the download blob's bytes and compares buffers) and a
 * byte-identical settled imported-viewport screenshot under SwiftShader.
 * Artifacts: the exported bytes land in `e2e-artifacts/render/` for
 * inspection, alongside the viewport captures. The harness already records
 * video for every run; no dedicated video artifact.
 */

/** The analytic plate-with-hole volume (mm³) the rebuilt plate encodes. */
const ANALYTIC_VOLUME_MM3 = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;

/** The established imported-soup vs kernel-volume band. */
const VOLUME_REL_TOLERANCE = 0.005;

/** The settled plate's extents under the kernel placement conventions. */
const PLATE_EXTENTS_TEXT = "30.000 × 20.000 × 10.000";

/** The provenance detail the fixture publishes for the STEP re-import. */
const STEP_DETAIL_JSON = JSON.stringify({
  origin: "imported-step",
  solids: 1,
  unit: "mm",
});

/** The exporter's neutralized header stamp (the determinism contract). */
const EPOCH_STAMP = "1970-01-01T00:00:00";

/** One read of the fixture's STEP export surface. */
interface StepExportSurface {
  readonly bytes: number | null;
  readonly solids: number | null;
}

async function readStepExportSurface(page: Page): Promise<StepExportSurface> {
  const raw = await page.evaluate(() => {
    const root = document.getElementById("io-root");
    return {
      bytes: root?.getAttribute("data-export-step-bytes") ?? null,
      solids: root?.getAttribute("data-export-step-solids") ?? null,
    };
  });
  const parse = (value: string | null): number | null =>
    value === null || value === "" ? null : Number(value);
  return { bytes: parse(raw.bytes), solids: parse(raw.solids) };
}

/** Fetches the held export's download blob — the exact exported bytes. */
async function fetchHeldStepBytes(page: Page): Promise<Buffer> {
  const href = await page.locator("#io-download-step").getAttribute("href");
  expect(href, "the held STEP export must expose its download anchor").toBeTruthy();
  return Buffer.from(
    await page.evaluate(async (url) => {
      const response = await fetch(url);
      return new Uint8Array(await response.arrayBuffer());
    }, href ?? ""),
  );
}

/**
 * One full export round trip on a fresh page: settle the source, export
 * (booting the OCCT worker), re-import the held bytes, settle the imported
 * scene, assert the surfaces, capture the imported-mesh screenshot and the
 * exported bytes.
 */
async function exportRoundTrip(
  page: Page,
): Promise<{ readonly shot: Buffer; readonly step: Buffer }> {
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");
  const sourceVolume = Number(
    await page.locator("#io-source-volume").textContent(),
  );
  expect(Number.isFinite(sourceVolume)).toBe(true);

  await page.locator("#io-export-step").click();
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return (
      root !== null && (root.getAttribute("data-export-step-bytes") ?? "") !== ""
    );
  });
  const exportSurface = await readStepExportSurface(page);
  expect(exportSurface.solids, "the export carries one solid").toBe(1);
  expect(
    exportSurface.bytes,
    "the exported file must carry real bytes",
  ).toBeGreaterThan(0);

  const step = await fetchHeldStepBytes(page);
  // The browser-produced bytes ARE the exporter's deterministic output: the
  // fixed epoch stamp is the only ISO-8601 stamp, and the AP214 schema the
  // AsIs default emits rides the header.
  const text = step.toString("utf-8");
  const stamps = text.match(/'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/g) ?? [];
  expect(stamps).toEqual([`'${EPOCH_STAMP}'`]);
  expect(text).toContain(
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'))",
  );

  await page.locator("#io-import-step").click();
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return root !== null && root.getAttribute("data-import-source") === "step";
  });
  await waitForImportedMeshSettled(page);

  const surface = await readIoImportSurface(page);
  expect(surface.error, "the re-import must not report an error").toBe("");
  expect(surface.source, "the re-import must name its provenance").toBe("step");
  expect(surface.detail).toBe(STEP_DETAIL_JSON);
  expect(surface.extents, "the re-imported bounds must be the plate's").toBe(
    PLATE_EXTENTS_TEXT,
  );
  expect(
    surface.triangles,
    "the re-imported solid must tessellate to triangles",
  ).toBeGreaterThan(0);
  const importedVolume = Number(surface.volumeExact);
  expect(
    Number.isFinite(importedVolume),
    `re-imported volume "${surface.volumeExact}"`,
  ).toBe(true);
  expect(
    Math.abs(importedVolume - sourceVolume),
    `re-imported ${String(importedVolume)} vs source ${String(sourceVolume)}`,
  ).toBeLessThanOrEqual(sourceVolume * VOLUME_REL_TOLERANCE);
  expect(
    Math.abs(importedVolume - ANALYTIC_VOLUME_MM3),
    `re-imported ${String(importedVolume)} vs analytic ${String(ANALYTIC_VOLUME_MM3)}`,
  ).toBeLessThanOrEqual(ANALYTIC_VOLUME_MM3 * VOLUME_REL_TOLERANCE);

  // Pixels: only after the settle stamp proved the frame carried the STEP.
  const shot = await page.locator("#io-import-viewport canvas").screenshot();
  return { shot, step };
}

test("step export round trip: occt worker rebuild → export → re-import renders and agrees semantically", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const first = await exportRoundTrip(page);
  await saveArtifact("io-export-step-run1.png", first.shot);
  await saveArtifact("plate-exported.step", first.step);
  await page.screenshot({
    path: "e2e-artifacts/render/io-export-step-fullpage.png",
    fullPage: true,
  });

  // A full second run: fresh document load, fresh OCCT worker, the same
  // rebuild — byte-identical STEP bytes and a byte-identical settled scene.
  const second = await exportRoundTrip(page);
  expect(
    second.step.equals(first.step),
    `exported STEP run1 sha256=${sha256(first.step)} vs run2 sha256=${sha256(second.step)}`,
  ).toBe(true);
  expect(
    second.shot.equals(first.shot),
    `imported-STEP export run1 sha256=${sha256(first.shot)} vs run2 sha256=${sha256(second.shot)}`,
  ).toBe(true);
  await saveArtifact("io-export-step-run2.png", second.shot);
});
