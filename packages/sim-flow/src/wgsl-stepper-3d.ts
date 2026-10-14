/**
 * The WGSL 3D stepper (Phase 66a): the D3Q19 GPU provider's
 * orchestration over the `./wgsl-shader-3d` compute module, written
 * against the narrow `./gpu-device` seam (REUSED unchanged from the 2D
 * provider — feature detection, the fake device, and the CPU fallback
 * discipline are device-level concerns, and 66a adds no new ones).
 * The surface mirrors the CPU 3D stepper's (`./stepper-3d`) readout
 * contract — meta, step/diverged, distributions (the layout contract's
 * diff surface), snapshots, force histories, solver fields — with the
 * one honest difference the contract documents: reads are ASYNC
 * (device readbacks) and the kernel arithmetic is f32, not the CPU's
 * f64-with-f32-stores. That difference is exactly what the S5
 * oracle-vs-GPU tolerance harness gates (`./gpu-oracle-3d-harness`);
 * nothing here is ever bit-asserted against the oracle.
 *
 * Validation and unit derivation are SHARED with the CPU, not
 * duplicated: `createWgsl3dStepper` first builds the CPU 3D stepper
 * from the same config — every input refusal is the CPU's own refusal,
 * and the derived `Lbm3dRunMeta` (unit closure, rates, reference
 * pressure) is consumed verbatim as the uniform block's source. The
 * face conditions convert SI → lattice through the SAME expressions
 * `./stepper-3d`'s compileFace uses ((v·dt)/dx and the pressure
 * factor), so the uniform values are the CPU's values.
 *
 * Determinism (law S2's provider posture): the orchestration is a
 * fixed function of its inputs — fixed buffer set and sizes, fixed
 * pipeline creation order, fixed per-step pass sequence, fixed
 * bind-group parity alternation, fixed write placement. No clock, no
 * randomness, no host-dependent branching.
 *
 * The per-step dispatch sequence (asserted by the fake-device tests):
 * collide_step → stream_pull → apply_faces → reflect_solids →
 * reduce_partials → reduce_forces → macro_out — the CPU advance order,
 * decomposed per `./wgsl-shader-3d`'s contract block. Divergence is
 * discovered at readback boundaries (`syncStatus`): the shader freezes
 * itself through the status buffer the moment it trips, and the
 * host-side step count truncates to the first diverged step when
 * synced — the CPU's freeze, reported at the readback cadence instead
 * of instantly (stated honestly in 64a, unchanged here).
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimHistorySeries,
  type SimParseResult,
  type SolverSimField,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type {
  WgslBindGroup,
  WgslBindGroupEntry,
  WgslBuffer,
  WgslComputePipeline,
  WgslDevice,
} from "./gpu-device";

import { D3Q19_Q } from "./d3q19";
import { LBM3D_FORCE_SERIES_NAMES, LBM3D_FORCE_UNIT } from "./forces-3d";
import {
  type Lbm3dLatticeSnapshot,
  type Lbm3dRunMeta,
  type Lbm3dStepperConfig,
  createLbm3dStepper,
} from "./stepper-3d";
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
  type Wgsl3dFaceParams,
  type Wgsl3dRunParams,
  wgsl3dEncodeRunParams,
  wgsl3dEncodeStepParams,
  wgsl3dPackDistributions,
  wgsl3dPackMask,
  wgsl3dPackStatus,
  wgsl3dReductionShape,
  wgsl3dUnpackDistributions,
} from "./wgsl-shader-3d";

/** What {@link createWgsl3dStepper} takes beyond the CPU stepper's config. */
export interface Wgsl3dStepperOptions {
  /**
   * The force-history capacity: the number of steps the stepper may
   * record (the engine passes its step budget). A positive integer.
   * `advance()` past this capacity THROWS before submitting — the
   * force-history buffer holds exactly this many sample slots.
   */
  readonly stepCapacity: number;
}

