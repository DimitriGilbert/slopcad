/**
 * Binary STL export (Phase 18.1): serializes the kernel contract's
 * {@link Tessellation} — the kernel-neutral indexed triangle soup in
 * canonical millimetres — into the compact binary STL wire format as a
 * {@link Uint8Array}, ready for download or disk. Binary (not ASCII) STL is
 * the only flavor exported: it is compact, parses everywhere, and — unlike
 * the ASCII flavor's decimal text — has exactly one byte-level encoding of a
 * given mesh, which is what makes deterministic output possible.
 *
 * ## Conventions
 *
 * - **Units** — STL is unitless. Coordinates are written unchanged in the
 *   kernel contract's canonical millimetres; no scaling happens here and
 *   consumers importing the file must assume mm.
 * - **Triangle order** — exactly the tessellation's index order: triangle
 *   `t` is the index triple `[indices[3t], indices[3t+1], indices[3t+2]]`,
 *   and its three vertices are written in that triple's order. No sorting,
 *   no re-indexing, no vertex deduplication: the same soup yields the same
 *   bytes on every call.
 * - **float32 semantics** — STL stores IEEE-754 binary32 little-endian
 *   coordinates. The soup's f64 numbers are converted with round-to-nearest
 *   (`DataView.setFloat32` / `Math.fround` semantics). Sub-normal f64
 *   magnitudes may underflow to zero; magnitudes beyond the finite float32
 *   range are *rejected* (`stl-export/non-finite-vertex`) rather than
 *   silently written as infinities.
 * - **Facet normals** — STL carries one normal per triangle, the soup
 *   optionally one per vertex. When kernel normals are present the facet
 *   normal is the renormalized mean of the triangle's three vertex normals
 *   (exactly the face normal for planar faces, the honest bisector for a
 *   crease triangle whose split normals disagree). When absent it is
 *   computed per-face from the triangle winding, `normalize((v1−v0)×(v2−v0))`
 *   — the right-hand rule the contract's winding already encodes. Either
 *   way a zero-length result (degenerate triangle, or vertex normals that
 *   cancel) writes `(0,0,0)`, the STL-sanctioned "receiver computes it"
 *   value.
 * - **Header** — the 80-byte header is fixed deterministic ASCII,
 *   {@link STL_BINARY_HEADER_TEXT}, zero-padded: a stable slopcad identifier
 *   and the unit declaration, never a timestamp or any run-varying content.
 *   It deliberately does not start with `"solid"` so ASCII-sniffing parsers
 *   cannot misread the file.
 * - **Attribute bytes** — every triangle's trailing `uint16` attribute byte
 *   count is `0` (no per-facet attributes exist in the kernel contract).
 *
 * ## Multi-solid scope
 *
 * STL has no part/assembly structure. The exporter takes exactly one
 * tessellation — one solid per file; callers compose multi-solid exports as
 * one file per solid. A multi-solid convenience wrapper is out of scope for
 * 18.1.
 *
 * ## Failure discipline
 *
 * The soup arrives across a trust boundary (it may be anything at runtime),
 * so every structural defect is rejected as a structured
 * {@link StlExportError} on the cad-core `ParseResult` discipline — never a
 * throw, never a partially-written buffer: empty tessellations (an empty
 * solid has no boundary to export), non-triple-aligned arrays, mismatched
 * normals, non-finite or float32-overflowing vertices or normals, and
 * out-of-range indices.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

/** Stable failure codes produced when STL export rejects its input. */
export const STL_EXPORT_ERROR_CODES = {
  /** A tessellation with no triangles has no boundary to export. */
  emptyTessellation: "stl-export/empty-tessellation",
  /** Positions/indices were not flat triples, or normals did not pair with positions. */
  malformedTessellation: "stl-export/malformed-tessellation",
  /** A vertex coordinate was NaN/infinite, or beyond the finite float32 range. */
  nonFiniteVertex: "stl-export/non-finite-vertex",
  /**
   * A normal component (when the soup carries normals) was NaN/infinite, or
   * beyond the finite float32 range.
   */
  nonFiniteNormal: "stl-export/non-finite-normal",
  /** An index was not an integer inside the vertex range. */
  indexOutOfRange: "stl-export/index-out-of-range",
} as const;

export type StlExportErrorCode =
  (typeof STL_EXPORT_ERROR_CODES)[keyof typeof STL_EXPORT_ERROR_CODES];

