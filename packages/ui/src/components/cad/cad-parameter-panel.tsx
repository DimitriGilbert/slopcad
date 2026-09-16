/**
 * `CadParameterPanel` (Phase 15.4): the shadcn-side CAD parameter panel —
 * the document's parameters displayed with their current quantities and
 * defining expressions, edited through a Formedible form (the schema +
 * field-config surface, never hand-rolled inputs), and applied EXCLUSIVELY
 * through the command vocabulary: every applied edit is committed as a
 * `parameter.set` transaction — the model API's
 * {@link setParameterCommand} interpreted by the store's `applyCommand`,
 * which is the exact path `useCadParameters().setValue` /
 * `setValueFromExpression` take. There is no second write path and no
 * direct kernel access.
 *
 * ## Field derivation (from parameter data only)
 *
 * The field list is a pure function of the parameter collection — one
 * editable field per parameter, keyed `value:<id>` or `expression:<id>`:
 *
 * - A LITERAL parameter (`expression === null`) gets a `number` field for
 *   its canonical magnitude; applying commits `setParameterCommand` with the
 *   domain's canonical value of the parameter's own dimension.
 * - An EXPRESSION-DRIVEN parameter gets a `text` field whose default is the
 *   domain's own canonical printing of the defining expression
 *   (`printExpression`) — the same field displays and edits the expression.
 *   Applying evaluates the submitted text with the domain's own parser and
 *   evaluator against the document's current parameter values and commits
 *   the RESULTING VALUE: the Phase 7 vocabulary has no expression command
 *   (see `useCadParameters`), so a committed expression edit is honestly a
 *   `parameter.set` of what the expression currently produces — the stored
 *   expression is domain substrate and is never written from the UI.
 * - Every field's label IS the parameter name (domain data, not prose), and
 *   its description carries the current quantity in the canonical unit of
 *   the parameter's dimension (`mm`, `rad`, `mm2`, `mm3`, `1` — the unit
 *   registry's canonical tokens; magnitudes render with the domain's own
 *   magnitude formatting, the same `String(number)` rule `printExpression`
 *   uses).
 *
 * Unchanged edits are filtered before anything is issued: a submitted value
 * that is `equalQuantity` to the current one, or an expression whose text
 * equals the current printing, issues no command.
 *
 * ## Error surfacing (domain-validated, never re-implemented)
 *
 * Expression correctness is checked by the DOMAIN, not by the form: each
 * expression field's Formedible `validation` runs the domain's
 * `parseExpression`/`evaluateExpression` against the current collection, and
 * a failure surfaces that structured error verbatim in the field's error
 * display as `code: message` — blocking submit, so an invalid expression
 * issues nothing. Numeric non-values are the form's own concern: the value
 * fields carry a finite-number gate with the externalized message. All
 * validation lives in the field configs — one source of truth per concern,
 * no parallel form-level schema duplicating either. A failure returned
 * by the apply surface itself (a structured transaction refusal, or a
 * prop-mode apply outcome) is surfaced in the panel's error region — the
 * first refusal stops the submit loop, and nothing after it is issued.
 *
 * ## State: two documented input modes, props first
 *
 * - **Prop-driven** — pass `parameters`, and take over the write path with
 *   `onApply` (receiving the parameter and the edit, returning the
 *   structured outcome); optionally pass `evaluate` for pre-submit
 *   expression validation. No provider is required.
 * - **Provider-driven** — mount below a `<CadProvider store={...}>` and
 *   omit the props: the panel mirrors `useCadParameters().parameters`,
 *   validates expressions against the provider collection, and applies
 *   through `store.applyCommand(setParameterCommand(...))`.
 *
 * **Precedence**: explicit props always win, per group — `parameters`
 * overrides the mirrored collection, `onApply` overrides the store as the
 * apply surface, and `evaluate` overrides the provider-derived evaluator.
 * With NO apply surface (no provider, no `onApply`) the form renders
 * disabled with no submit button — the panel is an inert viewer; it never
 * pretends to apply (the toolbar's and tree's documented inert discipline).
 *
 * All user-facing strings live in {@link CAD_PARAMETER_PANEL_LABELS}
 * (overridable via the `labels` prop); parameter names, expressions,
 * quantities, and error code/message text are domain data rendered verbatim.
 */

