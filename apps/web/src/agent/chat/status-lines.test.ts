// @vitest-environment node
// Pure status-line derivations over message data; jsdom adds nothing.

/**
 * The status-line contract (PLAN-AGENT-CHAT Phase 4.4): the transient
 * pending line shows only while a run is busy and nothing renderable has
 * streamed yet — and status history is a function of the MESSAGE PARTS,
 * which persist verbatim (the Phase 3.4 rows' losslessness contract), so
 * a transcript resumed from persistence derives the same lines. The sync
 * formatter surfaces everything but the true quiet state — failures
 * never silent (D3).
 */

import type { UIMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import type { AgentSyncStatus } from "../persistence/sync";
import type { AgentChatMessage } from "./parts/part-types";

import { messageToRow, rowToMessage } from "../persistence/rows";
import {
  AGENT_PENDING_LINE,
  agentPendingStatusLine,
  formatAgentSyncStatus,
} from "./status-lines";

/** One user text message. */
function userMessage(id: string, content: string): AgentChatMessage {
  return { id, role: "user", parts: [{ type: "text", content }] };
}

/** One assistant message over the given parts. */
function assistantMessage(
  id: string,
  parts: AgentChatMessage["parts"],
): AgentChatMessage {
  return { id, role: "assistant", parts };
}

describe("agentPendingStatusLine", () => {
  it("shows the waiting line while busy with no messages yet", () => {
    expect(agentPendingStatusLine({ busy: true, messages: [] })).toBe(
      AGENT_PENDING_LINE,
    );
  });

  it("shows the waiting line in the real post-send state: busy, transcript ending with the user's own text", () => {
    const line = agentPendingStatusLine({
      busy: true,
      messages: [userMessage("u1", "extrude the base")],
    });
    expect(line).toBe(AGENT_PENDING_LINE);
  });

  it("keeps waiting across earlier turns while the current run's assistant has not arrived", () => {
    const line = agentPendingStatusLine({
      busy: true,
      messages: [
        userMessage("u1", "first"),
        assistantMessage("a1", [{ type: "text", content: "Done." }]),
        userMessage("u2", "second"),
      ],
    });
    expect(line).toBe(AGENT_PENDING_LINE);
  });

  it("yields once the CURRENT run's assistant has content, earlier turns aside", () => {
    const line = agentPendingStatusLine({
      busy: true,
      messages: [
        userMessage("u1", "first"),
        assistantMessage("a1", [{ type: "text", content: "Done." }]),
        userMessage("u2", "second"),
        assistantMessage("a2", [{ type: "text", content: "Mak" }]),
      ],
    });
    expect(line).toBeNull();
  });

  it("shows the waiting line while the newest message has no renderable part", () => {
    const line = agentPendingStatusLine({
      busy: true,
      messages: [
        userMessage("u1", "extrude the base"),
        assistantMessage("a1", [{ type: "text", content: "   " }]),
      ],
    });
    expect(line).toBe(AGENT_PENDING_LINE);
  });

  it("yields once the newest message streams real text", () => {
    const line = agentPendingStatusLine({
      busy: true,
      messages: [
        userMessage("u1", "extrude the base"),
        assistantMessage("a1", [{ type: "text", content: "Mak" }]),
      ],
    });
    expect(line).toBeNull();
  });

  it("yields once any non-text part arrives (parts own status display)", () => {
    const line = agentPendingStatusLine({
      busy: true,
      messages: [
        userMessage("u1", "extrude the base"),
        assistantMessage("a1", [
          {
            arguments: "{}",
            id: "call-1",
            name: "cad_apply_commands",
            state: "awaiting-input",
            type: "tool-call",
          },
        ]),
      ],
    });
    expect(line).toBeNull();
  });

  it("never shows while not busy — on live and resumed transcripts alike", () => {
    const messages = [
      userMessage("u1", "extrude the base"),
      assistantMessage("a1", [{ type: "text", content: "Done." }]),
    ];
    expect(agentPendingStatusLine({ busy: false, messages })).toBeNull();
    expect(agentPendingStatusLine({ busy: false, messages: [] })).toBeNull();
  });

  it("derives identically after the persistence round-trip (parts are the history)", () => {
    const original: readonly UIMessage[] = [
      userMessage("u1", "extrude the base"),
      assistantMessage("a1", [
        { type: "text", content: "Applying." },
        {
          arguments: "{}",
          id: "call-1",
          name: "cad_apply_commands",
          state: "input-complete",
          type: "tool-call",
        },
      ]),
    ];
    // The exact write/read path the store's resume uses: parts persist
    // verbatim, so the same derivation holds for the revived transcript.
    const revived = original.map((message, index) =>
      rowToMessage(messageToRow(message, "conv-1", index + 1)),
    );

    expect(agentPendingStatusLine({ busy: true, messages: revived })).toBe(
      agentPendingStatusLine({ busy: true, messages: original }),
    );
    expect(
      agentPendingStatusLine({ busy: false, messages: revived }),
    ).toBeNull();
    expect(revived[1]?.parts).toEqual(original[1]?.parts);
  });
});

describe("formatAgentSyncStatus", () => {
  /** The quiet status — nothing may render for it. */
  const quiet: AgentSyncStatus = {
    state: "idle",
    pending: 0,
    failure: null,
  };

  it("renders nothing for the true quiet state", () => {
    expect(formatAgentSyncStatus(quiet)).toBeNull();
  });

  it("renders the syncing line, with its remaining op count", () => {
    expect(formatAgentSyncStatus({ ...quiet, state: "syncing" })).toBe(
      "Syncing conversation…",
    );
    expect(
      formatAgentSyncStatus({ ...quiet, state: "syncing", pending: 3 }),
    ).toBe("Syncing conversation (3 ops left)…");
  });

  it("renders queued work while idle", () => {
    expect(formatAgentSyncStatus({ ...quiet, pending: 2 })).toBe(
      "2 change(s) waiting to sync.",
    );
  });

  it("surfaces a failure's stalled op and error, never silently", () => {
    const failed: AgentSyncStatus = {
      state: "failed",
      pending: 1,
      failure: {
        conversationId: "conv-1",
        error: new Error("network unreachable"),
        kind: "append-message",
        messageId: "m-9",
      },
    };
    const line = formatAgentSyncStatus(failed);
    expect(line).toContain("message append");
    expect(line).toContain("network unreachable");
    expect(line).toContain("1 op(s) still queued");
  });

  it("names the other op kinds in their failure lines", () => {
    const base = {
      state: "failed" as const,
      pending: 0,
      failure: {
        conversationId: "conv-1",
        error: "boom",
        messageId: null,
      },
    };
    expect(
      formatAgentSyncStatus({
        ...base,
        failure: { ...base.failure, kind: "create-conversation" },
      }),
    ).toContain("conversation create");
    expect(
      formatAgentSyncStatus({
        ...base,
        failure: { ...base.failure, kind: "delete-conversation" },
      }),
    ).toContain("conversation delete");
    expect(
      formatAgentSyncStatus({
        ...base,
        failure: { ...base.failure, kind: "unexpected" },
      }),
    ).toContain("Sync failed at sync");
  });
});
