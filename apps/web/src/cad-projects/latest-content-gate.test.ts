/**
 * The latest-content gate (the review fix for the background-refetch
 * data-loss path): a dirty session must refuse a refetched latest
 * version, so a concurrent save from another tab plus a refocus cannot
 * silently wipe unsaved local edits through the whole-session replace.
 */

import { describe, expect, it } from "vitest";

import { shouldApplyLatestContent } from "./latest-content-gate";

const LATEST_V5 = "native content of server version 5";
const LOADED_V3 = "native content of server version 3";

describe("shouldApplyLatestContent", () => {
  it("refuses a changed latest while the session is dirty (the data-loss guard)", () => {
    expect(
      shouldApplyLatestContent({
        pinned: false,
        loadedFrom: LOADED_V3,
        latestContent: LATEST_V5,
        isDirty: true,
      }),
    ).toBe(false);
  });

  it("applies a changed latest while the session is clean", () => {
    expect(
      shouldApplyLatestContent({
        pinned: false,
        loadedFrom: LOADED_V3,
        latestContent: LATEST_V5,
        isDirty: false,
      }),
    ).toBe(true);
  });

  it("refuses while an explicit version pick is pinned (existing behavior)", () => {
    expect(
      shouldApplyLatestContent({
        pinned: true,
        loadedFrom: LOADED_V3,
        latestContent: LATEST_V5,
        isDirty: false,
      }),
    ).toBe(false);
    // The pin wins even over the boot read.
    expect(
      shouldApplyLatestContent({
        pinned: true,
        loadedFrom: null,
        latestContent: LATEST_V5,
        isDirty: true,
      }),
    ).toBe(false);
  });

  it("refuses text the store already mirrors (enter exactly once per text)", () => {
    expect(
      shouldApplyLatestContent({
        pinned: false,
        loadedFrom: LATEST_V5,
        latestContent: LATEST_V5,
        isDirty: false,
      }),
    ).toBe(false);
  });

  it("applies the boot read: a null loadedFrom is no baseline to protect", () => {
    // Before the first read the bar's identity check is vacuously dirty
    // (savedDocument is null while the authored boot document is not), so
    // the gate must not treat the boot as unsaved edits — the initial
    // load always applies.
    expect(
      shouldApplyLatestContent({
        pinned: false,
        loadedFrom: null,
        latestContent: LATEST_V5,
        isDirty: true,
      }),
    ).toBe(true);
  });
});
