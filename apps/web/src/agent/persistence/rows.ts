/**
 * The message ↔ row mapping for client-emitted agent chat persistence
 * (PLAN-AGENT-CHAT Phase 3.4, D3): our own glue between TanStack AI's
 * `UIMessage`/parts model and the flat rows the persisted TanStack DB
 * collections store — the mapping
 * `docs/research/tanstack-ai.md` §12(c) says does not exist upstream and is
 * ours to write.
 *
 * Round-trip contract (pinned by `rows.test.ts`):
 *
 * - `messageToRow` → `rowToMessage` returns the original message for every
 *   JSON-born field, VERBATIM: parts are stored as one `JSON.stringify` of
 *   the array and parsed back with plain `JSON.parse` — no replacer, no
 *   reviver, no per-type handling. Any transform at this seam would need
 *   provenance the JSON text cannot carry (an earlier date-envelope scheme
 *   folded payload objects that happened to look like the envelope — the
 *   reviver cannot distinguish our tag from user data), so parts and
 *   `metadata` follow the plain JSON convention: a `Date` inside them
 *   persists as its ISO string. That is exactly the convention the sync
 *   wire already used and TanStack's own storage normalizes back into
 *   Dates on load (`@tanstack/ai-client`'s message date normalizer).
 * - Message-level fields that get REAL columns are the only revived values:
 *   `createdAt` is a dedicated row column read back as a `Date` — provenance
 *   is structural, not guessed from the payload text.
 * - UNKNOWN part types round-trip VERBATIM: parts are never filtered,
 *   mapped, or enumerated by type — a part shape a newer `@tanstack/ai`
 *   emits (or a custom part) persists untouched and rehydrates untouched,
 *   including objects whose shape resembles any internal envelope (there
 *   is none anymore).
 *
 * The sync wire form ({@link messageRowPartsToWire}) is now the SAME text:
 * the stored parts JSON is already the plain form the tRPC
 * `agentConversations.append` contract
 * (`packages/api/src/routers/agent-conversations.ts`) stores verbatim in
 * its opaque JSON column — the server never sees slopcad-internal tagging.
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
 * One `agent_messages` row. `parts`/`metadata` are plain JSON text
 * (`JSON.stringify` of the live values — Dates as ISO strings, nothing
 * tagged); `seq` is the per-conversation monotonic insertion order (TanStack
 * collections iterate by key, not insertion, so order must be carried
 * explicitly); `syncedAt` is the outbox's per-row delivery marker (null =
 * append still queued).
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    parts: JSON.stringify(message.parts),
    name: message.name ?? null,
    metadata: metadata === undefined ? null : JSON.stringify(metadata),
    createdAt: (message.createdAt ?? new Date()).toISOString(),
    syncedAt: null,
  };
}

/**
 * Decodes a row's parts text verbatim (plain `JSON.parse` — no reviver) and
 * asserts it is an array (it always is for rows written by
 * {@link messageToRow}; a corrupt store fails loudly here instead of feeding
 * the chat runtime garbage).
 */
function decodeParts(row: AgentMessageRow): unknown[] {
  const decoded: unknown = JSON.parse(row.parts);
  if (!Array.isArray(decoded)) {
    throw new TypeError(
      `The stored parts of message "${row.id}" are not a JSON array (store corrupt?).`,
    );
  }
  return decoded;
}

/**
 * Revives one row into a TanStack AI `UIMessage` — the resume path's
 * currency (`useChat`-shaped messages). The parts array is returned exactly
 * as stored: `unknown`-typed JSON that was a valid parts array when written,
 * re-narrowed with the array check only (the verbatim round-trip is the
 * mapping's contract, pinned by tests — a per-part re-validation here would
 * be a second, drifting copy of the parts model). The one revived Date is
 * the row-level `createdAt` column, not anything parsed from payload text.
 */
export function rowToMessage(row: AgentMessageRow): UIMessage {
  const parts: unknown[] = decodeParts(row);
  const metadata: unknown =
    row.metadata === null ? undefined : JSON.parse(row.metadata);
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
 * The parts of one row in their tRPC wire form. The stored parts text IS
 * the wire form: plain JSON, exactly what the server's opaque JSON column
 * stores — there is no private envelope to strip. The outbox's append op
 * sends this.
 */
export function messageRowPartsToWire(row: AgentMessageRow): unknown[] {
  return decodeParts(row);
}
