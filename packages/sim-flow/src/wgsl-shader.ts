/**
 * The WGSL compute shader of the D2Q9 provider (Phase 64a,
 * requirement 1) plus the TS-side mirror of its memory layout. The
 * shader is a STRING MODULE whose direction/velocity/weight/reflection
 * tables are GENERATED from the `./d2q9` constants — the layout
 * contract's own stated mirror discipline: any change to the direction
 * ORDER or indexing changes the generated tables with it, so the GPU
 * buffers can never silently permute against the CPU oracle
 * (`./d2q9`'s contract block; deviation is a bug, and the byte-offset
 * tests pin it).
 *
 * ## The mirror spec (d2q9.ts → GPU buffers)
 *
 * The CPU kernel's nine `Float32Array`s of `nx·ny` (`x + y·nx`,
 * x-fastest) pack into ONE storage buffer per distribution set (live
 * and scratch): direction-major, `f_i[n]` at element `i·nodes + n`,
 * f32, little-endian — the exact byte image of the CPU arrays
 * concatenated in direction order. The pack/unpack helpers below are
 * the single implementation of that formula on the TS side; the WGSL
 * `at(i, n)` helper is its single implementation on the shader side.
 * A single bind group stays inside the spec's guaranteed 8
 * storage-buffer bindings per stage (the largest entry point binds 5).
 *
 * ## The step decomposition (mirroring `./stepper`'s advance order)
 *
 * One step = seven fixed-order compute dispatches; WebGPU guarantees
 * storage writes are visible between dispatches, which is what the
 * CPU's sequential passes get for free:
 *
 * 1. `collide_step` — macroscopic recompute (the divergence sentinel
 *    lives here, mirroring `lbmComputeMacroscopic`'s `!(ρ > 0)`,
 *    which catches NaN too), then BGK/TRT collision in place on the
 *    live buffer (mirroring `./relaxation`, even/odd TRT parts
 *    included). Writes the lagged macroscopic fields the boundary
 *    conditions consume.
 * 2. `stream_pull` — PULL streaming into the scratch buffer (each
 *    node gathers from its nine sources): identical semantics to the
 *    CPU's zeroed-scratch push — every slot receives exactly the
 *    in-domain source value or 0, rest copies.
 * 3. `apply_faces` — all four faces in ONE dispatch, one invocation
 *    per node applying west → east → south → north in program order:
 *    the CPU's fixed face order (corner ownership: later face wins)
 *    preserved exactly, race-free because each node is one
 *    invocation. Zou/He velocity and pressure reconstructions, the
 *    convective outflow, and the wall family (no-slip full reflection,
 *    free-slip/symmetry specular) mirror `./boundaries` formula for
 *    formula, including the corner `readKnown` equilibrium closure
 *    and the lagged macroscopic sources.
 * 4. `reflect_solids` — full-way bounce-back on the scratch buffer
 *    (each solid node swaps populations with their opposites) plus
 *    the per-node momentum-exchange impulse partial 2·Σf_i·c_i — the
 *    cfd-ts lineage term, per node.
 * 5. `reduce_partials` — deterministic block reduction of the
 *    per-node impulses: fixed 64-lane workgroups, a fixed per-lane
 *    stride loop, and a fixed butterfly tree. NO atomics: the sum's
 *    floating-point ORDER is fixed by the dispatch shape, so the same
 *    grid reduces identically every step and every run.
 * 6. `reduce_forces` — the same fixed pattern over the workgroup
 *    partials; lane 0 writes the step's impulse pair into the force
 *    history buffer (lattice units; SI conversion happens once at
 *    readback, the CPU accumulator's own discipline).
 * 7. `macro_out` — post-swap macroscopic recompute into the readback
 *    macro buffer (the CPU snapshot's fresh-compute discipline) and,
 *    inside the averaging window, the per-node Welford mean/M2 update
 *    mirroring `./averaging` exactly.
 *
 * The live/scratch swap is a BIND-GROUP PARITY FLIP (two variants per
 * pass, src↔dst), never a copy — the CPU's reference-exchange swap.
 * Divergence freezes the run through a status buffer (flag +
 * first-diverged-step via atomicMin), and the freeze GATES THE WRITES
 * THAT ACCUMULATE READOUT STATE, not every pass: `collide_step` trips
 * the sentinel and skips its own writes; `reflect_solids` and
 * `macro_out` early-exit on the flag (no impulse, bounce-back, macro,
 * or moment writes past the freeze); `reduce_forces` gates its
 * history WRITE on the flag (never control flow — an early return
 * before its workgroupBarrier() would break the uniformity analysis).
 * `stream_pull`, `apply_faces`, and `reduce_partials` still execute
 * every submitted step, writing only step-scratch — the swap buffer
 * and the partial sums — which no readout consumes past the freeze.
 * A blown-up run therefore stops accumulating forces, moments, and
 * macroscopic state exactly like the CPU stepper's freeze, at the
 * price of full-budget submits of passes whose useful writes are
 * gated.
 *
 * The force accumulation strategy is the two-stage deterministic
 * REDUCTION above (requirement 1's justification): f32 atomics vary
 * across devices (and were late to the WGSL spec) and i32 fixed-point
 * atomics throw away precision exactly where drag is a small
 * difference of large streams; the fixed-shape reduction is
 * device-independent and order-stable, at the cost of two extra tiny
 * dispatches per step.
 *
 * All arithmetic is f32; the CPU oracle computes macroscopic and
 * collision terms in f64 before the f32 store. That is the bounded
 * difference the S5 oracle-vs-GPU tolerance harness (`./gpu-oracle-harness`)
 * exists to gate — never bit-asserted (law S5).
 */

