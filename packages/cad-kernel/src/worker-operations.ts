/**
 * The worker protocol's operation vocabulary (Phase 10.1): the kernel
 * operations a worker request can carry, as data.
 *
 * Every operation in the vocabulary is an operation of the kernel contract
 * (`./contract`) — primitives, booleans, the transform, measurements,
 * tessellation, disposal — with one translation: in-process opaque
 * {@link KernelSolid} handles cannot cross a message boundary, so the wire
 * addresses solids by {@link WorkerSolidId} (see `./worker-ids`), the ids a
 * worker session mints for the solids it holds.
 *
 * The vocabulary is a table, not a closed enum of methods. Each operation id
 * maps to four codec entries — a typed input form, a canonical serialized
 * input form, and the same pair for results — registered in the typed/wire
 * maps below. Adding an operation means adding one id to
 * {@link WORKER_OPERATION_IDS} and completing its table rows; the mapped types
 * then force every codec to exist before the package compiles. Future groups
 * (e.g. `document.*` commands for the settled worker-executes-domain
 * architecture) extend the same table without touching the envelope.
 *
 * ## Division of validation labor
 *
 * The codecs validate *structure only*: lengths must parse as cad-core
 * dimensional values of dimension length, solid references must parse as
 * worker solid ids, arrays must be arrays. Semantic rules — a radius must be
 * positive, booleans need at least two operands, an empty solid has no bounds
 * — stay in the kernel contract, whose failures reach the caller as a
 * structured `worker/operation-failed` response carrying the kernel error
 * code in `data`. This keeps the contract the single source of semantic truth
 * and the protocol layer a pure carrier.
 *
 * ## Determinism
 *
 * Serialization emits the canonical form in a fixed key order, with every
 * length normalized to canonical millimetres by cad-core's dimensional-value
 * serializer; parsing accepts any unit of the right dimension. Two equal
 * quantities therefore always produce identical bytes regardless of the units
 * they were built with. Parsing is strict on known fields and tolerant of
 * unknown fields, so newer payload versions deserialize without corruption.
 */

import {
  type AnyDimensionalValue,
  type LengthValue,
  type ParseResult,
  type SerializedDimensionalValue,
  fail,
  ok,
  parseDimensionalValue,
  serializeDimensionalValue,
} from "@slopcad/cad-core";
import type { KernelBounds, Tessellation } from "./contract";

import {
  WORKER_PROTOCOL_ERROR_CODES,
  type WorkerParseError,
  workerParseError,
} from "./worker-errors";
import { type WorkerSolidId, parseWorkerSolidId } from "./worker-ids";

/**
 * The operations the worker protocol carries. Grouped by `<group>.<name>` so
 * later groups (document commands, topology queries) extend the same
 * vocabulary without renaming anything.
 */
export const WORKER_OPERATION_IDS = [
  "solid.createBox",
  "solid.createSphere",
  "solid.createCylinder",
  "solid.createCone",
  "solid.union",
  "solid.subtract",
  "solid.intersect",
  "solid.transform",
  "solid.bounds",
  "solid.volume",
  "solid.tessellate",
  "solid.dispose",
] as const;

/** An operation the worker protocol knows how to carry. */
export type WorkerOperationId = (typeof WORKER_OPERATION_IDS)[number];

const OPERATION_SET: ReadonlySet<string> = new Set(WORKER_OPERATION_IDS);

/** Type guard for untrusted operation names. */
export function isWorkerOperationId(
  input: unknown,
): input is WorkerOperationId {
  return typeof input === "string" && OPERATION_SET.has(input);
}

/** Input of `solid.createBox`: the box's extents along x, y, z. */
export interface WorkerBoxInput {
  readonly width: LengthValue;
  readonly depth: LengthValue;
  readonly height: LengthValue;
}

/** Input of `solid.createSphere`: the radius. */
export interface WorkerSphereInput {
  readonly radius: LengthValue;
}

/** Input of `solid.createCylinder`: the radius and height. */
export interface WorkerCylinderInput {
  readonly radius: LengthValue;
  readonly height: LengthValue;
}

