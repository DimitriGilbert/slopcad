/**
 * The JSX model compiler: lowers a React element tree authored with the
 * element vocabulary (`./elements.ts`) onto the Phase 7 command vocabulary
 * of `@slopcad/cad-core`.
 *
 * ## No second parametric representation (the hard rule)
 *
 * `compileModel` is a pure tree walk over plain `ReactElement` data. It
 * interprets nothing geometrically: every recognized element becomes
 * `parameter.create` / `parameter.set` / `body.create` / `feature.create`
 * commands — built in the canonical serialized wire form and re-parsed
 * through `parseCommand`, so the output is exactly the vocabulary
 * `applyCommand` (the sole interpreter, in cad-core) executes. There is no
 * parallel model, graph, or evaluator here to keep in sync.
 *
 * ## Determinism
 *
 * The walk consults no clock, randomness, or environment: the same element
 * tree compiles to a byte-identical transaction (ids are derived from
 * element kinds, occurrence counters, explicit `id` props, and `<Parameter>`
 * names, in document order). Registries are maps keyed for lookup only —
 * never iterated to produce output — so no map iteration order leaks into
 * the result.
 *
 * ## What the walk accepts
 *
 * - CAD element tags from this package (dispatch on the branded `kind`);
 * - user function components (invoked once with their props, which must be
 *   plain serializable data; the returned node is walked recursively);
 * - React Fragments (transparent pass-through of children);
 * - arrays of children (flattened in order);
 * - `null` / `undefined` / `true` / `false` children (conditional authoring).
 *
 * Everything else — class components, string (HTML) tags, functions or
 * promises or non-finite numbers in props, unknown element kinds, bodies
 * nested in containers, ambiguous translate targets — is rejected with a
 * structured {@link CadJsxCompileError} carrying the tree `path`; domain
 * errors never throw.
 */

import {
  CAD_DOCUMENT_FORMAT_VERSION,
  fail,
  isExpressionIdentifierName,
  length,
  ok,
  parseBodyId,
  parseCommand,
  parseDimensionalValue,
  parseFeatureId,
  parseParameterId,
  serializeDimensionalValueResult,
} from "@slopcad/cad-core";
import type {
  AnyDimensionalValue,
  BodyId,
  CadCommand,
  CadTransaction,
  FeatureId,
  ParameterId,
  ParseFailure,
  ParseResult,
  SerializedCadCommand,
  SerializedDimensionalValue,
} from "@slopcad/cad-core";
import { Fragment, isValidElement } from "react";
import type { ReactElement } from "react";

import { isCadElementTag } from "./elements";

/** Stable failure codes produced when a model is rejected at compile time. */
export const CAD_JSX_ERROR_CODES = {
  rootInvalid: "cadjsx/root-invalid",
  elementTypeUnknown: "cadjsx/element-type-unknown",
  stringTagRejected: "cadjsx/string-tag-rejected",
  classComponentRejected: "cadjsx/class-component-rejected",
  kindUnsupported: "cadjsx/kind-unsupported",
  propsInvalid: "cadjsx/props-invalid",
  propUnknown: "cadjsx/prop-unknown",
  propValueInvalid: "cadjsx/prop-value-invalid",
  idInvalid: "cadjsx/id-invalid",
  idConflict: "cadjsx/id-conflict",
  parameterNameConflict: "cadjsx/parameter-name-conflict",
  parameterUnknown: "cadjsx/parameter-unknown",
  childInvalid: "cadjsx/child-invalid",
  childrenUnexpected: "cadjsx/children-unexpected",
  componentThrew: "cadjsx/component-threw",
  componentReturnInvalid: "cadjsx/component-return-invalid",
  translateTargetInvalid: "cadjsx/translate-target-invalid",
  bodyProducerConflict: "cadjsx/body-producer-conflict",
  bodyNested: "cadjsx/body-nested",
  treeTooDeep: "cadjsx/tree-too-deep",
  commandInvalid: "cadjsx/command-invalid",
} as const;

export type CadJsxErrorCode =
  (typeof CAD_JSX_ERROR_CODES)[keyof typeof CAD_JSX_ERROR_CODES];

/**
 * Structured failure describing why a model was rejected. `path` locates
 * the failing element in the tree — segments name the root (`<root>`),
 * elements (`<Box>`), invoked components (`Plate`), fragments
 * (`Fragment`), and array slots (`children[2]`).
 */
export interface CadJsxCompileError extends ParseFailure {
  readonly code: CadJsxErrorCode;
  readonly path: readonly string[];
}

/** The primitive feature kinds the bridge reads length parameters for, in the input order it reads them. */
const PRIMITIVE_DIMENSIONS: Readonly<
  Record<"box" | "sphere" | "cylinder" | "cone", readonly string[]>