/** The 3D WGSL provider's stepper — the CPU 3D stepper's shape, async. */
export interface Wgsl3dStepper {
  /** The shared run facts (derived by the CPU twin's own closure). */
  readonly meta: Lbm3dRunMeta;
  /** Submitted steps, truncated to the first diverged step once synced. */
  get step(): number;
  /** Whether the run diverged (as of the last {@link Wgsl3dStepper} sync). */
  get diverged(): boolean;
  /**
   * Submits one step's fixed compute-pass sequence (no host wait).
   * Throws (before any submit) on a step past the force-history
   * capacity — a submit that far would write `reduce_forces` output
   * past the history buffer's end.
   */
  advance(): void;
  /** Reads the divergence status back and truncates the step count. */
  syncStatus(): Promise<void>;
  /** Macroscopic fields, lattice units, freshly read back (copies). */
  snapshotLattice(): Promise<Lbm3dLatticeSnapshot>;
  /**
   * The live distribution set, read back — the layout contract's diff
   * surface: nineteen per-direction arrays of nx·ny·nz, x-fastest.
   */
  distributions(): Promise<readonly Float32Array[]>;
  /**
   * The force history triple (SI newtons, converted once at readback).
   * Reads the divergence status FIRST (an implicit {@link syncStatus}):
   * an unsynced diverged run reports only the samples it actually
   * recorded — never the zero-initialized slots past the freeze.
   */
  forceState(): Promise<{
    readonly current: {
      readonly dragN: number;
      readonly liftN: number;
      readonly sideN: number;
    };
    readonly history: readonly SimHistorySeries[];
  }>;
  /**
   * The S4-ready solver fields (velocity-x/y/z, speed, pressure) —
   * mirroring the CPU 3D stepper's field set and labels.
   */
  solverFields(): Promise<readonly SolverSimField[]>;
  /** Frees the stepper's buffers (the device itself is the owner's). */
  destroy(): void;
}

/** One entry point's pipeline plus its two buffer-parity bind groups. */
interface PassSet {
  readonly pipeline: WgslComputePipeline;
  /** Bind group per parity: index 0 reads src=first, 1 reads src=second. */
  readonly groups: readonly [WgslBindGroup, WgslBindGroup];
}

/** The entry-point name by short key (creation order = WGSL3D_ENTRY_POINTS). */
type PassKey = (typeof WGSL3D_ENTRY_POINTS)[number];

/** The per-entry-point binding sets (exactly the shader's used globals). */
const PASS_BINDINGS: Readonly<Record<PassKey, readonly number[]>> = {
  collide_step: [
    WGSL3D_BINDINGS.distSrc,
    WGSL3D_BINDINGS.macro,
    WGSL3D_BINDINGS.mask,
    WGSL3D_BINDINGS.status,
    WGSL3D_BINDINGS.runParams,
    WGSL3D_BINDINGS.stepParams,
  ],
  stream_pull: [
    WGSL3D_BINDINGS.distSrc,
    WGSL3D_BINDINGS.distDst,
    WGSL3D_BINDINGS.runParams,
  ],
  apply_faces: [
    WGSL3D_BINDINGS.distSrc,
    WGSL3D_BINDINGS.distDst,
    WGSL3D_BINDINGS.macro,
    WGSL3D_BINDINGS.mask,
    WGSL3D_BINDINGS.runParams,
  ],
  reflect_solids: [
    WGSL3D_BINDINGS.distDst,
    WGSL3D_BINDINGS.mask,
    WGSL3D_BINDINGS.impulse,
    WGSL3D_BINDINGS.status,
    WGSL3D_BINDINGS.runParams,
  ],
  reduce_partials: [
    WGSL3D_BINDINGS.impulse,
    WGSL3D_BINDINGS.partials,
    WGSL3D_BINDINGS.runParams,
  ],
  reduce_forces: [
    WGSL3D_BINDINGS.partials,
    WGSL3D_BINDINGS.status,
    WGSL3D_BINDINGS.forces,
    WGSL3D_BINDINGS.runParams,
    WGSL3D_BINDINGS.stepParams,
  ],
  macro_out: [
    WGSL3D_BINDINGS.distDst,
    WGSL3D_BINDINGS.macro,
    WGSL3D_BINDINGS.mask,
    WGSL3D_BINDINGS.status,
    WGSL3D_BINDINGS.runParams,
  ],
};

