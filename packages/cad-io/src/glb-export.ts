/**
 * GLB export (Phase 19): serializes the Phase 11.1 render projection — the
 * renderer-neutral render data ({@link RenderProjection}: one indexed
 * triangle soup per body in canonical millimetres, with the kernel's
 * crease-aware unit normals whenever the kernel computed them) — into the
 * glTF 2.0 GLB container as a {@link Uint8Array}, ready for download or
 * disk.
 *
 * ## Input surface
 *
 * The plan's Phase 19 reads "render projection", and that is what this
 * adapter takes: the projection IS the renderer-neutral render data, and it
 * carries the two things a GLB viewer should receive — the geometry and the
 * kernel normals that shade the CAD faces flat. The projection's camera
 * rides along in the type but has **no destination in this format** (scene
 * framing is the receiving viewer's concern — the same "no destination"
 * discipline as the 3MF exporter's treatment of normals); it is deliberately
 * not read. A caller holding only a raw kernel `Tessellation` wraps it in
 * one line through cad-core's `projectTessellation` +
 * `createRenderProjection` instead of this module growing a second input
 * shape.
 *
 * ## Spec conformance (glTF 2.0, Khronos)
 *
 * - **Container** — the 12-byte header (`magic` `0x46546C67` = ASCII
 *   `glTF`, `version` 2, `length` = total file length), then exactly two
 *   chunks in the spec's mandated order: the JSON chunk (`0x4E4F534A`)
 *   first, the BIN chunk (`0x004E4942`) second. The start and end of each
 *   chunk are 4-byte aligned: the JSON chunk is padded with trailing Space
 *   chars (`0x20`), the BIN chunk with trailing zeros (`0x00`), exactly as
 *   the GLB File Format Specification requires.
 * - **Structure** — one `node` per render object (in projection order),
 *   named from the object's body id — the stable document identity, e.g.
 *   `body_plate` — falling back to the render object id when a body id is
 *   absent; a single `scene` referencing every node; one `mesh` per node
 *   with one indexed `primitive` (`mode` 4, TRIANGLES) whose `POSITION` and
 *   (when the object carries them) `NORMAL` attributes and scalar `indices`
 *   each reference their own `bufferView` (targets 34962 / 34963), so no
 *   buffer view ever mixes the data kinds the spec forbids mixing.
 * - **Attributes** — `POSITION`/`NORMAL` are VEC3 float32 (componentType
 *   5126) as the spec's attribute table demands; the f64 soup converts with
 *   round-to-nearest (`Math.fround` / `DataView.setFloat32` semantics), and
 *   magnitudes beyond the finite float32 range are rejected rather than
 *   written as infinities (the spec forbids infinite or NaN attribute
 *   data). Every value is written little-endian through `DataView` — never
 *   through platform-endian typed-array views.
 * - **`min`/`max`** — the `POSITION` accessor carries `min`/`max` (a spec
 *   MUST), computed from the *converted* float32 values so they describe
 *   exactly the data the accessor holds; the `NORMAL` accessor omits them
 *   (the spec requires them only for positions).
 * - **Indices** — scalar (SCALAR), uint16 (componentType 5123) when an
 *   object has at most {@link GLB_UINT16_VERTEX_LIMIT} vertices (then the
 *   largest index is 65534, safely below the value the spec forbids — the
 *   component-type maximum triggers primitive restart), otherwise uint32
 *   (5125).
 * - **Alignment** — every buffer view starts at a 4-byte boundary (a
 *   multiple of the 4-byte float32/uint32 component sizes and of the
 *   stricter 4-byte vertex-attribute rule; uint16 index views start
 *   4-aligned too, so their element size 2 divides every access stride the
 *   spec checks), accessor byte offsets are zero, and `buffers[0]` is the
 *   GLB-stored buffer with no `uri`; its `byteLength` is the unpadded data
 *   length (the spec allows the BIN chunk to exceed it by up to 3
 *   alignment bytes).
 * - **Material** — one shared `material` for every primitive, encoding the
 *   CadScene material conventions through `pbrMetallicRoughness`:
 *   `baseColorFactor` is the documented default body color `#8aadf4`
 *   (`packages/cad-r3f/src/cad-model.tsx`'s `DEFAULT_MATERIAL`, the Phase
 *   1.6 spike scene's fixed parameters) converted sRGB→linear — glTF color
 *   factors are linear multipliers — with `metallicFactor`/`roughnessFactor`
 *   from the same documented metalness 0.15 / roughness 0.55. The constants
 *   are restated here, with citation, because cad-io must never depend on a
 *   renderer package.
 * - **No camera** — GLB cameras are not emitted; the projection's camera is
 *   render-time data (see Input surface).
 *
 * ## Determinism
 *
 * Same projection, byte-identical `.glb`, every call: a fixed JSON key
 * order (glTF prescribes none; this exporter's canonical order is asset,
 * scene, scenes, nodes, meshes, materials, accessors, bufferViews,
 * buffers, with each object's keys in the order the builders below emit
 * them), numbers emitted as JavaScript's shortest round-tripping decimal
 * (`JSON.stringify`), a fixed `asset.generator` string, segments laid out
 * in projection order with zero-only alignment padding, and no timestamp,
 * random, or environment-dependent byte anywhere.
 *
 * ## Failure discipline
 *
 * The projection arrives across a trust boundary, so every structural
 * defect is rejected as a structured {@link GlbExportError} on the cad-core
 * `ParseResult` discipline — never a throw, never a partially written file:
 * an empty projection, a render object with no triangles, non-triple or
 * non-finite (or float32-overflowing) buffers, unpaired normals, and
 * out-of-range indices.
 */

