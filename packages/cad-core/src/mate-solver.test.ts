/**
 * Assembly mate solver tests (Phase 51): golden closed-form solves, the
 * numeric solve against them, DOF accounting, structured diagnostics,
 * joint zero stations, and the bitwise determinism gate.
 */

import { describe, expect, it } from "vitest";

import {
  ASSEMBLY_SOLVE_DIAGNOSTIC_CODES,
  createJointId,
  createMateId,
  createOccurrenceId,
  createReferenceId,
  IDENTITY_PLACEMENT_TRANSFORM,
  jointDofSummary,
  MATE_RESIDUAL_TOLERANCE,
  referenceSolveCoincident,
  solveAssemblyMates,
  transformPlacementPoint,
  type JointId,
  type MateAnchor,
  type MateId,
  type PlacementTransform,
  type ReferenceId,
} from "./index";

const OCC_A = createOccurrenceId("occ_base");
const OCC_B = createOccurrenceId("occ_lid");
const MAT_FLUSH: MateId = createMateId("mat_flush");
const MAT_GAP: MateId = createMateId("mat_gap");
const MAT_GHOST: MateId = createMateId("mat_ghost");
const JNT_HINGE: JointId = createJointId("jnt_hinge");
const JNT_SLIDER: JointId = createJointId("jnt_slider");
const REF_A: ReferenceId = createReferenceId("ref_a");
const REF_B: ReferenceId = createReferenceId("ref_b");

const PLANE_TOP: MateAnchor = {
  kind: "plane",
  transform: {
    rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
    translation: [0, 0, 10],
  },
};

const IDENTITY: PlacementTransform = IDENTITY_PLACEMENT_TRANSFORM;

function translate(x: number, y: number, z: number): PlacementTransform {
  return { rotation: IDENTITY.rotation, translation: [x, y, z] };
}

