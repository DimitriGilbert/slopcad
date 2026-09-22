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
import { useRef, type ReactElement } from "react";
import { DATUM_FORMAT_VERSION } from "@slopcad/cad-core";
import {
  HOLE_TYPE_VALUES,
  ISO_METRIC_THREAD_TABLE,
  isoMetricThreadByDesignation,
  structuredHoleRoles,
  structuredHoleTypeOf,
} from "@slopcad/cad-kernel";

import { LOFT_DEFAULT_STATION_STEP_MM, type LoftSectionChoice } from "./loft";
import { HELIX_DEFAULTS } from "./helix";
import {
  THREAD_DEFAULTS,
  THREAD_MODE_VALUES,
  type ThreadCutInput,
} from "./thread";
import { RIB_DEFAULTS, type RibCutInput } from "./rib";
import {
  SCALE_DEFAULTS,
  THICKEN_DEFAULTS,
  type ScaleInput,
  type SplitInput,
  type ThickenInput,
} from "./scale-thicken";
import {
  STRUCTURED_HOLE_DEFAULTS,
  type StructuredHoleSubmission,
} from "./hole-dialog";
import {
  PATTERN_DEFAULTS,
  PATTERN_PATH_DEFAULTS,
  type MirrorInput,
  type PatternFeatureInput,
  type PatternPathInput,
} from "./pattern";

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
  readonly helixTitle: string;
  readonly helixProfile: string;
  readonly helixRadius: string;
  readonly helixPitch: string;
  readonly helixTurns: string;
  readonly helixHandedness: string;
  readonly helixStartAngle: string;
  readonly helixTaper: string;
  readonly helixDatumAxis: string;
  readonly helixWorldAxis: string;
  readonly helixHint: string;
  readonly threadTitle: string;
  readonly threadDesignation: string;
  readonly threadMajor: string;
  readonly threadPitch: string;
  readonly threadLength: string;
  readonly threadMode: string;
  readonly threadHandedness: string;
  readonly threadAxis: string;
  readonly threadHint: string;
  readonly ribTitle: string;
  readonly ribProfile: string;
  readonly ribThickness: string;
  readonly ribHint: string;
  readonly draftTitle: string;
  readonly draftProfile: string;
  readonly draftDistance: string;
  readonly draftTaper: string;
  readonly draftHint: string;
  readonly scaleTitle: string;
  readonly scaleFactor: string;
  readonly scaleHint: string;
  readonly thickenTitle: string;
  readonly thickenThickness: string;
  readonly thickenHint: string;
  readonly splitTitle: string;
  readonly splitPlane: string;
  readonly splitSide: string;
  readonly splitSideNormal: string;
  readonly splitSideOpposite: string;
  readonly splitHint: string;
  readonly holeTitle: string;
  readonly holeType: string;
  readonly holeTypeStraight: string;
  readonly holeTypeCounterbore: string;
  readonly holeTypeCountersink: string;
  readonly holeTypeTaper: string;
  readonly holeTypeThreaded: string;
  readonly holeDesignation: string;
  readonly holeDiameter: string;
  readonly holeDepth: string;
  readonly holeTipAngle: string;
  readonly holeCboreDiameter: string;
  readonly holeCboreDepth: string;
  readonly holeCsinkDiameter: string;
  readonly holeCsinkAngle: string;
  readonly holeTaperAngle: string;
  readonly holeThreadMajor: string;
  readonly holeThreadPitch: string;
  readonly holePositionsSketch: string;
  readonly holePositionsParameter: string;
  readonly holePositionX: string;
  readonly holePositionY: string;
  readonly holeDatumAxis: string;
  readonly holeWorldAxis: string;
  readonly holeAxis: string;
  readonly holeHint: string;
  readonly patternTitle: string;
  readonly patternLegs: string;
  readonly patternLegDirection: string;
  readonly patternLegCount: string;
  readonly patternLegSpacing: string;
  readonly patternSkips: string;
  readonly patternSkipOrdinal: string;
  readonly patternHint: string;
  readonly patternPathTitle: string;
  readonly patternPathSketch: string;
  readonly patternPathCount: string;
  readonly patternPathSpacing: string;
  readonly patternPathOrientation: string;
  readonly patternPathOrientationFixed: string;
  readonly patternPathOrientationTangent: string;
  readonly patternPathHint: string;
  readonly mirrorTitle: string;
  readonly mirrorPlane: string;
  readonly mirrorMerge: string;
  readonly mirrorMergeStandalone: string;
  readonly mirrorMergeMerged: string;
  readonly mirrorHint: string;
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
  helixTitle: "Sweep a profile along a helix",
  helixProfile: "Profile sketch (drawn in the meridian)",
  helixRadius: "Radius (mm)",
  helixPitch: "Pitch (mm per turn)",
  helixTurns: "Turns",
  helixHandedness: "Handedness",
  helixStartAngle: "Start angle (deg)",
  helixTaper: "Taper (mm over the spine)",
  helixDatumAxis: "Axis datum (optional)",
  helixWorldAxis: "World Z axis",
  helixHint:
    "The sketch's (x, y) become the helix's (radial, axial) offsets from the spine's start; the spine runs on the world Z axis or the picked datum axis.",
  threadTitle: "Thread an ISO metric specification",
  threadDesignation: "ISO designation",
  threadMajor: "Major diameter (mm)",
  threadPitch: "Pitch (mm)",
  threadLength: "Thread length (mm)",
  threadMode: "Mode",
  threadHandedness: "Handedness",
  threadAxis: "Axis",
  threadHint:
    "The thread cuts the last extrusion (model the nominal major diameter, then thread it); cosmetic threads annotate without geometry.",
  ribTitle: "Add a rib to the latest extrusion",
  ribProfile: "Rib cross-section sketch",
  ribThickness: "Thickness (mm)",
  ribHint:
    "The closed profile extrudes symmetrically by the thickness about its own sketch plane and merges with the part; draw it reaching outside the solid it strengthens.",
  draftTitle: "Extrude a saved sketch with a draft taper",
  draftProfile: "Profile sketch",
  draftDistance: "Distance (mm)",
  draftTaper: "Draft taper (deg)",
  draftHint:
    "Positive tapers narrow the walls away from the sketch plane (the foundry draft); negative tapers widen them. The walls lean by the angle, so cross-sections inset as they travel.",
  scaleTitle: "Scale the latest extrusion uniformly",
  scaleFactor: "Factor",
  scaleHint:
    "One uniform factor about the world origin: volume scales by its cube, bounds by itself. Non-uniform scaling is out of contract scope.",
  thickenTitle: "Hollow the latest extrusion into a closed shell",
  thickenThickness: "Wall thickness (mm)",
  thickenHint:
    "The closed hollow — uniform walls around a sealed interior void, the shell feature's complement.",
  splitTitle: "Split the latest extrusion by a datum plane",
  splitPlane: "Cutting datum plane",
  splitSide: "Kept side",
  splitSideNormal: "The plane normal's side",
  splitSideOpposite: "The opposite side",
  splitHint:
    "The boolean cut keeps one side of the picked datum plane; create the plane first (the Datum button), then split.",
  holeTitle: "Cut a structured hole",
  holeType: "Hole type",
  holeTypeStraight: "Straight (drill)",
  holeTypeCounterbore: "Counterbore",
  holeTypeCountersink: "Countersink",
  holeTypeTaper: "Taper",
  holeTypeThreaded: "Threaded (ISO tap)",
  holeDesignation: "ISO designation",
  holeDiameter: "Diameter (mm)",
  holeDepth: "Depth to the drill tip (mm)",
  holeTipAngle: "Drill tip angle (deg, included; 180 = flat)",
  holeCboreDiameter: "Counterbore Ø (mm)",
  holeCboreDepth: "Counterbore depth (mm)",
  holeCsinkDiameter: "Countersink rim Ø (mm)",
  holeCsinkAngle: "Countersink angle (deg, included)",
  holeTaperAngle: "Taper angle (deg, included)",
  holeThreadMajor: "Thread major diameter (mm)",
  holeThreadPitch: "Thread pitch (mm)",
  holePositionsSketch: "Positions sketch (point entities)",
  holePositionsParameter: "Parameter position (one hole)",
  holePositionX: "Position x (mm, in-plane)",
  holePositionY: "Position y (mm, in-plane)",
  holeDatumAxis: "Axis datum (optional)",
  holeWorldAxis: "World axis",
  holeAxis: "Axis",
  holeHint:
    "One feature, one type, many positions: the depth runs to the drill tip; blind or through is the depth-versus-extent rule; threaded holes tap the ISO basic minor and cut the ISO ridge (helix-capable kernels only).",
  patternTitle: "Pattern the latest extrusion",
  patternLegs: "Array legs (one per direction)",
  patternLegDirection: "Direction (deg)",
  patternLegCount: "Count",
  patternLegSpacing: "Spacing (mm)",
  patternSkips: "Skipped instances",
  patternSkipOrdinal: "Instance ordinal",
  patternHint:
    "Each leg repeats the extrusion along its own direction at its own spacing — asymmetric grids carry one leg per direction. Skips drop whole instances by ordinal (0 is the untranslated original); edit them later in the parameters panel.",
  patternPathTitle: "Repeat the latest extrusion along a sketch path",
  patternPathSketch: "Path sketch",
  patternPathCount: "Instances",
  patternPathSpacing: "Spacing along the path (mm)",
  patternPathOrientation: "Orientation",
  patternPathOrientationFixed: "Fixed (translate only)",
  patternPathOrientationTangent: "Tangent-follow (rotate with the path)",
  patternPathHint:
    "The path sketch draws in the world XZ plane — sketch (x, y) becomes world (x, z), drawn upward from the origin. Instances stand every spacing of arc length; tangent-follow needs a rotating kernel (the OCCT route).",
  mirrorTitle: "Mirror the latest extrusion about a datum plane",
  mirrorPlane: "Mirror datum plane",
  mirrorMerge: "Merge option",
  mirrorMergeStandalone: "Standalone copy",
  mirrorMergeMerged: "Merge with the original",
  mirrorHint:
    "The reflection about the picked datum plane; merging unions it with the original — the symmetric-part route. Create the plane first (the Datum button).",
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