> = {
  box: ["width", "depth", "height"],
  sphere: ["radius"],
  cylinder: ["radius", "height"],
  cone: ["bottomRadius", "topRadius", "height"],
};

/** The translate offsets, in the input order the bridge reads them. */
const TRANSLATE_DIMENSIONS = ["x", "y", "z"] as const;

/** Guards the walk against runaway recursion (a component returning itself forever). */
const MAX_TREE_DEPTH = 100;

/** One input a feature declares, in wire shape. */
type WireInput =
  | { readonly kind: "parameter"; readonly id: ParameterId }
  | { readonly kind: "feature"; readonly id: FeatureId };

/** A resolved dimensional prop: a literal quantity or a reference to a declared parameter. */
type ResolvedDimension =
  | { readonly kind: "value"; readonly value: AnyDimensionalValue }
  | { readonly kind: "ref"; readonly id: ParameterId };

/** A compiled node's solid producers, identified by their feature ids. */
interface ProducerRef {
  readonly featureId: FeatureId;
}

/** A compiled node's contribution: which producers its subtree declared. */
interface NodeResult {
  readonly producers: readonly ProducerRef[];
}

const EMPTY_RESULT: NodeResult = { producers: [] };

/** The `<Body>` capture state: the body awaiting its single producing child. */
interface BodyCapture {
  readonly bodyId: BodyId;
  captured: boolean;
}

/** Everything the walk accumulates; lookup-only maps, append-only command list. */
interface CompileState {
  readonly commands: SerializedCadCommand[];
  /** Every id claimed so far (one id space across kinds), with a description. */
  readonly claimedIds: Map<string, string>;
  /** Declared parameters by id (value: the declared name). */
  readonly parameters: Map<ParameterId, string>;
  /** Parameter names by id, for the duplicate-name gate. */
  readonly parameterNames: Map<string, ParameterId>;
  /** Element kind occurrence counters feeding the default slug scheme. */
  readonly occurrences: Map<string, number>;
}

/** Threading state of the walk. */
interface WalkContext {
  readonly path: readonly string[];
  readonly depth: number;
  /** Active while an ancestor `<Body>` awaits its single producing child. */
  readonly capture: BodyCapture | undefined;
  /** True while an ancestor `<Body>` or `<Translate>` is collecting children. */
  readonly withinContainer: boolean;
}

function compileError(
  code: CadJsxErrorCode,
  message: string,
  path: readonly string[],
  input: unknown = null,
): CadJsxCompileError {
  return { code, message, input, path: [...path] };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** True for the child node forms React renders as nothing. */
function isIgnorableChild(node: unknown): boolean {
  return node === null || node === undefined || node === false || node === true;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A short deterministic description of a rejected node, for error messages. */
function describeNode(node: unknown): string {
  if (node === null) return "null";
  if (typeof node === "string") return `the string "${node}"`;
  return `a ${typeof node}`;
}

/**
 * The compiler entry point: walks the element tree and emits the canonical
 * command transaction, or a structured failure with the tree path. Pure
 * and deterministic; never throws for domain errors.
 */
export function compileModel(
  root: ReactElement<unknown>,
): ParseResult<CadTransaction, CadJsxCompileError> {
  if (!isValidElement(root)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.rootInvalid,
        "A model's root must be a React element (a CAD element tag, a user function component, or a Fragment).",
        ["<root>"],
        root,
      ),
    );
  }
  const state: CompileState = {
    commands: [],
    claimedIds: new Map(),
    parameters: new Map(),
    parameterNames: new Map(),
    occurrences: new Map(),
  };
  const walked = walkNode(
    root,
    {
      path: ["<root>"],
      depth: 0,
      capture: undefined,
      withinContainer: false,
    },
    state,
  );
  if (!walked.ok) return walked;
  // Round-trip guarantee: every command was built in the serialized wire
  // form; parseCommand re-validates it into the canonical CadCommand the
  // single interpreter executes.
  const commands: CadCommand[] = [];
  for (const [index, serialized] of state.commands.entries()) {
    const parsed = parseCommand(serialized);
    if (!parsed.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.commandInvalid,
          `The command emitted at index ${index} did not survive its own canonical parse: ${parsed.error.message}`,
          ["<root>"],
          serialized,
        ),
      );
    }
    commands.push(parsed.value);
  }
  return ok(Object.freeze({ commands: Object.freeze(commands) }));
}

