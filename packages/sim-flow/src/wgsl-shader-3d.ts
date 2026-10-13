/**
 * The WGSL compute shader of the D3Q19 provider (Phase 66a) plus the
 * TS-side mirror of its memory layout — the 64a pattern carried to 3D.
 * The shader is a STRING MODULE whose direction/velocity/weight/
 * reflection tables are GENERATED from the `./d3q19` constants — the
 * layout contract's own stated mirror discipline: any change to the
 * direction ORDER or indexing changes the generated tables with it, so
 * the GPU buffers can never silently permute against the CPU oracle
 * (`./d3q19`'s contract block; deviation is a bug, and the byte-offset
 * tests pin it).
 *
 * ## The mirror spec (d3q19.ts → GPU buffers)
 *
 * The CPU kernel's nineteen `Float32Array`s of `nx·ny·nz`
 * (`x + y·nx + z·nx·ny`, x-fastest) pack into ONE storage buffer per
 * distribution set (live and scratch): direction-major, `f_i[n]` at
 * element `i·nodes + n`, f32, little-endian — the exact byte image of
 * the CPU arrays concatenated in direction order. The pack/unpack
 * helpers below are the single implementation of that formula on the TS
 * side; the WGSL `at(i, n)` helper is its single implementation on the
 * shader side. A single bind group stays inside the spec's guaranteed
 * storage-buffer bindings per stage (the largest entry point,
 * `collide_step`, binds 6: four storage — half the guaranteed eight —
 * plus the two uniform blocks).
 *
 * ## The step decomposition (the 64a seven-pass, justified unchanged)
 *
 * One step = the same seven fixed-order compute dispatches — the
 * decomposition is per-node arithmetic plus deterministic reductions,
 * dimension-independent by construction, so the 3D variant KEEPS it:
 *
 * 1. `collide_step` — macroscopic recompute (the divergence sentinel
 *    `!(rho > 0.0)` catches NaN as well) then BGK/TRT collision in
 *    place on the live buffer, writing the lagged macroscopic fields
 *    (four planes: ρ, u_x, u_y, u_z).
 * 2. `stream_pull` — pull streaming into the scratch buffer: identical
 *    semantics to the CPU's zeroed-scratch push.
 * 3. `apply_faces` — all six faces in ONE dispatch, one invocation per
 *    node applying west → east → south → north → bottom → top in
 *    program order (edge ownership: later face wins), race-free. The
 *    2D kernel hand-unrolled its four faces; the 3D faces go through
 *    ONE axis-generic Zou/He core (`reconstructFace`), the mirror of
 *    `./boundaries-3d`'s own generic closure — thirty hand-unrolled
 *    blocks would drift, and both sides sharing the generic shape is
 *    what makes the formula-for-formula audit readable.
 * 4. `reflect_solids` — full-way bounce-back on the scratch buffer plus
 *    the per-node momentum-exchange impulse partial 2·Σf_i·c_i, three
 *    components.
 * 5. `reduce_partials` — deterministic block reduction of the per-node
 *    impulses: fixed 64-lane workgroups, a fixed per-lane stride loop,
 *    and a fixed butterfly tree. NO atomics: the sum's floating-point
 *    ORDER is fixed by the dispatch shape (the 64a justification,
 *    carried over verbatim).
 * 6. `reduce_forces` — the same fixed pattern over the workgroup
 *    partials; lane 0 writes the step's impulse triple into the force
 *    history buffer (lattice units; SI conversion happens once at
 *    readback).
 * 7. `macro_out` — post-swap macroscopic recompute into the readback
 *    macro buffer. The 2D provider's Welford averaging moments are NOT
 *    here: 3D run-orchestration averaging is 66b/66c's raise, and this
 *    provider states that loudly instead of carrying dead bindings.
 *
 * The live/scratch swap is a BIND-GROUP PARITY FLIP, never a copy.
 * Divergence freezes the run through a status buffer exactly as in 2D:
 * `collide_step` trips the sentinel and skips its own writes;
 * `reflect_solids` and `macro_out` early-exit on the flag;
 * `reduce_forces` gates its history WRITE on the flag (never control
 * flow — an early return before its workgroupBarrier() would break the
 * uniformity analysis); `stream_pull`, `apply_faces`, and
 * `reduce_partials` still execute every submitted step, writing only
 * step-scratch no readout consumes past the freeze.
 *
 * All arithmetic is f32; the CPU oracle computes macroscopic and
 * collision terms in f64 before the f32 store. That is the bounded
 * difference the S5 oracle-vs-GPU tolerance harness
 * (`./gpu-oracle-3d-harness`) exists to gate — never bit-asserted.
 */

import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  D3Q19_WEIGHTS,
} from "./d3q19";

