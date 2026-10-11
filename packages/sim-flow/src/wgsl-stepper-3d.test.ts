/**
 * The 3D WGSL stepper's orchestration tests (Phase 66a): the D3Q19
 * provider driven against the node-side FAKE DEVICE (the 64a seam,
 * reused unchanged) — no shader executes, but everything around the
 * shader is pinned: the buffer set and sizes (the d3q19 mirror), the
 * bitwise initial state, the fixed per-step dispatch sequence and
 * counts, the bind-group parity alternation that IS the swap, the
 * per-step uniform write, the readback framing, the honest declines,
 * destruction, and the determinism of the whole orchestration layer.
 */

import { describe, expect, it } from "vitest";

import { analyticOccupancy3d, testFluid } from "./fixtures";
import { D3Q19_Q } from "./d3q19";
import { createLbm3dStepper, type Lbm3dStepperConfig } from "./stepper-3d";
import { createWgslFakeDevice, type WgslFakeTrace } from "./wgsl-fake-device";
import { createWgsl3dStepper } from "./wgsl-stepper-3d";
import {
  WGSL3D_ENTRY_POINTS,
  WGSL3D_RUN_PARAMS_BYTE_LENGTH,
  WGSL3D_STEP_PARAMS_BYTE_LENGTH,
  WGSL3D_WORKGROUP_SIZE,
} from "./wgsl-shader-3d";

/** The shared small 3D channel: 10×6×6, a box obstacle, all face kinds. */
function channelConfig(): Lbm3dStepperConfig {
  return {
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
    north: { kind: "symmetry" },
    bottom: { kind: "convective-outflow" },
    top: { kind: "wall", slip: true },
  };
}

const NODES = 10 * 6 * 6;
const NODE_WORKGROUPS = Math.ceil(NODES / WGSL3D_WORKGROUP_SIZE);

/** The fixed per-step pass sequence with its dispatch counts. */
function expectedStepPasses(): readonly {
  readonly entryPoint: string;
  readonly workgroups: number;
}[] {
  return [
    { entryPoint: "collide_step", workgroups: NODE_WORKGROUPS },
    { entryPoint: "stream_pull", workgroups: NODE_WORKGROUPS },
    { entryPoint: "apply_faces", workgroups: NODE_WORKGROUPS },
    { entryPoint: "reflect_solids", workgroups: NODE_WORKGROUPS },
    { entryPoint: "reduce_partials", workgroups: NODE_WORKGROUPS },
    { entryPoint: "reduce_forces", workgroups: 1 },
    { entryPoint: "macro_out", workgroups: NODE_WORKGROUPS },
  ];
}

