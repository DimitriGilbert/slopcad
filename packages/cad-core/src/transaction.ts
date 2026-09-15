/**
 * Transactions (Phase 7.2): an ordered batch of {@link CadCommand}s with an
 * atomic commit. {@link applyTransaction} folds the commands over the
 * document through the single {@link applyCommand} interpreter — command 2
 * sees command 1's effect, and so on — and commits only if every command
 * succeeds. Rollback is structural: documents are immutable, the fold
 * threads private intermediate states, and the caller's document is never
 * touched, so a failed transaction leaves nothing behind (there is nothing
 * to undo). A failure carries `transaction/command-failed`, the zero-based
 * index of the offending command, and that command's first structured
 * error as `cause`; an empty transaction commits to the identical document
 * value (identity — the fold of zero commands).
 *
 * A transaction is itself serializable as an ordered command list:
 * {@link serializeTransaction} emits `{ formatVersion, commands }` in fixed
 * key order and {@link parseTransaction} validates untrusted input strictly
 * (unknown fields ignored for forward compatibility), so transactions can
 * cross persistence and IPC boundaries and replay exactly.
 */

import {
  applyCommand,
  type CadCommand,
  type CommandError,
  parseCommand,
  serializeCommand,
  type SerializedCadCommand,
} from "./command";
import { type CadDocument, type DocumentError } from "./document";
import { type ParameterError } from "./parameter";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { CAD_DOCUMENT_FORMAT_VERSION } from "./version";

/** An ordered batch of commands committed atomically. */
export interface CadTransaction {
  readonly commands: readonly CadCommand[];
}

/** Stable failure codes produced when transaction input is rejected. */
export const TRANSACTION_ERROR_CODES = {
  malformed: "transaction/malformed",
  versionUnsupported: "transaction/version-unsupported",
  commandFailed: "transaction/command-failed",
} as const;

export type TransactionErrorCode =
  (typeof TRANSACTION_ERROR_CODES)[keyof typeof TRANSACTION_ERROR_CODES];

/**
 * Structured failure describing why a transaction was rejected. `index` is
 * the zero-based position of the offending command, or -1 when the failure
 * is about the transaction as a whole (a malformed serialized envelope);
 * `cause` is the offending command's own structured error, when there is
 * one.
 */
export interface TransactionError extends ParseFailure {
  readonly code: TransactionErrorCode;
  readonly index: number;
  readonly cause?: DocumentError | ParameterError | CommandError;
}

function transactionError(
  code: TransactionErrorCode,
  message: string,
  input: unknown,
  index: number,
  cause?: DocumentError | ParameterError | CommandError,
): TransactionError {
  return { code, message, input, index, cause };
}

/**
 * Runtime guard for a smuggled non-array `commands` field. A dedicated guard
 * (rather than a bare `Array.isArray`) keeps the element type narrowed to
 * {@link CadCommand} instead of degrading it through `any[]`.
 */
function isCommandList(
  commands: unknown,
): commands is readonly CadCommand[] {
  return Array.isArray(commands);
}

/**
 * Applies a transaction atomically: commands run in order, each against the
 * document its predecessors produced, and either all succeed (returning the
 * final document) or the first failure aborts the fold with
 * `transaction/command-failed`, its command index, and its structured cause.
 * The input document is never modified, so a failed transaction is a
 * never-happened transaction.
 */
export function applyTransaction(
  document: CadDocument,
  transaction: CadTransaction,
): ParseResult<CadDocument, TransactionError> {
  if (!isCommandList(transaction.commands)) {
    return fail(
      transactionError(
        TRANSACTION_ERROR_CODES.malformed,
        "A transaction's commands must be an array.",
        transaction,
        -1,
      ),
    );
  }
  let current = document;
  for (const [index, command] of transaction.commands.entries()) {
    const applied = applyCommand(current, command);
    if (!applied.ok) {
      return fail(
        transactionError(
          TRANSACTION_ERROR_CODES.commandFailed,
          `The command at index ${index} of the transaction failed: ${applied.error.message}`,
          command,
          index,
          applied.error,
        ),
      );
    }
    current = applied.value;
  }
  return ok(current);
}

/** Canonical JSON form of a transaction, in fixed key order. */
export interface SerializedCadTransaction {
  readonly formatVersion: number;
  readonly commands: readonly SerializedCadCommand[];
}

/** Serializes a transaction to its canonical, deterministic JSON form. */
export function serializeTransaction(
  transaction: CadTransaction,
): SerializedCadTransaction {
  return {
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    commands: transaction.commands.map(serializeCommand),
  };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Parses untrusted input (e.g. a transaction revived from persisted JSON or
 * IPC) as a {@link CadTransaction}. Every command is validated through
 * {@link parseCommand}; a malformed command fails with
 * `transaction/malformed`, its index, and the command's own error as
 * `cause`. Unknown fields are ignored so future format versions deserialize
 * without data corruption.
 */
export function parseTransaction(
  input: unknown,
): ParseResult<CadTransaction, TransactionError> {
  if (!isPlainRecord(input)) {
    return fail(
      transactionError(
        TRANSACTION_ERROR_CODES.malformed,
        "A serialized transaction must be a plain object with a commands array.",
        input,
        -1,
      ),
    );
  }
  if (input.formatVersion !== CAD_DOCUMENT_FORMAT_VERSION) {
    return fail(
      transactionError(
        TRANSACTION_ERROR_CODES.versionUnsupported,
        `A serialized transaction must carry formatVersion ${CAD_DOCUMENT_FORMAT_VERSION}.`,
        input.formatVersion,
        -1,
      ),
    );
  }
  if (!Array.isArray(input.commands)) {
    return fail(
      transactionError(
        TRANSACTION_ERROR_CODES.malformed,
        "A serialized transaction must carry a commands array.",
        input.commands,
        -1,
      ),
    );
  }
  const commands: CadCommand[] = [];
  for (const [index, entry] of input.commands.entries()) {
    const parsed = parseCommand(entry);
    if (!parsed.ok) {
      return fail(
        transactionError(
          TRANSACTION_ERROR_CODES.malformed,
          `The command at index ${index} of the serialized transaction is invalid: ${parsed.error.message}`,
          entry,
          index,
          parsed.error,
        ),
      );
    }
    commands.push(parsed.value);
  }
  return ok(Object.freeze({ commands: Object.freeze(commands) }));
}
