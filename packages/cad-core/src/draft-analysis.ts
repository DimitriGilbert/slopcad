/**
 * Draft analysis (Phase 58): the pull-direction check that classifies a
 * body's planar faces against a pull datum and assigns the deterministic
 * color band the face map renders.
 *
 * ## What is classified, and how
 *
 * The analysis consumes the body's tessellation WITH per-corner normals
 * (the projection's paired-unit-normal contract) and groups corners into
 * PLANAR FACES by exact normal triple — the honest topology a soup
 * carries: one face per distinct constant normal. Each face's angle to
 * the pull direction drives the band:
 *
 * - `positive` — the face normal agrees with the pull (|cos| ≥
 *   `parallelLimit`): the face slides OUT with the pull.
 * - `negative` — the face normal opposes the pull: it slides against a
 *   matching-direction mold half.
 * - `vertical` — the face is perpendicular to the pull (|cos| ≤
 *   `verticalLimit`): no draft information; the classic draft-critical
 *   wall that needs a drafted angle.
 * - `undercut` — anything in the oblique band between the limits: the
 *   face resists straight pull.
 *
 * The band limits default to 5°; every band carries a fixed color hex —
 * the deterministic color banding this module owns (the map's legend and
 * the machine surfaces read the same constants). The per-corner class
 * array parallels the soup's corners so a host can rebuild the map as
 * colored geometry without re-deriving anything.
 *
 * Determinism: identical soup, pull, and limits produce an identical
 * report — faces iterate in first-appearance order of their normals, and
 * every comparison is against the same fixed band constants.
 */

import { type DatumVec3 } from "./datum";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes for draft analysis. */
export const DRAFT_ANALYSIS_ERROR_CODES = {
  malformed: "analysis/draft-malformed",
  pullDegenerate: "analysis/draft-pull-degenerate",
} as const;

export type DraftAnalysisErrorCode =
  (typeof DRAFT_ANALYSIS_ERROR_CODES)[keyof typeof DRAFT_ANALYSIS_ERROR_CODES];

/** Structured failure describing why a draft analysis was rejected. */
export interface DraftAnalysisError extends ParseFailure {
  readonly code: DraftAnalysisErrorCode;
}

/** A soup with paired per-corner positions and normals, triangle-indexed. */
export interface DraftAnalysisMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals: readonly number[];
}

/** The four draft bands, in classification order. */
export type DraftFaceClassification =
  "positive" | "negative" | "vertical" | "undercut";

/**
 * The deterministic color banding — fixed hex per class, the same values
 * the legend and any colored rebuild must use.
 */
export const DRAFT_BAND_COLORS: Readonly<
  Record<DraftFaceClassification, string>
> = {
  positive: "#3d9a5f",
  negative: "#b3452f",
  vertical: "#3f6fb5",
  undercut: "#c2912f",
} as const;

/** The default band limits in degrees (both tails symmetric). */
export const DRAFT_BAND_LIMIT_DEG = 5;

/** One classified planar face in the report. */
export interface DraftFace {
  /** The face's unit normal (the exact triple it was grouped by). */
  readonly normal: DatumVec3;
  /** The angle between the normal and the pull, in degrees `[0, 180]`. */
  readonly angleDeg: number;
  readonly classification: DraftFaceClassification;
  /** The band's fixed color hex (from {@link DRAFT_BAND_COLORS}). */
  readonly colorHex: string;
  /** How many corners of the soup belong to the face. */
  readonly cornerCount: number;
}

/** The draft analysis report. */
export interface DraftAnalysisReport {
  /** The pull direction the classification measured against. */
  readonly pull: DatumVec3;
  readonly faces: readonly DraftFace[];
  /**
   * Per-corner classification, paralleling the soup's corners (one entry
   * per corner, same order as `positions`/`normals` triples).
   */
  readonly cornerClasses: readonly DraftFaceClassification[];
  /** The band limits the classification used, in degrees. */
  readonly limitDeg: number;
}

/** The analysis input: the soup, the pull datum, optional band limits. */
export interface DraftAnalysisInput {
  readonly mesh: DraftAnalysisMesh;
  /** The pull direction (need not be unit; it is normalized here). */
  readonly pull: DatumVec3;
  readonly limitDeg?: number;
}

/**
 * Validates the soup and pull at the trust boundary, then classifies the
 * planar faces in first-appearance order.
 */