import { type ParseFailure, type ParseResult, fail, ok } from "@slopcad/cad-core";
import type { RenderObject, RenderProjection } from "@slopcad/cad-core";

/** Stable failure codes produced when GLB export rejects its input. */
export const GLB_EXPORT_ERROR_CODES = {
  /** A projection with no render objects has nothing to export. */
  emptyProjection: "glb-export/empty-projection",
  /** A render object with no triangles cannot become a mesh primitive. */
  emptyObject: "glb-export/empty-object",
  /** Positions/indices were not flat triples, or normals did not pair. */
  malformedObject: "glb-export/malformed-object",
  /** A vertex coordinate was NaN/infinite, or beyond the finite float32 range. */
  nonFiniteVertex: "glb-export/non-finite-vertex",
  /** A normal component (when the object carries normals) was not finite. */
  nonFiniteNormal: "glb-export/non-finite-normal",
  /** An index was not an integer inside the object's vertex range. */
  indexOutOfRange: "glb-export/index-out-of-range",
} as const;

export type GlbExportErrorCode =
  (typeof GLB_EXPORT_ERROR_CODES)[keyof typeof GLB_EXPORT_ERROR_CODES];

/** Structured failure describing why GLB export rejected its input. */
export interface GlbExportError extends ParseFailure {
  readonly code: GlbExportErrorCode;
}

/** The result of GLB export: serialized bytes, or a structured failure. */
export type GlbExportResult = ParseResult<Uint8Array, GlbExportError>;

/** GLB header byte length: magic + version + total length. */
export const GLB_HEADER_BYTES = 12;

/** Byte length of one chunk preamble: chunkLength + chunkType. */
export const GLB_CHUNK_HEADER_BYTES = 8;

/** The GLB `magic` value: ASCII `glTF` (a spec MUST). */
export const GLB_MAGIC = 0x4654_6c67;

/** The GLB container version this exporter writes (spec: 2). */
export const GLB_VERSION = 2;

/** Chunk type of the JSON chunk (`0x4E4F534A` = ASCII `JSON`). */
export const GLB_JSON_CHUNK_TYPE = 0x4e4f_534a;

/** Chunk type of the BIN chunk (`0x004E4942` = ASCII `BIN\0`). */
export const GLB_BIN_CHUNK_TYPE = 0x004e_4942;

/**
 * The `asset.generator` value: a fixed slopcad identifier. Never a
 * timestamp or any run-varying content.
 */
export const GLB_GENERATOR = "slopcad glb-export (phase 19)";

/**
 * The largest vertex count addressable by uint16 primitive indices under
 * the spec rule that indices MUST NOT equal the component-type maximum:
 * with at most 65535 vertices the largest index is 65534. At or below this
 * count the exporter writes uint16 indices (componentType 5123), above it
 * uint32 (5125).
 */
export const GLB_UINT16_VERTEX_LIMIT = 65_535;

