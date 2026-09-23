/**
 * OCCT adapter's surface-operation tests (Phase 49): the trim family,
 * knit/unstitch, the analytic extend/offset rebuilds, the B-spline fill,
 * the sheet-to-solid thickening, and the face-addressed pair — judged at
 * the exact band (every analytic fixture is derivable in closed form; the
 * B-spline fill is the one documented approximation band, its patch
 * surface a `Geom_BSplineSurface` by construction).
 *
 * The convention pins the validator re-derives: the trim family rides the
 * same-dimension OCCT booleans (Common/Cut on open shells), extend/offset
 * rebuild each face over its OWN underlying surface at widened/shifted
 * parameters, `MakeThickSolidBySimple` carries the sheet-to-solid route
 * (open shell in, solid out), and knit closes when the sewed shell bounds
 * a measurable volume.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  KERNEL_ERROR_CODES,
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

const EXACT_AREA_TOLERANCE_DECIMALS = 9;

function planeSheetHandle(
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  z = 0,
) {
  return unwrapKernelResult(
    kernel.createSheet({
      kind: "plane",
      placement: {
        rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
        translation: { x: length(0), y: length(0), z: length(z) },
      },
      uMin: length(uMin),
      uMax: length(uMax),
      vMin: length(vMin),
      vMax: length(vMax),
    } satisfies SheetSurfaceInput),
    "plane sheet",
  );
}

function spherePatch(
  radius: number,
  vMin: number,
  vMax: number,
  uSweep: number,
) {
  return unwrapKernelResult(
    kernel.createSheet({
      kind: "sphere",
      placement: identityPlacement,
      radius: length(radius),
      vMin: angle(vMin),
      vMax: angle(vMax),
      uSweep: angle(uSweep),
    } satisfies SheetSurfaceInput),
    "sphere patch",
  );
}

function cylinderSheet(radius: number, height: number, uSweep: number) {
  return unwrapKernelResult(
    kernel.createSheet({
      kind: "cylinder",
      placement: identityPlacement,
      radius: length(radius),
      height: length(height),
      uSweep: angle(uSweep),
    } satisfies SheetSurfaceInput),
    "cylinder sheet",
  );
}

describe("occt trimSheet (Phase 49)", () => {
  it("keeps the exact common region of two crossing plane sheets", () => {
    // A 30 x 20 sheet trimmed to its u in [10, 20] band by a crossing
    // tool — the kept area is exactly 10 x 20 = 200 mm².
    const sheet = planeSheetHandle(0, 30, 0, 20);
    const tool = planeSheetHandle(10, 20, -100, 100);
    const trimmed = unwrapKernelResult(
      kernel.trimSheet({ sheet, tool, keepInside: true }),
      "trim keep",
    );
    expect(unwrapKernelResult(kernel.area(trimmed), "kept area")).toBeCloseTo(
      200,
      EXACT_AREA_TOLERANCE_DECIMALS,
    );
  });

  it("cuts the tool's region away on keepInside false", () => {
    const sheet = planeSheetHandle(0, 30, 0, 20);
    const tool = planeSheetHandle(10, 20, -100, 100);
    const cut = unwrapKernelResult(
      kernel.trimSheet({ sheet, tool, keepInside: false }),
      "trim cut",
    );
    // Two flanks of 10 x 20 each — 400 mm².
    expect(unwrapKernelResult(kernel.area(cut), "cut area")).toBeCloseTo(
      400,
      EXACT_AREA_TOLERANCE_DECIMALS,
    );
  });

  it("trims a sphere patch by a plane sheet to the exact spherical zone", () => {
    // A half-sphere patch (polar 0..π/2, full azimuth) trimmed by the
    // z = r/2 horizontal plane sheet, keeping the cap: the zone's exact
    // area is 2πr·h with h = r/2 — π r².
    const r = 10;
    const sheet = spherePatch(r, 0, Math.PI / 2, 2 * Math.PI);
    const tool = planeSheetHandle(-100, 100, -100, 100, r / 2);
    const kept = unwrapKernelResult(
      kernel.trimSheet({ sheet, tool, keepInside: true }),
      "sphere trim",
    );
    expect(unwrapKernelResult(kernel.area(kept), "zone area")).toBeCloseTo(
      Math.PI * r * r,
      6,
    );
  });

  it("declares the empty overlap with the structured surface-trim-empty", () => {
    const sheet = planeSheetHandle(0, 10, 0, 10, 0);
    const tool = planeSheetHandle(0, 10, 0, 10, 5);
    expectKernelFailure(
      kernel.trimSheet({ sheet, tool, keepInside: true }),
      KERNEL_ERROR_CODES.surfaceTrimEmpty,
      "disjoint sheets",
    );
  });
});

describe("occt untrimSheet (Phase 49)", () => {
  it("restores the trimmed sphere patch to the full 4πr² natural bounds", () => {
    const patch = spherePatch(10, Math.PI / 4, Math.PI / 2, Math.PI / 2);
    const untrimmed = unwrapKernelResult(
      kernel.untrimSheet({ sheet: patch }),
      "untrim",
    );
    expect(
      unwrapKernelResult(kernel.area(untrimmed), "natural area"),
    ).toBeCloseTo(4 * Math.PI * 100, EXACT_AREA_TOLERANCE_DECIMALS);
    expectKernelFailure(
      kernel.untrimSheet({ sheet: planeSheetHandle(0, 10, 0, 10) }),
      KERNEL_ERROR_CODES.surfaceUntrimUnsupported,
      "open-ended plane",
    );
  });
});

describe("occt extendSheet (Phase 49)", () => {
  it("grows a plane patch symmetrically on both axes", () => {
    const extended = unwrapKernelResult(
      kernel.extendSheet({
        sheet: planeSheetHandle(0, 10, 0, 10),
        uDelta: length(5),
        vDelta: length(2),
      }),
      "extend plane",
    );
    const area = unwrapKernelResult(kernel.area(extended), "extended area");
    expect(area).toBeCloseTo(20 * 14, EXACT_AREA_TOLERANCE_DECIMALS);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(extended), "extended bounds"),
      { min: [-5, -2, 0], max: [15, 12, 0] },
      1e-9,
    );
  });

  it("grows a half-cylinder to the full turn in u and freely in v", () => {
    const half = cylinderSheet(10, 10, Math.PI);
    const full = unwrapKernelResult(
      kernel.extendSheet({
        sheet: half,
        uDelta: length(Math.PI / 2),
        vDelta: length(3),
      }),
      "extend cylinder",
    );
    // Full cylinder r = 10, height 10 + 2·3: 2π·10·16.
    expect(unwrapKernelResult(kernel.area(full), "full cylinder")).toBeCloseTo(
      2 * Math.PI * 10 * 16,
      6,
    );
  });

  it("refuses an azimuth delta past the full turn and a zero delta", () => {
    const half = cylinderSheet(10, 10, Math.PI * 1.5);
    expectKernelFailure(
      kernel.extendSheet({
        sheet: half,
        uDelta: length(Math.PI),
        vDelta: length(1),
      }),
      KERNEL_ERROR_CODES.surfaceExtendInvalid,
      "u past full turn",
    );
    expectKernelFailure(
      kernel.extendSheet({
        sheet: planeSheetHandle(0, 10, 0, 10),
        uDelta: length(0),
        vDelta: length(1),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "zero delta",
    );
  });
});

describe("occt knit and unstitch (Phase 49)", () => {
  it("closes a torn-open solid back into a measurable volume", () => {
    // A 10 x 10 x 10 box torn open by deleteFaceKeepSurface: the
    // remainder is an open shell (volume declines), the extracted face a
    // standalone sheet. Knitting the two back sews a CLOSED shell — the
    // knit-closure fixture: the answer is a SOLID again, and its volume
    // is measurable: exactly 1000 mm³.
    const boxSolid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box",
    );
    const torn = unwrapKernelResult(
      kernel.deleteFaceKeepSurface({ target: boxSolid, face: 2 }),
      "tear open",
    );
    expectKernelFailure(
      kernel.volume(torn.remainder),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "open remainder volume",
    );
    const closed = unwrapKernelResult(
      kernel.knit({
        bodies: [torn.remainder, torn.face],
        tolerance: length(0.001),
      }),
      "knit closure",
    );
    expect(
      unwrapKernelResult(kernel.volume(closed), "closed volume"),
    ).toBeCloseTo(1000, EXACT_AREA_TOLERANCE_DECIMALS);
  });

  it("sews a sheet into a solid's own faces (the sheet+solid case)", () => {
    const boxSolid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box",
    );
    const cap = planeSheetHandle(-50, 50, -50, 50, 10);
    const sewed = unwrapKernelResult(
      kernel.knit({ bodies: [boxSolid, cap], tolerance: length(0.001) }),
      "knit sheet+solid",
    );
    // The sheet covers the box's own top face region — the sew closes
    // (or stays a boundary-consistent shell); either way the solid's
    // material volume is unchanged and measurable only if closed.
    const volume = kernel.volume(sewed);
    if (volume.ok) {
      expect(volume.value).toBeCloseTo(1000, EXACT_AREA_TOLERANCE_DECIMALS);
    } else {
      // The open-shell answer: the area carries the sheet's overhang.
      const area = unwrapKernelResult(kernel.area(sewed), "sewed area");
      expect(area).toBeGreaterThanOrEqual(600);
    }
  });

  it("explodes a solid and a sheet into face soup with preserved area", () => {
    const boxSolid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box",
    );
    const soup = unwrapKernelResult(
      kernel.unstitch({ body: boxSolid }),
      "solid soup",
    );
    expect(unwrapKernelResult(kernel.area(soup), "soup area")).toBeCloseTo(
      600,
      EXACT_AREA_TOLERANCE_DECIMALS,
    );
    expectKernelFailure(
      kernel.volume(soup),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "soup volume",
    );
    const sheetSoup = unwrapKernelResult(
      kernel.unstitch({ body: planeSheetHandle(0, 10, 0, 10) }),
      "sheet soup",
    );
    expect(
      unwrapKernelResult(kernel.area(sheetSoup), "sheet soup area"),
    ).toBeCloseTo(100, EXACT_AREA_TOLERANCE_DECIMALS);
  });
});

describe("occt fillPatch (Phase 49)", () => {
  it("fills a rectangular loop with a B-spline patch at the planar band", () => {
    const patch = unwrapKernelResult(
      kernel.fillPatch({
        loop: rectLoop(0, 0, 10, 20),
        placement: identityPlacement,
      }),
      "fill rect",
    );
    const area = unwrapKernelResult(kernel.area(patch), "patch area");
    // The B-spline patch approximates the planar region: 200 mm² at the
    // documented approximation band (not the exact band — the surface is
    // a Geom_BSplineSurface by construction).
    expect(area).toBeGreaterThan(198);
    expect(area).toBeLessThan(202);
  });

  it("places the patch by the rotation-then-translation composition", () => {
    const patch = unwrapKernelResult(
      kernel.fillPatch({
        loop: rectLoop(0, 0, 10, 10),
        placement: {
          rotation: { axis: [1, 0, 0] as const, angle: angle(Math.PI / 2) },
          translation: { x: length(0), y: length(0), z: length(5) },
        },
      }),
      "fill placed",
    );
    const bounds = unwrapKernelResult(kernel.bounds(patch), "patch bounds");
    // Local (u, v, 0) → world (u, 0, v) then translated +5 z: the patch
    // lies in y = 0, z in [5, 15].
    expect(bounds.min[1]).toBeCloseTo(0, 6);
    expect(bounds.max[1]).toBeCloseTo(0, 6);
    expect(bounds.min[2]).toBeCloseTo(5, 6);
    expect(bounds.max[2]).toBeCloseTo(15, 6);
  });

  it("rejects an open boundary loop with the structured surface-patch-failed", () => {
    expectKernelFailure(
      kernel.fillPatch({
        loop: [
          { kind: "line", start: [0, 0], end: [10, 0] },
          { kind: "line", start: [10, 0], end: [10, 10] },
        ],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.surfacePatchFailed,
      "open loop",
    );
  });
});

describe("occt offsetSheet (Phase 49)", () => {
  it("moves a plane patch along its normal, preserving area", () => {
    const offset = unwrapKernelResult(
      kernel.offsetSheet({
        sheet: planeSheetHandle(0, 10, 0, 10),
        distance: length(3),
      }),
      "offset plane",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(offset), "offset bounds"),
      { min: [0, 0, 3], max: [10, 10, 3] },
      1e-9,
    );
  });

  it("drives a cylinder's radius exactly (negative distance inward)", () => {
    const sheet = cylinderSheet(10, 10, 2 * Math.PI);
    const inward = unwrapKernelResult(
      kernel.offsetSheet({ sheet, distance: length(-2) }),
      "offset cylinder",
    );
    expect(unwrapKernelResult(kernel.area(inward), "r8 area")).toBeCloseTo(
      2 * Math.PI * 8 * 10,
      6,
    );
  });

  it("refuses a radius-inverting distance and a zero distance", () => {
    const sheet = cylinderSheet(10, 10, 2 * Math.PI);
    expectKernelFailure(
      kernel.offsetSheet({ sheet, distance: length(-12) }),
      KERNEL_ERROR_CODES.surfaceOffsetFailed,
      "inverting distance",
    );
    expectKernelFailure(
      kernel.offsetSheet({ sheet, distance: length(0) }),
      KERNEL_ERROR_CODES.surfaceOffsetFailed,
      "zero distance",
    );
  });
});

describe("occt thickenSheet (Phase 49)", () => {
  it("builds the exact prism volume from a plane patch (volume x area·t)", () => {
    const thickened = unwrapKernelResult(
      kernel.thickenSheet({
        sheet: planeSheetHandle(0, 30, 0, 20),
        thickness: length(2),
        side: 1,
      }),
      "thicken plane",
    );
    // Developable plane: NO curvature term — volume exactly area x t.
    expect(
      unwrapKernelResult(kernel.volume(thickened), "prism volume"),
    ).toBeCloseTo(30 * 20 * 2, EXACT_AREA_TOLERANCE_DECIMALS);
    // Convention pin: the engine's BySimple offset for a +z-normal
    // createSheet plane patch with side +1. Observed against the probe
    // run — the wall grows toward +z (along the carried normal).
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(thickened), "thicken bounds"),
      { min: [0, 0, 0], max: [30, 20, 2] },
      1e-9,
    );
  });

  it("thickens a cylinder shell with the exact developable volume", () => {
    const sheet = cylinderSheet(10, 10, 2 * Math.PI);
    const thickened = unwrapKernelResult(
      kernel.thickenSheet({ sheet, thickness: length(2), side: 1 }),
      "thicken cylinder",
    );
    // Developable in the wall direction: π(r+t)²h − πr²h.
    const expected = Math.PI * 12 * 12 * 10 - Math.PI * 10 * 10 * 10;
    expect(
      unwrapKernelResult(kernel.volume(thickened), "tube volume"),
    ).toBeCloseTo(expected, 6);
  });

  it("thickens on the mirrored side with side -1", () => {
    const down = unwrapKernelResult(
      kernel.thickenSheet({
        sheet: planeSheetHandle(0, 10, 0, 10),
        thickness: length(2),
        side: -1,
      }),
      "thicken down",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(down), "down bounds"),
      { min: [0, 0, -2], max: [10, 10, 0] },
      1e-9,
    );
  });
});

describe("occt replaceFaceWithSheet (Phase 49)", () => {
  it("replaces the box top with a lowered coplanar sheet, cutting the slab", () => {
    const boxSolid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box",
    );
    const cover = planeSheetHandle(-50, 50, -50, 50, 9);
    // The box's top face ordinal: the Phase 44 snapshot's face walk —
    // face 2 carries +z on the canonical box (the moveFace fixture's
    // top-face hint); resolved through the snapshot convention below.
    const replaced = unwrapKernelResult(
      kernel.replaceFaceWithSheet({ target: boxSolid, face: 5, sheet: cover }),
      "replace top",
    );
    const volume = unwrapKernelResult(
      kernel.volume(replaced),
      "replaced volume",
    );
    expect(volume).toBeCloseTo(900, EXACT_AREA_TOLERANCE_DECIMALS);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(replaced), "replaced bounds"),
      { min: [0, 0, 0], max: [10, 10, 9] },
      1e-9,
    );
  });

  it("refuses a sheet that does not cover the addressed face", () => {
    const boxSolid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box",
    );
    const small = planeSheetHandle(0, 1, 0, 1, 10);
    expectKernelFailure(
      kernel.replaceFaceWithSheet({ target: boxSolid, face: 5, sheet: small }),
      KERNEL_ERROR_CODES.surfaceReplaceFailed,
      "uncovered face",
    );
  });
});

describe("occt deleteFaceKeepSurface (Phase 49)", () => {
  it("extracts the addressed face as a sheet and leaves an open-shell remainder", () => {
    const boxSolid = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "box",
    );
    const result = unwrapKernelResult(
      kernel.deleteFaceKeepSurface({ target: boxSolid, face: 2 }),
      "delete keep",
    );
    expect(
      unwrapKernelResult(kernel.area(result.face), "extracted face"),
    ).toBeCloseTo(100, EXACT_AREA_TOLERANCE_DECIMALS);
    expect(
      unwrapKernelResult(kernel.area(result.remainder), "remainder shell"),
    ).toBeCloseTo(500, EXACT_AREA_TOLERANCE_DECIMALS);
    expectKernelFailure(
      kernel.volume(result.remainder),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "remainder volume",
    );
    expectKernelFailure(
      kernel.deleteFaceKeepSurface({ target: boxSolid, face: 999 }),
      KERNEL_ERROR_CODES.faceOpFaceUnknown,
      "stale ordinal",
    );
  });
});

describe("occt surface workflow (Phase 49 e2e chain, kernel level)", () => {
  it("loft sheet -> trim -> thicken -> fillet the solid", () => {
    // 1. A sheet loft: the 30 x 20 wall set over two stations.
    const loftSheet = unwrapKernelResult(
      kernel.loft({
        sections: [
          { loop: rectLoop(0, 0, 30, 20), z: length(0) },
          { loop: rectLoop(0, 0, 30, 20), z: length(10) },
        ],
        placement: identityPlacement,
        sheet: true,
      }),
      "sheet loft",
    );
    const loftArea = unwrapKernelResult(kernel.area(loftSheet), "loft walls");
    expect(loftArea).toBeCloseTo(2 * (30 + 20) * 10, 6);
    // 2. Trim: the y = 0 wall plane's own tool keeps ONE wall's upper band
    // (the same-plane region route — Common of the wall with a tool lying
    // in its plane): a single 30 x 5 face, 150 mm².
    const tool = unwrapKernelResult(
      kernel.createSheet({
        kind: "plane",
        placement: {
          rotation: { axis: [1, 0, 0] as const, angle: angle(Math.PI / 2) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
        uMin: length(0),
        uMax: length(30),
        vMin: length(5),
        vMax: length(10),
      }),
      "workflow tool",
    );
    const trimmed = unwrapKernelResult(
      kernel.trimSheet({ sheet: loftSheet, tool, keepInside: true }),
      "workflow trim",
    );
    expect(
      unwrapKernelResult(kernel.area(trimmed), "trimmed walls"),
    ).toBeCloseTo(150, 6);
    // 3. Thicken into a solid — the single planar face is the exact
    // developable case: 30 x 5 x 2 = 300 mm³, measurable.
    const thickened = unwrapKernelResult(
      kernel.thickenSheet({
        sheet: trimmed,
        thickness: length(2),
        side: 1,
      }),
      "workflow thicken",
    );
    const thickenedVolume = unwrapKernelResult(
      kernel.volume(thickened),
      "workflow volume",
    );
    expect(thickenedVolume).toBeCloseTo(300, 6);
    // 4. Fillet the solid's rim edges — a fillet-capable kernel answers.
    const filleted = kernel.fillet({
      target: thickened,
      edges: [0],
      radius: length(1),
    });
    expect(filleted.ok).toBe(true);
    if (filleted.ok) {
      const volume = unwrapKernelResult(
        kernel.volume(filleted.value),
        "fillet volume",
      );
      // A 1 mm rim fillet removes material — strictly below the unfilleted
      // volume, never above it.
      expect(volume).toBeLessThan(thickenedVolume);
    }
  });
});