/** Input of `solid.createCone`: the frustum radii and height. */
export interface WorkerConeInput {
  readonly bottomRadius: LengthValue;
  readonly topRadius: LengthValue;
  readonly height: LengthValue;
}

/** Input of `solid.union`: the operands to unite. */
export interface WorkerUnionInput {
  readonly operands: readonly WorkerSolidId[];
}

/** Input of `solid.subtract`: the target and the tools to remove from it. */
export interface WorkerSubtractInput {
  readonly target: WorkerSolidId;
  readonly tools: readonly WorkerSolidId[];
}

/** Input of `solid.intersect`: the operands to intersect. */
export interface WorkerIntersectInput {
  readonly operands: readonly WorkerSolidId[];
}

/** A translation vector of `solid.transform`. */
export interface WorkerTranslationVector {
  readonly x: LengthValue;
  readonly y: LengthValue;
  readonly z: LengthValue;
}

/** Input of `solid.transform`: the solid and the translation to apply. */
export interface WorkerTransformInput {
  readonly solid: WorkerSolidId;
  readonly translation: WorkerTranslationVector;
}

/**
 * Input of the single-solid operations `solid.bounds`, `solid.volume`,
 * `solid.tessellate`, and `solid.dispose`.
 */
export interface WorkerSolidRefInput {
  readonly solid: WorkerSolidId;
}

/** Result of every solid-producing operation: the minted solid's id. */
export interface WorkerSolidResult {
  readonly solid: WorkerSolidId;
}

/** Result of `solid.bounds`: the axis-aligned bounding box in mm. */
export interface WorkerBoundsResult {
  readonly bounds: KernelBounds;
}

/** Result of `solid.volume`: the volume in mm³ (0 for an empty solid). */
export interface WorkerVolumeResult {
  readonly volume: number;
}

/** Result of `solid.tessellate`: the indexed triangle soup in mm. */
export interface WorkerTessellationResult {
  readonly tessellation: Tessellation;
}

/** Result of `solid.dispose`: nothing (`null` on the wire). */
export type WorkerDisposeResult = null;

/** The typed input of each operation. */
export interface WorkerOperationInputs {
  readonly "solid.createBox": WorkerBoxInput;
  readonly "solid.createSphere": WorkerSphereInput;
  readonly "solid.createCylinder": WorkerCylinderInput;
  readonly "solid.createCone": WorkerConeInput;
  readonly "solid.union": WorkerUnionInput;
  readonly "solid.subtract": WorkerSubtractInput;
  readonly "solid.intersect": WorkerIntersectInput;
  readonly "solid.transform": WorkerTransformInput;
  readonly "solid.bounds": WorkerSolidRefInput;
  readonly "solid.volume": WorkerSolidRefInput;
  readonly "solid.tessellate": WorkerSolidRefInput;
  readonly "solid.dispose": WorkerSolidRefInput;
}

/** The typed input of an operation, keyed by operation id. */
export type WorkerOperationInput<
  O extends WorkerOperationId = WorkerOperationId,
> = WorkerOperationInputs[O];

/** The typed result of each operation. */
export interface WorkerOperationResults {
  readonly "solid.createBox": WorkerSolidResult;
  readonly "solid.createSphere": WorkerSolidResult;
  readonly "solid.createCylinder": WorkerSolidResult;
  readonly "solid.createCone": WorkerSolidResult;
  readonly "solid.union": WorkerSolidResult;
  readonly "solid.subtract": WorkerSolidResult;
  readonly "solid.intersect": WorkerSolidResult;
  readonly "solid.transform": WorkerSolidResult;
  readonly "solid.bounds": WorkerBoundsResult;
  readonly "solid.volume": WorkerVolumeResult;
  readonly "solid.tessellate": WorkerTessellationResult;
  readonly "solid.dispose": WorkerDisposeResult;
}

/** The typed result of an operation, keyed by operation id. */
export type WorkerOperationResult<
  O extends WorkerOperationId = WorkerOperationId,
> = WorkerOperationResults[O];

/** Serialized lengths are cad-core dimensional values in canonical mm. */
export type SerializedWorkerLength = SerializedDimensionalValue;

/**
 * The canonical JSON input form of each operation, in a fixed key order.
 * Lengths are canonical (`mm`); solids are referenced by their `wsol_` ids.
 */
