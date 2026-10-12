/**
 * The geometry-aware compile door's DYNAMICS branch tests (Phase 67c):
 * a serialized dynamics scenario plus the document's mechanism wire
 * (occurrences, joint records, mass properties, grounded ids) become
 * the compiled problem's solver dynamics — the stance re-validated at
 * the door, the wire carried verbatim for the 67 dynamics door's own
 * conversion, and the load couplings converted to SI (the application
 * point's mm → m). The truths this file owns:
 *
 * - the products attach ONLY through the compile door that carries the
 *   mechanism wire; the plain 61a door never sees it (a wire-less
 *   compile stays the 61a shape);
 * - every stance budget, wire shape, and load series the door consumes
 *   is re-validated — the loud declines, never silent drops (a
 *   non-string grounded entry is refused, not filtered);
 * - the motor record crosses verbatim (`motorWire`) — the dynamics
 *   door owns its one conversion site.
 *
 * Node-env vitest, no network — the law-S2/S5 stance.
 */

import { describe, expect, it } from "vitest";

import { compileSimScenarioWithGeometry } from "./compile-geometry";
import { compileSimScenario, type SimMechanismWire } from "./units";

/**
 * The compile door's `mechanism` seam is typed in-process, but the
 * door's re-validation exists for the UNTRUSTED wire that crosses it
 * (the worker host's serialized form) — the malformed fixtures below
 * ride through this one declared seam, never silently coerced.
 */
function mechanismSeam(wire: unknown): SimMechanismWire {
  return wire as SimMechanismWire;
}

/** The serialized demo motor record (the compile's `motor` seam). */
const CRANK_MOTOR = {
  id: "mtr_crank",
  name: "Crank motor",
  kind: "dc-brushed",
  stallTorqueMNm: 80,
  noLoadSpeedRpm: 1500,
  nominalVoltageV: 12,
  rotorInertiaKgM2: 0.0004,
};

/** The mechanism wire's structural fixture (verbatim document forms). */
function mechanismWire(overrides?: {
  readonly grounded?: readonly unknown[];
  readonly occurrences?: readonly unknown[];
  readonly joints?: readonly unknown[];
  readonly masses?: readonly unknown[];
}): Record<string, unknown> {
  return {
    occurrences: overrides?.occurrences ?? [
      {
        id: "occ_base",
        placement: {
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [0, 0, 0],
        },
      },
      {
        id: "occ_crank",
        placement: {
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [0, 0, 0],
        },
      },
    ],
    joints: overrides?.joints ?? [
      {
        id: "jnt_crank",
        name: "Crank main bearing",
        kind: "revolute",
        baseOccurrenceId: "occ_base",
        occurrenceId: "occ_crank",
        frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
      },
    ],
    masses: overrides?.masses ?? [
      {
        occurrenceId: "occ_base",
        massGrams: 282.6,
        centerOfGravityMm: [65, 0, 0],
        inertiaTensorKgM2: [0.00027, 0, 0, 0, 0.00027, 0, 0, 0, 0.00027],
      },
      {
        occurrenceId: "occ_crank",
        massGrams: 84.8,
        centerOfGravityMm: [15, 0, 0],
        inertiaTensorKgM2: [3e-6, 0, 0, 0, 3e-6, 0, 0, 0, 3e-6],
      },
    ],
    ...(overrides?.grounded === undefined
      ? {}
      : { grounded: overrides.grounded }),
  };
}

/**
 * The serialized dynamics scenario the door consumes. `stance` replaces
 * the solve stance wholesale (`null` omits it); `loads` rides inside it.
 */
function dynamicsScenario(options?: {
  readonly stance?: unknown;
  readonly loads?: unknown;
}): Record<string, unknown> {
  const base = {
    timeStepS: 0.001,
    durationS: 2,
    sampleIntervalS: 0.04,
    motorJointId: "jnt_crank",
    ...(options?.loads === undefined ? {} : { loads: options.loads }),
  };
  return {
    id: "sim_000001",
    name: "slider-crank",
    kind: "dynamics",
    domain: {
      kind: "explicit",
      min: [-20, -40, -12],
      max: [150, 40, 12],
      resolutionMm: 2,
    },
    conditions: [],
    fluid: "air",
    materials: [],
    gravityMPerS2: [0, -9.80665, 0],
    ...(options?.stance === null
      ? {}
      : {
          dynamics: options?.stance === undefined ? base : options.stance,
        }),
  };
}

