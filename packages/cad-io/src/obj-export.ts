/**
 * Wavefront OBJ export (Phase 56): serializes the kernel contract's
 * {@link Tessellation} — the kernel-neutral indexed triangle soup in
 * canonical millimetres — into deterministic ASCII OBJ bytes.
 *
 * ## Conventions
 *
 * - **Units** — OBJ is unitless. Coordinates are written unchanged in the
 *   kernel contract's canonical millimetres; consumers importing the file
 *   must assume mm (the importer in `./obj-import` does exactly that).
 * - **Geometry** — one `v` line per distinct position triple, in soup
 *   order, and one `f` line per triangle, `f a b c` with 1-based indices
 *   in the soup's index order: triangle `t` is
 *   `[indices[3t], indices[3t+1], indices[3t+2]]`. No deduplication, no
 *   re-indexing, no reordering — the same soup yields the same bytes on
 *   every call.
 * - **Number format** — fixed six-decimal text (`n.toFixed(6)`), with
 *   negative zero normalized to `0.000000`: six decimals round at
 *   nanometre scale (1e-6 mm), far below any mesh tolerance, and the
 *   fixed width is what makes the output byte-deterministic (no
 *   shortest-representation dialect differences).
 * - **Header** — a fixed two-line comment naming the producer and the
 *   unit convention, never a timestamp or run-varying content. The
 *   object name is the fixed literal {@link OBJ_EXPORT_OBJECT_NAME}.
 * - **Normals/UVs** — the kernel contract's optional per-vertex normals
 *   are deliberately not written: `vn` indices would fork the vertex
 *   numbering this format keeps (positions only), and OBJ's `vt/vn`
 *   fan out per-corner in real files. The import side records the
 *   omission honestly instead.
 *
 * ## Multi-solid scope
 *
 * Like the STL family: one tessellation per file; callers compose
 * multi-solid exports as one file per solid.
 *
 * ## Failure discipline
 *
 * The soup arrives across a trust boundary, so every structural defect is
 * rejected as a structured {@link ObjExportError} on the cad-core
 * `ParseResult` discipline — never a throw, never a partial file: empty
 * tessellations, non-triple-aligned arrays, and non-finite coordinates.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

/** Stable failure codes produced when OBJ export rejects its input. */
export const OBJ_EXPORT_ERROR_CODES = {
  /** A tessellation with no triangles has no boundary to export. */
  emptyTessellation: "obj-export/empty-tessellation",
  /** Positions/indices were not flat triples. */
  malformedTessellation: "obj-export/malformed-tessellation",
  /** A coordinate was NaN or infinite — no finite text exists for it. */
  nonFiniteVertex: "obj-export/non-finite-vertex",
} as const;

export type ObjExportErrorCode =
  (typeof OBJ_EXPORT_ERROR_CODES)[keyof typeof OBJ_EXPORT_ERROR_CODES];

/** Structured failure describing why OBJ export rejected a tessellation. */
export interface ObjExportError extends ParseFailure {
  readonly code: ObjExportErrorCode;
}

/** The result of OBJ export: deterministic OBJ bytes, or a failure. */
export type ObjExportResult = ParseResult<Uint8Array, ObjExportError>;

/** The fixed `o` name every export writes (byte-determinism: no run input). */
export const OBJ_EXPORT_OBJECT_NAME = "slopcad-mesh";

/** The fixed header comment's first line. */
export const OBJ_EXPORT_HEADER_TEXT =
  "# slopcad OBJ export - units: millimeters";

/** Fixed six-decimal format; negative zero normalized. */
function formatCoordinate(value: number): string {
  const text = value.toFixed(6);
  return text === "-0.000000" ? "0.000000" : text;
}

/**
 * Exports `tessellation` as deterministic ASCII OBJ bytes. Total over
 * soups: either exports or fails with a structured `obj-export/*` code —
 * never a throw. Deterministic: fixed order, fixed format, no time, no
 * randomness.
 */
export function exportObj(tessellation: Tessellation): ObjExportResult {
  const { positions, indices } = tessellation;
  if (indices.length === 0) {
    return fail({
      code: OBJ_EXPORT_ERROR_CODES.emptyTessellation,
      message:
        "The tessellation has no triangles; an exported OBJ needs a boundary to write.",
      input: new Uint8Array(),
    });
  }
  if (
    positions.length % 3 !== 0 ||
    indices.length % 3 !== 0 ||
    indices.some((index) => !Number.isInteger(index))
  ) {
    return fail({
      code: OBJ_EXPORT_ERROR_CODES.malformedTessellation,
      message:
        "Positions and indices must be flat xyz/triple arrays; the soup is not triple-aligned.",
      input: new Uint8Array(),
    });
  }
  const vertexCount = positions.length / 3;
  for (const index of indices) {
    if (index < 0 || index >= vertexCount) {
      return fail({
        code: OBJ_EXPORT_ERROR_CODES.malformedTessellation,
        message: `Index ${String(index)} is outside the soup's ${String(vertexCount)} vertices.`,
        input: new Uint8Array(),
      });
    }
  }
  for (const coordinate of positions) {
    if (!Number.isFinite(coordinate)) {
      return fail({
        code: OBJ_EXPORT_ERROR_CODES.nonFiniteVertex,
        message:
          "A vertex coordinate is NaN or infinite; OBJ text has no finite form for it.",
        input: new Uint8Array(),
      });
    }
  }

  const lines: string[] = [
    OBJ_EXPORT_HEADER_TEXT,
    `o ${OBJ_EXPORT_OBJECT_NAME}`,
  ];
  for (let v = 0; v < vertexCount; v += 1) {
    lines.push(
      `v ${formatCoordinate(positions[v * 3] ?? 0)} ${formatCoordinate(positions[v * 3 + 1] ?? 0)} ${formatCoordinate(positions[v * 3 + 2] ?? 0)}`,
    );
  }
  for (let t = 0; t < indices.length; t += 3) {
    lines.push(
      `f ${String((indices[t] ?? 0) + 1)} ${String((indices[t + 1] ?? 0) + 1)} ${String((indices[t + 2] ?? 0) + 1)}`,
    );
  }
  return ok(new TextEncoder().encode(`${lines.join("\n")}\n`));
}
