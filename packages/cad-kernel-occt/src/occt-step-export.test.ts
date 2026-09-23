/**
 * STEP export tests (Phase 21.4): the exporter's determinism (the two
 * neutralized writer fields — and nothing else — stand between the writer's
 * output and byte-identity, pinned against the committed 21.3 fixture), the
 * plan's round-trip criterion (exported STEP re-imports with its semantics
 * intact: volume in the exact band, exact bounds, identical topology), the
 * unit/schema options with their process-global restore, multi-solid export,
 * and the structured error paths.
 *
 * The strongest determinism pin is cross-process by construction: the
 * committed fixture was written by the SAME binding's writer in a DIFFERENT
 * process; this suite's exported plate must equal it byte-for-byte except
 * the single neutralized FILE_NAME timestamp line (the fixture keeps its
 * real generation time, the export pins the epoch stamp) — everything
 * geometric is identical across processes, runtimes, and write history.
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
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";
import type { OcctKernel } from "./occt-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import {
  exportStepShapes,
  STEP_EXPORT_EPOCH_STAMP,
  STEP_EXPORT_ERROR_CODES,
} from "./occt-step-export";
import { importStepShapes } from "./occt-step-import";
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

/** The committed 21.3 fixture: the same plate, written cross-process. */
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
      x: mm(PLATE.boreCenterXYMm[0]),
      y: mm(PLATE.boreCenterXYMm[1]),
      z: mm(0),
    }),
    "transform",
  );
  return unwrapKernelResult(kernel.subtract(plate, [bore]), "subtract");
}

