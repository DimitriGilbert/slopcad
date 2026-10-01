/**
 * `CadParameterPanel` (Phase 15.4): the shadcn-side CAD parameter panel —
 * the document's parameters displayed with their current quantities and
 * defining expressions, edited through a Formedible form (the schema +
 * field-config surface, never hand-rolled inputs), and applied EXCLUSIVELY
 * through the command vocabulary: every applied edit is committed as a
 * `parameter.set` transaction — the model API's `setParameterCommand` for
 * literals and `setParameterExpressionCommand` for expressions, interpreted
 * by the store's `applyCommand`, which is the exact path
 * `useCadParameters().setValue` / `setValueFromExpression` take. There is
 * no second write path and no direct kernel access.
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
 *   Applying commits the expression ITSELF (Phase 22): the submitted text is
 *   parsed with the domain's own parser and rides `parameter.set` as a
 *   serialized AST (`setParameterExpressionCommand`); the document's single
 *   interpreter validates the identifiers and cycles against the live
 *   collection, stores the AST, and recomputes the parameter and its
 *   dependents in the same application. Nothing is evaluated on the React
 *   side of a commit — the domain is the only evaluator.
 * - Every field's label IS the parameter name (domain data, not prose).
 *   The current quantity never renders as a third row under the input:
 *   a LITERAL field wears its canonical unit INSIDE the control (the
 *   number field's `suffix`), and an EXPRESSION field prints its
 *   evaluated quantity as the field's one data line (`= 16 mm`) — the
 *   canonical unit of the parameter's dimension (`mm`, `rad`, `mm2`,
 *   `mm3`, `1` — the unit registry's canonical tokens; magnitudes render
 *   with the domain's own magnitude formatting, the same `String(number)`
 *   rule `printExpression` uses). The full current-quantity sentence
 *   rides along as a screen-reader-only description.
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
 * issues nothing. The checks the evaluator cannot make (unknown
 * identifiers on a racing document, reference cycles) are refused by the
 * apply surface's interpreter and surface verbatim in the panel's error
 * region. Numeric non-values are the form's own concern: the value
 * fields carry a finite-number gate with the externalized message. All
 * validation lives in the field configs — one source of truth per concern,
 * no parallel form-level schema duplicating either. A failure returned
 * by the apply surface itself (a structured transaction refusal — unwrapped
 * to its command cause when there is one — or a prop-mode apply outcome)
 * is surfaced in the panel's error region — the first refusal stops the
 * submit loop, and nothing after it is issued.
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
  setParameterExpressionCommand,
  toCanonical,
  useCadParameters,
  useCadStore,
  volume,
  type AnyDimensionalValue,
  type CadSession,
  type CadStore,
  type Dimension,
  type ExpressionUpdateError,
  type Parameter,
  type ParameterCollection,
  type ParseResult,
  type TransactionError,
} from "@slopcad/cad-react";
import { cn } from "cn";
import type { FormedibleFieldConfig } from "../formedible/lib/types";

import { Button } from "../button";
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

/**
 * Maps a store apply result to the panel outcome. A refused transaction
 * carries its offending command's structured error as `cause` — the
 * domain's own refusal (an unknown identifier, a reference cycle) — which
 * is what the error region surfaces, verbatim; only a cause-less refusal
 * (the transaction envelope's own shape failures) falls back to the
 * transaction error itself.
 */
