/**
 * The 3D WGSL shader module's layout tests (Phase 66a): the d3q19
 * layout CONTRACT as the mirror spec — the generated tables, the
 * byte-offset formula, the pack/unpack round-trip against the CPU 3D
 * kernel's own arrays, the uniform block encodings, and the reduction
 * shape. Any deviation between the CPU contract and the GPU image is a
 * bug, and these pins exist to catch it before a real device ever runs.
 */

import { describe, expect, it } from "vitest";

import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  D3Q19_WEIGHTS,
} from "./d3q19";
import { analyticOccupancy3d, testFluid } from "./fixtures";
import { GPU_ORACLE_3D_MATRIX } from "./gpu-oracle-3d-harness";
import { type Lbm3dStepperConfig, createLbm3dStepper } from "./stepper-3d";
import {
  WGSL3D_BINDINGS,
  WGSL3D_COLLISION_KINDS,
  WGSL3D_ENTRY_POINTS,
  WGSL3D_FACE_KINDS,
  WGSL3D_MAX_NODES,
  WGSL3D_RUN_PARAMS_BYTE_LENGTH,
  WGSL3D_STEP_PARAMS_BYTE_LENGTH,
  WGSL3D_WORKGROUP_SIZE,
  WGSL_D3Q19_COMPUTE,
  type Wgsl3dRunParams,
  wgsl3dDirectionByteOffset,
  wgsl3dEncodeRunParams,
  wgsl3dEncodeStepParams,
  wgsl3dPackDistributions,
  wgsl3dPackMask,
  wgsl3dPackStatus,
  wgsl3dReductionShape,
  wgsl3dUnpackDistributions,
} from "./wgsl-shader-3d";

/** A small stepped 3D channel with a box obstacle — real bytes to mirror. */
function steppedChannel(steps: number): readonly Float32Array[] {
  const config: Lbm3dStepperConfig = {
    mask: {
      nx: 10,
      ny: 6,
      nz: 6,
      solid: analyticOccupancy3d(
        10,
        6,
        6,
        (x, y, z) => x >= 4 && x <= 6 && y >= 2 && y <= 3 && z >= 2 && z <= 3,
      ),
    },
    fluid: testFluid(1.2, 2e-4),
    cellSizeM: 0.001,
    characteristicVelocityMPerS: 0.075,
    west: { kind: "velocity-inlet", velocityMPerS: [0.05, 0, 0] },
    east: { kind: "pressure-outlet", pressurePa: 0 },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "symmetry" },
    top: { kind: "symmetry" },
  };
  const created = createLbm3dStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  created.value.run(steps);
  return created.value.distributions();
}

