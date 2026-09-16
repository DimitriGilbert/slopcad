/**
 * 3MF export (Phase 18.3): serializes the kernel contract's
 * {@link Tessellation} — the kernel-neutral indexed triangle soup in canonical
 * millimetres — into a 3MF document, the OPC-packaged XML mesh interchange
 * format, as a {@link Uint8Array} ready for download or disk.
 *
 * ## Spec conformance (3MF Core Specification, 3MF Consortium)
 *
 * - **Container** — a 3MF document is an OPC package in a ZIP archive
 *   (§1.1). Entries "MUST use the compression method Deflate … or be stored
 *   uncompressed ('0 - The file is stored (no compression)')" — this exporter
 *   always writes **stored** entries, which OPC (Annex C) sanctions and which
 *   removes deflate output as a source of byte variance. The package carries
 *   exactly the three parts a minimal conformant 3MF document needs:
 *   `[Content_Types].xml` (the OPC content-types stream), `_rels/.rels` (the
 *   package relationships with the 3MF Document StartPart relationship of
 *   type `http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel`
 *   targeting `/3D/3dmodel.model`, exactly as the spec's own §2.1.5 example
 *   shows), and the 3D Model part `3D/3dmodel.model` with content type
 *   `application/vnd.ms-package.3dmanufacturing-3dmodel+xml` (Appendix C.1).
 * - **Markup** — the model part is UTF-8 XML with the core namespace
 *   `http://schemas.microsoft.com/3dmanufacturing/core/2015/02` (Appendix
 *   C.3), no DTD, no `xml:space` (§2.3.4), and decimal values in the en-US
 *   sense — a `.` radix (§2.3.2 rule 5).
 * - **Units** — unlike unitless STL, 3MF declares units: the `<model unit>`
 *   attribute (ST_Unit: micron/millimeter/centimeter/inch/foot/meter,
 *   default millimeter) says how to interpret every coordinate. The exporter
 *   always writes `unit="millimeter"` explicitly — the kernel contract's
 *   canonical millimetres pass through unscaled, and receivers never have to
 *   lean on the spec default.
 * - **Geometry** — one `<object id="1" type="model">` resource holding a
 *   single `<mesh>` of `<vertices>` (implicit 0-based order) and
 *   `<triangles>` referencing them as `v1/v2/v3`, built by one `<item
 *   objectid="1"/>` under `<build>`. Vertex coordinates are **ST_Number —
 *   lexical space unbounded-precision decimal text, value space the XML
 *   Schema `xs:double` set — not a fixed-width binary float
 *   serialization** — so each f64 is written as its shortest round-tripping
 *   decimal
 *   (`Number.prototype.toString`, always `.`-radix; its output shapes —
 *   plain decimal or `e±n` exponent — both satisfy the ST_Number pattern).
 *   That decimal reparse is numerically identical to the source f64 (bit-
 *   identical for every finite value except the sign of −0, which prints as
 *   plain `0`): 3MF export is *lossless*, with no float32 boundary and
 *   therefore no float32-range rejection (a deliberate difference from the
 *   STL exporter). Triangle
 *   order is exactly the soup's index order, winding untouched: the spec's
 *   counter-clockwise/outward rule is the same right-hand rule the kernel
 *   contract's winding already encodes.
 * - **Normals** — 3MF core meshes store **no normals**: the spec defines a
 *   triangle's face normal as the unit `(B−A)×(C−A)` the receiver computes
 *   from the winding (§4.1). The soup's optional vertex normals are
 *   therefore neither read nor validated here — not even length-checked —
 *   they simply have no destination in this format.
 * - **Metadata** — model-level `<metadata>` children carry the spec's
 *   well-known names (§3.4.1, Table 3-1) where provided: `Title`,
 *   `Designer`, `Description`, each at most once (the spec forbids duplicate
 *   names) and in that fixed order. Absent fields emit no element at all.
 *
 * ## Determinism
 *
 * Same input, byte-identical `.3mf`, every call: fixed entry order (content
 * types, rels, model), stored (method 0) entries, a fixed DOS timestamp of
 * 1980-01-01 00:00:00 (the DOS epoch — never `now()`), zero general-purpose
 * flags, extra fields, and comments, plain non-ZIP64 layout (the spec says
 * producers SHOULD stay below ZIP64; JavaScript's maximum string/array
 * lengths keep the package far under the 4 GiB ZIP32 boundary anyway), and a
 * fully fixed XML shape (LF newlines, two-space indent, fixed attribute
 * order, trailing newline). CRC-32 is computed inline from a constant table.
 *
 * ## Capacity limits are structural, not checked
 *
 * The XSD caps vertices and triangles at < 2^31 (ST_ResourceID/Index), but a
 * JavaScript array cannot exceed 2^32−1 flat number components — at most
 * ~1.43 × 10^9 vertices or triangles — so those limits cannot be approached,
 * let alone crossed; no dead guard is carried for them.
 *
 * ## Failure discipline
 *
 * The soup and metadata arrive across a trust boundary, so every structural
 * defect is rejected as a structured {@link ThreeMfExportError} on the
 * cad-core `ParseResult` discipline — never a throw, never a partially
 * written package: empty soups, soups with fewer than the 4 triangles the
 * spec requires of a `model`-type mesh (§4.1.4), non-triple arrays,
 * non-finite vertices, out-of-range indices, triangles whose `v1/v2/v3` are
 * not distinct (a spec MUST), and metadata that is not a non-empty string of
 * XML-1.0-legal characters.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

/** Stable failure codes produced when 3MF export rejects its input. */
export const THREE_MF_EXPORT_ERROR_CODES = {
  /** A tessellation with no triangles has no boundary to export. */
  emptyTessellation: "three-mf-export/empty-tessellation",
  /**
   * Fewer than 4 triangles: a `model`-type 3MF mesh "has to contain at least
   * 4 triangles to form a solid body" (spec §4.1.4).
   */
  tooFewTriangles: "three-mf-export/too-few-triangles",
  /** Positions/indices were not flat triples. */
  malformedTessellation: "three-mf-export/malformed-tessellation",
  /** A vertex coordinate was NaN or infinite. */
  nonFiniteVertex: "three-mf-export/non-finite-vertex",
  /** An index was not an integer inside the vertex range. */
  indexOutOfRange: "three-mf-export/index-out-of-range",
  /** A triangle's v1/v2/v3 indices were not distinct (a spec MUST). */
  degenerateTriangle: "three-mf-export/degenerate-triangle",
  /** A metadata field was not a non-empty XML-1.0-legal string. */
  invalidMetadata: "three-mf-export/invalid-metadata",
} as const;

