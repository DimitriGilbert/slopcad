/**
 * 3MF export unit tests (Phase 18.3): package structure conformance (each
 * OPC part judged through the independent hand-rolled reader in
 * `./three-mf-test-reader`, never by exact-buffer goldens alone), the units
 * declaration, metadata presence/absence and escaping, geometry fidelity
 * (3MF decimals round-trip f64 positions exactly, unlike STL's float32),
 * determinism pinned across independently-built inputs, structured
 * rejection of malformed soups and metadata, and the reader's own
 * strictness against hand-mutated packages.
 *
 * Scene geometry comes from the fake kernel — deterministic, in-process,
 * and contract-conformant. Real-engine geometry (Manifold) is covered by
 * `./three-mf-manifold.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  type Tessellation,
  createFakeKernel,
  tessellationTriangleCount,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";

import {
  type ThreeMfExportError,
  type ThreeMfExportErrorCode,
  type ThreeMfExportResult,
  exportThreeMf,
} from "./three-mf-export";
import {
  type ThreeMfReadDocument,
  readThreeMfPackage,
  threeMfBounds,
  threeMfVolumeMm3,
} from "./three-mf-test-reader";
import { positionsBounds } from "./stl-test-reader";

const mm = (value: number) => length(value, "mm");

/**
 * The smallest soup the spec accepts as a solid: a unit tetrahedron with
 * outward (counter-clockwise) winding on every face, volume 1/6.
 */
const TETRAHEDRON: Tessellation = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 2, 1, 0, 3, 2, 0, 1, 3, 1, 2, 3],
};

function unwrapThreeMf(result: ThreeMfExportResult): Uint8Array {
  if (result.ok) return result.value;
  throw new Error(
    `3MF export failed with ${result.error.code}: ${result.error.message}`,
  );
}

function expectThreeMfFailure(
  result: ThreeMfExportResult,
  code: ThreeMfExportErrorCode,
  label: string,
): ThreeMfExportError {
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
    kernel.transform(cylinder, {
      x: mm(15),
      y: mm(10),
      z: mm(0),
    }),
    "transform",
  );
  const drilled = unwrapKernelResult(
    kernel.subtract(plate, [bore]),
    "subtract",
  );
  return unwrapKernelResult(kernel.tessellate(drilled), "tessellate");
}

/**
 * Numerically exact match across the f64 → decimal → f64 boundary: 3MF's
 * arbitrary-precision decimals round-trip `toString()` output exactly, so
 * every coordinate must reparse to the same number (the `===` comparison is
 * deliberately used over `Object.is` so the sign of zero cannot fail it —
 * the one bit the format does not carry).
 */
