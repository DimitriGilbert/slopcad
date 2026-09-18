/**
 * Serializable commands (Phase 7): the mutation vocabulary of the CAD
 * document. A {@link CadCommand} is pure data describing ONE supported
 * mutation — set a parameter's value, create, update, delete, or reorder a
 * feature record — and {@link applyCommand} is its sole interpreter: a pure,
 * deterministic function of (document, command) → next document, or a
 * structured failure carrying the substrate's stable `document/*` and
 * `parameter/*` codes. Nothing here mutates inputs, consults the clock or
 * randomness, or performs I/O, which is what makes command logs replayable:
 * applying the same command to the same document state always yields the
 * same next state.
 *
 * This module is the supported mutation surface for those operations —
 * layers above cad-core should express changes as commands (wrapped in
 * transactions and applied through a session) rather than calling the
 * Phase 6 document functions directly. Those functions remain exported as
 * the substrate the command layer orchestrates (and as the raw material for
 * the kernel/worker phases); nothing is hidden or removed.
 *
 * ## The Phase 20 `feature.reorder` extension (disclosed)
 *
 * Reordering a feature in the timeline is a first-class command (see
 * `feature-history.ts` for the composition decision): it is the only form
 * of reorder that is undoable and replayable, because the Phase 7 history
 * records transactions. The disclosure: the vocabulary grew from four
 * command types to five, so a persisted LOG carrying `feature.reorder` is
 * written only by this version and parsed only by parsers that know the
 * type (the strict `command/type-unknown` rule); every file written before
 * the extension carries none and parses exactly as before.
 *
 * ## Determinism of generated ids
 *
 * `feature.create` may omit its id; the id is then generated from the
 * document's own id generator, whose counters are part of the document
 * state. The generator is deterministic, so a command applied twice to an
 * identical state generates the identical id — a serialized command with no
 * id replays onto the same id it produced when first applied. The created
 * record is the last element of `features` when the command carried no
 * explicit id ({@link addFeature} appends).
 *
 * ## Wire format
 *
 * {@link serializeCommand} emits a fixed-shape, fixed-key-order JSON object
 * stamped with the package format version; {@link parseCommand} validates
 * untrusted input strictly (stable `command/*` failure codes) and ignores
 * unknown fields so future format versions deserialize without data
 * corruption. Dimensional values serialize canonically (canonical unit,
 * canonical magnitude), so a replayed `parameter.set` stores the equal
 * canonical quantity — equal as a quantity and identical after document
 * serialization, which is canonical for the same reason.
 */

import {
  type AnyDimensionalValue,
  parseDimensionalValue,
  serializeDimensionalValue,
  type SerializedDimensionalValue,
} from "./dimensional";
import {
  addBody,
  addDocumentReference,
  addDocumentSketch,
  addDocumentParameter,
  addFeature,
  type CadDocument,
  type DocumentError,
  type FeatureInputRef,
  parseFeatureInputRef,
  parseFeatureKind,
  removeFeature,
  reorderFeature,
  type SerializedFeatureInputRef,
  updateFeature,
} from "./document";
import {
  type BodyId,
  type FeatureId,
  type ParameterId,
  type SketchDocumentId,
  parseBodyId,
  parseFeatureId,
  parseParameterId,
  parseSketchDocumentId,
  type ReferenceId,
  parseReferenceId,
} from "./ids";
import { type ParameterError, updateParameterValue } from "./parameter";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { CAD_DOCUMENT_FORMAT_VERSION } from "./version";

/** The command types of the mutation vocabulary (Phase 7 + Phase 20 reorder). */
export const CAD_COMMAND_TYPES = [
  "parameter.set",
  "parameter.create",
  "feature.create",
  "feature.update",
  "feature.delete",
  "feature.reorder",
  "body.create",
  "sketch.create",
  "reference.create",
] as const;

export type CadCommandType = (typeof CAD_COMMAND_TYPES)[number];

const COMMAND_TYPE_SET: ReadonlySet<string> = new Set(CAD_COMMAND_TYPES);

/** Type guard for untrusted command type values. */
export function isCadCommandType(input: unknown): input is CadCommandType {
  return typeof input === "string" && COMMAND_TYPE_SET.has(input);
}

