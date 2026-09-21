/**
 * `CadSketchInspector` (Phase 25): the sketch's docked inspector — the
 * solver readout (status chip + degrees of freedom), the constraint list
 * (per-constraint status, selectable), the dimension editor, and the
 * structured diagnostics feed. Pure display and event passthrough: sketch
 * data arrives as a plain view model, edits leave through two callbacks
 * (`onSelectConstraint`, `onEditDimension`), and the write path is entirely
 * the host's.
 *
 * ## The dimension editor is a Formedible form
 *
 * One number field for the selected constraint's dimensional value (the
 * canonical magnitude in the constraint's own unit — mm for
 * distance/radius/diameter, deg for angle), applied through `onEditDimension`.
 * Validation lives entirely in the field config (the finite-number gate with
 * the externalized message); a refusal returned by the apply surface surfaces
 * verbatim in the inspector's error region. Unchanged submits are filtered by
 * the host (the editor issues `sketch.dimension.set` only for a real change).
 * With no dimensional constraint selected the editor renders the documented
 * hint — it never pretends to edit.
 *
 * All user-facing strings live in {@link CAD_SKETCH_INSPECTOR_LABELS}
 * (overridable via the `labels` prop); constraint labels, diagnostic
 * messages, and codes are host data rendered verbatim.
 */

import { useMemo, useState } from "react";
import { cn } from "cn";
import type { FormedibleFieldConfig } from "../formedible/lib/types";

import { useFormedible } from "../formedible/hooks/use-formedible";

/** Merges label overrides over the documented defaults, memoized. */
function useMergedLabels(
  overrides: Partial<CadSketchInspectorLabels> | undefined,
): CadSketchInspectorLabels {
  return useMemo(
    () => ({ ...CAD_SKETCH_INSPECTOR_LABELS, ...overrides }),
    [overrides],
  );
}

/** Status of one constraint in the list. */
export type CadSketchConstraintStatus = "ok" | "warning" | "error";

/** View model of one constraint row. */
export interface CadSketchInspectorConstraint {
  readonly id: string;
  /** The constraint kind (the domain's vocabulary, verbatim). */
  readonly kind: string;
  /** The row's display text (host data, e.g. `distance 60 mm`). */
  readonly label: string;
  /** The ids the constraint references (for machines; not rendered). */
  readonly entityIds: readonly string[];
  readonly status: CadSketchConstraintStatus;
  /** The structured diagnostic message behind a warning/error status. */
  readonly message?: string;
}

/** View model of the selected constraint's editable dimension. */
export interface CadSketchInspectorDimension {
  readonly constraintId: string;
  /** The current canonical magnitude (mm or deg). */
  readonly value: number;
  /** The unit token shown beside the field (`mm` or `deg`). */
  readonly unit: string;
  /** Decimal places to display. */
  readonly decimals: number;
}

/** One structured diagnostic in the feed. */
export interface CadSketchInspectorDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
}

/** The solver readout's status. */
export type CadSketchSolveStatus = "solved" | "under-constrained" | "failed";

