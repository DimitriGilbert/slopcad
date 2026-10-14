/**
 * The voxelizer — law S3's geometry interface (ROADMAP-SIM Phase 62a):
 * a watertight `Tessellation` in canonical millimetres (the kernel
 * contract's geometry currency, `packages/cad-kernel/src/contract.ts`)
 * becomes a deterministic occupancy grid, full 3D or as a 2D
 * cross-section slice at a plane. sim-core depends on nothing at
 * runtime, so the contract's shape is restated here structurally
 * (`SimTessellationWire`) and re-validated field by field at the door —
 * the exact wire discipline `./units` applies to serialized records,
 * pinned against the kernel package by `./voxel-cross-compat.test`.
 *
 * ## Semantics
 *
 * Samples are node-centered (`./voxel-grid`): the classification runs
 * per lattice point. A node is occupied exactly when the point lies
 * INSIDE OR ON the closed solid — 1 for boundary nodes, the honest
 * closed-set convention. The domain comes from explicit bounds or is
 * body-derived (the tessellation's own referenced-vertex AABB plus a
 * margin, the compile door's `bodyBounds` discipline); the voxel size
 * is the caller's resolution, and the grid tiles the domain with nodes
 * at `min + i·h` — never past the max corner — so an aligned fixture
 * (faces on node planes) reproduces the analytic occupancy exactly.
 *
 * ## Classification (determinism, and where degeneracies live)
 *
 * Each node classifies by casting the fixed +X ray. A hit on a
 * non-parallel triangle at t = 0 — or a node exactly coplanar with and
 * inside a ray-parallel triangle — is boundary membership: inside,
 * immediately (the closed-set convention). Every other crossing is
 * counted with the textbook robust point-in-polygon straddle rule
 * applied to the triangle's (y, z) projection: an edge toggles only
 * when it straddles the node's z half-openly AND crosses ahead in y.
 * That rule counts a lattice ray that passes exactly THROUGH a shared
 * edge or vertex of the projected mesh exactly once — the property
 * plain parity lacks (a sphere's meridian plane at y = 0 or a box
 * face's diagonal double-counts one side only, flipping through-passing
 * exterior nodes to false interiors; a real fixture, not a measure-zero
 * worry) — and it degenerates ray-parallel faces to zero-area
 * projections that never toggle, which the coplanar rescue then covers
 * for nodes lying ON them. Inside = on-surface OR odd crossings. Every
 * accumulated term is exact integer arithmetic over pure
 * floating-point triangle tests — no iteration-order-dependent fills,
 * no accumulation drift: identical inputs give bitwise-identical
 * grids, and permuting the soup's triangle order leaves the grid
 * unchanged (both are pinned by tests).
 *
 * The honest caveat: a node exactly on a ray-parallel PLANE but
 * outside every coplanar triangle, whose grazing entry and exit
 * straddle-counts come out odd by silhouette-fold coincidence, is the
 * remaining measure-zero blind spot; the Phase 66 cut-cell decision
 * may harden it with the distance field.
 *
 * ## Units (law S4)
 *
 * Document millimetres IN, SI-safe grid geometry OUT: the
 * classification arithmetic runs in the tessellation's own millimetres
 * (exact for the dyadic fixtures the analytic tests use), and the
 * resulting geometry converts to solver-space metres at this one door
 * through the shared `MM_PER_M` — the geometry half of the compile
 * door, whose scenario half lives in `./units`. Projection back to
 * document space rides `simGridToFieldBlock` (`./voxel-grid`), which
 * goes through `projectSimResult` and nothing else.
 */

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimParseResult, simFail, simOk } from "./result";
import { MM_PER_M } from "./units";
import {
  type SimOccupancyGrid,
  SIM_GRID_MAX_SAMPLES,
  simGridNameProblem,
} from "./voxel-grid";

// ---------------------------------------------------------------------------
// The tessellation door (the kernel contract's Tessellation, restated)
// ---------------------------------------------------------------------------

