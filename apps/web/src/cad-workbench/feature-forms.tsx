/**
 * The workbench's feature forms (Phase 38 + Phase 39): Formedible config
 * objects — field list + options — for the sweep and loft create flows and
 * the DATUM create flow, mounted in the composition's feature dialog. The
 * sweep form picks the profile and path sketches from the document's saved
 * pool; the loft form picks an ORDERED section list (≥2, sortable rows)
 * with each section's station z; the datum form builds one of the four
 * datum payloads (plane from origin + frame, axis from two points, point,
 * coordinate system) from numeric fields. Submission routes EXCLUSIVELY
 * through the engine's actions — the same validation seam and transaction
 * vocabulary every create action rides — and a structured refusal surfaces
 * verbatim in the dialog's error region (the parameter panel's
 * apply-failure precedent).
 *
 * The sketch options are domain data rendered verbatim (the sketch record's
 * own name); the forms never guess geometry from names — the engine
 * re-resolves every picked sketch through the executor bridge's resolver
 * seams before anything commits.
 */

import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { DATUM_FORMAT_VERSION } from "@slopcad/cad-core";

import { LOFT_DEFAULT_STATION_STEP_MM, type LoftSectionChoice } from "./loft";

/** One pickable sketch: the document record's id and its name. */
export interface CadFeatureSketchOption {
  readonly id: string;
  readonly name: string;
}

/** The user-facing strings of the feature forms (overridable via props). */
export interface CadFeatureFormLabels {
  readonly sweepTitle: string;
  readonly sweepProfile: string;
  readonly sweepPath: string;
  readonly sweepHint: string;
  readonly loftTitle: string;
  readonly loftSections: string;
  readonly loftSectionSketch: string;
  readonly loftSectionStation: string;
  readonly loftHint: string;
  readonly submit: string;
  readonly pickSketch: string;
}

/** Documented label defaults; every form-authored string lives here. */
export const CAD_FEATURE_FORM_LABELS: CadFeatureFormLabels = {
  sweepTitle: "Sweep a profile along a path",
  sweepProfile: "Profile sketch",
  sweepPath: "Path sketch",
  sweepHint:
    "Draw the path from the sketch origin upward: sketch (x, y) becomes the path's (x, z) in the profile's frame.",
  loftTitle: "Loft ordered sections",
  loftSections: "Sections (in order)",
  loftSectionSketch: "Section sketch",
  loftSectionStation: "Station z (mm)",
  loftHint:
    "Sections loft in row order along the workplane normal; stations must strictly increase.",
  submit: "Create",
  pickSketch: "Pick a sketch",
};

/** Form values of the sweep form (Formedible values carry an index signature). */
export interface SweepFormValues extends Record<string, unknown> {
  readonly profileSketchId: string;
  readonly pathSketchId: string;
}

/** Form values of the loft form (one row per section). */
export interface LoftFormValues extends Record<string, unknown> {
  readonly sections: {
    readonly sketchId: string;
    readonly stationMm: number;
  }[];
}

/** The sketch options as Formedible select entries. */
function sketchOptions(
  sketches: readonly CadFeatureSketchOption[],
): readonly { value: string; label: string }[] {
  return sketches.map((sketch) => ({ label: sketch.name, value: sketch.id }));
}

