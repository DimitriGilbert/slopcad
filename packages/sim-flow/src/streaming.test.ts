import { describe, expect, it } from "vitest";

import { createLbmState, lbmReflectSolids } from "./state";
import { lbmStream, lbmSwap } from "./streaming";

describe("push streaming", () => {
  it("moves each population exactly one link along its velocity", () => {
    const state = createLbmState({ nx: 5, ny: 5, solid: new Uint8Array(25) });
    for (let i = 0; i < 9; i += 1) {
      state.f[i]!.fill(0);
      state.fTmp[i]!.fill(0);
    }
    state.f[1]![2 + 2 * 5] = 0.3; // (+1, 0)  from (2,2)
    state.f[5]![2 + 2 * 5] = 0.1; // (+1,+1)  from (2,2)
    state.f[4]![2 + 2 * 5] = 0.2; // (0,−1)   from (2,2)
    state.f[0]![2 + 2 * 5] = 0.4; // rest     stays
    lbmStream(state);
    expect(state.fTmp[1]![3 + 2 * 5]).toBeCloseTo(0.3, 6);
    expect(state.fTmp[5]![3 + 3 * 5]).toBeCloseTo(0.1, 6);
    expect(state.fTmp[4]![2 + 1 * 5]).toBeCloseTo(0.2, 6);
    expect(state.fTmp[0]![2 + 2 * 5]).toBeCloseTo(0.4, 6);
    // Nothing arrived anywhere else from direction 1.
    expect(state.fTmp[1]![2 + 2 * 5]).toBe(0);
  });

  it("books the momentum of populations pushed out of the domain", () => {
    const state = createLbmState({ nx: 5, ny: 5, solid: new Uint8Array(25) });
    for (let i = 0; i < 9; i += 1) {
      state.f[i]!.fill(0);
      state.fTmp[i]!.fill(0);
    }
    state.f[1]![4 + 2 * 5] = 0.25; // (+1,0) at the east edge: drops
    state.f[2]![3 + 4 * 5] = 0.15; // (0,+1) at the north edge: drops
    state.f[6]![0 + 4 * 5] = 0.05; // (−1,+1) at the west+north corner: drops
    const { droppedX, droppedY } = lbmStream(state);
    expect(droppedX).toBeCloseTo(0.25 - 0.05, 6);
    expect(droppedY).toBeCloseTo(0.15 + 0.05, 6);
  });

  it("a full-way round trip: out and back in two streams with one reflection", () => {
    const solid = new Uint8Array(25);
    solid[3 + 2 * 5] = 1; // node (3, 2)
    const state = createLbmState({ nx: 5, ny: 5, solid });
    for (let i = 0; i < 9; i += 1) {
      state.f[i]!.fill(0);
      state.fTmp[i]!.fill(0);
    }
    const value = 0.2;
    state.f[1]![2 + 2 * 5] = value; // leaves (2,2) heading +x
    lbmStream(state); // arrives at the solid (3,2)
    const impulse = lbmReflectSolids(state); // reflected to −x
    expect(impulse.impulseX).toBeCloseTo(2 * value, 6);
    lbmSwap(state);
    lbmStream(state); // reflected population leaves the solid
    expect(state.fTmp[3]![2 + 2 * 5]).toBeCloseTo(value, 6);
    expect(state.fTmp[3]![3 + 2 * 5]).toBe(0);
  });
});
