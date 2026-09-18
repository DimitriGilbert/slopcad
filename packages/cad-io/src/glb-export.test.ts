/**
 * GLB export unit tests (Phase 19): container structure judged against the
 * glTF 2.0 GLB spec (header fields, chunk order and padding, 4-byte
 * alignment), semantic correctness judged through the independent
 * hand-rolled reader in `./glb-test-reader` (never by exact-buffer goldens
 * alone), naming from the body id, the documented CadScene material,
 * accessor math (float32 conversion, min/max, uint16/uint32 sizing),
 * byte-determinism across independently built inputs, the structured
 * rejection matrix, and the reader's own strictness.
 *
 * Scene geometry is authored in-process (small hand-built soups, plus a
 * 65536-vertex soup for the index-sizing boundary). Real-engine geometry
 * (Manifold) is covered by `./glb-manifold.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  boundsFromPositions,
  createBodyId,
  createRenderProjection,
  parseRenderObjectId,
  projectTessellation,
  type RenderCamera,
  type RenderObject,
  type RenderProjection,
} from "@slopcad/cad-core";

import {
  type GlbExportError,
  type GlbExportErrorCode,
  type GlbExportResult,
  GLB_BASE_COLOR_SRGB,
  GLB_BIN_CHUNK_TYPE,
  GLB_CHUNK_HEADER_BYTES,
  GLB_GENERATOR,
  GLB_HEADER_BYTES,
  GLB_JSON_CHUNK_TYPE,
  GLB_MAGIC,
  GLB_MATERIAL_NAME,
  GLB_METALLIC_FACTOR,
  GLB_ROUGHNESS_FACTOR,
  GLB_UINT16_VERTEX_LIMIT,
  GLB_VERSION,
  exportGlb,
} from "./glb-export";
import { readGlb } from "./glb-test-reader";

/** The projections' camera: any valid spec — GLB export must not read it. */
const CAMERA: RenderCamera = {
  kind: "perspective",
  position: [50, -40, 45],
  target: [5, 5, 0],
  up: [0, 0, 1],
  fovDeg: 40,
};

/** The canonical top-level JSON key order (the exporter's documented one). */
const CANONICAL_TOP_LEVEL_KEYS = [
  "asset",
  "scene",
  "scenes",
  "nodes",
  "meshes",
  "materials",
  "accessors",
  "bufferViews",
  "buffers",
];

function unwrapGlb(result: GlbExportResult): Uint8Array {
  if (result.ok) return result.value;
  throw new Error(
    `GLB export failed with ${result.error.code}: ${result.error.message}`,
  );
}

