/**
 * 3MF import unit tests (Phase 18.4): the export → import semantic
 * round-trip against the Phase 18.3 exporter (exact f64 positions — 3MF
 * decimals cross no float32 boundary — counts, index structure, bounds,
 * divergence-theorem volume, units, metadata), the externally authored
 * fixture under `../fixtures/` (a hand-built package with deflate
 * entries, a centimeter unit, a ZIP comment, and an extra thumbnail
 * relationship — none of which our exporter produces), the ST_Unit
 * conversion factors, structured rejection of every documented failure
 * class, and no-throw probes over seeded random bytes, every truncation
 * of a real export, mutated model XML, and deflate-flipped entries.
 *
 * Malformed packages are built by an independent test-side ZIP writer
 * (stored and deflate, its own bitwise CRC-32) so the importer is never
 * fed its own output shape by accident; semantic volume/bounds judgments
 * reuse `./stl-test-reader`'s helpers, never the importer's bookkeeping.
 */

import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createBodyId, length, projectTessellation } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  type Tessellation,
  createFakeKernel,
  tessellationTriangleCount,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";

import { type ThreeMfExportResult, exportThreeMf } from "./three-mf-export";
import {
  type ImportedThreeMfMesh,
  type ThreeMfImportError,
  type ThreeMfImportErrorCode,
  type ThreeMfImportResult,
  THREE_MF_IMPORT_ERROR_CODES,
  THREE_MF_IMPORT_MAX_PART_BYTES,
  THREE_MF_IMPORT_MAX_XML_ELEMENTS,
  THREE_MF_UNIT_TO_MILLIMETER_FACTORS,
  importThreeMf,
} from "./three-mf-import";
import { positionsBounds, tessellationVolumeMm3 } from "./stl-test-reader";

const BOX_VOLUME_MM3 = 2 * 3 * 4;
/** The external fixture's tetrahedron: (1.5 × 2 × 2.5) cm³ = 1250 mm³. */
const FIXTURE_VOLUME_MM3 = 1250;
const ALL_FAILURE_CODES: readonly string[] = Object.values(
  THREE_MF_IMPORT_ERROR_CODES,
);

const mm = (value: number) => length(value, "mm");

function unwrapThreeMf(result: ThreeMfExportResult): Uint8Array {
  if (result.ok) return result.value;
  throw new Error(
    `3MF export failed with ${result.error.code}: ${result.error.message}`,
  );
}

function unwrapImport(result: ThreeMfImportResult): ImportedThreeMfMesh {
  if (result.ok) return result.value;
  throw new Error(
    `3MF import failed with ${result.error.code}: ${result.error.message}`,
  );
}

function expectImportFailure(
  result: ThreeMfImportResult,
  code: ThreeMfImportErrorCode,
  label: string,
): ThreeMfImportError {
  if (result.ok) {
    throw new Error(`${label}: expected failure with ${code} but succeeded.`);
  }
  if (result.error.code !== code) {
    throw new Error(
      `${label}: expected failure with ${code} but got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.error;
}

/** Deterministic PRNG (mulberry32) so the fuzz probes never flake. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeBoxTessellation(
  kernel: GeometryKernel,
  width: number,
  depth: number,
  height: number,
): Tessellation {
  const box = unwrapKernelResult(
    kernel.createBox({
      width: mm(width),
      depth: mm(depth),
      height: mm(height),
    }),
    "createBox",
  );
  return unwrapKernelResult(kernel.tessellate(box), "tessellate");
}

function fakeBoxMinusBoreTessellation(kernel: GeometryKernel): Tessellation {
  const plate = unwrapKernelResult(
    kernel.createBox({ width: mm(30), depth: mm(20), height: mm(10) }),
    "createBox",
  );
  const cylinder = unwrapKernelResult(
    kernel.createCylinder({ radius: mm(4), height: mm(10) }),
    "createCylinder",
  );
  const bore = unwrapKernelResult(
    kernel.transform(cylinder, { x: mm(15), y: mm(10), z: mm(0) }),
    "transform",
  );
  const drilled = unwrapKernelResult(
    kernel.subtract(plate, [bore]),
    "subtract",
  );
  return unwrapKernelResult(kernel.tessellate(drilled), "tessellate");
}

/**
 * Structural contract of an imported 3MF mesh: an *indexed* soup (the
 * format preserves vertex sharing, unlike STL), finite positions, indices
 * in range, and never a normals field — 3MF core carries none, so none
 * are ever synthesized.
 */
function expectConsistentMesh(mesh: ImportedThreeMfMesh): void {
  const { positions, indices, normals } = mesh.tessellation;
  expect(normals).toBeUndefined();
  expect(indices.length % 3).toBe(0);
  expect(positions.length % 3).toBe(0);
  const vertexCount = positions.length / 3;
  for (const value of positions) {
    expect(Number.isFinite(value)).toBe(true);
  }
  for (const index of indices) {
    expect(Number.isInteger(index)).toBe(true);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(vertexCount);
  }
}

/** Every imported position is exactly (`===`) the source position. */
function expectPositionsExactly(
  imported: ImportedThreeMfMesh,
  source: Tessellation,
): void {
  expect(imported.tessellation.positions.length).toBe(source.positions.length);
  for (let i = 0; i < source.positions.length; i += 1) {
    const parsed = imported.tessellation.positions[i];
    const expected = source.positions[i];
    if (parsed !== expected) {
      throw new Error(
        `Position ${i}: imported ${String(parsed)} is not exactly the source ${String(expected)}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Test-side ZIP writer (independent of both the exporter and the importer)
// ---------------------------------------------------------------------------

/** CRC-32 (PKWARE ZIP polynomial), bitwise long division — its own
 * implementation so nothing about the importer's checksums is assumed. */
function crc32Of(data: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const rightmost = crc & 1;
      crc >>>= 1;
      if (rightmost === 1) {
        crc ^= 0xedb88320;
      }
    }
  }
  return ~crc >>> 0;
}

const testEncoder = new TextEncoder();
const DOS_DATE = (1980 - 1980) * 512 + 1 * 32 + 1;
const DOS_TIME = 0;

/** One part for the test-side writer: name, bytes, compression method. */
interface TestZipPart {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

function part(
  name: string,
  data: string | Uint8Array,
  method: 0 | 8 = 0,
): TestZipPart {
  return {
    name,
    data: typeof data === "string" ? testEncoder.encode(data) : data,
    method,
  };
}

/**
 * Lays out a minimal deterministic ZIP: fixed 1980-01-01 timestamps, no
 * extra fields, optional stored or deflate entries, optional EOCD
 * comment — everything the importer's tolerances are probed with.
 */
function buildTestZip(
  parts: readonly TestZipPart[],
  eocdComment = "",
): Uint8Array {
  const plans = parts.map((entry) => {
    const nameBytes = testEncoder.encode(entry.name);
    const compressed =
      entry.method === 8 ? deflateRawSync(entry.data) : entry.data;
    return {
      nameBytes,
      compressed,
      crc: crc32Of(entry.data),
    };
  });
  let cursor = 0;
  const localOffsets: number[] = [];
  for (const [i, entry] of parts.entries()) {
    localOffsets.push(cursor);
    cursor +=
      30 +
      testEncoder.encode(entry.name).length +
      (plans[i]?.compressed.length ?? 0);
  }
  const centralOffset = cursor;
  let centralSize = 0;
  for (const plan of plans) {
    centralSize += 46 + plan.nameBytes.length;
  }
  const commentBytes = testEncoder.encode(eocdComment);
  const bytes = new Uint8Array(
    centralOffset + centralSize + 22 + commentBytes.length,
  );
  const view = new DataView(bytes.buffer);
  for (const [i, plan] of plans.entries()) {
    const offset = localOffsets[i] ?? 0;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, (parts[i]?.method ?? 0) === 8 ? 8 : 0, true);
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, plan.crc, true);
    view.setUint32(offset + 18, plan.compressed.length, true);
    view.setUint32(offset + 22, parts[i]?.data.length ?? 0, true);
    view.setUint16(offset + 26, plan.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    bytes.set(plan.nameBytes, offset + 30);
    bytes.set(plan.compressed, offset + 30 + plan.nameBytes.length);
  }
  let central = centralOffset;
  for (const [i, plan] of plans.entries()) {
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 0x0014, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, 0, true);
    view.setUint16(central + 10, (parts[i]?.method ?? 0) === 8 ? 8 : 0, true);
    view.setUint16(central + 12, DOS_TIME, true);
    view.setUint16(central + 14, DOS_DATE, true);
    view.setUint32(central + 16, plan.crc, true);
    view.setUint32(central + 20, plan.compressed.length, true);
    view.setUint32(central + 24, parts[i]?.data.length ?? 0, true);
    view.setUint16(central + 28, plan.nameBytes.length, true);
    view.setUint16(central + 30, 0, true);
    view.setUint16(central + 32, 0, true);
    view.setUint16(central + 34, 0, true);
    view.setUint16(central + 36, 0, true);
    view.setUint32(central + 38, 0, true);
    view.setUint32(central + 42, localOffsets[i] ?? 0, true);
    bytes.set(plan.nameBytes, central + 46);
    central += 46 + plan.nameBytes.length;
  }
  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 4, 0, true);
  view.setUint16(central + 6, 0, true);
  view.setUint16(central + 8, parts.length, true);
  view.setUint16(central + 10, parts.length, true);
  view.setUint32(central + 12, centralSize, true);
  view.setUint32(central + 16, centralOffset, true);
  view.setUint16(central + 20, commentBytes.length, true);
  bytes.set(commentBytes, central + 22);
  return bytes;
}

