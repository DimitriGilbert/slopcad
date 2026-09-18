/**
 * STL import (Phase 18.2): parses untrusted bytes — the raw content of an
 * `.stl` file — into an {@link ImportedStlMesh}, a kernel-neutral
 * {@link Tessellation} plus a provenance flag for which STL flavor was
 * found. The inverse of `./stl-export` at the semantic level: triangle
 * count, corner order, vertex values (float32 tolerance), bounds, and
 * enclosed volume all survive the export → import round trip.
 *
 * ## Format detection (structural, never the `"solid"` prefix)
 *
 * The ASCII flavor "must" start with the keyword `solid`, but plenty of
 * real binary files start with the bytes `solid` too (sloppy writers put it
 * in the header), so the prefix alone proves nothing. Detection is
 * structural, in this exact order:
 *
 * 1. **Binary frame, exact**: length ≥ 84 and
 *    `length === 84 + 50 × uint32le(count at offset 80)` → binary. This is
 *    the only positive binary test, and it doubles as the allocation guard
 *    (below).
 * 2. **ASCII**: the buffer decodes entirely as 7-bit printable text (bytes
 *    0x09/0x0A/0x0D/0x20–0x7E) and its first word is the lowercase
 *    `solid` keyword → strict grammar parse. Anything that decodes as text
 *    but does not open with `solid` is `stl-import/wrong-encoding`.
 * 3. **Failure classification** for input that is neither: bytes that
 *    cannot be ASCII are diagnosed against the binary frame the header
 *    always forms — shorter than the declared payload →
 *    `stl-import/truncated`, longer → `stl-import/count-mismatch`. A
 *    byte-order mark (UTF-8 `EF BB BF` or UTF-16LE `FF FE` followed by an
 *    encoded `solid`) is reported as `stl-import/wrong-encoding`, because
 *    ASCII STL is 7-bit text without a BOM.
 *
 * Edge cases, documented: an adversarial text file whose byte length and
 * `uint32` at offset 80 happen to satisfy rule 1 is read as binary — such a
 * file is simultaneously a well-formed binary STL, and rule 1 must run
 * first precisely because real binary files may carry `solid` headers.
 * Conversely, random non-text garbage is always reported as a binary frame
 * defect (truncated/count-mismatch) since non-text bytes cannot be ASCII
 * STL and the 84-byte frame "parses" for any length ≥ 84.
 *
 * ## Allocation guard
 *
 * `count` is trusted only after the exact structural equality in rule 1,
 * and failure classification compares plain numbers. A count field claiming
 * `0xFFFFFFFF` (~214 GB of triangles) therefore fails a length comparison
 * before any array is allocated — the importer never pre-allocates from an
 * untrusted count.
 *
 * ## No parametric history fabrication
 *
 * STL carries a triangle soup and nothing else: no units, no features, no
 * parameters, no construction history. The success type is named
 * {@link ImportedStlMesh} to make mesh-body semantics explicit, and its
 * payload is exactly a tessellation plus the detected flavor — this module
 * constructs no document, feature, parameter, or solid, and imports
 * nothing from cad-core's document machinery, so there is no API surface
 * through which invented history could leak. Callers turn the soup into
 * document bodies; that act (and its explicit "imported mesh" provenance)
 * belongs to the app layer, not the format adapter.
 *
 * ## Representation conventions
 *
 * - **Units** — STL is unitless; coordinates import unchanged as the
 *   canonical millimetres the exporter writes. Consumers assume mm.
 * - **Soup shape** — STL has no vertex-sharing information, so the import
 *   is an unshared triangle soup: three fresh position triples per facet,
 *   sequential indices `0..3n−1`. Welding vertices is a consumer decision.
 * - **Normals** — the file's facet normals are imported as per-corner
 *   vertex normals (the contract's per-vertex shape) *only when every
 *   facet's normal is finite and unit-length within
 *   {@link STL_IMPORT_NORMAL_UNIT_TOLERANCE}; otherwise the normals field
 *   is omitted entirely — the STL-sanctioned "receiver computes it"
 *   convention for zero normals, extended honestly to non-unit ones. All
 *   or nothing: partial normals are never emitted and none are ever
 *   synthesized.
 * - **Determinism** — same bytes in, identical tessellation out: one pass,
 *   fixed order, no hash tables, no time or randomness.
 * - **Attribute bytes** — the per-triangle `uint16` attribute byte count
 *   of binary STL is parsed past and ignored (the kernel contract has no
 *   per-facet attributes to receive it).
 *
 * ## Failure discipline
 *
 * The bytes arrive across a trust boundary, so no byte input throws: every
 * defect — empty input, truncated or count-mismatched binary frames, ASCII
 * grammar violations, non-finite coordinates in either flavor, wrong
 * encodings — is a structured {@link StlImportError} on the cad-core
 * `ParseResult` discipline with a stable `stl-import/*` code.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

import {
  STL_HEADER_BYTES,
  STL_MIN_BYTES,
  STL_TRIANGLE_BYTES,
} from "./stl-export";

/** Stable failure codes produced when STL import rejects its input. */
export const STL_IMPORT_ERROR_CODES = {
  /** Zero-byte input, or an STL that declares no triangles at all. */
  empty: "stl-import/empty",
  /** A binary frame carrying fewer bytes than its triangle count declares. */
  truncated: "stl-import/truncated",
  /** A binary frame carrying more bytes than its triangle count declares. */
  countMismatch: "stl-import/count-mismatch",
  /** Decodable ASCII STL text that violates the facet grammar. */
  asciiSyntax: "stl-import/ascii-syntax",
  /** A coordinate or normal that parses to NaN/Infinity in either flavor. */
  nonFiniteValue: "stl-import/non-finite-value",
  /** Bytes that are neither binary STL nor ASCII STL text. */
  wrongEncoding: "stl-import/wrong-encoding",
} as const;