function expectGlbFailure(
  result: GlbExportResult,
  code: GlbExportErrorCode,
  label: string,
): GlbExportError {
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

/** Projects a soup through the public cad-core boundary under a body id. */
function projectedObject(
  bodyPayload: string,
  positions: number[],
  indices: number[],
  normals?: number[],
): RenderObject {
  const result = projectTessellation(
    createBodyId(`body_${bodyPayload}`),
    normals === undefined
      ? { positions, indices }
      : { positions, indices, normals },
  );
  if (!result.ok) {
    throw new Error(`Fixture projection rejected: ${result.error.message}`);
  }
  return result.value;
}

/** An object with bodyId absent — the node-name fallback path. */
function anonymousObject(
  payload: string,
  positions: number[],
  indices: number[],
): RenderObject {
  const id = parseRenderObjectId(`rend_${payload}`);
  if (!id.ok)
    throw new Error(`Fixture render id rejected: ${id.error.message}`);
  return {
    id: id.value,
    positions,
    indices,
    bounds: boundsFromPositions(positions),
  };
}

/**
 * A raw object carrying structurally INVALID buffers (the rejection
 * matrix's inputs): bounds are fixed constants because invalid positions
 * have no derivable box, and the object bypasses the validating projection
 * boundary the same way any untrusted runtime input would.
 */
function rawObject(
  payload: string,
  positions: number[],
  indices: number[],
  normals?: number[],
): RenderObject {
  const id = parseRenderObjectId(`rend_${payload}`);
  if (!id.ok)
    throw new Error(`Fixture render id rejected: ${id.error.message}`);
  return {
    id: id.value,
    positions,
    indices,
    ...(normals === undefined ? {} : { normals }),
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

function projectionOf(objects: RenderObject[]): RenderProjection {
  const result = createRenderProjection(objects, CAMERA);
  if (!result.ok) {
    throw new Error(`Fixture projection rejected: ${result.error.message}`);
  }
  return result.value;
}

/** A one-triangle soup with unit +z vertex normals. */
function triangleSoup(): {
  positions: number[];
  indices: number[];
  normals: number[];
} {
  return {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  };
}

/** Assembles the container layout facts of an exported GLB. */
function containerLayout(bytes: Uint8Array): {
  readonly jsonChunkLength: number;
  readonly jsonChunkStart: number;
  readonly binChunkLength: number;
  readonly binChunkStart: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonChunkStart = GLB_HEADER_BYTES;
  const jsonChunkLength = view.getUint32(jsonChunkStart, true);
  const binChunkStart =
    jsonChunkStart + GLB_CHUNK_HEADER_BYTES + jsonChunkLength;
  const binChunkLength = view.getUint32(binChunkStart, true);
  return { jsonChunkLength, jsonChunkStart, binChunkLength, binChunkStart };
}

/**
 * The expected glTF linear base color of {@link GLB_BASE_COLOR_SRGB},
 * computed here independently of the exporter (same IEC transfer function,
 * re-derived in the test so a formula regression cannot hide).
 */
function expectedBaseColorLinear(): [number, number, number, number] {
  const linear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const hex = GLB_BASE_COLOR_SRGB.slice(1);
  return [
    linear(Number.parseInt(hex.slice(0, 2), 16)),
    linear(Number.parseInt(hex.slice(2, 4), 16)),
    linear(Number.parseInt(hex.slice(4, 6), 16)),
    1,
  ];
}

describe("GLB container structure (glTF 2.0 spec)", () => {
  it("writes the 12-byte header: magic, version 2, total length", () => {
    const soup = triangleSoup();
    const bytes = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject("plate", soup.positions, soup.indices, soup.normals),
        ]),
      ),
    );
    expect(bytes.length).toBeGreaterThanOrEqual(GLB_HEADER_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(GLB_MAGIC);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("glTF");
    expect(view.getUint32(4, true)).toBe(GLB_VERSION);
    expect(view.getUint32(8, true)).toBe(bytes.length);
  });

  it("carries the JSON chunk first and the BIN chunk second, both 4-aligned", () => {
    const soup = triangleSoup();
    const bytes = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject("plate", soup.positions, soup.indices, soup.normals),
        ]),
      ),
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { jsonChunkStart, jsonChunkLength, binChunkStart, binChunkLength } =
      containerLayout(bytes);
    expect(view.getUint32(jsonChunkStart + 4, true)).toBe(GLB_JSON_CHUNK_TYPE);
    expect(jsonChunkLength % 4).toBe(0);
    expect(view.getUint32(binChunkStart + 4, true)).toBe(GLB_BIN_CHUNK_TYPE);
    expect(binChunkLength % 4).toBe(0);
    expect(binChunkStart + GLB_CHUNK_HEADER_BYTES + binChunkLength).toBe(
      bytes.length,
    );
  });

  it("pads the JSON chunk with Space chars (0x20) and the BIN chunk with zeros", () => {
    // One triangle's uint16 indices are 6 bytes — a BIN segment that needs
    // 2 zero pad bytes; the JSON chunk pads to 4 with 0x20 whatever its
    // content length is.
    const soup = triangleSoup();
    const bytes = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject("plate", soup.positions, soup.indices, soup.normals),
        ]),
      ),
    );
    const { jsonChunkStart, jsonChunkLength, binChunkStart, binChunkLength } =
      containerLayout(bytes);
    const document = readGlb(bytes);
    // The JSON chunk's padding: every byte after the parsed JSON text (the
    // test strips trailing 0x20 the same way the reader does) through the
    // chunk end must be 0x20.
    const jsonContentLength = new TextEncoder().encode(
      decoderJsonText(bytes),
    ).length;
    expect(jsonContentLength).toBeLessThan(jsonChunkLength);
    for (
      let i = jsonChunkStart + GLB_CHUNK_HEADER_BYTES + jsonContentLength;
      i < jsonChunkStart + GLB_CHUNK_HEADER_BYTES + jsonChunkLength;
      i += 1
    ) {
      expect(bytes[i]).toBe(0x20);
    }
    // The BIN chunk: the declared buffer length plus up to 3 zero bytes.
    const declared = document.bufferByteLength;
    expect(binChunkLength - declared).toBeGreaterThanOrEqual(0);
    expect(binChunkLength - declared).toBeLessThanOrEqual(3);
    expect(binChunkLength - declared).toBeGreaterThan(0); // 3 uint16 indices (6 bytes) need 2 pad bytes
    const binDataStart = binChunkStart + GLB_CHUNK_HEADER_BYTES;
    for (
      let i = binDataStart + declared;
      i < binDataStart + binChunkLength;
      i += 1
    ) {
      expect(bytes[i]).toBe(0x00);
    }
  });

  it("emits the exporter's canonical top-level JSON key order", () => {
    const soup = triangleSoup();
    const bytes = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject("plate", soup.positions, soup.indices, soup.normals),
        ]),
      ),
    );
    const document = readGlb(bytes);
    expect(document.topLevelKeys).toEqual(CANONICAL_TOP_LEVEL_KEYS);
    expect(document.assetVersion).toBe("2.0");
    expect(document.generator).toBe(GLB_GENERATOR);
  });
});