function expectGeometryExactlyMatchesSource(
  document: ThreeMfReadDocument,
  tessellation: Tessellation,
): void {
  const { vertices, triangles } = document.model;
  expect(vertices.length).toBe(tessellation.positions.length / 3);
  expect(triangles.length).toBe(tessellationTriangleCount(tessellation));
  for (let v = 0; v < vertices.length; v += 1) {
    const vertex = vertices[v];
    if (vertex === undefined) {
      throw new Error(`Parsed model is missing vertex ${v}.`);
    }
    for (const axis of [0, 1, 2]) {
      const parsed = vertex[axis] ?? 0;
      const source = tessellation.positions[3 * v + axis] ?? 0;
      if (!(parsed === source)) {
        throw new Error(
          `Vertex ${v} axis ${axis}: parsed ${parsed} is not exactly the source ${source}.`,
        );
      }
    }
  }
  for (let t = 0; t < triangles.length; t += 1) {
    const triangle = triangles[t];
    if (triangle === undefined) {
      throw new Error(`Parsed model is missing triangle ${t}.`);
    }
    for (const corner of [0, 1, 2]) {
      const parsed = triangle[corner] ?? 0;
      const source = tessellation.indices[3 * t + corner] ?? 0;
      if (parsed !== source) {
        throw new Error(
          `Triangle ${t} corner ${corner}: parsed index ${parsed} is not the source index ${source} — declaration order must be index order.`,
        );
      }
    }
  }
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

const box = fakeBoxTessellation(createFakeKernel(), 2, 3, 4);

describe("exportThreeMf package structure (independent reader)", () => {
  it("is a ZIP archive with local headers and an EOCD record", () => {
    const bytes = unwrapThreeMf(exportThreeMf(box));
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...bytes.subarray(bytes.length - 22, bytes.length - 18)]).toEqual([
      0x50, 0x4b, 0x05, 0x06,
    ]);
  });

  it("carries exactly the three canonical OPC parts", () => {
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(box)));
    expect([...document.parts.keys()].sort()).toEqual(
      ["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"].sort(),
    );
  });

  it("declares the OPC and 3MF content types for the parts", () => {
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(box)));
    expect(document.contentTypes.get("rels")).toBe(
      "application/vnd.openxmlformats-package.relationships+xml",
    );
    expect(document.contentTypes.get("model")).toBe(
      "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
    );
  });

  it("roots the payload with the 3MF StartPart relationship", () => {
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(box)));
    expect(document.relationships.length).toBe(1);
    const relationship = document.relationships[0];
    if (relationship === undefined) {
      throw new Error("The StartPart relationship is missing.");
    }
    expect(relationship.type).toBe(
      "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel",
    );
    expect(relationship.target).toBe("/3D/3dmodel.model");
  });

  it("builds one model-type object resource via one build item", () => {
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(box)));
    expect(document.model.namespace).toBe(
      "http://schemas.microsoft.com/3dmanufacturing/core/2015/02",
    );
    expect(document.model.objectId).toBe(1);
    expect(document.model.buildObjectIds).toEqual([1]);
  });
});

describe("exportThreeMf units", () => {
  it("declares millimeter on the model element — canonical units pass through", () => {
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(box)));
    expect(document.model.unit).toBe("millimeter");
  });

  it("writes coordinates unscaled in the declared unit", () => {
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(box)));
    const source = positionsBounds(box.positions);
    const parsed = threeMfBounds(document);
    for (const axis of [0, 1, 2]) {
      expect(parsed.min[axis]).toBe(source.min[axis]);
      expect(parsed.max[axis]).toBe(source.max[axis]);
    }
  });
});

describe("exportThreeMf metadata", () => {
  it("emits provided fields as well-known model-level metadata", () => {
    const document = readThreeMfPackage(
      unwrapThreeMf(
        exportThreeMf(box, {
          title: "Slopcad bracket",
          designer: "didi",
          description: "Plate with bore, phase 18.3 fixture.",
        }),
      ),
    );
    expect(document.model.metadata.get("Title")).toBe("Slopcad bracket");
    expect(document.model.metadata.get("Designer")).toBe("didi");
    expect(document.model.metadata.get("Description")).toBe(
      "Plate with bore, phase 18.3 fixture.",
    );
  });

  it("emits no metadata elements when none is provided", () => {
    const bytes = unwrapThreeMf(exportThreeMf(box));
    const document = readThreeMfPackage(bytes);
    expect(document.model.metadata.size).toBe(0);
    const modelText = new TextDecoder().decode(
      document.parts.get("3D/3dmodel.model") ?? new Uint8Array(),
    );
    expect(modelText.includes("<metadata")).toBe(false);
  });

  it("round-trips XML-special characters in metadata text", () => {
    const document = readThreeMfPackage(
      unwrapThreeMf(
        exportThreeMf(TETRAHEDRON, {
          title: `A & B <i>quoted</i> 'single' "double" > end`,
        }),
      ),
    );
    expect(document.model.metadata.get("Title")).toBe(
      `A & B <i>quoted</i> 'single' "double" > end`,
    );
  });

  it("round-trips exotic-but-legal XML text: whitespace, private use, astral", () => {
    const exotic = "line\ttwo\nthree\rprivate \uE000 astral \u{1F6E0} end";
    const document = readThreeMfPackage(
      unwrapThreeMf(exportThreeMf(TETRAHEDRON, { description: exotic })),
    );
    expect(document.model.metadata.get("Description")).toBe(exotic);
  });
});

