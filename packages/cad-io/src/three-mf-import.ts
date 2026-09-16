/**
 * 3MF import (Phase 18.4): parses untrusted bytes — the raw content of a
 * `.3mf` file, an OPC package inside a ZIP archive — into an
 * {@link ImportedThreeMfMesh}: the kernel-neutral {@link Tessellation} in
 * canonical millimetres, the unit the model declared, and the well-known
 * metadata. The semantic inverse of `./three-mf-export`: the export →
 * import round trip preserves triangle counts, the index structure, exact
 * f64 positions, bounds, and the divergence-theorem volume — 3MF decimal
 * coordinates are lossless text, with no float32 boundary to cross.
 *
 * ## Container (ZIP framing) — what is accepted
 *
 * - **End of central directory** — located by scanning backwards from the
 *   buffer end for the EOCD signature with a comment length that accounts
 *   for every remaining byte, so a package with a trailing ZIP comment
 *   (common in externally authored archives) still resolves. The EOCD must
 *   describe disk 0 with no ZIP64 sentinels; the central directory must end
 *   exactly where the EOCD begins.
 * - **Compression methods** — both of the methods OPC sanctions: stored
 *   (method 0 — what our exporter writes) and deflate (method 8 — what
 *   real-world 3MF from other tools almost always carries). Any other
 *   method, and encrypted entries, are rejected.
 * - **Local/central agreement** — every entry's local file header is
 *   validated against its central record: signature, name, method, and
 *   (when the entry has no data descriptor) CRC and sizes. Entries using a
 *   data descriptor (streaming writers, general-purpose bit 3) are read
 *   with the central directory's authoritative sizes. Central-directory
 *   extra fields and per-entry comments are parsed past — external
 *   archives legitimately carry them.
 * - **CRC-32** — verified against every extracted part's bytes.
 *
 * ## Environment constraint (the deflate decision)
 *
 * Deflate is supported through `node:zlib`'s `inflateRawSync` (raw deflate
 * is the ZIP stream shape): dependency-free in Node, and the difference
 * between "imports our own files" and "imports 3MF". Browsers ship no
 * zlib, and this module's static `node:zlib` import therefore targets
 * Node — server, CLI, and tests. A browser import adapter would have to
 * inject an inflate implementation behind an interface; that decoupling is
 * deliberately out of scope for Phase 18.4. The stored-entry path itself
 * needs no inflate, so packages our exporter produces contain nothing the
 * browser story depends on zlib for.
 *
 * ## ZIP safety (the STL allocation-guard discipline)
 *
 * No size is trusted before it is reconciled with the buffer: every
 * structural read is preceded by a bounds check in plain-number
 * arithmetic, data regions must fit inside the archive before anything is
 * sliced or inflated, and a declared uncompressed size larger than
 * {@link THREE_MF_IMPORT_MAX_PART_BYTES} is rejected *before* inflation —
 * a decompression bomb never gets to allocate. Inflation is additionally
 * capped at the declared size via zlib's `maxOutputLength`. Only the three
 * required OPC parts are ever extracted; other entries are
 * framing-validated but never decompressed, so a hostile archive pays for
 * its framing, nothing more.
 *
 * ## OPC resolution
 *
 * `[Content_Types].xml` and `_rels/.rels` are required parts. The 3D Model
 * part is found the OPC way: the single relationship of the 3MF Document
 * StartPart type selects the part. Its target is matched literally against
 * entry names (after stripping one leading slash — `_rels/.rels` lives at
 * the package root, so a slash-less target is equally root-relative);
 * there is no filesystem resolution, so path traversal has nothing to
 * traverse. The model part's effective content type (Override, else
 * Default by extension) must be the 3MF model content type. Relationships
 * of other types are ignored; their targets are not required to exist
 * (thumbnail relationships are routine).
 *
 * ## XML parsing
 *
 * Node has no DOMParser and the no-new-dependencies rule applies, so the
 * model, content-types, and relationships parts are parsed by a
 * hand-rolled, well-formedness-checking XML parser: elements, attributes
 * (single- or double-quoted), the five predefined entities and numeric
 * character references, CDATA sections, comments, and processing
 * instructions. Rejected: DOCTYPE and any DTD declaration (the spec
 * forbids them), unknown entities, duplicate attributes, mismatched end
 * tags, illegal characters, and content after the root element. Names are
 * restricted to the ASCII letter/`_`/`:`/digit/`.`/`-` vocabulary OPC and
 * 3MF use. The `<model>` root must declare the core namespace as its
 * *default* namespace — prefixed forms are rejected with a clear message
 * (the overwhelming majority of producers, like the spec's own examples,
 * use the default namespace). Prefixed (foreign-namespace) elements are
 * skipped per the spec's extension model; unknown *unprefixed* elements
 * in core positions are structure violations. Unknown attributes are
 * ignored unless they could silently change geometry semantics —
 * `transform` on a build item and non-empty `requiredextensions` are
 * rejected instead of dropped, because ignoring them would import a
 * *different* model than the one the document describes.
 *
 * ## Structure (the core single-object case)
 *
 * The core spec essentials are enforced: one `<resources>` holding exactly
 * one `model`-type `<object>` (type defaults to `model` when absent) whose
 * `<mesh>` lists `<vertices>` before `<triangles>`, and one `<build>` with
 * exactly one `<item>` referencing that object by id. Out of scope, each
 * rejected as `three-mf-import/unsupported-structure` rather than
 * half-read: multiple objects, multiple build items (instancing),
 * `components`, build-item `transform` matrices, non-`model` object types
 * (`support`/`solidsupport`/`other`), and models declaring non-empty
 * `requiredextensions`. Triangles keep their file winding: the spec's
 * counter-clockwise/outward rule is the same right-hand rule the kernel
 * contract encodes, and re-orienting is a consumer decision, never the
 * importer's.
 *
 * ## Units — declared unit surfaced, geometry canonicalized
 *
 * 3MF declares units; `units` in the result reports **the unit the model
 * declared** (the spec default `millimeter` when the attribute is absent),
 * while `tessellation.positions` is **always canonical millimetres**.
 * Non-millimetre models are converted with the ST_Unit factors, applied as
 * one f64 multiplication per component:
 *
 * | ST_Unit      | factor to mm | definition |
 * | ------------ | ------------ | ---------- |
 * | micron       | `0.001`      | 10⁻³ mm    |
 * | millimeter   | `1`          | pass-through, never multiplied — exact f64s survive bit-for-bit (the round-trip guarantee) |
 * | centimeter   | `10`         | 10 mm      |
 * | inch         | `25.4`       | 25.4 mm    |
 * | foot         | `304.8`      | 12 × 25.4 mm |
 * | meter        | `1000`       | 10³ mm     |
 *
 * Any other `unit` value is `three-mf-import/invalid-unit`. A coordinate
 * that is finite in its declared unit but overflows to infinity in
 * millimetres is rejected, not clipped.
 *
 * ## Metadata
 *
 * The well-known model-level names this package round-trips — `Title`,
 * `Designer`, `Description` (§3.4.1) — are preserved; each at most once
 * (duplicates are malformed per spec) with entities decoded and inner
 * whitespace intact, and whitespace-only values dropped as meaningless.
 * Other metadata names (e.g. `Application`) are parsed for
 * well-formedness and deliberately dropped: they have no destination in
 * this package's metadata shape. Object-level naming attributes (`name`,
 * `pid`, `pindex`) are ignored.
 *
 * ## No parametric history fabrication
 *
 * 3MF core carries a mesh, units, and metadata — no features, no
 * parameters, no construction history. The success type is named
 * {@link ImportedThreeMfMesh} and its payload is exactly a tessellation,
 * the declared unit, and metadata: this module constructs no document,
 * feature, parameter, or solid and imports nothing from cad-core's
 * document machinery, so no invented history can leak through it. Normals
 * are never synthesized — 3MF core meshes store none (the receiver
 * computes face normals from winding), so the imported soup simply has no
 * `normals` field. Callers turn the mesh into document bodies; that act
 * belongs to the app layer, not the format adapter.
 *
 * ## Failure discipline
 *
 * The bytes arrive across a trust boundary, so `importThreeMf` never
 * throws: every defect is a structured {@link ThreeMfImportError} on the
 * cad-core `ParseResult` discipline with a stable `three-mf-import/*`
 * code. Internally, rejections travel as a private {@link ImportReject}
 * exception caught at the single entry point; unexpected exceptions are
 * rethrown — an implementation bug must not masquerade as a hostile file.
 * The code → defect mapping:
 *
 * | code | fires when |
 * | ---- | ---------- |
 * | `empty` | zero-byte input; a model with no triangles; no `<build>` or an empty one (nothing is instantiated) |
 * | `not-a-zip` | any ZIP framing defect: missing/corrupt EOCD, bad signatures, offsets out of bounds, central/local disagreement, unsupported or encrypted methods, duplicate entry names, ZIP64 sentinels, invalid UTF-8 entry names |
 * | `bad-compression` | a deflate stream that cannot be inflated, or a declared expansion beyond the documented cap |
 * | `crc-mismatch` | extracted bytes fail the entry's CRC-32 |
 * | `missing-part` | a required OPC part is absent, or the StartPart target resolves to no entry |
 * | `bad-relationship` | no single 3MF Document StartPart relationship, external targets, duplicate relationship ids |
 * | `invalid-content-type` | the model part's effective content type is not the 3MF model type |
 * | `invalid-unit` | the `<model unit>` value is not an ST_Unit |
 * | `malformed-xml` | invalid UTF-8, XML well-formedness defects, wrong root/namespace, container/nesting violations, missing attributes on unique elements, duplicate metadata names |
 * | `count-mismatch` | repeated geometry elements present but not parseable — a `<vertex>`/`<triangle>` with a missing or lexically invalid attribute, or unexpected content among them |
 * | `non-finite-vertex` | a coordinate that parses to infinity, in its declared unit or after conversion |
 * | `degenerate-index` | an integer index that is negative, out of vertex range, or repeated within its triangle (a spec MUST) |
 * | `unsupported-structure` | the documented out-of-scope constructs above |
 */

