/**
 * NEMA 17 mount tests (Phase 32.2): semantic geometry judged analytically
 * against both shipped kernel backends (bounds exact, volumes within the
 * contract suite's curved band), parameter-edit regeneration (edit →
 * geometry changes exactly as the closed form predicts), port resolution,
 * and the component's structured refusals. Public APIs only: the component
 * builds through `directComponentKernel` over each backend's public
 * `GeometryKernel` contract.
 */

import { describe, expect, it } from "vitest";
import { assertBoundsEqual, assertVolumeClose } from "@slopcad/cad-kernel";
import type { KernelBounds } from "@slopcad/cad-kernel";
import { CURVED_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
import type { ComponentBuild } from "./cad-component";
import type { ComponentKernel } from "./component-kernel";

import { directComponentKernel } from "./component-kernel";
import {
  nema17Mount,
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
  NEMA17_MOUNT_DEFINITION,
} from "./nema17-mount";
import { nema17Analytic } from "./component-fixtures";
import {
  COMPONENT_KERNEL_CASES,
  countKernelSolids,
  unwrapComponentResult,
} from "./kernel-cases";

/** Builds at `values` and refuses to return anything but success. */
async function buildOrThrow(
  kernel: ComponentKernel,
  values: typeof NEMA17_MOUNT_DEFAULT_PARAMETERS,
): Promise<ComponentBuild> {
  const build = await nema17Mount.build(kernel, values);
  if (!build.ok) {
    throw new Error(
      `build failed: ${build.error.code}: ${build.error.message}`,
    );
  }
  return build.value;
}

/** Measures one build body (volume and bounds) and disposes it. */
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

describe.for(COMPONENT_KERNEL_CASES)("nema17-mount on %s", (kernelCase) => {
  it("builds the standard NEMA 17 fit: analytic volume and exact bounds", async () => {
    const kernel = directComponentKernel(await kernelCase.create());
    const build = await buildOrThrow(kernel, NEMA17_MOUNT_DEFAULT_PARAMETERS);
    expect(build.bodies.map((body) => body.bodyId)).toEqual(
      NEMA17_MOUNT_DEFINITION.preview.bodyIds,
    );
    expect(build.bodies[0]?.name).toBe("plate");
    const analytic = nema17Analytic(NEMA17_MOUNT_DEFAULT_PARAMETERS);
    const measured = await measure(kernel, build);
    assertVolumeClose(
      measured.volumeMm3,
      analytic.volumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(measured.bounds, analytic.bounds);
  });

  it("regenerates exactly when the plate grows (46 → 60 mm)", async () => {
    const kernel = directComponentKernel(await kernelCase.create());
    const edited = { ...NEMA17_MOUNT_DEFAULT_PARAMETERS, plateSizeMm: 60 };
    const analytic = nema17Analytic(edited);
    const measured = await measure(kernel, await buildOrThrow(kernel, edited));
    assertVolumeClose(
      measured.volumeMm3,
      analytic.volumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(measured.bounds, analytic.bounds);
    // The closed form's prediction for the delta: the analytic difference,
    // grown plate minus the original, is what the kernel must follow.
    const original = nema17Analytic(NEMA17_MOUNT_DEFAULT_PARAMETERS);
    expect(analytic.volumeMm3).toBeGreaterThan(original.volumeMm3);
    expect(analytic.bounds.max[0]).toBe(60);
  });

  it("regenerates exactly when the bore opens up (⌀22.5 → ⌀26) and loses the predicted volume", async () => {
    const kernel = directComponentKernel(await kernelCase.create());
    // A wider bore needs a wider collar (constraint 3) that still clears the
    // screw drill circles (constraint 4): ⌀27.5 + ⌀3.4 ≤ the 31 mm pitch.
    const edited = {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      boreDiameterMm: 26,
      bossDiameterMm: 27.5,
    };
    const analytic = nema17Analytic(edited);
    const measured = await measure(kernel, await buildOrThrow(kernel, edited));
    assertVolumeClose(
      measured.volumeMm3,
      analytic.volumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    // The closed form's prediction for the edit: the wider bore removes its
    // annulus over the full height, the wider collar adds its own annulus
    // over the collar height.
    const before = nema17Analytic(NEMA17_MOUNT_DEFAULT_PARAMETERS);
    const height =
      NEMA17_MOUNT_DEFAULT_PARAMETERS.plateThicknessMm +
      NEMA17_MOUNT_DEFAULT_PARAMETERS.bossHeightMm;
    const removed = Math.PI * ((26 / 2) ** 2 - (22.5 / 2) ** 2) * height;
    const added =
      Math.PI *
      ((27.5 / 2) ** 2 - (24 / 2) ** 2) *
      NEMA17_MOUNT_DEFAULT_PARAMETERS.bossHeightMm;
    expect(analytic.volumeMm3).toBeCloseTo(
      before.volumeMm3 - removed + added,
      9,
    );
    expect(analytic.volumeMm3).toBeLessThan(before.volumeMm3);
  });

  it("omits the collar at bossHeight 0 and matches the flat-plate closed form", async () => {
    const kernel = directComponentKernel(await kernelCase.create());
    const flat = { ...NEMA17_MOUNT_DEFAULT_PARAMETERS, bossHeightMm: 0 };
    const analytic = nema17Analytic(flat);
    expect(analytic.bounds.max[2]).toBe(flat.plateThicknessMm);
    const measured = await measure(kernel, await buildOrThrow(kernel, flat));
    assertVolumeClose(
      measured.volumeMm3,
      analytic.volumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(measured.bounds, analytic.bounds);
  });
});

describe("nema17-mount ports and refusals (kernel-free)", () => {
  it("resolves the shaft bore and the 31 mm screw grid at the defaults", () => {
    const ports = nema17Mount.ports(NEMA17_MOUNT_DEFAULT_PARAMETERS);
    expect(ports.map((port) => port.name)).toEqual([
      "shaftBore",
      "screwHole1",
      "screwHole2",
      "screwHole3",
      "screwHole4",
    ]);
    const bore = ports[0];
    expect(bore?.kind).toBe("interface");
    expect(bore?.axis).toBe(3);
    expect(bore?.diameter).toBe(22.5);
    // Mid-height of plate+collar, plate-centred.
    expect(bore?.position).toEqual([23, 23, 4.75]);
    const centers = ports.slice(1).map((port) => port.position);
    for (const center of centers) {
      // The 31 mm grid about the plate centre: ±15.5 mm on x and y.
      expect(Math.abs(center[0] - 23)).toBe(15.5);
      expect(Math.abs(center[1] - 23)).toBe(15.5);
      expect(center[2]).toBe(3);
    }
    // The grid is square: all four corners present exactly once.
    const xs = new Set(centers.map((c) => c[0]));
    const ys = new Set(centers.map((c) => c[1]));
    expect(xs.size).toBe(2);
    expect(ys.size).toBe(2);
  });

  it("moves the ports with the parameters (grid pitch and plate size)", () => {
    const ports = nema17Mount.ports({
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      plateSizeMm: 60,
      holeSpacingMm: 40,
    });
    const half = 40 / 2;
    expect(ports[0]?.position).toEqual([30, 30, 4.75]);
    for (const port of ports.slice(1)) {
      expect(Math.abs(port.position[0] - 30)).toBe(half);
    }
  });

  it("refuses out-of-contract values with the contract's codes (no kernel call)", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    const outOfRange = await nema17Mount.build(kernel, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      plateSizeMm: 29,
    });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.error.code).toBe(
        "component-contract/parameter-out-of-range",
      );
    }
    const unknown = await nema17Mount.build(kernel, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      plateSize: 46,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("component-contract/unknown-parameter");
    }
  });

  it("refuses in-bounds-but-unbuildable parameter conflicts, each with its reason", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    // 1. Screw holes do not keep 2 mm edge distance on a 38 mm plate.
    const screwFit = await nema17Mount.build(kernel, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      plateSizeMm: 38,
    });
    // 38 ≥ 31 + 3.4 + 4 = 38.4? No — 38 < 38.4, refused.
    expect(screwFit.ok).toBe(false);
    if (!screwFit.ok) {
      expect(screwFit.error.code).toBe("component/parameter-conflict");
      expect(screwFit.error.message).toContain("screw");
    }
    // 2. The bore leaves < 1 mm of wall.
    const boreWall = await nema17Mount.build(kernel, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      boreDiameterMm: 45,
    });
    expect(boreWall.ok).toBe(false);
    if (!boreWall.ok) {
      expect(boreWall.error.code).toBe("component/parameter-conflict");
      expect(boreWall.error.message).toContain("bore");
    }
    // 3. A collar thinner than the bore it rings.
    const thinCollar = await nema17Mount.build(kernel, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      bossDiameterMm: 20,
    });
    expect(thinCollar.ok).toBe(false);
    // 4. A collar reaching the screw holes' drill circles.
    const wideCollar = await nema17Mount.build(kernel, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      bossDiameterMm: 30,
    });
    expect(wideCollar.ok).toBe(false);
    if (!wideCollar.ok) {
      expect(wideCollar.error.message).toContain("collar");
    }
  });
});