/**
 * One supported document mutation, as pure serializable data. `parameter.set`
 * replaces a document parameter's stored value (the cached evaluation
 * result; recomputation is the regeneration pipeline's concern).
 * `feature.create` adds a record ({@link addFeature}); `feature.update`
 * wholesale-replaces a record's mutable fields — kind, inputs, outputs —
 * with referential integrity enforced ({@link updateFeature});
 * `feature.delete` removes a record ({@link removeFeature}); and
 * `feature.reorder` moves a record to a new timeline position, immediately
 * after `afterFeatureId` (or to the front when `afterFeatureId` is `null`),
 * with the input-order replayability rule enforced on the result
 * ({@link reorderFeature}).
 */
export type CadCommand =
  | {
      readonly type: "parameter.set";
      readonly id: ParameterId;
      readonly value: AnyDimensionalValue;
    }
  | {
      readonly type: "parameter.create";
      readonly id?: ParameterId;
      readonly name: string;
      readonly value: AnyDimensionalValue;
    }
  | {
      readonly type: "body.create";
      readonly id?: BodyId;
      readonly name: string;
    }
  | {
      readonly type: "sketch.create";
      readonly id?: SketchDocumentId;
      readonly name: string;
      readonly sketch: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "reference.create";
      readonly id?: ReferenceId;
      readonly name: string;
      readonly reference: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "feature.create";
      readonly id?: FeatureId;
      readonly kind: string;
      readonly inputs: readonly FeatureInputRef[];
      readonly outputs: readonly BodyId[];
    }
  | {
      readonly type: "feature.update";
      readonly id: FeatureId;
      readonly kind: string;
      readonly inputs: readonly FeatureInputRef[];
      readonly outputs: readonly BodyId[];
    }
  | {
      readonly type: "feature.delete";
      readonly id: FeatureId;
    }
  | {
      readonly type: "feature.reorder";
      readonly id: FeatureId;
      /** The feature to sit after; `null` moves the feature to the front. */
      readonly afterFeatureId: FeatureId | null;
    };

/** Stable failure codes produced when command input is rejected. */
export const COMMAND_ERROR_CODES = {
  malformed: "command/malformed",
  versionUnsupported: "command/version-unsupported",
  typeUnknown: "command/type-unknown",
} as const;

export type CommandErrorCode =
  (typeof COMMAND_ERROR_CODES)[keyof typeof COMMAND_ERROR_CODES];

/** Structured failure describing why input was rejected as a command. */
export interface CommandError extends ParseFailure {
  readonly code: CommandErrorCode;
}

function commandError(
  code: CommandErrorCode,
  message: string,
  input: unknown,
): CommandError {
  return { code, message, input };
}

/**
 * Everything {@link applyCommand} can fail with: the substrate's structured
 * failures (`document/*`, `parameter/*`), plus the command layer's own
 * `command/type-unknown` for an object whose `type` is not in the vocabulary
 * — reachable only when ill-typed input is smuggled past the compiler.
 */
export type CommandApplyError = DocumentError | ParameterError | CommandError;

/**
 * Applies a command to a document, returning the next document or the
 * substrate's structured failure. Pure and deterministic: the same command
 * on the same document always produces the same result, and the input
 * document is never modified. Fields are re-validated at the substrate even
 * though the command is typed, so smuggled input fails structurally instead
 * of corrupting state.
 */
