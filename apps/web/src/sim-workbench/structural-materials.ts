/**
 * The structural fixture's material presets (Phase 69, the thermal
 * `./thermal-materials` precedent): the demo document carries no
 * material records (material records are consumer-layer records, the
 * `DocumentMaterialRecord` resolver seam), so the workbench's
 * structural form selects among these NAMED PRESETS — serialized record
 * wire objects in exactly the form the compile input carries across
 * the worker wire and `@slopcad/sim-structural`'s material door
 * re-validates. Pure data, one source of truth for the form's options
 * and the compile input's records.
 *
 * The values are textbook-adjacent engineering values (the same honesty
 * band the kernel fixtures use), stated in the record fields the door
 * consumes — density in g/cm³ (the document mass convention), Young's
 * modulus in Pa, Poisson's ratio, yield strength in Pa (the
 * factor-of-safety family), and the thermal-expansion coefficient the
 * hot-bracket chain consumes.
 */

import { type MaterialId, parseMaterialId } from "@slopcad/cad-core";

/** Parses a preset's authored id once — the fixture's own static assert. */
function presetMaterialId(raw: string): MaterialId {
  const parsed = parseMaterialId(raw);
  if (!parsed.ok) {
    throw new Error(
      `The structural material preset id "${raw}" is not a valid material id: ${parsed.error.message}`,
    );
  }
  return parsed.value;
}

/** One selectable preset: the option's value plus its record wire form. */
export interface StructuralMaterialPreset {
  /** The material id the scenario's assignments reference. */
  readonly id: MaterialId;
  /** The form option's display label. */
  readonly label: string;
  /** The serialized `DocumentMaterialRecord` wire object. */
  readonly record: Record<string, unknown>;
}

/** The presets, in selector order. */
export const STRUCTURAL_MATERIAL_PRESETS: readonly StructuralMaterialPreset[] =
  [
    {
      id: presetMaterialId("mat_demo_steel_s235"),
      label: "Steel S235 (E = 210 GPa)",
      record: {
        id: "mat_demo_steel_s235",
        name: "Steel S235",
        densityGPerCm3: 7.85,
        youngsModulusPa: 210e9,
        poissonRatio: 0.3,
        yieldStrengthPa: 235e6,
        thermalExpansionPerK: 1.2e-5,
      },
    },
    {
      id: presetMaterialId("mat_demo_aluminium_6061"),
      label: "Aluminium 6061 (E = 69 GPa)",
      record: {
        id: "mat_demo_aluminium_6061",
        name: "Aluminium 6061",
        densityGPerCm3: 2.7,
        youngsModulusPa: 69e9,
        poissonRatio: 0.33,
        yieldStrengthPa: 275e6,
        thermalExpansionPerK: 2.3e-5,
      },
    },
  ];

/**
 * The preset a material id names. Unknown ids (a stale form value, a
 * hand-edited field) resolve to the FIRST preset — the fixture's own
 * form offers only these ids, so an unknown one is a form bug the
 * scenario name will make visible, never a fabricated material record.
 */
export function structuralMaterialPresetOf(
  id: string,
): StructuralMaterialPreset {
  const found = STRUCTURAL_MATERIAL_PRESETS.find(
    (preset) => (preset.id as string) === id,
  );
  return found ?? (STRUCTURAL_MATERIAL_PRESETS[0] as StructuralMaterialPreset);
}

/** The option list the form's material select consumes. */
export const STRUCTURAL_MATERIAL_OPTIONS = STRUCTURAL_MATERIAL_PRESETS.map(
  (preset) => ({ value: preset.id, label: preset.label }),
);
