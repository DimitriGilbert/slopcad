import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { STL_HEADER_BYTES, STL_TRIANGLE_BYTES } from "@slopcad/cad-io";

import {
  readIoGlbSurface,
  readIoImportSurface,
  saveArtifact,
  sha256,
  waitForGlbViewerSettled,
  waitForImportedMeshSettled,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 18 phase-level browser deliverable — the mesh export/import
 * workflow e2e. Per the plan's Phase-level Validation: a browser round
 * trip succeeds and screenshots verify the imported geometry.
 *
 * Each round trip drives the /io fixture: the settled source plate is
 * exported IN-PAGE (the same soup the source viewport renders), the bytes
 * are pulled out of the page through the export's real download anchor,
 * re-imported through the fixture's import surface (STL parsed in the
 * browser; 3MF parsed by the app's own server, whose 18.4 importer is
 * Node-targeted), and the imported mesh rendered in its own deterministic
 * viewport. Semantic assertions read the machine surfaces: the imported
 * triangle count matches the source soup exactly, the imported volume
 * matches the source soup's divergence-theorem volume (exact numeric
 * identity for 3MF — lossless f64 text — and float32 tolerance for STL)
 * and the kernel volume within the established 0.5% band, provenance and
 * detail are honest, and the settle stamp agrees before pixels are taken.
 *
 * Screenshot baselines: the imported-mesh scene must render byte-identical
 * across two consecutive full runs (fresh page load, fresh worker, fresh
 * export/import) under SwiftShader — the render spec's determinism
 * discipline applied to the round trip. The exported FILE bytes are saved
 * as artifacts for human inspection (and asserted byte-identical across
 * runs — the exporters are deterministic). Runs against the production
 * build (see playwright.render.config.ts).
 */

const VOLUME_REL_TOLERANCE = 0.005;
/** STL float32 quantization: volume agrees to ~1e-7 relative; 1e-6 is slack. */
const STL_VOLUME_REL_TOLERANCE = 1e-6;
/** GLB float32 positions quantize like STL's; the same 1e-6 slack applies. */
const GLB_VOLUME_REL_TOLERANCE = 1e-6;

/** The settled plate's extents under the kernel placement conventions. */
const PLATE_EXTENTS_TEXT = "30.000 × 20.000 × 10.000";

/** What one round trip captures, for the cross-run byte comparisons. */
interface RoundTripCapture {
  readonly shot: Buffer;
  readonly fileBytes: Buffer;
  readonly sourceTriangles: number;
  readonly sourceVolume: number;
}

/** The /io fixture's settled source numbers (kernel volume + soup count). */
async function readSourceSurface(page: Page): Promise<{
  readonly volume: number;
  readonly triangles: number;
  readonly meshVolumeText: string;
}> {
  const volumeText = await page.locator("#io-source-volume").textContent();
  const volume = Number(volumeText);
  expect(Number.isFinite(volume), `#io-source-volume="${String(volumeText)}"`).toBe(true);
  const trianglesText = await page.locator("#io-source-triangles").textContent();
  const triangles = Number(trianglesText);
  expect(
    Number.isInteger(triangles) && triangles > 0,
    `#io-source-triangles="${String(trianglesText)}"`,
  ).toBe(true);
  const meshVolumeText = await page
    .locator("#io-root")
    .getAttribute("data-source-mesh-volume");
  expect(meshVolumeText, "the source mesh volume must be published").not.toBeNull();
  return { volume, triangles, meshVolumeText: meshVolumeText ?? "" };
}

/**
 * Pulls a held export's exact bytes through its download anchor: the blob
 * URL the anchor serves is fetched IN THE PAGE (the same bytes a human
 * downloading the file gets) and returned as base64.
 */