export function applyCommand(
  document: CadDocument,
  command: CadCommand,
): ParseResult<CadDocument, CommandApplyError> {
  switch (command.type) {
    case "parameter.set": {
      const updated = updateParameterValue(
        document.parameters,
        command.id,
        command.value,
      );
      if (!updated.ok) return updated;
      return ok(Object.freeze({ ...document, parameters: updated.value }));
    }
    case "parameter.create": {
      const added = addDocumentParameter(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        value: command.value,
      });
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "body.create": {
      const added = addBody(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
      });
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "sketch.create": {
      const added = addDocumentSketch(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        sketch: command.sketch,
      });
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "reference.create": {
      const added = addDocumentReference(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        reference: command.reference,
      });
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "feature.create": {
      const added = addFeature(document, command);
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "feature.update": {
      const updated = updateFeature(document, command.id, {
        kind: command.kind,
        inputs: command.inputs,
        outputs: command.outputs,
      });
      if (!updated.ok) return updated;
      return ok(updated.value.document);
    }
    case "feature.delete":
      return removeFeature(document, command.id);
    case "feature.reorder":
      return reorderFeature(document, command.id, command.afterFeatureId);
    default:
      return fail(
        commandError(
          COMMAND_ERROR_CODES.typeUnknown,
          `A command type must be one of: ${CAD_COMMAND_TYPES.join(", ")}.`,
          command,
        ),
      );
  }
}

/** Canonical JSON form of a command, discriminated by `type`, fixed key order. */
export type SerializedCadCommand =
  | {
      readonly formatVersion: number;
      readonly type: "parameter.set";
      readonly id: string;
      readonly value: SerializedDimensionalValue;
    }
  | {
      readonly formatVersion: number;
      readonly type: "parameter.create";
      readonly id?: string;
      readonly name: string;
      readonly value: SerializedDimensionalValue;
    }
  | {
      readonly formatVersion: number;
      readonly type: "body.create";
      readonly id?: string;
      readonly name: string;
    }
  | {
      readonly formatVersion: number;
      readonly type: "sketch.create";
      readonly id?: string;
      readonly name: string;
      readonly sketch: Readonly<Record<string, unknown>>;
    }
  | {
      readonly formatVersion: number;
      readonly type: "reference.create";
      readonly id?: string;
      readonly name: string;
      readonly reference: Readonly<Record<string, unknown>>;
    }
  | {
      readonly formatVersion: number;
      readonly type: "feature.create";
      readonly id?: string;
      readonly kind: string;
      readonly inputs: readonly SerializedFeatureInputRef[];
      readonly outputs: readonly string[];
    }
  | {
      readonly formatVersion: number;
      readonly type: "feature.update";
      readonly id: string;
      readonly kind: string;
      readonly inputs: readonly SerializedFeatureInputRef[];
      readonly outputs: readonly string[];
    }
  | {
      readonly formatVersion: number;
      readonly type: "feature.delete";
      readonly id: string;
    }
  | {
      readonly formatVersion: number;
      readonly type: "feature.reorder";
      readonly id: string;
      readonly afterFeatureId: string | null;
    };

function serializeInputRef(ref: FeatureInputRef): SerializedFeatureInputRef {
  return { kind: ref.kind, id: ref.id };
}

/** Serializes a command to its canonical, deterministic JSON form. */
export function serializeCommand(command: CadCommand): SerializedCadCommand {
  switch (command.type) {
    case "parameter.set":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
        value: serializeDimensionalValue(command.value),
      };
    case "feature.create":
      return command.id === undefined
        ? {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            kind: command.kind,
            inputs: command.inputs.map(serializeInputRef),
            outputs: [...command.outputs],
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            kind: command.kind,
            inputs: command.inputs.map(serializeInputRef),
            outputs: [...command.outputs],
          };
    case "parameter.create":
      return command.id === undefined
        ? {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            name: command.name,
            value: serializeDimensionalValue(command.value),
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            name: command.name,
            value: serializeDimensionalValue(command.value),
          };
    case "body.create":
      return command.id === undefined
        ? {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            name: command.name,
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            name: command.name,
          };
    case "sketch.create":
      return command.id === undefined
        ? {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            name: command.name,
            sketch: command.sketch,
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            name: command.name,
            sketch: command.sketch,
          };
    case "reference.create":
      return command.id === undefined
        ? {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            name: command.name,
            reference: command.reference,
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            name: command.name,
            reference: command.reference,
          };
    case "feature.update":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
        kind: command.kind,
        inputs: command.inputs.map(serializeInputRef),
        outputs: [...command.outputs],
      };
    case "feature.delete":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
      };
    case "feature.reorder":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
        afterFeatureId: command.afterFeatureId,
      };
    default:
      throw new Error(
        "Invariant violation: a serialized command must carry a known command type.",
      );
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseCommandInputs(
  input: unknown,
): ParseResult<readonly FeatureInputRef[], CommandError> {
  if (!Array.isArray(input)) {
    return fail(
      commandError(
        COMMAND_ERROR_CODES.malformed,
        "Command inputs must be an array of input references.",
        input,
      ),
    );
  }
  const refs: FeatureInputRef[] = [];
  for (const entry of input) {
    const parsed = parseFeatureInputRef(entry);
    if (!parsed.ok) {
      return fail(
        commandError(
          COMMAND_ERROR_CODES.malformed,
          `A command input reference is invalid: ${parsed.error.message}`,
          entry,
        ),
      );
    }
    refs.push(parsed.value);
  }
  return ok(Object.freeze(refs));
}

