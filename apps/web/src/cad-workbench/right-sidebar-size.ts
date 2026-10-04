/**
 * The right sidebar's user-resizable width (PLAN-AGENT-CHAT Phase 4.5,
 * D16): the pure logic behind the drag/keyboard resize — clamping, the
 * keyboard steps of the separator a11y pattern, and the per-browser
 * persistence that follows the workbench's sibling panel-state idiom
 * (the first-run sketch hint + the agent chat view state): a namespaced
 * localStorage key, reads that tolerate stripped or corrupt storage, and
 * a React hook that applies the stored width only AFTER hydration in an
 * effect — the first render never depends on storage, so server and
 * client markup agree.
 *
 * Searched before building: the repo carries no reusable resizer or
 * panel-resize pattern (only CSS textarea resize and the presentational
 * `packages/ui` separator), so the width semantics live here and the
 * handle chrome beside the dock.
 */

import { useCallback, useEffect, useState } from "react";

/** The dock's floor: narrower than this and the property rows wrap. */
export const RIGHT_SIDEBAR_MIN_WIDTH = 200;
/** The dock's ceiling: wider than this and the viewport starves. */
export const RIGHT_SIDEBAR_MAX_WIDTH = 560;
/** The width before the user ever drags (the old hardcoded dock width). */
export const DEFAULT_RIGHT_SIDEBAR_WIDTH = 272;
/** One keyboard press grows/shrinks the dock by this many pixels. */
export const RIGHT_SIDEBAR_KEYBOARD_STEP = 16;

/** The namespaced localStorage key the width persists under. */
export const RIGHT_SIDEBAR_WIDTH_STORAGE_KEY =
  "slopcad.workbench.right-sidebar-width.v1";

/** The minimal storage surface the width needs (localStorage-shaped). */
export interface RightSidebarWidthStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

/** Clamps a width into `[min, max]`, rounding to whole pixels. */
export function clampRightSidebarWidth(width: number): number {
  return Math.min(
    RIGHT_SIDEBAR_MAX_WIDTH,
    Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

/** The keys the keyboard side of the separator pattern answers. */
export type RightSidebarResizeKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** True for exactly the keys {@link keyboardResizeRightSidebar} handles. */
export function isRightSidebarResizeKey(
  key: string,
): key is RightSidebarResizeKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "Home" ||
    key === "End"
  );
}

/**
 * The keyboard step: the dock is right-anchored, so ArrowLeft DRAGS the
 * edge left and widens (the drag metaphor, per the separator pattern),
 * ArrowRight narrows, and Home/End jump to the clamped extremes.
 */
export function keyboardResizeRightSidebar(
  width: number,
  key: RightSidebarResizeKey,
): number {
  switch (key) {
    case "ArrowLeft":
      return clampRightSidebarWidth(width + RIGHT_SIDEBAR_KEYBOARD_STEP);
    case "ArrowRight":
      return clampRightSidebarWidth(width - RIGHT_SIDEBAR_KEYBOARD_STEP);
    case "Home":
      return RIGHT_SIDEBAR_MIN_WIDTH;
    case "End":
      return RIGHT_SIDEBAR_MAX_WIDTH;
  }
}

/** Reads the persisted width, tolerating stripped or corrupt storage. */
export function readRightSidebarWidth(
  storage: RightSidebarWidthStorage,
): number {
  let raw: string | null = null;
  try {
    raw = storage.getItem(RIGHT_SIDEBAR_WIDTH_STORAGE_KEY);
  } catch {
    return DEFAULT_RIGHT_SIDEBAR_WIDTH;
  }
  if (raw === null) {
    return DEFAULT_RIGHT_SIDEBAR_WIDTH;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RIGHT_SIDEBAR_WIDTH;
  }
  return clampRightSidebarWidth(parsed);
}

/** Persists the width, tolerating stripped storage (session-only then). */
export function persistRightSidebarWidth(
  storage: RightSidebarWidthStorage,
  width: number,
): void {
  try {
    storage.setItem(RIGHT_SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // A stripped context cannot persist; the in-memory width still holds.
  }
}

/**
 * The browser backend binding: `globalThis.localStorage` when it exists,
 * `null` otherwise (SSR, node). Same seam shape as the agent view state's.
 */
export function getBrowserRightSidebarStorage(): RightSidebarWidthStorage | null {
  if (typeof globalThis.localStorage === "undefined") {
    return null;
  }
  return globalThis.localStorage;
}

/** The hook's public surface: the live width plus its clamping setter. */
export interface UseRightSidebarWidthReturn {
  readonly width: number;
  readonly setWidth: (width: number) => void;
}

/**
 * The reactive width: starts at the default on both server and client
 * (hydration-safe), applies the stored width in an effect, and persists
 * every set immediately. Every value that leaves here is clamped.
 */
export function useRightSidebarWidth(): UseRightSidebarWidthReturn {
  const [width, setWidthState] = useState(DEFAULT_RIGHT_SIDEBAR_WIDTH);

  // The stored width applies after hydration, never at render time.
  useEffect(() => {
    const storage = getBrowserRightSidebarStorage();
    if (storage === null) {
      return;
    }
    setWidthState(readRightSidebarWidth(storage));
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampRightSidebarWidth(next);
    setWidthState(clamped);
    const storage = getBrowserRightSidebarStorage();
    if (storage !== null) {
      persistRightSidebarWidth(storage, clamped);
    }
  }, []);

  return { setWidth, width };
}
