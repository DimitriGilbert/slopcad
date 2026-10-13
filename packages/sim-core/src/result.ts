/**
 * The sim-core result plumbing — the package's own zero-dependency copy of
 * the structured-failure discipline every cad-core module follows
 * (`packages/cad-core/src/result.ts`): a parse either succeeds with a
 * value or fails with a structured error carrying a stable code, a human
 * message, and the offending input. sim-core deliberately depends on
 * nothing at runtime, so the tiny result vocabulary is restated here
 * rather than imported.
 */

/** A structured failure: a stable `sim/*`-family code plus context. */
export interface SimParseFailure {
  readonly code: string;
  readonly message: string;
  readonly input: unknown;
}

/** The outcome of a sim-core boundary: a value or a structured failure. */
export type SimParseResult<T, E extends SimParseFailure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wraps a value in the success arm. */
export function simOk<T>(value: T): SimParseResult<T, never> {
  return { ok: true, value };
}

/** Wraps an error in the failure arm. */
export function simFail<E extends SimParseFailure>(
  error: E,
): SimParseResult<never, E> {
  return { ok: false, error };
}