import { useMemo, useState } from "react";
import {
  CadProviderError,
  angle,
  area,
  CANONICAL_UNITS,
  dimensionless,
  equalQuantity,
  evaluateExpression,
  length,
  parseExpression,
  parameterEnvironment,
  printExpression,
  setParameterCommand,
  toCanonical,
  useCadParameters,
  useCadStore,
  volume,
  type AnyDimensionalValue,
  type CadStore,
  type Dimension,
  type ExpressionUpdateError,
  type Parameter,
  type ParameterCollection,
  type ParseResult,
} from "@slopcad/cad-react";
import { cn } from "@slopcad/ui/lib/utils";
import type { FormedibleFieldConfig } from "../formedible/lib/types";

import { useFormedible } from "../formedible/hooks/use-formedible";

/** The user-facing strings of {@link CadParameterPanel}. Overridable via props. */
export interface CadParameterPanelLabels {
  /** The visible panel title. */
  readonly title: string;
  /** Shown when there is nothing to display (no parameters source, or an empty collection). */
  readonly empty: string;
  /** The submit button's label. */
  readonly submit: string;
  /** Prefix of a field's current-quantity description. */
  readonly currentValue: string;
  /** Message shown when a value field is submitted without a usable number. */
  readonly valueInvalid: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_PARAMETER_PANEL_LABELS: CadParameterPanelLabels = {
  title: "Parameters",
  empty: "No parameters.",
  submit: "Apply",
  currentValue: "Current value",
  valueInvalid: "Enter a number.",
};

/** The form values of the panel's generated Formedible form. */
export type CadParameterPanelFormValues = Record<
  string,
  number | string | undefined
>;

/**
 * One applied edit: a canonical magnitude for a literal parameter, or the
 * expression text for an expression-driven one.
 */
export type CadParameterEdit =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "expression"; readonly expression: string };

/** Structured outcome of one apply: the domain's refusal, verbatim. */
export type CadParameterApplyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/**
 * The apply surface: receives the parameter and the edit, returns the
 * structured outcome. The provider-backed surface commits
 * `setParameterCommand` transactions through the store.
 */
export type CadParameterApply = (
  parameter: Parameter,
  edit: CadParameterEdit,
) => CadParameterApplyOutcome;

/**
 * The expression evaluator used for pre-submit validation: the domain's own
 * parse + evaluation result, structurally.
 */
export type CadParameterExpressionEvaluator = (
  expression: string,
) => ParseResult<AnyDimensionalValue, ExpressionUpdateError>;

/** Props of {@link CadParameterPanel}. */
export interface CadParameterPanelProps {
  /** The parameters to display and edit; overrides the provider-mirrored collection. */
  readonly parameters?: readonly Parameter[];
  /**
   * The apply surface; overrides the store apply (see the precedence rule
   * in the module doc). Without it and without a provider the panel is
   * inert: fields render disabled and no submit button exists.
   */
  readonly onApply?: CadParameterApply;
  /**
   * The pre-submit expression evaluator; overrides the evaluator derived
   * from the provider collection. Without any evaluator, expression fields
   * carry no pre-submit validation and the apply surface re-checks
   * structurally (its refusal surfaces in the panel error region).
   */
  readonly evaluate?: CadParameterExpressionEvaluator;
  /** Label token overrides, merged over {@link CAD_PARAMETER_PANEL_LABELS}. */
  readonly labels?: Partial<CadParameterPanelLabels>;
  /** Extends the container classes; width defaults to the content. */
  readonly className?: string;
}

/** The form key of a literal parameter's value field. */
function valueKey(id: string): string {
  return `value:${id}`;
}

/** The form key of an expression-driven parameter's expression field. */
function expressionKey(id: string): string {
  return `expression:${id}`;
}

/** The domain's canonical value of `dimension` at `magnitude`. */
function canonicalValue(
  dimension: Dimension,
  magnitude: number,
): AnyDimensionalValue {
  switch (dimension) {
    case "length":
      return length(magnitude);
    case "angle":
      return angle(magnitude);
    case "area":
      return area(magnitude);
    case "volume":
      return volume(magnitude);
    case "dimensionless":
      return dimensionless(magnitude);
  }
}

/**
 * The current quantity of a parameter in the canonical unit of its
 * dimension — the domain's unit token and magnitude formatting, verbatim.
 */
function currentQuantityText(parameter: Parameter): string {
  const canonical = toCanonical(parameter.value);
  return `${String(canonical.value)} ${CANONICAL_UNITS[canonical.dimension]}`;
}

