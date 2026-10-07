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
 * or sketches nested in containers, wrong producer counts on consuming
 * elements, unresolvable `<Use>`/sketch references, sketch entities
 * outside a sketch or non-entities inside one — is rejected with a
 * structured {@link CadJsxCompileError} carrying the tree `path`; domain
 * errors never throw.
 */

import {
  angle,
  CAD_DOCUMENT_FORMAT_VERSION,
  dimensionless,
  fail,
  isExpressionIdentifierName,
  length,
  ok,
  parseBodyId,
  parseCommand,
  parseCurveId,
  parseDatumId,
  parseDimensionalValue,
  parseFeatureId,
  parseParameterId,
  parseReferenceId,
  parseSketchDocumentId,
  serializeDimensionalValueResult,
  valueIn,
} from "@slopcad/cad-core";
import type {
  AnyDimensionalValue,
  BodyId,
  CadCommand,
  CadTransaction,
  CurveId,
  DatumId,
  FeatureId,
  ParameterId,
  ParseFailure,
  ParseResult,
  ReferenceId,
  SerializedCadCommand,
  SerializedDimensionalValue,
  SketchDocumentId,
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
  operationTargetInvalid: "cadjsx/operation-target-invalid",
  booleanInputsInvalid: "cadjsx/boolean-inputs-invalid",
  propConflict: "cadjsx/prop-conflict",
  referenceInvalid: "cadjsx/reference-invalid",
  referenceUnknown: "cadjsx/reference-unknown",
  sketchUnknown: "cadjsx/sketch-unknown",
  sketchNested: "cadjsx/sketch-nested",
  sketchChildInvalid: "cadjsx/sketch-child-invalid",
  sketchEntityOutside: "cadjsx/sketch-entity-outside",
  sketchPayloadInvalid: "cadjsx/sketch-payload-invalid",
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

/**
 * The sketch serialization format this compiler emits, from
 * `@slopcad/cad-sketch`'s `SKETCH_FORMAT_VERSION` (v2 — the entity kinds
 * `ellipse`, `ellipticalArc`, `spline`, `polygon`, and `slot`). The value
 * is mirrored here, not imported: `@slopcad/cad-jsx` sits directly above
 * `@slopcad/cad-core` and depends on nothing else in the workspace, so the
 * sketch payload is reproduced from the cad-sketch canonical form (its
 * `serializeSketch`/`serializeSketchEntity` key orders) — never invented.
 */
const SKETCH_FORMAT_VERSION = 2;

/**
 * The workplane orthonormality acceptance cad-sketch's `parseWorkplane`
 * applies to a STORED frame (unit within, perpendicular within, and a
 * right-handed cross product): the compiler validates authored frames the
 * same way instead of silently re-canonicalizing them.
 */
const WORKPLANE_ORTHONORMALITY_TOLERANCE = 1e-9;

/** One full turn in radians, for the angle canonicalization cad-sketch applies. */
const TWO_PI = Math.PI * 2;

/**
 * Guards the walk against runaway recursion: a component returning
 * itself forever, a children array containing itself, or a prop value
 * containing itself.
 */
const MAX_TREE_DEPTH = 100;

/** One input a feature declares, in wire shape. */
type WireInput =
  | { readonly kind: "parameter"; readonly id: ParameterId }
  | { readonly kind: "feature"; readonly id: FeatureId }
  | { readonly kind: "body"; readonly id: BodyId }
  | { readonly kind: "sketch"; readonly id: SketchDocumentId }
  | { readonly kind: "datum"; readonly id: DatumId }
  | { readonly kind: "curve"; readonly id: CurveId }
  | { readonly kind: "reference"; readonly id: ReferenceId };

/** The dimensions a parameter-carrying prop may declare. */
type PropDimension = "length" | "angle" | "dimensionless";

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
  /** Declared sketch records by id (value: the display name). */
  readonly sketches: Map<SketchDocumentId, string>;
  /**
   * Every feature id emitted so far (value: a description) — the registry
   * `<Use>` resolves against. Lookup only; never iterated for output.
   */
  readonly producedFeatures: Map<FeatureId, string>;
}

/** Threading state of the walk. */
interface WalkContext {
  readonly path: readonly string[];
  readonly depth: number;
  /** Active while an ancestor `<Body>` awaits its single producing child. */
  readonly capture: BodyCapture | undefined;
  /** True while an ancestor container (`<Body>` or an operation) collects children. */
  readonly withinContainer: boolean;
  /** Active while an ancestor `<Sketch>` collects entity children. */
  readonly sketch: SketchCapture | undefined;
}

/** The `<Sketch>` collection state: serialized entities, in document order. */
interface SketchCapture {
  readonly entities: Readonly<Record<string, unknown>>[];
  /** Entity ids claimed within THIS sketch (cad-sketch requires per-sketch uniqueness). */
  readonly ids: Set<string>;
}

function compileError(
  code: CadJsxErrorCode,
  message: string,
  path: readonly string[],
  input: unknown = null,
): CadJsxCompileError {
  return { code, message, input, path: [...path] };
}