describe("the generated 3D WGSL tables (the d3q19 mirror)", () => {
  it("embeds the velocity, weight, and reflection tables derived from the d3q19 constants", () => {
    const velocities = D3Q19_VELOCITIES.map(
      ([cx, cy, cz]) =>
        `vec3<i32>(${String(cx)}, ${String(cy)}, ${String(cz)})`,
    ).join(",\n  ");
    const weights = D3Q19_WEIGHTS.map((weight) => String(weight)).join(",\n  ");
    const opposites = D3Q19_OPPOSITE.map((index) => `${String(index)}u`).join(
      ",\n  ",
    );
    expect(WGSL_D3Q19_COMPUTE).toContain(
      `var<private> C = array<vec3<i32>, ${String(D3Q19_Q)}>(\n  ${velocities}\n);`,
    );
    expect(WGSL_D3Q19_COMPUTE).toContain(
      `var<private> W = array<f32, ${String(D3Q19_Q)}>(\n  ${weights}\n);`,
    );
    expect(WGSL_D3Q19_COMPUTE).toContain(
      `var<private> OPP = array<u32, ${String(D3Q19_Q)}>(\n  ${opposites}\n);`,
    );
  });

  it("declares exactly the seven step entry points and every binding slot", () => {
    for (const entryPoint of WGSL3D_ENTRY_POINTS) {
      expect(WGSL_D3Q19_COMPUTE).toContain(`fn ${entryPoint}(`);
    }
    const declared = WGSL_D3Q19_COMPUTE.match(/^fn (\w+)\(/gm) ?? [];
    expect(declaredEntryPoints(declared)).toEqual([...WGSL3D_ENTRY_POINTS]);
    for (const binding of Object.values(WGSL3D_BINDINGS)) {
      expect(WGSL_D3Q19_COMPUTE).toContain(`@binding(${String(binding)})`);
    }
    // The 3D provider declares no moments binding (the averaging raise
    // is 66b/66c's; the slot stays absent, not dead).
    expect(WGSL_D3Q19_COMPUTE).not.toContain("@binding(10)");
  });

  it("fixes the compute workgroup size at the provider's documented 64", () => {
    expect(WGSL3D_WORKGROUP_SIZE).toBe(64);
    expect(WGSL_D3Q19_COMPUTE).toContain(
      `@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})`,
    );
  });

  it("caps the grid at the 19-float storage budget", () => {
    expect(WGSL3D_MAX_NODES).toBe(Math.floor((128 * 1024 * 1024) / (4 * 19)));
  });
});

/** The entry-point names among the shader's declared functions, in order. */
function declaredEntryPoints(declared: readonly string[]): readonly string[] {
  return declared
    .map((line) => line.slice("fn ".length, line.length - 1))
    .filter((name) =>
      (WGSL3D_ENTRY_POINTS as readonly string[]).includes(name),
    );
}

describe("the 3D distribution pack (the layout contract's byte image)", () => {
  it("round-trips the CPU 3D kernel's stepped distributions bitwise", () => {
    const distributions = steppedChannel(5);
    const packed = wgsl3dPackDistributions(distributions);
    const unpacked = wgsl3dUnpackDistributions(packed, 10 * 6 * 6);
    expect(unpacked.length).toBe(D3Q19_Q);
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const plane = unpacked[i];
      const reference = distributions[i];
      if (plane === undefined || reference === undefined) continue;
      expect([...plane]).toEqual([...reference]);
    }
  });

  it("places direction i's plane at byte offset i·nodes·4 exactly", () => {
    const distributions = steppedChannel(5);
    const nodes = 10 * 6 * 6;
    const packed = wgsl3dPackDistributions(distributions);
    expect(packed.byteLength).toBe(D3Q19_Q * nodes * 4);
    const view = new DataView(packed.buffer, packed.byteOffset);
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const offset = wgsl3dDirectionByteOffset(i, nodes);
      expect(offset).toBe(i * nodes * 4);
      const plane = distributions[i];
      if (plane === undefined) continue;
      for (let n = 0; n < nodes; n += 1) {
        expect(view.getFloat32(offset + n * 4, true)).toBe(plane[n] ?? 0);
      }
    }
  });
});

