/**
 * The WGSL stepper (Phase 64a): the GPU provider's orchestration over
 * the `./wgsl-shader` compute module, written against the narrow
 * `./gpu-device` seam so a fake device validates it headlessly. The
 * surface mirrors the CPU stepper's (`./stepper`) readout contract —
 * meta, step/diverged, distributions (the layout contract's diff
 * surface), snapshots, force histories, moments, solver fields — with
 * the one honest difference the contract documents: reads are ASYNC
 * (device readbacks) and the kernel arithmetic is f32, not the CPU's
 * f64-with-f32-stores. That difference is exactly what the S5
 * oracle-vs-GPU tolerance harness gates (`./gpu-oracle-harness`);
 * nothing here is ever bit-asserted against the oracle.
 *
 * Validation and unit derivation are SHARED with the CPU, not
 * duplicated: `createWgslLbmStepper` first builds the CPU stepper from
 * the same config — every input refusal is the CPU's own refusal, and
 * the derived `LbmRunMeta` (unit closure, rates, reference pressure)
 * is consumed verbatim as the uniform block's source. The face
 * conditions convert SI → lattice through the SAME expressions
 * `./stepper`'s compileFace uses ((v·dt)/dx and the pressure factor),
 * so the uniform values are the CPU's values.
 *
 * Determinism (law S2's provider posture): the orchestration is a
 * fixed function of its inputs — fixed buffer set and sizes, fixed
 * pipeline creation order, fixed per-step pass sequence, fixed
 * bind-group parity alternation, fixed write placement. No clock, no
 * randomness, no host-dependent branching. The same config on the
 * same device produces the same submits; across devices the WGSL
 * execution is the device's, which is why S5's gate is a tolerance
 * harness and the CPU stays the test truth.
 *
 * The per-step dispatch sequence (asserted by the fake-device tests):
 * collide_step → stream_pull → apply_faces → reflect_solids →
 * reduce_partials → reduce_forces → macro_out — the CPU advance
 * order, decomposed per `./wgsl-shader`'s contract block. Divergence
 * is discovered at readback boundaries (`syncStatus`): the shader
 * freezes itself through the status buffer the moment it trips, and
 * the host-side step count truncates to the first diverged step when
 * synced — the CPU's freeze, reported at the readback cadence instead
 * of instantly (stated honestly; a full-budget submit whose
 * accumulating writes are gated is the price of not stalling the
 * pipeline every step).
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
import type { LbmFieldMoments } from "./averaging";
import type {
  WgslBindGroup,
  WgslBindGroupEntry,
  WgslBuffer,
  WgslComputePipeline,
  WgslDevice,
} from "./gpu-device";

import { D2Q9_Q } from "./d2q9";
import { LBM_FORCE_SERIES_NAMES, LBM_FORCE_UNIT } from "./forces";
import {
  type LbmLatticeSnapshot,
  type LbmRunMeta,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";
import {
  WGSL_BINDINGS,
  WGSL_COLLISION_KINDS,
  WGSL_D2Q9_COMPUTE,
  WGSL_ENTRY_POINTS,
  WGSL_FACE_KINDS,
  WGSL_MAX_NODES,
  WGSL_RUN_PARAMS_BYTE_LENGTH,
  WGSL_STEP_PARAMS_BYTE_LENGTH,
  WGSL_WORKGROUP_SIZE,
  type WgslFaceParams,
  type WgslRunParams,
  wgslEncodeRunParams,
  wgslEncodeStepParams,
  wgslPackDistributions,
  wgslPackMask,
  wgslPackStatus,
  wgslReductionShape,
  wgslUnpackDistributions,
} from "./wgsl-shader";

/** What {@link createWgslLbmStepper} takes beyond the CPU stepper's config. */
export interface WgslStepperOptions {
  /**
   * The force-history capacity: the number of steps the stepper may
   * record (the engine passes its step budget). A positive integer.
   * `advance()` past this capacity THROWS before submitting — the
   * force-history buffer holds exactly this many sample slots.
   */
  readonly stepCapacity: number;
  /**
   * The 1-based step at which the GPU-side averaging window opens
   * (mirrors the engine layer's averaging start); absent = never.
   */
  readonly averagingStartStep?: number;
}