function expectBytesIdentical(
  a: Uint8Array,
  b: Uint8Array,
  label: string,
): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      throw new Error(`${label}: first differing byte at ${i}.`);
    }
  }
}

/** A copy of `bytes` with one little-endian uint16 field overwritten. */
function withUint16At(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint16(offset, value, true);
  return copy;
}

/** A copy of `bytes` with one little-endian uint32 field overwritten. */
function withUint32At(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

// ---------------------------------------------------------------------------
// Canonical part texts for hand-built packages
// ---------------------------------------------------------------------------

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  "</Types>\n";

const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>' +
  "</Relationships>\n";

/** The canonical single-object millimetre tetrahedron model part. */
const TETRA_MODEL_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
  "  <resources>\n" +
  '    <object id="1" type="model">\n' +
  "      <mesh>\n" +
  "        <vertices>\n" +
  '          <vertex x="0" y="0" z="0"/>\n' +
  '          <vertex x="10" y="0" z="0"/>\n' +
  '          <vertex x="0" y="10" z="0"/>\n' +
  '          <vertex x="0" y="0" z="10"/>\n' +
  "        </vertices>\n" +
  "        <triangles>\n" +
  '          <triangle v1="0" v2="2" v3="1"/>\n' +
  '          <triangle v1="0" v2="3" v3="2"/>\n' +
  '          <triangle v1="0" v2="1" v3="3"/>\n' +
  '          <triangle v1="1" v2="2" v3="3"/>\n' +
  "        </triangles>\n" +
  "      </mesh>\n" +
  "    </object>\n" +
  "  </resources>\n" +
  "  <build>\n" +
  '    <item objectid="1"/>\n' +
  "  </build>\n" +
  "</model>\n";

/** A stored canonical three-part package around a custom model XML. */
function modelPackage(modelXml: string | Uint8Array): Uint8Array {
  return buildTestZip([
    part("[Content_Types].xml", CONTENT_TYPES_XML),
    part("_rels/.rels", RELS_XML),
    part("3D/3dmodel.model", modelXml),
  ]);
}

// ---------------------------------------------------------------------------
// The external fixture: deflate entries, centimeter unit, ZIP comment
// ---------------------------------------------------------------------------

/** The fixture's rels: a routine thumbnail relationship alongside the
 * StartPart, with attribute order unlike ours — real-world shape. */
const FIXTURE_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="relThumb" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="/Metadata/thumbnail.png"/>' +
  '<Relationship Target="/3D/3dmodel.model" Id="relModel" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  "</Relationships>\n";

/** The fixture's model: CRLF lines, an XML comment, entity-bearing
 * description, an unknown metadata name, and a single-quoted attribute. */
const FIXTURE_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<!-- Externally authored 3MF fixture (slopcad Phase 18.4) -->",
  '<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <metadata name="Title">External tetrahedron</metadata>',
  '  <metadata name="Designer">Another CAD</metadata>',
  '  <metadata name="Description">Hand-authored centimeter fixture &lt;phase 18.4&gt;</metadata>',
  '  <metadata name="Application">External Author 1.0</metadata>',
  "  <resources>",
  '    <object id="1" type="model">',
  "      <mesh>",
  "        <vertices>",
  '          <vertex x="0" y="0" z="0"/>',
  '          <vertex x="1.5" y="0" z="0"/>',
  '          <vertex x="0" y="2" z="0"/>',
  '          <vertex x="0" y="0" z="2.5"/>',
  "        </vertices>",
  "        <triangles>",
  '          <triangle v1="0" v2="2" v3="1"/>',
  '          <triangle v1="0" v2="3" v3="2"/>',
  '          <triangle v1="0" v2="1" v3="3"/>',
  '          <triangle v1="1" v2="2" v3="3"/>',
  "        </triangles>",
  "      </mesh>",
  "    </object>",
  "  </resources>",
  "  <build>",
  "    <item objectid='1'/>",
  "  </build>",
  "</model>",
  "",
].join("\r\n");

/** Regenerates the committed external fixture byte-for-byte (provenance). */
function rebuildExternalFixture(): Uint8Array {
  return buildTestZip(
    [
      part("[Content_Types].xml", CONTENT_TYPES_XML, 8),
      part("_rels/.rels", FIXTURE_RELS_XML, 8),
      part("3D/3dmodel.model", FIXTURE_MODEL_XML, 8),
    ],
    "slopcad phase 18.4 external fixture",
  );
}

const fixtureUrl = new URL(
  "../fixtures/tetrahedron-centimeter.3mf",
  import.meta.url,
);
const fixtureBytes = new Uint8Array(readFileSync(fixtureUrl));

// ---------------------------------------------------------------------------
// Shared scene geometry
// ---------------------------------------------------------------------------

const box = fakeBoxTessellation(createFakeKernel(), 2, 3, 4);
const boxPackage = unwrapThreeMf(exportThreeMf(box));

describe("importThreeMf round-trip (18.3 export → import)", () => {
  it("preserves vertex and triangle counts and the exact index structure", () => {
    const imported = unwrapImport(importThreeMf(boxPackage));
    expect(tessellationTriangleCount(imported.tessellation)).toBe(
      tessellationTriangleCount(box),
    );
    expect(imported.tessellation.positions.length).toBe(box.positions.length);
    expect(imported.tessellation.indices).toEqual(box.indices);
  });

  it("preserves every f64 position exactly — 3MF decimals are lossless", () => {
    const imported = unwrapImport(importThreeMf(boxPackage));
    expectPositionsExactly(imported, box);
  });

  it("preserves bounds exactly", () => {
    const imported = unwrapImport(importThreeMf(boxPackage));
    const importedBounds = positionsBounds(imported.tessellation.positions);
    const sourceBounds = positionsBounds(box.positions);
    expect([...importedBounds.min]).toEqual([...sourceBounds.min]);
    expect([...importedBounds.max]).toEqual([...sourceBounds.max]);
    expect([...importedBounds.max]).toEqual([2, 3, 4]);
  });

  it("preserves the divergence-theorem volume", () => {
    const imported = unwrapImport(importThreeMf(boxPackage));
    expect(tessellationVolumeMm3(imported.tessellation)).toBe(
      tessellationVolumeMm3(box),
    );
    expect(tessellationVolumeMm3(imported.tessellation)).toBeCloseTo(
      BOX_VOLUME_MM3,
      12,
    );
  });

  it("round-trips an indexed boolean-result soup exactly", () => {
    const soup = fakeBoxMinusBoreTessellation(createFakeKernel());
    const imported = unwrapImport(
      importThreeMf(unwrapThreeMf(exportThreeMf(soup))),
    );
    expectConsistentMesh(imported);
    expect(imported.tessellation.indices).toEqual(soup.indices);
    expectPositionsExactly(imported, soup);
    expect(tessellationVolumeMm3(imported.tessellation)).toBe(
      tessellationVolumeMm3(soup),
    );
  });

  it("round-trips f64 coordinates that fixed-width binary formats mangle", () => {
    const quirky: Tessellation = {
      positions: [
        1 / 3,
        2 / 3,
        1e-7,
        5e-324,
        1.5,
        1e21,
        -1.25e-9,
        123456789.12345679,
        -7,
        0.1,
        0,
        3,
      ],
      indices: [0, 2, 1, 0, 3, 2, 0, 1, 3, 1, 2, 3],
    };
    const imported = unwrapImport(
      importThreeMf(unwrapThreeMf(exportThreeMf(quirky))),
    );
    expectPositionsExactly(imported, quirky);
    expect(imported.tessellation.indices).toEqual(quirky.indices);
  });

  it("surfaces the source unit as millimeter and pins the payload shape", () => {
    const imported = unwrapImport(importThreeMf(boxPackage));
    expect(imported.units).toBe("millimeter");
    expect(Object.keys(imported).sort()).toEqual([
      "metadata",
      "tessellation",
      "units",
    ]);
    expect(Object.keys(imported.tessellation).sort()).toEqual([
      "indices",
      "positions",
    ]);
  });

  it("round-trips all three metadata fields, XML escaping included", () => {
    const metadata = {
      title: `A & B <i>quoted</i> 'single' "double" > end`,
      designer: "didi",
      description: "Plate with bore, phase 18.4 round-trip.",
    };
    const imported = unwrapImport(
      importThreeMf(unwrapThreeMf(exportThreeMf(box, metadata))),
    );
    expect(imported.metadata).toEqual(metadata);
  });

  it("imports no metadata keys when the model carries none", () => {
    const imported = unwrapImport(importThreeMf(boxPackage));
    expect(Object.keys(imported.metadata)).toEqual([]);
  });

  it("is deterministic: identical bytes import to identical values", () => {
    const first = unwrapImport(importThreeMf(boxPackage));
    const second = unwrapImport(importThreeMf(new Uint8Array(boxPackage)));
    expect(first.tessellation.positions).toEqual(second.tessellation.positions);
    expect(first.tessellation.indices).toEqual(second.tessellation.indices);
    expect(first.units).toBe(second.units);
    expect(first.metadata).toEqual(second.metadata);
  });
});