function toOutcome(
  applied: ParseResult<CadSession, TransactionError>,
): CadParameterApplyOutcome {
  if (applied.ok) return { ok: true };
  const cause = applied.error.cause;
  return {
    ok: false,
    error: cause ?? {
      code: applied.error.code,
      message: applied.error.message,
    },
  };
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
function useOptionalCadParameters(): ReturnType<
  typeof useCadParameters
> | null {
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
  // `setParameterCommand` / `setParameterExpressionCommand` interpreted by
  // `applyCommand`, the same commits `useCadParameters().setValue` /
  // `setValueFromExpression` issue. Stable per store + collection identity,
  // so the form config below can capture it.
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
        return toOutcome(applied);
      }
      // The expression commit: parse the submitted text and ship the AST —
      // the domain's interpreter evaluates, validates identifiers/cycles,
      // and recomputes the dependents at apply time, against the LIVE
      // document. The submit loop applies several edits in ONE synchronous
      // pass, each committing immediately, so an expression committed after
      // a literal in the same submit reads that literal's fresh value — the
      // pre-submit `collection` snapshot serves only the field-validation
      // evaluator above.
      const parsed = parseExpression(edit.expression);
      if (!parsed.ok) {
        return {
          ok: false,
          error: { code: parsed.error.code, message: parsed.error.message },
        };
      }
      const applied = store.applyCommand(
        setParameterExpressionCommand(parameter.id, parsed.value),
      );
      return toOutcome(applied);
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
      // The preview quantity: for an EXPRESSION parameter the cached
      // `parameter.value` can lag the collection — a foreign parameter.set
      // commit (an edit to a DIFFERENT parameter this expression reads) does
      // not rewrite this parameter's cached value, so the stale number would
      // contradict the settled document. The preview therefore re-evaluates
      // the defining expression against the CURRENT environment on every
      // collection change; the cached value is the fallback when no
      // evaluator is available or the expression does not evaluate.
      let quantity = currentQuantityText(parameter);
      if (parameter.expression !== null && evaluate !== undefined) {
        const evaluated = evaluate(printExpression(parameter.expression));
        if (evaluated.ok) {
          const canonical = toCanonical(evaluated.value);
          quantity = `${String(canonical.value)} ${CANONICAL_UNITS[canonical.dimension]}`;
        }
      }
      // The field's quantity lives in the field HEAD, not a third row:
      // literal fields wear their canonical unit INSIDE the control (the
      // suffix), expression fields print their evaluated quantity as the
      // one data line (`= 16 mm`). The full current-quantity sentence
      // rides along as a screen-reader-only description — same words as
      // ever, zero extra visual rows.
      const srQuantity = (
        <span className="sr-only">
          {`${mergedLabels.currentValue}: ${quantity}`}
        </span>
      );
      if (parameter.expression === null) {
        defaultValues[valueKey(parameter.id)] = toCanonical(
          parameter.value,
        ).value;
        fields.push({
          name: valueKey(parameter.id),
          type: "number",
          label: parameter.name,
          description: srQuantity,
          suffix: CANONICAL_UNITS[parameter.value.dimension],
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
        description: (
          <>
            {srQuantity}
            <span aria-hidden="true" className="font-mono">
              {`= ${quantity}`}
            </span>
          </>
        ),
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
                return outcome.ok ? null : formatDomainError(outcome.error);
              },
      });
    }

    return {
      defaultValues,
      fields,
      onSubmit: ({
        value,
      }: {
        readonly value: CadParameterPanelFormValues;
      }) => {
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
    // Inert discipline: no apply surface, no submit button, disabled fields.
    showSubmitButton: false,
    disabled: apply === undefined,
  });

  // The apply action is pinned as the dock's footer: the FIELDS scroll, the
  // terminal action never leaves the viewport. It rides the Formedible
  // form's own submit lifecycle (`form.handleSubmit` — the same path the
  // in-form button took), so validation, touched-marking, and the onSubmit
  // config are unchanged.
  const submitApply = (): void => {
    parameterForm.form
      .handleSubmit()
      .catch((error: unknown) => console.error(error));
  };

  return (
    <div
      className={cn(
        "border-border bg-card/60 flex max-h-full min-h-0 flex-col overflow-hidden rounded-md border text-sm",
        className,
      )}
      data-slot="cad-parameter-panel"
    >
      <div className="text-muted-foreground border-border bg-background/40 shrink-0 border-b px-2.5 py-1.5 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
        {mergedLabels.title}
      </div>
      {!hasParameters ? (
        <div className="text-muted-foreground px-2.5 py-2 text-xs">
          {mergedLabels.empty}
        </div>
      ) : (
        <>
          <parameterForm.Form
            aria-label={mergedLabels.title}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2.5"
            onKeyDown={(event) => {
              // The pinned footer carries the form's only visible submit,
              // so the form restores HTML's implicit Enter submission
              // itself: Enter inside a field commits, exactly as it did
              // with the in-form button. Buttons and links keep their
              // native key handling; textareas keep Shift+Enter.
              if (event.key !== "Enter" || event.shiftKey) return;
              const target = event.target;
              if (
                target instanceof HTMLButtonElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLAnchorElement ||
                (target instanceof HTMLElement && target.isContentEditable)
              ) {
                return;
              }
              event.preventDefault();
              submitApply();
            }}
          />
          {applyFailure !== undefined ? (
            <div
              className="text-destructive border-border shrink-0 border-t px-2.5 py-1.5 text-xs leading-4"
              data-cad-param-panel-error=""
              role="alert"
            >
              {applyFailure}
            </div>
          ) : null}
          {apply !== undefined ? (
            <parameterForm.form.Subscribe
              selector={(state) => ({
                canSubmit: Boolean(state.canSubmit),
                isSubmitting: Boolean(state.isSubmitting),
              })}
            >
              {(state) => (
                <Button
                  className="w-full rounded-none border-t border-t-border"
                  disabled={!state.canSubmit || state.isSubmitting}
                  onClick={submitApply}
                  type="button"
                  variant="default"
                >
                  {mergedLabels.submit}
                </Button>
              )}
            </parameterForm.form.Subscribe>
          ) : null}
        </>
      )}
    </div>
  );
}