/** The structured failure for a walk that outran {@link MAX_TREE_DEPTH}. */
function treeTooDeepFailure(
  path: readonly string[],
  hint: string,
): CadJsxCompileError {
  return compileError(
    CAD_JSX_ERROR_CODES.treeTooDeep,
    `The model tree exceeds the maximum depth of ${MAX_TREE_DEPTH} (${hint}); compilation stopped here.`,
    path,
  );
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
    sketches: new Map(),
    producedFeatures: new Map(),
  };
  const walked = walkNode(
    root,
    {
      path: ["<root>"],
      depth: 0,
      capture: undefined,
      withinContainer: false,
      sketch: undefined,
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
    // The element walk checks the same cap at its own entry; arrays
    // recurse without an element between (a children array that
    // contains itself), so the cap must hold here too.
    if (ctx.depth >= MAX_TREE_DEPTH) {
      return fail(
        treeTooDeepFailure(ctx.path, "often an array that contains itself"),
      );
    }
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
      treeTooDeepFailure(ctx.path, "often a component that returns itself"),
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
    const invalid = validatePropData(value, key, componentCtx.path, 0);
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
 * must be able to treat props as data. The depth cap bounds the recursion
 * (a value that contains itself returns the structured failure instead of
 * overflowing the stack).
 */
function validatePropData(
  value: unknown,
  label: string,
  path: readonly string[],
  depth: number,
): CadJsxCompileError | undefined {
  if (depth >= MAX_TREE_DEPTH) {
    return compileError(
      CAD_JSX_ERROR_CODES.propsInvalid,
      `The prop "${label}" nests deeper than the maximum of ${MAX_TREE_DEPTH} (often a value that contains itself); props must be plain serializable data.`,
      path,
      value,
    );
  }
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
          const invalid = validatePropData(
            entry,
            `${label}[${index}]`,
            path,
            depth + 1,
          );
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
          const invalid = validatePropData(
            entry,
            `${label}.${key}`,
            path,
            depth + 1,
          );
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
  if (ctx.sketch !== undefined && !SKETCH_ENTITY_KINDS.has(kind)) {
    if (kind === "sketch") {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.sketchNested,
          "A <Sketch> cannot be nested inside another <Sketch> — declare each sketch at the top level.",
          ctx.path,
        ),
      );
    }
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchChildInvalid,
        `A <${kind}> cannot appear inside a <Sketch> — a sketch's children are its entity elements only (${[...SKETCH_ENTITY_KINDS].join(", ")}).`,
        ctx.path,
        kind,
      ),
    );
  }
  switch (kind) {
    case "parameter":
      return compileParameterElement(props, ctx, state);
    case "body":
      return compileBodyElement(props, ctx, state);
    case "translate":
      return compileTranslateElement(props, ctx, state);
    case "union":
    case "subtract":
    case "intersect":
      return compileBooleanElement(kind, props, ctx, state);
    case "use":
      return compileUseElement(props, ctx, state);
    case "extrude":
      return compileExtrudeElement(props, ctx, state);
    case "revolve":
      return compileRevolveElement(props, ctx, state);
    case "sweep":
      return compileSweepElement(props, ctx, state);
    case "sweepWire":
      return compileSweepWireElement(props, ctx, state);
    case "loft":
      return compileLoftElement(props, ctx, state);
    case "fillet":
    case "chamfer":
    case "shell":
      return compileEdgeCutElement(kind, props, ctx, state);
    case "thicken":
      return compileThickenElement(props, ctx, state);
    case "split":
      return compileSplitElement(props, ctx, state);
    case "hole":
      return compileHoleElement(props, ctx, state);
    case "rib":
      return compileRibElement(props, ctx, state);
    case "thread":
      return compileThreadElement(props, ctx, state);
    case "helix":
      return compileHelixElement(props, ctx, state);
    case "scale":
      return compileScaleElement(props, ctx, state);
    case "moveFace":
    case "replaceFace":
    case "deleteFace":
      return compileLocalFaceElement(kind, props, ctx, state);
    case "patternLinear":
      return compilePatternLinearElement(props, ctx, state);
    case "patternCircular":
      return compilePatternCircularElement(props, ctx, state);
    case "patternPath":
      return compilePatternPathElement(props, ctx, state);
    case "mirror":
      return compileMirrorElement(props, ctx, state);
    case "sketch":
      return compileSketchElement(props, ctx, state);
    case "point":
    case "line":
    case "rectangle":
    case "circle":
    case "arc":
    case "ellipse":
    case "slot":
    case "polygon":
    case "spline":
      return compileSketchEntityElement(kind, props, ctx, state);
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

/**
 * Resolves one dimensional prop: a number (the canonical unit of the
 * prop's dimension — mm, rad, or unity), a quantity of that dimension, or
 * a parameter id reference.
 */
function resolveDimension(
  raw: unknown,
  prop: string,
  dimension: PropDimension,
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
    return ok({
      kind: "value",
      value:
        dimension === "length"
          ? length(raw)
          : dimension === "angle"
            ? angle(raw)
            : dimensionless(raw),
    });
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
    if (parsedValue.value.dimension !== dimension) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The "${prop}" prop must be a ${dimension} — the kernel bridge reads a ${dimension} parameter here — but carries the dimension "${parsedValue.value.dimension}".`,
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
      `The "${prop}" prop must be a plain number (the canonical unit of its dimension), a dimensional quantity from "@slopcad/cad-core", or a "param_…" parameter id string.`,
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

/**
 * Verifies a referenced parameter was declared before this point in the
 * tree and wraps it as its feature input (the shared ref branch of
 * {@link dimensionInput} and the extrude's pre-resolved distance fold).
 */
function parameterRefInput(
  name: string,
  id: ParameterId,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<WireInput, CadJsxCompileError> {
  if (!state.parameters.has(id)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.parameterUnknown,
        `The "${name}" prop references parameter "${id}", which is not declared before this point in the tree — declare the <Parameter> above the element that consumes it.`,
        ctx.path,
        id,
      ),
    );
  }
  return ok({ kind: "parameter", id });
}

/** Resolves one dimension to a feature input, emitting the implicit parameter when it is a literal. */
function dimensionInput(
  slug: string,
  name: string,
  raw: unknown,
  dimension: PropDimension,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<WireInput, CadJsxCompileError> {
  const resolved = resolveDimension(raw, name, dimension, ctx);
  if (!resolved.ok) return fail(resolved.error);
  if (resolved.value.kind === "ref") {
    return parameterRefInput(name, resolved.value.id, ctx, state);
  }
  const parameterId = emitImplicitParameter(
    slug,
    name,
    resolved.value.value,
    ctx,
    state,
  );
  if (!parameterId.ok) return fail(parameterId.error);
  return ok({ kind: "parameter", id: parameterId.value });
}

/**
 * Emits the implicit DIMENSIONLESS parameter a selector prop serializes
 * to (a world axis, a handedness, a mode — the bridge's selector
 * constants), in the implicit-parameter discipline.
 */
function selectorInput(
  slug: string,
  name: string,
  value: number,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<WireInput, CadJsxCompileError> {
  const parameterId = emitImplicitParameter(
    slug,
    name,
    dimensionless(value),
    ctx,
    state,
  );
  if (!parameterId.ok) return fail(parameterId.error);
  return ok({ kind: "parameter", id: parameterId.value });
}

/** Resolves one dimension with a default, for optional props that still ride a parameter. */
function optionalDimensionInput(
  slug: string,
  name: string,
  raw: unknown,
  fallback: number,
  dimension: PropDimension,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<WireInput, CadJsxCompileError> {
  return dimensionInput(slug, name, raw ?? fallback, dimension, ctx, state);
}

/** Parses one persistent-reference record id (`ref_…`) a topology-addressed element consumes. */
function referenceIdOf(
  kind: string,
  prop: string,
  raw: unknown,
  ctx: WalkContext,
): ParseResult<ReferenceId, CadJsxCompileError> {
  if (typeof raw !== "string") {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The "${prop}" prop of <${kind}> must be a persistent-reference record id string ("ref_…").`,
        ctx.path,
        raw,
      ),
    );
  }
  const parsed = parseReferenceId(raw);
  if (!parsed.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The "${prop}" prop of <${kind}> is not a valid reference record id: ${parsed.error.message}`,
        ctx.path,
        raw,
      ),
    );
  }
  return ok(parsed.value);
}

/** Parses one datum record id (`dtm_…`) a datum-consuming element addresses. */
function datumIdOf(
  kind: string,
  prop: string,
  raw: unknown,
  ctx: WalkContext,
): ParseResult<DatumId, CadJsxCompileError> {
  if (typeof raw !== "string") {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The "${prop}" prop of <${kind}> must be a datum record id string ("dtm_…").`,
        ctx.path,
        raw,
      ),
    );
  }
  const parsed = parseDatumId(raw);
  if (!parsed.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The "${prop}" prop of <${kind}> is not a valid datum record id: ${parsed.error.message}`,
        ctx.path,
        raw,
      ),
    );
  }
  return ok(parsed.value);
}

/**
 * Parses one curve record id (`crv_…`) a curve-consuming element addresses
 * — the wire-spine discipline: curve records are document entities this
 * vocabulary cannot declare, so the prop addresses a record the target
 * document already carries (the datum discipline's twin).
 */
function curveIdOf(
  kind: string,
  prop: string,
  raw: unknown,
  ctx: WalkContext,
): ParseResult<CurveId, CadJsxCompileError> {
  if (typeof raw !== "string") {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The "${prop}" prop of <${kind}> must be a curve record id string ("crv_…").`,
        ctx.path,
        raw,
      ),
    );
  }
  const parsed = parseCurveId(raw);
  if (!parsed.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The "${prop}" prop of <${kind}> is not a valid curve record id: ${parsed.error.message}`,
        ctx.path,
        raw,
      ),
    );
  }
  return ok(parsed.value);
}

/** Resolves one in-scope sketch record id (`skd_…`), declared earlier as a `<Sketch>`. */
function sketchInputOf(
  kind: string,
  prop: string,
  raw: unknown,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<WireInput, CadJsxCompileError> {
  if (typeof raw !== "string") {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The "${prop}" prop of <${kind}> must be a sketch record id string ("skd_…").`,
        ctx.path,
        raw,
      ),
    );
  }
  const parsed = parseSketchDocumentId(raw);
  if (!parsed.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The "${prop}" prop of <${kind}> is not a valid sketch record id: ${parsed.error.message}`,
        ctx.path,
        raw,
      ),
    );
  }
  if (!state.sketches.has(parsed.value)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchUnknown,
        `The "${prop}" prop of <${kind}> references sketch "${parsed.value}", which is not declared before this point in the tree — declare the <Sketch id=…> above the element that consumes it.`,
        ctx.path,
        parsed.value,
      ),
    );
  }
  return ok({ kind: "sketch", id: parsed.value });
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
  // The producer registry <Use> resolves against: every emitted feature id,
  // explicit or derived, in emission (document) order.
  state.producedFeatures.set(
    featureId,
    `the "${kind}" feature emitted at ${ctx.path.join(" > ")}`,
  );
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
        `The CAD element kind "${kind}" is not one this compiler version lowers to commands; the supported kinds are listed in the package's CAD_ELEMENT_KINDS.`,
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
      "length",
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
      sketch: undefined,
    },
    state,
  );
  if (!children.ok) return fail(children.error);
  const producer = children.value.producers[0];
  if (children.value.producers.length !== 1 || producer === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.translateTargetInvalid,
        `A <Translate> needs exactly one producing child element (a primitive, an operation, or a <Use>); this one declares ${children.value.producers.length}.`,
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
      "length",
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

// ---------------------------------------------------------------------------
// Phase 2 element lowerings
// ---------------------------------------------------------------------------

/** The world-axis selector values the bridge reads (1 = X, 2 = Y, 3 = Z). */
const WORLD_AXIS_VALUES = { x: 1, y: 2, z: 3 } as const;

/** The structured hole type selectors (the bridge's dimensionless 1–5). */
const HOLE_TYPE_VALUES = {
  straight: 1,
  counterbore: 2,
  countersink: 3,
  taper: 4,
  threaded: 5,
} as const;

/**
 * The structured hole's type-directed parameter roles, mirroring
 * `@slopcad/cad-kernel`'s `structuredHoleRoles` order (type first, the
 * type's own dimensions, then positions/axis which ride their own props).
 */
const HOLE_TYPE_ROLES: Readonly<
  Record<
    keyof typeof HOLE_TYPE_VALUES,
    readonly {
      readonly prop: string;
      readonly dimension: PropDimension;
    }[]
  >
> = {
  straight: [
    { prop: "diameter", dimension: "length" },
    { prop: "depth", dimension: "length" },
    { prop: "tipAngle", dimension: "angle" },
  ],
  counterbore: [
    { prop: "diameter", dimension: "length" },
    { prop: "depth", dimension: "length" },
    { prop: "tipAngle", dimension: "angle" },
    { prop: "cboreDiameter", dimension: "length" },
    { prop: "cboreDepth", dimension: "length" },
  ],
  countersink: [
    { prop: "diameter", dimension: "length" },
    { prop: "depth", dimension: "length" },
    { prop: "tipAngle", dimension: "angle" },
    { prop: "csinkDiameter", dimension: "length" },
    { prop: "csinkAngle", dimension: "angle" },
  ],
  taper: [
    { prop: "diameter", dimension: "length" },
    { prop: "depth", dimension: "length" },
    { prop: "taperAngle", dimension: "angle" },
  ],
  threaded: [
    { prop: "depth", dimension: "length" },
    { prop: "tipAngle", dimension: "angle" },
    { prop: "threadMajor", dimension: "length" },
    { prop: "threadPitch", dimension: "length" },
  ],
};

/** The thread mode selectors (the bridge's dimensionless 1–3). */
const THREAD_MODE_VALUES = { external: 1, internal: 2, cosmetic: 3 } as const;

/** The handedness selectors (the bridge's +1 / −1). */
const HANDEDNESS_VALUES = { right: 1, left: -1 } as const;

/** The path-pattern orientation selectors (the bridge's 1 = fixed, 2 = tangent). */
const PATTERN_ORIENTATION_VALUES = { fixed: 1, tangent: 2 } as const;

/** Reads one enum-valued selector prop and maps it to its wire value. */
function selectorValueOf(
  kind: string,
  prop: string,
  raw: unknown,
  mapping: Readonly<Record<string, number>>,
  ctx: WalkContext,
): ParseResult<number, CadJsxCompileError> {
  // hasOwn, not `in`: the mapping is a plain record, and `in` would accept
  // Object.prototype members ("toString", …) as selector keys.
  if (typeof raw !== "string" || !Object.hasOwn(mapping, raw)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The "${prop}" prop of <${kind}> must be one of: ${Object.keys(mapping).join(", ")}.`,
        ctx.path,
        raw,
      ),
    );
  }
  return ok(mapping[raw] ?? 0);
}

/** A boolean flag prop (`boolean` or absent). */
function optionalFlagOf(
  kind: string,
  prop: string,
  raw: unknown,
  ctx: WalkContext,
): ParseResult<boolean, CadJsxCompileError> {
  if (raw === undefined) return ok(false);
  if (typeof raw === "boolean") return ok(raw);
  return fail(
    compileError(
      CAD_JSX_ERROR_CODES.propValueInvalid,
      `The "${prop}" prop of <${kind}> must be a boolean.`,
      ctx.path,
      raw,
    ),
  );
}

/** Reads a finite plain-number entity parameter (mm or rad, as stored). */
function entityNumberOf(
  kind: string,
  prop: string,
  raw: unknown,
  ctx: WalkContext,
): ParseResult<number, CadJsxCompileError> {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
        `The "${prop}" prop of <${kind}> must be a finite number (sketch entity parameters are stored in workplane mm/rad).`,
        ctx.path,
        raw,
      ),
    );
  }
  return ok(raw);
}

/** Requires a strictly positive entity radius/semi-axis. */
function entityRadiusOf(
  kind: string,
  prop: string,
  raw: unknown,
  ctx: WalkContext,
): ParseResult<number, CadJsxCompileError> {
  const value = entityNumberOf(kind, prop, raw, ctx);
  if (!value.ok) return value;
  if (!(value.value > 0)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
        `The "${prop}" prop of <${kind}> must be a positive number of mm.`,
        ctx.path,
        raw,
      ),
    );
  }
  return value;
}

/** Canonicalizes an angle into [0, 2π), the way cad-sketch's builders store it. */
function canonicalSketchAngle(angleValue: number): number {
  const wrapped = angleValue % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * Walks one consuming element's children and requires exactly one solid
 * producer (the operation's target). The child keeps its own body; only
 * the operation's own feature may be captured by an enclosing `<Body>`.
 */
function targetChildOf(
  kind: string,
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<ProducerRef, CadJsxCompileError> {
  const children = walkNode(
    props.children,
    {
      path: ctx.path,
      depth: ctx.depth + 1,
      capture: undefined,
      withinContainer: true,
      sketch: undefined,
    },
    state,
  );
  if (!children.ok) return fail(children.error);
  const producer = children.value.producers[0];
  if (children.value.producers.length !== 1 || producer === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.operationTargetInvalid,
        `A <${kind}> needs exactly one producing child element (the target solid — a primitive, an operation, or a <Use>); this one declares ${children.value.producers.length}.`,
        ctx.path,
      ),
    );
  }
  return ok(producer);
}

/** Emits one operation's feature from its resolved inputs, as a producer. */
function emitOperation(
  kind: string,
  identity: ElementIdentity,
  inputs: readonly WireInput[],
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const producer = emitFeature(
    kind,
    identity.slug,
    identity.explicitFeatureId,
    inputs,
    ctx,
    state,
  );
  if (!producer.ok) return fail(producer.error);
  return ok({ producers: [producer.value] });
}

/**
 * `<Union>`, `<Subtract>`, `<Intersect>`: every producing child becomes a
 * feature input in declaration order — the bridge's `readSolids` layout
 * (`kernel.subtract` reads the FIRST input as the base, the rest as tools).
 */
function compileBooleanElement(
  kind: "union" | "subtract" | "intersect",
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    kind,
    props,
    ["id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  const children = walkNode(
    props.children,
    {
      path: ctx.path,
      depth: ctx.depth + 1,
      capture: undefined,
      withinContainer: true,
      sketch: undefined,
    },
    state,
  );
  if (!children.ok) return fail(children.error);
  if (children.value.producers.length < 2) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.booleanInputsInvalid,
        `A <${kind}> needs at least two producing children${kind === "subtract" ? " (the first is the base, the rest are the tools)" : ""}; this one declares ${children.value.producers.length}.`,
        ctx.path,
      ),
    );
  }
  const identity = elementSlug(kind, props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = children.value.producers.map((producer) => ({
    kind: "feature" as const,
    id: producer.featureId,
  }));
  return emitOperation(kind, identity.value, inputs, ctx, state);
}

/**
 * `<Use>`: consumes an already-produced feature by reference — the
 * shared-subtree mechanism. Emits no commands; resolves to the same
 * feature input a nested form would produce. It is a first-class
 * producer: inside a `<Body>` it claims the body's one-producer capture
 * (a `<Use>` cannot shape the captured body — the referenced feature
 * already produced its own — so the body stands bare), and refuses a
 * second producer like any real one.
 */
function compileUseElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps("use", props, ["feature"], true, ctx);
  if (invalid !== undefined) return fail(invalid);
  if (typeof props.feature !== "string") {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'A <Use> requires the feature prop: a feature id string ("feat_…").',
        ctx.path,
        props.feature,
      ),
    );
  }
  const parsed = parseFeatureId(props.feature);
  if (!parsed.ok) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The feature prop of <Use> is not a valid feature id: ${parsed.error.message}`,
        ctx.path,
        props.feature,
      ),
    );
  }
  if (!state.producedFeatures.has(parsed.value)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceUnknown,
        `A <Use> references feature "${parsed.value}", which is not produced before this point in the tree — give the shared element an explicit id prop and place it above its consumers.`,
        ctx.path,
        parsed.value,
      ),
    );
  }
  if (ctx.capture !== undefined) {
    if (ctx.capture.captured) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.bodyProducerConflict,
          `A <Body> may contain at most one producing element; the <Use> of feature "${parsed.value}" appeared after the body's shape was already declared.`,
          ctx.path,
        ),
      );
    }
    ctx.capture.captured = true;
  }
  return ok({ producers: [{ featureId: parsed.value }] });
}

