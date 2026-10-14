/**
 * The combustion STOVE authoring form (Phase 68c): a Formedible CONFIG
 * OBJECT — zod schema + field list + options — never a hand-rolled TSX
 * form (the working-agreement law), the `./thermal-scenario-form`
 * precedent applied to the stove WITH fire. The form authors exactly
 * the fields the 68c stove stance names: the fuel and equivalence
 * ratio of the premixed charge, the lit charge's state (the 0D fire
 * statement — a cold charge never ignites, the honest authoring rule),
 * the fire → wall coupling h and the fire-side wall temperature, the
 * 65-family solve fields (radiation mode, initial/ambient temperature,
 * ambient convection), and the march budget. The DOMAIN is the 65
 * fixture family's own (the same explicit bounds the thermal stove
 * rides) and the SOLID MATERIAL rides the thermal presets — the stove
 * with fire is the 65 stove body, one clause richer.
 *
 * Submission maps the flat form values onto a cad-core
 * `SimScenarioDraft` through the pure {@link combustionStoveDraftOf}
 * — the mapper the config tests pin.
 */

import type { BodyId, SimScenarioDraft } from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

import {
  THERMAL_FLUID_OPTIONS,
  THERMAL_FORM_DOMAIN,
  THERMAL_RADIATION_OPTIONS,
} from "./thermal-scenario-form";
import {
  THERMAL_MATERIAL_OPTIONS,
  thermalMaterialPresetOf,
} from "./thermal-materials";

/** The fuel vocabulary: the curated one-step kinetics set (CH4, octanes). */
export const COMBUSTION_STOVE_FUEL_OPTIONS = [
  { value: "CH4", label: "Methane (CH4)" },
  { value: "C8H18-ISO", label: "Iso-octane (gasoline surrogate)" },
  { value: "C8H18-N", label: "n-Octane" },
] as const;

/**
 * The lit charge's default temperature, K — the 0D fire statement: the
 * reactor is an autoignition march, so the charge authors already at
 * ignition conditions (a stove's lit burner pocket); a 300 K methane
 * charge never lights and the run reports a fire that did not burn.
 */
export const COMBUSTION_STOVE_DEFAULT_CHARGE_K = 1400;

/** The default fire → wall coupling, W/(m²·K) (a strong firebox band). */
export const COMBUSTION_STOVE_DEFAULT_WALL_H = 30;

/** The default march: 30 s at a 1 s cadence (the burn plus cooldown). */
export const COMBUSTION_STOVE_DEFAULT_DURATION_S = 30;
export const COMBUSTION_STOVE_DEFAULT_SAMPLE_INTERVAL_S = 1;

export const combustionStoveSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the scenario a name")
    .max(64, "Keep the name under 64 characters"),
  materialId: z.string().min(1, "Pick a material"),
  fluid: z.enum(["air", "water", "glycol"]),
  fuel: z.enum(["CH4", "C8H18-ISO", "C8H18-N"]),
  equivalenceRatio: z
    .number()
    .positive("The equivalence ratio must be positive")
    .max(5, "The chemistry carries equivalence ratios up to 5"),
  chargeTemperatureK: z
    .number()
    .positive("The charge temperature must be positive kelvin"),
  chargePressureBar: z
    .number()
    .positive("The charge pressure must be positive bar"),
  wallConvectionWPerM2K: z
    .number()
    .positive("The fire-wall h must be positive W/(m²·K)"),
  wallTemperatureK: z
    .number()
    .positive("The fire-side wall temperature must be positive kelvin"),
  radiationMode: z.enum(["off", "linearized", "full"]),
  initialTemperatureK: z
    .number()
    .positive("The initial temperature must be positive kelvin"),
  ambientConvectionWPerM2K: z
    .number()
    .min(0, "The ambient coefficient must be ≥ 0 W/(m²·K)"),
  durationS: z.number().positive("The duration must be positive seconds"),
  sampleIntervalS: z
    .number()
    .positive("The sample interval must be positive seconds"),
});

export type CombustionStoveValues = z.infer<typeof combustionStoveSchema>;

/** The boot values: the demo stove with fire (lit methane, steel body). */
export const COMBUSTION_STOVE_DEFAULT_VALUES: CombustionStoveValues = {
  name: "stove-fire",
  materialId: (THERMAL_MATERIAL_OPTIONS[0] as { readonly value: string }).value,
  fluid: "air",
  fuel: "CH4",
  equivalenceRatio: 1,
  chargeTemperatureK: COMBUSTION_STOVE_DEFAULT_CHARGE_K,
  chargePressureBar: 1,
  wallConvectionWPerM2K: COMBUSTION_STOVE_DEFAULT_WALL_H,
  wallTemperatureK: 293.15,
  radiationMode: "linearized",
  initialTemperatureK: 293.15,
  ambientConvectionWPerM2K: 5,
  durationS: COMBUSTION_STOVE_DEFAULT_DURATION_S,
  sampleIntervalS: COMBUSTION_STOVE_DEFAULT_SAMPLE_INTERVAL_S,
};

