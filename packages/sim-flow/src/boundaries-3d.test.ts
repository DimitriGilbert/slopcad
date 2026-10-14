/**
 * The 3D boundary-condition tests (Phase 66a): the axis-generic Zou/He
 * closure's EXACT moment identities — the reconstruction must deliver
 * exactly its prescribed (ρ, u) in mass and all three momentum
 * components at every boundary node, whatever the arrived values were
 * — plus the wall-reflection partner maps and the per-step ledger's
 * exact bookkeeping. These are the identities the WGSL mirror rests
 * on: formula parity, provable headlessly.
 */

import { describe, expect, it } from "vitest";

import {
  LBM3D_FACE_ORDER,
  type Lbm3dFace,
  type Lbm3dFaceCondition,
  type Lbm3dFaceMomentumLedger,
  lbm3dApplyFaceConditions,
} from "./boundaries-3d";
import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  d3q19Equilibrium,
} from "./d3q19";
import { createLbm3dState, type Lbm3dSolidMask } from "./state-3d";

const NX = 6;
const NY = 5;
const NZ = 5;

function emptyMask(): Lbm3dSolidMask {
  return { nx: NX, ny: NY, nz: NZ, solid: new Uint8Array(NX * NY * NZ) };
}

/**
 * A fresh state whose streaming scratch carries a physical "arrived"
 * pattern — the equilibrium of a drifting state — so the
 * reconstructions operate on realistic values (any values would
 * satisfy the identities; physical ones also keep the solved ρ
 * positive). The live `f` set is seeded distinctly so the wall
 * reflections' post-collision source is distinguishable from `fTmp`.
 */
function seededState(
  scratchRho: number,
  ux: number,
  uy: number,
  uz: number,
): ReturnType<typeof createLbm3dState> {
  const state = createLbm3dState(emptyMask());
  for (let i = 0; i < D3Q19_Q; i += 1) {
    state.fTmp[i]?.fill(d3q19Equilibrium(i, scratchRho, ux, uy, uz));
    state.f[i]?.fill(0.01 * (i + 1) + 0.001);
  }
  return state;
}

const flatConditions = (
  west: Lbm3dFaceCondition,
  east: Lbm3dFaceCondition,
  south: Lbm3dFaceCondition,
  north: Lbm3dFaceCondition,
  bottom: Lbm3dFaceCondition,
  top: Lbm3dFaceCondition,
): Record<Lbm3dFace, Lbm3dFaceCondition> => ({
  west,
  east,
  south,
  north,
  bottom,
  top,
});

/** The boundary-plane node indexes of one face. */
function faceIndexes(face: Lbm3dFace, edges = true): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < NX * NY * NZ; index += 1) {
    const x = index % NX;
    const y = Math.floor(index / NX) % NY;
    const z = Math.floor(index / (NX * NY));
    if (face === "west" && x !== 0) continue;
    if (face === "east" && x !== NX - 1) continue;
    if (face === "south" && y !== 0) continue;
    if (face === "north" && y !== NY - 1) continue;
    if (face === "bottom" && z !== 0) continue;
    if (face === "top" && z !== NZ - 1) continue;
    // Non-edge nodes only (optional): nodes whose OTHER two coordinates
    // are strictly interior lie on exactly this one face — the set
    // where every "known" population's source is genuinely in-domain.
    if (!edges) {
      if (face !== "west" && face !== "east" && (x === 0 || x === NX - 1)) {
        continue;
      }
      if (face !== "south" && face !== "north" && (y === 0 || y === NY - 1)) {
        continue;
      }
      if (face !== "bottom" && face !== "top" && (z === 0 || z === NZ - 1)) {
        continue;
      }
    }
    indexes.push(index);
  }
  return indexes;
}

const idledWalls: Record<Lbm3dFace, Lbm3dFaceCondition> = flatConditions(
  { kind: "wall", slip: false },
  { kind: "wall", slip: false },
  { kind: "wall", slip: false },
  { kind: "wall", slip: false },
  { kind: "wall", slip: false },
  { kind: "wall", slip: false },
);

