/**
 * The MJCF builder's pins (Phase 67b): the document→MuJoCo model
 * mapping as DETERMINISTIC TEXT — one pinned XML per joint kind (the
 * near-free friction mapping's `damping`/`frictionloss` attributes
 * included), the quaternion bridge against the classic conventions, and
 * the deterministic number formatting. Pure builder tests: no wasm, no
 * engine — the provider suite carries the runtime pins.
 */

import { describe, expect, it } from "vitest";

import { compileMechanism } from "./door";
import {
  MJCF_INERTIA_FLOOR_KG_M2,
  MJCF_LOOP_AXIS_SAMPLE_M,
  buildMjcf,
  mat3FromQuat,
  mjcfNumber,
  quatFromMat3,
  rotationVectorFromMat3,
} from "./mujoco-model";
import { mechanismTopology } from "./topology";

const SQ = Math.SQRT1_2;

function builtXml(input: Parameters<typeof compileMechanism>[0]): string {
  const compiled = compileMechanism(input);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const topology = mechanismTopology(
    compiled.value.bodies,
    compiled.value.joints,
  );
  return buildMjcf(compiled.value, topology).xml;
}

const MASS_BASE = {
  occurrenceId: "base",
  massGrams: 1000,
  centerOfGravityMm: [0, 0, 0] as [number, number, number],
};

describe("the quaternion bridge (MuJoCo wxyz against the classic forms)", () => {
  it("quatFromMat3 and mat3FromQuat are mutual inverses on canonical rotations", () => {
    const cases: readonly (readonly [number, number, number, number])[] = [
      [SQ, 0, 0, SQ], // rotZ 90°
      [SQ, SQ, 0, 0], // rotX 90°
      [SQ, 0, SQ, 0], // rotY 90°
      (() => {
        const angle = Math.hypot(0.3, -0.2, 0.5);
        const half = Math.sin(angle / 2);
        return [
          Math.cos(angle / 2),
          (0.3 / angle) * half,
          (-0.2 / angle) * half,
          (0.5 / angle) * half,
        ];
      })(), // exp([0.3,-0.2,0.5])
    ];
    for (const [w, x, y, z] of cases) {
      const r = mat3FromQuat([w, x, y, z]);
      const back = quatFromMat3(r);
      const same =
        [w, x, y, z].every((v, i) => Math.abs(v - (back[i] ?? 0)) < 1e-12) ||
        [w, x, y, z].every((v, i) => Math.abs(v + (back[i] ?? 0)) < 1e-12);
      expect(same).toBe(true);
    }
  });

  it("rotationVectorFromMat3 is the exact log of exp([φ]×)", () => {
    const phis: readonly (readonly number[])[] = [
      [0.3, -0.2, 0.5],
      [0, 0, 0],
      [2.5, 0.1, -0.4],
    ];
    for (const phi of phis) {
      const angle = Math.hypot(phi[0] ?? 0, phi[1] ?? 0, phi[2] ?? 0);
      if (angle < 1e-12) continue;
      const u = [
        (phi[0] ?? 0) / angle,
        (phi[1] ?? 0) / angle,
        (phi[2] ?? 0) / angle,
      ];
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const t = 1 - c;
      const [a = 0, b = 0, cc = 0] = u;
      const r = mat3FromQuat([
        Math.cos(angle / 2),
        a * Math.sin(angle / 2),
        b * Math.sin(angle / 2),
        cc * Math.sin(angle / 2),
      ]);
      // The Rodrigues form (independent construction):
      const rr = [
        t * a * a + c,
        t * a * b - s * cc,
        t * a * cc + s * b,
        t * a * b + s * cc,
        t * b * b + c,
        t * b * cc - s * a,
        t * a * cc - s * b,
        t * b * cc + s * a,
        t * cc * cc + c,
      ];
      for (let index = 0; index < 9; index += 1) {
        expect(r[index]).toBeCloseTo(rr[index] ?? 0, 12);
      }
      const log = rotationVectorFromMat3(r);
      expect(log[0]).toBeCloseTo(phi[0] ?? 0, 12);
      expect(log[1]).toBeCloseTo(phi[1] ?? 0, 12);
      expect(log[2]).toBeCloseTo(phi[2] ?? 0, 12);
    }
  });
});

