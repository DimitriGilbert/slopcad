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
 * Phase 21.5 browser gates — the BREP and IGES exchange workflows on the
 * /io fixture (the plan's "Valid fixtures import. Invalid files fail
 * safely." in the browser).
 *
 * The BREP test is the STEP pair's twin with one STRONGER pin: the
 * browser's exported bytes must equal the committed kernel fixture
 * BYTE-FOR-BYTE — the fixture was written by a Node script in another
 * process, the browser export runs in a fresh OCCT worker inside
 * Chromium, and the BREP writer carries no timestamp or counter to
 * neutralize, so cross-environment byte-identity is the determinism
 * contract in its purest form. The round trip then re-imports exactly
 * those held bytes (`brep.import` → tessellate → dispose) and renders the
 * re-imported solids, asserting the `{"origin":"imported-brep",…}`
 * provenance, the plate's extents, and the divergence-theorem volume
 * within the established 0.5% band of the /io SOURCE solid's kernel
 * volume. A garbage `.brep` upload first proves the failure surface: the
 * structured `brep-import/*` code, verbatim, and no imported view.
 *
 * The IGES test is deliberately shaped differently — the honest
 * architecture: IGES reads to MESHES on the MAIN THREAD through the
 * plan's fallback engine (`occt-import-js`, lazily booted ~7.3 MB wasm),
 * not through the OCCT worker (there are no solids to mint). The committed
 * fixture (a real 10 mm Inventor IGES cube, adopted from the fallback's
 * own LGPL test suite) uploads through the real file input and renders as
 * a mesh body with the `{"origin":"imported-iges",…}` mesh-level
 * provenance, the cube's 10×10×10 mm extents, and ~1000 mm³ volume; a
 * garbage `.igs` upload fails with the structured `iges-import/*` code.
 *
 * Screenshot determinism: each path's settled imported-viewport scene must
 * render byte-identical across two consecutive full runs under
 * SwiftShader — the render suite's discipline applied to both new paths.
 * The harness already records video for every run; no dedicated artifact.
 */

/** The committed 21.5 fixtures, read cross-environment in Node. */
const BREP_FIXTURE_BYTES = readFileSync(
  new URL(
    "../../../packages/cad-kernel-occt/fixtures/plate-with-hole.brep",
    import.meta.url,
  ),
);
const IGES_FIXTURE_BYTES = readFileSync(
  new URL(
    "../../../packages/cad-kernel-occt/fixtures/cube-10mm.igs",
    import.meta.url,
  ),
);

/** The analytic plate-with-hole volume (mm³) the rebuilt BREP plate encodes. */
const ANALYTIC_VOLUME_MM3 = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;

/** The IGES fixture's volume: a 10 mm cube. */
const IGES_VOLUME_MM3 = 1000;

/** The established imported-soup vs kernel-volume band. */
const VOLUME_REL_TOLERANCE = 0.005;

/** The settled plate's extents under the kernel placement conventions. */
const PLATE_EXTENTS_TEXT = "30.000 × 20.000 × 10.000";

/** The settled IGES cube's extents (its own placement: x/z ±5, y 0..10). */
const IGES_EXTENTS_TEXT = "10.000 × 10.000 × 10.000";

/** The provenance details the fixture publishes for the new paths. */
const BREP_DETAIL_JSON = JSON.stringify({
  origin: "imported-brep",
  solids: 1,
  unit: "mm",
});
const IGES_DETAIL_JSON = JSON.stringify({
  origin: "imported-iges",
  meshes: 1,
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

/** Fetches a held export's download blob — the exact exported bytes. */
async function fetchHeldBytes(page: Page, anchorId: string): Promise<Buffer> {
  const href = await page.locator(anchorId).getAttribute("href");
  expect(href, "the held export must expose its download anchor").toBeTruthy();
  return Buffer.from(
    await page.evaluate(async (url) => {
      const response = await fetch(url);
      return new Uint8Array(await response.arrayBuffer());
    }, href ?? ""),
  );
}

/** Uploads bytes through the real file input and waits for the import view. */
async function uploadAndWaitForSource(
  page: Page,
  name: string,
  mimeType: string,
  bytes: Buffer,
  source: "brep" | "iges",
): Promise<void> {
  await page.locator("#io-import-file").setInputFiles({
    name,
    mimeType,
    buffer: bytes,
  });
  await page.waitForFunction((expected) => {
    const root = document.getElementById("io-root");
    return (
      root !== null && root.getAttribute("data-import-source") === expected
    );
  }, source);
}

/**
 * One full BREP export round trip on a fresh page: settle the source,
 * export (booting the OCCT worker), re-import the held bytes, settle the
 * imported scene, assert the surfaces, capture the imported-mesh
 * screenshot and the exported bytes.
 */
async function brepRoundTrip(
  page: Page,
): Promise<{ readonly shot: Buffer; readonly brep: Buffer }> {
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");
  const sourceVolume = await readSourceVolume(page);

  await page.locator("#io-export-brep").click();
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return (
      root !== null &&
      (root.getAttribute("data-export-brep-bytes") ?? "") !== ""
    );
  });
  const solids = await page
    .locator("#io-root")
    .getAttribute("data-export-brep-solids");
  expect(solids, "the export carries one solid").toBe("1");

  // The browser-produced bytes ARE the writer's whole truth: no timestamp,
  // no counter — and they equal the committed Node-written fixture
  // byte-for-byte, the cross-environment determinism pin.
  const brep = await fetchHeldBytes(page, "#io-download-brep");
  expect(brep.length).toBe(BREP_FIXTURE_BYTES.length);
  expect(brep.equals(BREP_FIXTURE_BYTES)).toBe(true);

  await page.locator("#io-import-brep").click();
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return root !== null && root.getAttribute("data-import-source") === "brep";
  });
  await waitForImportedMeshSettled(page);

  const surface = await readIoImportSurface(page);
  expect(surface.error, "the re-import must not report an error").toBe("");
  expect(surface.source, "the re-import must name its provenance").toBe("brep");
  expect(surface.detail).toBe(BREP_DETAIL_JSON);
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

  // Pixels: only after the settle stamp proved the frame carried the BREP.
  const shot = await page.locator("#io-import-viewport canvas").screenshot();
  return { shot, brep };
}