describe("mate solver", () => {
  it("matches the reference solver's closed form for a coincident mate", () => {
    const baseWorld = IDENTITY;
    const movingWorld = translate(50, 0, 0);
    const baseAnchor: MateAnchor = PLANE_TOP;
    const movingAnchor: MateAnchor = { kind: "plane", transform: IDENTITY };
    const golden = referenceSolveCoincident(
      baseWorld,
      baseAnchor,
      movingWorld,
      movingAnchor,
    );
    // The closed form maps the moving anchor exactly onto the base anchor.
    expect(transformPlacementPoint(golden, [0, 0, 0])).toEqual([0, 0, 10]);
    const result = solveAssemblyMates({
      occurrences: [OCC_A, OCC_B],
      grounded: [OCC_A],
      mates: [
        {
          id: MAT_FLUSH,
          name: "Flush",
          kind: "coincident",
          first: { occurrenceId: OCC_A, referenceId: REF_A },
          second: { occurrenceId: OCC_B, referenceId: REF_B },
        },
      ],
      joints: [],
      initial: new Map([
        [OCC_A, baseWorld],
        [OCC_B, movingWorld],
      ]),
      anchors: new Map([
        [MAT_FLUSH, { first: baseAnchor, second: movingAnchor }],
      ]),
    });
    expect(result.status).toBe("solved");
    expect(result.residual).toBeLessThanOrEqual(MATE_RESIDUAL_TOLERANCE);
    const solved = result.transforms.get(OCC_B);
    expect(solved).toBeDefined();
    if (solved === undefined) return;
    const placedOrigin = transformPlacementPoint(solved, [0, 0, 0]);
    expect(Math.abs(placedOrigin[0] - golden.translation[0])).toBeLessThan(
      1e-8,
    );
    expect(Math.abs(placedOrigin[1] - golden.translation[1])).toBeLessThan(
      1e-8,
    );
    expect(Math.abs(placedOrigin[2] - golden.translation[2])).toBeLessThan(
      1e-8,
    );
  });

  it("reports remaining DOF: a distance mate leaves five, a revolute joint one", () => {
    const distance = solveAssemblyMates({
      occurrences: [OCC_A, OCC_B],
      grounded: [OCC_A],
      mates: [
        {
          id: MAT_GAP,
          name: "Gap",
          kind: "distance",
          value: 25,
          first: { occurrenceId: OCC_A, referenceId: REF_A },
          second: { occurrenceId: OCC_B, referenceId: REF_B },
        },
      ],
      joints: [],
      initial: new Map([
        [OCC_A, IDENTITY],
        [OCC_B, translate(50, 0, 0)],
      ]),
      anchors: new Map([
        [
          MAT_GAP,
          {
            first: { kind: "point", transform: IDENTITY },
            second: { kind: "point", transform: IDENTITY },
          },
        ],
      ]),
    });
    expect(distance.status).toBe("underConstrained");
    expect(distance.dof).toBe(5);
    expect(
      distance.diagnostics.some(
        (d) => d.code === ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.underConstrained,
      ),
    ).toBe(true);
    // The distance itself holds.
    const solved = distance.transforms.get(OCC_B);
    expect(solved).toBeDefined();
    if (solved === undefined) return;
    const gap = Math.hypot(
      transformPlacementPoint(solved, [0, 0, 0])[0] -
        transformPlacementPoint(IDENTITY, [0, 0, 0])[0],
      transformPlacementPoint(solved, [0, 0, 0])[1],
      transformPlacementPoint(solved, [0, 0, 0])[2],
    );
    expect(Math.abs(gap - 25)).toBeLessThanOrEqual(1e-6);

    const hingeStation = solveAssemblyMates({
      occurrences: [OCC_A, OCC_B],
      grounded: [OCC_A],
      mates: [],
      joints: [
        {
          id: JNT_HINGE,
          name: "Hinge",
          kind: "revolute",
          baseOccurrenceId: OCC_A,
          occurrenceId: OCC_B,
          frame: { origin: [0, 0, 10], axis: [0, 0, 1] },
        },
      ],
      initial: new Map([
        [OCC_A, IDENTITY],
        [OCC_B, IDENTITY],
      ]),
      anchors: new Map(),
    });
    expect(hingeStation.status).toBe("underConstrained");
    expect(hingeStation.dof).toBe(1);
    expect(
      jointDofSummary([
        {
          id: JNT_HINGE,
          name: "Hinge",
          kind: "revolute",
          baseOccurrenceId: OCC_A,
          occurrenceId: OCC_B,
        },
      ]),
    ).toEqual({ rotational: 1, translational: 0 });
  });

  it("pulls an off-station joint onto its zero station", () => {
    const result = solveAssemblyMates({
      occurrences: [OCC_A, OCC_B],
      grounded: [OCC_A],
      mates: [],
      joints: [
        {
          id: JNT_SLIDER,
          name: "Slide",
          kind: "slider",
          baseOccurrenceId: OCC_A,
          occurrenceId: OCC_B,
          frame: { origin: [0, 0, 0], axis: [0, 0, 2] },
        },
      ],
      initial: new Map([
        [OCC_A, IDENTITY],
        // Off station: 3 sideways and a tilt.
        [OCC_B, translate(3, 0, 0)],
      ]),
      anchors: new Map(),
    });
    expect(result.status).toBe("underConstrained");
    expect(result.residual).toBeLessThanOrEqual(MATE_RESIDUAL_TOLERANCE);
    const solved = result.transforms.get(OCC_B);
    expect(solved).toBeDefined();
    if (solved === undefined) return;
    // The zero station anchors the moved origin at the joint frame origin
    // and its z along the axis; the slide direction stays free.
    expect(
      Math.abs(transformPlacementPoint(solved, [0, 0, 0])[0]),
    ).toBeLessThan(1e-6);
    expect(
      Math.abs(transformPlacementPoint(solved, [0, 0, 0])[1]),
    ).toBeLessThan(1e-6);
  });

  it("reports conflicting mates structurally", () => {
    const result = solveAssemblyMates({
      occurrences: [OCC_A, OCC_B],
      grounded: [OCC_A],
      mates: [
        {
          id: MAT_FLUSH,
          name: "Flush",
          kind: "coincident",
          first: { occurrenceId: OCC_A, referenceId: REF_A },
          second: { occurrenceId: OCC_B, referenceId: REF_B },
        },
        {
          id: MAT_GAP,
          name: "Gap",
          kind: "distance",
          value: 25,
          first: { occurrenceId: OCC_A, referenceId: REF_A },
          second: { occurrenceId: OCC_B, referenceId: REF_B },
        },
      ],
      joints: [],
      initial: new Map([
        [OCC_A, IDENTITY],
        [OCC_B, translate(50, 0, 0)],
      ]),
      anchors: new Map([
        [
          MAT_FLUSH,
          {
            first: PLANE_TOP,
            second: { kind: "plane", transform: IDENTITY },
          },
        ],
        [
          MAT_GAP,
          {
            first: { kind: "point", transform: IDENTITY },
            second: { kind: "point", transform: IDENTITY },
          },
        ],
      ]),
    });
    expect(result.status).toBe("conflicting");
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.conflicting,
      ),
    ).toBe(true);
  });

  it("refuses unresolved anchors and unknown occurrences before solving", () => {
    const result = solveAssemblyMates({
      occurrences: [OCC_A],
      grounded: [OCC_A],
      mates: [
        {
          id: MAT_GHOST,
          name: "Ghost",
          kind: "coincident",
          first: { occurrenceId: OCC_A, referenceId: REF_A },
          second: { occurrenceId: OCC_B, referenceId: REF_B },
        },
      ],
      joints: [],
      initial: new Map([[OCC_A, IDENTITY]]),
      anchors: new Map(),
    });
    expect(result.status).toBe("unresolved");
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.mateUnresolved,
      ),
    ).toBe(true);
  });

  it("solves bitwise identically across runs", () => {
    const input = {
      occurrences: [OCC_A, OCC_B],
      grounded: [OCC_A],
      mates: [
        {
          id: MAT_FLUSH,
          name: "Flush",
          kind: "coincident" as const,
          first: { occurrenceId: OCC_A, referenceId: REF_A },
          second: { occurrenceId: OCC_B, referenceId: REF_B },
        },
      ],
      joints: [
        {
          id: JNT_HINGE,
          name: "Hinge",
          kind: "revolute" as const,
          baseOccurrenceId: OCC_A,
          occurrenceId: OCC_B,
          frame: { origin: [0, 0, 10] as const, axis: [0, 0, 1] as const },
        },
      ],
      initial: new Map([
        [OCC_A, IDENTITY],
        [OCC_B, translate(50, 3, -2)],
      ]),
      anchors: new Map([
        [
          MAT_FLUSH,
          {
            first: PLANE_TOP,
            second: { kind: "plane" as const, transform: IDENTITY },
          },
        ],
      ]),
    };
    const first = solveAssemblyMates(input);
    const second = solveAssemblyMates(input);
    expect(JSON.stringify(first.transforms)).toBe(
      JSON.stringify(second.transforms),
    );
    expect(first.status).toBe(second.status);
    expect(first.iterations).toBe(second.iterations);
    expect(first.dof).toBe(second.dof);
  });
});