/**
 * Converts one face's SI spec into its uniform parameters (compileFace's
 * math).
 */
function wgsl3dFaceParams(
  spec: Lbm3dStepperConfig["west"],
  units: Lbm3dRunMeta["units"],
  referencePressurePa: number,
): Wgsl3dFaceParams {
  switch (spec.kind) {
    case "velocity-inlet": {
      const [vx, vy, vz] = spec.velocityMPerS;
      return {
        kind: WGSL3D_FACE_KINDS.velocity,
        ux: (vx * units.timeStepS) / units.cellSizeM,
        uy: (vy * units.timeStepS) / units.cellSizeM,
        uz: (vz * units.timeStepS) / units.cellSizeM,
        rho: 0,
      };
    }
    case "pressure-outlet":
      return {
        kind: WGSL3D_FACE_KINDS.pressure,
        ux: 0,
        uy: 0,
        uz: 0,
        rho:
          1 + (spec.pressurePa - referencePressurePa) / units.pressureFactorPa,
      };
    case "convective-outflow":
      return {
        kind: WGSL3D_FACE_KINDS.convectiveOutflow,
        ux: 0,
        uy: 0,
        uz: 0,
        rho: 0,
      };
    case "wall":
      return {
        kind: spec.slip
          ? WGSL3D_FACE_KINDS.wallSpecular
          : WGSL3D_FACE_KINDS.wallNoSlip,
        ux: 0,
        uy: 0,
        uz: 0,
        rho: 0,
      };
    case "symmetry":
      return {
        kind: WGSL3D_FACE_KINDS.wallSpecular,
        ux: 0,
        uy: 0,
        uz: 0,
        rho: 0,
      };
  }
}

/** The initial macro block: ρ = 1, u = 0 at fluid nodes, zero at solids. */
function initialMacroBytes(nodes: number, solid: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(nodes * 4 * 4);
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < nodes; n += 1) {
    if (solid[n] === 1) continue;
    view.setFloat32(n * 4, 1, true);
  }
  return bytes;
}

/** Reads four f32 planes (ρ, ux, uy, uz) from a macro readback. */
function macroPlanes(
  bytes: Uint8Array,
  nodes: number,
): {
  rho: Float64Array;
  ux: Float64Array;
  uy: Float64Array;
  uz: Float64Array;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rho = new Float64Array(nodes);
  const ux = new Float64Array(nodes);
  const uy = new Float64Array(nodes);
  const uz = new Float64Array(nodes);
  for (let n = 0; n < nodes; n += 1) {
    rho[n] = view.getFloat32(n * 4, true);
    ux[n] = view.getFloat32((nodes + n) * 4, true);
    uy[n] = view.getFloat32((2 * nodes + n) * 4, true);
    uz[n] = view.getFloat32((3 * nodes + n) * 4, true);
  }
  return { rho, ux, uy, uz };
}

