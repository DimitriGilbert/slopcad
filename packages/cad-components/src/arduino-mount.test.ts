/**
 * Arduino UNO mount tests (Phase 32.3): semantic geometry judged
 * analytically against both shipped kernel backends (the UNO R3
 * footprint's real board-class dimensions pinned: 68.58 × 53.34 mm
 * outline, four ⌀3.2 holes at the drawing's centers), parameter-edit
 * regeneration, port resolution against the documented hole positions,
 * and the component's structured refusals.
 */

import { describe, expect, it } from "vitest";
import { assertBoundsEqual, assertVolumeClose } from "@slopcad/cad-kernel";
import type { KernelBounds } from "@slopcad/cad-kernel";
import { CURVED_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
import type { ComponentBuild } from "./cad-component";
import type { ComponentKernel } from "./component-kernel";

import { directComponentKernel } from "./component-kernel";
import {
  arduinoMount,
  ARDUINO_MOUNT_DEFAULT_PARAMETERS,
  ARDUINO_MOUNT_DEFINITION,
  ARDUINO_UNO_R3_FOOTPRINT,
  boardHoleCentersMm,
} from "./arduino-mount";
import { arduinoAnalytic } from "./component-fixtures";
import {
  COMPONENT_KERNEL_CASES,
  countKernelSolids,
  unwrapComponentResult,
} from "./kernel-cases";

/** Builds at `values`, refusing anything but success. */
async function buildOrThrow(
  kernel: ComponentKernel,
  values: typeof ARDUINO_MOUNT_DEFAULT_PARAMETERS,
): Promise<ComponentBuild> {
  const build = await arduinoMount.build(kernel, values);
  if (!build.ok) {
    throw new Error(
      `build failed: ${build.error.code}: ${build.error.message}`,
    );
  }
  return build.value;
}

async function measure(
  kernel: ComponentKernel,
  build: ComponentBuild,
): Promise<{ readonly volumeMm3: number; readonly bounds: KernelBounds }> {
  const body = build.bodies[0];
  if (body === undefined) throw new Error("the mount builds one body");
  const volume = unwrapComponentResult(
    await kernel.volume(body.solid),
    "volume",
  );
  const bounds = unwrapComponentResult(
    await kernel.bounds(body.solid),
    "bounds",
  );
  await kernel.dispose(body.solid);
  return { bounds, volumeMm3: volume };
}

describe("arduino UNO footprint data (the fixed board truth)", () => {
  it("carries the UNO R3 drawing's outline and hole centers", () => {
    // 2.7″ × 2.1″ board, quoted in millimetres.
    expect(ARDUINO_UNO_R3_FOOTPRINT.boardWidthMm).toBeCloseTo(68.58, 9);
    expect(ARDUINO_UNO_R3_FOOTPRINT.boardDepthMm).toBeCloseTo(53.34, 9);
    expect(ARDUINO_UNO_R3_FOOTPRINT.boardHoleDiameterMm).toBe(3.2);
    expect(ARDUINO_UNO_R3_FOOTPRINT.holeCentersFromBoardCornerMm).toEqual([
      [13.97, 2.54],
      [15.24, 50.8],
      [66.04, 35.56],
      [66.04, 7.62],
    ]);
    // The drawing's shield spacing: the 66.04 − 15.24 = 50.80 mm pair.
    expect(66.04 - 15.24).toBeCloseTo(50.8, 9);
  });

  it("shifts the hole centers by the plate margin, board-relative positions intact", () => {
    const centers = boardHoleCentersMm(2);
    const board = ARDUINO_UNO_R3_FOOTPRINT.holeCentersFromBoardCornerMm;
    for (const [index, [x, y]] of centers.entries()) {
      const [bx, by] = board[index] ?? [0, 0];
      expect(x).toBe(bx + 2);
      expect(y).toBe(by + 2);
    }
  });
});

describe.for(COMPONENT_KERNEL_CASES)(
  "arduino-uno-mount on %s",
  (kernelCase) => {
    it("builds the UNO R3 fit: analytic volume and exact bounds", async () => {
      const kernel = directComponentKernel(await kernelCase.create());
      const build = await buildOrThrow(
        kernel,
        ARDUINO_MOUNT_DEFAULT_PARAMETERS,
      );
      expect(build.bodies.map((body) => body.bodyId)).toEqual(
        ARDUINO_MOUNT_DEFINITION.preview.bodyIds,
      );
      expect(build.bodies[0]?.name).toBe("base");
      const analytic = arduinoAnalytic(ARDUINO_MOUNT_DEFAULT_PARAMETERS);
      const measured = await measure(kernel, build);
      assertVolumeClose(
        measured.volumeMm3,
        analytic.volumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(measured.bounds, analytic.bounds);
      // The pinned plate: outline + 2 mm overhang, 3 + 6 tall.
      expect(analytic.bounds.max).toEqual([72.58, 57.34, 9]);
    });

    it("regenerates exactly when the standoffs grow (6 → 10 mm tall, ⌀7 → ⌀9)", async () => {
      const kernel = directComponentKernel(await kernelCase.create());
      const edited = {
        ...ARDUINO_MOUNT_DEFAULT_PARAMETERS,
        standoffHeightMm: 10,
        standoffDiameterMm: 9,
      };
      const analytic = arduinoAnalytic(edited);
      const measured = await measure(
        kernel,
        await buildOrThrow(kernel, edited),
      );
      assertVolumeClose(
        measured.volumeMm3,
        analytic.volumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(measured.bounds, analytic.bounds);
      // The closed form's prediction: taller, wider standoffs add material,
      // the deeper drill removes it — both exactly computable.
      const before = arduinoAnalytic(ARDUINO_MOUNT_DEFAULT_PARAMETERS);
      const added = 4 * Math.PI * ((9 / 2) ** 2 * 10 - (7 / 2) ** 2 * 6);
      const removed = 4 * Math.PI * (3.2 / 2) ** 2 * (10 - 6);
      expect(analytic.volumeMm3).toBeCloseTo(
        before.volumeMm3 + added - removed,
        9,
      );
    });

    it("regenerates exactly when the plate overhang changes (2 → 5 mm)", async () => {
      const kernel = directComponentKernel(await kernelCase.create());
      const edited = { ...ARDUINO_MOUNT_DEFAULT_PARAMETERS, marginMm: 5 };
      const analytic = arduinoAnalytic(edited);
      const measured = await measure(
        kernel,
        await buildOrThrow(kernel, edited),
      );
      assertVolumeClose(
        measured.volumeMm3,
        analytic.volumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(measured.bounds, analytic.bounds);
      // The plate grows on all four sides; the standoffs stay board-relative.
      expect(analytic.bounds.max[0]).toBeCloseTo(68.58 + 10, 9);
      expect(analytic.bounds.max[1]).toBeCloseTo(53.34 + 10, 9);
    });
  },
);

describe("arduino-uno-mount ports and refusals (kernel-free)", () => {
  it("resolves the four board seats at the UNO hole positions", () => {
    const ports = arduinoMount.ports(ARDUINO_MOUNT_DEFAULT_PARAMETERS);
    expect(ports.map((port) => port.name)).toEqual([
      "boardMount1",
      "boardMount2",
      "boardMount3",
      "boardMount4",
    ]);
    const margin = ARDUINO_MOUNT_DEFAULT_PARAMETERS.marginMm;
    for (const [index, port] of ports.entries()) {
      expect(port.kind).toBe("boss");
      expect(port.axis).toBe(3);
      expect(port.diameter).toBe(3.2);
      const [bx, by] = ARDUINO_UNO_R3_FOOTPRINT.holeCentersFromBoardCornerMm[
        index
      ] ?? [0, 0];
      expect(port.position[0]).toBe(bx + margin);
      expect(port.position[1]).toBe(by + margin);
      // The seat face: top of the standoff.
      expect(port.position[2]).toBe(
        ARDUINO_MOUNT_DEFAULT_PARAMETERS.plateThicknessMm +
          ARDUINO_MOUNT_DEFAULT_PARAMETERS.standoffHeightMm,
      );
    }
  });

  it("moves the seats with the margin, keeping them board-relative", () => {
    const ports = arduinoMount.ports({
      ...ARDUINO_MOUNT_DEFAULT_PARAMETERS,
      marginMm: 5,
    });
    expect(ports[0]?.position[0]).toBe(13.97 + 5);
    expect(ports[2]?.position[1]).toBe(35.56 + 5);
  });

  it("refuses out-of-contract values with the contract's codes", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    const outOfRange = await arduinoMount.build(kernel, {
      ...ARDUINO_MOUNT_DEFAULT_PARAMETERS,
      standoffHeightMm: 21,
    });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.error.code).toBe(
        "component-contract/parameter-out-of-range",
      );
    }
  });

  it("refuses standoffs that overhang the plate (the 2.54 mm edge rule)", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    // No overhang: the ⌀7 standoffs (radius 3.5) exceed 0 + 2.54 mm.
    const overhang = await arduinoMount.build(kernel, {
      ...ARDUINO_MOUNT_DEFAULT_PARAMETERS,
      marginMm: 0,
    });
    expect(overhang.ok).toBe(false);
    if (!overhang.ok) {
      expect(overhang.error.code).toBe("component/parameter-conflict");
      expect(overhang.error.message).toContain("overhang");
    }
    // The default margin is exactly the boundary case: radius 3.5 ≤ 2 + 2.54.
    const seated = await arduinoMount.build(
      kernel,
      ARDUINO_MOUNT_DEFAULT_PARAMETERS,
    );
    expect(seated.ok).toBe(true);
  });

  it("refuses a drilled clearance that leaves no standoff wall", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    // ⌀4 holes through ⌀4 standoffs: both in bounds, no wall left.
    const thinWall = await arduinoMount.build(kernel, {
      ...ARDUINO_MOUNT_DEFAULT_PARAMETERS,
      standoffDiameterMm: 4,
      boardHoleDiameterMm: 4,
    });
    expect(thinWall.ok).toBe(false);
    if (!thinWall.ok) {
      expect(thinWall.error.code).toBe("component/parameter-conflict");
      expect(thinWall.error.message).toContain("wall");
    }
  });
});