describe("importThreeMf external fixture (deflate, centimeter, metadata)", () => {
  it("committed fixture matches its documented generator byte-for-byte", () => {
    expectBytesIdentical(
      fixtureBytes,
      rebuildExternalFixture(),
      "Committed fixture vs regenerated package",
    );
  });

  it("imports deflate entries and surfaces the declared centimeter unit", () => {
    const imported = unwrapImport(importThreeMf(fixtureBytes));
    expect(imported.units).toBe("centimeter");
    expectConsistentMesh(imported);
  });

  it("converts centimeter coordinates to exact millimetres", () => {
    const imported = unwrapImport(importThreeMf(fixtureBytes));
    expect(imported.tessellation.positions).toEqual([
      0, 0, 0, 15, 0, 0, 0, 20, 0, 0, 0, 25,
    ]);
    expect(imported.tessellation.indices).toEqual([
      0, 2, 1, 0, 3, 2, 0, 1, 3, 1, 2, 3,
    ]);
  });

  it("computes the documented volume and bounds after conversion", () => {
    const imported = unwrapImport(importThreeMf(fixtureBytes));
    expect(tessellationVolumeMm3(imported.tessellation)).toBe(
      FIXTURE_VOLUME_MM3,
    );
    const bounds = positionsBounds(imported.tessellation.positions);
    expect([...bounds.min]).toEqual([0, 0, 0]);
    expect([...bounds.max]).toEqual([15, 20, 25]);
  });

  it("preserves the three well-known metadata fields and drops others", () => {
    const imported = unwrapImport(importThreeMf(fixtureBytes));
    expect(Object.keys(imported.metadata).sort()).toEqual([
      "description",
      "designer",
      "title",
    ]);
    expect(imported.metadata.title).toBe("External tetrahedron");
    expect(imported.metadata.designer).toBe("Another CAD");
    expect(imported.metadata.description).toBe(
      "Hand-authored centimeter fixture <phase 18.4>",
    );
  });

  it("imports the stored-entry rebuild of the same parts identically", () => {
    const fromDeflate = unwrapImport(importThreeMf(fixtureBytes));
    const fromStored = unwrapImport(
      importThreeMf(
        buildTestZip([
          part("[Content_Types].xml", CONTENT_TYPES_XML),
          part("_rels/.rels", FIXTURE_RELS_XML),
          part("3D/3dmodel.model", FIXTURE_MODEL_XML),
        ]),
      ),
    );
    expect(fromStored.units).toBe(fromDeflate.units);
    expect(fromStored.tessellation.positions).toEqual(
      fromDeflate.tessellation.positions,
    );
    expect(fromStored.tessellation.indices).toEqual(
      fromDeflate.tessellation.indices,
    );
    expect(fromStored.metadata).toEqual(fromDeflate.metadata);
  });

  it("re-exports to canonical millimetres and re-imports identically", () => {
    const imported = unwrapImport(importThreeMf(fixtureBytes));
    const reExported = unwrapThreeMf(
      exportThreeMf(imported.tessellation, imported.metadata),
    );
    const reImported = unwrapImport(importThreeMf(reExported));
    expect(reImported.units).toBe("millimeter");
    expect(reImported.tessellation.positions).toEqual(
      imported.tessellation.positions,
    );
    expect(reImported.tessellation.indices).toEqual(
      imported.tessellation.indices,
    );
    expect(reImported.metadata).toEqual(imported.metadata);
    expect(tessellationVolumeMm3(reImported.tessellation)).toBe(
      FIXTURE_VOLUME_MM3,
    );
  });
});

describe("importThreeMf unit conversion", () => {
  /** A tetra model in `unit` whose B/C/D vertices are the given triples. */
  function unitPackage(
    unit: string,
    bcd: readonly (readonly [number, number, number])[],
  ): Uint8Array {
    const [b, c, d] = bcd;
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
      `  <resources><object id="1" type="model"><mesh>\n` +
      `    <vertices>\n` +
      `      <vertex x="0" y="0" z="0"/>\n` +
      `      <vertex x="${b?.[0]}" y="${b?.[1]}" z="${b?.[2]}"/>\n` +
      `      <vertex x="${c?.[0]}" y="${c?.[1]}" z="${c?.[2]}"/>\n` +
      `      <vertex x="${d?.[0]}" y="${d?.[1]}" z="${d?.[2]}"/>\n` +
      `    </vertices>\n` +
      `    <triangles>\n` +
      `      <triangle v1="0" v2="2" v3="1"/>\n` +
      `      <triangle v1="0" v2="3" v3="2"/>\n` +
      `      <triangle v1="0" v2="1" v3="3"/>\n` +
      `      <triangle v1="1" v2="2" v3="3"/>\n` +
      `    </triangles>\n` +
      `  </mesh></object></resources>\n` +
      `  <build><item objectid="1"/></build>\n` +
      `</model>\n`;
    return modelPackage(xml);
  }

  it("applies the documented exact ST_Unit factors", () => {
    expect(THREE_MF_UNIT_TO_MILLIMETER_FACTORS).toEqual({
      micron: 0.001,
      millimeter: 1,
      centimeter: 10,
      inch: 25.4,
      foot: 304.8,
      meter: 1000,
    });
  });

  it("converts micron, inch, foot, and meter coordinates to millimetres", () => {
    const micron = unwrapImport(
      importThreeMf(
        unitPackage("micron", [
          [100, 0, 0],
          [0, 200, 0],
          [0, 0, 250],
        ]),
      ),
    );
    expect(micron.units).toBe("micron");
    expect(micron.tessellation.positions).toEqual([
      0, 0, 0, 0.1, 0, 0, 0, 0.2, 0, 0, 0, 0.25,
    ]);

    const inch = unwrapImport(
      importThreeMf(
        unitPackage("inch", [
          [1, 0, 0],
          [0, 0.5, 0],
          [0, 0, 3],
        ]),
      ),
    );
    expect(inch.units).toBe("inch");
    expect(inch.tessellation.positions[3]).toBe(25.4);
    expect(inch.tessellation.positions[7]).toBe(12.7);
    expect(inch.tessellation.positions[11]).toBeCloseTo(76.2, 12);

    const foot = unwrapImport(
      importThreeMf(
        unitPackage("foot", [
          [1, 0, 0],
          [0, 2, 0],
          [0, 0, 1],
        ]),
      ),
    );
    expect(foot.tessellation.positions[3]).toBe(304.8);

    const meter = unwrapImport(
      importThreeMf(
        unitPackage("meter", [
          [1.5, 0, 0],
          [0, 0.25, 0],
          [0, 0, 1],
        ]),
      ),
    );
    expect(meter.tessellation.positions).toEqual([
      0, 0, 0, 1500, 0, 0, 0, 250, 0, 0, 0, 1000,
    ]);
  });

  it("defaults to millimeter when the unit attribute is absent", () => {
    const xml = TETRA_MODEL_XML.replace(' unit="millimeter"', "");
    const imported = unwrapImport(importThreeMf(modelPackage(xml)));
    expect(imported.units).toBe("millimeter");
    expect(imported.tessellation.positions[3]).toBe(10);
  });
});