/**
 * The structural restatement of the kernel contract's `Tessellation`:
 * flat xyz positions and flat triangle-vertex indices in canonical
 * millimetres, optional flat xyz vertex normals. The voxelizer's input
 * door re-validates every field it consumes from `unknown`, exactly as
 * `./units` re-validates serialized records.
 */
export interface SimTessellationWire {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
}

/** A validated tessellation: the soup plus its referenced-vertex bounds, mm. */
export interface ValidatedSimTessellation {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  /**
   * The axis-aligned bounds of the REFERENCED vertices (unreferenced
   * positions cannot grow a body-derived domain), canonical mm.
   */
  readonly minMm: readonly [number, number, number];
  readonly maxMm: readonly [number, number, number];
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Validates a tessellation at the door: plain positions/indices arrays
 * with lengths divisible by 3, finite coordinates, indices in vertex
 * range, normals (when present) matching the position count — and at
 * least one triangle. An empty soup bounds no solid: the voxelizer
 * declines loudly (`sim/tessellation-invalid`) instead of fabricating
 * an all-empty grid that is indistinguishable from a bug.
 */
export function parseSimTessellationWire(
  input: unknown,
): SimParseResult<ValidatedSimTessellation, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.tessellationInvalid, message, at));
  if (!isPlainRecord(input)) {
    return refuse(
      "A tessellation must be a plain object with positions and indices arrays.",
      input,
    );
  }
  // The element-wise view keeps the element type `unknown` (never the
  // `any` Array.isArray narrows to), so every component narrows through
  // its own typeof check below — the `./units` wire-door discipline.
  if (!Array.isArray(input.positions) || !Array.isArray(input.indices)) {
    return refuse(
      "A tessellation's positions and indices must be arrays.",
      input,
    );
  }
  const positions: readonly unknown[] = input.positions as readonly unknown[];
  const indices: readonly unknown[] = input.indices as readonly unknown[];
  if (positions.length % 3 !== 0) {
    return refuse(
      `A tessellation's positions length (${String(positions.length)}) must be divisible by 3.`,
      positions.length,
    );
  }
  if (indices.length % 3 !== 0) {
    return refuse(
      `A tessellation's indices length (${String(indices.length)}) must be divisible by 3 (flat triangles).`,
      indices.length,
    );
  }
  if (indices.length === 0) {
    return refuse(
      "A tessellation with zero triangles bounds no solid; the voxelizer declines loudly rather than emitting a fabricated all-empty grid.",
      input,
    );
  }
  const vertexCount = positions.length / 3;
  for (const coordinate of positions) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      return refuse(
        "A tessellation's positions must be finite canonical-millimetre coordinates.",
        coordinate,
      );
    }
  }
  // Referenced-vertex flags and index validation in one deterministic
  // pass; the flags carry the body-derived bounds' vertex set.
  const referenced = new Uint8Array(vertexCount);
  for (const index of indices) {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= vertexCount
    ) {
      return refuse(
        `A tessellation's indices must be integers within vertex range [0, ${String(vertexCount)}).`,
        index,
      );
    }
    referenced[index] = 1;
  }
  if (input.normals !== undefined && input.normals !== null) {
    if (
      !Array.isArray(input.normals) ||
      input.normals.length !== positions.length ||
      (input.normals as readonly unknown[]).some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      )
    ) {
      return refuse(
        "A tessellation's normals, when present, must be a finite xyz array exactly as long as positions.",
        input.normals,
      );
    }
  }
  // Referenced-vertex bounds: one deterministic pass over validated
  // numbers, min/max exact and therefore order-independent — the
  // stable body-derived domain base.
  const numberPositions = positions as readonly number[];
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
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (referenced[vertex] !== 1) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      const coordinate = numberPositions[vertex * 3 + axis];
      if (coordinate === undefined) continue;
      min[axis] = Math.min(min[axis] ?? Infinity, coordinate);
      max[axis] = Math.max(max[axis] ?? -Infinity, coordinate);
    }
  }
  return simOk(
    Object.freeze({
      positions: numberPositions,
      indices: indices as readonly number[],
      minMm: min,
      maxMm: max,
    }),
  );
}

