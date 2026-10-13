import { describe, expect, it } from "vitest";

import { lbmApplyFaceConditions } from "./boundaries";
import { D2Q9_Q, D2Q9_VELOCITIES } from "./d2q9";
import { createLbmState } from "./state";

const nx = 5;
const ny = 5;

/** Fills the scratch with a known as-if-streamed state at one node. */
function seedScratch(
  values: readonly number[],
  index: number,
): ReturnType<typeof createLbmState> {
  const state = createLbmState({ nx, ny, solid: new Uint8Array(nx * ny) });
  for (let i = 0; i < D2Q9_Q; i += 1) {
    state.fTmp[i]!.fill(0);
    state.f[i]!.fill(0);
    state.fTmp[i]![index] = values[i] ?? 0;
    state.f[i]![index] = values[i] ?? 0;
  }
  return state;
}

function nodeMassAndMomentum(
  state: ReturnType<typeof createLbmState>,
  index: number,
): { rho: number; mx: number; my: number } {
  let rho = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < D2Q9_Q; i += 1) {
    const value = state.fTmp[i]?.[index] ?? 0;
    rho += value;
    mx += value * (D2Q9_VELOCITIES[i]?.[0] ?? 0);
    my += value * (D2Q9_VELOCITIES[i]?.[1] ?? 0);
  }
  return { rho, mx, my };
}

const inertFaces = {
  west: { kind: "symmetry" } as const,
  east: { kind: "symmetry" } as const,
  south: { kind: "symmetry" } as const,
  north: { kind: "symmetry" } as const,
};