/** glTF accessor componentType for float32. */
const COMPONENT_TYPE_FLOAT32 = 5126;
/** glTF accessor componentType for uint16. */
const COMPONENT_TYPE_UINT16 = 5123;
/** glTF accessor componentType for uint32. */
const COMPONENT_TYPE_UINT32 = 5125;

/** glTF bufferView target: ARRAY_BUFFER (vertex attributes). */
const TARGET_ARRAY_BUFFER = 34962;
/** glTF bufferView target: ELEMENT_ARRAY_BUFFER (vertex indices). */
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/**
 * The documented default body color, sRGB hex —
 * `packages/cad-r3f/src/cad-model.tsx` `DEFAULT_MATERIAL.color` (the Phase
 * 1.6 spike scene's fixed material), restated here with citation because
 * cad-io must never depend on a renderer package.
 */
export const GLB_BASE_COLOR_SRGB = "#8aadf4";

/** The documented metalness — `DEFAULT_MATERIAL.metalness` (see above). */
export const GLB_METALLIC_FACTOR = 0.15;

/** The documented roughness — `DEFAULT_MATERIAL.roughness` (see above). */
export const GLB_ROUGHNESS_FACTOR = 0.55;

/** The shared material's name in the emitted JSON. */
export const GLB_MATERIAL_NAME = "slopcad-cad-scene-default";

/** Largest finite float32; vertex magnitudes beyond this cannot be written. */
const FLOAT32_MAX = 3.402_823_466_385_288_6e38;

/**
 * Converts one sRGB channel (0-255) to its glTF linear factor: the IEC
 * 61966-2-1 transfer function. Pure integer-and-pow math — the same value
 * on every engine, every run.
 */
function srgbChannelToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * The `baseColorFactor` (linear RGBA) of {@link GLB_BASE_COLOR_SRGB}.
 * Computed from the hex, not hard-coded, so the sRGB source stays the
 * single statement of the color.
 */
const BASE_COLOR_LINEAR: readonly [number, number, number, number] = [
  srgbChannelToLinear(Number.parseInt(GLB_BASE_COLOR_SRGB.slice(1, 3), 16)),
  srgbChannelToLinear(Number.parseInt(GLB_BASE_COLOR_SRGB.slice(3, 5), 16)),
  srgbChannelToLinear(Number.parseInt(GLB_BASE_COLOR_SRGB.slice(5, 7), 16)),
  1,
];

const encoder = new TextEncoder();

function glbError(
  code: GlbExportErrorCode,
  message: string,
  input: unknown,
): GlbExportError {
  return { code, message, input };
}

/**
 * One render object converted into GLB-ready typed segments. The arrays
 * hold the exact float32 values `DataView.setFloat32(…, true)` will write
 * (round-to-nearest of the source f64), so the accessor min/max below
 * describe the emitted bytes exactly.
 */
interface PreparedObject {
  /** Node name: the body id, or the render object id when absent. */
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  readonly indices: Uint16Array | Uint32Array;
  /** Component type of the indices accessor: 5123 or 5125. */
  readonly indexComponentType: number;
  /** float32 min per axis of the converted positions (accessor `min`). */
  readonly positionMin: readonly [number, number, number];
  /** float32 max per axis of the converted positions (accessor `max`). */
  readonly positionMax: readonly [number, number, number];
}

/**
 * Validates one render object against everything the writer needs and
 * converts its buffers into float32/int segments, returning the first
 * structured failure found or the prepared object.
 */