/** The WGSL provider's stepper — the CPU stepper's readout shape, async. */
export interface WgslLbmStepper {
  /** The shared run facts (derived by the CPU twin's own closure). */
  readonly meta: LbmRunMeta;
  /** Submitted steps, truncated to the first diverged step once synced. */
  get step(): number;
  /** Whether the run diverged (as of the last {@link WgslLbmStepper} sync). */
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
  snapshotLattice(): Promise<LbmLatticeSnapshot>;
  /**
   * The live distribution set, read back — the layout contract's diff
   * surface: nine per-direction arrays of nx·ny, x-fastest.
   */
  distributions(): Promise<readonly Float32Array[]>;
  /**
   * The force history pair (SI N/m, converted once at readback). Reads
   * the divergence status FIRST (an implicit {@link syncStatus}): an
   * unsynced diverged run reports only the samples it actually
   * recorded — never the zero-initialized slots past the freeze.
   */
  forceState(): Promise<{
    readonly current: {
      readonly dragNPerM: number;
      readonly liftNPerM: number;
    };
    readonly history: readonly SimHistorySeries[];
  }>;
  /** The GPU-accumulated averaging moments (Welford, per `./averaging`). */
  moments(): Promise<LbmFieldMoments>;
  /**
   * The S4-ready solver fields (velocity-x, velocity-y, speed,
   * pressure) — mirroring the CPU stepper's field set and labels.
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

/** The entry-point name by short key (creation order = WGSL_ENTRY_POINTS). */
type PassKey = (typeof WGSL_ENTRY_POINTS)[number];

/** The per-entry-point binding sets (exactly the shader's used globals). */
const PASS_BINDINGS: Readonly<Record<PassKey, readonly number[]>> = {
  collide_step: [
    WGSL_BINDINGS.distSrc,
    WGSL_BINDINGS.macro,
    WGSL_BINDINGS.mask,
    WGSL_BINDINGS.status,
    WGSL_BINDINGS.runParams,
    WGSL_BINDINGS.stepParams,
  ],
  stream_pull: [
    WGSL_BINDINGS.distSrc,
    WGSL_BINDINGS.distDst,
    WGSL_BINDINGS.runParams,
  ],
  apply_faces: [
    WGSL_BINDINGS.distSrc,
    WGSL_BINDINGS.distDst,
    WGSL_BINDINGS.macro,
    WGSL_BINDINGS.mask,
    WGSL_BINDINGS.runParams,
  ],
  reflect_solids: [
    WGSL_BINDINGS.distDst,
    WGSL_BINDINGS.mask,
    WGSL_BINDINGS.impulse,
    WGSL_BINDINGS.status,
    WGSL_BINDINGS.runParams,
  ],
  reduce_partials: [
    WGSL_BINDINGS.impulse,
    WGSL_BINDINGS.partials,
    WGSL_BINDINGS.runParams,
  ],
  reduce_forces: [
    WGSL_BINDINGS.partials,
    WGSL_BINDINGS.status,
    WGSL_BINDINGS.forces,
    WGSL_BINDINGS.runParams,
    WGSL_BINDINGS.stepParams,
  ],
  macro_out: [
    WGSL_BINDINGS.distDst,
    WGSL_BINDINGS.macro,
    WGSL_BINDINGS.mask,
    WGSL_BINDINGS.status,
    WGSL_BINDINGS.moments,
    WGSL_BINDINGS.runParams,
    WGSL_BINDINGS.stepParams,
  ],
};

/** Converts one face's SI spec into its uniform parameters (compileFace's math). */
function wgslFaceParams(
  spec: LbmStepperConfig["west"],
  units: LbmRunMeta["units"],
  referencePressurePa: number,
): WgslFaceParams {
  switch (spec.kind) {
    case "velocity-inlet": {
      const [vx, vy] = spec.velocityMPerS;
      return {
        kind: WGSL_FACE_KINDS.velocity,
        ux: (vx * units.timeStepS) / units.cellSizeM,
        uy: (vy * units.timeStepS) / units.cellSizeM,
        rho: 0,
      };
    }
    case "pressure-outlet":
      return {
        kind: WGSL_FACE_KINDS.pressure,
        ux: 0,
        uy: 0,
        rho:
          1 + (spec.pressurePa - referencePressurePa) / units.pressureFactorPa,
      };
    case "convective-outflow":
      return {
        kind: WGSL_FACE_KINDS.convectiveOutflow,
        ux: 0,
        uy: 0,
        rho: 0,
      };
    case "wall":
      return {
        kind: spec.slip
          ? WGSL_FACE_KINDS.wallSpecular
          : WGSL_FACE_KINDS.wallNoSlip,
        ux: 0,
        uy: 0,
        rho: 0,
      };
    case "symmetry":
      return {
        kind: WGSL_FACE_KINDS.wallSpecular,
        ux: 0,
        uy: 0,
        rho: 0,
      };
  }
}

/** The initial macro block: ρ = 1, u = 0 at fluid nodes, zero at solids. */
function initialMacroBytes(nodes: number, solid: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(nodes * 3 * 4);
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < nodes; n += 1) {
    if (solid[n] === 1) continue;
    view.setFloat32(n * 4, 1, true);
  }
  return bytes;
}

