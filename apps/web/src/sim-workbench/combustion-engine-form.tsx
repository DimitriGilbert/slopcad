/**
 * The combustion ENGINE authoring form (Phase 68c): a Formedible
 * CONFIG OBJECT — zod schema + field list + options — never a
 * hand-rolled TSX form (the working-agreement law), the
 * `./dynamics-scenario-form` precedent applied to the 0D Otto cycle.
 * The form authors exactly the fields the 68c engine stance names:
 * the fuel (the flame-speed set), the slider-crank geometry in
 * millimetres (the Phase 67 seam), the speed, the trapped charge at
 * IVC, the spark timing, the Woschni wall-heat stance, the Chen–Flynn
 * friction fields (the published defaults one edit away), and the
 * optional sweep axis whose rows ride the same result. The DOMAIN is
 * not physics here — the 0D chamber has no spatial domain — it rides
 * the fixture family's explicit box so the record stays the same
 * shape every kind shares (law S1), and the compile door never
 * voxelizes it.
 *
 * Submission maps the flat form values onto a cad-core
 * `SimScenarioDraft` through the pure {@link combustionEngineDraftOf}
 * — the mapper the config tests pin.
 */

import type { SimScenarioDraft } from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

import { THERMAL_FORM_DOMAIN } from "./thermal-scenario-form";

/** The engine fuel vocabulary: the published flame-speed set. */
export const COMBUSTION_ENGINE_FUEL_OPTIONS = [
  { value: "C8H18-ISO", label: "Iso-octane (gasoline surrogate)" },
  { value: "C8H18-N", label: "n-Octane" },
] as const;

/** The wall-heat vocabulary: adiabatic or the Woschni correlation. */
export const COMBUSTION_ENGINE_WALL_HEAT_OPTIONS = [
  { value: "adiabatic", label: "Adiabatic walls" },
  { value: "woschni", label: "Woschni correlation" },
] as const;

/** The sweep-axis vocabulary (the 68b sweeps). */
export const COMBUSTION_ENGINE_SWEEP_OPTIONS = [
  { value: "none", label: "No sweep (one cycle)" },
  { value: "compressionRatio", label: "Sweep compression ratio" },
  { value: "equivalenceRatio", label: "Sweep equivalence ratio φ" },
  { value: "sparkTiming", label: "Sweep spark timing" },
] as const;

/** The demo engine: a 0.5 L single at CR 10, 1500 rpm, WOT stoichiometric. */
export const COMBUSTION_ENGINE_DEMO = {
  boreMm: 86,
  crankRadiusMm: 43,
  rodLengthMm: 143,
  compressionRatio: 10,
  speedRpm: 1500,
  intakePressureBar: 1,
  intakeTK: 300,
  equivalenceRatio: 1,
  sparkTimingBTDCDeg: 25,
  wallTemperatureK: 450,
  /** The published Chen–Flynn default (the 68b constant, one edit away). */
  fmepA: 0.4,
  fmepB: 0.0075,
  fmepC: 0.075,
  fmepD: 0.0025,
  pumpingMepBar: 0.2,
  sweepFrom: 10,
  sweepTo: 50,
  sweepSteps: 8,
} as const;

export const combustionEngineSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the scenario a name")
    .max(64, "Keep the name under 64 characters"),
  fuel: z.enum(["C8H18-ISO", "C8H18-N"]),
  boreMm: z.number().positive("The bore must be positive mm"),
  crankRadiusMm: z.number().positive("The crank radius must be positive mm"),
  rodLengthMm: z.number().positive("The rod length must be positive mm"),
  compressionRatio: z
    .number()
    .positive("The compression ratio must be positive")
    .gt(1, "The compression ratio must exceed 1"),
  speedRpm: z.number().positive("The speed must be positive rpm"),
  intakePressureBar: z
    .number()
    .positive("The intake pressure must be positive bar"),
  intakeTK: z
    .number()
    .positive("The intake temperature must be positive kelvin"),
  equivalenceRatio: z
    .number()
    .positive("The equivalence ratio must be positive")
    .max(5, "The chemistry carries equivalence ratios up to 5"),
  sparkTimingBTDCDeg: z
    .number()
    .positive(
      "The spark timing is degrees before TDC, strictly inside the stroke",
    )
    .max(178, "The spark must fire inside the compression stroke"),
  wallHeatMode: z.enum(["adiabatic", "woschni"]),
  wallTemperatureK: z
    .number()
    .positive("The wall temperature must be positive kelvin"),
  overrideFmep: z.boolean(),
  fmepA: z.number().min(0, "The FMEP a term must be ≥ 0 bar"),
  fmepB: z.number().min(0, "The FMEP b term must be ≥ 0 bar/bar"),
  fmepC: z.number().min(0, "The FMEP c term must be ≥ 0 bar/(m/s)"),
  fmepD: z.number().min(0, "The FMEP d term must be ≥ 0 bar/(m/s)²"),
  pumpingMepBar: z.number().min(0, "The pumping MEP must be ≥ 0 bar"),
  sweepKind: z.enum([
    "none",
    "compressionRatio",
    "equivalenceRatio",
    "sparkTiming",
  ]),
  sweepFrom: z.number(),
  sweepTo: z.number(),
  sweepSteps: z.number().int().min(1, "A sweep needs at least 1 interval"),
});

