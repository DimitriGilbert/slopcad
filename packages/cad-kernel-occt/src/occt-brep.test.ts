/**
 * BREP exchange tests (Phase 21.5): the exporter's determinism (probed to
 * need NO neutralizer — pinned against the committed fixture across
 * processes), the plan's round-trip criterion (exported BREP re-imports
 * with its semantics intact: volume in the exact band, exact bounds,
 * identical topology), the compound multi-shape carrier, and the structured
 * malformed-byte matrix (no throws, no filesystem state — the string API
 * bypasses the virtual filesystem entirely).
 *
 * The strongest determinism pin is cross-process by construction: the
 * committed fixture was written by the SAME binding's writer in a DIFFERENT
 * process; this suite's exported plate must equal it BYTE-FOR-BYTE — unlike
 * the STEP twin (whose writer carries a wall-clock timestamp), there is no
 * neutralized line, so every byte including the header must agree.
 */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import type { KernelSolid } from "@slopcad/cad-kernel";
import { unwrapKernelResult } from "@slopcad/cad-kernel";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import type {
  OpenCascadeInstance,
  TopoDS_Builder,
  TopoDS_Compound,
  TopoDS_Shape,
} from "replicad-opencascadejs";
import type { OcctKernel } from "./occt-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import {
  BREP_EXPORT_ERROR_CODES,
  BREP_IMPORT_ERROR_CODES,
  exportBrepShapes,
} from "./occt-brep";
import {
  createOcctRuntime,
  RUNTIME_BRAND,
  type OcctRuntime,
} from "./occt-runtime";

/** The fixture scene's dimensions — exactly the /io source plate. */
const PLATE = {
  widthMm: 30,
  depthMm: 20,
  heightMm: 10,
  boreRadiusMm: 4,
  boreCenterXYmM: [15, 10] as const,
};

/** The fixture's analytic volume: 30×20×10 box minus the ⌀8 through-bore. */
const ANALYTIC_VOLUME_MM3 =
  PLATE.widthMm * PLATE.depthMm * PLATE.heightMm -
  Math.PI * PLATE.boreRadiusMm ** 2 * PLATE.heightMm;

/** The committed 21.5 fixture: the same plate, written cross-process. */
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(new URL("../fixtures/plate-with-hole.brep", import.meta.url)),
);

let runtime: OcctRuntime;
let kernel: OcctKernel;

beforeAll(async () => {
  runtime = await createOcctRuntime();
  kernel = occtKernelFromRuntime(runtime);
});

/** The OpenCascade instance behind the shared runtime (in-package use). */
const oc = (): OpenCascadeInstance => runtime[RUNTIME_BRAND];

const mm = (value: number) => length(value, "mm");

/** Builds the plate-with-hole through the kernel contract's own surface. */
function buildPlate(): KernelSolid {
  const plate = unwrapKernelResult(
    kernel.createBox({
      width: mm(PLATE.widthMm),
      depth: mm(PLATE.depthMm),
      height: mm(PLATE.heightMm),
    }),
    "createBox",
  );
  const boreAtOrigin = unwrapKernelResult(
    kernel.createCylinder({
      radius: mm(PLATE.boreRadiusMm),
      height: mm(PLATE.heightMm),
    }),
    "createCylinder",
  );
  const bore = unwrapKernelResult(
    kernel.transform(boreAtOrigin, {
      x: mm(PLATE.boreCenterXYmM[0]),
      y: mm(PLATE.boreCenterXYmM[1]),
      z: mm(0),
    }),
    "transform",
  );
  return unwrapKernelResult(kernel.subtract(plate, [bore]), "subtract");
}

/** Exports `solids` or fails the test with the structured message. */
function exportBytes(solids: readonly KernelSolid[]): Uint8Array {
  const exported = kernel.exportBrep(solids);
  if (!exported.ok) throw new Error(exported.error.message);
  return exported.value;
}

type TopoKind = Parameters<
  InstanceType<OpenCascadeInstance["TopExp_Explorer"]>["Init"]
>[1];

/** Explores the Phase 21.1 TopoDS surface for a face/edge/vertex count. */
function topologyCounts(shape: TopoDS_Shape): {
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
} {
  const instance = oc();
  const count = (kind: TopoKind): number => {
    const explorer = new instance.TopExp_Explorer(shape, kind);
    let found = 0;
    while (explorer.More()) {
      found += 1;
      explorer.Next();
    }
    explorer.delete();
    return found;
  };
  return {
    faces: count(instance.TopAbs_ShapeEnum.TopAbs_FACE),
    edges: count(instance.TopAbs_ShapeEnum.TopAbs_EDGE),
    vertices: count(instance.TopAbs_ShapeEnum.TopAbs_VERTEX),
  };
}

