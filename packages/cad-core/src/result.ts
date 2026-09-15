/**
 * Minimal result type shared by every `@slopcad/cad-core` parser so input
 * from trust boundaries (persisted documents, imported files, IPC) is
 * rejected through structured failures instead of exceptions.
 */

/** Structured failure describing why a parser rejected its input. */
export interface ParseFailure {
  /** Stable machine-readable failure code (domain-prefixed, e.g. `id/empty`). */
  readonly code: string;
  /** Human-readable explanation of the failure. */
  readonly message: string;
  /** The rejected input, retained for diagnostics and logging. */
  readonly input: unknown;
}

/** Discriminated result of parsing untrusted input into a value of `T`. */
export type ParseResult<T, F extends ParseFailure = ParseFailure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: F };

/** Builds a successful parse result. */
export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/** Builds a failed parse result. */
export function fail<F extends ParseFailure>(
  error: F,
): { readonly ok: false; readonly error: F } {
  return { ok: false, error };
}
