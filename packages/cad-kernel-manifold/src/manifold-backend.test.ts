import { describe, expect, it } from "vitest";
import { KERNEL_BACKEND_IDS } from "@slopcad/cad-kernel";

import { MANIFOLD_BACKEND_ID } from "./index";

describe("MANIFOLD_BACKEND_ID", () => {
  it("is registered in the kernel abstraction's backend list", () => {
    expect(KERNEL_BACKEND_IDS).toContain(MANIFOLD_BACKEND_ID);
  });

  it("identifies the Manifold backend", () => {
    expect(MANIFOLD_BACKEND_ID).toBe("manifold");
  });
});