import { inflateRawSync } from "node:zlib";
import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

import {
  THREE_MF_CONTENT_TYPES_NAMESPACE,
  THREE_MF_CONTENT_TYPES_PART_NAME,
  THREE_MF_CORE_NAMESPACE,
  THREE_MF_MODEL_CONTENT_TYPE,
  THREE_MF_MODEL_RELATIONSHIP_TYPE,
  THREE_MF_RELATIONSHIPS_NAMESPACE,
  THREE_MF_RELS_PART_NAME,
  crc32,
  type ThreeMfMetadata,
} from "./three-mf-export";

/** Stable failure codes produced when 3MF import rejects its input. */
export const THREE_MF_IMPORT_ERROR_CODES = {
  /** Zero bytes, a mesh with no triangles, or a model that builds nothing. */
  empty: "three-mf-import/empty",
  /** Any ZIP framing defect (see the module header's code table). */
  notAZip: "three-mf-import/not-a-zip",
  /** A deflate entry that cannot be inflated or exceeds the size cap. */
  badCompression: "three-mf-import/bad-compression",
  /** Extracted bytes fail the entry's CRC-32. */
  crcMismatch: "three-mf-import/crc-mismatch",
  /** A required OPC part is absent or unresolvable. */
  missingPart: "three-mf-import/missing-part",
  /** The package has no unambiguous 3MF Document StartPart relationship. */
  badRelationship: "three-mf-import/bad-relationship",
  /** The model part's declared OPC content type is wrong. */
  invalidContentType: "three-mf-import/invalid-content-type",
  /** The `<model unit>` attribute is not one of the ST_Unit values. */
  invalidUnit: "three-mf-import/invalid-unit",
  /** XML well-formedness or document-structure defects. */
  malformedXml: "three-mf-import/malformed-xml",
  /** Repeated geometry elements that are present but not parseable. */
  countMismatch: "three-mf-import/count-mismatch",
  /** A coordinate that parses to a non-finite number. */
  nonFiniteVertex: "three-mf-import/non-finite-vertex",
  /** An index that is out of range or repeats within its triangle. */
  degenerateIndex: "three-mf-import/degenerate-index",
  /** Documented out-of-scope 3MF constructs (see the module header). */
  unsupportedStructure: "three-mf-import/unsupported-structure",
} as const;

export type ThreeMfImportErrorCode =
  (typeof THREE_MF_IMPORT_ERROR_CODES)[keyof typeof THREE_MF_IMPORT_ERROR_CODES];

/** Structured failure describing why 3MF import rejected some bytes. */
export interface ThreeMfImportError extends ParseFailure {
  readonly code: ThreeMfImportErrorCode;
}

/**
 * The ST_Unit values the core spec defines (§4.1): the units a `<model>`
 * may declare, in the spec's spelling.
 */
export type ThreeMfUnit =
  | "micron"
  | "millimeter"
  | "centimeter"
  | "inch"
  | "foot"
  | "meter";

/**
 * The exact ST_Unit → millimetre conversion factors (micron 10⁻³,
 * centimeter 10, inch 25.4, foot 304.8 = 12 × 25.4, meter 10³), applied as
 * one f64 multiplication per coordinate component. Millimetre models are
 * never multiplied — their positions pass through unscaled, so exact f64
 * values survive the import bit-for-bit (the round-trip guarantee).
 */