/**
 * A tessellation's axis-aligned bounds in canonical millimetres — over
 * its referenced vertices; the measurement `SimCompileInput.bodyBounds`
 * wants for body-derived domains and the S9 characteristic length.
 */
export function simTessellationBoundsMm(input: unknown): SimParseResult<
  {
    readonly minMm: readonly [number, number, number];
    readonly maxMm: readonly [number, number, number];
  },
  SimError
> {
  const parsed = parseSimTessellationWire(input);
  if (!parsed.ok) return parsed;
  return simOk(
    Object.freeze({ minMm: parsed.value.minMm, maxMm: parsed.value.maxMm }),
  );
}

// ---------------------------------------------------------------------------
// The domain door (explicit bounds or body-derived, document mm)
// ---------------------------------------------------------------------------

/** An explicit domain: the box in canonical mm plus the resolution. */
export interface SimVoxelDomainExplicit {
  readonly kind: "explicit";
  readonly minMm: readonly [number, number, number];
  readonly maxMm: readonly [number, number, number];
  readonly resolutionMm: number;
}

/** A body-derived domain: the tessellation's bounds padded by a margin. */
export interface SimVoxelDomainBody {
  readonly kind: "body";
  readonly marginMm: number;
  readonly resolutionMm: number;
}

export type SimVoxelDomain = SimVoxelDomainExplicit | SimVoxelDomainBody;

interface ResolvedDomainMm {
  readonly minMm: readonly [number, number, number];
  readonly maxMm: readonly [number, number, number];
  readonly resolutionMm: number;
}

function finiteTriple(
  input: unknown,
  what: string,
): SimParseResult<readonly [number, number, number], SimError> {
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (entries.length !== 3) {
    return simFail(
      simError(
        SIM_ERROR_CODES.voxelDomainInvalid,
        `${what} must be an array of three numbers.`,
        input,
      ),
    );
  }
  const [x, y, z] = entries;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof z !== "number" ||
    !Number.isFinite(z)
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.voxelDomainInvalid,
        `${what} must be three finite numbers.`,
        input,
      ),
    );
  }
  return simOk([x, y, z]);
}

function parseVoxelDomain(
  input: unknown,
  tessellation: ValidatedSimTessellation,
): SimParseResult<ResolvedDomainMm, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.voxelDomainInvalid, message, at));
  if (!isPlainRecord(input)) {
    return refuse(
      "A voxel domain must be a plain object with a kind field.",
      input,
    );
  }
  if (
    typeof input.resolutionMm !== "number" ||
    !Number.isFinite(input.resolutionMm) ||
    input.resolutionMm <= 0
  ) {
    return refuse(
      "A voxel domain's resolution must be a positive finite number of millimetres.",
      input.resolutionMm,
    );
  }
  const resolutionMm = input.resolutionMm;
  if (input.kind === "explicit") {
    const min = finiteTriple(
      input.minMm,
      "An explicit voxel domain's min corner",
    );
    if (!min.ok) return min;
    const max = finiteTriple(
      input.maxMm,
      "An explicit voxel domain's max corner",
    );
    if (!max.ok) return max;
    for (let axis = 0; axis < 3; axis += 1) {
      if ((max.value[axis] ?? 0) <= (min.value[axis] ?? 0)) {
        return refuse(
          "An explicit voxel domain's max corner must exceed its min corner on every axis.",
          input,
        );
      }
    }
    return simOk({ minMm: min.value, maxMm: max.value, resolutionMm });
  }
  if (input.kind === "body") {
    if (
      typeof input.marginMm !== "number" ||
      !Number.isFinite(input.marginMm) ||
      input.marginMm < 0
    ) {
      return refuse(
        "A body-derived voxel domain's margin must be a non-negative finite number of millimetres.",
        input.marginMm,
      );
    }
    const margin = input.marginMm;
    return simOk({
      minMm: [
        (tessellation.minMm[0] ?? 0) - margin,
        (tessellation.minMm[1] ?? 0) - margin,
        (tessellation.minMm[2] ?? 0) - margin,
      ],
      maxMm: [
        (tessellation.maxMm[0] ?? 0) + margin,
        (tessellation.maxMm[1] ?? 0) + margin,
        (tessellation.maxMm[2] ?? 0) + margin,
      ],
      resolutionMm,
    });
  }
  return refuse(
    'A voxel domain\'s kind must be "explicit" or "body".',
    input.kind,
  );
}