function parseCommandOutputs(
  input: unknown,
): ParseResult<readonly BodyId[], CommandError> {
  if (!Array.isArray(input)) {
    return fail(
      commandError(
        COMMAND_ERROR_CODES.malformed,
        "Command outputs must be an array of body ids.",
        input,
      ),
    );
  }
  const ids: BodyId[] = [];
  for (const entry of input) {
    const parsed = parseBodyId(entry);
    if (!parsed.ok) {
      return fail(
        commandError(
          COMMAND_ERROR_CODES.malformed,
          `A command output must be a valid body id: ${parsed.error.message}`,
          entry,
        ),
      );
    }
    ids.push(parsed.value);
  }
  return ok(Object.freeze(ids));
}

function parseCommandKind(input: unknown): ParseResult<string, CommandError> {
  const parsed = parseFeatureKind(input);
  if (!parsed.ok) {
    return fail(
      commandError(
        COMMAND_ERROR_CODES.malformed,
        `A command feature kind is invalid: ${parsed.error.message}`,
        input,
      ),
    );
  }
  return parsed;
}

/** The shared payload of `feature.create` and `feature.update` commands. */
interface FeatureCommandFields {
  readonly kind: string;
  readonly inputs: readonly FeatureInputRef[];
  readonly outputs: readonly BodyId[];
}

function parseFeatureCommandFields(
  input: Record<string, unknown>,
): ParseResult<FeatureCommandFields, CommandError> {
  const kind = parseCommandKind(input.kind);
  if (!kind.ok) return kind;
  const inputs = parseCommandInputs(input.inputs);
  if (!inputs.ok) return inputs;
  const outputs = parseCommandOutputs(input.outputs);
  if (!outputs.ok) return outputs;
  return ok({ kind: kind.value, inputs: inputs.value, outputs: outputs.value });
}

/**
 * Parses untrusted input (e.g. a command revived from persisted JSON or IPC)
 * as a {@link CadCommand}. Known fields are validated strictly — format
 * version, command type, ids, kinds, input references, outputs, dimensional
 * values — while unknown fields are ignored so future format versions
 * deserialize without data corruption. A missing optional `id` on
 * `feature.create` is preserved: replay generates the id deterministically.
 */
