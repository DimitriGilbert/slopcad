/**
 * The structural-scenario authoring form (Phase 69): a Formedible
 * CONFIG OBJECT — zod schema + field list + options — never a
 * hand-rolled TSX form (the working-agreement law), the
 * `./thermal-scenario-form` precedent applied to the bracket. The form
 * authors exactly the fields the 69 scenario surface names: the solid
 * material (the fixture's named presets with the structural fields),
 * ONE fixture (a fixed face — the demo's bolted base — a symmetry
 * roller on a face, or a point fix), ONE load (the demo's tip force at
 * a point, a total force spread over a face, or a pressure on a face),
 * and the body-force family's switches (self-weight on/off through the
 * scenario's gravity vector, the centrifugal stance — a fixed authored
 * rpm or a referenced fan run's found operating point — and the thermal
 * chain with its stress-free reference temperature).
 *
 * ## The boundary-condition selection UX (the named product risk)
 *
 * Face and point selection rides HONEST AXIS/FACE/POINT SELECTORS —
 * the six domain faces as a select, world points as explicit mm
 * triples against the demo body's authored geometry (the bracket's tip
 * is the wall's top centre, stated in the demo constants). There is no
 * 3D picking against the voxelized body in this surface: the Phase 62
 * overlay family deliberately never enters the pick path, and no
 * precedent exists for pickable plane/point widgets on the sim grid —
 * a half-built picker is worse than stated selectors, so the selectors
 * are what shipped, with the overlay painting the committed round
 * beside them.
 *
 * The RUN-TO-RUN chain selections (which persisted thermal run's
 * temperature field feeds the ΔT, which fan run's operating point
 * feeds the rpm) are NOT form fields: runs are store data, not
 * document records, so they ride native selects over the persisted run
 * list in the page (the 63d comparison surface's precedent), consumed
 * only when the stance asks.
 *
 * Submission maps the flat form values onto a cad-core
 * `SimScenarioDraft` through the pure {@link structuralScenarioDraftOf}
 * — the mapper the config tests pin.
 */

import type { BodyId, SimScenarioDraft } from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

import {
  STRUCTURAL_MATERIAL_OPTIONS,
  structuralMaterialPresetOf,
} from "./structural-materials";
import { BRACKET_DEMO } from "./bracket-demo";

/** The six domain faces the fixture/load selectors offer. */
export const STRUCTURAL_FACE_OPTIONS = [
  { value: "xMin", label: "x min" },
  { value: "xMax", label: "x max" },
  { value: "yMin", label: "y min" },
  { value: "yMax", label: "y max" },
  { value: "zMin", label: "z min (the base's bottom)" },
  { value: "zMax", label: "z max (the wall's top)" },
] as const;

/** The fixture kinds the form authors. */
export const STRUCTURAL_FIXTURE_OPTIONS = [
  { value: "fixed-face", label: "Fixed face (all dofs)" },
  { value: "symmetry-roller", label: "Symmetry roller (one axis)" },
  { value: "point-fix", label: "Point fix (nearest node)" },
] as const;

/** The load kinds the form authors. */
export const STRUCTURAL_LOAD_OPTIONS = [
  { value: "force-point", label: "Force at a point (the tip load)" },
  { value: "force-face", label: "Total force on a face" },
  { value: "pressure-face", label: "Pressure on a face" },
] as const;

/** The centrifugal rate sources. */
export const STRUCTURAL_CENTRIFUGAL_OPTIONS = [
  { value: "none", label: "None" },
  { value: "fixed", label: "Fixed rpm" },
  { value: "fan-run", label: "A fan run's operating point" },
] as const;

/** The finite-number schema every authored magnitude shares. */
const finite = z.number();