export interface SerializedWorkerOperationInputs {
  readonly "solid.createBox": {
    readonly width: SerializedWorkerLength;
    readonly depth: SerializedWorkerLength;
    readonly height: SerializedWorkerLength;
  };
  readonly "solid.createSphere": {
    readonly radius: SerializedWorkerLength;
  };
  readonly "solid.createCylinder": {
    readonly radius: SerializedWorkerLength;
    readonly height: SerializedWorkerLength;
  };
  readonly "solid.createCone": {
    readonly bottomRadius: SerializedWorkerLength;
    readonly topRadius: SerializedWorkerLength;
    readonly height: SerializedWorkerLength;
  };
  readonly "solid.union": {
    readonly operands: readonly string[];
  };
  readonly "solid.subtract": {
    readonly target: string;
    readonly tools: readonly string[];
  };
  readonly "solid.intersect": {
    readonly operands: readonly string[];
  };
  readonly "solid.transform": {
    readonly solid: string;
    readonly translation: {
      readonly x: SerializedWorkerLength;
      readonly y: SerializedWorkerLength;
      readonly z: SerializedWorkerLength;
    };
  };
  readonly "solid.bounds": {
    readonly solid: string;
  };
  readonly "solid.volume": {
    readonly solid: string;
  };
  readonly "solid.tessellate": {
    readonly solid: string;
  };
  readonly "solid.dispose": {
    readonly solid: string;
  };
}

/** The canonical JSON input form of an operation, keyed by operation id. */
export type SerializedWorkerOperationInput<
  O extends WorkerOperationId = WorkerOperationId,
> = SerializedWorkerOperationInputs[O];

/** The canonical JSON result form of each operation. */
export interface SerializedWorkerOperationResults {
  readonly "solid.createBox": {
    readonly solid: string;
  };
  readonly "solid.createSphere": {
    readonly solid: string;
  };
  readonly "solid.createCylinder": {
    readonly solid: string;
  };
  readonly "solid.createCone": {
    readonly solid: string;
  };
  readonly "solid.union": {
    readonly solid: string;
  };
  readonly "solid.subtract": {
    readonly solid: string;
  };
  readonly "solid.intersect": {
    readonly solid: string;
  };
  readonly "solid.transform": {
    readonly solid: string;
  };
  readonly "solid.bounds": {
    readonly bounds: {
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    };
  };
  readonly "solid.volume": {
    readonly volume: number;
  };
  readonly "solid.tessellate": {
    readonly tessellation: {
      readonly positions: readonly number[];
      readonly indices: readonly number[];
      readonly normals?: readonly number[];
    };
  };
  readonly "solid.dispose": null;
}

/** The canonical JSON result form of an operation, keyed by operation id. */
export type SerializedWorkerOperationResult<
  O extends WorkerOperationId = WorkerOperationId,
> = SerializedWorkerOperationResults[O];

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

function payloadError(
  message: string,
  input: unknown,
): ParseResult<never, WorkerParseError> {
  return fail(
    workerParseError(
      WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
      message,
      input,
    ),
  );
}

function requirePayloadRecord(
  operation: WorkerOperationId,
  input: unknown,
): ParseResult<Record<string, unknown>, WorkerParseError> {
  if (!isPlainRecord(input)) {
    return payloadError(
      `The payload of "${operation}" must be a plain object.`,
      input,
    );
  }
  return ok(input);
}

/** Type guard narrowing a parsed dimensional value to a length. */
function isLengthValue(value: AnyDimensionalValue): value is LengthValue {
  return value.dimension === "length";
}

function requireLengthField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<LengthValue, WorkerParseError> {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok) {
    return payloadError(
      `The "${operation}" field "${field}" must be a serialized length value: ${parsed.error.message}`,
      input,
    );
  }
  if (!isLengthValue(parsed.value)) {
    return payloadError(
      `The "${operation}" field "${field}" must be a length; it is a ${parsed.value.dimension}.`,
      input,
    );
  }
  return ok(parsed.value);
}