function prepareObject(
  object: RenderObject,
  index: number,
): ParseResult<PreparedObject, GlbExportError> {
  const label = `Render object ${index}`;
  const { positions, indices, normals } = object;
  if (indices.length === 0) {
    return fail(
      glbError(
        GLB_EXPORT_ERROR_CODES.emptyObject,
        `${label} has no triangles; empty bodies project to no object, so an exported projection must not carry one.`,
        indices,
      ),
    );
  }
  if (positions.length % 3 !== 0) {
    return fail(
      glbError(
        GLB_EXPORT_ERROR_CODES.malformedObject,
        `${label} positions length ${positions.length} is not divisible by 3 (flat xyz triples required).`,
        positions.length,
      ),
    );
  }
  if (indices.length % 3 !== 0) {
    return fail(
      glbError(
        GLB_EXPORT_ERROR_CODES.malformedObject,
        `${label} indices length ${indices.length} is not divisible by 3 (triangle index triples required).`,
        indices.length,
      ),
    );
  }
  if (normals !== undefined && normals.length !== positions.length) {
    return fail(
      glbError(
        GLB_EXPORT_ERROR_CODES.malformedObject,
        `${label} normals length ${normals.length} does not pair index-for-index with positions length ${positions.length}.`,
        normals.length,
      ),
    );
  }
  const vertexCount = positions.length / 3;
  const positions32 = new Float32Array(positions.length);
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < positions.length; i += 1) {
    const value = positions[i];
    if (value === undefined || !Number.isFinite(value)) {
      return fail(
        glbError(
          GLB_EXPORT_ERROR_CODES.nonFiniteVertex,
          `${label} position ${i} is not a finite number (got ${String(value)}); float32 POSITION data cannot carry NaN or infinity.`,
          value,
        ),
      );
    }
    if (Math.abs(value) > FLOAT32_MAX) {
      return fail(
        glbError(
          GLB_EXPORT_ERROR_CODES.nonFiniteVertex,
          `${label} position ${i} (${String(value)}) is beyond the finite float32 range ±${FLOAT32_MAX}; float32 POSITION data would round it to infinity.`,
          value,
        ),
      );
    }
    const value32 = Math.fround(value);
    positions32[i] = value32;
    const axis = i % 3;
    if (value32 < (min[axis] ?? Number.POSITIVE_INFINITY)) min[axis] = value32;
    if (value32 > (max[axis] ?? Number.NEGATIVE_INFINITY)) max[axis] = value32;
  }
  let normals32: Float32Array | null = null;
  if (normals !== undefined) {
    normals32 = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 1) {
      const value = normals[i];
      if (value === undefined || !Number.isFinite(value)) {
        return fail(
          glbError(
            GLB_EXPORT_ERROR_CODES.nonFiniteNormal,
            `${label} normal component ${i} is not a finite number (got ${String(value)}); float32 NORMAL data cannot carry NaN or infinity.`,
            value,
          ),
        );
      }
      if (Math.abs(value) > FLOAT32_MAX) {
        return fail(
          glbError(
            GLB_EXPORT_ERROR_CODES.nonFiniteNormal,
            `${label} normal component ${i} (${String(value)}) is beyond the finite float32 range; float32 NORMAL data would round it to infinity.`,
            value,
          ),
        );
      }
      normals32[i] = Math.fround(value);
    }
  }
  const useUint32 = vertexCount > GLB_UINT16_VERTEX_LIMIT;
  const indicesTyped = useUint32
    ? new Uint32Array(indices.length)
    : new Uint16Array(indices.length);
  for (let i = 0; i < indices.length; i += 1) {
    const value = indices[i];
    if (
      value === undefined ||
      !Number.isInteger(value) ||
      value < 0 ||
      value >= vertexCount
    ) {
      return fail(
        glbError(
          GLB_EXPORT_ERROR_CODES.indexOutOfRange,
          `${label} index ${i} is ${String(value)}, not an integer inside the vertex range 0..${vertexCount - 1}.`,
          value,
        ),
      );
    }
    indicesTyped[i] = value;
  }
  return ok({
    name: object.bodyId ?? object.id,
    positions: positions32,
    normals: normals32,
    indices: indicesTyped,
    indexComponentType: useUint32 ? COMPONENT_TYPE_UINT32 : COMPONENT_TYPE_UINT16,
    positionMin: min,
    positionMax: max,
  });
}

/** One planned BIN segment: its bufferView record and its byte writer. */
interface PlannedSegment {
  readonly bufferView: {
    readonly buffer: number;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly target: number;
  };
  readonly write: (view: DataView, byteOffset: number) => void;
}

/** The glTF JSON document shape this exporter emits (fixed key order). */
interface GltfJson {
  readonly asset: { readonly version: string; readonly generator: string };
  readonly scene: number;
  readonly scenes: { readonly nodes: number[] }[];
  readonly nodes: { readonly name: string; readonly mesh: number }[];
  readonly meshes: {
    readonly primitives: {
      readonly attributes:
        | { readonly POSITION: number }
        | { readonly POSITION: number; readonly NORMAL: number };
      readonly indices: number;
      readonly material: number;
      readonly mode: number;
    }[];
  }[];
  readonly materials: {
    readonly name: string;
    readonly pbrMetallicRoughness: {
      readonly baseColorFactor: readonly number[];
      readonly metallicFactor: number;
      readonly roughnessFactor: number;
    };
  }[];
  readonly accessors: {
    readonly bufferView: number;
    readonly byteOffset: number;
    readonly count: number;
    readonly componentType: number;
    readonly type: "SCALAR" | "VEC3";
    readonly min?: readonly number[];
    readonly max?: readonly number[];
  }[];
  readonly bufferViews: {
    readonly buffer: number;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly target: number;
  }[];
  readonly buffers: { readonly byteLength: number }[];
}