describe("importThreeMf rejects malformed input (per failure class)", () => {
  it("three-mf-import/empty: zero bytes, no build, empty build, no triangles", () => {
    expectImportFailure(
      importThreeMf(new Uint8Array(0)),
      "three-mf-import/empty",
      "Zero-byte input",
    );
    expectImportFailure(
      importThreeMf(
        modelPackage(TETRA_MODEL_XML.replace(/<build>[\s\S]*<\/build>\n/, "")),
      ),
      "three-mf-import/empty",
      "Model without a build",
    );
    expectImportFailure(
      importThreeMf(
        modelPackage(TETRA_MODEL_XML.replace('    <item objectid="1"/>\n', "")),
      ),
      "three-mf-import/empty",
      "Build without items",
    );
    expectImportFailure(
      importThreeMf(
        modelPackage(TETRA_MODEL_XML.replace(/<triangle[^>]*\/>\n/g, "")),
      ),
      "three-mf-import/empty",
      "Mesh with no triangles",
    );
  });

  it("three-mf-import/not-a-zip: framing defects", () => {
    const printable = new Uint8Array(64).fill(0x41);
    expectImportFailure(
      importThreeMf(printable),
      "three-mf-import/not-a-zip",
      "Printable garbage",
    );
    const badEocd = new Uint8Array(boxPackage);
    badEocd[badEocd.length - 22] = 0x51;
    expectImportFailure(
      importThreeMf(badEocd),
      "three-mf-import/not-a-zip",
      "Corrupted EOCD signature",
    );
    expectImportFailure(
      importThreeMf(boxPackage.subarray(0, 21)),
      "three-mf-import/not-a-zip",
      "Shorter than an EOCD record",
    );
    const badCentral = new Uint8Array(boxPackage);
    const centralOffset = new DataView(badCentral.buffer).getUint32(
      badCentral.length - 6,
      true,
    );
    badCentral[centralOffset] = 0x51;
    expectImportFailure(
      importThreeMf(badCentral),
      "three-mf-import/not-a-zip",
      "Corrupted central directory signature",
    );
    expectImportFailure(
      importThreeMf(withUint16At(boxPackage, boxPackage.length - 22 + 8, 4)),
      "three-mf-import/not-a-zip",
      "EOCD entry count disagrees with the entries walked",
    );
    expectImportFailure(
      importThreeMf(
        withUint32At(boxPackage, boxPackage.length - 22 + 16, 0xffffffff),
      ),
      "three-mf-import/not-a-zip",
      "ZIP64 central-directory offset sentinel",
    );
  });

  it("three-mf-import/not-a-zip: unsupported methods, encryption, local/central disagreement", () => {
    const centralOffset = new DataView(boxPackage.buffer).getUint32(
      boxPackage.length - 6,
      true,
    );
    const thirdCentral =
      centralOffset +
      2 * 46 +
      "[Content_Types].xml".length +
      "_rels/.rels".length;
    const localOffsetOfThird = new DataView(boxPackage.buffer).getUint32(
      thirdCentral + 42,
      true,
    );
    const methodBoth = withUint16At(
      withUint16At(boxPackage, thirdCentral + 10, 12),
      localOffsetOfThird + 8,
      12,
    );
    expectImportFailure(
      importThreeMf(methodBoth),
      "three-mf-import/not-a-zip",
      "Compression method 12 in both records",
    );
    expectImportFailure(
      importThreeMf(withUint16At(boxPackage, thirdCentral + 8, 0x0001)),
      "three-mf-import/not-a-zip",
      "Encrypted entry flag",
    );
    const renamedLocal = new Uint8Array(boxPackage);
    renamedLocal[30] = 0x28; // '[' of the first entry's local name becomes '('
    expectImportFailure(
      importThreeMf(renamedLocal),
      "three-mf-import/not-a-zip",
      "Local header names a different entry",
    );
    expectImportFailure(
      importThreeMf(withUint32At(boxPackage, thirdCentral + 20, 999)),
      "three-mf-import/not-a-zip",
      "Central compressed size disagrees with the local header",
    );
  });

  it("three-mf-import/crc-mismatch: corrupted stored data", () => {
    const corrupted = new Uint8Array(modelPackage(TETRA_MODEL_XML));
    const view = new DataView(corrupted.buffer);
    const centralOffset = view.getUint32(corrupted.length - 6, true);
    // Third entry is the model; find its local data start and flip a byte.
    const thirdCentral =
      centralOffset +
      2 * 46 +
      "[Content_Types].xml".length +
      "_rels/.rels".length;
    const localOffset = view.getUint32(thirdCentral + 42, true);
    const nameLength = view.getUint16(localOffset + 26, true);
    corrupted[localOffset + 30 + nameLength] =
      (corrupted[localOffset + 30 + nameLength] ?? 0) ^ 0x20;
    expectImportFailure(
      importThreeMf(corrupted),
      "three-mf-import/crc-mismatch",
      "Model part data byte flipped",
    );
  });

  it("three-mf-import/bad-compression: broken deflate and the size cap", () => {
    const junkDeflate = buildTestZip([
      part("[Content_Types].xml", CONTENT_TYPES_XML),
      part("_rels/.rels", RELS_XML),
      part("3D/3dmodel.model", TETRA_MODEL_XML, 8),
    ]);
    const view = new DataView(junkDeflate.buffer);
    const centralOffset = view.getUint32(junkDeflate.length - 6, true);
    const thirdCentral =
      centralOffset +
      2 * 46 +
      "[Content_Types].xml".length +
      "_rels/.rels".length;
    const localOffset = view.getUint32(thirdCentral + 42, true);
    const nameLength = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + nameLength;
    const ruined = new Uint8Array(junkDeflate);
    for (let i = 0; i < 12; i += 1) {
      ruined[dataStart + i] = 0xff;
    }
    const outcome = importThreeMf(ruined);
    if (outcome.ok) {
      throw new Error("Broken deflate stream unexpectedly imported.");
    }
    expect([
      "three-mf-import/bad-compression",
      "three-mf-import/crc-mismatch",
      "three-mf-import/not-a-zip",
    ]).toContain(outcome.error.code);

    const cap = THREE_MF_IMPORT_MAX_PART_BYTES + 1;
    const overCap = withUint32At(
      withUint32At(junkDeflate, thirdCentral + 24, cap),
      localOffset + 22,
      cap,
    );
    expectImportFailure(
      importThreeMf(overCap),
      "three-mf-import/bad-compression",
      "Declared expansion beyond the cap",
    );
  });

  it("three-mf-import/missing-part: required parts and unresolvable targets", () => {
    const withoutContentTypes = buildTestZip([
      part("_rels/.rels", RELS_XML),
      part("3D/3dmodel.model", TETRA_MODEL_XML),
    ]);
    expectImportFailure(
      importThreeMf(withoutContentTypes),
      "three-mf-import/missing-part",
      "No [Content_Types].xml entry",
    );
    const withoutRels = buildTestZip([
      part("[Content_Types].xml", CONTENT_TYPES_XML),
      part("3D/3dmodel.model", TETRA_MODEL_XML),
    ]);
    expectImportFailure(
      importThreeMf(withoutRels),
      "three-mf-import/missing-part",
      "No _rels/.rels entry",
    );
    const danglingTarget = RELS_XML.replace(
      "/3D/3dmodel.model",
      "/3D/missing.model",
    );
    expectImportFailure(
      importThreeMf(
        buildTestZip([
          part("[Content_Types].xml", CONTENT_TYPES_XML),
          part("_rels/.rels", danglingTarget),
          part("3D/3dmodel.model", TETRA_MODEL_XML),
        ]),
      ),
      "three-mf-import/missing-part",
      "StartPart target resolves to no entry",
    );
  });

  it("three-mf-import/bad-relationship: absent, duplicated, external, duplicate ids", () => {
    const modelType =
      "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
    const thumbnailType =
      "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail";
    const relsPackage = (relsXml: string): Uint8Array =>
      buildTestZip([
        part("[Content_Types].xml", CONTENT_TYPES_XML),
        part("_rels/.rels", relsXml),
        part("3D/3dmodel.model", TETRA_MODEL_XML),
      ]);
    const relsBody = (relationshipTags: readonly string[]): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      relationshipTags.join("") +
      "</Relationships>\n";
    expectImportFailure(
      importThreeMf(
        relsPackage(
          relsBody([
            `<Relationship Id="rel0" Type="${thumbnailType}" Target="/3D/3dmodel.model"/>`,
          ]),
        ),
      ),
      "three-mf-import/bad-relationship",
      "No 3MF StartPart relationship",
    );
    expectImportFailure(
      importThreeMf(
        relsPackage(
          relsBody([
            `<Relationship Id="rel0" Type="${modelType}" Target="/3D/3dmodel.model"/>`,
            `<Relationship Id="rel1" Type="${modelType}" Target="/3D/3dmodel.model"/>`,
          ]),
        ),
      ),
      "three-mf-import/bad-relationship",
      "Two 3MF StartPart relationships",
    );
    expectImportFailure(
      importThreeMf(
        relsPackage(
          relsBody([
            `<Relationship Id="rel0" Type="${modelType}" Target="http://elsewhere.example/3dmodel.model" TargetMode="External"/>`,
          ]),
        ),
      ),
      "three-mf-import/bad-relationship",
      "External StartPart target",
    );
    expectImportFailure(
      importThreeMf(
        relsPackage(
          relsBody([
            `<Relationship Id="rel0" Type="${thumbnailType}" Target="/Metadata/thumbnail.png"/>`,
            `<Relationship Id="rel0" Type="${modelType}" Target="/3D/3dmodel.model"/>`,
          ]),
        ),
      ),
      "three-mf-import/bad-relationship",
      "Duplicate relationship ids",
    );
  });

  it("three-mf-import/invalid-content-type: wrong or missing model type", () => {
    const wrongDefault = CONTENT_TYPES_XML.replace(
      'Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"',
      'Extension="model" ContentType="text/plain"',
    );
    const parts = (contentTypes: string): readonly TestZipPart[] => [
      part("[Content_Types].xml", contentTypes),
      part("_rels/.rels", RELS_XML),
      part("3D/3dmodel.model", TETRA_MODEL_XML),
    ];
    expectImportFailure(
      importThreeMf(buildTestZip(parts(wrongDefault))),
      "three-mf-import/invalid-content-type",
      "Model default content type is text/plain",
    );
    const noModelType = CONTENT_TYPES_XML.replace(
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
      "",
    );
    expectImportFailure(
      importThreeMf(buildTestZip(parts(noModelType))),
      "three-mf-import/invalid-content-type",
      "Model content type never declared",
    );
  });

  it("three-mf-import/invalid-unit: values outside ST_Unit", () => {
    for (const unit of ["furlong", "MM", "millimetres", ""]) {
      expectImportFailure(
        importThreeMf(
          modelPackage(
            TETRA_MODEL_XML.replace('unit="millimeter"', `unit="${unit}"`),
          ),
        ),
        "three-mf-import/invalid-unit",
        `unit="${unit}"`,
      );
    }
  });

  it("three-mf-import/not-a-zip: entry-level framing defects", () => {
    const view = new DataView(
      boxPackage.buffer,
      boxPackage.byteOffset,
      boxPackage.byteLength,
    );
    const centralOffset = view.getUint32(boxPackage.length - 6, true);
    const thirdCentral =
      centralOffset +
      2 * 46 +
      "[Content_Types].xml".length +
      "_rels/.rels".length;
    const thirdLocal = view.getUint32(thirdCentral + 42, true);
    expectImportFailure(
      importThreeMf(
        buildTestZip([
          part("[Content_Types].xml", CONTENT_TYPES_XML),
          part("_rels/.rels", RELS_XML),
          part("3D/3dmodel.model", TETRA_MODEL_XML),
          part("3D/3dmodel.model", TETRA_MODEL_XML),
        ]),
      ),
      "three-mf-import/not-a-zip",
      "Duplicate entry names",
    );
    expectImportFailure(
      importThreeMf(withUint16At(boxPackage, boxPackage.length - 22 + 4, 1)),
      "three-mf-import/not-a-zip",
      "Multi-disk archive",
    );
    expectImportFailure(
      importThreeMf(withUint32At(boxPackage, thirdCentral + 42, 1)),
      "three-mf-import/not-a-zip",
      "Local header offset points at junk",
    );
    const notUtf8Name = new Uint8Array(boxPackage);
    notUtf8Name[30] = 0xff;
    notUtf8Name[centralOffset + 46] = 0xff;
    expectImportFailure(
      importThreeMf(notUtf8Name),
      "three-mf-import/not-a-zip",
      "Entry name is not UTF-8",
    );
    expectImportFailure(
      importThreeMf(withUint16At(boxPackage, thirdCentral + 30, 0xfff0)),
      "three-mf-import/not-a-zip",
      "Central extra-field length runs past the archive",
    );
    expectImportFailure(
      importThreeMf(
        withUint32At(
          withUint32At(boxPackage, thirdCentral + 20, 0x7ffffff0),
          thirdLocal + 18,
          0x7ffffff0,
        ),
      ),
      "three-mf-import/not-a-zip",
      "Declared data region runs past the buffer",
    );
    expectImportFailure(
      importThreeMf(withUint32At(boxPackage, thirdCentral + 24, 0xffffffff)),
      "three-mf-import/not-a-zip",
      "ZIP64 uncompressed-size sentinel",
    );
    // A stored entry whose central record claims a different uncompressed
    // size, hidden behind a data-descriptor flag from the local/central
    // comparison: the stored-branch mismatch itself must fire.
    const storedMismatch = withUint32At(
      withUint16At(boxPackage, thirdCentral + 8, 0x0008),
      thirdCentral + 24,
      999,
    );
    expectImportFailure(
      importThreeMf(storedMismatch),
      "three-mf-import/not-a-zip",
      "Stored entry with compressed ≠ uncompressed size",
    );
    expectImportFailure(
      importThreeMf(withUint16At(boxPackage, thirdCentral + 34, 1)),
      "three-mf-import/not-a-zip",
      "Entry starts on another disk",
    );
    expectImportFailure(
      importThreeMf(withUint32At(boxPackage, thirdCentral + 42, 0xffffffff)),
      "three-mf-import/not-a-zip",
      "ZIP64 local-header offset sentinel",
    );
    expectImportFailure(
      importThreeMf(withUint16At(boxPackage, thirdCentral + 28, 0xfff0)),
      "three-mf-import/not-a-zip",
      "Central name length runs past the archive",
    );
    expectImportFailure(
      importThreeMf(withUint16At(boxPackage, thirdLocal + 26, 0x7fff)),
      "three-mf-import/not-a-zip",
      "Local name length runs past the archive",
    );
    // A deflate entry declaring one byte less than it inflates to.
    const deflated = buildTestZip([
      part("[Content_Types].xml", CONTENT_TYPES_XML),
      part("_rels/.rels", RELS_XML),
      part("3D/3dmodel.model", TETRA_MODEL_XML, 8),
    ]);
    const deflatedView = new DataView(deflated.buffer);
    const deflatedCentral =
      deflatedView.getUint32(deflated.length - 6, true) +
      2 * 46 +
      "[Content_Types].xml".length +
      "_rels/.rels".length;
    const deflatedLocal = deflatedView.getUint32(deflatedCentral + 42, true);
    const declared = deflatedView.getUint32(deflatedCentral + 24, true) + 1;
    expectImportFailure(
      importThreeMf(
        withUint32At(
          withUint32At(deflated, deflatedCentral + 24, declared),
          deflatedLocal + 22,
          declared,
        ),
      ),
      "three-mf-import/not-a-zip",
      "Deflate entry inflates to less than declared",
    );
  });

  it("three-mf-import/malformed-xml: OPC parts with defects", () => {
    const parts = (
      contentTypes: string,
      rels: string,
    ): readonly TestZipPart[] => [
      part("[Content_Types].xml", contentTypes),
      part("_rels/.rels", rels),
      part("3D/3dmodel.model", TETRA_MODEL_XML),
    ];
    const cases: readonly [string, Uint8Array][] = [
      [
        "content-types root in the wrong namespace",
        buildTestZip(
          parts(
            CONTENT_TYPES_XML.replace(
              "http://schemas.openxmlformats.org/package/2006/content-types",
              "http://example.invalid/ct",
            ),
            RELS_XML,
          ),
        ),
      ],
      [
        "Default without a ContentType",
        buildTestZip(
          parts(
            CONTENT_TYPES_XML.replace(
              'ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"',
              "",
            ),
            RELS_XML,
          ),
        ),
      ],
      [
        "duplicate Default extension",
        buildTestZip(
          parts(
            CONTENT_TYPES_XML.replace(
              "</Types>",
              '<Default Extension="rels" ContentType="text/plain"/></Types>',
            ),
            RELS_XML,
          ),
        ),
      ],
      [
        "unknown element in the content-types stream",
        buildTestZip(
          parts(
            CONTENT_TYPES_XML.replace("</Types>", "<junk/></Types>"),
            RELS_XML,
          ),
        ),
      ],
      [
        "relationships root in the wrong namespace",
        buildTestZip(
          parts(
            CONTENT_TYPES_XML,
            RELS_XML.replace(
              "http://schemas.openxmlformats.org/package/2006/relationships",
              "http://example.invalid/rels",
            ),
          ),
        ),
      ],
      [
        "Relationship without a Target",
        buildTestZip(
          parts(
            CONTENT_TYPES_XML,
            RELS_XML.replace(' Target="/3D/3dmodel.model"', ""),
          ),
        ),
      ],
      [
        "unknown element among relationships",
        buildTestZip(
          parts(
            CONTENT_TYPES_XML,
            RELS_XML.replace("</Relationships>", "<junk/></Relationships>"),
          ),
        ),
      ],
    ];
    for (const [label, bytes] of cases) {
      expectImportFailure(
        importThreeMf(bytes),
        "three-mf-import/malformed-xml",
        label,
      );
    }
    expectImportFailure(
      importThreeMf(
        buildTestZip(
          parts(
            CONTENT_TYPES_XML,
            RELS_XML.replace('Target="/3D/3dmodel.model"', 'Target="/"'),
          ),
        ),
      ),
      "three-mf-import/bad-relationship",
      "Empty StartPart target",
    );
    expectImportFailure(
      importThreeMf(
        buildTestZip([
          part("[Content_Types].xml", CONTENT_TYPES_XML),
          // A model part with no extension: nothing to resolve a Default by.
          part(
            "_rels/.rels",
            RELS_XML.replace("/3D/3dmodel.model", "/3D/3dmodel"),
          ),
          part("3D/3dmodel", TETRA_MODEL_XML),
        ]),
      ),
      "three-mf-import/invalid-content-type",
      "Model part name without an extension",
    );
  });

  it("three-mf-import/malformed-xml: XML token and structure defects", () => {
    const core = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
    const cases: readonly [string, string | Uint8Array][] = [
      ["non-UTF-8 model part", new Uint8Array([0xff, 0xfe, 0x00, 0x01])],
      ["wrong root element", TETRA_MODEL_XML.replace(/model/g, "shape")],
      [
        "missing core namespace",
        TETRA_MODEL_XML.replace(` xmlns="${core}"`, ""),
      ],
      [
        "prefixed root",
        TETRA_MODEL_XML.replace(
          `<model unit="millimeter"`,
          `<m:model unit="millimeter"`,
        ).replace("</model>", "</m:model>"),
      ],
      [
        "DOCTYPE declaration",
        TETRA_MODEL_XML.replace(
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE model>',
        ),
      ],
      ["unclosed element", TETRA_MODEL_XML.replace("</vertices>", "")],
      [
        "mismatched end tag",
        TETRA_MODEL_XML.replace("</triangles>", "</verts>"),
      ],
      [
        "duplicate attribute",
        TETRA_MODEL_XML.replace(
          '<triangle v1="0" v2="2" v3="1"/>',
          '<triangle v1="0" v1="1" v2="2" v3="1"/>',
        ),
      ],
      [
        "unknown entity",
        TETRA_MODEL_XML.replace(
          '<vertex x="0" y="0" z="0"/>',
          '<vertex x="&nope;" y="0" z="0"/>',
        ),
      ],
      [
        "literal < inside an attribute",
        TETRA_MODEL_XML.replace(
          '<vertex x="0" y="0" z="0"/>',
          '<vertex x="<1" y="0" z="0"/>',
        ),
      ],
      [
        "text at document level",
        `stray<?xml version="1.0"?>`.concat(TETRA_MODEL_XML),
      ],
      [
        "content after the root element",
        TETRA_MODEL_XML.replace("</model>\n", "</model>\n<extra/>"),
      ],
      [
        "character data inside <resources>",
        TETRA_MODEL_XML.replace("<resources>", "<resources>junk"),
      ],
      [
        "vertices after triangles (order)",
        (() => {
          const verticesBlock =
            TETRA_MODEL_XML.match(/ {8}<vertices>[\s\S]*?<\/vertices>/)?.[0] ??
            "";
          const trianglesBlock =
            TETRA_MODEL_XML.match(
              / {8}<triangles>[\s\S]*?<\/triangles>/,
            )?.[0] ?? "";
          return TETRA_MODEL_XML.replace(
            `${verticesBlock}\n${trianglesBlock}`,
            `${trianglesBlock}\n${verticesBlock}`,
          );
        })(),
      ],
      [
        "unterminated entity",
        TETRA_MODEL_XML.replace(
          '<vertex x="0" y="0" z="0"/>',
          '<vertex x="&nope" y="0" z="0"/>',
        ),
      ],
      [
        "numeric reference with non-hex digits",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          '  <metadata name="Title">&#xZZ;</metadata>\n  <resources>',
        ),
      ],
      [
        "CDATA with an illegal character",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          '  <metadata name="Title"><![CDATA[bell \u0007]]></metadata>\n  <resources>',
        ),
      ],
      [
        "start tag is never terminated",
        TETRA_MODEL_XML.slice(0, TETRA_MODEL_XML.indexOf("<resources>") + 4),
      ],
      [
        "end tag closes an element that is not open",
        TETRA_MODEL_XML.replace("</model>\n", "</model>\n</junk>\n"),
      ],
      ["empty model part", ""],
      [
        "numeric character reference beyond the character set",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          '  <metadata name="Title">&#1114112;</metadata>\n  <resources>',
        ),
      ],
      [
        "numeric character reference to a surrogate",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          '  <metadata name="Title">&#xD800;</metadata>\n  <resources>',
        ),
      ],
      [
        "comment is never closed",
        `<?xml version="1.0" encoding="UTF-8"?><!-- dangling\n`.concat(
          TETRA_MODEL_XML.slice(TETRA_MODEL_XML.indexOf("\n") + 1),
        ),
      ],
      [
        "comment contains --",
        TETRA_MODEL_XML.replace(
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<?xml version="1.0" encoding="UTF-8"?><!-- a -- b -->',
        ),
      ],
      [
        "processing instruction is never closed",
        TETRA_MODEL_XML.replace(
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<?xml version="1.0" encoding="UTF-8"?><?pi dangling',
        ),
      ],
      [
        "CDATA section is never closed",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          '  <metadata name="Title"><![CDATA[dangling</metadata>\n  <resources>',
        ),
      ],
      [
        "control character in character data",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          `  <metadata name="Title">bell \u0007</metadata>\n  <resources>`,
        ),
      ],
      [
        "character data directly under <model>",
        TETRA_MODEL_XML.replace(
          '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
          '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">junk',
        ),
      ],
      [
        "metadata after <resources>",
        TETRA_MODEL_XML.replace(
          "  </resources>",
          '  </resources>\n  <metadata name="Title">late</metadata>',
        ),
      ],
      [
        "second <resources>",
        TETRA_MODEL_XML.replace(
          "  </resources>",
          "  </resources>\n  <resources/>",
        ),
      ],
      [
        "second <build>",
        TETRA_MODEL_XML.replace(
          "  </build>",
          '  </build>\n  <build><item objectid="1"/></build>',
        ),
      ],
      [
        "resources without an object",
        TETRA_MODEL_XML.replace(/ {4}<object[\s\S]*?<\/object>\n/, ""),
      ],
      [
        "object without a mesh",
        TETRA_MODEL_XML.replace(/ {6}<mesh>[\s\S]*?<\/mesh>\n/, ""),
      ],
      [
        "unknown element inside <object>",
        TETRA_MODEL_XML.replace(
          '    <object id="1" type="model">',
          '    <object id="1" type="model">\n      <junk/>',
        ),
      ],
      [
        "unknown element inside <build>",
        TETRA_MODEL_XML.replace("  <build>", "  <build>\n    <junk/>"),
      ],
      [
        "mesh without a vertices element",
        TETRA_MODEL_XML.replace(/ {8}<vertices>[\s\S]*?<\/vertices>\n/, ""),
      ],
      [
        "mesh without a triangles element",
        TETRA_MODEL_XML.replace(/ {8}<triangles>[\s\S]*?<\/triangles>\n/, ""),
      ],
      [
        "second <vertices> element",
        TETRA_MODEL_XML.replace(
          "        </vertices>",
          "        </vertices>\n        <vertices/>",
        ),
      ],
      [
        "object id is not integer text",
        TETRA_MODEL_XML.replace('id="1"', 'id="one"'),
      ],
      [
        "build item objectid is not integer text",
        TETRA_MODEL_XML.replace('objectid="1"', 'objectid="one"'),
      ],
      [
        "metadata with an element child",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          '  <metadata name="Title"><b>bold</b></metadata>\n  <resources>',
        ),
      ],
      ["object without id", TETRA_MODEL_XML.replace(' id="1"', "")],
      [
        "build item references a nonexistent object",
        TETRA_MODEL_XML.replace('objectid="1"', 'objectid="9"'),
      ],
      [
        "unknown unprefixed element inside <mesh>",
        TETRA_MODEL_XML.replace(
          "      <mesh>",
          "      <mesh>\n        <junk/>",
        ),
      ],
      [
        "duplicate metadata name",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          '  <metadata name="Title">A</metadata>\n  <metadata name="Title">B</metadata>\n  <resources>',
        ),
      ],
      [
        "metadata without a name",
        TETRA_MODEL_XML.replace(
          "  <resources>",
          "  <metadata>no name</metadata>\n  <resources>",
        ),
      ],
    ];
    for (const [label, model] of cases) {
      expectImportFailure(
        importThreeMf(modelPackage(model)),
        "three-mf-import/malformed-xml",
        label,
      );
    }
  });

  it("three-mf-import/count-mismatch: unparseable repeated geometry elements", () => {
    const cases: readonly [string, string][] = [
      [
        "vertex missing z",
        TETRA_MODEL_XML.replace(
          '<vertex x="10" y="0" z="0"/>',
          '<vertex x="10" y="0"/>',
        ),
      ],
      [
        "vertex x not decimal text",
        TETRA_MODEL_XML.replace(
          '<vertex x="10" y="0" z="0"/>',
          '<vertex x="abc" y="0" z="0"/>',
        ),
      ],
      [
        "vertex x is the xs:double INF spelling",
        TETRA_MODEL_XML.replace(
          '<vertex x="10" y="0" z="0"/>',
          '<vertex x="INF" y="0" z="0"/>',
        ),
      ],
      [
        "triangle missing v3",
        TETRA_MODEL_XML.replace(
          '<triangle v1="0" v2="2" v3="1"/>',
          '<triangle v1="0" v2="2"/>',
        ),
      ],
      [
        "triangle v2 not integer text",
        TETRA_MODEL_XML.replace(
          '<triangle v1="0" v2="2" v3="1"/>',
          '<triangle v1="0" v2="1.5" v3="1"/>',
        ),
      ],
      [
        "foreign element among triangles",
        TETRA_MODEL_XML.replace(
          "        <triangles>",
          "        <triangles>\n          <junk/>",
        ),
      ],
      [
        "character data among vertices",
        TETRA_MODEL_XML.replace("        <vertices>", "        <vertices>junk"),
      ],
    ];
    for (const [label, model] of cases) {
      expectImportFailure(
        importThreeMf(modelPackage(model)),
        "three-mf-import/count-mismatch",
        label,
      );
    }
  });

  it("three-mf-import/non-finite-vertex: overflow in place and after conversion", () => {
    expectImportFailure(
      importThreeMf(
        modelPackage(
          TETRA_MODEL_XML.replace(
            '<vertex x="10" y="0" z="0"/>',
            '<vertex x="1e999" y="0" z="0"/>',
          ),
        ),
      ),
      "three-mf-import/non-finite-vertex",
      "Coordinate parses to infinity",
    );
    const centimeterOverflow = TETRA_MODEL_XML.replace(
      'unit="millimeter"',
      'unit="centimeter"',
    ).replace(
      '<vertex x="10" y="0" z="0"/>',
      '<vertex x="2e307" y="0" z="0"/>',
    );
    expectImportFailure(
      importThreeMf(modelPackage(centimeterOverflow)),
      "three-mf-import/non-finite-vertex",
      "Finite centimetres converting to infinite millimetres",
    );
  });

  it("three-mf-import/degenerate-index: negative, out of range, repeated", () => {
    const cases: readonly [string, string][] = [
      [
        "negative index",
        TETRA_MODEL_XML.replace(
          'v1="0" v2="2" v3="1"',
          'v1="-1" v2="2" v3="1"',
        ),
      ],
      [
        "index at the vertex count",
        TETRA_MODEL_XML.replace('v1="0" v2="2" v3="1"', 'v1="4" v2="2" v3="1"'),
      ],
      [
        "repeated index within a triangle",
        TETRA_MODEL_XML.replace('v1="0" v2="2" v3="1"', 'v1="2" v2="2" v3="1"'),
      ],
    ];
    for (const [label, model] of cases) {
      expectImportFailure(
        importThreeMf(modelPackage(model)),
        "three-mf-import/degenerate-index",
        label,
      );
    }
  });

  it("three-mf-import/unsupported-structure: out-of-scope constructs", () => {
    const cases: readonly [string, string][] = [
      [
        "two objects",
        TETRA_MODEL_XML.replace(
          "    </object>\n",
          `    </object>\n    <object id="2" type="model"><mesh><vertices><vertex x="1" y="1" z="1"/><vertex x="2" y="1" z="1"/><vertex x="1" y="2" z="1"/><vertex x="1" y="1" z="2"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>\n`,
        ),
      ],
      [
        "two build items",
        TETRA_MODEL_XML.replace(
          '    <item objectid="1"/>',
          '    <item objectid="1"/>\n    <item objectid="1"/>',
        ),
      ],
      [
        "transformed build item",
        TETRA_MODEL_XML.replace(
          '<item objectid="1"/>',
          '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 5 5"/>',
        ),
      ],
      [
        "components composite",
        TETRA_MODEL_XML.replace(
          "      <mesh>",
          '      <components><component objectid="1"/></components>\n      <mesh>',
        ),
      ],
      [
        "non-model object type",
        TETRA_MODEL_XML.replace('type="model"', 'type="support"'),
      ],
      [
        "required extensions",
        TETRA_MODEL_XML.replace(
          "<model ",
          '<model requiredextensions="http://example.com/ext" ',
        ),
      ],
    ];
    for (const [label, model] of cases) {
      expectImportFailure(
        importThreeMf(modelPackage(model)),
        "three-mf-import/unsupported-structure",
        label,
      );
    }
  });
});