export type ThreeMfExportErrorCode =
  (typeof THREE_MF_EXPORT_ERROR_CODES)[keyof typeof THREE_MF_EXPORT_ERROR_CODES];

/** Structured failure describing why 3MF export rejected its input. */
export interface ThreeMfExportError extends ParseFailure {
  readonly code: ThreeMfExportErrorCode;
}

/** The result of 3MF export: package bytes, or a structured failure. */
export type ThreeMfExportResult = ParseResult<Uint8Array, ThreeMfExportError>;

/**
 * Optional model-level metadata (Phase 18.3 "preserve relevant metadata
 * where supported"): the 3MF well-known names of §3.4.1 this exporter emits,
 * each only when provided.
 */
export interface ThreeMfMetadata {
  /** `<metadata name="Title">` — a title for the 3MF document. */
  readonly title?: string;
  /** `<metadata name="Designer">` — a name for a designer of this document. */
  readonly designer?: string;
  /** `<metadata name="Description">` — a description of the document. */
  readonly description?: string;
}

/** The unit declared on `<model>`: the kernel contract's canonical unit. */
export const THREE_MF_MODEL_UNIT = "millimeter";

/** Part name of the OPC content-types stream at the package root. */
export const THREE_MF_CONTENT_TYPES_PART_NAME = "[Content_Types].xml";

/** Part name of the package-level relationships part. */
export const THREE_MF_RELS_PART_NAME = "_rels/.rels";

/** Part name of the 3D Model part — the 3MF payload root. */
export const THREE_MF_MODEL_PART_NAME = "3D/3dmodel.model";