describe("createWgsl3dStepper against the fake device", () => {
  it("creates the documented buffer set with the d3q19-contract sizes and labels", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 16,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { buffers } = device.trace;
    expect(buffers.map((buffer) => buffer.label)).toEqual([
      "dist-first",
      "dist-second",
      "macro",
      "mask",
      "impulse",
      "partials",
      "status",
      "forces",
      "run-params",
      "step-params",
    ]);
    const byLabel = new Map(buffers.map((buffer) => [buffer.label, buffer]));
    expect(byLabel.get("dist-first")?.byteLength).toBe(D3Q19_Q * NODES * 4);
    expect(byLabel.get("dist-second")?.byteLength).toBe(D3Q19_Q * NODES * 4);
    expect(byLabel.get("macro")?.byteLength).toBe(NODES * 4 * 4);
    expect(byLabel.get("mask")?.byteLength).toBe(NODES * 4);
    expect(byLabel.get("impulse")?.byteLength).toBe(NODES * 3 * 4);
    expect(byLabel.get("partials")?.byteLength).toBe(NODE_WORKGROUPS * 3 * 4);
    expect(byLabel.get("status")?.byteLength).toBe(8);
    expect(byLabel.get("forces")?.byteLength).toBe(16 * 3 * 4);
    expect(byLabel.get("run-params")?.byteLength).toBe(
      WGSL3D_RUN_PARAMS_BYTE_LENGTH,
    );
    expect(byLabel.get("step-params")?.byteLength).toBe(
      WGSL3D_STEP_PARAMS_BYTE_LENGTH,
    );
  });

  it("seeds the GPU distributions bitwise-equal to the CPU twin's step-0 state", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 4,
    });
    if (!created.ok) throw new Error(created.error.message);
    const cpu = createLbm3dStepper(channelConfig());
    if (!cpu.ok) throw new Error(cpu.error.message);
    for (const label of ["dist-first", "dist-second"]) {
      const buffer = device.bufferByLabel(label);
      if (buffer === undefined) throw new Error(`missing buffer ${label}`);
      const bytes = await device.readBuffer(buffer);
      const gpu = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        NODES * D3Q19_Q,
      );
      const reference = cpu.value.distributions();
      for (let i = 0; i < D3Q19_Q; i += 1) {
        const plane = reference[i];
        if (plane === undefined) continue;
        for (let n = 0; n < NODES; n += 1) {
          expect(gpu[i * NODES + n]).toBe(plane[n] ?? 0);
        }
      }
    }
  });

  it("submits the fixed seven-pass sequence per step with the parity swap", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 8,
    });
    if (!created.ok) throw new Error(created.error.message);
    const stepper = created.value;
    const initialWrites = device.trace.writes.length;
    // The setup writes: both distributions, mask, macro, status, run params.
    expect(initialWrites).toBe(6);
    stepper.advance();
    stepper.advance();
    stepper.advance();
    expect(stepper.step).toBe(3);
    expect(stepper.diverged).toBe(false);
    const { dispatches, submissions, writes } = device.trace;
    expect(submissions).toEqual([{ passes: 7 }, { passes: 7 }, { passes: 7 }]);
    expect(dispatches.length).toBe(21);
    for (let step = 0; step < 3; step += 1) {
      const slice = dispatches.slice(step * 7, step * 7 + 7);
      expect(
        slice.map((entry) => ({
          entryPoint: entry.entryPoint,
          workgroups: entry.workgroups,
        })),
      ).toEqual([...expectedStepPasses()]);
      // The parity swap: collide reads distSrc from buffer 0 on odd
      // steps, buffer 1 on even steps — the reference-exchange swap.
      const collideBindings = slice[0]?.groupBuffers;
      expect(collideBindings?.[0]).toEqual([step % 2 === 0 ? 0 : 1]);
      const streamBindings = slice[1]?.groupBuffers;
      expect(streamBindings).toEqual([
        [step % 2 === 0 ? 0 : 1],
        [step % 2 === 0 ? 1 : 0],
        [8],
      ]);
    }
    // One per-step uniform write per advance, after the six setup writes.
    expect(writes.length).toBe(6 + 3);
    const stepWrites = writes.slice(6);
    for (const write of stepWrites) {
      expect(write.buffer).toBe(9);
      expect(write.offsetBytes).toBe(0);
      expect(write.byteLength).toBe(WGSL3D_STEP_PARAMS_BYTE_LENGTH);
    }
    // The third step's uniform: stepIndex 3.
    const stepParamsBuffer = device.bufferByLabel("step-params");
    if (stepParamsBuffer === undefined) {
      throw new Error("missing step-params buffer");
    }
    const stepParams = await device.readBuffer(stepParamsBuffer);
    const view = new DataView(stepParams.buffer, stepParams.byteOffset);
    expect(view.getUint32(0, true)).toBe(3);
  });

  it("compiles the seven entry points exactly once each, in the fixed order", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 2,
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(
      device.trace.pipelines.map((pipeline) => pipeline.entryPoint),
    ).toEqual([...WGSL3D_ENTRY_POINTS]);
  });

  it("reads back through the documented framing: distributions, macro, forces", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 5,
    });
    if (!created.ok) throw new Error(created.error.message);
    const stepper = created.value;
    stepper.advance();
    stepper.advance();
    const distributions = await stepper.distributions();
    expect(distributions.length).toBe(D3Q19_Q);
    for (const plane of distributions) {
      expect(plane.length).toBe(NODES);
    }
    const snapshot = await stepper.snapshotLattice();
    expect(snapshot.rho.length).toBe(NODES);
    expect(snapshot.uz.length).toBe(NODES);
    expect(snapshot.step).toBe(2);
    // The fake executes no shader, so the macro readback still carries
    // the seeded initial state: rho = 1 at fluid nodes, 0 at solids.
    const solid = channelConfig().mask.solid;
    for (let n = 0; n < NODES; n += 1) {
      expect(snapshot.rho[n]).toBe(solid[n] === 1 ? 0 : 1);
    }
    const forces = await stepper.forceState();
    expect(forces.history.map((series) => series.name)).toEqual([
      "drag",
      "lift",
      "side",
    ]);
    expect(forces.history[0]?.samples.length).toBe(2);
    await stepper.syncStatus();
    expect(stepper.diverged).toBe(false);
    expect(stepper.step).toBe(2);
  });

  it("is deterministic: the same config on two fresh devices yields identical traces", async () => {
    const run = async (): Promise<WgslFakeTrace> => {
      const device = createWgslFakeDevice();
      const created = await createWgsl3dStepper(channelConfig(), device, {
        stepCapacity: 4,
      });
      if (!created.ok) throw new Error(created.error.message);
      created.value.advance();
      created.value.advance();
      await created.value.syncStatus();
      await created.value.distributions();
      await created.value.forceState();
      return device.trace;
    };
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it("refuses the inputs the provider cannot honor, loudly", async () => {
    const device = createWgslFakeDevice();
    const noCapacity = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 0,
    });
    expect(noCapacity.ok).toBe(false);
    if (noCapacity.ok) return;
    expect(noCapacity.error.code).toBe("sim/scenario-invalid");

    const oversized = await createWgsl3dStepper(
      {
        ...channelConfig(),
        mask: {
          nx: 200,
          ny: 200,
          nz: 200,
          solid: new Uint8Array(200 * 200 * 200),
        },
      },
      device,
      { stepCapacity: 4 },
    );
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.error.message).toContain("storage-binding");
  });

  it("freezes host-side on divergence and truncates to the first diverged step", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 6,
    });
    if (!created.ok) throw new Error(created.error.message);
    const stepper = created.value;
    stepper.advance();
    stepper.advance();
    // Simulate the shader's sentinel: flag set, first diverged step 2.
    const status = device.bufferByLabel("status");
    if (status === undefined) throw new Error("missing status buffer");
    device.queue.writeBuffer(
      status,
      0,
      new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]),
    );
    await stepper.syncStatus();
    expect(stepper.diverged).toBe(true);
    expect(stepper.step).toBe(1);
    const before = device.trace.dispatches.length;
    stepper.advance();
    expect(device.trace.dispatches.length).toBe(before);
    const forces = await stepper.forceState();
    expect(forces.history[0]?.samples.length).toBe(1);
  });

  it("forceState syncs first: an unsynced diverged run reports no zero slots past the freeze", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 6,
    });
    if (!created.ok) throw new Error(created.error.message);
    const stepper = created.value;
    stepper.advance();
    stepper.advance();
    stepper.advance();
    const status = device.bufferByLabel("status");
    if (status === undefined) throw new Error("missing status buffer");
    device.queue.writeBuffer(
      status,
      0,
      new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]),
    );
    const forces = await stepper.forceState();
    expect(stepper.diverged).toBe(true);
    expect(stepper.step).toBe(1);
    expect(forces.history[0]?.samples.length).toBe(1);
    expect(forces.history[1]?.samples.length).toBe(1);
    expect(forces.history[2]?.samples.length).toBe(1);
  });

  it("throws on advance() past the force-history capacity, before any submit", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 2,
    });
    if (!created.ok) throw new Error(created.error.message);
    const stepper = created.value;
    stepper.advance();
    stepper.advance();
    const before = device.trace.dispatches.length;
    const writesBefore = device.trace.writes.length;
    expect(() => stepper.advance()).toThrow(/step slots/);
    expect(stepper.step).toBe(2);
    expect(device.trace.dispatches.length).toBe(before);
    expect(device.trace.writes.length).toBe(writesBefore);
  });

  it("gives every host-written buffer copy-destination usage (writeBuffer's spec requirement)", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 3,
    });
    if (!created.ok) throw new Error(created.error.message);
    created.value.advance();
    created.value.advance();
    const { buffers, writes } = device.trace;
    expect(writes.length).toBeGreaterThan(0);
    const writtenOrdinals = [
      ...new Set(writes.map((write) => write.buffer)),
    ].sort((a, b) => a - b);
    // Every buffer the orchestration ever writes: the two distribution
    // parities, macro, mask, status, run params (setup) and step
    // params (one write per advance).
    expect(writtenOrdinals).toEqual([0, 1, 2, 3, 6, 8, 9]);
    for (const ordinal of writtenOrdinals) {
      const info = buffers[ordinal];
      if (info === undefined) {
        throw new Error(`missing buffer ordinal ${String(ordinal)}`);
      }
      expect(info.usage).toContain("copy-destination");
    }
  });

  it("throws on use after destroy (the fake's honest failure surface)", async () => {
    const device = createWgslFakeDevice();
    const created = await createWgsl3dStepper(channelConfig(), device, {
      stepCapacity: 2,
    });
    if (!created.ok) throw new Error(created.error.message);
    created.value.destroy();
    await expect(created.value.snapshotLattice()).rejects.toThrow(/destroyed/);
  });
});
