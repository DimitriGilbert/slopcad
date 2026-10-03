/**
 * `CadParameterManager` (Phase 23): the management mode of the CAD
 * parameter panel — one source of truth with the edit-in-place form, never
 * a second surface. Where the panel's default mode edits the parameters a
 * document already has, the manager manages the VARIABLES themselves,
 * exclusively through the command vocabulary:
 *
 * - **Create** — a Formedible form (name, quantity) committing
 *   `parameter.create`. The name is validated with the domain's own
 *   identifier guard and reserved-function set plus the LIVE collection's
 *   names (field errors, not commit refusals); the quantity is a LITERAL
 *   SEED in the domain's own grammar — any expression without parameter
 *   references that evaluates to a finite quantity (`10`, `10mm`, `-29.6mm`,
 *   `2mm * 3` — a computation over constants is still computable without
 *   the document), so any dimension and sign is creatable without an
 *   invented unit picker. A formula over the document's variables refuses
 *   with the row-editor pointer: defining expressions belong to the row
 *   editor. A created variable is immediately part of the document:
 *   every `$` autocomplete in the feature dialogs derives from the live
 *   collection.
 * - **Expression editing with `$` autocomplete** — any variable's value can
 *   be switched between literal and expression. The editor is a Formedible
 *   form whose custom field reuses the expression-number field's token
 *   primitives (`activeExpressionNumberToken`,
 *   `filterExpressionNumberNames`) adapted to the expression grammar: the
 *   suggestions open on a `$` token ANYWHERE in the text, and a clicked row
 *   inserts the BARE identifier — the exact token `parseExpression`
 *   consumes — so the live preview and the field validator judge the
 *   committed artifact and the `$` stays a pure trigger character.
 *   Suggestions exclude the edited variable itself (a trivial self-cycle is
 *   never suggested; the domain still refuses a typed one at commit, with
 *   the chain in the refusal). The commit rides the expression payload path
 *   (`setParameterExpressionCommand`) — the domain evaluates, validates,
 *   and re-derives the dependents in the same application; the manager
 *   never evaluates anything into the document.
 * - **Clear back to literal** — the vocabulary's clear-null form
 *   (`clearParameterExpressionCommand`), landing on the expression's live
 *   evaluated quantity (the cached value as fallback).
 * - **The dependency graph** — an expression variable's direct references
 *   (the domain's own `extractExpressionDependencies` on the stored AST)
 *   and how many other variables reference it. Feature-input usage is not
 *   part of the panel's store surface and is never guessed.
 * - **Rename** — the Phase 24 `parameter.rename` command through a per-row
 *   inline Formedible editor (the manager's forms are Formedible forms).
 *   Its name field carries the create form's rules verbatim — identifier
 *   guard, reserved-function set, the LIVE collection's other names — as
 *   field errors, not commit refusals. The commit rides the vocabulary, so
 *   the domain rewrites every stored expression referencing the old name in
 *   the same application: the dependent rows' `depends on` lines re-render
 *   from their stored ASTs with the rewrite visible in place, and feature
 *   inputs (BY ID) ride untouched.
 * - **Delete** — the Phase 24 `parameter.delete` command behind a two-click
 *   confirm (Delete arms the row's action row; Confirm delete issues; Cancel
 *   or another row's action disarms), so a stray click cannot delete. A
 *   referenced variable's refusal surfaces in the shared alert region
 *   naming the blockers — the variables whose stored expressions read it
 *   (by name) and the features whose declared inputs consume it (by id and
 *   kind) — the `used by N variables` count enriched with the consumers to
 *   clear first; an unreferenced variable deletes cleanly and its row
 *   disappears.
 *
 * The manager offers exactly what the vocabulary allows — `parameter.create`
 * and `parameter.set` were the whole parameter surface of `applyCommand`
 * until the Phase 24 lifecycle completed it.
 *
 * The manager is store-backed by construction: the panel renders it only
 * when the store IS the apply surface (prop-mode `onApply` hosts keep the
 * edit form — the edit shape does not extend to the create/expression/clear
 * verbs). Its apply surface is one command per commit; refusals surface in
 * the panel's shared alert region (the applier owns that display), and a
 * refused expression commit leaves the editor open underneath it.
 *
 * All user-facing strings live in {@link CAD_PARAMETER_MANAGER_LABELS}
 * (overridable via the `labels` prop); parameter names, expressions,
 * quantities, and error text are domain data rendered verbatim.
 */

import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  angle,
  area,
  CANONICAL_UNITS,
  clearParameterExpressionCommand,
  deleteParameterCommand,
  dimensionless,
  EMPTY_PARAMETER_COLLECTION,
  evaluateExpression,
  extractExpressionDependencies,
  isExpressionFunction,
  isExpressionIdentifierName,
  length,
  parseExpression,
  parameterEnvironment,
  printExpression,
  renameParameterCommand,
  setParameterExpressionCommand,
  toCanonical,
  volume,
  type AnyDimensionalValue,
  type CadCommand,
  type Dimension,
  type ExpressionUpdateError,
  type Parameter,
  type ParameterId,
  type ParseResult,
} from "@slopcad/cad-react";
import { cn } from "cn";
import type {
  FormedibleFieldConfig,
  FormedibleFieldRenderProps,
} from "../formedible/lib/types";
import type {
  CadParameterApplyOutcome,
  CadParameterExpressionEvaluator,
} from "./cad-parameter-panel";