/** The single object resource id the exporter assigns (spec: id ≥ 1). */
const OBJECT_RESOURCE_ID = 1;

/**
 * Content type of the 3D Model part (3MF core spec Appendix C.1). Shared
 * spec constant: the importer validates incoming packages against it.
 */
export const THREE_MF_MODEL_CONTENT_TYPE =
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";

/** Content type of every `.rels` part (OPC). */
const RELS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";

/**
 * The 3MF Document StartPart relationship type (Appendix C.2). Shared spec
 * constant: the importer resolves the model part through it.
 */
export const THREE_MF_MODEL_RELATIONSHIP_TYPE =
  "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

/**
 * The 3MF core XML namespace (Appendix C.3). Shared spec constant: the
 * importer requires it as the model root's default namespace.
 */
export const THREE_MF_CORE_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

/** OPC content-types stream namespace. Shared spec constant (importer). */
export const THREE_MF_CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";

/** OPC relationships namespace. Shared spec constant (importer). */
export const THREE_MF_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Byte length of a ZIP local file header (before name and data). */
const LOCAL_FILE_HEADER_BYTES = 30;

/** Byte length of a ZIP central directory header (before the name). */
const CENTRAL_DIRECTORY_HEADER_BYTES = 46;

/** Byte length of the ZIP end-of-central-directory record. */
const EOCD_BYTES = 22;

/**
 * The fixed DOS timestamp written into every ZIP entry: 1980-01-01
 * 00:00:00, the DOS epoch minimum. `(year−1980)<<9 | month<<5 | day` for the
 * date word, zero for the time word — constant, never the current clock.
 */
const DOS_DATE = (1980 - 1980) * 512 + 1 * 32 + 1;
const DOS_TIME = 0;

/** The CRC-32 table for the reflected 0xEDB88320 polynomial (PKWARE ZIP). */
const CRC32_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

/**
 * CRC-32 (PKWARE ZIP polynomial) of `data`, as an unsigned 32-bit value.
 * Shared ZIP routine: the importer verifies every extracted part's CRC
 * against the same table-driven implementation that wrote it.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    const tableEntry = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (tableEntry ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** One stored ZIP entry to lay out. */
interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Precomputed layout facts for one entry. */
interface ZipEntryPlan {
  readonly nameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly localOffset: number;
}

/**
 * Lays out `entries` as a minimal deterministic ZIP archive: for each entry,
 * in order, a local file header followed by the stored (uncompressed) name
 * and data; then the central directory; then the end-of-central-directory
 * record. Everything that could vary run-to-run is pinned: method 0, the
 * 1980-01-01 DOS epoch timestamp, zero flags/extra fields/comments, and no
 * ZIP64.
 */