/**
 * `<Fillet>`, `<Chamfer>`, `<Shell>`: the bridge's shared edge-cut layout —
 * one feature/body target, one or more REFERENCE inputs (the topology
 * selection, persistent-reference records minted by the picking layer),
 * and exactly one length parameter (radius / distance / thickness).
 */
function compileEdgeCutElement(
  kind: "fillet" | "chamfer" | "shell",
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const sizeProp =
    kind === "fillet"
      ? "radius"
      : kind === "chamfer"
        ? "distance"
        : "thickness";
  const refsProp = kind === "shell" ? "faces" : "edges";
  const allowed = [sizeProp, refsProp, "id", "children"];
  const invalid = validateDescriptorProps(kind, props, allowed, false, ctx);
  if (invalid !== undefined) return fail(invalid);
  if (props[sizeProp] === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The <${kind}> element requires the "${sizeProp}" prop.`,
        ctx.path,
      ),
    );
  }
  const rawRefs = props[refsProp];
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.referenceInvalid,
        `The "${refsProp}" prop of <${kind}> must be a non-empty array of persistent-reference record ids ("ref_…") — the bridge needs at least one ${kind === "shell" ? "face" : "edge"} reference.`,
        ctx.path,
        rawRefs,
      ),
    );
  }
  const target = targetChildOf(kind, props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug(kind, props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [{ kind: "feature", id: target.value.featureId }];
  for (const raw of rawRefs) {
    const referenceId = referenceIdOf(kind, refsProp, raw, ctx);
    if (!referenceId.ok) return fail(referenceId.error);
    inputs.push({ kind: "reference", id: referenceId.value });
  }
  const size = dimensionInput(
    identity.value.slug,
    sizeProp,
    props[sizeProp],
    "length",
    ctx,
    state,
  );
  if (!size.ok) return fail(size.error);
  inputs.push(size.value);
  return emitOperation(kind, identity.value, inputs, ctx, state);
}

/** `<Thicken>`: one target + one wall thickness parameter. */
function compileThickenElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "thicken",
    props,
    ["thickness", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.thickness === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Thicken> element requires the "thickness" prop.',
        ctx.path,
      ),
    );
  }
  const target = targetChildOf("thicken", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("thicken", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const thickness = dimensionInput(
    identity.value.slug,
    "thickness",
    props.thickness,
    "length",
    ctx,
    state,
  );
  if (!thickness.ok) return fail(thickness.error);
  return emitOperation(
    "thicken",
    identity.value,
    [{ kind: "feature", id: target.value.featureId }, thickness.value],
    ctx,
    state,
  );
}

/** `<Split>`: one target + one datum PLANE input + the keep-side selector. */
function compileSplitElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "split",
    props,
    ["plane", "keep", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.keep !== 1 && props.keep !== -1) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        "The keep prop of <Split> must be 1 (keep the side the plane normal points to) or -1 (the opposite).",
        ctx.path,
        props.keep,
      ),
    );
  }
  if (props.plane === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Split> element requires the "plane" prop: a datum plane record id ("dtm_…").',
        ctx.path,
      ),
    );
  }
  const plane = datumIdOf("split", "plane", props.plane, ctx);
  if (!plane.ok) return fail(plane.error);
  const target = targetChildOf("split", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("split", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const keep = selectorInput(
    identity.value.slug,
    "keep",
    props.keep,
    ctx,
    state,
  );
  if (!keep.ok) return fail(keep.error);
  return emitOperation(
    "split",
    identity.value,
    [
      { kind: "feature", id: target.value.featureId },
      { kind: "datum", id: plane.value },
      keep.value,
    ],
    ctx,
    state,
  );
}

/**
 * `<Hole>`: the bridge's flat five-parameter layout, or the structured
 * type-directed form when `type` is present (`structuredHoleRoles` order,
 * with `positions`/`axisDatum` as the sketch/datum alternatives).
 */
function compileHoleElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const allowed = [
    "type",
    "diameter",
    "depth",
    "tipAngle",
    "cboreDiameter",
    "cboreDepth",
    "csinkDiameter",
    "csinkAngle",
    "taperAngle",
    "threadMajor",
    "threadPitch",
    "positionX",
    "positionY",
    "positions",
    "axis",
    "axisDatum",
    "id",
    "children",
  ];
  const invalid = validateDescriptorProps("hole", props, allowed, false, ctx);
  if (invalid !== undefined) return fail(invalid);
  const target = targetChildOf("hole", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("hole", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [{ kind: "feature", id: target.value.featureId }];
  const axisConflict =
    props.axis !== undefined && props.axisDatum !== undefined
      ? `The axis and axisDatum props of <hole> are alternatives — pass the world-axis selector or a datum axis record id, not both.`
      : undefined;
  if (axisConflict !== undefined) {
    return fail(
      compileError(CAD_JSX_ERROR_CODES.propConflict, axisConflict, ctx.path),
    );
  }

  if (props.type === undefined) {
    // The flat five-parameter form.
    for (const flatOnly of [
      "tipAngle",
      "cboreDiameter",
      "cboreDepth",
      "csinkDiameter",
      "csinkAngle",
      "taperAngle",
      "threadMajor",
      "threadPitch",
      "positions",
    ] as const) {
      if (props[flatOnly] !== undefined) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propConflict,
            `The "${flatOnly}" prop belongs to the structured hole form — add the type prop to author one.`,
            ctx.path,
            flatOnly,
          ),
        );
      }
    }
    for (const required of [
      "diameter",
      "depth",
      "positionX",
      "positionY",
    ] as const) {
      if (props[required] === undefined) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propValueInvalid,
            `A flat-form <Hole> requires the "${required}" prop.`,
            ctx.path,
          ),
        );
      }
    }
    const dimensions: readonly {
      readonly prop: string;
      readonly dimension: PropDimension;
    }[] = [
      { prop: "diameter", dimension: "length" },
      { prop: "depth", dimension: "length" },
      { prop: "positionX", dimension: "length" },
      { prop: "positionY", dimension: "length" },
    ];
    for (const { prop, dimension } of dimensions) {
      const input = dimensionInput(
        identity.value.slug,
        prop,
        props[prop],
        dimension,
        ctx,
        state,
      );
      if (!input.ok) return fail(input.error);
      inputs.push(input.value);
    }
    if (props.axisDatum !== undefined) {
      const datum = datumIdOf("hole", "axisDatum", props.axisDatum, ctx);
      if (!datum.ok) return fail(datum.error);
      inputs.push({ kind: "datum", id: datum.value });
    } else {
      const axisValue = selectorValueOf(
        "hole",
        "axis",
        props.axis ?? "z",
        WORLD_AXIS_VALUES,
        ctx,
      );
      if (!axisValue.ok) return fail(axisValue.error);
      const axis = selectorInput(
        identity.value.slug,
        "axis",
        axisValue.value,
        ctx,
        state,
      );
      if (!axis.ok) return fail(axis.error);
      inputs.push(axis.value);
    }
    return emitOperation("hole", identity.value, inputs, ctx, state);
  }

  // The structured, type-directed form.
  const typeValue = selectorValueOf(
    "hole",
    "type",
    props.type,
    HOLE_TYPE_VALUES,
    ctx,
  );
  if (!typeValue.ok) return fail(typeValue.error);
  const holeType = props.type as keyof typeof HOLE_TYPE_VALUES;
  const roles = HOLE_TYPE_ROLES[holeType];
  const typeInput = selectorInput(
    identity.value.slug,
    "type",
    typeValue.value,
    ctx,
    state,
  );
  if (!typeInput.ok) return fail(typeInput.error);
  inputs.push(typeInput.value);
  const roleProps = new Set<string>(roles.map((role) => role.prop));
  for (const key of Object.keys(props)) {
    if (
      key !== "type" &&
      allowed.includes(key) &&
      !roleProps.has(key) &&
      ![
        "positionX",
        "positionY",
        "positions",
        "axis",
        "axisDatum",
        "id",
        "children",
      ].includes(key) &&
      props[key] !== undefined
    ) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propConflict,
          `The "${key}" prop does not belong to a <hole> of type "${holeType}" — that type's dimensions are: ${[...roleProps].join(", ")}.`,
          ctx.path,
          key,
        ),
      );
    }
  }
  for (const role of roles) {
    if (props[role.prop] === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `A <hole> of type "${holeType}" requires the "${role.prop}" prop.`,
          ctx.path,
        ),
      );
    }
    const input = dimensionInput(
      identity.value.slug,
      role.prop,
      props[role.prop],
      role.dimension,
      ctx,
      state,
    );
    if (!input.ok) return fail(input.error);
    inputs.push(input.value);
  }
  if (props.positions !== undefined) {
    if (props.positionX !== undefined || props.positionY !== undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propConflict,
          "The positions prop (a sketch of hole centres) replaces positionX/positionY — pass one or the other.",
          ctx.path,
        ),
      );
    }
    const sketch = sketchInputOf(
      "hole",
      "positions",
      props.positions,
      ctx,
      state,
    );
    if (!sketch.ok) return fail(sketch.error);
    inputs.push(sketch.value);
  } else {
    for (const position of ["positionX", "positionY"] as const) {
      if (props[position] === undefined) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propValueInvalid,
            `A <hole> of type "${holeType}" requires the "${position}" prop (or the positions sketch alternative).`,
            ctx.path,
          ),
        );
      }
      const input = dimensionInput(
        identity.value.slug,
        position,
        props[position],
        "length",
        ctx,
        state,
      );
      if (!input.ok) return fail(input.error);
      inputs.push(input.value);
    }
  }
  if (props.axisDatum !== undefined) {
    const datum = datumIdOf("hole", "axisDatum", props.axisDatum, ctx);
    if (!datum.ok) return fail(datum.error);
    inputs.push({ kind: "datum", id: datum.value });
  } else {
    const axisValue = selectorValueOf(
      "hole",
      "axis",
      props.axis ?? "z",
      WORLD_AXIS_VALUES,
      ctx,
    );
    if (!axisValue.ok) return fail(axisValue.error);
    const axis = selectorInput(
      identity.value.slug,
      "axis",
      axisValue.value,
      ctx,
      state,
    );
    if (!axis.ok) return fail(axis.error);
    inputs.push(axis.value);
  }
  return emitOperation("hole", identity.value, inputs, ctx, state);
}