describe("exportThreeMf geometry fidelity", () => {
  it("preserves every vertex and triangle exactly, in declaration order", () => {
    const soup = fakeBoxMinusBoreTessellation(createFakeKernel());
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(soup)));
    expectGeometryExactlyMatchesSource(document, soup);
  });

  it("round-trips f64 coordinates that fixed-width binary formats would mangle", () => {
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
    const document = readThreeMfPackage(unwrapThreeMf(exportThreeMf(quirky)));
    expectGeometryExactlyMatchesSource(document, quirky);
  });

  it("keeps the mesh a closed outward-oriented solid (divergence volume)", () => {
    const document = readThreeMfPackage(
      unwrapThreeMf(exportThreeMf(TETRAHEDRON)),
    );
    expect(threeMfVolumeMm3(document)).toBeCloseTo(1 / 6, 15);
  });

  it("ignores soup normals entirely — 3MF core meshes carry none", () => {
    // A normals array that would fail the STL exporter's pairing check is
    // irrelevant here: 3MF has no destination for normals, so the mismatch
    // must not reject the export.
    const mismatchedNormals: Tessellation = {
      positions: TETRAHEDRON.positions,
      indices: TETRAHEDRON.indices,
      normals: [0, 0, 1],
    };
    const document = readThreeMfPackage(
      unwrapThreeMf(exportThreeMf(mismatchedNormals)),
    );
    expectGeometryExactlyMatchesSource(document, TETRAHEDRON);
  });
});

describe("exportThreeMf determinism", () => {
  it("produces byte-identical output for repeated calls", () => {
    expectBytesIdentical(
      unwrapThreeMf(exportThreeMf(box, { title: "Same" })),
      unwrapThreeMf(exportThreeMf(box, { title: "Same" })),
      "Repeated export of the same input",
    );
  });

  it("produces byte-identical output for independently built inputs", () => {
    const first = fakeBoxMinusBoreTessellation(createFakeKernel());
    const second = fakeBoxMinusBoreTessellation(createFakeKernel());
    expectBytesIdentical(
      unwrapThreeMf(exportThreeMf(first)),
      unwrapThreeMf(exportThreeMf(second)),
      "Independently built box-minus-bore soups",
    );
  });

  it("is insensitive to input object identity and metadata key order", () => {
    const spread: Tessellation = { ...box };
    const reversedMetadata = { description: "d", title: "t" } as const;
    const orderedMetadata = { title: "t", description: "d" } as const;
    expectBytesIdentical(
      unwrapThreeMf(exportThreeMf(spread, reversedMetadata)),
      unwrapThreeMf(exportThreeMf(box, orderedMetadata)),
      "Spread soup and reordered metadata",
    );
  });
});