export function analyzeDraft(
  input: DraftAnalysisInput,
): ParseResult<DraftAnalysisReport, DraftAnalysisError> {
  const { positions, indices, normals } = input.mesh;
  if (
    positions.length === 0 ||
    positions.length % 3 !== 0 ||
    normals.length !== positions.length ||
    indices.length === 0 ||
    indices.length % 3 !== 0 ||
    indices.some((index) => !Number.isInteger(index) || index < 0)
  ) {
    return fail({
      code: DRAFT_ANALYSIS_ERROR_CODES.malformed,
      message:
        "A draft analysis mesh must carry paired position and normal triples and in-range triangle indices.",
      input: { corners: positions.length / 3, indices: indices.length },
    });
  }
  for (let offset = 0; offset < indices.length; offset += 1) {
    const index = indices[offset];
    if (index === undefined || index * 3 + 2 >= positions.length) {
      return fail({
        code: DRAFT_ANALYSIS_ERROR_CODES.malformed,
        message:
          "A draft analysis mesh's triangle indices must stay in range of the corner arrays.",
        input: { index },
      });
    }
  }
  const pullLength = Math.hypot(input.pull[0], input.pull[1], input.pull[2]);
  if (!(pullLength > 0)) {
    return fail({
      code: DRAFT_ANALYSIS_ERROR_CODES.pullDegenerate,
      message: "A draft pull direction must be a non-zero vector.",
      input: { pull: input.pull },
    });
  }
  const limitDeg = input.limitDeg ?? DRAFT_BAND_LIMIT_DEG;
  if (!(limitDeg > 0 && limitDeg < 90)) {
    return fail({
      code: DRAFT_ANALYSIS_ERROR_CODES.malformed,
      message: "A draft band limit must lie strictly between 0 and 90 degrees.",
      input: { limitDeg },
    });
  }
  const pull: DatumVec3 = [
    input.pull[0] / pullLength,
    input.pull[1] / pullLength,
    input.pull[2] / pullLength,
  ];
  const cosLimit = Math.cos((limitDeg * Math.PI) / 180);
  const sinLimit = Math.sin((limitDeg * Math.PI) / 180);

  // Group corners by exact normal triple, first appearance order.
  const faceOrderByNormal = new Map<string, number>();
  const faceNormals: DatumVec3[] = [];
  const faceCorners: number[] = [];
  for (let corner = 0; corner * 3 < normals.length; corner += 1) {
    const nx = normals[corner * 3] ?? 0;
    const ny = normals[corner * 3 + 1] ?? 0;
    const nz = normals[corner * 3 + 2] ?? 0;
    const key = `${nx}/${ny}/${nz}`;
    let face = faceOrderByNormal.get(key);
    if (face === undefined) {
      face = faceNormals.length;
      faceOrderByNormal.set(key, face);
      faceNormals.push([nx, ny, nz]);
      faceCorners.push(0);
    }
    faceCorners[face] = (faceCorners[face] ?? 0) + 1;
  }

  const faces: DraftFace[] = faceNormals.map((normal, face) => ({
    normal,
    angleDeg: 0,
    classification: "vertical",
    colorHex: DRAFT_BAND_COLORS.vertical,
    cornerCount: faceCorners[face] ?? 0,
  }));
  for (const [face, normal] of faceNormals.entries()) {
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    const cosAngle =
      length > 0
        ? (normal[0] * pull[0] + normal[1] * pull[1] + normal[2] * pull[2]) /
          length
        : 0;
    const angleDeg =
      (Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180) / Math.PI;
    const absCos = Math.abs(cosAngle);
    let classification: DraftFaceClassification;
    if (absCos >= cosLimit) {
      classification = cosAngle > 0 ? "positive" : "negative";
    } else if (absCos <= sinLimit) {
      classification = "vertical";
    } else {
      classification = "undercut";
    }
    faces[face] = {
      normal,
      angleDeg,
      classification,
      colorHex: DRAFT_BAND_COLORS[classification],
      cornerCount: faceCorners[face] ?? 0,
    };
  }
  // The per-corner array parallels the soup's corners and carries the
  // FINAL classification, built now that every face is classified.
  const finalCornerClasses: DraftFaceClassification[] = [];
  for (let corner = 0; corner * 3 < normals.length; corner += 1) {
    const nx = normals[corner * 3] ?? 0;
    const ny = normals[corner * 3 + 1] ?? 0;
    const nz = normals[corner * 3 + 2] ?? 0;
    const face = faceOrderByNormal.get(`${nx}/${ny}/${nz}`);
    const classified = face === undefined ? undefined : faces[face];
    finalCornerClasses.push(
      classified === undefined ? "vertical" : classified.classification,
    );
  }

  return ok({
    pull: input.pull,
    faces,
    cornerClasses: finalCornerClasses,
    limitDeg,
  });
}