/** The fixed compute workgroup size (64 ≤ the spec's 256 minimum). */
export const WGSL3D_WORKGROUP_SIZE = 64;

/** The workgroup-count ceiling per dimension (the spec's minimum). */
const MAX_WORKGROUPS_PER_DIMENSION = 65535;

/**
 * The largest node count the 3D provider accepts: the 19·nodes f32
 * distribution buffer must stay within the guaranteed 128 MiB
 * storage-binding size, and the per-node dispatch count ceil(nodes/64)
 * within the workgroup ceiling (≈ 1.77 M nodes — a 120³ grid).
 */
export const WGSL3D_MAX_NODES = Math.floor((128 * 1024 * 1024) / (4 * D3Q19_Q));

/** The @group(0) binding slots the shader declares. */
export const WGSL3D_BINDINGS = {
  distSrc: 0,
  distDst: 1,
  macro: 2,
  mask: 3,
  impulse: 4,
  partials: 5,
  status: 6,
  forces: 7,
  runParams: 8,
  stepParams: 9,
} as const;

/** The shader's compute entry points, in step order. */
export const WGSL3D_ENTRY_POINTS = [
  "collide_step",
  "stream_pull",
  "apply_faces",
  "reflect_solids",
  "reduce_partials",
  "reduce_forces",
  "macro_out",
] as const;

/** The face-condition discriminants the run-params uniform carries. */
export const WGSL3D_FACE_KINDS = {
  velocity: 0,
  pressure: 1,
  convectiveOutflow: 2,
  wallNoSlip: 3,
  wallSpecular: 4,
} as const;

/** The collision discriminants (mirroring `LbmCollisionModel`). */
export const WGSL3D_COLLISION_KINDS = { bgk: 0, trt: 1 } as const;

/** The status buffer's u32 slots: [diverged flag, first diverged step]. */
export const WGSL3D_STATUS_INDEXES = {
  diverged: 0,
  firstDivergedStep: 1,
} as const;

/** The "no divergence yet" sentinel stored in the status buffer. */
export const WGSL3D_STATUS_STEP_MAX = 0xffffffff;

/** One face's compiled WGSL parameters (lattice units). */
export interface Wgsl3dFaceParams {
  /** The {@link WGSL3D_FACE_KINDS} discriminant. */
  readonly kind: number;
  /** The prescribed velocity (velocity faces). */
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  /** The prescribed lattice density (pressure faces). */
  readonly rho: number;
}

/** The run-fixed uniform block: grid, rates, six faces, reduction shape. */
export interface Wgsl3dRunParams {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly nodes: number;
  /** {@link WGSL3D_COLLISION_KINDS} */
  readonly collisionKind: number;
  readonly lambdaPlus: number;
  readonly lambdaMinus: number;
  readonly west: Wgsl3dFaceParams;
  readonly east: Wgsl3dFaceParams;
  readonly south: Wgsl3dFaceParams;
  readonly north: Wgsl3dFaceParams;
  readonly bottom: Wgsl3dFaceParams;
  readonly top: Wgsl3dFaceParams;
  /** Per-lane node stride of the block reduction (≥ 1). */
  readonly reduceStride: number;
  /** Nodes one reduction workgroup covers (WORKGROUP_SIZE·stride). */
  readonly blockNodes: number;
  /** The reduction's workgroup count. */
  readonly blockCount: number;
}

/**
 * The run-params uniform block's byte length — 160 exactly (7 scalars +
 * 6 face kinds + 18 face velocity components + 6 face densities + 3
 * reduction shape u32s, all 4-byte, 16-aligned).
 */
export const WGSL3D_RUN_PARAMS_BYTE_LENGTH = 160;

/** The per-step uniform block's byte length (step index, padded). */
export const WGSL3D_STEP_PARAMS_BYTE_LENGTH = 16;

/** The per-step uniform: what changes between submits. */
export interface Wgsl3dStepParams {
  /** The 1-based step index this submit completes. */
  readonly stepIndex: number;
}

/** The reduction geometry: fixed strides so the float order is fixed. */
export function wgsl3dReductionShape(
  nodes: number,
): Pick<Wgsl3dRunParams, "reduceStride" | "blockNodes" | "blockCount"> {
  const stride = Math.max(
    1,
    Math.ceil(nodes / (WGSL3D_WORKGROUP_SIZE * MAX_WORKGROUPS_PER_DIMENSION)),
  );
  const blockNodes = WGSL3D_WORKGROUP_SIZE * stride;
  return {
    reduceStride: stride,
    blockNodes,
    blockCount: Math.ceil(nodes / blockNodes),
  };
}