import { Button } from "../button";
import { FieldWrapper } from "../formedible/fields/field-wrapper";
import {
  activeExpressionNumberToken,
  filterExpressionNumberNames,
} from "../formedible/fields/expression-number-field";
import { useFormedible } from "../formedible/hooks/use-formedible";
import { Input } from "../input";

/** The user-facing strings of {@link CadParameterManager}. Overridable via props. */
export interface CadParameterManagerLabels {
  /** The create section's heading. */
  readonly createTitle: string;
  /** The create form's submit button. */
  readonly create: string;
  /** The create form's name field label. */
  readonly nameLabel: string;
  /** The create form's value field label. */
  readonly valueLabel: string;
  /** Refusal when the submitted name is not a usable expression identifier. */
  readonly nameInvalid: string;
  /** Refusal when the submitted name is reserved (`{name}` is substituted). */
  readonly nameReserved: string;
  /** Refusal when the submitted name exists (`{name}` is substituted). */
  readonly nameTaken: string;
  /** Refusal when the value field is submitted without a usable quantity. */
  readonly valueInvalid: string;
  /** Refusal when the value field holds a formula instead of a quantity. */
  readonly valueFormula: string;
  /** Prefix of an expression variable's direct-reference list. */
  readonly dependsOn: string;
  /** Reference count for exactly one referencing variable. */
  readonly usedByOne: string;
  /** Reference count template (`{count}` is substituted). */
  readonly usedByMany: string;
  /** The row action that opens the expression editor on a literal. */
  readonly setExpression: string;
  /** The row action that opens the expression editor on an expression. */
  readonly editExpression: string;
  /** The row action that clears an expression back to a literal. */
  readonly makeLiteral: string;
  /** The row action that opens the rename editor. */
  readonly rename: string;
  /** The rename editor's name field label. */
  readonly renameNameLabel: string;
  /** The row action that arms the delete confirm. */
  readonly delete: string;
  /** The armed row action that issues the delete. */
  readonly confirmDelete: string;
  /** The editor's commit button. */
  readonly apply: string;
  /** The editor's dismiss button. */
  readonly cancel: string;
  /** Dropdown text when no name matches the active `$` token. */
  readonly noSuggestions: string;
  /** Shown when the document has no variables yet. */
  readonly empty: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_PARAMETER_MANAGER_LABELS: CadParameterManagerLabels = {
  createTitle: "New variable",
  create: "Create variable",
  nameLabel: "Name",
  valueLabel: "Value",
  nameInvalid:
    "Use letters, digits, and underscores, start with a letter or underscore, and keep it to 64 characters.",
  nameReserved: 'The name "{name}" is reserved by the expression function set.',
  nameTaken: 'A variable named "{name}" already exists.',
  valueInvalid: "Enter a quantity like 10 or 10mm.",
  valueFormula:
    "Enter a quantity like 10 or 10mm — use Set expression for formulas.",
  dependsOn: "depends on",
  usedByOne: "used by 1 variable",
  usedByMany: "used by {count} variables",
  setExpression: "Set expression",
  editExpression: "Edit expression",
  makeLiteral: "Make literal",
  rename: "Rename",
  renameNameLabel: "New name",
  delete: "Delete",
  confirmDelete: "Confirm delete",
  apply: "Apply",
  cancel: "Cancel",
  noSuggestions: "No variables",
  empty: "No variables.",
};

/**
 * The manager's apply surface: one vocabulary command per commit
 * (`parameter.create`, the expression and clear-null forms of
 * `parameter.set`, and the Phase 24 lifecycle — `parameter.rename` /
 * `parameter.delete`). Refusals surface in the host's shared alert region —
 * the applier owns that display; the manager only reads the outcome to
 * close its editor.
 */
export type CadParameterCommandApply = (
  command: CadCommand,
) => CadParameterApplyOutcome;

/** Props of {@link CadParameterManager}. */
export interface CadParameterManagerProps {
  /**
   * The LIVE collection's parameters, in document order — the manager acts
   * on the document the commands apply to, never on a display override.
   */
  readonly parameters: readonly Parameter[];
  /**
   * The pre-submit expression evaluator (parse + evaluate against the live
   * collection) behind the editor's preview line and field validation.
   * Without it the preview is absent and correctness is the domain's
   * commit-time check alone.
   */
  readonly evaluate: CadParameterExpressionEvaluator | undefined;
  /** The command apply surface (see {@link CadParameterCommandApply}). */
  readonly onCommand: CadParameterCommandApply;
  /** Label token overrides, merged over {@link CAD_PARAMETER_MANAGER_LABELS}. */
  readonly labels?: Partial<CadParameterManagerLabels>;
  /** Extends the container classes. */
  readonly className?: string;
}

/**
 * The domain's canonical value of `dimension` at `magnitude` — the same
 * mapping the edit form's apply path uses for literal commits.
 */
export function canonicalDimensionValue(
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

/** Substitutes one `{token}` placeholder in a label template. */
function formatLabelTemplate(
  template: string,
  token: string,
  replacement: string,
): string {
  return template.replaceAll(`{${token}}`, replacement);
}

/** The manager's single structured-error format: the domain's code + message. */
function formatDomainError(error: {
  readonly code: string;
  readonly message: string;
}): string {
  return `${error.code}: ${error.message}`;
}

/** The identifier-free environment a quantity text evaluates against. */
const EMPTY_ENVIRONMENT = parameterEnvironment(EMPTY_PARAMETER_COLLECTION);

/**
 * Evaluates a quantity text — a number or attached-unit literal, no
 * identifiers — with the domain's own parser and evaluator.
 */
function evaluateQuantityText(
  text: string,
): ParseResult<AnyDimensionalValue, ExpressionUpdateError> {
  const parsed = parseExpression(text);
  if (!parsed.ok) return parsed;
  return evaluateExpression(parsed.value, EMPTY_ENVIRONMENT);
}

/** The current quantity of a parameter in the canonical unit of its dimension. */
function currentQuantityText(parameter: Parameter): string {
  return currentQuantityTextFromValue(parameter.value);
}

/** The canonical quantity text of a dimensional value. */
function currentQuantityTextFromValue(value: AnyDimensionalValue): string {
  const canonical = toCanonical(value);
  return `${String(canonical.value)} ${CANONICAL_UNITS[canonical.dimension]}`;
}

/** The create form's values. */
export type CadParameterManagerCreateValues = {
  name: string;
  value: string | undefined;
};

/** Module-scope defaults (the Formedible adoption gate mints once). */
const CREATE_DEFAULT_VALUES: CadParameterManagerCreateValues = {
  name: "",
  value: undefined,
};

/** The rename editor's values. */
export type CadParameterManagerRenameValues = {
  name: string;
};

/** Module-scope defaults (the Formedible adoption gate mints once). */
const RENAME_DEFAULT_VALUES: CadParameterManagerRenameValues = {
  name: "",
};

/** The expression editor's values. */
export type CadParameterManagerEditorValues = {
  expression: string;
};

/** Maximum suggestions rendered at once (the expression-number field's cap). */
const MAX_SUGGESTIONS = 8;

/**
 * What the editor's custom field needs beyond the config: the suggestion
 * names (the edited variable already excluded), the evaluator behind the
 * live preview, and the dropdown's empty text.
 */
interface ManagerExpressionContextValue {
  readonly names: readonly string[];
  readonly evaluate: CadParameterExpressionEvaluator | undefined;
  readonly noSuggestions: string;
}

const ManagerExpressionContext =
  createContext<ManagerExpressionContextValue | null>(null);

/**
 * The editor's expression input: a plain text field over the full
 * expression grammar with a `$`-triggered clickable autocomplete. The form
 * value is the raw text — `parseExpression` consumes it verbatim at commit.
 */
function ManagerExpressionInput({
  field,
  fieldConfig,
}: FormedibleFieldRenderProps<CadParameterManagerEditorValues>) {
  const context = useContext(ManagerExpressionContext);
  if (context === null) {
    throw new Error(
      "ManagerExpressionInput rendered outside the manager expression context.",
    );
  }
  const [inputValue, setInputValue] = useState(
    typeof field.value === "string" ? field.value : "",
  );
  const [caret, setCaret] = useState(inputValue.length);
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const lastSyncedValueRef = useRef<unknown>(field.value);

  // External value changes (defaults adoption, a form reset) re-sync the
  // display — the autocomplete fields' lastSyncedValueRef discipline.
  useEffect(() => {
    if (field.value === lastSyncedValueRef.current) {
      return;
    }
    lastSyncedValueRef.current = field.value;
    const next = typeof field.value === "string" ? field.value : "";
    setInputValue(next);
    setCaret(next.length);
  }, [field.value]);

  // The suggestions open on an active `$` token ANYWHERE in the text — the
  // editor's value is a full expression, so a reference may sit mid-text
  // (`holeDiameter + 2mm`). This is the one deliberate divergence from the
  // expression-number field's start-of-value rule, which serves that field's
  // single-token value contract.
  const token = activeExpressionNumberToken(inputValue, caret);
  const suggestions =
    token === null
      ? []
      : filterExpressionNumberNames(
          context.names,
          token.partial,
          MAX_SUGGESTIONS,
        );
  const showDropdown = isOpen && token !== null;
  const active = Math.min(highlighted, Math.max(suggestions.length - 1, 0));
  const listboxId = `${field.id}-manager-expression-listbox`;
  const activeOptionId =
    suggestions[active] === undefined
      ? undefined
      : `${listboxId}-option-${String(active)}`;

  const commitSelection = (name: string): void => {
    if (token === null) return;
    // The inserted selection is the BARE identifier — the grammar's own
    // token: the editor edits the exact text the commit parses, so the live
    // preview and the field validator judge the committed artifact. A
    // NEGATED token (`-$par`, the scanner's own span) re-emits its minus:
    // the token spans the sign, so dropping it would silently flip the
    // reference's sign in the committed expression (Phase 32b).
    const sign = token.negated ? "-" : "";
    const next = `${inputValue.slice(0, token.start)}${sign}${name}${inputValue.slice(token.end)}`;
    setInputValue(next);
    setCaret(token.start + sign.length + name.length);
    field.onChange(next);
    lastSyncedValueRef.current = next;
    setIsOpen(false);
    setHighlighted(0);
  };

  // The live preview: the domain's own evaluation of the CURRENT text — the
  // same read-only preview the edit form's expression fields carry. (An
  // unevaluable text has no line; its structured failure rides the field
  // validation error below.)
  const evaluated = context.evaluate?.(inputValue.trim());
  const preview =
    evaluated !== undefined && evaluated.ok
      ? currentQuantityTextFromValue(evaluated.value)
      : undefined;

  return (
    <FieldWrapper fieldConfig={fieldConfig} field={field}>
      <div className="relative">
        <Input
          id={field.id}
          name={field.name}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={inputValue}
          placeholder={fieldConfig.placeholder}
          disabled={fieldConfig.disabled}
          required={fieldConfig.required}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={showDropdown ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showDropdown ? activeOptionId : undefined}
          aria-invalid={field.error ? true : undefined}
          className={cn("font-mono", fieldConfig.inputClassName)}
          onBlur={() => {
            field.onBlur();
            setIsOpen(false);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart ?? inputValue.length);
          }}
          onChange={(event) => {
            const text = event.target.value;
            setInputValue(text);
            setCaret(event.target.selectionStart ?? text.length);
            setIsOpen(true);
            setHighlighted(0);
            field.onChange(text);
            lastSyncedValueRef.current = text;
          }}
          onKeyDown={(event) => {
            if (!showDropdown) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted(Math.min(active + 1, suggestions.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted(Math.max(active - 1, 0));
            } else if (event.key === "Enter") {
              const selected = suggestions[active];
              if (selected !== undefined) {
                // preventDefault keeps the editor's Enter-to-submit shim out
                // of the selection; stopPropagation keeps the bubbled form
                // handler from committing the editor mid-selection.
                event.preventDefault();
                event.stopPropagation();
                commitSelection(selected);
              }
            } else if (event.key === "Escape") {
              setIsOpen(false);
            }
          }}
        />
        {showDropdown ? (
          <div
            className="absolute left-0 right-0 top-full z-50 max-h-60 overflow-y-auto rounded-b-md border border-t-0 bg-popover p-1 text-popover-foreground shadow-md"
            id={listboxId}
            role="listbox"
            aria-label={
              typeof fieldConfig.label === "string"
                ? fieldConfig.label
                : field.name
            }
          >
            {suggestions.length === 0 ? (
              <div className="text-muted-foreground px-3 py-2 text-sm">
                {context.noSuggestions}
              </div>
            ) : (
              suggestions.map((name, index) => (
                <Button
                  key={name}
                  type="button"
                  variant="ghost"
                  role="option"
                  id={`${listboxId}-option-${String(index)}`}
                  aria-selected={index === active}
                  disabled={fieldConfig.disabled}
                  className="flex h-auto w-full items-center justify-start rounded-sm px-3 py-2 text-left font-mono text-sm"
                  // Keep the input focused (and its caret parked in the
                  // token) so the click commits without a blur round-trip —
                  // the autocomplete fields' discipline.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    commitSelection(name);
                  }}
                >
                  {`$${name}`}
                </Button>
              ))
            )}
          </div>
        ) : null}
      </div>
      {preview === undefined ? null : (
        <span
          aria-hidden="true"
          className="text-muted-foreground mt-1 block font-mono text-[11px]"
        >
          {`= ${preview}`}
        </span>
      )}
    </FieldWrapper>
  );
}

