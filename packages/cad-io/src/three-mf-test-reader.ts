/**
 * A hand-rolled 3MF/OPC reader for the test suite (Phase 18.3). Its
 * independence is the point: it shares no code with `./three-mf-export` (it
 * does not import it, call it, or invert it) — not even the CRC-32, which is
 * reimplemented here as table-less bitwise long division so the writer's
 * checksums are confirmed by a second implementation agreeing. It parses the
 * raw published container shape itself: the ZIP end-of-central-directory
 * record, central directory, and local file headers (stored entries only —
 * our own output), then the three OPC parts (`[Content_Types].xml`,
 * `_rels/.rels`, `3D/3dmodel.model`) decoded as strict UTF-8 and picked
 * apart with small extraction patterns. Node has no DOMParser, so the XML
 * extraction is pattern-based and strict about the canonical element shapes
 * a conformant producer emits. Semantic assertions built on this reader are
 * therefore evidence about the format output, not about the exporter's
 * internal bookkeeping.
 *
 * Test-only module: imported exclusively by this package's `*.test.ts`
 * files, never exported from the package index.
 */

/** One parsed OPC relationship. */
export interface ThreeMfReadRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
}

/** The 3D Model part reconstructed as plain data. */
export interface ThreeMfReadModel {
  /** The `<model unit>` attribute. */
  readonly unit: string;
  /** The default namespace declared on `<model>`. */
  readonly namespace: string;
  /** Well-known metadata by `<metadata name>`. */
  readonly metadata: ReadonlyMap<string, string>;
  /** Vertices in declaration (implicit index) order. */
  readonly vertices: readonly (readonly [number, number, number])[];
  /** Triangles as vertex index triples in declaration order. */
  readonly triangles: readonly (readonly [number, number, number])[];
  /** The id of the single `<object>` resource. */
  readonly objectId: number;
  /** The objectids of the `<build>`'s `<item>`s, in order. */
  readonly buildObjectIds: readonly number[];
}

/** A parsed 3MF document: the package parts plus the interpreted pieces. */
export interface ThreeMfReadDocument {
  /** Every ZIP entry by part name. */
  readonly parts: ReadonlyMap<string, Uint8Array>;
  /** `<Default Extension, ContentType>` pairs of the content-types stream. */
  readonly contentTypes: ReadonlyMap<string, string>;
  readonly relationships: readonly ThreeMfReadRelationship[];
  readonly model: ThreeMfReadModel;
}

