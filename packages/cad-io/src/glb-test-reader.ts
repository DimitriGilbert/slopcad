/**
 * A hand-rolled GLB reader for the test suite (Phase 19). Its independence
 * is the point — the same discipline as `./three-mf-test-reader`: it shares
 * no code with `./glb-export` (it does not import it, call it, or invert
 * it). It walks the GLB container itself (12-byte header, chunk sequence,
 * padding bytes), extracts the JSON chunk (platform `JSON.parse` on the
 * pad-stripped text — the honest tool for JSON, as regex extraction was for
 * the 3MF reader's XML), and decodes every mesh primitive's POSITION /
 * NORMAL / indices accessors straight out of the BIN chunk through
 * `DataView` reads, enforcing the spec rules our producer must satisfy:
 * chunk order and 4-byte alignment, Space-padded JSON and zero-padded BIN,
 * buffer-view/accessor offset alignment and bounds, the POSITION
 * accessor's required `min`/`max` (checked to equal the decoded data), and
 * the forbidden component-type-maximum index value.
 *
 * The reader is strict about the canonical shapes our exporter emits (one
 * primitive per mesh, TRIANGLES mode, one material) — deviations throw, so
 * semantic assertions built on this reader are evidence about the format
 * output, not about the exporter's internal bookkeeping.
 *
 * Test-only module: imported exclusively by this package's `*.test.ts`
 * files, never exported from the package index.
 */

import type { RenderBounds } from "@slopcad/cad-core";

/** One decoded mesh primitive: geometry plus the accessor metadata. */
export interface GlbReadPrimitive {
  /** Decoded POSITION values, one xyz triple per vertex. */
  readonly positions: readonly (readonly [number, number, number])[];
  /** Decoded NORMAL values, or `null` when the primitive carries none. */
  readonly normals: readonly (readonly [number, number, number])[] | null;
  /** Decoded index values (uint16 or uint32, per `indexComponentType`). */
  readonly indices: readonly number[];
  /** glTF componentType of the indices accessor (5123 or 5125). */
  readonly indexComponentType: number;
  /** The POSITION accessor's `min`, as written in the JSON. */
  readonly positionMin: readonly number[];
  /** The POSITION accessor's `max`, as written in the JSON. */
  readonly positionMax: readonly number[];
}

/** One decoded node: its name (when authored) and its primitive. */
export interface GlbReadNode {
  readonly name: string | null;
  readonly mesh: number;
  readonly primitive: GlbReadPrimitive;
}

/** A parsed GLB asset: container facts plus the decoded scene content. */
export interface GlbReadDocument {
  /** The `asset.version` string from the JSON chunk. */
  readonly assetVersion: string;
  /** The `asset.generator` string, or `null` when absent. */
  readonly generator: string | null;
  /** The JSON chunk's top-level keys, in the order the text carries them. */
  readonly topLevelKeys: readonly string[];
  /** All node names in node-array order (null for unnamed nodes). */
  readonly nodeNames: readonly (string | null)[];
  /** The decoded nodes, in scene order. */
  readonly nodes: readonly GlbReadNode[];
  /** The shared material's name. */
  readonly materialName: string;
  /** The `baseColorFactor` RGBA (linear) of the shared material. */
  readonly baseColorFactor: readonly number[];
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  /** The `buffers[0].byteLength` declared in the JSON. */
  readonly bufferByteLength: number;
  /** The BIN chunk bytes (chunk content, padding included). */
  readonly bin: Uint8Array;
}

