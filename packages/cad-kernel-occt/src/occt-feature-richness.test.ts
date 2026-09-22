/**
 * OCCT-adapter Phase 41 feature-richness tests: everything the shared
 * contract suite does not prove about the three new engine-backed
 * surfaces — the draft taper's `BRepOffsetAPI_DraftAngle` route (the
 * prismatoid-exact box, the cone-frustum cylinder, the CONCAVE L-prism's
 * miter quadratic, the direction=−1 footing, and the ellipse-loop subset
 * decline), the uniform scale's `gp_Trsf.SetScale` composition (×f³
 * volume, ×f bounds, translation-after-scale order, mirrored-vs-scaled
 * rejection), and the thicken's cavity composition (the exact closed
 * hollow on the box and the sphere shell, the too-thick post-condition,
 * and the probed negative-offset degeneracy the adapter refuses
 * structurally).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertVolumeClose,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import type { KernelSolid, ProfileExtrudeInput } from "@slopcad/cad-kernel";

import { occtKernelFromRuntime, type OcctKernel } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

function makeKernel(): OcctKernel {
  return occtKernelFromRuntime(runtime);
}

function box(
  kernel: OcctKernel,
  width = 30,
  depth = 20,
  height = 10,
): KernelSolid {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(width),
      depth: length(depth),
      height: length(height),
    }),
    "createBox",
  );
}

const IDENTITY_PLACEMENT: ProfileExtrudeInput["placement"] = {
  rotation: { axis: [0, 0, 1], angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

const RECTANGLE_LOOP: ProfileExtrudeInput["loop"] = [
  { kind: "line", start: [0, 0], end: [30, 0] },
  { kind: "line", start: [30, 0], end: [30, 20] },
  { kind: "line", start: [30, 20], end: [0, 20] },
  { kind: "line", start: [0, 20], end: [0, 0] },
];

/** The concave L the prespike probe agreed on (A0 = 500, P0 = 100, κ = 4). */
const L_LOOP: ProfileExtrudeInput["loop"] = [
  { kind: "line", start: [0, 0], end: [30, 0] },
  { kind: "line", start: [30, 0], end: [30, 20] },
  { kind: "line", start: [30, 20], end: [10, 20] },
  { kind: "line", start: [10, 20], end: [10, 10] },
  { kind: "line", start: [10, 10], end: [0, 10] },
  { kind: "line", start: [0, 10], end: [0, 0] },
];

describe("occt extrude draft taper (Phase 41)", () => {
  it("drafts the rectangle prism to the exact prismatoid (the probe's value)", () => {
    const kernel = makeKernel();
    const alpha = (5 * Math.PI) / 180;
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "tapered extrude",
    );
    // The prespike probe's own measurement: 5572.762370697783 — the
    // miter quadratic at 15-digit agreement.
    const inset = 10 * Math.tan(alpha);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      10 * (600 - 100 * (inset / 2) + (4 / 3) * inset * inset),
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("drafts the cylinder to the exact cone frustum", () => {
    const kernel = makeKernel();
    const alpha = (3 * Math.PI) / 180;
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: [{ kind: "circle", center: [0, 0], radius: 5 }],
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "tapered circle extrude",
    );
    const r2 = 5 - 10 * Math.tan(alpha);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      (Math.PI * 10 * (25 + 5 * r2 + r2 * r2)) / 3,
      1e-12,
    );
  });

  it("drafts the concave L-prism to the miter quadratic (concavity included)", () => {
    const kernel = makeKernel();
    const alpha = (3 * Math.PI) / 180;
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: L_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "tapered L extrude",
    );
    const inset = 10 * Math.tan(alpha);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      10 * (500 - 100 * (inset / 2) + (4 / 3) * inset * inset),
      1e-12,
    );
  });

  it("drafts the negative direction below the profile plane with the same volume", () => {
    const kernel = makeKernel();
    const alpha = (5 * Math.PI) / 180;
    const down = unwrapKernelResult(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: -1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "downward tapered extrude",
    );
    const inset = 10 * Math.tan(alpha);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(down), "volume"),
      10 * (600 - 100 * (inset / 2) + (4 / 3) * inset * inset),
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(down), "bounds"),
      { min: [0, 0, -10], max: [30, 20, 0] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("widens on the negative draft (the outset direction)", () => {
    const kernel = makeKernel();
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle((-3 * Math.PI) / 180),
      }),
      "widening extrude",
    );
    const h = 10 * Math.tan((3 * Math.PI) / 180);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      10 * (600 + 100 * (h / 2) + (4 / 3) * h * h),
      1e-12,
    );
  });

  it("declines the ellipse-loop taper and the degenerate battery structurally", () => {
    const kernel = makeKernel();
    expectKernelFailure(
      kernel.extrude({
        loop: [
          {
            kind: "ellipse",
            center: [0, 0],
            radiusX: 8,
            radiusY: 4.5,
            rotation: angle(0),
          },
        ],
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(0.05),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
    );
    expectKernelFailure(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(Math.PI / 2),
      }),
      KERNEL_ERROR_CODES.invalidTaper,
    );
    // tan(84.3°)·10 ≫ 10 mm collapses the 20 mm-deep rectangle.
    expectKernelFailure(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle((84.3 * Math.PI) / 180),
      }),
      KERNEL_ERROR_CODES.invalidTaper,
    );
  });

  it("keeps the untapered prism exact when the field is absent or zero", () => {
    const kernel = makeKernel();
    for (const taper of [undefined, angle(0)]) {
      const solid = unwrapKernelResult(
        kernel.extrude({
          loop: RECTANGLE_LOOP,
          height: length(10),
          direction: 1,
          placement: IDENTITY_PLACEMENT,
          ...(taper === undefined ? {} : { taper }),
        }),
        "plain extrude",
      );
      expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBe(6000);
    }
  });
});