/** Walks one node: nothing, an array, an element, or a rejected child. */
function walkNode(
  node: unknown,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  if (isIgnorableChild(node)) return ok(EMPTY_RESULT);
  if (Array.isArray(node)) {
    const producers: ProducerRef[] = [];
    for (const [index, child] of node.entries()) {
      const childCtx: WalkContext = {
        ...ctx,
        path: [...ctx.path, `children[${index}]`],
        depth: ctx.depth + 1,
      };
      const walked = walkNode(child, childCtx, state);
      if (!walked.ok) return walked;
      producers.push(...walked.value.producers);
    }
    return ok({ producers });
  }
  if (isValidElement(node)) {
    return walkElement(node, ctx, state);
  }
  return fail(
    compileError(
      CAD_JSX_ERROR_CODES.childInvalid,
      `A CAD model has no text or raw-value children; found ${describeNode(node)} (strings and numbers are rejected — author geometry with elements).`,
      ctx.path,
      node,
    ),
  );
}

/** Walks one element: dispatch on its type. */
function walkElement(
  element: ReactElement<unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  if (ctx.depth >= MAX_TREE_DEPTH) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.treeTooDeep,
        `The model tree exceeds the maximum depth of ${MAX_TREE_DEPTH} (often a component that returns itself); compilation stopped here.`,
        ctx.path,
      ),
    );
  }
  const tag: unknown = element.type;
  if (isCadElementTag<Record<string, unknown>>(tag)) {
    const elementCtx: WalkContext = {
      ...ctx,
      path: [...ctx.path, `<${tag.kind}>`],
    };
    const props = elementProps(element, elementCtx);
    if (!props.ok) return fail(props.error);
    return dispatchElement(tag.kind, props.value, elementCtx, state);
  }
  if (tag === Fragment) {
    const fragmentCtx: WalkContext = {
      ...ctx,
      path: [...ctx.path, "Fragment"],
    };
    const props = elementProps(element, fragmentCtx);
    if (!props.ok) return fail(props.error);
    for (const key of Object.keys(props.value)) {
      if (key !== "children") {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propsInvalid,
            `A Fragment carries only children; found the prop "${key}".`,
            fragmentCtx.path,
            props.value[key],
          ),
        );
      }
    }
    return walkNode(
      props.value.children,
      { ...fragmentCtx, depth: fragmentCtx.depth + 1 },
      state,
    );
  }
  if (typeof tag === "string") {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.stringTagRejected,
        `The string tag "<${tag}>" is an HTML/DOM tag; a CAD model is authored with the CAD element tags and function components from "@slopcad/cad-jsx".`,
        ctx.path,
        tag,
      ),
    );
  }
  if (typeof tag === "function") {
    // `typeof` narrowed the value to `Function`; the brand and Fragment
    // checks above did not match, so this is a function element type in
    // the React sense — the cast gives it the walk's callable shape.
    const functionTag = tag as FunctionTag;
    if (isClassComponent(functionTag)) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.classComponentRejected,
          "Class components are rejected: a CAD model must be pure data, authored with function components (no hooks, no render lifecycle).",
          ctx.path,
          Reflect.get(functionTag, "name"),
        ),
      );
    }
    return invokeComponent(functionTag, element, ctx, state);
  }
  return fail(
    compileError(
      CAD_JSX_ERROR_CODES.elementTypeUnknown,
      "The element's type is neither a CAD element tag, a function component, a Fragment, nor anything the compiler can resolve (memo/forwardRef/lazy wrappers and symbol tags are not walkable data).",
      ctx.path,
      element.type,
    ),
  );
}

/** Reads an element's props as a plain record (a runtime guard for smuggled input). */
function elementProps(
  element: ReactElement<unknown>,
  ctx: WalkContext,
): ParseResult<Record<string, unknown>, CadJsxCompileError> {
  if (!isPlainRecord(element.props)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propsInvalid,
        "An element's props must be a plain object.",
        ctx.path,
        element.props,
      ),
    );
  }
  return ok(element.props);
}

/** A function element type: the loosest callable shape the walk needs. */
type FunctionTag = (props: Record<string, unknown>) => unknown;

/**
 * Recognizes a class component the way React does: a function whose
 * prototype carries the `isReactComponent` marker (React sets it to an
 * empty object, so the check is for presence, not `true`).
 */
function isClassComponent(tag: FunctionTag): boolean {
  const prototype: unknown = Reflect.get(tag, "prototype");
  if (typeof prototype !== "object" || prototype === null) return false;
  return Reflect.get(prototype, "isReactComponent") !== undefined;
}