// ---------------------------------------------------------------------------
// The slice plane door
// ---------------------------------------------------------------------------

/** The slice plane's normal axis, named in document-axis order. */
export type SimVoxelPlaneAxis = "x" | "y" | "z";

export const SIM_VOXEL_PLANE_AXES = [
  "x",
  "y",
  "z",
] as const satisfies readonly SimVoxelPlaneAxis[];

/** A cross-section plane: the axis it is perpendicular to, and where. */
export interface SimVoxelSlicePlane {
  readonly axis: SimVoxelPlaneAxis;
  readonly coordinateMm: number;
}

function parseSlicePlane(
  input: unknown,
): SimParseResult<SimVoxelSlicePlane, SimError> {
  if (!isPlainRecord(input)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.voxelDomainInvalid,
        "A slice request must carry a plane with an axis and a coordinate.",
        input,
      ),
    );
  }
  if (
    typeof input.axis !== "string" ||
    !SIM_VOXEL_PLANE_AXES.includes(input.axis as SimVoxelPlaneAxis)
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.voxelDomainInvalid,
        "A slice plane's axis must be one of: x, y, z.",
        input.axis,
      ),
    );
  }
  if (
    typeof input.coordinateMm !== "number" ||
    !Number.isFinite(input.coordinateMm)
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.voxelDomainInvalid,
        "A slice plane's coordinate must be a finite number of millimetres.",
        input.coordinateMm,
      ),
    );
  }
  return simOk({
    axis: input.axis as SimVoxelPlaneAxis,
    coordinateMm: input.coordinateMm,
  });
}

// ---------------------------------------------------------------------------
// The classifier (+X ray, straddle parity + the two on-surface rescues)
// ---------------------------------------------------------------------------

/** Per-triangle precomputation: the 9 mm coordinates, then the y/z culling box. */
interface TriangleAccel {
  readonly coords: Float64Array;
  readonly cullMinY: Float64Array;
  readonly cullMaxY: Float64Array;
  readonly cullMinZ: Float64Array;
  readonly cullMaxZ: Float64Array;
}

function buildTriangleAccel(
  tessellation: ValidatedSimTessellation,
): TriangleAccel {
  const triangleCount = tessellation.indices.length / 3;
  const coords = new Float64Array(triangleCount * 9);
  const cullMinY = new Float64Array(triangleCount);
  const cullMaxY = new Float64Array(triangleCount);
  const cullMinZ = new Float64Array(triangleCount);
  const cullMaxZ = new Float64Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = tessellation.indices[triangle * 3 + corner] ?? 0;
      for (let axis = 0; axis < 3; axis += 1) {
        coords[triangle * 9 + corner * 3 + axis] =
          tessellation.positions[vertex * 3 + axis] ?? 0;
      }
    }
    const base = triangle * 9;
    cullMinY[triangle] = Math.min(
      coords[base + 1] ?? 0,
      coords[base + 4] ?? 0,
      coords[base + 7] ?? 0,
    );
    cullMaxY[triangle] = Math.max(
      coords[base + 1] ?? 0,
      coords[base + 4] ?? 0,
      coords[base + 7] ?? 0,
    );
    cullMinZ[triangle] = Math.min(
      coords[base + 2] ?? 0,
      coords[base + 5] ?? 0,
      coords[base + 8] ?? 0,
    );
    cullMaxZ[triangle] = Math.max(
      coords[base + 2] ?? 0,
      coords[base + 5] ?? 0,
      coords[base + 8] ?? 0,
    );
  }
  return { coords, cullMinY, cullMaxY, cullMinZ, cullMaxZ };
}