/** Extracts the JSON chunk's text the way the reader does (pad-stripped). */
function decoderJsonText(bytes: Uint8Array): string {
  const { jsonChunkStart, jsonChunkLength } = containerLayout(bytes);
  const data = bytes.subarray(
    jsonChunkStart + GLB_CHUNK_HEADER_BYTES,
    jsonChunkStart + GLB_CHUNK_HEADER_BYTES + jsonChunkLength,
  );
  let end = data.length;
  while (end > 0 && data[end - 1] === 0x20) end -= 1;
  return new TextDecoder().decode(data.subarray(0, end));
}

describe("GLB glTF-level structure and semantics", () => {
  it("names nodes from the body id, falling back to the render object id", () => {
    const soup = triangleSoup();
    const bytes = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject("plate", soup.positions, soup.indices, soup.normals),
          anonymousObject("extra", soup.positions, soup.indices),
        ]),
      ),
    );
    const document = readGlb(bytes);
    expect(document.nodeNames).toEqual(["body_plate", "rend_extra"]);
    expect(document.nodes.length).toBe(2);
    for (const node of document.nodes) {
      expect(node.primitive.positions.length).toBe(3);
      expect(node.primitive.indices).toEqual([0, 1, 2]);
    }
  });

  it("round-trips positions, normals and indices at float32 fidelity", () => {
    // Values chosen so float32 rounding is exact for them; 0.1 exercises
    // the fround path (source 0.1 → float32 0.100000001490116...).
    const positions = [0, 0, 0, 1.5, 0, 0, 0, 0.1, 0];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const bytes = unwrapGlb(
      exportGlb(
        projectionOf([projectedObject("plate", positions, [0, 1, 2], normals)]),
      ),
    );
    const primitive = readGlb(bytes).nodes[0]?.primitive;
    expect(primitive).toBeDefined();
    if (primitive === undefined) throw new Error("unreachable");
    expect(primitive.positions.length).toBe(3);
    for (let v = 0; v < 3; v += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        expect(primitive.positions[v]?.[axis]).toBe(
          Math.fround(positions[3 * v + axis] ?? 0),
        );
        expect(primitive.normals?.[v]?.[axis]).toBe(
          Math.fround(normals[3 * v + axis] ?? 0),
        );
      }
    }
  });

  it("writes POSITION accessor min/max describing the converted float32 data", () => {
    const positions = [-1.25, 0, 2.5, 1, 0.5, -3.75, 0, 7, 0.125];
    const bytes = unwrapGlb(
      exportGlb(projectionOf([projectedObject("plate", positions, [0, 1, 2])])),
    );
    const primitive = readGlb(bytes).nodes[0]?.primitive;
    if (primitive === undefined) throw new Error("unreachable");
    const minExpected = [
      Math.fround(-1.25),
      Math.fround(0),
      Math.fround(-3.75),
    ];
    const maxExpected = [Math.fround(1), Math.fround(7), Math.fround(2.5)];
    expect(primitive.positionMin).toEqual(minExpected);
    expect(primitive.positionMax).toEqual(maxExpected);
  });

  it("emits the documented CadScene material as linear pbrMetallicRoughness", () => {
    const soup = triangleSoup();
    const bytes = unwrapGlb(
      exportGlb(
        projectionOf([projectedObject("plate", soup.positions, soup.indices)]),
      ),
    );
    const document = readGlb(bytes);
    expect(document.materialName).toBe(GLB_MATERIAL_NAME);
    expect(document.baseColorFactor).toEqual(expectedBaseColorLinear());
    expect(document.metallicFactor).toBe(GLB_METALLIC_FACTOR);
    expect(document.roughnessFactor).toBe(GLB_ROUGHNESS_FACTOR);
    // 0.15 and 0.55 are exact decimal-to-binary values (JSON shortest form
    // must reparse to exactly the documented constants).
    expect(document.baseColorFactor.length).toBe(4);
    expect(document.baseColorFactor[3]).toBe(1);
  });

  it("sizes primitive indices uint16 up to the 65535-vertex limit, uint32 above", () => {
    const atLimit = GLB_UINT16_VERTEX_LIMIT;
    const build = (vertexCount: number): Uint8Array => {
      const positions: number[] = [];
      for (let v = 0; v < vertexCount; v += 1) positions.push(v, 0, 0);
      return unwrapGlb(
        exportGlb(projectionOf([projectedObject("big", positions, [0, 1, 2])])),
      );
    };
    const small = readGlb(build(atLimit));
    expect(small.nodes[0]?.primitive.indexComponentType).toBe(5123);
    // At 65535 vertices the largest index is 65534 — the uint16 max the
    // spec allows without hitting the forbidden primitive-restart value.
    expect(
      small.nodes[0]?.primitive.indices.every((index) => index < 65_535),
    ).toBe(true);
    const large = readGlb(build(atLimit + 1));
    expect(large.nodes[0]?.primitive.indexComponentType).toBe(5125);
  });

  it("is byte-identical across repeated exports and independently built inputs", () => {
    const first = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject(
            "plate",
            triangleSoup().positions,
            triangleSoup().indices,
            triangleSoup().normals,
          ),
        ]),
      ),
    );
    const second = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject(
            "plate",
            triangleSoup().positions,
            triangleSoup().indices,
            triangleSoup().normals,
          ),
        ]),
      ),
    );
    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length; i += 1) {
      if (first[i] !== second[i]) {
        throw new Error(`Repeated exports differ at byte ${i}.`);
      }
    }
    // Two objects, exported twice: order (projection order) is pinned too.
    const multiFirst = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject(
            "plate",
            triangleSoup().positions,
            triangleSoup().indices,
          ),
          projectedObject("block", [1, 1, 1, 2, 1, 1, 1, 2, 1], [0, 1, 2]),
        ]),
      ),
    );
    const multiSecond = unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject(
            "plate",
            triangleSoup().positions,
            triangleSoup().indices,
          ),
          projectedObject("block", [1, 1, 1, 2, 1, 1, 1, 2, 1], [0, 1, 2]),
        ]),
      ),
    );
    expect(Buffer.from(multiSecond).equals(Buffer.from(multiFirst))).toBe(true);
  });
});