describe("BREP export is deterministic with no neutralizer", () => {
  it("exports the same plate byte-identically across interleaved exports", () => {
    const plate = buildPlate();
    const first = exportBytes([plate]);
    // Interleave unrelated exports, then export the SAME solid again:
    // identical bytes — the writer has no process-global state to offset.
    const sphere = unwrapKernelResult(
      kernel.createSphere({ radius: mm(2) }),
      "createSphere",
    );
    expect(exportBytes([sphere]).length).toBeGreaterThan(0);
    const second = exportBytes([plate]);
    expect([...second]).toEqual([...first]);
    kernel.dispose(plate);
    kernel.dispose(sphere);
  });

  it("equals the committed cross-process fixture byte-for-byte, header included", () => {
    // The BREP writer carries no timestamp and no counter (probed): the
    // whole file — header line included — must agree across processes.
    const exported = exportBytes([buildPlate()]);
    expect(exported.length).toBe(FIXTURE_BYTES.length);
    expect([...exported]).toEqual([...FIXTURE_BYTES]);
  });

  it("carries the pure-ASCII CASCADE Topology form and no date-shaped text", () => {
    const text = new TextDecoder().decode(exportBytes([buildPlate()]));
    expect(text).toMatch(
      /^\uFEFF?\s*CASCADE Topology V\d+, \(c\) Open Cascade/,
    );
    // No wall clock anywhere in the file: the determinism contract's probe.
    expect(text.match(/\d{4}-\d{2}-\d{2}/g)).toBeNull();
    const nonAscii = [...text].filter((ch) => ch.charCodeAt(0) > 0x7f).length;
    expect(nonAscii).toBe(0);
  });

  it("leaves no filesystem state on any path (the string API never touches it)", () => {
    const slopcadFiles = (): readonly string[] => {
      const entries: unknown = oc().FS.readdir("/");
      if (!Array.isArray(entries)) {
        throw new Error("FS.readdir must return a list of entries.");
      }
      const names: string[] = [];
      for (const entry of entries) {
        if (typeof entry === "string" && entry.startsWith("slopcad-")) {
          names.push(entry);
        }
      }
      return names;
    };
    expect(slopcadFiles()).toEqual([]);
    expect(exportBytes([buildPlate()]).length).toBeGreaterThan(0);
    // Drive the malformed import matrix too: nothing may appear in the FS.
    for (const bytes of [
      new Uint8Array(0),
      new TextEncoder().encode("garbage"),
      FIXTURE_BYTES.subarray(0, Math.floor(FIXTURE_BYTES.length / 2)),
    ]) {
      expect(kernel.importBrep(bytes).ok).toBe(false);
    }
    expect(kernel.exportBrep([]).ok).toBe(false);
    expect(slopcadFiles()).toEqual([]);
  });
});

