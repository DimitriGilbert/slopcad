/**
 * Phase 55 derived-view geometry: projected, auxiliary, section, detail,
 * and broken-out views, all over the deterministic edges-overlay pipeline.
 *
 * Every function here is pure float64 math over an {@link OverlayMesh} (or
 * an existing {@link DrawingViewGeometry}) — no clocks, no randomness — so
 * the same inputs produce byte-identical chains. The results are
 * `DrawingViewGeometry` values with `fidelity: "edges-overlay"`: like the
 * Phase 53 fallback, they draw no hidden lines and are never to be
 * presented as exact HLR.
 *
 * ## The five derivations
 *
 * - **Projected (fold-line method).** `projectedViewBasis` folds a parent
 *   view's basis by 90° to the left, back, or bottom: a left fold negates
 *   the parent's sheet-right into the eye (sheet-up kept, so the vertical
 *   registration with the parent survives — the Phase 53 alignment law's
 *   axis rule), a back fold negates the eye, a bottom fold negates the
 *   sheet-up into the eye while keeping the sheet-right (horizontal
 *   registration).
 * - **Auxiliary.** `auxiliaryViewBasis` takes an inclined EDGE (two world
 *   endpoints): the auxiliary eye is the in-parent-view-plane direction
 *   perpendicular to the edge's parent-projection (chosen as the side the
 *   parent's eye is on), and the edge is the sheet-up axis — the edge shows
 *   true length. An edge parallel to the parent's look direction has no
 *   in-plane projection and yields `null` (structured decline, not a wrong
 *   picture).
 * - **Section.** `sectionOverlayProjection` cuts the tessellated body by a
 *   plane (the Phase 46 section-record vocabulary: origin, normal, kept
 *   side): feature edges clip to the kept side in world space (the only
 *   space where the side test is defined), and the cut face — the closed
 *   polygon loop(s) the plane traces through the mesh — hatches with a
 *   deterministic line family at the requested spacing and angle.
 * - **Detail.** `detailCropGeometry` crops an existing geometry to a
 *   circle in view-plane model millimetres; segments crossing the circle
 *   are clipped at it, chains falling outside are dropped, and the bounds
 *   shrink to the crop (or `null` when nothing is inside).
 * - **Broken-out.** `brokenOutOverlayProjection` adds a section hatch
 *   restricted to a band of the parent view's geometry: cut-face strokes
 *   whose midpoints fall inside the u-band survive; the edges stay the
 *   plain (unsectioned) projection.
 *
 * ## The cut face and its area
 *
 * `meshPlaneCrossSection` walks every triangle that straddles the plane,
 * takes the two intersection points per straddling triangle as a segment,
 * and stitches segments sharing a quantized endpoint into closed loops.
 * The loops lie in world axes on the cut plane; `polygonArea` (shoelace)
 * is the area the hatching fills — the same quantity the Phase 46 kernel
 * section face measures for the same body and plane, which the section
 * fixtures pin.
 */

import {
  type DrawingProjectedDirection,
  type DrawingViewGeometry,
  type ProjectedChain,
  type ViewBasis,
  viewBasis,
  viewBasisForKind,
} from "./drawing";
import {
  type OverlayClipPlane,
  type OverlayMesh,
  edgesOverlayProjection,
} from "./drawing-projection";

// ---------------------------------------------------------------------------
// Projected (fold-line) and auxiliary bases
// ---------------------------------------------------------------------------

/**
 * The fold-line basis for a projected view (Phase 55): folds the parent
 * view's basis by 90° to the given direction (module docs).
 */
export function projectedViewBasis(
  parent: ViewBasis,
  direction: DrawingProjectedDirection,
): ViewBasis {
  if (direction === "back") {
    return viewBasis(negate(eyeOf(parent)), parent.up);
  }
  if (direction === "left") {
    return viewBasis(negate(parent.right), parent.up);
  }
  // bottom: the eye folds to the parent's -sheet-up; the parent's
  // sheet-right is kept, and the up hint is the unique axis completing the
  // frame (up = eye x right, since viewBasis derives right = up x eye).
  const eye = negate(parent.up);
  return viewBasis(eye, cross(eye, parent.right));
}

/**
 * The fold-line basis for a projected view whose parent is a BASE view
 * kind ({@link projectedViewBasis} general form).
 */