describe("the 3D Zou/He reconstruction (the axis-generic closure)", () => {
  it("delivers exactly its prescribed (ρ, u) in mass and momentum on the velocity faces", () => {
    const velocity: [number, number, number] = [0.04, 0.012, -0.008];
    const state = seededState(1.01, 0.03, 0.008, 0.004);
    const conditions = flatConditions(
      { kind: "velocity", ux: velocity[0], uy: velocity[1], uz: velocity[2] },
      { kind: "velocity", ux: -velocity[0], uy: velocity[1], uz: velocity[2] },
      { kind: "velocity", ux: velocity[0], uy: velocity[1], uz: velocity[2] },
      { kind: "velocity", ux: velocity[0], uy: -velocity[1], uz: velocity[2] },
      { kind: "velocity", ux: velocity[0], uy: velocity[1], uz: velocity[2] },
      { kind: "velocity", ux: velocity[0], uy: velocity[1], uz: -velocity[2] },
    );
    const ledger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
    lbm3dApplyFaceConditions(state, conditions, ledger);
    // The exact moment identities hold at every node whose "known"
    // populations all arrived in-domain — the NON-EDGE nodes of each
    // face. At edge nodes the documented equilibrium closure
    // (`readKnown`) substitutes ghost values the node's slots do not
    // hold, trading local exactness for determinism (the 2D corner
    // precedent); the step-level momentum audit — which books every
    // actual write — stays exact everywhere, and the box fixture pins
    // that identity over a full run.
    for (const face of LBM3D_FACE_ORDER) {
      for (const index of faceIndexes(face, false)) {
        let mass = 0;
        let mx = 0;
        let my = 0;
        let mz = 0;
        for (let i = 0; i < D3Q19_Q; i += 1) {
          const value = state.fTmp[i]?.[index] ?? 0;
          mass += value;
          mx += value * (D3Q19_VELOCITIES[i]?.[0] ?? 0);
          my += value * (D3Q19_VELOCITIES[i]?.[1] ?? 0);
          mz += value * (D3Q19_VELOCITIES[i]?.[2] ?? 0);
        }
        const signed: [number, number, number] = [
          face === "east" ? -velocity[0] : velocity[0],
          face === "north" ? -velocity[1] : velocity[1],
          face === "top" ? -velocity[2] : velocity[2],
        ];
        // The identities close to f32 STORAGE rounding (measured
        // ≈ 5e-9): the reconstructions live in Float32Array slots.
        expect(Math.abs(mx - mass * signed[0])).toBeLessThan(1e-8);
        expect(Math.abs(my - mass * signed[1])).toBeLessThan(1e-8);
        expect(Math.abs(mz - mass * signed[2])).toBeLessThan(1e-8);
      }
    }
  });

  it("delivers exactly its prescribed ρ on the pressure faces, with the solved normal", () => {
    const rho = 0.985;
    const state = seededState(1.0, 0.02, 0.005, -0.003);
    const conditions = flatConditions(
      { kind: "pressure", rho },
      { kind: "pressure", rho },
      { kind: "pressure", rho },
      { kind: "pressure", rho },
      { kind: "pressure", rho },
      { kind: "pressure", rho },
    );
    const ledger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
    lbm3dApplyFaceConditions(state, conditions, ledger);
    // Non-edge nodes (the identity's domain — see the velocity test).
    for (const face of LBM3D_FACE_ORDER) {
      for (const index of faceIndexes(face, false)) {
        let mass = 0;
        for (let i = 0; i < D3Q19_Q; i += 1) {
          mass += state.fTmp[i]?.[index] ?? 0;
        }
        // The f32 storage rounding band (measured ≈ 1.3e-9).
        expect(Math.abs(mass - rho)).toBeLessThan(1e-8);
      }
    }
  });

  it("books the ledger as exactly Σ (new − old)·c over the overwritten slots", () => {
    const state = seededState(1.0, 0.03, 0.01, 0.005);
    const before: Float64Array[] = [];
    for (let i = 0; i < D3Q19_Q; i += 1) {
      before.push(Float64Array.from(state.fTmp[i] ?? new Float32Array(0)));
    }
    const conditions = flatConditions(
      { kind: "velocity", ux: 0.05, uy: 0.01, uz: 0.0 },
      { kind: "pressure", rho: 1.0 },
      { kind: "wall", slip: false },
      { kind: "symmetry" },
      { kind: "convective-outflow" },
      { kind: "wall", slip: true },
    );
    const ledger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
    lbm3dApplyFaceConditions(state, conditions, ledger);
    let expectedX = 0;
    let expectedY = 0;
    let expectedZ = 0;
    for (let index = 0; index < NX * NY * NZ; index += 1) {
      const x = index % NX;
      const y = Math.floor(index / NX) % NY;
      const z = Math.floor(index / (NX * NY));
      const boundary =
        x === 0 ||
        x === NX - 1 ||
        y === 0 ||
        y === NY - 1 ||
        z === 0 ||
        z === NZ - 1;
      if (!boundary) continue;
      for (let i = 0; i < D3Q19_Q; i += 1) {
        const delta = (state.fTmp[i]?.[index] ?? 0) - (before[i]?.[index] ?? 0);
        if (delta === 0) continue;
        expectedX += delta * (D3Q19_VELOCITIES[i]?.[0] ?? 0);
        expectedY += delta * (D3Q19_VELOCITIES[i]?.[1] ?? 0);
        expectedZ += delta * (D3Q19_VELOCITIES[i]?.[2] ?? 0);
      }
    }
    expect(Math.abs(ledger.x - expectedX)).toBeLessThan(1e-6);
    expect(Math.abs(ledger.y - expectedY)).toBeLessThan(1e-6);
    expect(Math.abs(ledger.z - expectedZ)).toBeLessThan(1e-6);
    // The 1e-6 band (measured 2.1e-8): the ledger and this expectation
    // sum the SAME write terms in different orders — node-major here,
    // write-order there — so the difference is pure f64 accumulation
    // rounding, not a bookkeeping gap.
  });
});