import { D2Q9_OPPOSITE, D2Q9_Q, D2Q9_VELOCITIES, D2Q9_WEIGHTS } from "./d2q9";

/** The fixed compute workgroup size (64 ≤ the spec's 256 minimum). */
export const WGSL_WORKGROUP_SIZE = 64;

/** The workgroup-count ceiling per dimension (the spec's minimum). */
const MAX_WORKGROUPS_PER_DIMENSION = 65535;

/**
 * The largest node count the provider accepts: the 9·nodes f32
 * distribution buffer must stay within the guaranteed 128 MiB
 * storage-binding size, and the per-node dispatch count
 * ceil(nodes/64) within the workgroup ceiling.
 */
export const WGSL_MAX_NODES = Math.floor((128 * 1024 * 1024) / (4 * D2Q9_Q));

/** The @group(0) binding slots the shader declares. */
export const WGSL_BINDINGS = {
  distSrc: 0,
  distDst: 1,
  macro: 2,
  mask: 3,
  impulse: 4,
  partials: 5,
  status: 6,
  forces: 7,
  moments: 8,
  runParams: 9,
  stepParams: 10,
} as const;

/** The shader's compute entry points, in step order. */
export const WGSL_ENTRY_POINTS = [
  "collide_step",
  "stream_pull",
  "apply_faces",
  "reflect_solids",
  "reduce_partials",
  "reduce_forces",
  "macro_out",
] as const;

/** The face-condition discriminants the run-params uniform carries. */
export const WGSL_FACE_KINDS = {
  velocity: 0,
  pressure: 1,
  convectiveOutflow: 2,
  wallNoSlip: 3,
  wallSpecular: 4,
} as const;

/** The collision discriminants (mirroring `LbmCollisionModel`). */
export const WGSL_COLLISION_KINDS = { bgk: 0, trt: 1 } as const;

/** The status buffer's u32 slots: [diverged flag, first diverged step]. */
export const WGSL_STATUS_INDEXES = {
  diverged: 0,
  firstDivergedStep: 1,
} as const;

/** The "no divergence yet" sentinel stored in the status buffer. */
export const WGSL_STATUS_STEP_MAX = 0xffffffff;

/** One face's compiled WGSL parameters (lattice units). */
export interface WgslFaceParams {
  /** The {@link WGSL_FACE_KINDS} discriminant. */
  readonly kind: number;
  /** The prescribed velocity (velocity faces). */
  readonly ux: number;
  readonly uy: number;
  /** The prescribed lattice density (pressure faces). */
  readonly rho: number;
}

/** The run-fixed uniform block: grid, rates, faces, reduction shape. */
export interface WgslRunParams {
  readonly nx: number;
  readonly ny: number;
  readonly nodes: number;
  /** {@link WGSL_COLLISION_KINDS} */
  readonly collisionKind: number;
  readonly lambdaPlus: number;
  readonly lambdaMinus: number;
  readonly west: WgslFaceParams;
  readonly east: WgslFaceParams;
  readonly south: WgslFaceParams;
  readonly north: WgslFaceParams;
  /** Per-lane node stride of the block reduction (≥ 1). */
  readonly reduceStride: number;
  /** Nodes one reduction workgroup covers (WORKGROUP_SIZE·stride). */
  readonly blockNodes: number;
  /** The reduction's workgroup count. */
  readonly blockCount: number;
}

/** The run-params uniform block's byte length (16-aligned). */
export const WGSL_RUN_PARAMS_BYTE_LENGTH = 128;

/** The per-step uniform block's byte length (16-aligned). */
export const WGSL_STEP_PARAMS_BYTE_LENGTH = 16;

/** The per-step uniform: what changes between submits. */
export interface WgslStepParams {
  /** The 1-based step index this submit completes. */
  readonly stepIndex: number;
  /** Whether `macro_out` folds this step into the averaging moments. */
  readonly averaging: boolean;
  /** The averaging snapshot count INCLUDING this step (Welford's n). */
  readonly averageCount: number;
}

/** The reduction geometry: fixed strides so the float order is fixed. */
export function wgslReductionShape(
  nodes: number,
): Pick<WgslRunParams, "reduceStride" | "blockNodes" | "blockCount"> {
  const stride = Math.max(
    1,
    Math.ceil(nodes / (WGSL_WORKGROUP_SIZE * MAX_WORKGROUPS_PER_DIMENSION)),
  );
  const blockNodes = WGSL_WORKGROUP_SIZE * stride;
  return {
    reduceStride: stride,
    blockNodes,
    blockCount: Math.ceil(nodes / blockNodes),
  };
}