export function projectedViewBasisForKind(
  parentKind: Parameters<typeof viewBasisForKind>[0],
  direction: DrawingProjectedDirection,
): ViewBasis {
  return projectedViewBasis(viewBasisForKind(parentKind), direction);
}

/**
 * The auxiliary-view basis from an inclined edge (module docs): `null`
 * when the edge projects to nothing in the parent's view (it runs parallel
 * to the parent's look direction) — the auxiliary view is then undefined
 * and the caller must decline rather than draw a wrong picture.
 */
export function auxiliaryViewBasis(
  parent: ViewBasis,
  edgeFrom: readonly [number, number, number],
  edgeTo: readonly [number, number, number],
): ViewBasis | null {
  const ex = edgeTo[0] - edgeFrom[0];
  const ey = edgeTo[1] - edgeFrom[1];
  const ez = edgeTo[2] - edgeFrom[2];
  const eLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (eLen === 0) return null;
  const e: [number, number, number] = [ex / eLen, ey / eLen, ez / eLen];
  // Remove the look-direction component: the edge's in-plane projection.
  const dot =
    e[0] * parent.look[0] + e[1] * parent.look[1] + e[2] * parent.look[2];
  const proj: [number, number, number] = [
    e[0] - dot * parent.look[0],
    e[1] - dot * parent.look[1],
    e[2] - dot * parent.look[2],
  ];
  const projLen = Math.sqrt(
    proj[0] * proj[0] + proj[1] * proj[1] + proj[2] * proj[2],
  );
  if (projLen < 1e-12) return null;
  // The auxiliary eye is perpendicular to the edge, inside the parent's
  // view plane: the cross of the edge's in-plane projection with the look
  // direction. The sign follows the parent's eye side, so the auxiliary
  // view looks at the same half of the object.
  const raw = cross(proj, parent.look);
  const rawLen = Math.sqrt(raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2]);
  const parentEye = eyeOf(parent);
  const sign =
    raw[0] * parentEye[0] + raw[1] * parentEye[1] + raw[2] * parentEye[2] >= 0
      ? 1
      : -1;
  const eye: [number, number, number] = [
    (sign * raw[0]) / rawLen,
    (sign * raw[1]) / rawLen,
    (sign * raw[2]) / rawLen,
  ];
  return viewBasis(eye, e);
}

// ---------------------------------------------------------------------------
// Section: mesh/plane cross-section, kept-side clipping, hatching
// ---------------------------------------------------------------------------

/** One closed cross-section loop: world-space vertices on the cut plane. */
export type CrossSectionLoop = readonly (readonly [number, number, number])[];

/** The plane a section view cuts with (the Phase 46 record vocabulary). */
export interface SectionPlane {
  readonly origin: readonly [number, number, number];
  /** Any finite non-zero normal (normalized on use). */
  readonly normal: readonly [number, number, number];
  /** `+1` keeps the normal's side, `-1` the opposite. */
  readonly keepSide: 1 | -1;
}

/** The default hatch stroke spacing (model millimetres). */
export const DEFAULT_HATCH_SPACING_MM = 2;

/** The default hatch angle, radians (the drafting 45° convention). */
export const DEFAULT_HATCH_ANGLE_RAD = Math.PI / 4;

/** Hard cap on hatch strokes per call (a degenerate spacing must not hang
 * the renderer); the family simply stops at the cap. */
const HATCH_STROKE_CAP = 20000;

/** Loop-stitching quantization, millimetres: endpoints within this radius
 * join (well below any drafting-visible length, well above float64 noise
 * for model-scale meshes). */
const STITCH_EPSILON = 1e-6;

const key3 = (p: readonly [number, number, number]): string =>
  `${Math.round(p[0] / STITCH_EPSILON)}|${Math.round(p[1] / STITCH_EPSILON)}|${Math.round(p[2] / STITCH_EPSILON)}`;

/**
 * Traces the closed polygon loop(s) the plane cuts through the mesh.
 * Deterministic: triangles walk in index order; loops stitch from the
 * lexicographically first unconsumed vertex, always continuing through an
 * unused segment to the next vertex.
 */