/** `<Rib>`: one target + one sketch input (the cross-section) + one thickness parameter. */
function compileRibElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "rib",
    props,
    ["thickness", "sketch", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.thickness === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Rib> element requires the "thickness" prop.',
        ctx.path,
      ),
    );
  }
  if (props.sketch === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Rib> element requires the "sketch" prop: an in-scope <Sketch id=…> carrying the rib cross-section.',
        ctx.path,
      ),
    );
  }
  const sketch = sketchInputOf("rib", "sketch", props.sketch, ctx, state);
  if (!sketch.ok) return fail(sketch.error);
  const target = targetChildOf("rib", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("rib", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const thickness = dimensionInput(
    identity.value.slug,
    "thickness",
    props.thickness,
    "length",
    ctx,
    state,
  );
  if (!thickness.ok) return fail(thickness.error);
  return emitOperation(
    "rib",
    identity.value,
    [
      { kind: "feature", id: target.value.featureId },
      sketch.value,
      thickness.value,
    ],
    ctx,
    state,
  );
}

/**
 * `<Thread>`: one target + five parameters in the bridge's declared order
 * (major diameter, pitch, length, mode, handedness) + the axis — a world
 * selector parameter or a datum axis input.
 */
function compileThreadElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "thread",
    props,
    [
      "majorDiameter",
      "pitch",
      "length",
      "mode",
      "handedness",
      "axis",
      "axisDatum",
      "id",
      "children",
    ],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.axis !== undefined && props.axisDatum !== undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propConflict,
        "The axis and axisDatum props of <thread> are alternatives — pass the world-axis selector or a datum axis record id, not both.",
        ctx.path,
      ),
    );
  }
  const target = targetChildOf("thread", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("thread", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [{ kind: "feature", id: target.value.featureId }];
  for (const dimension of ["majorDiameter", "pitch", "length"] as const) {
    if (props[dimension] === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The <Thread> element requires the "${dimension}" prop.`,
          ctx.path,
        ),
      );
    }
    const input = dimensionInput(
      identity.value.slug,
      dimension,
      props[dimension],
      "length",
      ctx,
      state,
    );
    if (!input.ok) return fail(input.error);
    inputs.push(input.value);
  }
  const mode = selectorValueOf(
    "thread",
    "mode",
    props.mode ?? "external",
    THREAD_MODE_VALUES,
    ctx,
  );
  if (!mode.ok) return fail(mode.error);
  const modeInput = selectorInput(
    identity.value.slug,
    "mode",
    mode.value,
    ctx,
    state,
  );
  if (!modeInput.ok) return fail(modeInput.error);
  inputs.push(modeInput.value);
  const handedness = selectorValueOf(
    "thread",
    "handedness",
    props.handedness ?? "right",
    HANDEDNESS_VALUES,
    ctx,
  );
  if (!handedness.ok) return fail(handedness.error);
  const handednessInput = selectorInput(
    identity.value.slug,
    "handedness",
    handedness.value,
    ctx,
    state,
  );
  if (!handednessInput.ok) return fail(handednessInput.error);
  inputs.push(handednessInput.value);
  if (props.axisDatum !== undefined) {
    const datum = datumIdOf("thread", "axisDatum", props.axisDatum, ctx);
    if (!datum.ok) return fail(datum.error);
    inputs.push({ kind: "datum", id: datum.value });
  } else {
    const axisValue = selectorValueOf(
      "thread",
      "axis",
      props.axis ?? "z",
      WORLD_AXIS_VALUES,
      ctx,
    );
    if (!axisValue.ok) return fail(axisValue.error);
    const axis = selectorInput(
      identity.value.slug,
      "axis",
      axisValue.value,
      ctx,
      state,
    );
    if (!axis.ok) return fail(axis.error);
    inputs.push(axis.value);
  }
  return emitOperation("thread", identity.value, inputs, ctx, state);
}

/**
 * `<Helix>`: a PRODUCER — one sketch input (the meridian profile) + six
 * parameters in the bridge's declared order (radius, pitch, turns,
 * handedness, start angle, taper) + an optional datum axis input.
 */
function compileHelixElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "helix",
    props,
    [
      "sketch",
      "radius",
      "pitch",
      "turns",
      "handedness",
      "startAngle",
      "taper",
      "axis",
      "id",
    ],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.sketch === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Helix> element requires the "sketch" prop: an in-scope <Sketch id=…> carrying the meridian profile.',
        ctx.path,
      ),
    );
  }
  const sketch = sketchInputOf("helix", "sketch", props.sketch, ctx, state);
  if (!sketch.ok) return fail(sketch.error);
  const identity = elementSlug("helix", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [sketch.value];
  const radius = dimensionInput(
    identity.value.slug,
    "radius",
    props.radius,
    "length",
    ctx,
    state,
  );
  if (!radius.ok) return fail(radius.error);
  inputs.push(radius.value);
  const pitch = dimensionInput(
    identity.value.slug,
    "pitch",
    props.pitch,
    "length",
    ctx,
    state,
  );
  if (!pitch.ok) return fail(pitch.error);
  inputs.push(pitch.value);
  const turns = dimensionInput(
    identity.value.slug,
    "turns",
    props.turns,
    "dimensionless",
    ctx,
    state,
  );
  if (!turns.ok) return fail(turns.error);
  inputs.push(turns.value);
  const handedness = selectorValueOf(
    "helix",
    "handedness",
    props.handedness ?? "right",
    HANDEDNESS_VALUES,
    ctx,
  );
  if (!handedness.ok) return fail(handedness.error);
  const handednessInput = selectorInput(
    identity.value.slug,
    "handedness",
    handedness.value,
    ctx,
    state,
  );
  if (!handednessInput.ok) return fail(handednessInput.error);
  inputs.push(handednessInput.value);
  const startAngle = optionalDimensionInput(
    identity.value.slug,
    "startAngle",
    props.startAngle,
    0,
    "angle",
    ctx,
    state,
  );
  if (!startAngle.ok) return fail(startAngle.error);
  inputs.push(startAngle.value);
  const taper = optionalDimensionInput(
    identity.value.slug,
    "taper",
    props.taper,
    0,
    "length",
    ctx,
    state,
  );
  if (!taper.ok) return fail(taper.error);
  inputs.push(taper.value);
  if (props.axis !== undefined) {
    const datum = datumIdOf("helix", "axis", props.axis, ctx);
    if (!datum.ok) return fail(datum.error);
    inputs.push({ kind: "datum", id: datum.value });
  }
  return emitOperation("helix", identity.value, inputs, ctx, state);
}

/**
 * `<Extrude>`: a PRODUCER — the bridge's exact sketch-driven layout: one
 * sketch input (the profile source), ONE signed length parameter (the
 * distance; magnitude the height, sign the direction — `direction={-1}`
 * folds into the sign so one `parameter.set` re-drives both, Phase 26.1),
 * and an optional third angle parameter (the Phase 41 draft taper; absent
 * or zero = the plain prism).
 */
function compileExtrudeElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "extrude",
    props,
    ["sketch", "height", "direction", "taper", "id"],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.sketch === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Extrude> element requires the "sketch" prop: an in-scope <Sketch id=…> carrying the profile to extrude.',
        ctx.path,
      ),
    );
  }
  if (props.height === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Extrude> element requires the "height" prop.',
        ctx.path,
      ),
    );
  }
  if (
    props.direction !== undefined &&
    props.direction !== 1 &&
    props.direction !== -1
  ) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        "The direction prop of <Extrude> must be 1 (along the sketch plane's normal) or -1 (against it).",
        ctx.path,
        props.direction,
      ),
    );
  }
  const sketch = sketchInputOf("extrude", "sketch", props.sketch, ctx, state);
  if (!sketch.ok) return fail(sketch.error);
  const identity = elementSlug("extrude", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const direction = props.direction === -1 ? -1 : 1;
  const resolvedHeight = resolveDimension(
    props.height,
    "height",
    "length",
    ctx,
  );
  if (!resolvedHeight.ok) return fail(resolvedHeight.error);
  let heightRaw: unknown = props.height;
  if (resolvedHeight.value.kind === "ref") {
    if (direction === -1) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propConflict,
          "The direction prop of <Extrude> cannot flip a referenced height parameter — the referenced parameter's own sign carries the direction (its magnitude the height); author the sign into the <Parameter> itself.",
          ctx.path,
          props.direction,
        ),
      );
    }
  } else {
    // Fold the direction into the ONE signed distance parameter the bridge
    // reads (magnitude the height, sign the direction).
    heightRaw = length(valueIn(resolvedHeight.value.value, "mm") * direction);
  }
  const distance = dimensionInput(
    identity.value.slug,
    "height",
    heightRaw,
    "length",
    ctx,
    state,
  );
  if (!distance.ok) return fail(distance.error);
  const inputs: WireInput[] = [sketch.value, distance.value];
  if (props.taper !== undefined) {
    const taper = dimensionInput(
      identity.value.slug,
      "taper",
      props.taper,
      "angle",
      ctx,
      state,
    );
    if (!taper.ok) return fail(taper.error);
    inputs.push(taper.value);
  }
  return emitOperation("extrude", identity.value, inputs, ctx, state);
}

/**
 * `<Revolve>`: a PRODUCER — the bridge's compat layout: one sketch input
 * (the profile source), one angle parameter (the sweep), and the axis — an
 * angle parameter (the in-plane direction CCW from the workplane +x axis,
 * the axis line through the workplane origin) or a datum axis input (the
 * Phase 39 form; the datum must lie IN the sketch plane — the kernel's
 * structured verdict).
 */
function compileRevolveElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "revolve",
    props,
    ["sketch", "angle", "axis", "axisDatum", "id"],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.axis !== undefined && props.axisDatum !== undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propConflict,
        "The axis and axisDatum props of <revolve> are alternatives — pass the in-plane axis direction angle or a datum axis record id, not both.",
        ctx.path,
      ),
    );
  }
  if (props.sketch === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Revolve> element requires the "sketch" prop: an in-scope <Sketch id=…> carrying the profile to revolve.',
        ctx.path,
      ),
    );
  }
  if (props.angle === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Revolve> element requires the "angle" prop (the sweep; a plain number is canonical radians).',
        ctx.path,
      ),
    );
  }
  const sketch = sketchInputOf("revolve", "sketch", props.sketch, ctx, state);
  if (!sketch.ok) return fail(sketch.error);
  const identity = elementSlug("revolve", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const sweep = dimensionInput(
    identity.value.slug,
    "angle",
    props.angle,
    "angle",
    ctx,
    state,
  );
  if (!sweep.ok) return fail(sweep.error);
  const inputs: WireInput[] = [sketch.value, sweep.value];
  if (props.axisDatum !== undefined) {
    const datum = datumIdOf("revolve", "axisDatum", props.axisDatum, ctx);
    if (!datum.ok) return fail(datum.error);
    inputs.push({ kind: "datum", id: datum.value });
  } else {
    const axis = optionalDimensionInput(
      identity.value.slug,
      "axis",
      props.axis,
      0,
      "angle",
      ctx,
      state,
    );
    if (!axis.ok) return fail(axis.error);
    inputs.push(axis.value);
  }
  return emitOperation("revolve", identity.value, inputs, ctx, state);
}

/**
 * `<Sweep>`: a PRODUCER — the Phase 38 planar sweep's exact layout: two
 * sketch inputs, the profile first and the path second; no dimension
 * parameters (the path determines the extent).
 */
function compileSweepElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "sweep",
    props,
    ["profile", "path", "id"],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.profile === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Sweep> element requires the "profile" prop: an in-scope <Sketch id=…> carrying the closed profile loop.',
        ctx.path,
      ),
    );
  }
  if (props.path === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Sweep> element requires the "path" prop: an in-scope <Sketch id=…> carrying the path chain.',
        ctx.path,
      ),
    );
  }
  const profile = sketchInputOf("sweep", "profile", props.profile, ctx, state);
  if (!profile.ok) return fail(profile.error);
  const path = sketchInputOf("sweep", "path", props.path, ctx, state);
  if (!path.ok) return fail(path.error);
  const identity = elementSlug("sweep", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  return emitOperation(
    "sweep",
    identity.value,
    [profile.value, path.value],
    ctx,
    state,
  );
}

/**
 * `<SweepWire>`: a PRODUCER — the Phase 47 generalized sweep's exact
 * layout: one sketch input (the profile loop) and one curve input (the 3D
 * wire spine, a curve record the target document carries).
 */
function compileSweepWireElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "sweepWire",
    props,
    ["profile", "spine", "id"],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.profile === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <SweepWire> element requires the "profile" prop: an in-scope <Sketch id=…> carrying the closed profile loop.',
        ctx.path,
      ),
    );
  }
  if (props.spine === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <SweepWire> element requires the "spine" prop: a curve record id ("crv_…") carrying the 3D wire spine.',
        ctx.path,
      ),
    );
  }
  const profile = sketchInputOf(
    "sweepWire",
    "profile",
    props.profile,
    ctx,
    state,
  );
  if (!profile.ok) return fail(profile.error);
  const spine = curveIdOf("sweepWire", "spine", props.spine, ctx);
  if (!spine.ok) return fail(spine.error);
  const identity = elementSlug("sweepWire", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  return emitOperation(
    "sweepWire",
    identity.value,
    [profile.value, { kind: "curve", id: spine.value }],
    ctx,
    state,
  );
}

/**
 * `<Loft>`: a PRODUCER — the Phase 38 loft's exact layout: per section, its
 * sketch input then its station-z length parameter, interleaved in order
 * (the workbench authoring order; the bridge matches sketches and stations
 * by per-kind declared position). At least two sections.
 */
function compileLoftElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "loft",
    props,
    ["sections", "id"],
    true,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  const rawSections = props.sections;
  if (!Array.isArray(rawSections) || rawSections.length < 2) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Loft> element requires the "sections" prop: an array of at least two { sketch, z } section records — the bridge lofts between at least two sections.',
        ctx.path,
        rawSections,
      ),
    );
  }
  const identity = elementSlug("loft", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [];
  for (const [index, rawSection] of rawSections.entries()) {
    if (!isPlainRecord(rawSection)) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `Every <Loft> section must be a plain { sketch, z } record; section ${String(index + 1)} is not one.`,
          ctx.path,
          rawSection,
        ),
      );
    }
    for (const key of Object.keys(rawSection)) {
      if (key !== "sketch" && key !== "z") {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propUnknown,
            `"${key}" is not a key of a <Loft> section; each section carries exactly sketch and z.`,
            ctx.path,
            key,
          ),
        );
      }
    }
    if (rawSection.sketch === undefined || rawSection.z === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `Every <Loft> section requires its sketch and z; section ${String(index + 1)} misses one.`,
          ctx.path,
          rawSection,
        ),
      );
    }
    const sketch = sketchInputOf(
      "loft",
      `sections[${index}].sketch`,
      rawSection.sketch,
      ctx,
      state,
    );
    if (!sketch.ok) return fail(sketch.error);
    // The per-station parameter role keeps an identifier-safe suffix so each
    // section's implicit parameter claims a distinct id and name.
    const station = dimensionInput(
      identity.value.slug,
      `stationZ${String(index + 1)}`,
      rawSection.z,
      "length",
      ctx,
      state,
    );
    if (!station.ok) return fail(station.error);
    inputs.push(sketch.value, station.value);
  }
  return emitOperation("loft", identity.value, inputs, ctx, state);
}

/** `<Scale>`: one target + one dimensionless factor (uniform scaling only). */
function compileScaleElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "scale",
    props,
    ["factor", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.factor === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Scale> element requires the "factor" prop.',
        ctx.path,
      ),
    );
  }
  const target = targetChildOf("scale", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("scale", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const factor = dimensionInput(
    identity.value.slug,
    "factor",
    props.factor,
    "dimensionless",
    ctx,
    state,
  );
  if (!factor.ok) return fail(factor.error);
  return emitOperation(
    "scale",
    identity.value,
    [{ kind: "feature", id: target.value.featureId }, factor.value],
    ctx,
    state,
  );
}

/**
 * `<MoveFace>`, `<ReplaceFace>`, `<DeleteFace>`: the bridge's local-face
 * layouts — one target, exactly one FACE reference input, then the kind's
 * own parameters (axis + distance; a datum plane; the heal flag).
 */
function compileLocalFaceElement(
  kind: "moveFace" | "replaceFace" | "deleteFace",
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const allowed =
    kind === "moveFace"
      ? ["face", "axis", "distance", "id", "children"]
      : kind === "replaceFace"
        ? ["face", "plane", "id", "children"]
        : ["face", "heal", "id", "children"];
  const invalid = validateDescriptorProps(kind, props, allowed, false, ctx);
  if (invalid !== undefined) return fail(invalid);
  if (props.face === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The <${kind}> element requires the "face" prop: a persistent-reference record id ("ref_…").`,
        ctx.path,
      ),
    );
  }
  const face = referenceIdOf(kind, "face", props.face, ctx);
  if (!face.ok) return fail(face.error);
  const target = targetChildOf(kind, props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug(kind, props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [
    { kind: "feature", id: target.value.featureId },
    { kind: "reference", id: face.value },
  ];
  if (kind === "moveFace") {
    const axisValue = selectorValueOf(
      kind,
      "axis",
      props.axis,
      WORLD_AXIS_VALUES,
      ctx,
    );
    if (!axisValue.ok) return fail(axisValue.error);
    if (props.distance === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          'The <MoveFace> element requires the "distance" prop.',
          ctx.path,
        ),
      );
    }
    const axis = selectorInput(
      identity.value.slug,
      "axis",
      axisValue.value,
      ctx,
      state,
    );
    if (!axis.ok) return fail(axis.error);
    inputs.push(axis.value);
    const distance = dimensionInput(
      identity.value.slug,
      "distance",
      props.distance,
      "length",
      ctx,
      state,
    );
    if (!distance.ok) return fail(distance.error);
    inputs.push(distance.value);
  } else if (kind === "replaceFace") {
    if (props.plane === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          'The <ReplaceFace> element requires the "plane" prop: a datum plane record id ("dtm_…").',
          ctx.path,
        ),
      );
    }
    const plane = datumIdOf(kind, "plane", props.plane, ctx);
    if (!plane.ok) return fail(plane.error);
    inputs.push({ kind: "datum", id: plane.value });
  } else {
    const heal = optionalFlagOf(kind, "heal", props.heal, ctx);
    if (!heal.ok) return fail(heal.error);
    const healInput = selectorInput(
      identity.value.slug,
      "heal",
      heal.value ? 1 : 0,
      ctx,
      state,
    );
    if (!healInput.ok) return fail(healInput.error);
    inputs.push(healInput.value);
  }
  return emitOperation(kind, identity.value, inputs, ctx, state);
}