function buildZipArchive(entries: readonly ZipEntry[]): Uint8Array {
  const plans: ZipEntryPlan[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    plans.push({
      nameBytes,
      data: entry.data,
      crc: crc32(entry.data),
      localOffset: cursor,
    });
    cursor += LOCAL_FILE_HEADER_BYTES + nameBytes.length + entry.data.length;
  }
  const centralDirectoryOffset = cursor;
  let centralDirectorySize = 0;
  for (const plan of plans) {
    centralDirectorySize +=
      CENTRAL_DIRECTORY_HEADER_BYTES + plan.nameBytes.length;
  }
  const bytes = new Uint8Array(
    centralDirectoryOffset + centralDirectorySize + EOCD_BYTES,
  );
  const view = new DataView(bytes.buffer);
  for (const plan of plans) {
    const offset = plan.localOffset;
    view.setUint32(offset, 0x04034b50, true); // local file header signature
    view.setUint16(offset + 4, 20, true); // version needed to extract (2.0)
    view.setUint16(offset + 6, 0, true); // general purpose bit flag
    view.setUint16(offset + 8, 0, true); // compression method: stored
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, plan.crc, true);
    view.setUint32(offset + 18, plan.data.length, true); // compressed size
    view.setUint32(offset + 22, plan.data.length, true); // uncompressed size
    view.setUint16(offset + 26, plan.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra field length
    bytes.set(plan.nameBytes, offset + LOCAL_FILE_HEADER_BYTES);
    bytes.set(
      plan.data,
      offset + LOCAL_FILE_HEADER_BYTES + plan.nameBytes.length,
    );
  }
  let centralCursor = centralDirectoryOffset;
  for (const plan of plans) {
    view.setUint32(centralCursor, 0x02014b50, true); // central header signature
    view.setUint16(centralCursor + 4, 0x0014, true); // version made by (2.0, MS-DOS)
    view.setUint16(centralCursor + 6, 20, true); // version needed to extract
    view.setUint16(centralCursor + 8, 0, true); // general purpose bit flag
    view.setUint16(centralCursor + 10, 0, true); // compression method: stored
    view.setUint16(centralCursor + 12, DOS_TIME, true);
    view.setUint16(centralCursor + 14, DOS_DATE, true);
    view.setUint32(centralCursor + 16, plan.crc, true);
    view.setUint32(centralCursor + 20, plan.data.length, true);
    view.setUint32(centralCursor + 24, plan.data.length, true);
    view.setUint16(centralCursor + 28, plan.nameBytes.length, true);
    view.setUint16(centralCursor + 30, 0, true); // extra field length
    view.setUint16(centralCursor + 32, 0, true); // file comment length
    view.setUint16(centralCursor + 34, 0, true); // disk number start
    view.setUint16(centralCursor + 36, 0, true); // internal file attributes
    view.setUint32(centralCursor + 38, 0, true); // external file attributes
    view.setUint32(centralCursor + 42, plan.localOffset, true);
    bytes.set(plan.nameBytes, centralCursor + CENTRAL_DIRECTORY_HEADER_BYTES);
    centralCursor += CENTRAL_DIRECTORY_HEADER_BYTES + plan.nameBytes.length;
  }
  view.setUint32(centralCursor, 0x06054b50, true); // EOCD signature
  view.setUint16(centralCursor + 4, 0, true); // number of this disk
  view.setUint16(centralCursor + 6, 0, true); // disk with central directory
  view.setUint16(centralCursor + 8, plans.length, true);
  view.setUint16(centralCursor + 10, plans.length, true);
  view.setUint32(centralCursor + 12, centralDirectorySize, true);
  view.setUint32(centralCursor + 16, centralDirectoryOffset, true);
  view.setUint16(centralCursor + 20, 0, true); // comment length
  return bytes;
}

/** Escapes the XML-special characters of text content: `&`, `<`, `>`. */
function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The index of the first code unit `value` cannot carry as XML 1.0
 * character data, or −1 when the whole string is legal (tab, LF, CR, and
 * the printable ranges; surrogate pairs as their astral code point; never a
 * lone surrogate or a control character).
 */
function firstXmlInvalidIndex(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x9 || code === 0xa || code === 0xd) {
      continue;
    }
    if (code >= 0x20 && code <= 0xd7ff) {
      continue;
    }
    if (code >= 0xe000 && code <= 0xfffd) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next =
        i + 1 < value.length ? value.charCodeAt(i + 1) : /* not a pair */ 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // the pair is one legal astral code point
        continue;
      }
    }
    return i;
  }
  return -1;
}

function threeMfError(
  code: ThreeMfExportErrorCode,
  message: string,
  input: unknown,
): ThreeMfExportError {
  return { code, message, input };
}

/** The metadata fields in their fixed emission order. */
const METADATA_FIELDS: readonly {
  readonly label: string;
  readonly xmlName: string;
  readonly read: (metadata: ThreeMfMetadata) => string | undefined;
}[] = [
  { label: "title", xmlName: "Title", read: (m) => m.title },
  { label: "designer", xmlName: "Designer", read: (m) => m.designer },
  { label: "description", xmlName: "Description", read: (m) => m.description },
];

/**
 * Validates the optional metadata: every provided field must be a string
 * that is non-empty (after trimming) and built only of XML-1.0-legal
 * characters. Returns the first structured failure found, or `undefined`.
 */