function requireSolidIdField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<WorkerSolidId, WorkerParseError> {
  const parsed = parseWorkerSolidId(input);
  if (!parsed.ok) {
    return payloadError(
      `The "${operation}" field "${field}" must be a worker solid id: ${parsed.error.message}`,
      input,
    );
  }
  return ok(parsed.value);
}

function requireSolidIdArrayField(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<readonly WorkerSolidId[], WorkerParseError> {
  if (!Array.isArray(input)) {
    return payloadError(
      `The "${operation}" field "${field}" must be an array of worker solid ids.`,
      input,
    );
  }
  const solids: WorkerSolidId[] = [];
  for (const entry of input) {
    const parsed = requireSolidIdField(operation, field, entry);
    if (!parsed.ok) return parsed;
    solids.push(parsed.value);
  }
  return ok(solids);
}

// ---------------------------------------------------------------------------
// Per-operation input codecs
// ---------------------------------------------------------------------------

function serializeBoxInput(
  input: WorkerBoxInput,
): SerializedWorkerOperationInput<"solid.createBox"> {
  return {
    width: serializeDimensionalValue(input.width),
    depth: serializeDimensionalValue(input.depth),
    height: serializeDimensionalValue(input.height),
  };
}

function parseBoxInput(
  payload: unknown,
): ParseResult<WorkerBoxInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createBox", payload);
  if (!record.ok) return record;
  const width = requireLengthField(
    "solid.createBox",
    "width",
    record.value.width,
  );
  if (!width.ok) return width;
  const depth = requireLengthField(
    "solid.createBox",
    "depth",
    record.value.depth,
  );
  if (!depth.ok) return depth;
  const height = requireLengthField(
    "solid.createBox",
    "height",
    record.value.height,
  );
  if (!height.ok) return height;
  return ok({ width: width.value, depth: depth.value, height: height.value });
}

function serializeSphereInput(
  input: WorkerSphereInput,
): SerializedWorkerOperationInput<"solid.createSphere"> {
  return { radius: serializeDimensionalValue(input.radius) };
}

function parseSphereInput(
  payload: unknown,
): ParseResult<WorkerSphereInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createSphere", payload);
  if (!record.ok) return record;
  const radius = requireLengthField(
    "solid.createSphere",
    "radius",
    record.value.radius,
  );
  if (!radius.ok) return radius;
  return ok({ radius: radius.value });
}

function serializeCylinderInput(
  input: WorkerCylinderInput,
): SerializedWorkerOperationInput<"solid.createCylinder"> {
  return {
    radius: serializeDimensionalValue(input.radius),
    height: serializeDimensionalValue(input.height),
  };
}

function parseCylinderInput(
  payload: unknown,
): ParseResult<WorkerCylinderInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createCylinder", payload);
  if (!record.ok) return record;
  const radius = requireLengthField(
    "solid.createCylinder",
    "radius",
    record.value.radius,
  );
  if (!radius.ok) return radius;
  const height = requireLengthField(
    "solid.createCylinder",
    "height",
    record.value.height,
  );
  if (!height.ok) return height;
  return ok({ radius: radius.value, height: height.value });
}

function serializeConeInput(
  input: WorkerConeInput,
): SerializedWorkerOperationInput<"solid.createCone"> {
  return {
    bottomRadius: serializeDimensionalValue(input.bottomRadius),
    topRadius: serializeDimensionalValue(input.topRadius),
    height: serializeDimensionalValue(input.height),
  };
}

function parseConeInput(
  payload: unknown,
): ParseResult<WorkerConeInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.createCone", payload);
  if (!record.ok) return record;
  const bottomRadius = requireLengthField(
    "solid.createCone",
    "bottomRadius",
    record.value.bottomRadius,
  );
  if (!bottomRadius.ok) return bottomRadius;
  const topRadius = requireLengthField(
    "solid.createCone",
    "topRadius",
    record.value.topRadius,
  );
  if (!topRadius.ok) return topRadius;
  const height = requireLengthField(
    "solid.createCone",
    "height",
    record.value.height,
  );
  if (!height.ok) return height;
  return ok({
    bottomRadius: bottomRadius.value,
    topRadius: topRadius.value,
    height: height.value,
  });
}

