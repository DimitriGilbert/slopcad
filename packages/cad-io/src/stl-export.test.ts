/**
 * STL export unit tests (Phase 18.1): structure and header conventions,
 * semantic correctness judged through the independent hand-rolled reader in
 * `./stl-test-reader` (never by exact-buffer goldens alone), determinism
 * pinned across independently-built inputs, structured rejection of
 * malformed soups, and the reader's own strictness.
 *
 * Scene geometry comes from the fake kernel — deterministic, in-process, and
 * contract-conformant. Real-engine geometry (Manifold) is covered by
 * `./stl-manifold.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  type KernelBounds,
  type Tessellation,
  createFakeKernel,
  tessellationTriangleCount,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";

import {
  type StlExportErrorCode,
  type StlExportError,
  type StlExportResult,
  STL_BINARY_HEADER_TEXT,
  STL_MIN_BYTES,
  STL_TRIANGLE_BYTES,
  exportStlBinary,
} from "./stl-export";
import { importStl } from "./stl-import";
import {
  type StlDocument,
  documentBounds,
  float32Close,
  positionsBounds,
  readBinaryStl,
} from "./stl-test-reader";

/**
 * Facet normals cross an f64 → float32 boundary, so unit length is judged
 * to 0.1% — the same slack the kernel contract's normal checks use.
 */
const NORMAL_UNIT_TOLERANCE = 1e-3;

const mm = (value: number) => length(value, "mm");

function unwrapStl(result: StlExportResult): Uint8Array {
  if (result.ok) return result.value;
  throw new Error(
    `STL export failed with ${result.error.code}: ${result.error.message}`,
  );
}