describe("the 3D uniform blocks and reduction shape", () => {
  it("encodes the run params at the documented byte offsets, little-endian", () => {
    const params: Wgsl3dRunParams = {
      nx: 10,
      ny: 6,
      nz: 6,
      nodes: 360,
      collisionKind: WGSL3D_COLLISION_KINDS.trt,
      lambdaPlus: 0.75,
      lambdaMinus: 0.125,
      west: {
        kind: WGSL3D_FACE_KINDS.velocity,
        ux: 0.25,
        uy: -0.125,
        uz: 0.5,
        rho: 0,
      },
      east: { kind: WGSL3D_FACE_KINDS.pressure, ux: 0, uy: 0, uz: 0, rho: 1.5 },
      south: {
        kind: WGSL3D_FACE_KINDS.wallNoSlip,
        ux: 0,
        uy: 0,
        uz: 0,
        rho: 0,
      },
      north: {
        kind: WGSL3D_FACE_KINDS.wallSpecular,
        ux: 0,
        uy: 0,
        uz: 0,
        rho: 0,
      },
      bottom: {
        kind: WGSL3D_FACE_KINDS.convectiveOutflow,
        ux: 0,
        uy: 0,
        uz: 0,
        rho: 0,
      },
      top: { kind: WGSL3D_FACE_KINDS.velocity, ux: 0, uy: 0, uz: 0, rho: 0 },
      reduceStride: 1,
      blockNodes: 64,
      blockCount: 6,
    };
    const bytes = wgsl3dEncodeRunParams(params);
    expect(bytes.byteLength).toBe(WGSL3D_RUN_PARAMS_BYTE_LENGTH);
    expect(WGSL3D_RUN_PARAMS_BYTE_LENGTH % 16).toBe(0);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(10);
    expect(view.getUint32(4, true)).toBe(6);
    expect(view.getUint32(8, true)).toBe(6);
    expect(view.getUint32(12, true)).toBe(360);
    expect(view.getUint32(16, true)).toBe(WGSL3D_COLLISION_KINDS.trt);
    expect(view.getFloat32(20, true)).toBe(0.75);
    expect(view.getFloat32(24, true)).toBe(0.125);
    expect(view.getUint32(28, true)).toBe(WGSL3D_FACE_KINDS.velocity);
    expect(view.getUint32(32, true)).toBe(WGSL3D_FACE_KINDS.pressure);
    expect(view.getUint32(36, true)).toBe(WGSL3D_FACE_KINDS.wallNoSlip);
    expect(view.getUint32(40, true)).toBe(WGSL3D_FACE_KINDS.wallSpecular);
    expect(view.getUint32(44, true)).toBe(WGSL3D_FACE_KINDS.convectiveOutflow);
    expect(view.getFloat32(52, true)).toBe(0.25);
    expect(view.getFloat32(56, true)).toBe(-0.125);
    expect(view.getFloat32(60, true)).toBe(0.5);
    expect(view.getFloat32(76, true)).toBe(0);
    expect(view.getFloat32(128, true)).toBe(1.5);
    expect(view.getUint32(148, true)).toBe(1);
    expect(view.getUint32(152, true)).toBe(64);
    expect(view.getUint32(156, true)).toBe(6);
  });

  it("encodes the per-step params as the 16-byte block the shader declares", () => {
    const bytes = wgsl3dEncodeStepParams({ stepIndex: 7 });
    expect(bytes.byteLength).toBe(WGSL3D_STEP_PARAMS_BYTE_LENGTH);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(7);
    expect(view.getUint32(4, true)).toBe(0);
  });

  it("shapes the reduction so every node is covered exactly once, within the dispatch ceiling", () => {
    for (const nodes of [360, 131072, WGSL3D_MAX_NODES]) {
      const shape = wgsl3dReductionShape(nodes);
      expect(shape.blockNodes).toBe(WGSL3D_WORKGROUP_SIZE * shape.reduceStride);
      expect(shape.blockCount).toBe(Math.ceil(nodes / shape.blockNodes));
      expect(shape.blockCount).toBeLessThanOrEqual(65535);
      expect(shape.blockCount * shape.blockNodes).toBeGreaterThanOrEqual(nodes);
    }
    const huge = wgsl3dReductionShape(WGSL3D_MAX_NODES * 4);
    expect(huge.reduceStride).toBeGreaterThan(1);
    expect(huge.blockCount).toBeLessThanOrEqual(65535);
  });

  it("packs the mask as u32 nodes and the status block as the no-divergence sentinel", () => {
    const mask = wgsl3dPackMask(
      analyticOccupancy3d(4, 3, 2, (x, y, z) => x === 1 && y === 1 && z === 1),
    );
    expect(mask.byteLength).toBe(24 * 4);
    const view = new DataView(mask.buffer);
    expect(view.getUint32((1 + 1 * 4 + 1 * 12) * 4, true)).toBe(1);
    expect(view.getUint32(0, true)).toBe(0);
    const status = wgsl3dPackStatus();
    const statusView = new DataView(status.buffer);
    expect(statusView.getUint32(0, true)).toBe(0);
    expect(statusView.getUint32(4, true)).toBe(0xffffffff);
  });

  it("keeps every 3D matrix case's grid inside the provider's node ceiling", () => {
    for (const testCase of GPU_ORACLE_3D_MATRIX) {
      const nodes =
        testCase.config.mask.nx *
        testCase.config.mask.ny *
        testCase.config.mask.nz;
      expect(nodes).toBeLessThanOrEqual(WGSL3D_MAX_NODES);
    }
  });
});