/** Encodes the run-params uniform block (little-endian, 160 bytes). */
export function wgsl3dEncodeRunParams(params: Wgsl3dRunParams): Uint8Array {
  const bytes = new Uint8Array(WGSL3D_RUN_PARAMS_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.nx, true);
  view.setUint32(4, params.ny, true);
  view.setUint32(8, params.nz, true);
  view.setUint32(12, params.nodes, true);
  view.setUint32(16, params.collisionKind, true);
  view.setFloat32(20, params.lambdaPlus, true);
  view.setFloat32(24, params.lambdaMinus, true);
  const faces: readonly (readonly [Wgsl3dFaceParams, number])[] = [
    [params.west, 28],
    [params.east, 32],
    [params.south, 36],
    [params.north, 40],
    [params.bottom, 44],
    [params.top, 48],
  ];
  for (const [face, kindOffset] of faces) {
    view.setUint32(kindOffset, face.kind, true);
  }
  const velocities: readonly (readonly [Wgsl3dFaceParams, number])[] = [
    [params.west, 52],
    [params.east, 64],
    [params.south, 76],
    [params.north, 88],
    [params.bottom, 100],
    [params.top, 112],
  ];
  for (const [face, offset] of velocities) {
    view.setFloat32(offset, face.ux, true);
    view.setFloat32(offset + 4, face.uy, true);
    view.setFloat32(offset + 8, face.uz, true);
  }
  view.setFloat32(124, params.west.rho, true);
  view.setFloat32(128, params.east.rho, true);
  view.setFloat32(132, params.south.rho, true);
  view.setFloat32(136, params.north.rho, true);
  view.setFloat32(140, params.bottom.rho, true);
  view.setFloat32(144, params.top.rho, true);
  view.setUint32(148, params.reduceStride, true);
  view.setUint32(152, params.blockNodes, true);
  view.setUint32(156, params.blockCount, true);
  return bytes;
}

/** Encodes the per-step uniform block (little-endian, 16 bytes). */
export function wgsl3dEncodeStepParams(params: Wgsl3dStepParams): Uint8Array {
  const bytes = new Uint8Array(WGSL3D_STEP_PARAMS_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.stepIndex, true);
  return bytes;
}

/**
 * The byte offset of direction `i`'s plane inside a packed distribution
 * buffer — THE mirror formula of the d3q19 layout contract (any
 * deviation is a bug; the orchestration tests assert it).
 */
export function wgsl3dDirectionByteOffset(i: number, nodes: number): number {
  return i * nodes * 4;
}

/** Packs nineteen per-direction arrays into the GPU distribution image. */
export function wgsl3dPackDistributions(
  directions: readonly Float32Array[],
): Uint8Array {
  const nodes = directions[0]?.length ?? 0;
  if (directions.length !== D3Q19_Q) {
    throw new Error(
      `The 3D distribution mirror packs exactly ${String(D3Q19_Q)} directions, received ${String(directions.length)}.`,
    );
  }
  const bytes = new Uint8Array(D3Q19_Q * nodes * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < D3Q19_Q; i += 1) {
    const plane = directions[i];
    if (plane === undefined || plane.length !== nodes) {
      throw new Error(
        `The 3D distribution mirror packs ${String(nodes)} values per direction, direction ${String(i)} carries ${String(plane?.length ?? 0)}.`,
      );
    }
    for (let n = 0; n < nodes; n += 1) {
      view.setFloat32(
        wgsl3dDirectionByteOffset(i, nodes) + n * 4,
        plane[n] ?? 0,
        true,
      );
    }
  }
  return bytes;
}

/**
 * Unpacks a GPU distribution readback into the nineteen per-direction
 * arrays.
 */