export type StlImportErrorCode =
  (typeof STL_IMPORT_ERROR_CODES)[keyof typeof STL_IMPORT_ERROR_CODES];

/** Structured failure describing why STL import rejected some bytes. */
export interface StlImportError extends ParseFailure {
  readonly code: StlImportErrorCode;
}

/** Which STL flavor the bytes were detected as. */
export type StlImportFlavor = "binary" | "ascii";

/**
 * The successful result of importing an STL file: a mesh body's triangle
 * soup plus the detected flavor. Named for imported-mesh semantics — an
 * imported STL is a mesh, never a parametric document (see the module
 * header's no-fabrication rule).
 */
export interface ImportedStlMesh {
  readonly tessellation: Tessellation;
  readonly flavor: StlImportFlavor;
}

/** The result of STL import: an imported mesh, or a structured failure. */
export type StlImportResult = ParseResult<ImportedStlMesh, StlImportError>;

/**
 * How far an imported facet normal may deviate from unit length and still
 * be imported: binary normals are float32 and ASCII ones decimal text, so
 * 0.1% is rounding noise while genuinely corrupt normals are omitted.
 * Mirrors the tolerance the kernel contract and the render projection
 * apply, so an imported normal passes every downstream consumer unchanged.
 */
export const STL_IMPORT_NORMAL_UNIT_TOLERANCE = 1e-3;

function stlError(
  code: StlImportErrorCode,
  message: string,
  bytes: Uint8Array,
): StlImportError {
  return { code, message, input: bytes };
}

/** The exact byte length a binary STL with `count` triangles must have. */
function binaryFrameBytes(count: number): number {
  return STL_MIN_BYTES + STL_TRIANGLE_BYTES * count;
}

// ---------------------------------------------------------------------------
// Text sniffing
// ---------------------------------------------------------------------------

/**
 * Whether every byte decodes as 7-bit printable text (0x09, 0x0A, 0x0D,
 * 0x20–0x7E) — the character set well-formed ASCII STL lives in. Bytes
 * outside it rule out the ASCII flavor outright.
 */
function isDecodableAsciiText(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (!(
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e)
    )) {
      return false;
    }
  }
  return true;
}

/** Decodes already-validated printable bytes to a string, chunked. */
function decodeAsciiBytes(bytes: Uint8Array): string {
  let text = "";
  const chunkSize = 0x2000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    text += String.fromCharCode(...bytes.subarray(i, end));
  }
  return text;
}

/** The first whitespace-delimited word of `text`, or `""` for blank text. */
function firstWord(text: string): string {
  const match = /\S+/.exec(text);
  return match === null ? "" : (match[0] ?? "");
}

/** Whether the bytes open with a UTF-8 BOM before ASCII STL text. */
function hasUtf8BomSolid(bytes: Uint8Array): boolean {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xef ||
    bytes[1] !== 0xbb ||
    bytes[2] !== 0xbf
  ) {
    return false;
  }
  const rest = bytes.subarray(3);
  return (
    isDecodableAsciiText(rest) && firstWord(decodeAsciiBytes(rest)) === "solid"
  );
}