function serializeOperandsInput(input: {
  readonly operands: readonly WorkerSolidId[];
}): {
  readonly operands: readonly string[];
} {
  return { operands: [...input.operands] };
}

function parseOperandsInput(
  operation: "solid.union" | "solid.intersect",
  payload: unknown,
): ParseResult<
  { readonly operands: readonly WorkerSolidId[] },
  WorkerParseError
> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const operands = requireSolidIdArrayField(
    operation,
    "operands",
    record.value.operands,
  );
  if (!operands.ok) return operands;
  return ok({ operands: operands.value });
}

function serializeSubtractInput(
  input: WorkerSubtractInput,
): SerializedWorkerOperationInput<"solid.subtract"> {
  return { target: input.target, tools: [...input.tools] };
}

function parseSubtractInput(
  payload: unknown,
): ParseResult<WorkerSubtractInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.subtract", payload);
  if (!record.ok) return record;
  const target = requireSolidIdField(
    "solid.subtract",
    "target",
    record.value.target,
  );
  if (!target.ok) return target;
  const tools = requireSolidIdArrayField(
    "solid.subtract",
    "tools",
    record.value.tools,
  );
  if (!tools.ok) return tools;
  return ok({ target: target.value, tools: tools.value });
}

function serializeTransformInput(
  input: WorkerTransformInput,
): SerializedWorkerOperationInput<"solid.transform"> {
  return {
    solid: input.solid,
    translation: {
      x: serializeDimensionalValue(input.translation.x),
      y: serializeDimensionalValue(input.translation.y),
      z: serializeDimensionalValue(input.translation.z),
    },
  };
}

function parseTransformInput(
  payload: unknown,
): ParseResult<WorkerTransformInput, WorkerParseError> {
  const record = requirePayloadRecord("solid.transform", payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(
    "solid.transform",
    "solid",
    record.value.solid,
  );
  if (!solid.ok) return solid;
  if (!isPlainRecord(record.value.translation)) {
    return payloadError(
      'The "solid.transform" field "translation" must be a plain object with x, y, z length fields.',
      record.value.translation,
    );
  }
  const x = requireLengthField(
    "solid.transform",
    "translation.x",
    record.value.translation.x,
  );
  if (!x.ok) return x;
  const y = requireLengthField(
    "solid.transform",
    "translation.y",
    record.value.translation.y,
  );
  if (!y.ok) return y;
  const z = requireLengthField(
    "solid.transform",
    "translation.z",
    record.value.translation.z,
  );
  if (!z.ok) return z;
  return ok({
    solid: solid.value,
    translation: { x: x.value, y: y.value, z: z.value },
  });
}

function serializeSolidRefInput(input: WorkerSolidRefInput): {
  readonly solid: string;
} {
  return { solid: input.solid };
}

function parseSolidRefInput(
  operation:
    "solid.bounds" | "solid.volume" | "solid.tessellate" | "solid.dispose",
  payload: unknown,
): ParseResult<WorkerSolidRefInput, WorkerParseError> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(operation, "solid", record.value.solid);
  if (!solid.ok) return solid;
  return ok({ solid: solid.value });
}

/**
 * The input codec table: one serializer and one parser per operation. This
 * registry is the operation vocabulary as data — adding an operation without
 * registering its codecs fails to compile.
 */
const INPUT_SERIALIZERS: {
  readonly [O in WorkerOperationId]: (
    input: WorkerOperationInput<O>,
  ) => SerializedWorkerOperationInput<O>;
} = {
  "solid.createBox": serializeBoxInput,
  "solid.createSphere": serializeSphereInput,
  "solid.createCylinder": serializeCylinderInput,
  "solid.createCone": serializeConeInput,
  "solid.union": serializeOperandsInput,
  "solid.subtract": serializeSubtractInput,
  "solid.intersect": serializeOperandsInput,
  "solid.transform": serializeTransformInput,
  "solid.bounds": serializeSolidRefInput,
  "solid.volume": serializeSolidRefInput,
  "solid.tessellate": serializeSolidRefInput,
  "solid.dispose": serializeSolidRefInput,
};

