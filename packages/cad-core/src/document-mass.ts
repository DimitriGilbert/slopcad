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

/** Stable failure codes produced when a material record is rejected. */
export const MATERIAL_RECORD_ERROR_CODES = {
  malformed: "analysis/material-malformed",
  idInvalid: "analysis/material-id-invalid",
  nameInvalid: "analysis/material-name-invalid",
  densityInvalid: "analysis/material-density-invalid",
  thermalInvalid: "analysis/material-thermal-invalid",
  structuralInvalid: "analysis/material-structural-invalid",
} as const;

export type MaterialRecordErrorCode =
  (typeof MATERIAL_RECORD_ERROR_CODES)[keyof typeof MATERIAL_RECORD_ERROR_CODES];

/** Structured failure describing why a material record was rejected. */
export interface MaterialRecordError extends ParseFailure {
  readonly code: MaterialRecordErrorCode;
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

/**
 * A document-level material record: a name, one density in g/cm³, and —
 * Phase 61's thermal extension (ROADMAP-SIM) — three optional thermal
 * fields the heat-transfer path consumes. The thermal fields are ADDITIVE
 * exactly like the density was: absent means the record simply does not
 * carry one, a thermal scenario consuming a record without the field it
 * needs declines structurally at the sim compile boundary (`sim/*`),
 * never fabricates a value. The geometry-kernel contract stays
 * analysis-free — these fields live here, at the consumer layer, and no
 * kernel ever sees them.
 *
 * Phase 69's structural extension is the same move once more: three
 * optional linear-elastic fields — `youngsModulusPa`, `poissonRatio`,
 * `yieldStrengthPa` — plus the thermal-chaining seam the structural
 * expansion load needs, `thermalExpansionPerK` (1/K, any finite sign:
 * shrinkage materials exist). A structural run consuming a record
 * without its elasticity pair declines at the structural door; a record
 * without a yield strength runs but reports no factor of safety; a
 * thermal-expansion load against a record without a coefficient
 * declines. The exact additive-fields honesty, again.
 */
export interface DocumentMaterialRecord {
  readonly id: MaterialId;
  readonly name: string;
  /** The material's density in grams per cubic centimetre (water = 1). */
  readonly densityGPerCm3: number;
  /** The thermal conductivity in W/(m·K); absent = unknown. */
  readonly thermalConductivityWPerMK?: number;
  /** The specific heat capacity in J/(kg·K); absent = unknown. */
  readonly specificHeatJPerKgK?: number;
  /** The hemispherical total emissivity, dimensionless, [0, 1]; absent = unknown. */
  readonly emissivity?: number;
  /** Young's modulus, Pa; absent = unknown (the structural pair's first half). */
  readonly youngsModulusPa?: number;
  /** Poisson's ratio, dimensionless, strictly inside (−1, 0.5); absent = unknown. */
  readonly poissonRatio?: number;
  /** The tensile yield strength, Pa; absent = unknown (no factor-of-safety). */
  readonly yieldStrengthPa?: number;
  /** The coefficient of thermal expansion, 1/K; absent = unknown. */
  readonly thermalExpansionPerK?: number;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function materialRecordError(
  code: MaterialRecordErrorCode,
  message: string,
  input: unknown,
): MaterialRecordError {
  return { code, message, input };
}

function parseThermalField(
  input: unknown,
  field: string,
  lowerBound: number,
  upperBound: number | undefined,
): ParseResult<number | undefined, MaterialRecordError> {
  if (input === undefined || input === null) return ok(undefined);
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < lowerBound
  ) {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.thermalInvalid,
        `A material record's ${field} must be a finite number ≥ ${String(lowerBound)} when present.`,
        input,
      ),
    );
  }
  if (upperBound !== undefined && input > upperBound) {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.thermalInvalid,
        `A material record's ${field} must be ≤ ${String(upperBound)} when present.`,
        input,
      ),
    );
  }
  return ok(input);
}

/**
 * Parses one optional structural field — finite and strictly inside
 * (lower, upper) when present (Young's modulus and yield strength take
 * (0, ∞); Poisson's ratio takes the isotropic-stability band (−1, 0.5)).
 */
function parseStructuralField(
  input: unknown,
  field: string,
  lowerBound: number,
  upperBound: number | undefined,
): ParseResult<number | undefined, MaterialRecordError> {
  if (input === undefined || input === null) return ok(undefined);
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input <= lowerBound ||
    (upperBound !== undefined && input >= upperBound)
  ) {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.structuralInvalid,
        upperBound === undefined
          ? `A material record's ${field} must be a finite number > ${String(lowerBound)} when present.`
          : `A material record's ${field} must be a finite number strictly inside (${String(lowerBound)}, ${String(upperBound)}) when present.`,
        input,
      ),
    );
  }
  return ok(input);
}

