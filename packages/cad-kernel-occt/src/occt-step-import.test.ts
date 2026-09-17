/**
 * STEP import tests (Phase 21.3): the committed fixture file (the
 * plate-with-hole, generated from the binding's own writer by
 * `scripts/write-step-fixture.ts`) imports with its semantics intact, the
 * malformed-byte matrix fails with structured `step-import/*` codes, the
 * unit canonicalization is verified behaviorally against the binding, and
 * no virtual-file state leaks past any import.
 *
 * The semantic identity at the core of the suite: the imported solid equals
 * the SAME scene built directly with OCCT's own builders — identical
 * analytic volume in the exact band, identical tight bounds, and identical
 * BREP topology counts (faces/edges/vertices explored through the Phase
 * 21.1 TopoDS surface, 7/30/60 — the pre-spike's probed counts). Imported
 * equals built is the phase's whole criterion, and it needs no magic
 * constants beyond the pinned topology identity itself.
 */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import type { KernelSolid } from "@slopcad/cad-kernel";
import { unwrapKernelResult } from "@slopcad/cad-kernel";
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";
import type { OcctKernel } from "./occt-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import { importStepShapes, STEP_IMPORT_ERROR_CODES } from "./occt-step-import";
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
  boreCenterXYMm: [15, 10] as const,
};

/** The fixture's analytic volume: 30×20×10 box minus the ⌀8 through-bore. */
const ANALYTIC_VOLUME_MM3 =
  PLATE.widthMm * PLATE.depthMm * PLATE.heightMm -
  Math.PI * PLATE.boreRadiusMm ** 2 * PLATE.heightMm;

/** The committed fixture: the plate-with-hole as a real STEP Part 21 file. */
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(new URL("../fixtures/plate-with-hole.step", import.meta.url)),
);

let runtime: OcctRuntime;
let kernel: OcctKernel;

beforeAll(async () => {
  runtime = await createOcctRuntime();
  kernel = occtKernelFromRuntime(runtime);
});