/** The panel's single structured-error format: the domain's code + message. */
function formatDomainError(error: {
  readonly code: string;
  readonly message: string;
}): string {
  return `${error.code}: ${error.message}`;
}

/** Parses and evaluates `expression` against `collection`'s current values. */
function evaluateAgainst(
  collection: ParameterCollection,
  expression: string,
): ParseResult<AnyDimensionalValue, ExpressionUpdateError> {
  const parsed = parseExpression(expression);
  if (!parsed.ok) return parsed;
  return evaluateExpression(parsed.value, parameterEnvironment(collection));
}

/**
 * The submitted edit for `parameter`, or `undefined` when nothing should be
 * issued: blocked fields contribute nothing, and an edit equal to the
 * current document state (quantity-equal value, or identically printed
 * expression) is a no-op, not a command.
 */
function submittedEdit(
  parameter: Parameter,
  values: CadParameterPanelFormValues,
): CadParameterEdit | undefined {
  if (parameter.expression === null) {
    const submitted = values[valueKey(parameter.id)];
    // The field's numeric gate only lets finite submits through; a
    // non-number here means the field was refused, so nothing to apply.
    if (typeof submitted !== "number" || !Number.isFinite(submitted)) {
      return undefined;
    }
    if (
      equalQuantity(
        parameter.value,
        canonicalValue(parameter.value.dimension, submitted),
      )
    ) {
      return undefined;
    }
    return { kind: "value", value: submitted };
  }
  const submitted = values[expressionKey(parameter.id)];
  if (typeof submitted !== "string") return undefined;
  const text = submitted.trim();
  if (text === printExpression(parameter.expression)) return undefined;
  return { kind: "expression", expression: text };
}

/**
 * Reads the parameters hook, mapping the structured "no provider" error to
 * `null` — the same optional-read discipline as the viewport's, toolbar's,
 * and model tree's (the structured error is thrown before any stateful
 * hook, so removing a provider above a mounted panel re-renders fewer hooks
 * and fails loudly in React, a programming error reported as one).
 */
