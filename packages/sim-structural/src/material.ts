/**
 * The solid material door of the structural domain (Phase 69a, law S4's
 * consumer half — the `@slopcad/sim-thermal` material-door precedent):
 * the scenario's material selections arrive as CANONICAL SERIALIZED
 * `DocumentMaterialRecord` wire objects — the same stance the sim-core
 * compile boundary takes (`@slopcad/cad-core`'s serializers emit them;
 * this package re-validates every field it consumes and depends on
 * nothing at runtime but `@slopcad/sim-core`).
 *
 * The ONE conversion this door owns is the density:
 *
 *   densityKgPerM3 = densityGPerCm3 × 1000
 *
 * (g/cm³ → kg/m³, the mass convention's own factor — the thermal door's
 * ρc conversion stated the same move). Everything else is SI already:
 * Young's modulus and yield strength in Pa, Poisson's ratio and the
 * expansion coefficient dimensionless / 1/K.
 *
 * The additive-fields honesty rides the thermal precedent exactly: the
 * elasticity pair (Young's modulus AND Poisson's ratio) is REQUIRED by
 * every stiffness assembly — a record missing either declines loudly,
 * never a fabricated value. Density is likewise required (the body-force
 * family — self-weight and centrifugal load — is ρ-driven). The yield
 * strength and the expansion coefficient are consumer-scoped absences: a
 * record without `yieldStrengthPa` parses, runs, and reports every field
 * EXCEPT the factor of safety (the one consumer that needs it declines,
 * naming the material); a record without `thermalExpansionPerK` parses
 * and declines only when a thermal-expansion load is requested against
 * it. A record without any structural field at all is simply not a
 * structural material — the door refuses it for this domain.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";

/** g/cm³ → kg/m³ — the one density conversion of this door. */
const G_PER_CM3_TO_KG_PER_M3 = 1000;

/**
 * A solid material in structural solver space: the elasticity pair and
 * density every assembly needs, plus the two consumer-scoped optional
 * fields — yield strength (factor-of-safety reporting) and the thermal
 * expansion coefficient (the Phase 65 temperature-field chaining seam).
 */
export interface StructuralSolidMaterial {
  readonly id: string;
  readonly name: string;
  /** Density, kg/m³ (converted from the record's g/cm³ HERE). */
  readonly densityKgPerM3: number;
  /** Young's modulus, Pa; finite, > 0. */
  readonly youngsModulusPa: number;
  /** Poisson's ratio, dimensionless, strictly inside (−1, 0.5). */
  readonly poissonRatio: number;
  /** Tensile yield strength, Pa; absent = unknown (no factor of safety). */
  readonly yieldStrengthPa?: number;
  /** Coefficient of thermal expansion, 1/K; absent = unknown. */
  readonly thermalExpansionPerK?: number;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

const refuse = (
  message: string,
  at: unknown,
): SimParseResult<never, SimError> =>
  simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));

/**
 * Parses one serialized `DocumentMaterialRecord` into the solver-space
 * {@link StructuralSolidMaterial}. The record's identity, name, and
 * density follow the mass aggregate's own rules (re-validated here, the
 * wire trust discipline); the elasticity pair is REQUIRED — the exact
 * precedent of the thermal door requiring conductivity — and the yield
 * strength and expansion coefficient ride additively with their
 * consumer-scoped absence honesty.
 */
export function structuralSolidMaterialFromRecord(
  record: unknown,
): SimParseResult<StructuralSolidMaterial, SimError> {
  if (!isPlainRecord(record)) {
    return refuse(
      "A structural scenario's material selection must be a plain serialized material record.",
      record,
    );
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    return refuse(
      "A structural scenario's material record must carry a non-empty id.",
      record.id,
    );
  }
  const name =
    typeof record.name === "string" && record.name.trim().length > 0
      ? record.name.trim()
      : record.id;
  if (
    typeof record.densityGPerCm3 !== "number" ||
    !Number.isFinite(record.densityGPerCm3) ||
    record.densityGPerCm3 <= 0
  ) {
    return refuse(
      `The material record "${record.id}" must carry a positive finite density in g/cm³ for the structural door (the body-force family is density-driven).`,
      record.densityGPerCm3,
    );
  }
  if (
    typeof record.youngsModulusPa !== "number" ||
    !Number.isFinite(record.youngsModulusPa) ||
    record.youngsModulusPa <= 0
  ) {
    return refuse(
      `The material record "${record.id}" carries no valid youngsModulusPa; a linear-elastic stiffness assembly without E would fabricate a value, and the structural door declines instead.`,
      record.youngsModulusPa,
    );
  }
  if (
    typeof record.poissonRatio !== "number" ||
    !Number.isFinite(record.poissonRatio) ||
    record.poissonRatio <= -1 ||
    record.poissonRatio >= 0.5
  ) {
    return refuse(
      `The material record "${record.id}" carries no valid poissonRatio strictly inside (−1, 0.5) — the isotropic-stability band the elasticity law needs.`,
      record.poissonRatio,
    );
  }
  let yieldStrengthPa: number | undefined;
  if (record.yieldStrengthPa !== undefined && record.yieldStrengthPa !== null) {
    if (
      typeof record.yieldStrengthPa !== "number" ||
      !Number.isFinite(record.yieldStrengthPa) ||
      record.yieldStrengthPa <= 0
    ) {
      return refuse(
        `The material record "${record.id}" yield strength must be a positive finite Pa value when present.`,
        record.yieldStrengthPa,
      );
    }
    yieldStrengthPa = record.yieldStrengthPa;
  }
  let thermalExpansionPerK: number | undefined;
  if (
    record.thermalExpansionPerK !== undefined &&
    record.thermalExpansionPerK !== null
  ) {
    if (
      typeof record.thermalExpansionPerK !== "number" ||
      !Number.isFinite(record.thermalExpansionPerK)
    ) {
      return refuse(
        `The material record "${record.id}" thermal expansion coefficient must be a finite 1/K value when present.`,
        record.thermalExpansionPerK,
      );
    }
    thermalExpansionPerK = record.thermalExpansionPerK;
  }
  return simOk(
    Object.freeze({
      id: record.id,
      name,
      densityKgPerM3: record.densityGPerCm3 * G_PER_CM3_TO_KG_PER_M3,
      youngsModulusPa: record.youngsModulusPa,
      poissonRatio: record.poissonRatio,
      ...(yieldStrengthPa === undefined ? {} : { yieldStrengthPa }),
      ...(thermalExpansionPerK === undefined ? {} : { thermalExpansionPerK }),
    }),
  );
}