/** Reads three f32 planes (ρ, ux, uy) from a macro readback. */
function macroPlanes(
  bytes: Uint8Array,
  nodes: number,
): { rho: Float64Array; ux: Float64Array; uy: Float64Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rho = new Float64Array(nodes);
  const ux = new Float64Array(nodes);
  const uy = new Float64Array(nodes);
  for (let n = 0; n < nodes; n += 1) {
    rho[n] = view.getFloat32(n * 4, true);
    ux[n] = view.getFloat32((nodes + n) * 4, true);
    uy[n] = view.getFloat32((2 * nodes + n) * 4, true);
  }
  return { rho, ux, uy };
}

/** Builds the solver field set from a macro readback (the CPU stepper's mirror). */
function solverFieldsFromMacro(
  snapshot: LbmLatticeSnapshot,
  meta: LbmRunMeta,
  originM: readonly [number, number],
): readonly SolverSimField[] {
  const { nx, ny } = meta;
  const dx = meta.units.cellSizeM;
  const velocityValuesX: number[] = [];
  const velocityValuesY: number[] = [];
  const speedValues: number[] = [];
  const pressureValues: number[] = [];
  for (let index = 0; index < snapshot.rho.length; index += 1) {
    const vx = (snapshot.ux[index] ?? 0) * meta.units.velocityFactor;
    const vy = (snapshot.uy[index] ?? 0) * meta.units.velocityFactor;
    velocityValuesX.push(vx);
    velocityValuesY.push(vy);
    speedValues.push(Math.sqrt(vx * vx + vy * vy));
    pressureValues.push(
      meta.referencePressurePa +
        ((snapshot.rho[index] ?? 0) - 1) * meta.units.pressureFactorPa,
    );
  }
  const geometry = {
    extent: [nx, ny, 1] as const,
    originM: [originM[0] ?? 0, originM[1] ?? 0, 0] as const,
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
 * Creates the WGSL stepper: validates through the CPU twin, mirrors
 * the initial state bitwise (the layout contract's pack), compiles the
 * seven pipelines in fixed order, and materializes the two buffer
 * parities. Refuses the inputs the CPU refuses, plus the provider's
 * own bounds (the guaranteed-limit grid ceiling, the history capacity).
 */
export async function createWgslLbmStepper(
  config: LbmStepperConfig,
  device: WgslDevice,
  options: WgslStepperOptions,
): Promise<SimParseResult<WgslLbmStepper, SimError>> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  // The provider's own grid ceiling first: an over-cap grid declines
  // before the CPU twin's buffers are ever requested.
  const rawNx = config.mask.nx;
  const rawNy = config.mask.ny;
  if (
    Number.isInteger(rawNx) &&
    Number.isInteger(rawNy) &&
    rawNx * rawNy > WGSL_MAX_NODES
  ) {
    return refuse(
      `The WGSL provider hosts grids up to ${String(WGSL_MAX_NODES)} nodes inside the guaranteed storage-binding size; ${String(rawNx)}×${String(rawNy)} is ${String(rawNx * rawNy)}.`,
      { nx: rawNx, ny: rawNy },
    );
  }
  // The CPU twin: one source of truth for validation, units, and rates.
  const twin = createLbmStepper(config);
  if (!twin.ok) return twin;
  const meta = twin.value.meta;
  const nx = meta.nx;
  const ny = meta.ny;
  const nodes = nx * ny;
  if (
    !Number.isInteger(options.stepCapacity) ||
    options.stepCapacity < 1 ||
    options.stepCapacity > Math.floor(0xffffffff / 2)
  ) {
    return refuse(
      "A WGSL stepper's step capacity must be a positive integer (the force-history buffer's length).",
      options.stepCapacity,
    );
  }
  const averagingStart =
    options.averagingStartStep === undefined
      ? null
      : options.averagingStartStep;
  if (
    averagingStart !== null &&
    (!Number.isInteger(averagingStart) ||
      averagingStart < 1 ||
      averagingStart > options.stepCapacity)
  ) {
    return refuse(
      "A WGSL stepper's averaging start step must be an integer in [1, step capacity].",
      options.averagingStartStep,
    );
  }

  // --- Buffers (fixed set, fixed labels, fixed order) -----------------------
  const distBytes = D2Q9_Q * nodes * 4;
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
    nodes * 3 * 4,
    ["storage", "copy-source", "copy-destination"],
    "macro",
  );
  const maskBuffer = device.createBuffer(
    nodes * 4,
    ["storage", "copy-destination"],
    "mask",
  );
  const impulseBuffer = device.createBuffer(
    nodes * 2 * 4,
    ["storage"],
    "impulse",
  );
  const shape = wgslReductionShape(nodes);
  const partialsBuffer = device.createBuffer(
    shape.blockCount * 2 * 4,
    ["storage"],
    "partials",
  );
  const statusBuffer = device.createBuffer(
    8,
    ["storage", "copy-source", "copy-destination"],
    "status",
  );
  const forcesBuffer = device.createBuffer(
    options.stepCapacity * 2 * 4,
    ["storage", "copy-source"],
    "forces",
  );
  const momentsBuffer = device.createBuffer(
    nodes * 4 * 4,
    ["storage", "copy-source"],
    "moments",
  );
  const runParamsBuffer = device.createBuffer(
    WGSL_RUN_PARAMS_BYTE_LENGTH,
    ["uniform", "copy-destination"],
    "run-params",
  );
  const stepParamsBuffer = device.createBuffer(
    WGSL_STEP_PARAMS_BYTE_LENGTH,
    ["uniform", "copy-destination"],
    "step-params",
  );

  // --- Pipelines and the two buffer parities (fixed creation order) ---------
  const passes = new Map<PassKey, PassSet>();
  for (const entryPoint of WGSL_ENTRY_POINTS) {
    const pipeline = await device.createComputePipeline(
      WGSL_D2Q9_COMPUTE,
      entryPoint,
      entryPoint,
    );
    const bufferFor = (
      binding: number,
      parity: 0 | 1,
    ): WgslBuffer | undefined => {
      switch (binding) {
        case WGSL_BINDINGS.distSrc:
          return parity === 0 ? distFirst : distSecond;
        case WGSL_BINDINGS.distDst:
          return parity === 0 ? distSecond : distFirst;
        case WGSL_BINDINGS.macro:
          return macroBuffer;
        case WGSL_BINDINGS.mask:
          return maskBuffer;
        case WGSL_BINDINGS.impulse:
          return impulseBuffer;
        case WGSL_BINDINGS.partials:
          return partialsBuffer;
        case WGSL_BINDINGS.status:
          return statusBuffer;
        case WGSL_BINDINGS.forces:
          return forcesBuffer;
        case WGSL_BINDINGS.moments:
          return momentsBuffer;
        case WGSL_BINDINGS.runParams:
          return runParamsBuffer;
        case WGSL_BINDINGS.stepParams:
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
            `The WGSL pass "${entryPoint}" declared binding ${String(binding)} with no buffer.`,
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
  const packed = wgslPackDistributions(initialDistributions);
  device.queue.writeBuffer(distFirst, 0, packed);
  device.queue.writeBuffer(distSecond, 0, packed);
  device.queue.writeBuffer(maskBuffer, 0, wgslPackMask(config.mask.solid));
  device.queue.writeBuffer(
    macroBuffer,
    0,
    initialMacroBytes(nodes, config.mask.solid),
  );
  device.queue.writeBuffer(statusBuffer, 0, wgslPackStatus());
  const runParams: WgslRunParams = {
    nx,
    ny,
    nodes,
    collisionKind:
      meta.collision.kind === "bgk"
        ? WGSL_COLLISION_KINDS.bgk
        : WGSL_COLLISION_KINDS.trt,
    lambdaPlus: meta.rates.lambdaPlus,
    lambdaMinus: meta.rates.lambdaMinus,
    west: wgslFaceParams(config.west, meta.units, meta.referencePressurePa),
    east: wgslFaceParams(config.east, meta.units, meta.referencePressurePa),
    south: wgslFaceParams(config.south, meta.units, meta.referencePressurePa),
    north: wgslFaceParams(config.north, meta.units, meta.referencePressurePa),
    ...shape,
  };
  device.queue.writeBuffer(runParamsBuffer, 0, wgslEncodeRunParams(runParams));

  // --- The stepper -----------------------------------------------------------
  const nodeWorkgroups = Math.ceil(nodes / WGSL_WORKGROUP_SIZE);
  let step = 0;
  let diverged = false;
  let averageCount = 0;

  const recordPass = (
    encoder: ReturnType<WgslDevice["createCommandEncoder"]>,
    key: PassKey,
    parity: 0 | 1,
    workgroups: number,
  ): void => {
    const entry = passes.get(key);
    if (entry === undefined) {
      throw new Error(`The WGSL pass "${key}" was not compiled.`);
    }
    const group = entry.groups[parity];
    if (group === undefined) {
      throw new Error(
        `The WGSL pass "${key}" has no parity-${String(parity)} bind group.`,
      );
    }
    const pass = encoder.beginComputePass(key);
    pass.setPipeline(entry.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  };

  const stepper: WgslLbmStepper = {
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
      // slots; a submit past it would make reduce_forces write beyond
      // the buffer's end. Decline loudly BEFORE any submit — the same
      // discipline the fake device enforces on byte ranges, enforced
      // host-side so it holds on real hardware too.
      if (stepIndex > options.stepCapacity) {
        throw new Error(
          `The WGSL stepper's force history holds ${String(options.stepCapacity)} step slots; advance() number ${String(stepIndex)} would write reduce_forces output past the buffer's end (create the stepper with a step capacity of at least the intended step count).`,
        );
      }
      const averaging = averagingStart !== null && stepIndex >= averagingStart;
      const count =
        averaging && averagingStart !== null
          ? stepIndex - averagingStart + 1
          : 0;
      device.queue.writeBuffer(
        stepParamsBuffer,
        0,
        wgslEncodeStepParams({
          stepIndex,
          averaging,
          averageCount: count,
        }),
      );
      const parity = ((stepIndex - 1) % 2) as 0 | 1;
      const encoder = device.createCommandEncoder(
        `wgsl-step-${String(stepIndex)}`,
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
      if (averaging) averageCount = count;
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
      return { step, rho: planes.rho, ux: planes.ux, uy: planes.uy };
    },
    distributions: async () => {
      // The live buffer after k steps: parity k mod 2 (k = 0 → first).
      const live = step % 2 === 0 ? distFirst : distSecond;
      const bytes = await device.readBuffer(live);
      return wgslUnpackDistributions(bytes, nodes);
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
      const factor = meta.units.forcePerDepthFactor;
      const drag: number[] = [];
      const lift: number[] = [];
      for (let s = 0; s < samples; s += 1) {
        drag.push(view.getFloat32(2 * s * 4, true) * factor);
        lift.push(view.getFloat32((2 * s + 1) * 4, true) * factor);
      }
      return {
        current: {
          dragNPerM: drag[drag.length - 1] ?? 0,
          liftNPerM: lift[lift.length - 1] ?? 0,
        },
        history: [
          {
            name: LBM_FORCE_SERIES_NAMES[0] ?? "drag",
            unit: LBM_FORCE_UNIT,
            samples: drag,
          },
          {
            name: LBM_FORCE_SERIES_NAMES[1] ?? "lift",
            unit: LBM_FORCE_UNIT,
            samples: lift,
          },
        ],
      };
    },
    moments: async () => {
      const bytes = await device.readBuffer(momentsBuffer);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const meanX = new Float64Array(nodes);
      const meanY = new Float64Array(nodes);
      const varianceX = new Float64Array(nodes);
      const varianceY = new Float64Array(nodes);
      const count = averageCount;
      for (let n = 0; n < nodes; n += 1) {
        meanX[n] = view.getFloat32(n * 4, true);
        meanY[n] = view.getFloat32((nodes + n) * 4, true);
        if (count > 0) {
          varianceX[n] = view.getFloat32((2 * nodes + n) * 4, true) / count;
          varianceY[n] = view.getFloat32((3 * nodes + n) * 4, true) / count;
        }
      }
      return { count, meanX, meanY, varianceX, varianceY };
    },
    solverFields: async () => {
      const snapshot = await stepper.snapshotLattice();
      const origin = config.originM ?? [0, 0];
      return solverFieldsFromMacro(snapshot, meta, [
        origin[0] ?? 0,
        origin[1] ?? 0,
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
        momentsBuffer,
        runParamsBuffer,
        stepParamsBuffer,
      ]) {
        buffer.destroy();
      }
    },
  };
  return simOk(stepper);
}