/**
 * Serializes `projection` to a deterministic glTF 2.0 GLB asset — one named
 * node per render object, float32 POSITION/NORMAL accessors (POSITION with
 * its spec-required min/max), indices sized uint16/uint32 by vertex count,
 * and the documented CadScene pbrMetallicRoughness material — packed into
 * the GLB container: a 12-byte header, the space-padded JSON chunk, then
 * the zero-padded BIN chunk. Same projection in, same bytes out, every
 * call.
 */
export function exportGlb(projection: RenderProjection): GlbExportResult {
  const objects = projection.objects;
  if (objects.length === 0) {
    return fail(
      glbError(
        GLB_EXPORT_ERROR_CODES.emptyProjection,
        "A projection with no render objects has no geometry to export.",
        objects,
      ),
    );
  }
  const prepared: PreparedObject[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i];
    if (object === undefined) {
      return fail(
        glbError(
          GLB_EXPORT_ERROR_CODES.malformedObject,
          `Render object ${i} is missing.`,
          object,
        ),
      );
    }
    const result = prepareObject(object, i);
    if (!result.ok) return fail(result.error);
    prepared.push(result.value);
  }

  // Plan the binary segments 4-byte aligned, in projection order: each
  // object contributes positions, then (when present) normals, then
  // indices — one buffer view each, targets 34962/34963.
  const alignedLength = (length: number): number => Math.ceil(length / 4) * 4;
  const segments: PlannedSegment[] = [];
  let cursor = 0;
  const planSegment = (
    byteLength: number,
    target: number,
    write: (view: DataView, byteOffset: number) => void,
  ): void => {
    const byteOffset = alignedLength(cursor);
    segments.push({
      bufferView: { buffer: 0, byteOffset, byteLength, target },
      write,
    });
    cursor = byteOffset + byteLength;
  };
  for (const object of prepared) {
    const positions = object.positions;
    planSegment(positions.length * 4, TARGET_ARRAY_BUFFER, (view, at) => {
      for (let i = 0; i < positions.length; i += 1) {
        view.setFloat32(at + i * 4, positions[i] ?? 0, true);
      }
    });
    const normals = object.normals;
    if (normals !== null) {
      planSegment(normals.length * 4, TARGET_ARRAY_BUFFER, (view, at) => {
        for (let i = 0; i < normals.length; i += 1) {
          view.setFloat32(at + i * 4, normals[i] ?? 0, true);
        }
      });
    }
    const indices = object.indices;
    const componentBytes =
      object.indexComponentType === COMPONENT_TYPE_UINT32 ? 4 : 2;
    planSegment(
      indices.length * componentBytes,
      TARGET_ELEMENT_ARRAY_BUFFER,
      (view, at) => {
        if (componentBytes === 4) {
          for (let i = 0; i < indices.length; i += 1) {
            view.setUint32(at + i * 4, indices[i] ?? 0, true);
          }
        } else {
          for (let i = 0; i < indices.length; i += 1) {
            view.setUint16(at + i * 2, indices[i] ?? 0, true);
          }
        }
      },
    );
  }
  const binContentLength = cursor;
  const binChunkLength = alignedLength(binContentLength);

  // Build the glTF JSON in the exporter's canonical fixed key order,
  // referencing the planned views in plan order.
  const accessors: GltfJson["accessors"][number][] = [];
  const bufferViews: GltfJson["bufferViews"][number][] = [];
  const nodes: GltfJson["nodes"] = [];
  const meshes: GltfJson["meshes"] = [];
  for (const object of prepared) {
    const positionView = bufferViews.length;
    const plannedPosition = segments[positionView]?.bufferView;
    if (plannedPosition === undefined) {
      return fail(
        glbError(
          GLB_EXPORT_ERROR_CODES.malformedObject,
          "Internal segment planning produced fewer buffer views than objects.",
          positionView,
        ),
      );
    }
    bufferViews.push(plannedPosition);
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      byteOffset: 0,
      count: object.positions.length / 3,
      componentType: COMPONENT_TYPE_FLOAT32,
      type: "VEC3",
      min: object.positionMin,
      max: object.positionMax,
    });
    let normalAccessor: number | null = null;
    if (object.normals !== null) {
      const normalView = bufferViews.length;
      const plannedNormal = segments[normalView]?.bufferView;
      if (plannedNormal === undefined) {
        return fail(
          glbError(
            GLB_EXPORT_ERROR_CODES.malformedObject,
            "Internal segment planning produced fewer buffer views than objects.",
            normalView,
          ),
        );
      }
      bufferViews.push(plannedNormal);
      normalAccessor = accessors.length;
      accessors.push({
        bufferView: normalView,
        byteOffset: 0,
        count: object.normals.length / 3,
        componentType: COMPONENT_TYPE_FLOAT32,
        type: "VEC3",
      });
    }
    const indexView = bufferViews.length;
    const plannedIndex = segments[indexView]?.bufferView;
    if (plannedIndex === undefined) {
      return fail(
        glbError(
          GLB_EXPORT_ERROR_CODES.malformedObject,
          "Internal segment planning produced fewer buffer views than objects.",
          indexView,
        ),
      );
    }
    bufferViews.push(plannedIndex);
    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: indexView,
      byteOffset: 0,
      count: object.indices.length,
      componentType: object.indexComponentType,
      type: "SCALAR",
    });
    const attributes:
      | { POSITION: number }
      | { POSITION: number; NORMAL: number } = normalAccessor === null
      ? { POSITION: positionAccessor }
      : { POSITION: positionAccessor, NORMAL: normalAccessor };
    meshes.push({
      primitives: [
        {
          attributes,
          indices: indexAccessor,
          material: 0,
          mode: 4,
        },
      ],
    });
    nodes.push({ name: object.name, mesh: meshes.length - 1 });
  }
  const gltf: GltfJson = {
    asset: { version: "2.0", generator: GLB_GENERATOR },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    nodes,
    meshes,
    materials: [
      {
        name: GLB_MATERIAL_NAME,
        pbrMetallicRoughness: {
          baseColorFactor: BASE_COLOR_LINEAR,
          metallicFactor: GLB_METALLIC_FACTOR,
          roughnessFactor: GLB_ROUGHNESS_FACTOR,
        },
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binContentLength }],
  };
  const jsonBytes = encoder.encode(JSON.stringify(gltf));
  const jsonChunkLength = alignedLength(jsonBytes.length);
  const totalLength =
    GLB_HEADER_BYTES +
    GLB_CHUNK_HEADER_BYTES +
    jsonChunkLength +
    GLB_CHUNK_HEADER_BYTES +
    binChunkLength;

  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);
  const jsonChunkStart = GLB_HEADER_BYTES;
  view.setUint32(jsonChunkStart, jsonChunkLength, true);
  view.setUint32(jsonChunkStart + 4, GLB_JSON_CHUNK_TYPE, true);
  bytes.set(jsonBytes, jsonChunkStart + GLB_CHUNK_HEADER_BYTES);
  // JSON chunk padding: trailing Space chars (0x20), a spec MUST. The
  // buffer is zero-initialized, so the fill below is the only padding write.
  bytes.fill(
    0x20,
    jsonChunkStart + GLB_CHUNK_HEADER_BYTES + jsonBytes.length,
    jsonChunkStart + GLB_CHUNK_HEADER_BYTES + jsonChunkLength,
  );
  const binChunkStart =
    jsonChunkStart + GLB_CHUNK_HEADER_BYTES + jsonChunkLength;
  view.setUint32(binChunkStart, binChunkLength, true);
  view.setUint32(binChunkStart + 4, GLB_BIN_CHUNK_TYPE, true);
  // BIN chunk padding: trailing zeros (0x00) — the allocation is already
  // zeroed, so only the segments' content needs writing.
  const binDataStart = binChunkStart + GLB_CHUNK_HEADER_BYTES;
  for (const segment of segments) {
    segment.write(view, binDataStart + segment.bufferView.byteOffset);
  }
  return ok(bytes);
}
