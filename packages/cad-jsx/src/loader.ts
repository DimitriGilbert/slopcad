/**
 * The canonical TSX model loader (Phase 4): the ONE transpile → evaluate
 * → compile pipeline every server-side consumer of authored `.tsx` models
 * runs — the `/api/io/import-tsx` route, this package's round-trip tests,
 * and any future host. It turns TypeScript/TSX source text into the
 * native `slopcad` document format's canonical text by:
 *
 * 1. **Transpiling** the source through esbuild (the transform engine the
 *    repo's toolchain already runs on, pinned to the lockfile version)
 *    with the CLASSIC JSX transform (`createElement`/`Fragment` factories)
 *    into a single CommonJS-free/ESM-free module body — no `import`/`
 *    export` statements survive, so nothing needs a module loader;
 * 2. **Evaluating** that body in a fresh `node:vm` context whose
 *    globalThis exposes ONLY what a model needs: React's `createElement`
 *    and `Fragment`, this package's full element runtime (every exported
 *    tag and helper) as globals, and a hand-built `require` that resolves
 *    EXACTLY `"react"` and `"@slopcad/cad-jsx"` — anything else (a
 *    `node:fs`, a network client, another workspace package) is a
 *    structured `forbidden-import` refusal. The vm context carries the
 *    standard ECMAScript builtins (Math, JSON, …) and NO host objects:
 *    no `process`, no `fs`, no `fetch`, no `Buffer`. This isolates honest
 *    models from accidents and vocabulary drift; it is a containment
 *    boundary, not a hardened sandbox against hostile code — the endpoint
 *    layer's session gate owns who may submit source at all;
 * 3. **Rendering** the module's default export — an element, or a
 *    component function invoked once with no props (the CLI's contract,
 *    shared through `resolveModelExport`) — and compiling it through
 *    `compileToNative`.
 *
 * Hard limits: a source-size cap (`TSX_SOURCE_MAX_BYTES`) refuses
 * oversized submissions before the transform, and the evaluation runs
 * under vm's synchronous `timeout` budget (`TSX_EVAL_TIMEOUT_MS`) — the
 * module body of a CommonJS-free transpile is synchronous code, so the
 * vm timeout fits exactly; a model that loops forever is terminated and
 * surfaced as a structured `evaluation-failed` refusal. Runaway model
 * recursion is additionally guarded: a stack overflow surfaces through
 * the same structured refusal, and the compiler's own walk caps tree
 * depth.
 *
 * Node-only by design (esbuild + `node:vm`); the package index never
 * re-exports this module, so browser bundles stay clean (import it as
 * `@slopcad/cad-jsx/loader`).
 */

import { fail, ok } from "@slopcad/cad-core";
import type { ParseResult } from "@slopcad/cad-core";
import { transform } from "esbuild";
import { Fragment, createElement } from "react";
import { runInNewContext } from "node:vm";
import type { CompileToNativeOptions, NativeEmitError } from "./native";
import type { CadJsxCompileError } from "./compiler";
import type { CliModelError } from "./cli";

import { compileToNative } from "./native";
import { resolveModelExport } from "./cli";
import * as cadJsxRuntime from "./index";

/**
 * The largest model source the loader accepts: authored models are
 * kilobytes; a megabyte bounds the transform and the eval without
 * excluding any realistic file.
 */
export const TSX_SOURCE_MAX_BYTES = 1024 * 1024;

/**
 * The synchronous evaluation budget. The transpiled module body of a
 * CommonJS-free single module contains no awaits, so vm's `timeout`
 * terminates a runaway model deterministically.
 */
export const TSX_EVAL_TIMEOUT_MS = 250;

/** Stable failure codes produced when a model source cannot be loaded. */
export const TSX_LOAD_ERROR_CODES = {
  /** The source exceeds {@link TSX_SOURCE_MAX_BYTES}. */
  sourceTooLarge: "cadjsx-load/source-too-large",
  /** esbuild refused the source (a syntax error in the TSX). */
  transformFailed: "cadjsx-load/transform-failed",
  /** The module imports anything but "react" and "@slopcad/cad-jsx". */
  forbiddenImport: "cadjsx-load/forbidden-import",
  /** The evaluation threw, timed out, or overflowed the stack. */
  evaluationFailed: "cadjsx-load/evaluation-failed",
} as const;

export type TsxLoadErrorCode =
  (typeof TSX_LOAD_ERROR_CODES)[keyof typeof TSX_LOAD_ERROR_CODES];