export function meshPlaneCrossSection(
  mesh: OverlayMesh,
  plane: SectionPlane,
): { readonly loops: readonly CrossSectionLoop[] } {
  const n = plane.normal;
  const nLen = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  if (nLen === 0) return { loops: [] };
  const nx = n[0] / nLen;
  const ny = n[1] / nLen;
  const nz = n[2] / nLen;
  const offset =
    nx * plane.origin[0] + ny * plane.origin[1] + nz * plane.origin[2];
  const triangleCount = Math.floor(mesh.indices.length / 3);
  const segments: (readonly [Vec3, Vec3])[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const a = vertexOf(mesh, ia);
    const b = vertexOf(mesh, ib);
    const c = vertexOf(mesh, ic);
    if (a === null || b === null || c === null) continue;
    const da = signedDistance(a, nx, ny, nz, offset);
    const db = signedDistance(b, nx, ny, nz, offset);
    const dc = signedDistance(c, nx, ny, nz, offset);
    // Straddling triangles only: vertices exactly on the plane are not on
    // either side, so a triangle touching the plane tangentially produces
    // no segment (its cut face degenerates to an edge, which draws
    // nothing). A straddling triangle has one vertex on one side and two
    // on the other — exactly one pair shares a side.
    const sa = side(da);
    const sb = side(db);
    const sc = side(dc);
    if (sa === 0 || sb === 0 || sc === 0) continue;
    if (sa === sb && sb === sc) continue;
    const crossings: Vec3[] = [];
    if (sa !== sb) crossings.push(edgePoint(a, da, b, db));
    if (sb !== sc) crossings.push(edgePoint(b, db, c, dc));
    if (sa !== sc) crossings.push(edgePoint(a, da, c, dc));
    if (crossings.length === 2) {
      const p = crossings[0];
      const q = crossings[1];
      if (p !== undefined && q !== undefined && key3(p) !== key3(q)) {
        segments.push([p, q]);
      }
    }
  }
  return { loops: stitchLoops(segments) };
}

/**
 * The planar polygon's area from the magnitude of its AREA VECTOR: the
 * edge-cross-product sum Σ p×q is a VECTOR — 2·A·n̂ for a planar loop of
 * area A and unit normal n̂ — so the area is half that vector's magnitude.
 * (A scalar sum of the three projected cross products would measure
 * A·|n̂x+n̂y+n̂z| and overstate every oblique cut by up to √3 — the
 * 10 mm cube's x+y+z=15 hexagon read 225 instead of 75·√3 ≈ 129.9.) For
 * cross-section loops (vertices on the cut plane) this is the cut-face
 * area in square millimetres — the quantity the Phase 46 kernel section
 * face measures for the same body and plane.
 */
export function polygonArea(loop: CrossSectionLoop): number {
  let wx = 0;
  let wy = 0;
  let wz = 0;
  const count = loop.length;
  for (let i = 0; i < count; i += 1) {
    const p = loop[i];
    const q = loop[(i + 1) % count];
    if (p === undefined || q === undefined) continue;
    wx += p[1] * q[2] - p[2] * q[1];
    wy += p[2] * q[0] - p[0] * q[2];
    wz += p[0] * q[1] - p[1] * q[0];
  }
  return Math.sqrt(wx * wx + wy * wy + wz * wz) / 2;
}

/**
 * Deterministic hatch strokes for a set of closed loops: a line family at
 * `angleRad` to the plane's first defining edge, spaced `spacingMm` apart,
 * even-odd paired against the loop edges (inner loops cut holes — the
 * overlay's honest best effort for faces with islands). Strokes come back
 * in the SAME world axes as the loops, two points each, capped at
 * {@link HATCH_STROKE_CAP}.
 */