describe("the dynamics compile branch", () => {
  it("attaches the re-validated stance, the wire verbatim, and the SI loads", () => {
    const motor = { ...CRANK_MOTOR };
    const loads = [
      {
        kind: "flow-force",
        occurrenceId: "occ_crank",
        samples: [
          { tS: 0, forceN: [1, 0, 0], atWorldPointMm: [10, 0, 0] },
          { tS: 2, forceN: [2, 0, 0], atWorldPointMm: [20, 0, 0] },
        ],
      },
      {
        kind: "joint-torque",
        name: "combustion estimate",
        jointId: "jnt_crank",
        samples: [
          { tS: 0, effortNPerM: 0 },
          { tS: 2, effortNPerM: 0.01 },
        ],
      },
    ];
    const wire = mechanismWire({ grounded: ["occ_base"] });
    const compiled = compileSimScenarioWithGeometry({
      scenario: dynamicsScenario({ loads }),
      motor,
      mechanism: mechanismSeam(wire),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const dynamics = compiled.value.dynamics;
    expect(dynamics).toBeDefined();
    if (dynamics === undefined) return;
    // The stance, re-validated and carried.
    expect(dynamics.provider).toBe("reference");
    expect(dynamics.timeStepS).toBe(0.001);
    expect(dynamics.durationS).toBe(2);
    expect(dynamics.sampleIntervalS).toBe(0.04);
    expect(dynamics.motorJointId).toBe("jnt_crank");
    // The wire crosses VERBATIM — the 67 dynamics door converts it.
    expect(dynamics.mechanism).toEqual(wire);
    // The motor record crosses verbatim (the door's own one site).
    expect(dynamics.motorWire).toEqual(motor);
    // The loads in SI: forces and efforts as authored, the point mm → m.
    expect(dynamics.loads).toHaveLength(2);
    const flow = dynamics.loads[0];
    expect(flow?.kind).toBe("flow-force");
    if (flow?.kind === "flow-force") {
      expect(flow.samples[0]?.forceN).toEqual([1, 0, 0]);
      expect(flow.samples[0]?.atWorldPointM).toEqual([0.01, 0, 0]);
      expect(flow.samples[1]?.atWorldPointM).toEqual([0.02, 0, 0]);
    }
    const torque = dynamics.loads[1];
    if (torque?.kind === "joint-torque") {
      expect(torque.name).toBe("combustion estimate");
      expect(torque.samples[1]?.effortNPerM).toBe(0.01);
    }
  });

  it("keeps the 61a shape at the plain door and declines wire-less geometry compiles", () => {
    // The plain 61a door never sees the mechanism seam: the scenario
    // compiles to the bare (geometry-less) shape without dynamics
    // products.
    const plain = compileSimScenario({ scenario: dynamicsScenario() });
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.value.dynamics).toBeUndefined();
    }
    // The geometry door REFUSES to fabricate a mechanism.
    const wireless = compileSimScenarioWithGeometry({
      scenario: dynamicsScenario(),
    });
    expect(wireless.ok).toBe(false);
    if (!wireless.ok) {
      expect(wireless.error.message).toContain("refuses to fabricate");
    }
  });

  it("re-validates the stance budget on the step lattice and cadence grid", () => {
    const declined = (
      options: { readonly stance?: unknown },
      fragment: string,
    ): void => {
      const refused = compileSimScenarioWithGeometry({
        scenario: dynamicsScenario(options),
        mechanism: mechanismSeam(mechanismWire()),
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.message).toContain(fragment);
      }
    };
    declined({ stance: null }, "refuses to guess a march");
    declined({ stance: "not an object" }, "refuses to guess a march");
    declined(
      {
        stance: {
          timeStepS: 0,
          durationS: 2,
          sampleIntervalS: 0.04,
        },
      },
      "positive finite number",
    );
    declined(
      {
        stance: {
          timeStepS: 0.003,
          durationS: 1,
          sampleIntervalS: 0.02,
        },
      },
      "integer multiple",
    );
    declined(
      {
        stance: {
          timeStepS: 0.001,
          durationS: 2,
          sampleIntervalS: 0.0005,
        },
      },
      "integer number of time steps",
    );
    declined(
      {
        stance: {
          timeStepS: 0.001,
          durationS: 2,
          sampleIntervalS: 0.04,
          provider: "warp",
        },
      },
      '"reference" or "mujoco"',
    );
    declined(
      {
        stance: {
          timeStepS: 0.001,
          durationS: 2,
          sampleIntervalS: 0.04,
          motorJointId: 7,
        },
      },
      "joint id string",
    );
  });

  it("declines mechanism wires with structural holes and non-string grounded entries", () => {
    const over = (
      wire: Record<string, unknown>,
    ): ReturnType<typeof compileSimScenarioWithGeometry> =>
      compileSimScenarioWithGeometry({
        scenario: dynamicsScenario(),
        mechanism: mechanismSeam(wire),
      });
    const holes = over({
      occurrences: [],
      joints: [],
      masses: [],
    });
    expect(holes.ok).toBe(false);
    if (!holes.ok) {
      expect(holes.error.message).toContain("non-empty occurrences");
    }
    const noMasses = over({
      occurrences: mechanismWire().occurrences,
      joints: mechanismWire().joints,
    });
    expect(noMasses.ok).toBe(false);
    if (!noMasses.ok) {
      expect(noMasses.error.message).toContain("mass-properties list");
    }
    const groundedNotArray = over({
      ...mechanismWire(),
      grounded: "occ_base",
    });
    expect(groundedNotArray.ok).toBe(false);
    if (!groundedNotArray.ok) {
      expect(groundedNotArray.error.message).toContain(
        "grounded list must be an array",
      );
    }
    // The never-guess posture: a non-string grounded entry is declined
    // loudly, never silently filtered out of the weld list.
    const groundedNonString = over({
      ...mechanismWire(),
      grounded: ["occ_base", 42],
    });
    expect(groundedNonString.ok).toBe(false);
    if (!groundedNonString.ok) {
      expect(groundedNonString.error.message).toContain(
        "grounded entries must be occurrence id strings",
      );
    }
  });

  it("declines malformed load couplings loudly", () => {
    const withLoads = (
      loads: unknown,
    ): ReturnType<typeof compileSimScenarioWithGeometry> =>
      compileSimScenarioWithGeometry({
        scenario: dynamicsScenario({ loads }),
        mechanism: mechanismSeam(mechanismWire()),
      });
    const declined = (loads: unknown, fragment: string): void => {
      const refused = withLoads(loads);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.message).toContain(fragment);
      }
    };
    declined("not an array", "array of series records");
    declined(["not a record"], "plain object with a kind field");
    declined(
      [
        {
          kind: "wind-force",
          occurrenceId: "occ_crank",
          samples: [
            { tS: 0, forceN: [1, 0, 0] },
            { tS: 1, forceN: [1, 0, 0] },
          ],
        },
      ],
      '"flow-force" or "joint-torque"',
    );
    declined(
      [
        {
          kind: "flow-force",
          occurrenceId: 7,
          samples: [
            { tS: 0, forceN: [1, 0, 0] },
            { tS: 1, forceN: [1, 0, 0] },
          ],
        },
      ],
      "occurrence id string",
    );
    declined(
      [
        {
          kind: "flow-force",
          occurrenceId: "occ_crank",
          samples: [{ tS: 0, forceN: [1, 0, 0] }],
        },
      ],
      "at least two samples",
    );
    declined(
      [
        {
          kind: "flow-force",
          occurrenceId: "occ_crank",
          samples: [
            { tS: 1, forceN: [1, 0, 0] },
            { tS: 0, forceN: [1, 0, 0] },
          ],
        },
      ],
      "strictly increasing",
    );
    declined(
      [
        {
          kind: "flow-force",
          occurrenceId: "occ_crank",
          samples: [
            { tS: 0, forceN: [1, 0] },
            { tS: 1, forceN: [1, 0, 0] },
          ],
        },
      ],
      "force",
    );
    declined(
      [
        {
          kind: "flow-force",
          occurrenceId: "occ_crank",
          samples: [
            { tS: 0, forceN: [1, 0, 0], atWorldPointMm: [10, 0] },
            { tS: 1, forceN: [1, 0, 0] },
          ],
        },
      ],
      "application point",
    );
    declined(
      [
        {
          kind: "joint-torque",
          name: "estimate",
          jointId: "jnt_crank",
          samples: [
            { tS: 0, effortNPerM: 0 },
            { tS: 1, effortNPerM: "strong" },
          ],
        },
      ],
      "finite number (N·m)",
    );
    declined(
      [
        {
          kind: "joint-torque",
          name: "   ",
          jointId: "jnt_crank",
          samples: [
            { tS: 0, effortNPerM: 0 },
            { tS: 1, effortNPerM: 0 },
          ],
        },
      ],
      "1-64 characters",
    );
    declined(
      [
        {
          kind: "joint-torque",
          name: "estimate",
          jointId: 7,
          samples: [
            { tS: 0, effortNPerM: 0 },
            { tS: 1, effortNPerM: 0 },
          ],
        },
      ],
      "joint id string",
    );
  });
});