/** Form values of the helix form. */
export interface HelixFormValues extends Record<string, unknown> {
  readonly profileSketchId: string;
  readonly radiusMm: number;
  readonly pitchMm: number;
  readonly turns: number;
  readonly handedness: string;
  readonly startAngleDeg: number;
  readonly taperMm: number;
  readonly datumAxisId: string;
}

/** One pickable datum axis: the document record's id and its name. */
export interface CadFeatureDatumOption {
  readonly id: string;
  readonly name: string;
}

/**
 * The helix form: the meridian profile sketch, the six spine numbers, and
 * the optional datum axis. Submission routes through the engine's helix
 * action — the same validation seam every create action rides — and a
 * structured refusal surfaces verbatim in the dialog's error region.
 */
export function HelixFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onHelix,
  sketches,
  datumAxes,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onHelix: (
    sketchId: string,
    authoring: {
      readonly radiusMm: number;
      readonly pitchMm: number;
      readonly turns: number;
      readonly handedness: 1 | -1;
      readonly startAngleRad: number;
      readonly taperMm: number;
    },
    datumAxisId: string | null,
  ) => void;
  readonly sketches: readonly CadFeatureSketchOption[];
  readonly datumAxes: readonly CadFeatureDatumOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const numberField = (
    name: keyof HelixFormValues & string,
    label: string,
  ): FormedibleFieldConfig<HelixFormValues> => ({
    name,
    required: true,
    type: "number",
    label,
    inputClassName: "font-mono",
    validation: (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? null
        : "Enter a finite number.",
  });
  const fields: readonly FormedibleFieldConfig<HelixFormValues>[] = [
    {
      name: "profileSketchId",
      options: sketchOptions(sketches),
      placeholder: labels.pickSketch,
      required: true,
      type: "select",
      label: labels.helixProfile,
    },
    numberField("radiusMm", labels.helixRadius),
    numberField("pitchMm", labels.helixPitch),
    numberField("turns", labels.helixTurns),
    {
      name: "handedness",
      options: [
        { value: "right", label: "Right-handed" },
        { value: "left", label: "Left-handed" },
      ],
      required: true,
      type: "select",
      label: labels.helixHandedness,
    },
    numberField("startAngleDeg", labels.helixStartAngle),
    numberField("taperMm", labels.helixTaper),
    {
      name: "datumAxisId",
      options: [
        { value: "", label: labels.helixWorldAxis },
        ...datumAxes.map((datum) => ({
          value: datum.id,
          label: datum.name,
        })),
      ],
      // Not required: the empty value IS a choice (the world Z axis) —
      // a `required` flag would refuse the default and block submission.
      type: "select",
      label: labels.helixDatumAxis,
    },
  ];
  const form = useFormedible<HelixFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        profileSketchId: sketches[0]?.id ?? "",
        radiusMm: HELIX_DEFAULTS.radiusMm,
        pitchMm: HELIX_DEFAULTS.pitchMm,
        turns: HELIX_DEFAULTS.turns,
        handedness: "right",
        startAngleDeg: (HELIX_DEFAULTS.startAngleRad * 180) / Math.PI,
        taperMm: HELIX_DEFAULTS.taperMm,
        datumAxisId: "",
      },
      onSubmit: ({ value }) => {
        onHelix(
          value.profileSketchId,
          {
            radiusMm: value.radiusMm,
            pitchMm: value.pitchMm,
            turns: value.turns,
            handedness: value.handedness === "left" ? -1 : 1,
            startAngleRad: (value.startAngleDeg * Math.PI) / 180,
            taperMm: value.taperMm,
          },
          value.datumAxisId === "" ? null : value.datumAxisId,
        );
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.helixTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the thread form. */
export interface ThreadFormValues extends Record<string, unknown> {
  readonly designation: string;
  readonly majorDiameterMm: number;
  readonly pitchMm: number;
  readonly lengthMm: number;
  readonly mode: string;
  readonly handedness: string;
  readonly axis: string;
}

/**
 * The thread form: the ISO designation picker (the table fills the major
 * diameter and pitch; the numbers stay editable — the designation is a
 * picker, never persisted state), the thread length, mode, handedness,
 * and the world axis. The picker's fill rides the form's own change hook:
 * a designation CHANGE copies the table row's two numbers into the
 * fields through the form API (`form.setFieldValue`), and nothing else —
 * a hand edit after a pick is just another field change the hook
 * ignores, so it persists until the next pick. Submission routes
 * through the engine's thread action; a structured refusal surfaces
 * verbatim in the dialog's error region.
 */
export function ThreadFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onThread,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onThread: (specification: ThreadCutInput) => void;
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<ThreadFormValues>[] = [
    {
      name: "designation",
      options: ISO_METRIC_THREAD_TABLE.map((size) => ({
        value: size.designation,
        label: `${size.designation} — pitch ${String(size.pitchMm)} mm, tap drill ${String(size.tapDrillMm)} mm`,
      })),
      required: true,
      type: "select",
      label: labels.threadDesignation,
    },
    {
      name: "majorDiameterMm",
      required: true,
      type: "number",
      label: labels.threadMajor,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value)
          ? null
          : "Enter a finite number.",
    },
    {
      name: "pitchMm",
      required: true,
      type: "number",
      label: labels.threadPitch,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value)
          ? null
          : "Enter a finite number.",
    },
    {
      name: "lengthMm",
      required: true,
      type: "number",
      label: labels.threadLength,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value)
          ? null
          : "Enter a finite number.",
    },
    {
      name: "mode",
      options: [
        { value: "external", label: "External (cuts the rod's grooves)" },
        { value: "internal", label: "Internal (cuts a hole's threads)" },
        { value: "cosmetic", label: "Cosmetic (annotation, no geometry)" },
      ],
      required: true,
      type: "select",
      label: labels.threadMode,
    },
    {
      name: "handedness",
      options: [
        { value: "right", label: "Right-handed" },
        { value: "left", label: "Left-handed" },
      ],
      required: true,
      type: "select",
      label: labels.threadHandedness,
    },
    {
      name: "axis",
      options: [
        { value: "x", label: "World X" },
        { value: "y", label: "World Y" },
        { value: "z", label: "World Z" },
      ],
      required: true,
      type: "select",
      label: labels.threadAxis,
    },
  ];
  const modeValue = (mode: string): number =>
    mode === "internal"
      ? THREAD_MODE_VALUES.internal
      : mode === "cosmetic"
        ? THREAD_MODE_VALUES.cosmetic
        : THREAD_MODE_VALUES.external;
  const axisValue = (axis: string): number =>
    axis === "x" ? 1 : axis === "y" ? 2 : 3;
  // The last designation the fill hook saw (seeded with the form's own
  // default): the discriminator that keeps the fill tied to DESIGNATION
  // changes instead of firing on every number-field keystroke.
  const designationRef = useRef("M6");
  const form = useFormedible<ThreadFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        designation: "M6",
        majorDiameterMm: THREAD_DEFAULTS.majorDiameterMm,
        pitchMm: THREAD_DEFAULTS.pitchMm,
        lengthMm: THREAD_DEFAULTS.lengthMm,
        mode: "external",
        handedness: "right",
        axis: "z",
      },
      onChange: ({ value }) => {
        // The designation picker's linked-field fill: only a CHANGE of
        // the designation itself copies the table row's major diameter
        // and pitch into the number fields — hand edits to those numbers
        // leave the designation untouched, so they persist until the
        // next pick. `form.form` is the hook's own TanStack instance
        // (stable per mount); the closure reads it after the hook
        // returned.
        if (value.designation === designationRef.current) return;
        designationRef.current = value.designation;
        const size = isoMetricThreadByDesignation(value.designation);
        if (size === undefined) return;
        form.form.setFieldValue("majorDiameterMm", size.majorDiameterMm);
        form.form.setFieldValue("pitchMm", size.pitchMm);
      },
      onSubmit: ({ value }) => {
        onThread({
          majorDiameterMm: value.majorDiameterMm,
          pitchMm: value.pitchMm,
          lengthMm: value.lengthMm,
          mode: modeValue(value.mode),
          handedness: value.handedness === "left" ? -1 : 1,
          axis: axisValue(value.axis),
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.threadTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the rib form. */
export interface RibFormValues extends Record<string, unknown> {
  readonly profileSketchId: string;
  readonly thicknessMm: number;
}

/**
 * The rib form: the cross-section sketch picker plus the thickness.
 * Submission routes through the engine's rib action; a structured refusal
 * surfaces verbatim in the dialog's error region.
 */
export function RibFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onRib,
  sketches,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onRib: (specification: RibCutInput & { sketchId: string }) => void;
  readonly sketches: readonly CadFeatureSketchOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<RibFormValues>[] = [
    {
      name: "profileSketchId",
      options: sketchOptions(sketches),
      placeholder: labels.pickSketch,
      required: true,
      type: "select",
      label: labels.ribProfile,
    },
    {
      name: "thicknessMm",
      required: true,
      type: "number",
      label: labels.ribThickness,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value)
          ? null
          : "Enter a thickness in millimetres.",
    },
  ];
  const form = useFormedible<RibFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        profileSketchId: sketches[0]?.id ?? "",
        thicknessMm: RIB_DEFAULTS.thicknessMm,
      },
      onSubmit: ({ value }) => {
        onRib({
          sketchId: value.profileSketchId,
          thicknessMm: value.thicknessMm,
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form aria-label={labels.ribTitle} className="space-y-3" noValidate />
  );
}

/** Form values of the scale form. */
export interface ScaleFormValues extends Record<string, unknown> {
  readonly factor: number;
}

/** The scale form: one uniform factor against the latest extrusion. */
export function ScaleFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onScale,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onScale: (specification: ScaleInput) => void;
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<ScaleFormValues>[] = [
    {
      name: "factor",
      required: true,
      type: "number",
      label: labels.scaleFactor,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? null
          : "Enter a finite, strictly positive factor.",
    },
  ];
  const form = useFormedible<ScaleFormValues>({
    fields,
    formOptions: {
      defaultValues: { factor: SCALE_DEFAULTS.factor },
      onSubmit: ({ value }) => {
        onScale({ factor: value.factor });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.scaleTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the thicken form. */
export interface ThickenFormValues extends Record<string, unknown> {
  readonly thicknessMm: number;
}

/** The thicken form: one wall thickness against the latest extrusion. */
export function ThickenFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onThicken,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onThicken: (specification: ThickenInput) => void;
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<ThickenFormValues>[] = [
    {
      name: "thicknessMm",
      required: true,
      type: "number",
      label: labels.thickenThickness,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? null
          : "Enter a finite, strictly positive thickness.",
    },
  ];
  const form = useFormedible<ThickenFormValues>({
    fields,
    formOptions: {
      defaultValues: { thicknessMm: THICKEN_DEFAULTS.thicknessMm },
      onSubmit: ({ value }) => {
        onThicken({ thicknessMm: value.thicknessMm });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.thickenTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the split form. */
export interface SplitFormValues extends Record<string, unknown> {
  readonly datumPlaneId: string;
  readonly side: string;
}

/**
 * The split form: the datum-plane picker plus the kept-side selector.
 * Submission routes through the engine's split action; a structured
 * refusal (an unresolvable datum, a plane that misses the solid)
 * surfaces verbatim in the dialog's error region.
 */
export function SplitFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onSplit,
  datumPlanes,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onSplit: (
    specification: SplitInput & { datumPlaneId: string },
  ) => void;
  readonly datumPlanes: readonly CadFeatureDatumOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<SplitFormValues>[] = [
    {
      name: "datumPlaneId",
      options: datumPlanes.map((datum) => ({
        value: datum.id,
        label: datum.name,
      })),
      placeholder: labels.splitPlane,
      required: true,
      type: "select",
      label: labels.splitPlane,
    },
    {
      name: "side",
      options: [
        { value: "normal", label: labels.splitSideNormal },
        { value: "opposite", label: labels.splitSideOpposite },
      ],
      required: true,
      type: "select",
      label: labels.splitSide,
    },
  ];
  const form = useFormedible<SplitFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        datumPlaneId: datumPlanes[0]?.id ?? "",
        side: "normal",
      },
      onSubmit: ({ value }) => {
        onSplit({
          datumPlaneId: value.datumPlaneId,
          side: value.side === "opposite" ? -1 : 1,
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.splitTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the draft-extrude form. */
export interface DraftFormValues extends Record<string, unknown> {
  readonly profileSketchId: string;
  readonly distanceMm: number;
  readonly taperDeg: number;
}
/**
 * The draft-extrude form: the saved profile sketch, the signed distance,
 * and the taper angle — the Phase 41 third input of the extrude feature.
 * Submission routes through the engine's draft action; a structured
 * refusal (an unresolvable profile, a taper past the collapse) surfaces
 * verbatim in the dialog's error region.
 */
export function DraftFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onDraft,
  sketches,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onDraft: (specification: {
    readonly sketchId: string;
    readonly distanceMm: number;
    readonly taperDeg: number;
  }) => void;
  readonly sketches: readonly CadFeatureSketchOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const numberField = (
    name: keyof DraftFormValues & string,
    label: string,
  ): FormedibleFieldConfig<DraftFormValues> => ({
    name,
    required: true,
    type: "number",
    label,
    inputClassName: "font-mono",
    validation: (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? null
        : "Enter a finite number.",
  });
  const fields: readonly FormedibleFieldConfig<DraftFormValues>[] = [
    {
      name: "profileSketchId",
      options: sketchOptions(sketches),
      placeholder: labels.pickSketch,
      required: true,
      type: "select",
      label: labels.draftProfile,
    },
    numberField("distanceMm", labels.draftDistance),
    numberField("taperDeg", labels.draftTaper),
  ];
  const form = useFormedible<DraftFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        profileSketchId: sketches[0]?.id ?? "",
        distanceMm: 10,
        taperDeg: 5,
      },
      onSubmit: ({ value }) => {
        onDraft({
          sketchId: value.profileSketchId,
          distanceMm: value.distanceMm,
          taperDeg: value.taperDeg,
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.draftTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the structured hole dialog (every role, type-directed). */
export interface HoleFormValues extends Record<string, unknown> {
  readonly holeType: string;
  readonly designation: string;
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly tipAngleDeg: number;
  readonly cboreDiameterMm: number;
  readonly cboreDepthMm: number;
  readonly csinkDiameterMm: number;
  readonly csinkAngleDeg: number;
  readonly taperAngleDeg: number;
  readonly threadMajorMm: number;
  readonly threadPitchMm: number;
  readonly positionsSketchId: string;
  readonly positionXMm: number;
  readonly positionYMm: number;
  readonly axis: string;
  readonly datumAxisId: string;
}

/**
 * The structured hole dialog (Phase 42): Formedible, SCHEMA-DRIVEN from the
 * kernel's `structuredHoleRoles` parameter schema — the field list is
 * derived by scanning the schema per type, each role's field showing for
 * exactly the types whose role list carries it (`conditional` on the live
 * type value), so the form and the bridge reader share ONE source of the
 * parameter layout. The ISO designation picker (the standard-table picker,
 * Phase 40's table verbatim) fills the threaded type's major diameter and
 * pitch through the thread form's change-hook discipline; the positions
 * picker chooses the parameter position or a sketch's point entities (one
 * feature, many holes); the axis picker chooses a world axis or a datum
 * axis (the helix form's precedent). Submission routes through the
 * engine's structured hole action; a structured refusal surfaces verbatim
 * in the dialog's error region.
 */
export function HoleFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onHole,
  onValuesChange,
  sketches,
  datumAxes,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onHole: (submission: StructuredHoleSubmission) => void;
  /** Live values for the viewport's preview ghost (every change). */
  readonly onValuesChange?: (values: HoleFormValues) => void;
  readonly sketches: readonly CadFeatureSketchOption[];
  readonly datumAxes: readonly CadFeatureDatumOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const typeValue = (raw: string): number =>
    raw === "counterbore"
      ? HOLE_TYPE_VALUES.counterbore
      : raw === "countersink"
        ? HOLE_TYPE_VALUES.countersink
        : raw === "taper"
          ? HOLE_TYPE_VALUES.taper
          : raw === "threaded"
            ? HOLE_TYPE_VALUES.threaded
            : HOLE_TYPE_VALUES.straight;
  // The schema-driven applicability table: role name → the selector values
  // whose role list carries it (built by scanning `structuredHoleRoles`,
  // never hand-maintained — the parameter schema is the single source).
  const roleApplicability = new Map<string, readonly number[]>();
  for (const name of [
    "diameter",
    "depth",
    "tipAngle",
    "cboreDiameter",
    "cboreDepth",
    "csinkDiameter",
    "csinkAngle",
    "taperAngle",
    "threadMajor",
    "threadPitch",
  ]) {
    const carriers: number[] = [];
    for (const type of [1, 2, 3, 4, 5]) {
      const resolved = structuredHoleTypeOf(type);
      if (resolved === null) continue;
      if (
        structuredHoleRoles(resolved, {}).some((role) => role.name === name)
      ) {
        carriers.push(type);
      }
    }
    roleApplicability.set(name, carriers);
  }
  const roleLabels: Record<string, string> = {
    diameter: labels.holeDiameter,
    depth: labels.holeDepth,
    tipAngle: labels.holeTipAngle,
    cboreDiameter: labels.holeCboreDiameter,
    cboreDepth: labels.holeCboreDepth,
    csinkDiameter: labels.holeCsinkDiameter,
    csinkAngle: labels.holeCsinkAngle,
    taperAngle: labels.holeTaperAngle,
    threadMajor: labels.holeThreadMajor,
    threadPitch: labels.holeThreadPitch,
  };
  const numberFieldFor = (
    role: string,
  ): FormedibleFieldConfig<HoleFormValues> => ({
    name: roleNumberFieldOf(role),
    required: true,
    type: "number",
    label: roleLabels[role] ?? role,
    inputClassName: "font-mono",
    conditional: (values) =>
      (roleApplicability.get(role) ?? []).includes(typeValue(values.holeType)),
    validation: (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? null
        : "Enter a finite number.",
  });
  const fields: readonly FormedibleFieldConfig<HoleFormValues>[] = [
    {
      name: "holeType",
      options: [
        { value: "straight", label: labels.holeTypeStraight },
        { value: "counterbore", label: labels.holeTypeCounterbore },
        { value: "countersink", label: labels.holeTypeCountersink },
        { value: "taper", label: labels.holeTypeTaper },
        { value: "threaded", label: labels.holeTypeThreaded },
      ],
      required: true,
      type: "select",
      label: labels.holeType,
    },
    {
      name: "designation",
      options: ISO_METRIC_THREAD_TABLE.map((size) => ({
        value: size.designation,
        label: `${size.designation} — pitch ${String(size.pitchMm)} mm, tap drill ${String(size.tapDrillMm)} mm`,
      })),
      required: true,
      type: "select",
      label: labels.holeDesignation,
      conditional: (values) =>
        typeValue(values.holeType) === HOLE_TYPE_VALUES.threaded,
    },
    numberFieldFor("diameter"),
    numberFieldFor("depth"),
    numberFieldFor("tipAngle"),
    numberFieldFor("cboreDiameter"),
    numberFieldFor("cboreDepth"),
    numberFieldFor("csinkDiameter"),
    numberFieldFor("csinkAngle"),
    numberFieldFor("taperAngle"),
    numberFieldFor("threadMajor"),
    numberFieldFor("threadPitch"),
    {
      name: "positionsSketchId",
      options: [
        { value: "", label: labels.holePositionsParameter },
        ...sketches.map((sketch) => ({
          value: sketch.id,
          label: sketch.name,
        })),
      ],
      type: "select",
      label: labels.holePositionsSketch,
    },
    {
      name: "positionXMm",
      required: true,
      type: "number",
      label: labels.holePositionX,
      inputClassName: "font-mono",
      conditional: (values) => values.positionsSketchId === "",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value)
          ? null
          : "Enter a finite in-plane coordinate.",
    },
    {
      name: "positionYMm",
      required: true,
      type: "number",
      label: labels.holePositionY,
      inputClassName: "font-mono",
      conditional: (values) => values.positionsSketchId === "",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value)
          ? null
          : "Enter a finite in-plane coordinate.",
    },
    {
      name: "datumAxisId",
      options: [
        { value: "", label: labels.holeWorldAxis },
        ...datumAxes.map((datum) => ({
          value: datum.id,
          label: datum.name,
        })),
      ],
      // Not required: the empty value IS a choice (the world axis).
      type: "select",
      label: labels.holeDatumAxis,
    },
    {
      name: "axis",
      options: [
        { value: "x", label: "World X" },
        { value: "y", label: "World Y" },
        { value: "z", label: "World Z" },
      ],
      required: true,
      type: "select",
      label: labels.holeAxis,
      conditional: (values) => values.datumAxisId === "",
    },
  ];
  // The last designation the fill hook saw (the thread form's discipline):
  // only a DESIGNATION change copies the table row's numbers.
  const designationRef = useRef("M6");
  const form = useFormedible<HoleFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        holeType: "straight",
        designation: "M6",
        diameterMm: STRUCTURED_HOLE_DEFAULTS.spec.diameterMm,
        depthMm: STRUCTURED_HOLE_DEFAULTS.spec.depthMm,
        tipAngleDeg: STRUCTURED_HOLE_DEFAULTS.spec.tipAngleDeg,
        cboreDiameterMm: STRUCTURED_HOLE_DEFAULTS.spec.cboreDiameterMm,
        cboreDepthMm: STRUCTURED_HOLE_DEFAULTS.spec.cboreDepthMm,
        csinkDiameterMm: STRUCTURED_HOLE_DEFAULTS.spec.csinkDiameterMm,
        csinkAngleDeg: STRUCTURED_HOLE_DEFAULTS.spec.csinkAngleDeg,
        taperAngleDeg: STRUCTURED_HOLE_DEFAULTS.spec.taperAngleDeg,
        threadMajorMm: STRUCTURED_HOLE_DEFAULTS.spec.threadMajorMm,
        threadPitchMm: STRUCTURED_HOLE_DEFAULTS.spec.threadPitchMm,
        positionsSketchId: "",
        positionXMm: STRUCTURED_HOLE_DEFAULTS.positionXMm,
        positionYMm: STRUCTURED_HOLE_DEFAULTS.positionYMm,
        axis: "z",
        datumAxisId: "",
      },
      onChange: ({ value }) => {
        onValuesChange?.(value);
        if (value.designation === designationRef.current) return;
        designationRef.current = value.designation;
        const size = isoMetricThreadByDesignation(value.designation);
        if (size === undefined) return;
        form.form.setFieldValue("threadMajorMm", size.majorDiameterMm);
        form.form.setFieldValue("threadPitchMm", size.pitchMm);
      },
      onSubmit: ({ value }) => {
        onHole({
          spec: {
            type: typeValue(value.holeType),
            diameterMm: value.diameterMm,
            depthMm: value.depthMm,
            tipAngleDeg: value.tipAngleDeg,
            cboreDiameterMm: value.cboreDiameterMm,
            cboreDepthMm: value.cboreDepthMm,
            csinkDiameterMm: value.csinkDiameterMm,
            csinkAngleDeg: value.csinkAngleDeg,
            taperAngleDeg: value.taperAngleDeg,
            threadMajorMm: value.threadMajorMm,
            threadPitchMm: value.threadPitchMm,
          },
          positionXMm: value.positionXMm,
          positionYMm: value.positionYMm,
          axis: value.axis === "x" ? 1 : value.axis === "y" ? 2 : 3,
          positionsSketchId:
            value.positionsSketchId === "" ? null : value.positionsSketchId,
          datumAxisId: value.datumAxisId === "" ? null : value.datumAxisId,
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form aria-label={labels.holeTitle} className="space-y-3" noValidate />
  );
}

/** The role's form field name (the spec field names, camelCase + Mm). */
function roleNumberFieldOf(role: string): string {
  switch (role) {
    case "diameter":
      return "diameterMm";
    case "depth":
      return "depthMm";
    case "tipAngle":
      return "tipAngleDeg";
    case "cboreDiameter":
      return "cboreDiameterMm";
    case "cboreDepth":
      return "cboreDepthMm";
    case "csinkDiameter":
      return "csinkDiameterMm";
    case "csinkAngle":
      return "csinkAngleDeg";
    case "taperAngle":
      return "taperAngleDeg";
    case "threadMajor":
      return "threadMajorMm";
    case "threadPitch":
      return "threadPitchMm";
    default:
      return role;
  }
}

/** Form values of the pattern editor (the Phase 43 feature array). */
export interface PatternFormValues extends Record<string, unknown> {
  readonly legs: {
    readonly directionDeg: number;
    readonly count: number;
    readonly spacingMm: number;
  }[];
  readonly skips: { readonly ordinal: number }[];
}

/**
 * The pattern editor form (Phase 43): an ordered, sortable array of LEGS
 * (direction + count + spacing — one row per array direction, asymmetric
 * grids included) plus the SKIP-INSTANCE list. Submission routes through
 * the engine's pattern action; a structured refusal surfaces verbatim in
 * the dialog's error region.
 */
export function PatternFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onPattern,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onPattern: (specification: PatternFeatureInput) => void;
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<PatternFormValues>[] = [
    {
      arrayConfig: {
        addButtonLabel: "Add leg",
        defaultValue: {
          directionDeg: PATTERN_DEFAULTS.legs[0]?.directionDeg ?? 0,
          count: PATTERN_DEFAULTS.legs[0]?.count ?? 3,
          spacingMm: PATTERN_DEFAULTS.legs[0]?.spacingMm ?? 20,
        },
        itemLabel: "Leg",
        minItems: 1,
        objectConfig: {
          columns: 3,
          fields: [
            {
              name: "directionDeg",
              required: true,
              type: "number",
              label: labels.patternLegDirection,
              inputClassName: "font-mono",
              validation: (value) =>
                typeof value === "number" && Number.isFinite(value)
                  ? null
                  : "Enter a finite angle in degrees.",
            },
            {
              name: "count",
              required: true,
              type: "number",
              label: labels.patternLegCount,
              inputClassName: "font-mono",
              validation: (value) =>
                typeof value === "number" &&
                Number.isInteger(value) &&
                value >= 2
                  ? null
                  : "Enter a whole count of at least 2.",
            },
            {
              name: "spacingMm",
              required: true,
              type: "number",
              label: labels.patternLegSpacing,
              inputClassName: "font-mono",
              validation: (value) =>
                typeof value === "number" && Number.isFinite(value) && value > 0
                  ? null
                  : "Enter a strictly positive spacing.",
            },
          ],
          layout: "grid",
        },
        sortable: true,
      },
      name: "legs",
      type: "array",
      label: labels.patternLegs,
    },
    {
      arrayConfig: {
        addButtonLabel: "Skip an instance",
        defaultValue: { ordinal: 1 },
        itemLabel: "Skip",
        minItems: 0,
        objectConfig: {
          columns: 1,
          fields: [
            {
              name: "ordinal",
              required: true,
              type: "number",
              label: labels.patternSkipOrdinal,
              inputClassName: "font-mono",
              validation: (value) =>
                typeof value === "number" &&
                Number.isInteger(value) &&
                value >= 0
                  ? null
                  : "Enter a whole instance ordinal (0 is the untranslated original).",
            },
          ],
          layout: "grid",
        },
        sortable: false,
      },
      name: "skips",
      type: "array",
      label: labels.patternSkips,
    },
  ];
  const form = useFormedible<PatternFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        legs: PATTERN_DEFAULTS.legs.map((leg) => ({ ...leg })),
        skips: [],
      },
      onSubmit: ({ value }) => {
        onPattern({
          legs: value.legs.map((leg) => ({
            directionDeg: leg.directionDeg,
            count: leg.count,
            spacingMm: leg.spacingMm,
          })),
          skips: value.skips.map((skip) => skip.ordinal),
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.patternTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the path-pattern form. */
export interface PatternPathFormValues extends Record<string, unknown> {
  readonly pathSketchId: string;
  readonly count: number;
  readonly spacingMm: number;
  readonly orientation: string;
}

/**
 * The path-pattern form (Phase 43): the saved path sketch picker, the
 * instance count and arc-length spacing, and the orientation option
 * (fixed vs tangent-follow). Submission routes through the engine's
 * pattern-path action; a structured refusal surfaces verbatim.
 */
export function PatternPathFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onPatternPath,
  sketches,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onPatternPath: (
    specification: PatternPathInput & { readonly sketchId: string },
  ) => void;
  readonly sketches: readonly CadFeatureSketchOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<PatternPathFormValues>[] = [
    {
      name: "pathSketchId",
      options: sketchOptions(sketches),
      placeholder: labels.pickSketch,
      required: true,
      type: "select",
      label: labels.patternPathSketch,
    },
    {
      name: "count",
      required: true,
      type: "number",
      label: labels.patternPathCount,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isInteger(value) && value >= 2
          ? null
          : "Enter a whole count of at least 2.",
    },
    {
      name: "spacingMm",
      required: true,
      type: "number",
      label: labels.patternPathSpacing,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? null
          : "Enter a strictly positive spacing.",
    },
    {
      name: "orientation",
      options: [
        { value: "fixed", label: labels.patternPathOrientationFixed },
        { value: "tangent", label: labels.patternPathOrientationTangent },
      ],
      required: true,
      type: "select",
      label: labels.patternPathOrientation,
    },
  ];
  const form = useFormedible<PatternPathFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        pathSketchId: sketches[0]?.id ?? "",
        count: PATTERN_PATH_DEFAULTS.count,
        spacingMm: PATTERN_PATH_DEFAULTS.spacingMm,
        orientation: "fixed",
      },
      onSubmit: ({ value }) => {
        onPatternPath({
          sketchId: value.pathSketchId,
          count: value.count,
          spacingMm: value.spacingMm,
          orientation: value.orientation === "tangent" ? 2 : 1,
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.patternPathTitle}
      className="space-y-3"
      noValidate
    />
  );
}

/** Form values of the mirror form. */
export interface MirrorFormValues extends Record<string, unknown> {
  readonly datumPlaneId: string;
  readonly merge: string;
}

/**
 * The mirror form (Phase 43): the datum-plane picker plus the merge
 * option (a standalone reflection or one union with the original).
 * Submission routes through the engine's mirror action; a structured
 * refusal surfaces verbatim in the dialog's error region.
 */
export function MirrorFeatureForm({
  labels: labelOverrides = CAD_FEATURE_FORM_LABELS,
  onMirror,
  datumPlanes,
}: {
  readonly labels?: CadFeatureFormLabels;
  readonly onMirror: (
    specification: MirrorInput & { readonly datumPlaneId: string },
  ) => void;
  readonly datumPlanes: readonly CadFeatureDatumOption[];
}): ReactElement {
  const labels = { ...CAD_FEATURE_FORM_LABELS, ...labelOverrides };
  const fields: readonly FormedibleFieldConfig<MirrorFormValues>[] = [
    {
      name: "datumPlaneId",
      options: datumPlanes.map((datum) => ({
        value: datum.id,
        label: datum.name,
      })),
      placeholder: labels.mirrorPlane,
      required: true,
      type: "select",
      label: labels.mirrorPlane,
    },
    {
      name: "merge",
      options: [
        { value: "standalone", label: labels.mirrorMergeStandalone },
        { value: "merge", label: labels.mirrorMergeMerged },
      ],
      required: true,
      type: "select",
      label: labels.mirrorMerge,
    },
  ];
  const form = useFormedible<MirrorFormValues>({
    fields,
    formOptions: {
      defaultValues: {
        datumPlaneId: datumPlanes[0]?.id ?? "",
        merge: "standalone",
      },
      onSubmit: ({ value }) => {
        onMirror({
          datumPlaneId: value.datumPlaneId,
          merge: value.merge === "merge" ? 2 : 1,
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.submit,
  });
  return (
    <form.Form
      aria-label={labels.mirrorTitle}
      className="space-y-3"
      noValidate
    />
  );
}
