/**
 * The cockpit rails' own state (LAYOUT.md G6): whether each rail is
 * COLLAPSED to the icon width, and which of its sections are disclosed.
 *
 * ## Why this exists
 *
 * `--rail-w-icon: 2.75rem` has been declared in `cockpit.css` since the
 * density pass with no consumer that is a rail. The docks instead had a
 * width-conditional drawer: below `xl` they were absolutely positioned,
 * `invisible`, translated off-canvas, and reachable only through two
 * `xl:hidden` toggles in the tool strip; above `xl` they were inline and
 * the toggles vanished. That is a control appearing and disappearing by
 * viewport width, which LAYOUT.md's zone invariant 4 forbids.
 *
 * The replacement is one honest state. A rail is EXPANDED (`--rail-w`,
 * or the inspector's persisted drag width) or COLLAPSED (`--rail-w-icon`,
 * an icon rail that still shows its own controls and its own expand
 * toggle). It is always in the flex flow, at every width; nothing is ever
 * `invisible`, nothing is translated off-canvas, and the toggle is a
 * permanent control that reports `aria-expanded`.
 *
 * ## The one width-aware decision, made honestly
 *
 * Width still matters: two 240px rails on a 768px frame leave no bed. So
 * width picks the DEFAULT of the collapse state — once, at mount, only
 * for a user who has never chosen — and never the existence of a control.
 * {@link defaultRailCollapsedForWidth} is that rule, pinned at the same
 * 1280px the old `xl:` drawer used, so a 1280-wide session sees exactly
 * the layout it saw before. A stored preference always wins over it.
 *
 * ## Persistence
 *
 * The sibling idiom of `right-sidebar-size.ts` and the agent view state:
 * one namespaced key, reads that tolerate stripped or corrupt storage,
 * and a hook that applies storage only AFTER hydration — the first render
 * never depends on storage, so server and client markup agree.
 */

import { useCallback, useEffect, useState } from "react";

/** The two rails the cockpit docks. */
export type WorkbenchRailId = "model" | "inspector";

/** Every rail id, for exhaustive iteration. */
export const WORKBENCH_RAIL_IDS: readonly WorkbenchRailId[] = [
  "model",
  "inspector",
];

/**
 * The disclosure sections the two rails stack, as stable ids. These are
 * the persistence keys, so they are named for the CONCERN, not for the
 * component that happens to render it today.
 */
export type WorkbenchRailSectionId =
  | "model-sketches"
  | "model-datums"
  | "model-features"
  | "inspector-selection"
  | "inspector-measurement"
  | "inspector-parameters"
  | "inspector-configurations";

/** Every section id, for exhaustive iteration and the parse's allow-list. */
export const WORKBENCH_RAIL_SECTION_IDS: readonly WorkbenchRailSectionId[] = [
  "model-sketches",
  "model-datums",
  "model-features",
  "inspector-selection",
  "inspector-measurement",
  "inspector-parameters",
  "inspector-configurations",
];

/** The persisted shape: collapse per rail, disclosure per section. */
export interface WorkbenchRailState {
  readonly collapsed: Readonly<Record<WorkbenchRailId, boolean>>;
  readonly sections: Readonly<Record<WorkbenchRailSectionId, boolean>>;
}

/**
 * The boot state before any storage or any width is consulted: both rails
 * expanded, every section disclosed. It is also the SSR state, which is
 * why it cannot depend on either input.
 */
export const DEFAULT_RAIL_STATE: WorkbenchRailState = {
  collapsed: { inspector: false, model: false },
  sections: {
    "inspector-configurations": true,
    "inspector-measurement": true,
    "inspector-parameters": true,
    "inspector-selection": true,
    "model-datums": true,
    "model-features": true,
    "model-sketches": true,
  },
};

/** The namespaced localStorage key the rail state persists under. */
export const RAIL_STATE_STORAGE_KEY = "slopcad.workbench.rails.v1";

/**
 * The width at or above which both rails default to expanded. The same
 * 1280px the retired `xl:` drawer breakpoint used, so no existing session
 * width changes what it sees on first boot.
 */
export const RAIL_EXPAND_MIN_WIDTH = 1280;

/**
 * The default collapse state for a frame of this width, for a user who
 * has stored no preference. Width chooses a DEFAULT here and nothing
 * else: the toggle exists at every width either way.
 */
export function defaultRailCollapsedForWidth(width: number): boolean {
  return width < RAIL_EXPAND_MIN_WIDTH;
}

/** The minimal storage surface the rail state needs (localStorage-shaped). */
export interface WorkbenchRailStateStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

function isRailSectionId(value: string): value is WorkbenchRailSectionId {
  return (WORKBENCH_RAIL_SECTION_IDS as readonly string[]).includes(value);
}

function isRailId(value: string): value is WorkbenchRailId {
  return (WORKBENCH_RAIL_IDS as readonly string[]).includes(value);
}

function booleanRecord(value: unknown): Readonly<Record<string, boolean>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
  );
  return Object.fromEntries(entries);
}

/**
 * Parses a stored payload into a complete state, tolerating anything:
 * a missing key, invalid JSON, a wrong shape, an unknown rail or section
 * id, a non-boolean value. Every field the payload does not legitimately
 * supply falls back to {@link DEFAULT_RAIL_STATE} — a corrupt store
 * degrades to the default layout, it never throws at a user.
 */