/** Whether q lies in the CLOSED 2D triangle (a, b, c) — boundary inclusive. */
function pointInClosedTriangle2D(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  qx: number,
  qy: number,
): boolean {
  const d1 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  const d2 = (cx - bx) * (qy - by) - (cy - by) * (qx - bx);
  const d3 = (ax - cx) * (qy - cy) - (ay - cy) * (qx - cx);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * The straddle rule: whether q lies in the HALF-OPEN 2D triangle (a, b,
 * c) — the textbook robust point-in-polygon test over the triangle's
 * three edges. An edge toggles only when its endpoints straddle q's
 * second coordinate half-openly (one strictly above, the other at or
 * below) and the crossing sits strictly ahead in the first coordinate.
 * Shared edges and vertices of a triangulation therefore count exactly
 * once across their adjacent triangles, and degenerate (zero-area)
 * projections never toggle.
 */
function pointInHalfOpenTriangle2D(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  qx: number,
  qy: number,
): boolean {
  let inside = false;
  const edges: readonly (readonly [number, number, number, number])[] = [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay],
  ];
  for (const [ex0, ey0, ex1, ey1] of edges) {
    if (ey0 > qy === ey1 > qy) continue; // no half-open straddle
    const fraction = (qy - ey0) / (ey1 - ey0);
    const crossX = ex0 + fraction * (ex1 - ex0);
    if (crossX > qx) inside = !inside;
  }
  return inside;
}

/**
 * Whether the point lies inside or on the closed solid — the module
 * header's classifier. Sign-exact Möller–Trumbore for the fixed +X ray
 * (products preserve signs, so the comparisons never divide), with the
 * culling boxes checked closed (a hit exactly on a box edge survives).
 * Ray-parallel triangles fall to the coplanar on-surface rescue: the
 * plane test is exact, and the containment runs closed in a projection
 * the plane never degenerates on.
 */
function pointInsideClosedSolid(
  px: number,
  py: number,
  pz: number,
  accel: TriangleAccel,
): boolean {
  const triangleCount = accel.cullMinY.length;
  let crossings = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (
      py < (accel.cullMinY[triangle] ?? 0) ||
      py > (accel.cullMaxY[triangle] ?? 0) ||
      pz < (accel.cullMinZ[triangle] ?? 0) ||
      pz > (accel.cullMaxZ[triangle] ?? 0)
    ) {
      continue;
    }
    const base = triangle * 9;
    const x0 = accel.coords[base] ?? 0;
    const y0 = accel.coords[base + 1] ?? 0;
    const z0 = accel.coords[base + 2] ?? 0;
    const e1x = (accel.coords[base + 3] ?? 0) - x0;
    const e1y = (accel.coords[base + 4] ?? 0) - y0;
    const e1z = (accel.coords[base + 5] ?? 0) - z0;
    const e2x = (accel.coords[base + 6] ?? 0) - x0;
    const e2y = (accel.coords[base + 7] ?? 0) - y0;
    const e2z = (accel.coords[base + 8] ?? 0) - z0;
    // Möller–Trumbore for D = (1, 0, 0): pvec = (0, −e2z, e2y).
    const det = e1z * e2y - e1y * e2z;
    const x1 = x0 + e1x;
    const y1 = y0 + e1y;
    const z1 = z0 + e1z;
    const x2 = x0 + e2x;
    const y2 = y0 + e2y;
    const z2 = z0 + e2z;
    if (det === 0) {
      // Ray-parallel (or degenerate): only an exactly-coplanar point
      // inside the closed triangle is boundary membership.
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      if (ny === 0 && nz === 0) continue; // degenerate triangle
      if ((py - y0) * ny + (pz - z0) * nz !== 0) continue; // not coplanar
      const coplanarInside =
        nz !== 0
          ? pointInClosedTriangle2D(x0, y0, x1, y1, x2, y2, px, py)
          : pointInClosedTriangle2D(x0, z0, x1, z1, x2, z2, px, pz);
      if (coplanarInside) return true;
      continue;
    }
    const tvx = px - x0;
    const tvy = py - y0;
    const tvz = pz - z0;
    const n1 = tvz * e2y - tvy * e2z; // u · det
    const n2 = tvy * e1z - tvz * e1y; // v · det  (= qvec.x)
    const n0 = det - n1 - n2; // (1 − u − v) · det
    const m0 = n0 * det;
    const m1 = n1 * det;
    const m2 = n2 * det;
    if (m0 < 0 || m1 < 0 || m2 < 0) continue; // outside the closed triangle
    const qvy = tvz * e1x - tvx * e1z;
    const qvz = tvx * e1y - tvy * e1x;
    const tdet = e2x * n2 + e2y * qvy + e2z * qvz; // t · det  (e2 · qvec, qvec.x reused)
    if (tdet === 0) return true; // the point lies ON this triangle
    if (tdet * det < 0) continue; // hit behind the point
    // The crossing counts under the half-open straddle rule in the
    // (y, z) projection — exactly-once across shared edges/vertices.
    if (pointInHalfOpenTriangle2D(y0, z0, y1, z1, y2, z2, py, pz)) {
      crossings += 1;
    }
  }
  return crossings % 2 === 1;
}

