/**
 * The quasi-static load coupling's units (Phase 67c, deliverable 4):
 * the compile door's restated validation and the per-step evaluation's
 * interpolation semantics — piecewise-linear between samples, constant
 * ends outside them, flow forces to the control's loads term and
 * torque estimates to its joint efforts.
 */

import { describe, expect, it } from "vitest";
import type { CompiledSimDynamicsLoad } from "@slopcad/sim-core";

import {
  compileDynamicsLoads,
  emptyDynamicsLoadTerms,
  evaluateDynamicsLoads,
} from "./loads";

function flowForceLoad(): CompiledSimDynamicsLoad {
  return {
    kind: "flow-force",
    occurrenceId: "occ_body",
    samples: [
      {
        tS: 0,
        forceN: [1, 0, 0],
        atWorldPointM: [0.1, 0, 0],
      },
      {
        tS: 1,
        forceN: [3, -2, 0.5],
        atWorldPointM: [0.2, 0, 0],
      },
      {
        tS: 2,
        forceN: [2, -1, 0.25],
      },
    ],
  };
}

function torqueLoad(): CompiledSimDynamicsLoad {
  return {
    kind: "joint-torque",
    name: "combustion estimate",
    jointId: "jnt_crank",
    samples: [
      { tS: 0.5, effortNPerM: 0 },
      { tS: 1.5, effortNPerM: 4 },
    ],
  };
}

describe("the load coupling compile", () => {
  it("compiles both series kinds with their tables", () => {
    const compiled = compileDynamicsLoads([flowForceLoad(), torqueLoad()]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.series).toHaveLength(2);
    const flow = compiled.series[0];
    expect(flow?.kind).toBe("flow-force");
    expect(flow?.occurrenceId).toBe("occ_body");
    expect(flow?.times).toEqual([0, 1, 2]);
    expect(flow?.forces?.[1]).toEqual([3, -2, 0.5]);
    expect(flow?.points?.[2]).toBeUndefined();
    const torque = compiled.series[1];
    expect(torque?.kind).toBe("joint-torque");
    expect(torque?.name).toBe("combustion estimate");
    expect(torque?.efforts).toEqual([0, 4]);
  });

  it("declines a series without the interpolation spine", () => {
    const single = compileDynamicsLoads([
      {
        kind: "joint-torque",
        name: "thin",
        jointId: "jnt_crank",
        samples: [{ tS: 0, effortNPerM: 1 }],
      },
    ]);
    expect(single.ok).toBe(false);
    const unordered = compileDynamicsLoads([
      {
        kind: "joint-torque",
        name: "backwards",
        jointId: "jnt_crank",
        samples: [
          { tS: 1, effortNPerM: 1 },
          { tS: 0, effortNPerM: 2 },
        ],
      },
    ]);
    expect(unordered.ok).toBe(false);
    if (unordered.ok) return;
    expect(unordered.message).toContain("strictly increasing");
  });

  it("the empty stance is the empty term", () => {
    expect(emptyDynamicsLoadTerms()).toEqual({ loads: [], jointEfforts: [] });
  });
});

describe("the per-step evaluation", () => {
  it("interpolates component-wise with constant ends", () => {
    const compiled = compileDynamicsLoads([flowForceLoad()]);
    if (!compiled.ok) throw new Error(compiled.message);
    const mid = evaluateDynamicsLoads(compiled.series, 0.5);
    expect(mid.loads).toHaveLength(1);
    expect(mid.loads[0]?.forceN[0]).toBeCloseTo(2, 12);
    expect(mid.loads[0]?.forceN[1]).toBeCloseTo(-1, 12);
    expect(mid.loads[0]?.forceN[2]).toBeCloseTo(0.25, 12);
    expect(mid.loads[0]?.atWorldPointM?.[0]).toBeCloseTo(0.15, 12);
    // Before the first sample: the first value holds.
    const before = evaluateDynamicsLoads(compiled.series, -1);
    expect(before.loads[0]?.forceN[0]).toBeCloseTo(1, 12);
    // After the last: the last holds.
    const after = evaluateDynamicsLoads(compiled.series, 99);
    expect(after.loads[0]?.forceN[0]).toBeCloseTo(2, 12);
    // A sample past the last authored POINT keeps the nearest authored
    // one (the honest nearest-sample rule for the application point).
    expect(after.loads[0]?.atWorldPointM?.[0]).toBeCloseTo(0.2, 12);
  });

  it("interpolates the torque estimate and clamps outside its window", () => {
    const compiled = compileDynamicsLoads([torqueLoad()]);
    if (!compiled.ok) throw new Error(compiled.message);
    const before = evaluateDynamicsLoads(compiled.series, 0);
    expect(before.jointEfforts[0]?.effort).toBeCloseTo(0, 12);
    const mid = evaluateDynamicsLoads(compiled.series, 1);
    expect(mid.jointEfforts[0]?.effort).toBeCloseTo(2, 12);
    const after = evaluateDynamicsLoads(compiled.series, 2);
    expect(after.jointEfforts[0]?.effort).toBeCloseTo(4, 12);
    expect(after.jointEfforts[0]?.jointId).toBe("jnt_crank");
  });

  it("no series is the empty control term", () => {
    const terms = evaluateDynamicsLoads([], 1);
    expect(terms.loads).toHaveLength(0);
    expect(terms.jointEfforts).toHaveLength(0);
  });
});
