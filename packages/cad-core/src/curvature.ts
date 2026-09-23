/**
 * Curvature display (Phase 58): the two honest curvature consumers the
 * roadmap names — the 2D sketch spline comb and the mesh-based surface
 * curvature band — as pure modules over submitted samples/soups.
 *
 * ## The comb (2D)
 *
 * `sketchCurvatureComb` consumes a sampled planar path (the SEAM: the
 * host samples its curve — cad-sketch's spline evaluators are the real
 * producer for spline entities) and derives the curvature at each
 * interior sample with the three-point circumradius formula, exact for
 * any three points on a circle (so a sampled circular arc pins κ = 1/r
 * exactly). The comb is the radius-visualization data: a spike at each
 * sample along the path normal, length κ × scale, capped at `maxScale`×
 * the scale so straight segments (κ → 0) and the cap stay honest.
 *
 * ## The surface band (3D)
 *
 * `surfaceCurvatureBands` classifies each WELDED vertex of a soup by the
 * maximum deviation between the normals of the faces meeting there —
 * the honest mesh-based band: exact agreement means flat, small deviation
 * means smoothly curved tessellation, large deviation means a sharp edge
 * the tessellation carries. It reads the normals AS SUBMITTED: a
 * smooth-shaded soup (per-corner normals already equal to the true
 * surface normal) reads flat because its normals carry no face-to-face
 * deviation, while a faceted soup's per-quad normals expose the surface's
 * curvature as the seam deviation. It is an estimate OVER THE SUBMITTED
 * MESH (refinement converges it), never an exact surface property: where
 * OCCT surface props are reachable a kernel consumer may replace the
 * band — this module's output declares its own precision instead of
 * pretending. Welding is by exact position triple (a soup's corners are
 * unwelded; the position identity is the deterministic join).
 */

import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes for curvature analysis. */
export const CURVATURE_ERROR_CODES = {
  malformed: "analysis/curvature-malformed",
  degenerate: "analysis/curvature-degenerate",
} as const;

export type CurvatureErrorCode =
  (typeof CURVATURE_ERROR_CODES)[keyof typeof CURVATURE_ERROR_CODES];

/** Structured failure describing why a curvature analysis was rejected. */
export interface CurvatureError extends ParseFailure {
  readonly code: CurvatureErrorCode;
}

/** A sampled planar path: one `[x, y]` pair per sample, in path order. */
export type PlanarPath = readonly (readonly [number, number])[];

/** One comb spike: the base point on the curve and the spike's tip. */
export interface CurvatureCombSpike {
  readonly base: readonly [number, number];
  readonly tip: readonly [number, number];
  /** The signed curvature at the sample (1/length units). */
  readonly curvature: number;
}

/** The comb report: spikes plus the summary the readout displays. */
export interface CurvatureComb {
  readonly spikes: readonly CurvatureCombSpike[];
  /** The maximum absolute curvature over the path (Infinity-cap applied). */
  readonly maxCurvature: number;
  /** The scale the spike lengths were drawn at. */
  readonly scale: number;
}

/** The comb's input: samples, the spike scale, the per-spike length cap. */
export interface CurvatureCombInput {
  readonly samples: PlanarPath;
  /** Spike length per unit curvature (world units). Default 1. */
  readonly scale?: number;
  /**
   * The longest spike allowed, in world units — a straight path's κ→0
   * needs no cap, but a huge-κ sample must not produce an unbounded one.
   * Default 50.
   */
  readonly maxSpike?: number;
}

/**
 * Derives the curvature comb over the sampled path. The first and last
 * samples carry no spike (three-point curvature needs both neighbours).
 */
export function sketchCurvatureComb(
  input: CurvatureCombInput,
): ParseResult<CurvatureComb, CurvatureError> {
  const samples = input.samples;
  if (samples.length < 3) {
    return fail({
      code: CURVATURE_ERROR_CODES.malformed,
      message:
        "A curvature comb needs at least three samples to derive curvature.",
      input: { samples: samples.length },
    });
  }
  const scale = input.scale ?? 1;
  const maxSpike = input.maxSpike ?? 50;
  if (!(scale > 0) || !(maxSpike > 0)) {
    return fail({
      code: CURVATURE_ERROR_CODES.malformed,
      message: "A comb's scale and spike cap must be positive.",
      input: { scale, maxSpike },
    });
  }
  const spikes: CurvatureCombSpike[] = [];
  let maxCurvature = 0;
  for (let index = 1; index + 1 < samples.length; index += 1) {
    const a = samples[index - 1];
    const b = samples[index];
    const c = samples[index + 1];
    if (a === undefined || b === undefined || c === undefined) continue;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const bcx = c[0] - b[0];
    const bcy = c[1] - b[1];
    const cax = a[0] - c[0];
    const cay = a[1] - c[1];
    const cross = abx * bcy - aby * bcx;
    const ab = Math.hypot(abx, aby);
    const bc = Math.hypot(bcx, bcy);
    const ca = Math.hypot(cax, cay);
    const denominator = ab * bc * ca;
    if (!(denominator > 0)) {
      return fail({
        code: CURVATURE_ERROR_CODES.degenerate,
        message:
          "A comb path's samples must be distinct; coincident samples have no circumcircle.",
        input: { index },
      });
    }
    // Circumradius R = |ab|·|bc|·|ca| / (4·area) with area = |cross|/2,
    // so κ = 1/R = 2·|cross| / denominator, signed by the turn direction
    // (positive = counter-clockwise).
    const curvature = (2 * cross) / denominator;
    const magnitude = Math.abs(curvature);
    maxCurvature = Math.max(maxCurvature, magnitude);
    // The unit normal at b, oriented toward the curve's centre of
    // curvature: the normal opposing the tangent, signed by the turn.
    const tangentX = abx / ab + bcx / bc || 0;
    const tangentY = aby / ab + bcy / bc || 0;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    const signedSpike = Math.min(magnitude * scale, maxSpike);
    spikes.push({
      base: b,
      tip: [
        b[0] + normalX * signedSpike * Math.sign(curvature || 1),
        b[1] + normalY * signedSpike * Math.sign(curvature || 1),
      ],
      curvature,
    });
  }
  return ok({ spikes, maxCurvature, scale });
}