/** Encodes the run-params uniform block (little-endian, 128 bytes). */
export function wgslEncodeRunParams(params: WgslRunParams): Uint8Array {
  const bytes = new Uint8Array(WGSL_RUN_PARAMS_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.nx, true);
  view.setUint32(4, params.ny, true);
  view.setUint32(8, params.nodes, true);
  view.setUint32(12, params.collisionKind, true);
  view.setFloat32(16, params.lambdaPlus, true);
  view.setFloat32(20, params.lambdaMinus, true);
  const faces: readonly (readonly [WgslFaceParams, number, number])[] = [
    [params.west, 24, 40],
    [params.east, 28, 48],
    [params.south, 32, 56],
    [params.north, 36, 64],
  ];
  for (const [face, kindOffset, velocityOffset] of faces) {
    view.setUint32(kindOffset, face.kind, true);
    view.setFloat32(velocityOffset, face.ux, true);
    view.setFloat32(velocityOffset + 4, face.uy, true);
  }
  view.setFloat32(72, params.west.rho, true);
  view.setFloat32(76, params.east.rho, true);
  view.setFloat32(80, params.south.rho, true);
  view.setFloat32(84, params.north.rho, true);
  view.setUint32(88, params.reduceStride, true);
  view.setUint32(92, params.blockNodes, true);
  view.setUint32(96, params.blockCount, true);
  // Bytes 100–127: alignment padding to the 16-byte struct boundary.
  return bytes;
}

/** Encodes the per-step uniform block (little-endian, 16 bytes). */
export function wgslEncodeStepParams(params: WgslStepParams): Uint8Array {
  const bytes = new Uint8Array(WGSL_STEP_PARAMS_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.stepIndex, true);
  view.setUint32(4, params.averaging ? 1 : 0, true);
  view.setUint32(8, params.averageCount, true);
  return bytes;
}

/**
 * The byte offset of direction `i`'s plane inside a packed distribution
 * buffer — THE mirror formula of the d2q9 layout contract (any
 * deviation is a bug; the orchestration tests assert it).
 */
export function wgslDirectionByteOffset(i: number, nodes: number): number {
  return i * nodes * 4;
}

/** Packs nine per-direction arrays into the GPU distribution image. */
export function wgslPackDistributions(
  directions: readonly Float32Array[],
): Uint8Array {
  const nodes = directions[0]?.length ?? 0;
  if (directions.length !== D2Q9_Q) {
    throw new Error(
      `The distribution mirror packs exactly ${String(D2Q9_Q)} directions, received ${String(directions.length)}.`,
    );
  }
  const bytes = new Uint8Array(D2Q9_Q * nodes * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < D2Q9_Q; i += 1) {
    const plane = directions[i];
    if (plane === undefined || plane.length !== nodes) {
      throw new Error(
        `The distribution mirror packs ${String(nodes)} values per direction, direction ${String(i)} carries ${String(plane?.length ?? 0)}.`,
      );
    }
    for (let n = 0; n < nodes; n += 1) {
      view.setFloat32(
        wgslDirectionByteOffset(i, nodes) + n * 4,
        plane[n] ?? 0,
        true,
      );
    }
  }
  return bytes;
}