/**
 * One open variable's expression editor: a Formedible form (the manager's
 * forms are Formedible forms) whose single field is the suggest input.
 * Applying parses the text and commits the AST through the apply surface —
 * success closes the editor, a refusal leaves it open under the alert
 * region. Cancelling issues nothing.
 */
function ManagerExpressionEditor({
  evaluate,
  labels,
  names,
  onCancel,
  onCommit,
  parameter,
}: {
  readonly evaluate: CadParameterExpressionEvaluator | undefined;
  readonly labels: CadParameterManagerLabels;
  readonly names: readonly string[];
  readonly onCancel: () => void;
  readonly onCommit: (parameter: Parameter, text: string) => void;
  readonly parameter: Parameter;
}) {
  // The editor opens on the domain's own printing: an expression variable
  // edits its stored expression; a literal one starts from its canonical
  // magnitude (a constant expression is a legal first expression).
  const initialText =
    parameter.expression === null
      ? String(toCanonical(parameter.value).value)
      : printExpression(parameter.expression);
  const valueInvalid = labels.valueInvalid;

  const config = useMemo(() => {
    const fields: FormedibleFieldConfig<CadParameterManagerEditorValues>[] = [
      {
        name: "expression",
        type: "text",
        label: parameter.name,
        inputClassName: "font-mono",
        component: ManagerExpressionInput,
        // The domain owns expression correctness: the validator returns the
        // structured failure verbatim, blocking an invalid submit exactly
        // like the edit form's expression fields.
        validation:
          evaluate === undefined
            ? undefined
            : (value) => {
                if (typeof value !== "string") return valueInvalid;
                const outcome = evaluate(value.trim());
                return outcome.ok ? null : formatDomainError(outcome.error);
              },
      },
    ];
    return {
      defaultValues: { expression: initialText },
      fields,
      onSubmit: ({
        value,
      }: {
        readonly value: CadParameterManagerEditorValues;
      }) => {
        const text =
          typeof value.expression === "string" ? value.expression.trim() : "";
        if (text === "") return;
        onCommit(parameter, text);
      },
    };
  }, [evaluate, initialText, onCommit, parameter, valueInvalid]);

  const editorForm = useFormedible<CadParameterManagerEditorValues>({
    fields: config.fields,
    formOptions: {
      defaultValues: config.defaultValues,
      onSubmit: config.onSubmit,
    },
    // A refusal keeps the editor open under the alert region; a success
    // unmounts the editor — the reset path never shows.
    resetOnSubmitSuccess: false,
    showSubmitButton: false,
  });

  // The pinned action pair carries the form's only submit (the same
  // `form.handleSubmit` path the panel's footer button took).
  const submitEditor = (): void => {
    editorForm.form
      .handleSubmit()
      .catch((error: unknown) => console.error(error));
  };

  const contextValue = useMemo<ManagerExpressionContextValue>(
    () => ({ names, evaluate, noSuggestions: labels.noSuggestions }),
    [evaluate, labels.noSuggestions, names],
  );

  return (
    <ManagerExpressionContext.Provider value={contextValue}>
      <editorForm.Form
        aria-label={labels.editExpression}
        className="mt-1.5"
        onKeyDown={(event) => {
          // The pinned Apply carries the form's only visible submit, so the
          // form restores HTML's implicit Enter submission itself (the
          // panel's footer discipline). A dropdown selection stops
          // propagation at the input, so this never races it.
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
          submitEditor();
        }}
      />
      <div className="mt-1.5 flex gap-1">
        <Button onClick={submitEditor} size="xs" type="button">
          {labels.apply}
        </Button>
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          {labels.cancel}
        </Button>
      </div>
    </ManagerExpressionContext.Provider>
  );
}