function validateMetadata(
  metadata: ThreeMfMetadata | undefined,
): ThreeMfExportError | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  for (const field of METADATA_FIELDS) {
    const value = field.read(metadata);
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return threeMfError(
        THREE_MF_EXPORT_ERROR_CODES.invalidMetadata,
        `3MF metadata field '${field.label}' is not a string (got ${typeof value}).`,
        metadata,
      );
    }
    if (value.trim().length === 0) {
      return threeMfError(
        THREE_MF_EXPORT_ERROR_CODES.invalidMetadata,
        `3MF metadata field '${field.label}' is empty or whitespace-only; omit the field instead of exporting a meaningless <metadata> element.`,
        metadata,
      );
    }
    const invalidAt = firstXmlInvalidIndex(value);
    if (invalidAt !== -1) {
      return threeMfError(
        THREE_MF_EXPORT_ERROR_CODES.invalidMetadata,
        `3MF metadata field '${field.label}' contains the character U+${value
          .charCodeAt(invalidAt)
          .toString(16)
          .padStart(4, "0")
          .toUpperCase()}, which XML 1.0 character data cannot carry.`,
        metadata,
      );
    }
  }
  return undefined;
}

/**
 * Validates the soup against everything the 3MF writer needs — including the
 * spec's own MUSTs (≥4 triangles for a model-type mesh; distinct v1/v2/v3) —
 * returning the first structured failure found or `undefined` when writable.
 * Vertex normals are deliberately unchecked: 3MF core meshes store none.
 */
function validateTessellation(
  tessellation: Tessellation,
): ThreeMfExportError | undefined {
  const { positions, indices } = tessellation;
  const triangleCount = indices.length / 3;
  if (indices.length === 0) {
    return threeMfError(
      THREE_MF_EXPORT_ERROR_CODES.emptyTessellation,
      "A tessellation with no triangles has no boundary to export; empty solids are filtered out before 3MF export.",
      tessellation,
    );
  }
  if (triangleCount < 4) {
    return threeMfError(
      THREE_MF_EXPORT_ERROR_CODES.tooFewTriangles,
      `A 3MF model-type mesh must contain at least 4 triangles to form a solid body; the tessellation has ${triangleCount}.`,
      tessellation,
    );
  }
  if (positions.length % 3 !== 0) {
    return threeMfError(
      THREE_MF_EXPORT_ERROR_CODES.malformedTessellation,
      `Tessellation positions length ${positions.length} is not divisible by 3 (flat xyz triples required).`,
      tessellation,
    );
  }
  if (indices.length % 3 !== 0) {
    return threeMfError(
      THREE_MF_EXPORT_ERROR_CODES.malformedTessellation,
      `Tessellation indices length ${indices.length} is not divisible by 3 (triangle index triples required).`,
      tessellation,
    );
  }
  for (let i = 0; i < positions.length; i += 1) {
    const value = positions[i];
    if (value === undefined || !Number.isFinite(value)) {
      return threeMfError(
        THREE_MF_EXPORT_ERROR_CODES.nonFiniteVertex,
        `Tessellation position ${i} is not a finite number (got ${String(value)}); ST_Number coordinates are decimal text and cannot carry NaN or infinity.`,
        tessellation,
      );
    }
  }
  const vertexCount = positions.length / 3;
  for (let t = 0; t < indices.length; t += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const index = indices[t + corner];
      if (
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= vertexCount
      ) {
        return threeMfError(
          THREE_MF_EXPORT_ERROR_CODES.indexOutOfRange,
          `Tessellation index ${t + corner} is ${String(index)}, not an integer inside the vertex range 0..${vertexCount - 1}.`,
          tessellation,
        );
      }
    }
    const v1 = indices[t] ?? 0;
    const v2 = indices[t + 1] ?? 0;
    const v3 = indices[t + 2] ?? 0;
    if (v1 === v2 || v1 === v3 || v2 === v3) {
      return threeMfError(
        THREE_MF_EXPORT_ERROR_CODES.degenerateTriangle,
        `Triangle ${t / 3} repeats an index (${v1}, ${v2}, ${v3}); the spec requires v1, v2 and v3 to be distinct.`,
        tessellation,
      );
    }
  }
  return undefined;
}