/** Unpacks a GPU distribution readback into the nine per-direction arrays. */
export function wgslUnpackDistributions(
  bytes: Uint8Array,
  nodes: number,
): Float32Array[] {
  if (bytes.byteLength !== D2Q9_Q * nodes * 4) {
    throw new Error(
      `A distribution readback carries ${String(D2Q9_Q * nodes * 4)} bytes for ${String(nodes)} nodes, received ${String(bytes.byteLength)}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directions: Float32Array[] = [];
  for (let i = 0; i < D2Q9_Q; i += 1) {
    const plane = new Float32Array(nodes);
    for (let n = 0; n < nodes; n += 1) {
      plane[n] = view.getFloat32(
        wgslDirectionByteOffset(i, nodes) + n * 4,
        true,
      );
    }
    directions.push(plane);
  }
  return directions;
}

/** Packs a solid mask (0/1 u8 per node) into the shader's u32 view. */
export function wgslPackMask(solid: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(solid.length * 4);
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < solid.length; n += 1) {
    view.setUint32(n * 4, solid[n] ?? 0, true);
  }
  return bytes;
}

/** Packs the initial status block: not diverged, no step recorded. */
export function wgslPackStatus(): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(WGSL_STATUS_INDEXES.diverged * 4, 0, true);
  view.setUint32(
    WGSL_STATUS_INDEXES.firstDivergedStep * 4,
    WGSL_STATUS_STEP_MAX,
    true,
  );
  return bytes;
}

// --- The generated WGSL source ------------------------------------------------

/** The velocity table, generated from `D2Q9_VELOCITIES` (the mirror). */
function velocityTableWgsl(): string {
  const entries = D2Q9_VELOCITIES.map(
    ([cx, cy]) => `vec2<i32>(${String(cx)}, ${String(cy)})`,
  );
  return `var<private> C = array<vec2<i32>, ${String(D2Q9_Q)}>(\n  ${entries.join(",\n  ")}\n);`;
}

/** The weight table, generated from `D2Q9_WEIGHTS` (the mirror). */
function weightTableWgsl(): string {
  const entries = D2Q9_WEIGHTS.map((weight) => String(weight));
  return `var<private> W = array<f32, ${String(D2Q9_Q)}>(\n  ${entries.join(",\n  ")}\n);`;
}

/** The reflection table, generated from `D2Q9_OPPOSITE` (the mirror). */
function oppositeTableWgsl(): string {
  const entries = D2Q9_OPPOSITE.map((index) => `${String(index)}u`);
  return `var<private> OPP = array<u32, ${String(D2Q9_Q)}>(\n  ${entries.join(",\n  ")}\n);`;
}

function shaderSource(): string {
  return `// slopcad D2Q9 WGSL provider (Phase 64a) — the mirror of the Phase 63a
// CPU reference kernel. Generated by ./wgsl-shader; the direction,
// weight, and reflection tables below are GENERATED from the ./d2q9
// constants — the layout contract's mirror discipline. Step semantics
// mirror ./stepper's advance order; see that module's contract block.

struct RunParams {
  nx: u32,
  ny: u32,
  nodes: u32,
  collisionKind: u32,
  lambdaPlus: f32,
  lambdaMinus: f32,
  westKind: u32,
  eastKind: u32,
  southKind: u32,
  northKind: u32,
  westUx: f32,
  westUy: f32,
  eastUx: f32,
  eastUy: f32,
  southUx: f32,
  southUy: f32,
  northUx: f32,
  northUy: f32,
  westRho: f32,
  eastRho: f32,
  southRho: f32,
  northRho: f32,
  reduceStride: u32,
  blockNodes: u32,
  blockCount: u32,
  // Alignment padding to the 16-byte uniform struct boundary.
  pad0: u32, pad1: u32, pad2: u32, pad3: u32,
  pad4: u32, pad5: u32, pad6: u32,
};

struct StepParams {
  stepIndex: u32,
  averaging: u32,
  averageCount: u32,
  pad0: u32,
};

@group(0) @binding(0) var<storage, read_write> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read_write> macroscopic: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> impulse: array<f32>;
@group(0) @binding(5) var<storage, read_write> partials: array<f32>;
@group(0) @binding(6) var<storage, read_write> status: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> forces: array<f32>;
@group(0) @binding(8) var<storage, read_write> moments: array<f32>;
@group(0) @binding(9) var<uniform> rp: RunParams;
@group(0) @binding(10) var<uniform> stp: StepParams;

${velocityTableWgsl()}

${weightTableWgsl()}

${oppositeTableWgsl()}

// The d2q9 layout contract's element formula: f_i[n] at i*nodes + n.
fn at(i: u32, n: u32) -> u32 {
  return i * rp.nodes + n;
}

fn equilibrium(i: u32, rho: f32, ux: f32, uy: f32) -> f32 {
  let cu = f32(C[i].x) * ux + f32(C[i].y) * uy;
  let usq = ux * ux + uy * uy;
  return W[i] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * usq);
}

fn equilibriumEven(i: u32, rho: f32, ux: f32, uy: f32) -> f32 {
  let cu = f32(C[i].x) * ux + f32(C[i].y) * uy;
  let usq = ux * ux + uy * uy;
  return W[i] * rho * (1.0 + 4.5 * cu * cu - 1.5 * usq);
}

fn equilibriumOdd(i: u32, rho: f32, ux: f32, uy: f32) -> f32 {
  let cu = f32(C[i].x) * ux + f32(C[i].y) * uy;
  return W[i] * rho * 3.0 * cu;
}

// Pass 1 — macroscopic recompute + collision, in place on the live
// buffer (mirrors lbmComputeMacroscopic + lbmCollide). The divergence
// sentinel: !(rho > 0.0) is true for NaN as well, the CPU's
// !Number.isFinite(sum) || sum <= 0.
@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})
fn collide_step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  if (mask[n] == 1u) { return; }
  var rho = src[at(0u, n)];
  var mx = 0.0;
  var my = 0.0;
  for (var i = 1u; i < ${String(D2Q9_Q)}u; i = i + 1u) {
    let v = src[at(i, n)];
    rho = rho + v;
    mx = mx + v * f32(C[i].x);
    my = my + v * f32(C[i].y);
  }
  if (!(rho > 0.0)) {
    atomicStore(&status[${String(WGSL_STATUS_INDEXES.diverged)}u], 1u);
    atomicMin(&status[${String(WGSL_STATUS_INDEXES.firstDivergedStep)}u], stp.stepIndex);
    return;
  }
  let ux = mx / rho;
  let uy = my / rho;
  macroscopic[n] = rho;
  macroscopic[rp.nodes + n] = ux;
  macroscopic[2u * rp.nodes + n] = uy;
  if (rp.collisionKind == ${String(WGSL_COLLISION_KINDS.bgk)}u) {
    for (var i = 0u; i < ${String(D2Q9_Q)}u; i = i + 1u) {
      let v = src[at(i, n)];
      src[at(i, n)] = v - rp.lambdaPlus * (v - equilibrium(i, rho, ux, uy));
    }
    return;
  }
  // TRT: the rest direction is purely even; every reflected pair is
  // updated atomically from its two original values.
  let v0 = src[at(0u, n)];
  src[at(0u, n)] = v0 - rp.lambdaPlus * (v0 - equilibriumEven(0u, rho, ux, uy));
  for (var i = 1u; i < ${String(D2Q9_Q)}u; i = i + 1u) {
    let j = OPP[i];
    if (j <= i) { continue; }
    let fi = src[at(i, n)];
    let fj = src[at(j, n)];
    let evenError = (fi + fj) / 2.0 - equilibriumEven(i, rho, ux, uy);
    let oddError = (fi - fj) / 2.0 - equilibriumOdd(i, rho, ux, uy);
    src[at(i, n)] = fi - rp.lambdaPlus * evenError - rp.lambdaMinus * oddError;
    src[at(j, n)] = fj - rp.lambdaPlus * evenError + rp.lambdaMinus * oddError;
  }
}