async function readDownloadBytes(page: Page, anchorId: string): Promise<Buffer> {
  const base64 = await page.evaluate((id) => {
    const anchor = document.getElementById(id);
    if (anchor === null || !(anchor instanceof HTMLAnchorElement)) {
      throw new Error(`download anchor #${id} is missing`);
    }
    return fetch(anchor.href)
      .then(async (response) => response.arrayBuffer())
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        // Chunked conversion: String.fromCharCode's argument count cap.
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
      });
  }, anchorId);
  return Buffer.from(base64, "base64");
}

/**
 * One full round trip on a fresh page: settle the source, export, capture
 * the exported bytes, import, settle the imported scene, run the semantic
 * assertions, capture the imported-mesh screenshot.
 */
async function roundTrip(
  page: Page,
  format: "stl" | "3mf",
): Promise<RoundTripCapture> {
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");
  const source = await readSourceSurface(page);

  // Export: the held bytes appear with the source soup's triangle count.
  const exportButton = page
    .locator(format === "stl" ? "#io-export-stl" : "#io-export-3mf");
  await exportButton.click();
  const root = page.locator("#io-root");
  const bytesText = await root.getAttribute(
    format === "stl" ? "data-export-stl-bytes" : "data-export-3mf-bytes",
  );
  expect(bytesText, "the export must publish its byte count").not.toBeNull();
  expect(Number(bytesText)).toBeGreaterThan(0);
  const exportTriangles = await root.getAttribute(
    format === "stl" ? "data-export-stl-triangles" : "data-export-3mf-triangles",
  );
  expect(
    exportTriangles,
    "the exported soup must carry the source triangle count",
  ).toBe(String(source.triangles));

  const fileBytes = await readDownloadBytes(
    page,
    format === "stl" ? "io-download-stl" : "io-download-3mf",
  );
  expect(fileBytes.length, "download bytes must match the published size").toBe(
    Number(bytesText),
  );
  if (format === "stl") {
    // Binary STL frame: 80-byte header + uint32 count + 50 bytes/triangle.
    expect(fileBytes.length).toBe(
      STL_HEADER_BYTES + 4 + STL_TRIANGLE_BYTES * source.triangles,
    );
  } else {
    // A 3MF document is an OPC package in a ZIP archive.
    expect(fileBytes.subarray(0, 2).toString("latin1")).toBe("PK");
  }

  // Import: the held bytes return through the format's honest path.
  await page
    .locator(format === "stl" ? "#io-import-stl" : "#io-import-3mf")
    .click();
  await waitForImportedMeshSettled(page);
  const surface = await readIoImportSurface(page);
  expect(surface.error, "the import must not report an error").toBe("");
  expect(surface.source).toBe(format);
  expect(
    surface.triangles,
    "the imported triangle count must equal the source soup's",
  ).toBe(source.triangles);
  expect(surface.extents, "the imported bounds must be the plate's").toBe(
    PLATE_EXTENTS_TEXT,
  );
  expect(surface.detail).toBe(
    format === "stl"
      ? '{"flavor":"binary"}'
      : '{"units":"millimeter","title":"slopcad plate"}',
  );

  // Volume semantics: the imported soup's divergence-theorem volume vs the
  // source soup's same measure (exact for 3MF's lossless f64 text, float32
  // tolerance for STL) and vs the kernel volume (the established band).
  const importedVolume = Number(surface.volumeExact);
  expect(Number.isFinite(importedVolume), `imported volume "${surface.volumeExact}"`).toBe(true);
  const sourceMeshVolume = Number(source.meshVolumeText);
  expect(Number.isFinite(sourceMeshVolume), `source mesh volume "${source.meshVolumeText}"`).toBe(true);
  if (format === "3mf") {
    expect(
      surface.volumeExact,
      "3MF round trip: the imported volume must equal the source soup's exactly",
    ).toBe(source.meshVolumeText);
  } else {
    expect(
      Math.abs(importedVolume - sourceMeshVolume),
      `STL float32 drift: ${String(importedVolume)} vs ${String(sourceMeshVolume)}`,
    ).toBeLessThanOrEqual(sourceMeshVolume * STL_VOLUME_REL_TOLERANCE);
  }
  expect(
    Math.abs(importedVolume - source.volume),
    `imported ${String(importedVolume)} vs kernel ${String(source.volume)}`,
  ).toBeLessThanOrEqual(source.volume * VOLUME_REL_TOLERANCE);

  // Pixels: only now — the settle stamp proved the frame carried the mesh.
  const shot = await page.locator("#io-import-viewport canvas").screenshot();
  return { shot, fileBytes, sourceTriangles: source.triangles, sourceVolume: source.volume };
}

