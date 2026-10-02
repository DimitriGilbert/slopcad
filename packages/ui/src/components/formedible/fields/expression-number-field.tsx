/**
 * The expression-number field (Phase 21): a number field that also accepts a
 * `$name` parameter reference — optionally negated (`-$name`, Phase 30) —
 * with a clickable autocomplete over the document's existing parameter
 * names.
 *
 * ## Value contract
 * The form value is a canonical `number` (the number field's exact
 * semantics — the consumer's validation gates judge literals unchanged), a
 * `string` `$name` token with an OPTIONAL leading `-`, or `undefined`
 * (empty). Partial or garbage text keeps its raw string in the form value
 * so the input never fights the keyboard; the field-level validation
 * ({@link expressionNumberProblem}) refuses anything that is neither a
 * gate-passing number nor a well-formed token naming a KNOWN parameter, so
 * an invalid value cannot submit. The negated token is one token — the sign
 * rides the reference (`-$caseDepth` means "minus the parameter's value");
 * what a submission DOES with the negation is the consumer's resolution
 * seam, not the field's.
 *
 * ## The autocomplete
 * While the caret sits inside a `$` token — bare or `-`-prefixed — the
 * dropdown lists the configured `parameterNames` filtered by the partial
 * name after the `$` (substring, case-insensitive — the autocomplete
 * field's rule). Clicking a row — or ArrowDown/ArrowUp + Enter — replaces
 * the active token with the full reference, PRESERVING the typed sign
 * (`-$` inserts `-$name`); Escape closes. With NO active `$` token there is
 * no dropdown: plain numbers never see suggestion chrome.
 */

import { useEffect, useRef, useState } from "react";
import type {
  FormedibleFieldRenderProps,
  FormedibleFormValues,
} from "../lib/types";
import { cn } from "cn";

import { FieldWrapper } from "./field-wrapper";
import { Button } from "../../button";
import { Input } from "../../input";

/**
 * The exact shape of a completed `$name` token (the parameter identifier),
 * with its optional leading `-`: the sign is part of the token, so
 * `-$name` is one reference ("minus the parameter's value"), never a
 * fragment of arithmetic.
 */
export const EXPRESSION_NUMBER_TOKEN_PATTERN =
  /^(-?)\$([A-Za-z_][A-Za-z0-9_]{0,63})$/;

/** The parameter name carried by a `$name` (or `-$name`) token, or `null` when it is not one. */
export function expressionNumberTokenName(value: string): string | null {
  const match = EXPRESSION_NUMBER_TOKEN_PATTERN.exec(value);
  return match?.[2] ?? null;
}

/**
 * True when the value is a NEGATED token (`-$name`): the typed `-` rides
 * the reference. A bare token, a number, or any non-token is not negated.
 */
export function expressionNumberTokenNegated(value: string): boolean {
  const match = EXPRESSION_NUMBER_TOKEN_PATTERN.exec(value);
  return match?.[1] === "-";
}

/** The `$` token the caret currently sits in. */
export interface ActiveExpressionNumberToken {
  /**
   * The index of the token's start in the input text — the leading `-`
   * when the token is negated, the `$` otherwise.
   */
  readonly start: number;
  /** The caret position — the token's open end while it is being typed. */
  readonly end: number;
  /** The partial name typed after the `$` (possibly empty). */
  readonly partial: string;
  /** Whether the token carries the leading `-` (`-$par…`). */
  readonly negated: boolean;
}

const ACTIVE_TOKEN_PATTERN = /(-?)\$([A-Za-z_][A-Za-z0-9_]{0,63})?$/;

/**
 * The `$` token ending at `caret` (the text before the caret must end with
 * an optional `-`, a `$`, and an optional partial identifier), or `null`
 * when the caret is not inside one.
 */
export function activeExpressionNumberToken(
  text: string,
  caret: number,
): ActiveExpressionNumberToken | null {
  const match = ACTIVE_TOKEN_PATTERN.exec(text.slice(0, Math.max(caret, 0)));
  if (match === null) return null;
  return {
    start: match.index,
    end: Math.max(caret, 0),
    partial: match[2] ?? "",
    negated: match[1] === "-",
  };
}

/**
 * Replaces the active token span with the full selection — the text before
 * the token, the completed reference (the typed `-` preserved: a negated
 * token completes to `-$name`), and the text after the caret.
 */
export function insertExpressionNumberSelection(
  text: string,
  token: ActiveExpressionNumberToken,
  name: string,
): string {
  const completed = `${token.negated ? "-$" : "$"}${name}`;
  return `${text.slice(0, token.start)}${completed}${text.slice(token.end)}`;
}

/**
 * The names suggested for a partial token: substring, case-insensitive (the
 * autocomplete field's filter), capped at `maxResults` in document order.
 */
export function filterExpressionNumberNames(
  names: readonly string[],
  partial: string,
  maxResults: number,
): readonly string[] {
  const query = partial.toLowerCase();
  return names
    .filter((name) => name.toLowerCase().includes(query))
    .slice(0, maxResults);
}

/** The input text a form value renders as (numbers and tokens verbatim). */
export function expressionNumberDisplayValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "";
}

