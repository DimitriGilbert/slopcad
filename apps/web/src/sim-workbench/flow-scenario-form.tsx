/**
 * The flow-scenario authoring form (Phase 63c): a Formedible CONFIG
 * OBJECT — zod schema + field list + options — never a hand-rolled TSX
 * form (the working-agreement law). The form authors exactly the fields
 * the roadmap's scenario surface names: the fluid selection (the Phase
 * 61 named set), the explicit domain bounds and resolution, the inlet
 * velocity, the peripheral boundary conditions (wall slip/no-slip and
 * symmetry), the outflow kind, the step budget, the grid-convergence
 * flag, and the backend preference. Submission maps the flat form
 * values onto a cad-core `SimScenarioDraft` through the pure
 * {@link flowScenarioDraftOf} — the mapper the config tests pin — so the
 * scenario record that lands in the document's `simulations` section is
 * the same validated shape every other authoring path produces.
 *
 * The defaults are the workbench demo's own wind tunnel: the fixture
 * domain around the demo plate, a slow air stream (real air at coarse
 * voxels is viscous-dominated — the honest regime the slice resolution
 * buys), no-slip walls, a convective outflow, and a short budget.
 */

import type { SimScenarioDraft } from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

/** The fluid choices: the Phase 61 named set, verbatim. */
export const FLOW_FLUID_OPTIONS = [
  { value: "air", label: "Air" },
  { value: "water", label: "Water" },
  { value: "glycol", label: "Glycol" },
] as const;

/** The peripheral wall vocabulary the 2D tunnel consumes. */
export const FLOW_WALL_OPTIONS = [
  { value: "no-slip", label: "Wall (no-slip)" },
  { value: "slip", label: "Wall (slip)" },
  { value: "symmetry", label: "Symmetry" },
] as const;

/** The outflow vocabulary. */
export const FLOW_OUTLET_OPTIONS = [
  { value: "convective", label: "Convective outflow" },
  { value: "pressure", label: "Pressure outlet" },
] as const;

/** The backend preference vocabulary (law S2/S5: the CPU oracle default). */
export const FLOW_BACKEND_OPTIONS = [
  { value: "cpu", label: "CPU reference kernel" },
  { value: "gpu", label: "GPU (Phase 64 provider)" },
] as const;

/**
 * The form's default domain: the Phase 62 fixture's explicit tunnel
 * around the demo plate — the same bounds the grid fixture renders.
 */
export const FLOW_FORM_DEFAULT_DOMAIN = {
  minMm: [-50, -34, -6],
  maxMm: [50, 34, 12],
  resolutionMm: 4,
} as const;

/** The default inlet speed, m/s — slow air, honest for coarse voxels. */
export const FLOW_FORM_DEFAULT_INLET_M_PER_S = 0.01;

/** The default step budget — short, and long enough to average over. */
export const FLOW_FORM_DEFAULT_STEP_BUDGET = 240;

export const flowScenarioSchema = z.object({
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
  southCondition: z.enum(["no-slip", "slip", "symmetry"]),
  northCondition: z.enum(["no-slip", "slip", "symmetry"]),
  outletKind: z.enum(["convective", "pressure"]),
  outletPressurePa: z.number(),
  stepBudget: z
    .number()
    .int()
    .min(2, "The step budget must be an integer of at least 2"),
  gridConvergence: z.boolean(),
  backend: z.enum(["cpu", "gpu"]),
});

export type FlowScenarioValues = z.infer<typeof flowScenarioSchema>;

