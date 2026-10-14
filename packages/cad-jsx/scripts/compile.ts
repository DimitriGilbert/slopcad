/**
 * The `compile` CLI entry (Phase 3): compiles a JSX-authored CAD model
 * file to the native `slopcad` document format's canonical text.
 *
 * Run: `pnpm --filter @slopcad/cad-jsx compile <model.tsx> [--out <path>]
 * [--commands <path>]`
 * (tsx executes the entry — the runner pattern apps/web's `tsx scripts/*.ts`
 * scripts set; Node alone cannot import the workspace's TypeScript source,
 * whose extensionless relative imports node ESM refuses).
 *
 * Loading an authored `.tsx` model needs a real JSX transform (Node's
 * type stripping transforms types only, and tsx's tsconfig-driven JSX
 * runtime choice cannot reach model files outside this package), so the
 * loader transpiles the model source through esbuild — the same transform
 * engine the repo's vite/vitest toolchain runs on, pinned to the version
 * already in the lockfile — into a sibling temporary `.mjs` file (same
 * directory, so the module's own imports resolve against the model's
 * node_modules), imports it, and removes it again. No dev server, no
 * watcher.
 *
 * The decisions live in `../src/cli.ts` (unit-tested there); this entry is
 * the I/O shell: parse argv, load the model module, render its default
 * export, compile to native, write stdout (always), the --out file and
 * the --commands batch file (when requested), and exit with the
 * documented code — 0 success, 1 compile/validation error, 2 usage error.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

import { compileToNative } from "../src/native";
import {
  CLI_MODEL_ERROR_CODES,
  compileCliHelp,
  deriveDocumentId,
  nativeCommandBatchText,
  parseCompileArguments,
  resolveModelExport,
} from "../src/cli";

/** The exit codes the CLI contract documents. */
const EXIT_SUCCESS = 0;
const EXIT_MODEL_ERROR = 1;
const EXIT_USAGE_ERROR = 2;

/** Writes one line to stderr and exits with the given code. */
function failWith(code: number, message: string): never {
  process.stderr.write(`cadjsx compile: ${message}\n`);
  process.exit(code);
}

/**
 * Loads a `.ts`/`.tsx` model file as a module: esbuild transpiles the
 * source (automatic JSX runtime) into a hidden sibling `.mjs` file so the
 * module's bare imports resolve exactly as they would from the model
 * itself, node imports the sibling, and the sibling is removed whether or
 * not the import succeeded.
 */
async function loadModelModule(modelPath: string): Promise<unknown> {
  const source = await readFile(modelPath, "utf8");
  const transpiled = await transform(source, {
    loader: "tsx",
    jsx: "automatic",
    format: "esm",
    sourcefile: modelPath,
  });
  const tempPath = join(
    dirname(modelPath),
    `.${basename(modelPath)}.${process.pid}.mjs`,
  );
  try {
    await writeFile(tempPath, transpiled.code, "utf8");
    return await import(pathToFileURL(tempPath).href);
  } finally {
    await rm(tempPath, { force: true });
  }
}

const parsed = parseCompileArguments(process.argv.slice(2));
if (parsed.kind === "help") {
  process.stdout.write(`${compileCliHelp}\n`);
  process.exit(EXIT_SUCCESS);
}
if (parsed.kind === "usageError") {
  process.stderr.write(
    `cadjsx compile: ${parsed.message}\n\n${compileCliHelp}\n`,
  );
  process.exit(EXIT_USAGE_ERROR);
}

const modelPath = resolve(parsed.arguments.modelPath);
let modelModule: unknown;
try {
  modelModule = await loadModelModule(modelPath);
} catch (error) {
  failWith(
    EXIT_MODEL_ERROR,
    `the model file "${modelPath}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
  );
}
const defaultExport: unknown =
  typeof modelModule === "object" &&
  modelModule !== null &&
  "default" in modelModule
    ? (modelModule as Record<string, unknown>).default
    : undefined;
if (defaultExport === undefined) {
  failWith(
    EXIT_MODEL_ERROR,
    `${CLI_MODEL_ERROR_CODES.defaultMissing}: the model file "${modelPath}" has no default export (export the model element or its component as the default).`,
  );
}
const model = resolveModelExport(defaultExport);
if (!model.ok) {
  failWith(EXIT_MODEL_ERROR, `${model.error.code}: ${model.error.message}`);
}

const native = compileToNative(model.value, {
  documentId: deriveDocumentId(modelPath),
});
if (!native.ok) {
  const pathNote =
    "path" in native.error ? ` @ ${native.error.path.join(" > ")}` : "";
  failWith(
    EXIT_MODEL_ERROR,
    `${native.error.code}: ${native.error.message}${pathNote}`,
  );
}

/** Writes `text` to `path` (parents created) and notes it on stderr. */
async function writeOutput(path: string, text: string): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
  process.stderr.write(`cadjsx compile: wrote ${absolute}\n`);
}

const batch =
  parsed.arguments.commandsPath === undefined
    ? undefined
    : nativeCommandBatchText(native.value);
if (batch !== undefined && !batch.ok) {
  failWith(EXIT_MODEL_ERROR, `${batch.error.code}: ${batch.error.message}`);
}

process.stdout.write(native.value);
if (parsed.arguments.outPath !== undefined) {
  await writeOutput(parsed.arguments.outPath, native.value);
}
if (parsed.arguments.commandsPath !== undefined && batch !== undefined) {
  await writeOutput(parsed.arguments.commandsPath, batch.value);
}
process.exit(EXIT_SUCCESS);