describe.for(COMPONENT_KERNEL_CASES)(
  "arduino-mount dispose accounting on %s",
  (kernelCase) => {
    it("strands nothing on the default build: every mint except the returned body is disposed", async () => {
      const counter = countKernelSolids(
        directComponentKernel(await kernelCase.create()),
      );
      const build = await buildOrThrow(
        counter.kernel,
        ARDUINO_MOUNT_DEFAULT_PARAMETERS,
      );
      const returned = new Set(build.bodies.map((body) => body.solid));
      expect(returned.size).toBe(1);
      // The default build's mints: plate, four standoff pairs, their
      // union, four hole pairs, and the drilled result.
      expect(counter.minted).toHaveLength(19);
      expect(counter.disposed).toHaveLength(
        counter.minted.length - returned.size,
      );
      expect(new Set(counter.disposed).size).toBe(counter.disposed.length);
      for (const solid of counter.disposed) {
        expect(returned.has(solid)).toBe(false);
      }
      // The returned body stays caller-owned: release it through the same
      // kernel.
      for (const solid of returned) {
        await counter.kernel.dispose(solid);
      }
    });

    it("releases every mint when the kernel refuses mid-build", async () => {
      const counter = countKernelSolids(
        directComponentKernel(await kernelCase.create()),
        { failNthMint: 11 },
      );
      const build = await arduinoMount.build(
        counter.kernel,
        ARDUINO_MOUNT_DEFAULT_PARAMETERS,
      );
      expect(build.ok).toBe(false);
      if (!build.ok) {
        expect(build.error.code).toBe("test/injected-mint-refusal");
      }
      // The first board hole refused: the ten prior mints (plate, four
      // standoff pairs, the union) are all released.
      expect(counter.minted).toHaveLength(10);
      expect(counter.disposed).toHaveLength(10);
      expect(new Set(counter.disposed).size).toBe(10);
    });
  },
);