export function parseCommand(
  input: unknown,
): ParseResult<CadCommand, CommandError> {
  if (!isPlainRecord(input)) {
    return fail(
      commandError(
        COMMAND_ERROR_CODES.malformed,
        "A serialized command must be a plain object.",
        input,
      ),
    );
  }
  if (input.formatVersion !== CAD_DOCUMENT_FORMAT_VERSION) {
    return fail(
      commandError(
        COMMAND_ERROR_CODES.versionUnsupported,
        `A serialized command must carry formatVersion ${CAD_DOCUMENT_FORMAT_VERSION}.`,
        input.formatVersion,
      ),
    );
  }
  const { type } = input;
  if (!isCadCommandType(type)) {
    return fail(
      commandError(
        COMMAND_ERROR_CODES.typeUnknown,
        `A command type must be one of: ${CAD_COMMAND_TYPES.join(", ")}.`,
        type,
      ),
    );
  }
  switch (type) {
    case "parameter.set": {
      const parsedId = parseParameterId(input.id);
      if (!parsedId.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A parameter.set command needs a valid parameter id: ${parsedId.error.message}`,
            input.id,
          ),
        );
      }
      const parsedValue = parseDimensionalValue(input.value);
      if (!parsedValue.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A parameter.set command needs a valid dimensional value: ${parsedValue.error.message}`,
            input.value,
          ),
        );
      }
      return ok(
        Object.freeze({ type, id: parsedId.value, value: parsedValue.value }),
      );
    }
    case "parameter.create": {
      let id: ParameterId | undefined;
      if (input.id !== undefined) {
        const parsedId = parseParameterId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A parameter.create command needs a valid parameter id: ${parsedId.error.message}`,
              input.id,
            ),
          );
        }
        id = parsedId.value;
      }
      if (typeof input.name !== "string" || input.name.length === 0) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A parameter.create command needs a non-empty name string.",
            input.name,
          ),
        );
      }
      const parsedValue = parseDimensionalValue(input.value);
      if (!parsedValue.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A parameter.create command needs a valid dimensional value: ${parsedValue.error.message}`,
            input.value,
          ),
        );
      }
      return ok(
        Object.freeze(
          id === undefined
            ? { type, name: input.name, value: parsedValue.value }
            : { type, id, name: input.name, value: parsedValue.value },
        ),
      );
    }
    case "body.create": {
      let id: BodyId | undefined;
      if (input.id !== undefined) {
        const parsedId = parseBodyId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A body.create command needs a valid body id: ${parsedId.error.message}`,
              input.id,
            ),
          );
        }
        id = parsedId.value;
      }
      if (typeof input.name !== "string" || input.name.length === 0) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A body.create command needs a non-empty name string.",
            input.name,
          ),
        );
      }
      return ok(
        Object.freeze(
          id === undefined
            ? { type, name: input.name }
            : { type, id, name: input.name },
        ),
      );
    }
    case "sketch.create": {
      let id: SketchDocumentId | undefined;
      if (input.id !== undefined) {
        const parsedId = parseSketchDocumentId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A sketch.create command needs a valid sketch id: ${parsedId.error.message}`,
              input.id,
            ),
          );
        }
        id = parsedId.value;
      }
      if (typeof input.name !== "string" || input.name.length === 0) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A sketch.create command needs a non-empty name string.",
            input.name,
          ),
        );
      }
      if (!isPlainRecord(input.sketch)) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A sketch.create command needs a plain-object sketch payload (the sketch domain's canonical serialized form).",
            input.sketch,
          ),
        );
      }
      return ok(
        Object.freeze(
          id === undefined
            ? { type, name: input.name, sketch: input.sketch }
            : { type, id, name: input.name, sketch: input.sketch },
        ),
      );
    }
    case "reference.create": {
      let id: ReferenceId | undefined;
      if (input.id !== undefined) {
        const parsedId = parseReferenceId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A reference.create command needs a valid reference id: ${parsedId.error.message}`,
              input.id,
            ),
          );
        }
        id = parsedId.value;
      }
      if (typeof input.name !== "string" || input.name.length === 0) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A reference.create command needs a non-empty name string.",
            input.name,
          ),
        );
      }
      if (!isPlainRecord(input.reference)) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A reference.create command needs a plain-object reference payload (the persistent-reference module's canonical serialized form).",
            input.reference,
          ),
        );
      }
      return ok(
        Object.freeze(
          id === undefined
            ? { type, name: input.name, reference: input.reference }
            : { type, id, name: input.name, reference: input.reference },
        ),
      );
    }
    case "feature.create": {
      let id: FeatureId | undefined;
      if (input.id !== undefined) {
        const parsedId = parseFeatureId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A feature.create command needs a valid feature id: ${parsedId.error.message}`,
              input.id,
            ),
          );
        }
        id = parsedId.value;
      }
      const fields = parseFeatureCommandFields(input);
      if (!fields.ok) return fields;
      return ok(
        Object.freeze(
          id === undefined
            ? { type, ...fields.value }
            : { type, id, ...fields.value },
        ),
      );
    }
    case "feature.update": {
      const parsedId = parseFeatureId(input.id);
      if (!parsedId.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A feature.update command needs a valid feature id: ${parsedId.error.message}`,
            input.id,
          ),
        );
      }
      const fields = parseFeatureCommandFields(input);
      if (!fields.ok) return fields;
      return ok(Object.freeze({ type, id: parsedId.value, ...fields.value }));
    }
    case "feature.reorder": {
      const parsedId = parseFeatureId(input.id);
      if (!parsedId.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A feature.reorder command needs a valid feature id: ${parsedId.error.message}`,
            input.id,
          ),
        );
      }
      if (input.afterFeatureId === null) {
        return ok(
          Object.freeze({
            type,
            id: parsedId.value,
            afterFeatureId: null,
          }),
        );
      }
      const parsedAnchor = parseFeatureId(input.afterFeatureId);
      if (!parsedAnchor.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A feature.reorder command's afterFeatureId must be null or a valid feature id: ${parsedAnchor.error.message}`,
            input.afterFeatureId,
          ),
        );
      }
      return ok(
        Object.freeze({
          type,
          id: parsedId.value,
          afterFeatureId: parsedAnchor.value,
        }),
      );
    }
    default: {
      const parsedId = parseFeatureId(input.id);
      if (!parsedId.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A feature.delete command needs a valid feature id: ${parsedId.error.message}`,
            input.id,
          ),
        );
      }
      return ok(Object.freeze({ type: "feature.delete", id: parsedId.value }));
    }
  }
}