/** The boot values: the demo wind tunnel. */
export const FLOW_FORM_DEFAULT_VALUES: FlowScenarioValues = {
  name: "wind-tunnel",
  fluid: "air",
  domainMinX: FLOW_FORM_DEFAULT_DOMAIN.minMm[0],
  domainMinY: FLOW_FORM_DEFAULT_DOMAIN.minMm[1],
  domainMinZ: FLOW_FORM_DEFAULT_DOMAIN.minMm[2],
  domainMaxX: FLOW_FORM_DEFAULT_DOMAIN.maxMm[0],
  domainMaxY: FLOW_FORM_DEFAULT_DOMAIN.maxMm[1],
  domainMaxZ: FLOW_FORM_DEFAULT_DOMAIN.maxMm[2],
  resolutionMm: FLOW_FORM_DEFAULT_DOMAIN.resolutionMm,
  inletSpeedMPerS: FLOW_FORM_DEFAULT_INLET_M_PER_S,
  southCondition: "no-slip",
  northCondition: "no-slip",
  outletKind: "convective",
  outletPressurePa: 0,
  stepBudget: FLOW_FORM_DEFAULT_STEP_BUDGET,
  gridConvergence: false,
  backend: "cpu",
};

/**
 * The form's field list — one entry per schema key, in panel order. The
 * domain bounds and the pressure outlet ride as number fields; the
 * pressure field is authored whatever the outlet kind and consumed only
 * by the pressure branch of the mapper.
 */
export const flowScenarioFields: readonly FormedibleFieldConfig<FlowScenarioValues>[] =
  [
    { name: "name", type: "text", label: "Scenario name", required: true },
    {
      name: "fluid",
      type: "select",
      label: "Fluid",
      required: true,
      options: FLOW_FLUID_OPTIONS,
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
      label: "Inlet speed (m/s)",
      required: true,
    },
    {
      name: "southCondition",
      type: "select",
      label: "South boundary",
      required: true,
      options: FLOW_WALL_OPTIONS,
    },
    {
      name: "northCondition",
      type: "select",
      label: "North boundary",
      required: true,
      options: FLOW_WALL_OPTIONS,
    },
    {
      name: "outletKind",
      type: "select",
      label: "Outflow",
      required: true,
      options: FLOW_OUTLET_OPTIONS,
    },
    {
      name: "outletPressurePa",
      type: "number",
      label: "Outlet pressure (Pa)",
      required: true,
    },
    {
      name: "stepBudget",
      type: "number",
      label: "Step budget",
      required: true,
    },
    {
      name: "gridConvergence",
      type: "checkbox",
      label: "Grid-convergence self-check",
    },
    {
      name: "backend",
      type: "radio",
      options: FLOW_BACKEND_OPTIONS,
      label: "Backend",
    },
  ];

/** The peripheral wall vocabulary, as the mapper's union. */
type FlowWallCondition = "no-slip" | "slip" | "symmetry";

/** Maps the form's values onto the document's scenario draft. */
export function flowScenarioDraftOf(
  values: FlowScenarioValues,
): SimScenarioDraft {
  const peripheral = (
    face: "yMin" | "yMax",
    condition: FlowWallCondition,
  ): NonNullable<SimScenarioDraft["conditions"]>[number] =>
    condition === "symmetry"
      ? { kind: "symmetry", face }
      : { kind: "wall", face, slip: condition === "slip" };
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
        face: "xMin",
        speedMPerS: values.inletSpeedMPerS,
        direction: [1, 0, 0],
      },
      ...(values.outletKind === "pressure"
        ? [
            {
              kind: "pressure-outlet" as const,
              face: "xMax" as const,
              pressurePa: values.outletPressurePa,
            },
          ]
        : []),
      peripheral("yMin", values.southCondition),
      peripheral("yMax", values.northCondition),
    ],
    fluid: values.fluid,
    stepBudget: values.stepBudget,
    gridConvergence: values.gridConvergence,
    backend: values.backend,
  };
}

/** The flow-scenario form: config object in, typed draft out. */
export function FlowScenarioForm({
  onSubmitScenario,
  submitLabel = "Save scenario",
}: {
  readonly onSubmitScenario: (draft: SimScenarioDraft) => void | Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<FlowScenarioValues>({
    schema: flowScenarioSchema,
    fields: flowScenarioFields,
    formOptions: {
      defaultValues: FLOW_FORM_DEFAULT_VALUES,
      onSubmit: async ({ value }) => {
        await onSubmitScenario(flowScenarioDraftOf(value));
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return <form.Form aria-label="Flow scenario" className="space-y-2" />;
}