describe("importThreeMf resource ceilings (parse-stage amplification bounds)", () => {
  it("refuses a small package whose inflated model XML exceeds the element ceiling", () => {
    // The amplification shape: a package of kilobytes on the wire (deflate)
    // whose inflated model text asks for a million-plus-element DOM. The
    // ceiling must refuse it as a structured result — never a throw, never
    // the multi-GB parse.
    const bombXml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
      '  <resources><object id="1" type="model"><mesh><vertices>\n' +
      "<a/>".repeat(THREE_MF_IMPORT_MAX_XML_ELEMENTS) +
      '</vertices><triangles><triangle v1="0" v2="0" v3="0"/></triangles></mesh></object></resources>\n' +
      '  <build><item objectid="1"/></build>\n' +
      "</model>\n";
    const bombPackage = buildTestZip([
      part("[Content_Types].xml", CONTENT_TYPES_XML),
      part("_rels/.rels", RELS_XML),
      part("3D/3dmodel.model", bombXml, 8),
    ]);
    expect(bombPackage.byteLength).toBeLessThan(1024 * 1024);
    const error = expectImportFailure(
      importThreeMf(bombPackage),
      "three-mf-import/unsupported-structure",
      "Model XML beyond the element ceiling",
    );
    expect(error.message).toContain(String(THREE_MF_IMPORT_MAX_XML_ELEMENTS));
  });

  it("imports a legal document of exactly the ceiling element count", () => {
    // A model padded to EXACTLY THREE_MF_IMPORT_MAX_XML_ELEMENTS elements
    // with foreign-namespace fillers — parsed and counted by the ceiling,
    // skipped by the interpretation — must still import: the ceiling is a
    // true ceiling (`>`), not one element below it. The element-open count
    // of the built text is asserted below so the arithmetic here cannot
    // silently drift off the boundary.
    const fillerCount = THREE_MF_IMPORT_MAX_XML_ELEMENTS - 16;
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:x="http://example.invalid/x">\n' +
      '  <resources><object id="1" type="model"><mesh><vertices>\n' +
      '<vertex x="0" y="0" z="0"/>\n' +
      '<vertex x="10" y="0" z="0"/>\n' +
      '<vertex x="0" y="10" z="0"/>\n' +
      '<vertex x="0" y="0" z="10"/>\n' +
      "<x:e/>\n".repeat(fillerCount) +
      "</vertices><triangles>\n" +
      '<triangle v1="0" v2="2" v3="1"/>\n' +
      '<triangle v1="0" v2="3" v3="2"/>\n' +
      '<triangle v1="0" v2="1" v3="3"/>\n' +
      '<triangle v1="1" v2="2" v3="3"/>\n' +
      "</triangles></mesh></object></resources>\n" +
      '  <build><item objectid="1"/></build>\n' +
      "</model>\n";
    const elementOpens = xml.match(/<[A-Za-z_:]/g)?.length ?? 0;
    expect(elementOpens).toBe(THREE_MF_IMPORT_MAX_XML_ELEMENTS);
    const imported = unwrapImport(importThreeMf(modelPackage(xml)));
    expect(imported.tessellation.positions).toEqual([
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10,
    ]);
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
    expectConsistentMesh(imported);
  });

  it("still imports a tiny valid 3MF under the ceilings", () => {
    const imported = unwrapImport(importThreeMf(modelPackage(TETRA_MODEL_XML)));
    expect(imported.tessellation.positions).toEqual([
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10,
    ]);
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
  });
});