/** Whether the bytes open with a UTF-16LE BOM before a UTF-16 `solid`. */
function hasUtf16LeBomSolid(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xfe) {
    return false;
  }
  const solidUtf16Le = [
    0x73, 0x00, 0x6f, 0x00, 0x6c, 0x00, 0x69, 0x00, 0x64, 0x00,
  ];
  return solidUtf16Le.every((byte, i) => bytes[i + 2] === byte);
}

// ---------------------------------------------------------------------------
// Output assembly
// ---------------------------------------------------------------------------

/** Sequential indices `0 .. vertexCount-1` — the unshared soup shape. */
function sequentialIndices(vertexCount: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < vertexCount; i += 1) {
    indices.push(i);
  }
  return indices;
}

/**
 * Assembles the {@link ImportedStlMesh} from accumulated per-corner
 * positions and the per-facet normals, applying the documented all-or-
 * nothing normals rule.
 */
function assembleMesh(
  positions: number[],
  facetNormals: number[],
  normalsUsable: boolean,
  flavor: StlImportFlavor,
): StlImportResult {
  const indices = sequentialIndices(positions.length / 3);
  const tessellation: Tessellation = normalsUsable
    ? { positions, indices, normals: facetNormals }
    : { positions, indices };
  return ok({ tessellation, flavor });
}

// ---------------------------------------------------------------------------
// Binary flavor
// ---------------------------------------------------------------------------

/**
 * Parses an exact-length-validated binary frame: `count` records of 12
 * little-endian float32s (facet normal, three vertices) plus an ignored
 * `uint16` attribute count. Non-finite floats reject the whole file; the
 * facet normal feeds the all-or-nothing vertex normals.
 */
function importBinary(
  bytes: Uint8Array,
  view: DataView,
  triangleCount: number,
): StlImportResult {
  const positions: number[] = [];
  const normals: number[] = [];
  let normalsUsable = true;
  for (let t = 0; t < triangleCount; t += 1) {
    const base = STL_MIN_BYTES + STL_TRIANGLE_BYTES * t;
    const floats: number[] = [];
    for (let f = 0; f < 12; f += 1) {
      const value = view.getFloat32(base + 4 * f, true);
      if (!Number.isFinite(value)) {
        const role =
          f < 3
            ? `normal component ${f}`
            : `vertex ${Math.floor((f - 3) / 3)} component ${(f - 3) % 3}`;
        return fail(
          stlError(
            STL_IMPORT_ERROR_CODES.nonFiniteValue,
            `Binary STL triangle ${t} ${role} is ${String(value)}.`,
            bytes,
          ),
        );
      }
      floats.push(value);
    }
    positions.push(
      floats[3] ?? 0,
      floats[4] ?? 0,
      floats[5] ?? 0,
      floats[6] ?? 0,
      floats[7] ?? 0,
      floats[8] ?? 0,
      floats[9] ?? 0,
      floats[10] ?? 0,
      floats[11] ?? 0,
    );
    if (normalsUsable) {
      const nx = floats[0] ?? 0;
      const ny = floats[1] ?? 0;
      const nz = floats[2] ?? 0;
      const length = Math.hypot(nx, ny, nz);
      if (Math.abs(length - 1) <= STL_IMPORT_NORMAL_UNIT_TOLERANCE) {
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      } else {
        normalsUsable = false;
      }
    }
  }
  return assembleMesh(positions, normals, normalsUsable, "binary");
}

// ---------------------------------------------------------------------------
// ASCII flavor
// ---------------------------------------------------------------------------

/**
 * A strict decimal number token: optional sign, digits with optional
 * fraction point, optional exponent. Rejects `nan`/`inf`/`1abc` as syntax
 * before `parseFloat` ever sees them; only exponent overflow (`1e999`)
 * parses and then fails the finiteness check.
 */
const ASCII_NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** One non-blank line, pre-split into whitespace-delimited tokens. */
interface AsciiLine {
  readonly lineNumber: number;
  readonly tokens: readonly string[];
}

/** Splits text into lines, dropping blanks, keeping 1-based line numbers. */
function significantLines(text: string): AsciiLine[] {
  const lines: AsciiLine[] = [];
  const rawLines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < rawLines.length; i += 1) {
    const trimmed = (rawLines[i] ?? "").trim();
    if (trimmed.length === 0) {
      continue;
    }
    lines.push({ lineNumber: i + 1, tokens: trimmed.split(/\s+/) });
  }
  return lines;
}