describe("exported BREP re-imports with its semantics intact", () => {
  it("round-trips the built plate: exact-band volume, exact bounds, identical topology", () => {
    const plate = buildPlate();
    const bytes = exportBytes([plate]);

    // The plan's criterion, kernel-level: exported BREP re-imports, with
    // the STEP twin's provenance literal.
    const imported = kernel.importBrep(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.solids).toHaveLength(1);
    const solid = imported.value.solids[0]?.solid;
    if (solid === undefined) throw new Error("The import yielded no solid.");
    expect(imported.value.solids[0]?.origin).toBe("imported-brep");

    // The ASCII decimal text re-parses to last-ulp-rounded doubles (probed
    // at 3.3e-16 relative) — inside the contract suite's exact band.
    const volume = unwrapKernelResult(
      kernel.volume(solid),
      "round-trip volume",
    );
    expect(Math.abs(volume - ANALYTIC_VOLUME_MM3)).toBeLessThanOrEqual(
      ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_TOLERANCE,
    );
    const bounds = unwrapKernelResult(
      kernel.bounds(solid),
      "round-trip bounds",
    );
    const maxExpected = [PLATE.widthMm, PLATE.depthMm, PLATE.heightMm] as const;
    for (const axis of [0, 1, 2] as const) {
      expect(Math.abs(bounds.min[axis])).toBeLessThanOrEqual(
        EXACT_BOUNDS_TOLERANCE,
      );
      const expected = maxExpected[axis];
      if (expected === undefined) throw new Error("axes are triples");
      expect(Math.abs(bounds.max[axis] - expected)).toBeLessThanOrEqual(
        EXACT_BOUNDS_TOLERANCE,
      );
    }

    kernel.dispose(solid);
    kernel.dispose(plate);
  });

  it("preserves the BREP topology: the plate's exact face/edge/vertex counts", () => {
    const bytes = exportBytes([buildPlate()]);
    const reimported = importBrepShapesForCounts(bytes);
    expect(topologyCounts(reimported)).toEqual({
      faces: 7,
      edges: 30,
      vertices: 60,
    });
    reimported.delete();
  });

  it("exports multiple solids as ONE compound file that imports back in order with per-solid volumes", () => {
    const plate = buildPlate();
    const box = unwrapKernelResult(
      kernel.createBox({ width: mm(5), depth: mm(5), height: mm(5) }),
      "createBox",
    );
    const sphere = unwrapKernelResult(
      kernel.createSphere({ radius: mm(2) }),
      "createSphere",
    );
    const bytes = exportBytes([plate, box, sphere]);
    // The compound carrier is still one BREP file with one header.
    const text = new TextDecoder().decode(bytes);
    expect(text.match(/CASCADE Topology V\d+,/g)).toHaveLength(1);

    const imported = kernel.importBrep(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.solids).toHaveLength(3);
    // File order is preserved (probed): plate, box, sphere — each with its
    // own exact volume, origins all the BREP literal.
    const volumes = imported.value.solids.map((ref) => {
      expect(ref.origin).toBe("imported-brep");
      return unwrapKernelResult(kernel.volume(ref.solid), "multi round-trip");
    });
    expect(
      Math.abs((volumes[0] ?? 0) - ANALYTIC_VOLUME_MM3),
    ).toBeLessThanOrEqual(ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_TOLERANCE);
    expect(volumes[1] ?? 0).toBeCloseTo(125, 6);
    expect(
      Math.abs((volumes[2] ?? 0) - (4 / 3) * Math.PI * 2 ** 3),
    ).toBeLessThanOrEqual((4 / 3) * Math.PI * 2 ** 3 * EXACT_VOLUME_TOLERANCE);
    for (const ref of imported.value.solids) kernel.dispose(ref.solid);
    for (const solid of [plate, box, sphere]) kernel.dispose(solid);
  });
});

describe("the malformed-byte matrix fails with structured brep-import codes", () => {
  it("rejects the empty input", () => {
    const result = kernel.importBrep(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_IMPORT_ERROR_CODES.empty);
    }
  });

  it("rejects garbage that is not CASCADE Topology text at all", () => {
    const result = kernel.importBrep(new TextEncoder().encode("hello world"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_IMPORT_ERROR_CODES.malformed);
    }
  });

  it("rejects undecodable binary garbage", () => {
    const result = kernel.importBrep(
      new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0x0a]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_IMPORT_ERROR_CODES.malformed);
    }
  });

  it("rejects truncated BREP text (the reader's null shape)", () => {
    const result = kernel.importBrep(
      FIXTURE_BYTES.subarray(0, Math.floor(FIXTURE_BYTES.length / 2)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_IMPORT_ERROR_CODES.truncated);
    }
  });

  it("rejects a header-only file (no table sections)", () => {
    const result = kernel.importBrep(
      new TextEncoder().encode("\nCASCADE Topology V3, (c) Open Cascade\n"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_IMPORT_ERROR_CODES.truncated);
    }
  });

  it("rejects a STEP file's bytes with the malformed code (wrong format, named honestly)", () => {
    const step = readFileSync(
      new URL("../fixtures/plate-with-hole.step", import.meta.url),
    );
    const result = kernel.importBrep(new Uint8Array(step));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_IMPORT_ERROR_CODES.malformed);
    }
  });

  it("never throws across the whole matrix", () => {
    const matrix: readonly Uint8Array[] = [
      new Uint8Array(0),
      new TextEncoder().encode("garbage"),
      new Uint8Array([0x00, 0x01, 0x02, 0xff]),
      new TextEncoder().encode("\nCASCADE Topology V3, (c) Open Cascade\n"),
      FIXTURE_BYTES.subarray(0, 10),
      FIXTURE_BYTES,
    ];
    for (const bytes of matrix) {
      expect(() => kernel.importBrep(bytes)).not.toThrow();
    }
  });
});