// Pass 2 — pull streaming into the scratch buffer (mirrors lbmStream's
// zeroed-scratch push: every slot receives its in-domain source value
// or exactly 0; the rest copies).
@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})
fn stream_pull(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  let x = n % rp.nx;
  let y = n / rp.nx;
  for (var i = 0u; i < ${String(D2Q9_Q)}u; i = i + 1u) {
    let sx = i32(x) - C[i].x;
    let sy = i32(y) - C[i].y;
    if (sx >= 0 && sx < i32(rp.nx) && sy >= 0 && sy < i32(rp.ny)) {
      dst[at(i, n)] = src[at(i, u32(sx) + u32(sy) * rp.nx)];
    } else {
      dst[at(i, n)] = 0.0;
    }
  }
}

// Pass 3 — the four face conditions in one dispatch, in the CPU's
// fixed order (mirrors lbmApplyFaceConditions): corner ownership by
// program order, solid skip per face, the corner readKnown equilibrium
// closure, and lagged macroscopic sources.
fn readKnown(n: u32, x: u32, y: u32, i: u32) -> f32 {
  let sx = i32(x) - C[i].x;
  let sy = i32(y) - C[i].y;
  if (sx >= 0 && sx < i32(rp.nx) && sy >= 0 && sy < i32(rp.ny)) {
    return dst[at(i, n)];
  }
  return equilibrium(i, macroscopic[n], macroscopic[rp.nodes + n], macroscopic[2u * rp.nodes + n]);
}

// The macroscopic velocity at a node, zeroed over solids (stale there).
fn macroU(n: u32) -> vec2<f32> {
  if (mask[n] == 1u) { return vec2<f32>(0.0, 0.0); }
  return vec2<f32>(macroscopic[rp.nodes + n], macroscopic[2u * rp.nodes + n]);
}

fn convectiveOne(n: u32, neighbor: u32, i: u32, speed: f32) {
  let faceValue = src[at(i, n)];
  let neighborValue = src[at(i, neighbor)];
  dst[at(i, n)] = faceValue - speed * (faceValue - neighborValue);
}

fn convective(n: u32, neighbor: u32, i0: u32, i1: u32, i2: u32, speed: f32) {
  convectiveOne(n, neighbor, i0, speed);
  convectiveOne(n, neighbor, i1, speed);
  convectiveOne(n, neighbor, i2, speed);
}

fn reconstructWest(n: u32, f3: f32, f6: f32, f7: f32, f2: f32, f4: f32, rho: f32, ux: f32, uy: f32) {
  dst[at(1u, n)] = f3 + (2.0 / 3.0) * rho * ux;
  let sum = (1.0 / 3.0) * rho * ux + f6 + f7;
  let difference = rho * uy - f2 + f4 - f6 + f7;
  dst[at(5u, n)] = (sum + difference) / 2.0;
  dst[at(8u, n)] = (sum - difference) / 2.0;
}

fn reconstructEast(n: u32, f1: f32, f5: f32, f8: f32, f2: f32, f4: f32, rho: f32, ux: f32, uy: f32) {
  dst[at(3u, n)] = f1 - (2.0 / 3.0) * rho * ux;
  let sum = f5 + f8 - (1.0 / 3.0) * rho * ux;
  let difference = rho * uy - f2 + f4 - f5 + f8;
  dst[at(6u, n)] = (sum + difference) / 2.0;
  dst[at(7u, n)] = (sum - difference) / 2.0;
}

fn reconstructSouth(n: u32, f4: f32, f7: f32, f8: f32, f1: f32, f3: f32, rho: f32, ux: f32, uy: f32) {
  dst[at(2u, n)] = f4 + (2.0 / 3.0) * rho * uy;
  let sum = (1.0 / 3.0) * rho * uy + f7 + f8;
  let difference = rho * ux - f1 + f3 + f7 - f8;
  dst[at(5u, n)] = (sum + difference) / 2.0;
  dst[at(6u, n)] = (sum - difference) / 2.0;
}

fn reconstructNorth(n: u32, f2: f32, f5: f32, f6: f32, f1: f32, f3: f32, rho: f32, ux: f32, uy: f32) {
  dst[at(4u, n)] = f2 - (2.0 / 3.0) * rho * uy;
  let sum = f5 + f6 - (1.0 / 3.0) * rho * uy;
  let difference = rho * ux - f1 + f3 - f5 + f6;
  dst[at(8u, n)] = (sum + difference) / 2.0;
  dst[at(7u, n)] = (sum - difference) / 2.0;
}