export function hatchLoops(
  loops: readonly CrossSectionLoop[],
  spacingMm: number,
  angleRad: number,
): readonly WorldChain[] {
  if (loops.length === 0 || !(spacingMm > 0)) return [];
  const frame = hatchFrame(loops, angleRad);
  if (frame === null) return [];
  const [u, v] = frame;
  // The (u, v) projection is relative to a reference point ON the plane
  // (the frame's origin is the world origin, which is not on the plane);
  // strokes are rebuilt around the same reference.
  const ref = loops[0]?.[0];
  if (ref === undefined) return [];
  const rel = (
    p: readonly [number, number, number],
  ): readonly [number, number, number] => [
    p[0] - ref[0],
    p[1] - ref[1],
    p[2] - ref[2],
  ];
  let minV = Infinity;
  let maxV = -Infinity;
  const projected = loops.map((loop) =>
    loop.map((p) => {
      const r = rel(p);
      const pu = r[0] * u[0] + r[1] * u[1] + r[2] * u[2];
      const pv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
      return [pu, pv] as const;
    }),
  );
  const strokes: WorldChain[] = [];
  const firstC = Math.ceil(minV / spacingMm) * spacingMm;
  for (
    let c = firstC;
    c <= maxV && strokes.length < HATCH_STROKE_CAP;
    c += spacingMm
  ) {
    // Even-odd crossing count along the scan line: intersect every loop
    // edge with v = c, collect u, sort, pair.
    const us: number[] = [];
    for (const loop of projected) {
      const count = loop.length;
      for (let i = 0; i < count; i += 1) {
        const p = loop[i];
        const q = loop[(i + 1) % count];
        if (p === undefined || q === undefined) continue;
        if (p[1] === q[1]) continue;
        if ((p[1] <= c && q[1] > c) || (q[1] <= c && p[1] > c)) {
          const t = (c - p[1]) / (q[1] - p[1]);
          us.push(p[0] + t * (q[0] - p[0]));
        }
      }
    }
    us.sort((a, b) => a - b);
    for (
      let i = 0;
      i + 1 < us.length && strokes.length < HATCH_STROKE_CAP;
      i += 2
    ) {
      const u0 = us[i];
      const u1 = us[i + 1];
      if (u0 === undefined || u1 === undefined || u1 - u0 < STITCH_EPSILON) {
        continue;
      }
      strokes.push([
        [
          ref[0] + u0 * u[0] + c * v[0],
          ref[1] + u0 * u[1] + c * v[1],
          ref[2] + u0 * u[2] + c * v[2],
        ],
        [
          ref[0] + u1 * u[0] + c * v[0],
          ref[1] + u1 * u[1] + c * v[1],
          ref[2] + u1 * u[2] + c * v[2],
        ],
      ]);
    }
  }
  return strokes;
}

/** A world-space two-point chain (hatch strokes come back in world axes). */
export type WorldChain = readonly (readonly [number, number, number])[];

/**
 * The section view's overlay geometry: the kept side's projected feature
 * edges (chains clipped at the cut plane, in world space before
 * projection) plus the cut face's hatch transformed into the view basis —
 * one `DrawingViewGeometry`, fidelity `edges-overlay` (module docs).
 */
export function sectionOverlayProjection(
  mesh: OverlayMesh,
  plane: SectionPlane,
  eye: readonly [number, number, number],
  upHint: readonly [number, number, number],
  hatchSpacingMm: number = DEFAULT_HATCH_SPACING_MM,
  hatchAngleRad: number = DEFAULT_HATCH_ANGLE_RAD,
): DrawingViewGeometry {
  const clip = keptSideClipPlane(plane);
  const base =
    clip === null
      ? edgesOverlayProjection(mesh, eye, upHint)
      : edgesOverlayProjection(mesh, eye, upHint, clip);
  if (base.bounds === null) return base;
  const cut = meshPlaneCrossSection(mesh, plane);
  const basis = viewBasis(eye, upHint);
  const hatch: ProjectedChain[] = [];
  for (const stroke of hatchLoops(cut.loops, hatchSpacingMm, hatchAngleRad)) {
    const a = stroke[0];
    const b = stroke[1];
    if (a === undefined || b === undefined) continue;
    hatch.push([toViewPlane(a, basis), toViewPlane(b, basis)]);
  }
  return {
    fidelity: "edges-overlay",
    visible: base.visible,
    hidden: [],
    hatch,
    bounds: base.bounds,
  };
}

/**
 * The broken-out variant: the FULL unsectioned projection of the body,
 * with the cut face's hatch added only inside the u-band (`bandMinU`..
 * `bandMaxU`, view-plane model millimetres, strokes judged by midpoint).
 */