export function parseRailState(raw: string | null): WorkbenchRailState {
  if (raw === null) return DEFAULT_RAIL_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_RAIL_STATE;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_RAIL_STATE;
  }
  const record: Record<string, unknown> = { ...parsed };
  const storedCollapsed = booleanRecord(record.collapsed);
  const storedSections = booleanRecord(record.sections);

  const collapsed = { ...DEFAULT_RAIL_STATE.collapsed };
  for (const [key, value] of Object.entries(storedCollapsed)) {
    if (isRailId(key)) collapsed[key] = value;
  }
  const sections = { ...DEFAULT_RAIL_STATE.sections };
  for (const [key, value] of Object.entries(storedSections)) {
    if (isRailSectionId(key)) sections[key] = value;
  }
  return { collapsed, sections };
}

/** The payload {@link parseRailState} reads back, round-trip stable. */
export function serializeRailState(state: WorkbenchRailState): string {
  return JSON.stringify({
    collapsed: state.collapsed,
    sections: state.sections,
  });
}

/** A new state with one rail's collapse flipped. */
export function toggleRailCollapsed(
  state: WorkbenchRailState,
  rail: WorkbenchRailId,
): WorkbenchRailState {
  return {
    collapsed: { ...state.collapsed, [rail]: !state.collapsed[rail] },
    sections: state.sections,
  };
}

/** A new state with one section's disclosure set. */
export function setRailSectionOpen(
  state: WorkbenchRailState,
  section: WorkbenchRailSectionId,
  open: boolean,
): WorkbenchRailState {
  return {
    collapsed: state.collapsed,
    sections: { ...state.sections, [section]: open },
  };
}

/** Both rails' collapse set at once — the width default's application. */
export function setAllRailsCollapsed(
  state: WorkbenchRailState,
  collapsed: boolean,
): WorkbenchRailState {
  return {
    collapsed: { inspector: collapsed, model: collapsed },
    sections: state.sections,
  };
}

/** Reads the persisted state, tolerating stripped or corrupt storage. */
export function readRailState(
  storage: WorkbenchRailStateStorage,
): WorkbenchRailState | null {
  try {
    const raw = storage.getItem(RAIL_STATE_STORAGE_KEY);
    return raw === null ? null : parseRailState(raw);
  } catch {
    return null;
  }
}

/** Persists the state, tolerating stripped storage (session-only then). */
export function persistRailState(
  storage: WorkbenchRailStateStorage,
  state: WorkbenchRailState,
): void {
  try {
    storage.setItem(RAIL_STATE_STORAGE_KEY, serializeRailState(state));
  } catch {
    // A stripped context cannot persist; the in-memory state still holds.
  }
}

/**
 * The browser backend binding: `globalThis.localStorage` when it exists,
 * `null` otherwise (SSR, node). The sibling width hook's seam shape.
 */
export function getBrowserRailStateStorage(): WorkbenchRailStateStorage | null {
  if (typeof globalThis.localStorage === "undefined") return null;
  return globalThis.localStorage;
}

/** The hook's public surface. */
export interface UseWorkbenchRailStateReturn {
  /** Whether a rail is collapsed to the icon width. */
  readonly isCollapsed: (rail: WorkbenchRailId) => boolean;
  /** Flips one rail's collapse and persists it. */
  readonly toggleCollapsed: (rail: WorkbenchRailId) => void;
  /** Whether a section is disclosed. */
  readonly isSectionOpen: (section: WorkbenchRailSectionId) => boolean;
  /** Sets one section's disclosure and persists it. */
  readonly setSectionOpen: (
    section: WorkbenchRailSectionId,
    open: boolean,
  ) => void;
}

/**
 * The reactive rail state: the default on both server and client
 * (hydration-safe), then — in one post-hydration effect — the stored
 * state if there is one, or the width default if there is not. Every
 * later change persists immediately.
 */
export function useWorkbenchRailState(): UseWorkbenchRailStateReturn {
  const [state, setState] = useState<WorkbenchRailState>(DEFAULT_RAIL_STATE);

  useEffect(() => {
    const storage = getBrowserRailStateStorage();
    const stored = storage === null ? null : readRailState(storage);
    if (stored !== null) {
      setState(stored);
      return;
    }
    // No stored preference: the frame's own width picks the default.
    const narrow = defaultRailCollapsedForWidth(globalThis.innerWidth);
    if (narrow) {
      setState((current) => setAllRailsCollapsed(current, true));
    }
  }, []);

  // Every write goes through one reducer-shaped commit, so a toggle can
  // never race the post-hydration load: the updater sees the live state.
  const commit = useCallback(
    (reduce: (current: WorkbenchRailState) => WorkbenchRailState) => {
      setState((current) => {
        const next = reduce(current);
        const storage = getBrowserRailStateStorage();
        if (storage !== null) persistRailState(storage, next);
        return next;
      });
    },
    [],
  );

  const toggleCollapsed = useCallback(
    (rail: WorkbenchRailId) => {
      commit((current) => toggleRailCollapsed(current, rail));
    },
    [commit],
  );

  const setSectionOpen = useCallback(
    (section: WorkbenchRailSectionId, open: boolean) => {
      commit((current) => setRailSectionOpen(current, section, open));
    },
    [commit],
  );

  const isCollapsed = useCallback(
    (rail: WorkbenchRailId) => state.collapsed[rail],
    [state],
  );
  const isSectionOpen = useCallback(
    (section: WorkbenchRailSectionId) => state.sections[section],
    [state],
  );

  return { isCollapsed, isSectionOpen, setSectionOpen, toggleCollapsed };
}
