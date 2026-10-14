/**
 * The fan-scenario authoring form (Phase 66c): a Formedible CONFIG
 * OBJECT — zod schema + field list + options — never a hand-rolled TSX
 * form (the working-agreement law; the flow and thermal forms'
 * sibling). The form authors the fields the roadmap's fan surface
 * names: the fluid, the explicit 3D domain and resolution, the duct
 * inlet, the rotating-machinery stance (MRF — the honest default — or
 * the resolved-rotation showcase), the RPM MODE (a fixed authored rate
 * or the motor-driven operating point), the motor selection (the
 * document's `motors` records), the authored blade count, the shaft
 * axis and the rotating zone, and the step budget. Submission maps the
 * flat form values onto a cad-core `SimScenarioDraft` carrying the
 * `flow3d` stance through the pure {@link fanScenarioDraftOf} — the
 * mapper the config tests pin.
 *
 * The defaults ARE the motor-driven fan-in-a-tube demo: the demo
 * domain around the demo body, the demo motor preselected, MRF, four
 * blades — one submit saves the record that runs the Phase 66 demo.
 */

import {
  type MotorId,
  parseMotorId,
  type SimScenarioDraft,
} from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

import { FAN_DEMO, FAN_DEMO_MOTOR_ID } from "./fan-demo";

/** The rotation-kind vocabulary the form offers. */
export const FAN_ROTATION_OPTIONS = [
  { value: "mrf", label: "MRF (steady fan — the honest default)" },
  {
    value: "resolved-rotation",
    label: "Resolved rotation (the showcase, fixed rpm only)",
  },
] as const;

/** The RPM-mode vocabulary: fixed rate vs the motor-driven point. */
export const FAN_RPM_MODE_OPTIONS = [
  { value: "motor", label: "Motor-driven (find the operating point)" },
  { value: "fixed", label: "Fixed rpm (motor-less)" },
] as const;

/** The fluid choices: the Phase 61 named set, verbatim. */
export const FAN_FLUID_OPTIONS = [
  { value: "air", label: "Air" },
  { value: "water", label: "Water" },
  { value: "glycol", label: "Glycol" },
] as const;

/** One selectable motor of the document's `motors` section. */
export interface FanMotorOption {
  readonly value: string;
  readonly label: string;
  /** The formedible option-config index signature. */
  readonly [custom: string]: unknown;
}

export const fanScenarioSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the scenario a name")
    .max(64, "Keep the name under 64 characters"),
  fluid: z.enum(["air", "water", "glycol"]),
  domainMinX: z.number(),
  domainMinY: z.number(),
  domainMinZ: z.number(),
  domainMaxX: z.number(),
  domainMaxY: z.number(),
  domainMaxZ: z.number(),
  resolutionMm: z
    .number()
    .positive("The resolution must be positive millimetres"),
  inletSpeedMPerS: z
    .number()
    .positive("The inlet speed must be positive metres per second"),
  rotationKind: z.enum(["mrf", "resolved-rotation"]),
  rpmMode: z.enum(["motor", "fixed"]),
  motorId: z.string(),
  fixedRpm: z.number().positive("The fixed rpm must be positive"),
  bladeCount: z
    .number()
    .int()
    .min(1, "The blade count must be a positive integer"),
  axisPointX: z.number(),
  axisPointY: z.number(),
  axisPointZ: z.number(),
  axisDirX: z.number(),
  axisDirY: z.number(),
  axisDirZ: z.number(),
  zoneRadiusMm: z
    .number()
    .positive("The zone radius must be positive millimetres"),
  stepBudget: z
    .number()
    .int()
    .min(2, "The step budget must be an integer of at least 2"),
});

export type FanScenarioValues = z.infer<typeof fanScenarioSchema>;

/** The boot values: the motor-driven fan-in-a-tube demo. */
export const FAN_FORM_DEFAULT_VALUES: FanScenarioValues = {
  name: "fan-in-tube",
  fluid: "air",
  domainMinX: FAN_DEMO.domainMinMm[0],
  domainMinY: FAN_DEMO.domainMinMm[1],
  domainMinZ: FAN_DEMO.domainMinMm[2],
  domainMaxX: FAN_DEMO.domainMaxMm[0],
  domainMaxY: FAN_DEMO.domainMaxMm[1],
  domainMaxZ: FAN_DEMO.domainMaxMm[2],
  resolutionMm: FAN_DEMO.resolutionMm,
  inletSpeedMPerS: FAN_DEMO.inletSpeedMPerS,
  rotationKind: "mrf",
  rpmMode: "motor",
  motorId: FAN_DEMO_MOTOR_ID,
  fixedRpm: 80,
  bladeCount: FAN_DEMO.bladeCount,
  axisPointX: FAN_DEMO.axisPointMm[0],
  axisPointY: FAN_DEMO.axisPointMm[1],
  axisPointZ: FAN_DEMO.axisPointMm[2],
  axisDirX: FAN_DEMO.axisDirection[0],
  axisDirY: FAN_DEMO.axisDirection[1],
  axisDirZ: FAN_DEMO.axisDirection[2],
  zoneRadiusMm: FAN_DEMO.zoneRadiusMm,
  stepBudget: FAN_DEMO.stepBudget,
};

/**
 * The form's field list — one entry per schema key, in panel order.
 * The motor select's options arrive from the hosting document (the
 * `motors` records the page carries); the fixed-rpm field rides along
 * whatever the mode and the mapper consumes it only in the fixed
 * branch.
 */
