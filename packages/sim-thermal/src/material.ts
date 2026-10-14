/**
 * The solid material door of the thermal domain (Phase 65a, law S4's
 * consumer half): the scenario's material selections arrive as
 * CANONICAL SERIALIZED `DocumentMaterialRecord` wire objects — the same
 * stance the sim-core compile boundary takes (`@slopcad/cad-core`'s
 * serializers emit them; this package re-validates every field it
 * consumes and depends on nothing at runtime but `@slopcad/sim-core`).
 *
 * The conversions happen HERE and only here in this package: the
 * record's density is authored in g/cm³ (the document's mass
 * convention) and its thermal fields in SI — conductivity
 * W/(m·K), specific heat J/(kg·K), emissivity dimensionless — so the
 * ONE conversion this door owns is ρ·c:
 *
 *   volumetricHeatCapacityJPerM3K = densityGPerCm3 × 1000 × specificHeatJPerKgK
 *
 * (g/cm³ → kg/m³ is exactly ×1000, the same factor `MM_PER_M` guards at
 * the length boundary; stated here so the arithmetic has one home).
 *
 * The additive-fields honesty of the record rides through unchanged:
 * a record without `thermalConductivityWPerMK` declines loudly (no
 * conduction solve exists without k — never a fabricated value); a
 * record without `specificHeatJPerKgK` (or its density is somehow
 * unusable) parses with the volumetric heat capacity ABSENT, and only
 * the transient march — the one consumer that needs ρc — declines,
 * naming the material (the steady solve is legitimately ρc-free).
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
 * A solid material in solver space: conduction's k (always), the
 * transient march's ρc (present exactly when the record carried a
 * specific heat), and radiation's emissivity (the Phase 61 field —
 * absent means the surface cannot radiate and a radiation-bearing
 * boundary declines, never guesses).
 */
export interface ThermalSolidMaterial {
  readonly id: string;
  readonly name: string;
  /** Thermal conductivity, W/(m·K); finite, ≥ 0 (0 = perfect insulator). */
  readonly thermalConductivityWPerMK: number;
  /**
   * Volumetric heat capacity ρ·c, J/(m³·K); finite > 0 when present.
   * Absent when the record carried no specific heat — the transient
   * march declines on the first solid cell of such a material.
   */
  readonly volumetricHeatCapacityJPerM3K?: number;
  /** Hemispherical total emissivity, [0, 1]; absent = unknown. */
  readonly emissivity?: number;
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
 * {@link ThermalSolidMaterial}. The record's identity, name, and density
 * follow the mass aggregate's own rules (re-validated here, the wire
 * trust discipline); conductivity is REQUIRED by the conduction solve;
 * specific heat and emissivity ride additively.
 */
export function thermalSolidMaterialFromRecord(
  record: unknown,
): SimParseResult<ThermalSolidMaterial, SimError> {
  if (!isPlainRecord(record)) {
    return refuse(
      "A thermal scenario's material selection must be a plain serialized material record.",
      record,
    );
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    return refuse(
      "A thermal scenario's material record must carry a non-empty id.",
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
      `The material record "${record.id}" must carry a positive finite density in g/cm³ for the thermal door (ρ·c needs it).`,
      record.densityGPerCm3,
    );
  }
  if (record.thermalConductivityWPerMK === undefined) {
    return refuse(
      `The material record "${record.id}" carries no thermalConductivityWPerMK; a conduction solve without k would fabricate a value, and the thermal door declines instead.`,
      record,
    );
  }
  if (
    typeof record.thermalConductivityWPerMK !== "number" ||
    !Number.isFinite(record.thermalConductivityWPerMK) ||
    record.thermalConductivityWPerMK < 0
  ) {
    return refuse(
      `The material record "${record.id}" thermal conductivity must be a finite number ≥ 0 W/(m·K).`,
      record.thermalConductivityWPerMK,
    );
  }
  let volumetricHeatCapacityJPerM3K: number | undefined;
  if (record.specificHeatJPerKgK !== undefined) {
    if (
      typeof record.specificHeatJPerKgK !== "number" ||
      !Number.isFinite(record.specificHeatJPerKgK) ||
      record.specificHeatJPerKgK <= 0
    ) {
      return refuse(
        `The material record "${record.id}" specific heat must be a positive finite J/(kg·K) value when present.`,
        record.specificHeatJPerKgK,
      );
    }
    volumetricHeatCapacityJPerM3K =
      record.densityGPerCm3 *
      G_PER_CM3_TO_KG_PER_M3 *
      record.specificHeatJPerKgK;
  }
  let emissivity: number | undefined;
  if (record.emissivity !== undefined) {
    if (
      typeof record.emissivity !== "number" ||
      !Number.isFinite(record.emissivity) ||
      record.emissivity < 0 ||
      record.emissivity > 1
    ) {
      return refuse(
        `The material record "${record.id}" emissivity must be a finite number in [0, 1] when present.`,
        record.emissivity,
      );
    }
    emissivity = record.emissivity;
  }
  return simOk(
    Object.freeze({
      id: record.id,
      name,
      thermalConductivityWPerMK: record.thermalConductivityWPerMK,
      ...(volumetricHeatCapacityJPerM3K === undefined
        ? {}
        : { volumetricHeatCapacityJPerM3K }),
      ...(emissivity === undefined ? {} : { emissivity }),
    }),
  );
}