// ---------------------------------------------------------------------------
// The public doors
// ---------------------------------------------------------------------------

/** What {@link voxelizeSimTessellation} consumes (document space, mm). */
export interface SimVoxelizeInput {
  /** The watertight triangle soup in canonical mm (re-validated). */
  readonly tessellation: unknown;
  /** The domain (explicit or body-derived) plus resolution, in mm. */
  readonly domain: unknown;
  /** The grid's name; defaults to "domain". */
  readonly name?: string;
}

/**
 * Voxelize a tessellation into a 3D occupancy grid (law S3):
 * node-centered samples over the resolved domain, the classification
 * of the module header, geometry in solver-space metres at the S4
 * door. Deterministic — bitwise — for identical inputs, and the grid
 * fills never depend on the soup's triangle order.
 */
export function voxelizeSimTessellation(
  input: SimVoxelizeInput,
): SimParseResult<SimOccupancyGrid, SimError> {
  const tessellation = parseSimTessellationWire(input.tessellation);
  if (!tessellation.ok) return tessellation;
  const domain = parseVoxelDomain(input.domain, tessellation.value);
  if (!domain.ok) return domain;
  const name = input.name ?? "domain";
  const nameProblem = simGridNameProblem(name);
  if (nameProblem !== undefined) return simFail(nameProblem);
  const shape = shapeOverDomain(domain.value);
  const shapeProblem = shapeBudgetProblem(shape);
  if (shapeProblem !== undefined) return simFail(shapeProblem);
  const cells = classifyLattice(
    tessellation.value,
    domain.value.minMm,
    shape,
    domain.value.resolutionMm,
  );
  return simOk(
    Object.freeze({
      semantic: "occupancy",
      name,
      shape,
      originM: toMetres(domain.value.minMm),
      spacingM: uniformSpacingM(domain.value.resolutionMm),
      cells,
    }),
  );
}

/** What {@link voxelizeSimTessellationSlice} consumes (document space, mm). */
export interface SimVoxelizeSliceInput extends SimVoxelizeInput {
  /** The cross-section plane: { axis, coordinateMm }. */
  readonly plane: unknown;
}

/**
 * Voxelize a tessellation's cross-section at a plane into a 2D
 * occupancy grid — a `[nu, nv, 1]` lattice in DOCUMENT-axis order whose
 * single sample on the plane's axis sits exactly ON the plane (origin
 * on that axis is the plane coordinate; the in-plane axes keep the
 * domain's own min corners). The classification is the same 3D
 * closed-solid test evaluated at the plane's sample points, so a slice
 * of an aligned analytic shape is exact. A plane that misses the solid
 * yields an honestly empty grid — the mesh door already refused the
 * truly empty cases.
 */