// The half-way wall reflection family, sourced from the boundary
// node's POST-COLLISION distributions (mirrors reflectInPlace).
fn reflectWest(n: u32, specular: bool) {
  dst[at(1u, n)] = src[at(3u, n)];
  if (specular) {
    dst[at(5u, n)] = src[at(6u, n)];
    dst[at(8u, n)] = src[at(7u, n)];
  } else {
    dst[at(5u, n)] = src[at(7u, n)];
    dst[at(8u, n)] = src[at(6u, n)];
  }
}

fn reflectEast(n: u32, specular: bool) {
  dst[at(3u, n)] = src[at(1u, n)];
  if (specular) {
    dst[at(6u, n)] = src[at(5u, n)];
    dst[at(7u, n)] = src[at(8u, n)];
  } else {
    dst[at(6u, n)] = src[at(8u, n)];
    dst[at(7u, n)] = src[at(5u, n)];
  }
}

fn reflectSouth(n: u32, specular: bool) {
  dst[at(2u, n)] = src[at(4u, n)];
  if (specular) {
    dst[at(5u, n)] = src[at(8u, n)];
    dst[at(6u, n)] = src[at(7u, n)];
  } else {
    dst[at(5u, n)] = src[at(7u, n)];
    dst[at(6u, n)] = src[at(8u, n)];
  }
}

fn reflectNorth(n: u32, specular: bool) {
  dst[at(4u, n)] = src[at(2u, n)];
  if (specular) {
    dst[at(7u, n)] = src[at(6u, n)];
    dst[at(8u, n)] = src[at(5u, n)];
  } else {
    dst[at(7u, n)] = src[at(5u, n)];
    dst[at(8u, n)] = src[at(6u, n)];
  }
}

fn applyWest(n: u32, x: u32, y: u32) {
  if (mask[n] == 1u) { return; }
  switch rp.westKind {
    case ${String(WGSL_FACE_KINDS.velocity)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f2 = readKnown(n, x, y, 2u);
      let f4 = readKnown(n, x, y, 4u);
      let f3 = readKnown(n, x, y, 3u);
      let f6 = readKnown(n, x, y, 6u);
      let f7 = readKnown(n, x, y, 7u);
      let base = f0 + f2 + f4 + 2.0 * (f3 + f6 + f7);
      reconstructWest(n, f3, f6, f7, f2, f4, base / (1.0 - rp.westUx), rp.westUx, rp.westUy);
    }
    case ${String(WGSL_FACE_KINDS.pressure)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f2 = readKnown(n, x, y, 2u);
      let f4 = readKnown(n, x, y, 4u);
      let f3 = readKnown(n, x, y, 3u);
      let f6 = readKnown(n, x, y, 6u);
      let f7 = readKnown(n, x, y, 7u);
      let base = f0 + f2 + f4 + 2.0 * (f3 + f6 + f7);
      let tangential = macroU(n + 1u);
      reconstructWest(n, f3, f6, f7, f2, f4, rp.westRho, 1.0 - base / rp.westRho, tangential.y);
    }
    case ${String(WGSL_FACE_KINDS.convectiveOutflow)}u {
      let own = macroU(n);
      let speed = clamp(-own.x, 0.0, 0.5);
      convective(n, n + 1u, 1u, 5u, 8u, speed);
    }
    default {
      reflectWest(n, rp.westKind == ${String(WGSL_FACE_KINDS.wallSpecular)}u);
    }
  }
}

fn applyEast(n: u32, x: u32, y: u32) {
  if (mask[n] == 1u) { return; }
  switch rp.eastKind {
    case ${String(WGSL_FACE_KINDS.velocity)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f2 = readKnown(n, x, y, 2u);
      let f4 = readKnown(n, x, y, 4u);
      let f1 = readKnown(n, x, y, 1u);
      let f5 = readKnown(n, x, y, 5u);
      let f8 = readKnown(n, x, y, 8u);
      let base = f0 + f2 + f4 + 2.0 * (f1 + f5 + f8);
      reconstructEast(n, f1, f5, f8, f2, f4, base / (1.0 + rp.eastUx), rp.eastUx, rp.eastUy);
    }
    case ${String(WGSL_FACE_KINDS.pressure)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f2 = readKnown(n, x, y, 2u);
      let f4 = readKnown(n, x, y, 4u);
      let f1 = readKnown(n, x, y, 1u);
      let f5 = readKnown(n, x, y, 5u);
      let f8 = readKnown(n, x, y, 8u);
      let base = f0 + f2 + f4 + 2.0 * (f1 + f5 + f8);
      let tangential = macroU(n - 1u);
      reconstructEast(n, f1, f5, f8, f2, f4, rp.eastRho, base / rp.eastRho - 1.0, tangential.y);
    }
    case ${String(WGSL_FACE_KINDS.convectiveOutflow)}u {
      let own = macroU(n);
      let speed = clamp(own.x, 0.0, 0.5);
      convective(n, n - 1u, 3u, 6u, 7u, speed);
    }
    default {
      reflectEast(n, rp.eastKind == ${String(WGSL_FACE_KINDS.wallSpecular)}u);
    }
  }
}

