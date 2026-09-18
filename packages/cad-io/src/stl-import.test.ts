/**
 * STL import unit tests (Phase 18.2): structural format detection (binary
 * frame vs ASCII text — the `"solid"` prefix is never trusted alone), the
 * export → import semantic round-trip against the Phase 18.1 exporter, the
 * externally authored ASCII tetrahedron fixture under `../fixtures/`,
 * structured rejection of every documented failure class, no-throw probes
 * over seeded random bytes / every truncation of a real export / mutated
 * ASCII, determinism pins, and projection-level renderability of imported
 * meshes (no DOM involved).
 *
 * Semantic judgments reuse the independent `./stl-test-reader` utilities —
 * never the importer's own bookkeeping — plus the fake kernel for
 * contract-conformant scene geometry (the 18.1 export test's donor pattern).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBodyId, length, projectTessellation } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  type Tessellation,
  createFakeKernel,
  tessellationTriangleCount,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";

import {
  type StlExportResult,
  STL_BINARY_HEADER_TEXT,
  STL_MIN_BYTES,
  STL_TRIANGLE_BYTES,
  exportStlBinary,
} from "./stl-export";
import {
  type ImportedStlMesh,
  type StlImportErrorCode,
  type StlImportError,
  type StlImportResult,
  STL_IMPORT_ERROR_CODES,
  importStl,
} from "./stl-import";
import {
  enclosedVolumeMm3,
  float32Close,
  positionsBounds,
  readBinaryStl,
  tessellationVolumeMm3,
} from "./stl-test-reader";

const BOX_VOLUME_MM3 = 2 * 3 * 4;
const TETRA_VOLUME_MM3 = 1000 / 6;
/** Imported normals are float32 (binary) or decimal text (ASCII) — 0.1% is
 * the same unit-length slack the kernel contract and projection use. */
const NORMAL_UNIT_TOLERANCE = 1e-3;
const ALL_FAILURE_CODES: readonly string[] = Object.values(
  STL_IMPORT_ERROR_CODES,
);

const mm = (value: number) => length(value, "mm");

function unwrapStl(result: StlExportResult): Uint8Array {
  if (result.ok) return result.value;
  throw new Error(
    `STL export failed with ${result.error.code}: ${result.error.message}`,
  );
}

function unwrapImport(result: StlImportResult): ImportedStlMesh {
  if (result.ok) return result.value;
  throw new Error(
    `STL import failed with ${result.error.code}: ${result.error.message}`,
  );
}