/**
 * `<PatternLinear>`: one target + three parameters in the bridge's
 * declared order (count, spacing, direction).
 */
function compilePatternLinearElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "patternLinear",
    props,
    ["count", "spacing", "direction", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  for (const required of ["count", "spacing"] as const) {
    if (props[required] === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The <PatternLinear> element requires the "${required}" prop.`,
          ctx.path,
        ),
      );
    }
  }
  const target = targetChildOf("patternLinear", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("patternLinear", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const count = dimensionInput(
    identity.value.slug,
    "count",
    props.count,
    "dimensionless",
    ctx,
    state,
  );
  if (!count.ok) return fail(count.error);
  const spacing = dimensionInput(
    identity.value.slug,
    "spacing",
    props.spacing,
    "length",
    ctx,
    state,
  );
  if (!spacing.ok) return fail(spacing.error);
  const direction = optionalDimensionInput(
    identity.value.slug,
    "direction",
    props.direction,
    0,
    "angle",
    ctx,
    state,
  );
  if (!direction.ok) return fail(direction.error);
  return emitOperation(
    "patternLinear",
    identity.value,
    [
      { kind: "feature", id: target.value.featureId },
      count.value,
      spacing.value,
      direction.value,
    ],
    ctx,
    state,
  );
}

/**
 * `<PatternCircular>`: one target + three parameters in the bridge's
 * declared order (count, totalAngle, axis).
 */
function compilePatternCircularElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "patternCircular",
    props,
    ["count", "totalAngle", "axis", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  for (const required of ["count", "totalAngle"] as const) {
    if (props[required] === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The <PatternCircular> element requires the "${required}" prop.`,
          ctx.path,
        ),
      );
    }
  }
  const target = targetChildOf("patternCircular", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("patternCircular", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const count = dimensionInput(
    identity.value.slug,
    "count",
    props.count,
    "dimensionless",
    ctx,
    state,
  );
  if (!count.ok) return fail(count.error);
  const totalAngle = dimensionInput(
    identity.value.slug,
    "totalAngle",
    props.totalAngle,
    "angle",
    ctx,
    state,
  );
  if (!totalAngle.ok) return fail(totalAngle.error);
  const axisValue = selectorValueOf(
    "patternCircular",
    "axis",
    props.axis ?? "z",
    WORLD_AXIS_VALUES,
    ctx,
  );
  if (!axisValue.ok) return fail(axisValue.error);
  const axis = selectorInput(
    identity.value.slug,
    "axis",
    axisValue.value,
    ctx,
    state,
  );
  if (!axis.ok) return fail(axis.error);
  return emitOperation(
    "patternCircular",
    identity.value,
    [
      { kind: "feature", id: target.value.featureId },
      count.value,
      totalAngle.value,
      axis.value,
    ],
    ctx,
    state,
  );
}

/**
 * `<PatternPath>`: one target + one sketch input (the path chain) + three
 * parameters in the bridge's declared order (count, spacing, orientation).
 */
function compilePatternPathElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "patternPath",
    props,
    ["count", "spacing", "orientation", "sketch", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  for (const required of ["count", "spacing", "sketch"] as const) {
    if (props[required] === undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propValueInvalid,
          `The <PatternPath> element requires the "${required}" prop.`,
          ctx.path,
        ),
      );
    }
  }
  const target = targetChildOf("patternPath", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const sketch = sketchInputOf(
    "patternPath",
    "sketch",
    props.sketch,
    ctx,
    state,
  );
  if (!sketch.ok) return fail(sketch.error);
  const identity = elementSlug("patternPath", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const count = dimensionInput(
    identity.value.slug,
    "count",
    props.count,
    "dimensionless",
    ctx,
    state,
  );
  if (!count.ok) return fail(count.error);
  const spacing = dimensionInput(
    identity.value.slug,
    "spacing",
    props.spacing,
    "length",
    ctx,
    state,
  );
  if (!spacing.ok) return fail(spacing.error);
  const orientation = selectorValueOf(
    "patternPath",
    "orientation",
    props.orientation ?? "fixed",
    PATTERN_ORIENTATION_VALUES,
    ctx,
  );
  if (!orientation.ok) return fail(orientation.error);
  const orientationInput = selectorInput(
    identity.value.slug,
    "orientation",
    orientation.value,
    ctx,
    state,
  );
  if (!orientationInput.ok) return fail(orientationInput.error);
  return emitOperation(
    "patternPath",
    identity.value,
    [
      { kind: "feature", id: target.value.featureId },
      sketch.value,
      count.value,
      spacing.value,
      orientationInput.value,
    ],
    ctx,
    state,
  );
}

/**
 * `<Mirror>`: the bridge's two exact layouts. A world-axis `plane` prop
 * (`"x"`/`"y"`/`"z"`) authors the two-parameter selector form (plane,
 * offset); a datum record id authors the datum-plane form (one datum
 * input, an optional merge parameter).
 */
function compileMirrorElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const invalid = validateDescriptorProps(
    "mirror",
    props,
    ["plane", "offset", "merge", "id", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  if (props.plane === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The <Mirror> element requires the "plane" prop: a world axis name ("x", "y", "z") or a datum plane record id ("dtm_…").',
        ctx.path,
      ),
    );
  }
  const target = targetChildOf("mirror", props, ctx, state);
  if (!target.ok) return fail(target.error);
  const identity = elementSlug("mirror", props.id, ctx, state);
  if (!identity.ok) return fail(identity.error);
  const inputs: WireInput[] = [{ kind: "feature", id: target.value.featureId }];
  if (
    typeof props.plane === "string" &&
    Object.hasOwn(WORLD_AXIS_VALUES, props.plane)
  ) {
    if (props.merge !== undefined) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.propConflict,
          'The merge prop belongs to the datum-plane form of <mirror> — author it with plane="dtm_…" or drop merge.',
          ctx.path,
        ),
      );
    }
    const selector = selectorValueOf(
      "mirror",
      "plane",
      props.plane,
      WORLD_AXIS_VALUES,
      ctx,
    );
    if (!selector.ok) return fail(selector.error);
    const plane = selectorInput(
      identity.value.slug,
      "plane",
      selector.value,
      ctx,
      state,
    );
    if (!plane.ok) return fail(plane.error);
    inputs.push(plane.value);
    const offset = optionalDimensionInput(
      identity.value.slug,
      "offset",
      props.offset,
      0,
      "length",
      ctx,
      state,
    );
    if (!offset.ok) return fail(offset.error);
    inputs.push(offset.value);
    return emitOperation("mirror", identity.value, inputs, ctx, state);
  }
  if (props.offset !== undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propConflict,
        'The offset prop belongs to the world-axis form of <mirror> — author it with plane="x"|"y"|"z" or drop offset.',
        ctx.path,
      ),
    );
  }
  const planeDatum = datumIdOf("mirror", "plane", props.plane, ctx);
  if (!planeDatum.ok) return fail(planeDatum.error);
  inputs.push({ kind: "datum", id: planeDatum.value });
  if (props.merge !== undefined) {
    const merge = optionalFlagOf("mirror", "merge", props.merge, ctx);
    if (!merge.ok) return fail(merge.error);
    const mergeInput = selectorInput(
      identity.value.slug,
      "merge",
      merge.value ? 2 : 1,
      ctx,
      state,
    );
    if (!mergeInput.ok) return fail(mergeInput.error);
    inputs.push(mergeInput.value);
  }
  return emitOperation("mirror", identity.value, inputs, ctx, state);
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
      sketch: undefined,
    },
    state,
  );
  if (!children.ok) return fail(children.error);
  // A <Body> is a container, not a producer: zero producers leaves a bare
  // body record, one producer shaped it. Every producer kind claims the
  // capture during the walk — a real feature in emitFeature, a <Use>
  // reference in compileUseElement — and each refuses a second, so the
  // walked producers need no second check here.
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

