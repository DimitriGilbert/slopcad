/**
 * The edges-overlay drawing projection (Phase 53): the mesh-kernel fallback
 * behind the `drawingView` capability law.
 *
 * The kernel contract's `drawingView` operation is gated on the
 * `hiddenLineRemoval` capability: only a kernel with exact hidden-line
 * removal (OCCT, via `HLRBRep`) answers it natively. Everything else — and
 * any kernel call the caller prefers not to wait on — projects the body's
 * own tessellation here: the FEATURE edges of the boundary mesh (edges
 * shared by two triangles whose face normals diverge by more than the
 * documented threshold, plus boundary edges with only one incident face)
 * are orthographically projected onto the view basis.
 *
 * ## Fidelity, classified honestly
 *
 * The result is a `DrawingViewGeometry` with `fidelity: "edges-overlay"`:
 * every extracted chain is drawn as VISIBLE, `hidden` is empty, and smooth
 * silhouettes (a cylinder's outline without mesh-aligned feature edges)
 * are simply absent. An exact HLR would occlude the far-side edges this
 * projection still draws; callers must not present the overlay as an exact
 * view. The fidelity class on the geometry — never a caller-side guess —
 * is the honesty mechanism.
 *
 * ## Determinism
 *
 * Pure float64 math over the indexed mesh, no clocks, no randomness: the
 * same tessellation, eye, and up produce byte-identical chains, in the
 * edges' first-seen order (deterministic because the mesh arrays are).
 * Edge keys are sorted index pairs, so winding never matters.
 */

import {
  type DrawingViewGeometry,
  type ProjectedChain,
  DRAWING_VIEW_EYE_DIRECTIONS,
  DRAWING_VIEW_UP_HINTS,
  type DrawingViewKind,
  viewBasis,
} from "./drawing";

/**
 * The dihedral threshold for feature edges, radians (~20°): two triangles
 * whose normals diverge more than this meet at a feature edge. Below it
 * the edge is a tessellation seam on a smooth surface and is not drawn.
 */
export const FEATURE_EDGE_DIHEDRAL_THRESHOLD_RAD = 20 * (Math.PI / 180);

/** The indexed-triangle mesh the overlay projects (kernel tessellation shape). */
export interface OverlayMesh {
  /** Flat xyz positions, 3 floats per vertex. */
  readonly positions: readonly number[];
  /** Triangle vertex indices, 3 per triangle. */
  readonly indices: readonly number[];
}

/**
 * Projects a tessellated body onto a base view kind's basis, producing the
 * edges-overlay geometry (see module docs). `positions`/`indices` must be
 * well-formed (lengths divisible by 3; indices in range) — malformed input
 * yields the empty geometry rather than a wrong picture, with the bounds
 * `null` exactly like an empty HLR answer.
 */
export function edgesOverlayProjectionForKind(
  mesh: OverlayMesh,
  kind: DrawingViewKind,
): DrawingViewGeometry {
  return edgesOverlayProjection(
    mesh,
    DRAWING_VIEW_EYE_DIRECTIONS[kind],
    DRAWING_VIEW_UP_HINTS[kind],
  );
}

/**
 * A WORLD-space clip plane applied before projection: a feature edge is
 * clipped to the kept side {p : n·p - d ≥ 0} (edges crossing the plane are
 * cut at it, removed-side portions drop). The section-view path uses this
 * to clip in world coordinates — the only space where the test is defined
 * (a view-plane point does not determine a world point's side).
 */
export interface OverlayClipPlane {
  /** Unit-scaled normal of the kept half-space (normalized on use). */
  readonly normal: readonly [number, number, number];
  /** The plane offset: `normal·p = offset` is the cut plane. */
  readonly offset: number;
}

/**
 * Projects a tessellated body onto an arbitrary (eye, up) basis — the
 * general form of {@link edgesOverlayProjectionForKind}, with an optional
 * world-space clip plane (see {@link OverlayClipPlane}).
 */