export const structuralScenarioSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the scenario a name")
    .max(64, "Keep the name under 64 characters"),
  materialId: z.string().min(1, "Pick a material"),
  fixtureKind: z.enum(["fixed-face", "symmetry-roller", "point-fix"]),
  fixtureFace: z.enum(["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"]),
  rollerAxis: z.enum(["x", "y", "z"]),
  fixturePointX: finite,
  fixturePointY: finite,
  fixturePointZ: finite,
  loadKind: z.enum(["force-point", "force-face", "pressure-face"]),
  loadPointX: finite,
  loadPointY: finite,
  loadPointZ: finite,
  loadFace: z.enum(["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"]),
  loadForceX: finite,
  loadForceY: finite,
  loadForceZ: finite,
  loadPressurePa: finite,
  selfWeight: z.boolean(),
  centrifugalMode: z.enum(["none", "fixed", "fan-run"]),
  centrifugalFixedRpm: finite,
  centrifugalAxisPointX: finite,
  centrifugalAxisPointY: finite,
  centrifugalAxisPointZ: finite,
  centrifugalAxisDirX: finite,
  centrifugalAxisDirY: finite,
  centrifugalAxisDirZ: finite,
  thermalChain: z.boolean(),
  referenceTemperatureK: finite,
});

export type StructuralScenarioValues = z.infer<typeof structuralScenarioSchema>;

/** The boot values: the demo bracket — bolted base, −y tip load, dry. */
export const STRUCTURAL_FORM_DEFAULT_VALUES: StructuralScenarioValues = {
  name: "bracket",
  materialId: (STRUCTURAL_MATERIAL_OPTIONS[0] as { readonly value: string })
    .value,
  fixtureKind: "fixed-face",
  fixtureFace: BRACKET_DEMO.fixtureFace,
  rollerAxis: "y",
  fixturePointX: 0,
  fixturePointY: 0,
  fixturePointZ: 0,
  loadKind: "force-point",
  loadPointX: BRACKET_DEMO.tipPointMm[0],
  loadPointY: BRACKET_DEMO.tipPointMm[1],
  loadPointZ: BRACKET_DEMO.tipPointMm[2],
  loadFace: "yMax",
  loadForceX: BRACKET_DEMO.tipForceN[0],
  loadForceY: BRACKET_DEMO.tipForceN[1],
  loadForceZ: BRACKET_DEMO.tipForceN[2],
  loadPressurePa: 1e5,
  selfWeight: false,
  centrifugalMode: "none",
  centrifugalFixedRpm: 3000,
  centrifugalAxisPointX: 0,
  centrifugalAxisPointY: 0,
  centrifugalAxisPointZ: 0,
  centrifugalAxisDirX: 0,
  centrifugalAxisDirY: 0,
  centrifugalAxisDirZ: 1,
  thermalChain: false,
  referenceTemperatureK: BRACKET_DEMO.referenceTemperatureK,
};