export type CombustionEngineValues = z.infer<typeof combustionEngineSchema>;

/** The boot values: the demo Otto case with the spark sweep aboard. */
export const COMBUSTION_ENGINE_DEFAULT_VALUES: CombustionEngineValues = {
  name: "otto",
  fuel: "C8H18-ISO",
  boreMm: COMBUSTION_ENGINE_DEMO.boreMm,
  crankRadiusMm: COMBUSTION_ENGINE_DEMO.crankRadiusMm,
  rodLengthMm: COMBUSTION_ENGINE_DEMO.rodLengthMm,
  compressionRatio: COMBUSTION_ENGINE_DEMO.compressionRatio,
  speedRpm: COMBUSTION_ENGINE_DEMO.speedRpm,
  intakePressureBar: COMBUSTION_ENGINE_DEMO.intakePressureBar,
  intakeTK: COMBUSTION_ENGINE_DEMO.intakeTK,
  equivalenceRatio: COMBUSTION_ENGINE_DEMO.equivalenceRatio,
  sparkTimingBTDCDeg: COMBUSTION_ENGINE_DEMO.sparkTimingBTDCDeg,
  wallHeatMode: "woschni",
  wallTemperatureK: COMBUSTION_ENGINE_DEMO.wallTemperatureK,
  overrideFmep: false,
  fmepA: COMBUSTION_ENGINE_DEMO.fmepA,
  fmepB: COMBUSTION_ENGINE_DEMO.fmepB,
  fmepC: COMBUSTION_ENGINE_DEMO.fmepC,
  fmepD: COMBUSTION_ENGINE_DEMO.fmepD,
  pumpingMepBar: COMBUSTION_ENGINE_DEMO.pumpingMepBar,
  sweepKind: "sparkTiming",
  sweepFrom: COMBUSTION_ENGINE_DEMO.sweepFrom,
  sweepTo: COMBUSTION_ENGINE_DEMO.sweepTo,
  sweepSteps: COMBUSTION_ENGINE_DEMO.sweepSteps,
};