describe("GLB export rejection matrix", () => {
  it("rejects an empty projection with glb-export/empty-projection", () => {
    const error = expectGlbFailure(
      exportGlb(projectionOf([])),
      "glb-export/empty-projection",
      "empty projection",
    );
    expect(error.message).toContain("no render objects");
  });

  it("rejects an object with no triangles with glb-export/empty-object", () => {
    const object = anonymousObject("hollow", [0, 0, 0, 1, 0, 0, 0, 1, 0], []);
    const error = expectGlbFailure(
      exportGlb(projectionOf([object])),
      "glb-export/empty-object",
      "empty object",
    );
    expect(error.message).toContain("no triangles");
  });

  it("rejects non-triple buffers and unpaired normals with glb-export/malformed-object", () => {
    const raggedPositions = rawObject("ragged", [0, 0, 0, 1, 0], [0]);
    expectGlbFailure(
      exportGlb(projectionOf([raggedPositions])),
      "glb-export/malformed-object",
      "positions not divisible by 3",
    );
    const raggedIndices = rawObject(
      "ragged-idx",
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1],
    );
    expectGlbFailure(
      exportGlb(projectionOf([raggedIndices])),
      "glb-export/malformed-object",
      "indices not divisible by 3",
    );
    const unpaired = rawObject(
      "unpaired",
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, 2],
      [0, 0, 1],
    );
    expectGlbFailure(
      exportGlb(projectionOf([unpaired])),
      "glb-export/malformed-object",
      "normals not paired with positions",
    );
  });

  it("rejects non-finite and float32-overflowing vertices with glb-export/non-finite-vertex", () => {
    const nan = rawObject(
      "nan",
      [Number.NaN, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, 2],
    );
    expectGlbFailure(
      exportGlb(projectionOf([nan])),
      "glb-export/non-finite-vertex",
      "NaN position",
    );
    const infinite = rawObject(
      "inf",
      [0, 0, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 1, 0],
      [0, 1, 2],
    );
    expectGlbFailure(
      exportGlb(projectionOf([infinite])),
      "glb-export/non-finite-vertex",
      "infinite position",
    );
    const overflow = rawObject(
      "overflow",
      [0, 0, 0, 1e39, 0, 0, 0, 1, 0],
      [0, 1, 2],
    );
    expectGlbFailure(
      exportGlb(projectionOf([overflow])),
      "glb-export/non-finite-vertex",
      "float32-overflowing position",
    );
  });

  it("rejects non-finite normals with glb-export/non-finite-normal", () => {
    const object = rawObject(
      "badnormal",
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, 2],
      [0, 0, 1, 0, 0, 1, Number.NaN, 0, 1],
    );
    expectGlbFailure(
      exportGlb(projectionOf([object])),
      "glb-export/non-finite-normal",
      "NaN normal",
    );
  });

  it("rejects out-of-range indices with glb-export/index-out-of-range", () => {
    const object = rawObject("wild", [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 3]);
    const error = expectGlbFailure(
      exportGlb(projectionOf([object])),
      "glb-export/index-out-of-range",
      "index beyond vertex range",
    );
    expect(error.message).toContain("vertex range");
  });
});