/** Structured failure describing why STL export rejected a tessellation. */
export interface StlExportError extends ParseFailure {
  readonly code: StlExportErrorCode;
}

/** The result of STL export: serialized bytes, or a structured failure. */
export type StlExportResult = ParseResult<Uint8Array, StlExportError>;

/**
 * The deterministic 80-byte header content: a fixed slopcad identifier plus
 * the unit declaration. ASCII-only, never starts with `"solid"`, and padded
 * with zero bytes to {@link STL_HEADER_BYTES} when written.
 */
export const STL_BINARY_HEADER_TEXT = "slopcad binary STL; units: mm";

/** Byte length of a binary STL header. */
export const STL_HEADER_BYTES = 80;

/** Byte length of the little-endian uint32 triangle count after the header. */
export const STL_COUNT_BYTES = 4;

/** Byte length of one binary STL triangle (normal + 3 vertices + uint16). */
export const STL_TRIANGLE_BYTES = 50;

/** Byte length of a binary STL file with no triangles (header + count). */
export const STL_MIN_BYTES = STL_HEADER_BYTES + STL_COUNT_BYTES;

/** Largest finite float32; vertex magnitudes beyond this cannot be written. */
const FLOAT32_MAX = 3.402_823_466_385_288_6e38;

/**
 * Cross-product length below which a triangle (or a mean of vertex normals)
 * counts as degenerate and exports the `(0,0,0)` facet normal. Far below
 * anything real geometry produces, far above float32 quantization noise.
 */
const DEGENERATE_LENGTH = 1e-12;

function stlError(
  code: StlExportErrorCode,
  message: string,
  input: Tessellation,
): StlExportError {
  return { code, message, input };
}

/**
 * Validates the soup against everything the binary writer needs, returning
 * the first structured failure found or `undefined` when writable.
 */
function validateTessellation(
  tessellation: Tessellation,
): StlExportError | undefined {
  const { positions, indices, normals } = tessellation;
  if (indices.length === 0) {
    return stlError(
      STL_EXPORT_ERROR_CODES.emptyTessellation,
      "A tessellation with no triangles has no boundary to export; empty solids are filtered out before STL export.",
      tessellation,
    );
  }
  if (positions.length % 3 !== 0) {
    return stlError(
      STL_EXPORT_ERROR_CODES.malformedTessellation,
      `Tessellation positions length ${positions.length} is not divisible by 3 (flat xyz triples required).`,
      tessellation,
    );
  }
  if (indices.length % 3 !== 0) {
    return stlError(
      STL_EXPORT_ERROR_CODES.malformedTessellation,
      `Tessellation indices length ${indices.length} is not divisible by 3 (triangle index triples required).`,
      tessellation,
    );
  }
  if (normals !== undefined && normals.length !== positions.length) {
    return stlError(
      STL_EXPORT_ERROR_CODES.malformedTessellation,
      `Tessellation normals length ${normals.length} does not match positions length ${positions.length} (one normal per vertex required when present).`,
      tessellation,
    );
  }
  for (let i = 0; i < positions.length; i += 1) {
    const value = positions[i];
    if (value === undefined || !Number.isFinite(value)) {
      return stlError(
        STL_EXPORT_ERROR_CODES.nonFiniteVertex,
        `Tessellation position ${i} is not a finite number (got ${String(value)}).`,
        tessellation,
      );
    }
    if (Math.abs(value) > FLOAT32_MAX) {
      return stlError(
        STL_EXPORT_ERROR_CODES.nonFiniteVertex,
        `Tessellation position ${i} (${value}) is beyond the finite float32 range ±${FLOAT32_MAX}; binary STL coordinates are float32 and would round to infinity.`,
        tessellation,
      );
    }
  }
  if (normals !== undefined) {
    for (let i = 0; i < normals.length; i += 1) {
      const value = normals[i];
      if (value === undefined || !Number.isFinite(value)) {
        return stlError(
          STL_EXPORT_ERROR_CODES.nonFiniteNormal,
          `Tessellation normal component ${i} is not a finite number (got ${String(value)}).`,
          tessellation,
        );
      }
      if (Math.abs(value) > FLOAT32_MAX) {
        return stlError(
          STL_EXPORT_ERROR_CODES.nonFiniteNormal,
          `Tessellation normal component ${i} (${value}) is beyond the finite float32 range ±${FLOAT32_MAX}; the facet normal's renormalized mean of such components can overflow to NaN.`,
          tessellation,
        );
      }
    }
  }
  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= vertexCount
    ) {
      return stlError(
        STL_EXPORT_ERROR_CODES.indexOutOfRange,
        `Tessellation index ${i} is ${String(index)}, not an integer inside the vertex range 0..${vertexCount - 1}.`,
        tessellation,
      );
    }
  }
  return undefined;
}

