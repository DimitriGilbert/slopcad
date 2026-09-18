/**
 * Unit tests for the Phase 13 normalized tool input events: the pointer
 * payload (world point + Phase 12 pick + modifiers), the keyboard payload,
 * the `pick ⇒ point` rule, and the strict parser's stable failure codes.
 */

import { describe, expect, it } from "vitest";

import { createBodyId } from "./ids";
import {
  NO_TOOL_MODIFIERS,
  parseToolInputEvent,
  TOOL_EVENT_ERROR_CODES,
  TOOL_EVENT_TYPES,
  toolModifiers,
} from "./tool-events";

const BODY = createBodyId("body_plate");

function faceRef(
  regeneration: number,
  faceIndex: number,
): {
  readonly kind: "face";
  readonly bodyId: typeof BODY;
  readonly regeneration: number;
  readonly faceIndex: number;
} {
  return { kind: "face", bodyId: BODY, regeneration, faceIndex };
}

function pointerDown(): Record<string, unknown> {
  return {
    type: "pointer-down",
    point: [1, 2, 3],
    pick: {
      reference: { kind: "body", bodyId: BODY },
      renderObjectId: "rend_plate",
    },
    modifiers: { shift: true, alt: false, ctrl: false, meta: false },
  };
}

describe("tool events", () => {
  it("declares exactly the five normalized event types", () => {
    expect(TOOL_EVENT_TYPES).toEqual([
      "pointer-down",
      "pointer-move",
      "pointer-up",
      "key-down",
      "key-up",
    ]);
  });

  it("parses a pointer event with a pick, point, and modifiers", () => {
    const parsed = parseToolInputEvent(pointerDown());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      type: "pointer-down",
      point: [1, 2, 3],
      pick: {
        reference: { kind: "body", bodyId: BODY },
        renderObjectId: "rend_plate",
      },
      modifiers: toolModifiers(true, false, false, false),
    });
  });

  it("parses a pointer event over empty space (null point, null pick)", () => {
    const parsed = parseToolInputEvent({
      type: "pointer-move",
      point: null,
      pick: null,
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      type: "pointer-move",
      point: null,
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
  });

  it("parses a keyboard event", () => {
    const parsed = parseToolInputEvent({
      type: "key-down",
      key: "Escape",
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      type: "key-down",
      key: "Escape",
      modifiers: NO_TOOL_MODIFIERS,
    });
  });

  it("rejects unknown event types", () => {
    const parsed = parseToolInputEvent({
      type: "scroll",
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(TOOL_EVENT_ERROR_CODES.typeUnknown);
  });

  it("enforces the pick ⇒ point rule", () => {
    const parsed = parseToolInputEvent({
      type: "pointer-up",
      point: null,
      pick: {
        reference: { kind: "body", bodyId: BODY },
        renderObjectId: "rend_plate",
      },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(TOOL_EVENT_ERROR_CODES.pickWithoutPoint);
  });

  it("validates the pick's selection reference through the domain parser", () => {
    const parsed = parseToolInputEvent({
      type: "pointer-up",
      point: [0, 0, 0],
      pick: {
        reference: { kind: "body", bodyId: "not-a-body-id" },
        renderObjectId: "rend_plate",
      },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(TOOL_EVENT_ERROR_CODES.referenceInvalid);
  });

  it("rejects non-boolean modifiers, non-finite points, and empty keys", () => {
    const badModifiers = parseToolInputEvent({
      type: "key-up",
      key: "a",
      modifiers: { shift: "yes", alt: false, ctrl: false, meta: false },
    });
    expect(badModifiers.ok).toBe(false);
    if (!badModifiers.ok) {
      expect(badModifiers.error.code).toBe(TOOL_EVENT_ERROR_CODES.malformed);
    }
    const badPoint = parseToolInputEvent({
      type: "pointer-move",
      point: [0, Number.NaN, 0],
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(badPoint.ok).toBe(false);
    const badKey = parseToolInputEvent({
      type: "key-down",
      key: "",
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(badKey.ok).toBe(false);
  });

  it("ignores unknown fields for forward compatibility", () => {
    const parsed = parseToolInputEvent({
      ...pointerDown(),
      futureField: { nested: true },
    });
    expect(parsed.ok).toBe(true);
  });

  it("synthetic face references round-trip through the pick payload", () => {
    const face = faceRef(3, 2);
    const parsed = parseToolInputEvent({
      type: "pointer-up",
      point: [4, 5, 6],
      pick: { reference: face, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.value.type !== "pointer-up") throw new Error("wrong event");
    expect(parsed.value.pick?.reference).toEqual(face);
  });
});