for (const format of ["3mf", "stl"] as const) {
  test(`${format} round trip: export → import → the imported mesh renders and agrees semantically`, async ({
    page,
  }) => {
    const first = await roundTrip(page, format);
    await saveArtifact(`io-import-${format}-run1.png`, first.shot);
    await saveArtifact(`round-trip.${format}`, first.fileBytes);
    await page.screenshot({
      path: `e2e-artifacts/render/io-roundtrip-${format}-fullpage.png`,
      fullPage: true,
    });

    // A full second run: fresh document load, fresh worker, fresh export
    // and import — the same bytes and the same settled scene must result.
    const second = await roundTrip(page, format);
    expect(
      second.sourceTriangles,
      "the second run must export the same soup",
    ).toBe(first.sourceTriangles);
    expect(second.sourceVolume).toBe(first.sourceVolume);
    expect(
      second.fileBytes.equals(first.fileBytes),
      `exported ${format} bytes are deterministic`,
    ).toBe(true);
    expect(
      second.shot.equals(first.shot),
      `imported-scene run1 sha256=${sha256(first.shot)} vs run2 sha256=${sha256(second.shot)}`,
    ).toBe(true);

    await saveArtifact(`io-import-${format}-run2.png`, second.shot);
  });
}

/**
 * One full GLB round trip on a fresh page: settle the source, export the
 * RENDER PROJECTION to GLB, capture the bytes, load them through three's
 * GLTFLoader (the reference viewer), settle the loaded scene, run the
 * semantic assertions, capture the viewer screenshot.
 */