function require(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Malformed GLB: ${message}`);
  }
}

/** Reads a little-endian uint32 at `offset` of `view`. */
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The glTF JSON document as the reader consumes it (parsed loose). */
interface GltfReadJson {
  readonly asset?: { readonly version?: unknown; readonly generator?: unknown };
  readonly scene?: unknown;
  readonly scenes?: unknown;
  readonly nodes?: unknown;
  readonly meshes?: unknown;
  readonly materials?: unknown;
  readonly accessors?: unknown;
  readonly bufferViews?: unknown;
  readonly buffers?: unknown;
  readonly [key: string]: unknown;
}

/** Slices `bytes` as a Uint8Array view (no copy) between the offsets. */
function slice(bytes: Uint8Array, start: number, end: number): Uint8Array {
  return bytes.subarray(start, end);
}

/**
 * Walks the GLB container: validates the 12-byte header, then the chunk
 * sequence — the JSON chunk first (Space-padded), the BIN chunk second
 * (zero-padded), each chunk 4-byte aligned, each within the buffer, and
 * nothing after the chunks the file length cannot account for. Returns the
 * JSON text (padding stripped) and the BIN chunk content.
 */
function readContainer(bytes: Uint8Array): {
  readonly jsonText: string;
  readonly bin: Uint8Array | null;
} {
  require(bytes.length >=
    12 + 8, `expected at least 20 bytes, got ${bytes.length}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  require(u32(view, 0) ===
    0x4654_6c67, `magic is 0x${u32(view, 0).toString(16)}, not 0x46546c67 (ASCII "glTF").`);
  require(u32(view, 4) === 2, `container version ${u32(view, 4)} is not 2.`);
  require(u32(view, 8) ===
    bytes.length, `header length ${u32(view, 8)} does not equal the byte length ${bytes.length}.`);
  let cursor = 12;
  let jsonText: string | null = null;
  let jsonChunkEnd = -1;
  let bin: Uint8Array | null = null;
  while (cursor < bytes.length) {
    require(cursor + 8 <=
      bytes.length, `chunk preamble at ${cursor} runs past the buffer.`);
    const chunkLength = u32(view, cursor);
    const chunkType = u32(view, cursor + 4);
    const dataStart = cursor + 8;
    require(chunkLength % 4 ===
      0, `chunk at ${cursor} has length ${chunkLength}, not a multiple of four.`);
    require(dataStart + chunkLength <=
      bytes.length, `chunk at ${cursor} (length ${chunkLength}) runs past the buffer.`);
    if (chunkType === 0x4e4f_534a) {
      require(jsonText === null, "more than one JSON chunk.");
      require(cursor === 12, "the JSON chunk is not the very first chunk.");
      const data = slice(bytes, dataStart, dataStart + chunkLength);
      // Padding: trailing Space chars (0x20) — walk them off the end; what
      // remains must be non-empty and must not end in a Space.
      let end = data.length;
      while (end > 0 && (data[end - 1] ?? 0) === 0x20) end -= 1;
      require(end > 0, "the JSON chunk is entirely Space padding.");
      jsonText = decoder.decode(slice(data, 0, end));
      jsonChunkEnd = dataStart + chunkLength;
    } else if (chunkType === 0x004e_4942) {
      require(bin === null, "more than one BIN chunk.");
      require(jsonText !==
        null, "the BIN chunk appears before the JSON chunk.");
      require(cursor ===
        jsonChunkEnd, "the BIN chunk does not directly follow the (padded) JSON chunk.");
      bin = slice(bytes, dataStart, dataStart + chunkLength);
    } else {
      throw new Error(
        `Malformed GLB: unknown chunk type 0x${chunkType.toString(16)}.`,
      );
    }
    cursor = dataStart + chunkLength;
  }
  require(jsonText !== null, "no JSON chunk.");
  require(cursor ===
    bytes.length, `chunks end at ${cursor} but the file is ${bytes.length} bytes.`);
  return { jsonText, bin };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function numberOf(value: unknown, where: string): number {
  require(typeof value === "number" &&
    Number.isFinite(
      value,
    ), `${where} is not a finite number (got ${String(value)}).`);
  return value;
}

function arrayOf(value: unknown, where: string): unknown[] {
  require(isArray(value), `${where} is not an array.`);
  return value;
}

/** glTF componentType for float32. */
const TYPE_FLOAT32 = 5126;
/** glTF componentType for uint16. */
const TYPE_UINT16 = 5123;
/** glTF componentType for uint32. */
const TYPE_UINT32 = 5125;

/** Byte size of the component types this reader decodes. */
function componentSize(componentType: number): number {
  switch (componentType) {
    case TYPE_FLOAT32:
    case TYPE_UINT32:
      return 4;
    case TYPE_UINT16:
      return 2;
    default:
      throw new Error(
        `Malformed GLB: unsupported componentType ${componentType}.`,
      );
  }
}

/** The component-type maximum whose use as an index value the spec forbids. */
function componentMax(componentType: number): number {
  switch (componentType) {
    case TYPE_UINT16:
      return 65_535;
    case TYPE_UINT32:
      return 4_294_967_295;
    default:
      throw new Error(
        `Malformed GLB: unsupported index componentType ${componentType}.`,
      );
  }
}

interface AccessorRecord {
  readonly bufferView: number;
  readonly byteOffset: number;
  readonly count: number;
  readonly componentType: number;
  readonly type: string;
  readonly min: readonly number[] | null;
  readonly max: readonly number[] | null;
}

function readAccessorRecord(input: unknown, where: string): AccessorRecord {
  require(isRecord(input), `${where} is not an object.`);
  const bufferView = numberOf(input.bufferView, `${where}.bufferView`);
  const byteOffset =
    input.byteOffset === undefined
      ? 0
      : numberOf(input.byteOffset, `${where}.byteOffset`);
  const count = numberOf(input.count, `${where}.count`);
  const componentType = numberOf(input.componentType, `${where}.componentType`);
  require(typeof input.type === "string", `${where}.type is not a string.`);
  const readTriple = (value: unknown): readonly number[] | null => {
    if (value === undefined) return null;
    return arrayOf(value, `${where} min/max`).map((component) =>
      numberOf(component, `${where} min/max component`),
    );
  };
  return {
    bufferView,
    byteOffset,
    count,
    componentType,
    type: input.type,
    min: readTriple(input.min),
    max: readTriple(input.max),
  };
}

interface BufferViewRecord {
  readonly byteOffset: number;
  readonly byteLength: number;
}

function readBufferViewRecord(input: unknown, where: string): BufferViewRecord {
  require(isRecord(input), `${where} is not an object.`);
  require(input.byteStride ===
    undefined, `${where} carries a byteStride; this reader decodes our producer's tightly-packed views.`);
  return {
    byteOffset: numberOf(input.byteOffset, `${where}.byteOffset`),
    byteLength: numberOf(input.byteLength, `${where}.byteLength`),
  };
}

/**
 * Decodes one accessor out of the BIN chunk, enforcing the spec's access
 * math: the buffer view and the accessor's byte offset are aligned to the
 * component size, the buffer view is large enough for every element, and
 * the whole span lies inside the declared buffer byte length.
 */
function decodeAccessor(
  accessor: AccessorRecord,
  bufferViews: readonly BufferViewRecord[],
  bin: Uint8Array,
  bufferByteLength: number,
  where: string,
): number[] {
  const view = bufferViews[accessor.bufferView];
  require(view !== undefined, `${where} references a missing bufferView.`);
  const size = componentSize(accessor.componentType);
  require(view.byteOffset % size ===
    0, `${where}'s bufferView byteOffset ${view.byteOffset} is not a multiple of the component size ${size}.`);
  require(accessor.byteOffset % size ===
    0, `${where}'s byteOffset ${accessor.byteOffset} is not a multiple of the component size ${size}.`);
  const elementSize = size * (accessor.type === "VEC3" ? 3 : 1);
  require(accessor.byteOffset + accessor.count * elementSize <=
    view.byteLength, `${where} needs ${accessor.byteOffset + accessor.count * elementSize} bytes inside its bufferView of ${view.byteLength}.`);
  require(view.byteOffset + view.byteLength <=
    bufferByteLength, `${where}'s bufferView spans past the declared buffer byte length.`);
  require(view.byteOffset +
    accessor.byteOffset +
    accessor.count * elementSize <=
    bin.length, `${where}'s data runs past the BIN chunk.`);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const base = view.byteOffset + accessor.byteOffset;
  const values: number[] = [];
  const stride = accessor.type === "VEC3" ? 3 : 1;
  for (let i = 0; i < accessor.count * stride; i += 1) {
    const at = base + i * size;
    if (accessor.componentType === TYPE_FLOAT32) {
      values.push(dv.getFloat32(at, true));
    } else if (accessor.componentType === TYPE_UINT32) {
      values.push(dv.getUint32(at, true));
    } else {
      values.push(dv.getUint16(at, true));
    }
  }
  return values;
}

function readPrimitive(
  primitiveInput: unknown,
  accessorsInput: unknown[],
  bufferViews: readonly BufferViewRecord[],
  bin: Uint8Array,
  bufferByteLength: number,
): GlbReadPrimitive {
  require(isRecord(primitiveInput), "a mesh primitive is not an object.");
  require(numberOf(primitiveInput.mode, "primitive.mode") ===
    4, "primitive.mode is not 4 (TRIANGLES); this reader decodes our producer's indexed triangles.");
  require(numberOf(primitiveInput.material, "primitive.material") ===
    0, "primitive.material is not 0; this reader decodes our producer's single shared material.");
  const attributes = primitiveInput.attributes;
  require(isRecord(attributes), "primitive.attributes is not an object.");
  const positionAccessorIndex = numberOf(
    attributes.POSITION,
    "attributes.POSITION",
  );
  const positionAccessor = readAccessorRecord(
    accessorsInput[positionAccessorIndex],
    `accessor ${positionAccessorIndex} (POSITION)`,
  );
  require(positionAccessor.type === "VEC3" &&
    positionAccessor.componentType ===
      TYPE_FLOAT32, "the POSITION accessor is not VEC3 float32.");
  require(positionAccessor.min !== null &&
    positionAccessor.max !==
      null, "the POSITION accessor carries no min/max (a spec MUST).");
  const positionValues = decodeAccessor(
    positionAccessor,
    bufferViews,
    bin,
    bufferByteLength,
    "the POSITION accessor",
  );
  const positions: (readonly [number, number, number])[] = [];
  for (let v = 0; v < positionValues.length; v += 3) {
    positions.push([
      positionValues[v] ?? 0,
      positionValues[v + 1] ?? 0,
      positionValues[v + 2] ?? 0,
    ]);
  }
  // The spec requires min/max to describe the accessor's data: verify them
  // against the decoded values, exactly (f32 values parse to equal f64s).
  const computedMin: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const computedMax: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const [x, y, z] of positions) {
    if (x < computedMin[0]) computedMin[0] = x;
    if (y < computedMin[1]) computedMin[1] = y;
    if (z < computedMin[2]) computedMin[2] = z;
    if (x > computedMax[0]) computedMax[0] = x;
    if (y > computedMax[1]) computedMax[1] = y;
    if (z > computedMax[2]) computedMax[2] = z;
  }
  for (const axis of [0, 1, 2]) {
    require((positionAccessor.min ?? [])[axis] ===
      computedMin[
        axis
      ], `POSITION accessor min[${String(axis)}] is ${String((positionAccessor.min ?? [])[axis])}, but the decoded data's min is ${computedMin[axis]}.`);
    require((positionAccessor.max ?? [])[axis] ===
      computedMax[
        axis
      ], `POSITION accessor max[${String(axis)}] is ${String((positionAccessor.max ?? [])[axis])}, but the decoded data's max is ${computedMax[axis]}.`);
  }

  let normals: readonly (readonly [number, number, number])[] | null = null;
  if (attributes.NORMAL !== undefined) {
    const normalAccessorIndex = numberOf(
      attributes.NORMAL,
      "attributes.NORMAL",
    );
    const normalAccessor = readAccessorRecord(
      accessorsInput[normalAccessorIndex],
      `accessor ${normalAccessorIndex} (NORMAL)`,
    );
    require(normalAccessor.type === "VEC3" &&
      normalAccessor.componentType ===
        TYPE_FLOAT32, "the NORMAL accessor is not VEC3 float32.");
    require(normalAccessor.count ===
      positionAccessor.count, "the NORMAL accessor's count does not match POSITION's (a spec MUST).");
    const normalValues = decodeAccessor(
      normalAccessor,
      bufferViews,
      bin,
      bufferByteLength,
      "the NORMAL accessor",
    );
    const decoded: (readonly [number, number, number])[] = [];
    for (let v = 0; v < normalValues.length; v += 3) {
      decoded.push([
        normalValues[v] ?? 0,
        normalValues[v + 1] ?? 0,
        normalValues[v + 2] ?? 0,
      ]);
    }
    normals = decoded;
  }

  const indexAccessorIndex = numberOf(
    primitiveInput.indices,
    "primitive.indices",
  );
  const indexAccessor = readAccessorRecord(
    accessorsInput[indexAccessorIndex],
    `accessor ${indexAccessorIndex} (indices)`,
  );
  require(indexAccessor.type ===
    "SCALAR", "the indices accessor is not SCALAR.");
  require(indexAccessor.componentType === TYPE_UINT16 ||
    indexAccessor.componentType ===
      TYPE_UINT32, "the indices accessor is not uint16 or uint32.");
  require(indexAccessor.count % 3 === 0 &&
    indexAccessor.count >
      0, "the index count is not a non-zero multiple of three (triangles topology).");
  const indices = decodeAccessor(
    indexAccessor,
    bufferViews,
    bin,
    bufferByteLength,
    "the indices accessor",
  );
  const forbidden = componentMax(indexAccessor.componentType);
  for (let i = 0; i < indices.length; i += 1) {
    const value = indices[i] ?? -1;
    require(value >= 0 &&
      value <
        positionAccessor.count, `index ${i} is ${value}, outside the vertex range 0..${positionAccessor.count - 1}.`);
    require(value !==
      forbidden, `index ${i} equals ${forbidden}, the component-type maximum the spec forbids (primitive restart).`);
  }
  return {
    positions,
    normals,
    indices,
    indexComponentType: indexAccessor.componentType,
    positionMin: positionAccessor.min ?? [],
    positionMax: positionAccessor.max ?? [],
  };
}