export function wgsl3dUnpackDistributions(
  bytes: Uint8Array,
  nodes: number,
): Float32Array[] {
  if (bytes.byteLength !== D3Q19_Q * nodes * 4) {
    throw new Error(
      `A 3D distribution readback carries ${String(D3Q19_Q * nodes * 4)} bytes for ${String(nodes)} nodes, received ${String(bytes.byteLength)}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directions: Float32Array[] = [];
  for (let i = 0; i < D3Q19_Q; i += 1) {
    const plane = new Float32Array(nodes);
    for (let n = 0; n < nodes; n += 1) {
      plane[n] = view.getFloat32(
        wgsl3dDirectionByteOffset(i, nodes) + n * 4,
        true,
      );
    }
    directions.push(plane);
  }
  return directions;
}

/** Packs a solid mask (0/1 u8 per node) into the shader's u32 view. */
export function wgsl3dPackMask(solid: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(solid.length * 4);
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < solid.length; n += 1) {
    view.setUint32(n * 4, solid[n] ?? 0, true);
  }
  return bytes;
}

/** Packs the initial status block: not diverged, no step recorded. */
export function wgsl3dPackStatus(): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(WGSL3D_STATUS_INDEXES.diverged * 4, 0, true);
  view.setUint32(
    WGSL3D_STATUS_INDEXES.firstDivergedStep * 4,
    WGSL3D_STATUS_STEP_MAX,
    true,
  );
  return bytes;
}

// --- The generated WGSL source ------------------------------------------------

/** The velocity table, generated from `D3Q19_VELOCITIES` (the mirror). */
function velocityTableWgsl(): string {
  const entries = D3Q19_VELOCITIES.map(
    ([cx, cy, cz]) => `vec3<i32>(${String(cx)}, ${String(cy)}, ${String(cz)})`,
  );
  return `var<private> C = array<vec3<i32>, ${String(D3Q19_Q)}>(\n  ${entries.join(",\n  ")}\n);`;
}

/** The weight table, generated from `D3Q19_WEIGHTS` (the mirror). */
function weightTableWgsl(): string {
  const entries = D3Q19_WEIGHTS.map((weight) => String(weight));
  return `var<private> W = array<f32, ${String(D3Q19_Q)}>(\n  ${entries.join(",\n  ")}\n);`;
}

/** The reflection table, generated from `D3Q19_OPPOSITE` (the mirror). */
function oppositeTableWgsl(): string {
  const entries = D3Q19_OPPOSITE.map((index) => `${String(index)}u`);
  return `var<private> OPP = array<u32, ${String(D3Q19_Q)}>(\n  ${entries.join(",\n  ")}\n);`;
}

function shaderSource(): string {
  return `// slopcad D3Q19 WGSL provider (Phase 66a) — the mirror of the Phase 66a
// CPU reference kernel. Generated by ./wgsl-shader-3d; the direction,
// weight, and reflection tables below are GENERATED from the ./d3q19
// constants — the layout contract's mirror discipline. Step semantics
// mirror ./stepper-3d's advance order; see that module's contract block.

struct RunParams {
  nx: u32,
  ny: u32,
  nz: u32,
  nodes: u32,
  collisionKind: u32,
  lambdaPlus: f32,
  lambdaMinus: f32,
  westKind: u32,
  eastKind: u32,
  southKind: u32,
  northKind: u32,
  bottomKind: u32,
  topKind: u32,
  westUx: f32, westUy: f32, westUz: f32,
  eastUx: f32, eastUy: f32, eastUz: f32,
  southUx: f32, southUy: f32, southUz: f32,
  northUx: f32, northUy: f32, northUz: f32,
  bottomUx: f32, bottomUy: f32, bottomUz: f32,
  topUx: f32, topUy: f32, topUz: f32,
  westRho: f32,
  eastRho: f32,
  southRho: f32,
  northRho: f32,
  bottomRho: f32,
  topRho: f32,
  reduceStride: u32,
  blockNodes: u32,
  blockCount: u32,
};

struct StepParams {
  stepIndex: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<storage, read_write> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read_write> macroscopic: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> impulse: array<f32>;
@group(0) @binding(5) var<storage, read_write> partials: array<f32>;
@group(0) @binding(6) var<storage, read_write> status: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> forces: array<f32>;
@group(0) @binding(8) var<uniform> rp: RunParams;
@group(0) @binding(9) var<uniform> stp: StepParams;

${velocityTableWgsl()}

${weightTableWgsl()}

${oppositeTableWgsl()}

// The d3q19 layout contract's element formula: f_i[n] at i*nodes + n.
fn at(i: u32, n: u32) -> u32 {
  return i * rp.nodes + n;
}

// Component selection over the fixed axes (uniform 'axis' values — the
// face geometry is run-fixed, so the branches are uniform).
fn comp(v: vec3<i32>, axis: u32) -> i32 {
  if (axis == 0u) { return v.x; }
  if (axis == 1u) { return v.y; }
  return v.z;
}

fn compf(v: vec3<f32>, axis: u32) -> f32 {
  if (axis == 0u) { return v.x; }
  if (axis == 1u) { return v.y; }
  return v.z;
}

// Whether every component OTHER than 'axis' is zero (the axis direction).
fn othersZero(v: vec3<i32>, axis: u32) -> bool {
  if (axis == 0u) { return v.y == 0 && v.z == 0; }
  if (axis == 1u) { return v.x == 0 && v.z == 0; }
  return v.x == 0 && v.y == 0;
}

// Whether the direction lies in the axis-t plane (the remaining axis'
// component is zero) — the a-t diagonals' membership test.
fn inPlane(v: vec3<i32>, axis: u32, t: u32) -> bool {
  if (axis == 0u) {
    if (t == 1u) { return v.z == 0; }
    return v.y == 0;
  }
  if (axis == 1u) {
    if (t == 2u) { return v.x == 0; }
    return v.z == 0;
  }
  if (t == 0u) { return v.y == 0; }
  return v.x == 0;
}

fn equilibrium(i: u32, rho: f32, u: vec3<f32>) -> f32 {
  let cu = dot(vec3<f32>(C[i]), u);
  let usq = dot(u, u);
  return W[i] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * usq);
}

fn equilibriumEven(i: u32, rho: f32, u: vec3<f32>) -> f32 {
  let cu = dot(vec3<f32>(C[i]), u);
  let usq = dot(u, u);
  return W[i] * rho * (1.0 + 4.5 * cu * cu - 1.5 * usq);
}

fn equilibriumOdd(i: u32, rho: f32, u: vec3<f32>) -> f32 {
  return W[i] * rho * 3.0 * dot(vec3<f32>(C[i]), u);
}

// Pass 1 — macroscopic recompute + collision, in place on the live
// buffer (mirrors lbm3dComputeMacroscopic + lbm3dCollide). The
// divergence sentinel: !(rho > 0.0) is true for NaN as well.
@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})
fn collide_step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  if (mask[n] == 1u) { return; }
  var rho = src[at(0u, n)];
  var m = vec3<f32>(0.0);
  for (var i = 1u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let v = src[at(i, n)];
    rho = rho + v;
    m = m + v * vec3<f32>(C[i]);
  }
  if (!(rho > 0.0)) {
    atomicStore(&status[${String(WGSL3D_STATUS_INDEXES.diverged)}u], 1u);
    atomicMin(&status[${String(WGSL3D_STATUS_INDEXES.firstDivergedStep)}u], stp.stepIndex);
    return;
  }
  let u = m / rho;
  macroscopic[n] = rho;
  macroscopic[rp.nodes + n] = u.x;
  macroscopic[2u * rp.nodes + n] = u.y;
  macroscopic[3u * rp.nodes + n] = u.z;
  if (rp.collisionKind == ${String(WGSL3D_COLLISION_KINDS.bgk)}u) {
    for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
      let v = src[at(i, n)];
      src[at(i, n)] = v - rp.lambdaPlus * (v - equilibrium(i, rho, u));
    }
    return;
  }
  // TRT: the rest direction is purely even; every reflected pair is
  // updated atomically from its two original values.
  let v0 = src[at(0u, n)];
  src[at(0u, n)] = v0 - rp.lambdaPlus * (v0 - equilibriumEven(0u, rho, u));
  for (var i = 1u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let j = OPP[i];
    if (j <= i) { continue; }
    let fi = src[at(i, n)];
    let fj = src[at(j, n)];
    let evenError = (fi + fj) / 2.0 - equilibriumEven(i, rho, u);
    let oddError = (fi - fj) / 2.0 - equilibriumOdd(i, rho, u);
    src[at(i, n)] = fi - rp.lambdaPlus * evenError - rp.lambdaMinus * oddError;
    src[at(j, n)] = fj - rp.lambdaPlus * evenError + rp.lambdaMinus * oddError;
  }
}

