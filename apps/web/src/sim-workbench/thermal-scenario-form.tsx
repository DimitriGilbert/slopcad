/**
 * The thermal-scenario authoring form (Phase 65c): a Formedible CONFIG
 * OBJECT — zod schema + field list + options — never a hand-rolled TSX
 * form (the working-agreement law), the `./flow-scenario-form`
 * precedent applied to the stove. The form authors exactly the fields
 * the 65c scenario surface names: the solid material (the fixture's
 * named presets), the working fluid (the Phase 61 named set — the
 * coupled march's buoyancy and the ambient exchange consume it), the
 * heat source (W per metre of the slice's depth), the initial/ambient
 * temperature, the ambient convection coefficient (the §7.12
 * equilibrium boundary's h), the radiation mode (off/linearized/full),
 * the steady-vs-transient stance with its budget (duration + sample
 * cadence), and the conjugate-coupling flag (the buoyant plume;
 * transient-only — a steady coupled stance cannot even save, the
 * record boundary declines it). The DOMAIN is not authored here: the
 * stove rides the fixture family's own explicit domain (the same
 * bounds the flow form and the grid fixture use — `./sim-grid-fixture`'s
 * SIM_FIXTURE_DOMAIN at the coarse preset's resolution), so the two
 * forms beside each other stay label-disjoint and the demo voxelizes
 * the same body every scenario family does.
 *
 * The BOUNDARY selection rides the mode, stated here: the sealed
 * conduction mode needs no face conditions — every exposed face takes
 * the equilibrium boundary (the ambient h plus the radiation mode's
 * loss); the coupled mode authors fixed-temperature walls at the
 * ambient temperature on the four lateral faces (the room whose walls
 * stay at ambient — the honest loss path a sealed cavity otherwise
 * lacks). Submission maps the flat form values onto a cad-core
 * `SimScenarioDraft` through the pure {@link thermalScenarioDraftOf}
 * — the mapper the config tests pin.
 *
 * The defaults are the demo stove: the heated plate (the fixture
 * domain's own body) as a steel wall at a believable equilibrium — a
 * "stove without fire" whose wall conducts and whose air is one flag
 * away from convecting.
 */

import type { BodyId, SimScenarioDraft } from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

import {
  THERMAL_MATERIAL_OPTIONS,
  thermalMaterialPresetOf,
} from "./thermal-materials";
import { SIM_FIXTURE_DOMAIN } from "./sim-grid-fixture";

/** The fluid choices: the Phase 61 named set, verbatim (the flow form's). */
export const THERMAL_FLUID_OPTIONS = [
  { value: "air", label: "Air" },
  { value: "water", label: "Water" },
  { value: "glycol", label: "Glycol" },
] as const;

/** The radiation-mode vocabulary (§7.12: off / linearized / full). */
export const THERMAL_RADIATION_OPTIONS = [
  { value: "off", label: "Radiation off" },
  { value: "linearized", label: "Linearized Stefan–Boltzmann" },
  { value: "full", label: "Full Stefan–Boltzmann" },
] as const;

/** The solve-mode vocabulary. */
export const THERMAL_SOLVE_MODE_OPTIONS = [
  { value: "steady", label: "Steady equilibrium" },
  { value: "transient", label: "Transient march" },
] as const;

/**
 * The stove's voxelization domain — NOT an authored field: the fixture
 * family's own explicit domain (`SIM_FIXTURE_DOMAIN`) at the coarse
 * preset's resolution, the same demo body every scenario family
 * voxelizes (the coupled march's lattice cost is the honest reason for
 * the coarse preset).
 */
export const THERMAL_FORM_DOMAIN = {
  minMm: SIM_FIXTURE_DOMAIN.minMm,
  maxMm: SIM_FIXTURE_DOMAIN.maxMm,
  resolutionMm: 4,
} as const;

/** The demo stove's default source, W per metre of depth. */
export const THERMAL_FORM_DEFAULT_SOURCE_W = 20;

/** The default initial/ambient temperature, K. */
export const THERMAL_FORM_DEFAULT_INITIAL_K = 293.15;

/** The default ambient convection coefficient, W/(m²·K). */
export const THERMAL_FORM_DEFAULT_AMBIENT_H = 5;

/** The default transient budget: 60 s at a 5 s cadence. */
export const THERMAL_FORM_DEFAULT_DURATION_S = 60;
export const THERMAL_FORM_DEFAULT_SAMPLE_INTERVAL_S = 5;

export const thermalScenarioSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the scenario a name")
    .max(64, "Keep the name under 64 characters"),
  materialId: z.string().min(1, "Pick a material"),
  fluid: z.enum(["air", "water", "glycol"]),
  sourceW: z
    .number()
    .positive("The source must be positive watts per metre of depth"),
  initialTemperatureK: z
    .number()
    .positive("The initial temperature must be positive kelvin"),
  ambientConvectionWPerM2K: z
    .number()
    .min(0, "The ambient coefficient must be ≥ 0 W/(m²·K)"),
  radiationMode: z.enum(["off", "linearized", "full"]),
  solveMode: z.enum(["steady", "transient"]),
  cht: z.boolean(),
  durationS: z.number().positive("The duration must be positive seconds"),
  sampleIntervalS: z
    .number()
    .positive("The sample interval must be positive seconds"),
});