describe("the 3D wall family (half-way link reflection)", () => {
  it("no-slip maps each missing population to its full reflection partner's post-collision value", () => {
    const state = seededState(1.0, 0.02, 0.0, 0.0);
    const ledger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
    lbm3dApplyFaceConditions(state, idledWalls, ledger);
    for (const face of LBM3D_FACE_ORDER) {
      for (const index of faceIndexes(face)) {
        for (let i = 0; i < D3Q19_Q; i += 1) {
          const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
          const pointsInward =
            (face === "west" && cx > 0) ||
            (face === "east" && cx < 0) ||
            (face === "south" && cy > 0) ||
            (face === "north" && cy < 0) ||
            (face === "bottom" && cz > 0) ||
            (face === "top" && cz < 0);
          if (!pointsInward) continue;
          const opposite = D3Q19_OPPOSITE[i] ?? 0;
          expect(state.fTmp[i]?.[index]).toBe(state.f[opposite]?.[index]);
        }
      }
    }
  });

  it("specular (symmetry/free-slip) flips only the normal component of the partner", () => {
    const state = seededState(1.0, 0.02, 0.0, 0.0);
    const conditions = flatConditions(
      { kind: "symmetry" },
      { kind: "symmetry" },
      { kind: "symmetry" },
      { kind: "symmetry" },
      { kind: "symmetry" },
      { kind: "symmetry" },
    );
    const ledger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
    lbm3dApplyFaceConditions(state, conditions, ledger);
    // Non-edge nodes: at an edge the LATER face in LBM3D_FACE_ORDER
    // owns the shared diagonals (the documented edge ownership), so a
    // single face's partner map is only the whole truth where the node
    // lies on exactly that face.
    for (const face of LBM3D_FACE_ORDER) {
      for (const index of faceIndexes(face, false)) {
        for (let i = 0; i < D3Q19_Q; i += 1) {
          const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
          const pointsInward =
            (face === "west" && cx > 0) ||
            (face === "east" && cx < 0) ||
            (face === "south" && cy > 0) ||
            (face === "north" && cy < 0) ||
            (face === "bottom" && cz > 0) ||
            (face === "top" && cz < 0);
          if (!pointsInward) continue;
          // The specular partner: the velocity with the face-normal
          // component flipped (for the axis direction it coincides
          // with the full reflection).
          const flipX = face === "west" || face === "east";
          const flipY = face === "south" || face === "north";
          const flipZ = face === "bottom" || face === "top";
          let partner = D3Q19_OPPOSITE[i] ?? 0;
          for (let j = 0; j < D3Q19_Q; j += 1) {
            const [jx, jy, jz] = D3Q19_VELOCITIES[j] ?? [0, 0, 0];
            if (
              jx === (flipX ? -cx : cx) &&
              jy === (flipY ? -cy : cy) &&
              jz === (flipZ ? -cz : cz)
            ) {
              partner = j;
              break;
            }
          }
          expect(state.fTmp[i]?.[index]).toBe(state.f[partner]?.[index]);
        }
      }
    }
  });
});