/**
 * One open variable's rename editor: a Formedible form whose single name
 * field carries the create form's rules verbatim (the identifier guard, the
 * reserved-function set, the LIVE collection's OTHER names — the edited
 * variable's own name is already excluded from the row's `names`). Applying
 * commits `parameter.rename` through the apply surface — success closes the
 * editor, a refusal leaves it open under the alert region. Cancelling
 * issues nothing.
 */
function ManagerRenameEditor({
  labels,
  names,
  onCancel,
  onCommit,
  parameter,
}: {
  readonly labels: CadParameterManagerLabels;
  /** The collection's other names — the uniqueness set the field checks. */
  readonly names: readonly string[];
  readonly onCancel: () => void;
  readonly onCommit: (parameter: Parameter, name: string) => void;
  readonly parameter: Parameter;
}) {
  const nameInvalid = labels.nameInvalid;

  const config = useMemo(() => {
    const fields: FormedibleFieldConfig<CadParameterManagerRenameValues>[] = [
      {
        name: "name",
        type: "text",
        label: labels.renameNameLabel,
        placeholder: "plateHeight",
        inputClassName: "font-mono",
        // The create form's name validation, rule for rule — field errors,
        // not commit refusals (the domain re-checks at apply regardless).
        validation: (value) => {
          if (typeof value !== "string" || !isExpressionIdentifierName(value)) {
            return nameInvalid;
          }
          if (isExpressionFunction(value)) {
            return formatLabelTemplate(labels.nameReserved, "name", value);
          }
          return names.includes(value)
            ? formatLabelTemplate(labels.nameTaken, "name", value)
            : null;
        },
      },
    ];
    return {
      fields,
      onSubmit: ({
        value,
      }: {
        readonly value: CadParameterManagerRenameValues;
      }) => {
        const name = typeof value.name === "string" ? value.name.trim() : "";
        if (name === "") return;
        onCommit(parameter, name);
      },
    };
  }, [labels, names, onCommit, parameter, nameInvalid]);

  const renameForm = useFormedible<CadParameterManagerRenameValues>({
    fields: config.fields,
    formOptions: {
      defaultValues: RENAME_DEFAULT_VALUES,
      onSubmit: config.onSubmit,
    },
    // A refusal keeps the editor open under the alert region; a success
    // unmounts the editor — the expression editor's discipline.
    resetOnSubmitSuccess: false,
    showSubmitButton: false,
  });

  // The pinned action pair carries the form's only submit (the expression
  // editor's Enter-to-submit shim restored below).
  const submitRename = (): void => {
    renameForm.form
      .handleSubmit()
      .catch((error: unknown) => console.error(error));
  };

  return (
    <>
      <renameForm.Form
        aria-label={labels.rename}
        className="mt-1.5"
        onKeyDown={(event) => {
          // The pinned Apply carries the form's only visible submit, so the
          // form restores HTML's implicit Enter submission itself.
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
          submitRename();
        }}
      />
      <div className="mt-1.5 flex gap-1">
        <Button onClick={submitRename} size="xs" type="button">
          {labels.apply}
        </Button>
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          {labels.cancel}
        </Button>
      </div>
    </>
  );
}