/** Reads the xyz triple at flat offset `base` of a validated flat array. */
function tripleAt(
  array: readonly number[],
  base: number,
): readonly [number, number, number] {
  const x = array[base] ?? 0;
  const y = array[base + 1] ?? 0;
  const z = array[base + 2] ?? 0;
  return [x, y, z];
}

/**
 * The facet normal of triangle `t` under the documented rule: the
 * renormalized mean of the triangle's vertex normals when the soup carries
 * normals, otherwise the normalized winding normal `(v1−v0)×(v2−v0)`;
 * `(0,0,0)` when either is degenerate. Inputs are pre-validated finite.
 */
function facetNormal(
  tessellation: Tessellation,
  triangle: number,
): readonly [number, number, number] {
  const { positions, indices, normals } = tessellation;
  const i0 = indices[3 * triangle] ?? 0;
  const i1 = indices[3 * triangle + 1] ?? 0;
  const i2 = indices[3 * triangle + 2] ?? 0;
  if (normals !== undefined) {
    const n0 = tripleAt(normals, 3 * i0);
    const n1 = tripleAt(normals, 3 * i1);
    const n2 = tripleAt(normals, 3 * i2);
    const sx = n0[0] + n1[0] + n2[0];
    const sy = n0[1] + n1[1] + n2[1];
    const sz = n0[2] + n1[2] + n2[2];
    const length = Math.hypot(sx, sy, sz);
    if (length > DEGENERATE_LENGTH) {
      return [sx / length, sy / length, sz / length];
    }
    return [0, 0, 0];
  }
  const v0 = tripleAt(positions, 3 * i0);
  const v1 = tripleAt(positions, 3 * i1);
  const v2 = tripleAt(positions, 3 * i2);
  const ex = v1[0] - v0[0];
  const ey = v1[1] - v0[1];
  const ez = v1[2] - v0[2];
  const fx = v2[0] - v0[0];
  const fy = v2[1] - v0[1];
  const fz = v2[2] - v0[2];
  const cx = ey * fz - ez * fy;
  const cy = ez * fx - ex * fz;
  const cz = ex * fy - ey * fx;
  const length = Math.hypot(cx, cy, cz);
  if (length > DEGENERATE_LENGTH) {
    return [cx / length, cy / length, cz / length];
  }
  return [0, 0, 0];
}

/**
 * Serializes `tessellation` to deterministic binary STL bytes. Byte layout:
 * the fixed 80-byte header, the little-endian uint32 triangle count, then
 * `50 × count` triangle records — normal, three vertices (all float32
 * little-endian), and the zero uint16 attribute byte count. Same soup in,
 * same bytes out, every call.
 */
export function exportStlBinary(tessellation: Tessellation): StlExportResult {
  const failure = validateTessellation(tessellation);
  if (failure !== undefined) {
    return fail(failure);
  }
  const { positions, indices } = tessellation;
  const triangleCount = indices.length / 3;
  const bytes = new Uint8Array(
    STL_MIN_BYTES + STL_TRIANGLE_BYTES * triangleCount,
  );
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < STL_BINARY_HEADER_TEXT.length; i += 1) {
    view.setUint8(i, STL_BINARY_HEADER_TEXT.charCodeAt(i));
  }
  view.setUint32(STL_HEADER_BYTES, triangleCount, true);
  let offset = STL_MIN_BYTES;
  for (let t = 0; t < triangleCount; t += 1) {
    const normal = facetNormal(tessellation, t);
    view.setFloat32(offset, normal[0], true);
    view.setFloat32(offset + 4, normal[1], true);
    view.setFloat32(offset + 8, normal[2], true);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[3 * t + corner] ?? 0;
      const base = 3 * vertex;
      view.setFloat32(offset + 12 + 12 * corner, positions[base] ?? 0, true);
      view.setFloat32(
        offset + 16 + 12 * corner,
        positions[base + 1] ?? 0,
        true,
      );
      view.setFloat32(
        offset + 20 + 12 * corner,
        positions[base + 2] ?? 0,
        true,
      );
    }
    view.setUint16(offset + 48, 0, true);
    offset += STL_TRIANGLE_BYTES;
  }
  return ok(bytes);
}