describe("GLB test-reader strictness", () => {
  function validBytes(): Uint8Array {
    const soup = triangleSoup();
    return unwrapGlb(
      exportGlb(
        projectionOf([
          projectedObject("plate", soup.positions, soup.indices, soup.normals),
        ]),
      ),
    );
  }

  it("rejects a corrupted magic, a wrong version, and a truncated file", () => {
    const badMagic = Uint8Array.from(validBytes());
    badMagic[0] = 0x00;
    expect(() => readGlb(badMagic)).toThrow(/magic/);

    const badVersion = Uint8Array.from(validBytes());
    const badVersionView = new DataView(badVersion.buffer);
    badVersionView.setUint32(4, 1, true);
    expect(() => readGlb(badVersion)).toThrow(/version/);

    const truncated = validBytes().subarray(0, validBytes().length - 1);
    expect(() => readGlb(truncated)).toThrow(/length/);
  });

  it("rejects JSON chunks padded with zeros instead of Space chars", () => {
    const valid = validBytes();
    const document = readGlb(valid);
    const jsonText = decoderJsonText(valid);
    const contentLength = new TextEncoder().encode(jsonText).length;
    const padCount = (4 - (contentLength % 4)) % 4;
    expect(padCount).toBeGreaterThan(0);
    // Reassemble the container with 0x00 JSON padding.
    const { binChunkStart } = containerLayout(valid);
    const binChunk = valid.subarray(binChunkStart);
    const jsonChunkLength = contentLength + padCount;
    const total =
      GLB_HEADER_BYTES +
      GLB_CHUNK_HEADER_BYTES +
      jsonChunkLength +
      binChunk.length;
    const corrupt = new Uint8Array(total);
    const view = new DataView(corrupt.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, GLB_VERSION, true);
    view.setUint32(8, total, true);
    view.setUint32(GLB_HEADER_BYTES, jsonChunkLength, true);
    view.setUint32(GLB_HEADER_BYTES + 4, GLB_JSON_CHUNK_TYPE, true);
    corrupt.set(
      valid.subarray(
        GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES,
        GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + contentLength,
      ),
      GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES,
    );
    corrupt.set(
      binChunk,
      GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + jsonChunkLength,
    );
    expect(() => readGlb(corrupt)).toThrow(/padding|Space|JSON/);
    expect(document.topLevelKeys.length).toBeGreaterThan(0); // sanity on the valid parse
  });

  it("rejects chunk lengths that are not multiples of four", () => {
    const valid = validBytes();
    const jsonText = decoderJsonText(valid);
    const contentLength = new TextEncoder().encode(jsonText).length;
    const { binChunkStart } = containerLayout(valid);
    const binChunk = valid.subarray(binChunkStart);
    const oddLength = contentLength + 1;
    const total =
      GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + oddLength + binChunk.length;
    const corrupt = new Uint8Array(total);
    const view = new DataView(corrupt.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, GLB_VERSION, true);
    view.setUint32(8, total, true);
    view.setUint32(GLB_HEADER_BYTES, oddLength, true);
    view.setUint32(GLB_HEADER_BYTES + 4, GLB_JSON_CHUNK_TYPE, true);
    corrupt.set(
      valid.subarray(
        GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES,
        GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + contentLength,
      ),
      GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES,
    );
    corrupt.set(
      binChunk,
      GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + oddLength,
    );
    expect(() => readGlb(corrupt)).toThrow(/multiple of four/);
  });

  it("rejects BIN data whose decoded values contradict the POSITION min/max", () => {
    const valid = validBytes();
    // Flip a bit inside the positions segment (first float32 of the first
    // buffer view, right after the BIN chunk header): the decoded value no
    // longer matches the accessor's declared min/max.
    const { binChunkStart } = containerLayout(valid);
    const corrupt = Uint8Array.from(valid);
    const firstPositionAt = binChunkStart + GLB_CHUNK_HEADER_BYTES;
    const original = new DataView(corrupt.buffer).getFloat32(
      firstPositionAt,
      true,
    );
    new DataView(corrupt.buffer).setFloat32(
      firstPositionAt,
      original === 0 ? 1.5 : 0,
      true,
    );
    expect(() => readGlb(corrupt)).toThrow(/min|max|decoded/);
  });

  it("rejects indices beyond the vertex range", () => {
    const valid = validBytes();
    const document = readGlb(valid);
    const { binChunkStart } = containerLayout(valid);
    // The indices are the last segment; the final uint16 is index 2.
    const lastIndexPath =
      binChunkStart + GLB_CHUNK_HEADER_BYTES + document.bufferByteLength - 2;
    const corrupt = Uint8Array.from(valid);
    new DataView(corrupt.buffer).setUint16(lastIndexPath, 65_535, true);
    expect(() => readGlb(corrupt)).toThrow(/index/);
  });
});