/**
 * Parses `bytes` as a GLB asset, throwing on any structural violation:
 * header or chunk framing defects, wrong padding bytes, misaligned or
 * out-of-bounds buffer views/accessors, a POSITION accessor without
 * min/max (or whose min/max disagree with the decoded data), indices out
 * of vertex range or at the forbidden component-type maximum, and
 * non-conformant JSON shapes.
 */
export function readGlb(bytes: Uint8Array): GlbReadDocument {
  const { jsonText, bin } = readContainer(bytes);
  let json: GltfReadJson;
  try {
    json = JSON.parse(jsonText) as GltfReadJson;
  } catch (error) {
    throw new Error(
      `Malformed GLB: the JSON chunk does not parse (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const asset = json.asset;
  require(isRecord(asset), "asset is not an object.");
  require(typeof asset.version ===
    "string", `asset.version is ${String(asset.version)}, not a string.`);
  require(asset.version ===
    "2.0", `asset.version is ${asset.version}, not "2.0".`);
  require(asset.generator === undefined ||
    typeof asset.generator ===
      "string", "asset.generator is present but not a string.");
  const bufferViews = arrayOf(json.bufferViews, "bufferViews").map((entry, i) =>
    readBufferViewRecord(entry, `bufferViews[${String(i)}]`),
  );
  const accessorsInput = arrayOf(json.accessors, "accessors");
  const buffers = arrayOf(json.buffers, "buffers");
  require(buffers.length ===
    1, `expected exactly one buffer, got ${buffers.length}.`);
  const firstBuffer = buffers[0];
  require(isRecord(firstBuffer), "buffers[0] is not an object.");
  const bufferByteLength = numberOf(
    firstBuffer.byteLength,
    "buffers[0].byteLength",
  );
  require(bin !==
    null, "no BIN chunk: this reader decodes our producer's GLB-stored buffer.");
  require(bufferByteLength <= bin.length &&
    bin.length - bufferByteLength <=
      3, `the BIN chunk holds ${bin.length} bytes but the buffer declares ${bufferByteLength} (padding must be 0-3 bytes).`);
  for (let i = bufferByteLength; i < bin.length; i += 1) {
    require((bin[i] ?? 1) ===
      0, `BIN chunk padding byte ${i - bufferByteLength} is not zero.`);
  }
  require(numberOf(json.scene, "scene") ===
    0, "scene is not 0; this reader decodes our producer's single scene.");
  const scenes = arrayOf(json.scenes, "scenes");
  require(scenes.length ===
    1, `expected exactly one scene, got ${scenes.length}.`);
  const firstScene = scenes[0];
  require(isRecord(firstScene), "scenes[0] is not an object.");
  const sceneNodes = arrayOf(firstScene.nodes, "scenes[0].nodes");
  const nodesInput = arrayOf(json.nodes, "nodes");
  const meshesInput = arrayOf(json.meshes, "meshes");
  const materials = arrayOf(json.materials, "materials");
  require(materials.length ===
    1, `expected exactly one material, got ${materials.length}.`);
  const material = materials[0];
  require(isRecord(material), "materials[0] is not an object.");
  require(typeof material.name ===
    "string", "materials[0].name is not a string.");
  const pbr = material.pbrMetallicRoughness;
  require(isRecord(pbr), "materials[0].pbrMetallicRoughness is not an object.");
  const baseColorFactor = arrayOf(
    pbr.baseColorFactor,
    "pbrMetallicRoughness.baseColorFactor",
  ).map((component) => numberOf(component, "baseColorFactor component"));
  require(baseColorFactor.length ===
    4, `baseColorFactor has ${baseColorFactor.length} components, not 4.`);

  const nodes: GlbReadNode[] = [];
  const nodeNames: (string | null)[] = [];
  for (const nodeIndex of sceneNodes) {
    const index = numberOf(nodeIndex, "scene node index");
    const node = nodesInput[index];
    require(node !== undefined, `scene references missing node ${index}.`);
    require(isRecord(node), `node ${index} is not an object.`);
    require(node.name === undefined ||
      typeof node.name ===
        "string", `node ${index} name is present but not a string.`);
    const name = node.name === undefined ? null : node.name;
    const meshIndex = numberOf(node.mesh, `node ${index}.mesh`);
    const mesh = meshesInput[meshIndex];
    require(mesh !==
      undefined, `node ${index} references missing mesh ${meshIndex}.`);
    require(isRecord(mesh), `mesh ${meshIndex} is not an object.`);
    const primitives = arrayOf(mesh.primitives, `mesh ${meshIndex}.primitives`);
    require(primitives.length ===
      1, `mesh ${meshIndex} carries ${primitives.length} primitives; this reader decodes our producer's one-primitive meshes.`);
    const primitive = readPrimitive(
      primitives[0],
      accessorsInput,
      bufferViews,
      bin,
      bufferByteLength,
    );
    nodeNames.push(name);
    nodes.push({ name, mesh: meshIndex, primitive });
  }
  require(nodeNames.length ===
    nodesInput.length, "the scene does not reference every node.");
  return {
    assetVersion: asset.version,
    topLevelKeys: Object.keys(json),
    generator: asset.generator === undefined ? null : asset.generator,
    nodeNames,
    nodes,
    materialName: material.name,
    baseColorFactor,
    metallicFactor: numberOf(
      pbr.metallicFactor,
      "pbrMetallicRoughness.metallicFactor",
    ),
    roughnessFactor: numberOf(
      pbr.roughnessFactor,
      "pbrMetallicRoughness.roughnessFactor",
    ),
    bufferByteLength,
    bin,
  };
}

/**
 * The enclosed volume of one decoded primitive, in cubic millimetres, by
 * the divergence theorem: one sixth of the summed signed tetrahedron
 * volumes over the index triples, absolute value at the end (outward
 * winding makes the sum negative; the magnitude IS the volume). The values
 * are float32 — quantization noise is far below any semantic tolerance.
 */
export function glbVolumeMm3(primitive: GlbReadPrimitive): number {
  const { positions, indices } = primitive;
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = positions[indices[t] ?? 0];
    const b = positions[indices[t + 1] ?? 0];
    const c = positions[indices[t + 2] ?? 0];
    require(a !== undefined &&
      b !== undefined &&
      c !==
        undefined, "a triangle references a vertex outside the position array.");
    total +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) +
      a[1] * (b[2] * c[0] - b[0] * c[2]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return Math.abs(total / 6);
}

/** The axis-aligned bounds of one decoded primitive's positions. */
export function glbBounds(primitive: GlbReadPrimitive): RenderBounds {
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
  for (const [x, y, z] of primitive.positions) {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max };
}
