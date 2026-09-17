/**
 * JSCAD-adapter-specific tests (Phase 23): the semantic geometry and
 * structured-failure behaviours beyond what the shared contract suite
 * already judges — the honest capability declaration, LengthValue unit
 * grounding, the measured curved/boolean bands on the mirrored fixtures,
 * the rotation guard against JSCAD's silent-identity axis degeneracy, the
 * no-throw boundary for non-finite dynamically-parsed inputs, disposal
 * observability, and the documented normals omission.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import type { LengthValue } from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  type GeometryKernel,
  KERNEL_BACKEND_IDS,
  KERNEL_ERROR_CODES,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import { CURVED_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";

import { buildBooleanChain, buildPlateWithHole } from "./jscad-fixtures";
import {
  createJscadKernel,
  JSCAD_KERNEL_CAPABILITIES,
} from "./jscad-kernel";

const mm = (value: number) => length(value, "mm");

describe("createJscadKernel", () => {
  it("declares the jscad backend id and the honest capability set", () => {
    const kernel = createJscadKernel();
    expect(kernel.id).toBe("jscad");
    expect(KERNEL_BACKEND_IDS).toContain(kernel.id);
    expect(kernel.capabilities).toEqual(JSCAD_KERNEL_CAPABILITIES);
    // The honesty matrix, pinned: full modeling surface, exact primitives
    // and tight bounds w.r.t. its own polygon sets, BSP-estimated boolean
    // volumes (the fake kernel's declaration discipline), no BREP topology.
    expect(kernel.capabilities).toEqual({
      booleans: true,
      transformTranslation: true,
      transformRotation: true,
      transformScale: false,
      exactPrimitiveVolumes: true,
      exactBooleanVolumes: false,
      tightBooleanBounds: true,
      persistentTopology: false,
    });
  });

  it("grounds every length input through the unit registry (cm and inch inputs become canonical mm)", () => {
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({
        width: length(3, "cm"),
        depth: length(1, "in"),
        height: mm(5),
      }),
      "createBox",
    );
    // 3 cm = 30 mm, 1 in = 25.4 mm: the placement contract holds in
    // canonical millimetres regardless of the input unit.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [0, 0, 0], max: [30, 25.4, 5] },
      1e-9,
    );
  });

  it("measures curved primitives inside the documented band (sphere −1.60%, cylinder −0.64%, cone −0.64% at 32 segments)", () => {
    const kernel = createJscadKernel();
    const sphere = unwrapKernelResult(
      kernel.createSphere({ radius: mm(10) }),
      "createSphere",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(sphere), "sphere volume"),
      (4 / 3) * Math.PI * 10 ** 3,
      CURVED_VOLUME_TOLERANCE,
    );
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: mm(4), height: mm(10) }),
      "createCylinder",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(cylinder), "cylinder volume"),
      Math.PI * 4 ** 2 * 10,
      CURVED_VOLUME_TOLERANCE,
    );
    const cone = unwrapKernelResult(
      kernel.createCone({
        bottomRadius: mm(4),
        topRadius: mm(0),
        height: mm(10),
      }),
      "createCone",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(cone), "cone volume"),
      (Math.PI * 4 ** 2 * 10) / 3,
      CURVED_VOLUME_TOLERANCE,
    );
    // Sphere bounds stay exactly ±radius: the polygon vertices lie ON the
    // sphere, so the discretization moves the volume, never the extents.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(sphere), "sphere bounds"),
      { min: [-10, -10, -10], max: [10, 10, 10] },
      1e-9,
    );
  });

  it("builds the plate-with-hole inside its measured band with exactly tight bounds", () => {
    const kernel: GeometryKernel = createJscadKernel();
    const scene = buildPlateWithHole(kernel);
    // Probed +0.059% vs analytic on this adapter — inside the curved band
    // the exactBooleanVolumes: false declaration buys.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(scene.result), "plate volume"),
      scene.analyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    // Every face of the true result lies on the plate's box and JSCAD's
    // bounds are the tight AABBs of its actual polygon sets (probed): the
    // tightBooleanBounds: true declaration judged exactly.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(scene.result), "plate bounds"),
      scene.tightBounds,
      1e-9,
    );
    const soup = unwrapKernelResult(
      kernel.tessellate(scene.result),
      "tessellate",
    );
    assertTessellationValid(soup, { bounds: scene.tightBounds });
    expect(soup.normals).toBeUndefined();
  });

  it("builds the boolean chain inside its measured bands with tight planar bounds", () => {
    const kernel = createJscadKernel();
    const chain = buildBooleanChain(kernel);
    // Planar disjoint union: the axis-aligned boolean the suite's exact
    // policy would judge tightly on exact kernels; on JSCAD it is judged
    // against the analytic value inside the declared estimation band.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(chain.union), "union volume"),
      chain.unionVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(chain.union), "union bounds"),
      chain.unionTightBounds,
      1e-9,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(chain.cut), "cut volume"),
      chain.cutAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(chain.trimmed), "trimmed volume"),
      chain.trimmedAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(chain.trimmed), "trimmed bounds"),
      chain.trimmedTightBounds,
      1e-9,
    );
  });

  it("rejects rotation axes JSCAD would silently degrade to identity (below its EPS)", () => {
    // mat4.fromRotation treats a squared magnitude below EPS (1e-5) as a
    // degenerate axis and returns the IDENTITY — a silent mis-apply the
    // contract forbids. The adapter validates first and rejects.
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.createBox({ width: mm(10), depth: mm(10), height: mm(10) }),
      "createBox",
    );
    expectKernelFailure(
      kernel.transform(solid, {
        x: mm(0),
        y: mm(0),
        z: mm(0),
        rotation: {
          axis: [0.001, 0, 0],
          angle: angle(Math.PI / 2),
        },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "below-EPS axis rotation",
    );
    // A healthy axis of small magnitude still rotates exactly.
    const rotated = unwrapKernelResult(
      kernel.transform(solid, {
        x: mm(0),
        y: mm(0),
        z: mm(0),
        rotation: { axis: [1, 1, 1], angle: angle(0) },
      }),
      "identity-angle rotation",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(rotated), "rotated bounds"),
      { min: [0, 0, 0], max: [10, 10, 10] },
      1e-9,
    );
  });

  it("normalizes non-finite dynamically-parsed lengths into structured failures (no-throw boundary)", () => {
    const kernel = createJscadKernel();
    const nanWidth: LengthValue = {
      dimension: "length",
      unit: "mm",
      value: Number.NaN,
    };
    expectKernelFailure(
      kernel.createBox({
        width: nanWidth,
        depth: mm(1),
        height: mm(1),
      }),
      KERNEL_ERROR_CODES.invalidLength,
      "NaN box width",
    );
    expectKernelFailure(
      kernel.createSphere({ radius: nanWidth }),
      KERNEL_ERROR_CODES.invalidLength,
      "NaN sphere radius",
    );
  });

  it("makes disposal observable: disposed handles read as kernel/solid-not-owned", () => {
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.createSphere({ radius: mm(1) }),
      "createSphere",
    );
    kernel.dispose(solid);
    // Repeated dispose stays a silent no-op (never fails), and every
    // subsequent operation reads the handle as not owned.
    kernel.dispose(solid);
    expectKernelFailure(
      kernel.volume(solid),
      KERNEL_ERROR_CODES.solidNotOwned,
      "volume of disposed solid",
    );
    expectKernelFailure(
      kernel.tessellate(solid),
      KERNEL_ERROR_CODES.solidNotOwned,
      "tessellate of disposed solid",
    );
    // Foreign handles were never owned: dispose leaves them untouched and
    // operations on them still read as not owned.
    const foreign = unwrapKernelResult(
      createJscadKernel().createSphere({ radius: mm(1) }),
      "createSphere",
    );
    kernel.dispose(foreign);
    expectKernelFailure(
      kernel.bounds(foreign),
      KERNEL_ERROR_CODES.solidNotOwned,
      "bounds of foreign solid",
    );
  });

  it("omits kernel normals in tessellations (the documented honest omission)", () => {
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.createCylinder({ radius: mm(2), height: mm(5) }),
      "createCylinder",
    );
    const soup = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    expect(soup.normals).toBeUndefined();
    assertTessellationValid(soup, {
      bounds: { min: [-2, -2, 0], max: [2, 2, 5] },
    });
  });
});
