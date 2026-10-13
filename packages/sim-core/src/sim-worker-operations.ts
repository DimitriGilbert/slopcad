/**
 * The sim worker protocol's operation vocabulary (Phase 61b): the `sim.*`
 * operations a worker request can carry, as data — the twin of the kernel
 * protocol's `worker-operations` (`@slopcad/cad-kernel`), restated under
 * sim-core's zero-runtime-dependency stance with the same table discipline:
 * each operation id maps to four codec entries — typed input, canonical
 * serialized input, and the same pair for results — registered in the typed
 * maps below, so the mapped types force every codec to exist before the
 * package compiles.
 *
 * Three operations today, grouped `sim.<name>`:
 *
 * - `sim.compile` — scenario → compiled problem: the serialized scenario
 *   JSON (plus optional motor record and body bounds) crosses the wire, the
 *   worker executes the 61a S4/S9 compile boundary (`compileSimScenario`),
 *   and the response mints a session {@link SimProblemId} while returning
 *   the compiled scenario's wire form (the regime report and snapshot hash
 *   reach the host without a run).
 * - `sim.run` — start a run on a compiled problem: the worker drives the
 *   hosted {@link SimEngine}, emitting `progress` and `field-chunk`
 *   notifications (see `./sim-worker-protocol`) between steps; the terminal
 *   response mints a session {@link SimRunId} and reports the run's step and
 *   chunk counts. The final result stays worker-side until finalize.
 * - `sim.finalize` — result finalize: fetch the authoritative
 *   {@link SimResult} of a completed run as its persisted form — the
 *   summary JSON verbatim, the field blocks as the deterministic `SMR1`
 *   binary payload bytes (strict base64 on the wire), and the history
 *   series. Repeatable for the channel's lifetime: the run's result stays
 *   addressable, and repeat finalize answers identical bytes.
 *
 * Cancellation is NOT an operation: it rides the envelope's `cancel` message
 * through the cancellation-ledger discipline (`./sim-worker-cancellation`),
 * exactly as in the kernel protocol.
 *
 * ## Division of validation labor
 *
 * The codecs validate *structure only* — ids must parse as sim worker ids,
 * extents as positive integer triples, values as finite numbers, payload
 * bytes as strict base64 that decodes as an `SMR1` block set. Semantic
 * rules — the scenario compiling, the problem belonging to this session,
 * the engine supporting the kind — stay in the compile boundary, the
 * session, and the engine, whose structured `sim/*` failures reach the
 * caller as a `worker/operation-failed` response carrying the code in
 * `data.simCode`.
 *
 * ## Determinism
 *
 * Serialization emits the canonical form in a fixed key order; identical
 * values produce identical bytes. Parsing is strict on known fields and
 * tolerant of unknown fields, so newer payload revisions deserialize without
 * corruption. Every message survives `value → JSON → value` unchanged.
 */

import type {
  SimHistorySeries,
  SimResult,
  SimResultSummary,
} from "./sim-result";
import type { SimProblemId, SimRunId } from "./sim-worker-ids";
import type { SimWorkerParseError } from "./sim-worker-errors";
import type {
  CompiledSimCondition,
  CompiledSimMotor,
  CompiledSimScenario,
  SimBodyBoundsMm,
  SimMechanismWire,
} from "./units";
import type { SimStructuralChainInput } from "./compile-geometry";
import type { SimDomainFace } from "./vocabulary";
import type { SimQualitativeFlag } from "./regime";

import { decodeSimBase64Strict, encodeSimBase64 } from "./sim-base64";
import { SIM_QUALITATIVE_FLAGS } from "./regime";
import { decodeSimResultPayload, encodeSimResultPayload } from "./sim-result";
import { parseSimProblemId, parseSimRunId } from "./sim-worker-ids";
import {
  SIM_WORKER_PROTOCOL_ERROR_CODES,
  simWorkerParseError,
} from "./sim-worker-errors";
import { isSimScenarioKind, SIM_CORE_DOMAIN_FACES } from "./vocabulary";

/**
 * The operations the sim worker protocol carries. Grouped `sim.<name>` so
 * later groups extend the vocabulary without renaming anything.
 */
export const SIM_WORKER_OPERATION_IDS = [
  "sim.compile",
  "sim.run",
  "sim.finalize",
] as const;

/** An operation the sim worker protocol knows how to carry. */
export type SimWorkerOperationId = (typeof SIM_WORKER_OPERATION_IDS)[number];

const OPERATION_SET: ReadonlySet<string> = new Set(SIM_WORKER_OPERATION_IDS);

/** Type guard for untrusted operation names. */
export function isSimWorkerOperationId(
  input: unknown,
): input is SimWorkerOperationId {
  return typeof input === "string" && OPERATION_SET.has(input);
}

// ---------------------------------------------------------------------------
// Typed forms
// ---------------------------------------------------------------------------

/**
 * Input of `sim.compile`: the scenario's canonical serialized JSON verbatim
 * (the compile boundary re-validates every field — the 61a trust
 * discipline), the optional selected motor record in the same form, the
 * optional body geometry bounds (document millimetres) a body-derived domain
 * needs, and — Phase 63c — the optional merged tessellation of the
 * scenario's referenced bodies in the voxelizer's wire form (flat mm
 * positions/indices, optional normals): the geometry-aware compile door
 * (`compileSimScenarioWithGeometry`) voxelizes it into the compiled
 * problem's occupancy slice. Phase 65c adds the thermal branch's pair: the
 * optional serialized `DocumentMaterialRecord` wire objects the scenario's
 * material assignments reference, and the referenced bodies' OWN
 * tessellations (one entry per body) — the per-body form the per-cell
 * material map needs.
 */
export interface WorkerSimCompileInput {
  readonly scenario: unknown;
  readonly motor?: unknown;
  readonly bodyBounds?: readonly SimBodyBoundsMm[];
  readonly tessellation?: unknown;
  /** Phase 65c: the material records the thermal branch resolves by id. */
  readonly materials?: readonly unknown[];
  /** Phase 65c: the per-body tessellations the thermal branch voxelizes. */
  readonly bodyTessellations?: readonly {
    readonly bodyId: string;
    readonly tessellation: unknown;
  }[];
  /**
   * Phase 67c: the mechanism wire the dynamics branch compiles — the
   * document's resolved occurrences, serialized joint records, mass
   * properties, and grounded ids, crossing verbatim after the
   * structural gate (the compile boundary re-validates).
   */
  readonly mechanism?: SimMechanismWire;
  /**
   * Phase 69: the structural branch's run-time chain inputs — a thermal
   * run's temperature block and/or a fan run's found operating rpm,
   * crossing after the structural gate for the structural compile
   * branch's own re-validation (each consumed only when the stance asks).
   */
  readonly structuralChain?: SimStructuralChainInput;
}

