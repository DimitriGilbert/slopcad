/**
 * The workbench's feature forms (Phase 38): Formedible config objects —
 * field list + options — for the sweep and loft create flows, mounted in
 * the composition's feature dialog. The sweep form picks the profile and
 * path sketches from the document's saved pool; the loft form picks an
 * ORDERED section list (≥2, sortable rows) with each section's station z.
 * Submission routes EXCLUSIVELY through the engine's actions — the same
 * validation seam and transaction vocabulary every create action rides —
 * and a structured refusal surfaces verbatim in the dialog's error region
 * (the parameter panel's apply-failure precedent).
 *
 * The sketch options are domain data rendered verbatim (the sketch record's
 * own name); the forms never guess geometry from names — the engine
 * re-resolves every picked sketch through the executor bridge's resolver
 * seams before anything commits.
 */

import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";

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