/** Builds the solver field set from a macro readback (the CPU twin's mirror). */
function solverFieldsFromMacro(
  snapshot: Lbm3dLatticeSnapshot,
  meta: Lbm3dRunMeta,
  originM: readonly [number, number, number],
): readonly SolverSimField[] {
  const { nx, ny, nz } = meta;
  const dx = meta.units.cellSizeM;
  const velocityValuesX: number[] = [];
  const velocityValuesY: number[] = [];
  const velocityValuesZ: number[] = [];
  const speedValues: number[] = [];
  const pressureValues: number[] = [];
  for (let index = 0; index < snapshot.rho.length; index += 1) {
    const vx = (snapshot.ux[index] ?? 0) * meta.units.velocityFactor;
    const vy = (snapshot.uy[index] ?? 0) * meta.units.velocityFactor;
    const vz = (snapshot.uz[index] ?? 0) * meta.units.velocityFactor;
    velocityValuesX.push(vx);
    velocityValuesY.push(vy);
    velocityValuesZ.push(vz);
    speedValues.push(Math.sqrt(vx * vx + vy * vy + vz * vz));
    pressureValues.push(
      meta.referencePressurePa +
        ((snapshot.rho[index] ?? 0) - 1) * meta.units.pressureFactorPa,
    );
  }
  const geometry = {
    extent: [nx, ny, nz] as const,
    originM: [originM[0] ?? 0, originM[1] ?? 0, originM[2] ?? 0] as const,
    spacingM: [dx, dx, dx] as const,
    dataType: "float32" as const,
  };
  return [
    {
      id: "velocity-x",
      unit: "mm/s",
      dimension: "velocity",
      values: velocityValuesX,
      ...geometry,
    },
    {
      id: "velocity-y",
      unit: "mm/s",
      dimension: "velocity",
      values: velocityValuesY,
      ...geometry,
    },
    {
      id: "velocity-z",
      unit: "mm/s",
      dimension: "velocity",
      values: velocityValuesZ,
      ...geometry,
    },
    {
      id: "speed",
      unit: "mm/s",
      dimension: "velocity",
      values: speedValues,
      ...geometry,
    },
    {
      id: "pressure",
      unit: "Pa",
      dimension: "pressure",
      values: pressureValues,
      ...geometry,
    },
  ];
}

/**
 * Creates the WGSL 3D stepper: validates through the CPU twin, mirrors
 * the initial state bitwise (the layout contract's pack), compiles the
 * seven pipelines in fixed order, and materializes the two buffer
 * parities. Refuses the inputs the CPU refuses, plus the provider's
 * own bounds (the guaranteed-limit grid ceiling, the history capacity).
 */