describe.for(COMPONENT_KERNEL_CASES)(
  "nema17-mount dispose accounting on %s",
  (kernelCase) => {
    it("strands nothing on the default build: every mint except the returned body is disposed", async () => {
      const counter = countKernelSolids(
        directComponentKernel(await kernelCase.create()),
      );
      const build = await buildOrThrow(
        counter.kernel,
        NEMA17_MOUNT_DEFAULT_PARAMETERS,
      );
      const returned = new Set(build.bodies.map((body) => body.solid));
      expect(returned.size).toBe(1);
      // The default build's mints: plate, collar branch (collar, placed,
      // union), bore pair, four screw pairs, and the drilled result.
      expect(counter.minted).toHaveLength(15);
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
        { failNthMint: 4 },
      );
      const build = await nema17Mount.build(
        counter.kernel,
        NEMA17_MOUNT_DEFAULT_PARAMETERS,
      );
      expect(build.ok).toBe(false);
      if (!build.ok) {
        expect(build.error.code).toBe("test/injected-mint-refusal");
      }
      // The union of plate+collar refused: the three prior mints are all
      // released, none survives the refusal.
      expect(counter.minted).toHaveLength(3);
      expect(counter.disposed).toHaveLength(3);
      expect(new Set(counter.disposed).size).toBe(3);
    });
  },
);