export const THREE_MF_UNIT_TO_MILLIMETER_FACTORS: Readonly<
  Record<ThreeMfUnit, number>
> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** Whether `value` is one of the ST_Unit names the core spec defines. */
function isThreeMfUnit(value: string): value is ThreeMfUnit {
  return value in THREE_MF_UNIT_TO_MILLIMETER_FACTORS;
}

/**
 * The largest uncompressed part this importer will inflate: 512 MiB
 * (2²⁹ bytes), checked against the *declared* size before any inflation,
 * so a decompression bomb is rejected by arithmetic, not by an
 * out-of-memory crash. A model part is decimal XML text; anything near
 * this cap is orders of magnitude beyond the mesh a JavaScript array can
 * hold.
 */
export const THREE_MF_IMPORT_MAX_PART_BYTES = 2 ** 29;

/**
 * The successful result of importing a 3MF file: a mesh body's triangle
 * soup in canonical millimetres, the unit the model declared, and the
 * well-known metadata. Named for imported-mesh semantics — an imported
 * 3MF is a mesh, never a parametric document (see the module header's
 * no-fabrication rule).
 */
export interface ImportedThreeMfMesh {
  /** The mesh in canonical millimetres (see the units section above). */
  readonly tessellation: Tessellation;
  /** The ST_Unit the model declared; the spec default is `millimeter`. */
  readonly units: ThreeMfUnit;
  /** Preserved well-known metadata; absent fields are absent keys. */
  readonly metadata: ThreeMfMetadata;
}

/** The result of 3MF import: an imported mesh, or a structured failure. */
export type ThreeMfImportResult = ParseResult<
  ImportedThreeMfMesh,
  ThreeMfImportError
>;

/**
 * Internal control-flow carrier: a rejection with its structured code,
 * thrown by the parsing layers and caught at the single entry point so
 * the public function stays total. Never escapes `importThreeMf`.
 */
class ImportReject extends Error {
  constructor(
    readonly code: ThreeMfImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * One parsed XML element: qualified name, attributes, element children,
 * and the concatenated character data (entities resolved, CDATA included,
 * comments excluded — mixed-content ordering between text and children is
 * not preserved, only membership, which is all the 3MF shape needs).
 */
interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: XmlElement[];
  text: string;
}

/** XML name start characters: ASCII letters, `_`, `:`. */
function isXmlNameStartChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x3a
  );
}

/** XML name continuation characters: start characters plus digits, `.`, `-`. */
function isXmlNameChar(code: number): boolean {
  return (
    isXmlNameStartChar(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x2e
  );
}

function isXmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
}

/**
 * Whether a UTF-16 code unit is legal XML 1.0 character data on its own:
 * tab, LF, CR, and the printable ranges. Surrogate pairs are validated
 * structurally where text is scanned.
 */
function isLegalXmlCharCode(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd)
  );
}

/**
 * Parses `text` as an XML document and returns its root element. Throws
 * {@link ImportReject} (`malformed-xml`) on every well-formedness defect
 * the 3MF model, content-types, and relationships parts can present — see
 * the module header for the exact feature set.
 */