/** The three surface curvature bands. */
export type SurfaceCurvatureBand = "flat" | "curved" | "sharp";

/**
 * The deterministic band colors — the legend and any colored rebuild
 * read the same constants.
 */
export const SURFACE_CURVATURE_BAND_COLORS: Readonly<
  Record<SurfaceCurvatureBand, string>
> = {
  flat: "#4c78a8",
  curved: "#72b04b",
  sharp: "#c2912f",
} as const;

/** The default band thresholds, in degrees of normal deviation. */
export const SURFACE_CURVATURE_BAND_LIMITS = {
  /** Up to this face-to-face normal deviation the vertex reads flat. */
  flatDeg: 0.5,
  /** Up to this deviation the vertex reads curved; beyond it, sharp. */
  curvedDeg: 40,
} as const;

/** One band's census: the band, its color, its welded-vertex count. */
export interface SurfaceCurvatureBandCensus {
  readonly band: SurfaceCurvatureBand;
  readonly colorHex: string;
  readonly vertices: number;
}

/** The surface band report. */
export interface SurfaceCurvatureBandsReport {
  readonly census: readonly SurfaceCurvatureBandCensus[];
  /** The welded-vertex count the census sums to. */
  readonly weldedVertices: number;
  /** The thresholds the classification used, in degrees. */
  readonly limitsDeg: typeof SURFACE_CURVATURE_BAND_LIMITS;
}

/** The band analysis input: the soup (positions + corner normals). */
export interface SurfaceCurvatureBandsInput {
  readonly positions: readonly number[];
  readonly normals: readonly number[];
  readonly limitDeg?: typeof SURFACE_CURVATURE_BAND_LIMITS;
}

/**
 * Validates the soup, welds corners by exact position, classifies each
 * welded vertex by its maximum face-normal deviation, and reports the
 * per-band census (in `flat`, `curved`, `sharp` order).
 */
export function surfaceCurvatureBands(
  input: SurfaceCurvatureBandsInput,
): ParseResult<SurfaceCurvatureBandsReport, CurvatureError> {
  const { positions, normals } = input;
  if (
    positions.length === 0 ||
    positions.length % 3 !== 0 ||
    normals.length !== positions.length
  ) {
    return fail({
      code: CURVATURE_ERROR_CODES.malformed,
      message:
        "A curvature band analysis needs paired position and normal triples.",
      input: { positions: positions.length, normals: normals.length },
    });
  }
  const limits = input.limitDeg ?? SURFACE_CURVATURE_BAND_LIMITS;
  // Weld by exact position triple.
  const weld = new Map<string, number>();
  const vertexNormals: NormalList[] = [];
  const vertexOfCorner: number[] = [];
  for (let corner = 0; corner * 3 < positions.length; corner += 1) {
    const px = positions[corner * 3] ?? 0;
    const py = positions[corner * 3 + 1] ?? 0;
    const pz = positions[corner * 3 + 2] ?? 0;
    const key = `${px}/${py}/${pz}`;
    let vertex = weld.get(key);
    if (vertex === undefined) {
      vertex = vertexNormals.length;
      weld.set(key, vertex);
      vertexNormals.push([]);
    }
    vertexOfCorner.push(vertex);
    const normal: Vec3 = [
      normals[corner * 3] ?? 0,
      normals[corner * 3 + 1] ?? 0,
      normals[corner * 3 + 2] ?? 0,
    ];
    const bucket = vertexNormals[vertex];
    if (bucket !== undefined) {
      const already = bucket.some(
        (existing) =>
          existing[0] === normal[0] &&
          existing[1] === normal[1] &&
          existing[2] === normal[2],
      );
      if (!already) bucket.push(normal);
    }
  }
  const counts: Record<SurfaceCurvatureBand, number> = {
    flat: 0,
    curved: 0,
    sharp: 0,
  };
  for (const normalsAtVertex of vertexNormals) {
    let maxDeviationCos = 1;
    for (let i = 0; i < normalsAtVertex.length; i += 1) {
      for (let j = i + 1; j < normalsAtVertex.length; j += 1) {
        const first = normalsAtVertex[i];
        const second = normalsAtVertex[j];
        if (first === undefined || second === undefined) continue;
        const dot = clampUnit(
          first[0] * second[0] + first[1] * second[1] + first[2] * second[2],
        );
        maxDeviationCos = Math.min(maxDeviationCos, dot);
      }
    }
    const deviationDeg = (Math.acos(maxDeviationCos) * 180) / Math.PI;
    if (deviationDeg <= limits.flatDeg) counts.flat += 1;
    else if (deviationDeg <= limits.curvedDeg) counts.curved += 1;
    else counts.sharp += 1;
  }
  return ok({
    census: (["flat", "curved", "sharp"] as const).map((band) => ({
      band,
      colorHex: SURFACE_CURVATURE_BAND_COLORS[band],
      vertices: counts[band],
    })),
    weldedVertices: vertexNormals.length,
    limitsDeg: limits,
  });
}

type Vec3 = [number, number, number];
type NormalList = Vec3[];

/** Clamps a dot product into `[-1, 1]` for the safe arccosine. */
function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