/** Structured failure describing why a model source was refused. */
export interface TsxLoadError {
  readonly code: TsxLoadErrorCode | CliModelError["code"];
  readonly message: string;
  readonly input: unknown;
}

/**
 * The forbidden-module refusal the sandbox's `require` throws — thrown in
 * the vm, caught outside it (the class lives in this module's realm, so
 * `instanceof` survives the context boundary).
 */
class ForbiddenImportError extends Error {
  readonly specifier: string;

  constructor(specifier: string) {
    super(
      `A TSX model may import only "react" and "@slopcad/cad-jsx"; "${specifier}" is refused.`,
    );
    this.name = "ForbiddenImportError";
    this.specifier = specifier;
  }
}

/** An unknown thrown value's message (vm-realm Errors are not host Errors). */
function messageOf(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { readonly message: unknown }).message === "string"
  ) {
    return (error as { readonly message: string }).message;
  }
  return String(error);
}

/** The React surface a model may reach: the classic-transform factories. */
const reactModule = Object.freeze({
  Fragment,
  createElement,
});

/**
 * The sandbox's `require`: exactly two module specifiers resolve, both to
 * host module objects; everything else is a structured refusal.
 */
function sandboxRequire(specifier: string): unknown {
  if (specifier === "react") return reactModule;
  if (specifier === "@slopcad/cad-jsx") return cadJsxRuntime;
  throw new ForbiddenImportError(specifier);
}

/** Options for {@link compileTsxSource}. */
export interface CompileTsxOptions extends CompileToNativeOptions {
  /** The model's TypeScript/TSX source text. */
  readonly source: string;
  /** The synchronous evaluation budget; defaults to {@link TSX_EVAL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The loader's error union: its own refusals plus the compiler's and the emission's. */
export type TsxCompileFailure =
  TsxLoadError | CadJsxCompileError | NativeEmitError;

/**
 * Loads one TSX model source and compiles it to the native document
 * format's canonical text: transpile → sandbox evaluate → render the
 * default export → `compileToNative`. Never throws for domain errors;
 * every refusal is a structured failure.
 */
export async function compileTsxSource(
  options: CompileTsxOptions,
): Promise<ParseResult<string, TsxCompileFailure>> {
  const { source, timeoutMs, ...nativeOptions } = options;
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > TSX_SOURCE_MAX_BYTES) {
    return fail({
      code: TSX_LOAD_ERROR_CODES.sourceTooLarge,
      input: bytes,
      message: `The model source is ${String(bytes)} bytes; the loader accepts at most ${String(TSX_SOURCE_MAX_BYTES)}.`,
    });
  }

  let transpiled: string;
  try {
    transpiled = (
      await transform(source, {
        format: "cjs",
        jsx: "transform",
        jsxFactory: "createElement",
        jsxFragment: "Fragment",
        loader: "tsx",
        sourcefile: "model.tsx",
      })
    ).code;
  } catch (error) {
    return fail({
      code: TSX_LOAD_ERROR_CODES.transformFailed,
      input: source,
      message: `The model source does not transpile: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // The sandbox: the vm context's own ECMAScript builtins plus exactly
  // the model surface. `module`/`exports` receive the CommonJS output.
  const moduleRecord: { exports: Record<string, unknown> } = {
    exports: {},
  };
  const sandbox: Record<string, unknown> = {
    ...cadJsxRuntime,
    Fragment,
    createElement,
    exports: moduleRecord.exports,
    module: moduleRecord,
    require: sandboxRequire,
  };
  let defaultExport: unknown;
  try {
    runInNewContext(transpiled, sandbox, {
      timeout: timeoutMs ?? TSX_EVAL_TIMEOUT_MS,
    });
    defaultExport = moduleRecord.exports.default;
  } catch (error) {
    if (error instanceof ForbiddenImportError) {
      return fail({
        code: TSX_LOAD_ERROR_CODES.forbiddenImport,
        input: error.specifier,
        message: error.message,
      });
    }
    // vm-thrown errors (a timeout, or an Error the model raised) are
    // constructed in the vm's realm — `instanceof Error` against the host
    // realm is false — so the message is read structurally.
    const message = messageOf(error);
    const timedOut = message.includes("Script execution timed out");
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message: timedOut
        ? `The model exceeded its ${String(timeoutMs ?? TSX_EVAL_TIMEOUT_MS)} ms evaluation budget.`
        : `The model threw while being evaluated: ${message}`,
    });
  }

  const model = resolveModelExport(defaultExport);
  if (!model.ok) return fail(model.error);
  const native = compileToNative(model.value, nativeOptions);
  if (!native.ok) return fail(native.error);
  return ok(native.value);
}
