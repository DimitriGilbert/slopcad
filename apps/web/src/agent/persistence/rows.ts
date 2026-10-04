/**
 * The message ↔ row mapping for client-emitted agent chat persistence
 * (PLAN-AGENT-CHAT Phase 3.4, D3): our own glue between TanStack AI's
 * `UIMessage`/parts model and the flat rows the persisted TanStack DB
 * collections store — the mapping
 * `docs/research/tanstack-ai.md` §12(c) says does not exist upstream and is
 * ours to write.
 *
 * Losslessness contract (pinned by `rows.test.ts`):
 *
 * - `messageToRow` → `rowToMessage` returns a message equal to the original
 *   for every JSON-born field, and revives `Date` values as `Date`s (a plain
 *   `JSON.parse(JSON.stringify(...))` silently degrades them to strings —
 *   TanStack's converters expect `createdAt?: Date`). Dates survive through
 *   a single-key envelope (`{ [DATE_TAG]: iso }`) written by a replacer and
 *   folded back by a reviver; the tag is deliberately namespaced so no
 *   wire-born object can collide with it.
 * - UNKNOWN part types round-trip VERBATIM: parts are serialized as a whole
 *   array, never filtered, mapped, or enumerated by type — a part shape a
 *   newer `@tanstack/ai` emits (or a custom part) persists untouched and
 *   rehydrates untouched. Known part fields (tool-call ids, image sources,
 *   error states, thinking signatures) therefore need no per-type handling
 *   here at all; that is the point.
 * - Message-level optional fields (`name`, `metadata`, `createdAt`) are
 *   preserved; `metadata` uses the same date-preserving codec.
 *
 * The sync wire form ({@link messageRowPartsToWire}) is deliberately
 * DIFFERENT: the tRPC `agentConversations.append` contract
 * (`packages/api/src/routers/agent-conversations.ts`) stores `parts` as
 * opaque JSON, so the push strips our private date envelope and sends the
 * plain JSON form (Dates as ISO strings — the wire convention). The server
 * never sees slopcad-internal tagging.
 *
 * Roles mirror the tRPC `append` enum exactly (`system | user | assistant`)
 * via the router's own exported type, so client rows and server rows cannot
 * drift apart.
 */

import type { UIMessage } from "@tanstack/ai";
import type { AgentMessageRole } from "@slopcad/api/routers/agent-conversations";

/**
 * One `agent_conversations` row (client-side, D3). `id` is minted
 * CLIENT-side (`crypto.randomUUID` in the store) — client-emitted chat is
 * keyed by its own ids; `serverId` is the tRPC conversation id once the
 * opt-in sync's create has been acknowledged (null until then), which is
 * what makes the sync outbox's create/append split durable.
 */
export interface AgentConversationRow {
  readonly id: string;
  readonly title: string;
  /** ISO timestamp of creation. */
  readonly createdAt: string;
  /** ISO timestamp of the last append (mirror of the server column). */
  readonly updatedAt: string;
  /** The server conversation id once the sync create was acknowledged. */
  readonly serverId: string | null;
}

/**
 * One `agent_messages` row. `parts`/`metadata` are the date-preserving JSON
 * text this module defines; `seq` is the per-conversation monotonic
 * insertion order (TanStack collections iterate by key, not insertion, so
 * order must be carried explicitly); `syncedAt` is the outbox's per-row
 * delivery marker (null = append still queued).
 */
export interface AgentMessageRow {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly role: AgentMessageRole;
  readonly parts: string;
  readonly name: string | null;
  readonly metadata: string | null;
  readonly createdAt: string;
  readonly syncedAt: string | null;
}

/**
 * The single-key envelope a `Date` serializes into. Namespaced so a
 * wire-born part can never be mistaken for one (and checked for exactly-one
 * key on the way back).
 */
const DATE_TAG = "__slopcadDateIso";

/**
 * The `JSON.stringify` replacer that tags `Date`s. Reads the RAW property
 * through `this[key]` because stringify applies `toJSON` BEFORE the
 * replacer — by the time the replacer sees a Date it is already an ISO
 * string. (For the root call stringify wraps the value as `{ "": value }`,
 * so `this[key]` with `key === ""` covers that case too.)
 */