/** Field-level validation configuration for one expression-number field. */
export interface ExpressionNumberValidation {
  /** The document's parameter names a `$name` may reference. */
  readonly parameterNames: readonly string[];
  /** The numeric gate a literal must pass; defaults to finiteness. */
  readonly acceptsNumber?: (value: number) => boolean;
  /**
   * Message when the value is neither a gate-passing number nor a well-formed
   * `$name` token (and when the token's parameter is unknown the message
   * names the parameter instead).
   */
  readonly message: string;
}

/**
 * The structured field-level problem of one submitted value: `null` when the
 * value is a gate-passing number or a `$name` / `-$name` token the
 * parameter list knows, otherwise the refusal (naming an unknown parameter
 * verbatim — the negated token's sign is not part of the name). Whether a
 * NEGATED token is acceptable for a given role is the consumer resolution
 * seam's decision, not this gate's.
 */
export function expressionNumberProblem(
  value: unknown,
  validation: ExpressionNumberValidation,
): string | null {
  if (typeof value === "number") {
    const accepts = validation.acceptsNumber ?? Number.isFinite;
    return accepts(value) ? null : validation.message;
  }
  if (typeof value === "string") {
    const name = expressionNumberTokenName(value);
    if (name !== null) {
      return validation.parameterNames.includes(name)
        ? null
        : `Unknown parameter "${name}".`;
    }
  }
  return validation.message;
}

/** The field value a typed text derives to (see the module doc's contract). */
function deriveExpressionNumberValue(
  text: string,
): number | string | undefined {
  if (text === "") return undefined;
  if (text.includes("$")) return text;
  const parsed = Number(text);
  if (Number.isFinite(parsed)) return parsed;
  return text;
}

export function ExpressionNumberField<
  TFormValues extends FormedibleFormValues,
>({ fieldConfig, field }: FormedibleFieldRenderProps<TFormValues>) {
  const config = fieldConfig.expressionNumberConfig;
  const parameterNames = config?.parameterNames ?? [];
  const maxResults = config?.maxResults ?? 8;
  const noOptionsText = config?.noOptionsText ?? "No parameters";
  const [inputValue, setInputValue] = useState(
    expressionNumberDisplayValue(field.value),
  );
  const [caret, setCaret] = useState(inputValue.length);
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const lastSyncedValueRef = useRef<unknown>(field.value);

  // External value changes (defaults adoption, a form reset) re-sync the
  // display — the autocomplete field's lastSyncedValueRef discipline.
  useEffect(() => {
    if (field.value === lastSyncedValueRef.current) {
      return;
    }
    lastSyncedValueRef.current = field.value;
    const next = expressionNumberDisplayValue(field.value);
    setInputValue(next);
    setCaret(next.length);
  }, [field.value]);

  // The suggestions only open on a token that STARTS the value: the field's
  // value contract is one number or one `$name`, so a token preceded by any
  // other text can never complete to a submittable value — suggesting it
  // would be a lie.
  const activeToken = activeExpressionNumberToken(inputValue, caret);
  const token = activeToken?.start === 0 ? activeToken : null;
  const suggestions =
    token === null
      ? []
      : filterExpressionNumberNames(parameterNames, token.partial, maxResults);
  const showDropdown = isOpen && token !== null;
  const active = Math.min(highlighted, Math.max(suggestions.length - 1, 0));
  const listboxId = `${field.id}-expression-listbox`;
  const activeOptionId =
    suggestions[active] === undefined
      ? undefined
      : `${listboxId}-option-${String(active)}`;

  const commitSelection = (name: string): void => {
    if (token === null) return;
    const next = insertExpressionNumberSelection(inputValue, token, name);
    setInputValue(next);
    // The caret parks after the inserted name (`-$name` → two prefix chars).
    setCaret(token.start + (token.negated ? 2 : 1) + name.length);
    field.onChange(next);
    lastSyncedValueRef.current = next;
    setIsOpen(false);
    setHighlighted(0);
  };

  return (
    <FieldWrapper fieldConfig={fieldConfig} field={field}>
      <div className="relative">
        <Input
          id={field.id}
          name={field.name}
          // A TEXT input: the `$` token must be typable (a native number
          // input refuses it); the value contract stays the number field's.
          type="text"
          inputMode="decimal"
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
          className={cn(
            // Room for the suffix tag on the control's right edge.
            fieldConfig.suffix === undefined ? undefined : "pr-10",
            fieldConfig.inputClassName,
          )}
          onBlur={() => {
            field.onBlur();
            // The number input's trailing-mark normalization: "10." settles
            // to "10" — the committed value's own display text.
            setInputValue(expressionNumberDisplayValue(field.value));
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
            const derived = deriveExpressionNumberValue(text);
            field.onChange(derived);
            lastSyncedValueRef.current = derived;
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
                event.preventDefault();
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
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {noOptionsText}
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
                  // the autocomplete field's discipline.
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
        {fieldConfig.suffix === undefined ? null : (
          <span
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute right-2.5 font-mono text-[11px]"
            data-slot="field-suffix"
          >
            {fieldConfig.suffix}
          </span>
        )}
      </div>
    </FieldWrapper>
  );
}