export function edgesOverlayProjection(
  mesh: OverlayMesh,
  eye: readonly [number, number, number],
  upHint: readonly [number, number, number],
  clipPlane?: OverlayClipPlane,
): DrawingViewGeometry {
  const plane = normalizeClipPlane(clipPlane);
  const basis = viewBasis(eye, upHint);
  const triangleCount = Math.floor(mesh.indices.length / 3);
  if (triangleCount === 0 || mesh.positions.length < 3) {
    return { fidelity: "edges-overlay", visible: [], hidden: [], bounds: null };
  }
  // Face normals per triangle (deterministic order).
  const normals: [number, number, number][] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    if (
      ia === undefined ||
      ib === undefined ||
      ic === undefined ||
      ia >= mesh.positions.length / 3 ||
      ib >= mesh.positions.length / 3 ||
      ic >= mesh.positions.length / 3
    ) {
      return {
        fidelity: "edges-overlay",
        visible: [],
        hidden: [],
        bounds: null,
      };
    }
    const ax = mesh.positions[ia * 3] ?? 0;
    const ay = mesh.positions[ia * 3 + 1] ?? 0;
    const az = mesh.positions[ia * 3 + 2] ?? 0;
    const bx = mesh.positions[ib * 3] ?? 0;
    const by = mesh.positions[ib * 3 + 1] ?? 0;
    const bz = mesh.positions[ib * 3 + 2] ?? 0;
    const cx = mesh.positions[ic * 3] ?? 0;
    const cy = mesh.positions[ic * 3 + 1] ?? 0;
    const cz = mesh.positions[ic * 3 + 2] ?? 0;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    normals.push([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
  }
  // Feature edges: sorted-index-pair keys, first-seen order, with the
  // accumulated left/right face normals for the dihedral test.
  const edgeOrder: string[] = [];
  const edgeFaces = new Map<string, [number, number] | [number]>();
  const edgeEnds = new Map<string, [number, number]>();
  for (let t = 0; t < triangleCount; t += 1) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const loop = [ia, ib, ic, ia];
    for (let e = 0; e < 3; e += 1) {
      const from = loop[e];
      const to = loop[e + 1];
      if (from === undefined || to === undefined || from === to) continue;
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      const existing = edgeFaces.get(key);
      if (existing === undefined) {
        edgeFaces.set(key, [t]);
        edgeEnds.set(key, [from, to]);
        edgeOrder.push(key);
      } else if (existing.length === 1) {
        edgeFaces.set(key, [existing[0] ?? t, t]);
      }
    }
  }
  const visible: ProjectedChain[] = [];
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const track = (u: number, v: number): void => {
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  };
  for (const key of edgeOrder) {
    const faces = edgeFaces.get(key);
    const ends = edgeEnds.get(key);
    if (faces === undefined || ends === undefined) continue;
    if (faces.length === 2) {
      const n1 = normals[faces[0] ?? 0];
      const n2 = normals[faces[1] ?? 0];
      if (n1 === undefined || n2 === undefined) continue;
      const l1 = Math.sqrt(n1[0] * n1[0] + n1[1] * n1[1] + n1[2] * n1[2]);
      const l2 = Math.sqrt(n2[0] * n2[0] + n2[1] * n2[1] + n2[2] * n2[2]);
      if (l1 === 0 || l2 === 0) continue;
      const cos = (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (l1 * l2);
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (angle <= FEATURE_EDGE_DIHEDRAL_THRESHOLD_RAD) continue;
    }
    const a = ends[0];
    const b = ends[1];
    if (a === undefined || b === undefined) continue;
    let first3: readonly [number, number, number] | null = vertexPoint(mesh, a);
    let second3: readonly [number, number, number] | null = vertexPoint(
      mesh,
      b,
    );
    if (first3 === null || second3 === null) continue;
    if (plane !== null) {
      const clipped = clipSegmentToPlane(first3, second3, plane);
      if (clipped === null) continue;
      first3 = clipped[0];
      second3 = clipped[1];
    }
    const first = toPlane(first3, basis);
    const second = toPlane(second3, basis);
    // An edge parallel to the view direction projects to a POINT — a
    // zero-length chain is nothing to draw (a drawing never renders a dot
    // for an edge seen end-on), so it is dropped here rather than emitted
    // as a degenerate segment.
    if (first[0] === second[0] && first[1] === second[1]) continue;
    track(first[0], first[1]);
    track(second[0], second[1]);
    visible.push([first, second]);
  }
  if (visible.length === 0) {
    return { fidelity: "edges-overlay", visible: [], hidden: [], bounds: null };
  }
  return {
    fidelity: "edges-overlay",
    visible,
    hidden: [],
    bounds: { minU, maxU, minV, maxV },
  };
}

function normalizeClipPlane(plane: OverlayClipPlane | undefined): {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly d: number;
} | null {
  if (plane === undefined) return null;
  const len = Math.sqrt(
    plane.normal[0] * plane.normal[0] +
      plane.normal[1] * plane.normal[1] +
      plane.normal[2] * plane.normal[2],
  );
  if (len === 0) return null;
  return {
    nx: plane.normal[0] / len,
    ny: plane.normal[1] / len,
    nz: plane.normal[2] / len,
    d: plane.offset,
  };
}

function signedDistanceTo(
  p: readonly [number, number, number],
  plane: {
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly d: number;
  },
): number {
  return plane.nx * p[0] + plane.ny * p[1] + plane.nz * p[2] - plane.d;
}

/**
 * Clips a segment to the kept half-space, interpolating the crossing at
 * the plane. Returns `null` when the whole segment falls on the removed
 * side. An endpoint exactly on the plane counts as kept.
 */
function clipSegmentToPlane(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  plane: {
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly d: number;
  },
):
  | readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ]
  | null {
  const EPSILON = 1e-9;
  const da = signedDistanceTo(a, plane);
  const db = signedDistanceTo(b, plane);
  const aKept = da >= -EPSILON;
  const bKept = db >= -EPSILON;
  if (aKept && bKept) return [a, b];
  if (!aKept && !bKept) return null;
  const t = da / (da - db);
  const crossing: [number, number, number] = [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
    a[2] + t * (b[2] - a[2]),
  ];
  return aKept ? [a, crossing] : [crossing, b];
}

function vertexPoint(
  mesh: OverlayMesh,
  vertex: number,
): [number, number, number] | null {
  const x = mesh.positions[vertex * 3];
  const y = mesh.positions[vertex * 3 + 1];
  const z = mesh.positions[vertex * 3 + 2];
  if (x === undefined || y === undefined || z === undefined) return null;
  return [x, y, z];
}

function toPlane(
  p: readonly [number, number, number],
  basis: {
    readonly right: readonly [number, number, number];
    readonly up: readonly [number, number, number];
  },
): [number, number] {
  return [
    p[0] * basis.right[0] + p[1] * basis.right[1] + p[2] * basis.right[2],
    p[0] * basis.up[0] + p[1] * basis.up[1] + p[2] * basis.up[2],
  ];
}