/** The user-facing strings of {@link CadSketchInspector}. Overridable. */
export interface CadSketchInspectorLabels {
  readonly title: string;
  readonly solverHeading: string;
  readonly statusLabels: Readonly<Record<CadSketchSolveStatus, string>>;
  readonly dofLabel: string;
  readonly constraintsHeading: string;
  readonly emptyConstraints: string;
  readonly dimensionHeading: string;
  readonly dimensionHint: string;
  readonly dimensionValueInvalid: string;
  readonly apply: string;
  readonly diagnosticsHeading: string;
  readonly emptyDiagnostics: string;
  readonly arrayHeading: string;
  readonly arraySelectionLabel: (count: number) => string;
  readonly arrayNoSelection: string;
  readonly convertHeading: string;
  readonly convertNoTopology: string;
  readonly convertEmpty: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_SKETCH_INSPECTOR_LABELS: CadSketchInspectorLabels = {
  title: "Sketch",
  solverHeading: "Solver",
  statusLabels: {
    solved: "Solved",
    "under-constrained": "Under-constrained",
    failed: "Failed",
  },
  dofLabel: "DoF",
  constraintsHeading: "Constraints",
  emptyConstraints: "No constraints.",
  dimensionHeading: "Dimension",
  dimensionHint:
    "Select a distance, radius, diameter, or angle constraint to edit its value.",
  dimensionValueInvalid: "Enter a number.",
  apply: "Apply",
  diagnosticsHeading: "Diagnostics",
  emptyDiagnostics: "No diagnostics.",
  arrayHeading: "Array",
  arraySelectionLabel: (count: number): string =>
    `${String(count)} selected ${count === 1 ? "entity" : "entities"}`,
  arrayNoSelection:
    "Select entities first: the array applies to the current selection.",
  convertHeading: "Convert",
  convertNoTopology:
    "No topology view: model geometry cannot be converted in this host.",
  convertEmpty: "No topology references to convert.",
};

/** Structured outcome of a dimension apply: the host's refusal, verbatim. */
export type CadSketchDimensionApplyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** The structured outcome every Phase 37 apply surface returns. */
export type CadSketchSketchApplyOutcome = CadSketchDimensionApplyOutcome;

/** Which array pattern the form edits (the active tool decides). */
export type CadSketchArrayTool = "rectArray" | "circArray";

/** The inspector's array-pattern form view model (Phase 37). */
export interface CadSketchInspectorArray {
  readonly tool: CadSketchArrayTool;
  /** How many entities the array will copy (the live selection). */
  readonly selectionCount: number;
}

/** The rectangular array form's submitted values. */
export interface CadSketchRectArrayValues {
  readonly countX: number;
  readonly countY: number;
  readonly spacingX: number;
  readonly spacingY: number;
}

/** The circular array form's submitted values. */
export interface CadSketchCircArrayValues {
  readonly count: number;
  readonly angleStepDeg: number;
  readonly centerX: number;
  readonly centerY: number;
}

/** One convertible (or declined) topology entry in the convert list. */
export interface CadSketchInspectorConvertEntry {
  /** The persistent reference id (the row's identity and callback key). */
  readonly referenceId: string;
  /** The row's display text, host-composed (e.g. `vertex 0 @ (10, 20, 4)`). */
  readonly label: string;
  /** The topology kind (`vertex` converts; edge/face decline honestly). */
  readonly kind: string;
  /** Whether the host can convert this entry (kind + descriptor honesty). */
  readonly convertible: boolean;
  /** Why not, when not convertible (host data, verbatim). */
  readonly declineMessage?: string;
}

/** Props of {@link CadSketchInspector}. */
export interface CadSketchInspectorProps {
  /** The solver readout. */
  readonly solveStatus: CadSketchSolveStatus;
  readonly dof: number;
  /** The constraints to list, in order. */
  readonly constraints: readonly CadSketchInspectorConstraint[];
  /** The selected constraint id, or `null`. */
  readonly selectedConstraintId: string | null;
  readonly onSelectConstraint: (constraintId: string | null) => void;
  /**
   * The selected constraint's editable dimension, or `null` when the
   * selection is not dimensional (the hint renders instead).
   */
  readonly dimension: CadSketchInspectorDimension | null;
  /** The dimension apply surface; receives the canonical magnitude. */
  readonly onEditDimension?: (
    constraintId: string,
    value: number,
  ) => CadSketchDimensionApplyOutcome;
  /** The structured diagnostics feed, most severe first. */
  readonly diagnostics: readonly CadSketchInspectorDiagnostic[];
  /**
   * The array-pattern form (Phase 37): rendered when the active tool is an
   * array tool; the apply surface receives the form's numbers and the host
   * commits the op against the live selection.
   */
  readonly array?: CadSketchInspectorArray | null;
  readonly onApplyArray?: (
    tool: CadSketchArrayTool,
    values: CadSketchRectArrayValues | CadSketchCircArrayValues,
  ) => CadSketchSketchApplyOutcome;
  /**
   * The convert list (Phase 37): the host's topology references to project
   * as construction geometry. `null` renders the documented no-topology
   * hint — the inspector never pretends a convert is available.
   */
  readonly convert?: {
    readonly entries: readonly CadSketchInspectorConvertEntry[];
    /** The hint under the heading (e.g. the projected-out offset note). */
    readonly hint?: string;
  } | null;
  /** The convert apply surface; keyed by the entry's reference id. */
  readonly onConvert?: (referenceId: string) => CadSketchSketchApplyOutcome;
  /** Label token overrides, merged over {@link CAD_SKETCH_INSPECTOR_LABELS}. */
  readonly labels?: Partial<CadSketchInspectorLabels>;
  /** Extends the container classes. */
  readonly className?: string;
}

/** The list status classes: quiet when healthy, loud on problems. */
const STATUS_CLASSES: Readonly<Record<CadSketchConstraintStatus, string>> =
  Object.freeze({
    ok: "text-muted-foreground",
    warning: "text-amber-600 dark:text-amber-400 font-medium",
    error: "text-destructive font-medium",
  });

const SEVERITY_CLASSES: Readonly<
  Record<CadSketchInspectorDiagnostic["severity"], string>
> = Object.freeze({
  info: "text-sky-600 dark:text-sky-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
});

const SOLVE_CLASSES: Readonly<Record<CadSketchSolveStatus, string>> =
  Object.freeze({
    solved: "text-emerald-600 dark:text-emerald-400",
    "under-constrained": "text-amber-600 dark:text-amber-400",
    failed: "text-destructive font-medium",
  });

/** The inspector's form values: one number field keyed by constraint id. */
type DimensionFormValues = Record<string, number | undefined>;

/**
 * The sketch inspector: solver readout, constraint list, dimension editor,
 * diagnostics feed — the sketch's numbers, in one docked palette.
 */
export function CadSketchInspector({
  array = null,
  className,
  constraints,
  convert = null,
  diagnostics,
  dimension,
  dof,
  labels: labelOverrides,
  onApplyArray,
  onConvert,
  onEditDimension,
  onSelectConstraint,
  selectedConstraintId,
  solveStatus,
}: CadSketchInspectorProps) {
  const labels = useMergedLabels(labelOverrides);
  const [applyFailure, setApplyFailure] = useState<string | undefined>(
    undefined,
  );
  const [arrayFailure, setArrayFailure] = useState<string | undefined>(
    undefined,
  );
  const [convertFailure, setConvertFailure] = useState<string | undefined>(
    undefined,
  );

  const formConfig = useMemo(() => {
    const name =
      dimension === null ? "idle" : `value:${dimension.constraintId}`;
    const defaultValue =
      dimension === null
        ? undefined
        : Number(dimension.value.toFixed(dimension.decimals));
    const fields: FormedibleFieldConfig<DimensionFormValues>[] =
      dimension === null
        ? []
        : [
            {
              name,
              type: "number",
              label: `${labels.dimensionHeading} (${dimension.unit})`,
              inputClassName: "font-mono",
              validation: (value) =>
                typeof value === "number" && Number.isFinite(value)
                  ? null
                  : labels.dimensionValueInvalid,
            },
          ];
    return {
      name,
      defaultValue,
      fields,
      onSubmit: ({ value }: { readonly value: DimensionFormValues }) => {
        setApplyFailure(undefined);
        if (dimension === null || onEditDimension === undefined) return;
        const submitted = value[name];
        if (typeof submitted !== "number" || !Number.isFinite(submitted))
          return;
        const outcome = onEditDimension(dimension.constraintId, submitted);
        if (!outcome.ok) {
          setApplyFailure(`${outcome.error.code}: ${outcome.error.message}`);
        }
      },
    };
  }, [dimension, labels, onEditDimension]);

  const dimensionForm = useFormedible<DimensionFormValues>({
    fields: formConfig.fields,
    formOptions: {
      defaultValues: { [formConfig.name]: formConfig.defaultValue },
      onSubmit: formConfig.onSubmit,
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.apply,
    submitButtonClassName: "w-full",
    showSubmitButton:
      dimension !== null &&
      onEditDimension !== undefined &&
      formConfig.fields.length > 0,
  });

  // ----- The Phase 37 array-pattern form ------------------------------------
  // One Formedible form per tool (the fields genuinely differ); each renders
  // only while its tool is active, and applies against the live selection.

  const ARRAY_FIELD_LABELS = {
    countX: "Copies along x",
    countY: "Copies along y",
    spacingX: "Spacing x (mm)",
    spacingY: "Spacing y (mm)",
    count: "Copies",
    angleStepDeg: "Step (deg)",
    centerX: "Center x (mm)",
    centerY: "Center y (mm)",
  } as const;

  type ArrayFormValues = Record<string, number | undefined>;

  const requireInteger = (value: number): boolean =>
    Number.isInteger(value) && value >= 1;
  const requireFinite = (value: number): boolean => Number.isFinite(value);

  const rectArrayFields: FormedibleFieldConfig<ArrayFormValues>[] = [
    {
      name: "countX",
      type: "number",
      label: ARRAY_FIELD_LABELS.countX,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && requireInteger(value)
          ? null
          : "An integer of 1 or more.",
    },
    {
      name: "countY",
      type: "number",
      label: ARRAY_FIELD_LABELS.countY,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && requireInteger(value)
          ? null
          : "An integer of 1 or more.",
    },
    {
      name: "spacingX",
      type: "number",
      label: ARRAY_FIELD_LABELS.spacingX,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && requireFinite(value) && value !== 0
          ? null
          : "A non-zero number (mm).",
    },
    {
      name: "spacingY",
      type: "number",
      label: ARRAY_FIELD_LABELS.spacingY,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && requireFinite(value) && value !== 0
          ? null
          : "A non-zero number (mm).",
    },
  ];

  const circArrayFields: FormedibleFieldConfig<ArrayFormValues>[] = [
    {
      name: "count",
      type: "number",
      label: ARRAY_FIELD_LABELS.count,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && Number.isInteger(value) && value >= 2
          ? null
          : "An integer of 2 or more.",
    },
    {
      name: "angleStepDeg",
      type: "number",
      label: ARRAY_FIELD_LABELS.angleStepDeg,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && requireFinite(value) && value !== 0
          ? null
          : "A non-zero number of degrees.",
    },
    {
      name: "centerX",
      type: "number",
      label: ARRAY_FIELD_LABELS.centerX,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && requireFinite(value)
          ? null
          : "A number (mm).",
    },
    {
      name: "centerY",
      type: "number",
      label: ARRAY_FIELD_LABELS.centerY,
      inputClassName: "font-mono",
      validation: (value) =>
        typeof value === "number" && requireFinite(value)
          ? null
          : "A number (mm).",
    },
  ];

  const applyArray = (values: ArrayFormValues): void => {
    setArrayFailure(undefined);
    if (array === null || array === undefined || onApplyArray === undefined) {
      return;
    }
    const numberAt = (name: string): number | null => {
      const value = values[name];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    if (array.tool === "rectArray") {
      const countX = numberAt("countX");
      const countY = numberAt("countY");
      const spacingX = numberAt("spacingX");
      const spacingY = numberAt("spacingY");
      if (
        countX === null ||
        countY === null ||
        spacingX === null ||
        spacingY === null
      ) {
        return;
      }
      const outcome = onApplyArray(array.tool, {
        countX,
        countY,
        spacingX,
        spacingY,
      });
      if (!outcome.ok) {
        setArrayFailure(`${outcome.error.code}: ${outcome.error.message}`);
      }
      return;
    }
    const count = numberAt("count");
    const angleStepDeg = numberAt("angleStepDeg");
    const centerX = numberAt("centerX");
    const centerY = numberAt("centerY");
    if (
      count === null ||
      angleStepDeg === null ||
      centerX === null ||
      centerY === null
    ) {
      return;
    }
    const outcome = onApplyArray(array.tool, {
      angleStepDeg,
      centerX,
      centerY,
      count,
    });
    if (!outcome.ok) {
      setArrayFailure(`${outcome.error.code}: ${outcome.error.message}`);
    }
  };

  const rectArrayForm = useFormedible<ArrayFormValues>({
    fields: rectArrayFields,
    formOptions: {
      defaultValues: { countX: 3, countY: 2, spacingX: 20, spacingY: 20 },
      onSubmit: ({ value }: { readonly value: ArrayFormValues }) => {
        applyArray(value);
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.apply,
    submitButtonClassName: "w-full",
    showSubmitButton: array?.tool === "rectArray",
  });

  const circArrayForm = useFormedible<ArrayFormValues>({
    fields: circArrayFields,
    formOptions: {
      defaultValues: { count: 6, angleStepDeg: 60, centerX: 0, centerY: 0 },
      onSubmit: ({ value }: { readonly value: ArrayFormValues }) => {
        applyArray(value);
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: labels.apply,
    submitButtonClassName: "w-full",
    showSubmitButton: array?.tool === "circArray",
  });

  return (
    <div
      className={cn(
        "border-border bg-background w-60 border text-sm",
        className,
      )}
      data-slot="cad-sketch-inspector"
      data-sketch-inspector-selected-constraint={selectedConstraintId ?? ""}
      data-sketch-inspector-solve-status={solveStatus}
      data-sketch-inspector-dof={String(dof)}
    >
      <div className="text-muted-foreground border-border border-b px-2 py-1.5 text-xs font-medium tracking-wider uppercase">
        {labels.title}
      </div>
      <section
        aria-label={labels.solverHeading}
        className="border-border flex items-center gap-2 border-b px-2 py-1.5"
      >
        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {labels.solverHeading}
        </span>
        <span
          className={`${SOLVE_CLASSES[solveStatus]} whitespace-nowrap font-mono text-xs`}
          data-testid="sketch-solve-status"
        >
          {labels.statusLabels[solveStatus]}
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-xs">
          {labels.dofLabel} {String(dof)}
        </span>
      </section>
      <section aria-label={labels.constraintsHeading} className="border-b">
        <div className="text-muted-foreground px-2 pt-1.5 text-[10px] font-medium tracking-wider uppercase">
          {labels.constraintsHeading}
        </div>
        {constraints.length === 0 ? (
          <div className="text-muted-foreground px-2 py-2">
            {labels.emptyConstraints}
          </div>
        ) : (
          <ul className="px-1 py-1">
            {constraints.map((constraint) => {
              const selected = constraint.id === selectedConstraintId;
              return (
                <li key={constraint.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-1 py-0.5 text-left text-xs outline-none hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring/50",
                      selected && "bg-muted",
                    )}
                    data-sketch-constraint-id={constraint.id}
                    data-sketch-constraint-status={constraint.status}
                    title={constraint.message ?? constraint.label}
                    onClick={() => {
                      onSelectConstraint(selected ? null : constraint.id);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        constraint.status === "error" && "bg-destructive",
                        constraint.status === "warning" && "bg-amber-500",
                        constraint.status === "ok" && "bg-muted-foreground/40",
                      )}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono",
                        STATUS_CLASSES[constraint.status],
                      )}
                    >
                      {constraint.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section
        aria-label={labels.dimensionHeading}
        className="border-border border-b px-2 py-2"
      >
        {dimension === null ? (
          <p className="text-muted-foreground text-xs leading-4">
            {labels.dimensionHint}
          </p>
        ) : (
          <>
            <dimensionForm.Form className="space-y-2" />
            {applyFailure !== undefined ? (
              <div
                className="text-destructive pt-1 text-xs leading-4"
                data-testid="sketch-dimension-error"
                role="alert"
              >
                {applyFailure}
              </div>
            ) : null}
          </>
        )}
      </section>
      {/* The Phase 37 array-pattern form: rendered while an array tool is
          active; applies against the live selection. */}
      {array !== null ? (
        <section
          aria-label={labels.arrayHeading}
          className="border-border border-b px-2 py-2"
          data-sketch-array-tool={array.tool}
          data-sketch-array-selection={String(array.selectionCount)}
        >
          <div className="text-muted-foreground pb-1 text-[10px] font-medium tracking-wider uppercase">
            {labels.arrayHeading}
          </div>
          {array.selectionCount === 0 ? (
            <p className="text-muted-foreground text-xs leading-4">
              {labels.arrayNoSelection}
            </p>
          ) : (
            <>
              <p
                className="text-muted-foreground pb-1 font-mono text-xs"
                data-testid="sketch-array-selection"
              >
                {labels.arraySelectionLabel(array.selectionCount)}
              </p>
              {array.tool === "rectArray" ? (
                <rectArrayForm.Form className="space-y-2" />
              ) : (
                <circArrayForm.Form className="space-y-2" />
              )}
              {arrayFailure !== undefined ? (
                <div
                  className="text-destructive pt-1 text-xs leading-4"
                  data-testid="sketch-array-error"
                  role="alert"
                >
                  {arrayFailure}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {/* The Phase 37 convert list: the host's topology references; a host
          without a topology view gets the honest hint, not dead rows. */}
      <section
        aria-label={labels.convertHeading}
        className="border-border border-b px-2 py-2"
        data-sketch-convert-section=""
      >
        <div className="text-muted-foreground pb-1 text-[10px] font-medium tracking-wider uppercase">
          {labels.convertHeading}
        </div>
        {convert === null ? (
          <p className="text-muted-foreground text-xs leading-4">
            {labels.convertNoTopology}
          </p>
        ) : convert.entries.length === 0 ? (
          <p className="text-muted-foreground text-xs leading-4">
            {labels.convertEmpty}
          </p>
        ) : (
          <>
            {convert.hint !== undefined ? (
              <p className="text-muted-foreground pb-1 text-xs leading-4">
                {convert.hint}
              </p>
            ) : null}
            <ul className="px-0 py-0.5">
              {convert.entries.map((entry) => (
                <li key={entry.referenceId}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 px-1 py-0.5 text-left text-xs outline-none enabled:hover:bg-muted/60 disabled:cursor-default disabled:opacity-60 focus-visible:ring-1 focus-visible:ring-ring/50"
                    data-sketch-convert-entry={entry.referenceId}
                    data-sketch-convert-kind={entry.kind}
                    data-sketch-convert-convertible={entry.convertible}
                    disabled={!entry.convertible}
                    title={
                      entry.declineMessage ??
                      `Convert ${entry.label} into the sketch`
                    }
                    onClick={() => {
                      setConvertFailure(undefined);
                      if (onConvert === undefined) return;
                      const outcome = onConvert(entry.referenceId);
                      if (!outcome.ok) {
                        setConvertFailure(
                          `${outcome.error.code}: ${outcome.error.message}`,
                        );
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {entry.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {convertFailure !== undefined ? (
              <div
                className="text-destructive pt-1 text-xs leading-4"
                data-testid="sketch-convert-error"
                role="alert"
              >
                {convertFailure}
              </div>
            ) : null}
          </>
        )}
      </section>
      <section aria-label={labels.diagnosticsHeading}>
        <div className="text-muted-foreground px-2 pt-1.5 text-[10px] font-medium tracking-wider uppercase">
          {labels.diagnosticsHeading}
        </div>
        {diagnostics.length === 0 ? (
          <div className="text-muted-foreground px-2 py-2">
            {labels.emptyDiagnostics}
          </div>
        ) : (
          <ul className="space-y-1 px-2 py-1.5">
            {diagnostics.map((diagnostic) => (
              <li
                key={`${diagnostic.code}:${diagnostic.message}`}
                className={`${SEVERITY_CLASSES[diagnostic.severity]} text-xs leading-4`}
                data-sketch-diagnostic-code={diagnostic.code}
                data-sketch-diagnostic-severity={diagnostic.severity}
              >
                <span className="font-mono">{diagnostic.code}</span>
                {": "}
                {diagnostic.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