const INPUT_PARSERS: {
  readonly [O in WorkerOperationId]: (
    payload: unknown,
  ) => ParseResult<WorkerOperationInput<O>, WorkerParseError>;
} = {
  "solid.createBox": parseBoxInput,
  "solid.createSphere": parseSphereInput,
  "solid.createCylinder": parseCylinderInput,
  "solid.createCone": parseConeInput,
  "solid.union": (payload) => parseOperandsInput("solid.union", payload),
  "solid.subtract": parseSubtractInput,
  "solid.intersect": (payload) =>
    parseOperandsInput("solid.intersect", payload),
  "solid.transform": parseTransformInput,
  "solid.bounds": (payload) => parseSolidRefInput("solid.bounds", payload),
  "solid.volume": (payload) => parseSolidRefInput("solid.volume", payload),
  "solid.tessellate": (payload) =>
    parseSolidRefInput("solid.tessellate", payload),
  "solid.dispose": (payload) => parseSolidRefInput("solid.dispose", payload),
};

/**
 * Serializes an operation's typed input to its canonical wire form: fixed key
 * order, lengths normalized to millimetres.
 */
export function serializeWorkerOperationInput<O extends WorkerOperationId>(
  operation: O,
  input: WorkerOperationInput<O>,
): SerializedWorkerOperationInput<O> {
  return INPUT_SERIALIZERS[operation](input);
}

/**
 * Parses untrusted input as the given operation's input payload. Strict on
 * known fields, tolerant of unknown fields; rejects with
 * `worker/malformed-payload`.
 */
export function parseWorkerOperationInput<O extends WorkerOperationId>(
  operation: O,
  payload: unknown,
): ParseResult<WorkerOperationInput<O>, WorkerParseError> {
  return INPUT_PARSERS[operation](payload);
}

// ---------------------------------------------------------------------------
// Per-operation result codecs
// ---------------------------------------------------------------------------

function serializeSolidResult(result: WorkerSolidResult): {
  readonly solid: string;
} {
  return { solid: result.solid };
}

function parseSolidResult(
  operation: WorkerOperationId,
  payload: unknown,
): ParseResult<WorkerSolidResult, WorkerParseError> {
  const record = requirePayloadRecord(operation, payload);
  if (!record.ok) return record;
  const solid = requireSolidIdField(operation, "solid", record.value.solid);
  if (!solid.ok) return solid;
  return ok({ solid: solid.value });
}

/** Copies input into a finite-number array, or `undefined` if it is not one. */
function finiteNumberArray(input: unknown): readonly number[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries: readonly unknown[] = input;
  const values: number[] = [];
  for (const entry of entries) {
    if (!isFiniteNumber(entry)) return undefined;
    values.push(entry);
  }
  return values;
}

/** Copies input into a non-negative integer array, or `undefined` if it is not one. */
function nonNegativeIntegerArray(
  input: unknown,
): readonly number[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries: readonly unknown[] = input;
  const values: number[] = [];
  for (const entry of entries) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      return undefined;
    }
    values.push(entry);
  }
  return values;
}

function parsePoint3(
  operation: WorkerOperationId,
  field: string,
  input: unknown,
): ParseResult<readonly [number, number, number], WorkerParseError> {
  const values = finiteNumberArray(input);
  if (values === undefined || values.length !== 3) {
    return payloadError(
      `The "${operation}" bounds field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  const [x, y, z] = values;
  if (x === undefined || y === undefined || z === undefined) {
    return payloadError(
      `The "${operation}" bounds field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  return ok([x, y, z]);
}

function serializeBoundsResult(
  result: WorkerBoundsResult,
): SerializedWorkerOperationResult<"solid.bounds"> {
  return {
    bounds: {
      min: [...result.bounds.min],
      max: [...result.bounds.max],
    },
  };
}

function parseBoundsResult(
  payload: unknown,
): ParseResult<WorkerBoundsResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.bounds", payload);
  if (!record.ok) return record;
  if (!isPlainRecord(record.value.bounds)) {
    return payloadError(
      'The "solid.bounds" result field "bounds" must be a plain object with min and max points.',
      record.value.bounds,
    );
  }
  const min = parsePoint3("solid.bounds", "min", record.value.bounds.min);
  if (!min.ok) return min;
  const max = parsePoint3("solid.bounds", "max", record.value.bounds.max);
  if (!max.ok) return max;
  return ok({ bounds: { min: min.value, max: max.value } });
}

function serializeVolumeResult(
  result: WorkerVolumeResult,
): SerializedWorkerOperationResult<"solid.volume"> {
  return { volume: result.volume };
}

function parseVolumeResult(
  payload: unknown,
): ParseResult<WorkerVolumeResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.volume", payload);
  if (!record.ok) return record;
  const volume = record.value.volume;
  if (!isFiniteNumber(volume) || volume < 0) {
    return payloadError(
      'The "solid.volume" result field "volume" must be a finite, non-negative number.',
      volume,
    );
  }
  return ok({ volume });
}