/** Invokes a user function component and walks what it returns. */
function invokeComponent(
  tag: FunctionTag,
  element: ReactElement<unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const props = elementProps(element, ctx);
  if (!props.ok) return fail(props.error);
  const rawName: unknown = Reflect.get(tag, "name");
  const componentName =
    typeof rawName === "string" && rawName.length > 0 ? rawName : "Anonymous";
  const componentCtx: WalkContext = {
    ...ctx,
    path: [...ctx.path, componentName],
    depth: ctx.depth + 1,
  };
  for (const [key, value] of Object.entries(props.value)) {
    const invalid = validatePropData(value, key, componentCtx.path);
    if (invalid !== undefined) return fail(invalid);
  }
  // The class-component guard above ran first, so `tag` is a plain
  // function at runtime; invoking it directly is the whole compile step.
  let returned: unknown;
  try {
    returned = tag(props.value);
  } catch (error) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.componentThrew,
        `The component "${componentName}" threw while being invoked as a pure function: ${messageOf(error)} — models must be pure (no hooks, no effects, no context).`,
        componentCtx.path,
        props.value,
      ),
    );
  }
  if (
    typeof returned === "string" ||
    typeof returned === "number" ||
    typeof returned === "bigint"
  ) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.componentReturnInvalid,
        `The component "${componentName}" returned ${typeof returned === "string" ? `the string "${returned}"` : `a raw ${typeof returned} value`}; a model component must return an element, an array of elements, or null — text and raw values are not model data.`,
        componentCtx.path,
        returned,
      ),
    );
  }
  return walkNode(
    returned,
    { ...componentCtx, depth: componentCtx.depth + 1 },
    state,
  );
}

/**
 * Validates that a user component's prop value is plain serializable data:
 * finite numbers, strings, booleans, null/undefined, arrays, plain objects,
 * and React elements. Functions (including promise `then` hooks), symbols,
 * bigints, NaN/Infinity, and class instances are rejected — the compiler
 * must be able to treat props as data.
 */
function validatePropData(
  value: unknown,
  label: string,
  path: readonly string[],
): CadJsxCompileError | undefined {
  if (value === null || value === undefined) return undefined;
  switch (typeof value) {
    case "boolean":
    case "string":
      return undefined;
    case "number":
      if (!Number.isFinite(value)) {
        return compileError(
          CAD_JSX_ERROR_CODES.propsInvalid,
          `The prop "${label}" is not a finite number (NaN and Infinity are rejected).`,
          path,
          value,
        );
      }
      return undefined;
    case "function":
      return compileError(
        CAD_JSX_ERROR_CODES.propsInvalid,
        `The prop "${label}" is a function; props must be plain serializable data (only the element type itself may be a function).`,
        path,
        value,
      );
    case "symbol":
    case "bigint":
      return compileError(
        CAD_JSX_ERROR_CODES.propsInvalid,
        `The prop "${label}" is a ${typeof value}; props must be plain serializable data.`,
        path,
        String(value),
      );
    case "object": {
      if (isValidElement(value)) return undefined;
      if (Array.isArray(value)) {
        for (const [index, entry] of value.entries()) {
          const invalid = validatePropData(entry, `${label}[${index}]`, path);
          if (invalid !== undefined) return invalid;
        }
        return undefined;
      }
      if (isPlainRecord(value)) {
        if (Object.getOwnPropertySymbols(value).length > 0) {
          return compileError(
            CAD_JSX_ERROR_CODES.propsInvalid,
            `The prop "${label}" carries symbol-keyed properties; props must be plain serializable data.`,
            path,
            value,
          );
        }
        for (const [key, entry] of Object.entries(value)) {
          const invalid = validatePropData(entry, `${label}.${key}`, path);
          if (invalid !== undefined) return invalid;
        }
        return undefined;
      }
      return compileError(
        CAD_JSX_ERROR_CODES.propsInvalid,
        `The prop "${label}" is not plain serializable data (class instances, Dates, Maps, Sets, and promises are rejected).`,
        path,
        value,
      );
    }
  }
}

/** Dispatches a recognized CAD element to its lowering. */
function dispatchElement(
  kind: string,
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  switch (kind) {
    case "parameter":
      return compileParameterElement(props, ctx, state);
    case "body":
      return compileBodyElement(props, ctx, state);
    case "translate":
      return compileTranslateElement(props, ctx, state);
    default:
      return compilePrimitiveElement(kind, props, ctx, state);
  }
}

/**
 * Rejects props outside `allowed` and — for childless elements — any
 * children; shared descriptor validation.
 */
function validateDescriptorProps(
  kind: string,
  props: Record<string, unknown>,
  allowed: readonly string[],
  childless: boolean,
  ctx: WalkContext,
): CadJsxCompileError | undefined {
  for (const key of Object.keys(props)) {
    if (!allowed.includes(key)) {
      return compileError(
        CAD_JSX_ERROR_CODES.propUnknown,
        `"${key}" is not a prop of <${kind}>; the accepted props are: ${allowed.join(", ")}.`,
        ctx.path,
        key,
      );
    }
  }
  if (childless && !isIgnorableChild(props.children)) {
    return compileError(
      CAD_JSX_ERROR_CODES.childrenUnexpected,
      `<${kind}> takes no children.`,
      ctx.path,
      props.children,
    );
  }
  return undefined;
}