function parseXmlDocument(text: string): XmlElement {
  const length = text.length;
  let cursor = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;

  const reject: (message: string) => never = (message) => {
    throw new ImportReject(THREE_MF_IMPORT_ERROR_CODES.malformedXml, message);
  };
  const startsWith = (marker: string): boolean =>
    text.startsWith(marker, cursor);

  const skipWhitespace = (): void => {
    while (cursor < length && isXmlWhitespace(text.charCodeAt(cursor))) {
      cursor += 1;
    }
  };

  const readName = (where: string): string => {
    if (cursor >= length || !isXmlNameStartChar(text.charCodeAt(cursor))) {
      reject(
        `${where}: a name must start with a letter, '_' or ':' (found '${text.charAt(cursor)}').`,
      );
    }
    const start = cursor;
    while (cursor < length && isXmlNameChar(text.charCodeAt(cursor))) {
      cursor += 1;
    }
    return text.slice(start, cursor);
  };

  /** Decodes the entity whose `&` has been consumed; cursor lands past `;`. */
  const decodeEntity = (where: string): string => {
    const semicolon = text.indexOf(";", cursor);
    if (semicolon === -1 || semicolon - cursor > 12) {
      reject(`${where}: entity reference is unterminated or oversized.`);
    }
    const name = text.slice(cursor, semicolon);
    cursor = semicolon + 1;
    if (name === "amp") return "&";
    if (name === "lt") return "<";
    if (name === "gt") return ">";
    if (name === "quot") return '"';
    if (name === "apos") return "'";
    if (name.startsWith("#")) {
      const body = name.slice(1);
      const hex = body.startsWith("x") || body.startsWith("X");
      const digits = hex ? body.slice(1) : body;
      if (!digits.match(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/)) {
        reject(`${where}: '&${name};' is not a numeric character reference.`);
      }
      const codePoint = Number.parseInt(digits, hex ? 16 : 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 1 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        reject(
          `${where}: character reference '&${name};' is outside the character set XML 1.0 can carry.`,
        );
      }
      return String.fromCodePoint(codePoint);
    }
    reject(
      `${where}: '&${name};' is not a predefined entity, and DTD-declared entities are forbidden in 3MF parts.`,
    );
  };

  const skipComment = (): void => {
    const end = text.indexOf("-->", cursor + 4);
    if (end === -1) {
      reject("comment is never closed.");
    }
    const body = text.slice(cursor + 4, end);
    if (body.includes("--") || body.endsWith("-")) {
      reject("comments must not contain '--' or end with '-'.");
    }
    cursor = end + 3;
  };

  const skipProcessingInstruction = (): void => {
    const end = text.indexOf("?>", cursor + 2);
    if (end === -1) {
      reject("processing instruction is never closed.");
    }
    cursor = end + 2;
  };

  /** Reads a CDATA section into `top`'s character data. */
  const readCdata = (top: XmlElement): void => {
    const end = text.indexOf("]]>", cursor + 9);
    if (end === -1) {
      reject("CDATA section is never closed.");
    }
    const chunk = text.slice(cursor + 9, end);
    for (let i = 0; i < chunk.length; i += 1) {
      if (!isLegalXmlCharCode(chunk.charCodeAt(i))) {
        reject("CDATA section contains a character XML 1.0 cannot carry.");
      }
    }
    top.text += chunk;
    cursor = end + 3;
  };

  /**
   * Scans one character-data code unit (entities resolved, surrogate pairs
   * kept whole) into `top`. Lone surrogates never survive the strict UTF-8
   * decode, so anything the pair check does not consume falls through to
   * the character-range rejection.
   */
  const scanTextChar = (top: XmlElement): void => {
    const code = text.charCodeAt(cursor);
    if (code === 0x26 /* & */) {
      cursor += 1;
      top.text += decodeEntity("character data");
      return;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next =
        cursor + 1 < length ? text.charCodeAt(cursor + 1) : /* unpaired */ 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        top.text += text.slice(cursor, cursor + 2);
        cursor += 2;
        return;
      }
    }
    if (!isLegalXmlCharCode(code)) {
      reject(
        `character data carries U+${code.toString(16).padStart(4, "0").toUpperCase()}, which XML 1.0 forbids.`,
      );
    }
    top.text += text.charAt(cursor);
    cursor += 1;
  };

  const readAttributeValue = (
    attributeName: string,
    elementName: string,
  ): string => {
    const quote = text.charAt(cursor);
    if (quote !== '"' && quote !== "'") {
      reject(
        `attribute '${attributeName}' of <${elementName}> must be quoted with '"' or "'".`,
      );
    }
    cursor += 1;
    let value = "";
    while (cursor < length && text.charAt(cursor) !== quote) {
      const code = text.charCodeAt(cursor);
      if (code === 0x26 /* & */) {
        cursor += 1;
        value += decodeEntity(`attribute '${attributeName}'`);
        continue;
      }
      if (code === 0x3c /* < */) {
        reject(
          `attribute '${attributeName}' of <${elementName}> contains a literal '<'.`,
        );
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const next =
          cursor + 1 < length ? text.charCodeAt(cursor + 1) : /* unpaired */ 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          value += text.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
      }
      if (!isLegalXmlCharCode(code)) {
        reject(
          `attribute '${attributeName}' carries a character XML 1.0 forbids.`,
        );
      }
      value += text.charAt(cursor);
      cursor += 1;
    }
    if (cursor >= length) {
      reject(
        `attribute '${attributeName}' of <${elementName}> is never closed.`,
      );
    }
    cursor += 1;
    return value;
  };

  const openElement = (): void => {
    if (root !== undefined && stack.length === 0) {
      reject("content appears after the root element's end tag.");
    }
    cursor += 1; // past '<'
    const name = readName("start tag");
    const attributes = new Map<string, string>();
    const finish = (selfClosing: boolean): void => {
      const node: XmlElement = {
        name,
        attributes,
        children: [],
        text: "",
      };
      const parent = stack[stack.length - 1];
      if (parent === undefined) {
        root = node;
      } else {
        parent.children.push(node);
      }
      if (!selfClosing) {
        stack.push(node);
      }
    };
    for (;;) {
      skipWhitespace();
      if (cursor >= length) {
        reject(`start tag <${name}> is never terminated.`);
      }
      if (startsWith("/>")) {
        cursor += 2;
        finish(true);
        return;
      }
      if (text.charAt(cursor) === ">") {
        cursor += 1;
        finish(false);
        return;
      }
      const attributeName = readName(`start tag <${name}>`);
      skipWhitespace();
      if (text.charAt(cursor) !== "=") {
        reject(
          `attribute '${attributeName}' of <${name}> must be followed by '='.`,
        );
      }
      cursor += 1;
      skipWhitespace();
      const value = readAttributeValue(attributeName, name);
      if (attributes.has(attributeName)) {
        reject(`attribute '${attributeName}' appears twice on <${name}>.`);
      }
      attributes.set(attributeName, value);
    }
  };

  const closeElement = (): void => {
    cursor += 2; // past '</'
    const name = readName("end tag");
    skipWhitespace();
    if (cursor >= length || text.charAt(cursor) !== ">") {
      reject(`end tag </${name}> must close with '>' immediately after the name.`);
    }
    cursor += 1;
    const top = stack[stack.length - 1];
    if (top === undefined) {
      reject(`end tag </${name}> closes an element that is not open.`);
    }
    if (top.name !== name) {
      reject(`end tag </${name}> does not match the open <${top.name}>.`);
    }
    stack.pop();
  };

  while (cursor < length) {
    if (text.charCodeAt(cursor) === 0x3c /* < */) {
      if (startsWith("<?")) {
        skipProcessingInstruction();
      } else if (startsWith("<!--")) {
        skipComment();
      } else if (startsWith("<![CDATA[")) {
        const top = stack[stack.length - 1] ??
          reject("CDATA is not allowed outside the root element.");
        readCdata(top);
      } else if (startsWith("<!")) {
        reject(
          "DTD declarations (DOCTYPE and friends) are forbidden in 3MF XML parts.",
        );
      } else if (startsWith("</")) {
        closeElement();
      } else {
        openElement();
      }
      continue;
    }
    if (stack.length === 0) {
      if (isXmlWhitespace(text.charCodeAt(cursor))) {
        cursor += 1;
        continue;
      }
      reject(
        `character data '${text.charAt(cursor)}' appears outside the root element.`,
      );
    }
    scanTextChar(
      stack[stack.length - 1] ??
        reject("character data has no open element to land in."),
    );
  }
  if (root === undefined) {
    reject("no root element.");
  }
  if (stack.length > 0) {
    reject(
      `element <${stack[stack.length - 1]?.name ?? "?"}> is never closed.`,
    );
  }
  return root;
}

/**
 * The ST_Number lexical form accepted for coordinates: the XML Schema
 * `xs:double` decimal spellings (optional sign, digits with an optional
 * `.`-fraction or a leading `.`-fraction, optional exponent) — and *not*
 * the `INF`/`NaN` spellings xs:double also permits, which 3MF coordinates
 * exclude. Lexical screening happens before `Number()` so hexadecimal,
 * empty, and bare-word tokens can never parse silently.
 */
const ST_NUMBER_PATTERN =
  /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** The integer lexical form accepted for indices and ids (xs:int-derived). */
const ST_INTEGER_PATTERN = /^[+-]?[0-9]+$/;

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

/** Byte length of a ZIP local file header (before name, extra, and data). */
const LOCAL_FILE_HEADER_BYTES = 30;

/** Byte length of a ZIP central directory header (before name/extra/comment). */
const CENTRAL_DIRECTORY_HEADER_BYTES = 46;

/** Byte length of the ZIP end-of-central-directory record. */
const EOCD_BYTES = 22;

/** Longest EOCD trailing comment the backward scan will look through. */
const MAX_ZIP_COMMENT_BYTES = 0xffff;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** One central-directory entry, framing-validated, awaiting extraction. */
interface ZipEntryRecord {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dataStart: number;
}

/** A framing-validated ZIP index that extracts parts on demand. */
interface ZipIndex {
  /** Extracts and verifies one entry: inflate, size-check, CRC-check. */
  readonly extract: (name: string) => Uint8Array;
}