/** Parses one numeric token of an STL line, failing with the right code. */
function asciiNumber(
  tokens: readonly string[],
  offset: number,
  lineNumber: number,
  context: string,
  bytes: Uint8Array,
): ParseResult<number, StlImportError> {
  const token = tokens[offset];
  if (token === undefined || !ASCII_NUMBER_PATTERN.test(token)) {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.asciiSyntax,
        `${context} token "${String(token)}" is not a decimal number (line ${lineNumber}).`,
        bytes,
      ),
    );
  }
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.nonFiniteValue,
        `${context} token "${token}" parses to ${String(value)} (line ${lineNumber}).`,
        bytes,
      ),
    );
  }
  return ok(value);
}

/** Parses the three numeric tokens at `offset` as an xyz triple. */
function asciiTriple(
  tokens: readonly string[],
  offset: number,
  lineNumber: number,
  context: string,
  bytes: Uint8Array,
): ParseResult<readonly [number, number, number], StlImportError> {
  const x = asciiNumber(tokens, offset, lineNumber, context, bytes);
  if (!x.ok) return x;
  const y = asciiNumber(tokens, offset + 1, lineNumber, context, bytes);
  if (!y.ok) return y;
  const z = asciiNumber(tokens, offset + 2, lineNumber, context, bytes);
  if (!z.ok) return z;
  return ok([x.value, y.value, z.value]);
}

/**
 * Parses validated ASCII STL text under the strict grammar
 * `solid [name] (facet normal <n> / outer loop / vertex×3 / endloop /
 * endfacet)* endsolid [name]` — keywords lowercase and case-sensitive per
 * the de-facto standard, names free text, one solid per file (mirroring
 * the exporter's one-solid-per-file scope).
 */
