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
};

/** Structured outcome of a dimension apply: the host's refusal, verbatim. */
export type CadSketchDimensionApplyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

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
  className,
  constraints,
  diagnostics,
  dimension,
  dof,
  labels: labelOverrides,
  onEditDimension,
  onSelectConstraint,
  selectedConstraintId,
  solveStatus,
}: CadSketchInspectorProps) {
  const labels = useMergedLabels(labelOverrides);
  const [applyFailure, setApplyFailure] = useState<string | undefined>(
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