export type ThermalScenarioValues = z.infer<typeof thermalScenarioSchema>;

/** The boot values: the demo stove, sealed steady mode. */
export const THERMAL_FORM_DEFAULT_VALUES: ThermalScenarioValues = {
  name: "stove",
  materialId: (THERMAL_MATERIAL_OPTIONS[0] as { readonly value: string }).value,
  fluid: "air",
  sourceW: THERMAL_FORM_DEFAULT_SOURCE_W,
  initialTemperatureK: THERMAL_FORM_DEFAULT_INITIAL_K,
  ambientConvectionWPerM2K: THERMAL_FORM_DEFAULT_AMBIENT_H,
  radiationMode: "linearized",
  solveMode: "steady",
  cht: false,
  durationS: THERMAL_FORM_DEFAULT_DURATION_S,
  sampleIntervalS: THERMAL_FORM_DEFAULT_SAMPLE_INTERVAL_S,
};

/** The form's field list — one entry per schema key, in panel order. */
export const thermalScenarioFields: readonly FormedibleFieldConfig<ThermalScenarioValues>[] =
  [
    {
      name: "name",
      type: "text",
      label: "Thermal scenario name",
      required: true,
    },
    {
      name: "materialId",
      type: "select",
      label: "Solid material",
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
      name: "sourceW",
      type: "number",
      label: "Heat source (W per m of depth)",
      required: true,
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
      name: "radiationMode",
      type: "select",
      label: "Radiation",
      required: true,
      options: THERMAL_RADIATION_OPTIONS,
    },
    {
      name: "solveMode",
      type: "radio",
      label: "Solve mode",
      options: THERMAL_SOLVE_MODE_OPTIONS,
    },
    {
      name: "cht",
      type: "checkbox",
      label: "Conjugate: convect to the fluid (buoyant plume)",
      description:
        "Transient only: the march couples the solid to the air with Boussinesq buoyancy.",
    },
    {
      name: "durationS",
      type: "number",
      label: "Transient duration (s)",
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
 * Maps the form's values onto the document's scenario draft. The
 * boundary set rides the mode (the module header's stated rule): sealed
 * conduction authors no face conditions — the equilibrium boundary
 * covers every exposed face — and the coupled march authors
 * fixed-temperature walls at the ambient temperature on the four
 * lateral faces (the room the plume rises in). The transient budget
 * rides only the transient stance.
 */
export function thermalScenarioDraftOf(
  values: ThermalScenarioValues,
  bodyId: BodyId,
): SimScenarioDraft {
  const material = thermalMaterialPresetOf(values.materialId);
  const lateralFaces = ["xMin", "xMax", "yMin", "yMax"] as const;
  return {
    name: values.name.trim(),
    kind: "thermal",
    domain: {
      kind: "explicit",
      min: [...THERMAL_FORM_DOMAIN.minMm],
      max: [...THERMAL_FORM_DOMAIN.maxMm],
      resolutionMm: THERMAL_FORM_DOMAIN.resolutionMm,
    },
    conditions: values.cht
      ? lateralFaces.map((face) => ({
          kind: "fixed-temperature" as const,
          face,
          temperatureK: values.initialTemperatureK,
        }))
      : [],
    fluid: values.fluid,
    materials: [{ bodyId, materialId: material.id }],
    thermal: {
      radiationMode: values.radiationMode,
      solveMode: values.solveMode,
      cht: values.cht,
      sourceW: values.sourceW,
      initialTemperatureK: values.initialTemperatureK,
      ambientConvectionWPerM2K: values.ambientConvectionWPerM2K,
      ...(values.solveMode === "transient"
        ? {
            durationS: values.durationS,
            sampleIntervalS: values.sampleIntervalS,
          }
        : {}),
    },
    backend: "cpu",
  };
}

/** The thermal-scenario form: config object in, typed draft out. */
export function ThermalScenarioForm({
  bodyId,
  onSubmitScenario,
  submitLabel = "Save thermal scenario",
}: {
  /** The demo body the material assignment addresses. */
  readonly bodyId: BodyId;
  readonly onSubmitScenario: (draft: SimScenarioDraft) => void | Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<ThermalScenarioValues>({
    schema: thermalScenarioSchema,
    fields: thermalScenarioFields,
    formOptions: {
      defaultValues: THERMAL_FORM_DEFAULT_VALUES,
      onSubmit: async ({ value }) => {
        await onSubmitScenario(thermalScenarioDraftOf(value, bodyId));
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return <form.Form aria-label="Thermal scenario" className="space-y-2" />;
}
