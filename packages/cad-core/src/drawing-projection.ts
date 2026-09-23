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
 * Projects a tessellated body onto an arbitrary (eye, up) basis — the
 * general form of {@link edgesOverlayProjectionForKind}.
 */
export function edgesOverlayProjection(
  mesh: OverlayMesh,
  eye: readonly [number, number, number],
  upHint: readonly [number, number, number],
): DrawingViewGeometry {
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
    const first = projectVertex(mesh, a, basis);
    const second = projectVertex(mesh, b, basis);
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

function projectVertex(
  mesh: OverlayMesh,
  vertex: number,
  basis: {
    readonly right: readonly [number, number, number];
    readonly up: readonly [number, number, number];
  },
): [number, number] {
  const x = mesh.positions[vertex * 3] ?? 0;
  const y = mesh.positions[vertex * 3 + 1] ?? 0;
  const z = mesh.positions[vertex * 3 + 2] ?? 0;
  return [
    x * basis.right[0] + y * basis.right[1] + z * basis.right[2],
    x * basis.up[0] + y * basis.up[1] + z * basis.up[2],
  ];
}
