/**
 * Enclosure tests (Phase 32.4): semantic geometry judged analytically
 * against both shipped kernel backends — the shell and the lid as
 * separate bodies (rounded-rect closed forms, exact bounds, curved-band
 * volumes), parameter-change regeneration (walls, cavity, corners, lid
 * fit, bosses), seated-frame port resolution, and the structured
 * refusals.
 */

import { describe, expect, it } from "vitest";
import { assertBoundsEqual, assertVolumeClose } from "@slopcad/cad-kernel";
import type { KernelBounds } from "@slopcad/cad-kernel";
import { CURVED_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
import type { ComponentBuild } from "./cad-component";
import type { ComponentKernel } from "./component-kernel";
import type { EnclosureParameters } from "./enclosure";

import { directComponentKernel } from "./component-kernel";
import {
  enclosure,
  ENCLOSURE_DEFAULT_PARAMETERS,
  ENCLOSURE_DEFINITION,
  deriveEnclosure,
  lidBossCentersMm,
  roundedRectLoop,
  seatedLidZMm,
} from "./enclosure";
import { enclosureAnalytic } from "./component-fixtures";
import {
  COMPONENT_KERNEL_CASES,
  countKernelSolids,
  unwrapComponentResult,
} from "./kernel-cases";

/** Builds at `values`, refusing anything but success. */
async function buildOrThrow(
  kernel: ComponentKernel,
  values: typeof ENCLOSURE_DEFAULT_PARAMETERS,
): Promise<ComponentBuild> {
  const build = await enclosure.build(kernel, values);
  if (!build.ok) {
    throw new Error(
      `build failed: ${build.error.code}: ${build.error.message}`,
    );
  }
  return build.value;
}

interface MeasuredBody {
  readonly name: string;
  readonly volumeMm3: number;
  readonly bounds: KernelBounds;
}

async function measureAll(
  kernel: ComponentKernel,
  build: ComponentBuild,
): Promise<readonly MeasuredBody[]> {
  const measured: MeasuredBody[] = [];
  for (const body of build.bodies) {
    const volume = unwrapComponentResult(
      await kernel.volume(body.solid),
      `volume ${body.name}`,
    );
    const bounds = unwrapComponentResult(
      await kernel.bounds(body.solid),
      `bounds ${body.name}`,
    );
    await kernel.dispose(body.solid);
    measured.push({ bounds, name: body.name, volumeMm3: volume });
  }
  return measured;
}

describe("enclosure derived geometry (pure arithmetic)", () => {
  it("derives the default footprint: 60×40 cavity, 2.4 walls, 3 mm corners", () => {
    const derived = deriveEnclosure(ENCLOSURE_DEFAULT_PARAMETERS);
    expect(derived.outerWidthMm).toBeCloseTo(64.8, 9);
    expect(derived.outerDepthMm).toBeCloseTo(44.8, 9);
    expect(derived.outerHeightMm).toBeCloseTo(27.4, 9);
    expect(derived.outerRadiusMm).toBe(3);
    expect(derived.innerRadiusMm).toBeCloseTo(0.6, 9);
    // The lid undercuts the cavity by the full sliding clearance.
    expect(derived.lidWidthMm).toBeCloseTo(59.8, 9);
    expect(derived.lidDepthMm).toBeCloseTo(39.8, 9);
    expect(derived.lidRadiusMm).toBeCloseTo(0.5, 9);
    expect(seatedLidZMm(ENCLOSURE_DEFAULT_PARAMETERS)).toBeCloseTo(27.4, 9);
  });

  it("builds a closed rounded-rect loop for r > 0 and four lines for r = 0", () => {
    const rounded = roundedRectLoop(60, 40, 3);
    expect(rounded).toHaveLength(8); // 4 lines + 4 arcs
    // The chain closes: every segment starts where the previous ended
    // (arcs resolve through their angles about their centers).
    const sharp = roundedRectLoop(60, 40, 0);
    expect(sharp).toHaveLength(4);
    expect(sharp.every((segment) => segment.kind === "line")).toBe(true);
  });
});

describe.for(COMPONENT_KERNEL_CASES)(
  "electronics-enclosure on %s",
  (kernelCase) => {
    it("builds shell and lid under their preview body ids, analytically true", async () => {
      const kernel = directComponentKernel(await kernelCase.create());
      const build = await buildOrThrow(kernel, ENCLOSURE_DEFAULT_PARAMETERS);
      expect(build.bodies.map((body) => body.bodyId)).toEqual(
        ENCLOSURE_DEFINITION.preview.bodyIds,
      );
      expect(build.bodies.map((body) => body.name)).toEqual(["shell", "lid"]);
      const analytic = enclosureAnalytic(ENCLOSURE_DEFAULT_PARAMETERS);
      const measured = await measureAll(kernel, build);
      const shell = measured.find((body) => body.name === "shell");
      const lid = measured.find((body) => body.name === "lid");
      expect(shell).toBeDefined();
      expect(lid).toBeDefined();
      if (shell === undefined || lid === undefined) return;
      assertVolumeClose(
        shell.volumeMm3,
        analytic.shellVolumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertVolumeClose(
        lid.volumeMm3,
        analytic.lidVolumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(shell.bounds, analytic.shellBounds);
      // The lid's bosses hang below its own z=0 into negative z.
      assertBoundsEqual(lid.bounds, analytic.lidBounds);
    });

    it("regenerates exactly when the cavity grows (60 → 90 mm inner width)", async () => {
      const kernel = directComponentKernel(await kernelCase.create());
      const edited = { ...ENCLOSURE_DEFAULT_PARAMETERS, innerWidthMm: 90 };
      const analytic = enclosureAnalytic(edited);
      const measured = await measureAll(
        kernel,
        await buildOrThrow(kernel, edited),
      );
      const shell = measured.find((body) => body.name === "shell");
      const lid = measured.find((body) => body.name === "lid");
      if (shell === undefined || lid === undefined) return;
      assertVolumeClose(
        shell.volumeMm3,
        analytic.shellVolumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertVolumeClose(
        lid.volumeMm3,
        analytic.lidVolumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(shell.bounds, analytic.shellBounds);
      // The shell grew by 30 mm in x; the lid grew with the cavity.
      expect(analytic.shellBounds.max[0]).toBeCloseTo(94.8, 9);
      expect(analytic.lidBounds.max[0]).toBeCloseTo(89.8, 9);
      // Growing the cavity adds shell volume (two new wall-side slabs minus
      // nothing) and lid volume: both analytic forms agree with the kernel.
      const before = enclosureAnalytic(ENCLOSURE_DEFAULT_PARAMETERS);
      expect(analytic.shellVolumeMm3).toBeGreaterThan(before.shellVolumeMm3);
      expect(analytic.lidVolumeMm3).toBeGreaterThan(before.lidVolumeMm3);
    });

    it("regenerates exactly when the walls thicken (2.4 → 4 mm) without moving the cavity", async () => {
      const kernel = directComponentKernel(await kernelCase.create());
      const edited = { ...ENCLOSURE_DEFAULT_PARAMETERS, wallThicknessMm: 4 };
      const analytic = enclosureAnalytic(edited);
      const measured = await measureAll(
        kernel,
        await buildOrThrow(kernel, edited),
      );
      const shell = measured.find((body) => body.name === "shell");
      if (shell === undefined) return;
      assertVolumeClose(
        shell.volumeMm3,
        analytic.shellVolumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(shell.bounds, analytic.shellBounds);
      // The cavity (and therefore the lid) is unchanged: wall growth is
      // purely outward.
      expect(analytic.shellBounds.max[0]).toBeCloseTo(68, 9);
      expect(deriveEnclosure(edited).lidWidthMm).toBeCloseTo(59.8, 9);
    });

    it("builds sharp corners at radius 0 and stays analytically true", async () => {
      const kernel = directComponentKernel(await kernelCase.create());
      const sharp = { ...ENCLOSURE_DEFAULT_PARAMETERS, cornerRadiusMm: 0 };
      const analytic = enclosureAnalytic(sharp);
      const measured = await measureAll(
        kernel,
        await buildOrThrow(kernel, sharp),
      );
      const shell = measured.find((body) => body.name === "shell");
      if (shell === undefined) return;
      assertVolumeClose(
        shell.volumeMm3,
        analytic.shellVolumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(shell.bounds, analytic.shellBounds);
      // The sharp box's shell volume is the pure rectangular closed form.
      const derived = deriveEnclosure(sharp);
      expect(analytic.shellVolumeMm3).toBeCloseTo(
        derived.outerWidthMm * derived.outerDepthMm * derived.outerHeightMm -
          ENCLOSURE_DEFAULT_PARAMETERS.innerWidthMm *
            ENCLOSURE_DEFAULT_PARAMETERS.innerDepthMm *
            ENCLOSURE_DEFAULT_PARAMETERS.innerHeightMm,
        6,
      );
    });
  },
);

describe("electronics-enclosure ports and refusals (kernel-free)", () => {
  it("resolves the four seated boss pilots and the cavity opening", () => {
    const ports = enclosure.ports(ENCLOSURE_DEFAULT_PARAMETERS);
    expect(ports.map((port) => port.name)).toEqual([
      "bossPilot1",
      "bossPilot2",
      "bossPilot3",
      "bossPilot4",
      "cavityOpening",
    ]);
    const seatedZ = seatedLidZMm(ENCLOSURE_DEFAULT_PARAMETERS);
    const lidOffset =
      ENCLOSURE_DEFAULT_PARAMETERS.lidFitClearanceMm / 2 +
      ENCLOSURE_DEFAULT_PARAMETERS.wallThicknessMm;
    for (const [index, [x, y]] of lidBossCentersMm(
      ENCLOSURE_DEFAULT_PARAMETERS,
    ).entries()) {
      const pilot = ports[index];
      expect(pilot?.kind).toBe("hole");
      expect(pilot?.axis).toBe(3);
      expect(pilot?.diameter).toBe(2.8);
      // Seated-assembly frame: lid offset in x/y, pilot mid-plane in z.
      expect(pilot?.position[0]).toBeCloseTo(lidOffset + x, 9);
      expect(pilot?.position[1]).toBeCloseTo(lidOffset + y, 9);
      expect(pilot?.position[2]).toBeGreaterThan(
        seatedZ - ENCLOSURE_DEFAULT_PARAMETERS.bossHeightMm,
      );
      expect(pilot?.position[2]).toBeLessThan(
        seatedZ + ENCLOSURE_DEFAULT_PARAMETERS.lidThicknessMm,
      );
    }
    const opening = ports[4];
    expect(opening?.kind).toBe("interface");
    expect(opening?.position).toEqual([2.4 + 30, 2.4 + 20, seatedZ]);
  });

  it("moves the opening and the seat plane when the cavity height changes", () => {
    const taller = { ...ENCLOSURE_DEFAULT_PARAMETERS, innerHeightMm: 40 };
    const opening = enclosure.ports(taller)[4];
    expect(opening?.position[2]).toBeCloseTo(42.4, 9);
    expect(seatedLidZMm(taller)).toBeCloseTo(42.4, 9);
  });

  it("refuses a corner radius beyond half the smaller side", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    // A 20 mm-deep cavity makes the outer depth 24.8: half is 12.4, so the
    // in-bounds 13 mm radius cannot fit (unreachable at the default cavity,
    // where the descriptor max of 20 stays under the 22.4 limit).
    const refused = await enclosure.build(kernel, {
      ...ENCLOSURE_DEFAULT_PARAMETERS,
      innerDepthMm: 20,
      cornerRadiusMm: 13,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("component/parameter-conflict");
      expect(refused.error.message).toContain("corner radius");
    }
  });

  it("refuses corner bosses that embed into the cavity's corner arcs", async () => {
    const counter = countKernelSolids(
      directComponentKernel(await COMPONENT_KERNEL_CASES[0]!.create()),
    );
    // In-bounds corner radii whose inner arcs reach past the seated
    // corner bosses: 13 clears by 2.96 mm of the required 3, 15 by
    // 2.13, 20 by 0.06 (the review measured 238.11 mm³ of real seated
    // lid/shell interference at 20 — now unreachable, because the
    // refusal fires before any kernel call).
    for (const cornerRadiusMm of [13, 15, 20]) {
      const refused = await enclosure.build(counter.kernel, {
        ...ENCLOSURE_DEFAULT_PARAMETERS,
        cornerRadiusMm,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("component/parameter-conflict");
        expect(refused.error.message).toContain("corner bosses");
        expect(refused.error.message).toContain("corner arcs");
      }
    }
    // The refusal is pre-kernel on every path: nothing is minted.
    expect(counter.minted).toHaveLength(0);
    expect(counter.disposed).toHaveLength(0);
  });

  it("refuses bosses that pierce the corner wall band from the far side (the executed repros)", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    // The hole in the superseded |dist − innerRadius| form, which
    // treated the inner arc CIRCLE alone as the obstacle on both sides:
    // the real obstacle is the WALL BAND between the concentric inner
    // and outer corner arcs. Each config below is in-bounds and cleared
    // the old form, yet executes with the seated bosses embedded in the
    // band — radius 20/wall 6 measured 28.95 mm³ of seated
    // interference, radius 18/wall 2.4 measured 3.88 mm³, and the
    // analytic ⌀4 case at radius 16 reaches 4.52 mm past the inner arc
    // clean through the 2.4 mm wall.
    const wallBandRepros: readonly EnclosureParameters[] = [
      {
        ...ENCLOSURE_DEFAULT_PARAMETERS,
        bossDiameterMm: 3,
        bossInsetMm: 2,
        cornerRadiusMm: 20,
        lidFitClearanceMm: 0,
        wallThicknessMm: 6,
      },
      {
        ...ENCLOSURE_DEFAULT_PARAMETERS,
        bossDiameterMm: 3,
        bossInsetMm: 2,
        cornerRadiusMm: 18,
        lidFitClearanceMm: 0,
      },
      {
        ...ENCLOSURE_DEFAULT_PARAMETERS,
        bossDiameterMm: 4,
        bossInsetMm: 2,
        cornerRadiusMm: 16,
      },
    ];
    for (const repro of wallBandRepros) {
      const refused = await enclosure.build(kernel, repro);
      expect(refused.ok, `cornerRadius ${String(repro.cornerRadiusMm)}`).toBe(
        false,
      );
      if (!refused.ok) {
        expect(refused.error.code).toBe("component/parameter-conflict");
        expect(refused.error.message).toContain("corner bosses");
        expect(refused.error.message).toContain("wall band");
      }
    }
  });

  it("keeps the corner bosses clear of the arcs at the defaults and at radius 12", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    // Defaults (radius 3) and the largest passing radius (12, arc
    // clearance 3.38 mm ≥ the 3 mm boss radius) both build.
    const atTwelve = { ...ENCLOSURE_DEFAULT_PARAMETERS, cornerRadiusMm: 12 };
    const measured = await measureAll(
      kernel,
      await buildOrThrow(kernel, ENCLOSURE_DEFAULT_PARAMETERS),
    );
    expect(measured).toHaveLength(2);
    const analytic = enclosureAnalytic(atTwelve);
    const measuredTwelve = await measureAll(
      kernel,
      await buildOrThrow(kernel, atTwelve),
    );
    const shell = measuredTwelve.find((body) => body.name === "shell");
    if (shell === undefined) return;
    assertVolumeClose(
      shell.volumeMm3,
      analytic.shellVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(shell.bounds, analytic.shellBounds);
  });

  it("builds when the bosses sit wholly beyond the corner square at a large radius", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    // The far side's clear shape: at a 16 mm corner radius (inner arc
    // 13.6) the defaults refuse, but raising the inset per the
    // refusal's advice moves each boss past the corner square entirely
    // (seated 16.7 − 3 ≥ 13.6), where no arc bounds it — the branch the
    // old absolute-value form misrepresented as "clears on either
    // side".
    const beyond = await buildOrThrow(kernel, {
      ...ENCLOSURE_DEFAULT_PARAMETERS,
      bossInsetMm: 16.5,
      cornerRadiusMm: 16,
    });
    expect(beyond.bodies).toHaveLength(2);
  });

  it("refuses bosses that cross the walls, overlap each other, outgrow the cavity, or lose their wall", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    const crossingWall = await enclosure.build(kernel, {
      ...ENCLOSURE_DEFAULT_PARAMETERS,
      bossInsetMm: 2,
      bossDiameterMm: 7,
    });
    expect(crossingWall.ok).toBe(false);
    if (!crossingWall.ok) {
      expect(crossingWall.error.message).toContain("cross");
    }

    const overlapping = await enclosure.build(kernel, {
      ...ENCLOSURE_DEFAULT_PARAMETERS,
      innerDepthMm: 20,
      bossInsetMm: 8,
      bossDiameterMm: 6,
    });
    expect(overlapping.ok).toBe(false);
    if (!overlapping.ok) {
      expect(overlapping.error.message).toContain("overlap");
    }

    const tooTall = await enclosure.build(kernel, {
      ...ENCLOSURE_DEFAULT_PARAMETERS,
      bossHeightMm: 26,
    });
    expect(tooTall.ok).toBe(false);
    if (!tooTall.ok) {
      expect(tooTall.error.message).toContain("rim");
    }

    const thinBossWall = await enclosure.build(kernel, {
      ...ENCLOSURE_DEFAULT_PARAMETERS,
      bossDiameterMm: 4,
      bossPilotDiameterMm: 4,
    });
    expect(thinBossWall.ok).toBe(false);
    if (!thinBossWall.ok) {
      expect(thinBossWall.error.message).toContain("pilot");
    }
  });

  it("refuses out-of-contract values with the contract's codes", async () => {
    const kernel = directComponentKernel(
      await COMPONENT_KERNEL_CASES[0]!.create(),
    );
    const refused = await enclosure.build(kernel, {
      ...ENCLOSURE_DEFAULT_PARAMETERS,
      wallThicknessMm: 0.5,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(
        "component-contract/parameter-out-of-range",
      );
    }
  });
});

describe.for(COMPONENT_KERNEL_CASES)(
  "enclosure dispose accounting on %s",
  (kernelCase) => {
    it("strands nothing on the default build: every mint except the two returned bodies is disposed", async () => {
      const counter = countKernelSolids(
        directComponentKernel(await kernelCase.create()),
      );
      const build = await buildOrThrow(
        counter.kernel,
        ENCLOSURE_DEFAULT_PARAMETERS,
      );
      const returned = new Set(build.bodies.map((body) => body.solid));
      expect(returned.size).toBe(2);
      // The default build's mints: shell block, cavity, hollowed shell,
      // lid block, four boss pairs, their union, four pilot pairs, and the
      // drilled lid.
      expect(counter.minted).toHaveLength(22);
      expect(counter.disposed).toHaveLength(
        counter.minted.length - returned.size,
      );
      expect(new Set(counter.disposed).size).toBe(counter.disposed.length);
      for (const solid of counter.disposed) {
        expect(returned.has(solid)).toBe(false);
      }
      // The returned bodies stay caller-owned: release them through the
      // same kernel.
      for (const solid of returned) {
        await counter.kernel.dispose(solid);
      }
    });

    it("releases every mint when the kernel refuses mid-build", async () => {
      const counter = countKernelSolids(
        directComponentKernel(await kernelCase.create()),
        { failNthMint: 5 },
      );
      const build = await enclosure.build(
        counter.kernel,
        ENCLOSURE_DEFAULT_PARAMETERS,
      );
      expect(build.ok).toBe(false);
      if (!build.ok) {
        expect(build.error.code).toBe("test/injected-mint-refusal");
      }
      // The first boss cylinder refused: the four prior mints (shell
      // block, cavity, hollowed shell, lid block) are all released — the
      // would-be returned shell included, because nothing is returned on a
      // refusal.
      expect(counter.minted).toHaveLength(4);
      expect(counter.disposed).toHaveLength(4);
      expect(new Set(counter.disposed).size).toBe(4);
    });
  },
);