// ---------------------------------------------------------------------------
// Sketches: <Sketch> and its entity children
// ---------------------------------------------------------------------------

/** The entity element kinds a `<Sketch>` may contain. */
const SKETCH_ENTITY_KINDS: ReadonlySet<string> = new Set([
  "point",
  "line",
  "rectangle",
  "circle",
  "arc",
  "ellipse",
  "slot",
  "polygon",
  "spline",
]);

/**
 * The sketch entity-id payload grammar, mirrored from cad-sketch's
 * `sketch-ids.ts` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` after `skent_`) —
 * reproduced, not imported, per the package boundary.
 */
const SKETCH_ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `<Sketch>`: the document sketch record. The payload is the cad-sketch
 * CANONICAL SERIALIZED FORM — `{ formatVersion: 2, workplane, entities,
 * constraints: [] }` with each entity in `serializeSketchEntity`'s fixed
 * key order — reproduced from cad-sketch (the package sits above cad-core
 * only). The workplane frame is validated the way cad-sketch's
 * `parseWorkplane` validates a stored frame: unit, perpendicular,
 * right-handed — never silently re-canonicalized.
 */
function compileSketchElement(
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  if (ctx.withinContainer) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchNested,
        "A <Sketch> is a top-level record, like <Body> and <Parameter>; it cannot be nested inside a container.",
        ctx.path,
      ),
    );
  }
  const invalid = validateDescriptorProps(
    "sketch",
    props,
    ["id", "name", "origin", "normal", "xAxis", "children"],
    false,
    ctx,
  );
  if (invalid !== undefined) return fail(invalid);
  const workplane = serializeWorkplaneOf(props, ctx);
  if (!workplane.ok) return fail(workplane.error);

  const occurrence = (state.occurrences.get("sketch") ?? 0) + 1;
  state.occurrences.set("sketch", occurrence);
  let sketchId: SketchDocumentId;
  let slug: string;
  if (props.id === undefined) {
    slug = `sketch-${occurrence}`;
    const derived = parseSketchDocumentId(`skd_${slug}`);
    if (!derived.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The implicit sketch id "skd_${slug}" is not a valid sketch record id: ${derived.error.message}.`,
          ctx.path,
          `skd_${slug}`,
        ),
      );
    }
    sketchId = derived.value;
  } else if (typeof props.id === "string") {
    const explicit = parseSketchDocumentId(props.id);
    if (!explicit.ok) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.idInvalid,
          `The id prop of <Sketch> is not a valid sketch record id: ${explicit.error.message}`,
          ctx.path,
          props.id,
        ),
      );
    }
    sketchId = explicit.value;
    slug = props.id.slice(props.id.indexOf("_") + 1);
  } else {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        'The id prop of <Sketch> must be a sketch record id string ("skd_…").',
        ctx.path,
        props.id,
      ),
    );
  }
  const claimed = claimId(
    state,
    sketchId,
    `the sketch with slug "${slug}"`,
    ctx,
  );
  if (claimed !== undefined) return fail(claimed);
  const explicitName = props.name;
  let name: string;
  if (explicitName === undefined) {
    name = slug.replace(/-/g, " ");
  } else if (typeof explicitName === "string") {
    name = explicitName;
  } else {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        "The name prop of <Sketch> must be a string.",
        ctx.path,
        explicitName,
      ),
    );
  }
  if (name.length === 0 || name.length > 64) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The <Sketch> name must be a string of 1-64 characters (the document's sketch-name rule); "${name}" is ${name.length}.`,
        ctx.path,
        name,
      ),
    );
  }
  const capture: SketchCapture = { entities: [], ids: new Set() };
  const children = walkNode(
    props.children,
    {
      path: ctx.path,
      depth: ctx.depth + 1,
      capture: undefined,
      withinContainer: true,
      sketch: capture,
    },
    state,
  );
  if (!children.ok) return fail(children.error);
  state.commands.push({
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    type: "sketch.create",
    id: sketchId,
    name,
    sketch: {
      formatVersion: SKETCH_FORMAT_VERSION,
      workplane: workplane.value,
      entities: [...capture.entities],
      constraints: [],
    },
  });
  state.sketches.set(sketchId, name);
  // A sketch is a record, not a producer: consuming elements reference it
  // through a `{ kind: "sketch" }` input resolved above.
  return ok(EMPTY_RESULT);
}

/** A validated, serialized workplane frame in cad-sketch's stored shape. */
type SerializedWorkplane = {
  readonly origin: Readonly<Record<string, unknown>>;
  readonly normal: Readonly<Record<string, unknown>>;
  readonly xAxis: Readonly<Record<string, unknown>>;
};

/** Reads a workplane vector prop: a plain record of finite x/y/z numbers. */
function workplaneVecOf(
  prop: string,
  raw: unknown,
  ctx: WalkContext,
): ParseResult<
  { readonly x: number; readonly y: number; readonly z: number },
  CadJsxCompileError
