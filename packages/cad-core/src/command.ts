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
 * ## The Phase 22 expression payloads (disclosed)
 *
 * `parameter.set` and `parameter.create` gained optional expression
 * payloads (the full form rules and the serialized-AST wire-form rationale
 * live on {@link CadCommand}). The same disclosure shape as `feature.reorder`:
 * every command written before the extension parses and applies exactly as
 * before — a `parameter.set` without an `expression` field is the identical
 * value-only set it always was, and application recomputes expression-driven
 * values ONLY through the new payloads, so a pre-expression log replays to
 * byte-identical documents. A log carrying an expression payload is written
 * only by this version; an older reader would silently drop the field and
 * replay a different document (the native-format replay check would refuse
 * it), which is why the native envelope version gates the capability.
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
 * serialization, which is canonical for the same reason. Expression
 * payloads serialize as canonical ASTs (frozen, fixed key order), so the
 * same rule holds for them: a replayed define stores the identical
 * expression and recomputes to the identical cached values.
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
  addDocumentDatum,
  addDocumentCurve,
  addDocumentConfiguration,
  addDocumentParameter,
  addFeature,
  type CadDocument,
  type DocumentError,
  type FeatureInputRef,
  parseFeatureInputRef,
  parseFeatureKind,
  removeDocumentConfiguration,
  removeFeature,
  reorderFeature,
  type SerializedFeatureInputRef,
  updateBody,
  updateDocumentConfiguration,
  updateFeature,
} from "./document";
import {
  type BodyId,
  type ConfigurationId,
  type CurveId,
  type DatumId,
  type FeatureId,
  type ParameterId,
  type SketchDocumentId,
  parseBodyId,
  parseConfigurationId,
  parseCurveId,
  parseDatumId,
  parseFeatureId,
  parseParameterId,
  parseSketchDocumentId,
  type ReferenceId,
  parseReferenceId,
} from "./ids";
import { type SerializedCurve, parseSerializedCurve } from "./curve";
import { type ExpressionNode, parseExpressionAst } from "./expression";
import { type ParameterError, updateParameterValue } from "./parameter";
import { installParameterExpression } from "./parameter-graph";
import {
  type Appearance,
  type FaceAppearanceOverride,
  parseAppearance,
} from "./appearance";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { CAD_DOCUMENT_FORMAT_VERSION } from "./version";

/** The command types of the mutation vocabulary (Phase 7 + Phase 20 reorder + Phase 39 datums + Phase 44 body.update + Phase 47 curves). */
export const CAD_COMMAND_TYPES = [
  "parameter.set",
  "parameter.create",
  "feature.create",
  "feature.update",
  "feature.delete",
  "feature.reorder",
  "body.create",
  "body.update",
  "sketch.create",
  "reference.create",
  "datum.create",
  "curve.create",
  "configuration.create",
  "configuration.update",
  "configuration.delete",
] as const;

export type CadCommandType = (typeof CAD_COMMAND_TYPES)[number];

const COMMAND_TYPE_SET: ReadonlySet<string> = new Set(CAD_COMMAND_TYPES);

/** Type guard for untrusted command type values. */
export function isCadCommandType(input: unknown): input is CadCommandType {
  return typeof input === "string" && COMMAND_TYPE_SET.has(input);
}