describe("importThreeMf tolerances (what well-formed external files may do)", () => {
  it("decodes predefined and numeric entities and CDATA in metadata text", () => {
    const xml = TETRA_MODEL_XML.replace(
      "  <resources>",
      '  <metadata name="Title">A &amp; B &quot;q&quot; &apos;a&apos; &#65;&#x42;<![CDATA[<literal &>]]> emoji \u{1F6E0} end</metadata>\n' +
        "  <resources>",
    );
    const imported = unwrapImport(importThreeMf(modelPackage(xml)));
    expect(imported.metadata.title).toBe(
      `A & B "q" 'a' AB<literal &> emoji \u{1F6E0} end`,
    );
  });

  it("resolves the model part through an Override instead of a Default", () => {
    const overrideContentTypes =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
      "</Types>\n";
    const imported = unwrapImport(
      importThreeMf(
        buildTestZip([
          part("[Content_Types].xml", overrideContentTypes),
          part("_rels/.rels", RELS_XML),
          part("3D/3dmodel.model", TETRA_MODEL_XML),
        ]),
      ),
    );
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
  });

  it("skips prefixed foreign-namespace elements wherever extensions may appear", () => {
    const xml = TETRA_MODEL_XML.replace(
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:x="http://example.invalid/x">',
    )
      .replace("  <resources>", "  <x:extra/><resources>")
      .replace("      <mesh>", "      <x:meshinfo/><mesh>")
      .replace(
        "        <triangles>",
        "        <triangles>\n          <x:tri/>",
      );
    // The replaces must all have applied — a silent no-op would make this
    // test assert nothing about extension tolerance.
    expect(xml).toContain("<x:extra/>");
    expect(xml).toContain("<x:meshinfo/>");
    expect(xml).toContain("<x:tri/>");
    const imported = unwrapImport(importThreeMf(modelPackage(xml)));
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
  });

  it("ignores object naming attributes it has no destination for", () => {
    const xml = TETRA_MODEL_XML.replace(
      '<object id="1" type="model">',
      '<object id="1" type="model" name="Tetra" pid="0" pindex="0">',
    );
    const imported = unwrapImport(importThreeMf(modelPackage(xml)));
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
  });

  it("ignores relationships of other types and their missing targets", () => {
    const relsWithExtras =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="relThumb" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="/Metadata/thumbnail.png"/>' +
      '<Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>' +
      "</Relationships>\n";
    const imported = unwrapImport(
      importThreeMf(
        buildTestZip([
          part("[Content_Types].xml", CONTENT_TYPES_XML),
          part("_rels/.rels", relsWithExtras),
          part("3D/3dmodel.model", TETRA_MODEL_XML),
        ]),
      ),
    );
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
  });

  it("accepts a slash-less StartPart target (root-relative resolution)", () => {
    const relsSlashless = RELS_XML.replace(
      "/3D/3dmodel.model",
      "3D/3dmodel.model",
    );
    const imported = unwrapImport(
      importThreeMf(
        buildTestZip([
          part("[Content_Types].xml", CONTENT_TYPES_XML),
          part("_rels/.rels", relsSlashless),
          part("3D/3dmodel.model", TETRA_MODEL_XML),
        ]),
      ),
    );
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
  });

  it("tolerates a trailing ZIP comment and central-directory extra fields", () => {
    const withComment = buildTestZip(
      [
        part("[Content_Types].xml", CONTENT_TYPES_XML),
        part("_rels/.rels", RELS_XML),
        part("3D/3dmodel.model", TETRA_MODEL_XML),
      ],
      "a comment an external tool might leave",
    );
    const imported = unwrapImport(importThreeMf(withComment));
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
  });
});

