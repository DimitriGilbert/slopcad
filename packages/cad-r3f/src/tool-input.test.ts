/**
 * Unit tests for the R3F tool-input normalizer: CadPick → pointer tool
 * event mapping (world point, reference, provenance), the empty-space
 * case, modifier capture from DOM-shaped flags, and keyboard events.
 */

import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createFeatureId,
  toolModifiers,
} from "@slopcad/cad-core";
import type { CadPick } from "./picking";

import {
  serializeToolInputEvent,
  toolKeyEvent,
  toolModifiersFromNative,
  toolPointerEvent,
} from "./tool-input";

const BODY = createBodyId("body_plate");
const FEATURE = createFeatureId("feat_pad");

const BODY_PICK: CadPick = {
  reference: { kind: "body", bodyId: BODY },
  renderObjectId: "rend_plate",
  worldPoint: [1.5, -2.5, 3.5],
};

const FACE_PICK: CadPick = {
  reference: { kind: "face", bodyId: BODY, regeneration: 4, faceIndex: 2 },
  renderObjectId: "rend_plate",
  featureId: FEATURE,
  worldPoint: [0, 0, 10],
};

describe("tool input normalization", () => {
  it("maps a pick to a pointer event with the pick's world point", () => {
    const event = toolPointerEvent(
      "pointer-down",
      BODY_PICK,
      toolModifiers(false, false, false, false),
    );
    expect(event).toEqual({
      type: "pointer-down",
      point: [1.5, -2.5, 3.5],
      pick: {
        reference: { kind: "body", bodyId: BODY },
        renderObjectId: "rend_plate",
      },
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    });
  });

  it("carries the pick's feature provenance when present", () => {
    const event = toolPointerEvent(
      "pointer-up",
      FACE_PICK,
      toolModifiers(true, false, false, false),
    );
    expect(event.point).toEqual([0, 0, 10]);
    expect(event.pick).toEqual({
      reference: { kind: "face", bodyId: BODY, regeneration: 4, faceIndex: 2 },
      renderObjectId: "rend_plate",
      featureId: FEATURE,
    });
    expect(event.modifiers.shift).toBe(true);
  });

  it("normalizes empty-space pointers to null point and null pick", () => {
    const event = toolPointerEvent(
      "pointer-move",
      null,
      toolModifiers(false, true, false, false),
    );
    expect(event).toEqual({
      type: "pointer-move",
      point: null,
      pick: null,
      modifiers: { shift: false, alt: true, ctrl: false, meta: false },
    });
  });

  it("captures the four DOM modifier flags", () => {
    expect(
      toolModifiersFromNative({
        shiftKey: false,
        altKey: false,
        ctrlKey: true,
        metaKey: true,
      }),
    ).toEqual({ shift: false, alt: false, ctrl: true, meta: true });
  });

  it("builds keyboard events and serializes events as plain JSON", () => {
    const event = toolKeyEvent(
      "key-down",
      "Escape",
      toolModifiers(false, false, false, false),
    );
    expect(event).toEqual({
      type: "key-down",
      key: "Escape",
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    });
    expect(JSON.parse(serializeToolInputEvent(event))).toEqual(event);
  });
});