fn applySouth(n: u32, x: u32, y: u32) {
  if (mask[n] == 1u) { return; }
  switch rp.southKind {
    case ${String(WGSL_FACE_KINDS.velocity)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f1 = readKnown(n, x, y, 1u);
      let f3 = readKnown(n, x, y, 3u);
      let f4 = readKnown(n, x, y, 4u);
      let f7 = readKnown(n, x, y, 7u);
      let f8 = readKnown(n, x, y, 8u);
      let base = f0 + f1 + f3 + 2.0 * (f4 + f7 + f8);
      reconstructSouth(n, f4, f7, f8, f1, f3, base / (1.0 - rp.southUy), rp.southUx, rp.southUy);
    }
    case ${String(WGSL_FACE_KINDS.pressure)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f1 = readKnown(n, x, y, 1u);
      let f3 = readKnown(n, x, y, 3u);
      let f4 = readKnown(n, x, y, 4u);
      let f7 = readKnown(n, x, y, 7u);
      let f8 = readKnown(n, x, y, 8u);
      let base = f0 + f1 + f3 + 2.0 * (f4 + f7 + f8);
      let tangential = macroU(n + rp.nx);
      reconstructSouth(n, f4, f7, f8, f1, f3, rp.southRho, tangential.x, 1.0 - base / rp.southRho);
    }
    case ${String(WGSL_FACE_KINDS.convectiveOutflow)}u {
      let own = macroU(n);
      let speed = clamp(-own.y, 0.0, 0.5);
      convective(n, n + rp.nx, 2u, 5u, 6u, speed);
    }
    default {
      reflectSouth(n, rp.southKind == ${String(WGSL_FACE_KINDS.wallSpecular)}u);
    }
  }
}

fn applyNorth(n: u32, x: u32, y: u32) {
  if (mask[n] == 1u) { return; }
  switch rp.northKind {
    case ${String(WGSL_FACE_KINDS.velocity)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f1 = readKnown(n, x, y, 1u);
      let f3 = readKnown(n, x, y, 3u);
      let f2 = readKnown(n, x, y, 2u);
      let f5 = readKnown(n, x, y, 5u);
      let f6 = readKnown(n, x, y, 6u);
      let base = f0 + f1 + f3 + 2.0 * (f2 + f5 + f6);
      reconstructNorth(n, f2, f5, f6, f1, f3, base / (1.0 + rp.northUy), rp.northUx, rp.northUy);
    }
    case ${String(WGSL_FACE_KINDS.pressure)}u {
      let f0 = readKnown(n, x, y, 0u);
      let f1 = readKnown(n, x, y, 1u);
      let f3 = readKnown(n, x, y, 3u);
      let f2 = readKnown(n, x, y, 2u);
      let f5 = readKnown(n, x, y, 5u);
      let f6 = readKnown(n, x, y, 6u);
      let base = f0 + f1 + f3 + 2.0 * (f2 + f5 + f6);
      let tangential = macroU(n - rp.nx);
      reconstructNorth(n, f2, f5, f6, f1, f3, rp.northRho, tangential.x, base / rp.northRho - 1.0);
    }
    case ${String(WGSL_FACE_KINDS.convectiveOutflow)}u {
      let own = macroU(n);
      let speed = clamp(own.y, 0.0, 0.5);
      convective(n, n - rp.nx, 4u, 7u, 8u, speed);
    }
    default {
      reflectNorth(n, rp.northKind == ${String(WGSL_FACE_KINDS.wallSpecular)}u);
    }
  }
}

@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})
fn apply_faces(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  let x = n % rp.nx;
  let y = n / rp.nx;
  if (x > 0u && x < rp.nx - 1u && y > 0u && y < rp.ny - 1u) { return; }
  if (x == 0u) { applyWest(n, x, y); }
  if (x == rp.nx - 1u) { applyEast(n, x, y); }
  if (y == 0u) { applySouth(n, x, y); }
  if (y == rp.ny - 1u) { applyNorth(n, x, y); }
}

// Pass 4 — full-way bounce-back plus the per-node momentum-exchange
// impulse partial (mirrors lbmReflectSolids). Freezes on divergence.
@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})
fn reflect_solids(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  if (mask[n] != 1u) { return; }
  if (atomicLoad(&status[${String(WGSL_STATUS_INDEXES.diverged)}u]) != 0u) { return; }
  var values: array<f32, ${String(D2Q9_Q)}>;
  var ix = 0.0;
  var iy = 0.0;
  for (var i = 0u; i < ${String(D2Q9_Q)}u; i = i + 1u) {
    let v = dst[at(i, n)];
    values[i] = v;
    ix = ix + v * f32(C[i].x);
    iy = iy + v * f32(C[i].y);
  }
  impulse[2u * n] = 2.0 * ix;
  impulse[2u * n + 1u] = 2.0 * iy;
  for (var i = 1u; i < ${String(D2Q9_Q)}u; i = i + 1u) {
    let j = OPP[i];
    if (j <= i) { continue; }
    dst[at(i, n)] = values[j];
    dst[at(j, n)] = values[i];
  }
}

