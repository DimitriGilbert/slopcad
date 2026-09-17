import { describe, expect, it } from "vitest";
import { KERNEL_BACKEND_IDS } from "@slopcad/cad-kernel";

import { OCCT_BACKEND_ID } from "./index";

describe("OCCT_BACKEND_ID", () => {
  it("is registered in the kernel abstraction's backend list", () => {
    expect(KERNEL_BACKEND_IDS).toContain(OCCT_BACKEND_ID);
  });

  it("identifies the OpenCascade backend", () => {
    expect(OCCT_BACKEND_ID).toBe("opencascade");
  });
});
