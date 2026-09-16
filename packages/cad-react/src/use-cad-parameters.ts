/**
 * `useCadParameters` (Phase 14): the parameter hook. Mirrors the document's
 * {@link ParameterCollection} through the `parameters` concern (a subset of
 * document changes — a feature-only commit does not notify it) and exposes
 * the mutation surface the Phase 7 vocabulary actually has for parameters:
 * `parameter.set` value commits, expression-aware through the domain's own
 * parser and evaluator.
 *
 * ## Expression-aware updates, honestly scoped
 *
 * A parameter's defining expression lives in its domain record
 * (`Parameter.expression`) and is written by the domain substrate, not by
 * this layer — the Phase 7 command vocabulary has NO expression command, so
 * there is no React-side expression write that would not bypass the session.
 * What this hook does offer is evaluation-aware editing: a text expression
 * is parsed and evaluated with the domain's own `parseExpression` /
 * `evaluateExpression` against the document's current parameter values, and
 * the resulting canonical dimensional value is committed through
 * `parameter.set`. A parse or evaluation failure is returned structurally
 * and issues nothing. (Self-reference reads the pre-commit stored value.)
 *
 * Notification model: re-renders exactly when the parameter collection
 * identity changes — never on feature-only commits, selection, or tools.
 */

import { useSyncExternalStore } from "react";
import {
  evaluateExpression,
  findParameterByName,
  getParameter,
  parseExpression,
  parameterEnvironment,
  type AnyDimensionalValue,
  type CadSession,
  type ExpressionEvaluationError,
  type ExpressionParseError,
  type Parameter,
  type ParameterCollection,
  type ParameterId,
  type ParseResult,
  type TransactionError,
} from "@slopcad/cad-core";

import { setParameterCommand } from "./model";
import { useCadStore } from "./provider";

/** Structured failure of an expression-aware update. */
export type ExpressionUpdateError =
  | ExpressionParseError
  | ExpressionEvaluationError;

/** The failure union of {@link CadParametersApi.setValueFromExpression}. */
export type ExpressionSetError = ExpressionUpdateError | TransactionError;

/** What {@link useCadParameters} exposes. */
export interface CadParametersApi {
  /** The current parameter collection (immutable domain value). */
  readonly collection: ParameterCollection;
  /** The parameters, in document order. */
  readonly parameters: readonly Parameter[];
  /** The parameter with the given id, or `undefined`. */
  readonly get: (id: ParameterId) => Parameter | undefined;
  /** The parameter with the given name, or `undefined`. */
  readonly getByName: (name: string) => Parameter | undefined;
  /**
   * Commits a literal value through a `parameter.set` transaction. The
   * domain validates the value; on failure nothing changed.
   */
  readonly setValue: (
    id: ParameterId,
    value: AnyDimensionalValue,
  ) => ParseResult<CadSession, TransactionError>;
  /**
   * Parses a text expression against the document's current parameter
   * values and returns the resulting canonical dimensional value — or the
   * structured parse/evaluation failure. Issues nothing.
   */
  readonly evaluate: (
    expression: string,
  ) => ParseResult<AnyDimensionalValue, ExpressionUpdateError>;
  /**
   * Evaluates a text expression (see {@link CadParametersApi.evaluate}) and
   * commits the resulting value through a `parameter.set` transaction. On
   * any failure the document is untouched and the structured error is
   * returned.
   */
  readonly setValueFromExpression: (
    id: ParameterId,
    expression: string,
  ) => ParseResult<CadSession, ExpressionSetError>;
}

/** Subscribes to the `parameters` concern and mirrors the collection. */
export function useCadParameters(): CadParametersApi {
  const store = useCadStore("useCadParameters");
  const collection = useSyncExternalStore(
    store.subscribeParameters,
    store.getParameters,
    // Server snapshot: the same getter — the store runs headless (see
    // use-cad-document.ts).
    store.getParameters,
  );
  const environment = parameterEnvironment(collection);

  const evaluate = (
    expression: string,
  ): ParseResult<AnyDimensionalValue, ExpressionUpdateError> => {
    const parsed = parseExpression(expression);
    if (!parsed.ok) return parsed;
    return evaluateExpression(parsed.value, environment);
  };

  const setValueFromExpression = (
    id: ParameterId,
    expression: string,
  ): ParseResult<CadSession, ExpressionSetError> => {
    const evaluated = evaluate(expression);
    if (!evaluated.ok) return evaluated;
    return store.applyCommand(setParameterCommand(id, evaluated.value));
  };

  const setValue = (
    id: ParameterId,
    value: AnyDimensionalValue,
  ): ParseResult<CadSession, TransactionError> =>
    store.applyCommand(setParameterCommand(id, value));

  return {
    collection,
    parameters: collection.parameters,
    get: (id) => getParameter(collection, id),
    getByName: (name) => findParameterByName(collection, name),
    setValue,
    evaluate,
    setValueFromExpression,
  };
}