> {
  if (!isPlainRecord(raw)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
        `The "${prop}" prop of <Sketch> must be an object with finite x, y, and z numbers (millimetres).`,
        ctx.path,
        raw,
      ),
    );
  }
  const vector: Record<string, unknown> = {};
  for (const axis of ["x", "y", "z"] as const) {
    const value = raw[axis];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
          `The "${prop}" prop of <Sketch> must carry a finite number in its "${axis}" component.`,
          ctx.path,
          raw,
        ),
      );
    }
    vector[axis] = value;
  }
  return ok({
    x: vector.x as number,
    y: vector.y as number,
    z: vector.z as number,
  });
}

function vec3LengthOf(vector: { x: number; y: number; z: number }): number {
  return Math.sqrt(
    vector.x * vector.x + vector.y * vector.y + vector.z * vector.z,
  );
}

function vec3DotOf(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Validates the authored workplane the way cad-sketch's `parseWorkplane`
 * accepts a STORED frame — orthonormal and right-handed within its
 * tolerance — and returns it verbatim in the serialized shape (origin,
 * normal, xAxis, each `{x, y, z}`).
 */
function serializeWorkplaneOf(
  props: Record<string, unknown>,
  ctx: WalkContext,
): ParseResult<SerializedWorkplane, CadJsxCompileError> {
  const origin = workplaneVecOf(
    "origin",
    props.origin ?? { x: 0, y: 0, z: 0 },
    ctx,
  );
  if (!origin.ok) return fail(origin.error);
  const normal = workplaneVecOf(
    "normal",
    props.normal ?? { x: 0, y: 0, z: 1 },
    ctx,
  );
  if (!normal.ok) return fail(normal.error);
  const xAxis = workplaneVecOf(
    "xAxis",
    props.xAxis ?? { x: 1, y: 0, z: 0 },
    ctx,
  );
  if (!xAxis.ok) return fail(xAxis.error);
  const tolerance = WORKPLANE_ORTHONORMALITY_TOLERANCE;
  const near = (value: number, target: number) =>
    Math.abs(value - target) <= tolerance;
  if (
    !near(vec3LengthOf(normal.value), 1) ||
    !near(vec3LengthOf(xAxis.value), 1)
  ) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
        "A <Sketch> workplane's normal and xAxis must be unit vectors within 1e-9 — the frame is stored verbatim, exactly as cad-sketch parses it; normalize the axes you author.",
        ctx.path,
        { normal: normal.value, xAxis: xAxis.value },
      ),
    );
  }
  if (!near(vec3DotOf(normal.value, xAxis.value), 0)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
        "A <Sketch> workplane's normal and xAxis must be perpendicular within 1e-9.",
        ctx.path,
        { normal: normal.value, xAxis: xAxis.value },
      ),
    );
  }
  const yAxis = {
    x: normal.value.y * xAxis.value.z - normal.value.z * xAxis.value.y,
    y: normal.value.z * xAxis.value.x - normal.value.x * xAxis.value.z,
    z: normal.value.x * xAxis.value.y - normal.value.y * xAxis.value.x,
  };
  if (!near(vec3LengthOf(yAxis), 1)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
        "A <Sketch> workplane must be right-handed: normal × xAxis must be a unit vector within 1e-9.",
        ctx.path,
        { normal: normal.value, xAxis: xAxis.value },
      ),
    );
  }
  const asRecord = (vector: { x: number; y: number; z: number }) => ({
    x: vector.x,
    y: vector.y,
    z: vector.z,
  });
  return ok({
    origin: asRecord(origin.value),
    normal: asRecord(normal.value),
    xAxis: asRecord(xAxis.value),
  });
}

/** The entity's slug: the explicit `skent_…` id's payload, or `<kind>-<occurrence>`. */
function sketchEntitySlug(
  kind: string,
  rawId: unknown,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<string, CadJsxCompileError> {
  const occurrence = (state.occurrences.get(kind) ?? 0) + 1;
  state.occurrences.set(kind, occurrence);
  if (rawId === undefined) {
    return ok(`${kind}-${occurrence}`);
  }
  if (typeof rawId !== "string" || !rawId.startsWith("skent_")) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.propValueInvalid,
        `The id prop of <${kind}> must be a sketch entity id string ("skent_…").`,
        ctx.path,
        rawId,
      ),
    );
  }
  const payload = rawId.slice("skent_".length);
  if (!SKETCH_ENTITY_ID_PATTERN.test(payload)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.idInvalid,
        `The id prop of <${kind}> is not a valid sketch entity id: the payload must be 1-64 characters, start alphanumeric, and use only A-Za-z0-9._- .`,
        ctx.path,
        rawId,
      ),
    );
  }
  return ok(payload);
}

/** Builds and claims one entity id (`skent_<slug>`) within the sketch. */
function sketchEntityIdOf(
  kind: string,
  slug: string,
  capture: SketchCapture,
  ctx: WalkContext,
): ParseResult<string, CadJsxCompileError> {
  const id = `skent_${slug}`;
  if (!SKETCH_ENTITY_ID_PATTERN.test(slug)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.idInvalid,
        `The <${kind}> element derives the entity id "${id}", whose payload is not a valid sketch entity payload (1-64 characters, starting alphanumeric, only A-Za-z0-9._-).`,
        ctx.path,
        id,
      ),
    );
  }
  if (capture.ids.has(id)) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
        `The sketch entity id "${id}" is already used within this <Sketch> — entity ids must be unique per sketch.`,
        ctx.path,
        id,
      ),
    );
  }
  capture.ids.add(id);
  return ok(id);
}

/**
 * The circumcircle of three points, or `null` when they are collinear —
 * cad-sketch's `circumcircleOf` determinant test mirrored for the arc3
 * slot's compile-time validation.
 */
function circumcircleRadiusOf(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  c: { readonly x: number; readonly y: number },
): number | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (d === 0 || !Number.isFinite(d)) return null;
  const ux =
    ((a.x * a.x + a.y * a.y) * (b.y - c.y) +
      (b.x * b.x + b.y * b.y) * (c.y - a.y) +
      (c.x * c.x + c.y * c.y) * (a.y - b.y)) /
    d;
  const uy =
    ((a.x * a.x + a.y * a.y) * (c.x - b.x) +
      (b.x * b.x + b.y * b.y) * (a.x - c.x) +
      (c.x * c.x + c.y * c.y) * (b.x - a.x)) /
    d;
  const radius = Math.hypot(a.x - ux, a.y - uy);
  if (!Number.isFinite(radius) || radius === 0) return null;
  return radius;
}

/**
 * One sketch entity child: validated against the cad-sketch entity
 * builders' own rules (positive radii, canonicalized angles, positive arc
 * sweep, polygon side bounds, spline point grammars, slot distinctness,
 * chained rectangle edges) and appended to the enclosing `<Sketch>`'s
 * payload in cad-sketch's serialized key order. Emits no commands and
 * produces no solid.
 */
