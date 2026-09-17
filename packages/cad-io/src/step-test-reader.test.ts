/**
 * The STEP Part 21 test reader's own tests (Phase 21.4): the reader parses
 * the committed OCCT-written fixture — real bytes produced by the same
 * binding's `STEPControl_Writer` the kernel package's exporter wraps, in a
 * different process — and its structural facts are asserted against what
 * that writer was probed to emit under `STEPControl_AsIs`/AP214: the ISO
 * keyword and terminator, the OCCT FILE_NAME/FILE_SCHEMA header, the
 * advanced-BREP entity chain (one `ADVANCED_BREP_SHAPE_REPRESENTATION` per
 * product, one `MANIFOLD_SOLID_BREP` and `CLOSED_SHELL` per solid, seven
 * `ADVANCED_FACE`s for the plate-with-hole), and a sane entity-assignment
 * count. Malformed inputs (garbage, truncated, terminator-less) throw.
 *
 * The fixture is read by path (`../cad-kernel-occt/fixtures`) as a COMMITTED
 * ARTIFACT — a dev-time read of a sibling package's test data, never a
 * package dependency: this package stays layering-clean below the kernels.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { countStepEntitiesOfType, readStepPart21 } from "./step-test-reader";

const FIXTURE_BYTES = new Uint8Array(
  readFileSync(
    new URL(
      "../../cad-kernel-occt/fixtures/plate-with-hole.step",
      import.meta.url,
    ),
  ),
);

const BREP_CHAIN_TYPES = [
  "ADVANCED_BREP_SHAPE_REPRESENTATION",
  "MANIFOLD_SOLID_BREP",
  "CLOSED_SHELL",
  "ADVANCED_FACE",
  "CARTESIAN_POINT",
] as const;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the STEP Part 21 test reader", () => {
  it("parses the committed fixture's header exactly", () => {
    const document = readStepPart21(FIXTURE_BYTES, BREP_CHAIN_TYPES);
    expect(document.header.description).toBe("Open CASCADE Model");
    expect(document.header.modelName).toBe("Open CASCADE Shape Model");
    expect(document.header.timeStamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    );
    expect(document.header.processor).toBe(
      "Open CASCADE STEP processor 8.0",
    );
    expect(document.header.originator).toBe("Open CASCADE 8.0");
    // AP214, the AsIs default schema the binding emits (probed).
    expect(document.header.schema).toBe(
      "AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }",
    );
  });

  it("asserts the real AsIs structure: the advanced-BREP chain and sane entity counts", () => {
    const document = readStepPart21(FIXTURE_BYTES, BREP_CHAIN_TYPES);
    // One product, one solid, one closed shell, seven faces — the drilled
    // plate's probed topology.
    expect(document.typeCounts["ADVANCED_BREP_SHAPE_REPRESENTATION"]).toBe(1);
    expect(document.typeCounts["MANIFOLD_SOLID_BREP"]).toBe(1);
    expect(document.typeCounts["CLOSED_SHELL"]).toBe(1);
    expect(document.typeCounts["ADVANCED_FACE"]).toBe(7);
    // Sane entity graph: hundreds of assignments, dense up to the maximum
    // id (OCCT numbers sequentially), and cartersian points aplenty.
    expect(document.entityCount).toBeGreaterThanOrEqual(400);
    expect(document.entityCount).toBe(document.maxEntityId);
    expect(document.typeCounts["CARTESIAN_POINT"]).toBeGreaterThan(30);
  });

  it("throws on structural violations, not on STEP it merely dislikes", () => {
    for (const [name, bytes] of [
      ["empty", new Uint8Array(0)],
      ["garbage", utf8("this is not a STEP file")],
      [
        "missing terminator",
        utf8("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1 = PRODUCT('a');\n"),
      ],
      [
        "no header",
        utf8("ISO-10303-21;\nDATA;\n#1 = PRODUCT('a');\nEND-ISO-10303-21;\n"),
      ],
    ] as const) {
      expect(() => readStepPart21(bytes), name).toThrow(/Malformed STEP/);
    }
  });

  it("counts entity types by word boundary (no substring false positives)", () => {
    // BREP_WITH_VOIDS contains… nothing named like a bare MANIFOLD prefix,
    // but a text containing SHELL_OF_SOLID must not count as CLOSED_SHELL.
    const text = "#1 = SHELL_OF_SOLID('x'); #2 = CLOSED_SHELL('y');";
    expect(countStepEntitiesOfType(text, "CLOSED_SHELL")).toBe(1);
    expect(countStepEntitiesOfType(text, "SHELL_OF_SOLID")).toBe(1);
    expect(countStepEntitiesOfType(text, "MANIFOLD_SOLID_BREP")).toBe(0);
  });
});