describe("exportThreeMf rejects malformed input", () => {
  const soup = fakeBoxMinusBoreTessellation(createFakeKernel());

  function mutated(patch: {
    positions?: readonly number[];
    indices?: readonly number[];
  }): Tessellation {
    return { ...soup, ...patch };
  }

  it("rejects an empty tessellation", () => {
    expectThreeMfFailure(
      exportThreeMf({ positions: [], indices: [] }),
      "three-mf-export/empty-tessellation",
      "Empty soup",
    );
    expectThreeMfFailure(
      exportThreeMf(mutated({ indices: [] })),
      "three-mf-export/empty-tessellation",
      "No triangles",
    );
  });

  it("rejects soups with fewer than the 4 triangles a solid body needs", () => {
    for (const triangleCount of [1, 2, 3]) {
      expectThreeMfFailure(
        exportThreeMf(
          mutated({ indices: soup.indices.slice(0, 3 * triangleCount) }),
        ),
        "three-mf-export/too-few-triangles",
        `${triangleCount} triangles`,
      );
    }
  });

  it("rejects arrays that are not flat triples", () => {
    expectThreeMfFailure(
      exportThreeMf(mutated({ positions: soup.positions.slice(0, -1) })),
      "three-mf-export/malformed-tessellation",
      "Positions not divisible by 3",
    );
    expectThreeMfFailure(
      exportThreeMf(mutated({ indices: soup.indices.slice(0, -1) })),
      "three-mf-export/malformed-tessellation",
      "Indices not divisible by 3",
    );
  });

  it("rejects non-finite vertices", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const positions = [...soup.positions];
      positions[4] = bad;
      expectThreeMfFailure(
        exportThreeMf(mutated({ positions })),
        "three-mf-export/non-finite-vertex",
        `Position ${String(bad)}`,
      );
    }
  });

  it("rejects indices outside the vertex range", () => {
    for (const bad of [-1, soup.positions.length / 3, 1.5]) {
      const indices = [...soup.indices];
      indices[7] = bad;
      expectThreeMfFailure(
        exportThreeMf(mutated({ indices })),
        "three-mf-export/index-out-of-range",
        `Index ${bad}`,
      );
    }
  });

  it("rejects triangles whose vertex indices are not distinct", () => {
    for (const [label, indices] of [
      ["v1 === v2", [0, 0, 1, 0, 3, 2, 0, 1, 3, 1, 2, 3]],
      ["v2 === v3", [0, 2, 2, 0, 3, 2, 0, 1, 3, 1, 2, 3]],
      ["v1 === v3", [1, 2, 1, 0, 3, 2, 0, 1, 3, 1, 2, 3]],
    ] as const) {
      expectThreeMfFailure(
        exportThreeMf({ positions: TETRAHEDRON.positions, indices }),
        "three-mf-export/degenerate-triangle",
        label,
      );
    }
  });

  it("rejects metadata that is not exportable XML text", () => {
    const empty = expectThreeMfFailure(
      exportThreeMf(TETRAHEDRON, { title: "" }),
      "three-mf-export/invalid-metadata",
      "Empty title",
    );
    expect(empty.message).toContain("title");
    expectThreeMfFailure(
      exportThreeMf(TETRAHEDRON, { title: " \t\n " }),
      "three-mf-export/invalid-metadata",
      "Whitespace-only title",
    );
    expectThreeMfFailure(
      exportThreeMf(TETRAHEDRON, { designer: "bad\u0007bell" }),
      "three-mf-export/invalid-metadata",
      "Control character",
    );
    expectThreeMfFailure(
      exportThreeMf(TETRAHEDRON, { description: "lone \ud800 surrogate" }),
      "three-mf-export/invalid-metadata",
      "Lone surrogate",
    );
    expectThreeMfFailure(
      exportThreeMf(TETRAHEDRON, { title: 42 as unknown as string }),
      "three-mf-export/invalid-metadata",
      "Non-string field",
    );
  });
});