/** The form's field list — one entry per schema key, in panel order. */
export const structuralScenarioFields: readonly FormedibleFieldConfig<StructuralScenarioValues>[] =
  [
    {
      name: "name",
      type: "text",
      label: "Structural scenario name",
      required: true,
    },
    {
      name: "materialId",
      type: "select",
      label: "Solid material",
      required: true,
      options: STRUCTURAL_MATERIAL_OPTIONS,
    },
    {
      name: "fixtureKind",
      type: "select",
      label: "Fixture",
      required: true,
      options: STRUCTURAL_FIXTURE_OPTIONS,
    },
    {
      name: "fixtureFace",
      type: "select",
      label: "Fixture face",
      required: true,
      options: STRUCTURAL_FACE_OPTIONS,
      conditional: (values) => values.fixtureKind !== "point-fix",
    },
    {
      name: "rollerAxis",
      type: "select",
      label: "Roller axis (the fixed component)",
      required: true,
      options: [
        { value: "x", label: "x" },
        { value: "y", label: "y" },
        { value: "z", label: "z" },
      ],
      conditional: (values) => values.fixtureKind === "symmetry-roller",
    },
    {
      name: "fixturePointX",
      type: "number",
      label: "Fixture point x (mm)",
      required: true,
      conditional: (values) => values.fixtureKind === "point-fix",
    },
    {
      name: "fixturePointY",
      type: "number",
      label: "Fixture point y (mm)",
      required: true,
      conditional: (values) => values.fixtureKind === "point-fix",
    },
    {
      name: "fixturePointZ",
      type: "number",
      label: "Fixture point z (mm)",
      required: true,
      conditional: (values) => values.fixtureKind === "point-fix",
    },
    {
      name: "loadKind",
      type: "select",
      label: "Load",
      required: true,
      options: STRUCTURAL_LOAD_OPTIONS,
    },
    {
      name: "loadPointX",
      type: "number",
      label: "Load point x (mm)",
      required: true,
      conditional: (values) => values.loadKind === "force-point",
    },
    {
      name: "loadPointY",
      type: "number",
      label: "Load point y (mm)",
      required: true,
      conditional: (values) => values.loadKind === "force-point",
    },
    {
      name: "loadPointZ",
      type: "number",
      label: "Load point z (mm)",
      required: true,
      conditional: (values) => values.loadKind === "force-point",
    },
    {
      name: "loadFace",
      type: "select",
      label: "Load face",
      required: true,
      options: STRUCTURAL_FACE_OPTIONS,
      conditional: (values) => values.loadKind !== "force-point",
    },
    {
      name: "loadForceX",
      type: "number",
      label: "Load force x (N)",
      required: true,
      conditional: (values) => values.loadKind !== "pressure-face",
    },
    {
      name: "loadForceY",
      type: "number",
      label: "Load force y (N)",
      required: true,
      conditional: (values) => values.loadKind !== "pressure-face",
    },
    {
      name: "loadForceZ",
      type: "number",
      label: "Load force z (N)",
      required: true,
      conditional: (values) => values.loadKind !== "pressure-face",
    },
    {
      name: "loadPressurePa",
      type: "number",
      label: "Load pressure (Pa, positive pushes in)",
      required: true,
      conditional: (values) => values.loadKind === "pressure-face",
    },
    {
      name: "selfWeight",
      type: "checkbox",
      label: "Self-weight (the scenario's gravity vector)",
      description:
        "Off = a weightless solve; on = the body-force term through standard gravity, −Y.",
    },
    {
      name: "centrifugalMode",
      type: "radio",
      label: "Centrifugal load",
      options: STRUCTURAL_CENTRIFUGAL_OPTIONS,
    },
    {
      name: "centrifugalFixedRpm",
      type: "number",
      label: "Shaft rate (rpm)",
      required: true,
      conditional: (values) => values.centrifugalMode === "fixed",
    },
    {
      name: "centrifugalAxisPointX",
      type: "number",
      label: "Axis point x (mm)",
      required: true,
      conditional: (values) => values.centrifugalMode !== "none",
    },
    {
      name: "centrifugalAxisPointY",
      type: "number",
      label: "Axis point y (mm)",
      required: true,
      conditional: (values) => values.centrifugalMode !== "none",
    },
    {
      name: "centrifugalAxisPointZ",
      type: "number",
      label: "Axis point z (mm)",
      required: true,
      conditional: (values) => values.centrifugalMode !== "none",
    },
    {
      name: "centrifugalAxisDirX",
      type: "number",
      label: "Axis direction x",
      required: true,
      conditional: (values) => values.centrifugalMode !== "none",
    },
    {
      name: "centrifugalAxisDirY",
      type: "number",
      label: "Axis direction y",
      required: true,
      conditional: (values) => values.centrifugalMode !== "none",
    },
    {
      name: "centrifugalAxisDirZ",
      type: "number",
      label: "Axis direction z",
      required: true,
      conditional: (values) => values.centrifugalMode !== "none",
    },
    {
      name: "thermalChain",
      type: "checkbox",
      label: "Thermal chain (a thermal run's temperature field)",
      description:
        "The selected thermal run's temperatures become ΔT against the reference — will the bracket warp when hot.",
    },
    {
      name: "referenceTemperatureK",
      type: "number",
      label: "Stress-free reference temperature (K)",
      required: true,
      conditional: "thermalChain",
    },
  ];

