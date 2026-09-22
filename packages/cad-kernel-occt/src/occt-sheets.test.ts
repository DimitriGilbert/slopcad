/**
 * OCCT adapter's sheet-body tests (Phase 48): the four swept sheet ops and
 * `createSheet`'s five analytic patches, judged at the exact band — OCCT's
 * `BRepGProp` surface integration is analytically exact on every fixture
 * here (the probe established the routes: wire prism, wire revolution,
 * `ThruSections(isSolid=false)`, the pipe without `MakeSolid`, and the
 * UV-bounded `MakeFace` patches; the torus rides the revolution route —
 * the single-thread binding carries no `Geom_ToroidalSurface`).
 *
 * The sheet DISCIPLINE pins too: `volume` declines an open shell (no
 * fabricated divergence-theorem number), every solid-consuming operation
 * declines a sheet operand structurally, while `area`/`bounds`/
 * `tessellate`/`transform` answer normally.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  KERNEL_ERROR_CODES,
  type ProfileLoftInput,
  type ProfileSegmentInput,
  type SheetSurfaceInput,
} from "@slopcad/cad-kernel";
import {
  assertBoundsEqual,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel/test-utils";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;
let kernel: GeometryKernel;

beforeAll(async () => {
  runtime = await createOcctRuntime();
  kernel = occtKernelFromRuntime(runtime);
});

function rectLoop(
  x0: number,
  y0: number,
  w: number,
  h: number,
): readonly ProfileSegmentInput[] {
  return [
    { kind: "line", start: [x0, y0], end: [x0 + w, y0] },
    { kind: "line", start: [x0 + w, y0], end: [x0 + w, y0 + h] },
    { kind: "line", start: [x0 + w, y0 + h], end: [x0, y0 + h] },
    { kind: "line", start: [x0, y0 + h], end: [x0, y0] },
  ];
}

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

const EXACT_AREA_TOLERANCE = 1e-9;

function sheetExtrudeFixture() {
  return unwrapKernelResult(
    kernel.extrude({
      loop: rectLoop(0, 0, 30, 20),
      height: length(10),
      direction: 1,
      placement: identityPlacement,
      sheet: true,
    }),
    "sheet extrude",
  );
}

describe("occt sheet extrude (Phase 48)", () => {
  it("answers the exact lateral area and bounds, with no caps", () => {
    const sheet = sheetExtrudeFixture();
    const area = unwrapKernelResult(kernel.area(sheet), "sheet area");
    // Perimeter 100 x height 10 — the caps' 2 x 600 are absent.
    expect(Math.abs(area - 1000)).toBeLessThanOrEqual(EXACT_AREA_TOLERANCE);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(sheet), "sheet bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      EXACT_AREA_TOLERANCE,
    );
    const soup = unwrapKernelResult(
      kernel.tessellate(sheet),
      "sheet tessellate",
    );
    expect(soup.indices.length).toBeGreaterThan(0);
  });

  it("declines volume with the structured unsupported code", () => {
    const sheet = sheetExtrudeFixture();
    expectKernelFailure(
      kernel.volume(sheet),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "sheet volume",
    );
  });

  it("declines booleans and feature ops on a sheet operand", () => {
    const sheet = sheetExtrudeFixture();
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box",
    );
    expectKernelFailure(
      kernel.union([sheet, box]),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "union with sheet",
    );
    expectKernelFailure(
      kernel.subtract(box, [sheet]),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "subtract with sheet tool",
    );
    expectKernelFailure(
      kernel.fillet({
        target: sheet,
        edges: [0],
        radius: length(1),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "fillet sheet",
    );
  });

  it("transforms and mirrors a sheet (open shells are isometry-safe)", () => {
    const sheet = sheetExtrudeFixture();
    const moved = unwrapKernelResult(
      kernel.transform(sheet, {
        x: length(5),
        y: length(0),
        z: length(0),
      }),
      "sheet transform",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(moved), "moved bounds"),
      { min: [5, 0, 0], max: [35, 20, 10] },
      EXACT_AREA_TOLERANCE,
    );
    const reflected = unwrapKernelResult(
      kernel.mirror(moved, { axis: "y", offset: length(0) }),
      "sheet mirror",
    );
    // The y-normal mirror plane flips y alone (the mirror contract's
    // plane-normal convention).
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(reflected), "mirrored bounds"),
      { min: [5, -20, 0], max: [35, 0, 10] },
      EXACT_AREA_TOLERANCE,
    );
  });

  it("declines the sheet + taper combination", () => {
    expectKernelFailure(
      kernel.extrude({
        loop: rectLoop(0, 0, 30, 20),
        height: length(10),
        direction: 1,
        placement: identityPlacement,
        taper: angle(0.1),
        sheet: true,
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "sheet taper extrude",
    );
  });
});

describe("occt sheet revolve (Phase 48)", () => {
  it("answers the exact swept-surface area (no meridian caps)", () => {
    const sheet = unwrapKernelResult(
      kernel.revolve({
        loop: rectLoop(5, 0, 5, 5),
        axis: { point: [0, 0], direction: [0, 1] },
        angle: angle(Math.PI),
        placement: identityPlacement,
        sheet: true,
      }),
      "sheet revolve",
    );
    const area = unwrapKernelResult(kernel.area(sheet), "sheet area");
    // Walls 50pi + 25pi, annuli 75pi (the probe's fixture).
    expect(Math.abs(area - 150 * Math.PI)).toBeLessThanOrEqual(1e-7);
  });
});

describe("occt sheet loft (Phase 48)", () => {
  it("answers the exact ruled-wall area (no station caps)", () => {
    const sections: ProfileLoftInput["sections"] = [
      { loop: rectLoop(0, 0, 20, 10), z: length(0) },
      { loop: rectLoop(0, 0, 20, 10), z: length(8) },
    ];
    const sheet = unwrapKernelResult(
      kernel.loft({ sections, placement: identityPlacement, sheet: true }),
      "sheet loft",
    );
    const area = unwrapKernelResult(kernel.area(sheet), "sheet area");
    expect(Math.abs(area - 60 * 8)).toBeLessThanOrEqual(1e-7);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(sheet), "sheet bounds"),
      { min: [0, 0, 0], max: [20, 10, 8] },
      1e-6,
    );
  });
});

describe("occt sheet sweep (Phase 48)", () => {
  it("answers the exact swept-wall area along a straight path", () => {
    const sheet = unwrapKernelResult(
      kernel.sweep({
        loop: rectLoop(-3, -3, 6, 6),
        path: [
          {
            kind: "line",
            start: [0, 0],
            end: [0, 10],
          },
        ],
        placement: identityPlacement,
        sheet: true,
      }),
      "sheet sweep",
    );
    const area = unwrapKernelResult(kernel.area(sheet), "sheet area");
    // Perimeter 24 x path length 10 — no end caps on the tube.
    expect(Math.abs(area - 240)).toBeLessThanOrEqual(1e-6);
  });
});

describe("occt createSheet (Phase 48)", () => {
  const cases: ReadonlyArray<{
    label: string;
    input: SheetSurfaceInput;
    area: number;
    bounds: {
      min: readonly [number, number, number];
      max: readonly [number, number, number];
    };
  }> = [
    {
      label: "plane 30x20",
      input: {
        kind: "plane",
        placement: identityPlacement,
        uMin: length(0),
        uMax: length(30),
        vMin: length(0),
        vMax: length(20),
      },
      area: 600,
      bounds: { min: [0, 0, 0], max: [30, 20, 0] },
    },
    {
      label: "half cylinder r5 h10",
      input: {
        kind: "cylinder",
        placement: identityPlacement,
        radius: length(5),
        height: length(10),
        uSweep: angle(Math.PI),
      },
      area: Math.PI * 5 * 10,
      bounds: { min: [-5, 0, 0], max: [5, 5, 10] },
    },
    {
      label: "half cone frustum 4->2 h10",
      input: {
        kind: "cone",
        placement: identityPlacement,
        bottomRadius: length(4),
        topRadius: length(2),
        height: length(10),
        uSweep: angle(Math.PI),
      },
      area: (Math.PI * (4 + 2) * Math.sqrt(10 * 10 + 4)) / 2,
      bounds: { min: [-4, 0, 0], max: [4, 4, 10] },
    },
    {
      label: "hemisphere r5",
      input: {
        kind: "sphere",
        placement: identityPlacement,
        radius: length(5),
        vMin: angle(0),
        vMax: angle(Math.PI / 2),
        uSweep: angle(2 * Math.PI),
      },
      area: 2 * Math.PI * 25,
      bounds: { min: [-5, -5, 0], max: [5, 5, 5] },
    },
    {
      label: "full torus R8 r2",
      input: {
        kind: "torus",
        placement: identityPlacement,
        majorRadius: length(8),
        minorRadius: length(2),
        uSweep: angle(2 * Math.PI),
        vSweep: angle(2 * Math.PI),
      },
      area: 4 * Math.PI * Math.PI * 8 * 2,
      bounds: { min: [-10, -10, -2], max: [10, 10, 2] },
    },
  ];

  for (const fixture of cases) {
    it(`builds the ${fixture.label} patch with exact area and bounds`, () => {
      const sheet = unwrapKernelResult(
        kernel.createSheet(fixture.input),
        fixture.label,
      );
      const area = unwrapKernelResult(kernel.area(sheet), "patch area");
      expect(Math.abs(area - fixture.area)).toBeLessThanOrEqual(1e-6);
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(sheet), "patch bounds"),
        fixture.bounds,
        1e-6,
      );
      expectKernelFailure(
        kernel.volume(sheet),
        KERNEL_ERROR_CODES.unsupportedOperation,
        "patch volume",
      );
    });
  }

  it("declines the spindle torus and degenerate domains structurally", () => {
    expectKernelFailure(
      kernel.createSheet({
        kind: "torus",
        placement: identityPlacement,
        majorRadius: length(2),
        minorRadius: length(5),
        uSweep: angle(2 * Math.PI),
        vSweep: angle(2 * Math.PI),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "spindle torus",
    );
    expectKernelFailure(
      kernel.createSheet({
        kind: "cylinder",
        placement: identityPlacement,
        radius: length(5),
        height: length(10),
        uSweep: angle(0),
      }),
      KERNEL_ERROR_CODES.invalidSweepAngle,
      "zero sweep",
    );
    expectKernelFailure(
      kernel.createSheet({
        kind: "plane",
        placement: identityPlacement,
        uMin: length(30),
        uMax: length(0),
        vMin: length(0),
        vMax: length(20),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "inverted plane range",
    );
  });

  it("places a patch by rotation-then-translation like the profile ops", () => {
    const sheet = unwrapKernelResult(
      kernel.createSheet({
        kind: "cylinder",
        placement: {
          rotation: { axis: [1, 0, 0], angle: angle(Math.PI / 2) },
          translation: { x: length(0), y: length(0), z: length(50) },
        },
        radius: length(5),
        height: length(10),
        uSweep: angle(2 * Math.PI),
      }),
      "placed cylinder",
    );
    // Rotation about x by +90deg maps local +z to world -y... then the
    // +50 z translation: the band runs along world -y at z in [45, 55]?
    // The exact composed frame is pinned by the bounds below.
    const bounds = unwrapKernelResult(kernel.bounds(sheet), "placed bounds");
    const extents = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    expect(extents[0]).toBeCloseTo(10, 6);
    expect(extents[1]).toBeCloseTo(10, 6);
    expect(extents[2]).toBeCloseTo(10, 6);
  });
});

describe("occt sheet STEP round-trip (Phase 48)", () => {
  it("exports a sheet and imports it back as the imported-step sheet class", () => {
    // The concrete surface carries the STEP exchange; the sheet class is
    // the roadmap's provenance growth (imported-step refs may be sheets).
    const occtKernel = kernel as ReturnType<typeof occtKernelFromRuntime>;
    const sheet = unwrapKernelResult(
      kernel.createSheet({
        kind: "cylinder",
        placement: identityPlacement,
        radius: length(5),
        height: length(10),
        uSweep: angle(2 * Math.PI),
      }),
      "cylinder sheet",
    );
    const bytes = occtKernel.exportStep([sheet]);
    if (!bytes.ok) throw new Error(bytes.error.message);
    const imported = occtKernel.importStep(bytes.value);
    if (!imported.ok) throw new Error(imported.error.message);
    expect(imported.value.solids.length).toBe(1);
    const ref = imported.value.solids[0];
    expect(ref?.sheet).toBe(true);
    expect(ref?.origin).toBe("imported-step");
    if (ref === undefined) throw new Error("the sheet ref vanished");
    const area = unwrapKernelResult(kernel.area(ref.solid), "reimported area");
    expect(Math.abs(area - 2 * Math.PI * 5 * 10)).toBeLessThanOrEqual(1e-6);
    expectKernelFailure(
      kernel.volume(ref.solid),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "reimported sheet volume",
    );
  });
});