/** The OpenCascade instance behind the shared runtime (in-package use). */
const oc = (): OpenCascadeInstance => runtime[RUNTIME_BRAND];

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The first imported solid of a successful import, or a failed test. */
function firstImportedSolid(bytes: Uint8Array): KernelSolid {
  const imported = kernel.importStep(bytes);
  if (!imported.ok) throw new Error(imported.error.message);
  const solid = imported.value.solids[0]?.solid;
  if (solid === undefined) throw new Error("The import yielded no solid.");
  return solid;
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

/** The exact BREP volume of a shape, via the binding's own integrator. */
function brepVolume(shape: TopoDS_Shape): number {
  const instance = oc();
  const props = new instance.GProp_GProps();
  try {
    instance.BRepGProp.VolumeProperties(shape, props, true, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/**
 * Builds the fixture's plate-with-hole directly with OCCT's builders — the
 * "built" twin every imported quantity is judged against.
 */
function buildBuiltinPlateShape(): TopoDS_Shape {
  const instance = oc();
  const box = new instance.BRepPrimAPI_MakeBox(
    PLATE.widthMm,
    PLATE.depthMm,
    PLATE.heightMm,
  ).Shape();
  const bore = new instance.BRepPrimAPI_MakeCylinder(
    PLATE.boreRadiusMm,
    PLATE.heightMm,
  ).Shape();
  const trsf = new instance.gp_Trsf();
  trsf.SetTranslation(new instance.gp_Vec(15, 10, 0));
  const placedBore = new instance.BRepBuilderAPI_Transform(
    bore,
    trsf,
    false,
    true,
  ).Shape();
  return new instance.BRepAlgoAPI_Cut(box, placedBore).Shape();
}

/** Writes shapes to a fresh MEMFS STEP file and returns its bytes. */
function writeStepBytes(shapes: readonly TopoDS_Shape[]): Uint8Array {
  const instance = oc();
  const path = "/slopcad-step-import-test-write.step";
  const writer = new instance.STEPControl_Writer();
  try {
    for (const shape of shapes) {
      const transfer = writer.Transfer(
        shape,
        instance.STEPControl_StepModelType.STEPControl_AsIs,
        true,
        new instance.Message_ProgressRange(),
      );
      if (transfer !== instance.IFSelect_ReturnStatus.IFSelect_RetDone) {
        throw new Error(`The test STEP transfer failed: ${String(transfer)}.`);
      }
    }
    if (
      writer.Write(path) !== instance.IFSelect_ReturnStatus.IFSelect_RetDone
    ) {
      throw new Error("The test STEP write failed.");
    }
  } finally {
    writer.delete();
  }
  const bytes = instance.FS.readFile(path);
  instance.FS.unlink(path);
  return bytes;
}

describe("the committed STEP fixture imports semantically", () => {
  it("imports as exactly one provenance-marked, geometry-only solid", () => {
    const imported = kernel.importStep(FIXTURE_BYTES);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    // The data-level no-fabrication pin: the result carries exactly the
    // provenance-marked solids — no feature, parameter, or history payload
    // exists anywhere on it, so a consumer can always tell imported
    // geometry from feature-built solids by data alone.
    expect(Object.keys(imported.value)).toEqual(["solids"]);
    expect(imported.value.solids).toHaveLength(1);
    expect(Object.keys(imported.value.solids[0] ?? {})).toEqual([
      "solid",
      "origin",
    ]);
    expect(imported.value.solids[0]?.origin).toBe("imported-step");
  });

  it("measures the built plate's exact volume", () => {
    const volume = unwrapKernelResult(
      kernel.volume(firstImportedSolid(FIXTURE_BYTES)),
      "imported volume",
    );
    const builtVolume = brepVolume(buildBuiltinPlateShape());
    // Imported equals built exactly, and both equal the analytic value.
    expect(Math.abs(volume - builtVolume)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE * builtVolume,
    );
    expect(Math.abs(volume - ANALYTIC_VOLUME_MM3)).toBeLessThanOrEqual(
      ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_TOLERANCE,
    );
  });

  it("reads the built plate's exact tight bounds", () => {
    const bounds = unwrapKernelResult(
      kernel.bounds(firstImportedSolid(FIXTURE_BYTES)),
      "imported bounds",
    );
    const minExpected = [0, 0, 0] as const;
    const maxExpected = [PLATE.widthMm, PLATE.depthMm, PLATE.heightMm] as const;
    for (const axis of [0, 1, 2] as const) {
      expect(
        Math.abs(bounds.min[axis] - minExpected[axis]),
      ).toBeLessThanOrEqual(EXACT_BOUNDS_TOLERANCE);
      expect(
        Math.abs(bounds.max[axis] - maxExpected[axis]),
      ).toBeLessThanOrEqual(EXACT_BOUNDS_TOLERANCE);
    }
  });

  it("preserves the BREP topology: the built plate's exact face/edge/vertex counts", () => {
    const shapes = importStepShapes(oc(), FIXTURE_BYTES);
    if (!shapes.ok) throw new Error(shapes.error.message);
    expect(shapes.value.shapes).toHaveLength(1);
    const importedShape = shapes.value.shapes[0];
    if (importedShape === undefined) throw new Error("unreachable above");
    const importedCounts = topologyCounts(importedShape);
    const builtCounts = topologyCounts(buildBuiltinPlateShape());
    // The identity: imported topology equals built topology, and both are
    // the drilled plate's probed 7 faces / 30 edges / 60 vertices.
    expect(importedCounts).toEqual(builtCounts);
    expect(importedCounts).toEqual({ faces: 7, edges: 30, vertices: 60 });
  });

  it("answers every contract operation after the import, dispose included", () => {
    const solid = firstImportedSolid(FIXTURE_BYTES);
    const tessellation = unwrapKernelResult(
      kernel.tessellate(solid),
      "imported tessellation",
    );
    expect(tessellation.indices.length / 3).toBeGreaterThan(0);
    expect(tessellation.positions.length % 3).toBe(0);
    // Import mints an ordinary owned solid: disposal works exactly like a
    // feature-built solid's, and the disposed handle reads as not-owned.
    kernel.dispose(solid);
    const volume = kernel.volume(solid);
    expect(volume.ok).toBe(false);
    if (!volume.ok) {
      expect(volume.error.code).toBe("kernel/solid-not-owned");
    }
  });
});

describe("multi-solid STEP files import as multiple solids", () => {
  it("mints one solid per file solid, each with its own exact volume", () => {
    const instance = oc();
    const second = new instance.BRepPrimAPI_MakeBox(5, 5, 5).Shape();
    const bytes = writeStepBytes([
      buildBuiltinPlateShape(),
      second,
      buildBuiltinPlateShape(),
    ]);
    const imported = kernel.importStep(bytes);
    if (!imported.ok) throw new Error(imported.error.message);
    expect(imported.value.solids).toHaveLength(3);
    for (const ref of imported.value.solids) {
      expect(ref.origin).toBe("imported-step");
    }
    const volumes = imported.value.solids.map((ref) =>
      unwrapKernelResult(kernel.volume(ref.solid), "imported multi volume"),
    );
    expect(
      Math.abs((volumes[0] ?? 0) - ANALYTIC_VOLUME_MM3),
    ).toBeLessThanOrEqual(ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_TOLERANCE);
    expect(volumes[1]).toBeCloseTo(125, 6);
    expect(
      Math.abs((volumes[2] ?? 0) - ANALYTIC_VOLUME_MM3),
    ).toBeLessThanOrEqual(ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_TOLERANCE);
    for (const ref of imported.value.solids) kernel.dispose(ref.solid);
  });
});

describe("STEP units canonicalize to millimetres", () => {
  it("imports an INCH-declared file at the mm geometry (the binding's transfer canonicalization)", () => {
    const instance = oc();
    // The file declares INCH; the reader's system length unit (the
    // millimetre position — probed `SystemLengthUnit() === 1` on a fresh
    // reader) converts the coordinates during transfer, so the imported
    // geometry must be the SAME millimetre plate the fixture carries. This
    // is the verified, pinned answer to "what unit handling does the
    // binding do": the declared unit name is not retrievable (FileUnits'
    // sequence type is unbound), but canonicalization to mm is behavioral.
    if (!instance.Interface_Static.SetCVal("write.step.unit", "INCH")) {
      throw new Error("The binding refused to set write.step.unit = INCH.");
    }
    let bytes: Uint8Array;
    try {
      bytes = writeStepBytes([buildBuiltinPlateShape()]);
    } finally {
      instance.Interface_Static.SetCVal("write.step.unit", "MM");
    }
    const volume = unwrapKernelResult(
      kernel.volume(firstImportedSolid(bytes)),
      "inch-imported volume",
    );
    expect(Math.abs(volume - ANALYTIC_VOLUME_MM3)).toBeLessThanOrEqual(
      ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_TOLERANCE,
    );
    const bounds = unwrapKernelResult(
      kernel.bounds(firstImportedSolid(bytes)),
      "inch-imported bounds",
    );
    expect(Math.abs(bounds.max[0] - PLATE.widthMm)).toBeLessThanOrEqual(
      EXACT_BOUNDS_TOLERANCE,
    );
    expect(Math.abs(bounds.max[1] - PLATE.depthMm)).toBeLessThanOrEqual(
      EXACT_BOUNDS_TOLERANCE,
    );
  });
});

describe("the malformed-byte matrix fails with structured step-import codes", () => {
  it("rejects the empty input", () => {
    const result = kernel.importStep(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_IMPORT_ERROR_CODES.empty);
    }
  });

  it("rejects garbage that is not ISO-10303-21 text at all", () => {
    const result = kernel.importStep(utf8("this is not a STEP file"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_IMPORT_ERROR_CODES.malformed);
    }
  });

  it("rejects undecodable binary garbage", () => {
    const result = kernel.importStep(new Uint8Array([0x00, 0xff, 0xfe, 0x9f]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_IMPORT_ERROR_CODES.malformed);
    }
  });

  it("rejects truncated ISO-10303-21 text", () => {
    const text = new TextDecoder().decode(FIXTURE_BYTES);
    const truncated = utf8(text.slice(0, Math.floor(text.length / 2)));
    const result = kernel.importStep(truncated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_IMPORT_ERROR_CODES.truncated);
    }
  });

  it("rejects a header-only file (ISO text with no data section)", () => {
    const result = kernel.importStep(
      utf8("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_IMPORT_ERROR_CODES.truncated);
    }
  });

  it("rejects a syntactically accepted STEP file that carries no solids", () => {
    const result = kernel.importStep(
      utf8("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nEND-ISO-10303-21;\n"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_IMPORT_ERROR_CODES.noSolids);
    }
  });

  it("leaks no virtual file on any path", () => {
    // FS.readdir is untyped (`any`) in the binding: narrow at the boundary.
    const leaked = (): string[] => {
      const entries: unknown = oc().FS.readdir("/");
      if (!Array.isArray(entries)) {
        throw new Error("FS.readdir must return a list of entries.");
      }
      const names: string[] = [];
      for (const entry of entries) {
        if (typeof entry === "string") names.push(entry);
      }
      return names.filter((name) => name.startsWith("slopcad-step-import"));
    };
    expect(leaked()).toEqual([]);
    // A success and every malformed case above shared this context.
    expect(kernel.importStep(FIXTURE_BYTES).ok).toBe(true);
    expect(kernel.importStep(new Uint8Array(0)).ok).toBe(false);
    expect(kernel.importStep(utf8("junk")).ok).toBe(false);
    expect(leaked()).toEqual([]);
  });
});