/**
 * Maps the form's values onto the document's scenario draft: the
 * fixture and the load become the scenario's conditions array (the
 * 69a compiled family), and the body-force switches become the
 * kind-locked structural stance.
 */
export function structuralScenarioDraftOf(
  values: StructuralScenarioValues,
  bodyIds: readonly BodyId[],
): SimScenarioDraft {
  const material = structuralMaterialPresetOf(values.materialId);
  const conditions = [
    values.fixtureKind === "fixed-face"
      ? ({ kind: "fixed-support", face: values.fixtureFace } as const)
      : values.fixtureKind === "symmetry-roller"
        ? ({
            kind: "axis-fix",
            face: values.fixtureFace,
            axis: values.rollerAxis,
          } as const)
        : ({
            kind: "point-fix",
            atWorldPointMm: [
              values.fixturePointX,
              values.fixturePointY,
              values.fixturePointZ,
            ],
          } as const),
    values.loadKind === "force-point"
      ? ({
          kind: "point-load",
          atWorldPointMm: [
            values.loadPointX,
            values.loadPointY,
            values.loadPointZ,
          ],
          forceN: [values.loadForceX, values.loadForceY, values.loadForceZ],
        } as const)
      : values.loadKind === "force-face"
        ? ({
            kind: "force-load",
            face: values.loadFace,
            forceN: [values.loadForceX, values.loadForceY, values.loadForceZ],
          } as const)
        : ({
            kind: "pressure-load",
            face: values.loadFace,
            pressurePa: values.loadPressurePa,
          } as const),
  ];
  return {
    name: values.name.trim(),
    kind: "structural",
    domain: {
      kind: "explicit",
      min: [...BRACKET_DEMO.domainMinMm],
      max: [...BRACKET_DEMO.domainMaxMm],
      resolutionMm: BRACKET_DEMO.resolutionMm,
    },
    conditions,
    fluid: "air",
    materials: bodyIds.map((bodyId) => ({
      bodyId,
      materialId: material.id,
    })),
    structural: {
      selfWeight: values.selfWeight,
      ...(values.centrifugalMode === "none"
        ? {}
        : {
            centrifugal: {
              axisPointMm: [
                values.centrifugalAxisPointX,
                values.centrifugalAxisPointY,
                values.centrifugalAxisPointZ,
              ],
              axisDirection: [
                values.centrifugalAxisDirX,
                values.centrifugalAxisDirY,
                values.centrifugalAxisDirZ,
              ],
              rpmMode: values.centrifugalMode === "fixed" ? "fixed" : "fan-run",
              ...(values.centrifugalMode === "fixed"
                ? { fixedRpm: values.centrifugalFixedRpm }
                : {}),
            },
          }),
      ...(values.thermalChain
        ? {
            thermal: {
              referenceTemperatureK: values.referenceTemperatureK,
            },
          }
        : {}),
    },
    backend: "cpu",
  };
}

/** The structural-scenario form: config object in, typed draft out. */
export function StructuralScenarioForm({
  bodyIds,
  onSubmitScenario,
  submitLabel = "Save structural scenario",
}: {
  /** The demo bodies the material assignments address (the bracket's two). */
  readonly bodyIds: readonly BodyId[];
  readonly onSubmitScenario: (draft: SimScenarioDraft) => void | Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<StructuralScenarioValues>({
    schema: structuralScenarioSchema,
    fields: structuralScenarioFields,
    formOptions: {
      defaultValues: STRUCTURAL_FORM_DEFAULT_VALUES,
      onSubmit: async ({ value }) => {
        await onSubmitScenario(structuralScenarioDraftOf(value, bodyIds));
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return <form.Form aria-label="Structural scenario" className="space-y-2" />;
}