test("brep round trip: occt worker rebuild → export equals the committed fixture → re-import renders and agrees semantically", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");

  // The browser failure surface first: garbage BREP bytes fail with the
  // structured code, verbatim, and nothing becomes the imported view.
  await page.locator("#io-import-file").setInputFiles({
    name: "garbage.brep",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("this is not a BREP file"),
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return root !== null && root.getAttribute("data-import-error") !== "";
  });
  const garbageError = await page
    .locator("#io-root")
    .getAttribute("data-import-error");
  expect(garbageError).toContain("brep-import/malformed");
  expect(
    await page.locator("#io-root").getAttribute("data-import-source"),
    "a rejected import must not mint an imported view",
  ).toBe("");

  const first = await brepRoundTrip(page);
  await saveArtifact("io-roundtrip-brep-run1.png", first.shot);
  await saveArtifact("plate-exported.brep", first.brep);
  await page.screenshot({
    path: "e2e-artifacts/render/io-roundtrip-brep-fullpage.png",
    fullPage: true,
  });

  // A full second run: fresh document load, fresh OCCT worker — the same
  // fixture-equal bytes and a byte-identical settled scene.
  const second = await brepRoundTrip(page);
  expect(
    second.brep.equals(first.brep),
    `exported BREP run1 sha256=${sha256(first.brep)} vs run2 sha256=${sha256(second.brep)}`,
  ).toBe(true);
  expect(
    second.shot.equals(first.shot),
    `imported-BREP run1 sha256=${sha256(first.shot)} vs run2 sha256=${sha256(second.shot)}`,
  ).toBe(true);
  await saveArtifact("io-roundtrip-brep-run2.png", second.shot);
});

test("iges upload: main-thread fallback engine import → the mesh body renders with mesh-level provenance", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");

  // The failure surface first: garbage IGES bytes fail with the structured
  // code, verbatim, and nothing becomes the imported view.
  await page.locator("#io-import-file").setInputFiles({
    name: "garbage.igs",
    mimeType: "application/iges",
    buffer: Buffer.from("this is not an IGES file"),
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("io-root");
    return root !== null && root.getAttribute("data-import-error") !== "";
  });
  const garbageError = await page
    .locator("#io-root")
    .getAttribute("data-import-error");
  expect(garbageError).toContain("iges-import/malformed");
  expect(
    await page.locator("#io-root").getAttribute("data-import-source"),
    "a rejected import must not mint an imported view",
  ).toBe("");

  // The real import — this run pays the fallback engine's ~7.3 MB wasm
  // boot on the main thread.
  await uploadAndWaitForSource(
    page,
    "cube-10mm.igs",
    "application/iges",
    IGES_FIXTURE_BYTES,
    "iges",
  );
  await waitForImportedMeshSettled(page);

  const surface = await readIoImportSurface(page);
  expect(surface.error, "the import must not report an error").toBe("");
  expect(surface.source, "the IGES path must name its provenance").toBe("iges");
  expect(
    surface.detail,
    "the IGES detail must carry mesh-level origin, meshes, unit",
  ).toBe(IGES_DETAIL_JSON);
  expect(surface.extents, "the imported cube's bounds").toBe(IGES_EXTENTS_TEXT);
  expect(
    surface.triangles,
    "the imported mesh must carry triangles",
  ).toBeGreaterThan(0);
  const importedVolume = Number(surface.volumeExact);
  expect(
    Number.isFinite(importedVolume),
    `imported volume "${surface.volumeExact}"`,
  ).toBe(true);
  expect(
    Math.abs(importedVolume - IGES_VOLUME_MM3),
    `imported ${String(importedVolume)} vs cube ${String(IGES_VOLUME_MM3)}`,
  ).toBeLessThanOrEqual(IGES_VOLUME_MM3 * VOLUME_REL_TOLERANCE);

  // Pixels: only after the settle stamp proved the frame carried the cube.
  const shot = await page.locator("#io-import-viewport canvas").screenshot();
  await saveArtifact("io-import-iges-run1.png", shot);
  await page.screenshot({
    path: "e2e-artifacts/render/io-import-iges-fullpage.png",
    fullPage: true,
  });

  // A full second run: fresh page, fresh engine boot, the same committed
  // bytes — the same settled scene, byte for byte.
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");
  await uploadAndWaitForSource(
    page,
    "cube-10mm.igs",
    "application/iges",
    IGES_FIXTURE_BYTES,
    "iges",
  );
  await waitForImportedMeshSettled(page);
  const second = await readIoImportSurface(page);
  expect(second.detail).toBe(IGES_DETAIL_JSON);
  const secondShot = await page
    .locator("#io-import-viewport canvas")
    .screenshot();
  expect(
    secondShot.equals(shot),
    `imported-IGES run1 sha256=${sha256(shot)} vs run2 sha256=${sha256(secondShot)}`,
  ).toBe(true);
  await saveArtifact("io-import-iges-run2.png", secondShot);
});