describe("BREP exchange rejects its inputs with structured codes", () => {
  it("rejects the empty solid list on export", () => {
    const result = kernel.exportBrep([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_EXPORT_ERROR_CODES.empty);
    }
  });

  it("rejects a foreign handle and a disposed handle with the kernel's solid-not-owned", () => {
    const otherKernel = occtKernelFromRuntime(runtime);
    const foreign = unwrapKernelResult(
      otherKernel.createSphere({ radius: mm(1) }),
      "createSphere",
    );
    const rejected = kernel.exportBrep([foreign]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("kernel/solid-not-owned");
    }
    otherKernel.dispose(foreign);

    const disposed = buildPlate();
    kernel.dispose(disposed);
    const afterDispose = kernel.exportBrep([disposed]);
    expect(afterDispose.ok).toBe(false);
    if (!afterDispose.ok) {
      expect(afterDispose.error.code).toBe("kernel/solid-not-owned");
    }
  });

  it("imports the committed fixture and answers every contract operation after", () => {
    const imported = kernel.importBrep(FIXTURE_BYTES);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const solid = imported.value.solids[0]?.solid;
    if (solid === undefined) throw new Error("The fixture yielded no solid.");
    expect(
      unwrapKernelResult(kernel.volume(solid), "fixture volume"),
    ).toBeGreaterThan(0);
    expect(kernel.bounds(solid).ok).toBe(true);
    expect(kernel.tessellate(solid).ok).toBe(true);
    kernel.dispose(solid);
    expect(kernel.volume(solid).ok).toBe(false);
  });
});

/** Imports `bytes` to ONE raw shape for topology exploration, or fails. */
function importBrepShapesForCounts(bytes: Uint8Array): TopoDS_Shape {
  // The raw boundary over the same text the kernel path decodes: explore
  // the FULL read-back shape (compound wrapper included) — the counts are
  // the file's, not one solid's wrapper.
  const text = new TextDecoder().decode(bytes);
  const shape = oc().BRepToolsWrapper.Read(text);
  if (shape.IsNull()) {
    throw new Error("The round-tripped BREP did not parse.");
  }
  return shape;
}

/** One raw box shape off the real binding (the kernel's own construction). */
function rawBoxShape(
  width: number,
  depth: number,
  height: number,
): TopoDS_Shape {
  const instance = oc();
  const maker = new instance.BRepPrimAPI_MakeBox(width, depth, height);
  const shape = maker.Shape();
  maker.delete();
  return shape;
}

describe("the compound wrapper is deleted when the compound build throws", () => {
  it("returns the structured kernel-failure and deletes the TopoDS_Compound", () => {
    // Counting stub over the real binding: every constructed compound's
    // delete() is observed; the builder's MakeCompound is the throwing
    // seam (the probed class of binding error the outer catch exists for).
    const real = oc();
    let compoundDeletes = 0;
    const countingCompounds = new Proxy(real.TopoDS_Compound, {
      construct(target) {
        const made: unknown = Reflect.construct(target, []);
        const instance = made as TopoDS_Compound;
        return new Proxy(instance, {
          get(obj, property, receiver) {
            if (property === "delete") {
              return () => {
                compoundDeletes += 1;
                obj.delete();
              };
            }
            const value: unknown = Reflect.get(obj, property, receiver);
            if (typeof value !== "function") {
              return value;
            }
            const bound: unknown = value.bind(obj);
            return bound;
          },
        });
      },
    });
    const throwingBuilders = new Proxy(real.TopoDS_Builder, {
      construct(target) {
        const made: unknown = Reflect.construct(target, []);
        const instance = made as TopoDS_Builder;
        return new Proxy(instance, {
          get(obj, property, receiver) {
            if (property === "MakeCompound") {
              return (): never => {
                throw new Error("TopoDS_Builder.MakeCompound binding boom");
              };
            }
            const value: unknown = Reflect.get(obj, property, receiver);
            if (typeof value !== "function") {
              return value;
            }
            const bound: unknown = value.bind(obj);
            return bound;
          },
        });
      },
    });
    const stubbed = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "TopoDS_Compound") return countingCompounds;
        if (property === "TopoDS_Builder") return throwingBuilders;
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });

    // Two shapes force the compound (multi-shape) path.
    const shapes = [rawBoxShape(10, 10, 10), rawBoxShape(5, 5, 5)];
    const result = exportBrepShapes(stubbed, shapes);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BREP_EXPORT_ERROR_CODES.kernelFailure);
      expect(result.error.message).toContain(
        "TopoDS_Builder.MakeCompound binding boom",
      );
    }
    // The wrapper is deleted on the throwing path — no leak past the catch.
    expect(compoundDeletes).toBe(1);
    for (const shape of shapes) shape.delete();
  });
});