/** Constant-time byte equality for the local/central name comparison. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Parses the ZIP container: EOCD by backward scan (a trailing comment is
 * tolerated), central directory walked with every offset bounds-checked
 * and every local header reconciled with its central record. Nothing is
 * decompressed here — extraction is lazy per part, so entries the package
 * does not need are never paid for.
 */
function readZipIndex(bytes: Uint8Array): ZipIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reject: (message: string) => never = (message) => {
    throw new ImportReject(THREE_MF_IMPORT_ERROR_CODES.notAZip, message);
  };
  const u16 = (offset: number): number => view.getUint16(offset, true);
  const u32 = (offset: number): number => view.getUint32(offset, true);

  if (bytes.length < EOCD_BYTES) {
    reject(
      `the input is ${bytes.length} bytes — too short for even the ${EOCD_BYTES}-byte ZIP end-of-central-directory record.`,
    );
  }
  const scanFloor = Math.max(
    0,
    bytes.length - EOCD_BYTES - MAX_ZIP_COMMENT_BYTES,
  );
  let eocdOffset = -1;
  for (
    let candidate = bytes.length - EOCD_BYTES;
    candidate >= scanFloor;
    candidate -= 1
  ) {
    if (u32(candidate) !== 0x06054b50) {
      continue;
    }
    if (candidate + EOCD_BYTES + u16(candidate + 20) === bytes.length) {
      eocdOffset = candidate;
      break;
    }
  }
  if (eocdOffset === -1) {
    reject(
      "no end-of-central-directory record whose comment length accounts for the buffer's end.",
    );
  }
  if (u16(eocdOffset + 4) !== 0 || u16(eocdOffset + 6) !== 0) {
    reject("the archive spans multiple disks.");
  }
  const entryCount = u16(eocdOffset + 8);
  const centralSize = u32(eocdOffset + 12);
  const centralOffset = u32(eocdOffset + 16);
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    reject(
      "ZIP64 archives are not supported (the spec says producers SHOULD stay below ZIP64).",
    );
  }
  if (
    centralOffset > eocdOffset ||
    centralOffset + centralSize !== eocdOffset
  ) {
    reject(
      `the central directory [${centralOffset}, ${centralOffset + centralSize}) does not end exactly at the end-of-central-directory offset ${eocdOffset}.`,
    );
  }

  const records = new Map<string, ZipEntryRecord>();
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + CENTRAL_DIRECTORY_HEADER_BYTES > eocdOffset) {
      reject(`the central directory runs past the archive at entry ${i}.`);
    }
    if (u32(cursor) !== 0x02014b50) {
      reject(`central directory entry ${i} has no header signature.`);
    }
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    if ((flags & 0x0001) !== 0) {
      reject(`entry ${i} is encrypted; encrypted entries are not supported.`);
    }
    if (method !== 0 && method !== 8) {
      reject(
        `entry ${i} uses compression method ${method}; only stored (0) and deflate (8) are supported.`,
      );
    }
    const crc = u32(cursor + 16);
    const compressedSize = u32(cursor + 20);
    const uncompressedSize = u32(cursor + 24);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      reject(`entry ${i} carries a ZIP64 size sentinel.`);
    }
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    if (u16(cursor + 34) !== 0) {
      reject(`entry ${i} starts on another disk.`);
    }
    const localOffset = u32(cursor + 42);
    if (localOffset === 0xffffffff) {
      reject(`entry ${i} carries a ZIP64 local-header offset sentinel.`);
    }
    if (cursor + CENTRAL_DIRECTORY_HEADER_BYTES + nameLength > eocdOffset) {
      reject(`entry ${i}'s name runs past the archive.`);
    }
    const nameBytes = bytes.subarray(
      cursor + CENTRAL_DIRECTORY_HEADER_BYTES,
      cursor + CENTRAL_DIRECTORY_HEADER_BYTES + nameLength,
    );
    let name: string;
    try {
      name = utf8Decoder.decode(nameBytes);
    } catch {
      reject(`entry ${i}'s name is not valid UTF-8.`);
    }
    if (records.has(name)) {
      reject(`duplicate entry name '${name}'.`);
    }
    cursor +=
      CENTRAL_DIRECTORY_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (cursor > eocdOffset) {
      reject(
        `entry '${name}' (extra fields or comment) runs past the archive.`,
      );
    }

    // Local/central agreement — the data lives behind the local header,
    // and both records must describe the same bytes.
    if (
      localOffset + LOCAL_FILE_HEADER_BYTES > bytes.length ||
      u32(localOffset) !== 0x04034b50
    ) {
      reject(
        `entry '${name}' has no local file header at offset ${localOffset}.`,
      );
    }
    if (u16(localOffset + 8) !== method) {
      reject(
        `entry '${name}': the local header claims method ${u16(localOffset + 8)}, the central record ${method}.`,
      );
    }
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    if (
      localOffset + LOCAL_FILE_HEADER_BYTES + localNameLength >
      bytes.length
    ) {
      reject(`entry '${name}' has a local name running past the archive.`);
    }
    if (
      localNameLength !== nameLength ||
      !bytesEqual(
        bytes.subarray(
          localOffset + LOCAL_FILE_HEADER_BYTES,
          localOffset + LOCAL_FILE_HEADER_BYTES + localNameLength,
        ),
        nameBytes,
      )
    ) {
      reject(`entry '${name}': the local header names a different entry.`);
    }
    if ((flags & 0x0008) === 0) {
      if (
        u32(localOffset + 14) !== crc ||
        u32(localOffset + 18) !== compressedSize ||
        u32(localOffset + 22) !== uncompressedSize
      ) {
        reject(
          `entry '${name}': local and central records disagree on CRC or sizes.`,
        );
      }
    }
    const dataStart =
      localOffset +
      LOCAL_FILE_HEADER_BYTES +
      localNameLength +
      localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      reject(
        `entry '${name}': data [${dataStart}, ${dataStart + compressedSize}) runs past the buffer — declared sizes are only acted on after this check.`,
      );
    }
    records.set(name, {
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      dataStart,
    });
  }
  if (cursor !== centralOffset + centralSize) {
    reject(
      `the central directory size ${centralSize} disagrees with the ${cursor - centralOffset} bytes of entries walked.`,
    );
  }

  const extract = (name: string): Uint8Array => {
    const record = records.get(name);
    if (record === undefined) {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.missingPart,
        `the package has no '${name}' entry.`,
      );
    }
    const stored = bytes.subarray(
      record.dataStart,
      record.dataStart + record.compressedSize,
    );
    let data: Uint8Array;
    if (record.method === 0) {
      if (record.compressedSize !== record.uncompressedSize) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.notAZip,
          `entry '${name}' is stored but declares compressed ${record.compressedSize} ≠ uncompressed ${record.uncompressedSize} bytes.`,
        );
      }
      data = stored;
    } else {
      if (record.uncompressedSize > THREE_MF_IMPORT_MAX_PART_BYTES) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.badCompression,
          `entry '${name}' declares ${record.uncompressedSize} uncompressed bytes, beyond the ${THREE_MF_IMPORT_MAX_PART_BYTES}-byte cap; refusing to inflate.`,
        );
      }
      try {
        data = inflateRawSync(stored, {
          maxOutputLength: record.uncompressedSize,
        });
      } catch (error) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.badCompression,
          `entry '${name}' cannot be inflated: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      if (data.length !== record.uncompressedSize) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.notAZip,
          `entry '${name}' inflates to ${data.length} bytes, not the declared ${record.uncompressedSize}.`,
        );
      }
    }
    if (crc32(data) !== record.crc) {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.crcMismatch,
        `entry '${name}' fails its CRC-32 check (header ${record.crc.toString(16)}, computed ${crc32(data).toString(16)}).`,
      );
    }
    return data;
  };

  return { extract };
}

// ---------------------------------------------------------------------------
// OPC parts
// ---------------------------------------------------------------------------

/** The content-type declarations of an OPC content-types stream. */
interface ContentTypes {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

/** Whether an element name is foreign (namespace-prefixed), not core OPC/3MF. */
function isPrefixedName(name: string): boolean {
  return name.includes(":");
}

/** Requires that `element`'s direct character data is nothing but whitespace. */
function requireBlankText(element: XmlElement, where: string): void {
  if (element.text.trim().length > 0) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `${where} must not carry character data ('${element.text.trim().slice(0, 24)}…').`,
    );
  }
}

/** Reads one required string attribute, rejecting on absence. */
function requiredAttribute(
  element: XmlElement,
  attributeName: string,
  where: string,
): string {
  const value = element.attributes.get(attributeName);
  if (value === undefined) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `${where} is missing its required '${attributeName}' attribute.`,
    );
  }
  return value;
}

/** Parses the OPC content-types stream into Default/Override declarations. */
function readContentTypes(xml: string): ContentTypes {
  const root = parseXmlDocument(xml);
  if (
    root.name !== "Types" ||
    root.attributes.get("xmlns") !== THREE_MF_CONTENT_TYPES_NAMESPACE
  ) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      "the content-types stream's root must be <Types> in the OPC content-types namespace.",
    );
  }
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const child of root.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name === "Default") {
      const extension = requiredAttribute(child, "Extension", "<Default>");
      const contentType = requiredAttribute(child, "ContentType", "<Default>");
      if (defaults.has(extension)) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          `the content-types stream declares Default extension '${extension}' twice.`,
        );
      }
      defaults.set(extension, contentType);
    } else if (child.name === "Override") {
      const partName = requiredAttribute(child, "PartName", "<Override>");
      const contentType = requiredAttribute(child, "ContentType", "<Override>");
      if (overrides.has(partName)) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          `the content-types stream overrides part '${partName}' twice.`,
        );
      }
      overrides.set(partName, contentType);
    } else {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.malformedXml,
        `<${child.name}> is not valid inside the content-types stream.`,
      );
    }
  }
  requireBlankText(root, "the content-types stream");
  return { defaults, overrides };
}

/** One parsed package relationship. */
interface PackageRelationship {
  readonly type: string;
  readonly target: string;
  readonly targetMode: string;
}

/** Parses `_rels/.rels` into its Relationship records. */
function readRelationships(xml: string): readonly PackageRelationship[] {
  const root = parseXmlDocument(xml);
  if (
    root.name !== "Relationships" ||
    root.attributes.get("xmlns") !== THREE_MF_RELATIONSHIPS_NAMESPACE
  ) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      "the relationships part's root must be <Relationships> in the OPC relationships namespace.",
    );
  }
  const relationships: PackageRelationship[] = [];
  const seenIds = new Set<string>();
  for (const child of root.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name !== "Relationship") {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.malformedXml,
        `<${child.name}> is not valid inside a relationships part.`,
      );
    }
    const id = requiredAttribute(child, "Id", "<Relationship>");
    if (seenIds.has(id)) {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.badRelationship,
        `relationship Id '${id}' is declared twice.`,
      );
    }
    seenIds.add(id);
    relationships.push({
      type: requiredAttribute(child, "Type", "<Relationship>"),
      target: requiredAttribute(child, "Target", "<Relationship>"),
      targetMode: child.attributes.get("TargetMode") ?? "Internal",
    });
  }
  requireBlankText(root, "the relationships part");
  return relationships;
}

/**
 * Resolves the 3D Model part name: the single 3MF Document StartPart
 * relationship's target, matched literally against entry names after
 * stripping one leading slash.
 */
function resolveModelPartName(
  relationships: readonly PackageRelationship[],
): string {
  const startPartRels = relationships.filter(
    (relationship) => relationship.type === THREE_MF_MODEL_RELATIONSHIP_TYPE,
  );
  const relationship = startPartRels[0];
  if (startPartRels.length === 0 || relationship === undefined) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.badRelationship,
      "the package relationships carry no 3MF Document StartPart relationship.",
    );
  }
  if (startPartRels.length > 1) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.badRelationship,
      `the package relationships carry ${startPartRels.length} 3MF Document StartPart relationships; exactly one is unambiguous.`,
    );
  }
  if (relationship.targetMode === "External") {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.badRelationship,
      `the 3MF Document StartPart targets the external URI '${relationship.target}' instead of a package part.`,
    );
  }
  const partName = relationship.target.startsWith("/")
    ? relationship.target.slice(1)
    : relationship.target;
  if (partName.length === 0) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.badRelationship,
      "the 3MF Document StartPart targets an empty part name.",
    );
  }
  return partName;
}

/** The effective OPC content type of `partName`, or `undefined` if undeclared. */
function effectiveContentType(
  contentTypes: ContentTypes,
  partName: string,
): string | undefined {
  const override =
    contentTypes.overrides.get(`/${partName}`) ??
    contentTypes.overrides.get(partName);
  if (override !== undefined) {
    return override;
  }
  const dot = partName.lastIndexOf(".");
  if (dot === -1 || dot === partName.length - 1) {
    return undefined;
  }
  return contentTypes.defaults.get(partName.slice(dot + 1));
}

// ---------------------------------------------------------------------------
// 3MF model interpretation
// ---------------------------------------------------------------------------

/** The interpreted core-model facts, geometry already in millimetres. */
interface InterpretedModel {
  readonly unit: ThreeMfUnit;
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly metadata: ThreeMfMetadata;
}

/** Reads one ST_Number coordinate attribute, rejecting lexical defects. */
function stNumberAttribute(
  element: XmlElement,
  attributeName: string,
  where: string,
): number {
  const token = element.attributes.get(attributeName);
  if (token === undefined || !ST_NUMBER_PATTERN.test(token)) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.countMismatch,
      `${where}: attribute '${attributeName}' is ${token === undefined ? "missing" : `not ST_Number decimal text ('${token}')`}.`,
    );
  }
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.nonFiniteVertex,
      `${where}: '${token}' parses to ${String(value)}.`,
    );
  }
  return value;
}

/** Reads one index attribute: lexical defects and value defects classified. */
function stIndexAttribute(
  element: XmlElement,
  attributeName: string,
  where: string,
): number {
  const token = element.attributes.get(attributeName);
  if (token === undefined || !ST_INTEGER_PATTERN.test(token)) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.countMismatch,
      `${where}: attribute '${attributeName}' is ${token === undefined ? "missing" : `not integer text ('${token}')`}.`,
    );
  }
  return Number(token);
}

/** Reads a required positive-integer attribute of a unique element. */
function positiveIntegerAttribute(
  element: XmlElement,
  attributeName: string,
  where: string,
): number {
  const token = requiredAttribute(element, attributeName, where);
  if (!ST_INTEGER_PATTERN.test(token)) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `${where}: attribute '${attributeName}' is not integer text ('${token}').`,
    );
  }
  const value = Number(token);
  if (value < 1) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `${where}: attribute '${attributeName}' is ${token}, not a positive integer.`,
    );
  }
  return value;
}

/** Interprets the parsed model root per the core single-object case. */
function interpretModel(root: XmlElement): InterpretedModel {
  const reject: (
    code: ThreeMfImportErrorCode,
    message: string,
  ) => never = (code, message) => {
    throw new ImportReject(code, message);
  };
  if (root.name !== "model") {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `the model part's root element is <${root.name}>, not <model>.`,
    );
  }
  if (root.attributes.get("xmlns") !== THREE_MF_CORE_NAMESPACE) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      "<model> must declare the 3MF core namespace as its default namespace (prefixed forms are rejected).",
    );
  }
  const requiredExtensions = root.attributes.get("requiredextensions");
  if (requiredExtensions !== undefined && requiredExtensions.trim() !== "") {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.unsupportedStructure,
      `the model requires extensions ('${requiredExtensions}') this importer does not implement.`,
    );
  }
  const unitToken = root.attributes.get("unit") ?? "millimeter";
  if (!isThreeMfUnit(unitToken)) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.invalidUnit,
      `<model unit> is '${unitToken}', not one of the ST_Unit values (micron, millimeter, centimeter, inch, foot, meter).`,
    );
  }
  const factor = THREE_MF_UNIT_TO_MILLIMETER_FACTORS[unitToken];

  // Model children in spec order: <metadata>*, <resources>, <build>?.
  let title: string | undefined;
  let designer: string | undefined;
  let description: string | undefined;
  const seenMetadataNames = new Set<string>();
  let resources: XmlElement | undefined;
  let build: XmlElement | undefined;
  for (const child of root.children) {
    if (isPrefixedName(child.name)) {
      continue; // foreign-namespace extension element
    }
    if (child.name === "metadata") {
      if (resources !== undefined || build !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          "<metadata> elements must precede <resources> and <build>.",
        );
      }
      const name = requiredAttribute(child, "name", "<metadata>");
      if (name.trim().length === 0) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          "<metadata> carries an empty name.",
        );
      }
      if (seenMetadataNames.has(name)) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          `<metadata name="${name}"> appears twice; the spec forbids duplicate names.`,
        );
      }
      seenMetadataNames.add(name);
      if (child.children.length > 0) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          `<metadata name="${name}"> must be text-only.`,
        );
      }
      const value = child.text.trim();
      if (name === "Title" && value.length > 0) {
        title = value;
      } else if (name === "Designer" && value.length > 0) {
        designer = value;
      } else if (name === "Description" && value.length > 0) {
        description = value;
      }
      continue;
    }
    if (child.name === "resources") {
      if (resources !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          "the model carries more than one <resources>.",
        );
      }
      if (build !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          "<resources> must precede <build>.",
        );
      }
      resources = child;
      continue;
    }
    if (child.name === "build") {
      if (build !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          "the model carries more than one <build>.",
        );
      }
      build = child;
      continue;
    }
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `<${child.name}> is not valid as a direct child of <model>.`,
    );
  }
  requireBlankText(root, "<model>");
  if (resources === undefined) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      "the model carries no <resources>.",
    );
  }

  // Resources: exactly one model-type object.
  let object: XmlElement | undefined;
  for (const child of resources.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name !== "object") {
      reject(
        THREE_MF_IMPORT_ERROR_CODES.malformedXml,
        `<${child.name}> is not valid inside <resources>.`,
      );
    }
    if (object !== undefined) {
      reject(
        THREE_MF_IMPORT_ERROR_CODES.unsupportedStructure,
        "the model defines multiple <object> resources; single-object import only.",
      );
    }
    object = child;
  }
  requireBlankText(resources, "<resources>");
  if (object === undefined) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      "<resources> defines no <object>.",
    );
  }
  const objectId = positiveIntegerAttribute(object, "id", "<object>");
  const objectType = object.attributes.get("type") ?? "model";
  if (objectType !== "model") {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.unsupportedStructure,
      `object ${objectId} has type '${objectType}'; only model-type objects are importable.`,
    );
  }

  let mesh: XmlElement | undefined;
  for (const child of object.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name === "mesh") {
      if (mesh !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          `object ${objectId} carries more than one <mesh>.`,
        );
      }
      mesh = child;
      continue;
    }
    if (child.name === "components") {
      reject(
        THREE_MF_IMPORT_ERROR_CODES.unsupportedStructure,
        `object ${objectId} is a components composite; component instancing is out of scope.`,
      );
    }
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `<${child.name}> is not valid inside <object>.`,
    );
  }
  requireBlankText(object, `<object id="${objectId}">`);
  if (mesh === undefined) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `object ${objectId} carries no <mesh>.`,
    );
  }

  // Mesh: <vertices> before <triangles>, both exactly once.
  let verticesElement: XmlElement | undefined;
  let trianglesElement: XmlElement | undefined;
  for (const child of mesh.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name === "vertices") {
      if (verticesElement !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          `object ${objectId}'s mesh carries more than one <vertices>.`,
        );
      }
      if (trianglesElement !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          "<vertices> must precede <triangles>.",
        );
      }
      verticesElement = child;
      continue;
    }
    if (child.name === "triangles") {
      if (trianglesElement !== undefined) {
        reject(
          THREE_MF_IMPORT_ERROR_CODES.malformedXml,
          `object ${objectId}'s mesh carries more than one <triangles>.`,
        );
      }
      trianglesElement = child;
      continue;
    }
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `<${child.name}> is not valid inside <mesh>.`,
    );
  }
  requireBlankText(mesh, `object ${objectId}'s <mesh>`);
  if (verticesElement === undefined || trianglesElement === undefined) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `object ${objectId}'s mesh must carry both <vertices> and <triangles>.`,
    );
  }

  // Vertices, converted to canonical millimetres as they are read.
  const positions: number[] = [];
  for (const child of verticesElement.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name !== "vertex") {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.countMismatch,
        `the <vertex> list holds a <${child.name}> element after ${positions.length / 3} vertices instead of a <vertex>.`,
      );
    }
    const where = `vertex ${positions.length / 3}`;
    for (const axis of ["x", "y", "z"] as const) {
      const value = stNumberAttribute(child, axis, where);
      const millimetres = factor === 1 ? value : value * factor;
      if (!Number.isFinite(millimetres)) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.nonFiniteVertex,
          `${where}: ${axis}='${value}' converts to infinity in millimetres.`,
        );
      }
      positions.push(millimetres);
    }
  }
  if (verticesElement.text.trim().length > 0) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.countMismatch,
      "<vertices> carries character data among its <vertex> elements.",
    );
  }
  const vertexCount = positions.length / 3;

  // Triangles: file winding untouched (CCW per spec — the kernel's rule).
  const indices: number[] = [];
  for (const child of trianglesElement.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name !== "triangle") {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.countMismatch,
        `the <triangle> list holds a <${child.name}> element after ${indices.length / 3} triangles instead of a <triangle>.`,
      );
    }
    const where = `triangle ${indices.length / 3}`;
    const v1 = stIndexAttribute(child, "v1", where);
    const v2 = stIndexAttribute(child, "v2", where);
    const v3 = stIndexAttribute(child, "v3", where);
    for (const [label, index] of [
      ["v1", v1],
      ["v2", v2],
      ["v3", v3],
    ] as const) {
      if (index < 0 || index >= vertexCount) {
        throw new ImportReject(
          THREE_MF_IMPORT_ERROR_CODES.degenerateIndex,
          `${where}: ${label}=${index} is outside the vertex range 0..${vertexCount - 1}.`,
        );
      }
    }
    if (v1 === v2 || v1 === v3 || v2 === v3) {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.degenerateIndex,
        `${where}: indices (${v1}, ${v2}, ${v3}) repeat a vertex; the spec requires them distinct.`,
      );
    }
    indices.push(v1, v2, v3);
  }
  if (trianglesElement.text.trim().length > 0) {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.countMismatch,
      "<triangles> carries character data among its <triangle> elements.",
    );
  }
  if (indices.length === 0) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.empty,
      "the mesh's <triangles> list is empty; there is no geometry to import.",
    );
  }

  // Build: exactly one untransformed item referencing the one object.
  if (build === undefined) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.empty,
      "the model carries no <build>; nothing is instantiated to import.",
    );
  }
  let item: XmlElement | undefined;
  for (const child of build.children) {
    if (isPrefixedName(child.name)) {
      continue;
    }
    if (child.name !== "item") {
      reject(
        THREE_MF_IMPORT_ERROR_CODES.malformedXml,
        `<${child.name}> is not valid inside <build>.`,
      );
    }
    if (item !== undefined) {
      reject(
        THREE_MF_IMPORT_ERROR_CODES.unsupportedStructure,
        "the build carries multiple <item>s; instancing is out of scope.",
      );
    }
    if (child.attributes.has("transform")) {
      reject(
        THREE_MF_IMPORT_ERROR_CODES.unsupportedStructure,
        "the build item carries a transform; transformed placement is out of scope.",
      );
    }
    item = child;
  }
  requireBlankText(build, "<build>");
  if (item === undefined) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.empty,
      "the build carries no <item>; nothing is instantiated to import.",
    );
  }
  const itemObjectId = positiveIntegerAttribute(item, "objectid", "<item>");
  if (itemObjectId !== objectId) {
    reject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `the build item references objectid ${itemObjectId}, but the only object resource has id ${objectId}.`,
    );
  }

  return {
    unit: unitToken,
    positions,
    indices,
    metadata: { ...(title === undefined ? {} : { title }), ...(designer === undefined ? {} : { designer }), ...(description === undefined ? {} : { description }) },
  };
}