// Pass 2 — pull streaming into the scratch buffer (mirrors lbm3dStream's
// zeroed-scratch push: every slot receives its in-domain source value
// or exactly 0; the rest copies).
@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})
fn stream_pull(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  let x = n % rp.nx;
  let y = (n / rp.nx) % rp.ny;
  let z = n / (rp.nx * rp.ny);
  let pos = vec3<i32>(i32(x), i32(y), i32(z));
  for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let source = pos - C[i];
    if (source.x >= 0 && source.x < i32(rp.nx)
        && source.y >= 0 && source.y < i32(rp.ny)
        && source.z >= 0 && source.z < i32(rp.nz)) {
      let sn = u32(source.x) + u32(source.y) * rp.nx + u32(source.z) * rp.nx * rp.ny;
      dst[at(i, n)] = src[at(i, sn)];
    } else {
      dst[at(i, n)] = 0.0;
    }
  }
}

// Pass 3 — the six face conditions in one dispatch, in the CPU's fixed
// order (mirrors lbm3dApplyFaceConditions): edge ownership by program
// order, solid skip per face, the edge readKnown equilibrium closure,
// and lagged macroscopic sources — through the same axis-generic Zou/He
// core the CPU module owns.
var<private> arrived: array<f32, ${String(D3Q19_Q)}>;