function serializeTessellationResult(
  result: WorkerTessellationResult,
): SerializedWorkerOperationResult<"solid.tessellate"> {
  const tessellation = result.tessellation;
  if (tessellation.normals === undefined) {
    return {
      tessellation: {
        positions: [...tessellation.positions],
        indices: [...tessellation.indices],
      },
    };
  }
  return {
    tessellation: {
      positions: [...tessellation.positions],
      indices: [...tessellation.indices],
      normals: [...tessellation.normals],
    },
  };
}

function parseTessellationResult(
  payload: unknown,
): ParseResult<WorkerTessellationResult, WorkerParseError> {
  const record = requirePayloadRecord("solid.tessellate", payload);
  if (!record.ok) return record;
  if (!isPlainRecord(record.value.tessellation)) {
    return payloadError(
      'The "solid.tessellate" result field "tessellation" must be a plain object with positions and indices arrays.',
      record.value.tessellation,
    );
  }
  const { positions, indices, normals } = record.value.tessellation;
  const parsedPositions = finiteNumberArray(positions);
  if (parsedPositions === undefined) {
    return payloadError(
      'The "solid.tessellate" tessellation "positions" must be an array of finite numbers.',
      positions,
    );
  }
  if (parsedPositions.length % 3 !== 0) {
    return payloadError(
      'The "solid.tessellate" tessellation "positions" length must be divisible by 3.',
      positions,
    );
  }
  const parsedIndices = nonNegativeIntegerArray(indices);
  if (parsedIndices === undefined) {
    return payloadError(
      'The "solid.tessellate" tessellation "indices" must be an array of non-negative integers.',
      indices,
    );
  }
  if (parsedIndices.length % 3 !== 0) {
    return payloadError(
      'The "solid.tessellate" tessellation "indices" length must be divisible by 3.',
      indices,
    );
  }
  const vertexCount = parsedPositions.length / 3;
  if (parsedIndices.some((index) => index >= vertexCount)) {
    return payloadError(
      'The "solid.tessellate" tessellation "indices" must reference existing vertices.',
      indices,
    );
  }
  if (normals === undefined) {
    return ok({
      tessellation: { positions: parsedPositions, indices: parsedIndices },
    });
  }
  const parsedNormals = finiteNumberArray(normals);
  if (parsedNormals === undefined) {
    return payloadError(
      'The "solid.tessellate" tessellation "normals" must be an array of finite numbers.',
      normals,
    );
  }
  if (parsedNormals.length !== parsedPositions.length) {
    return payloadError(
      'The "solid.tessellate" tessellation "normals" must pair index-for-index with "positions".',
      normals,
    );
  }
  return ok({
    tessellation: {
      positions: parsedPositions,
      indices: parsedIndices,
      normals: parsedNormals,
    },
  });
}

function serializeDisposeResult(): null {
  return null;
}

function parseDisposeResult(
  payload: unknown,
): ParseResult<WorkerDisposeResult, WorkerParseError> {
  if (payload !== null) {
    return payloadError('The "solid.dispose" result must be null.', payload);
  }
  return ok(null);
}

/**
 * The result codec table, the input table's twin: one serializer and one
 * parser per operation.
 */
