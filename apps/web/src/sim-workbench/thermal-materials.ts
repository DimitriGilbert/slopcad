/**
 * The thermal fixture's material presets (Phase 65c): the demo
 * document carries no material records (material records are
 * consumer-layer records, the `DocumentMaterialRecord` resolver seam),
 * so the workbench's thermal form selects among these NAMED PRESETS —
 * serialized record wire objects in exactly the form the compile input
 * carries across the worker wire and `@slopcad/sim-thermal`'s material
 * door re-validates. Pure data, one source of truth for the form's
 * options and the compile input's records.
 *
 * The values are textbook-adjacent engineering values (the same honesty
 * band the kernel fixtures use): stated in the record fields the door
 * consumes — density in g/cm³ (the document mass convention),
 * conductivity W/(m·K), specific heat J/(kg·K), emissivity [0, 1].
 */

import { type MaterialId, parseMaterialId } from "@slopcad/cad-core";

/** Parses a preset's authored id once — the fixture's own static assert. */
function presetMaterialId(raw: string): MaterialId {
  const parsed = parseMaterialId(raw);
  if (!parsed.ok) {
    throw new Error(
      `The thermal material preset id "${raw}" is not a valid material id: ${parsed.error.message}`,
    );
  }
  return parsed.value;
}

/** One selectable preset: the option's value plus its record wire form. */
export interface ThermalMaterialPreset {
  /** The material id the scenario's assignments reference. */
  readonly id: MaterialId;
  /** The form option's display label. */
  readonly label: string;
  /** The serialized `DocumentMaterialRecord` wire object. */
  readonly record: Record<string, unknown>;
}

/** The presets, in selector order. */
export const THERMAL_MATERIAL_PRESETS: readonly ThermalMaterialPreset[] = [
  {
    id: presetMaterialId("mat_demo_steel"),
    label: "Steel (k = 45)",
    record: {
      id: "mat_demo_steel",
      name: "Steel",
      densityGPerCm3: 7.8,
      thermalConductivityWPerMK: 45,
      specificHeatJPerKgK: 466,
      emissivity: 0.6,
    },
  },
  {
    id: presetMaterialId("mat_demo_aluminum"),
    label: "Aluminium (k = 205)",
    record: {
      id: "mat_demo_aluminum",
      name: "Aluminium",
      densityGPerCm3: 2.7,
      thermalConductivityWPerMK: 205,
      specificHeatJPerKgK: 900,
      emissivity: 0.1,
    },
  },
  {
    id: presetMaterialId("mat_demo_insulation"),
    label: "Ceramic insulation (k = 0.3)",
    record: {
      id: "mat_demo_insulation",
      name: "Ceramic insulation",
      densityGPerCm3: 0.6,
      thermalConductivityWPerMK: 0.3,
      specificHeatJPerKgK: 1000,
      emissivity: 0.85,
    },
  },
];

/**
 * The preset a material id names. Unknown ids (a stale form value, a
 * hand-edited field) resolve to the FIRST preset — the fixture's own
 * form offers only these ids, so an unknown one is a form bug the
 * scenario name will make visible, never a fabricated material record.
 */
export function thermalMaterialPresetOf(id: string): ThermalMaterialPreset {
  const found = THERMAL_MATERIAL_PRESETS.find(
    (preset) => (preset.id as string) === id,
  );
  return found ?? (THERMAL_MATERIAL_PRESETS[0] as ThermalMaterialPreset);
}

/** The option list the form's material select consumes. */
export const THERMAL_MATERIAL_OPTIONS = THERMAL_MATERIAL_PRESETS.map(
  (preset) => ({ value: preset.id, label: preset.label }),
);