fn readKnown(n: u32, pos: vec3<u32>, i: u32) -> f32 {
  let source = vec3<i32>(pos) - C[i];
  if (source.x >= 0 && source.x < i32(rp.nx)
      && source.y >= 0 && source.y < i32(rp.ny)
      && source.z >= 0 && source.z < i32(rp.nz)) {
    return dst[at(i, n)];
  }
  let lagged = vec3<f32>(macroscopic[rp.nodes + n], macroscopic[2u * rp.nodes + n], macroscopic[3u * rp.nodes + n]);
  return equilibrium(i, macroscopic[n], lagged);
}

fn loadArrived(n: u32, pos: vec3<u32>) {
  for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    arrived[i] = readKnown(n, pos, i);
  }
}

// The macroscopic velocity at a node, zeroed over solids (stale there).
fn macroU(n: u32) -> vec3<f32> {
  if (mask[n] == 1u) { return vec3<f32>(0.0, 0.0, 0.0); }
  return vec3<f32>(macroscopic[rp.nodes + n], macroscopic[2u * rp.nodes + n], macroscopic[3u * rp.nodes + n]);
}

// The mass elimination's base: sum of the arrived plus a second count
// of the fully-outbound set (rho*(1 - u_n) = base).
fn faceBaseSum(axis: u32, inward: i32) -> f32 {
  var base = 0.0;
  for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let cn = comp(C[i], axis) * inward;
    if (cn <= 0) { base = base + arrived[i]; }
    if (cn == -1) { base = base + arrived[i]; }
  }
  return base;
}

// The Zou/He reconstruction proper (mirrors reconstruct in
// ./boundaries-3d): the inbound axis pair, then each tangential
// plane's diagonal pair from its sum/difference split.
fn reconstructFace(n: u32, axis: u32, inward: i32, u: vec3<f32>, rho: f32) {
  let uN = f32(inward) * compf(u, axis);
  for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let c = C[i];
    if (comp(c, axis) == inward && othersZero(c, axis)) {
      let j = OPP[i];
      dst[at(i, n)] = arrived[j] + (1.0 / 3.0) * rho * uN;
    }
  }
  for (var t = 0u; t < 3u; t = t + 1u) {
    if (t == axis) { continue; }
    var dPlus = 0u;
    var dMinus = 0u;
    var mPlus = 0u;
    var mMinus = 0u;
    var moment = 0.0;
    for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
      let c = C[i];
      let cn = comp(c, axis) * inward;
      let ct = comp(c, t);
      if (cn > 0) {
        if (inPlane(c, axis, t) && ct != 0) {
          if (ct > 0) { dPlus = i; } else { dMinus = i; }
        }
        continue;
      }
      if (ct != 0) {
        moment = moment + f32(ct) * arrived[i];
      }
      if (cn < 0 && inPlane(c, axis, t) && ct != 0) {
        if (ct > 0) { mPlus = i; } else { mMinus = i; }
      }
    }
    let difference = rho * compf(u, t) - moment;
    let sum = arrived[mPlus] + arrived[mMinus] + (1.0 / 3.0) * rho * uN;
    dst[at(dPlus, n)] = (sum + difference) / 2.0;
    dst[at(dMinus, n)] = (sum - difference) / 2.0;
  }
}

// The half-way wall reflection family, sourced from the boundary
// node's POST-COLLISION distributions (mirrors the wall/symmetry arm).
fn reflectFace(n: u32, axis: u32, inward: i32, specular: bool) {
  for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    if (comp(C[i], axis) * inward <= 0) { continue; }
    var partner = OPP[i];
    if (specular) {
      var flipped = C[i];
      if (axis == 0u) { flipped.x = -flipped.x; }
      if (axis == 1u) { flipped.y = -flipped.y; }
      if (axis == 2u) { flipped.z = -flipped.z; }
      for (var j = 0u; j < ${String(D3Q19_Q)}u; j = j + 1u) {
        if (all(C[j] == flipped)) { partner = j; break; }
      }
    }
    dst[at(i, n)] = src[at(partner, n)];
  }
}

fn convectiveFace(n: u32, neighbor: u32, axis: u32, inward: i32, speed: f32) {
  for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    if (comp(C[i], axis) * inward <= 0) { continue; }
    let faceValue = src[at(i, n)];
    let neighborValue = src[at(i, neighbor)];
    dst[at(i, n)] = faceValue - speed * (faceValue - neighborValue);
  }
}

fn faceKindOf(f: u32) -> u32 {
  if (f == 0u) { return rp.westKind; }
  if (f == 1u) { return rp.eastKind; }
  if (f == 2u) { return rp.southKind; }
  if (f == 3u) { return rp.northKind; }
  if (f == 4u) { return rp.bottomKind; }
  return rp.topKind;
}