async function glbRoundTrip(page: Page): Promise<RoundTripCapture> {
  await page.goto("/io");
  await waitForSettledScene(page, "io-root");
  const source = await readSourceSurface(page);

  // Export: the held GLB appears with the source soup's triangle count.
  await page.locator("#io-export-glb").click();
  const root = page.locator("#io-root");
  const bytesText = await root.getAttribute("data-export-glb-bytes");
  expect(bytesText, "the GLB export must publish its byte count").not.toBeNull();
  expect(Number(bytesText)).toBeGreaterThan(0);
  const exportTriangles = await root.getAttribute("data-export-glb-triangles");
  expect(
    exportTriangles,
    "the exported GLB must carry the source triangle count",
  ).toBe(String(source.triangles));

  const fileBytes = await readDownloadBytes(page, "io-download-glb");
  expect(fileBytes.length, "download bytes must match the published size").toBe(
    Number(bytesText),
  );
  // GLB container: 12-byte header — magic "glTF", version 2, total length.
  expect(fileBytes.subarray(0, 4).toString("latin1")).toBe("glTF");
  expect(fileBytes.readUInt32LE(4)).toBe(2);
  expect(fileBytes.readUInt32LE(8)).toBe(fileBytes.length);

  // Reference viewer: the held bytes load through three's GLTFLoader and
  // the loaded scene settles in its own deterministic viewport.
  await page.locator("#io-load-glb").click();
  await waitForGlbViewerSettled(page);
  const glb = await readIoGlbSurface(page);
  expect(glb.error, "the GLB load must not report an error").toBe("");
  expect(glb.status, "GLTFLoader must report the load").toBe("loaded");
  // The loaded scene: one node named from the body id, carrying the
  // source soup's triangle count in decoded float32 geometry.
  const loadedNodes = JSON.parse(glb.nodes) as {
    name: string;
    vertices: number;
    triangles: number;
  }[];
  expect(loadedNodes.length, "the loaded scene must carry exactly one mesh").toBe(1);
  expect(loadedNodes[0]?.name, "the node name must preserve the body id").toBe(
    "body_plate",
  );
  expect(
    loadedNodes[0]?.triangles,
    "the decoded triangle count must equal the source soup's",
  ).toBe(source.triangles);
  expect(
    (loadedNodes[0]?.vertices ?? 0) > 0,
    "the decoded mesh must have vertices",
  ).toBe(true);
  expect(
    JSON.parse(glb.material),
    "the loaded material must be the documented CadScene material",
  ).toEqual({ colorHex: "8aadf4", metalness: 0.15, roughness: 0.55 });
  expect(glb.extents, "the loaded bounds must be the plate's").toBe(
    PLATE_EXTENTS_TEXT,
  );

  // Volume semantics: the decoded soup's divergence-theorem volume vs the
  // source soup's same measure (float32 tolerance — GLB positions are
  // float32) and vs the kernel volume (the established band).
  const loadedVolume = Number(glb.volumeExact);
  expect(Number.isFinite(loadedVolume), `loaded volume "${glb.volumeExact}"`).toBe(true);
  const sourceMeshVolume = Number(source.meshVolumeText);
  expect(Number.isFinite(sourceMeshVolume), `source mesh volume "${source.meshVolumeText}"`).toBe(true);
  expect(
    Math.abs(loadedVolume - sourceMeshVolume),
    `GLB float32 drift: ${String(loadedVolume)} vs ${String(sourceMeshVolume)}`,
  ).toBeLessThanOrEqual(sourceMeshVolume * GLB_VOLUME_REL_TOLERANCE);
  expect(
    Math.abs(loadedVolume - source.volume),
    `loaded ${String(loadedVolume)} vs kernel ${String(source.volume)}`,
  ).toBeLessThanOrEqual(source.volume * VOLUME_REL_TOLERANCE);

  // Pixels: only now — the settle stamp proved the frame carried the mesh.
  const shot = await page.locator("#io-glb-viewport canvas").screenshot();
  return { shot, fileBytes, sourceTriangles: source.triangles, sourceVolume: source.volume };
}

test("glb round trip: export → GLTFLoader reference viewer → the loaded GLB renders and agrees semantically", async ({
  page,
}) => {
  const first = await glbRoundTrip(page);
  await saveArtifact("io-glb-viewer-run1.png", first.shot);
  await saveArtifact("round-trip.glb", first.fileBytes);
  await page.screenshot({
    path: "e2e-artifacts/render/io-roundtrip-glb-fullpage.png",
    fullPage: true,
  });

  // A full second run: fresh document load, fresh worker, fresh export and
  // load — the same bytes and the same settled viewer scene must result.
  const second = await glbRoundTrip(page);
  expect(
    second.sourceTriangles,
    "the second run must export the same soup",
  ).toBe(first.sourceTriangles);
  expect(second.sourceVolume).toBe(first.sourceVolume);
  expect(
    second.fileBytes.equals(first.fileBytes),
    "exported GLB bytes are deterministic",
  ).toBe(true);
  expect(
    second.shot.equals(first.shot),
    `GLB viewer run1 sha256=${sha256(first.shot)} vs run2 sha256=${sha256(second.shot)}`,
  ).toBe(true);

  await saveArtifact("io-glb-viewer-run2.png", second.shot);
});

test("the 3MF import endpoint rejects malformed bytes with a structured failure", async ({
  request,
}) => {
  const response = await request.post("/api/io/import-3mf", {
    data: Buffer.from("this is not a zip archive, let alone a 3MF document"),
  });
  expect(response.status()).toBe(422);
  const payload = (await response.json()) as { ok: unknown; code?: unknown };
  expect(payload.ok).toBe(false);
  expect(String(payload.code)).toMatch(/^three-mf-import\//);
});