/** One variable's management row: identity, quantity, graph, actions. */
function ParameterManagerRow({
  deleteArmed,
  editing,
  evaluate,
  labels,
  names,
  onCancel,
  onClear,
  onCommitExpression,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onEdit,
  onRename,
  onCommitRename,
  onCancelRename,
  parameter,
  renaming,
  usedBy,
}: {
  /** Whether this row's delete is armed (the two-click confirm's second leg). */
  readonly deleteArmed: boolean;
  readonly editing: boolean;
  readonly evaluate: CadParameterExpressionEvaluator | undefined;
  readonly labels: CadParameterManagerLabels;
  /** The suggestion names for this row's editor (the variable itself excluded). */
  readonly names: readonly string[];
  readonly onCancel: () => void;
  readonly onClear: (parameter: Parameter) => void;
  readonly onCommitExpression: (parameter: Parameter, text: string) => void;
  /** Arms this row's delete confirm. */
  readonly onDelete: (parameter: Parameter) => void;
  /** Issues the `parameter.delete` command (the armed second leg). */
  readonly onConfirmDelete: (parameter: Parameter) => void;
  /** Disarms the delete confirm without issuing anything. */
  readonly onCancelDelete: () => void;
  readonly onEdit: (parameter: Parameter) => void;
  /** Opens this row's rename editor. */
  readonly onRename: (parameter: Parameter) => void;
  readonly onCommitRename: (parameter: Parameter, name: string) => void;
  readonly onCancelRename: () => void;
  readonly parameter: Parameter;
  readonly renaming: boolean;
  readonly usedBy: number;
}) {
  // The quantity line re-evaluates an expression against the LIVE
  // environment on every collection change — the edit form's preview
  // discipline (a cached value can lag a foreign commit).
  let quantity = currentQuantityText(parameter);
  if (parameter.expression !== null && evaluate !== undefined) {
    const evaluated = evaluate(printExpression(parameter.expression));
    if (evaluated.ok) {
      quantity = currentQuantityTextFromValue(evaluated.value);
    }
  }

  // The direct references: the domain's own extractor on the stored AST —
  // insertion (source) order, deduplicated by the extractor. The line reads
  // the STORED AST, so a rename's rewrite shows here the moment the
  // collection updates.
  const dependencies =
    parameter.expression === null
      ? []
      : [...extractExpressionDependencies(parameter.expression)];

  return (
    <div
      className="border-border border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
      data-slot="cad-parameter-row"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs font-medium">{parameter.name}</span>
        <span
          className={cn(
            "font-mono text-xs",
            parameter.expression === null
              ? "text-muted-foreground"
              : "text-foreground",
          )}
        >
          {parameter.expression === null ? quantity : `= ${quantity}`}
        </span>
      </div>
      {dependencies.length > 0 || usedBy > 0 ? (
        <div className="text-muted-foreground mt-0.5 font-mono text-[11px]">
          {dependencies.length > 0
            ? `${labels.dependsOn} ${dependencies.join(", ")}`
            : null}
          {dependencies.length > 0 && usedBy > 0 ? " · " : null}
          {usedBy === 1
            ? labels.usedByOne
            : usedBy > 1
              ? formatLabelTemplate(labels.usedByMany, "count", String(usedBy))
              : null}
        </div>
      ) : null}
      {renaming ? (
        <ManagerRenameEditor
          labels={labels}
          names={names}
          onCancel={onCancelRename}
          onCommit={onCommitRename}
          parameter={parameter}
        />
      ) : editing ? (
        <ManagerExpressionEditor
          evaluate={evaluate}
          labels={labels}
          names={names}
          onCancel={onCancel}
          onCommit={onCommitExpression}
          parameter={parameter}
        />
      ) : deleteArmed ? (
        <div className="mt-1 flex gap-1">
          <Button
            onClick={() => onConfirmDelete(parameter)}
            size="xs"
            type="button"
            variant="destructive"
          >
            {labels.confirmDelete}
          </Button>
          <Button
            onClick={onCancelDelete}
            size="xs"
            type="button"
            variant="ghost"
          >
            {labels.cancel}
          </Button>
        </div>
      ) : (
        <div className="mt-1 flex gap-1">
          {parameter.expression === null ? (
            <Button
              onClick={() => onEdit(parameter)}
              size="xs"
              type="button"
              variant="ghost"
            >
              {labels.setExpression}
            </Button>
          ) : (
            <>
              <Button
                onClick={() => onEdit(parameter)}
                size="xs"
                type="button"
                variant="ghost"
              >
                {labels.editExpression}
              </Button>
              <Button
                onClick={() => onClear(parameter)}
                size="xs"
                type="button"
                variant="ghost"
              >
                {labels.makeLiteral}
              </Button>
            </>
          )}
          <Button
            onClick={() => onRename(parameter)}
            size="xs"
            type="button"
            variant="ghost"
          >
            {labels.rename}
          </Button>
          <Button
            className="text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/15"
            onClick={() => onDelete(parameter)}
            size="xs"
            type="button"
            variant="ghost"
          >
            {labels.delete}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The CAD parameter manager: the create form and the per-variable
 * management rows, riding the vocabulary's parameter commands through the
 * host's apply surface. Rendered by {@link CadParameterPanel} in manage
 * mode; see the module doc for the capability contract.
 */
export function CadParameterManager({
  className,
  evaluate,
  labels: labelOverrides,
  onCommand,
  parameters,
}: CadParameterManagerProps) {
  const mergedLabels = useMemo(
    () => ({ ...CAD_PARAMETER_MANAGER_LABELS, ...labelOverrides }),
    [labelOverrides],
  );

  const [editingId, setEditingId] = useState<ParameterId | undefined>(
    undefined,
  );
  // The rename editor's open row and the delete confirm's armed row — one
  // of each at a time, and never both on the same row (any editor-open or
  // arm action clears the other state).
  const [renamingId, setRenamingId] = useState<ParameterId | undefined>(
    undefined,
  );
  const [deleteArmedId, setDeleteArmedId] = useState<ParameterId | undefined>(
    undefined,
  );

  const names = useMemo(
    () => parameters.map((parameter) => parameter.name),
    [parameters],
  );

  // The reference counts: how many stored expressions read each name. (The
  // features' input usage is not part of the panel's store surface and is
  // never guessed.)
  const usedBy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const parameter of parameters) {
      if (parameter.expression === null) continue;
      for (const name of extractExpressionDependencies(parameter.expression)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  }, [parameters]);

  // The expression commit: parse at the edge and ship the AST — the same
  // payload path the edit form takes. The field validation blocks invalid
  // submits, so the parse here cannot fail; a domain refusal (the cycle the
  // evaluator cannot see against cached values) surfaces in the host's
  // alert region and the editor stays open.
  const commitExpression = useCallback(
    (parameter: Parameter, text: string) => {
      const parsed = parseExpression(text);
      if (!parsed.ok) return;
      const outcome = onCommand(
        setParameterExpressionCommand(parameter.id, parsed.value),
      );
      if (outcome.ok) setEditingId(undefined);
    },
    [onCommand],
  );

  // The clear commit: the vocabulary's clear-null form, landing on the
  // expression's live evaluated quantity (the cached value as the fallback
  // when the preview cannot evaluate). Only an expression row renders the
  // action; the guard is also the type narrowing.
  const clearExpression = useCallback(
    (parameter: Parameter) => {
      if (parameter.expression === null) return;
      const evaluated = evaluate?.(printExpression(parameter.expression));
      const value =
        evaluated !== undefined && evaluated.ok
          ? evaluated.value
          : parameter.value;
      onCommand(clearParameterExpressionCommand(parameter.id, value));
    },
    [evaluate, onCommand],
  );

  // The rename commit: the vocabulary's Phase 24 rename. The field
  // validation blocks rule-breaking submits, so a refusal here is the
  // domain's own (a name that became taken between render and submit) —
  // the editor stays open under the alert region, exactly like the
  // expression editor. Success closes it; the rewritten ASTs re-render the
  // dependent rows' dependency lines from the live collection.
  const commitRename = useCallback(
    (parameter: Parameter, name: string) => {
      const outcome = onCommand(renameParameterCommand(parameter.id, name));
      if (outcome.ok) {
        setRenamingId(undefined);
        setDeleteArmedId(undefined);
      }
    },
    [onCommand],
  );

  // The delete commits: the armed second leg issues the Phase 24 delete. A
  // referenced variable's refusal names the blockers in the shared alert
  // region and the row stays (disarmed — the user reads, then decides); an
  // unreferenced one deletes cleanly and its row disappears with the live
  // collection.
  const armDelete = useCallback((parameter: Parameter) => {
    setDeleteArmedId(parameter.id);
    setRenamingId(undefined);
  }, []);

  const confirmDelete = useCallback(
    (parameter: Parameter) => {
      onCommand(deleteParameterCommand(parameter.id));
      setDeleteArmedId(undefined);
    },
    [onCommand],
  );

  const openRename = useCallback((parameter: Parameter) => {
    setRenamingId(parameter.id);
    setDeleteArmedId(undefined);
  }, []);

  const createConfig = useMemo(() => {
    const fields: FormedibleFieldConfig<CadParameterManagerCreateValues>[] = [
      {
        name: "name",
        type: "text",
        label: mergedLabels.nameLabel,
        placeholder: "plateHeight",
        inputClassName: "font-mono",
        // The domain's own identifier guard and reserved-function set, and
        // the LIVE collection's names — the same rules `parameter.create`
        // applies, surfaced as field errors instead of commit refusals.
        validation: (value) => {
          if (typeof value !== "string" || !isExpressionIdentifierName(value)) {
            return mergedLabels.nameInvalid;
          }
          if (isExpressionFunction(value)) {
            return formatLabelTemplate(
              mergedLabels.nameReserved,
              "name",
              value,
            );
          }
          return names.includes(value)
            ? formatLabelTemplate(mergedLabels.nameTaken, "name", value)
            : null;
        },
      },
      {
        name: "value",
        type: "text",
        label: mergedLabels.valueLabel,
        placeholder: "10mm",
        inputClassName: "font-mono",
        // The initial cache is a LITERAL SEED in the domain's own grammar —
        // any expression WITHOUT parameter references that evaluates
        // against the empty environment to a finite quantity of any
        // dimension (Phase 30's widened rule): `10`, `10mm`, `-29.6mm` (a
        // negated literal), `2mm * 3` (a pure computation over constants —
        // still computable without the document, so still a literal seed).
        // A formula over the document's variables is refused here by shape
        // (the identifier check): defining expressions belong to the row
        // editor. The evaluator itself is the finiteness gate (the domain's
        // structured `expression/non-finite-result`).
        validation: (value) => {
          if (typeof value !== "string" || value.trim() === "") {
            return mergedLabels.valueInvalid;
          }
          const text = value.trim();
          const parsed = parseExpression(text);
          if (!parsed.ok) return formatDomainError(parsed.error);
          if (extractExpressionDependencies(parsed.value).size > 0) {
            return mergedLabels.valueFormula;
          }
          const evaluated = evaluateQuantityText(text);
          return evaluated.ok ? null : formatDomainError(evaluated.error);
        },
      },
    ];
    return {
      fields,
      onSubmit: ({
        value,
      }: {
        readonly value: CadParameterManagerCreateValues;
      }) => {
        // The field gate only lets a parsed, identifier-free, evaluated
        // quantity through; its value is the `parameter.create` initial
        // cache verbatim. The checks mirror the field validation exactly
        // (parse → no identifier nodes → domain evaluation, whose structured
        // refusal covers non-finite results).
        const text = typeof value.value === "string" ? value.value.trim() : "";
        const parsed = parseExpression(text);
        if (!parsed.ok) return;
        if (extractExpressionDependencies(parsed.value).size > 0) return;
        const evaluated = evaluateQuantityText(text);
        if (!evaluated.ok) return;
        onCommand({
          type: "parameter.create",
          name: value.name,
          value: evaluated.value,
        });
      },
    };
  }, [mergedLabels, names, onCommand]);

  const createForm = useFormedible<CadParameterManagerCreateValues>({
    fields: createConfig.fields,
    formOptions: {
      defaultValues: CREATE_DEFAULT_VALUES,
      onSubmit: createConfig.onSubmit,
    },
    // A created variable's row appears below; the form resets to its
    // defaults ready for the next one (the documented submit reset).
    submitLabel: mergedLabels.create,
  });

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
      data-slot="cad-parameter-manager"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section
          aria-label={mergedLabels.createTitle}
          className="border-border border-b px-2.5 py-2"
        >
          <h3 className="text-muted-foreground pb-1.5 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
            {mergedLabels.createTitle}
          </h3>
          <createForm.Form className="space-y-2" />
        </section>
        <div className="px-2.5 py-2">
          {parameters.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {mergedLabels.empty}
            </p>
          ) : (
            parameters.map((parameter) => (
              <ParameterManagerRow
                key={parameter.id}
                deleteArmed={deleteArmedId === parameter.id}
                editing={editingId === parameter.id}
                evaluate={evaluate}
                labels={mergedLabels}
                names={names.filter((name) => name !== parameter.name)}
                onCancel={() => setEditingId(undefined)}
                onCancelDelete={() => setDeleteArmedId(undefined)}
                onCancelRename={() => setRenamingId(undefined)}
                onClear={clearExpression}
                onCommitExpression={commitExpression}
                onCommitRename={commitRename}
                onConfirmDelete={confirmDelete}
                onDelete={armDelete}
                onEdit={(edited) => {
                  setEditingId(edited.id);
                  setDeleteArmedId(undefined);
                  setRenamingId(undefined);
                }}
                onRename={openRename}
                parameter={parameter}
                renaming={renamingId === parameter.id}
                usedBy={usedBy.get(parameter.name) ?? 0}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
