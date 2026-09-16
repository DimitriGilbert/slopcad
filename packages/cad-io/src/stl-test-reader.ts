/**
 * A hand-rolled binary STL reader for the test suite (Phase 18.1). Its
 * independence is the point: it shares no code with `./stl-export` (it does
 * not import it, call it, or invert it) — it parses raw bytes straight from
 * the published STL binary layout (80-byte header, little-endian uint32
 * count, then 50-byte triangle records: float32 normal, three float32
 * vertices, uint16 attribute byte count) and throws on any structural
 * violation. Semantic assertions built on it are therefore evidence about
 * the format output, not about the exporter's internal bookkeeping.
 *
 * Test-only module: imported exclusively by this package's `*.test.ts`
 * files, never exported from the package index.
 */

/** One parsed STL triangle: facet normal, three vertices, attribute count. */
export interface StlTriangle {
  readonly normal: readonly [number, number, number];
  readonly vertices: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  readonly attributeByteCount: number;
}

/** One parsed binary STL document. */
export interface StlDocument {
  /** Header decoded as ASCII up to the first zero byte. */
  readonly headerText: string;
  /** The triangle count declared in the file (and fully parsed). */
  readonly triangleCount: number;
  readonly triangles: readonly StlTriangle[];
}

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const TRIANGLE_BYTES = 50;

function require(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Malformed binary STL: ${message}`);
  }
}

/**
 * Parses `bytes` as binary STL, throwing on short buffers, on a triangle
 * count that does not match the buffer length exactly, and on non-finite
 * float payloads.
 */
export function readBinaryStl(bytes: Uint8Array): StlDocument {
  require(bytes.length >=
    HEADER_BYTES +
      COUNT_BYTES, `expected at least ${HEADER_BYTES + COUNT_BYTES} bytes, got ${bytes.length}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerEnd = 0;
  while (headerEnd < HEADER_BYTES && bytes[headerEnd] !== 0) {
    headerEnd += 1;
  }
  const headerText = String.fromCharCode(
    ...Array.from(bytes.subarray(0, headerEnd), (byte) => {
      require(byte < 128, `header byte ${byte} is not ASCII.`);
      return byte;
    }),
  );
  const triangleCount = view.getUint32(HEADER_BYTES, true);
  require(bytes.length ===
    HEADER_BYTES +
      COUNT_BYTES +
      TRIANGLE_BYTES *
        triangleCount, `buffer length ${bytes.length} does not match 84 + 50 × ${triangleCount}.`);
  const triangles: StlTriangle[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const base = HEADER_BYTES + COUNT_BYTES + TRIANGLE_BYTES * t;
    const floats: number[] = [];
    for (let f = 0; f < 12; f += 1) {
      const value = view.getFloat32(base + 4 * f, true);
      require(Number.isFinite(
        value,
      ), `triangle ${t} float ${f} is not finite.`);
      floats.push(value);
    }
    const attributeByteCount = view.getUint16(base + 48, true);
    triangles.push({
      normal: [floats[0] ?? 0, floats[1] ?? 0, floats[2] ?? 0],
      vertices: [
        [floats[3] ?? 0, floats[4] ?? 0, floats[5] ?? 0],
        [floats[6] ?? 0, floats[7] ?? 0, floats[8] ?? 0],
        [floats[9] ?? 0, floats[10] ?? 0, floats[11] ?? 0],
      ],
      attributeByteCount,
    });
  }
  return { headerText, triangleCount, triangles };
}

/**
 * The enclosed volume of a closed oriented triangle mesh by the divergence
 * theorem: the signed sum `(1/6) Σ (a × b) · c` over triangles, exact for
 * the parsed float32 vertices. Outward-oriented (right-hand-rule) windings
 * yield positive volume.
 */
export function enclosedVolumeMm3(document: StlDocument): number {
  let volume = 0;
  for (const triangle of document.triangles) {
    const [a, b, c] = triangle.vertices;
    volume +=
      ((a[1] * b[2] - a[2] * b[1]) * c[0] +
        (a[2] * b[0] - a[0] * b[2]) * c[1] +
        (a[0] * b[1] - a[1] * b[0]) * c[2]) /
      6;
  }
  return volume;
}

/**
 * The enclosed volume of an indexed triangle soup by the divergence theorem
 * — the same signed `(a × b) · c / 6` sum as {@link enclosedVolumeMm3},
 * evaluated over an indexed soup instead of parsed triangles. Structural
 * input type (no kernel import): the reader stays workspace-import-free.
 */
export function tessellationVolumeMm3(tessellation: {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}): number {
  const { positions, indices } = tessellation;
  let volume = 0;
  for (let t = 0; t < indices.length / 3; t += 1) {
    const i0 = indices[3 * t] ?? 0;
    const i1 = indices[3 * t + 1] ?? 0;
    const i2 = indices[3 * t + 2] ?? 0;
    const ax = positions[3 * i0] ?? 0;
    const ay = positions[3 * i0 + 1] ?? 0;
    const az = positions[3 * i0 + 2] ?? 0;
    const bx = positions[3 * i1] ?? 0;
    const by = positions[3 * i1 + 1] ?? 0;
    const bz = positions[3 * i1 + 2] ?? 0;
    const cx = positions[3 * i2] ?? 0;
    const cy = positions[3 * i2 + 1] ?? 0;
    const cz = positions[3 * i2 + 2] ?? 0;
    volume +=
      ((ay * bz - az * by) * cx +
        (az * bx - ax * bz) * cy +
        (ax * by - ay * bx) * cz) /
      6;
  }
  return volume;
}

/** The axis-aligned bounding box of a parsed document's vertices. */
export function documentBounds(document: StlDocument): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const triangle of document.triangles) {
    for (const [x, y, z] of triangle.vertices) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Float32-rounding tolerance check: `actual` matches `expected` when within
 * one float32 ulp window of it (relative `2^-22`, i.e. ~4 ulp margin), and
 * exactly when `expected` is zero — the documented quantization slack for
 * values that crossed an f64 → float32 boundary.
 */
export function float32Close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.abs(expected) * 2 ** -22;
}

/** The axis-aligned bounding box of a flat xyz position array. */
export function positionsBounds(positions: readonly number[]): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
