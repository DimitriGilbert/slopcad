/**
 * The WGSL shader module's layout tests (Phase 64a): the d2q9 layout
 * CONTRACT as the mirror spec — the generated tables, the byte-offset
 * formula, the pack/unpack round-trip against the CPU kernel's own
 * arrays, the uniform block encodings, and the reduction shape. Any
 * deviation between the CPU contract and the GPU image is a bug, and
 * these pins exist to catch it before a real device ever runs.
 */

import { describe, expect, it } from "vitest";

import { D2Q9_OPPOSITE, D2Q9_Q, D2Q9_VELOCITIES, D2Q9_WEIGHTS } from "./d2q9";
import { analyticOccupancy, testFluid } from "./fixtures";
import { GPU_ORACLE_MATRIX } from "./gpu-oracle-harness";
import { type LbmStepperConfig, createLbmStepper } from "./stepper";
import {
  WGSL_BINDINGS,
  WGSL_D2Q9_COMPUTE,
  WGSL_ENTRY_POINTS,
  WGSL_FACE_KINDS,
  WGSL_MAX_NODES,
  WGSL_RUN_PARAMS_BYTE_LENGTH,
  WGSL_STEP_PARAMS_BYTE_LENGTH,
  WGSL_WORKGROUP_SIZE,
  type WgslRunParams,
  wgslDirectionByteOffset,
  wgslEncodeRunParams,
  wgslEncodeStepParams,
  wgslPackDistributions,
  wgslPackMask,
  wgslPackStatus,
  wgslReductionShape,
  wgslUnpackDistributions,
} from "./wgsl-shader";

/** A small stepped channel with an obstacle — real distribution bytes to mirror. */
function steppedChannel(steps: number): readonly Float32Array[] {
  const config: LbmStepperConfig = {
    mask: {
      nx: 12,
      ny: 8,
      solid: analyticOccupancy(
        12,
        8,
        (x, y) => (x - 6) ** 2 + (y - 3.5) ** 2 <= 2.5 ** 2,
      ),
    },
    fluid: testFluid(1.2, 2e-4),
    cellSizeM: 0.001,
    characteristicVelocityMPerS: 0.075,
    west: { kind: "velocity-inlet", velocityMPerS: [0.05, 0] },
    east: { kind: "pressure-outlet", pressurePa: 0 },
    south: { kind: "wall", slip: false },
    north: { kind: "symmetry" },
  };
  const created = createLbmStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  created.value.run(steps);
  return created.value.distributions();
}

