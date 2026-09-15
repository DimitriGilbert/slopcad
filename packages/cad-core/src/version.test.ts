import { describe, expect, it } from "vitest";

import { CAD_DOCUMENT_FORMAT_VERSION } from "./index";

describe("CAD_DOCUMENT_FORMAT_VERSION", () => {
  it("is pinned to 1, the initial document format base", () => {
    expect(CAD_DOCUMENT_FORMAT_VERSION).toBe(1);
  });

  it("is a positive integer suitable for version-stamping persisted documents", () => {
    expect(Number.isInteger(CAD_DOCUMENT_FORMAT_VERSION)).toBe(true);
    expect(CAD_DOCUMENT_FORMAT_VERSION).toBeGreaterThan(0);
  });
});
