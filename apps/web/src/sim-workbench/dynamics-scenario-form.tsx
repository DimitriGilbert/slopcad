/**
 * The dynamics-scenario authoring form (Phase 67c): a Formedible
 * CONFIG OBJECT — zod schema + field list + options — never a
 * hand-rolled TSX form (the working-agreement law; the flow, thermal,
 * and fan forms' sibling). The form authors the fields the roadmap's
 * dynamics surface names: the engine provider (the reference kernel —
 * the deterministic oracle — or the MuJoCo wasm provider behind the
 * same contract, the explicit opt-in), the motor selection (the 61
 * `motors` section, riding the demo's crank joint), and the march
 * budget (time step, duration, sample cadence — scenario fields,
 * never runtime knobs). Submission maps the flat form values onto a
 * cad-core `SimScenarioDraft` carrying the `dynamics` stance through
 * the pure {@link dynamicsScenarioDraftOf} — the mapper the config
 * tests pin.
 *
 * The mechanism itself is NOT a form field: the scenario's mechanism
 * source is the DOCUMENT's assembly joints and mate records (the
 * roadmap's own sentence), consumed at compile through the mechanism
 * wire the page derives. The defaults ARE the slider-crank demo: the
 * demo motor preselected on the reference kernel at the demo's march
 * budget — one submit saves the record that runs the Phase 67 demo.
 */

import {
  type MotorId,
  parseMotorId,
  type SimScenarioDraft,
  type SimScenarioDynamicsSpec,
} from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

import {
  SLIDER_DEMO,
  SLIDER_DEMO_MOTOR_ID,
  SLIDER_JOINT_IDS,
} from "./slider-crank-demo";

/** The provider vocabulary the form offers (the 67b factory seam). */
export const DYNAMICS_PROVIDER_OPTIONS = [
  {
    value: "reference",
    label: "Reference kernel (the deterministic oracle)",
  },
  {
    value: "mujoco",
    label: "MuJoCo wasm provider (opt-in, cross-validated)",
  },
] as const;

/** One selectable motor of the document's `motors` section. */
export interface DynamicsMotorOption {
  readonly value: string;
  readonly label: string;
  /** The formedible option-config index signature. */
  readonly [custom: string]: unknown;
}

/** The cross-field rule the mapper enforces on top of the schema. */
export const DYNAMICS_CADENCE_RULE =
  "The duration must be an integer multiple of the time step, and the sample interval an integer number of steps at most the duration.";

export const dynamicsScenarioSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the scenario a name")
    .max(64, "Keep the name under 64 characters"),
  provider: z.enum(["reference", "mujoco"]),
  motorId: z.string(),
  timeStepS: z.number().positive("The time step must be positive seconds"),
  durationS: z.number().positive("The duration must be positive seconds"),
  sampleIntervalS: z
    .number()
    .positive("The sample interval must be positive seconds"),
});

export type DynamicsScenarioValues = z.infer<typeof dynamicsScenarioSchema>;

/** The boot values: the slider-crank demo's own march. */
export const DYNAMICS_FORM_DEFAULT_VALUES: DynamicsScenarioValues = {
  name: "slider-crank",
  provider: "reference",
  motorId: SLIDER_DEMO_MOTOR_ID,
  timeStepS: SLIDER_DEMO.timeStepS,
  durationS: SLIDER_DEMO.durationS,
  sampleIntervalS: SLIDER_DEMO.sampleIntervalS,
};

/**
 * The form's field list — one entry per schema key, in panel order.
 * The motor select's options arrive from the hosting document (the
 * `motors` records the page carries).
 */
export function dynamicsScenarioFields(
  motorOptions: readonly DynamicsMotorOption[],
): readonly FormedibleFieldConfig<DynamicsScenarioValues>[] {
  return [
    {
      name: "name",
      type: "text",
      label: "Dynamics scenario name",
      required: true,
    },
    {
      name: "provider",
      type: "select",
      label: "Engine",
      required: true,
      options: DYNAMICS_PROVIDER_OPTIONS,
    },
    {
      name: "motorId",
      type: "select",
      label: "Motor (rides the crank joint)",
      options: motorOptions,
    },
    {
      name: "timeStepS",
      type: "number",
      label: "Time step (s)",
      required: true,
    },
    {
      name: "durationS",
      type: "number",
      label: "Duration (s)",
      required: true,
    },
    {
      name: "sampleIntervalS",
      type: "number",
      label: "Sample interval (s)",
      required: true,
    },
  ];
}

/** Maps the form's values onto the document's scenario draft. */
export function dynamicsScenarioDraftOf(
  values: DynamicsScenarioValues,
): SimScenarioDraft {
  // The motor selection crosses as a branded id: the form's string is
  // shape-checked here (the select only offers document ids) and the
  // invalid case declines the submit — never an unbranded cast.
  const parsedMotorId = parseMotorId(values.motorId);
  if (!parsedMotorId.ok) {
    throw new Error(
      "A dynamics scenario needs a valid motor record selection (the record rides exactly one joint).",
    );
  }
  const motorId: MotorId = parsedMotorId.value;
  // The step-lattice rule the record boundary enforces: restated here
  // so the mapper's decline names the form's own fields.
  const steps = Math.round(values.durationS / values.timeStepS);
  const cadence = Math.round(values.sampleIntervalS / values.timeStepS);
  if (
    steps < 1 ||
    Math.abs(steps * values.timeStepS - values.durationS) >
      1e-9 * values.durationS ||
    cadence < 1 ||
    Math.abs(cadence * values.timeStepS - values.sampleIntervalS) >
      1e-9 * values.sampleIntervalS ||
    values.sampleIntervalS > values.durationS
  ) {
    throw new Error(DYNAMICS_CADENCE_RULE);
  }
  const dynamics: SimScenarioDynamicsSpec = {
    timeStepS: values.timeStepS,
    durationS: values.durationS,
    sampleIntervalS: values.sampleIntervalS,
    motorJointId: SLIDER_JOINT_IDS.crank,
    ...(values.provider === "reference" ? {} : { provider: values.provider }),
  };
  return {
    name: values.name.trim(),
    kind: "dynamics",
    // The record's uniform domain/fluid fields: inert on a dynamics
    // run (the mechanism is the physics), authored at the demo's
    // bounding scale — the compile resolves them mechanically and the
    // engine consumes neither.
    domain: {
      kind: "explicit",
      min: [-20, -40, -12],
      max: [150, 40, 12],
      resolutionMm: 2,
    },
    conditions: [],
    fluid: "air",
    dynamics,
    motorId,
  };
}

/** The dynamics-scenario form: config object in, typed draft out. */
export function DynamicsScenarioForm({
  motorOptions,
  onSubmitScenario,
  submitLabel = "Save scenario",
}: {
  /** The document's motor records, as select options. */
  readonly motorOptions: readonly DynamicsMotorOption[];
  readonly onSubmitScenario: (draft: SimScenarioDraft) => void | Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<DynamicsScenarioValues>({
    schema: dynamicsScenarioSchema,
    fields: dynamicsScenarioFields(motorOptions),
    formOptions: {
      defaultValues: DYNAMICS_FORM_DEFAULT_VALUES,
      onSubmit: async ({ value }) => {
        await onSubmitScenario(dynamicsScenarioDraftOf(value));
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return <form.Form aria-label="Dynamics scenario" className="space-y-2" />;
}