function expectStlFailure(
  result: StlExportResult,
  code: StlExportErrorCode,
  label: string,
): StlExportError {
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

/** Every parsed vertex matches the source position its index points at. */
function expectVerticesMatchSource(
  document: StlDocument,
  tessellation: Tessellation,
): void {
  expect(document.triangleCount).toBe(tessellationTriangleCount(tessellation));
  for (let t = 0; t < document.triangleCount; t += 1) {
    const triangle = document.triangles[t];
    if (triangle === undefined) {
      throw new Error(`Parsed document is missing triangle ${t}.`);
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const index = tessellation.indices[3 * t + corner];
      if (index === undefined) {
        throw new Error(
          `Source tessellation is missing a corner of triangle ${t}.`,
        );
      }
      const vertex = triangle.vertices[corner];
      if (vertex === undefined) {
        throw new Error(`Parsed triangle ${t} is missing corner ${corner}.`);
      }
      const [px, py, pz] = vertex;
      const sx = tessellation.positions[3 * index] ?? 0;
      const sy = tessellation.positions[3 * index + 1] ?? 0;
      const sz = tessellation.positions[3 * index + 2] ?? 0;
      if (
        !float32Close(px, sx) ||
        !float32Close(py, sy) ||
        !float32Close(pz, sz)
      ) {
        throw new Error(
          `Triangle ${t} corner ${corner}: parsed [${px}, ${py}, ${pz}] does not match source position ${index} [${sx}, ${sy}, ${sz}] within float32 tolerance.`,
        );
      }
    }
  }
}

function expectNormalsUnitLength(document: StlDocument): void {
  for (let t = 0; t < document.triangleCount; t += 1) {
    const normal = document.triangles[t]?.normal;
    if (normal === undefined) {
      throw new Error(`Parsed document is missing triangle ${t}.`);
    }
    const normLength = Math.hypot(normal[0], normal[1], normal[2]);
    if (Math.abs(normLength - 1) > NORMAL_UNIT_TOLERANCE) {
      throw new Error(
        `Facet normal ${t} has length ${normLength}, not unit within ${NORMAL_UNIT_TOLERANCE}: [${normal.join(", ")}].`,
      );
    }
  }
}

/** Box-facet semantics: normals axis-aligned and pointing out of the box. */
function expectBoxFacetNormalsOutward(
  document: StlDocument,
  bounds: KernelBounds,
): void {
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerY = (bounds.min[1] + bounds.max[1]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  for (let t = 0; t < document.triangleCount; t += 1) {
    const triangle = document.triangles[t];
    if (triangle === undefined) {
      throw new Error(`Parsed document is missing triangle ${t}.`);
    }
    const { normal, vertices } = triangle;
    let dominantAxis = 0;
    for (const axis of [1, 2]) {
      if (Math.abs(normal[axis] ?? 0) > Math.abs(normal[dominantAxis] ?? 0)) {
        dominantAxis = axis;
      }
    }
    for (const axis of [0, 1, 2]) {
      if (axis !== dominantAxis) {
        expect(Math.abs(normal[axis] ?? 0)).toBeLessThan(NORMAL_UNIT_TOLERANCE);
      }
    }
    expect(Math.abs(normal[dominantAxis] ?? 0)).toBeGreaterThan(
      1 - NORMAL_UNIT_TOLERANCE,
    );
    let centroid: readonly [number, number, number] = [0, 0, 0];
    for (const vertex of vertices) {
      centroid = [
        centroid[0] + vertex[0] / 3,
        centroid[1] + vertex[1] / 3,
        centroid[2] + vertex[2] / 3,
      ];
    }
    const outward: readonly [number, number, number] = [
      centroid[0] - centerX,
      centroid[1] - centerY,
      centroid[2] - centerZ,
    ];
    const dot =
      (normal[0] ?? 0) * outward[0] +
      (normal[1] ?? 0) * outward[1] +
      (normal[2] ?? 0) * outward[2];
    expect(dot).toBeGreaterThan(0);
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

const boxKernel = createFakeKernel();
const box = fakeBoxTessellation(boxKernel, 2, 3, 4);
const boxBounds: KernelBounds = { min: [0, 0, 0], max: [2, 3, 4] };

describe("exportStlBinary structure", () => {
  it("writes exactly 84 + 50 × triangles bytes with the fixed header", () => {
    const bytes = unwrapStl(exportStlBinary(box));
    expect(bytes.length).toBe(
      STL_MIN_BYTES + STL_TRIANGLE_BYTES * tessellationTriangleCount(box),
    );
    const document = readBinaryStl(bytes);
    expect(document.headerText).toBe(STL_BINARY_HEADER_TEXT);
    expect(document.headerText.startsWith("solid")).toBe(false);
  });

  it("emits zero attribute byte counts and the source triangle count", () => {
    const document = readBinaryStl(unwrapStl(exportStlBinary(box)));
    expect(document.triangleCount).toBe(tessellationTriangleCount(box));
    for (const triangle of document.triangles) {
      expect(triangle.attributeByteCount).toBe(0);
    }
  });

  it("writes each triangle's vertices in the tessellation's index order", () => {
    const document = readBinaryStl(unwrapStl(exportStlBinary(box)));
    expectVerticesMatchSource(document, box);
  });
});

describe("exportStlBinary semantic geometry (independent reader)", () => {
  it("preserves bounds within float32 tolerance", () => {
    const document = readBinaryStl(unwrapStl(exportStlBinary(box)));
    const parsed = documentBounds(document);
    const source = positionsBounds(box.positions);
    expect(parsed.min.length).toBe(3);
    expect(parsed.max.length).toBe(3);
    for (const axis of [0, 1, 2]) {
      expect(float32Close(parsed.min[axis] ?? 0, source.min[axis] ?? 0)).toBe(
        true,
      );
      expect(float32Close(parsed.max[axis] ?? 0, source.max[axis] ?? 0)).toBe(
        true,
      );
      expect(
        float32Close(parsed.min[axis] ?? 0, boxBounds.min[axis] ?? 0),
      ).toBe(true);
      expect(
        float32Close(parsed.max[axis] ?? 0, boxBounds.max[axis] ?? 0),
      ).toBe(true);
    }
  });

  it("collapses kernel vertex normals into unit facet normals", () => {
    const document = readBinaryStl(unwrapStl(exportStlBinary(box)));
    expectNormalsUnitLength(document);
    expectBoxFacetNormalsOutward(document, boxBounds);
  });

  it("writes the (0,0,0) convention for degenerate facet normals", () => {
    // Zero-area triangle without normals: the winding cross product is zero.
    const collinear: Tessellation = {
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
      indices: [0, 1, 2],
    };
    let document = readBinaryStl(unwrapStl(exportStlBinary(collinear)));
    expect(document.triangles[0]?.normal).toEqual([0, 0, 0]);

    // Vertex normals 120° apart cancel: their mean is the zero vector even
    // on a non-degenerate triangle.
    const cancelling: Tessellation = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      normals: [1, 0, 0, -0.5, Math.sqrt(3) / 2, 0, -0.5, -Math.sqrt(3) / 2, 0],
    };
    document = readBinaryStl(unwrapStl(exportStlBinary(cancelling)));
    expect(document.triangles[0]?.normal).toEqual([0, 0, 0]);
  });

  it("computes facet normals from winding when normals are absent", () => {
    const withoutNormals: Tessellation = {
      positions: box.positions,
      indices: box.indices,
    };
    const document = readBinaryStl(unwrapStl(exportStlBinary(withoutNormals)));
    expectNormalsUnitLength(document);
    expectBoxFacetNormalsOutward(document, boxBounds);
    expectVerticesMatchSource(document, withoutNormals);
  });

  it("exports a boolean result soup without corrupting vertices", () => {
    const soup = fakeBoxMinusBoreTessellation(createFakeKernel());
    const document = readBinaryStl(unwrapStl(exportStlBinary(soup)));
    expectVerticesMatchSource(document, soup);
    expectNormalsUnitLength(document);
  });
});

describe("exportStlBinary determinism", () => {
  it("produces byte-identical output for repeated calls", () => {
    expectBytesIdentical(
      unwrapStl(exportStlBinary(box)),
      unwrapStl(exportStlBinary(box)),
      "Repeated export of the same input",
    );
  });

  it("produces byte-identical output for independently built inputs", () => {
    const first = fakeBoxMinusBoreTessellation(createFakeKernel());
    const second = fakeBoxMinusBoreTessellation(createFakeKernel());
    expectBytesIdentical(
      unwrapStl(exportStlBinary(first)),
      unwrapStl(exportStlBinary(second)),
      "Independently built box-minus-bore soups",
    );
  });
});

describe("exportStlBinary rejects malformed input", () => {
  const soup = fakeBoxMinusBoreTessellation(createFakeKernel());

  function mutated(patch: {
    positions?: readonly number[];
    indices?: readonly number[];
    normals?: readonly number[];
  }): Tessellation {
    return { ...soup, ...patch };
  }

  it("rejects an empty tessellation", () => {
    expectStlFailure(
      exportStlBinary({ positions: [], indices: [] }),
      "stl-export/empty-tessellation",
      "Empty soup",
    );
    expectStlFailure(
      exportStlBinary(mutated({ indices: [] })),
      "stl-export/empty-tessellation",
      "No triangles",
    );
  });

  it("rejects arrays that are not flat triples", () => {
    expectStlFailure(
      exportStlBinary(mutated({ positions: soup.positions.slice(0, -1) })),
      "stl-export/malformed-tessellation",
      "Positions not divisible by 3",
    );
    expectStlFailure(
      exportStlBinary(mutated({ indices: soup.indices.slice(0, -1) })),
      "stl-export/malformed-tessellation",
      "Indices not divisible by 3",
    );
    expectStlFailure(
      exportStlBinary(mutated({ normals: soup.normals?.slice(0, -1) ?? [] })),
      "stl-export/malformed-tessellation",
      "Normals not paired with positions",
    );
  });

  it("rejects non-finite and float32-overflowing vertices", () => {
    const nanAt = (index: number): readonly number[] => {
      const positions = [...soup.positions];
      positions[index] = Number.NaN;
      return positions;
    };
    expectStlFailure(
      exportStlBinary(mutated({ positions: nanAt(4) })),
      "stl-export/non-finite-vertex",
      "NaN position",
    );
    const positions = [...soup.positions];
    positions[4] = Number.POSITIVE_INFINITY;
    expectStlFailure(
      exportStlBinary(mutated({ positions })),
      "stl-export/non-finite-vertex",
      "Infinite position",
    );
    positions[4] = 1e39;
    const error = expectStlFailure(
      exportStlBinary(mutated({ positions })),
      "stl-export/non-finite-vertex",
      "Position beyond float32 range",
    );
    expect(error.message).toContain("float32");
  });

  it("rejects indices outside the vertex range", () => {
    for (const bad of [-1, soup.positions.length / 3, 1.5]) {
      const indices = [...soup.indices];
      indices[7] = bad;
      expectStlFailure(
        exportStlBinary(mutated({ indices })),
        "stl-export/index-out-of-range",
        `Index ${bad}`,
      );
    }
  });

  it("rejects non-finite normals", () => {
    const normals = [...(soup.normals ?? [])];
    if (normals.length === 0) {
      throw new Error("The fake boolean soup unexpectedly carries no normals.");
    }
    normals[2] = Number.NaN;
    expectStlFailure(
      exportStlBinary(mutated({ normals })),
      "stl-export/non-finite-normal",
      "NaN normal",
    );
  });
});

describe("exportStlBinary facet-normal overflow guard", () => {
  // Three same-sign finite components of 1e308 sum past DBL_MAX, so the
  // facet normal's renormalized mean is Infinity / Infinity = NaN —
  // validation must reject the soup rather than write a NaN float32 facet
  // normal into the file that this package's own importStl refuses.
  const overflowSoup: Tessellation = {
    positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
    indices: [0, 1, 2],
    normals: [1e308, 0, 0, 1e308, 0, 0, 1e308, 0, 0],
  };

  it("rejects normal components beyond the finite float32 range instead of writing NaN facet normals", () => {
    const error = expectStlFailure(
      exportStlBinary(overflowSoup),
      "stl-export/non-finite-normal",
      "Normals beyond float32 range",
    );
    expect(error.message).toContain("float32");
  });

  it("round-trips the unit-normal control cleanly through importStl", () => {
    const unitSoup: Tessellation = {
      positions: overflowSoup.positions,
      indices: overflowSoup.indices,
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    };
    const imported = importStl(unwrapStl(exportStlBinary(unitSoup)));
    if (!imported.ok) {
      throw new Error(
        `Unit-normal control failed to re-import: ${imported.error.code}: ${imported.error.message}.`,
      );
    }
    expect(imported.value.flavor).toBe("binary");
    expect(imported.value.tessellation.positions).toEqual([
      0, 0, 0, 10, 0, 0, 0, 10, 0,
    ]);
    expect(imported.value.tessellation.normals).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });
});

describe("readBinaryStl strictness", () => {
  it("rejects buffers that do not match the declared triangle count", () => {
    const bytes = unwrapStl(exportStlBinary(box));
    expect(() => readBinaryStl(bytes.subarray(0, bytes.length - 1))).toThrow();
    expect(() => readBinaryStl(bytes.subarray(0, STL_MIN_BYTES - 1))).toThrow();
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => readBinaryStl(padded)).toThrow();
  });

  it("treats float32 rounding as close and real deviations as far", () => {
    expect(float32Close(Math.fround(0.1), 0.1)).toBe(true);
    expect(float32Close(Math.fround(30), 30)).toBe(true);
    expect(float32Close(0, 0)).toBe(true);
    expect(float32Close(0.2, 0.1)).toBe(false);
    expect(float32Close(0, 1e-9)).toBe(false);
  });
});