export function voxelizeSimTessellationSlice(
  input: SimVoxelizeSliceInput,
): SimParseResult<SimOccupancyGrid, SimError> {
  const tessellation = parseSimTessellationWire(input.tessellation);
  if (!tessellation.ok) return tessellation;
  const plane = parseSlicePlane(input.plane);
  if (!plane.ok) return plane;
  const domain = parseVoxelDomain(input.domain, tessellation.value);
  if (!domain.ok) return domain;
  const name = input.name ?? "domain";
  const nameProblem = simGridNameProblem(name);
  if (nameProblem !== undefined) return simFail(nameProblem);
  const full = shapeOverDomain(domain.value);
  const shape: [number, number, number] = [
    full[0] ?? 1,
    full[1] ?? 1,
    full[2] ?? 1,
  ];
  shape[axisIndex(plane.value.axis)] = 1;
  const shapeProblem = shapeBudgetProblem(shape);
  if (shapeProblem !== undefined) return simFail(shapeProblem);
  const originMm: [number, number, number] = [
    domain.value.minMm[0] ?? 0,
    domain.value.minMm[1] ?? 0,
    domain.value.minMm[2] ?? 0,
  ];
  originMm[axisIndex(plane.value.axis)] = plane.value.coordinateMm;
  const cells = classifyLattice(
    tessellation.value,
    originMm,
    shape,
    domain.value.resolutionMm,
  );
  return simOk(
    Object.freeze({
      semantic: "occupancy",
      name,
      shape,
      originM: toMetres(originMm),
      spacingM: uniformSpacingM(domain.value.resolutionMm),
      cells,
    }),
  );
}

// ---------------------------------------------------------------------------
// Internals shared by both doors
// ---------------------------------------------------------------------------

function axisIndex(axis: SimVoxelPlaneAxis): number {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

function toMetres(
  triple: readonly [number, number, number],
): readonly [number, number, number] {
  return [
    (triple[0] ?? 0) / MM_PER_M,
    (triple[1] ?? 0) / MM_PER_M,
    (triple[2] ?? 0) / MM_PER_M,
  ];
}

/** The isotropic voxel stride as an SI triple. */
function uniformSpacingM(
  resolutionMm: number,
): readonly [number, number, number] {
  const spacing = resolutionMm / MM_PER_M;
  return [spacing, spacing, spacing];
}

/** Node counts per axis: `floor((max − min)/h) + 1` — nodes never pass max. */
function shapeOverDomain(
  domain: ResolvedDomainMm,
): readonly [number, number, number] {
  const shape: [number, number, number] = [1, 1, 1];
  for (let axis = 0; axis < 3; axis += 1) {
    const extent = (domain.maxMm[axis] ?? 0) - (domain.minMm[axis] ?? 0);
    shape[axis] = Math.floor(extent / domain.resolutionMm) + 1;
  }
  return shape;
}

function shapeBudgetProblem(
  shape: readonly [number, number, number],
): SimError | undefined {
  const total = (shape[0] ?? 1) * (shape[1] ?? 1) * (shape[2] ?? 1);
  if (total > SIM_GRID_MAX_SAMPLES) {
    return simError(
      SIM_ERROR_CODES.voxelDomainInvalid,
      `The resolved grid shape [${shape.join(", ")}] exceeds the sample sanity budget of ${String(SIM_GRID_MAX_SAMPLES)}; raise the resolution or shrink the domain.`,
      shape,
    );
  }
  return undefined;
}

/** The x-fastest classification sweep, in the tessellation's own millimetres. */
function classifyLattice(
  tessellation: ValidatedSimTessellation,
  originMm: readonly [number, number, number],
  shape: readonly [number, number, number],
  resolutionMm: number,
): Uint8Array {
  const accel = buildTriangleAccel(tessellation);
  const nx = shape[0] ?? 1;
  const ny = shape[1] ?? 1;
  const nz = shape[2] ?? 1;
  const cells = new Uint8Array(nx * ny * nz);
  const ox = originMm[0] ?? 0;
  const oy = originMm[1] ?? 0;
  const oz = originMm[2] ?? 0;
  let index = 0;
  for (let k = 0; k < nz; k += 1) {
    const pz = oz + k * resolutionMm;
    for (let j = 0; j < ny; j += 1) {
      const py = oy + j * resolutionMm;
      for (let i = 0; i < nx; i += 1) {
        const px = ox + i * resolutionMm;
        cells[index] = pointInsideClosedSolid(px, py, pz, accel) ? 1 : 0;
        index += 1;
      }
    }
  }
  return cells;
}