function importAscii(bytes: Uint8Array, text: string): StlImportResult {
  const lines = significantLines(text);
  const syntax = (lineNumber: number, message: string): StlImportResult =>
    fail(
      stlError(
        STL_IMPORT_ERROR_CODES.asciiSyntax,
        `${message} (line ${lineNumber}).`,
        bytes,
      ),
    );

  const first = lines[0];
  if (first === undefined || first.tokens[0] !== "solid") {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.wrongEncoding,
        'ASCII STL must open with the lowercase "solid" keyword.',
        bytes,
      ),
    );
  }

  const positions: number[] = [];
  const normals: number[] = [];
  let normalsUsable = true;
  let facets = 0;
  let cursor = 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined) {
      break;
    }
    cursor += 1;
    const keyword = line.tokens[0];

    if (keyword === "endsolid") {
      if (cursor < lines.length) {
        const next = lines[cursor];
        return syntax(
          next?.lineNumber ?? line.lineNumber,
          'Unexpected content after "endsolid"; ASCII STL carries one solid per file',
        );
      }
      if (facets === 0) {
        return fail(
          stlError(
            STL_IMPORT_ERROR_CODES.empty,
            "ASCII STL declares no facets; there are no triangles to import.",
            bytes,
          ),
        );
      }
      return assembleMesh(positions, normals, normalsUsable, "ascii");
    }

    if (keyword !== "facet") {
      return syntax(
        line.lineNumber,
        `Unexpected keyword "${String(keyword)}"; expected "facet" or "endsolid"`,
      );
    }
    if (line.tokens[1] !== "normal" || line.tokens.length !== 5) {
      return syntax(
        line.lineNumber,
        'A facet must open as "facet normal <nx> <ny> <nz>"',
      );
    }
    const normal = asciiTriple(
      line.tokens,
      2,
      line.lineNumber,
      "A facet normal",
      bytes,
    );
    if (!normal.ok) return normal;

    const loop = lines[cursor];
    cursor += 1;
    if (
      loop === undefined ||
      loop.tokens.length !== 2 ||
      loop.tokens[0] !== "outer" ||
      loop.tokens[1] !== "loop"
    ) {
      return syntax(
        loop?.lineNumber ?? line.lineNumber,
        'A facet must contain one "outer loop"',
      );
    }

    for (let corner = 0; corner < 3; corner += 1) {
      const vertexLine = lines[cursor];
      cursor += 1;
      if (
        vertexLine === undefined ||
        vertexLine.tokens[0] !== "vertex" ||
        vertexLine.tokens.length !== 4
      ) {
        return syntax(
          vertexLine?.lineNumber ?? loop.lineNumber,
          'A loop must contain exactly three "vertex <x> <y> <z>" lines',
        );
      }
      const vertex = asciiTriple(
        vertexLine.tokens,
        1,
        vertexLine.lineNumber,
        "A vertex",
        bytes,
      );
      if (!vertex.ok) return vertex;
      positions.push(vertex.value[0], vertex.value[1], vertex.value[2]);
    }

    const endLoop = lines[cursor];
    cursor += 1;
    if (endLoop === undefined || endLoop.tokens[0] !== "endloop") {
      return syntax(
        endLoop?.lineNumber ?? loop.lineNumber,
        'A loop must close with "endloop"',
      );
    }
    const endFacet = lines[cursor];
    cursor += 1;
    if (endFacet === undefined || endFacet.tokens[0] !== "endfacet") {
      return syntax(
        endFacet?.lineNumber ?? endLoop.lineNumber,
        'A facet must close with "endfacet"',
      );
    }

    if (normalsUsable) {
      const [nx, ny, nz] = normal.value;
      const length = Math.hypot(nx, ny, nz);
      if (Math.abs(length - 1) <= STL_IMPORT_NORMAL_UNIT_TOLERANCE) {
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      } else {
        normalsUsable = false;
      }
    }
    facets += 1;
  }

  return syntax(
    lines[lines.length - 1]?.lineNumber ?? 0,
    'ASCII STL must close with "endsolid"',
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Imports `bytes` as an STL file (binary or ASCII, detected structurally —
 * see the module header) into an {@link ImportedStlMesh}: an unshared
 * triangle soup in canonical millimetres with all-or-nothing imported
 * normals. Deterministic, and total: any byte input either imports or
 * fails with a structured `stl-import/*` code — never a throw.
 */
export function importStl(bytes: Uint8Array): StlImportResult {
  if (bytes.byteLength === 0) {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.empty,
        "The input is empty (0 bytes); there is no STL to import.",
        bytes,
      ),
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Rule 1 — the exact binary frame. The equality is also the allocation
  // guard: an untrusted count is only ever acted on after it has been
  // reconciled with the actual byte length, in plain-number arithmetic.
  if (bytes.byteLength >= STL_MIN_BYTES) {
    const triangleCount = view.getUint32(STL_HEADER_BYTES, true);
    if (bytes.byteLength === binaryFrameBytes(triangleCount)) {
      if (triangleCount === 0) {
        return fail(
          stlError(
            STL_IMPORT_ERROR_CODES.empty,
            "Binary STL declares zero triangles; there are no facets to import.",
            bytes,
          ),
        );
      }
      return importBinary(bytes, view, triangleCount);
    }
  }

  // Rule 2 — ASCII text opening with the `solid` keyword.
  if (isDecodableAsciiText(bytes)) {
    const text = decodeAsciiBytes(bytes);
    if (firstWord(text) === "solid") {
      return importAscii(bytes, text);
    }
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.wrongEncoding,
        'The input decodes as text but does not open with the ASCII STL "solid" keyword.',
        bytes,
      ),
    );
  }

  // Rule 3 — neither flavor: classify the failure against the binary frame.
  if (hasUtf8BomSolid(bytes)) {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.wrongEncoding,
        "The input carries a UTF-8 byte-order mark before otherwise-valid ASCII STL; ASCII STL is 7-bit text without a BOM.",
        bytes,
      ),
    );
  }
  if (hasUtf16LeBomSolid(bytes)) {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.wrongEncoding,
        "The input carries a UTF-16LE byte-order mark; ASCII STL is 7-bit text without a BOM.",
        bytes,
      ),
    );
  }
  if (bytes.byteLength < STL_MIN_BYTES) {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.truncated,
        `The input is ${bytes.byteLength} bytes — shorter than the ${STL_MIN_BYTES}-byte binary STL frame — and the bytes are not ASCII STL text.`,
        bytes,
      ),
    );
  }
  const triangleCount = view.getUint32(STL_HEADER_BYTES, true);
  const declaredBytes = binaryFrameBytes(triangleCount);
  if (bytes.byteLength < declaredBytes) {
    return fail(
      stlError(
        STL_IMPORT_ERROR_CODES.truncated,
        `Binary STL declares ${triangleCount} triangles (${declaredBytes} bytes) but the input carries only ${bytes.byteLength}.`,
        bytes,
      ),
    );
  }
  return fail(
    stlError(
      STL_IMPORT_ERROR_CODES.countMismatch,
      `Binary STL declares ${triangleCount} triangles (${declaredBytes} bytes) but the input carries ${bytes.byteLength} — ${bytes.byteLength - declaredBytes} bytes more than declared.`,
      bytes,
    ),
  );
}