/** Result of `sim.compile`: the minted problem id plus the compiled scenario. */
export interface WorkerSimCompileResult {
  readonly problem: SimProblemId;
  readonly compiled: CompiledSimScenario;
}

/** Input of `sim.run`: the compiled problem to run. */
export interface WorkerSimRunInput {
  readonly problem: SimProblemId;
}

/** Result of `sim.run`: the minted run id plus the run's emission counts. */
export interface WorkerSimRunResult {
  readonly run: SimRunId;
  /** The engine's final step count. */
  readonly steps: number;
  /** The field-chunk notifications the run emitted. */
  readonly chunks: number;
}

/** Input of `sim.finalize`: the completed run whose result to fetch. */
export interface WorkerSimFinalizeInput {
  readonly run: SimRunId;
}

/**
 * Result of `sim.finalize`: the run's {@link SimResult} in its persisted
 * form — the summary JSON verbatim, the field blocks as the deterministic
 * `SMR1` binary payload bytes, and the history series.
 */
export interface WorkerSimFinalizeResult {
  readonly summary: SimResultSummary;
  /** The encoded {@link SimResult} field-block payload (`SMR1` layout). */
  readonly payload: Uint8Array;
  readonly histories: readonly SimHistorySeries[];
}

/** The typed input of each operation. */
export interface SimWorkerOperationInputs {
  readonly "sim.compile": WorkerSimCompileInput;
  readonly "sim.run": WorkerSimRunInput;
  readonly "sim.finalize": WorkerSimFinalizeInput;
}

/** The typed input of an operation, keyed by operation id. */
export type SimWorkerOperationInput<
  O extends SimWorkerOperationId = SimWorkerOperationId,
> = SimWorkerOperationInputs[O];

/** The typed result of each operation. */
export interface SimWorkerOperationResults {
  readonly "sim.compile": WorkerSimCompileResult;
  readonly "sim.run": WorkerSimRunResult;
  readonly "sim.finalize": WorkerSimFinalizeResult;
}

/** The typed result of an operation, keyed by operation id. */
export type SimWorkerOperationResult<
  O extends SimWorkerOperationId = SimWorkerOperationId,
> = SimWorkerOperationResults[O];

// ---------------------------------------------------------------------------
// Serialized (wire) forms — fixed key order
// ---------------------------------------------------------------------------

/** One serialized body bound of `sim.compile`'s input (document mm). */
export interface SerializedSimBodyBounds {
  readonly bodyId: string;
  readonly minMm: readonly [number, number, number];
  readonly maxMm: readonly [number, number, number];
}

/**
 * The canonical wire form of a compiled boundary condition. The face is
 * absent on the structural point set (Phase 69), which carries the
 * world application point in metres (SI, converted at the 61a door).
 */
export interface SerializedSimCondition {
  readonly kind: string;
  readonly face?: string;
  readonly velocityMPerS?: readonly [number, number, number];
  readonly pressurePa?: number;
  readonly slip?: boolean;
  readonly temperatureK?: number;
  readonly fluxWPerM2?: number;
  readonly heatTransferCoefficientWPerM2K?: number;
  readonly ambientTemperatureK?: number;
  readonly emissivity?: number;
  readonly forceN?: readonly [number, number, number];
  readonly axis?: string;
  readonly atWorldPointM?: readonly [number, number, number];
}

/** The canonical wire form of a compiled scenario (pure SI, fixed keys). */
export interface SerializedCompiledSimScenario {
  readonly kind: string;
  readonly name: string;
  readonly domainMinM: readonly [number, number, number];
  readonly domainMaxM: readonly [number, number, number];
  readonly cellSizeM: number;
  readonly characteristicLengthM: number;
  readonly gravityMPerS2: readonly [number, number, number];
  readonly conditions: readonly SerializedSimCondition[];
  readonly fluid: Record<string, unknown>;
  readonly motor?: Record<string, unknown>;
  readonly backend: "cpu" | "gpu";
  readonly regime: Record<string, unknown>;
  readonly scenarioSnapshotHash: string;
}

/** The canonical JSON input form of each operation, in a fixed key order. */
export interface SerializedSimWorkerOperationInputs {
  readonly "sim.compile": {
    readonly scenario: unknown;
    readonly motor?: unknown;
    readonly bodyBounds?: readonly SerializedSimBodyBounds[];
    readonly tessellation?: unknown;
    readonly materials?: readonly unknown[];
    readonly bodyTessellations?: readonly {
      readonly bodyId: string;
      readonly tessellation: unknown;
    }[];
    readonly mechanism?: {
      readonly occurrences: readonly unknown[];
      readonly joints: readonly unknown[];
      readonly masses: readonly unknown[];
      readonly grounded?: readonly string[];
    };
    readonly structuralChain?: {
      readonly thermal?: {
        readonly field: {
          readonly originMm: readonly [number, number, number];
          readonly spacingMm: readonly [number, number, number];
          readonly extent: readonly [number, number, number];
          readonly values: readonly number[];
        };
      };
      readonly fanRpm?: number;
    };
  };
  readonly "sim.run": {
    readonly problem: string;
  };
  readonly "sim.finalize": {
    readonly run: string;
  };
}

/** The canonical JSON input form of an operation, keyed by operation id. */
export type SerializedSimWorkerOperationInput<
  O extends SimWorkerOperationId = SimWorkerOperationId,
> = SerializedSimWorkerOperationInputs[O];

/** The canonical JSON result form of each operation, in a fixed key order. */
export interface SerializedSimWorkerOperationResults {
  readonly "sim.compile": {
    readonly problem: string;
    readonly compiled: SerializedCompiledSimScenario;
  };
  readonly "sim.run": {
    readonly run: string;
    readonly steps: number;
    readonly chunks: number;
  };
  readonly "sim.finalize": {
    readonly summary: Record<string, unknown>;
    readonly payload: string;
    readonly histories: readonly SimHistorySeries[];
  };
}

/** The canonical JSON result form of an operation, keyed by operation id. */
export type SerializedSimWorkerOperationResult<
  O extends SimWorkerOperationId = SimWorkerOperationId,
> = SerializedSimWorkerOperationResults[O];

// ---------------------------------------------------------------------------
// Parse plumbing
// ---------------------------------------------------------------------------

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: SimWorkerParseError;
    };

function parseOk<T>(value: T): ParseOutcome<T> {
  return { ok: true, value };
}

function payloadError(
  message: string,
  input: unknown,
): { ok: false; error: SimWorkerParseError } {
  return {
    ok: false,
    error: simWorkerParseError(
      SIM_WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
      message,
      input,
    ),
  };
}

