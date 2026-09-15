import { describe, expect, it } from "vitest";

import { KERNEL_BACKEND_IDS } from "./index";

describe("KERNEL_BACKEND_IDS", () => {
  it("registers the Manifold, OpenCascade, JSCAD, and fake backends", () => {
    expect(KERNEL_BACKEND_IDS).toContain("manifold");
    expect(KERNEL_BACKEND_IDS).toContain("opencascade");
    expect(KERNEL_BACKEND_IDS).toContain("jscad");
    expect(KERNEL_BACKEND_IDS).toContain("fake");
  });

  it("contains no duplicate backend identifier", () => {
    expect(new Set(KERNEL_BACKEND_IDS).size).toBe(KERNEL_BACKEND_IDS.length);
  });
});
