/**
 * Profile-extrusion, profile-revolution, sweep, and loft geometry helpers
 * (Phase 26.1 / 26.2 / 26.3 / 26.4): the pure 2D/3D math the mesh-building
 * kernels (the fake kernel, the JSCAD adapter's station loft) need to
 * execute the contract's `extrude`, `revolve`, `sweep`, and `loft` — loop
 * tessellation into a chord polygon at a documented angular deflection,
 * exact shoelace area, even-odd point classification, the axis-angle
 * rotation matrix, the revolve's shared axis-validation core (signed-
 * distance extremes about an in-plane axis, exact over lines, arcs, and
 * circles; the crossing rule; the axis-frame tessellation; the Pappus
 * swept volume), the sweep's path battery (structural validation, the
 * chord-polyline self-intersection test, the per-arc axis-crossing rule,
 * the piece decomposition with its fixed-binormal stations, and the
 * Pappus-exact swept volume), and the loft's collection battery (member
 * validity, station ordering, vertex-count compatibility, the CCW
 * normalization, the linear morph, and the Simpson-exact morph volume).
 * The OCCT adapter prisms, revolves, pipes, and lofts the exact analytic
 * geometry and uses only the validation core; the Manifold adapter
 * implements no sweep and no loft.
 */

import { valueIn } from "@slopcad/cad-core";

import {
  KERNEL_ERROR_CODES,
  type KernelErrorCode,
  type ProfileLoftSectionInput,
  type ProfileRevolveAxisInput,
  type ProfileSegmentInput,
  type SweepPathSegmentInput,
} from "./contract";

/** A 2D point in the profile's local frame (mm). */
export interface ProfilePoint2 {
  readonly x: number;
  readonly y: number;
}

/**
 * Maximum angle (radians) between consecutive chord segments when a mesh
 * kernel tessellates a circular profile segment. THE canonical chord
 * deviation derivation (the other deflection mentions reference this): at
 * 0.1 rad (~5.7°) a full circle resolves to n = ceil(2π/0.1) = 63 chords
 * (Δ = 2π/63 ≈ 0.0997 rad), the inscribed chord polygon's area is
 * sin(Δ)/Δ of the analytic disc — a measured 0.1657% deficit — and the
 * mid-chord radius deficit is 1 − cos(Δ/2) ≈ 1.24e-3; comfortably inside
 * the contract suite's curved-volume band.
 */
export const PROFILE_MAX_SEGMENT_ANGLE_RAD = 0.1;

/** Endpoint closure tolerance (mm) for validating a loop as closed. */
export const PROFILE_CLOSURE_TOLERANCE_MM = 1e-6;

/** The CCW sweep of a circular segment in (0, 2π]. */
export function profileSegmentSweepRad(
  segment: Extract<ProfileSegmentInput, { kind: "arc" | "circle" }>,
): number {
  if (segment.kind === "circle") return Math.PI * 2;
  const start = valueIn(segment.startAngle, "rad");
  const end = valueIn(segment.endAngle, "rad");
  const sweep = (end - start) % (Math.PI * 2);
  return sweep <= 0 ? sweep + Math.PI * 2 : sweep;
}

function arcPoint(
  center: readonly [number, number],
  radius: number,
  angle: number,
): ProfilePoint2 {
  return {
    x: center[0] + radius * Math.cos(angle),
    y: center[1] + radius * Math.sin(angle),
  };
}

/**
 * Tessellates one profile loop into the chord polygon the mesh kernels
 * extrude: line segments contribute their endpoints; arc/circle segments
 * are subdivided at {@link PROFILE_MAX_SEGMENT_ANGLE_RAD} with vertices on
 * the true circle. Shared endpoints collapse to one polygon vertex each.
 */
export function tessellateProfileLoop(
  loop: readonly ProfileSegmentInput[],
): ProfilePoint2[] {
  const points: ProfilePoint2[] = [];
  const push = (point: ProfilePoint2): void => {
    const last = points[points.length - 1];
    if (
      last !== undefined &&
      Math.hypot(last.x - point.x, last.y - point.y) <= 1e-12
    ) {
      return;
    }
    points.push(point);
  };
  for (const segment of loop) {
    if (segment.kind === "line") {
      push({ x: segment.start[0], y: segment.start[1] });
      push({ x: segment.end[0], y: segment.end[1] });
      continue;
    }
    const sweep = profileSegmentSweepRad(segment);
    const a0 =
      segment.kind === "circle" ? 0 : valueIn(segment.startAngle, "rad");
    const divisions = Math.max(
      1,
      Math.ceil(sweep / PROFILE_MAX_SEGMENT_ANGLE_RAD),
    );
    for (let i = 0; i < divisions; i += 1) {
      push(
        arcPoint(segment.center, segment.radius, a0 + (sweep * i) / divisions),
      );
    }
    // The segment's final endpoint joins the next segment's start; a full
    // circle wraps to its own start, which the dedupe above absorbs.
    if (segment.kind === "arc") {
      // push the end vertex only if the next segment's start differs — the
      // closure check handles continuity, so push it and let dedupe act.
      push(arcPoint(segment.center, segment.radius, a0 + sweep));
    }
  }
  // Final closure: the loop's first and last vertices coincide for a closed
  // boundary — drop the duplicate tail vertex.
  const first = points[0];
  const last = points[points.length - 1];
  if (
    first !== undefined &&
    last !== undefined &&
    points.length > 1 &&
    Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9
  ) {
    points.pop();
  }
  return points;
}