export function brokenOutOverlayProjection(
  mesh: OverlayMesh,
  plane: SectionPlane,
  bandMinU: number,
  bandMaxU: number,
  eye: readonly [number, number, number],
  upHint: readonly [number, number, number],
  hatchSpacingMm: number = DEFAULT_HATCH_SPACING_MM,
): DrawingViewGeometry {
  const full = edgesOverlayProjection(mesh, eye, upHint);
  if (full.bounds === null) return full;
  const cut = meshPlaneCrossSection(mesh, plane);
  const basis = viewBasis(eye, upHint);
  const hatch: ProjectedChain[] = [];
  for (const stroke of hatchLoops(
    cut.loops,
    hatchSpacingMm,
    DEFAULT_HATCH_ANGLE_RAD,
  )) {
    const a = stroke[0];
    const b = stroke[1];
    if (a === undefined || b === undefined) continue;
    const av = toViewPlane(a, basis);
    const bv = toViewPlane(b, basis);
    const midU = (av[0] + bv[0]) / 2;
    if (midU < bandMinU || midU > bandMaxU) continue;
    hatch.push([av, bv]);
  }
  return {
    fidelity: "edges-overlay",
    visible: full.visible,
    hidden: [],
    hatch,
    bounds: full.bounds,
  };
}

/**
 * Crops an existing geometry to a circle (centre in view-plane model
 * millimetres): segments crossing the circle are clipped at it, outside
 * chains drop, and the bounds shrink to what remains. `null` bounds when
 * nothing survives (the honest empty crop).
 */
