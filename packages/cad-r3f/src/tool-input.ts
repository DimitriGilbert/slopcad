/**
 * Tool-input normalization (Phase 13): the R3F adapter's pure bridge from
 * renderer picks and DOM modifier flags to the cad-core normalized tool
 * events. The scene reports {@link CadPick}s (domain references — never raw
 * triangle indices); this module wraps them into the serializable
 * `ToolInputEvent` data the tool manager dispatches, mapping the pick's
 * world point to the event's `point` and preserving the `pick ⇒ point`
 * invariant structurally (a `null` pick yields a `null` point).
 *
 * Keyboard events and modifier flags are captured from the DOM by the host
 * (the fixture's viewport listeners) and enter through
 * {@link toolModifiersFromNative}, so the scene layer stays
 * modifier-free: it reports picks, the adapter enriches them with input
 * context.
 */

import {
  type ToolInputEvent,
  type ToolKeyboardEvent,
  type ToolModifiers,
  type ToolPointerEvent,
  type ToolPointerEventType,
  toolModifiers,
} from "@slopcad/cad-core";
import type { CadPick } from "./picking";

/**
 * Builds the modifiers record from the DOM/React pointer-event flag shape
 * (the four boolean properties every DOM pointer and keyboard event
 * carries).
 */
export function toolModifiersFromNative(native: {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): ToolModifiers {
  return toolModifiers(native.shiftKey, native.altKey, native.ctrlKey, native.metaKey);
}

/**
 * Normalizes a renderer pick (or its absence) into a pointer tool event.
 * The pick's world point becomes the event's point; a `null` pick becomes
 * the empty-space event (`point: null`, `pick: null`).
 */
export function toolPointerEvent(
  type: ToolPointerEventType,
  pick: CadPick | null,
  modifiers: ToolModifiers,
): ToolPointerEvent {
  if (pick === null) {
    return { type, point: null, pick: null, modifiers };
  }
  return {
    type,
    point: pick.worldPoint,
    pick: {
      reference: pick.reference,
      renderObjectId: pick.renderObjectId,
      ...(pick.featureId !== undefined ? { featureId: pick.featureId } : {}),
    },
    modifiers,
  };
}

/** Normalizes a keyboard activity into a keyboard tool event. */
export function toolKeyEvent(
  type: "key-down" | "key-up",
  key: string,
  modifiers: ToolModifiers,
): ToolKeyboardEvent {
  return { type, key, modifiers };
}

/**
 * Narrows a parsed event to its serialized JSON form (events are plain data
 * by construction — see `tool-events.ts`); exported for hosts that publish
 * event surfaces. Identity, not transformation.
 */
export function serializeToolInputEvent(event: ToolInputEvent): string {
  return JSON.stringify(event);
}