/** Emits the OPC `[Content_Types].xml` stream for the three-part package. */
function buildContentTypesXml(): string {
  return (
    `${XML_DECLARATION}\n` +
    `<Types xmlns="${THREE_MF_CONTENT_TYPES_NAMESPACE}">` +
    `<Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>` +
    `<Default Extension="model" ContentType="${THREE_MF_MODEL_CONTENT_TYPE}"/>` +
    `</Types>\n`
  );
}

/** Emits `_rels/.rels`: the one StartPart relationship to the model part. */
function buildRelsXml(): string {
  return (
    `${XML_DECLARATION}\n` +
    `<Relationships xmlns="${THREE_MF_RELATIONSHIPS_NAMESPACE}">` +
    `<Relationship Id="rel0" Type="${THREE_MF_MODEL_RELATIONSHIP_TYPE}" Target="/${THREE_MF_MODEL_PART_NAME}"/>` +
    `</Relationships>\n`
  );
}

/**
 * Emits the 3D Model part: declaration, `<model>` root declaring
 * `unit="millimeter"` and the core namespace, provided metadata in fixed
 * order, one model-type object resource with the mesh (vertices then
 * triangles, both in soup order), and a build with one item. Coordinates are
 * the shortest round-tripping decimal of each f64 — full precision, one
 * deterministic spelling per value.
 */
function buildModelXml(
  tessellation: Tessellation,
  metadata: ThreeMfMetadata | undefined,
): string {
  const { positions, indices } = tessellation;
  const lines: string[] = [
    XML_DECLARATION,
    `<model unit="${THREE_MF_MODEL_UNIT}" xmlns="${THREE_MF_CORE_NAMESPACE}">`,
  ];
  for (const field of METADATA_FIELDS) {
    const value = metadata === undefined ? undefined : field.read(metadata);
    if (value !== undefined) {
      lines.push(
        `  <metadata name="${field.xmlName}">${escapeXmlText(value)}</metadata>`,
      );
    }
  }
  lines.push(
    "  <resources>",
    `    <object id="${OBJECT_RESOURCE_ID}" type="model">`,
    "      <mesh>",
    "        <vertices>",
  );
  for (let v = 0; v < positions.length / 3; v += 1) {
    const x = positions[3 * v] ?? 0;
    const y = positions[3 * v + 1] ?? 0;
    const z = positions[3 * v + 2] ?? 0;
    lines.push(`          <vertex x="${x}" y="${y}" z="${z}"/>`);
  }
  lines.push("        </vertices>", "        <triangles>");
  for (let t = 0; t < indices.length / 3; t += 1) {
    const v1 = indices[3 * t] ?? 0;
    const v2 = indices[3 * t + 1] ?? 0;
    const v3 = indices[3 * t + 2] ?? 0;
    lines.push(`          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`);
  }
  lines.push(
    "        </triangles>",
    "      </mesh>",
    "    </object>",
    "  </resources>",
    "  <build>",
    `    <item objectid="${OBJECT_RESOURCE_ID}"/>`,
    "  </build>",
    "</model>",
    "",
  );
  return lines.join("\n");
}

/**
 * Serializes `tessellation` (and optional model-level `metadata`) to a
 * deterministic 3MF document — an OPC ZIP package of
 * `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model` holding the
 * mesh in canonical millimetres. Same soup and metadata in, same bytes out,
 * every call.
 */
export function exportThreeMf(
  tessellation: Tessellation,
  metadata?: ThreeMfMetadata,
): ThreeMfExportResult {
  const tessellationFailure = validateTessellation(tessellation);
  if (tessellationFailure !== undefined) {
    return fail(tessellationFailure);
  }
  const metadataFailure = validateMetadata(metadata);
  if (metadataFailure !== undefined) {
    return fail(metadataFailure);
  }
  return ok(
    buildZipArchive([
      {
        name: THREE_MF_CONTENT_TYPES_PART_NAME,
        data: encoder.encode(buildContentTypesXml()),
      },
      {
        name: THREE_MF_RELS_PART_NAME,
        data: encoder.encode(buildRelsXml()),
      },
      {
        name: THREE_MF_MODEL_PART_NAME,
        data: encoder.encode(buildModelXml(tessellation, metadata)),
      },
    ]),
  );
}