function useOptionalCadParameters(): ReturnType<typeof useCadParameters> | null {
  try {
    return useCadParameters();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/** The store counterpart of {@link useOptionalCadParameters}. */
function useOptionalCadStore(): CadStore | null {
  try {
    return useCadStore("CadParameterPanel");
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/**
 * The CAD parameter panel: the document's parameters with their current
 * quantities and expressions, edited through a Formedible form and applied
 * as `parameter.set` transactions, in one mountable component.
 */
export function CadParameterPanel({
  className,
  evaluate: evaluateProp,
  labels: labelOverrides,
  onApply,
  parameters: parametersProp,
}: CadParameterPanelProps) {
  const mergedLabels = useMemo(
    () => ({ ...CAD_PARAMETER_PANEL_LABELS, ...labelOverrides }),
    [labelOverrides],
  );

  const parametersApi = useOptionalCadParameters();
  const store = useOptionalCadStore();

  const parameters = parametersProp ?? parametersApi?.parameters;
  // The expression environment is the document's parameter values: the
  // provider collection when the panel mirrors one, regardless of whether
  // the display was overridden with `parameters`.
  const collection = parametersApi?.collection;

  const evaluate = useMemo<CadParameterExpressionEvaluator | undefined>(
    () =>
      evaluateProp ??
      (collection === undefined
        ? undefined
        : (expression) => evaluateAgainst(collection, expression)),
    [collection, evaluateProp],
  );

  // The apply surface: the host's `onApply` wins; otherwise the store path —
  // `setParameterCommand` interpreted by `applyCommand`, the same commit
  // `useCadParameters().setValue` / `setValueFromExpression` issue. Stable
  // per store + collection identity, so the form config below can capture it.
  const apply = useMemo<CadParameterApply | undefined>(() => {
    if (onApply !== undefined) return onApply;
    if (store === null || collection === undefined) return undefined;
    return (parameter, edit) => {
      if (edit.kind === "value") {
        const applied = store.applyCommand(
          setParameterCommand(
            parameter.id,
            canonicalValue(parameter.value.dimension, edit.value),
          ),
        );
        return applied.ok
          ? { ok: true }
          : { ok: false, error: applied.error };
      }
      const evaluated = evaluateAgainst(collection, edit.expression);
      if (!evaluated.ok) {
        return {
          ok: false,
          error: { code: evaluated.error.code, message: evaluated.error.message },
        };
      }
      const applied = store.applyCommand(
        setParameterCommand(parameter.id, evaluated.value),
      );
      return applied.ok ? { ok: true } : { ok: false, error: applied.error };
    };
  }, [collection, onApply, store]);

  const [applyFailure, setApplyFailure] = useState<string | undefined>(
    undefined,
  );

  // The form description is derived once per parameter-collection / label /
  // surface identity — the Formedible defaultValues adoption gate expects
  // burst-wise changes, not per-render churn (see the Formedible skill).
  // Validation lives entirely in the field configs (Formedible's field-level
  // validation surface, run on change/blur/submit): the numeric gate carries
  // the externalized message, the expression gate returns the domain's
  // structured failure. One source of truth per concern — no parallel
  // form-level schema duplicating either, and no schema-library import in
  // the CAD component area (the cad boundary allowlist).
  const formConfig = useMemo(() => {
    const parameterList = parameters ?? [];
    const defaultValues: Record<string, number | string> = {};
    const fields: FormedibleFieldConfig<CadParameterPanelFormValues>[] = [];

    for (const parameter of parameterList) {
      const quantity = `${mergedLabels.currentValue}: ${currentQuantityText(parameter)}`;
      if (parameter.expression === null) {
        defaultValues[valueKey(parameter.id)] = toCanonical(
          parameter.value,
        ).value;
        fields.push({
          name: valueKey(parameter.id),
          type: "number",
          label: parameter.name,
          description: quantity,
          inputClassName: "font-mono",
          // A finite-number gate with the externalized message; a refused
          // field blocks submit, so nothing is issued from it.
          validation: (value) =>
            typeof value === "number" && Number.isFinite(value)
              ? null
              : mergedLabels.valueInvalid,
        });
        continue;
      }
      defaultValues[expressionKey(parameter.id)] = printExpression(
        parameter.expression,
      );
      fields.push({
        name: expressionKey(parameter.id),
        type: "text",
        label: parameter.name,
        description: quantity,
        inputClassName: "font-mono",
        // The domain owns expression correctness: this validator returns the
        // domain's structured failure verbatim — the grammar is never
        // re-implemented client-side.
        validation:
          evaluate === undefined
            ? undefined
            : (value) => {
                if (typeof value !== "string") return mergedLabels.valueInvalid;
                const outcome = evaluate(value.trim());
                return outcome.ok
                  ? null
                  : formatDomainError(outcome.error);
              },
      });
    }

    return {
      defaultValues,
      fields,
      onSubmit: ({ value }: { readonly value: CadParameterPanelFormValues }) => {
        setApplyFailure(undefined);
        if (apply === undefined) return;
        for (const parameter of parameterList) {
          const edit = submittedEdit(parameter, value);
          if (edit === undefined) continue;
          const outcome = apply(parameter, edit);
          if (!outcome.ok) {
            setApplyFailure(formatDomainError(outcome.error));
            return;
          }
        }
      },
    };
  }, [apply, evaluate, mergedLabels, parameters]);

  const hasParameters = parameters !== undefined && parameters.length > 0;
  const parameterForm = useFormedible<CadParameterPanelFormValues>({
    fields: formConfig.fields,
    formOptions: {
      defaultValues: formConfig.defaultValues,
      onSubmit: formConfig.onSubmit,
    },
    // Submitted values survive the commit; the adopted defaults then re-sync
    // the fields to the committed document state on the next render.
    resetOnSubmitSuccess: false,
    submitLabel: mergedLabels.submit,
    // The apply is the panel's one terminal action — full width, deliberate.
    submitButtonClassName: "w-full",
    // Inert discipline: no apply surface, no submit button, disabled fields.
    showSubmitButton: apply !== undefined && hasParameters,
    disabled: apply === undefined,
  });

  return (
    <div
      className={cn(
        "border-border bg-background w-72 border text-sm",
        className,
      )}
      data-slot="cad-parameter-panel"
    >
      <div className="text-muted-foreground border-b px-2 py-1.5 text-xs font-medium tracking-wider uppercase">
        {mergedLabels.title}
      </div>
      {!hasParameters ? (
        <div className="text-muted-foreground px-2 py-2">
          {mergedLabels.empty}
        </div>
      ) : (
        <>
          <parameterForm.Form
            aria-label={mergedLabels.title}
            className="space-y-3 p-2"
          />
          {applyFailure !== undefined ? (
            <div
              className="text-destructive border-t px-2 py-1.5 text-xs leading-4"
              data-cad-param-panel-error=""
              role="alert"
            >
              {applyFailure}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