export function fanScenarioFields(
  motorOptions: readonly FanMotorOption[],
): readonly FormedibleFieldConfig<FanScenarioValues>[] {
  return [
    { name: "name", type: "text", label: "Scenario name", required: true },
    {
      name: "fluid",
      type: "select",
      label: "Fluid",
      required: true,
      options: FAN_FLUID_OPTIONS,
    },
    {
      name: "domainMinX",
      type: "number",
      label: "Domain min X (mm)",
      required: true,
    },
    {
      name: "domainMinY",
      type: "number",
      label: "Domain min Y (mm)",
      required: true,
    },
    {
      name: "domainMinZ",
      type: "number",
      label: "Domain min Z (mm)",
      required: true,
    },
    {
      name: "domainMaxX",
      type: "number",
      label: "Domain max X (mm)",
      required: true,
    },
    {
      name: "domainMaxY",
      type: "number",
      label: "Domain max Y (mm)",
      required: true,
    },
    {
      name: "domainMaxZ",
      type: "number",
      label: "Domain max Z (mm)",
      required: true,
    },
    {
      name: "resolutionMm",
      type: "number",
      label: "Resolution (mm)",
      required: true,
    },
    {
      name: "inletSpeedMPerS",
      type: "number",
      label: "Duct inlet speed (m/s)",
      required: true,
    },
    {
      name: "rotationKind",
      type: "select",
      label: "Rotation",
      required: true,
      options: FAN_ROTATION_OPTIONS,
    },
    {
      name: "rpmMode",
      type: "radio",
      label: "RPM mode",
      options: FAN_RPM_MODE_OPTIONS,
    },
    {
      name: "motorId",
      type: "select",
      label: "Motor (the motors section)",
      options: motorOptions,
    },
    {
      name: "fixedRpm",
      type: "number",
      label: "Fixed rpm (the fixed mode's rate)",
    },
    {
      name: "bladeCount",
      type: "number",
      label: "Blade count (BPF = blades × rpm)",
      required: true,
    },
    {
      name: "axisPointX",
      type: "number",
      label: "Axis point X (mm)",
      required: true,
    },
    {
      name: "axisPointY",
      type: "number",
      label: "Axis point Y (mm)",
      required: true,
    },
    {
      name: "axisPointZ",
      type: "number",
      label: "Axis point Z (mm)",
      required: true,
    },
    {
      name: "axisDirX",
      type: "number",
      label: "Axis direction X",
      required: true,
    },
    {
      name: "axisDirY",
      type: "number",
      label: "Axis direction Y",
      required: true,
    },
    {
      name: "axisDirZ",
      type: "number",
      label: "Axis direction Z",
      required: true,
    },
    {
      name: "zoneRadiusMm",
      type: "number",
      label: "Rotating zone radius (mm)",
      required: true,
    },
    {
      name: "stepBudget",
      type: "number",
      label: "Steps per rung",
      required: true,
    },
  ];
}

/** Maps the form's values onto the document's scenario draft. */
export function fanScenarioDraftOf(
  values: FanScenarioValues,
): SimScenarioDraft {
  const direction = [
    values.axisDirX,
    values.axisDirY,
    values.axisDirZ,
  ] as const;
  const directionIsZero =
    direction[0] === 0 && direction[1] === 0 && direction[2] === 0;
  const motorDriven = values.rpmMode === "motor";
  // The motor selection crosses as a branded id: the form's string is
  // shape-checked here (the select only offers document ids) and the
  // invalid case declines the submit — never an unbranded cast.
  const parsedMotorId = parseMotorId(values.motorId);
  const motorId: MotorId | undefined = motorDriven
    ? parsedMotorId.ok
      ? parsedMotorId.value
      : undefined
    : undefined;
  if (motorDriven && motorId === undefined) {
    throw new Error(
      "A motor-driven fan scenario needs a valid motor record selection.",
    );
  }
  return {
    name: values.name.trim(),
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [values.domainMinX, values.domainMinY, values.domainMinZ],
      max: [values.domainMaxX, values.domainMaxY, values.domainMaxZ],
      resolutionMm: values.resolutionMm,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "zMin",
        speedMPerS: values.inletSpeedMPerS,
        direction: [0, 0, 1],
      },
    ],
    fluid: values.fluid,
    stepBudget: values.stepBudget,
    flow3d: {
      rotation: {
        kind: values.rotationKind,
        axisPointMm: [values.axisPointX, values.axisPointY, values.axisPointZ],
        axisDirection: directionIsZero ? [0, 0, 1] : [...direction],
        zoneRadiusMm: values.zoneRadiusMm,
        rpmMode: values.rpmMode,
        ...(!motorDriven && values.fixedRpm !== undefined
          ? { fixedRpm: values.fixedRpm }
          : {}),
        bladeCount: values.bladeCount,
      },
    },
    ...(motorId === undefined ? {} : { motorId }),
  };
}

/** The fan-scenario form: config object in, typed draft out. */
export function FanScenarioForm({
  motorOptions,
  onSubmitScenario,
  submitLabel = "Save scenario",
}: {
  /** The document's motor records, as select options. */
  readonly motorOptions: readonly FanMotorOption[];
  readonly onSubmitScenario: (draft: SimScenarioDraft) => void | Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<FanScenarioValues>({
    schema: fanScenarioSchema,
    fields: fanScenarioFields(motorOptions),
    formOptions: {
      defaultValues: FAN_FORM_DEFAULT_VALUES,
      onSubmit: async ({ value }) => {
        await onSubmitScenario(fanScenarioDraftOf(value));
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return <form.Form aria-label="Fan scenario" className="space-y-2" />;
}