export function detailCropGeometry(
  geometry: DrawingViewGeometry,
  centreU: number,
  centreV: number,
  radiusMm: number,
): DrawingViewGeometry {
  if (!(radiusMm > 0)) {
    return {
      fidelity: geometry.fidelity,
      visible: [],
      hidden: [],
      ...(geometry.hatch === undefined ? {} : { hatch: [] }),
      bounds: null,
    };
  }
  const crop = (chains: readonly ProjectedChain[]): ProjectedChain[] => {
    const out: ProjectedChain[] = [];
    for (const chain of chains) {
      const cropped = cropChainToCircle(chain, centreU, centreV, radiusMm);
      if (cropped.length >= 2) out.push(cropped);
    }
    return out;
  };
  const visible = crop(geometry.visible);
  const hidden = crop(geometry.hidden);
  const hatch = crop(geometry.hatch ?? []);
  return recomputedBounds({
    fidelity: geometry.fidelity,
    visible,
    hidden,
    ...(geometry.hatch === undefined ? {} : { hatch }),
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

/** A view basis's eye direction (the negation of its look vector). */
function eyeOf(basis: ViewBasis): [number, number, number] {
  return [-basis.look[0], -basis.look[1], -basis.look[2]];
}

function negate(v: Vec3): [number, number, number] {
  return [-v[0], -v[1], -v[2]];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vertexOf(mesh: OverlayMesh, index: number): Vec3 | null {
  const o = index * 3;
  const x = mesh.positions[o];
  const y = mesh.positions[o + 1];
  const z = mesh.positions[o + 2];
  if (x === undefined || y === undefined || z === undefined) return null;
  return [x, y, z];
}

function signedDistance(
  p: Vec3,
  nx: number,
  ny: number,
  nz: number,
  offset: number,
): number {
  return nx * p[0] + ny * p[1] + nz * p[2] - offset;
}

function side(distance: number): 1 | 0 | -1 {
  if (distance > STITCH_EPSILON) return 1;
  if (distance < -STITCH_EPSILON) return -1;
  return 0;
}

function edgePoint(a: Vec3, da: number, b: Vec3, db: number): Vec3 {
  const t = da / (da - db);
  return [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
    a[2] + t * (b[2] - a[2]),
  ];
}

/** One directed segment: `from` → `to`, both as points and quantized keys. */
interface DirectedSegment {
  readonly fromKey: string;
  readonly from: Vec3;
  readonly toKey: string;
  readonly to: Vec3;
  /** The reverse direction of the same undirected edge. */
  twin?: DirectedSegment;
}

/** Stitches closed loops from segments sharing quantized endpoints. */
function stitchLoops(
  segments: readonly (readonly [Vec3, Vec3])[],
): readonly CrossSectionLoop[] {
  const outgoing = new Map<string, DirectedSegment[]>();
  for (const [p, q] of segments) {
    const kp = key3(p);
    const kq = key3(q);
    if (kp === kq) continue;
    const forward: DirectedSegment = {
      fromKey: kp,
      from: p,
      toKey: kq,
      to: q,
    };
    const backward: DirectedSegment = {
      fromKey: kq,
      from: q,
      toKey: kp,
      to: p,
    };
    forward.twin = backward;
    backward.twin = forward;
    pushDirected(outgoing, kp, forward);
    pushDirected(outgoing, kq, backward);
  }
  const loops: CrossSectionLoop[] = [];
  const used = new Set<DirectedSegment>();
  const startKeys = [...outgoing.keys()].sort();
  for (const startKey of startKeys) {
    let edge = takeNext(outgoing, startKey, used);
    if (edge === undefined) continue;
    const loop: Vec3[] = [edge.from];
    let guard = segments.length + 2;
    while (guard > 0) {
      guard -= 1;
      loop.push(edge.to);
      if (edge.toKey === startKey) break;
      const next = takeNext(outgoing, edge.toKey, used);
      if (next === undefined) break;
      edge = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function pushDirected(
  map: Map<string, DirectedSegment[]>,
  key: string,
  segment: DirectedSegment,
): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [segment]);
  else existing.push(segment);
}

/** Takes the first unused outgoing segment at `key` (deterministic order). */
function takeNext(
  map: Map<string, DirectedSegment[]>,
  key: string,
  used: Set<DirectedSegment>,
): DirectedSegment | undefined {
  const candidates = map.get(key);
  if (candidates === undefined) return undefined;
  for (const segment of candidates) {
    if (!used.has(segment)) {
      // Consuming one direction consumes the undirected edge: the walk
      // must never bounce straight back over the segment it arrived on.
      used.add(segment);
      if (segment.twin !== undefined) used.add(segment.twin);
      return segment;
    }
  }
  return undefined;
}

/**
 * A local in-plane frame for the loops' plane: `u` along the requested
 * hatch angle (rotated from the plane's first defining edge about the
 * plane normal, Rodrigues), `v = normal x u`. `null` when the loops are
 * degenerate (no area-defining plane).
 */
function hatchFrame(
  loops: readonly CrossSectionLoop[],
  angleRad: number,
): readonly [[number, number, number], [number, number, number]] | null {
  for (const loop of loops) {
    for (let i = 1; i < loop.length; i += 1) {
      const p0 = loop[i - 1];
      const p1 = loop[i];
      if (p0 === undefined || p1 === undefined) continue;
      const ex = p1[0] - p0[0];
      const ey = p1[1] - p0[1];
      const ez = p1[2] - p0[2];
      const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (len < STITCH_EPSILON) continue;
      const e: Vec3 = [ex / len, ey / len, ez / len];
      const normal = planeNormalFromLoop(loop, i);
      if (normal === null) continue;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const exn = cross(normal, e);
      const u: [number, number, number] = [
        e[0] * cos + exn[0] * sin,
        e[1] * cos + exn[1] * sin,
        e[2] * cos + exn[2] * sin,
      ];
      const v = cross(normal, u);
      return [u, v] as const;
    }
  }
  return null;
}

/** The loop's plane normal from the edge at `i` and a later non-parallel edge. */
function planeNormalFromLoop(
  loop: CrossSectionLoop,
  from: number,
): [number, number, number] | null {
  const p0 = loop[from - 1];
  const p1 = loop[from];
  if (p0 === undefined || p1 === undefined) return null;
  const ex = p1[0] - p0[0];
  const ey = p1[1] - p0[1];
  const ez = p1[2] - p0[2];
  const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (len < STITCH_EPSILON) return null;
  const e: Vec3 = [ex / len, ey / len, ez / len];
  const count = loop.length;
  for (let j = from + 1; j < count; j += 1) {
    const q0 = loop[j - 1];
    const q1 = loop[j];
    if (q0 === undefined || q1 === undefined) continue;
    const candidate = cross(e, [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]]);
    const clen = Math.sqrt(
      candidate[0] * candidate[0] +
        candidate[1] * candidate[1] +
        candidate[2] * candidate[2],
    );
    if (clen > 1e-9) {
      return [candidate[0] / clen, candidate[1] / clen, candidate[2] / clen];
    }
  }
  return null;
}

/** The world-space clip plane matching a section plane's kept side. */
function keptSideClipPlane(plane: SectionPlane): OverlayClipPlane | null {
  const n = plane.normal;
  const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  if (len === 0) return null;
  const s = plane.keepSide;
  const nx = (n[0] / len) * s;
  const ny = (n[1] / len) * s;
  const nz = (n[2] / len) * s;
  return {
    normal: [nx, ny, nz],
    offset: nx * plane.origin[0] + ny * plane.origin[1] + nz * plane.origin[2],
  };
}

function toViewPlane(
  p: Vec3,
  basis: { readonly right: Vec3; readonly up: Vec3 },
): [number, number] {
  return [
    p[0] * basis.right[0] + p[1] * basis.right[1] + p[2] * basis.right[2],
    p[0] * basis.up[0] + p[1] * basis.up[1] + p[2] * basis.up[2],
  ];
}

function recomputedBounds(geometry: {
  readonly fidelity: DrawingViewGeometry["fidelity"];
  readonly visible: readonly ProjectedChain[];
  readonly hidden: readonly ProjectedChain[];
  readonly hatch?: readonly ProjectedChain[];
}): DrawingViewGeometry {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const track = (p: readonly [number, number]): void => {
    if (p[0] < minU) minU = p[0];
    if (p[0] > maxU) maxU = p[0];
    if (p[1] < minV) minV = p[1];
    if (p[1] > maxV) maxV = p[1];
  };
  for (const chain of geometry.visible) for (const p of chain) track(p);
  for (const chain of geometry.hidden) for (const p of chain) track(p);
  if (minU === Infinity) {
    return {
      fidelity: geometry.fidelity,
      visible: [],
      hidden: [],
      ...(geometry.hatch === undefined ? {} : { hatch: geometry.hatch }),
      bounds: null,
    };
  }
  return {
    fidelity: geometry.fidelity,
    visible: geometry.visible,
    hidden: geometry.hidden,
    ...(geometry.hatch === undefined ? {} : { hatch: geometry.hatch }),
    bounds: { minU, maxU, minV, maxV },
  };
}

function cropChainToCircle(
  chain: ProjectedChain,
  centreU: number,
  centreV: number,
  radiusMm: number,
): ProjectedChain {
  const inside = (p: readonly [number, number]): boolean => {
    const du = p[0] - centreU;
    const dv = p[1] - centreV;
    return du * du + dv * dv <= radiusMm * radiusMm;
  };
  const out: (readonly [number, number])[] = [];
  let previous: readonly [number, number] | null = null;
  for (const point of chain) {
    if (previous !== null) {
      const pIn = inside(previous);
      const cIn = inside(point);
      if (pIn !== cIn) {
        out.push(
          circleCrossing(previous, point, centreU, centreV, radiusMm, pIn),
        );
      } else if (
        !pIn &&
        segmentEntersCircle(previous, point, centreU, centreV, radiusMm)
      ) {
        // Both endpoints outside but the segment crosses the circle twice:
        // emit the interior chord.
        out.push(
          circleCrossing(previous, point, centreU, centreV, radiusMm, false),
        );
        out.push(
          circleCrossing(previous, point, centreU, centreV, radiusMm, true),
        );
      }
    }
    if (inside(point)) out.push(point);
    previous = point;
  }
  return out;
}

/**
 * Whether a segment with both endpoints outside the circle meets it:
 * the closest approach of the segment's line (closed form) is inside the
 * radius, with the foot inside the segment.
 */
function segmentEntersCircle(
  a: readonly [number, number],
  b: readonly [number, number],
  centreU: number,
  centreV: number,
  radiusMm: number,
): boolean {
  const du = b[0] - a[0];
  const dv = b[1] - a[1];
  const length2 = du * du + dv * dv;
  if (length2 === 0) return false;
  const t = -((a[0] - centreU) * du + (a[1] - centreV) * dv) / length2;
  const footU = a[0] + t * du;
  const footV = a[1] + t * dv;
  const dfu = footU - centreU;
  const dfv = footV - centreV;
  return dfu * dfu + dfv * dfv <= radiusMm * radiusMm;
}

/**
 * The segment/circle crossing by bisection (deterministic fixed 40
 * iterations — far past float64 resolution at drafting scales). `fromIsInside`
 * disambiguates which side the crossing leaves.
 */
function circleCrossing(
  a: readonly [number, number],
  b: readonly [number, number],
  centreU: number,
  centreV: number,
  radiusMm: number,
  fromIsInside: boolean,
): [number, number] {
  const insideAt = (t: number): boolean => {
    const u = a[0] + t * (b[0] - a[0]);
    const v = a[1] + t * (b[1] - a[1]);
    const du = u - centreU;
    const dv = v - centreV;
    return du * du + dv * dv <= radiusMm * radiusMm;
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (insideAt(mid) === fromIsInside) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