/**
 * One supported document mutation, as pure serializable data.
 * `parameter.set` has three literal/expression forms (see the Phase 22
 * extension below): a value-only set, a clear-to-literal, and an expression
 * definition that recomputes the parameter and its dependents.
 * `feature.create` adds a record ({@link addFeature}); `feature.update`
 * wholesale-replaces a record's mutable fields — kind, inputs, outputs —
 * with referential integrity enforced ({@link updateFeature});
 * `feature.delete` removes a record ({@link removeFeature}); and
 * `feature.reorder` moves a record to a new timeline position, immediately
 * after `afterFeatureId` (or to the front when `afterFeatureId` is `null`),
 * with the input-order replayability rule enforced on the result
 * ({@link reorderFeature}).
 *
 * ## The Phase 22 expression payloads (disclosed)
 *
 * A parameter's value can be DEFINED by an expression over other parameters,
 * and the command vocabulary carries that definition. `parameter.set` gains
 * an optional `expression` field with three strictly discriminated forms:
 *
 * - **Value-only** (`expression` absent): today's semantics, unchanged —
 *   the cached value is overwritten, any stored expression is left in
 *   place, and NOTHING is recomputed. This is the raw cached-value write
 *   the pre-expression vocabulary always had; keeping it recompute-free is
 *   what lets pre-expression logs replay byte-identically.
 * - **Clear** (`expression: null`, with `value`): the parameter stops being
 *   expression-driven and becomes the literal `value`; dependents are
 *   re-derived against the new literal in the same application.
 * - **Define** (`expression`: an AST, with NO `value`): the AST becomes the
 *   parameter's defining expression, its cached value is re-derived from it,
 *   and every expression-driven parameter is recomputed in topological order
 *   ({@link installParameterExpression}). A literal `value` beside a
 *   non-null `expression` is ambiguous about what defines the parameter and
 *   is rejected by the strict parser, as is an expression-less command that
 *   carries neither a value nor an expression. The wire form is the
 *   SERIALIZED AST — the vocabulary's data-first style (a `curve.create`
 *   carries its serialized curve; the document substrate serializes
 *   expressions as ASTs) — never source text, which is non-canonical (many
 *   texts, one AST) and would break the same-state-same-bytes rule for
 *   command logs.
 *
 * `parameter.create` gains the same optional `expression` AST beside its
 * required `value` (the initial cache) — a literal-only create simply omits
 * the field, so every pre-expression create command parses and applies
 * exactly as before. Application validates identifiers against the
 * document's parameters (unknown name → structured refusal naming it) and
 * refuses a closing cycle with the chain
 * (`parameter/unknown-identifier` / `parameter/cycle`).
 */
