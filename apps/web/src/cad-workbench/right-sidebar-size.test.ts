// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  clampRightSidebarWidth,
  DEFAULT_RIGHT_SIDEBAR_WIDTH,
  isRightSidebarResizeKey,
  keyboardResizeRightSidebar,
  persistRightSidebarWidth,
  readRightSidebarWidth,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  RIGHT_SIDEBAR_KEYBOARD_STEP,
} from "./right-sidebar-size";

/** An in-memory localStorage double (the view-state tests' shape). */
function memoryStorage(initial = new Map<string, string>()): Storage {
  return {
    getItem: (name: string) => initial.get(name) ?? null,
    setItem: (name: string, value: string) => {
      initial.set(name, value);
    },
    removeItem: (name: string) => {
      initial.delete(name);
    },
  } as Storage;
}

describe("clampRightSidebarWidth", () => {
  it("keeps in-range widths, rounded to whole pixels", () => {
    expect(clampRightSidebarWidth(300)).toBe(300);
    expect(clampRightSidebarWidth(272.4)).toBe(272);
  });

  it("clamps below the minimum", () => {
    expect(clampRightSidebarWidth(RIGHT_SIDEBAR_MIN_WIDTH - 1)).toBe(
      RIGHT_SIDEBAR_MIN_WIDTH,
    );
    expect(clampRightSidebarWidth(0)).toBe(RIGHT_SIDEBAR_MIN_WIDTH);
  });

  it("clamps above the maximum", () => {
    expect(clampRightSidebarWidth(RIGHT_SIDEBAR_MAX_WIDTH + 1)).toBe(
      RIGHT_SIDEBAR_MAX_WIDTH,
    );
    expect(clampRightSidebarWidth(Number.MAX_SAFE_INTEGER)).toBe(
      RIGHT_SIDEBAR_MAX_WIDTH,
    );
  });
});

describe("keyboardResizeRightSidebar", () => {
  it("ArrowLeft widens the right-anchored dock by one step", () => {
    expect(keyboardResizeRightSidebar(272, "ArrowLeft")).toBe(
      272 + RIGHT_SIDEBAR_KEYBOARD_STEP,
    );
  });

  it("ArrowRight narrows the dock by one step", () => {
    expect(keyboardResizeRightSidebar(272, "ArrowRight")).toBe(
      272 - RIGHT_SIDEBAR_KEYBOARD_STEP,
    );
  });

  it("steps clamp at both extremes", () => {
    expect(
      keyboardResizeRightSidebar(RIGHT_SIDEBAR_MAX_WIDTH, "ArrowLeft"),
    ).toBe(RIGHT_SIDEBAR_MAX_WIDTH);
    expect(
      keyboardResizeRightSidebar(RIGHT_SIDEBAR_MIN_WIDTH, "ArrowRight"),
    ).toBe(RIGHT_SIDEBAR_MIN_WIDTH);
  });

  it("Home and End jump to the clamped extremes", () => {
    expect(keyboardResizeRightSidebar(400, "Home")).toBe(
      RIGHT_SIDEBAR_MIN_WIDTH,
    );
    expect(keyboardResizeRightSidebar(400, "End")).toBe(
      RIGHT_SIDEBAR_MAX_WIDTH,
    );
  });

  it("isRightSidebarResizeKey accepts exactly the four handled keys", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(isRightSidebarResizeKey(key)).toBe(true);
    }
    for (const key of ["arrowleft", "Enter", " ", "Escape", "ArrowUp"]) {
      expect(isRightSidebarResizeKey(key)).toBe(false);
    }
  });
});

describe("right sidebar width persistence", () => {
  it("round-trips a stored width", () => {
    const storage = memoryStorage();
    persistRightSidebarWidth(storage, 420);
    expect(readRightSidebarWidth(storage)).toBe(420);
  });

  it("reads the default when nothing is stored", () => {
    expect(readRightSidebarWidth(memoryStorage())).toBe(
      DEFAULT_RIGHT_SIDEBAR_WIDTH,
    );
  });

  it("clamps out-of-range stored values on read", () => {
    const storage = memoryStorage();
    persistRightSidebarWidth(storage, 9_999);
    expect(readRightSidebarWidth(storage)).toBe(RIGHT_SIDEBAR_MAX_WIDTH);
    const narrow = memoryStorage();
    narrow.setItem("slopcad.workbench.right-sidebar-width.v1", "8");
    expect(readRightSidebarWidth(narrow)).toBe(RIGHT_SIDEBAR_MIN_WIDTH);
  });

  it("falls back to the default on corrupt stored values", () => {
    const storage = memoryStorage();
    storage.setItem("slopcad.workbench.right-sidebar-width.v1", "not-a-number");
    expect(readRightSidebarWidth(storage)).toBe(DEFAULT_RIGHT_SIDEBAR_WIDTH);
  });

  it("never throws when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("stripped context");
      },
      setItem: () => {
        throw new Error("stripped context");
      },
    };
    expect(readRightSidebarWidth(throwing)).toBe(DEFAULT_RIGHT_SIDEBAR_WIDTH);
    expect(() => persistRightSidebarWidth(throwing, 300)).not.toThrow();
  });
});