function dateTagger(
  this: Record<string, unknown>,
  key: string,
  value: unknown,
): unknown {
  const raw = this[key];
  return raw instanceof Date ? { [DATE_TAG]: raw.toISOString() } : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `JSON.parse` reviver: an object carrying EXACTLY the date tag (and a
 * string value) folds back into a `Date`; everything else passes through.
 */
function dateReviver(_key: string, value: unknown): unknown {
  if (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value[DATE_TAG] === "string"
  ) {
    return new Date(value[DATE_TAG]);
  }
  return value;
}

/** Date-preserving encode (message-level values are JSON-born plus Dates). */
function encodePreservingDates(value: unknown): string {
  return JSON.stringify(value, dateTagger);
}

/** The inverse of {@link encodePreservingDates}. */
function decodePreservingDates(text: string): unknown {
  return JSON.parse(text, dateReviver);
}

/**
 * Maps one TanStack AI `UIMessage` to its persisted row form. `seq` is the
 * per-conversation order (the store mints it); `createdAt` is the message's
 * own timestamp when it carries one, else now.
 */
export function messageToRow(
  message: UIMessage,
  conversationId: string,
  seq: number,
): AgentMessageRow {
  if (typeof message.id !== "string" || message.id.length === 0) {
    throw new RangeError("messageToRow: the message carries no usable id.");
  }
  const metadata: unknown = message.metadata;
  return {
    id: message.id,
    conversationId,
    seq,
    role: message.role,
    parts: encodePreservingDates(message.parts),
    name: message.name ?? null,
    metadata: metadata === undefined ? null : encodePreservingDates(metadata),
    createdAt: (message.createdAt ?? new Date()).toISOString(),
    syncedAt: null,
  };
}

/**
 * Decodes a row's parts text and asserts it is an array (it always is for
 * rows written by {@link messageToRow}; a corrupt store fails loudly here
 * instead of feeding the chat runtime garbage).
 */
function decodeParts(row: AgentMessageRow): unknown[] {
  const decoded = decodePreservingDates(row.parts);
  if (!Array.isArray(decoded)) {
    throw new TypeError(
      `The stored parts of message "${row.id}" are not a JSON array (store corrupt?).`,
    );
  }
  return decoded;
}

/**
 * Revives one row into a TanStack AI `UIMessage` — the resume path's
 * currency (`useChat`-shaped messages, Dates as Dates). The parts array is
 * returned exactly as stored: `unknown`-typed JSON that was a valid parts
 * array when written, re-narrowed with the array check only (the lossless
 * round-trip is the mapping's contract, pinned by tests — a per-part
 * re-validation here would be a second, drifting copy of the parts model).
 */
export function rowToMessage(row: AgentMessageRow): UIMessage {
  const parts: unknown[] = decodeParts(row);
  const metadata: unknown =
    row.metadata === null ? undefined : decodePreservingDates(row.metadata);
  const metadataRecord = isPlainObject(metadata) ? metadata : undefined;
  return {
    id: row.id,
    role: row.role,
    parts: parts as UIMessage["parts"],
    createdAt: new Date(row.createdAt),
    ...(row.name === null ? {} : { name: row.name }),
    ...(metadataRecord === undefined ? {} : { metadata: metadataRecord }),
  };
}

/**
 * The parts of one row in their tRPC wire form: the SAME JSON minus the
 * private date envelope — `Date`s become ISO strings, exactly what
 * `JSON.stringify` does to them and what the server's opaque JSON column
 * stores. The outbox's append op sends this, never the tagged local form.
 */
export function messageRowPartsToWire(row: AgentMessageRow): unknown[] {
  const plain: unknown = JSON.parse(JSON.stringify(decodeParts(row)));
  if (!Array.isArray(plain)) {
    throw new TypeError(
      `The stored parts of message "${row.id}" did not re-serialize to an array.`,
    );
  }
  return plain;
}