/** The form's field list — one entry per schema key, in panel order. */
export const combustionEngineFields: readonly FormedibleFieldConfig<CombustionEngineValues>[] =
  [
    {
      name: "name",
      type: "text",
      label: "Engine scenario name",
      required: true,
    },
    {
      name: "fuel",
      type: "select",
      label: "Fuel",
      required: true,
      options: COMBUSTION_ENGINE_FUEL_OPTIONS,
    },
    {
      name: "boreMm",
      type: "number",
      label: "Bore (mm)",
      required: true,
    },
    {
      name: "crankRadiusMm",
      type: "number",
      label: "Crank radius — half stroke (mm)",
      required: true,
    },
    {
      name: "rodLengthMm",
      type: "number",
      label: "Rod length (mm)",
      required: true,
    },
    {
      name: "compressionRatio",
      type: "number",
      label: "Compression ratio",
      required: true,
    },
    {
      name: "speedRpm",
      type: "number",
      label: "Speed (rpm)",
      required: true,
    },
    {
      name: "intakePressureBar",
      type: "number",
      label: "IVC pressure (bar)",
      required: true,
    },
    {
      name: "intakeTK",
      type: "number",
      label: "IVC temperature (K)",
      required: true,
    },
    {
      name: "equivalenceRatio",
      type: "number",
      label: "Equivalence ratio φ",
      required: true,
    },
    {
      name: "sparkTimingBTDCDeg",
      type: "number",
      label: "Spark timing (° before TDC)",
      required: true,
    },
    {
      name: "wallHeatMode",
      type: "radio",
      label: "Wall heat",
      options: COMBUSTION_ENGINE_WALL_HEAT_OPTIONS,
    },
    {
      name: "wallTemperatureK",
      type: "number",
      label: "Wall temperature (K)",
      required: true,
      description: "The Woschni coolant-side wall; ignored when adiabatic.",
    },
    {
      name: "overrideFmep",
      type: "checkbox",
      label: "Override the Chen–Flynn friction default",
      description:
        "Unchecked: the published default correlation rides the scenario fields.",
    },
    {
      name: "fmepA",
      type: "number",
      label: "FMEP a (bar)",
      required: true,
      conditional: "overrideFmep",
    },
    {
      name: "fmepB",
      type: "number",
      label: "FMEP b (bar/bar)",
      required: true,
      conditional: "overrideFmep",
    },
    {
      name: "fmepC",
      type: "number",
      label: "FMEP c (bar/(m/s))",
      required: true,
      conditional: "overrideFmep",
    },
    {
      name: "fmepD",
      type: "number",
      label: "FMEP d (bar/(m/s)²)",
      required: true,
      conditional: "overrideFmep",
    },
    {
      name: "pumpingMepBar",
      type: "number",
      label: "Pumping MEP (bar)",
      required: true,
      conditional: "overrideFmep",
    },
    {
      name: "sweepKind",
      type: "select",
      label: "Sweep",
      required: true,
      options: COMBUSTION_ENGINE_SWEEP_OPTIONS,
    },
    {
      name: "sweepFrom",
      type: "number",
      label: "Sweep from",
      required: true,
      conditional: (values) => values.sweepKind !== "none",
    },
    {
      name: "sweepTo",
      type: "number",
      label: "Sweep to",
      required: true,
      conditional: (values) => values.sweepKind !== "none",
    },
    {
      name: "sweepSteps",
      type: "number",
      label: "Sweep intervals",
      required: true,
      conditional: (values) => values.sweepKind !== "none",
    },
  ];

/**
 * Maps the form's values onto the document's scenario draft — the
 * kind-locked combustion stance, engine mode, over the fixture box
 * (the 0D chamber's domain is its authored geometry, never voxelized).
 */
export function combustionEngineDraftOf(
  values: CombustionEngineValues,
): SimScenarioDraft {
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
    fluid: "air",
    materials: [],
    combustion: {
      mode: "engine",
      fuel: values.fuel,
      geometry: {
        boreMm: values.boreMm,
        crankRadiusMm: values.crankRadiusMm,
        rodLengthMm: values.rodLengthMm,
        compressionRatio: values.compressionRatio,
      },
      speedRpm: values.speedRpm,
      charge: {
        intakePressureBar: values.intakePressureBar,
        intakeTK: values.intakeTK,
        equivalenceRatio: values.equivalenceRatio,
      },
      spark: { timingBTDCDeg: values.sparkTimingBTDCDeg },
      wallHeat:
        values.wallHeatMode === "woschni"
          ? { mode: "woschni", wallTemperatureK: values.wallTemperatureK }
          : { mode: "adiabatic" },
      ...(values.overrideFmep
        ? {
            friction: {
              aBar: values.fmepA,
              bBarPerBar: values.fmepB,
              cBarPerMPerS: values.fmepC,
              dBarPerM2S2: values.fmepD,
              pumpingMepBar: values.pumpingMepBar,
            },
          }
        : {}),
      ...(values.sweepKind === "none"
        ? {}
        : {
            sweep: {
              kind: values.sweepKind,
              from: values.sweepFrom,
              to: values.sweepTo,
              steps: values.sweepSteps,
            },
          }),
    },
    backend: "cpu",
  };
}

/** The combustion engine form: config object in, typed draft out. */
export function CombustionEngineForm({
  onSubmitScenario,
  submitLabel = "Save engine scenario",
}: {
  readonly onSubmitScenario: (draft: SimScenarioDraft) => void | Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<CombustionEngineValues>({
    schema: combustionEngineSchema,
    fields: combustionEngineFields,
    formOptions: {
      defaultValues: COMBUSTION_ENGINE_DEFAULT_VALUES,
      onSubmit: async ({ value }) => {
        await onSubmitScenario(combustionEngineDraftOf(value));
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return (
    <form.Form aria-label="Combustion engine scenario" className="space-y-2" />
  );
}
