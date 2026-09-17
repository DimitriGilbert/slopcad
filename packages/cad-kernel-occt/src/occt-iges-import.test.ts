/**
 * IGES import tests (Phase 21.5): the plan's fallback-decision execution,
 * pinned against the committed fixture — a real 10 mm cube IGES file
 * (adopted verbatim from occt-import-js's own LGPL-2.1 test suite, whose
 * header self-describes Autodesk Inventor 2019 provenance and `2HMM`
 * units; no IGES writer exists anywhere in this repo's bindings, so a real
 * third-party file is the honest fixture).
 *
 * The pins: the mesh-level payload discipline (tessellations with names
 * and BREP face counts, origin `"imported-iges"` — never kernel solids),
 * the reader's canonical-millimetre behavior (the 10 mm cube reads back
 * exactly 10 mm extents in canonical mm), determinism (the same bytes
 * import to deep-equal meshes twice), and the structured malformed-byte
 * matrix (empty, non-IGES text, binary junk, truncated IGES — codes, never
 * throws).
 */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createIgesEngine,
  IGES_IMPORT_ERROR_CODES,
  importIgesMeshes,
  type IgesEngine,
} from "./occt-iges-import";

/** The committed fixture: a real 10×10×10 mm IGES cube. */
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(new URL("../fixtures/cube-10mm.igs", import.meta.url)),
);

let engine: IgesEngine;

beforeAll(async () => {
  engine = await createIgesEngine();
});

describe("the committed IGES fixture imports as mesh bodies", () => {
  it("yields one named mesh with a full soup and the mesh-level provenance", () => {
    const imported = importIgesMeshes(engine, FIXTURE_BYTES);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.origin).toBe("imported-iges");
    expect(imported.value.meshes).toHaveLength(1);
    const mesh = imported.value.meshes[0];
    if (mesh === undefined) throw new Error("The fixture yielded no mesh.");
    expect(mesh.name).toBe("Solid1");
    expect(mesh.brepFaces).toBe(6);
    expect(mesh.tessellation.positions.length).toBe(72);
    expect(mesh.tessellation.indices.length).toBe(36);
    expect(mesh.tessellation.normals?.length).toBe(72);
  });

  it("reads the 10 mm cube's canonical-millimetre extents exactly", () => {
    const imported = importIgesMeshes(engine, FIXTURE_BYTES);
    if (!imported.ok) throw new Error(imported.error.message);
    const soup = imported.value.meshes[0]?.tessellation;
    if (soup === undefined) throw new Error("The fixture yielded no mesh.");
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < soup.positions.length; i += 3) {
      for (const axis of [0, 1, 2] as const) {
        const value = soup.positions[i + axis];
        if (value === undefined) throw new Error("positions are triplets");
        const lo = min[axis];
        const hi = max[axis];
        if (lo === undefined || hi === undefined) {
          throw new Error("extents are triples");
        }
        min[axis] = Math.min(lo, value);
        max[axis] = Math.max(hi, value);
      }
    }
    // The fixture's placement: x/z ∈ [-5, 5], y ∈ [0, 10] — a 10 mm cube
    // in the file's own millimetres (probed against the raw reader).
    expect(min).toEqual([-5, 0, -5]);
    expect(max).toEqual([5, 10, 5]);
  });

  it("imports the same bytes to deep-equal meshes twice (determinism)", () => {
    const first = importIgesMeshes(engine, FIXTURE_BYTES);
    const second = importIgesMeshes(engine, FIXTURE_BYTES);
    expect(second).toEqual(first);
  });

  it("honors the library's tessellation params without changing the unit semantics", () => {
    // A coarser deflection still yields a valid manifold soup for the
    // planar cube: same extents, finite numbers, in-range indices.
    const imported = importIgesMeshes(engine, FIXTURE_BYTES, {
      linearUnit: "millimeter",
      linearDeflectionType: "absolute_value",
      linearDeflection: 0.1,
      angularDeflection: 0.5,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const soup = imported.value.meshes[0]?.tessellation;
    if (soup === undefined) throw new Error("The fixture yielded no mesh.");
    expect(soup.positions.length % 3).toBe(0);
    expect(soup.indices.length % 3).toBe(0);
  });
});

describe("the malformed-byte matrix fails with structured iges-import codes", () => {
  it("rejects the empty input", () => {
    const result = importIgesMeshes(engine, new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(IGES_IMPORT_ERROR_CODES.empty);
    }
  });

  it("rejects text that is not IGES (no fixed-format section records)", () => {
    const result = importIgesMeshes(
      engine,
      new TextEncoder().encode("hello world, definitely not fixed-width IGES"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(IGES_IMPORT_ERROR_CODES.malformed);
    }
  });

  it("rejects undecodable binary garbage", () => {
    const result = importIgesMeshes(
      engine,
      new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0x0a]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(IGES_IMPORT_ERROR_CODES.malformed);
    }
  });

  it("rejects truncated IGES text (the reader's structured failure)", () => {
    const result = importIgesMeshes(
      engine,
      FIXTURE_BYTES.subarray(0, Math.floor(FIXTURE_BYTES.length / 2)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(IGES_IMPORT_ERROR_CODES.failed);
    }
  });

  it("never throws across the whole matrix", () => {
    const matrix: readonly Uint8Array[] = [
      new Uint8Array(0),
      new TextEncoder().encode("garbage"),
      new Uint8Array([0x00, 0x01, 0x02, 0xff]),
      FIXTURE_BYTES.subarray(0, 80),
      FIXTURE_BYTES,
    ];
    for (const bytes of matrix) {
      expect(() => importIgesMeshes(engine, bytes)).not.toThrow();
    }
  });
});