fn faceVelocityOf(f: u32) -> vec3<f32> {
  if (f == 0u) { return vec3<f32>(rp.westUx, rp.westUy, rp.westUz); }
  if (f == 1u) { return vec3<f32>(rp.eastUx, rp.eastUy, rp.eastUz); }
  if (f == 2u) { return vec3<f32>(rp.southUx, rp.southUy, rp.southUz); }
  if (f == 3u) { return vec3<f32>(rp.northUx, rp.northUy, rp.northUz); }
  if (f == 4u) { return vec3<f32>(rp.bottomUx, rp.bottomUy, rp.bottomUz); }
  return vec3<f32>(rp.topUx, rp.topUy, rp.topUz);
}

fn faceRhoOf(f: u32) -> f32 {
  if (f == 0u) { return rp.westRho; }
  if (f == 1u) { return rp.eastRho; }
  if (f == 2u) { return rp.southRho; }
  if (f == 3u) { return rp.northRho; }
  if (f == 4u) { return rp.bottomRho; }
  return rp.topRho;
}

fn applyFace3d(n: u32, pos: vec3<u32>, f: u32) {
  if (mask[n] == 1u) { return; }
  let axis = f / 2u;
  let inward = select(1, -1, (f % 2u) == 1u);
  let stride = select(select(1u, rp.nx, axis == 1u), rp.nx * rp.ny, axis == 2u);
  let neighbor = select(n + stride, n - stride, inward < 0);
  let kind = faceKindOf(f);
  if (kind == ${String(WGSL3D_FACE_KINDS.velocity)}u) {
    loadArrived(n, pos);
    let u = faceVelocityOf(f);
    let uN = f32(inward) * compf(u, axis);
    let base = faceBaseSum(axis, inward);
    reconstructFace(n, axis, inward, u, base / (1.0 - uN));
    return;
  }
  if (kind == ${String(WGSL3D_FACE_KINDS.pressure)}u) {
    loadArrived(n, pos);
    let rho = faceRhoOf(f);
    let base = faceBaseSum(axis, inward);
    let uN = 1.0 - base / rho;
    var u = macroU(neighbor);
    if (axis == 0u) { u.x = uN * f32(inward); }
    if (axis == 1u) { u.y = uN * f32(inward); }
    if (axis == 2u) { u.z = uN * f32(inward); }
    reconstructFace(n, axis, inward, u, rho);
    return;
  }
  if (kind == ${String(WGSL3D_FACE_KINDS.convectiveOutflow)}u) {
    let own = macroU(n);
    let uN = compf(own, axis) * f32(inward);
    let speed = clamp(-uN, 0.0, 0.5);
    convectiveFace(n, neighbor, axis, inward, speed);
    return;
  }
  reflectFace(n, axis, inward, kind == ${String(WGSL3D_FACE_KINDS.wallSpecular)}u);
}

@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})
fn apply_faces(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  let x = n % rp.nx;
  let y = (n / rp.nx) % rp.ny;
  let z = n / (rp.nx * rp.ny);
  if (x > 0u && x < rp.nx - 1u && y > 0u && y < rp.ny - 1u && z > 0u && z < rp.nz - 1u) { return; }
  let pos = vec3<u32>(x, y, z);
  if (x == 0u) { applyFace3d(n, pos, 0u); }
  if (x == rp.nx - 1u) { applyFace3d(n, pos, 1u); }
  if (y == 0u) { applyFace3d(n, pos, 2u); }
  if (y == rp.ny - 1u) { applyFace3d(n, pos, 3u); }
  if (z == 0u) { applyFace3d(n, pos, 4u); }
  if (z == rp.nz - 1u) { applyFace3d(n, pos, 5u); }
}

// Pass 4 — full-way bounce-back plus the per-node momentum-exchange
// impulse partial, three components (mirrors lbm3dReflectSolids).
// Freezes on divergence.
@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})
fn reflect_solids(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  if (mask[n] != 1u) { return; }
  if (atomicLoad(&status[${String(WGSL3D_STATUS_INDEXES.diverged)}u]) != 0u) { return; }
  var values: array<f32, ${String(D3Q19_Q)}>;
  var imp = vec3<f32>(0.0);
  for (var i = 0u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let v = dst[at(i, n)];
    values[i] = v;
    imp = imp + v * vec3<f32>(C[i]);
  }
  impulse[3u * n] = 2.0 * imp.x;
  impulse[3u * n + 1u] = 2.0 * imp.y;
  impulse[3u * n + 2u] = 2.0 * imp.z;
  for (var i = 1u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let j = OPP[i];
    if (j <= i) { continue; }
    dst[at(i, n)] = values[j];
    dst[at(j, n)] = values[i];
  }
}

var<workgroup> reduceX: array<f32, ${String(WGSL3D_WORKGROUP_SIZE)}>;
var<workgroup> reduceY: array<f32, ${String(WGSL3D_WORKGROUP_SIZE)}>;
var<workgroup> reduceZ: array<f32, ${String(WGSL3D_WORKGROUP_SIZE)}>;

