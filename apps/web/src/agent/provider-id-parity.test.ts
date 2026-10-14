// @vitest-environment node

/**
 * The registry-cut parity tripwires (PLAN-AGENT-CHAT Phase 5): the chat
 * surface's registry copy in `@slopcad/ui` re-declares two contracts the
 * app also owns — this app-side test fails the build the moment either
 * pair drifts apart:
 *
 * - the provider-id universe: the registry item's `AGENT_PROVIDER_IDS`
 *   must stay exactly `@slopcad/api/providers`' `PROVIDER_IDS` (D6's one
 *   list; the registry copy exists only because registry files may not
 *   import workspace packages);
 * - the persistence row round trip: the shipped status-line derivation
 *   must hold identically over the app store's write/read path (parts are
 *   the history), the coverage that moved out of the shipped test tree
 *   with `persistence/rows`.
 */

import { PROVIDER_IDS } from "@slopcad/api/providers";
import { AGENT_PROVIDER_IDS } from "@slopcad/ui/agent/providers";
import { agentPendingStatusLine } from "@slopcad/ui/agent/chat/status-lines";
import type { AgentChatMessage } from "@slopcad/ui/agent/chat/parts/part-types";
import { describe, expect, it } from "vitest";

import { messageToRow, rowToMessage } from "./persistence/rows";

describe("AGENT_PROVIDER_IDS (the registry copy)", () => {
  it("stays exactly @slopcad/api/providers' PROVIDER_IDS", () => {
    expect([...AGENT_PROVIDER_IDS]).toEqual([...PROVIDER_IDS]);
  });
});

describe("the shipped status-line derivation over the app row round trip", () => {
  it("derives identically after the persistence round-trip (parts are the history)", () => {
    const original: readonly AgentChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", content: "extrude the base" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", content: "Applying." },
          {
            arguments: "{}",
            id: "call-1",
            name: "cad_apply_commands",
            state: "input-complete",
            type: "tool-call",
          },
        ],
      },
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
