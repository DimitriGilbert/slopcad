/**
 * OCCT cylindrical-surface typing tests (Phase 27.3): the topology
 * snapshot's face descriptors carry the EXACT analytic cylinder radius —
 * the `BRepAdaptor_Surface` → `GeomAbs_Cylinder` → `gp_Cylinder.Radius()`
 * probe — so the radius measurement's persistent path measures a cylinder
 * through the kernel's own surface typing rather than a fit. Planar faces
 * omit the field; the drilled plate's bore face reports the drilled radius.
 *
 * The WASM runtime is initialized once in a top-level `beforeAll` (the
 * occt-kernel.test.ts pattern); every test uses fresh kernel instances.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createBodyId, length } from "@slopcad/cad-core";
import { unwrapKernelResult } from "@slopcad/cad-kernel";

import { buildPlateWithHole, PLATE_WITH_HOLE } from "./occt-fixtures";
import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

function makeKernel() {
  return occtKernelFromRuntime(runtime);
}

describe("occt topology snapshots — cylindrical surface typing", () => {
  it("types a created cylinder's wall face with its exact radius", () => {
    const kernel = makeKernel();
    const radiusMm = 5;
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(radiusMm), height: length(10) }),
      "createCylinder",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(cylinder, {
        bodyId: createBodyId("body_radius_cylinder"),
        regeneration: 0,
        kinds: ["face"],
      }),
      "topologySnapshot",
    );
    const walls = snapshot.entities.filter(
      (entity) => entity.geometry.cylinderRadiusMm !== undefined,
    );
    expect(walls.length).toBe(1);
    const wall = walls[0];
    expect(wall).toBeDefined();
    expect(wall?.geometry.cylinderRadiusMm).toBe(radiusMm);
  });

  it("omits the radius from a box's planar faces", () => {
    const kernel = makeKernel();
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "createBox",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(box, {
        bodyId: createBodyId("body_radius_box"),
        regeneration: 0,
        kinds: ["face"],
      }),
      "topologySnapshot",
    );
    expect(snapshot.entities.length).toBe(6);
    for (const entity of snapshot.entities) {
      expect(entity.geometry.cylinderRadiusMm).toBeUndefined();
    }
  });

  it("types the drilled plate's bore face with the drilled radius, exactly", () => {
    const kernel = makeKernel();
    const fixture = buildPlateWithHole(kernel);
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(fixture.result, {
        bodyId: createBodyId("body_radius_plate"),
        regeneration: 0,
        kinds: ["face"],
      }),
      "topologySnapshot",
    );
    const walls = snapshot.entities.filter(
      (entity) => entity.geometry.cylinderRadiusMm !== undefined,
    );
    expect(walls.length).toBe(1);
    const wall = walls[0];
    expect(wall?.geometry.cylinderRadiusMm).toBe(PLATE_WITH_HOLE.boreRadiusMm);
    // The area rides along unchanged: the analytic lateral surface.
    expect(wall?.geometry.areaMm2).toBeCloseTo(
      2 * Math.PI * PLATE_WITH_HOLE.boreRadiusMm * PLATE_WITH_HOLE.heightMm,
      6,
    );
  });
});