// The fixed butterfly tree over the workgroup's lanes — the
// deterministic half of the force reduction strategy.
fn reduceWorkgroup(lane: u32) {
  var half = ${String(WGSL3D_WORKGROUP_SIZE / 2)}u;
  loop {
    if (half == 0u) { break; }
    if (lane < half) {
      reduceX[lane] = reduceX[lane] + reduceX[lane + half];
      reduceY[lane] = reduceY[lane] + reduceY[lane + half];
      reduceZ[lane] = reduceZ[lane] + reduceZ[lane + half];
    }
    workgroupBarrier();
    half = half >> 1u;
  }
}

// Pass 5 — block reduction of the per-node impulse partials: a fixed
// per-lane stride loop then the fixed tree. The floating-point order
// is fixed by the dispatch shape, so it is device-independent.
@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})
fn reduce_partials(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let base = wid.x * rp.blockNodes;
  var ax = 0.0;
  var ay = 0.0;
  var az = 0.0;
  for (var s = 0u; s < rp.reduceStride; s = s + 1u) {
    let index = base + s * ${String(WGSL3D_WORKGROUP_SIZE)}u + lid.x;
    if (index < rp.nodes) {
      ax = ax + impulse[3u * index];
      ay = ay + impulse[3u * index + 1u];
      az = az + impulse[3u * index + 2u];
    }
  }
  reduceX[lid.x] = ax;
  reduceY[lid.x] = ay;
  reduceZ[lid.x] = az;
  workgroupBarrier();
  reduceWorkgroup(lid.x);
  if (lid.x == 0u) {
    partials[3u * wid.x] = reduceX[0u];
    partials[3u * wid.x + 1u] = reduceY[0u];
    partials[3u * wid.x + 2u] = reduceZ[0u];
  }
}

// Pass 6 — the final reduction: the block partials become the step's
// impulse triple in the force history (lattice units, 0-based slot).
// Freezes on divergence — the CPU records no sample past the freeze.
// The divergence guard rides the WRITE, never the control flow.
@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})
fn reduce_forces(@builtin(local_invocation_id) lid: vec3<u32>) {
  var ax = 0.0;
  var ay = 0.0;
  var az = 0.0;
  for (var block = lid.x; block < rp.blockCount; block = block + ${String(WGSL3D_WORKGROUP_SIZE)}u) {
    ax = ax + partials[3u * block];
    ay = ay + partials[3u * block + 1u];
    az = az + partials[3u * block + 2u];
  }
  reduceX[lid.x] = ax;
  reduceY[lid.x] = ay;
  reduceZ[lid.x] = az;
  workgroupBarrier();
  reduceWorkgroup(lid.x);
  if (lid.x == 0u && atomicLoad(&status[${String(WGSL3D_STATUS_INDEXES.diverged)}u]) == 0u) {
    let slot = stp.stepIndex - 1u;
    forces[3u * slot] = reduceX[0u];
    forces[3u * slot + 1u] = reduceY[0u];
    forces[3u * slot + 2u] = reduceZ[0u];
  }
}

// Pass 7 — post-swap macroscopic recompute into the readback
// macroscopic buffer (mirrors snapshotLattice's fresh compute; solid
// columns zero). No averaging moments: 3D run-orchestration averaging
// is 66b/66c's raise, and this provider states that instead of
// carrying dead bindings.
@compute @workgroup_size(${String(WGSL3D_WORKGROUP_SIZE)})
fn macro_out(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= rp.nodes) { return; }
  if (atomicLoad(&status[${String(WGSL3D_STATUS_INDEXES.diverged)}u]) != 0u) { return; }
  if (mask[n] == 1u) {
    macroscopic[n] = 0.0;
    macroscopic[rp.nodes + n] = 0.0;
    macroscopic[2u * rp.nodes + n] = 0.0;
    macroscopic[3u * rp.nodes + n] = 0.0;
    return;
  }
  var rho = dst[at(0u, n)];
  var m = vec3<f32>(0.0);
  for (var i = 1u; i < ${String(D3Q19_Q)}u; i = i + 1u) {
    let v = dst[at(i, n)];
    rho = rho + v;
    m = m + v * vec3<f32>(C[i]);
  }
  let u = m / rho;
  macroscopic[n] = rho;
  macroscopic[rp.nodes + n] = u.x;
  macroscopic[2u * rp.nodes + n] = u.y;
  macroscopic[3u * rp.nodes + n] = u.z;
}
`;
}

/** The compiled WGSL compute module (fixed at module load, deterministic). */
export const WGSL_D3Q19_COMPUTE: string = shaderSource();