/**
 * Validates and freezes untrusted input as a
 * {@link DocumentMaterialRecord} — the record's parse boundary (the
 * consumer layer's host owns record authoring; this is the shape contract
 * the thermal and structural paths rely on). The identity, name, and
 * density follow the mass aggregate's own rules; the additive thermal
 * and structural fields are strictly optional, but a PRESENT one must be
 * physically ordered: conductivity and specific heat non-negative
 * (finite and ≥ 0), emissivity in [0, 1], Young's modulus and yield
 * strength positive finite, Poisson's ratio strictly inside (−1, 0.5),
 * and the expansion coefficient finite (either sign).
 */
export function parseDocumentMaterialRecord(
  input: unknown,
): ParseResult<DocumentMaterialRecord, MaterialRecordError> {
  if (!isPlainRecord(input)) {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.malformed,
        "A material record must be a plain object with id, name, and densityGPerCm3 fields.",
        input,
      ),
    );
  }
  if (typeof input.id !== "string") {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.idInvalid,
        "A material record's id must be a valid material id (a `mat_`-prefixed string).",
        input.id,
      ),
    );
  }
  const parsedId = parseMaterialId(input.id);
  if (!parsedId.ok) {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.idInvalid,
        `A material record's id must be a valid material id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.nameInvalid,
        "A material record's name must be a non-empty string.",
        input.name,
      ),
    );
  }
  if (
    typeof input.densityGPerCm3 !== "number" ||
    !Number.isFinite(input.densityGPerCm3) ||
    input.densityGPerCm3 <= 0
  ) {
    return fail(
      materialRecordError(
        MATERIAL_RECORD_ERROR_CODES.densityInvalid,
        "A material record's density must be a positive finite g/cm³ value.",
        input.densityGPerCm3,
      ),
    );
  }
  const thermalConductivityWPerMK = parseThermalField(
    input.thermalConductivityWPerMK,
    "thermal conductivity (W/(m·K))",
    0,
    undefined,
  );
  if (!thermalConductivityWPerMK.ok) return thermalConductivityWPerMK;
  const specificHeatJPerKgK = parseThermalField(
    input.specificHeatJPerKgK,
    "specific heat (J/(kg·K))",
    0,
    undefined,
  );
  if (!specificHeatJPerKgK.ok) return specificHeatJPerKgK;
  const emissivity = parseThermalField(input.emissivity, "emissivity", 0, 1);
  if (!emissivity.ok) return emissivity;
  const youngsModulusPa = parseStructuralField(
    input.youngsModulusPa,
    "Young's modulus (Pa)",
    0,
    undefined,
  );
  if (!youngsModulusPa.ok) return youngsModulusPa;
  const poissonRatio = parseStructuralField(
    input.poissonRatio,
    "Poisson's ratio",
    -1,
    0.5,
  );
  if (!poissonRatio.ok) return poissonRatio;
  const yieldStrengthPa = parseStructuralField(
    input.yieldStrengthPa,
    "yield strength (Pa)",
    0,
    undefined,
  );
  if (!yieldStrengthPa.ok) return yieldStrengthPa;
  let thermalExpansionPerK: number | undefined;
  if (
    input.thermalExpansionPerK !== undefined &&
    input.thermalExpansionPerK !== null
  ) {
    if (
      typeof input.thermalExpansionPerK !== "number" ||
      !Number.isFinite(input.thermalExpansionPerK)
    ) {
      return fail(
        materialRecordError(
          MATERIAL_RECORD_ERROR_CODES.structuralInvalid,
          "A material record's thermal expansion coefficient (1/K) must be a finite number when present (either sign: shrinkage materials exist).",
          input.thermalExpansionPerK,
        ),
      );
    }
    thermalExpansionPerK = input.thermalExpansionPerK;
  }
  return ok(
    Object.freeze({
      id: parsedId.value,
      name: input.name.trim(),
      densityGPerCm3: input.densityGPerCm3,
      ...(thermalConductivityWPerMK.value === undefined
        ? {}
        : { thermalConductivityWPerMK: thermalConductivityWPerMK.value }),
      ...(specificHeatJPerKgK.value === undefined
        ? {}
        : { specificHeatJPerKgK: specificHeatJPerKgK.value }),
      ...(emissivity.value === undefined
        ? {}
        : { emissivity: emissivity.value }),
      ...(youngsModulusPa.value === undefined
        ? {}
        : { youngsModulusPa: youngsModulusPa.value }),
      ...(poissonRatio.value === undefined
        ? {}
        : { poissonRatio: poissonRatio.value }),
      ...(yieldStrengthPa.value === undefined
        ? {}
        : { yieldStrengthPa: yieldStrengthPa.value }),
      ...(thermalExpansionPerK === undefined ? {} : { thermalExpansionPerK }),
    }),
  );
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