describe("occt transform uniform scale (Phase 41)", () => {
  it("scales the box by f³ with ×f bounds about the origin, then translates", () => {
    const kernel = makeKernel();
    const target = box(kernel);
    const scaled = unwrapKernelResult(
      kernel.transform(target, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 2,
      }),
      "scale transform",
    );
    // The prespike probe's own measurements: 48 000 mm³, [0,60]×[0,40]×[0,20].
    expect(unwrapKernelResult(kernel.volume(scaled), "volume")).toBe(48000);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(scaled), "bounds"),
      { min: [0, 0, 0], max: [60, 40, 20] },
      EXACT_BOUNDS_TOLERANCE,
    );
    const moved = unwrapKernelResult(
      kernel.transform(target, {
        x: length(5),
        y: length(0),
        z: length(0),
        scale: 2,
      }),
      "scale + translate",
    );
    // p ↦ s·R·p + t: the box spans x ∈ [5, 65].
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(moved), "bounds"),
      { min: [5, 0, 0], max: [65, 40, 20] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("scales a boolean exactly and rejects non-positive factors", () => {
    const kernel = makeKernel();
    const plate = unwrapKernelResult(
      kernel.subtract(box(kernel), [
        unwrapKernelResult(
          kernel.createCylinder({ radius: length(5), height: length(10) }),
          "bore",
        ),
      ]),
      "plate",
    );
    const scaled = unwrapKernelResult(
      kernel.transform(plate, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 3,
      }),
      "scaled plate",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(scaled), "volume"),
      unwrapKernelResult(kernel.volume(plate), "volume") * 27,
      1e-9,
    );
    expectKernelFailure(
      kernel.transform(box(kernel), {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 0,
      }),
      KERNEL_ERROR_CODES.invalidLength,
    );
    expectKernelFailure(
      kernel.transform(box(kernel), {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: -2,
      }),
      KERNEL_ERROR_CODES.invalidLength,
    );
  });
});

describe("occt thicken (Phase 41)", () => {
  it("hollows the box into the exact closed shell (the probe's composition)", () => {
    const kernel = makeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.thicken({ target, thickness: length(2) }),
      "box thicken",
    );
    // The prespike probe's own measurement: 6 000 − 2 496 = 3 504 exactly.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      3504,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("hollows the sphere into the exact closed shell", () => {
    const kernel = makeKernel();
    const target = unwrapKernelResult(
      kernel.createSphere({ radius: length(10) }),
      "createSphere",
    );
    const solid = unwrapKernelResult(
      kernel.thicken({ target, thickness: length(2) }),
      "sphere thicken",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      (4 / 3) * Math.PI * (1000 - 512),
      1e-9,
    );
  });

  it("refuses the too-thick degeneracy with the structured post-condition", () => {
    const kernel = makeKernel();
    expectKernelFailure(
      kernel.thicken({ target: box(kernel), thickness: length(5) }),
      KERNEL_ERROR_CODES.thickenFailed,
    );
    expectKernelFailure(
      kernel.thicken({ target: box(kernel), thickness: length(0) }),
      KERNEL_ERROR_CODES.invalidLength,
    );
  });
});
