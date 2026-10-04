// @vitest-environment node
// The mapping is pure JSON work; jsdom adds nothing.

/**
 * The message ↔ row mapping's losslessness contract (PLAN-AGENT-CHAT
 * Phase 3.4): `messageToRow` → `rowToMessage` returns the original message
 * — including `Date` values (revived as Dates, not degraded to strings),
 * message-level optional fields (`name`, `metadata`), the real TanStack AI
 * part shapes (tool-call, tool-result with image content and error-state
 * refusal results, thinking), and UNKNOWN part types verbatim — plus the
 * wire form's envelope-stripping guarantee (what sync pushes to tRPC
 * carries no slopcad-internal date tagging).
 */

import type { UIMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  messageRowPartsToWire,
  messageToRow,
  rowToMessage,
  type AgentMessageRow,
} from "./rows";

/**
 * Builds a `UIMessage` from raw parts. The parts array is cast ONCE here,
 * deliberately: the forward-compatibility scenario under test is "a newer
 * `@tanstack/ai` emits parts this repo's types do not know" — such parts
 * are, by definition, not assignable to today's `MessagePart` union, and
 * the mapping must still carry them verbatim.
 */
function message(
  parts: readonly unknown[],
  overrides: Partial<Pick<UIMessage, "id" | "role" | "name" | "metadata">> = {},
): UIMessage {
  return {
    id: overrides.id ?? "msg-1",
    role: overrides.role ?? "assistant",
    parts: [...parts] as UIMessage["parts"],
    createdAt: new Date("2026-10-04T12:00:00.000Z"),
    ...(overrides.name === undefined ? {} : { name: overrides.name }),
    ...(overrides.metadata === undefined
      ? {}
      : { metadata: overrides.metadata }),
  };
}

describe("agent persistence rows mapping", () => {
  it("round-trips a text-only message with its envelope fields", () => {
    const original = message(
      [{ type: "text", content: "Extrude the profile by 12mm." }],
      { id: "m-text", role: "user", name: "didi", metadata: { client: "web" } },
    );
    const row = messageToRow(original, "conv-1", 3);
    expect(row).toMatchObject({
      id: "m-text",
      conversationId: "conv-1",
      seq: 3,
      role: "user",
      name: "didi",
      createdAt: "2026-10-04T12:00:00.000Z",
      syncedAt: null,
    });
    expect(rowToMessage(row)).toEqual(original);
  });

  it("round-trips the real agent-loop part shapes losslessly", () => {
    const original = message([
      { type: "thinking", content: "Plan the extrude.", signature: "sig-1" },
      {
        type: "tool-call",
        id: "call-1",
        name: "cad_apply_commands",
        arguments: '{"commands":[]}',
        input: { commands: [] },
        state: "input-complete",
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        name: "cad_apply_commands",
        content: [
          { type: "text", content: "applied" },
          {
            type: "image",
            source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
          },
        ],
        state: "complete",
        createdAt: new Date("2026-10-04T12:00:01.500Z"),
      },
      {
        type: "tool-result",
        toolCallId: "call-2",
        content: "refused",
        state: "error",
        error: '{"code":"webmcp/invalid-input","message":"bad input"}',
      },
    ]);
    const revived = rowToMessage(messageToRow(original, "conv-1", 1));
    expect(revived).toEqual(original);
    // The part-level Date survived as a Date, not a string.
    expect(
      (revived.parts[2] as { createdAt?: unknown }).createdAt,
    ).toBeInstanceOf(Date);
  });

  it("preserves unknown part types verbatim — nothing is filtered", () => {
    const unknownPart = {
      type: "future-part-from-a-newer-release",
      payload: {
        nested: [1, 2, 3],
        when: new Date("2026-10-04T12:00:02.000Z"),
      },
    };
    const original = message([
      { type: "text", content: "before" },
      unknownPart,
      { type: "text", content: "after" },
    ]);
    const revived = rowToMessage(messageToRow(original, "conv-1", 2));
    expect(revived.parts).toHaveLength(3);
    expect(revived.parts[1]).toEqual(unknownPart);
    expect(revived.parts[0]).toEqual({ type: "text", content: "before" });
    expect(revived.parts[2]).toEqual({ type: "text", content: "after" });
  });

  it("revives Dates inside message metadata and stamps absent createdAt", () => {
    const original = message([{ type: "text", content: "hi" }], {
      metadata: { when: new Date("2026-10-04T11:00:00.000Z"), depth: 2 },
    });
    delete original.createdAt;
    const row = messageToRow(original, "conv-1", 1);
    expect(typeof row.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
    const revived = rowToMessage(row);
    expect(revived.metadata).toEqual({
      when: new Date("2026-10-04T11:00:00.000Z"),
      depth: 2,
    });
  });

  it("strips the private date envelope in the sync wire form", () => {
    const original = message([
      {
        type: "tool-result",
        toolCallId: "call-1",
        content: "done",
        state: "complete",
        createdAt: new Date("2026-10-04T12:00:03.000Z"),
      },
    ]);
    const row = messageToRow(original, "conv-1", 1);
    const wire = messageRowPartsToWire(row);
    expect(wire).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-1",
        content: "done",
        state: "complete",
        createdAt: "2026-10-04T12:00:03.000Z",
      },
    ]);
    // The wire form alone is envelope-free; the ROW keeps the tagged form.
    expect(JSON.stringify(wire)).not.toContain("__slopcadDateIso");
    expect(row.parts).toContain("__slopcadDateIso");
  });

  it("refuses messages without a usable id and corrupt rows alike", () => {
    expect(() =>
      messageToRow(
        message([{ type: "text", content: "x" }], { id: "" }),
        "c",
        1,
      ),
    ).toThrow(RangeError);
    const corrupt: AgentMessageRow = {
      id: "m-corrupt",
      conversationId: "c",
      seq: 1,
      role: "user",
      parts: '"not an array"',
      name: null,
      metadata: null,
      createdAt: "2026-10-04T12:00:00.000Z",
      syncedAt: null,
    };
    expect(() => rowToMessage(corrupt)).toThrow(TypeError);
    expect(() => messageRowPartsToWire(corrupt)).toThrow(TypeError);
  });
});
