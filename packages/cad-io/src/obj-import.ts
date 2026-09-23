/**
 * Wavefront OBJ import (Phase 56): parses untrusted ASCII `.obj` bytes —
 * the fixed subset of the format this codebase exchanges — into the
 * kernel contract's {@link Tessellation} in canonical millimetres, plus
 * the honest provenance the subset discipline owes the caller.
 *
 * ## Pinned subset (the honesty boundary)
 *
 * - **`v x y z [w]`** — geometry vertices. An optional fourth rational
 *   weight must be `1` (the only value that leaves `x y z` the actual
 *   position); any other weight is a whole-file failure
 *   (`obj-import/rational-vertex`) — dividing through would silently
 *   rewrite coordinates the caller did not author.
 * - **`f`** — faces with 3+ vertices, tokens in all four OBJ spellings
 *   (`i`, `i/j`, `i//k`, `i/j/k`): only the position index is geometry;
 *   `vt`/`vn` slots are ignored. Polygons fan-triangulate deterministically
 *   around vertex 0 — `(v0, vi, vi+1)` — the standard mesh-import
 *   convention, valid for the convex polygons OBJ files actually carry.
 *   Negative indices are the spec's relative addressing (`-1` = most
 *   recent vertex) and resolve exactly. Fewer than 3 vertices, an
 *   out-of-range index (either sign, after resolution), or a non-integer
 *   slot is a whole-file failure: the file claimed well-formed geometry
 *   and was not — a trust-boundary defect, not a scope boundary.
 * - **`o` / `g`** — the first one names the imported object in
 *   {@link ImportedObjMesh.name}; later ones are recorded as
 *   `keyword-out-of-subset` declines (multi-object files import their
 *   geometry merged, and the provenance says so).
 * - **Everything else** (`vn`, `vt`, `mtllib`, `usemtl`, `s`, `l`, `p`,
 *   `vp`, `curv`, …) is recorded in {@link ImportedObjMesh.declined} with
 *   its keyword and a `keyword-out-of-subset` reason — never silently
 *   dropped — and the rest of the file imports. `vn`/`vt` declines are
 *   the import-side half of the exporter's documented "positions only"
 *   convention.
 *
 * ## Units and framing
 *
 * OBJ is unitless; coordinates import 1:1 as canonical millimetres — the
 * documented convention, matching the exporter, not a detection. Lines
 * may end LF or CRLF; `#` comments and blank lines are skipped. Any byte
 * that is not ASCII text fails (`obj-import/binary-unsupported`): OBJ has
 * no sanctioned binary form. No byte input throws: empty input, binary
 * bytes, unknown keywords where a value line must start, and the
 * in-subset defects above all fail with a structured `obj-import/*` code
 * on the cad-core `ParseResult` discipline. Deterministic: one pass,
 * fixed order, no time, no randomness.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

/** Stable failure codes produced when OBJ import rejects its input. */
export const OBJ_IMPORT_ERROR_CODES = {
  empty: "obj-import/empty",
  binaryUnsupported: "obj-import/binary-unsupported",
  notObj: "obj-import/not-obj",
  syntax: "obj-import/syntax",
  rationalVertex: "obj-import/rational-vertex",
  indexOutOfRange: "obj-import/index-out-of-range",
} as const;

export type ObjImportErrorCode =
  (typeof OBJ_IMPORT_ERROR_CODES)[keyof typeof OBJ_IMPORT_ERROR_CODES];

/** Structured failure describing why OBJ import rejected some bytes. */
export interface ObjImportError extends ParseFailure {
  readonly code: ObjImportErrorCode;
}

/** One keyword the pinned subset does not consume, recorded instead. */
export interface ObjDeclinedKeyword {
  readonly keyword: string;
  readonly reason: "keyword-out-of-subset";
}

/** The successful result of importing an OBJ file. */
export interface ImportedObjMesh {
  /** The first `o`/`g` name, or null when the file names no object. */
  readonly name: string | null;
  readonly tessellation: Tessellation;
  /** OBJ is unitless; this importer's convention is 1:1 millimetres. */
  readonly units: "mm";
  readonly declined: readonly ObjDeclinedKeyword[];
}

/** The result of OBJ import: an imported mesh, or a structured failure. */
export type ObjImportResult = ParseResult<ImportedObjMesh, ObjImportError>;

function objError(
  code: ObjImportErrorCode,
  message: string,
  bytes: Uint8Array,
): ObjImportError {
  return { code, message, input: bytes };
}

/** Whether every byte is text ASCII OBJ can carry (printable, tab, CR/LF). */
function isDecodableText(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** OBJ double reader: decimal/exponent forms, finiteness enforced. */
function readDouble(token: string): number | null {
  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) ? parsed : null;
}