describe("the generated WGSL tables (the d2q9 mirror)", () => {
  it("embeds the velocity, weight, and reflection tables derived from the d2q9 constants", () => {
    const velocities = D2Q9_VELOCITIES.map(
      ([cx, cy]) => `vec2<i32>(${String(cx)}, ${String(cy)})`,
    ).join(",\n  ");
    const weights = D2Q9_WEIGHTS.map((weight) => String(weight)).join(",\n  ");
    const opposites = D2Q9_OPPOSITE.map((index) => `${String(index)}u`).join(
      ",\n  ",
    );
    expect(WGSL_D2Q9_COMPUTE).toContain(
      `var<private> C = array<vec2<i32>, ${String(D2Q9_Q)}>(\n  ${velocities}\n);`,
    );
    expect(WGSL_D2Q9_COMPUTE).toContain(
      `var<private> W = array<f32, ${String(D2Q9_Q)}>(\n  ${weights}\n);`,
    );
    expect(WGSL_D2Q9_COMPUTE).toContain(
      `var<private> OPP = array<u32, ${String(D2Q9_Q)}>(\n  ${opposites}\n);`,
    );
  });

  it("declares exactly the seven step entry points and every binding slot", () => {
    for (const entryPoint of WGSL_ENTRY_POINTS) {
      expect(WGSL_D2Q9_COMPUTE).toContain(`fn ${entryPoint}(`);
    }
    const declared = WGSL_D2Q9_COMPUTE.match(/^fn (\w+)\(/gm) ?? [];
    expect(declaredEntryPoints(declared)).toEqual([...WGSL_ENTRY_POINTS]);
    for (const binding of Object.values(WGSL_BINDINGS)) {
      expect(WGSL_D2Q9_COMPUTE).toContain(`@binding(${String(binding)})`);
    }
  });

  it("fixes the compute workgroup size at the provider's documented 64", () => {
    expect(WGSL_WORKGROUP_SIZE).toBe(64);
    expect(WGSL_D2Q9_COMPUTE).toContain(
      `@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})`,
    );
  });
});

/** The entry-point names among the shader's declared functions, in order. */
function declaredEntryPoints(declared: readonly string[]): readonly string[] {
  return declared
    .map((line) => line.slice("fn ".length, line.length - 1))
    .filter((name) => (WGSL_ENTRY_POINTS as readonly string[]).includes(name));
}

describe("the distribution pack (the layout contract's byte image)", () => {
  it("round-trips the CPU kernel's stepped distributions bitwise", () => {
    const distributions = steppedChannel(5);
    const packed = wgslPackDistributions(distributions);
    const unpacked = wgslUnpackDistributions(packed, 12 * 8);
    expect(unpacked.length).toBe(D2Q9_Q);
    for (let i = 0; i < D2Q9_Q; i += 1) {
      const plane = unpacked[i];
      const reference = distributions[i];
      if (plane === undefined || reference === undefined) continue;
      expect([...plane]).toEqual([...reference]);
    }
  });

  it("places direction i's plane at byte offset i·nodes·4 exactly", () => {
    const distributions = steppedChannel(5);
    const nodes = 12 * 8;
    const packed = wgslPackDistributions(distributions);
    expect(packed.byteLength).toBe(D2Q9_Q * nodes * 4);
    const view = new DataView(packed.buffer, packed.byteOffset);
    for (let i = 0; i < D2Q9_Q; i += 1) {
      const offset = wgslDirectionByteOffset(i, nodes);
      expect(offset).toBe(i * nodes * 4);
      const plane = distributions[i];
      if (plane === undefined) continue;
      for (let n = 0; n < nodes; n += 1) {
        expect(view.getFloat32(offset + n * 4, true)).toBe(plane[n] ?? 0);
      }
    }
  });
});

describe("the uniform blocks and reduction shape", () => {
  it("encodes the run params at the documented byte offsets, little-endian", () => {
    const params: WgslRunParams = {
      nx: 12,
      ny: 8,
      nodes: 96,
      collisionKind: 1,
      lambdaPlus: 0.75,
      lambdaMinus: 0.125,
      west: { kind: WGSL_FACE_KINDS.velocity, ux: 0.25, uy: -0.125, rho: 0 },
      east: { kind: WGSL_FACE_KINDS.pressure, ux: 0, uy: 0, rho: 1.5 },
      south: { kind: WGSL_FACE_KINDS.wallNoSlip, ux: 0, uy: 0, rho: 0 },
      north: { kind: WGSL_FACE_KINDS.wallSpecular, ux: 0, uy: 0, rho: 0 },
      reduceStride: 1,
      blockNodes: 64,
      blockCount: 2,
    };
    const bytes = wgslEncodeRunParams(params);
    expect(bytes.byteLength).toBe(WGSL_RUN_PARAMS_BYTE_LENGTH);
    expect(WGSL_RUN_PARAMS_BYTE_LENGTH % 16).toBe(0);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(12);
    expect(view.getUint32(4, true)).toBe(8);
    expect(view.getUint32(8, true)).toBe(96);
    expect(view.getUint32(12, true)).toBe(1);
    expect(view.getFloat32(16, true)).toBe(0.75);
    expect(view.getFloat32(20, true)).toBe(0.125);
    expect(view.getUint32(24, true)).toBe(WGSL_FACE_KINDS.velocity);
    expect(view.getUint32(28, true)).toBe(WGSL_FACE_KINDS.pressure);
    expect(view.getUint32(32, true)).toBe(WGSL_FACE_KINDS.wallNoSlip);
    expect(view.getUint32(36, true)).toBe(WGSL_FACE_KINDS.wallSpecular);
    expect(view.getFloat32(40, true)).toBe(0.25);
    expect(view.getFloat32(44, true)).toBe(-0.125);
    expect(view.getFloat32(72, true)).toBe(0);
    expect(view.getFloat32(76, true)).toBe(1.5);
    expect(view.getUint32(88, true)).toBe(1);
    expect(view.getUint32(92, true)).toBe(64);
    expect(view.getUint32(96, true)).toBe(2);
  });

  it("encodes the per-step params as the 16-byte block the shader declares", () => {
    const bytes = wgslEncodeStepParams({
      stepIndex: 7,
      averaging: true,
      averageCount: 3,
    });
    expect(bytes.byteLength).toBe(WGSL_STEP_PARAMS_BYTE_LENGTH);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(7);
    expect(view.getUint32(4, true)).toBe(1);
    expect(view.getUint32(8, true)).toBe(3);
    expect(view.getUint32(12, true)).toBe(0);
  });

  it("shapes the reduction so every node is covered exactly once, within the dispatch ceiling", () => {
    for (const nodes of [96, 131072, WGSL_MAX_NODES]) {
      const shape = wgslReductionShape(nodes);
      expect(shape.blockNodes).toBe(WGSL_WORKGROUP_SIZE * shape.reduceStride);
      expect(shape.blockCount).toBe(Math.ceil(nodes / shape.blockNodes));
      expect(shape.blockCount).toBeLessThanOrEqual(65535);
      expect(shape.blockCount * shape.blockNodes).toBeGreaterThanOrEqual(nodes);
    }
    const huge = wgslReductionShape(WGSL_MAX_NODES * 4);
    expect(huge.reduceStride).toBeGreaterThan(1);
    expect(huge.blockCount).toBeLessThanOrEqual(65535);
  });

  it("packs the mask as u32 nodes and the status block as the no-divergence sentinel", () => {
    const mask = wgslPackMask(
      analyticOccupancy(4, 3, (x, y) => x === 1 && y === 1),
    );
    expect(mask.byteLength).toBe(12 * 4);
    const view = new DataView(mask.buffer);
    expect(view.getUint32((1 + 1 * 4) * 4, true)).toBe(1);
    expect(view.getUint32(0, true)).toBe(0);
    const status = wgslPackStatus();
    const statusView = new DataView(status.buffer);
    expect(statusView.getUint32(0, true)).toBe(0);
    expect(statusView.getUint32(4, true)).toBe(0xffffffff);
  });

  it("keeps every matrix case's grid inside the provider's node ceiling", () => {
    for (const testCase of GPU_ORACLE_MATRIX) {
      const nodes = testCase.config.mask.nx * testCase.config.mask.ny;
      expect(nodes).toBeLessThanOrEqual(WGSL_MAX_NODES);
    }
  });
});