describe("boundary conditions", () => {
  it("Zou/He west velocity prescribes (ρ·u) exactly from the arrived six", () => {
    // Arrived populations at a west node: {0, 2, 4, 3, 6, 7}.
    const arrived = [0.3, 0, 0.09, 0.08, 0.09, 0, 0.02, 0.015, 0];
    const index = 0 + 2 * nx;
    const state = seedScratch(arrived, index);
    const ux = 0.06;
    const uy = 0.01;
    lbmApplyFaceConditions(
      state,
      { ...inertFaces, west: { kind: "velocity", ux, uy } },
      { x: 0, y: 0 },
    );
    const { rho, mx, my } = nodeMassAndMomentum(state, index);
    expect(mx).toBeCloseTo(rho * ux, 6);
    expect(my).toBeCloseTo(rho * uy, 6);
    expect(rho).toBeGreaterThan(0.5);
  });

  it("Zou/He east pressure prescribes ρ exactly and solves the outflow speed", () => {
    // Arrived populations at an east node: {0, 2, 4, 1, 5, 8} (+ whatever
    // streamed in along y from the neighbours — zeroed here).
    const arrived = [0.3, 0.08, 0.09, 0, 0.09, 0.02, 0, 0, 0.015];
    const index = nx - 1 + 2 * nx;
    const state = seedScratch(arrived, index);
    state.uy[index - 1] = 0.02; // the lagged tangential source (interior)
    const rho = 1.04;
    lbmApplyFaceConditions(
      state,
      { ...inertFaces, east: { kind: "pressure", rho } },
      { x: 0, y: 0 },
    );
    const momenta = nodeMassAndMomentum(state, index);
    expect(momenta.rho).toBeCloseTo(rho, 6);
    expect(momenta.my).toBeCloseTo(rho * 0.02, 6);
    // The algebra's sign pin, not an outflow claim: this synthetic seed
    // just solves to u_x < 0, which at the east face points INTO the
    // domain (the inward normal there is −x, i.e. the inflow sign).
    expect(momenta.mx).toBeLessThan(0);
  });

  it("Zou/He south velocity prescribes the momentum of a bottom inlet", () => {
    const arrived = [0.3, 0.08, 0, 0.08, 0.09, 0, 0, 0.015, 0.02];
    const index = 2;
    const state = seedScratch(arrived, index);
    lbmApplyFaceConditions(
      state,
      { ...inertFaces, south: { kind: "velocity", ux: 0.02, uy: 0.05 } },
      { x: 0, y: 0 },
    );
    const { rho, mx, my } = nodeMassAndMomentum(state, index);
    expect(mx).toBeCloseTo(rho * 0.02, 6);
    expect(my).toBeCloseTo(rho * 0.05, 6);
  });

  it("Zou/He north velocity prescribes the momentum of a top inlet", () => {
    const arrived = [0.3, 0.08, 0.09, 0.08, 0, 0.015, 0.02, 0, 0];
    const index = 2 + (ny - 1) * nx;
    const state = seedScratch(arrived, index);
    lbmApplyFaceConditions(
      state,
      { ...inertFaces, north: { kind: "velocity", ux: -0.01, uy: -0.04 } },
      { x: 0, y: 0 },
    );
    const { rho, mx, my } = nodeMassAndMomentum(state, index);
    expect(mx).toBeCloseTo(rho * -0.01, 6);
    expect(my).toBeCloseTo(rho * -0.04, 6);
  });

  it("the convective outflow at rest is the zero-gradient copy of the pre-step values", () => {
    const arrived = [0.3, 0.08, 0.09, 0, 0.09, 0.02, 0, 0, 0.015];
    const index = nx - 1 + 2 * nx;
    const state = seedScratch(arrived, index);
    const neighbor = index - 1;
    for (let i = 0; i < D2Q9_Q; i += 1) {
      state.f[i]![neighbor] = arrived[i] ?? 0;
    }
    lbmApplyFaceConditions(
      state,
      { ...inertFaces, east: { kind: "convective-outflow" } },
      { x: 0, y: 0 },
    );
    for (const i of [3, 6, 7]) {
      // u = 0 clamps the Courant number to zero: f(t+dt) = f(t).
      expect(state.fTmp[i]![index]).toBeCloseTo(arrived[i] ?? 0, 6);
    }
  });

  it("a no-slip wall reflects the missing trio into its full mirrors", () => {
    const arrived = [0.3, 0.08, 0.09, 0.08, 0.11, 0.02, 0.03, 0.015, 0.025];
    const index = 2; // south face
    const state = seedScratch(arrived, index);
    lbmApplyFaceConditions(
      state,
      { ...inertFaces, south: { kind: "wall", slip: false } },
      { x: 0, y: 0 },
    );
    expect(state.fTmp[2]![index]).toBeCloseTo(arrived[4] ?? 0, 6); // f2 = f4
    expect(state.fTmp[5]![index]).toBeCloseTo(arrived[7] ?? 0, 6); // f5 = f7
    expect(state.fTmp[6]![index]).toBeCloseTo(arrived[8] ?? 0, 6); // f6 = f8
  });

  it("a symmetry plane flips only the wall-normal component (specular pair)", () => {
    const arrived = [0.3, 0.08, 0.09, 0.08, 0.11, 0.02, 0.03, 0.015, 0.025];
    const index = 2; // south face
    const state = seedScratch(arrived, index);
    lbmApplyFaceConditions(state, inertFaces, { x: 0, y: 0 });
    expect(state.fTmp[2]![index]).toBeCloseTo(arrived[4] ?? 0, 6); // f2 = f4
    expect(state.fTmp[5]![index]).toBeCloseTo(arrived[8] ?? 0, 6); // f5 = f8
    expect(state.fTmp[6]![index]).toBeCloseTo(arrived[7] ?? 0, 6); // f6 = f7
  });

  it("books the momentum each overwrite delivers into the ledger", () => {
    const arrived = [0.3, 0.08, 0.09, 0.08, 0.11, 0.02, 0.03, 0.015, 0.025];
    const index = 2;
    const state = seedScratch(arrived, index);
    const ledger = { x: 0, y: 0 };
    lbmApplyFaceConditions(
      state,
      { ...inertFaces, south: { kind: "wall", slip: false } },
      ledger,
    );
    const momenta = nodeMassAndMomentum(state, index);
    const before = nodeMassAndMomentum(seedScratch(arrived, index), index);
    // The ledger's row: (new − old)·c summed over the overwritten trio.
    let expectedX = 0;
    let expectedY = 0;
    const overwrites: readonly [number, number][] = [
      [2, arrived[4] ?? 0],
      [5, arrived[7] ?? 0],
      [6, arrived[8] ?? 0],
    ];
    for (const [i, value] of overwrites) {
      const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
      expectedX += (value - (arrived[i] ?? 0)) * cx;
      expectedY += (value - (arrived[i] ?? 0)) * cy;
    }
    expect(ledger.x).toBeCloseTo(expectedX, 6);
    expect(ledger.y).toBeCloseTo(expectedY, 6);
    expect(momenta.my).toBeCloseTo(before.my + expectedY, 6);
    expect(momenta.mx).toBeCloseTo(before.mx + expectedX, 6);
  });

  it("skips solid boundary nodes (geometry bounce-back owns them)", () => {
    const solid = new Uint8Array(nx * ny);
    solid[2] = 1;
    const state = createLbmState({ nx, ny, solid });
    for (let i = 0; i < D2Q9_Q; i += 1) {
      state.fTmp[i]!.fill(0);
    }
    state.fTmp[0]![2] = 0.44;
    lbmApplyFaceConditions(
      state,
      {
        west: { kind: "velocity", ux: 0.05, uy: 0 },
        east: { kind: "pressure", rho: 1 },
        south: { kind: "wall", slip: false },
        north: { kind: "wall", slip: false },
      },
      { x: 0, y: 0 },
    );
    // Only the rest population survived; no boundary write touched the node.
    for (let i = 1; i < D2Q9_Q; i += 1) {
      expect(state.fTmp[i]![2]).toBe(0);
    }
    expect(state.fTmp[0]![2]).toBeCloseTo(0.44, 6);
  });
});