function expectImportFailure(
  result: StlImportResult,
  code: StlImportErrorCode,
  label: string,
): StlImportError {
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

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

function withUint32At(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

function withFloat32At(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setFloat32(offset, value, true);
  return copy;
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

/** Structural contract of an imported soup: unshared corners, sequential
 * indices, finite buffers, paired normals. */
function expectConsistentSoup(tessellation: Tessellation): void {
  const { positions, indices, normals } = tessellation;
  expect(indices.length % 3).toBe(0);
  expect(positions.length).toBe(indices.length * 3);
  for (const value of positions) {
    expect(Number.isFinite(value)).toBe(true);
  }
  for (let i = 0; i < indices.length; i += 1) {
    expect(indices[i]).toBe(i);
  }
  if (normals !== undefined) {
    expect(normals.length).toBe(positions.length);
    for (const value of normals) {
      expect(Number.isFinite(value)).toBe(true);
    }
  }
}

/** Every imported corner matches the exported float32 the source index
 * pointed at, within float32 tolerance. */
function expectCornersMatchSource(
  imported: ImportedStlMesh,
  source: Tessellation,
): void {
  const { positions } = imported.tessellation;
  for (let t = 0; t < tessellationTriangleCount(source); t += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const index = source.indices[3 * t + corner];
      if (index === undefined) {
        throw new Error(`Source is missing a corner of triangle ${t}.`);
      }
      for (const axis of [0, 1, 2]) {
        const parsed = positions[3 * (3 * t + corner) + axis] ?? 0;
        const expected = source.positions[3 * index + axis] ?? 0;
        if (!float32Close(parsed, expected)) {
          throw new Error(
            `Triangle ${t} corner ${corner} axis ${axis}: imported ${parsed} does not match source ${expected} within float32 tolerance.`,
          );
        }
      }
    }
  }
}

const boxKernel = createFakeKernel();
const box = fakeBoxTessellation(boxKernel, 2, 3, 4);
const boxBytes = unwrapStl(exportStlBinary(box));

const singleTriangle: Tessellation = {
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
  indices: [0, 1, 2],
};
const singleTriangleBytes = unwrapStl(exportStlBinary(singleTriangle));

const tetraUrl = new URL("../fixtures/tetra.stl", import.meta.url);
const tetraBytes = new Uint8Array(readFileSync(tetraUrl));
const tetraText = readFileSync(tetraUrl, "utf8");

const ASCII_ONE_FACET_LINES = [
  "solid block",
  "facet normal 0 0 1",
  "outer loop",
  "vertex 0 0 0",
  "vertex 1 0 0",
  "vertex 0 1 0",
  "endloop",
  "endfacet",
  "endsolid block",
] as const;

function asciiVariant(lines: readonly string[]): Uint8Array {
  return asciiBytes(`${lines.join("\n")}\n`);
}

function asciiWithoutLine(line: string): Uint8Array {
  return asciiVariant(ASCII_ONE_FACET_LINES.filter((entry) => entry !== line));
}

describe("importStl binary round-trip (18.1 export → import)", () => {
  it("preserves triangle count, corner order, and float32 vertex values", () => {
    const imported = unwrapImport(importStl(boxBytes));
    expect(imported.flavor).toBe("binary");
    expect(tessellationTriangleCount(imported.tessellation)).toBe(
      tessellationTriangleCount(box),
    );
    expectCornersMatchSource(imported, box);
  });

  it("produces an unshared triangle soup with sequential indices", () => {
    const imported = unwrapImport(importStl(boxBytes));
    expectConsistentSoup(imported.tessellation);
  });

  it("preserves bounds within float32 tolerance", () => {
    const imported = unwrapImport(importStl(boxBytes));
    const importedBounds = positionsBounds(imported.tessellation.positions);
    const sourceBounds = positionsBounds(box.positions);
    for (const axis of [0, 1, 2]) {
      expect(
        float32Close(
          importedBounds.min[axis] ?? 0,
          sourceBounds.min[axis] ?? 0,
        ),
      ).toBe(true);
      expect(
        float32Close(
          importedBounds.max[axis] ?? 0,
          sourceBounds.max[axis] ?? 0,
        ),
      ).toBe(true);
      expect(float32Close(importedBounds.min[axis] ?? 0, 0)).toBe(true);
      expect(
        float32Close(importedBounds.max[axis] ?? 0, [2, 3, 4][axis] ?? 0),
      ).toBe(true);
    }
  });

  it("preserves enclosed volume via the divergence theorem", () => {
    const imported = unwrapImport(importStl(boxBytes));
    // Same float32 values as the independent reader parses → exact agreement,
    // and the analytic box volume to float64 exactness.
    expect(tessellationVolumeMm3(imported.tessellation)).toBe(
      enclosedVolumeMm3(readBinaryStl(boxBytes)),
    );
    expect(tessellationVolumeMm3(imported.tessellation)).toBeCloseTo(
      BOX_VOLUME_MM3,
      12,
    );
  });

  it("imports the file's facet normals as per-corner vertex normals", () => {
    const imported = unwrapImport(importStl(boxBytes));
    const normals = imported.tessellation.normals;
    expect(normals).toBeDefined();
    const document = readBinaryStl(boxBytes);
    for (let t = 0; t < document.triangleCount; t += 1) {
      const facet = document.triangles[t]?.normal;
      if (facet === undefined) {
        throw new Error(`Reader document is missing triangle ${t}.`);
      }
      for (const corner of [0, 1, 2]) {
        const base = 3 * (3 * t + corner);
        const cornerNormal = [
          normals?.[base] ?? 0,
          normals?.[base + 1] ?? 0,
          normals?.[base + 2] ?? 0,
        ];
        expect(cornerNormal).toEqual(facet);
        const length = Math.hypot(
          cornerNormal[0] ?? 0,
          cornerNormal[1] ?? 0,
          cornerNormal[2] ?? 0,
        );
        expect(Math.abs(length - 1) <= NORMAL_UNIT_TOLERANCE).toBe(true);
      }
    }
  });

  it("round-trips an indexed boolean-result soup without corrupting corners", () => {
    const soup = fakeBoxMinusBoreTessellation(createFakeKernel());
    const bytes = unwrapStl(exportStlBinary(soup));
    const imported = unwrapImport(importStl(bytes));
    expect(tessellationTriangleCount(imported.tessellation)).toBe(
      tessellationTriangleCount(soup),
    );
    expectCornersMatchSource(imported, soup);
    const importedBounds = positionsBounds(imported.tessellation.positions);
    const sourceBounds = positionsBounds(soup.positions);
    for (const axis of [0, 1, 2]) {
      expect(
        float32Close(
          importedBounds.min[axis] ?? 0,
          sourceBounds.min[axis] ?? 0,
        ),
      ).toBe(true);
      expect(
        float32Close(
          importedBounds.max[axis] ?? 0,
          sourceBounds.max[axis] ?? 0,
        ),
      ).toBe(true);
    }
  });

  it("imports a degenerate-facet export by omitting normals, not by failing", () => {
    // Zero-area triangle: 18.1 writes the (0,0,0) receiver-computes normal.
    const collinear: Tessellation = {
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
      indices: [0, 1, 2],
    };
    const bytes = unwrapStl(exportStlBinary(collinear));
    const imported = unwrapImport(importStl(bytes));
    expect(imported.tessellation.normals).toBeUndefined();
    expect(tessellationTriangleCount(imported.tessellation)).toBe(1);
    expectCornersMatchSource(imported, collinear);
  });
});

describe("importStl ASCII fixture (externally authored)", () => {
  it("imports the hand-written tetrahedron with exact hand-computed volume", () => {
    // The fixture must be long enough that the binary frame check was
    // available and rejected it — ASCII detection is structural, not a
    // length accident.
    expect(tetraBytes.byteLength).toBeGreaterThanOrEqual(84);
    const imported = unwrapImport(importStl(tetraBytes));
    expect(imported.flavor).toBe("ascii");
    expect(tessellationTriangleCount(imported.tessellation)).toBe(4);
    expect(imported.tessellation.positions.length).toBe(36);
    expectConsistentSoup(imported.tessellation);
    const bounds = positionsBounds(imported.tessellation.positions);
    expect([...bounds.min]).toEqual([0, 0, 0]);
    expect([...bounds.max]).toEqual([10, 10, 10]);
    expect(tessellationVolumeMm3(imported.tessellation)).toBeCloseTo(
      TETRA_VOLUME_MM3,
      12,
    );
  });

  it("keeps the fixture's facet normals as per-corner unit vertex normals", () => {
    const imported = unwrapImport(importStl(tetraBytes));
    const normals = imported.tessellation.normals;
    expect(normals).toBeDefined();
    const expectedFacets: readonly (readonly [number, number, number])[] = [
      [0, 0, -1],
      [-1, 0, 0],
      [0, -1, 0],
      [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
    ];
    for (let t = 0; t < 4; t += 1) {
      for (const corner of [0, 1, 2]) {
        const base = 3 * (3 * t + corner);
        const normal = [
          normals?.[base] ?? 0,
          normals?.[base + 1] ?? 0,
          normals?.[base + 2] ?? 0,
        ];
        const expected = expectedFacets[t];
        if (expected === undefined) {
          throw new Error(`Missing expected facet ${t}.`);
        }
        for (const axis of [0, 1, 2]) {
          expect(float32Close(normal[axis] ?? 0, expected[axis] ?? 0)).toBe(
            true,
          );
        }
        const length = Math.hypot(
          normal[0] ?? 0,
          normal[1] ?? 0,
          normal[2] ?? 0,
        );
        expect(Math.abs(length - 1) <= NORMAL_UNIT_TOLERANCE).toBe(true);
      }
    }
  });

  it("is deterministic: identical bytes import to identical tessellations", () => {
    const first = unwrapImport(importStl(tetraBytes));
    const second = unwrapImport(importStl(tetraBytes));
    const byteCopy = unwrapImport(importStl(new Uint8Array(tetraBytes)));
    expect(first.tessellation.positions).toEqual(second.tessellation.positions);
    expect(first.tessellation.indices).toEqual(second.tessellation.indices);
    expect(first.tessellation.normals).toEqual(second.tessellation.normals);
    expect(first.tessellation.positions).toEqual(
      byteCopy.tessellation.positions,
    );
    expect(first.tessellation.normals).toEqual(byteCopy.tessellation.normals);
  });

  it("re-exports to binary and re-imports to the same soup", () => {
    const imported = unwrapImport(importStl(tetraBytes));
    const reExported = unwrapStl(exportStlBinary(imported.tessellation));
    const reImported = unwrapImport(importStl(reExported));
    expect(reImported.flavor).toBe("binary");
    expect(tessellationTriangleCount(reImported.tessellation)).toBe(4);
    for (let i = 0; i < imported.tessellation.positions.length; i += 1) {
      const parsed = reImported.tessellation.positions[i] ?? 0;
      const source = imported.tessellation.positions[i] ?? 0;
      if (!float32Close(parsed, source)) {
        throw new Error(`Re-imported position ${i} drifted past float32.`);
      }
    }
    expect(reImported.tessellation.indices).toEqual(
      imported.tessellation.indices,
    );
    expect(tessellationVolumeMm3(reImported.tessellation)).toBeCloseTo(
      TETRA_VOLUME_MM3,
      9,
    );
  });
});

describe("importStl format detection", () => {
  it("reads a binary file whose header starts with 'solid' as binary", () => {
    // The unreliable prefix heuristic: some real writers emit binary STL
    // with an ASCII "solid" header. Structural detection must win.
    const solidHeader = new Uint8Array(singleTriangleBytes);
    for (let i = 0; i < "solid".length; i += 1) {
      solidHeader[i] = "solid".charCodeAt(i);
    }
    const imported = unwrapImport(importStl(solidHeader));
    expect(imported.flavor).toBe("binary");
    expect(tessellationTriangleCount(imported.tessellation)).toBe(1);
  });

  it("accepts the documented ASCII variants (CRLF, nameless, blanks, exponents)", () => {
    const crlf = asciiBytes(ASCII_ONE_FACET_LINES.join("\r\n").concat("\r\n"));
    expect(unwrapImport(importStl(crlf)).flavor).toBe("ascii");

    const nameless = asciiVariant([
      "solid",
      ...ASCII_ONE_FACET_LINES.slice(1, -1),
      "endsolid",
    ]);
    expect(unwrapImport(importStl(nameless)).flavor).toBe("ascii");

    const spaced = asciiBytes(
      `\tsolid tabs\n\n  facet normal 0.0 0 1e0\n\t outer   loop\n
      vertex +.5 0 0\n vertex 1E0 -2E0 0\n vertex 0 1 0\nendloop\n
      endfacet\nendsolid spaced\n`,
    );
    const imported = unwrapImport(importStl(spaced));
    expect(imported.flavor).toBe("ascii");
    expect(tessellationTriangleCount(imported.tessellation)).toBe(1);
    expect(imported.tessellation.positions[1]).toBe(0);
    expect(imported.tessellation.positions[0]).toBeCloseTo(0.5, 12);
    expect(imported.tessellation.positions[4]).toBe(-2);
  });

  it("reports the API surface of an imported mesh, never a fabricated document", () => {
    const mesh = unwrapImport(importStl(tetraBytes));
    expect(Object.keys(mesh).sort()).toEqual(["flavor", "tessellation"]);
    expect(Object.keys(mesh.tessellation).sort()).toEqual([
      "indices",
      "normals",
      "positions",
    ]);
  });
});

describe("importStl rejects malformed input (per failure class)", () => {
  it("stl-import/empty: zero bytes, zero-triangle binary, empty solid", () => {
    expectImportFailure(
      importStl(new Uint8Array(0)),
      "stl-import/empty",
      "Zero-byte input",
    );
    expectImportFailure(
      importStl(new Uint8Array(84)),
      "stl-import/empty",
      "84-byte binary frame declaring zero triangles",
    );
    expectImportFailure(
      importStl(asciiBytes("solid nothing\nendsolid nothing\n")),
      "stl-import/empty",
      "ASCII solid with no facets",
    );
  });

  it("stl-import/truncated: binary frames carrying fewer bytes than declared", () => {
    expectImportFailure(
      importStl(boxBytes.subarray(0, 83)),
      "stl-import/truncated",
      "Cut below the 84-byte frame",
    );
    expectImportFailure(
      importStl(boxBytes.subarray(0, STL_MIN_BYTES + 25)),
      "stl-import/truncated",
      "Cut mid-triangle",
    );
    expectImportFailure(
      importStl(boxBytes.subarray(0, boxBytes.byteLength - STL_TRIANGLE_BYTES)),
      "stl-import/truncated",
      "Exactly one triangle missing",
    );
  });

  it("stl-import/truncated: absurd counts fail the length check before any allocation", () => {
    const garbage = new Uint8Array(100).fill(0x01);
    const absurd = withUint32At(garbage, 80, 0xffffffff);
    const error = expectImportFailure(
      importStl(absurd),
      "stl-import/truncated",
      "Count claiming ~214 GB of triangles",
    );
    expect(error.message).toContain("4294967295");
    const absurd32 = withUint32At(garbage, 80, 0x7fffffff);
    expectImportFailure(
      importStl(absurd32),
      "stl-import/truncated",
      "Count claiming ~107 GB of triangles",
    );
  });

  it("stl-import/count-mismatch: more triangle bytes than declared", () => {
    const triangles = tessellationTriangleCount(box);
    const undercounted = withUint32At(boxBytes, 80, triangles - 1);
    expectImportFailure(
      importStl(undercounted),
      "stl-import/count-mismatch",
      "Count one triangle short",
    );
    const padded = new Uint8Array(boxBytes.byteLength + STL_TRIANGLE_BYTES);
    padded.set(boxBytes);
    expectImportFailure(
      importStl(padded),
      "stl-import/count-mismatch",
      "One triangle of trailing zeros appended",
    );
    const oneByte = new Uint8Array(boxBytes.byteLength + 1);
    oneByte.set(boxBytes);
    expectImportFailure(
      importStl(oneByte),
      "stl-import/count-mismatch",
      "One stray byte appended",
    );
  });

  it("stl-import/ascii-syntax: broken facet grammar", () => {
    const cases: readonly [string, Uint8Array][] = [
      ["missing endsolid", asciiWithoutLine("endsolid block")],
      ["missing endfacet", asciiWithoutLine("endfacet")],
      ["missing endloop", asciiWithoutLine("endloop")],
      ["missing outer loop", asciiWithoutLine("outer loop")],
      ["only two vertices", asciiWithoutLine("vertex 1 0 0")],
      [
        "four vertices",
        asciiVariant([
          ...ASCII_ONE_FACET_LINES.slice(0, 6),
          "vertex 0 0 1",
          ...ASCII_ONE_FACET_LINES.slice(6),
        ]),
      ],
      [
        "unknown keyword inside the facet",
        asciiVariant([
          ...ASCII_ONE_FACET_LINES.slice(0, 7),
          "bogus keyword",
          ...ASCII_ONE_FACET_LINES.slice(7),
        ]),
      ],
      [
        "content after endsolid",
        asciiVariant([...ASCII_ONE_FACET_LINES, "trailing junk"]),
      ],
      [
        "a second solid",
        asciiVariant([
          ...ASCII_ONE_FACET_LINES,
          "solid another",
          "endsolid another",
        ]),
      ],
      [
        "facet without the normal keyword",
        asciiVariant(
          ASCII_ONE_FACET_LINES.map((line) =>
            line === "facet normal 0 0 1" ? "facet 0 0 1" : line,
          ),
        ),
      ],
      [
        "vertex with an extra coordinate",
        asciiVariant(
          ASCII_ONE_FACET_LINES.map((line) =>
            line === "vertex 0 0 0" ? "vertex 0 0 0 0" : line,
          ),
        ),
      ],
    ];
    for (const [label, bytes] of cases) {
      expectImportFailure(importStl(bytes), "stl-import/ascii-syntax", label);
    }
  });

  it("stl-import/ascii-syntax: non-decimal numeric tokens", () => {
    for (const token of ["nan", "abc", "1.2.3", "--1"]) {
      const bytes = asciiVariant(
        ASCII_ONE_FACET_LINES.map((line) =>
          line === "vertex 1 0 0" ? `vertex ${token} 0 0` : line,
        ),
      );
      expectImportFailure(
        importStl(bytes),
        "stl-import/ascii-syntax",
        `Vertex token "${token}"`,
      );
    }
  });

  it("stl-import/non-finite-value: NaN/Inf floats in either flavor", () => {
    // Triangle record layout: normal at +0, vertex 0 at +12 (float32 LE).
    expectImportFailure(
      importStl(
        withFloat32At(singleTriangleBytes, STL_MIN_BYTES + 16, Number.NaN),
      ),
      "stl-import/non-finite-value",
      "NaN binary vertex component",
    );
    expectImportFailure(
      importStl(
        withFloat32At(
          singleTriangleBytes,
          STL_MIN_BYTES + 4,
          Number.NEGATIVE_INFINITY,
        ),
      ),
      "stl-import/non-finite-value",
      "Infinite binary normal component",
    );
    expectImportFailure(
      importStl(
        asciiVariant(
          ASCII_ONE_FACET_LINES.map((line) =>
            line === "vertex 1 0 0" ? "vertex 1e999 0 0" : line,
          ),
        ),
      ),
      "stl-import/non-finite-value",
      "ASCII coordinate overflowing to Infinity",
    );
  });

  it("stl-import/wrong-encoding: text that is not ASCII STL, BOMs, wrong case", () => {
    const logText = asciiBytes(
      "slopcad shipping log - nothing to see here\n".repeat(4),
    );
    expectImportFailure(
      importStl(logText),
      "stl-import/wrong-encoding",
      "Printable text without the solid keyword",
    );
    expectImportFailure(
      importStl(asciiBytes("SOLID upper\nendsolid upper\n")),
      "stl-import/wrong-encoding",
      "Uppercase SOLID keyword",
    );
    const utf8Bom = new Uint8Array(3 + tetraBytes.byteLength);
    utf8Bom.set([0xef, 0xbb, 0xbf], 0);
    utf8Bom.set(tetraBytes, 3);
    expectImportFailure(
      importStl(utf8Bom),
      "stl-import/wrong-encoding",
      "UTF-8 BOM before valid ASCII STL",
    );
    const utf16Le = new Uint8Array([
      0xff, 0xfe, 0x73, 0x00, 0x6f, 0x00, 0x6c, 0x00, 0x69, 0x00, 0x64, 0x00,
    ]);
    expectImportFailure(
      importStl(utf16Le),
      "stl-import/wrong-encoding",
      "UTF-16LE BOM before a UTF-16 solid keyword",
    );
  });

  it("stl-import/ascii-syntax: an ASCII file cut mid-facet", () => {
    const half = asciiBytes(
      tetraText.slice(0, Math.floor(tetraText.length / 2)),
    );
    expectImportFailure(
      importStl(half),
      "stl-import/ascii-syntax",
      "ASCII fixture truncated at half length",
    );
  });
});

describe("importStl never throws on arbitrary bytes", () => {
  it("returns a structured result for seeded random buffers", () => {
    const random = mulberry32(42);
    let failures = 0;
    for (let i = 0; i < 400; i += 1) {
      const byteLength = Math.floor(random() ** 2 * 600);
      const bytes = new Uint8Array(byteLength);
      for (let b = 0; b < byteLength; b += 1) {
        bytes[b] = Math.floor(random() * 256);
      }
      const result = importStl(bytes);
      if (result.ok) {
        expectConsistentSoup(result.value.tessellation);
      } else {
        failures += 1;
        expect(ALL_FAILURE_CODES).toContain(result.error.code);
      }
    }
    expect(failures).toBeGreaterThan(0);
  });

  it("returns a classified failure for every truncation of a real export", () => {
    // Bytes 0..28 of the export header are printable ASCII, byte 29 onward
    // are zero padding, so short cuts decode as (non-STL) text and longer
    // cuts read as broken binary frames.
    const headerTextLength = STL_BINARY_HEADER_TEXT.length;
    for (let cut = 0; cut < boxBytes.byteLength; cut += 1) {
      const result = importStl(boxBytes.subarray(0, cut));
      if (result.ok) {
        throw new Error(`Truncation at ${cut} bytes unexpectedly imported.`);
      }
      const expected: StlImportErrorCode =
        cut === 0
          ? "stl-import/empty"
          : cut <= headerTextLength
            ? "stl-import/wrong-encoding"
            : "stl-import/truncated";
      if (result.error.code !== expected) {
        throw new Error(
          `Truncation at ${cut} bytes: expected ${expected} but got ${result.error.code}.`,
        );
      }
    }
  });

  it("returns a structured result for seeded ASCII mutations", () => {
    const random = mulberry32(0xa11ce);
    const alphabet = "0123456789.eE+- \tnxyz";
    const chars = [...tetraText];
    for (let i = 0; i < 200; i += 1) {
      const mutated = [...chars];
      const mutations = 1 + Math.floor(random() * 4);
      for (let m = 0; m < mutations; m += 1) {
        const at = Math.floor(random() * mutated.length);
        mutated[at] = alphabet[Math.floor(random() * alphabet.length)] ?? " ";
      }
      const result = importStl(asciiBytes(mutated.join("")));
      if (result.ok) {
        // Mutated digits can change geometry, never structure: a surviving
        // import is still a four-triangle, internally consistent soup.
        expect(tessellationTriangleCount(result.value.tessellation)).toBe(4);
        expectConsistentSoup(result.value.tessellation);
      } else {
        expect(ALL_FAILURE_CODES).toContain(result.error.code);
      }
    }
  });
});

describe("imported meshes are renderable (projection level)", () => {
  it("projectTessellation accepts the imported tetrahedron soup", () => {
    const imported = unwrapImport(importStl(tetraBytes));
    const projected = projectTessellation(
      createBodyId("body_imported_tetra"),
      imported.tessellation,
    );
    if (!projected.ok) {
      throw new Error(
        `Projection failed with ${projected.error.code}: ${projected.error.message}`,
      );
    }
    const object = projected.value;
    expect(object.positions).toEqual(imported.tessellation.positions);
    expect(object.indices).toEqual(imported.tessellation.indices);
    expect(object.normals).toEqual(imported.tessellation.normals);
    expect([...object.bounds.min]).toEqual([0, 0, 0]);
    expect([...object.bounds.max]).toEqual([10, 10, 10]);
  });

  it("projectTessellation accepts a normals-omitted import", () => {
    const collinear: Tessellation = {
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
      indices: [0, 1, 2],
    };
    const imported = unwrapImport(
      importStl(unwrapStl(exportStlBinary(collinear))),
    );
    const projected = projectTessellation(
      createBodyId("body_imported_degenerate"),
      imported.tessellation,
    );
    if (!projected.ok) {
      throw new Error(
        `Projection failed with ${projected.error.code}: ${projected.error.message}`,
      );
    }
    expect(projected.value.normals).toBeUndefined();
    expect(Object.keys(imported.tessellation).sort()).toEqual([
      "indices",
      "positions",
    ]);
  });
});