/** OBJ index reader: base-1 integers, negative meaning relative. */
function readIndex(token: string): number | null {
  if (!/^-?\d+$/.test(token)) return null;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Splits the first `/`-separated slot off an `f` token (`i/j/k` → `i`). */
function positionSlot(token: string): number | null {
  return readIndex(token.split("/", 1)[0] ?? token);
}

/**
 * Imports `bytes` as an ASCII OBJ file into an {@link ImportedObjMesh}.
 * Total over byte inputs: either imports or fails with a structured
 * `obj-import/*` code — never a throw. Deterministic: one pass, fixed
 * order, no time, no randomness.
 */
export function importObj(bytes: Uint8Array): ObjImportResult {
  if (bytes.byteLength === 0) {
    return fail(
      objError(
        OBJ_IMPORT_ERROR_CODES.empty,
        "The input is empty (0 bytes); there is no OBJ to import.",
        bytes,
      ),
    );
  }
  if (!isDecodableText(bytes)) {
    return fail(
      objError(
        OBJ_IMPORT_ERROR_CODES.binaryUnsupported,
        "The input carries bytes no ASCII OBJ can; this importer reads ASCII OBJ only.",
        bytes,
      ),
    );
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const declinedMap = new Map<string, ObjDeclinedKeyword>();
  let name: string | null = null;

  const lines = new TextDecoder("latin1").decode(bytes).split(/\r\n|\r|\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const spaceAt = trimmed.search(/\s/);
    const keyword = (
      spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)
    ).toLowerCase();
    const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();

    if (keyword === "v") {
      const tokens = rest.split(/\s+/);
      if (tokens.length < 3 || tokens.length > 4) {
        return fail(
          objError(
            OBJ_IMPORT_ERROR_CODES.syntax,
            `A v line needs 3 (or 4 rational) coordinates, found ${String(tokens.length)}: ${JSON.stringify(trimmed.slice(0, 64))}.`,
            bytes,
          ),
        );
      }
      const coords = tokens.slice(0, 3).map((token) => readDouble(token));
      if (coords.some((value) => value === null)) {
        return fail(
          objError(
            OBJ_IMPORT_ERROR_CODES.syntax,
            `A v line carries a non-finite coordinate: ${JSON.stringify(trimmed.slice(0, 64))}.`,
            bytes,
          ),
        );
      }
      if (tokens.length === 4) {
        const weight = readDouble(tokens[3] ?? "");
        if (weight !== 1) {
          return fail(
            objError(
              OBJ_IMPORT_ERROR_CODES.rationalVertex,
              `A v line declares rational weight ${tokens[3] ?? ""}; only weight 1 (plain coordinates) is in the pinned subset.`,
              bytes,
            ),
          );
        }
      }
      positions.push(coords[0] ?? 0, coords[1] ?? 0, coords[2] ?? 0);
      continue;
    }

    if (keyword === "f") {
      const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
      if (tokens.length < 3) {
        return fail(
          objError(
            OBJ_IMPORT_ERROR_CODES.syntax,
            `An f line needs at least 3 vertices, found ${String(tokens.length)}: ${JSON.stringify(trimmed.slice(0, 64))}.`,
            bytes,
          ),
        );
      }
      const face: number[] = [];
      for (const token of tokens) {
        const slot = positionSlot(token);
        if (slot === null) {
          return fail(
            objError(
              OBJ_IMPORT_ERROR_CODES.syntax,
              `An f vertex slot is not an integer index: ${JSON.stringify(token)} in ${JSON.stringify(trimmed.slice(0, 64))}.`,
              bytes,
            ),
          );
        }
        const resolved = slot > 0 ? slot - 1 : positions.length / 3 + slot;
        if (
          !Number.isInteger(resolved) ||
          resolved < 0 ||
          resolved >= positions.length / 3
        ) {
          return fail(
            objError(
              OBJ_IMPORT_ERROR_CODES.indexOutOfRange,
              `An f vertex index ${JSON.stringify(token)} resolves to ${String(resolved)}, outside the ${String(positions.length / 3)} vertices read so far.`,
              bytes,
            ),
          );
        }
        face.push(resolved);
      }
      for (let i = 1; i + 1 < face.length; i += 1) {
        indices.push(face[0] ?? 0, face[i] ?? 0, face[i + 1] ?? 0);
      }
      continue;
    }

    if (keyword === "o" || keyword === "g") {
      if (name === null) {
        name = rest.length > 0 ? rest : null;
      } else {
        declinedMap.set(keyword, { keyword, reason: "keyword-out-of-subset" });
      }
      continue;
    }

    if (!declinedMap.has(keyword)) {
      declinedMap.set(keyword, { keyword, reason: "keyword-out-of-subset" });
    }
  }

  if (positions.length === 0 || indices.length === 0) {
    return fail(
      objError(
        OBJ_IMPORT_ERROR_CODES.notObj,
        "The file carries no v/f geometry; it is not an importable OBJ mesh.",
        bytes,
      ),
    );
  }

  return ok({
    name,
    tessellation: { positions, indices },
    units: "mm",
    declined: [...declinedMap.values()],
  });
}