/** Claims an id in the compile-wide id space, or fails with `id-conflict`. */
function claimId(
  state: CompileState,
  id: string,
  what: string,
  ctx: WalkContext,
): CadJsxCompileError | undefined {
  const existing = state.claimedIds.get(id);
  if (existing !== undefined) {
    return compileError(
      CAD_JSX_ERROR_CODES.idConflict,
      `The id "${id}" (${what}) is already claimed in this model by ${existing}; ids are one space across parameters, bodies, and features — give this element a distinct id.`,
      ctx.path,
      id,
    );
  }
  state.claimedIds.set(id, what);
  return undefined;
}

/** An element's identity: the slug feeding derived ids, plus the claimed explicit feature id when given. */
interface ElementIdentity {
  readonly slug: string;
  readonly explicitFeatureId: FeatureId | undefined;
}

/**
 * The element's slug: the explicit `id` prop's payload (validated and
 * claimed as a feature id), or `<kind>-<occurrence>` from the per-kind
 * counter. The slug feeds the derived parameter, body, and feature ids.
 */
function elementSlug(
  kind: string,
  rawId: unknown,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<ElementIdentity, CadJsxCompileError> {
  const occurrence = (state.occurrences.get(kind) ?? 0) + 1;
  state.occurrences.set(kind, occurrence);
  if (rawId === undefined) {
    return ok({ slug: `${kind}-${occurrence}`, explicitFeatureId: undefined });
  }
  if (typeof rawId !== "string") {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The id prop of <${kind}> must be a feature id string ("feat_…").`,
        ctx.path,
        rawId,
      ),
    );
  }
  const parsed = parseFeatureId(rawId);
  if (!parsed.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.idInvalid,
        `The id prop of <${kind}> is not a valid feature id: ${parsed.error.message}`,
        ctx.path,
        rawId,
      ),
    );
  }
  const claimed = claimId(
    state,
    parsed.value,
    `the explicit id of <${kind}> (occurrence ${occurrence})`,
    ctx,
  );
  if (claimed !== undefined) return fail(claimed);
  return ok({
    slug: rawId.slice(rawId.indexOf("_") + 1),
    explicitFeatureId: parsed.value,
  });
}

/** Resolves one dimensional prop: a number (mm), a quantity, or a parameter id reference. */
function resolveDimension(
  raw: unknown,
  prop: string,
  ctx: WalkContext,
): ParseResult<ResolvedDimension, CadJsxCompileError> {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The "${prop}" prop must be a finite number (NaN and Infinity are rejected).`,
          ctx.path,
          raw,
        ),
      );
    }
    return ok({ kind: "value", value: length(raw) });
  }
  if (typeof raw === "string") {
    const parsed = parseParameterId(raw);
    if (!parsed.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The "${prop}" prop's string value is read as a parameter id reference and must match the "param_…" wire format: ${parsed.error.message}`,
          ctx.path,
          raw,
        ),
      );
    }
    return ok({ kind: "ref", id: parsed.value });
  }
  if (isPlainRecord(raw)) {
    const parsedValue = parseDimensionalValue(raw);
    if (!parsedValue.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The "${prop}" prop is not a valid dimensional value: ${parsedValue.error.message}`,
          ctx.path,
          raw,
        ),
      );
    }
    if (parsedValue.value.dimension !== "length") {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The "${prop}" prop must be a length — the kernel bridge reads length parameters — but carries the dimension "${parsedValue.value.dimension}".`,
          ctx.path,
          raw,
        ),
      );
    }
    return ok({ kind: "value", value: parsedValue.value });
  }
  return fail(
    compileError(
      CAD_JSX_ERROR_CODES.propValueInvalid,
      `The "${prop}" prop must be a plain number (canonical millimetres), a dimensional quantity from "@slopcad/cad-core", or a "param_…" parameter id string.`,
      ctx.path,
      raw,
    ),
  );
}

/** The implicit parameter name derived from a slug and a dimension (`box-1` + `width` → `box1Width`). */
function implicitParameterName(slug: string, dimension: string): string {
  const sanitized = slug.replace(/[^A-Za-z0-9_]/g, "");
  const capitalized = dimension.charAt(0).toUpperCase() + dimension.slice(1);
  return `${sanitized}${capitalized}`;
}

/** Serializes a quantity to its canonical wire value, or fails structurally. */
function serializedValueOf(
  value: AnyDimensionalValue,
  ctx: WalkContext,
): ParseResult<SerializedDimensionalValue, CadJsxCompileError> {
  const serialized = serializeDimensionalValueResult(value);
  if (!serialized.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `A dimensional value cannot be serialized canonically: ${serialized.error.message}`,
        ctx.path,
        value,
      ),
    );
  }
  return ok(serialized.value);
}