/** Exact shoelace signed area of a polygon (mm², positive for CCW). */
export function polygonSignedArea(polygon: readonly ProfilePoint2[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Even-odd point-in-polygon classification (boundary counts as inside). */
export function pointInPolygon(
  point: ProfilePoint2,
  polygon: readonly ProfilePoint2[],
): boolean {
  let inside = false;
  const count = polygon.length;
  for (let i = 0; i < count; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % count];
    if (a === undefined || b === undefined) continue;
    const hitsRay = a.y > point.y !== b.y > point.y;
    if (!hitsRay) continue;
    const xAtY = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (xAtY >= point.x) inside = !inside;
  }
  return inside;
}

/** The 3×3 row-major rotation matrix of an axis-angle (Rodrigues). */
export function axisAngleMatrix(
  axis: readonly [number, number, number],
  angleRad: number,
): readonly [
  [number, number, number],
  [number, number, number],
  [number, number, number],
] {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  const x = axis[0] / length;
  const y = axis[1] / length;
  const z = axis[2] / length;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** Transposes a 3×3 row-major matrix (the inverse of a pure rotation). */
export function transpose3(
  m: readonly (readonly [number, number, number])[],
): readonly [
  [number, number, number],
  [number, number, number],
  [number, number, number],
] {
  return [
    [m[0]?.[0] ?? 0, m[1]?.[0] ?? 0, m[2]?.[0] ?? 0],
    [m[0]?.[1] ?? 0, m[1]?.[1] ?? 0, m[2]?.[1] ?? 0],
    [m[0]?.[2] ?? 0, m[1]?.[2] ?? 0, m[2]?.[2] ?? 0],
  ];
}

/** Matrix×vector for a 3×3 row-major matrix. */
export function applyMatrix3(
  m: readonly (readonly [number, number, number])[],
  v: readonly [number, number, number],
): [number, number, number] {
  return [
    (m[0]?.[0] ?? 0) * v[0] + (m[0]?.[1] ?? 0) * v[1] + (m[0]?.[2] ?? 0) * v[2],
    (m[1]?.[0] ?? 0) * v[0] + (m[1]?.[1] ?? 0) * v[1] + (m[1]?.[2] ?? 0) * v[2],
    (m[2]?.[0] ?? 0) * v[0] + (m[2]?.[1] ?? 0) * v[1] + (m[2]?.[2] ?? 0) * v[2],
  ];
}

/**
 * The structural problems of a profile loop at the contract's probe scope,
 * or `null` when it is structurally sound: an empty loop, non-finite
 * coordinates, a zero-length line, a non-positive radius, a zero-sweep arc,
 * and consecutive-segment (and last-to-first) endpoint gaps beyond
 * {@link PROFILE_CLOSURE_TOLERANCE_MM}. Self-intersection is deliberately
 * NOT checked here (documented per-kernel honesty — see the contract's
 * extrude documentation).
 */
export function profileLoopProblem(
  loop: readonly ProfileSegmentInput[],
): string | null {
  if (loop.length === 0) return "the loop is empty";
  const ends: { readonly start: ProfilePoint2; readonly end: ProfilePoint2 }[] =
    [];
  for (const segment of loop) {
    if (segment.kind === "line") {
      const length = Math.hypot(
        segment.end[0] - segment.start[0],
        segment.end[1] - segment.start[1],
      );
      if (!Number.isFinite(length) || length <= PROFILE_CLOSURE_TOLERANCE_MM) {
        return "a line segment has zero (or non-finite) length";
      }
      ends.push({
        start: { x: segment.start[0], y: segment.start[1] },
        end: { x: segment.end[0], y: segment.end[1] },
      });
      continue;
    }
    if (!Number.isFinite(segment.radius) || segment.radius <= 0) {
      return "a circular segment has a non-positive (or non-finite) radius";
    }
    const [cx, cy] = segment.center;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      return "a circular segment has a non-finite center";
    }
    if (segment.kind === "circle") {
      const point = arcPoint(segment.center, segment.radius, 0);
      ends.push({ start: point, end: point });
      continue;
    }
    // Angles arrive in any authored unit (the contract's ProfileSegmentInput
    // documents "angles in any angle unit, canonicalized internally") and
    // are read in radians via the same valueIn conversion the module's
    // tessellators apply.
    if (
      !Number.isFinite(segment.startAngle.value) ||
      !Number.isFinite(segment.endAngle.value)
    ) {
      return "an arc has non-finite angles";
    }
    const a0 = valueIn(segment.startAngle, "rad");
    const a1 = valueIn(segment.endAngle, "rad");
    const sweep = (((a1 - a0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (sweep === 0) {
      return "an arc sweeps a zero angle (a full circle must use a circle segment)";
    }
    ends.push({
      start: arcPoint(segment.center, segment.radius, a0),
      end: arcPoint(segment.center, segment.radius, a1),
    });
  }
  for (let i = 0; i < ends.length; i += 1) {
    const current = ends[i];
    const next = ends[(i + 1) % ends.length];
    if (current === undefined || next === undefined) continue;
    const gap = Math.hypot(
      current.end.x - next.start.x,
      current.end.y - next.start.y,
    );
    if (!Number.isFinite(gap) || gap > PROFILE_CLOSURE_TOLERANCE_MM) {
      return `the loop does not close (gap ${gap} mm between consecutive segment endpoints)`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Revolution geometry (Phase 26.2)
// ---------------------------------------------------------------------------

/** A 2D revolve axis after normalization: origin point + unit frame. */
export interface RevolveAxisFrame {
  /** A point on the axis, local millimetres. */
  readonly origin: ProfilePoint2;
  /** The axis direction, normalized (axial coordinate). */
  readonly u: ProfilePoint2;
  /** u rotated +90°: the positive signed-radial direction. */
  readonly v: ProfilePoint2;
}

/**
 * Signed distances closer than this to the axis line count as ON the axis:
 * touching is legal (on-axis vertices, collinear edges, tangency), only
 * material strictly beyond the tolerance on both sides crosses (mm).
 */
export const REVOLVE_AXIS_TOUCH_TOLERANCE_MM = 1e-9;

/**
 * Normalizes a contract revolve axis into its frame, or `null` when the
 * direction is degenerate (zero, non-finite, or not normalizable) — the
 * adapters reject that case with `kernel/invalid-rotation` before measuring.
 */
export function normalizeRevolveAxis(
  axis: ProfileRevolveAxisInput,
): RevolveAxisFrame | null {
  const [px, py] = axis.point;
  const [dx, dy] = axis.direction;
  if (
    px === undefined ||
    py === undefined ||
    dx === undefined ||
    dy === undefined ||
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !Number.isFinite(dx) ||
    !Number.isFinite(dy)
  ) {
    return null;
  }
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0) return null;
  const ux = dx / length;
  const uy = dy / length;
  // Canonicalize −0 → 0 so identical axes always build identical frames.
  const plain = (value: number): number => (value === 0 ? 0 : value);
  return {
    origin: { x: plain(px), y: plain(py) },
    u: { x: plain(ux), y: plain(uy) },
    v: { x: plain(-uy), y: plain(ux) },
  };
}

/** The signed distance of a point from the axis line (+ on the v side). */
function axisSignedDistance(
  frame: RevolveAxisFrame,
  x: number,
  y: number,
): number {
  const { origin, u } = frame;
  return u.x * (y - origin.y) - u.y * (x - origin.x);
}

/** One segment's signed-distance extremes, exact over its true geometry. */
function segmentSignedExtremes(
  segment: ProfileSegmentInput,
  frame: RevolveAxisFrame,
): { readonly min: number; readonly max: number } {
  if (segment.kind === "line") {
    const a = axisSignedDistance(frame, segment.start[0], segment.start[1]);
    const b = axisSignedDistance(frame, segment.end[0], segment.end[1]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  // Circular geometry: s(θ) = C + r·sin(θ − φ) about the axis, with
  // C = signed distance of the center and φ = the axis direction's angle.
  // The extremes over an arc sit at its endpoints or at the sin extrema
  // θ = φ ± π/2 when the sweep contains them; a circle always spans both.
  const centerDistance = axisSignedDistance(
    frame,
    segment.center[0],
    segment.center[1],
  );
  if (segment.kind === "circle") {
    return {
      min: centerDistance - segment.radius,
      max: centerDistance + segment.radius,
    };
  }
  // Authored in any angle unit, read in radians (the module's convention).
  const a0 = valueIn(segment.startAngle, "rad");
  const sweep = profileSegmentSweepRad(segment);
  const phi = Math.atan2(frame.u.y, frame.u.x);
  const within = (theta: number): boolean =>
    (((theta - a0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) <= sweep;
  let min = Infinity;
  let max = -Infinity;
  const candidates = [a0, a0 + sweep];
  if (within(phi + Math.PI / 2)) candidates.push(phi + Math.PI / 2);
  if (within(phi - Math.PI / 2)) candidates.push(phi - Math.PI / 2);
  for (const theta of candidates) {
    const s = centerDistance + segment.radius * Math.sin(theta - phi);
    min = Math.min(min, s);
    max = Math.max(max, s);
  }
  return { min, max };
}

/**
 * The EXACT signed-distance extremes of a profile loop about the axis:
 * lines at their endpoints; arcs at their endpoints plus the sin extrema
 * their sweep actually contains (an arc that never sweeps past the axis
 * stays one-sided even when its underlying circle would cross); a circle
 * spans center ± radius. The caller passes a validated frame — degenerate
 * axes are the adapters' `kernel/invalid-rotation` rejections.
 */
export function revolveSignedExtremes(
  loop: readonly ProfileSegmentInput[],
  frame: RevolveAxisFrame,
): { readonly min: number; readonly max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const segment of loop) {
    const extremes = segmentSignedExtremes(segment, frame);
    min = Math.min(min, extremes.min);
    max = Math.max(max, extremes.max);
  }
  return { min, max };
}

/**
 * Whether the profile CROSSES the axis: material strictly beyond the touch
 * tolerance on BOTH sides. Touching (on-axis vertices, collinear edges,
 * tangency) is legal; this is the shared pre-geometry rejection every
 * kernel adapter runs before its revolve (the mesh kernels would silently
 * clip or cap the far side of a crossing contour — see the contract's
 * revolve documentation).
 */
export function revolveCrossesAxis(
  loop: readonly ProfileSegmentInput[],
  frame: RevolveAxisFrame,
): boolean {
  const { min, max } = revolveSignedExtremes(loop, frame);
  return (
    min < -REVOLVE_AXIS_TOUCH_TOLERANCE_MM &&
    max > REVOLVE_AXIS_TOUCH_TOLERANCE_MM
  );
}

/**
 * Tessellates the loop into the chord polygon the mesh kernels revolve, in
 * AXIS coordinates (x = axial, y = signed radial) at the shared angular
 * deflection — the same chord vertices {@link tessellateProfileLoop}
 * produces, expressed in the axis frame. Curved segments keep their
 * vertices on the true circle; only the chords bow inside.
 */
export function tessellateRevolveProfile(
  loop: readonly ProfileSegmentInput[],
  frame: RevolveAxisFrame,
): ProfilePoint2[] {
  return tessellateProfileLoop(loop).map((point) => ({
    x:
      (point.x - frame.origin.x) * frame.u.x +
      (point.y - frame.origin.y) * frame.u.y,
    y:
      (point.x - frame.origin.x) * frame.v.x +
      (point.y - frame.origin.y) * frame.v.y,
  }));
}

/**
 * The EXACT volume the chord polygon sweeps about the axis (Pappus's
 * centroid theorem over the polygon): `V = θ·|∫∫ s dA|`, computed in
 * closed form from the (axial, signed-radial) vertices. For straight
 * profiles this is the true swept volume; curved profiles carry only the
 * documented chord deficit. Never negative.
 */
export function revolvePappusVolume(
  polygon: readonly ProfilePoint2[],
  sweepRad: number,
): number {
  let moment = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    moment += (a.x * b.y - b.x * a.y) * (a.y + b.y);
  }
  return Math.abs((moment / 6) * sweepRad);
}

/** Multiplies two 3×3 row-major matrices. */
export function multiplyMatrix3(
  a: readonly (readonly [number, number, number])[],
  b: readonly (readonly [number, number, number])[],
): readonly [
  [number, number, number],
  [number, number, number],
  [number, number, number],
] {
  const cell = (row: number, column: number): number =>
    (a[row]?.[0] ?? 0) * (b[0]?.[column] ?? 0) +
    (a[row]?.[1] ?? 0) * (b[1]?.[column] ?? 0) +
    (a[row]?.[2] ?? 0) * (b[2]?.[column] ?? 0);
  return [
    [cell(0, 0), cell(0, 1), cell(0, 2)],
    [cell(1, 0), cell(1, 1), cell(1, 2)],
    [cell(2, 0), cell(2, 1), cell(2, 2)],
  ];
}

/**
 * The world placement of a mesh kernel's revolve output (Phase 26.2). The
 * mesh engines (Manifold, JSCAD) revolve a contour about the +z axis with
 * the profile starting at +x and sweeping counter-clockwise; the contract's
 * revolve lives in the axis frame (axial u, radial v, sweep toward w). The
 * composition mapping one onto the other: rotate the kernel output by the
 * profile's start angle (0 on the +v side, π on the −v side — the mirroring
 * the mesh kernels require), then rebase onto the axis frame (columns v, w,
 * u), then apply the contract placement (rotation first, translation
 * second). Returns the composed row-major rotation and millimetre
 * translation so an adapter builds one rigid transform, exactly one.
 */
export function revolutionMeshTransform(
  frame: RevolveAxisFrame,
  positiveSide: boolean,
  placementRotation: readonly (readonly [number, number, number])[],
  placementTranslation: readonly [number, number, number],
): {
  readonly rotation: readonly [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  readonly translation: readonly [number, number, number];
} {
  const u: readonly [number, number, number] = [frame.u.x, frame.u.y, 0];
  const v: readonly [number, number, number] = [frame.v.x, frame.v.y, 0];
  const w: readonly [number, number, number] = [0, 0, 1];
  // Columns v, w, u: the kernel's (x', y', z') = (radial@0°, radial@90°,
  // axial) reads as axis-frame (s_v, s_w, a).
  const rebase: readonly [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [v[0], w[0], u[0]],
    [v[1], w[1], u[1]],
    [v[2], w[2], u[2]],
  ];
  let rotation = multiplyMatrix3(placementRotation, rebase);
  if (!positiveSide) {
    // Rotate the kernel's sweep start by π: the mirrored contour sits at
    // the −v side, whose sweep runs [π, π + θ] in the axis frame.
    rotation = multiplyMatrix3(rotation, [
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, 1],
    ]);
  }
  const origin: readonly [number, number, number] = [
    frame.origin.x,
    frame.origin.y,
    0,
  ];
  const translated = applyMatrix3(placementRotation, origin);
  return {
    rotation,
    translation: [
      translated[0] + placementTranslation[0],
      translated[1] + placementTranslation[1],
      translated[2] + placementTranslation[2],
    ],
  };
}

// ---------------------------------------------------------------------------
// Sweep geometry (Phase 26.3)
// ---------------------------------------------------------------------------

/** A point in the sweep path's local XZ plane (mm). */
export interface SweepXZ {
  readonly x: number;
  readonly z: number;
}

/**
 * Angular tolerance (radians) for the sweep path's orientation rules: the
 * initial tangent's agreement with local +z and the G1 (tangent-continuity)
 * agreement at every joint, including a closed ring's wrap joint. Ten orders
 * above double-precision noise on computed tangents, far below any kink a
 * user or resolution would produce.
 */
export const SWEEP_TANGENT_TOLERANCE_RAD = 1e-6;

/**
 * The SIGNED sweep of a path arc in radians: `endAngle − startAngle` raw —
 * positive counter-clockwise in the (x, z) plane, negative clockwise, never
 * zero. The caller validates the domain `0 < |sweep| ≤ 2π`.
 */
export function sweepArcSignedSweep(
  segment: Extract<SweepPathSegmentInput, { kind: "arc" }>,
): number {
  return valueIn(segment.endAngle, "rad") - valueIn(segment.startAngle, "rad");
}

/** The path arc's point at a plane angle (CCW about the plane's origin). */
function sweepArcPoint(
  segment: Extract<SweepPathSegmentInput, { kind: "arc" }>,
  angle: number,
): SweepXZ {
  return {
    x: segment.center[0] + segment.radius * Math.cos(angle),
    z: segment.center[1] + segment.radius * Math.sin(angle),
  };
}

/** A unit path tangent at a plane angle, following the direction of travel. */
function sweepArcTangent(angle: number, sweep: number): SweepXZ {
  const sign = sweep > 0 ? 1 : -1;
  return { x: -sign * Math.sin(angle), z: sign * Math.cos(angle) };
}

/** Whether two unit tangents agree within the G1 tolerance. */
function tangentsAgree(a: SweepXZ, b: SweepXZ): boolean {
  const cross = a.x * b.z - a.z * b.x;
  const dot = a.x * b.x + a.z * b.z;
  return Math.abs(cross) <= SWEEP_TANGENT_TOLERANCE_RAD && dot > 0;
}

/**
 * The per-segment chain data the path validators share: the segment's
 * start/end points in the XZ plane, its unit start/end tangents, and the
 * signed arc sweep (0 for lines).
 */
interface PathChainStep {
  readonly start: SweepXZ;
  readonly end: SweepXZ;
  readonly startTangent: SweepXZ;
  readonly endTangent: SweepXZ;
  readonly sweep: number;
}

/**
 * Computes the path's chain steps, or `null` when a segment is individually
 * degenerate (non-finite fields, zero-length line, non-positive radius,
 * zero or over-full arc sweep) — the caller phrases the failure.
 */
function pathChainSteps(
  path: readonly SweepPathSegmentInput[],
): readonly PathChainStep[] | null {
  const steps: PathChainStep[] = [];
  for (const segment of path) {
    if (segment.kind === "line") {
      const [sx, sz] = segment.start;
      const [ex, ez] = segment.end;
      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sz) ||
        !Number.isFinite(ex) ||
        !Number.isFinite(ez)
      ) {
        return null;
      }
      const length = Math.hypot(ex - sx, ez - sz);
      if (length <= PROFILE_CLOSURE_TOLERANCE_MM) {
        return null;
      }
      const unit = { x: (ex - sx) / length, z: (ez - sz) / length };
      steps.push({
        start: { x: sx, z: sz },
        end: { x: ex, z: ez },
        startTangent: unit,
        endTangent: unit,
        sweep: 0,
      });
      continue;
    }
    const [cx, cz] = segment.center;
    if (
      !Number.isFinite(cx) ||
      !Number.isFinite(cz) ||
      !Number.isFinite(segment.radius) ||
      segment.radius <= 0
    ) {
      return null;
    }
    const sweep = sweepArcSignedSweep(segment);
    if (!Number.isFinite(sweep) || sweep === 0) {
      return null;
    }
    if (Math.abs(sweep) > Math.PI * 2 + 1e-9) {
      return null;
    }
    const a0 = valueIn(segment.startAngle, "rad");
    const a1 = valueIn(segment.endAngle, "rad");
    steps.push({
      start: sweepArcPoint(segment, a0),
      end: sweepArcPoint(segment, a1),
      startTangent: sweepArcTangent(a0, sweep),
      endTangent: sweepArcTangent(a1, sweep),
      sweep,
    });
  }
  return steps;
}

/**
 * Whether the path chain closes on itself: the final endpoint returns to
 * the local origin (the profile's attachment point). A closed ring sweeps
 * a tube that closes on itself — capped at nothing.
 */
export function sweepPathClosed(
  path: readonly SweepPathSegmentInput[],
): boolean {
  if (path.length === 0) return false;
  const steps = pathChainSteps(path);
  const last = steps?.[steps.length - 1];
  if (last === undefined) return false;
  return Math.hypot(last.end.x, last.end.z) <= PROFILE_CLOSURE_TOLERANCE_MM;
}

/**
 * The structural problems of a sweep path at the contract's probe scope, or
 * `null` when it is sound: an empty path; per-segment degeneracy (a
 * zero-length line, a non-positive radius, a zero or over-full arc sweep,
 * non-finite fields); a first segment that does not start at the local
 * origin or whose initial tangent is not the profile plane's normal +z
 * (the perpendicular-attachment rule); endpoint gaps at joints; and tangent
 * discontinuities (kinks) at joints — including a closed ring's wrap joint.
 * Self-intersection is deliberately SEPARATE (it rejects with its own
 * structured code, not as a structural problem).
 */
export function sweepPathProblem(
  path: readonly SweepPathSegmentInput[],
): string | null {
  if (path.length === 0) return "the path is empty";
  const steps = pathChainSteps(path);
  if (steps === null) {
    return "a path segment is degenerate (a zero-length line, a non-positive radius, a zero or over-full arc sweep, or a non-finite field)";
  }
  const first = steps[0];
  if (first === undefined) return "the path is empty";
  if (Math.hypot(first.start.x, first.start.z) > PROFILE_CLOSURE_TOLERANCE_MM) {
    return `the path must start at the local origin (the profile's attachment point); it starts at (${first.start.x}, ${first.start.z})`;
  }
  if (!tangentsAgree(first.startTangent, { x: 0, z: 1 })) {
    return `the path's initial tangent must be the profile plane's normal +z (the perpendicular-attachment rule); it is (${first.startTangent.x}, ${first.startTangent.z})`;
  }
  for (let i = 0; i < steps.length; i += 1) {
    const current = steps[i];
    const next = steps[(i + 1) % steps.length];
    if (current === undefined || next === undefined) continue;
    if (i + 1 < steps.length) {
      const gap = Math.hypot(
        current.end.x - next.start.x,
        current.end.z - next.start.z,
      );
      if (gap > PROFILE_CLOSURE_TOLERANCE_MM) {
        return `the path does not continue (gap ${gap} mm between segment ${i + 1} and segment ${i + 2})`;
      }
      if (!tangentsAgree(current.endTangent, next.startTangent)) {
        const angle = Math.atan2(
          current.endTangent.x * next.startTangent.z -
            current.endTangent.z * next.startTangent.x,
          current.endTangent.x * next.startTangent.x +
            current.endTangent.z * next.startTangent.z,
        );
        return `the path has a tangent discontinuity (kink) of ${angle} rad between segment ${i + 1} and segment ${i + 2} — sweeps require a G1 path`;
      }
    }
  }
  // The wrap joint of a closed ring is a joint like any other: the tube
  // closes on itself, so its final tangent must meet its first.
  const last = steps[steps.length - 1];
  if (
    last !== undefined &&
    sweepPathClosed(path) &&
    !tangentsAgree(last.endTangent, first.startTangent)
  ) {
    return "the path closes on itself with a tangent discontinuity (kink) at the closure joint — a closed sweep path must be G1 through the wrap";
  }
  return null;
}

/**
 * The path's chord polyline: the chain tessellated at the shared angular
 * deflection (lines contribute their endpoints, arcs their chords at
 * {@link PROFILE_MAX_SEGMENT_ANGLE_RAD}), consecutive duplicates collapsed.
 * The self-intersection test and the mesh-kernel stations share these
 * points.
 */
export function sweepPathChordPoints(
  path: readonly SweepPathSegmentInput[],
): SweepXZ[] {
  const points: SweepXZ[] = [];
  const push = (point: SweepXZ): void => {
    const last = points[points.length - 1];
    if (
      last !== undefined &&
      Math.hypot(last.x - point.x, last.z - point.z) <= 1e-12
    ) {
      return;
    }
    points.push(point);
  };
  for (const segment of path) {
    if (segment.kind === "line") {
      push({ x: segment.start[0], z: segment.start[1] });
      push({ x: segment.end[0], z: segment.end[1] });
      continue;
    }
    const sweep = sweepArcSignedSweep(segment);
    const a0 = valueIn(segment.startAngle, "rad");
    const divisions = Math.max(
      1,
      Math.ceil(Math.abs(sweep) / PROFILE_MAX_SEGMENT_ANGLE_RAD),
    );
    for (let i = 0; i <= divisions; i += 1) {
      push(sweepArcPoint(segment, a0 + (sweep * i) / divisions));
    }
  }
  return points;
}

/** The 2D cross product of (b − a) and (c − a) in the XZ plane. */
function crossXZ(a: SweepXZ, b: SweepXZ, c: SweepXZ): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

/** Orientation robustness epsilon for the chord crossing test. */
const SWEEP_CROSS_EPSILON = 1e-9;

/**
 * Whether two chord segments overlap away from a shared endpoint: a proper
 * crossing (strictly opposite orientations on both sides) or a collinear
 * overlap extending beyond a common endpoint. Segments that merely touch at
 * one endpoint do not overlap.
 */
function chordsOverlap(
  a1: SweepXZ,
  a2: SweepXZ,
  b1: SweepXZ,
  b2: SweepXZ,
): boolean {
  const d1 = crossXZ(b1, b2, a1);
  const d2 = crossXZ(b1, b2, a2);
  const d3 = crossXZ(a1, a2, b1);
  const d4 = crossXZ(a1, a2, b2);
  const properlyCross =
    ((d1 > SWEEP_CROSS_EPSILON && d2 < -SWEEP_CROSS_EPSILON) ||
      (d1 < -SWEEP_CROSS_EPSILON && d2 > SWEEP_CROSS_EPSILON)) &&
    ((d3 > SWEEP_CROSS_EPSILON && d4 < -SWEEP_CROSS_EPSILON) ||
      (d3 < -SWEEP_CROSS_EPSILON && d4 > SWEEP_CROSS_EPSILON));
  if (properlyCross) return true;
  const collinear =
    Math.abs(d1) <= SWEEP_CROSS_EPSILON &&
    Math.abs(d2) <= SWEEP_CROSS_EPSILON &&
    Math.abs(d3) <= SWEEP_CROSS_EPSILON &&
    Math.abs(d4) <= SWEEP_CROSS_EPSILON;
  if (!collinear) return false;
  // Collinear: overlap iff their 1D extents overlap beyond a shared point.
  const dx = a2.x - a1.x;
  const dz = a2.z - a1.z;
  const along = dx * dx >= dz * dz;
  const aLo = along ? Math.min(a1.x, a2.x) : Math.min(a1.z, a2.z);
  const aHi = along ? Math.max(a1.x, a2.x) : Math.max(a1.z, a2.z);
  const bLo = along ? Math.min(b1.x, b2.x) : Math.min(b1.z, b2.z);
  const bHi = along ? Math.max(b1.x, b2.x) : Math.max(b1.z, b2.z);
  return Math.min(aHi, bHi) - Math.max(aLo, bLo) > SWEEP_CROSS_EPSILON;
}

/**
 * Whether the path SELF-INTERSECTS: the chord polyline crosses itself or
 * overlaps collinearly away from shared joint endpoints (adjacent chords —
 * and the wrap pair of a closed ring — are exempt; they meet at exactly one
 * point by construction). This is the cheap, total detection the contract
 * promises BEFORE any kernel geometry runs.
 */
export function sweepPathSelfIntersects(
  path: readonly SweepPathSegmentInput[],
): boolean {
  const points = sweepPathChordPoints(path);
  const closed = sweepPathClosed(path);
  const count = points.length;
  if (count < 2) return false;
  const lastChord = count - 1;
  for (let i = 0; i < lastChord; i += 1) {
    const a1 = points[i];
    const a2 = points[i + 1];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = i + 2; j <= lastChord; j += 1) {
      const b1 = points[j];
      const b2 = points[j + 1];
      if (b1 === undefined || b2 === undefined) continue;
      // The final chord of a closed ring shares the wrap point with the
      // first chord — adjacent, exempt like consecutive chords.
      if (closed && i === 0 && j === lastChord) continue;
      if (chordsOverlap(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * The first arc whose centre axis the profile CROSSES (the tight-radius
 * bend: the tube pinches through the axis), or `null`. Every arc's axis is
 * a line in the profile's own (u, v) plane — at `u = −sign(sweep)·R`, the
 * arc centre's side — because the fixed-binormal transport keeps the
 * profile's coordinates in the moving frame invariant; the check is the
 * revolve axis-crossing rule (exact over lines, arcs, and circles; touching
 * legal) applied per arc.
 */
export function sweepProfileArcAxisCrossing(
  loop: readonly ProfileSegmentInput[],
  path: readonly SweepPathSegmentInput[],
): {
  readonly uAxis: number;
  readonly min: number;
  readonly max: number;
} | null {
  for (const segment of path) {
    if (segment.kind !== "arc") continue;
    const sweep = sweepArcSignedSweep(segment);
    const uAxis = -(sweep > 0 ? 1 : -1) * segment.radius;
    const frame = normalizeRevolveAxis({
      point: [uAxis, 0],
      direction: [0, 1],
    });
    if (frame === null) continue;
    if (revolveCrossesAxis(loop, frame)) {
      const extremes = revolveSignedExtremes(loop, frame);
      return { uAxis, min: extremes.min, max: extremes.max };
    }
  }
  return null;
}

/** One station of the transported profile frame along the path. */
export interface SweepStation {
  /** The path point at the station (local XZ, mm). */
  readonly position: SweepXZ;
  /**
   * The in-plane normal of the moving frame — the direction the profile's
   * own u axis points at the station (unit, in the XZ plane). The tangent
   * is `(−e1.z, e1.x)` and the profile's v axis is always local +y.
   */
  readonly e1: SweepXZ;
}

/** A decomposed sweep path piece: one straight prism or one arc revolution. */
export type SweepPiece =
  | {
      readonly kind: "line";
      readonly from: SweepXZ;
      readonly to: SweepXZ;
      readonly length: number;
      readonly e1: SweepXZ;
    }
  | {
      readonly kind: "arc";
      readonly center: SweepXZ;
      readonly radius: number;
      readonly startAngle: number;
      /** Signed sweep in radians: positive CCW in the (x, z) plane. */
      readonly sweep: number;
    };

/**
 * Decomposes a VALIDATED path into its transport pieces. Line pieces carry
 * their constant frame (position endpoints and the in-plane normal e1);
 * arc pieces carry their centre-axis geometry (stations derive from the
 * angles). Callers run {@link sweepPathProblem} first — the decomposition
 * assumes non-degenerate, G1-continuous input.
 */
export function decomposeSweepPath(
  path: readonly SweepPathSegmentInput[],
): readonly SweepPiece[] {
  const pieces: SweepPiece[] = [];
  for (const segment of path) {
    if (segment.kind === "line") {
      const from = { x: segment.start[0], z: segment.start[1] };
      const to = { x: segment.end[0], z: segment.end[1] };
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      const tangent = {
        x: (to.x - from.x) / length,
        z: (to.z - from.z) / length,
      };
      pieces.push({
        kind: "line",
        from,
        to,
        length,
        e1: { x: tangent.z, z: -tangent.x },
      });
      continue;
    }
    pieces.push({
      kind: "arc",
      center: { x: segment.center[0], z: segment.center[1] },
      radius: segment.radius,
      startAngle: valueIn(segment.startAngle, "rad"),
      sweep: sweepArcSignedSweep(segment),
    });
  }
  return pieces;
}

/** The station frame of a line piece at its start (index 0) or end (1). */
function lineStation(
  piece: Extract<SweepPiece, { kind: "line" }>,
  end: 0 | 1,
): SweepStation {
  return { position: end === 0 ? piece.from : piece.to, e1: piece.e1 };
}

/**
 * An arc piece's station at travel fraction `t ∈ [0, 1]`: the frame rotated
 * about the arc's centre axis by the signed sweep — position on the arc,
 * e1 the rotated in-plane normal (the profile's u direction).
 */
export function sweepArcStation(
  piece: Extract<SweepPiece, { kind: "arc" }>,
  t: number,
): SweepStation {
  const angle = piece.startAngle + piece.sweep * t;
  const position = {
    x: piece.center.x + piece.radius * Math.cos(angle),
    z: piece.center.z + piece.radius * Math.sin(angle),
  };
  const sign = piece.sweep > 0 ? 1 : -1;
  return {
    position,
    e1: { x: sign * Math.cos(angle), z: sign * Math.sin(angle) },
  };
}

/**
 * Every station of one piece at the shared angular deflection: line pieces
 * contribute their two endpoint frames; arc pieces contribute
 * `ceil(|sweep| / {@link PROFILE_MAX_SEGMENT_ANGLE_RAD}) + 1` frames.
 */
export function sweepPieceStations(piece: SweepPiece): readonly SweepStation[] {
  if (piece.kind === "line") {
    return [lineStation(piece, 0), lineStation(piece, 1)];
  }
  const divisions = Math.max(
    1,
    Math.ceil(Math.abs(piece.sweep) / PROFILE_MAX_SEGMENT_ANGLE_RAD),
  );
  const stations: SweepStation[] = [];
  for (let i = 0; i <= divisions; i += 1) {
    stations.push(sweepArcStation(piece, i / divisions));
  }
  return stations;
}

/**
 * The profile chord polygon's moment about the v axis: `∫ u dA`, the exact
 * closed form over the polygon (the same shoelace-weighted sum Pappus
 * uses). The polygon arrives CCW-normalized from the callers.
 */
export function polygonMomentU(polygon: readonly ProfilePoint2[]): number {
  let moment = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    moment += (a.x + b.x) * (a.x * b.y - b.x * a.y);
  }
  return moment / 6;
}

/**
 * The EXACT swept volume of the transported chord polygon along the piece
 * chain — the Pappus decomposition the contract documents: every line piece
 * contributes `A·L` (Cavalieri), every arc piece `|θ|·|d̄|·A` (Pappus, with
 * `d̄ = ū + sign(θ)·R` the profile centroid's signed distance to the arc's
 * centre axis — the moving-frame invariance that makes every arc's axis a
 * line in the profile's own coordinates). Exact for straight-edge profiles;
 * curved profiles carry only the documented chord deficit.
 */
export function sweepAnalyticVolume(
  polygon: readonly ProfilePoint2[],
  pieces: readonly SweepPiece[],
): number {
  const area = polygonSignedArea(polygon);
  const moment = polygonMomentU(polygon);
  let volume = 0;
  for (const piece of pieces) {
    if (piece.kind === "line") {
      volume += Math.abs(area) * piece.length;
      continue;
    }
    const centroidDistance =
      moment + (piece.sweep > 0 ? 1 : -1) * piece.radius * area;
    volume += Math.abs(piece.sweep) * Math.abs(centroidDistance);
  }
  return volume;
}

// ---------------------------------------------------------------------------
// Loft geometry (Phase 26.4)
// ---------------------------------------------------------------------------

/**
 * The structured problem a loft's section collection rejects with: the
 * code the contract assigns the violated rule plus the human detail.
 * Kernels return it verbatim (prefixed by their operation name), so every
 * adapter phrases the same collection failure identically.
 */
export interface LoftSectionsProblem {
  readonly code: KernelErrorCode;
  readonly message: string;
}

/**
 * Validates a loft's section collection, or `null` when it lofts. The
 * checks, in order, every one BEFORE any kernel geometry:
 *
 * 1. MEMBER validity — each loop passes the shared structural validator
 *    (`profileLoopProblem`) and the mesh-kernel face floor (≥3 distinct
 *    chord vertices, non-zero enclosed area), failing with
 *    `kernel/invalid-profile`; messages name the 1-based section index.
 * 2. STATION ordering — the sections' `z` values strictly increase along
 *    the list, failing with `kernel/loft-unordered-stations` (equal
 *    stations span zero height; a folding list self-overlaps).
 * 3. VERTEX-COUNT compatibility — every chord polygon (at the shared
 *    angular deflection) carries the same vertex count, failing with
 *    `kernel/loft-incompatible-profiles`: the morph's correspondence is
 *    index-based by contract, and engines handed a mismatch would each
 *    invent their own (probed: JSCAD repartitions to the LCM edge count,
 *    OCCT re-origins wires) — silently different solids from one input.
 *
 * Winding is deliberately NOT a rule: callers normalize each polygon CCW
 * (`loftSectionPolygons`), the same convention `extrude` applies.
 */
export function loftSectionsProblem(
  sections: readonly ProfileLoftSectionInput[],
): LoftSectionsProblem | null {
  if (sections.length < 2) {
    return {
      code: KERNEL_ERROR_CODES.invalidOperands,
      message: `the collection has ${sections.length} section(s); a loft needs at least two`,
    };
  }
  const polygons: (readonly ProfilePoint2[])[] = [];
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    if (section === undefined) continue;
    const problem = profileLoopProblem(section.loop);
    if (problem !== null) {
      return {
        code: KERNEL_ERROR_CODES.invalidProfile,
        message: `section ${i + 1}'s loop: ${problem}`,
      };
    }
    const polygon = tessellateProfileLoop(section.loop);
    if (polygon.length < 3 || !(Math.abs(polygonSignedArea(polygon)) > 1e-9)) {
      return {
        code: KERNEL_ERROR_CODES.invalidProfile,
        message: `section ${i + 1}'s loop is degenerate (fewer than three distinct vertices or zero enclosed area)`,
      };
    }
    polygons.push(polygon);
  }
  const stations: number[] = [];
  for (const section of sections) {
    stations.push(valueIn(section.z, "mm"));
  }
  for (let i = 0; i + 1 < stations.length; i += 1) {
    const here = stations[i];
    const next = stations[i + 1];
    if (here === undefined || next === undefined) continue;
    if (!(next > here)) {
      return {
        code: KERNEL_ERROR_CODES.loftUnorderedStations,
        message: `the stations must strictly increase along the section list; section ${i + 1} sits at z = ${String(here)} mm and section ${i + 2} at z = ${String(next)} mm`,
      };
    }
  }
  const firstCount = polygons[0]?.length ?? 0;
  for (let i = 1; i < polygons.length; i += 1) {
    const count = polygons[i]?.length ?? 0;
    if (count !== firstCount) {
      return {
        code: KERNEL_ERROR_CODES.loftIncompatibleProfiles,
        message: `the sections' chord polygons carry different vertex counts (${String(firstCount)} for section 1 vs ${String(count)} for section ${i + 1}); lofting needs an index correspondence — morph the loops to matching counts before the kernel`,
      };
    }
  }
  return null;
}

/**
 * The stations of a validated section collection, in list order (mm) —
 * the strictly increasing z spine `loft` lofts along.
 */
export function loftStations(
  sections: readonly ProfileLoftSectionInput[],
): number[] {
  return sections.map((section) => valueIn(section.z, "mm"));
}

/**
 * The CCW-normalized chord polygons of a VALIDATED section collection, in
 * list order — the morph's corresponding vertex sequences. Callers run
 * {@link loftSectionsProblem} first; winding is normalized here (the same
 * CCW convention every profile op applies), so authored CW loops loft the
 * identical solid to their CCW twins.
 */
export function loftSectionPolygons(
  sections: readonly ProfileLoftSectionInput[],
): (readonly ProfilePoint2[])[] {
  return sections.map((section) => {
    const polygon = tessellateProfileLoop(section.loop);
    return polygonSignedArea(polygon) > 0 ? polygon : [...polygon].reverse();
  });
}

/**
 * The linear morph of polygon `a` into `b` at parameter `t ∈ [0, 1]` —
 * vertex i of the result is `(1−t)·aᵢ + t·bᵢ`, the loft span's
 * cross-section model. Both polygons carry equal vertex counts (the
 * collection validator guarantees it); a violation is an invariant break,
 * not a caller error.
 */
export function morphPolygons(
  a: readonly ProfilePoint2[],
  b: readonly ProfilePoint2[],
  t: number,
): ProfilePoint2[] {
  if (a.length !== b.length) {
    throw new Error(
      "Invariant violation: loft morphs run between equal-count polygons (validated upstream).",
    );
  }
  return a.map((vertex, i) => {
    const other = b[i];
    if (other === undefined) {
      throw new Error(
        "Invariant violation: morph polygons are dense (validated upstream).",
      );
    }
    return {
      x: (1 - t) * vertex.x + t * other.x,
      y: (1 - t) * vertex.y + t * other.y,
    };
  });
}

/**
 * The EXACT volume of the loft over the chord polygons between the
 * stations — the Simpson (prismoidal) sum the contract documents: the
 * morph's cross-section area is a QUADRATIC function of the span
 * parameter (vertex coordinates are linear in t, and the shoelace area is
 * quadratic in the vertices), so Simpson's rule integrates it exactly:
 * each span contributes `h/6 · (Aⱼ + 4·A_mid + Aⱼ₊₁)`. Identical sections
 * give the prism `A·h` definitionally; similar concentric sections give
 * the frustum-family values. Exact for straight-edge sections; curved
 * sections carry only the documented chord deficit (vertices sit on the
 * true circles).
 */
export function loftAnalyticVolume(
  polygons: readonly (readonly ProfilePoint2[])[],
  stations: readonly number[],
): number {
  let volume = 0;
  for (let j = 0; j + 1 < stations.length; j += 1) {
    const here = polygons[j];
    const next = polygons[j + 1];
    const zHere = stations[j];
    const zNext = stations[j + 1];
    if (
      here === undefined ||
      next === undefined ||
      zHere === undefined ||
      zNext === undefined
    ) {
      continue;
    }
    const mid = morphPolygons(here, next, 0.5);
    // Signed areas throughout: the polygons are CCW, so in-scope spans
    // integrate positive; an adversarial twist whose mid-span section
    // flips orientation integrates its signed model exactly (the same
    // honesty self-intersecting profiles carry).
    volume +=
      ((zNext - zHere) / 6) *
      (polygonSignedArea(here) +
        4 * polygonSignedArea(mid) +
        polygonSignedArea(next));
  }
  return volume;
}
