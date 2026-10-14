/**
 * The `compile` CLI's pure logic (Phase 3): argument parsing, output-path
 * resolution, document-id derivation, and default-export resolution —
 * everything except the Node I/O the `scripts/compile.ts` entry performs.
 * Split this way, the CLI's decisions are unit-tested like any other
 * module (the repo has no precedent for spawning package scripts in
 * tests), and the entry stays a thin shell: parse, load, compile, write,
 * exit with the documented code.
 *
 * The CLI contract (see `compileCliHelp`):
 *
 * - `pnpm --filter @slopcad/cad-jsx compile <model.tsx> [--out <path>]
 *   [--commands <path>]`
 * - the model file's default export is rendered — a React element, or a
 *   component function (invoked once with no props);
 * - the native JSON always goes to stdout; `--out` ADDITIONALLY writes it
 *   to a file (a path with no extension gains the repo's `.native.json`
 *   fixture extension — the workbench's import accepts the raw JSON text,
 *   which is exactly what stdout and the file carry);
 * - `--commands` ADDITIONALLY writes the emission's command batch — every
 *   committed transaction's commands, in order, exactly as the native
 *   history serializes them — as a JSON array (an extensionless path
 *   gains the `.commands.json` fixture extension), the batch an agent
 *   replays through `cad_apply_commands`;
 * - exit codes: 0 success, 1 compile/validation error, 2 usage error.
 */

import { basename } from "node:path";
import { fail, ok, type ParseResult } from "@slopcad/cad-core";
import { isValidElement } from "react";
import type { ReactElement } from "react";

import { DEFAULT_NATIVE_DOCUMENT_ID } from "./native";

/** The repo's native-fixture extension, appended to extensionless --out paths. */
export const NATIVE_OUTPUT_EXTENSION = ".native.json";

/** The repo's command-batch extension, appended to extensionless --commands paths. */
export const COMMANDS_OUTPUT_EXTENSION = ".commands.json";

/** The CLI's contract, printed by `--help` and by usage errors. */
export const compileCliHelp = `Usage: pnpm --filter @slopcad/cad-jsx compile <model.tsx> [--out <path>] [--commands <path>]

Compiles a JSX-authored CAD model to the native slopcad document format's
canonical text: two-space-indented JSON with a trailing newline. The output
is the exact string the documents API stores as nativeContent and the
workbench opens — pipe it, or import the --out file as raw JSON text.

The model file's default export is rendered: a React element, or a
component function (invoked once with no props).

Options:
  --out <path>  additionally write the native JSON to <path>; a path with
                no extension gains the "${NATIVE_OUTPUT_EXTENSION}" extension
  --commands <path>
                additionally write the emission's command batch (every
                committed transaction's commands, in order) as a JSON
                array to <path>; a path with no extension gains the
                "${COMMANDS_OUTPUT_EXTENSION}" extension
  --help        show this help

Exit codes: 0 success; 1 compile or validation error (message on stderr);
2 usage error.`;

/** The parsed command line. */
export interface CompileArguments {
  /** The model file path, exactly as given (resolved to absolute by the entry). */
  readonly modelPath: string;
  /** The resolved output file path, or undefined for stdout only. */
  readonly outPath: string | undefined;
  /** The resolved command-batch file path, or undefined for none. */
  readonly commandsPath: string | undefined;
}

/** What {@link parseCompileArguments} makes of an argv slice. */
export type CompileArgumentResult =
  | { readonly kind: "help" }
  | { readonly kind: "parsed"; readonly arguments: CompileArguments }
  | { readonly kind: "usageError"; readonly message: string };

/**
 * Parses the CLI's arguments (the argv slice after the script path).
 * Accepts exactly one model path, at most one `--out <path>`, and at most
 * one `--commands <path>`; anything else — unknown flags, a flag missing
 * its value, a repeated flag, extra positionals — is a usage error.
 */
export function parseCompileArguments(
  argv: readonly string[],
): CompileArgumentResult {
  const paths: Record<"--out" | "--commands", string | undefined> = {
    "--out": undefined,
    "--commands": undefined,
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--out" || arg === "--commands") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return {
          kind: "usageError",
          message: `The ${arg} flag needs a path value (usage: ${arg} <path>).`,
        };
      }
      if (paths[arg] !== undefined) {
        return {
          kind: "usageError",
          message: `The ${arg} flag may be given at most once.`,
        };
      }
      paths[arg] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      return { kind: "usageError", message: `Unknown flag "${arg}".` };
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    return {
      kind: "usageError",
      message: `Expected exactly one model path; got ${String(positional.length)} (${positional.join(" ")}).`,
    };
  }
  const modelPath = positional[0];
  if (modelPath === undefined) {
    return { kind: "usageError", message: "A model file path is required." };
  }
  const outPath = paths["--out"];
  const commandsPath = paths["--commands"];
  return {
    kind: "parsed",
    arguments: {
      modelPath,
      outPath: outPath === undefined ? undefined : resolveOutPath(outPath),
      commandsPath:
        commandsPath === undefined
          ? undefined
          : resolveOutPath(commandsPath, COMMANDS_OUTPUT_EXTENSION),
    },
  };
}

