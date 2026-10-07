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
 *    globalThis exposes ONLY what a model needs, and NONE of it from the
 *    host realm: a trusted bootstrap bridge script runs first in the new
 *    context, reads the host's gate values (the element-brand symbols, the
 *    forbidden-import refusal gate, the model-surface data) from the
 *    sandbox object, mirrors the whole model surface — React's
 *    `createElement`/`Fragment` behavior, every element tag, the authoring
 *    helpers — as VM-REALM implementations, then deletes the gates. Every
 *    callable the model can see is created inside the vm realm, so
 *    property traversal from the sandbox walks vm prototypes only (host
 *    `Function`/`Object` — and through them `process.getBuiltinModule` —
 *    are unreachable); the one host callable, the refusal gate, lives in a
 *    closure binding and always throws. The hand-built vm `require`
 *    resolves EXACTLY `"react"` and `"@slopcad/cad-jsx"` to vm-realm
 *    module mirrors — anything else (a `node:fs`, a network client,
 *    another workspace package) is a structured `forbidden-import`
 *    refusal relayed as a plain vm-realm error. The transpiled body AND
 *    the default-export render (a component's no-props invocation) run
 *    as one script under vm's synchronous `timeout` budget, and the
 *    render outcome lands in a plain data property the host reads after.
 *    That budget bounds exactly those two phases — not every model-code
 *    execution the pipeline performs: nested function components the
 *    compiler invokes during its host-side walk, and getters a model
 *    plants on thrown values or element props (read host-side by the
 *    loader's catch paths and the compiler's structural traversal), all
 *    execute outside the budget. That is a known authenticated-endpoint
 *    DoS surface, to be bounded separately. The vm context carries the
 *    standard ECMAScript builtins (Math, JSON, …) and NO host objects:
 *    no `process`, no `fs`, no `fetch`, no `Buffer`. This isolates
 *    honest models from accidents and vocabulary drift; it bounds what
 *    model code can REACH, not every conceivable side channel — the
 *    endpoint layer's session gate still owns who may submit source at
 *    all;
 * 3. **Rendering** the module's default export — an element, or a
 *    component function invoked once with no props (the CLI's contract,
 *    shared through `resolveModelExport`) — and compiling it through
 *    `compileToNative`.
 *
 * Hard limits: a source-size cap (`TSX_SOURCE_MAX_BYTES`) refuses
 * oversized submissions before the transform, and the evaluation — module
 * body and default-export render together — runs under vm's synchronous
 * `timeout` budget (`TSX_EVAL_TIMEOUT_MS`). The budget bounds exactly that
 * one script: a model that loops forever in its module body or its
 * default-export render is terminated and surfaced as a structured
 * `evaluation-failed` refusal. Two model-code paths still run outside it,
 * host-side and unbounded: the compiler's walk invokes nested function
 * components directly, and structural reads on thrown values and element
 * props fire model-planted getters — an infinite loop in either hangs the
 * host. That is a known authenticated-endpoint DoS surface, to be bounded
 * separately (the sandbox's budget does not cover it). Runaway model
 * recursion is additionally guarded: a stack overflow surfaces through
 * the same structured refusal, and the compiler's own walk caps tree
 * depth across elements, arrays, and prop data.
 *
 * Node-only by design (esbuild + `node:vm`); the package index never
 * re-exports this module, so browser bundles stay clean (import it as
 * `@slopcad/cad-jsx/loader`).
 */

import {
  CANONICAL_UNITS,
  DIMENSIONLESS_UNIT,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { ParseResult } from "@slopcad/cad-core";
import { transform } from "esbuild";
import { Fragment, createElement, isValidElement } from "react";
import { Script, runInNewContext } from "node:vm";
import type { CliModelError } from "./cli";
import type { CadJsxCompileError } from "./compiler";
import type { CompileToNativeOptions, NativeEmitError } from "./native";

import {
  CLI_MODEL_ERROR_CODES,
  modelComponentReturnInvalidMessage,
  modelComponentThrewMessage,
  modelDefaultInvalidMessage,
} from "./cli";
import {
  CAD_ELEMENT_BRAND,
  CAD_ELEMENT_KINDS,
  isCadElementTag,
} from "./elements";
import { compileToNative } from "./native";
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
 * The canonical forbidden-module message, in one place: the host gate's
 * error and the loader's structured refusal both render it, so a vm-relayed
 * refusal carries exactly what the class used to.
 */
function forbiddenImportMessage(specifier: string): string {
  return `A TSX model may import only "react" and "@slopcad/cad-jsx"; "${specifier}" is refused.`;
}

/**
 * The host gate's forbidden-module error. It NEVER crosses into the vm:
 * the vm `require` calls the gate only for disallowed specifiers, catches
 * the throw, and rethrows a plain vm-realm record carrying the name and
 * specifier — so even a model that catches its own refused import cannot
 * traverse into the host realm.
 */
class ForbiddenImportError extends Error {
  readonly specifier: string;

  constructor(specifier: string) {
    super(forbiddenImportMessage(specifier));
    this.name = "ForbiddenImportError";
    this.specifier = specifier;
  }
}

/** The host require gate: refuses every specifier the vm mirror does not resolve. Always throws. */
function forbiddenRefusal(specifier: string): never {
  throw new ForbiddenImportError(specifier);
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

/** Reads one string field off an unknown thrown value, structurally (vm errors are not host errors). */
function stringFieldOf(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate: unknown = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// The vm-realm mirror
//
// The invariant the sandbox enforces: NO host-realm object is reachable
// from the model's globalThis by property traversal. Every callable the
// model sees — `require`, `createElement`, every tag and helper — is a
// function created INSIDE the vm realm by the bootstrap bridge; the host
// values it needs (the element-brand symbols, the refusal gate) reach the
// bridge once through a sandbox property that is deleted before any model
// code runs, and thereafter live only in closure bindings. A model
// traversing `.constructor`/`__proto__` from any sandbox value walks vm
// prototypes and finds the vm's own intrinsics — never the host's
// `Function`, `Object`, or `process`.
// ---------------------------------------------------------------------------

/** The sandbox-global key the bootstrap bridge reads its host gates from, then deletes. */
const REALM_GATE_KEY = "__slopcad_cadjsx_gates__";

/** The sandbox-global the epilogue calls to render the default export (a vm-realm function). */
const RENDER_OUTCOME_KEY = "__slopcad_cadjsx_render_outcome__";

/** The sandbox-global the epilogue stores the render outcome in (a plain data property the host reads). */
const RENDER_RESULT_KEY = "__slopcad_cadjsx_outcome__";

/** One element tag of the model surface, as bootstrap data (primitives only). */
interface ModelTagRow {
  readonly name: string;
  readonly kind: string;
}

/**
 * The model-visible runtime surface, as bootstrap data: every element tag
 * the package index exports (discovered from the real tags, so the index
 * and the sandbox cannot drift), the kind registry, and the canonical
 * units the dimensional helpers default to.
 */
interface ModelSurface {
  readonly tags: readonly ModelTagRow[];
  readonly kinds: readonly string[];
  readonly canonicalUnits: {
    readonly length: string;
    readonly angle: string;
    readonly dimensionless: string;
  };
}

const MODEL_SURFACE: ModelSurface = (() => {
  const tags: ModelTagRow[] = [];
  for (const [name, value] of Object.entries(cadJsxRuntime)) {
    if (isCadElementTag(value)) tags.push({ name, kind: value.kind });
  }
  return {
    tags,
    kinds: [...CAD_ELEMENT_KINDS],
    canonicalUnits: {
      length: CANONICAL_UNITS.length,
      angle: CANONICAL_UNITS.angle,
      dimensionless: DIMENSIONLESS_UNIT,
    },
  };
})();

/**
 * The host values the bootstrap bridge consumes. Primitives cross as-is;
 * {@link RealmGates.refuseImport} is the ONLY host callable and always
 * throws — its return type is `never`, so no host value can flow back into
 * the vm through it.
 */
interface RealmGates {
  /** React's element brand (`$$typeof`), read off a host element so it tracks the installed React. */
  readonly elementBrand: symbol;
  /** React's `Fragment` value (a registered symbol primitive on every React this package supports). */
  readonly fragment: unknown;
  /** The cad-jsx element-tag brand symbol. */
  readonly cadBrand: symbol;
  /** The forbidden-import refusal gate. */
  readonly refuseImport: (specifier: string) => never;
  /** {@link MODEL_SURFACE} as JSON — parsed vm-side, so no host object crosses. */
  readonly surfaceJson: string;
}

/**
 * Assembles the bootstrap gates. Fails (structurally) only if the
 * installed React's `createElement` does not brand its elements with a
 * symbol — pinned React never does, and the sandbox refuses to mirror an
 * unbrandable element surface.
 */
function realmGates(): {
  readonly ok: true;
  readonly gates: RealmGates;
} | {
  readonly ok: false;
  readonly message: string;
} {
  const brandProbe: unknown = createElement("slopcad-cadjsx-brand-probe");
  const elementBrand =
    typeof brandProbe === "object" && brandProbe !== null
      ? (brandProbe as { readonly $$typeof?: unknown }).$$typeof
      : undefined;
  if (typeof elementBrand !== "symbol") {
    return {
      ok: false,
      message:
        "The model sandbox could not be initialized: the installed React's createElement does not brand elements with a symbol.",
    };
  }
  return {
    ok: true,
    gates: {
      elementBrand,
      fragment: Fragment,
      cadBrand: CAD_ELEMENT_BRAND,
      refuseImport: forbiddenRefusal,
      surfaceJson: JSON.stringify(MODEL_SURFACE),
    },
  };
}

/**
 * The bootstrap bridge: the first script the fresh context runs, before
 * any model code exists. It reads the gates out of the sandbox object,
 * DELETES them, and builds the entire model surface as vm-realm
 * implementations:
 *
 * - element tags: functions that throw when invoked (model data, never
 *   renderable — the host tags' contract), carrying the cad-jsx brand
 *   symbol and `kind` string the compiler dispatches on;
 * - `createElement`: the classic-transform factory, mirroring React's
 *   props/children/key handling and freezing element and props like React
 *   does, producing plain vm-realm elements the host pipeline reads
 *   structurally (`$$typeof` is the registry symbol, so React's own
 *   `isValidElement` accepts them);
 * - `Fragment`: the installed React's Fragment value passed through as a
 *   primitive — the registered `react.fragment` symbol on every React
 *   this package supports; a callable Fragment (a React the sandbox
 *   cannot mirror without bridging model calls into the host realm) is
 *   refused loudly instead of wrapped;
 * - `length`/`angle`/`dimensionless`: the cad-core quantity constructors'
 *   record shape (cad-core validates units structurally downstream, not
 *   at construction);
 * - `require`: resolves `"react"` and `"@slopcad/cad-jsx"` to frozen
 *   vm-realm module mirrors; anything else calls the refusal gate — whose
 *   throw is caught and relayed as a null-prototype vm error, so the host
 *   error object never becomes a model-reachable value;
 * - `module`/`exports`: vm-realm records for the CommonJS transpile
 *   output;
 * - the render-outcome function the eval epilogue calls.
 *
 * After this script, the gates are gone; nothing left on globalThis has a
 * host prototype.
 */
const SANDBOX_BRIDGE_SOURCE = `"use strict";
(function () {
  var gates = globalThis[${JSON.stringify(REALM_GATE_KEY)}];
  delete globalThis[${JSON.stringify(REALM_GATE_KEY)}];
  var elementBrand = gates.elementBrand;
  var cadBrand = gates.cadBrand;
  var refuseImport = gates.refuseImport;
  var surface = JSON.parse(gates.surfaceJson);

  function makeTag(kind) {
    var tag = function () {
      throw new Error('The CAD element "' + kind + '" is model data for compileModel from "@slopcad/cad-jsx", not a renderable component; it must never be invoked.');
    };
    tag[cadBrand] = true;
    tag.kind = kind;
    return Object.freeze(tag);
  }

  function defineCadElement(kind) {
    if (typeof kind !== "string" || kind.length === 0) {
      throw new Error("A CAD element kind must be a non-empty string (the compiler dispatches on it).");
    }
    return makeTag(kind);
  }

  function isCadElementTag(tag) {
    if (typeof tag !== "function") return false;
    if (tag[cadBrand] !== true) return false;
    return typeof tag.kind === "string";
  }

  function requireFiniteMagnitude(magnitude) {
    if (!Number.isFinite(magnitude)) {
      throw new Error("A dimensional value magnitude must be a finite number, received " + String(magnitude) + ".");
    }
  }

  function length(value, unit) {
    requireFiniteMagnitude(value);
    return Object.freeze({ dimension: "length", unit: unit === undefined ? surface.canonicalUnits.length : unit, value: value });
  }

  function angle(value, unit) {
    requireFiniteMagnitude(value);
    return Object.freeze({ dimension: "angle", unit: unit === undefined ? surface.canonicalUnits.angle : unit, value: value });
  }

  function dimensionless(value) {
    requireFiniteMagnitude(value);
    return Object.freeze({ dimension: "dimensionless", unit: surface.canonicalUnits.dimensionless, value: value });
  }

  function createElement(type, config) {
    var key = null;
    var ref = null;
    var props = {};
    if (config !== null && config !== undefined) {
      if (config.key !== undefined) key = "" + config.key;
      if (config.ref !== undefined) ref = config.ref;
      var names = Object.keys(config);
      for (var index = 0; index < names.length; index += 1) {
        var name = names[index];
        if (name !== "key" && name !== "ref") props[name] = config[name];
      }
    }
    var extra = arguments.length - 2;
    if (extra === 1) {
      props.children = arguments[2];
    } else if (extra > 1) {
      var children = new Array(extra);
      for (var child = 0; child < extra; child += 1) children[child] = arguments[child + 2];
      props.children = children;
    }
    var element = { $$typeof: elementBrand, type: type, key: key, ref: ref, props: props, _owner: null };
    Object.freeze(props);
    Object.freeze(element);
    return element;
  }

  var fragment = gates.fragment;
  if (typeof fragment === "function") {
    throw new Error("The installed React's Fragment is a function; the model sandbox mirrors only the 'react.fragment' registered symbol and refuses a callable Fragment rather than bridge model calls into the host realm.");
  }

  var reactModule = Object.freeze({ Fragment: fragment, createElement: createElement });

  var cadJsxModule = {};
  var tagRows = surface.tags;
  for (var row = 0; row < tagRows.length; row += 1) {
    var tag = makeTag(tagRows[row].kind);
    cadJsxModule[tagRows[row].name] = tag;
    globalThis[tagRows[row].name] = tag;
  }
  cadJsxModule.defineCadElement = defineCadElement;
  cadJsxModule.isCadElementTag = isCadElementTag;
  cadJsxModule.CAD_ELEMENT_KINDS = Object.freeze(surface.kinds.slice());
  cadJsxModule.length = length;
  cadJsxModule.angle = angle;
  cadJsxModule.dimensionless = dimensionless;
  Object.freeze(cadJsxModule);
  globalThis.defineCadElement = defineCadElement;
  globalThis.isCadElementTag = isCadElementTag;
  globalThis.CAD_ELEMENT_KINDS = cadJsxModule.CAD_ELEMENT_KINDS;
  globalThis.length = length;
  globalThis.angle = angle;
  globalThis.dimensionless = dimensionless;

  globalThis.Fragment = fragment;
  globalThis.createElement = createElement;

  function vmRequire(specifier) {
    if (specifier === "react") return reactModule;
    if (specifier === "@slopcad/cad-jsx") return cadJsxModule;
    try {
      refuseImport(specifier);
    } catch (refusal) {
      var relayed = Object.create(null);
      relayed.name = typeof refusal.name === "string" ? refusal.name : "ForbiddenImportError";
      relayed.message = typeof refusal.message === "string" ? refusal.message : String(refusal);
      relayed.specifier = specifier;
      throw relayed;
    }
  }
  globalThis.require = vmRequire;

  var moduleRecord = { exports: {} };
  globalThis.module = moduleRecord;
  globalThis.exports = moduleRecord.exports;

  function isElementValue(value) {
    return typeof value === "object" && value !== null && value.$$typeof === elementBrand;
  }

  function renderOutcome(value) {
    if (isElementValue(value)) return { ok: true, element: value };
    if (typeof value === "function") {
      var returned;
      try {
        returned = value({});
      } catch (error) {
        return { ok: false, reason: "component-threw", text: error instanceof Error ? error.message : String(error), input: value };
      }
      if (isElementValue(returned)) return { ok: true, element: returned };
      return { ok: false, reason: "component-return-invalid", text: typeof returned, input: returned };
    }
    return { ok: false, reason: "default-invalid", text: value === null ? "null" : typeof value, input: value };
  }

  globalThis[${JSON.stringify(RENDER_OUTCOME_KEY)}] = renderOutcome;
})();`;

/** The bootstrap bridge script, compiled once at module load (compilation executes nothing). */
const SANDBOX_BRIDGE = new Script(SANDBOX_BRIDGE_SOURCE);

/**
 * The eval epilogue, appended to every transpiled model: renders the
 * default export and stores the outcome as a plain, configurable data
 * property on the vm global. Running INSIDE the budgeted script is the
 * point — a component that loops forever (or a getter trap planted on
 * `module.exports`) dies on the vm timeout instead of hanging the host's
 * post-run reads, and `defineProperty` replaces any accessor a hostile
 * model planted on the outcome key with a value property, so the host's
 * only read after the run cannot execute vm code.
 */
const MODEL_EVAL_EPILOGUE = `
;Object.defineProperty(globalThis, ${JSON.stringify(RENDER_RESULT_KEY)}, { configurable: true, value: globalThis[${JSON.stringify(RENDER_OUTCOME_KEY)}](module.exports.default) });
`;

/**
 * The render outcome the epilogue hands the host: a plain vm-realm record
 * read structurally (it is model-context data, so its shape is verified
 * before use).
 */
type VmRenderOutcome =
  | { readonly ok: true; readonly element: unknown }
  | {
      readonly ok: false;
      readonly reason:
        | "default-invalid"
        | "component-threw"
        | "component-return-invalid";
      readonly text: string;
      readonly input: unknown;
    };

/** Narrows the raw outcome value into a {@link VmRenderOutcome}, or `undefined` when the shape does not match. */
function readRenderOutcome(value: unknown): VmRenderOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { readonly ok?: unknown };
  if (record.ok === true) {
    return {
      ok: true,
      element: (value as { readonly element?: unknown }).element,
    };
  }
  if (record.ok !== false) return undefined;
  const outcome = value as {
    readonly reason?: unknown;
    readonly text?: unknown;
    readonly input?: unknown;
  };
  if (
    (outcome.reason === "default-invalid" ||
      outcome.reason === "component-threw" ||
      outcome.reason === "component-return-invalid") &&
    typeof outcome.text === "string"
  ) {
    return {
      ok: false,
      reason: outcome.reason,
      text: outcome.text,
      input: outcome.input,
    };
  }
  return undefined;
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

  // The sandbox: a fresh vm context whose only host contact is the one
  // bootstrap gates object — the bridge reads it, mirrors the model
  // surface with vm-realm implementations, and deletes it before any
  // model code exists.
  const gates = realmGates();
  if (!gates.ok) {
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message: gates.message,
    });
  }
  const budget = timeoutMs ?? TSX_EVAL_TIMEOUT_MS;
  const sandbox: Record<string, unknown> = { [REALM_GATE_KEY]: gates.gates };
  try {
    SANDBOX_BRIDGE.runInNewContext(sandbox, { timeout: budget });
  } catch (error) {
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message: `The model sandbox could not be initialized: ${messageOf(error)}`,
    });
  }
  if (typeof sandbox[RENDER_OUTCOME_KEY] !== "function") {
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message:
        "The model sandbox could not be initialized: the render bridge is missing.",
    });
  }

  try {
    // One script, one budget: the module body AND the default-export
    // render (see MODEL_EVAL_EPILOGUE). The second runInNewContext on the
    // same sandbox object reuses the bootstrap's context, globals intact.
    runInNewContext(`${transpiled}${MODEL_EVAL_EPILOGUE}`, sandbox, {
      timeout: budget,
    });
  } catch (error) {
    // The vm `require` relays forbidden-import refusals as plain
    // vm-realm records (name + specifier — never the host error object);
    // read them structurally. vm-thrown errors (a timeout, or an Error
    // the model raised) are likewise vm-realm, so every field is read
    // structurally.
    const specifier = stringFieldOf(error, "specifier");
    if (
      stringFieldOf(error, "name") === "ForbiddenImportError" &&
      specifier !== undefined
    ) {
      return fail({
        code: TSX_LOAD_ERROR_CODES.forbiddenImport,
        input: specifier,
        message: forbiddenImportMessage(specifier),
      });
    }
    const message = messageOf(error);
    const timedOut = message.includes("Script execution timed out");
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message: timedOut
        ? `The model exceeded its ${String(budget)} ms evaluation budget.`
        : `The model threw while being evaluated: ${message}`,
    });
  }

  const outcome = readRenderOutcome(sandbox[RENDER_RESULT_KEY]);
  if (outcome === undefined) {
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message: "The model sandbox returned no render outcome.",
    });
  }
  if (!outcome.ok) {
    // The vm-side render mirrors resolveModelExport's three refusals;
    // the messages come from cli.ts so both sides stay byte-identical.
    const code =
      outcome.reason === "default-invalid"
        ? CLI_MODEL_ERROR_CODES.defaultInvalid
        : outcome.reason === "component-threw"
          ? CLI_MODEL_ERROR_CODES.componentThrew
          : CLI_MODEL_ERROR_CODES.componentReturnInvalid;
    const message =
      outcome.reason === "default-invalid"
        ? modelDefaultInvalidMessage(outcome.text)
        : outcome.reason === "component-threw"
          ? modelComponentThrewMessage(outcome.text)
          : modelComponentReturnInvalidMessage(outcome.text);
    return fail({ code, input: outcome.input, message });
  }
  // Double-check the element with React's own validator: the outcome is
  // model-context data, so its shape is verified before the compile walk.
  if (!isValidElement(outcome.element)) {
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message:
        "The model's default export rendered to something that is not a React element.",
    });
  }
  // The compile walk caps tree depth (elements, arrays, and prop data
  // alike), so a domain failure surfaces as a structured error above.
  // Anything that still throws here — e.g. a stack overflow in a
  // structural read the caps do not cover — must not escape the loader:
  // it surfaces through the same structured refusal as the evaluation
  // phase.
  let native: ParseResult<string, CadJsxCompileError | NativeEmitError>;
  try {
    native = compileToNative(outcome.element, nativeOptions);
  } catch (error) {
    return fail({
      code: TSX_LOAD_ERROR_CODES.evaluationFailed,
      input: source,
      message: `The model threw while being compiled: ${messageOf(error)}`,
    });
  }
  if (!native.ok) return fail(native.error);
  return ok(native.value);
}