describe("readThreeMfPackage strictness", () => {
  /** Byte offsets of every occurrence of `signature` in `bytes`. */
  function findAll(
    bytes: Uint8Array,
    signature: readonly [number, number, number, number],
  ): number[] {
    const offsets: number[] = [];
    for (let i = 0; i + 4 <= bytes.length; i += 1) {
      if (
        bytes[i] === signature[0] &&
        bytes[i + 1] === signature[1] &&
        bytes[i + 2] === signature[2] &&
        bytes[i + 3] === signature[3]
      ) {
        offsets.push(i);
      }
    }
    return offsets;
  }

  const LOCAL_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;
  const CENTRAL_SIGNATURE = [0x50, 0x4b, 0x01, 0x02] as const;
  const EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06] as const;

  /** A fresh package plus its structural offsets, with layout pinned. */
  function freshPackage(): {
    bytes: Uint8Array;
    locals: readonly number[];
    centrals: readonly number[];
  } {
    const bytes = unwrapThreeMf(exportThreeMf(box));
    const locals = findAll(bytes, LOCAL_SIGNATURE);
    const centrals = findAll(bytes, CENTRAL_SIGNATURE);
    expect(locals.length).toBe(3);
    expect(centrals.length).toBe(3);
    expect(findAll(bytes, EOCD_SIGNATURE)).toEqual([bytes.length - 22]);
    return { bytes, locals, centrals };
  }

  it("rejects empty and truncated buffers", () => {
    const { bytes } = freshPackage();
    expect(() => readThreeMfPackage(new Uint8Array(0))).toThrow();
    expect(() =>
      readThreeMfPackage(bytes.subarray(0, bytes.length - 1)),
    ).toThrow(/end-of-central-directory/);
    expect(() =>
      readThreeMfPackage(bytes.subarray(0, Math.floor(bytes.length / 2))),
    ).toThrow();
  });

  it("rejects a corrupted EOCD signature and trailing garbage", () => {
    const { bytes } = freshPackage();
    const corrupted = new Uint8Array(bytes);
    corrupted[bytes.length - 22] = 0x51;
    expect(() => readThreeMfPackage(corrupted)).toThrow(
      /end-of-central-directory/,
    );
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => readThreeMfPackage(padded)).toThrow(
      /end-of-central-directory/,
    );
  });

  it("rejects compressed entries — this reader is stored-only", () => {
    const { bytes, centrals } = freshPackage();
    const deflated = new Uint8Array(bytes);
    const view = new DataView(deflated.buffer);
    view.setUint16((centrals[2] ?? 0) + 10, 8, true); // method: deflate
    expect(() => readThreeMfPackage(deflated)).toThrow(/method 8/);
  });

  it("rejects entries whose data does not match the declared CRC-32", () => {
    const { bytes, locals } = freshPackage();
    const corrupted = new Uint8Array(bytes);
    const modelLocal = locals[2] ?? 0;
    const view = new DataView(corrupted.buffer);
    const nameLength = view.getUint16(modelLocal + 26, true);
    const dataStart = modelLocal + 30 + nameLength;
    corrupted[dataStart] = (corrupted[dataStart] ?? 0) ^ 0x20;
    expect(() => readThreeMfPackage(corrupted)).toThrow(/CRC-32 mismatch/);
  });

  it("rejects local and central directory entries that disagree", () => {
    const { bytes, locals } = freshPackage();
    const renamed = new Uint8Array(bytes);
    renamed[(locals[0] ?? 0) + 30] = 0x28; // '[' of the first name becomes '('
    expect(() => readThreeMfPackage(renamed)).toThrow(/names/);
  });

  it("rejects packages missing a canonical 3MF part", () => {
    const { bytes, locals } = freshPackage();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const centralDirectoryOffset = view.getUint32(bytes.length - 6, true);
    // Walk the first two central entries; `cut` sits before the model's.
    let cut = centralDirectoryOffset;
    for (let i = 0; i < 2; i += 1) {
      cut += 46 + view.getUint16(cut + 28, true);
    }
    const keptCentrals = cut - centralDirectoryOffset;
    const modelLocal = locals[2] ?? 0;
    // Locals of the first two parts stay at their original offsets; the
    // carved package re-homes their central records and a fresh 2-entry EOCD.
    const carved = new Uint8Array(modelLocal + keptCentrals + 22);
    carved.set(bytes.subarray(0, modelLocal));
    carved.set(bytes.subarray(centralDirectoryOffset, cut), modelLocal);
    const carvedView = new DataView(carved.buffer);
    const eocd = modelLocal + keptCentrals;
    carvedView.setUint32(eocd, 0x06054b50, true);
    carvedView.setUint16(eocd + 8, 2, true);
    carvedView.setUint16(eocd + 10, 2, true);
    carvedView.setUint32(eocd + 12, keptCentrals, true);
    carvedView.setUint32(eocd + 16, modelLocal, true);
    expect(() => readThreeMfPackage(carved)).toThrow(/no 3D\/3dmodel\.model/);
  });
});