export async function createWgsl3dStepper(
  config: Lbm3dStepperConfig,
  device: WgslDevice,
  options: Wgsl3dStepperOptions,
): Promise<SimParseResult<Wgsl3dStepper, SimError>> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  // Rotating configs decline BEFORE anything else — Phase 66b keeps
  // MRF and resolved rotation CPU-oracle-only (the WGSL provider hosts
  // the static kernel), and a rotating scenario reaching this door must
  // hear that loudly, never run rotation-free physics silently.
  if (config.rotation !== undefined) {
    const door =
      config.rotation.kind === "mrf"
        ? "createMrf3dStepper"
        : "createResolvedRotation3dStepper";
    return refuse(
      `The 3D WGSL provider does not host rotating configs (Phase 66b: MRF and resolved rotation are CPU-oracle-only); the marker kind "${config.rotation.kind}" must go through ${door} on the CPU path.`,
      config.rotation,
    );
  }
  // The provider's own grid ceiling first: an over-cap grid declines
  // before the CPU twin's buffers are ever requested.
  const rawNx = config.mask.nx;
  const rawNy = config.mask.ny;
  const rawNz = config.mask.nz;
  if (
    Number.isInteger(rawNx) &&
    Number.isInteger(rawNy) &&
    Number.isInteger(rawNz) &&
    rawNx * rawNy * rawNz > WGSL3D_MAX_NODES
  ) {
    return refuse(
      `The 3D WGSL provider hosts grids up to ${String(WGSL3D_MAX_NODES)} nodes inside the guaranteed storage-binding size; ${String(rawNx)}×${String(rawNy)}×${String(rawNz)} is ${String(rawNx * rawNy * rawNz)}.`,
      { nx: rawNx, ny: rawNy, nz: rawNz },
    );
  }
  // The CPU twin: one source of truth for validation, units, and rates.
  const twin = createLbm3dStepper(config);
  if (!twin.ok) return twin;
  const meta = twin.value.meta;
  const nx = meta.nx;
  const ny = meta.ny;
  const nz = meta.nz;
  const nodes = nx * ny * nz;
  if (
    !Number.isInteger(options.stepCapacity) ||
    options.stepCapacity < 1 ||
    options.stepCapacity > Math.floor(0xffffffff / 3)
  ) {
    return refuse(
      "A 3D WGSL stepper's step capacity must be a positive integer (the force-history buffer's length).",
      options.stepCapacity,
    );
  }

  // --- Buffers (fixed set, fixed labels, fixed order) -----------------------
  const distBytes = D3Q19_Q * nodes * 4;
  const distFirst = device.createBuffer(
    distBytes,
    ["storage", "copy-source", "copy-destination"],
    "dist-first",
  );
  const distSecond = device.createBuffer(
    distBytes,
    ["storage", "copy-source", "copy-destination"],
    "dist-second",
  );
  // Host-written buffers carry copy-destination: queue.writeBuffer on
  // a buffer without it is a WebGPU validation error on real hardware
  // (the write is rejected, the provider computes nothing) — the fake
  // device mirrors that check so the mistake cannot pass headlessly.
  const macroBuffer = device.createBuffer(
    nodes * 4 * 4,
    ["storage", "copy-source", "copy-destination"],
    "macro",
  );
  const maskBuffer = device.createBuffer(
    nodes * 4,
    ["storage", "copy-destination"],
    "mask",
  );
  const impulseBuffer = device.createBuffer(
    nodes * 3 * 4,
    ["storage"],
    "impulse",
  );
  const shape = wgsl3dReductionShape(nodes);
  const partialsBuffer = device.createBuffer(
    shape.blockCount * 3 * 4,
    ["storage"],
    "partials",
  );
  const statusBuffer = device.createBuffer(
    8,
    ["storage", "copy-source", "copy-destination"],
    "status",
  );
  const forcesBuffer = device.createBuffer(
    options.stepCapacity * 3 * 4,
    ["storage", "copy-source"],
    "forces",
  );
  const runParamsBuffer = device.createBuffer(
    WGSL3D_RUN_PARAMS_BYTE_LENGTH,
    ["uniform", "copy-destination"],
    "run-params",
  );
  const stepParamsBuffer = device.createBuffer(
    WGSL3D_STEP_PARAMS_BYTE_LENGTH,
    ["uniform", "copy-destination"],
    "step-params",
  );

  // --- Pipelines and the two buffer parities (fixed creation order) ---------
  const passes = new Map<PassKey, PassSet>();
  for (const entryPoint of WGSL3D_ENTRY_POINTS) {
    const pipeline = await device.createComputePipeline(
      WGSL_D3Q19_COMPUTE,
      entryPoint,
      entryPoint,
    );
    const bufferFor = (
      binding: number,
      parity: 0 | 1,
    ): WgslBuffer | undefined => {
      switch (binding) {
        case WGSL3D_BINDINGS.distSrc:
          return parity === 0 ? distFirst : distSecond;
        case WGSL3D_BINDINGS.distDst:
          return parity === 0 ? distSecond : distFirst;
        case WGSL3D_BINDINGS.macro:
          return macroBuffer;
        case WGSL3D_BINDINGS.mask:
          return maskBuffer;
        case WGSL3D_BINDINGS.impulse:
          return impulseBuffer;
        case WGSL3D_BINDINGS.partials:
          return partialsBuffer;
        case WGSL3D_BINDINGS.status:
          return statusBuffer;
        case WGSL3D_BINDINGS.forces:
          return forcesBuffer;
        case WGSL3D_BINDINGS.runParams:
          return runParamsBuffer;
        case WGSL3D_BINDINGS.stepParams:
          return stepParamsBuffer;
        default:
          return undefined;
      }
    };
    const buildGroup = (parity: 0 | 1): WgslBindGroup => {
      const entries: WgslBindGroupEntry[] = [];
      for (const binding of PASS_BINDINGS[entryPoint]) {
        const buffer = bufferFor(binding, parity);
        if (buffer === undefined) {
          throw new Error(
            `The 3D WGSL pass "${entryPoint}" declared binding ${String(binding)} with no buffer.`,
          );
        }
        entries.push({ binding, buffer });
      }
      return pipeline.createBindGroup(
        entries,
        `${entryPoint}-p${String(parity)}`,
      );
    };
    passes.set(entryPoint, {
      pipeline,
      groups: [buildGroup(0), buildGroup(1)],
    });
  }

  // --- Initial state (the bitwise mirror of the CPU twin's step 0) ----------
  const initialDistributions = twin.value.distributions();
  const packed = wgsl3dPackDistributions(initialDistributions);
  device.queue.writeBuffer(distFirst, 0, packed);
  device.queue.writeBuffer(distSecond, 0, packed);
  device.queue.writeBuffer(maskBuffer, 0, wgsl3dPackMask(config.mask.solid));
  device.queue.writeBuffer(
    macroBuffer,
    0,
    initialMacroBytes(nodes, config.mask.solid),
  );
  device.queue.writeBuffer(statusBuffer, 0, wgsl3dPackStatus());
  const runParams: Wgsl3dRunParams = {
    nx,
    ny,
    nz,
    nodes,
    collisionKind:
      meta.collision.kind === "bgk"
        ? WGSL3D_COLLISION_KINDS.bgk
        : WGSL3D_COLLISION_KINDS.trt,
    lambdaPlus: meta.rates.lambdaPlus,
    lambdaMinus: meta.rates.lambdaMinus,
    west: wgsl3dFaceParams(config.west, meta.units, meta.referencePressurePa),
    east: wgsl3dFaceParams(config.east, meta.units, meta.referencePressurePa),
    south: wgsl3dFaceParams(config.south, meta.units, meta.referencePressurePa),
    north: wgsl3dFaceParams(config.north, meta.units, meta.referencePressurePa),
    bottom: wgsl3dFaceParams(
      config.bottom,
      meta.units,
      meta.referencePressurePa,
    ),
    top: wgsl3dFaceParams(config.top, meta.units, meta.referencePressurePa),
    ...shape,
  };
  device.queue.writeBuffer(
    runParamsBuffer,
    0,
    wgsl3dEncodeRunParams(runParams),
  );

  // --- The stepper -----------------------------------------------------------
  const nodeWorkgroups = Math.ceil(nodes / WGSL3D_WORKGROUP_SIZE);
  let step = 0;
  let diverged = false;

  const recordPass = (
    encoder: ReturnType<WgslDevice["createCommandEncoder"]>,
    key: PassKey,
    parity: 0 | 1,
    workgroups: number,
  ): void => {
    const entry = passes.get(key);
    if (entry === undefined) {
      throw new Error(`The 3D WGSL pass "${key}" was not compiled.`);
    }
    const group = entry.groups[parity];
    if (group === undefined) {
      throw new Error(
        `The 3D WGSL pass "${key}" has no parity-${String(parity)} bind group.`,
      );
    }
    const pass = encoder.beginComputePass(key);
    pass.setPipeline(entry.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  };

  const stepper: Wgsl3dStepper = {
    meta,
    get step() {
      return step;
    },
    get diverged() {
      return diverged;
    },
    advance(): void {
      if (diverged) return;
      const stepIndex = step + 1;
      // The force-history buffer holds exactly stepCapacity sample
      // slots of THREE floats; a submit past it would make
      // reduce_forces write beyond the buffer's end. Decline loudly
      // BEFORE any submit — the same discipline the fake device
      // enforces on byte ranges, enforced host-side so it holds on
      // real hardware too.
      if (stepIndex > options.stepCapacity) {
        throw new Error(
          `The 3D WGSL stepper's force history holds ${String(options.stepCapacity)} step slots; advance() number ${String(stepIndex)} would write reduce_forces output past the buffer's end (create the stepper with a step capacity of at least the intended step count).`,
        );
      }
      device.queue.writeBuffer(
        stepParamsBuffer,
        0,
        wgsl3dEncodeStepParams({ stepIndex }),
      );
      const parity = ((stepIndex - 1) % 2) as 0 | 1;
      const encoder = device.createCommandEncoder(
        `wgsl3d-step-${String(stepIndex)}`,
      );
      recordPass(encoder, "collide_step", parity, nodeWorkgroups);
      recordPass(encoder, "stream_pull", parity, nodeWorkgroups);
      recordPass(encoder, "apply_faces", parity, nodeWorkgroups);
      recordPass(encoder, "reflect_solids", parity, nodeWorkgroups);
      recordPass(encoder, "reduce_partials", parity, shape.blockCount);
      recordPass(encoder, "reduce_forces", parity, 1);
      recordPass(encoder, "macro_out", parity, nodeWorkgroups);
      device.queue.submit([encoder.finish()]);
      step = stepIndex;
    },
    syncStatus: async () => {
      const bytes = await device.readBuffer(statusBuffer);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      if (view.getUint32(0, true) === 0) return;
      diverged = true;
      const first = view.getUint32(4, true);
      const completed = Math.min(step, Math.max(0, first - 1));
      step = completed;
    },
    snapshotLattice: async () => {
      const bytes = await device.readBuffer(macroBuffer);
      const planes = macroPlanes(bytes, nodes);
      return {
        step,
        rho: planes.rho,
        ux: planes.ux,
        uy: planes.uy,
        uz: planes.uz,
      };
    },
    distributions: async () => {
      // The live buffer after k steps: parity k mod 2 (k = 0 → first).
      const live = step % 2 === 0 ? distFirst : distSecond;
      const bytes = await device.readBuffer(live);
      return wgsl3dUnpackDistributions(bytes, nodes);
    },
    forceState: async () => {
      // Honest histories sync FIRST. Until the status readback, `step`
      // counts submitted slots, and the slots past a not-yet-synced
      // freeze hold zero-initialized bytes — reporting them would
      // fabricate zero force samples the run never recorded. Syncing
      // truncates `step` to the first diverged step (converging: a
      // repeat sync reads the same status), so the history carries
      // exactly the samples the run actually wrote.
      await stepper.syncStatus();
      const bytes = await device.readBuffer(forcesBuffer);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const samples = step;
      const factor = meta.units.forceFactor;
      const drag: number[] = [];
      const lift: number[] = [];
      const side: number[] = [];
      for (let s = 0; s < samples; s += 1) {
        drag.push(view.getFloat32(3 * s * 4, true) * factor);
        lift.push(view.getFloat32((3 * s + 1) * 4, true) * factor);
        side.push(view.getFloat32((3 * s + 2) * 4, true) * factor);
      }
      return {
        current: {
          dragN: drag[drag.length - 1] ?? 0,
          liftN: lift[lift.length - 1] ?? 0,
          sideN: side[side.length - 1] ?? 0,
        },
        history: [
          {
            name: LBM3D_FORCE_SERIES_NAMES[0] ?? "drag",
            unit: LBM3D_FORCE_UNIT,
            samples: drag,
          },
          {
            name: LBM3D_FORCE_SERIES_NAMES[1] ?? "lift",
            unit: LBM3D_FORCE_UNIT,
            samples: lift,
          },
          {
            name: LBM3D_FORCE_SERIES_NAMES[2] ?? "side",
            unit: LBM3D_FORCE_UNIT,
            samples: side,
          },
        ],
      };
    },
    solverFields: async () => {
      const snapshot = await stepper.snapshotLattice();
      const origin = config.originM ?? [0, 0, 0];
      return solverFieldsFromMacro(snapshot, meta, [
        origin[0] ?? 0,
        origin[1] ?? 0,
        origin[2] ?? 0,
      ]);
    },
    destroy(): void {
      for (const buffer of [
        distFirst,
        distSecond,
        macroBuffer,
        maskBuffer,
        impulseBuffer,
        partialsBuffer,
        statusBuffer,
        forcesBuffer,
        runParamsBuffer,
        stepParamsBuffer,
      ]) {
        buffer.destroy();
      }
    },
  };
  return simOk(stepper);
}