function require(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Malformed 3MF: ${message}`);
  }
}

/**
 * CRC-32 (PKWARE ZIP polynomial 0xEDB88320), reimplemented independently of
 * the writer's table-driven version: per-byte bitwise long division. Two
 * implementations agreeing is itself evidence.
 */
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

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Unescapes the five predefined XML entities a conformant escaper emits. */
function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Extracts the sole inner text of `<tag>…</tag>` from `xml`, throwing when
 * the tag is absent or appears more than once.
 */
function soleElementText(xml: string, tag: string, where: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const first = xml.indexOf(open);
  require(first !== -1, `${where}: no <${tag}> element.`);
  const last = xml.lastIndexOf(open);
  require(first === last, `${where}: more than one <${tag}> element.`);
  const end = xml.indexOf(close, first);
  require(end !== -1, `${where}: <${tag}> is never closed.`);
  return xml.slice(first + open.length, end);
}

/** Reads a little-endian uint16 at `offset` of `view`. */
function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

/** Reads a little-endian uint32 at `offset` of `view`. */
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** The string value of attribute `name` on `tagText`, or `undefined`. */
function attributeOf(tagText: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tagText);
  return match === null ? undefined : (match[1] ?? "");
}

/**
 * Parses the ZIP container: exactly one end-of-central-directory record at
 * the very end (no comment), a central directory that ends exactly where
 * the EOCD says, and — per this reader's stored-only contract — method-0
 * entries whose local headers agree with their central records, whose sizes
 * match the buffer, and whose CRC-32 checks out against this file's own
 * implementation.
 */
function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  require(bytes.length >=
    22, `expected at least 22 bytes, got ${bytes.length}.`);
  const eocdOffset = bytes.length - 22;
  require(u32(view, eocdOffset) ===
    0x06054b50, "no end-of-central-directory signature at the end of the buffer.");
  const commentLength = u16(view, eocdOffset + 20);
  require(commentLength === 0, "unexpected ZIP comment after the EOCD.");
  const entryCount = u16(view, eocdOffset + 10);
  const centralSize = u32(view, eocdOffset + 12);
  const centralOffset = u32(view, eocdOffset + 16);
  require(centralOffset + centralSize ===
    eocdOffset, `central directory [${centralOffset}, ${centralOffset + centralSize}) does not end exactly at the EOCD offset ${eocdOffset}.`);
  const entries = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    require(cursor + 46 <= eocdOffset &&
      u32(view, cursor) ===
        0x02014b50, `central directory entry ${i} has no header signature.`);
    const method = u16(view, cursor + 10);
    require(method ===
      0, `entry ${i} uses compression method ${method}; this reader only accepts stored (method 0) entries — the shape our exporter emits.`);
    const crc = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    require(compressedSize ===
      uncompressedSize, `entry ${i} has compressed size ${compressedSize} ≠ uncompressed ${uncompressedSize}.`);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const fileCommentLength = u16(view, cursor + 32);
    require(extraLength === 0 &&
      fileCommentLength === 0, `entry ${i} carries extra fields or a comment.`);
    const localOffset = u32(view, cursor + 42);
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    cursor += 46 + nameLength;
    require(localOffset + 30 <= bytes.length &&
      u32(view, localOffset) ===
        0x04034b50, `entry ${name}: no local file header signature at offset ${localOffset}.`);
    const localMethod = u16(view, localOffset + 8);
    require(localMethod ===
      0, `entry ${name}: local header claims method ${localMethod}.`);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    require(localExtraLength ===
      0, `entry ${name}: local extra field present.`);
    const localName = decoder.decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    require(localName ===
      name, `entry ${name}: local header names ${localName} instead.`);
    const dataStart = localOffset + 30 + localNameLength;
    const dataEnd = dataStart + uncompressedSize;
    require(dataEnd <=
      bytes.length, `entry ${name}: data [${dataStart}, ${dataEnd}) runs past the buffer.`);
    const data = bytes.subarray(dataStart, dataEnd);
    require(crc32Of(data) ===
      crc, `entry ${name}: CRC-32 mismatch (header ${crc.toString(16)}, computed ${crc32Of(data).toString(16)}).`);
    require(!entries.has(name), `duplicate entry name ${name}.`);
    entries.set(name, data);
  }
  require(cursor ===
    centralOffset +
      centralSize, "central directory size disagrees with the entries walked.");
  return entries;
}

/** Parses `[Content_Types].xml` into its Default extension→type pairs. */
function readContentTypes(xml: string): Map<string, string> {
  require(xml.includes(
    'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"',
  ), "content-types stream is not in the OPC content-types namespace.");
  const defaults = new Map<string, string>();
  for (const match of xml.matchAll(
    /<Default Extension="([^"]+)" ContentType="([^"]+)"\/>/g,
  )) {
    const extension = match[1] ?? "";
    const contentType = match[2] ?? "";
    require(!defaults.has(
      extension,
    ), `duplicate <Default Extension="${extension}">.`);
    defaults.set(extension, contentType);
  }
  return defaults;
}

/** Parses `_rels/.rels` into its Relationship records. */
function readRelationships(xml: string): ThreeMfReadRelationship[] {
  require(xml.includes(
    'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"',
  ), "relationships part is not in the OPC relationships namespace.");
  const relationships: ThreeMfReadRelationship[] = [];
  for (const match of xml.matchAll(
    /<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)"\/>/g,
  )) {
    relationships.push({
      id: match[1] ?? "",
      type: match[2] ?? "",
      target: match[3] ?? "",
    });
  }
  return relationships;
}

/** Parses the 3D Model part into plain data. */
function readModel(xml: string): ThreeMfReadModel {
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  require(xml.startsWith(
    declaration,
  ), "model part does not declare UTF-8 XML.");
  const remainder = xml.slice(declaration.length);
  const openMatch = /<model\s+([^>]*)>/.exec(remainder);
  require(openMatch !==
    null, "model part does not open with a <model> element.");
  const attributes = openMatch[1] ?? "";
  const unit = attributeOf(attributes, "unit");
  require(unit !== undefined, "<model> carries no unit attribute.");
  const namespace = attributeOf(attributes, "xmlns");
  require(namespace !== undefined, "<model> declares no default namespace.");

  const metadata = new Map<string, string>();
  const body = remainder.slice(openMatch.index + openMatch[0].length);
  const resourcesStart = body.indexOf("<resources>");
  require(resourcesStart !== -1, "no <resources> element.");
  for (const match of body
    .slice(0, resourcesStart)
    .matchAll(/<metadata name="([^"]+)">([^<]*)<\/metadata>/g)) {
    const name = match[1] ?? "";
    require(!metadata.has(name), `duplicate <metadata name="${name}">.`);
    metadata.set(name, unescapeXml(match[2] ?? ""));
  }

  const objectMatch = /<object\s+([^>]*)>/.exec(body);
  require(objectMatch !== null, "no <object> resource.");
  const objectId = Number(attributeOf(objectMatch[1] ?? "", "id"));
  require(Number.isInteger(objectId) &&
    objectId >= 1, `<object> id ${objectId} is not a positive integer.`);

  const verticesText = soleElementText(body, "vertices", "model");
  const trianglesText = soleElementText(body, "triangles", "model");
  const vertexPattern = /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g;
  const vertices: (readonly [number, number, number])[] = [];
  for (const match of verticesText.matchAll(vertexPattern)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    require(Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(
        z,
      ), `vertex ${vertices.length} has a non-finite coordinate.`);
    vertices.push([x, y, z]);
  }
  const vertexOccurrences = verticesText.split("<vertex").length - 1;
  require(vertexOccurrences ===
    vertices.length, `parsed ${vertices.length} <vertex> elements but the text holds ${vertexOccurrences}.`);
  const trianglePattern =
    /<triangle v1="([^"]+)" v2="([^"]+)" v3="([^"]+)"\/>/g;
  const triangles: (readonly [number, number, number])[] = [];
  for (const match of trianglesText.matchAll(trianglePattern)) {
    const v1 = Number(match[1]);
    const v2 = Number(match[2]);
    const v3 = Number(match[3]);
    require(Number.isInteger(v1) &&
      Number.isInteger(v2) &&
      Number.isInteger(
        v3,
      ), `triangle ${triangles.length} has a non-integer vertex index.`);
    triangles.push([v1, v2, v3]);
  }
  const triangleOccurrences = trianglesText.split("<triangle").length - 1;
  require(triangleOccurrences ===
    triangles.length, `parsed ${triangles.length} <triangle> elements but the text holds ${triangleOccurrences}.`);

  const buildText = soleElementText(body, "build", "model");
  const buildObjectIds: number[] = [];
  for (const match of buildText.matchAll(/<item\s+([^>]*)\/>/g)) {
    const objectid = Number(attributeOf(match[1] ?? "", "objectid"));
    require(Number.isInteger(objectid) &&
      objectid >= 1, `<item> objectid ${objectid} is not a positive integer.`);
    buildObjectIds.push(objectid);
  }
  require(buildObjectIds.length >= 1, "<build> holds no <item>.");

  return {
    unit,
    namespace,
    metadata,
    vertices,
    triangles,
    objectId,
    buildObjectIds,
  };
}

/**
 * Parses `bytes` as a 3MF document, throwing on any structural violation:
 * ZIP framing defects, compressed entries, CRC mismatches, missing or
 * duplicated canonical parts, invalid UTF-8, and non-conformant XML shapes.
 */
export function readThreeMfPackage(bytes: Uint8Array): ThreeMfReadDocument {
  const parts = readZipEntries(bytes);
  const contentTypesData = parts.get("[Content_Types].xml");
  require(contentTypesData !== undefined, "no [Content_Types].xml part.");
  const relsData = parts.get("_rels/.rels");
  require(relsData !== undefined, "no _rels/.rels part.");
  const modelData = parts.get("3D/3dmodel.model");
  require(modelData !== undefined, "no 3D/3dmodel.model part.");
  return {
    parts,
    contentTypes: readContentTypes(decoder.decode(contentTypesData)),
    relationships: readRelationships(decoder.decode(relsData)),
    model: readModel(decoder.decode(modelData)),
  };
}

/**
 * The enclosed volume of the reconstructed mesh by the divergence theorem:
 * the signed sum `(1/6) Σ (a × b) · c` over the index triples, exact for the
 * parsed decimal vertices. Outward-oriented (right-hand-rule) windings —
 * 3MF's counter-clockwise convention — yield positive volume.
 */
export function threeMfVolumeMm3(document: ThreeMfReadDocument): number {
  const { vertices, triangles } = document.model;
  let volume = 0;
  for (const [i0, i1, i2] of triangles) {
    const a = vertices[i0];
    const b = vertices[i1];
    const c = vertices[i2];
    require(a !== undefined &&
      b !== undefined &&
      c !==
        undefined, "a triangle references a vertex outside the vertex array.");
    volume +=
      ((a[1] * b[2] - a[2] * b[1]) * c[0] +
        (a[2] * b[0] - a[0] * b[2]) * c[1] +
        (a[0] * b[1] - a[1] * b[0]) * c[2]) /
      6;
  }
  return volume;
}

/** The axis-aligned bounding box of the reconstructed mesh's vertices. */
export function threeMfBounds(document: ThreeMfReadDocument): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const [x, y, z] of document.model.vertices) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
