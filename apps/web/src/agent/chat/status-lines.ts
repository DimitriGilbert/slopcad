/**
 * The chat panel's status-line derivations (PLAN-AGENT-CHAT Phase 4.4):
 * the pure functions behind the transcript's status surfaces. Both are
 * functions of DATA ALONE — never of transient UI state — which is what
 * makes status lines become persistent history:
 *
 * - {@link agentPendingStatusLine} is the one orchestrator-level line the
 *   template pattern adds (its "Thinking…" row): shown while a run is
 *   starting and the incoming message has not yet produced a single
 *   renderable part. The moment any part arrives, the Phase 4.3 part
 *   renderers own status display (running tools render their own
 *   "Calling …" lines inside the message), and those lines persist with
 *   the message: the persistence rows carry parts verbatim
 *   (`../persistence/rows.ts`'s losslessness contract), so a resumed
 *   transcript renders the same status history without any of this
 *   module's transient state.
 * - {@link formatAgentSyncStatus} renders the Phase 3.4 sync status as
 *   the visible line — idle-with-nothing-queued hides, everything else
 *   (syncing, queued work, failures with their stalled op) shows, so a
 *   failed sync is never silent.
 */

import type { AgentSyncStatus } from "../persistence/sync";
import type { AgentChatMessage } from "./parts/part-types";

/** Everything the pending-line derivation needs. */
export interface AgentPendingStatusLineInput {
  readonly messages: readonly AgentChatMessage[];
  /** True while a run is submitted or streaming. */
  readonly busy: boolean;
}

/** The pending line's text; null whenever the transcript already shows work. */
export const AGENT_PENDING_LINE = "Waiting for the agent…";

/** True once a message carries any part the renderers draw. */
function messageHasRenderedContent(message: AgentChatMessage): boolean {
  // Every non-text part renders something in every state (the Phase 4.3
  // exhaustive switch guarantees it); a text part renders once it has
  // non-whitespace content.
  return message.parts.some(
    (part) => part.type !== "text" || part.content.trim().length > 0,
  );
}

/**
 * The current run's trailing assistant message: the newest assistant
 * message AFTER the last user message. Right after a send it does not
 * exist yet — the transcript ends with the user's own text, which must
 * never suppress the waiting line — and earlier turns' assistants are
 * not the current run's either.
 */
function trailingAssistantOfRun(
  messages: readonly AgentChatMessage[],
): AgentChatMessage | undefined {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

/**
 * The transient pre-content status row: present only while a run is busy
 * AND the current run has produced nothing renderable yet (no assistant
 * message after the last user text, or that message still empty of
 * renderable parts). Null the moment content arrives, after a stop, and
 * on every resumed transcript — the run's durable status then lives in
 * the message parts themselves.
 */
export function agentPendingStatusLine(
  input: AgentPendingStatusLineInput,
): string | null {
  if (!input.busy) {
    return null;
  }
  const trailing = trailingAssistantOfRun(input.messages);
  if (trailing !== undefined && messageHasRenderedContent(trailing)) {
    return null;
  }
  return AGENT_PENDING_LINE;
}

/** Maps a thrown value to readable text for the surfaced lines. */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "unknown error";
}

/** The human noun of one sync op kind, for the failure line. */
function syncOpNoun(status: AgentSyncStatus): string {
  switch (status.failure?.kind) {
    case "create-conversation":
      return "conversation create";
    case "append-message":
      return "message append";
    case "delete-conversation":
      return "conversation delete";
    default:
      return "sync";
  }
}

/**
 * Renders the sync status as the chat's visible line. `null` (nothing
 * rendered) only for the true quiet state — idle with an empty queue;
 * everything else surfaces, failures foremost.
 */
export function formatAgentSyncStatus(status: AgentSyncStatus): string | null {
  if (status.state === "syncing") {
    return status.pending > 0
      ? `Syncing conversation (${String(status.pending)} ops left)…`
      : "Syncing conversation…";
  }
  if (status.state === "failed" && status.failure !== null) {
    return `Sync failed at ${syncOpNoun(status)}: ${errorText(
      status.failure.error,
    )} — ${String(status.pending)} op(s) still queued.`;
  }
  if (status.pending > 0) {
    return `${String(status.pending)} change(s) waiting to sync.`;
  }
  return null;
}