/** The sweep form: profile select + path select, one submit. */
export function SweepFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onSweep,
  sketches,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onSweep: (profileSketchId: string, pathSketchId: string) => void;
  readonly sketches: readonly CadFeatureSketchOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<SweepFormValues>[] = [
    {
      name: "profileSketchId",
      options: sketchOptions(sketches),
      placeholder: labels.pickSketch,
      required: true,
      type: "select",
      label: labels.sweepProfile,
    },
    {
      name: "pathSketchId",
      options: sketchOptions(sketches),
      placeholder: labels.pickSketch,
      required: true,
      type: "select",
      label: labels.sweepPath,
    },
  ];
  const form = useFormedible<SweepFormValues>({
    fields,
    formOptions: {
      defaultValues: { pathSketchId: "", profileSketchId: "" },
      onSubmit: ({ value }) => {
        onSweep(value.profileSketchId, value.pathSketchId);
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.sweepTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** The loft form: an ordered, sortable section array with stations. */
export function LoftFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onLoft,
  sketches,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onLoft: (sections: readonly LoftSectionChoice[]) => void;
  readonly sketches: readonly CadFeatureSketchOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<LoftFormValues>[] = [
    {
      arrayConfig: {
        addButtonLabel: "Add section",
        defaultValue: {
          sketchId: sketches[0]?.id ?? "",
          stationMm: LOFT_DEFAULT_STATION_STEP_MM,
        },
        itemLabel: "Section",
        minItems: 2,
        objectConfig: {
          columns: 2,
          fields: [
            {
              name: "sketchId",
              options: sketchOptions(sketches),
              placeholder: labels.pickSketch,
              required: true,
              type: "select",
              label: labels.loftSectionSketch,
            },
            {
              name: "stationMm",
              required: true,
              type: "number",
              label: labels.loftSectionStation,
              inputClassName: "font-mono",
              validation: (value) =>
                typeof value === "number" && Number.isFinite(value)
                  ? null
                  : "Enter a station in millimetres.",
            },
          ],
          layout: "grid",
        },
        sortable: true,
      },
      name: "sections",
      type: "array",
      label: labels.loftSections,
    },
  ];
  const first = sketches[0]?.id ?? "";
  const second = sketches[1]?.id ?? "";
  const form = useFormedible<LoftFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        sections: [
          { sketchId: first, stationMm: 0 },
          {
            sketchId: second,
            stationMm: LOFT_DEFAULT_STATION_STEP_MM,
          },
        ],
      },
      onSubmit: ({ value }) => {
        onLoft(
          value.sections.map((section) => ({
            sketchId: section.sketchId,
            stationMm: section.stationMm,
          })),
        );
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form aria-label={labels.loftTitle} className="space-y-3" noValidate />
  );
}

/** The datum payload kinds the creation form builds. */
export type DatumFormKind = "plane" | "axis" | "point" | "cSys";

/** Form values of the datum form (all numeric fields in millimetres). */
export interface DatumFormValues extends Record<string, unknown> {
  readonly datumKind: DatumFormKind;
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
  readonly xAxisX: number;
  readonly xAxisY: number;
  readonly xAxisZ: number;
  readonly secondX: number;
  readonly secondY: number;
  readonly secondZ: number;
}

/** Labels of the datum form (overridable via props). */
export interface DatumFormLabels {
  readonly title: string;
  readonly hint: string;
  readonly kind: string;
  readonly kindPlane: string;
  readonly kindAxis: string;
  readonly kindPoint: string;
  readonly kindCSys: string;
  readonly submit: string;
  readonly coordinate: (name: string) => string;
}

/** Documented label defaults; every form-authored string lives here. */
export const DATUM_FORM_LABELS: DatumFormLabels = {
  title: "Create datum geometry",
  hint: "Named reference geometry the document keeps: planes, axes, points, and coordinate systems features and sketches can address.",
  kind: "Datum kind",
  kindPlane: "Datum plane (origin + frame)",
  kindAxis: "Datum axis (two points)",
  kindPoint: "Datum point",
  kindCSys: "Coordinate system",
  submit: "Create datum",
  coordinate: (name) => name,
};

function datumCoordinateField(
  name: keyof DatumFormValues & string,
  label: string,
): FormedibleFieldConfig<DatumFormValues> {
  return {
    name,
    required: true,
    type: "number",
    label,
    inputClassName: "font-mono",
    validation: (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? null
        : "Enter a finite number.",
  };
}

/**
 * The datum creation form: a kind select plus the numeric frame fields.
 * Submission builds the canonical datum payload for the chosen kind and
 * hands it to the engine's creation action, which re-validates through the
 * datum module's parser before anything commits.
 */
export function DatumFeatureForm({
  labels: labelOverrides = DATUM_FORM_LABELS,
  onCreateDatum,
}: {
  readonly labels?: DatumFormLabels;
  readonly onCreateDatum: (payload: Record<string, unknown>) => void;
}): ReactElement {
  const labels = { ...DATUM_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<DatumFormValues>[] = [
    {
      name: "datumKind",
      options: [
        { value: "plane", label: labels.kindPlane },
        { value: "axis", label: labels.kindAxis },
        { value: "point", label: labels.kindPoint },
        { value: "cSys", label: labels.kindCSys },
      ],
      placeholder: labels.kind,
      required: true,
      type: "select",
      label: labels.kind,
    },
    datumCoordinateField("originX", labels.coordinate("Origin x (mm)")),
    datumCoordinateField("originY", labels.coordinate("Origin y (mm)")),
    datumCoordinateField("originZ", labels.coordinate("Origin z (mm)")),
    datumCoordinateField("normalX", labels.coordinate("Normal x")),
    datumCoordinateField("normalY", labels.coordinate("Normal y")),
    datumCoordinateField("normalZ", labels.coordinate("Normal z")),
    datumCoordinateField("xAxisX", labels.coordinate("In-plane x x")),
    datumCoordinateField("xAxisY", labels.coordinate("In-plane x y")),
    datumCoordinateField("xAxisZ", labels.coordinate("In-plane x z")),
    datumCoordinateField("secondX", labels.coordinate("Second point x (mm)")),
    datumCoordinateField("secondY", labels.coordinate("Second point y (mm)")),
    datumCoordinateField("secondZ", labels.coordinate("Second point z (mm)")),
  ];
  const form = useFormedible<DatumFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        datumKind: "plane",
        originX: 0,
        originY: 0,
        originZ: 10,
        normalX: 0,
        normalY: 0,
        normalZ: 1,
        xAxisX: 1,
        xAxisY: 0,
        xAxisZ: 0,
        secondX: 0,
        secondY: 0,
        secondZ: 20,
      },
      onSubmit: ({ value }) => {
        const origin = [value.originX, value.originY, value.originZ] as const;
        const normal = [value.normalX, value.normalY, value.normalZ] as const;
        const xAxis = [value.xAxisX, value.xAxisY, value.xAxisZ] as const;
        const second = [value.secondX, value.secondY, value.secondZ] as const;
        const payload =
          value.datumKind === "plane"
            ? {
                formatVersion: DATUM_FORMAT_VERSION,
                datumType: "plane",
                definition: "originFrame",
                origin,
                normal,
                xAxis,
              }
            : value.datumKind === "axis"
              ? {
                  formatVersion: DATUM_FORMAT_VERSION,
                  datumType: "axis",
                  definition: "twoPoints",
                  first: origin,
                  second,
                }
              : value.datumKind === "point"
                ? {
                    formatVersion: DATUM_FORMAT_VERSION,
                    datumType: "point",
                    position: origin,
                  }
                : {
                    formatVersion: DATUM_FORMAT_VERSION,
                    datumType: "cSys",
                    origin,
                    xAxis,
                    normal,
                  };
        onCreateDatum(payload);
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form aria-label={labels.title} className="space-y-3" noValidate />
  );
}