/**
 * Resolves an output path: a path whose basename carries no extension
 * gains `extension` (the repo's `.native.json` native-fixture extension by
 * default); anything else is taken verbatim (the caller stays in control
 * of the exact name).
 */
export function resolveOutPath(
  outPath: string,
  extension: string = NATIVE_OUTPUT_EXTENSION,
): string {
  if (basename(outPath).includes(".")) return outPath;
  return `${outPath}${extension}`;
}

/**
 * The command batch of a native emission's canonical text: every committed
 * transaction's serialized commands, in commit order, as two-space-indented
 * JSON with a trailing newline — read from the text itself, so the batch
 * is byte-for-byte the commands the native history carries. Fails when the
 * text is not a native document with a transaction log.
 */
export function nativeCommandBatchText(
  nativeText: string,
): ParseResult<string, CliModelError> {
  const batchError = (message: string): { ok: false; error: CliModelError } =>
    fail({
      code: CLI_MODEL_ERROR_CODES.commandBatchInvalid,
      message,
      input: nativeText,
    });
  let value: unknown;
  try {
    value = JSON.parse(nativeText);
  } catch (error) {
    return batchError(
      `The native text is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const history = recordField(value, "history");
  const transactions = recordField(history, "transactions");
  if (!Array.isArray(transactions)) {
    return batchError("The native text carries no history.transactions array.");
  }
  const commands: unknown[] = [];
  for (const [index, transaction] of transactions.entries()) {
    const batch = recordField(transaction, "commands");
    if (!Array.isArray(batch)) {
      return batchError(
        `The native history's transaction ${String(index)} carries no commands array.`,
      );
    }
    const entries: readonly unknown[] = batch;
    commands.push(...entries);
  }
  return ok(`${JSON.stringify(commands, null, 2)}\n`);
}

/** `value[key]` when `value` is a non-array object, else undefined. */
function recordField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * Derives the emitted document's id from the model file's name: the
 * basename without extension, sanitized into the id payload charset
 * (alphanumeric start; letters, digits, dot, underscore, hyphen inside)
 * and length, under the `doc_` prefix — each model file compiles to a
 * distinguishable document while the same file always derives the same
 * id. A basename with no usable payload characters falls back to the
 * default id.
 */
export function deriveDocumentId(modelPath: string): string {
  const stem = basename(modelPath).replace(/\.[^.]*$/, "");
  const sanitized = stem
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  const payload = sanitized.slice(0, 64);
  if (payload.length === 0) return DEFAULT_NATIVE_DOCUMENT_ID;
  return `doc_${payload}`;
}

/** Stable failure codes produced when a loaded model file cannot be rendered. */
export const CLI_MODEL_ERROR_CODES = {
  /** The module has no default export. */
  defaultMissing: "cadjsx-cli/model-default-missing",
  /** The default export is neither an element nor a component function. */
  defaultInvalid: "cadjsx-cli/model-default-invalid",
  /** The default-export component threw when invoked with no props. */
  componentThrew: "cadjsx-cli/model-component-threw",
  /** The component returned something that is not a model root element. */
  componentReturnInvalid: "cadjsx-cli/model-component-return-invalid",
  /** The native emission's text carries no readable command batch. */
  commandBatchInvalid: "cadjsx-cli/command-batch-invalid",
} as const;

export type CliModelErrorCode =
  (typeof CLI_MODEL_ERROR_CODES)[keyof typeof CLI_MODEL_ERROR_CODES];

/** Structured failure describing why a loaded model file was rejected. */
export interface CliModelError {
  readonly code: CliModelErrorCode;
  readonly message: string;
  readonly input: unknown;
}

/**
 * Renders a model module's default export into the element
 * `compileToNative` consumes: an element passes through; a function is
 * invoked once with no props (the documented CLI form for models authored
 * as components); anything else is rejected structurally, and a throwing
 * component never crashes the CLI.
 */
/**
 * A function element type: the loosest callable shape the no-props render
 * needs (the compiler's own `FunctionTag` discipline — `typeof` narrowed
 * the value to `Function`, the cast gives it the callable shape).
 */
type ComponentTag = (props: Record<string, unknown>) => unknown;

export function resolveModelExport(
  defaultExport: unknown,
): ParseResult<ReactElement<unknown>, CliModelError> {
  if (isValidElement(defaultExport)) {
    return ok(defaultExport);
  }
  if (typeof defaultExport === "function") {
    const component = defaultExport as ComponentTag;
    let returned: unknown;
    try {
      returned = component({});
    } catch (error) {
      return fail({
        code: CLI_MODEL_ERROR_CODES.componentThrew,
        message: `The default-export component threw when invoked with no props: ${error instanceof Error ? error.message : String(error)} — a CLI model must be pure (no hooks, no effects).`,
        input: defaultExport,
      });
    }
    if (isValidElement(returned)) {
      return ok(returned);
    }
    return fail({
      code: CLI_MODEL_ERROR_CODES.componentReturnInvalid,
      message: `The default-export component must return a React element; got ${typeof returned}.`,
      input: returned,
    });
  }
  return fail({
    code: CLI_MODEL_ERROR_CODES.defaultInvalid,
    message: `The model file's default export must be a React element or a component function; got ${defaultExport === null ? "null" : typeof defaultExport}.`,
    input: defaultExport,
  });
}
