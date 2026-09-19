/**
 * The nema17-assembly example tests (Phase 33.3): the example composition
 * must build every registry component through one kernel, lay the bodies
 * out along x in measured-bounds order with the declared gap, keep every
 * component's analytic volume within the contract suite's curved band,
 * and read the NEMA 17 ports without a kernel. A parameter override must
 * reach the component it targets (and only that component).
 */

import { describe, expect, it } from "vitest";
import { assertVolumeClose } from "@slopcad/cad-kernel";
import { CURVED_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";

import {
  componentAnalyticVolumesMm3,
  nema17Analytic,
} from "../component-fixtures";
import { COMPONENT_KERNEL_CASES } from "../kernel-cases";
import { ARDUINO_MOUNT_DEFAULT_PARAMETERS } from "../arduino-mount";
import { ENCLOSURE_DEFAULT_PARAMETERS } from "../enclosure";
import { NEMA17_MOUNT_DEFAULT_PARAMETERS } from "../nema17-mount";
import { assemblyStudyDirect } from "./nema17-assembly";

/** The study's expected per-body volumes at the default parameter sets. */
function expectedVolumes(): ReadonlyMap<string, number> {
  const entries = new Set<string>();
  const map = new Map<string, number>();
  for (const [componentId, values] of [
    ["nema17-mount", NEMA17_MOUNT_DEFAULT_PARAMETERS],
    ["arduino-uno-mount", ARDUINO_MOUNT_DEFAULT_PARAMETERS],
    ["electronics-enclosure", ENCLOSURE_DEFAULT_PARAMETERS],
  ] as const) {
    const volumes = componentAnalyticVolumesMm3(componentId, values);
    expect(volumes, `analytic volumes for ${componentId}`).toBeDefined();
    const names =
      componentId === "nema17-mount"
        ? ["plate"]
        : componentId === "arduino-uno-mount"
          ? ["base"]
          : ["shell", "lid"];
    for (const [index, name] of names.entries()) {
      const key = `${componentId}/${name}`;
      entries.add(key);
      map.set(key, volumes?.[index] ?? 0);
    }
  }
  expect(entries.size).toBe(4);
  return map;
}

describe.for(COMPONENT_KERNEL_CASES)(
  "nema17-assembly example on %s",
  (case_) => {
    it("lays out all four bodies with the declared gap and analytic volumes", async () => {
      const kernel = await case_.create();
      const result = await assemblyStudyDirect(kernel, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { bodies, totalVolumeMm3, nema17Ports } = result.value;
      expect(bodies.map((body) => `${body.componentId}/${body.name}`)).toEqual([
        "nema17-mount/plate",
        "arduino-uno-mount/base",
        "electronics-enclosure/shell",
        "electronics-enclosure/lid",
      ]);

      // The layout: each next body starts at the previous max x plus 20 mm.
      for (let index = 1; index < bodies.length; index += 1) {
        const previous = bodies[index - 1];
        const current = bodies[index];
        if (previous === undefined || current === undefined) continue;
        expect(current.bounds.min[0]).toBeCloseTo(
          previous.bounds.max[0] + 20,
          6,
        );
      }
      // Nothing is placed before the origin.
      expect(bodies[0]?.bounds.min[0]).toBeGreaterThanOrEqual(0);

      // Every body's kernel volume matches its component's analytic value.
      const expected = expectedVolumes();
      let expectedTotal = 0;
      for (const body of bodies) {
        const volume = expected.get(`${body.componentId}/${body.name}`);
        expect(
          volume,
          `analytic volume for ${body.componentId}/${body.name}`,
        ).toBeDefined();
        expectedTotal += volume ?? 0;
        assertVolumeClose(body.volumeMm3, volume ?? 0, CURVED_VOLUME_TOLERANCE);
        kernel.dispose(body.solid);
      }
      // The total rides the same curved band as the per-body checks.
      assertVolumeClose(totalVolumeMm3, expectedTotal, CURVED_VOLUME_TOLERANCE);

      // The ports are the definition's five, resolved without a kernel.
      expect(nema17Ports.map((port) => port.name)).toEqual([
        "shaftBore",
        "screwHole1",
        "screwHole2",
        "screwHole3",
        "screwHole4",
      ]);
    });

    it("routes a parameter override to its component only", async () => {
      const kernel = await case_.create();
      const analytic = nema17Analytic({
        ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
        plateSizeMm: 52,
      });
      const result = await assemblyStudyDirect(kernel, {
        nema17: { ...NEMA17_MOUNT_DEFAULT_PARAMETERS, plateSizeMm: 52 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const plate = result.value.bodies[0];
      expect(plate?.componentId).toBe("nema17-mount");
      assertVolumeClose(
        plate?.volumeMm3 ?? 0,
        analytic.volumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      // The untouched components keep their analytic volumes.
      const expected = expectedVolumes();
      const uno = result.value.bodies[1];
      assertVolumeClose(
        uno?.volumeMm3 ?? 0,
        expected.get("arduino-uno-mount/base") ?? 0,
        CURVED_VOLUME_TOLERANCE,
      );
      const shell = result.value.bodies[2];
      assertVolumeClose(
        shell?.volumeMm3 ?? 0,
        expected.get("electronics-enclosure/shell") ?? 0,
        CURVED_VOLUME_TOLERANCE,
      );
      for (const body of result.value.bodies) {
        kernel.dispose(body.solid);
      }
    });

    it("refuses structurally when a component refuses", async () => {
      const kernel = await case_.create();
      // A plate too small for the NEMA 17 grid: the mount's own constraint.
      const result = await assemblyStudyDirect(kernel, {
        nema17: { ...NEMA17_MOUNT_DEFAULT_PARAMETERS, plateSizeMm: 30 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.step).toBe("nema17-mount");
      expect(result.error.code).toBe("component/parameter-conflict");
    });
  },
);
