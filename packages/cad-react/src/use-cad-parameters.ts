/**
 * `useCadParameters` (Phase 14): the parameter hook. Mirrors the document's
 * {@link ParameterCollection} through the `parameters` concern (a subset of
 * document changes — a feature-only commit does not notify it) and exposes
 * the mutation surface the command vocabulary has for parameters: literal
 * `parameter.set` value commits, and — since the vocabulary's Phase 22
 * expression payloads — defining-expression commits through the domain's
 * own parser.
 *
 * ## Expression-aware updates
 *
 * A parameter's defining expression is written THROUGH the vocabulary:
 * `setValueFromExpression` parses the text with the domain's
 * `parseExpression` and commits the AST via `parameter.set`'s expression
 * payload (`setParameterExpressionCommand`). The document's single
 * interpreter then validates the identifiers and cycles against the live
 * collection, stores the AST, and recomputes the parameter and its
 * dependents — one write path, no React-side evaluation that could disagree
 * with the domain. A parse failure is returned structurally and issues
 * nothing; a domain refusal (unknown identifier, cycle) rides the
 * transaction failure verbatim.
 *
 * `evaluate` remains the read-side preview: parse + evaluate against the
 * document's current parameter values, structurally, issuing nothing.
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

import { setParameterCommand, setParameterExpressionCommand } from "./model";
import { useCadStore } from "./provider";

/** Structured failure of an expression-aware evaluation preview. */
export type ExpressionUpdateError =
  ExpressionParseError | ExpressionEvaluationError;

/** The failure union of {@link CadParametersApi.setValueFromExpression}. */
export type ExpressionSetError = ExpressionParseError | TransactionError;

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
   * Parses a text expression with the domain's parser and commits the AST
   * through a `parameter.set` expression payload: the document stores the
   * expression, re-derives the parameter's cached value, and recomputes its
   * dependents. A parse failure leaves the document untouched; a domain
   * refusal (unknown identifier, closing cycle) surfaces verbatim as the
   * structured transaction failure.
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
    const parsed = parseExpression(expression);
    if (!parsed.ok) return parsed;
    return store.applyCommand(setParameterExpressionCommand(id, parsed.value));
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
