/**
 * Document mass properties with material assignment (Phase 58): the COG
 * marker datum and the mass aggregate behind it — the roadmap's "COG
 * marker datum + mass properties with density/material assignment" at the
 * consumer layer the block defines ("the contract keeps out of density;
 * this is the consumer layer").
 *
 * ## The records and the aggregate
 *
 * A {@link DocumentMaterialRecord} is a document-level named material
 * carrying one density in g/cm³ (the CAD convention: water = 1). The
 * aggregate consumes per-occurrence contributions — the host's kernel
 * measurements (volume mm³, world centroid mm) joined to an assignment —
 * and answers:
 *
 * - `massGrams = Σ (density_i × volume_i / 1000)` — the unit law: 1 g/cm³
 *   over 1000 mm³ is exactly 1 g (1000 mm³ = 1 cm³).
 * - `centerOfGravity = Σ (m_i × c_i) / Σ m_i` — the mass-weighted mean of
 *   the contribution centroids, the point the COG marker datum stamps.
 *
 * Honesty rules: an occurrence whose body has NO material assignment is a
 * structured decline (`mass/unassigned-material`), never silently
 * massless; an assignment naming an unknown material record is
 * `mass/unknown-material`; a zero total mass (degenerate densities) is
 * refused rather than divided through. This module fabricates no density:
 * a document without material records simply declines the mass aggregate
 * while the kernel's volume readouts stay the Phase 27.4 truth.
 *
 * Determinism: identical records, assignments, and contributions (in the
 * caller's fixed occurrence order) produce an identical report.
 */

import { type DatumVec3 } from "./datum";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes for the mass aggregate. */
export const DOCUMENT_MASS_ERROR_CODES = {
  malformed: "analysis/mass-malformed",
  unassignedMaterial: "analysis/mass-unassigned-material",
  unknownMaterial: "analysis/mass-unknown-material",
  zeroMass: "analysis/mass-zero-mass",
} as const;

export type DocumentMassErrorCode =
  (typeof DOCUMENT_MASS_ERROR_CODES)[keyof typeof DOCUMENT_MASS_ERROR_CODES];

/** Structured failure describing why a mass aggregate was rejected. */
export interface DocumentMassError extends ParseFailure {
  readonly code: DocumentMassErrorCode;
}

declare const materialIdBrand: unique symbol;

/**
 * The branded id of a document-level material record — its own brand (not
 * a `CAD_ID_KINDS` member) because materials live at the CONSUMER layer
 * the block defines, not in the kernel document schema; the `mat_` prefix
 * keeps them visually distinct from kernel ids.
 */
export type MaterialId = string & {
  readonly [materialIdBrand]: "material";
};

/** Parses a material id at the trust boundary (`mat_`-prefixed, non-empty). */
export function parseMaterialId(raw: string): ParseResult<MaterialId> {
  if (typeof raw !== "string" || !raw.startsWith("mat_") || raw.length < 5) {
    return fail({
      code: DOCUMENT_MASS_ERROR_CODES.malformed,
      message: "A material id must be a non-empty `mat_`-prefixed string.",
      input: { raw },
    });
  }
  return ok(raw as MaterialId);
}

/** A document-level material record: a name and one density, g/cm³. */
export interface DocumentMaterialRecord {
  readonly id: MaterialId;
  readonly name: string;
  /** The material's density in grams per cubic centimetre (water = 1). */
  readonly densityGPerCm3: number;
}

/** One mass contribution: one occurrence's kernel measurement, assigned. */
export interface MassContribution {
  /** The occurrence path, outermost first (the contribution's identity). */
  readonly path: readonly string[];
  /** The material the occurrence's body is assigned to. */
  readonly materialId: MaterialId;
  /** The kernel-measured solid volume, in mm³. */
  readonly volumeMm3: number;
  /** The solid's area-weighted centroid, world mm. */
  readonly centroid: DatumVec3;
}

/** The aggregate's report. */
export interface DocumentMassPropertiesReport {
  /** Σ density × volume, in grams (the documented unit law). */
  readonly massGrams: number;
  /** The mass-weighted centroid, world mm — the COG marker datum. */
  readonly centerOfGravity: DatumVec3;
  /** The contributing occurrences, in the caller's fixed order. */
  readonly contributions: readonly {
    readonly path: readonly string[];
    readonly massGrams: number;
  }[];
}

/** The aggregate's input: records, contributions, the record resolver. */
export interface DocumentMassPropertiesInput {
  readonly contributions: readonly MassContribution[];
  /** Resolves an assignment's material record; absent → structured decline. */
  readonly materialOf: (
    materialId: MaterialId,
  ) => DocumentMaterialRecord | undefined;
}

/**
 * Validates the contributions at the trust boundary and aggregates the
 * mass and COG in the caller's fixed occurrence order.
 */
export function documentMassProperties(
  input: DocumentMassPropertiesInput,
): ParseResult<DocumentMassPropertiesReport, DocumentMassError> {
  for (const contribution of input.contributions) {
    if (
      contribution.path.length === 0 ||
      !(contribution.volumeMm3 >= 0) ||
      !contribution.centroid.every((coordinate) => Number.isFinite(coordinate))
    ) {
      return fail({
        code: DOCUMENT_MASS_ERROR_CODES.malformed,
        message:
          "A mass contribution must carry a non-empty occurrence path, a non-negative finite volume, and a finite centroid.",
        input: contribution,
      });
    }
  }
  const masses: number[] = [];
  let massGrams = 0;
  for (const contribution of input.contributions) {
    const record = input.materialOf(contribution.materialId);
    if (record === undefined) {
      return fail({
        code: DOCUMENT_MASS_ERROR_CODES.unknownMaterial,
        message: `A mass contribution names material ${contribution.materialId}, which no document record defines.`,
        input: contribution,
      });
    }
    if (!(record.densityGPerCm3 > 0)) {
      return fail({
        code: DOCUMENT_MASS_ERROR_CODES.malformed,
        message:
          "A material record's density must be a positive finite g/cm³ value.",
        input: record,
      });
    }
    const massGramsOfContribution =
      (record.densityGPerCm3 * contribution.volumeMm3) / 1000;
    masses.push(massGramsOfContribution);
    massGrams += massGramsOfContribution;
  }
  if (!(massGrams > 0)) {
    return fail({
      code: DOCUMENT_MASS_ERROR_CODES.zeroMass,
      message:
        "The mass aggregate's total mass is zero; a COG datum cannot be derived from massless contributions.",
      input: { contributions: input.contributions.length },
    });
  }
  let cogX = 0;
  let cogY = 0;
  let cogZ = 0;
  for (const [index, contribution] of input.contributions.entries()) {
    const mass = masses[index] ?? 0;
    cogX += mass * (contribution.centroid[0] ?? 0);
    cogY += mass * (contribution.centroid[1] ?? 0);
    cogZ += mass * (contribution.centroid[2] ?? 0);
  }
  return ok({
    massGrams,
    centerOfGravity: [cogX / massGrams, cogY / massGrams, cogZ / massGrams],
    contributions: input.contributions.map((contribution, index) => ({
      path: [...contribution.path],
      massGrams: masses[index] ?? 0,
    })),
  });
}