var<workgroup> reduceX: array<f32, ${String(WGSL_WORKGROUP_SIZE)}>;
var<workgroup> reduceY: array<f32, ${String(WGSL_WORKGROUP_SIZE)}>;

// The fixed butterfly tree over the workgroup's lanes — the
// deterministic half of the force reduction strategy. The 'lane'
// parameter is the caller's local invocation index (builtins ride
// entry points only).
fn reduceWorkgroup(lane: u32) {
  var half = ${String(WGSL_WORKGROUP_SIZE / 2)}u;
  loop {
    if (half == 0u) { break; }
    if (lane < half) {
      reduceX[lane] = reduceX[lane] + reduceX[lane + half];
      reduceY[lane] = reduceY[lane] + reduceY[lane + half];
    }
    workgroupBarrier();
    half = half >> 1u;
  }
}

// Pass 5 — block reduction of the per-node impulse partials: a fixed
// per-lane stride loop then the fixed tree. The floating-point order
// is fixed by the dispatch shape, so it is device-independent.
@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})
fn reduce_partials(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let base = wid.x * rp.blockNodes;
  var ax = 0.0;
  var ay = 0.0;
  for (var s = 0u; s < rp.reduceStride; s = s + 1u) {
    let index = base + s * ${String(WGSL_WORKGROUP_SIZE)}u + lid.x;
    if (index < rp.nodes) {
      ax = ax + impulse[2u * index];
      ay = ay + impulse[2u * index + 1u];
    }
  }
  reduceX[lid.x] = ax;
  reduceY[lid.x] = ay;
  workgroupBarrier();
  reduceWorkgroup(lid.x);
  if (lid.x == 0u) {
    partials[2u * wid.x] = reduceX[0u];
    partials[2u * wid.x + 1u] = reduceY[0u];
  }
}

// Pass 6 — the final reduction: the block partials become the step's
// impulse pair in the force history (lattice units, 0-based slot).
// Freezes on divergence — the CPU records no sample past the freeze.
// The divergence guard rides the WRITE, never the control flow: a
// storage load is a non-uniform value, and an early return before a
// workgroupBarrier() would break the uniformity analysis.
@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})
fn reduce_forces(@builtin(local_invocation_id) lid: vec3<u32>) {
  var ax = 0.0;
  var ay = 0.0;
  for (var block = lid.x; block < rp.blockCount; block = block + ${String(WGSL_WORKGROUP_SIZE)}u) {
    ax = ax + partials[2u * block];
    ay = ay + partials[2u * block + 1u];
  }
  reduceX[lid.x] = ax;
  reduceY[lid.x] = ay;
  workgroupBarrier();
  reduceWorkgroup(lid.x);
  if (lid.x == 0u && atomicLoad(&status[${String(WGSL_STATUS_INDEXES.diverged)}u]) == 0u) {
    let slot = stp.stepIndex - 1u;
    forces[2u * slot] = reduceX[0u];
    forces[2u * slot + 1u] = reduceY[0u];
  }
}

// Pass 7 — post-swap macroscopic recompute into the readback
// macroscopic buffer (mirrors snapshotLattice's fresh compute; solid columns zero)
// and the per-node Welford moment update inside the averaging window
// (mirrors LbmMomentAccumulator.accumulate, population variance M2).
@compute @workgroup_size(${String(WGSL_WORKGROUP_SIZE)})
fn macro_out(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  if (atomicLoad(&status[${String(WGSL_STATUS_INDEXES.diverged)}u]) != 0u) { return; }
  if (mask[n] == 1u) {
    macroscopic[n] = 0.0;
    macroscopic[rp.nodes + n] = 0.0;
    macroscopic[2u * rp.nodes + n] = 0.0;
    return;
  }
  var rho = dst[at(0u, n)];
  var mx = 0.0;
  var my = 0.0;
  for (var i = 1u; i < ${String(D2Q9_Q)}u; i = i + 1u) {
    let v = dst[at(i, n)];
    rho = rho + v;
    mx = mx + v * f32(C[i].x);
    my = my + v * f32(C[i].y);
  }
  let ux = mx / rho;
  let uy = my / rho;
  macroscopic[n] = rho;
  macroscopic[rp.nodes + n] = ux;
  macroscopic[2u * rp.nodes + n] = uy;
  if (stp.averaging != 0u) {
    let k = f32(stp.averageCount);
    var meanX = moments[n];
    var meanY = moments[rp.nodes + n];
    let deltaX = ux - meanX;
    let deltaY = uy - meanY;
    meanX = meanX + deltaX / k;
    meanY = meanY + deltaY / k;
    moments[n] = meanX;
    moments[rp.nodes + n] = meanY;
    moments[2u * rp.nodes + n] = moments[2u * rp.nodes + n] + deltaX * (ux - meanX);
    moments[3u * rp.nodes + n] = moments[3u * rp.nodes + n] + deltaY * (uy - meanY);
  }
}
`;
}

/** The compiled WGSL compute module (fixed at module load, deterministic). */
export const WGSL_D2Q9_COMPUTE: string = shaderSource();
