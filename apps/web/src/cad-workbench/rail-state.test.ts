// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RAIL_STATE,
  RAIL_EXPAND_MIN_WIDTH,
  RAIL_STATE_STORAGE_KEY,
  WORKBENCH_RAIL_SECTION_IDS,
  defaultRailCollapsedForWidth,
  parseRailState,
  persistRailState,
  readRailState,
  serializeRailState,
  setAllRailsCollapsed,
  setRailSectionOpen,
  toggleRailCollapsed,
  type WorkbenchRailStateStorage,
} from "./rail-state";

/** A localStorage-shaped double; `fail` makes every access throw. */
function createStorage(
  seed: Readonly<Record<string, string>> = {},
  fail = false,
): WorkbenchRailStateStorage & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(seed));
  return {
    items,
    getItem(name) {
      if (fail) throw new Error("storage is unavailable");
      return items.get(name) ?? null;
    },
    setItem(name, value) {
      if (fail) throw new Error("storage is unavailable");
      items.set(name, value);
    },
  };
}

describe("the rail default (width picks a default, never a control)", () => {
  it("expands at and above the frame width two rails fit", () => {
    expect(defaultRailCollapsedForWidth(RAIL_EXPAND_MIN_WIDTH)).toBe(false);
    expect(defaultRailCollapsedForWidth(1920)).toBe(false);
  });

  it("collapses below it, where two 240px rails would starve the bed", () => {
    expect(defaultRailCollapsedForWidth(RAIL_EXPAND_MIN_WIDTH - 1)).toBe(true);
    expect(defaultRailCollapsedForWidth(768)).toBe(true);
  });

  it("keeps the retired drawer breakpoint, so 1280 sees what it saw", () => {
    expect(RAIL_EXPAND_MIN_WIDTH).toBe(1280);
  });
});

describe("the rail state's defaults", () => {
  it("boots both rails expanded with every section disclosed", () => {
    expect(DEFAULT_RAIL_STATE.collapsed).toEqual({
      inspector: false,
      model: false,
    });
    for (const section of WORKBENCH_RAIL_SECTION_IDS) {
      expect(DEFAULT_RAIL_STATE.sections[section]).toBe(true);
    }
  });
});

describe("the rail state's transitions (pure)", () => {
  it("flips one rail and leaves the other alone", () => {
    const next = toggleRailCollapsed(DEFAULT_RAIL_STATE, "model");
    expect(next.collapsed).toEqual({ inspector: false, model: true });
    expect(toggleRailCollapsed(next, "model").collapsed.model).toBe(false);
  });

  it("sets one section and leaves the rest alone", () => {
    const next = setRailSectionOpen(
      DEFAULT_RAIL_STATE,
      "inspector-configurations",
      false,
    );
    expect(next.sections["inspector-configurations"]).toBe(false);
    expect(next.sections["inspector-parameters"]).toBe(true);
  });

  it("applies one collapse to both rails", () => {
    expect(setAllRailsCollapsed(DEFAULT_RAIL_STATE, true).collapsed).toEqual({
      inspector: true,
      model: true,
    });
  });

  it("never mutates the state it was handed", () => {
    const before = serializeRailState(DEFAULT_RAIL_STATE);
    toggleRailCollapsed(DEFAULT_RAIL_STATE, "inspector");
    setRailSectionOpen(DEFAULT_RAIL_STATE, "model-features", false);
    expect(serializeRailState(DEFAULT_RAIL_STATE)).toBe(before);
  });
});

describe("the rail state's persistence", () => {
  it("round-trips through serialize/parse", () => {
    const state = setRailSectionOpen(
      toggleRailCollapsed(DEFAULT_RAIL_STATE, "inspector"),
      "model-datums",
      false,
    );
    expect(parseRailState(serializeRailState(state))).toEqual(state);
  });

  it("falls back to the default for a missing key", () => {
    expect(parseRailState(null)).toEqual(DEFAULT_RAIL_STATE);
    expect(readRailState(createStorage())).toBeNull();
  });

  it("falls back to the default for every corrupt payload", () => {
    for (const raw of ["", "{", "null", "[]", '"collapsed"', "42"]) {
      expect(parseRailState(raw)).toEqual(DEFAULT_RAIL_STATE);
    }
  });

  it("ignores unknown ids and non-boolean values, keeping the rest", () => {
    const parsed = parseRailState(
      JSON.stringify({
        collapsed: { bogus: true, inspector: "yes", model: true },
        sections: { "model-features": false, "not-a-section": false },
      }),
    );
    expect(parsed.collapsed).toEqual({ inspector: false, model: true });
    expect(parsed.sections["model-features"]).toBe(false);
    expect(parsed.sections["inspector-selection"]).toBe(true);
    expect(Object.keys(parsed.sections).sort()).toEqual(
      [...WORKBENCH_RAIL_SECTION_IDS].sort(),
    );
  });

  it("writes under the namespaced key and reads itself back", () => {
    const storage = createStorage();
    const state = toggleRailCollapsed(DEFAULT_RAIL_STATE, "model");
    persistRailState(storage, state);
    expect(storage.items.has(RAIL_STATE_STORAGE_KEY)).toBe(true);
    expect(readRailState(storage)).toEqual(state);
  });

  it("survives a stripped storage on both reads and writes", () => {
    const storage = createStorage({}, true);
    expect(readRailState(storage)).toBeNull();
    expect(() => {
      persistRailState(storage, DEFAULT_RAIL_STATE);
    }).not.toThrow();
  });
});