/** Emits the implicit `parameter.create` for one dimension and returns its id. */
function emitImplicitParameter(
  slug: string,
  dimension: string,
  value: AnyDimensionalValue,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<ParameterId, CadJsxCompileError> {
  const raw = `param_${slug}-${dimension}`;
  const parsed = parseParameterId(raw);
  if (!parsed.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.idInvalid,
        `The implicit parameter id "${raw}" (derived from the element's id/slug) is not a valid parameter id: ${parsed.error.message} — shorten the explicit id or drop it.`,
        ctx.path,
        raw,
      ),
    );
  }
  const name = implicitParameterName(slug, dimension);
  const nameText: string = name;
  if (!isExpressionIdentifierName(name)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.idInvalid,
        `The implicit parameter name "${nameText}" (derived from the element's id/slug) is not a valid expression identifier; choose an explicit id whose payload starts with a letter.`,
        ctx.path,
        nameText,
      ),
    );
  }
  const claimed = claimId(
    state,
    parsed.value,
    `the implicit "${dimension}" parameter of the element with slug "${slug}"`,
    ctx,
  );
  if (claimed !== undefined) return fail(claimed);
  const nameConflict = registerParameterName(parsed.value, name, ctx, state);
  if (nameConflict !== undefined) return fail(nameConflict);
  // Register for later reference: a dimensional prop may point at an
  // implicit parameter exactly as it may point at a <Parameter>.
  state.parameters.set(parsed.value, name);
  const serialized = serializedValueOf(value, ctx);
  if (!serialized.ok) return fail(serialized.error);
  state.commands.push({
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    type: "parameter.create",
    id: parsed.value,
    name,
    value: serialized.value,
  });
  return ok(parsed.value);
}

/** Records a parameter name, failing on the same name under a different id. */
function registerParameterName(
  id: ParameterId,
  name: string,
  ctx: WalkContext,
  state: CompileState,
): CadJsxCompileError | undefined {
  const existing = state.parameterNames.get(name);
  if (existing !== undefined && existing !== id) {
    return compileError(
      CAD_JSX_ERROR_CODES.parameterNameConflict,
      `A parameter named "${name}" is already declared in this model (id "${existing}"); parameter names are the document's identifier vocabulary — rename one of them.`,
      ctx.path,
      name,
    );
  }
  state.parameterNames.set(name, id);
  return undefined;
}

/** Resolves one dimension to a feature input, emitting the implicit parameter when it is a literal. */
function dimensionInput(
  slug: string,
  dimension: string,
  raw: unknown,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<WireInput, CadJsxCompileError> {
  const resolved = resolveDimension(raw, dimension, ctx);
  if (!resolved.ok) return fail(resolved.error);
  if (resolved.value.kind === "ref") {
    if (!state.parameters.has(resolved.value.id)) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.parameterUnknown,
          `The "${dimension}" prop references parameter "${resolved.value.id}", which is not declared before this point in the tree — declare the <Parameter> above the element that consumes it.`,
          ctx.path,
          resolved.value.id,
        ),
      );
    }
    return ok({ kind: "parameter", id: resolved.value.id });
  }
  const parameterId = emitImplicitParameter(
    slug,
    dimension,
    resolved.value.value,
    ctx,
    state,
  );
  if (!parameterId.ok) return fail(parameterId.error);
  return ok({ kind: "parameter", id: parameterId.value });
}

/**
 * Emits the output `body.create` (unless a `<Body>` capture supplies the
 * output body) and the `feature.create`, returning the producer reference.
 * An explicit feature id (already claimed by {@link elementSlug}) is used
 * verbatim; a derived one is parsed and claimed here.
 */
function emitFeature(
  kind: string,
  slug: string,
  explicitFeatureId: FeatureId | undefined,
  inputs: readonly WireInput[],
  ctx: WalkContext,
  state: CompileState,
): ParseResult<ProducerRef, CadJsxCompileError> {
  let outputBodyId: BodyId;
  if (ctx.capture !== undefined) {
    if (ctx.capture.captured) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.bodyProducerConflict,
          `A <Body> may contain at most one producing element; a second producer (kind "${kind}") appeared after the body's shape was already declared.`,
          ctx.path,
        ),
      );
    }
    ctx.capture.captured = true;
    outputBodyId = ctx.capture.bodyId;
  } else {
    const rawBody = `body_${slug}`;
    const parsedBody = parseBodyId(rawBody);
    if (!parsedBody.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The implicit body id "${rawBody}" (derived from the element's id/slug) is not a valid body id: ${parsedBody.error.message} — shorten the explicit id or drop it.`,
          ctx.path,
          rawBody,
        ),
      );
    }
    const claimedBody = claimId(
      state,
      parsedBody.value,
      `the output body of the "${kind}" element with slug "${slug}"`,
      ctx,
    );
    if (claimedBody !== undefined) return fail(claimedBody);
    state.commands.push({
      formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
      type: "body.create",
      id: parsedBody.value,
      name: slug.replace(/-/g, " "),
    });
    outputBodyId = parsedBody.value;
  }
  let featureId: FeatureId;
  if (explicitFeatureId !== undefined) {
    featureId = explicitFeatureId;
  } else {
    const rawFeature = `feat_${slug}`;
    const parsedFeature = parseFeatureId(rawFeature);
    if (!parsedFeature.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The implicit feature id "${rawFeature}" (derived from the element's id/slug) is not a valid feature id: ${parsedFeature.error.message} — shorten the explicit id or drop it.`,
          ctx.path,
          rawFeature,
        ),
      );
    }
    const claimedFeature = claimId(
      state,
      parsedFeature.value,
      `the "${kind}" feature with slug "${slug}"`,
      ctx,
    );
    if (claimedFeature !== undefined) return fail(claimedFeature);
    featureId = parsedFeature.value;
  }
  state.commands.push({
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    type: "feature.create",
    id: featureId,
    kind,
    inputs: inputs.map((input) => ({ kind: input.kind, id: input.id })),
    outputs: [outputBodyId],
  });
  return ok({ featureId });
}

