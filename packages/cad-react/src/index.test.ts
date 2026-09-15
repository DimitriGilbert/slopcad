import { describe, expect, it } from "vitest";
import { CAD_DOCUMENT_FORMAT_VERSION as CORE_FORMAT_VERSION } from "@slopcad/cad-core";

import { CAD_DOCUMENT_FORMAT_VERSION } from "./index";

describe("@slopcad/cad-react public entry", () => {
  it("re-exports the CAD core document format version unchanged", () => {
    expect(CAD_DOCUMENT_FORMAT_VERSION).toBe(CORE_FORMAT_VERSION);
  });
});