export type CadCommand =
  | {
      readonly type: "parameter.set";
      readonly id: ParameterId;
      /** The literal to store (the cached value; on clear, the literal it lands on). */
      readonly value: AnyDimensionalValue;
      /**
       * Absent: a value-only set (any stored expression stays); `null`: the
       * parameter stops being expression-driven. A non-null AST never rides
       * with a `value` — that is the other union arm.
       */
      readonly expression?: null;
    }
  | {
      readonly type: "parameter.set";
      readonly id: ParameterId;
      /**
       * The defining expression; the parameter's cached value and its
       * dependents are recomputed on apply. Carries no `value`.
       */
      readonly expression: ExpressionNode;
    }
  | {
      readonly type: "parameter.create";
      readonly id?: ParameterId;
      readonly name: string;
      /** The initial cached value; re-derived from the expression on apply when one rides. */
      readonly value: AnyDimensionalValue;
      /** The optional defining expression (validated and recomputed on apply). */
      readonly expression?: ExpressionNode;
    }
  | {
      readonly type: "body.create";
      readonly id?: BodyId;
      readonly name: string;
      /** Present exactly when the created body is a SHEET body (Phase 49). */
      readonly kind?: "sheet";
    }
  | {
      /**
       * The Phase 44 body record update: a PARTIAL update — only the
       * carried fields change (a rename keeps the display flags, a
       * visibility toggle keeps the name), so each concern rides its own
       * command and undo replays exactly what happened.
       */
      readonly type: "body.update";
      readonly id: BodyId;
      readonly name?: string;
      readonly visible?: boolean;
      readonly isolated?: boolean;
      /** Phase 59: assign an appearance record; `null` clears it. */
      readonly appearance?: Appearance | null;
      /** Phase 59: replace the face overrides; `null` clears them. */
      readonly faceAppearances?: readonly FaceAppearanceOverride[] | null;
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
      readonly type: "datum.create";
      readonly id?: DatumId;
      readonly name: string;
      readonly datum: Readonly<Record<string, unknown>>;
    }
  | {
      /**
       * The Phase 47 curve record creation: the curve module's canonical
       * serialized payload, stored verbatim (the sketch/datum discipline).
       */
      readonly type: "curve.create";
      readonly id?: CurveId;
      readonly name: string;
      readonly curve: SerializedCurve;
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
    }
  | {
      /**
       * The Phase 57 configuration row creation: the row's authored deltas —
       * parameter overrides (untrusted values re-validated dimensionally at
       * the substrate), suppressed features, and hidden bodies. Overrides
       * ride exactly the shape the configuration module parses.
       */
      readonly type: "configuration.create";
      readonly id?: ConfigurationId;
      readonly name: string;
      readonly parameterOverrides?: readonly {
        readonly parameterId: ParameterId;
        readonly value: AnyDimensionalValue;
      }[];
      readonly suppressedFeatures?: readonly FeatureId[];
      readonly hiddenBodies?: readonly BodyId[];
    }
  | {
      /** Replaces a configuration row's mutable fields, keeping its identity. */
      readonly type: "configuration.update";
      readonly id: ConfigurationId;
      readonly name: string;
      readonly parameterOverrides?: readonly {
        readonly parameterId: ParameterId;
        readonly value: AnyDimensionalValue;
      }[];
      readonly suppressedFeatures?: readonly FeatureId[];
      readonly hiddenBodies?: readonly BodyId[];
    }
  | {
      readonly type: "configuration.delete";
      readonly id: ConfigurationId;
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
      // The define form: install the AST and recompute in the same pure
      // transition (the AST shape was validated at parse; identifiers and
      // cycles are re-checked against the LIVE collection here, so a
      // smuggled command still fails structurally).
      if (command.expression !== undefined && command.expression !== null) {
        const installed = installParameterExpression(
          document.parameters,
          command.id,
          command.expression,
        );
        if (!installed.ok) return installed;
        return ok(
          Object.freeze({
            ...document,
            parameters: installed.value.collection,
          }),
        );
      }
      const updated = updateParameterValue(
        document.parameters,
        command.id,
        command.value,
      );
      if (!updated.ok) return updated;
      // The clear form: the literal lands and the expression goes, with the
      // dependents re-derived against the new literal.
      if (command.expression === null) {
        const cleared = installParameterExpression(
          updated.value,
          command.id,
          null,
        );
        if (!cleared.ok) return cleared;
        return ok(
          Object.freeze({
            ...document,
            parameters: cleared.value.collection,
          }),
        );
      }
      // The value-only form: exactly the pre-expression semantics — the
      // cached value moves, nothing is recomputed (pre-expression logs
      // replay byte-identically through this arm).
      return ok(Object.freeze({ ...document, parameters: updated.value }));
    }
    case "parameter.create": {
      const added = addDocumentParameter(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        value: command.value,
      });
      if (!added.ok) return added;
      if (command.expression === undefined) return ok(added.value.document);
      // The expression rides behind the substrate add so the validation sees
      // the parameter IN the collection (a self-reference resolves and is
      // refused as the cycle it is); the failure discards the whole pure
      // transition — nothing partial leaks.
      const installed = installParameterExpression(
        added.value.document.parameters,
        added.value.parameter.id,
        command.expression,
      );
      if (!installed.ok) return installed;
      return ok(
        Object.freeze({
          ...added.value.document,
          parameters: installed.value.collection,
        }),
      );
    }
    case "body.create": {
      const added = addBody(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        ...(command.kind === "sheet" ? { kind: "sheet" as const } : {}),
      });
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "body.update": {
      const updated = updateBody(document, command.id, {
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.visible === undefined ? {} : { visible: command.visible }),
        ...(command.isolated === undefined
          ? {}
          : { isolated: command.isolated }),
        ...(command.appearance === undefined
          ? {}
          : { appearance: command.appearance }),
        ...(command.faceAppearances === undefined
          ? {}
          : { faceAppearances: command.faceAppearances }),
      });
      if (!updated.ok) return updated;
      return ok(updated.value);
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
    case "datum.create": {
      const added = addDocumentDatum(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        datum: command.datum,
      });
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "curve.create": {
      const added = addDocumentCurve(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        curve: command.curve,
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
    case "configuration.create": {
      const added = addDocumentConfiguration(document, {
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        ...(command.parameterOverrides === undefined
          ? {}
          : { parameterOverrides: command.parameterOverrides }),
        ...(command.suppressedFeatures === undefined
          ? {}
          : { suppressedFeatures: command.suppressedFeatures }),
        ...(command.hiddenBodies === undefined
          ? {}
          : { hiddenBodies: command.hiddenBodies }),
      });
      if (!added.ok) return added;
      return ok(added.value.document);
    }
    case "configuration.update": {
      const updated = updateDocumentConfiguration(document, command.id, {
        name: command.name,
        ...(command.parameterOverrides === undefined
          ? {}
          : { parameterOverrides: command.parameterOverrides }),
        ...(command.suppressedFeatures === undefined
          ? {}
          : { suppressedFeatures: command.suppressedFeatures }),
        ...(command.hiddenBodies === undefined
          ? {}
          : { hiddenBodies: command.hiddenBodies }),
      });
      if (!updated.ok) return updated;
      return ok(updated.value);
    }
    case "configuration.delete":
      return removeDocumentConfiguration(document, command.id);
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
      /** Present-null exactly on the clear form; absent on the value-only form. */
      readonly expression?: null;
    }
  | {
      readonly formatVersion: number;
      readonly type: "parameter.set";
      readonly id: string;
      /** The define form: the serialized AST, with no `value` field. */
      readonly expression: ExpressionNode;
    }
  | {
      readonly formatVersion: number;
      readonly type: "parameter.create";
      readonly id?: string;
      readonly name: string;
      readonly value: SerializedDimensionalValue;
      /** The optional defining expression (serialized AST). */
      readonly expression?: ExpressionNode;
    }
  | {
      readonly formatVersion: number;
      readonly type: "body.create";
      readonly id?: string;
      readonly name: string;
      /** Present exactly when the created body is a SHEET body (Phase 49). */
      readonly kind?: "sheet";
    }
  | {
      readonly formatVersion: number;
      readonly type: "body.update";
      readonly id: string;
      readonly name?: string;
      readonly visible?: boolean;
      readonly isolated?: boolean;
      /** Phase 59: assign an appearance record; `null` clears it. */
      readonly appearance?: Appearance | null;
      /** Phase 59: replace the face overrides; `null` clears them. */
      readonly faceAppearances?: readonly FaceAppearanceOverride[] | null;
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
      readonly type: "datum.create";
      readonly id?: string;
      readonly name: string;
      readonly datum: Readonly<Record<string, unknown>>;
    }
  | {
      readonly formatVersion: number;
      readonly type: "curve.create";
      readonly id?: string;
      readonly name: string;
      readonly curve: SerializedCurve;
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
    }
  | {
      readonly formatVersion: number;
      readonly type: "configuration.create";
      readonly id?: string;
      readonly name: string;
      readonly parameterOverrides?: readonly {
        readonly parameterId: string;
        readonly value: SerializedDimensionalValue;
      }[];
      readonly suppressedFeatures?: readonly string[];
      readonly hiddenBodies?: readonly string[];
    }
  | {
      readonly formatVersion: number;
      readonly type: "configuration.update";
      readonly id: string;
      readonly name: string;
      readonly parameterOverrides?: readonly {
        readonly parameterId: string;
        readonly value: SerializedDimensionalValue;
      }[];
      readonly suppressedFeatures?: readonly string[];
      readonly hiddenBodies?: readonly string[];
    }
  | {
      readonly formatVersion: number;
      readonly type: "configuration.delete";
      readonly id: string;
    };

function serializeInputRef(ref: FeatureInputRef): SerializedFeatureInputRef {
  return { kind: ref.kind, id: ref.id };
}

/** Serializes a command to its canonical, deterministic JSON form. */
export function serializeCommand(command: CadCommand): SerializedCadCommand {
  switch (command.type) {
    case "parameter.set":
      if (command.expression !== undefined && command.expression !== null) {
        return {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          type: command.type,
          id: command.id,
          expression: command.expression,
        };
      }
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
        value: serializeDimensionalValue(command.value),
        ...(command.expression === undefined ? {} : { expression: null }),
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
            ...(command.expression === undefined
              ? {}
              : { expression: command.expression }),
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            name: command.name,
            value: serializeDimensionalValue(command.value),
            ...(command.expression === undefined
              ? {}
              : { expression: command.expression }),
          };
    case "body.create":
      if (command.id === undefined && command.kind === undefined) {
        return {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          type: command.type,
          name: command.name,
        };
      }
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        ...(command.id === undefined ? {} : { id: command.id }),
        ...(command.kind === undefined ? {} : { kind: command.kind }),
        name: command.name,
      };
    case "body.update":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.visible === undefined ? {} : { visible: command.visible }),
        ...(command.isolated === undefined
          ? {}
          : { isolated: command.isolated }),
        ...(command.appearance === undefined
          ? {}
          : { appearance: command.appearance }),
        ...(command.faceAppearances === undefined
          ? {}
          : { faceAppearances: command.faceAppearances }),
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
    case "datum.create":
      return command.id === undefined
        ? {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            name: command.name,
            datum: command.datum,
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            name: command.name,
            datum: command.datum,
          };
    case "curve.create":
      return command.id === undefined
        ? {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            name: command.name,
            curve: command.curve,
          }
        : {
            formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
            type: command.type,
            id: command.id,
            name: command.name,
            curve: command.curve,
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
    case "configuration.create":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        ...(command.id === undefined ? {} : { id: command.id }),
        name: command.name,
        ...(command.parameterOverrides === undefined
          ? {}
          : {
              parameterOverrides: command.parameterOverrides.map(
                (override) => ({
                  parameterId: override.parameterId,
                  value: serializeDimensionalValue(override.value),
                }),
              ),
            }),
        ...(command.suppressedFeatures === undefined
          ? {}
          : { suppressedFeatures: [...command.suppressedFeatures] }),
        ...(command.hiddenBodies === undefined
          ? {}
          : { hiddenBodies: [...command.hiddenBodies] }),
      };
    case "configuration.update":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
        name: command.name,
        ...(command.parameterOverrides === undefined
          ? {}
          : {
              parameterOverrides: command.parameterOverrides.map(
                (override) => ({
                  parameterId: override.parameterId,
                  value: serializeDimensionalValue(override.value),
                }),
              ),
            }),
        ...(command.suppressedFeatures === undefined
          ? {}
          : { suppressedFeatures: [...command.suppressedFeatures] }),
        ...(command.hiddenBodies === undefined
          ? {}
          : { hiddenBodies: [...command.hiddenBodies] }),
      };
    case "configuration.delete":
      return {
        formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
        type: command.type,
        id: command.id,
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

/**
 * Parses an optional wire array of ids through one id parser; `undefined`
 * rides through as `undefined` (the command carries no such list).
 */
function parseIdArray<K extends string>(
  input: unknown,
  parse: (value: unknown) => ParseResult<K, ParseFailure>,
): ParseResult<readonly K[] | undefined, ParseFailure> {
  if (input === undefined) return ok(undefined);
  if (!Array.isArray(input)) {
    return fail({
      code: "id/not-an-array",
      message: "must be an array",
      input,
    });
  }
  const ids: K[] = [];
  for (const entry of input) {
    const parsed = parse(entry);
    if (!parsed.ok) return parsed;
    ids.push(parsed.value);
  }
  return ok(ids);
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
 * values, expression ASTs and their form rules — while unknown fields are
 * ignored so future format versions deserialize without data corruption. A
 * missing optional `id` on `feature.create` is preserved: replay generates
 * the id deterministically.
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
      // Three strictly discriminated forms (see the CadCommand Phase 22
      // docs): value-only (expression absent), clear (expression null WITH a
      // value — the literal the parameter lands on), and define (an AST with
      // NO value). Ambiguity is rejected here, not guessed at apply.
      if (input.expression === undefined) {
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
      if (input.expression === null) {
        const parsedValue = parseDimensionalValue(input.value);
        if (!parsedValue.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A parameter.set command clearing an expression needs the literal value it lands on: ${parsedValue.error.message}`,
              input.value,
            ),
          );
        }
        return ok(
          Object.freeze({
            type,
            id: parsedId.value,
            value: parsedValue.value,
            expression: null,
          }),
        );
      }
      if (input.value !== undefined) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A parameter.set command cannot carry both a literal value and a defining expression; commit one form — a literal (value, with expression absent or null) or an expression (expression, without value).",
            input,
          ),
        );
      }
      const parsedExpression = parseExpressionAst(input.expression);
      if (!parsedExpression.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A parameter.set command needs a valid expression AST: ${parsedExpression.error.message}`,
            input.expression,
          ),
        );
      }
      return ok(
        Object.freeze({
          type,
          id: parsedId.value,
          expression: parsedExpression.value,
        }),
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
      // The optional defining expression: an AST when present (a create is
      // total, so there is no clear form — null is refused, omit the field
      // for a literal-only parameter).
      let expression: ExpressionNode | undefined;
      if (input.expression !== undefined) {
        if (input.expression === null) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              "A parameter.create command's expression must be a valid expression AST when present; omit the field for a literal-only parameter.",
              input.expression,
            ),
          );
        }
        const parsedExpression = parseExpressionAst(input.expression);
        if (!parsedExpression.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A parameter.create command needs a valid expression AST: ${parsedExpression.error.message}`,
              input.expression,
            ),
          );
        }
        expression = parsedExpression.value;
      }
      return ok(
        Object.freeze(
          id === undefined
            ? {
                type,
                name: input.name,
                value: parsedValue.value,
                ...(expression === undefined ? {} : { expression }),
              }
            : {
                type,
                id,
                name: input.name,
                value: parsedValue.value,
                ...(expression === undefined ? {} : { expression }),
              },
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
      const kind = input.kind === "sheet" ? ("sheet" as const) : undefined;
      return ok(
        Object.freeze(
          id === undefined && kind === undefined
            ? { type, name: input.name }
            : {
                type,
                ...(id === undefined ? {} : { id }),
                ...(kind === undefined ? {} : { kind }),
                name: input.name,
              },
        ),
      );
    }
    case "body.update": {
      const parsedId = parseBodyId(input.id);
      if (!parsedId.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A body.update command needs a valid body id: ${parsedId.error.message}`,
            input.id,
          ),
        );
      }
      if (
        input.name === undefined &&
        input.visible === undefined &&
        input.isolated === undefined &&
        input.appearance === undefined &&
        input.faceAppearances === undefined
      ) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A body.update command needs at least one of a name, a visible flag, an isolated flag, an appearance record, or face appearance overrides.",
            input,
          ),
        );
      }
      if (
        input.name !== undefined &&
        (typeof input.name !== "string" || input.name.length === 0)
      ) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A body.update command needs a non-empty name string when it carries one.",
            input.name,
          ),
        );
      }
      if (input.visible !== undefined && typeof input.visible !== "boolean") {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A body.update command's visible flag must be a boolean when present.",
            input.visible,
          ),
        );
      }
      if (input.isolated !== undefined && typeof input.isolated !== "boolean") {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A body.update command's isolated flag must be a boolean when present.",
            input.isolated,
          ),
        );
      }
      // The appearance fields (Phase 59): an appearance record or an
      // explicit `null` (clear), validated through the appearance module's
      // gate; the executor re-validates through the document boundary.
      let appearance: Appearance | null | undefined;
      if (input.appearance !== undefined) {
        if (input.appearance === null) {
          appearance = null;
        } else {
          const parsed = parseAppearance(input.appearance);
          if (!parsed.ok) {
            return fail(
              commandError(
                COMMAND_ERROR_CODES.malformed,
                `A body.update command's appearance record is invalid: ${parsed.error.message}`,
                input.appearance,
              ),
            );
          }
          appearance = parsed.value;
        }
      }
      let faceAppearances: readonly FaceAppearanceOverride[] | null | undefined;
      if (input.faceAppearances !== undefined) {
        if (input.faceAppearances === null) {
          faceAppearances = null;
        } else {
          if (!Array.isArray(input.faceAppearances)) {
            return fail(
              commandError(
                COMMAND_ERROR_CODES.malformed,
                "A body.update command's faceAppearances must be an array or null when present.",
                input.faceAppearances,
              ),
            );
          }
          const overrides: FaceAppearanceOverride[] = [];
          for (const entry of input.faceAppearances) {
            if (
              typeof entry !== "object" ||
              entry === null ||
              typeof (entry as Record<string, unknown>).face !== "number" ||
              !Number.isInteger((entry as Record<string, unknown>).face)
            ) {
              return fail(
                commandError(
                  COMMAND_ERROR_CODES.malformed,
                  "A face appearance override must carry an integer face index and an appearance.",
                  entry,
                ),
              );
            }
            const parsed = parseAppearance(
              (entry as Record<string, unknown>).appearance,
            );
            if (!parsed.ok) {
              return fail(
                commandError(
                  COMMAND_ERROR_CODES.malformed,
                  `A face appearance override's appearance is invalid: ${parsed.error.message}`,
                  entry,
                ),
              );
            }
            overrides.push(
              Object.freeze({
                face: (entry as Record<string, unknown>).face as number,
                appearance: parsed.value,
              }),
            );
          }
          faceAppearances = Object.freeze(overrides);
        }
      }
      return ok(
        Object.freeze({
          type,
          id: parsedId.value,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.visible === undefined ? {} : { visible: input.visible }),
          ...(input.isolated === undefined ? {} : { isolated: input.isolated }),
          ...(appearance === undefined ? {} : { appearance }),
          ...(faceAppearances === undefined ? {} : { faceAppearances }),
        }),
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
    case "datum.create": {
      let id: DatumId | undefined;
      if (input.id !== undefined) {
        const parsedId = parseDatumId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A datum.create command needs a valid datum id: ${parsedId.error.message}`,
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
            "A datum.create command needs a non-empty name string.",
            input.name,
          ),
        );
      }
      if (!isPlainRecord(input.datum)) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A datum.create command needs a plain-object datum payload (the datum module's canonical serialized form).",
            input.datum,
          ),
        );
      }
      return ok(
        Object.freeze(
          id === undefined
            ? { type, name: input.name, datum: input.datum }
            : { type, id, name: input.name, datum: input.datum },
        ),
      );
    }
    case "curve.create": {
      let id: CurveId | undefined;
      if (input.id !== undefined) {
        const parsedId = parseCurveId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A curve.create command needs a valid curve id: ${parsedId.error.message}`,
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
            "A curve.create command needs a non-empty name string.",
            input.name,
          ),
        );
      }
      // The curve payload parses through the curve module's own strict
      // parser here (stronger than the datum's plain-record check, because
      // the curve schema is shared); the semantic battery re-runs at the
      // substrate ({@link addDocumentCurve}).
      const parsedCurve = parseSerializedCurve(input.curve);
      if (!parsedCurve.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A curve.create command needs a valid curve payload: ${parsedCurve.error.message}`,
            input.curve,
          ),
        );
      }
      return ok(
        Object.freeze(
          id === undefined
            ? { type, name: input.name, curve: parsedCurve.value }
            : { type, id, name: input.name, curve: parsedCurve.value },
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
    case "configuration.create":
    case "configuration.update": {
      const isUpdate = type === "configuration.update";
      let id: ConfigurationId | undefined;
      if (isUpdate || input.id !== undefined) {
        const parsedId = parseConfigurationId(input.id);
        if (!parsedId.ok) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A ${type} command needs a valid configuration id: ${parsedId.error.message}`,
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
            `A ${type} command needs a non-empty name string.`,
            input.name,
          ),
        );
      }
      let overrides:
        | readonly { parameterId: ParameterId; value: AnyDimensionalValue }[]
        | undefined;
      if (input.parameterOverrides !== undefined) {
        if (!Array.isArray(input.parameterOverrides)) {
          return fail(
            commandError(
              COMMAND_ERROR_CODES.malformed,
              `A ${type} command's parameterOverrides must be an array.`,
              input.parameterOverrides,
            ),
          );
        }
        const rows: {
          parameterId: ParameterId;
          value: AnyDimensionalValue;
        }[] = [];
        for (const entry of input.parameterOverrides) {
          if (!isPlainRecord(entry)) {
            return fail(
              commandError(
                COMMAND_ERROR_CODES.malformed,
                `A ${type} command's overrides must be objects with parameterId and value.`,
                entry,
              ),
            );
          }
          const parsedParameter = parseParameterId(entry.parameterId);
          if (!parsedParameter.ok) {
            return fail(
              commandError(
                COMMAND_ERROR_CODES.malformed,
                `A ${type} command's override needs a valid parameter id: ${parsedParameter.error.message}`,
                entry,
              ),
            );
          }
          const parsedValue = parseDimensionalValue(entry.value);
          if (!parsedValue.ok) {
            return fail(
              commandError(
                COMMAND_ERROR_CODES.malformed,
                `A ${type} command's override needs a valid dimensional value: ${parsedValue.error.message}`,
                entry,
              ),
            );
          }
          rows.push({
            parameterId: parsedParameter.value,
            value: parsedValue.value,
          });
        }
        overrides = rows;
      }
      const suppressed = parseIdArray(input.suppressedFeatures, parseFeatureId);
      if (!suppressed.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A ${type} command's suppressedFeatures must be valid feature ids: ${suppressed.error.message}`,
            input.suppressedFeatures,
          ),
        );
      }
      const hidden = parseIdArray(input.hiddenBodies, parseBodyId);
      if (!hidden.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A ${type} command's hiddenBodies must be valid body ids: ${hidden.error.message}`,
            input.hiddenBodies,
          ),
        );
      }
      if (!isUpdate) {
        return ok(
          Object.freeze({
            type,
            ...(id === undefined ? {} : { id }),
            name: input.name,
            ...(overrides === undefined
              ? {}
              : { parameterOverrides: overrides }),
            ...(suppressed.value === undefined
              ? {}
              : { suppressedFeatures: suppressed.value }),
            ...(hidden.value === undefined
              ? {}
              : { hiddenBodies: hidden.value }),
          }),
        );
      }
      if (id === undefined) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            "A configuration.update command needs a valid configuration id.",
            input.id,
          ),
        );
      }
      return ok(
        Object.freeze({
          type,
          id,
          name: input.name,
          ...(overrides === undefined ? {} : { parameterOverrides: overrides }),
          ...(suppressed.value === undefined
            ? {}
            : { suppressedFeatures: suppressed.value }),
          ...(hidden.value === undefined ? {} : { hiddenBodies: hidden.value }),
        }),
      );
    }
    case "configuration.delete": {
      const parsedId = parseConfigurationId(input.id);
      if (!parsedId.ok) {
        return fail(
          commandError(
            COMMAND_ERROR_CODES.malformed,
            `A configuration.delete command needs a valid configuration id: ${parsedId.error.message}`,
            input.id,
          ),
        );
      }
      return ok(Object.freeze({ type, id: parsedId.value }));
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