describe("deterministic number formatting", () => {
  it("formats at twelve fixed decimals, trimming trailing zeros and normalizing −0", () => {
    expect(mjcfNumber(0.1)).toBe("0.1");
    expect(mjcfNumber(0.30000000000000004)).toBe("0.3");
    expect(mjcfNumber(-0)).toBe("0");
    expect(mjcfNumber(1e-9)).toBe("0.000000001");
    expect(mjcfNumber(1e-12)).toBe("0.000000000001");
  });
});

describe("the pinned MJCF per joint kind", () => {
  it("renders a revolute with the friction fields as native attributes", () => {
    const xml = builtXml({
      occurrences: [
        {
          id: "base",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "rod",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      grounded: ["base"],
      joints: [
        {
          id: "jnt_pivot",
          name: "Pivot",
          kind: "revolute",
          baseOccurrenceId: "base",
          occurrenceId: "rod",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
          viscousDampingNPerMSPerRad: 0.02,
          frictionLossNPerM: 0.05,
        },
      ],
      masses: [
        MASS_BASE,
        { occurrenceId: "rod", massGrams: 500, centerOfGravityMm: [100, 0, 0] },
      ],
      gravityMPerS2: [0, -9.80665, 0],
    });
    expect(xml).toContain(
      '<joint type="hinge" name="jnt_pivot" pos="0 0 0" axis="0 0 1" damping="0.02" frictionloss="0.05"/>',
    );
    // The point-mass rod's COG tensor floors at ε on every eigenvalue.
    expect(xml).toContain(
      `fullinertia="${mjcfNumber(MJCF_INERTIA_FLOOR_KG_M2)} ${mjcfNumber(MJCF_INERTIA_FLOOR_KG_M2)} ${mjcfNumber(MJCF_INERTIA_FLOOR_KG_M2)} 0 0 0"`,
    );
    expect(xml).toContain('gravity="0 -9.80665 0" integrator="Euler"');
  });

  it("renders a slider, a cylindrical pair, and the planar triple in the pinned order", () => {
    const kinds: readonly (readonly [string, string, string])[] = [
      ["slider", '<joint type="slide" name="j"', 'axis="1 0 0"/>'],
      [
        "cylindrical",
        '<joint type="hinge" name="j"',
        '<joint type="slide" name="j#1"',
      ],
      [
        "planar",
        '<joint type="slide" name="j"',
        '<joint type="slide" name="j#1"',
      ],
    ];
    for (const [kind, first, second] of kinds) {
      const xml = builtXml({
        occurrences: [
          {
            id: "base",
            placement: {
              rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
              translation: [0, 0, 0],
            },
          },
          {
            id: "body",
            placement: {
              rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
              translation: [0, 0, 0],
            },
          },
        ],
        joints: [
          {
            id: "j",
            kind,
            baseOccurrenceId: "base",
            occurrenceId: "body",
            frame: {
              origin: [10, 20, 30],
              axis: kind === "slider" ? [1, 0, 0] : [0, 1, 1],
            },
          },
        ],
        masses: [
          MASS_BASE,
          {
            occurrenceId: "body",
            massGrams: 800,
            centerOfGravityMm: [0, 0, 0],
            inertiaTensorKgM2: [0.002, 0, 0, 0, 0.003, 0, 0, 0, 0.004],
          },
        ],
        grounded: ["base"],
        gravityMPerS2: [0, 0, 0],
      });
      expect(xml).toContain(first);
      if (second.startsWith("<joint")) {
        expect(xml).toContain(second);
      }
      if (kind === "planar") {
        // Slides first, hinge LAST — the mates' pre-rotational plane.
        const slides = xml.indexOf('<joint type="slide" name="j#1"');
        const hinge = xml.indexOf('<joint type="hinge" name="j#2"');
        expect(hinge).toBeGreaterThan(slides);
        expect(slides).toBeGreaterThan(-1);
      }
    }
  });

  it("renders the ball joint and the free root", () => {
    const xml = builtXml({
      occurrences: [
        {
          id: "base",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "body",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [100, 0, 0],
          },
        },
        {
          id: "loose",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 300, 0],
          },
        },
      ],
      joints: [
        {
          id: "j_ball",
          kind: "ball",
          baseOccurrenceId: "base",
          occurrenceId: "body",
          frame: { origin: [0, 0, 0] },
        },
      ],
      masses: [
        MASS_BASE,
        {
          occurrenceId: "body",
          massGrams: 2000,
          centerOfGravityMm: [120, -10, 30],
          inertiaTensorKgM2: [0.004, 0, 0, 0, 0.003, 0, 0, 0, 0.002],
        },
        {
          occurrenceId: "loose",
          massGrams: 500,
          centerOfGravityMm: [0, 300, 0],
        },
      ],
      grounded: ["base"],
      gravityMPerS2: [0, 0, 0],
    });
    expect(xml).toContain('<joint type="ball" name="j_ball" pos="-0.1 0 0"/>');
    expect(xml).toContain('<freejoint name="loose::free"/>');
  });

  it("triangle-balances the singular rotor tensor minimally", () => {
    // diag(0, 0, 0.01) + floor: the two smaller principals rise to
    // λ₃/2 + ε — the hinge axis inertia stays EXACT.
    const xml = builtXml({
      occurrences: [
        {
          id: "base",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "rotor",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      grounded: ["base"],
      joints: [
        {
          id: "j_spin",
          kind: "revolute",
          baseOccurrenceId: "base",
          occurrenceId: "rotor",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        },
      ],
      masses: [
        MASS_BASE,
        {
          occurrenceId: "rotor",
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
          inertiaTensorKgM2: [0, 0, 0, 0, 0, 0, 0, 0, 0.01],
        },
      ],
      gravityMPerS2: [0, 0, 0],
    });
    const largest = 0.01 + MJCF_INERTIA_FLOOR_KG_M2;
    const lifted = largest / 2 + MJCF_INERTIA_FLOOR_KG_M2;
    const expected = `fullinertia="${mjcfNumber(lifted)} ${mjcfNumber(lifted)} ${mjcfNumber(largest)} 0 0 0"`;
    expect(xml).toContain(expected);
  });

  it("renders loop closure as paired connects with the pinned solref", () => {
    const xml = builtXml({
      occurrences: [
        {
          id: "frame",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "a",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "pin",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [100, 0, 0],
          },
        },
        {
          id: "c",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [180, 0, 0],
          },
        },
      ],
      joints: [
        {
          id: "j_a",
          kind: "revolute",
          baseOccurrenceId: "frame",
          occurrenceId: "a",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        },
        {
          id: "j_weld",
          kind: "rigid",
          baseOccurrenceId: "a",
          occurrenceId: "pin",
        },
        {
          id: "j_c",
          kind: "revolute",
          baseOccurrenceId: "frame",
          occurrenceId: "c",
          frame: { origin: [180, 0, 0], axis: [0, 0, 1] },
        },
        {
          id: "j_loop",
          kind: "revolute",
          baseOccurrenceId: "c",
          occurrenceId: "pin",
          frame: { origin: [100, 0, 0], axis: [0, 0, 1] },
        },
      ],
      masses: [
        {
          occurrenceId: "frame",
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
        },
        { occurrenceId: "a", massGrams: 200, centerOfGravityMm: [100, 0, 0] },
        { occurrenceId: "pin", massGrams: 50, centerOfGravityMm: [100, 0, 0] },
        { occurrenceId: "c", massGrams: 200, centerOfGravityMm: [100, 0, 0] },
      ],
      grounded: ["frame"],
      gravityMPerS2: [0, -9.80665, 0],
    });
    expect(xml).toContain(
      `<connect name="j_loop#eq0" body1="c" body2="pin" anchor="0.1 0 0" solref="0.002 1"/>`,
    );
    expect(xml).toContain(
      `<connect name="j_loop#eq1" body1="c" body2="pin" anchor="0.1 0 ${mjcfNumber(MJCF_LOOP_AXIS_SAMPLE_M)}" solref="0.002 1"/>`,
    );
  });

  it("renders the motor as a gear-1 actuator with the rotor inertia as armature", () => {
    const xml = builtXml({
      occurrences: [
        {
          id: "base",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "rotor",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      grounded: ["base"],
      joints: [
        {
          id: "j_drive",
          kind: "revolute",
          baseOccurrenceId: "base",
          occurrenceId: "rotor",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        },
      ],
      masses: [
        MASS_BASE,
        {
          occurrenceId: "rotor",
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
          inertiaTensorKgM2: [0, 0, 0, 0, 0, 0, 0, 0, 0.005],
        },
      ],
      gravityMPerS2: [0, 0, 0],
      motors: [
        {
          jointId: "j_drive",
          motor: {
            id: "mtr",
            kind: "dc-brushed",
            stallTorqueMNm: 100,
            noLoadSpeedRpm: 6000,
            nominalVoltageV: 12,
            rotorInertiaKgM2: 0.003,
          },
        },
      ],
    });
    expect(xml).toContain('armature="0.003"');
    expect(xml).toContain('<motor name="j_drive" joint="j_drive" gear="1"/>');
  });
});