/** `<Box>`, `<Sphere>`, `<Cylinder>`, `<Cone>`: dimensions → parameters, then body + feature. */
function compilePrimitiveElement(
  kind: string,
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const dimensions =
    PRIMITIVE_DIMENSIONS[kind as "box" | "sphere" | "cylinder" | "cone"];
  if (dimensions === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.kindUnsupported,
        `The CAD element kind "${kind}" is not one this compiler version lowers to commands; the supported kinds are: parameter, body, box, sphere, cylinder, cone, translate.`,
        ctx.path,
        kind,
      ),
    );
  }
  const invalid = validateDescriptorProps(
    kind,
    props,
    [...dimensions, "id"],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  for (const dimension of dimensions) {
    if (props[dimension] === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The <${kind}> element requires the "${dimension}" prop.`,
          ctx.path,
          props[dimension],
        ),
      );
    }
  }
  const identity = elementSlug(kind, props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [];
  for (const dimension of dimensions) {
    const input = dimensionInput(
      identity.value.slug,
      dimension,
      props[dimension],
      ctx,
      state,
    );
    if (!input.ok) return fail(input.error);
    inputs.push(input.value);
  }
  const producer = emitFeature(
    kind,
    identity.value.slug,
    identity.value.explicitFeatureId,
    inputs,
    ctx,
    state,
  );
  if (!producer.ok) return fail(producer.error);
  return ok({ producers: [producer.value] });
}

/** `<Translate>`: its single producer's feature + three offset parameters. */
function compileTranslateElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "translate",
    props,
    [...TRANSLATE_DIMENSIONS, "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  const identity = elementSlug("translate", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  // The child produces its own standalone solid (its own body); only the
  // translate itself may be captured by an enclosing <Body>.
  const children = walkNode(
    props.children,
    {
      path: ctx.path,
      depth: ctx.depth + 1,
      capture: undefined,
      withinContainer: true,
    },
    state,
  );
  if (!children.ok) return fail(children.error);
  const producer = children.value.producers[0];
  if (children.value.producers.length !== 1 || producer === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.translateTargetInvalid,
        `A <Translate> needs exactly one producing child element (a primitive or another <Translate>); this one declares ${children.value.producers.length}.`,
        ctx.path,
      ),
    );
  }
  const inputs: WireInput[] = [{ kind: "feature", id: producer.featureId }];
  for (const dimension of TRANSLATE_DIMENSIONS) {
    const input = dimensionInput(
      identity.value.slug,
      dimension,
      props[dimension] ?? 0,
      ctx,
      state,
    );
    if (!input.ok) return fail(input.error);
    inputs.push(input.value);
  }
  const emitted = emitFeature(
    "translate",
    identity.value.slug,
    identity.value.explicitFeatureId,
    inputs,
    ctx,
    state,
  );
  if (!emitted.ok) return fail(emitted.error);
  return ok({ producers: [emitted.value] });
}

/** `<Body>`: the body record, capturing at most one producing child's output. */
function compileBodyElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  if (ctx.withinContainer) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.bodyNested,
        "A <Body> cannot be nested inside another <Body> or a <Translate>; translate the producing primitive instead.",
        ctx.path,
      ),
    );
  }
  const invalid = validateDescriptorProps(
    "body",
    props,
    ["name", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  const name = props.name;
  if (typeof name !== "string" || name.length === 0) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        "A <Body> requires a non-empty name string.",
        ctx.path,
        name,
      ),
    );
  }
  let bodyId: BodyId;
  if (props.id === undefined) {
    const sanitized = name
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "");
    const derived = parseBodyId(`body_${sanitized}`);
    if (!derived.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The <Body> name "${name}" does not derive a valid body id (body_${sanitized}): ${derived.error.message} — pass an explicit id.`,
          ctx.path,
          name,
        ),
      );
    }
    bodyId = derived.value;
  } else if (typeof props.id === "string") {
    const explicit = parseBodyId(props.id);
    if (!explicit.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The id prop of <Body> is not a valid body id: ${explicit.error.message}`,
          ctx.path,
          props.id,
        ),
      );
    }
    bodyId = explicit.value;
  } else {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The id prop of <Body> must be a body id string ("body_…").',
        ctx.path,
        props.id,
      ),
    );
  }
  const claimed = claimId(state, bodyId, `the body named "${name}"`, ctx);
  if (claimed !== undefined) return fail(claimed);
  // The body record exists before any child feature can declare it as an
  // output — the same ordering the workbench's transactions use.
  state.commands.push({
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    type: "body.create",
    id: bodyId,
    name,
  });
  const capture: BodyCapture = { bodyId, captured: false };
  const children = walkNode(
    props.children,
    {
      path: ctx.path,
      depth: ctx.depth + 1,
      capture,
      withinContainer: true,
    },
    state,
  );
  if (!children.ok) return fail(children.error);
  // A <Body> is a container, not a producer: zero producers leaves a bare
  // body record, one producer shaped it (enforced during the walk).
  return ok(EMPTY_RESULT);
}

/** `<Parameter>`: a declaration (`parameter.create`) or a re-declaration (`parameter.set`). */
function compileParameterElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "parameter",
    props,
    ["name", "value", "id"],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  const name = props.name;
  if (typeof name !== "string" || name.length === 0) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        "A <Parameter> requires a non-empty name string.",
        ctx.path,
        name,
      ),
    );
  }
  if (!isExpressionIdentifierName(name)) {
    const nameText: string = name;
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `A <Parameter> name must be a valid expression identifier (a letter or underscore, then letters, digits, or underscores, at most 64 characters) — it must be usable in expressions; "${nameText}" is not.`,
        ctx.path,
        nameText,
      ),
    );
  }
  let value: AnyDimensionalValue;
  const rawValue = props.value;
  if (typeof rawValue === "number") {
    if (!Number.isFinite(rawValue)) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          "The value prop of <Parameter> must be a finite number (NaN and Infinity are rejected).",
          ctx.path,
          rawValue,
        ),
      );
    }
    value = length(rawValue);
  } else if (isPlainRecord(rawValue)) {
    const parsed = parseDimensionalValue(rawValue);
    if (!parsed.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The value prop of <Parameter> is not a valid dimensional value: ${parsed.error.message}`,
          ctx.path,
          rawValue,
        ),
      );
    }
    value = parsed.value;
  } else {
    if (rawValue === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          "A <Parameter> requires the value prop.",
          ctx.path,
        ),
      );
    }
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The value prop of <Parameter> must be a plain number (canonical millimetres) or a dimensional quantity from "@slopcad/cad-core".',
        ctx.path,
        rawValue,
      ),
    );
  }
  let id: ParameterId;
  if (props.id === undefined) {
    const derived = parseParameterId(`param_${name}`);
    if (!derived.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The <Parameter> name "${name}" does not derive a valid parameter id: ${derived.error.message}`,
          ctx.path,
          name,
        ),
      );
    }
    id = derived.value;
  } else if (typeof props.id === "string") {
    const explicit = parseParameterId(props.id);
    if (!explicit.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The id prop of <Parameter> is not a valid parameter id: ${explicit.error.message}`,
          ctx.path,
          props.id,
        ),
      );
    }
    id = explicit.value;
  } else {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The id prop of <Parameter> must be a parameter id string ("param_…").',
        ctx.path,
        props.id,
      ),
    );
  }
  const serialized = serializedValueOf(value, ctx);
  if (!serialized.ok) return fail(serialized.error);
  const existing = state.parameters.get(id);
  if (existing !== undefined) {
    if (existing !== name) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `This <Parameter> re-declares parameter "${id}" (first declared as "${existing}") under a different name ("${name}"); a re-declaration is a value update and must keep the original name.`,
          ctx.path,
          name,
        ),
      );
    }
    state.commands.push({
      formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
      type: "parameter.set",
      id,
      value: serialized.value,
    });
    return ok(EMPTY_RESULT);
  }
  const claimed = claimId(state, id, `the parameter named "${name}"`, ctx);
  if (claimed !== undefined) return fail(claimed);
  const nameConflict = registerParameterName(id, name, ctx, state);
  if (nameConflict !== undefined) return fail(nameConflict);
  state.parameters.set(id, name);
  state.commands.push({
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    type: "parameter.create",
    id,
    name,
    value: serialized.value,
  });
  return ok(EMPTY_RESULT);
}