/** The form's field list — one entry per schema key, in panel order. */
export const combustionStoveFields: readonly FormedibleFieldConfig<CombustionStoveValues>[] =
  [
    {
      name: "name",
      type: "text",
      label: "Combustion scenario name",
      required: true,
    },
    {
      name: "materialId",
      type: "select",
      label: "Stove body material",
      required: true,
      options: THERMAL_MATERIAL_OPTIONS,
    },
    {
      name: "fluid",
      type: "select",
      label: "Working fluid",
      required: true,
      options: THERMAL_FLUID_OPTIONS,
    },
    {
      name: "fuel",
      type: "select",
      label: "Fuel",
      required: true,
      options: COMBUSTION_STOVE_FUEL_OPTIONS,
    },
    {
      name: "equivalenceRatio",
      type: "number",
      label: "Equivalence ratio φ",
      required: true,
    },
    {
      name: "chargeTemperatureK",
      type: "number",
      label: "Lit charge temperature (K)",
      required: true,
      description:
        "The 0D fire: the charge authors at ignition conditions — a cold charge never lights.",
    },
    {
      name: "chargePressureBar",
      type: "number",
      label: "Charge pressure (bar)",
      required: true,
    },
    {
      name: "wallConvectionWPerM2K",
      type: "number",
      label: "Fire-wall h (W/(m²·K))",
      required: true,
    },
    {
      name: "wallTemperatureK",
      type: "number",
      label: "Fire-side wall temperature (K)",
      required: true,
    },
    {
      name: "radiationMode",
      type: "select",
      label: "Radiation",
      required: true,
      options: THERMAL_RADIATION_OPTIONS,
    },
    {
      name: "initialTemperatureK",
      type: "number",
      label: "Initial / ambient temperature (K)",
      required: true,
    },
    {
      name: "ambientConvectionWPerM2K",
      type: "number",
      label: "Ambient convection h (W/(m²·K))",
      required: true,
    },
    {
      name: "durationS",
      type: "number",
      label: "March duration (s)",
      required: true,
    },
    {
      name: "sampleIntervalS",
      type: "number",
      label: "Sample interval (s)",
      required: true,
    },
  ];

/**
 * Maps the form's values onto the document's scenario draft — the
 * kind-locked combustion stance, stove mode, over the 65 fixture
 * domain with the demo body's material assignment.
 */
export function combustionStoveDraftOf(
  values: CombustionStoveValues,
  bodyId: BodyId,
): SimScenarioDraft {
  const material = thermalMaterialPresetOf(values.materialId);
  return {
    name: values.name.trim(),
    kind: "combustion",
    domain: {
      kind: "explicit",
      min: [...THERMAL_FORM_DOMAIN.minMm],
      max: [...THERMAL_FORM_DOMAIN.maxMm],
      resolutionMm: THERMAL_FORM_DOMAIN.resolutionMm,
    },
    conditions: [],
    fluid: values.fluid,
    materials: [{ bodyId, materialId: material.id }],
    combustion: {
      mode: "stove",
      fuel: values.fuel,
      equivalenceRatio: values.equivalenceRatio,
      chargeTemperatureK: values.chargeTemperatureK,
      chargePressureBar: values.chargePressureBar,
      wallConvectionWPerM2K: values.wallConvectionWPerM2K,
      wallTemperatureK: values.wallTemperatureK,
      radiationMode: values.radiationMode,
      initialTemperatureK: values.initialTemperatureK,
      ambientConvectionWPerM2K: values.ambientConvectionWPerM2K,
      durationS: values.durationS,
      sampleIntervalS: values.sampleIntervalS,
    },
    backend: "cpu",
  };
}

/** The combustion stove form: config object in, typed draft out. */
export function CombustionStoveForm({
  bodyId,
  onSubmitScenario,
  submitLabel = "Save fire scenario",
}: {
  /** The demo body the material assignment addresses. */
  readonly bodyId: BodyId;
  readonly onSubmitScenario: (draft: SimScenarioDraft) => void | Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<CombustionStoveValues>({
    schema: combustionStoveSchema,
    fields: combustionStoveFields,
    formOptions: {
      defaultValues: COMBUSTION_STOVE_DEFAULT_VALUES,
      onSubmit: async ({ value }) => {
        await onSubmitScenario(combustionStoveDraftOf(value, bodyId));
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return (
    <form.Form aria-label="Combustion stove scenario" className="space-y-2" />
  );
}