describe("importThreeMf never throws on hostile bytes", () => {
  it("returns a structured result for seeded random buffers", () => {
    const random = mulberry32(4242);
    let failures = 0;
    for (let i = 0; i < 400; i += 1) {
      const byteLength = Math.floor(random() ** 2 * 700);
      const bytes = new Uint8Array(byteLength);
      for (let b = 0; b < byteLength; b += 1) {
        bytes[b] = Math.floor(random() * 256);
      }
      const result = importThreeMf(bytes);
      if (result.ok) {
        expectConsistentMesh(result.value);
      } else {
        failures += 1;
        expect(ALL_FAILURE_CODES).toContain(result.error.code);
      }
    }
    expect(failures).toBeGreaterThan(0);
  });

  it("returns a classified failure for every truncation of a real export", () => {
    for (let cut = 0; cut < boxPackage.byteLength; cut += 1) {
      const result = importThreeMf(boxPackage.subarray(0, cut));
      if (result.ok) {
        throw new Error(`Truncation at ${cut} bytes unexpectedly imported.`);
      }
      const expected: ThreeMfImportErrorCode =
        cut === 0 ? "three-mf-import/empty" : "three-mf-import/not-a-zip";
      if (result.error.code !== expected) {
        throw new Error(
          `Truncation at ${cut} bytes: expected ${expected} but got ${result.error.code}.`,
        );
      }
    }
  });

  it("returns a structured result for seeded model-XML mutations", () => {
    const random = mulberry32(0xfeed);
    const alphabet = '0123456789.eE+- \tnxyz</">=';
    const chars = [...TETRA_MODEL_XML];
    for (let i = 0; i < 150; i += 1) {
      const mutated = [...chars];
      const mutations = 1 + Math.floor(random() * 4);
      for (let m = 0; m < mutations; m += 1) {
        const at = Math.floor(random() * mutated.length);
        mutated[at] = alphabet[Math.floor(random() * alphabet.length)] ?? " ";
      }
      const result = importThreeMf(modelPackage(mutated.join("")));
      if (result.ok) {
        // Mutated digits can change geometry values, never structure: a
        // surviving import is still a four-triangle, consistent mesh.
        expect(tessellationTriangleCount(result.value.tessellation)).toBe(4);
        expectConsistentMesh(result.value);
      } else {
        expect(ALL_FAILURE_CODES).toContain(result.error.code);
      }
    }
  });

  it("rejects deflate-flipped stored entries without throwing", () => {
    const view = new DataView(
      boxPackage.buffer,
      boxPackage.byteOffset,
      boxPackage.byteLength,
    );
    const centralOffset = view.getUint32(boxPackage.length - 6, true);
    const thirdCentral =
      centralOffset +
      2 * 46 +
      "[Content_Types].xml".length +
      "_rels/.rels".length;
    const localOffset = view.getUint32(thirdCentral + 42, true);
    const flipped = withUint16At(
      withUint16At(boxPackage, thirdCentral + 10, 8),
      localOffset + 8,
      8,
    );
    const result = importThreeMf(flipped);
    if (result.ok) {
      throw new Error("Stored data with flipped method bytes imported.");
    }
    expect([
      "three-mf-import/bad-compression",
      "three-mf-import/crc-mismatch",
      "three-mf-import/not-a-zip",
    ]).toContain(result.error.code);
  });
});

describe("imported meshes are renderable (projection level)", () => {
  it("projectTessellation accepts the imported fixture soup", () => {
    const imported = unwrapImport(importThreeMf(fixtureBytes));
    const projected = projectTessellation(
      createBodyId("body_imported_3mf_tetra"),
      imported.tessellation,
    );
    if (!projected.ok) {
      throw new Error(
        `Projection failed with ${projected.error.code}: ${projected.error.message}`,
      );
    }
    expect(projected.value.positions).toEqual(imported.tessellation.positions);
    expect(projected.value.indices).toEqual(imported.tessellation.indices);
    expect(projected.value.normals).toEqual(imported.tessellation.normals);
    expect([...projected.value.bounds.min]).toEqual([0, 0, 0]);
    expect([...projected.value.bounds.max]).toEqual([15, 20, 25]);
  });
});