function compileSketchEntityElement(
  kind: string,
  props: Record<string, unknown>,
  ctx: WalkContext,
  state: CompileState,
): ParseResult<NodeResult, CadJsxCompileError> {
  const capture = ctx.sketch;
  if (capture === undefined) {
    return fail(
      compileError(
        CAD_JSX_ERROR_CODES.sketchEntityOutside,
        `A <${kind}> is a sketch entity — it may appear only as a child of <Sketch>.`,
        ctx.path,
      ),
    );
  }
  const allowed: readonly string[] =
    kind === "point"
      ? ["x", "y", "id"]
      : kind === "line"
        ? ["x1", "y1", "x2", "y2", "id"]
        : kind === "rectangle"
          ? ["x1", "y1", "x2", "y2", "id"]
          : kind === "circle"
            ? ["cx", "cy", "radius", "id"]
            : kind === "arc"
              ? ["cx", "cy", "radius", "startAngle", "endAngle", "id"]
              : kind === "ellipse"
                ? ["cx", "cy", "radiusX", "radiusY", "rotation", "id"]
                : kind === "slot"
                  ? [
                      "variant",
                      "x1",
                      "y1",
                      "x2",
                      "y2",
                      "x3",
                      "y3",
                      "radius",
                      "id",
                    ]
                  : kind === "polygon"
                    ? ["cx", "cy", "radius", "sides", "rotation", "fit", "id"]
                    : ["flavor", "points", "id"];
  const invalid = validateDescriptorProps(kind, props, allowed, true, ctx);
  if (invalid !== undefined) return fail(invalid);
  const slug = sketchEntitySlug(kind, props.id, ctx, state);
  if (!slug.ok) return fail(slug.error);

  const record = (fields: Readonly<Record<string, unknown>>) => fields;
  switch (kind) {
    case "point": {
      const x = entityNumberOf(kind, "x", props.x, ctx);
      if (!x.ok) return fail(x.error);
      const y = entityNumberOf(kind, "y", props.y, ctx);
      if (!y.ok) return fail(y.error);
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          x: x.value,
          y: y.value,
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "line": {
      const coordinates: Record<string, number> = {};
      for (const prop of ["x1", "y1", "x2", "y2"] as const) {
        const value = entityNumberOf(kind, prop, props[prop], ctx);
        if (!value.ok) return fail(value.error);
        coordinates[prop] = value.value;
      }
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          x1: coordinates.x1,
          y1: coordinates.y1,
          x2: coordinates.x2,
          y2: coordinates.y2,
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "rectangle": {
      const x1 = entityNumberOf(kind, "x1", props.x1, ctx);
      if (!x1.ok) return fail(x1.error);
      const y1 = entityNumberOf(kind, "y1", props.y1, ctx);
      if (!y1.ok) return fail(y1.error);
      const x2 = entityNumberOf(kind, "x2", props.x2, ctx);
      if (!x2.ok) return fail(x2.error);
      const y2 = entityNumberOf(kind, "y2", props.y2, ctx);
      if (!y2.ok) return fail(y2.error);
      if (x1.value === x2.value || y1.value === y2.value) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
            "A <Rectangle> must span a positive width and height — the two corners must differ in both x and y.",
            ctx.path,
            { x1: x1.value, y1: y1.value, x2: x2.value, y2: y2.value },
          ),
        );
      }
      const rectId = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!rectId.ok) return fail(rectId.error);
      const minX = Math.min(x1.value, x2.value);
      const maxX = Math.max(x1.value, x2.value);
      const minY = Math.min(y1.value, y2.value);
      const maxY = Math.max(y1.value, y2.value);
      // cad-sketch's rectangle convention (its dimensioned-rectangle
      // fixture): four chained line entities — bottom, right, top, left —
      // and the rectangle entity referencing them in edge order.
      const edgeIds: string[] = [];
      const corners: readonly {
        readonly edge: string;
        readonly from: readonly [number, number];
        readonly to: readonly [number, number];
      }[] = [
        { edge: "bottom", from: [minX, minY], to: [maxX, minY] },
        { edge: "right", from: [maxX, minY], to: [maxX, maxY] },
        { edge: "top", from: [maxX, maxY], to: [minX, maxY] },
        { edge: "left", from: [minX, maxY], to: [minX, minY] },
      ];
      for (const corner of corners) {
        const lineId = sketchEntityIdOf(
          "line",
          `${slug.value}-${corner.edge}`,
          capture,
          ctx,
        );
        if (!lineId.ok) return fail(lineId.error);
        edgeIds.push(lineId.value);
        capture.entities.push(
          record({
            id: lineId.value,
            kind: "line",
            construction: false,
            fixed: false,
            x1: corner.from[0],
            y1: corner.from[1],
            x2: corner.to[0],
            y2: corner.to[1],
          }),
        );
      }
      capture.entities.push(
        record({
          id: rectId.value,
          kind,
          construction: false,
          fixed: false,
          edges: edgeIds,
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "circle": {
      const cx = entityNumberOf(kind, "cx", props.cx, ctx);
      if (!cx.ok) return fail(cx.error);
      const cy = entityNumberOf(kind, "cy", props.cy, ctx);
      if (!cy.ok) return fail(cy.error);
      const radius = entityRadiusOf(kind, "radius", props.radius, ctx);
      if (!radius.ok) return fail(radius.error);
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          cx: cx.value,
          cy: cy.value,
          radius: radius.value,
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "arc": {
      const cx = entityNumberOf(kind, "cx", props.cx, ctx);
      if (!cx.ok) return fail(cx.error);
      const cy = entityNumberOf(kind, "cy", props.cy, ctx);
      if (!cy.ok) return fail(cy.error);
      const radius = entityRadiusOf(kind, "radius", props.radius, ctx);
      if (!radius.ok) return fail(radius.error);
      const startAngle = entityNumberOf(
        kind,
        "startAngle",
        props.startAngle,
        ctx,
      );
      if (!startAngle.ok) return fail(startAngle.error);
      const endAngle = entityNumberOf(kind, "endAngle", props.endAngle, ctx);
      if (!endAngle.ok) return fail(endAngle.error);
      if (canonicalSketchAngle(endAngle.value - startAngle.value) === 0) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
            "An <Arc> must sweep a positive angle; a zero (or full 2π-multiple) sweep is degenerate — split a full circle into arcs or use <Circle>.",
            ctx.path,
            { startAngle: startAngle.value, endAngle: endAngle.value },
          ),
        );
      }
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          cx: cx.value,
          cy: cy.value,
          radius: radius.value,
          startAngle: canonicalSketchAngle(startAngle.value),
          endAngle: canonicalSketchAngle(endAngle.value),
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "ellipse": {
      const cx = entityNumberOf(kind, "cx", props.cx, ctx);
      if (!cx.ok) return fail(cx.error);
      const cy = entityNumberOf(kind, "cy", props.cy, ctx);
      if (!cy.ok) return fail(cy.error);
      const radiusX = entityRadiusOf(kind, "radiusX", props.radiusX, ctx);
      if (!radiusX.ok) return fail(radiusX.error);
      const radiusY = entityRadiusOf(kind, "radiusY", props.radiusY, ctx);
      if (!radiusY.ok) return fail(radiusY.error);
      const rotation = entityNumberOf(
        kind,
        "rotation",
        props.rotation ?? 0,
        ctx,
      );
      if (!rotation.ok) return fail(rotation.error);
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          cx: cx.value,
          cy: cy.value,
          radiusX: radiusX.value,
          radiusY: radiusY.value,
          rotation: canonicalSketchAngle(rotation.value),
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "slot": {
      const variant = props.variant;
      if (variant !== "straight" && variant !== "arc3") {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propValueInvalid,
            'The variant prop of <Slot> must be "straight" or "arc3".',
            ctx.path,
            variant,
          ),
        );
      }
      const x1 = entityNumberOf(kind, "x1", props.x1, ctx);
      if (!x1.ok) return fail(x1.error);
      const y1 = entityNumberOf(kind, "y1", props.y1, ctx);
      if (!y1.ok) return fail(y1.error);
      const x2 = entityNumberOf(kind, "x2", props.x2, ctx);
      if (!x2.ok) return fail(x2.error);
      const y2 = entityNumberOf(kind, "y2", props.y2, ctx);
      if (!y2.ok) return fail(y2.error);
      const radius = entityRadiusOf(kind, "radius", props.radius, ctx);
      if (!radius.ok) return fail(radius.error);
      if (variant === "straight") {
        if (x1.value === x2.value && y1.value === y2.value) {
          return fail(
            compileError(
              CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
              "A straight <Slot>'s cap centers must be distinct — a zero-length centerline is degenerate (use <Circle>).",
              ctx.path,
              { x1: x1.value, y1: y1.value, x2: x2.value, y2: y2.value },
            ),
          );
        }
        const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
        if (!id.ok) return fail(id.error);
        capture.entities.push(
          record({
            id: id.value,
            kind,
            construction: false,
            fixed: false,
            variant,
            x1: x1.value,
            y1: y1.value,
            x2: x2.value,
            y2: y2.value,
            radius: radius.value,
          }),
        );
        return ok(EMPTY_RESULT);
      }
      const x3 = entityNumberOf(kind, "x3", props.x3, ctx);
      if (!x3.ok) return fail(x3.error);
      const y3 = entityNumberOf(kind, "y3", props.y3, ctx);
      if (!y3.ok) return fail(y3.error);
      const start = { x: x1.value, y: y1.value };
      const through = { x: x2.value, y: y2.value };
      const end = { x: x3.value, y: y3.value };
      const distinct =
        (start.x !== through.x || start.y !== through.y) &&
        (through.x !== end.x || through.y !== end.y) &&
        (start.x !== end.x || start.y !== end.y);
      if (!distinct) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
            "An arc3 <Slot>'s three centerline points must be distinct.",
            ctx.path,
            {
              x1: x1.value,
              y1: y1.value,
              x2: x2.value,
              y2: y2.value,
              x3: x3.value,
              y3: y3.value,
            },
          ),
        );
      }
      const circumradius = circumcircleRadiusOf(start, through, end);
      if (circumradius === null) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
            "An arc3 <Slot>'s centerline points must not be collinear — the centerline is an arc (a straight centerline is the straight slot).",
            ctx.path,
            {
              x1: x1.value,
              y1: y1.value,
              x2: x2.value,
              y2: y2.value,
              x3: x3.value,
              y3: y3.value,
            },
          ),
        );
      }
      if (!(circumradius > radius.value)) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
            `An arc3 <Slot>'s centerline arc radius (${circumradius.toFixed(6)} mm) must exceed its cap radius (${radius.value} mm); the inner offset arc would otherwise invert.`,
            ctx.path,
            { radius: radius.value, circumradius },
          ),
        );
      }
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          variant,
          x1: x1.value,
          y1: y1.value,
          x2: x2.value,
          y2: y2.value,
          x3: x3.value,
          y3: y3.value,
          radius: radius.value,
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "polygon": {
      const cx = entityNumberOf(kind, "cx", props.cx, ctx);
      if (!cx.ok) return fail(cx.error);
      const cy = entityNumberOf(kind, "cy", props.cy, ctx);
      if (!cy.ok) return fail(cy.error);
      const radius = entityRadiusOf(kind, "radius", props.radius, ctx);
      if (!radius.ok) return fail(radius.error);
      const sides = props.sides;
      if (
        typeof sides !== "number" ||
        !Number.isInteger(sides) ||
        sides < 3 ||
        sides > 128
      ) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
            "The sides prop of <Polygon> must be an integer between 3 and 128.",
            ctx.path,
            sides,
          ),
        );
      }
      const rotation = entityNumberOf(
        kind,
        "rotation",
        props.rotation ?? 0,
        ctx,
      );
      if (!rotation.ok) return fail(rotation.error);
      const fit = props.fit;
      if (fit !== "inscribed" && fit !== "circumscribed") {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propValueInvalid,
            'The fit prop of <Polygon> must be "inscribed" or "circumscribed".',
            ctx.path,
            fit,
          ),
        );
      }
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          cx: cx.value,
          cy: cy.value,
          radius: radius.value,
          sides,
          rotation: canonicalSketchAngle(rotation.value),
          fit,
        }),
      );
      return ok(EMPTY_RESULT);
    }
    case "spline": {
      const flavor = props.flavor;
      if (flavor !== "control" && flavor !== "interpolated") {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propValueInvalid,
            'The flavor prop of <Spline> must be "control" or "interpolated".',
            ctx.path,
            flavor,
          ),
        );
      }
      const rawPoints = props.points;
      if (!Array.isArray(rawPoints)) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.propValueInvalid,
            "The points prop of <Spline> must be an array of { x, y } points (workplane mm).",
            ctx.path,
            rawPoints,
          ),
        );
      }
      const points: { readonly x: number; readonly y: number }[] = [];
      for (const [index, rawPoint] of rawPoints.entries()) {
        if (!isPlainRecord(rawPoint)) {
          return fail(
            compileError(
              CAD_JSX_ERROR_CODES.propValueInvalid,
              `The points[${index}] entry of <Spline> must be an object with finite x and y numbers.`,
              ctx.path,
              rawPoint,
            ),
          );
        }
        const x = entityNumberOf(kind, `points[${index}].x`, rawPoint.x, ctx);
        if (!x.ok) return fail(x.error);
        const y = entityNumberOf(kind, `points[${index}].y`, rawPoint.y, ctx);
        if (!y.ok) return fail(y.error);
        points.push({ x: x.value, y: y.value });
      }
      if (points.length < 2) {
        return fail(
          compileError(
            CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
            "A <Spline> needs at least two points.",
            ctx.path,
            points.length,
          ),
        );
      }
      if (flavor === "control") {
        if (points.length < 4 || (points.length - 1) % 3 !== 0) {
          return fail(
            compileError(
              CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
              "A control-point <Spline>'s point count must be 4, 7, 10, … (three new points per extra Bézier segment).",
              ctx.path,
              points.length,
            ),
          );
        }
        const segments = (points.length - 1) / 3;
        for (let index = 0; index < segments; index += 1) {
          const a = points[3 * index];
          const b = points[3 * index + 3];
          if (
            a !== undefined &&
            b !== undefined &&
            a.x === b.x &&
            a.y === b.y
          ) {
            return fail(
              compileError(
                CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
                `Bézier segment ${index + 1} of a control <Spline> has coincident endpoints; a spline segment must have positive length.`,
                ctx.path,
                points.length,
              ),
            );
          }
        }
      } else {
        for (let index = 0; index + 1 < points.length; index += 1) {
          const a = points[index];
          const b = points[index + 1];
          if (
            a !== undefined &&
            b !== undefined &&
            a.x === b.x &&
            a.y === b.y
          ) {
            return fail(
              compileError(
                CAD_JSX_ERROR_CODES.sketchPayloadInvalid,
                "An interpolated <Spline>'s consecutive fit points must be distinct.",
                ctx.path,
                index,
              ),
            );
          }
        }
      }
      const id = sketchEntityIdOf(kind, slug.value, capture, ctx);
      if (!id.ok) return fail(id.error);
      capture.entities.push(
        record({
          id: id.value,
          kind,
          construction: false,
          fixed: false,
          flavor,
          points: points.map((point) => ({ x: point.x, y: point.y })),
        }),
      );
      return ok(EMPTY_RESULT);
    }
    default:
      return fail(
        compileError(
          CAD_JSX_ERROR_CODES.kindUnsupported,
          `The sketch entity kind "${kind}" is not one this compiler lowers.`,
          ctx.path,
          kind,
        ),
      );
  }
}