function requirePayloadRecord(
  operation: SimWorkerOperationId,
  input: unknown,
): ParseOutcome<Record<string, unknown>> {
  if (!isPlainRecord(input)) {
    return payloadError(
      `The payload of "${operation}" must be a plain object.`,
      input,
    );
  }
  return parseOk(input);
}

function requireFinite(
  input: unknown,
  operation: SimWorkerOperationId,
  field: string,
): ParseOutcome<number> {
  if (!isFiniteNumber(input)) {
    return payloadError(
      `The "${operation}" field "${field}" must be a finite number.`,
      input,
    );
  }
  return parseOk(input);
}

function requireNonNegativeInteger(
  input: unknown,
  operation: SimWorkerOperationId,
  field: string,
): ParseOutcome<number> {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    return payloadError(
      `The "${operation}" field "${field}" must be a non-negative integer.`,
      input,
    );
  }
  return parseOk(input);
}

function requireString(
  input: unknown,
  operation: SimWorkerOperationId,
  field: string,
): ParseOutcome<string> {
  if (typeof input !== "string" || input.length === 0) {
    return payloadError(
      `The "${operation}" field "${field}" must be a non-empty string.`,
      input,
    );
  }
  return parseOk(input);
}

function finiteTriple(
  input: unknown,
  operation: SimWorkerOperationId,
  field: string,
): ParseOutcome<readonly [number, number, number]> {
  // The element-wise copy keeps the element type `unknown` (never the
  // `any` Array.isArray narrows to), so every component narrows through
  // its own typeof/finite check below.
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (entries.length !== 3 || !entries.every(isFiniteNumber)) {
    return payloadError(
      `The "${operation}" field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  const [x, y, z] = entries as readonly [number, number, number];
  return parseOk([x, y, z]);
}

// ---------------------------------------------------------------------------
// sim.compile codecs
// ---------------------------------------------------------------------------

function serializeCompileInput(
  input: WorkerSimCompileInput,
): SerializedSimWorkerOperationInputs["sim.compile"] {
  return {
    scenario: input.scenario,
    ...(input.motor === undefined ? {} : { motor: input.motor }),
    ...(input.bodyBounds === undefined
      ? {}
      : {
          bodyBounds: input.bodyBounds.map(
            (entry): SerializedSimBodyBounds => ({
              bodyId: entry.bodyId,
              minMm: [...entry.minMm] as readonly [number, number, number],
              maxMm: [...entry.maxMm] as readonly [number, number, number],
            }),
          ),
        }),
    ...(input.tessellation === undefined
      ? {}
      : { tessellation: input.tessellation }),
    ...(input.materials === undefined
      ? {}
      : { materials: [...input.materials] }),
    ...(input.bodyTessellations === undefined
      ? {}
      : {
          bodyTessellations: input.bodyTessellations.map((entry) => ({
            bodyId: entry.bodyId,
            tessellation: entry.tessellation,
          })),
        }),
    ...(input.mechanism === undefined
      ? {}
      : {
          mechanism: {
            occurrences: [...input.mechanism.occurrences],
            joints: [...input.mechanism.joints],
            masses: [...input.mechanism.masses],
            ...(input.mechanism.grounded === undefined
              ? {}
              : { grounded: [...input.mechanism.grounded] }),
          },
        }),
    ...(input.structuralChain === undefined
      ? {}
      : {
          structuralChain: serializeStructuralChain(input.structuralChain),
        }),
  };
}

/** Canonical wire form of the structural branch's chain inputs. */
function serializeStructuralChain(
  chain: SimStructuralChainInput,
): SerializedSimWorkerOperationInputs["sim.compile"]["structuralChain"] {
  return {
    ...(chain.thermal === undefined
      ? {}
      : {
          thermal: {
            field: {
              originMm: [...chain.thermal.field.originMm] as [
                number,
                number,
                number,
              ],
              spacingMm: [...chain.thermal.field.spacingMm] as [
                number,
                number,
                number,
              ],
              extent: [...chain.thermal.field.extent] as [
                number,
                number,
                number,
              ],
              values: [...chain.thermal.field.values],
            },
          },
        }),
    ...(chain.fanRpm === undefined ? {} : { fanRpm: chain.fanRpm }),
  };
}

/**
 * Parses the structural branch's chain inputs (structure only — the
 * compile door re-validates every consumed magnitude).
 */
function parseStructuralChain(
  input: unknown,
): ParseOutcome<SimStructuralChainInput | undefined> {
  if (input === undefined || input === null) return parseOk(undefined);
  const record = requirePayloadRecord("sim.compile", input);
  if (!record.ok) return record;
  let thermal: SimStructuralChainInput["thermal"];
  if (record.value.thermal !== undefined && record.value.thermal !== null) {
    const thermalRecord = requirePayloadRecord(
      "sim.compile",
      record.value.thermal,
    );
    if (!thermalRecord.ok) return thermalRecord;
    const fieldRecord = requirePayloadRecord(
      "sim.compile",
      thermalRecord.value.field,
    );
    if (!fieldRecord.ok) return fieldRecord;
    const originMm = finiteTriple(
      fieldRecord.value.originMm,
      "sim.compile",
      "structuralChain.thermal.field.originMm",
    );
    if (!originMm.ok) return originMm;
    const spacingMm = finiteTriple(
      fieldRecord.value.spacingMm,
      "sim.compile",
      "structuralChain.thermal.field.spacingMm",
    );
    if (!spacingMm.ok) return spacingMm;
    const extent = finiteTriple(
      fieldRecord.value.extent,
      "sim.compile",
      "structuralChain.thermal.field.extent",
    );
    if (!extent.ok) return extent;
    if (!extent.value.every((entry) => Number.isInteger(entry) && entry > 0)) {
      return payloadError(
        'The "sim.compile" field "structuralChain.thermal.field.extent" must be three positive integers.',
        fieldRecord.value.extent,
      );
    }
    if (!Array.isArray(fieldRecord.value.values)) {
      return payloadError(
        'The "sim.compile" field "structuralChain.thermal.field.values" must be an array of finite numbers.',
        fieldRecord.value.values,
      );
    }
    const values: number[] = [];
    for (const value of fieldRecord.value.values) {
      const parsed = requireFinite(
        value,
        "sim.compile",
        "structuralChain.thermal.field.values",
      );
      if (!parsed.ok) return parsed;
      values.push(parsed.value);
    }
    thermal = {
      field: {
        originMm: originMm.value,
        spacingMm: spacingMm.value,
        extent: extent.value,
        values,
      },
    };
  }
  let fanRpm: number | undefined;
  if (record.value.fanRpm !== undefined && record.value.fanRpm !== null) {
    const parsed = requireFinite(
      record.value.fanRpm,
      "sim.compile",
      "structuralChain.fanRpm",
    );
    if (!parsed.ok) return parsed;
    fanRpm = parsed.value;
  }
  return parseOk({
    ...(thermal === undefined ? {} : { thermal }),
    ...(fanRpm === undefined ? {} : { fanRpm }),
  });
}

function parseBodyBoundsEntry(input: unknown): ParseOutcome<SimBodyBoundsMm> {
  const record = requirePayloadRecord("sim.compile", input);
  if (!record.ok) return record;
  const bodyId = requireString(
    record.value.bodyId,
    "sim.compile",
    "bodyBounds.bodyId",
  );
  if (!bodyId.ok) return bodyId;
  const minMm = finiteTriple(
    record.value.minMm,
    "sim.compile",
    "bodyBounds.minMm",
  );
  if (!minMm.ok) return minMm;
  const maxMm = finiteTriple(
    record.value.maxMm,
    "sim.compile",
    "bodyBounds.maxMm",
  );
  if (!maxMm.ok) return maxMm;
  return parseOk({
    bodyId: bodyId.value,
    minMm: minMm.value,
    maxMm: maxMm.value,
  });
}

function parseCompileInput(
  input: unknown,
): ParseOutcome<WorkerSimCompileInput> {
  const record = requirePayloadRecord("sim.compile", input);
  if (!record.ok) return record;
  // `scenario` (and the optional `motor`/`tessellation`) cross VERBATIM:
  // the compile boundary re-validates every field of the serialized
  // records, so the codec demands only the scenario's presence.
  if (!("scenario" in record.value)) {
    return payloadError(
      'The "sim.compile" payload must carry a "scenario" field.',
      input,
    );
  }
  let bodyBounds: SimBodyBoundsMm[] | undefined;
  if (record.value.bodyBounds !== undefined) {
    if (!Array.isArray(record.value.bodyBounds)) {
      return payloadError(
        'The "sim.compile" field "bodyBounds" must be an array of body bound records.',
        record.value.bodyBounds,
      );
    }
    bodyBounds = [];
    for (const entry of record.value.bodyBounds) {
      const parsed = parseBodyBoundsEntry(entry);
      if (!parsed.ok) return parsed;
      bodyBounds.push(parsed.value);
    }
  }
  // `materials` and `bodyTessellations` cross VERBATIM after the
  // structural gate (arrays; body entries carry a string bodyId) — the
  // compile boundary re-validates the records and tessellations itself.
  let materials: unknown[] | undefined;
  if (record.value.materials !== undefined) {
    if (!Array.isArray(record.value.materials)) {
      return payloadError(
        'The "sim.compile" field "materials" must be an array of serialized material records.',
        record.value.materials,
      );
    }
    materials = (record.value.materials as readonly unknown[]).map(
      (record) => record,
    );
  }
  let bodyTessellations:
    { readonly bodyId: string; readonly tessellation: unknown }[] | undefined;
  if (record.value.bodyTessellations !== undefined) {
    if (!Array.isArray(record.value.bodyTessellations)) {
      return payloadError(
        'The "sim.compile" field "bodyTessellations" must be an array of body tessellation entries.',
        record.value.bodyTessellations,
      );
    }
    bodyTessellations = [];
    for (const entry of record.value.bodyTessellations) {
      const entryRecord = requirePayloadRecord("sim.compile", entry);
      if (!entryRecord.ok) return entryRecord;
      const bodyId = requireString(
        entryRecord.value.bodyId,
        "sim.compile",
        "bodyTessellations.bodyId",
      );
      if (!bodyId.ok) return bodyId;
      if (!("tessellation" in entryRecord.value)) {
        return payloadError(
          'The "sim.compile" body tessellation entries must carry a "tessellation" field.',
          entry,
        );
      }
      bodyTessellations.push({
        bodyId: bodyId.value,
        tessellation: entryRecord.value.tessellation,
      });
    }
  }
  // The mechanism wire (Phase 67c): structural gate, verbatim crossing.
  let mechanism: SimMechanismWire | undefined;
  if (record.value.mechanism !== undefined) {
    const wire = requirePayloadRecord("sim.compile", record.value.mechanism);
    if (!wire.ok) return wire;
    if (
      !Array.isArray(wire.value.occurrences) ||
      !Array.isArray(wire.value.joints) ||
      !Array.isArray(wire.value.masses)
    ) {
      return payloadError(
        'The "sim.compile" field "mechanism" must carry occurrences, joints, and masses arrays.',
        record.value.mechanism,
      );
    }
    if (
      wire.value.grounded !== undefined &&
      !Array.isArray(wire.value.grounded)
    ) {
      return payloadError(
        'The "sim.compile" mechanism field "grounded" must be an array of occurrence id strings.',
        wire.value.grounded,
      );
    }
    let groundedIds: readonly string[] | undefined;
    if (Array.isArray(wire.value.grounded)) {
      const ids: string[] = [];
      for (const id of wire.value.grounded) {
        if (typeof id !== "string") {
          return payloadError(
            'The "sim.compile" mechanism field "grounded" must be an array of occurrence id strings — a non-string entry is declined, never silently dropped.',
            id,
          );
        }
        ids.push(id);
      }
      groundedIds = ids;
    }
    mechanism = {
      occurrences: (wire.value.occurrences as readonly unknown[]).map(
        (entry) => entry,
      ),
      joints: (wire.value.joints as readonly unknown[]).map((entry) => entry),
      masses: (wire.value.masses as readonly unknown[]).map((entry) => entry),
      ...(groundedIds === undefined ? {} : { grounded: groundedIds }),
    };
  }
  const chain = parseStructuralChain(record.value.structuralChain);
  if (!chain.ok) return chain;
  return parseOk({
    scenario: record.value.scenario,
    ...(record.value.motor === undefined ? {} : { motor: record.value.motor }),
    ...(bodyBounds === undefined ? {} : { bodyBounds }),
    ...(record.value.tessellation === undefined
      ? {}
      : { tessellation: record.value.tessellation }),
    ...(materials === undefined ? {} : { materials }),
    ...(bodyTessellations === undefined ? {} : { bodyTessellations }),
    ...(mechanism === undefined ? {} : { mechanism }),
    ...(chain.value === undefined ? {} : { structuralChain: chain.value }),
  });
}

/** The condition fields carried verbatim, in fixed order. */
const CONDITION_OPTIONAL_FIELDS = [
  "velocityMPerS",
  "pressurePa",
  "slip",
  "temperatureK",
  "fluxWPerM2",
  "heatTransferCoefficientWPerM2K",
  "ambientTemperatureK",
  "emissivity",
  "forceN",
  "axis",
  "atWorldPointM",
] as const;

/** The structural point set (Phase 69): conditions addressing world points. */
const CONDITION_POINT_KINDS = ["point-fix", "point-load"] as const;

/**
 * The condition's accumulation shape — every field typed, so the assembled
 * object assigns to both the serialized form (its `face` widens to string)
 * and the compiled form (whose `face` the parser narrows through the domain
 * face vocabulary) without assembly casts.
 */
interface SimConditionBuilder {
  kind: string;
  face?: SimDomainFace;
  velocityMPerS?: readonly [number, number, number];
  pressurePa?: number;
  slip?: boolean;
  temperatureK?: number;
  fluxWPerM2?: number;
  heatTransferCoefficientWPerM2K?: number;
  ambientTemperatureK?: number;
  emissivity?: number;
  forceN?: readonly [number, number, number];
  axis?: "x" | "y" | "z";
  atWorldPointM?: readonly [number, number, number];
}

function serializeCondition(
  condition: CompiledSimCondition,
): SerializedSimCondition {
  return {
    kind: condition.kind,
    ...(condition.face === undefined ? {} : { face: condition.face }),
    ...(condition.velocityMPerS === undefined
      ? {}
      : {
          velocityMPerS: [...condition.velocityMPerS] as [
            number,
            number,
            number,
          ],
        }),
    ...(condition.pressurePa === undefined
      ? {}
      : { pressurePa: condition.pressurePa }),
    ...(condition.slip === undefined ? {} : { slip: condition.slip }),
    ...(condition.temperatureK === undefined
      ? {}
      : { temperatureK: condition.temperatureK }),
    ...(condition.fluxWPerM2 === undefined
      ? {}
      : { fluxWPerM2: condition.fluxWPerM2 }),
    ...(condition.heatTransferCoefficientWPerM2K === undefined
      ? {}
      : {
          heatTransferCoefficientWPerM2K:
            condition.heatTransferCoefficientWPerM2K,
        }),
    ...(condition.ambientTemperatureK === undefined
      ? {}
      : { ambientTemperatureK: condition.ambientTemperatureK }),
    ...(condition.emissivity === undefined
      ? {}
      : { emissivity: condition.emissivity }),
    ...(condition.forceN === undefined
      ? {}
      : {
          forceN: [...condition.forceN] as [number, number, number],
        }),
    ...(condition.axis === undefined ? {} : { axis: condition.axis }),
    ...(condition.atWorldPointM === undefined
      ? {}
      : {
          atWorldPointM: [...condition.atWorldPointM] as [
            number,
            number,
            number,
          ],
        }),
  };
}

function parseConditionEntry(
  input: unknown,
): ParseOutcome<CompiledSimCondition> {
  const record = requirePayloadRecord("sim.compile", input);
  if (!record.ok) return record;
  const kind = requireString(
    record.value.kind,
    "sim.compile",
    "conditions.kind",
  );
  if (!kind.ok) return kind;
  const isPointKind = CONDITION_POINT_KINDS.includes(
    kind.value as (typeof CONDITION_POINT_KINDS)[number],
  );
  const output: SimConditionBuilder = { kind: kind.value };
  if (!isPointKind) {
    if (
      typeof record.value.face !== "string" ||
      !SIM_CORE_DOMAIN_FACES.includes(record.value.face as SimDomainFace)
    ) {
      return payloadError(
        `The "sim.compile" field "conditions.face" must be one of: ${SIM_CORE_DOMAIN_FACES.join(", ")}.`,
        record.value.face,
      );
    }
    output.face = record.value.face as SimDomainFace;
  }
  for (const field of CONDITION_OPTIONAL_FIELDS) {
    const value = record.value[field];
    if (value === undefined) continue;
    if (field === "slip") {
      if (typeof value !== "boolean") {
        return payloadError(
          `The "sim.compile" condition field "${field}" must be a boolean.`,
          value,
        );
      }
      output[field] = value;
      continue;
    }
    if (
      field === "velocityMPerS" ||
      field === "forceN" ||
      field === "atWorldPointM"
    ) {
      const triple = finiteTriple(value, "sim.compile", `conditions.${field}`);
      if (!triple.ok) return triple;
      output[field] = triple.value;
      continue;
    }
    if (field === "axis") {
      if (value !== "x" && value !== "y" && value !== "z") {
        return payloadError(
          'The "sim.compile" condition field "axis" must be "x", "y", or "z".',
          value,
        );
      }
      output[field] = value;
      continue;
    }
    const number = requireFinite(value, "sim.compile", `conditions.${field}`);
    if (!number.ok) return number;
    output[field] = number.value;
  }
  return parseOk(output);
}

/** The numeric fields of a serialized fluid state, validated finitely. */ const FLUID_STATE_NUMBER_FIELDS =
  [
    "temperatureK",
    "densityKgPerM3",
    "dynamicViscosityPaS",
    "kinematicViscosityM2PerS",
    "thermalDiffusivityM2PerS",
    "prandtl",
    "thermalExpansionPerK",
    "specificHeatJPerKgK",
    "thermalConductivityWPerMK",
    "speedOfSoundMPerS",
  ] as const;

/** The optional finite numbers of a serialized S9 regime report. */
const REGIME_NUMBER_FIELDS = [
  "reynolds",
  "mach",
  "prandtl",
  "rayleigh",
] as const;

function serializeCompiledScenario(
  compiled: CompiledSimScenario,
): SerializedCompiledSimScenario {
  return {
    kind: compiled.kind,
    name: compiled.name,
    domainMinM: [...compiled.domainMinM] as readonly [number, number, number],
    domainMaxM: [...compiled.domainMaxM] as readonly [number, number, number],
    cellSizeM: compiled.cellSizeM,
    characteristicLengthM: compiled.characteristicLengthM,
    gravityMPerS2: [...compiled.gravityMPerS2] as readonly [
      number,
      number,
      number,
    ],
    conditions: compiled.conditions.map(serializeCondition),
    fluid: { ...compiled.fluid },
    // The motor crosses as its record form: a plain serialized JSON object
    // the compile boundary already validated (its discriminated shape is
    // the units module's truth, not the wire's).
    ...(compiled.motor === undefined ? {} : { motor: { ...compiled.motor } }),
    backend: compiled.backend,
    regime: { ...compiled.regime },
    scenarioSnapshotHash: compiled.scenarioSnapshotHash,
  };
}

/**
 * Parses the wire's compiled-motor form — the COMPILED (SI) shape the
 * compile boundary emits, `stallTorqueNPerM`/`noLoadSpeedRadPerS` and the
 * derived constants — structurally: the discriminated `kind` selects the
 * shape, every numeric field must be finite, tabulated points are
 * speed/torque pairs. (The DOCUMENT record form's own validation is the
 * units module's `parseMotor`; this is its compiled twin at the wire.)
 */
function parseCompiledMotor(input: unknown): ParseOutcome<CompiledSimMotor> {
  const record = requirePayloadRecord("sim.compile", input);
  if (!record.ok) return record;
  let rotorInertiaKgM2: number | undefined;
  if (record.value.rotorInertiaKgM2 !== undefined) {
    const inertia = requireFinite(
      record.value.rotorInertiaKgM2,
      "sim.compile",
      "compiled.motor.rotorInertiaKgM2",
    );
    if (!inertia.ok) return inertia;
    if (inertia.value <= 0) {
      return payloadError(
        'The "sim.compile" field "compiled.motor.rotorInertiaKgM2" must be positive.',
        inertia.value,
      );
    }
    rotorInertiaKgM2 = inertia.value;
  }
  if (record.value.kind === "dc-brushed" || record.value.kind === "bldc") {
    const stallTorqueNPerM = requireFinite(
      record.value.stallTorqueNPerM,
      "sim.compile",
      "compiled.motor.stallTorqueNPerM",
    );
    if (!stallTorqueNPerM.ok) return stallTorqueNPerM;
    const noLoadSpeedRadPerS = requireFinite(
      record.value.noLoadSpeedRadPerS,
      "sim.compile",
      "compiled.motor.noLoadSpeedRadPerS",
    );
    if (!noLoadSpeedRadPerS.ok) return noLoadSpeedRadPerS;
    const nominalVoltageV = requireFinite(
      record.value.nominalVoltageV,
      "sim.compile",
      "compiled.motor.nominalVoltageV",
    );
    if (!nominalVoltageV.ok) return nominalVoltageV;
    const kvRpmPerV = requireFinite(
      record.value.kvRpmPerV,
      "sim.compile",
      "compiled.motor.kvRpmPerV",
    );
    if (!kvRpmPerV.ok) return kvRpmPerV;
    const ktNPerA = requireFinite(
      record.value.ktNPerA,
      "sim.compile",
      "compiled.motor.ktNPerA",
    );
    if (!ktNPerA.ok) return ktNPerA;
    return parseOk({
      kind: record.value.kind,
      stallTorqueNPerM: stallTorqueNPerM.value,
      noLoadSpeedRadPerS: noLoadSpeedRadPerS.value,
      nominalVoltageV: nominalVoltageV.value,
      ...(rotorInertiaKgM2 === undefined ? {} : { rotorInertiaKgM2 }),
      kvRpmPerV: kvRpmPerV.value,
      ktNPerA: ktNPerA.value,
    });
  }
  if (record.value.kind === "tabulated") {
    if (!Array.isArray(record.value.points) || record.value.points.length < 2) {
      return payloadError(
        'The "sim.compile" field "compiled.motor.points" must be an array of at least two speed/torque points.',
        record.value.points,
      );
    }
    const points: {
      readonly speedRadPerS: number;
      readonly torqueNPerM: number;
    }[] = [];
    for (const entry of record.value.points) {
      const point = requirePayloadRecord("sim.compile", entry);
      if (!point.ok) return point;
      const speedRadPerS = requireFinite(
        point.value.speedRadPerS,
        "sim.compile",
        "compiled.motor.points.speedRadPerS",
      );
      if (!speedRadPerS.ok) return speedRadPerS;
      const torqueNPerM = requireFinite(
        point.value.torqueNPerM,
        "sim.compile",
        "compiled.motor.points.torqueNPerM",
      );
      if (!torqueNPerM.ok) return torqueNPerM;
      points.push({
        speedRadPerS: speedRadPerS.value,
        torqueNPerM: torqueNPerM.value,
      });
    }
    return parseOk({
      kind: "tabulated",
      points,
      ...(rotorInertiaKgM2 === undefined ? {} : { rotorInertiaKgM2 }),
    });
  }
  return payloadError(
    'The "sim.compile" field "compiled.motor.kind" must be "dc-brushed", "bldc", or "tabulated".',
    record.value.kind,
  );
}

function parseCompiledScenarioEntry(
  input: unknown,
): ParseOutcome<CompiledSimScenario> {
  const record = requirePayloadRecord("sim.compile", input);
  if (!record.ok) return record;
  if (!isSimScenarioKind(record.value.kind)) {
    return payloadError(
      'The "sim.compile" field "compiled.kind" must be one of: flow, thermal, dynamics, combustion, structural.',
      record.value.kind,
    );
  }
  const kind: CompiledSimScenario["kind"] = record.value.kind;
  const name = requireString(record.value.name, "sim.compile", "compiled.name");
  if (!name.ok) return name;
  const domainMinM = finiteTriple(
    record.value.domainMinM,
    "sim.compile",
    "compiled.domainMinM",
  );
  if (!domainMinM.ok) return domainMinM;
  const domainMaxM = finiteTriple(
    record.value.domainMaxM,
    "sim.compile",
    "compiled.domainMaxM",
  );
  if (!domainMaxM.ok) return domainMaxM;
  const cellSizeM = requireFinite(
    record.value.cellSizeM,
    "sim.compile",
    "compiled.cellSizeM",
  );
  if (!cellSizeM.ok) return cellSizeM;
  const characteristicLengthM = requireFinite(
    record.value.characteristicLengthM,
    "sim.compile",
    "compiled.characteristicLengthM",
  );
  if (!characteristicLengthM.ok) return characteristicLengthM;
  const gravityMPerS2 = finiteTriple(
    record.value.gravityMPerS2,
    "sim.compile",
    "compiled.gravityMPerS2",
  );
  if (!gravityMPerS2.ok) return gravityMPerS2;
  if (!Array.isArray(record.value.conditions)) {
    return payloadError(
      'The "sim.compile" field "compiled.conditions" must be an array.',
      record.value.conditions,
    );
  }
  const conditions: CompiledSimCondition[] = [];
  for (const entry of record.value.conditions) {
    const parsed = parseConditionEntry(entry);
    if (!parsed.ok) return parsed;
    conditions.push(parsed.value);
  }
  const fluid = requirePayloadRecord("sim.compile", record.value.fluid);
  if (!fluid.ok) return fluid;
  const fluidId = requireString(
    fluid.value.fluidId,
    "sim.compile",
    "compiled.fluid.fluidId",
  );
  if (!fluidId.ok) return fluidId;
  const fluidNumbers: Record<
    (typeof FLUID_STATE_NUMBER_FIELDS)[number],
    number
  > = {
    temperatureK: 0,
    densityKgPerM3: 0,
    dynamicViscosityPaS: 0,
    kinematicViscosityM2PerS: 0,
    thermalDiffusivityM2PerS: 0,
    prandtl: 0,
    thermalExpansionPerK: 0,
    specificHeatJPerKgK: 0,
    thermalConductivityWPerMK: 0,
    speedOfSoundMPerS: 0,
  };
  for (const field of FLUID_STATE_NUMBER_FIELDS) {
    const value = requireFinite(
      fluid.value[field],
      "sim.compile",
      `compiled.fluid.${field}`,
    );
    if (!value.ok) return value;
    fluidNumbers[field] = value.value;
  }
  let motor: CompiledSimMotor | undefined;
  if (record.value.motor !== undefined) {
    const parsedMotor = parseCompiledMotor(record.value.motor);
    if (!parsedMotor.ok) return parsedMotor;
    motor = parsedMotor.value;
  }
  if (record.value.backend !== "cpu" && record.value.backend !== "gpu") {
    return payloadError(
      'The "sim.compile" field "compiled.backend" must be "cpu" or "gpu".',
      record.value.backend,
    );
  }
  const regime = requirePayloadRecord("sim.compile", record.value.regime);
  if (!regime.ok) return regime;
  const regimeNumbers: Partial<
    Record<(typeof REGIME_NUMBER_FIELDS)[number], number>
  > = {};
  for (const field of REGIME_NUMBER_FIELDS) {
    const value = regime.value[field];
    if (value === undefined) continue;
    const parsed = requireFinite(
      value,
      "sim.compile",
      `compiled.regime.${field}`,
    );
    if (!parsed.ok) return parsed;
    regimeNumbers[field] = parsed.value;
  }
  if (!Array.isArray(regime.value.qualitative)) {
    return payloadError(
      'The "sim.compile" field "compiled.regime.qualitative" must be an array of flag strings.',
      regime.value.qualitative,
    );
  }
  const qualitative: SimQualitativeFlag[] = [];
  for (const flag of regime.value.qualitative) {
    if (
      typeof flag !== "string" ||
      !SIM_QUALITATIVE_FLAGS.includes(flag as SimQualitativeFlag)
    ) {
      return payloadError(
        `The "sim.compile" field "compiled.regime.qualitative" must be one of: ${SIM_QUALITATIVE_FLAGS.join(", ")}.`,
        regime.value.qualitative,
      );
    }
    qualitative.push(flag as SimQualitativeFlag);
  }
  const scenarioSnapshotHash = requireString(
    record.value.scenarioSnapshotHash,
    "sim.compile",
    "compiled.scenarioSnapshotHash",
  );
  if (!scenarioSnapshotHash.ok) return scenarioSnapshotHash;
  return parseOk({
    kind,
    name: name.value,
    domainMinM: domainMinM.value,
    domainMaxM: domainMaxM.value,
    cellSizeM: cellSizeM.value,
    characteristicLengthM: characteristicLengthM.value,
    gravityMPerS2: gravityMPerS2.value,
    conditions,
    fluid: { fluidId: fluidId.value, ...fluidNumbers },
    ...(motor === undefined ? {} : { motor }),
    backend: record.value.backend,
    regime: { ...regimeNumbers, qualitative },
    scenarioSnapshotHash: scenarioSnapshotHash.value,
  });
}

function serializeCompileResult(
  result: WorkerSimCompileResult,
): SerializedSimWorkerOperationResults["sim.compile"] {
  return {
    problem: result.problem,
    compiled: serializeCompiledScenario(result.compiled),
  };
}

function parseCompileResult(
  input: unknown,
): ParseOutcome<WorkerSimCompileResult> {
  const record = requirePayloadRecord("sim.compile", input);
  if (!record.ok) return record;
  const problem = parseSimProblemId(record.value.problem);
  if (!problem.ok) {
    return payloadError(
      `The "sim.compile" result field "problem" must be a worker problem id: ${problem.error.message}`,
      input,
    );
  }
  const compiled = parseCompiledScenarioEntry(record.value.compiled);
  if (!compiled.ok) return compiled;
  return parseOk({ problem: problem.value, compiled: compiled.value });
}

// ---------------------------------------------------------------------------
// sim.run codecs
// ---------------------------------------------------------------------------

function serializeRunInput(
  input: WorkerSimRunInput,
): SerializedSimWorkerOperationInputs["sim.run"] {
  return { problem: input.problem };
}

function parseRunInput(input: unknown): ParseOutcome<WorkerSimRunInput> {
  const record = requirePayloadRecord("sim.run", input);
  if (!record.ok) return record;
  const problem = parseSimProblemId(record.value.problem);
  if (!problem.ok) {
    return payloadError(
      `The "sim.run" field "problem" must be a worker problem id: ${problem.error.message}`,
      input,
    );
  }
  return parseOk({ problem: problem.value });
}

function serializeRunResult(
  result: WorkerSimRunResult,
): SerializedSimWorkerOperationResults["sim.run"] {
  return { run: result.run, steps: result.steps, chunks: result.chunks };
}

function parseRunResult(input: unknown): ParseOutcome<WorkerSimRunResult> {
  const record = requirePayloadRecord("sim.run", input);
  if (!record.ok) return record;
  const run = parseSimRunId(record.value.run);
  if (!run.ok) {
    return payloadError(
      `The "sim.run" result field "run" must be a worker run id: ${run.error.message}`,
      input,
    );
  }
  const steps = requireNonNegativeInteger(
    record.value.steps,
    "sim.run",
    "steps",
  );
  if (!steps.ok) return steps;
  const chunks = requireNonNegativeInteger(
    record.value.chunks,
    "sim.run",
    "chunks",
  );
  if (!chunks.ok) return chunks;
  return parseOk({ run: run.value, steps: steps.value, chunks: chunks.value });
}

// ---------------------------------------------------------------------------
// sim.finalize codecs
// ---------------------------------------------------------------------------

function serializeFinalizeInput(
  input: WorkerSimFinalizeInput,
): SerializedSimWorkerOperationInputs["sim.finalize"] {
  return { run: input.run };
}

function parseFinalizeInput(
  input: unknown,
): ParseOutcome<WorkerSimFinalizeInput> {
  const record = requirePayloadRecord("sim.finalize", input);
  if (!record.ok) return record;
  const run = parseSimRunId(record.value.run);
  if (!run.ok) {
    return payloadError(
      `The "sim.finalize" field "run" must be a worker run id: ${run.error.message}`,
      input,
    );
  }
  return parseOk({ run: run.value });
}

function serializeFinalizeResult(
  result: WorkerSimFinalizeResult,
): SerializedSimWorkerOperationResults["sim.finalize"] {
  return {
    summary: { ...result.summary },
    payload: encodeSimBase64(result.payload),
    histories: result.histories.map((series) => ({
      name: series.name,
      unit: series.unit,
      samples: [...series.samples],
    })),
  };
}

function parseHistoryEntry(input: unknown): ParseOutcome<SimHistorySeries> {
  const record = requirePayloadRecord("sim.finalize", input);
  if (!record.ok) return record;
  const name = requireString(
    record.value.name,
    "sim.finalize",
    "histories.name",
  );
  if (!name.ok) return name;
  const unit = requireString(
    record.value.unit,
    "sim.finalize",
    "histories.unit",
  );
  if (!unit.ok) return unit;
  if (!Array.isArray(record.value.samples)) {
    return payloadError(
      'The "sim.finalize" field "histories.samples" must be an array of finite numbers.',
      record.value.samples,
    );
  }
  const samples: number[] = [];
  for (const sample of record.value.samples) {
    const value = requireFinite(sample, "sim.finalize", "histories.samples");
    if (!value.ok) return value;
    samples.push(value.value);
  }
  return parseOk({ name: name.value, unit: unit.value, samples });
}

function parseFinalizeResult(
  input: unknown,
): ParseOutcome<WorkerSimFinalizeResult> {
  const record = requirePayloadRecord("sim.finalize", input);
  if (!record.ok) return record;
  // The summary is 61a's versioned JSON schema; its shape beyond the
  // schema-version gate is the result model's truth, and the payload block
  // set below is re-validated byte-strictly.
  const summary = requirePayloadRecord("sim.finalize", record.value.summary);
  if (!summary.ok) return summary;
  const schemaVersion = requireNonNegativeInteger(
    summary.value.schemaVersion,
    "sim.finalize",
    "summary.schemaVersion",
  );
  if (!schemaVersion.ok) return schemaVersion;
  if (typeof record.value.payload !== "string") {
    return payloadError(
      'The "sim.finalize" result field "payload" must be strict base64 text.',
      record.value.payload,
    );
  }
  const payloadBytes = decodeSimBase64Strict(record.value.payload);
  if (payloadBytes === null) {
    return payloadError(
      'The "sim.finalize" result field "payload" is not strict canonical base64.',
      record.value.payload,
    );
  }
  const decoded = decodeSimResultPayload(payloadBytes);
  if (!decoded.ok) {
    return payloadError(
      `The "sim.finalize" result payload did not decode as an SMR1 block set: ${decoded.error.message}`,
      record.value.payload,
    );
  }
  if (!Array.isArray(record.value.histories)) {
    return payloadError(
      'The "sim.finalize" result field "histories" must be an array of history series records.',
      record.value.histories,
    );
  }
  const histories: SimHistorySeries[] = [];
  for (const entry of record.value.histories) {
    const parsed = parseHistoryEntry(entry);
    if (!parsed.ok) return parsed;
    histories.push(parsed.value);
  }
  return parseOk({
    summary: summary.value as unknown as SimResultSummary,
    payload: payloadBytes,
    histories,
  });
}

// ---------------------------------------------------------------------------
// The codec tables
// ---------------------------------------------------------------------------

const INPUT_SERIALIZERS: {
  readonly [O in SimWorkerOperationId]: (
    input: SimWorkerOperationInput<O>,
  ) => SerializedSimWorkerOperationInput<O>;
} = {
  "sim.compile": serializeCompileInput,
  "sim.run": serializeRunInput,
  "sim.finalize": serializeFinalizeInput,
};

const INPUT_PARSERS: {
  readonly [O in SimWorkerOperationId]: (
    payload: unknown,
  ) => ParseOutcome<SimWorkerOperationInput<O>>;
} = {
  "sim.compile": parseCompileInput,
  "sim.run": parseRunInput,
  "sim.finalize": parseFinalizeInput,
};

const RESULT_SERIALIZERS: {
  readonly [O in SimWorkerOperationId]: (
    result: SimWorkerOperationResult<O>,
  ) => SerializedSimWorkerOperationResult<O>;
} = {
  "sim.compile": serializeCompileResult,
  "sim.run": serializeRunResult,
  "sim.finalize": serializeFinalizeResult,
};

const RESULT_PARSERS: {
  readonly [O in SimWorkerOperationId]: (
    payload: unknown,
  ) => ParseOutcome<SimWorkerOperationResult<O>>;
} = {
  "sim.compile": parseCompileResult,
  "sim.run": parseRunResult,
  "sim.finalize": parseFinalizeResult,
};

/** Serializes an operation's typed input to its canonical wire form. */
export function serializeSimWorkerOperationInput<
  O extends SimWorkerOperationId,
>(
  operation: O,
  input: SimWorkerOperationInput<O>,
): SerializedSimWorkerOperationInput<O> {
  return INPUT_SERIALIZERS[operation](input);
}

/** Parses untrusted input as an operation's serialized input. */
export function parseSimWorkerOperationInput<O extends SimWorkerOperationId>(
  operation: O,
  input: unknown,
): ParseOutcome<SimWorkerOperationInput<O>> {
  return INPUT_PARSERS[operation](input);
}

/** Serializes an operation's typed result to its canonical wire form. */
export function serializeSimWorkerOperationResult<
  O extends SimWorkerOperationId,
>(
  operation: O,
  result: SimWorkerOperationResult<O>,
): SerializedSimWorkerOperationResult<O> {
  return RESULT_SERIALIZERS[operation](result);
}

/** Parses untrusted input as an operation's serialized result. */
export function parseSimWorkerOperationResult<O extends SimWorkerOperationId>(
  operation: O,
  input: unknown,
): ParseOutcome<SimWorkerOperationResult<O>> {
  return RESULT_PARSERS[operation](input);
}

/**
 * Builds the typed finalize result of a run's {@link SimResult}: encodes the
 * field blocks to the deterministic `SMR1` payload bytes (declining
 * structured when a block is malformed — never a fake payload) and carries
 * the summary and histories verbatim.
 */
export function simResultToFinalizeResult(
  result: SimResult,
): ParseOutcome<WorkerSimFinalizeResult> {
  const encoded = encodeSimResultPayload(result.fields);
  if (!encoded.ok) {
    return payloadError(
      `The run's field blocks did not encode as a result payload: ${encoded.error.message}`,
      result.fields,
    );
  }
  return parseOk({
    summary: result.summary,
    payload: encoded.value,
    histories: result.histories,
  });
}