/** Decodes part bytes as strict UTF-8, rejecting invalid encodings. */
function decodePartUtf8(data: Uint8Array, partName: string): string {
  try {
    return utf8Decoder.decode(data);
  } catch {
    throw new ImportReject(
      THREE_MF_IMPORT_ERROR_CODES.malformedXml,
      `part '${partName}' is not valid UTF-8.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Imports `bytes` as a 3MF document (an OPC ZIP package — see the module
 * header for exactly what is accepted) into an {@link ImportedThreeMfMesh}:
 * the mesh in canonical millimetres, the declared unit, and the well-known
 * metadata. Deterministic, and total: any byte input either imports or
 * fails with a structured `three-mf-import/*` code — never a throw.
 */
export function importThreeMf(bytes: Uint8Array): ThreeMfImportResult {
  if (bytes.byteLength === 0) {
    return fail({
      code: THREE_MF_IMPORT_ERROR_CODES.empty,
      message:
        "The input is empty (0 bytes); there is no 3MF package to import.",
      input: bytes,
    });
  }
  try {
    const zip = readZipIndex(bytes);
    const contentTypes = readContentTypes(
      decodePartUtf8(
        zip.extract(THREE_MF_CONTENT_TYPES_PART_NAME),
        THREE_MF_CONTENT_TYPES_PART_NAME,
      ),
    );
    const relationships = readRelationships(
      decodePartUtf8(
        zip.extract(THREE_MF_RELS_PART_NAME),
        THREE_MF_RELS_PART_NAME,
      ),
    );
    const modelPartName = resolveModelPartName(relationships);
    const declaredType = effectiveContentType(contentTypes, modelPartName);
    if (declaredType !== THREE_MF_MODEL_CONTENT_TYPE) {
      throw new ImportReject(
        THREE_MF_IMPORT_ERROR_CODES.invalidContentType,
        `part '${modelPartName}' is declared as '${declaredType ?? "no content type"}', not the 3MF model content type '${THREE_MF_MODEL_CONTENT_TYPE}'.`,
      );
    }
    const model = interpretModel(
      parseXmlDocument(
        decodePartUtf8(zip.extract(modelPartName), modelPartName),
      ),
    );
    return ok({
      tessellation: {
        positions: model.positions,
        indices: model.indices,
      },
      units: model.unit,
      metadata: model.metadata,
    });
  } catch (error) {
    if (error instanceof ImportReject) {
      return fail({ code: error.code, message: error.message, input: bytes });
    }
    throw error;
  }
}