/** Exports `solids` or fails the test with the structured message. */
function exportBytes(
  solids: readonly KernelSolid[],
  options?: Parameters<OcctKernel["exportStep"]>[1],
): Uint8Array {
  const exported = kernel.exportStep(solids, options);
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

describe("STEP export is deterministic", () => {
  it("exports the same plate byte-identically across interleaved exports (the product counter is neutralized)", () => {
    const plate = buildPlate();
    const first = exportBytes([plate]);
    // Offset the writer's process-global product counter with unrelated
    // exports, then export the SAME solid again: identical bytes anyway.
    const sphere = unwrapKernelResult(
      kernel.createSphere({ radius: mm(2) }),
      "createSphere",
    );
    expect(exportBytes([sphere]).length).toBeGreaterThan(0);
    expect(exportBytes([sphere, sphere]).length).toBeGreaterThan(0);
    const second = exportBytes([plate]);
    expect([...second]).toEqual([...first]);
    kernel.dispose(plate);
    kernel.dispose(sphere);
  });

  it("equals the committed cross-process fixture byte-for-byte except the neutralized timestamp line", () => {
    const exported = exportBytes([buildPlate()]);
    const exportedLines = new TextDecoder().decode(exported).split("\n");
    const fixtureLines = new TextDecoder().decode(FIXTURE_BYTES).split("\n");
    expect(exported.length).toBe(FIXTURE_BYTES.length);
    const differing: number[] = [];
    for (
      let line = 0;
      line < Math.max(exportedLines.length, fixtureLines.length);
      line += 1
    ) {
      if (exportedLines[line] !== fixtureLines[line]) differing.push(line);
    }
    // Exactly one line differs: the FILE_NAME timestamp (the fixture's real
    // generation time vs the export's fixed epoch stamp). The fixture's
    // product counter is 1 and the export's first product renumbers to 1,
    // so the counter sites agree here by construction.
    expect(differing).toEqual([3]);
    expect(exportedLines[3]).toContain(STEP_EXPORT_EPOCH_STAMP);
    expect(fixtureLines[3]).not.toContain(STEP_EXPORT_EPOCH_STAMP);
  });

  it("carries the neutralized header and renumbered product names, never a wall clock", () => {
    const text = new TextDecoder().decode(exportBytes([buildPlate()]));
    expect(text).toContain(`'${STEP_EXPORT_EPOCH_STAMP}'`);
    // The ONLY ISO-8601 stamp anywhere is the fixed epoch — a live clock
    // would betray itself as a second, current-dated stamp.
    const stamps = text.match(/'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/g) ?? [];
    expect(stamps).toEqual([`'${STEP_EXPORT_EPOCH_STAMP}'`]);
    // The first product's counter is renumbered to 1 regardless of prior
    // export history in this process (this test file has exported before).
    expect(text).toContain("PRODUCT('Open CASCADE STEP translator 8.0 1'");
  });

  it("writes no names or colors the binding cannot read back (the Phase 56 documented decline)", () => {
    // The XCAF document layer (STEPCAFControl_*) is not bound in this
    // build (probed; docs/architecture/occt-prespike-findings.md §5), so
    // export CANNOT write presentation/name data it could round-trip —
    // and the no-fabrication law forbids writing any anyway. The decline
    // is pinned in the bytes: the geometry-only writer emits no styled-
    // item or colour entities, and the only product names are the
    // renumbered translator literals.
    const text = new TextDecoder().decode(exportBytes([buildPlate()]));
    expect(text).not.toMatch(
      /STYLED_ITEM|COLOUR|DRAUGHTING_PRE_DEFINED_COLOUR/,
    );
    const productNames = text.match(/PRODUCT\('([^']*)'/g) ?? [];
    expect(productNames.length).toBeGreaterThan(0);
    for (const name of productNames) {
      expect(name.startsWith("PRODUCT('Open CASCADE STEP translator")).toBe(
        true,
      );
    }
  });

  it("leaks no virtual file on any path", () => {
    const leaked = (): string[] => {
      const entries: unknown = oc().FS.readdir("/");
      if (!Array.isArray(entries)) {
        throw new Error("FS.readdir must return a list of entries.");
      }
      const names: string[] = [];
      for (const entry of entries) {
        if (typeof entry === "string") names.push(entry);
      }
      return names.filter((name) => name.startsWith("slopcad-step-export"));
    };
    expect(leaked()).toEqual([]);
    expect(exportBytes([buildPlate()]).length).toBeGreaterThan(0);
    expect(kernel.exportStep([]).ok).toBe(false);
    expect(leaked()).toEqual([]);
  });
});

describe("exported STEP re-imports with its semantics intact", () => {
  it("round-trips the built plate: exact volume, exact bounds, identical topology", () => {
    const plate = buildPlate();
    const bytes = exportBytes([plate]);

    // The plan's criterion, kernel-level: exported STEP re-imports.
    const imported = kernel.importStep(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.solids).toHaveLength(1);
    const solid = imported.value.solids[0]?.solid;
    if (solid === undefined) throw new Error("The import yielded no solid.");

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

    // Topology identity against the pre-export shape, through the raw
    // boundary (the same exploration the 21.3 suite pins with).
    const shapes = importStepShapes(oc(), bytes);
    if (!shapes.ok) throw new Error(shapes.error.message);
    const reimported = shapes.value.shapes[0];
    if (reimported === undefined) throw new Error("no re-imported shape");
    expect(topologyCounts(reimported)).toEqual({
      faces: 7,
      edges: 30,
      vertices: 60,
    });

    kernel.dispose(solid);
    kernel.dispose(plate);
  });

  it("exports multiple solids into ONE file that imports back as the same count with per-solid volumes", () => {
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
    const text = new TextDecoder().decode(bytes);
    // Structural sanity of the multi-solid file: one BREP solid entity per
    // exported solid (the independent structural reader lives in cad-io).
    expect(text.match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(3);

    const imported = kernel.importStep(bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.solids).toHaveLength(3);
    const volumes = imported.value.solids.map((ref) =>
      unwrapKernelResult(kernel.volume(ref.solid), "multi round-trip volume"),
    );
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

describe("STEP export options select unit and schema without leaking", () => {
  it("writes an INCH-declared file whose import canonicalizes back to the same mm geometry", () => {
    const plate = buildPlate();
    const inch = exportBytes([plate], { unit: "INCH" });
    const text = new TextDecoder().decode(inch);
    // The writer declares the conversion-based unit in the file…
    expect(text).toContain("CONVERSION_BASED_UNIT('INCH'");
    // …and the reader canonicalizes on import (the 21.3-verified behavior).
    const imported = kernel.importStep(inch);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const solid = imported.value.solids[0]?.solid;
    if (solid === undefined) throw new Error("The import yielded no solid.");
    const volume = unwrapKernelResult(kernel.volume(solid), "inch volume");
    expect(Math.abs(volume - ANALYTIC_VOLUME_MM3)).toBeLessThanOrEqual(
      ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_TOLERANCE,
    );
    kernel.dispose(solid);
    kernel.dispose(plate);
  });

  it("switches the FILE_SCHEMA under the schema option and restores the default after", () => {
    const plate = buildPlate();
    const ap214Default = exportBytes([plate]);
    expect(new TextDecoder().decode(ap214Default)).toContain(
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'))",
    );
    const ap203 = exportBytes([plate], { schema: "AP203" });
    expect(new TextDecoder().decode(ap203)).toContain(
      "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
    );
    // The process-global static is restored: the next default export is
    // byte-identical to the one taken before the override (and the schema
    // override is itself deterministic).
    expect([...exportBytes([plate])]).toEqual([...ap214Default]);
    expect([...exportBytes([plate], { schema: "AP203" })]).toEqual([...ap203]);
    kernel.dispose(plate);
  });
});

describe("STEP export rejects its inputs with structured step-export codes", () => {
  it("rejects the empty solid list", () => {
    const result = kernel.exportStep([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_EXPORT_ERROR_CODES.empty);
    }
  });

  it("rejects a foreign handle and a disposed handle with the kernel's solid-not-owned", () => {
    const otherKernel = occtKernelFromRuntime(runtime);
    const foreign = unwrapKernelResult(
      otherKernel.createSphere({ radius: mm(1) }),
      "createSphere",
    );
    const rejected = kernel.exportStep([foreign]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("kernel/solid-not-owned");
    }
    otherKernel.dispose(foreign);

    const disposed = buildPlate();
    kernel.dispose(disposed);
    const afterDispose = kernel.exportStep([disposed]);
    expect(afterDispose.ok).toBe(false);
    if (!afterDispose.ok) {
      expect(afterDispose.error.code).toBe("kernel/solid-not-owned");
    }
  });

  it("rejects unit and schema strings the binding's writer refuses", () => {
    // The typed kernel surface cannot even express these (the union types
    // carry the accepted sets); the wire path passes plain strings, so the
    // module-level boundary is where string rejection is pinned.
    const shapes = importStepShapes(oc(), FIXTURE_BYTES);
    if (!shapes.ok) throw new Error(shapes.error.message);
    const unit = exportStepShapes(oc(), shapes.value.shapes, {
      unit: "FURLONGS",
    });
    expect(unit.ok).toBe(false);
    if (!unit.ok) {
      expect(unit.error.code).toBe(STEP_EXPORT_ERROR_CODES.invalidUnit);
    }
    const schema = exportStepShapes(oc(), shapes.value.shapes, {
      schema: "AP9999",
    });
    expect(schema.ok).toBe(false);
    if (!schema.ok) {
      expect(schema.error.code).toBe(STEP_EXPORT_ERROR_CODES.invalidSchema);
    }
    for (const shape of shapes.value.shapes) shape.delete();
  });
});

describe("the raw export boundary is total", () => {
  it("refuses zero shapes with the structured empty code (module-level guard)", () => {
    const result = exportStepShapes(oc(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(STEP_EXPORT_ERROR_CODES.empty);
    }
  });
});
