/**
 * `useCadSelection` (Phase 14): the selection hook. Mirrors the Phase 12
 * selection state through the `selection` concern and exposes its
 * operations — pick (single/multi), hover, clear, regeneration advance —
 * exactly the domain model's own operations, applied as serializable
 * operation data through the store. There is no React-side selection state:
 * the returned state is the immutable domain value, and a structured
 * failure (e.g. a stale synthetic reference) leaves it untouched.
 *
 * Notification model: re-renders exactly when the selection state identity
 * changes — never on document commits, parameter edits, or tool lifecycle
 * changes. (Tool-ISSUED selection ops notify too: the store diffs the
 * runtime after every operation, whoever initiated it.)
 */

import { useSyncExternalStore } from "react";
import type {
  ParseResult,
  SelectionError,
  SelectionReference,
  SelectionState,
} from "@slopcad/cad-core";

import { useCadStore } from "./provider";

/** What {@link useCadSelection} exposes. */
export interface CadSelectionApi {
  /** The current selection state (immutable domain value). */
  readonly selection: SelectionState;
  /** The selected references, insertion order. */
  readonly selected: readonly SelectionReference[];
  /** The hovered reference, or `null`. */
  readonly hover: SelectionReference | null;
  /** The regeneration the state's synthetic references belong to. */
  readonly regeneration: number;
  /** Picks a reference: single mode replaces, multi mode toggles. */
  readonly pick: (
    reference: SelectionReference,
    additive: boolean,
  ) => ParseResult<SelectionState, SelectionError>;
  /** Sets the hover (pointer feedback; never touches the selection). */
  readonly hoverReference: (
    reference: SelectionReference | null,
  ) => ParseResult<SelectionState, SelectionError>;
  /** Clears the selection; the hover is left untouched. */
  readonly clear: () => SelectionState;
  /**
   * Advances the regeneration identity — synthetic references die with the
   * old regeneration, stable ones persist (the Phase 12 transience rule).
   */
  readonly beginRegeneration: (
    regeneration: number,
  ) => ParseResult<SelectionState, SelectionError>;
}

/** Subscribes to the `selection` concern and mirrors the state. */
export function useCadSelection(): CadSelectionApi {
  const store = useCadStore("useCadSelection");
  const selection = useSyncExternalStore(
    store.subscribeSelection,
    store.getSelection,
    // Server snapshot: the same getter — the store runs headless (see
    // use-cad-document.ts).
    store.getSelection,
  );
  return {
    selection,
    selected: selection.selected,
    hover: selection.hover,
    regeneration: selection.regeneration,
    pick: store.pick,
    hoverReference: store.hover,
    clear: store.clearSelection,
    beginRegeneration: store.beginSelectionRegeneration,
  };
}
