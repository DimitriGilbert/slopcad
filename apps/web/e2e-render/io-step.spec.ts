import { readFileSync } from "node:fs";
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
 * Phase 21.3 browser gate — the STEP import workflow on the /io fixture
 * (the plan's "Browser import workflow passes" with screenshot evidence).
 *
 * The flow is the honest production shape: a `.step` file is uploaded
 * through the fixture's real file input, its raw bytes cross the worker
 * protocol to the LAZILY-BOOTED real OpenCascade worker (`step.import`),
 * the imported geometry-only solids are tessellated and disposed over the
 * same channel, and the resulting soups render in the imported-mesh
 * viewport — the same projection boundary every mesh import uses.
 *
 * Semantic assertions read the machine surfaces: provenance is "step" with
 * the `{"origin":"imported-step",...}` detail, extents are the plate's,
 * the imported soup's divergence-theorem volume sits within the
 * established 0.5% band of the /io SOURCE solid's kernel volume (the
 * committed fixture IS the source plate: 30×20×10 minus a ⌀8 through-bore),
 * and the settle stamp agrees before pixels are taken. A garbage upload
 * first proves the browser failure surface: the structured
 * `step-import/*` code, verbatim, and no imported view.
 *
 * Screenshot baseline: the imported-STEP scene must render byte-identical
 * across two consecutive full runs (fresh page load, fresh export of the
 * same committed bytes, fresh import) under SwiftShader — the render
 * spec's determinism discipline applied to the STEP path. This also pins
 * the OCCT tessellation's determinism across independent worker boots in
 * one browser. No dedicated video artifact: the flow's shape (upload →
 * render → settle) matches the existing /io specs, whose harness already
 * records video for every run.
 */

const FIXTURE_BYTES = readFileSync(
  new URL(
    "../../../packages/cad-kernel-occt/fixtures/plate-with-hole.step",
    import.meta.url,
  ),
);

/** The analytic plate-with-hole volume (mm³) the committed fixture encodes. */
const ANALYTIC_VOLUME_MM3 = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;

/** The established imported-soup vs kernel-volume band. */
const VOLUME_REL_TOLERANCE = 0.005;

/** The settled plate's extents under the kernel placement conventions. */
const PLATE_EXTENTS_TEXT = "30.000 × 20.000 × 10.000";

/** The provenance detail the fixture publishes for a STEP import. */
const STEP_DETAIL_JSON = JSON.stringify({
  origin: "imported-step",
  solids: 1,
  unit: "mm",
});

/** The /io source surface's kernel volume (the settled plate's). */
async function readSourceVolume(page: Page): Promise<number> {
  const volumeText = await page.locator("#io-source-volume").textContent();
  const volume = Number(volumeText);
  expect(
    Number.isFinite(volume),
    `#io-source-volume="${String(volumeText)}"`,
  ).toBe(true);
  return volume;
}

/**
 * One full STEP import on a fresh page: settle the source, upload `bytes`
 * through the real file input, settle the imported scene, assert the
 * surface, capture the imported-mesh screenshot.
 */
async function importStep(
  page: Page,
  bytes: Buffer,
  name: string,
): Promise<{ readonly shot: Buffer; readonly triangles: number }> {
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");
  const sourceVolume = await readSourceVolume(page);

  await page.locator("#io-import-file").setInputFiles({
    name,
    mimeType: "application/step",
    buffer: bytes,
  });

  // The first STEP import boots the OCCT worker (~22 MB asset); wait for
  // the import surface to name its provenance before the settle protocol.
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return root !== null && root.getAttribute("data-import-source") === "step";
  });
  await waitForImportedMeshSettled(page);

  const surface = await readIoImportSurface(page);
  expect(surface.error, "the import must not report an error").toBe("");
  expect(surface.source, "the STEP path must name its provenance").toBe("step");
  expect(
    surface.detail,
    "the STEP detail must carry origin, solids, unit",
  ).toBe(STEP_DETAIL_JSON);
  expect(surface.extents, "the imported bounds must be the plate's").toBe(
    PLATE_EXTENTS_TEXT,
  );
  expect(
    surface.triangles,
    "the imported solid must tessellate to triangles",
  ).toBeGreaterThan(0);

  // Volume semantics: the imported soup's divergence-theorem volume against
  // the SOURCE solid's kernel volume — the fixture IS the source plate.
  const importedVolume = Number(surface.volumeExact);
  expect(
    Number.isFinite(importedVolume),
    `imported volume "${surface.volumeExact}"`,
  ).toBe(true);
  expect(
    Math.abs(importedVolume - sourceVolume),
    `imported ${String(importedVolume)} vs source ${String(sourceVolume)}`,
  ).toBeLessThanOrEqual(sourceVolume * VOLUME_REL_TOLERANCE);
  expect(
    Math.abs(importedVolume - ANALYTIC_VOLUME_MM3),
    `imported ${String(importedVolume)} vs analytic ${String(ANALYTIC_VOLUME_MM3)}`,
  ).toBeLessThanOrEqual(ANALYTIC_VOLUME_MM3 * VOLUME_REL_TOLERANCE);

  // Pixels: only now — the settle stamp proved the frame carried the STEP.
  const shot = await page.locator("#io-import-viewport canvas").screenshot();
  return { shot, triangles: surface.triangles ?? 0 };
}

test("step round trip: upload → occt worker import → the imported solid renders and agrees semantically", async ({
  page,
}) => {
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");

  // The browser failure surface first: garbage STEP bytes fail with the
  // structured code, verbatim, and nothing becomes the imported view.
  await page.locator("#io-import-file").setInputFiles({
    name: "garbage.step",
    mimeType: "application/step",
    buffer: Buffer.from("this is not a STEP file"),
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return root !== null && root.getAttribute("data-import-error") !== "";
  });
  const garbageError = await page
    .locator("#io-root")
    .getAttribute("data-import-error");
  expect(garbageError).toContain("step-import/malformed");
  expect(
    await page.locator("#io-root").getAttribute("data-import-source"),
    "a rejected import must not mint an imported view",
  ).toBe("");

  // The real import — this run pays the worker boot; the import reuses it.
  const first = await importStep(page, FIXTURE_BYTES, "plate-with-hole.step");
  await saveArtifact("io-import-step-run1.png", first.shot);
  await page.screenshot({
    path: "e2e-artifacts/render/io-roundtrip-step-fullpage.png",
    fullPage: true,
  });

  // A full second run: fresh document load, fresh worker, the same
  // committed bytes — the same settled scene must result, byte for byte.
  const second = await importStep(page, FIXTURE_BYTES, "plate-with-hole.step");
  expect(second.triangles, "the second run must import the same soup").toBe(
    first.triangles,
  );
  expect(
    second.shot.equals(first.shot),
    `imported-STEP run1 sha256=${sha256(first.shot)} vs run2 sha256=${sha256(second.shot)}`,
  ).toBe(true);

  await saveArtifact("io-import-step-run2.png", second.shot);
});