const RESULT_SERIALIZERS: {
  readonly [O in WorkerOperationId]: (
    result: WorkerOperationResult<O>,
  ) => SerializedWorkerOperationResult<O>;
} = {
  "solid.createBox": serializeSolidResult,
  "solid.createSphere": serializeSolidResult,
  "solid.createCylinder": serializeSolidResult,
  "solid.createCone": serializeSolidResult,
  "solid.union": serializeSolidResult,
  "solid.subtract": serializeSolidResult,
  "solid.intersect": serializeSolidResult,
  "solid.transform": serializeSolidResult,
  "solid.bounds": serializeBoundsResult,
  "solid.volume": serializeVolumeResult,
  "solid.tessellate": serializeTessellationResult,
  "solid.dispose": serializeDisposeResult,
};

const RESULT_PARSERS: {
  readonly [O in WorkerOperationId]: (
    payload: unknown,
  ) => ParseResult<WorkerOperationResult<O>, WorkerParseError>;
} = {
  "solid.createBox": (payload) => parseSolidResult("solid.createBox", payload),
  "solid.createSphere": (payload) =>
    parseSolidResult("solid.createSphere", payload),
  "solid.createCylinder": (payload) =>
    parseSolidResult("solid.createCylinder", payload),
  "solid.createCone": (payload) =>
    parseSolidResult("solid.createCone", payload),
  "solid.union": (payload) => parseSolidResult("solid.union", payload),
  "solid.subtract": (payload) => parseSolidResult("solid.subtract", payload),
  "solid.intersect": (payload) => parseSolidResult("solid.intersect", payload),
  "solid.transform": (payload) => parseSolidResult("solid.transform", payload),
  "solid.bounds": parseBoundsResult,
  "solid.volume": parseVolumeResult,
  "solid.tessellate": parseTessellationResult,
  "solid.dispose": parseDisposeResult,
};

/**
 * Serializes an operation's typed result to its canonical wire form: fixed
 * key order, plain arrays for the triangle soup.
 */
export function serializeWorkerOperationResult<O extends WorkerOperationId>(
  operation: O,
  result: WorkerOperationResult<O>,
): SerializedWorkerOperationResult<O> {
  return RESULT_SERIALIZERS[operation](result);
}

/**
 * Parses untrusted input as the given operation's result payload. Enforces
 * the kernel contract's structural guarantees at the trust boundary —
 * divisible-by-3 soup arrays, in-range vertex indices, normals paired
 * index-for-index with positions, finite numbers throughout — and rejects
 * with `worker/malformed-payload`.
 */
export function parseWorkerOperationResult<O extends WorkerOperationId>(
  operation: O,
  payload: unknown,
): ParseResult<WorkerOperationResult<O>, WorkerParseError> {
  return RESULT_PARSERS[operation](payload);
}

/**
 * The mint-extraction table: for each operation, the solid its result mints —
 * exactly the solid-producing operations' results carry a
 * {@link WorkerSolidId}; every measurement/tessellation/disposal result owns
 * no session solid. Registered like the codec tables above, so adding an
 * operation forces a decision here at compile time.
 */
const RESULT_MINTS: {
  readonly [O in WorkerOperationId]: (
    result: WorkerOperationResult<O>,
  ) => WorkerSolidId | undefined;
} = {
  "solid.createBox": (result) => result.solid,
  "solid.createSphere": (result) => result.solid,
  "solid.createCylinder": (result) => result.solid,
  "solid.createCone": (result) => result.solid,
  "solid.union": (result) => result.solid,
  "solid.subtract": (result) => result.solid,
  "solid.intersect": (result) => result.solid,
  "solid.transform": (result) => result.solid,
  "solid.bounds": () => undefined,
  "solid.volume": () => undefined,
  "solid.tessellate": () => undefined,
  "solid.dispose": () => undefined,
};

/**
 * The session solid `operation`'s `result` minted, or `undefined` when the
 * result owns no solid. This is the codec-table answer to "does this result
 * carry a solid id" — the single source of truth, so callers (the stale-result
 * coordinator recording mints, the worker client releasing a voided request's
 * orphaned mint) never re-derive it by probing result shapes.
 */
export function resultMintsSolid<O extends WorkerOperationId>(
  operation: O,
  result: WorkerOperationResult<O>,
): WorkerSolidId | undefined {
  return RESULT_MINTS[operation](result);
}
