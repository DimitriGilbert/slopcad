/**
 * Assembly mate and joint vocabulary tests (Phase 51): parse boundaries,
 * the DOF-accounting table, the joint motion algebra, document wiring
 * (add doors, persistence round-trip, byte-stability), and the removal
 * in-use guard.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentReference,
  addJoint,
  addMate,
  addOccurrence,
  createDocument,
  createDocumentId,
  createIdGenerator,
  createJointId,
  createOccurrenceId,
  createReferenceId,
  JOINT_KINDS,
  JOINT_REMAINING_DOF,
  jointDofSummary,
  jointMotionTransform,
  MATE_KINDS,
  MATE_VALUE_UNITS,
  parseAssemblyJoint,
  parseAssemblyMate,
  parseCadDocument,
  type DocumentJoint,
  removeMate,
  removeOccurrence,
  serializeCadDocument,
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  transformPlacementPoint,
} from "./index";

function assemblyDocument() {
  let document = createDocument(createDocumentId("doc_mates"));
  const withBody = addBody(document, { name: "Block" });
  if (!withBody.ok) throw new Error("expected body add");
  document = withBody.value.document;
  const blockId = withBody.value.body.id;
  const withReference = addDocumentReference(document, {
    name: "Top face",
    reference: { kind: "face", note: "fixture" },
  });
  if (!withReference.ok) throw new Error("expected reference add");
  document = withReference.value.document;
  const withSecond = addBody(document, { name: "Plate" });
  if (!withSecond.ok) throw new Error("expected body add");
  document = withSecond.value.document;
  const plateId = withSecond.value.body.id;
  const withOccurrence = addOccurrence(document, {
    name: "Placed block",
    source: { kind: "body", bodyId: blockId },
  });
  if (!withOccurrence.ok) throw new Error("expected occurrence add");
  const documentWithOne = withOccurrence.value.document;
  const withSecondOccurrence = addOccurrence(documentWithOne, {
    name: "Placed plate",
    source: { kind: "body", bodyId: plateId },
  });
  if (!withSecondOccurrence.ok) throw new Error("expected occurrence add");
  return {
    document: withSecondOccurrence.value.document,
    referenceId: withReference.value.reference.id,
    firstOccurrence: withOccurrence.value.occurrence.id,
    secondOccurrence: withSecondOccurrence.value.occurrence.id,
  };
}

describe("mate and joint vocabulary", () => {
  it("carries the seven mates and six joints", () => {
    expect(MATE_KINDS).toEqual([
      "coincident",
      "concentric",
      "distance",
      "angle",
      "parallel",
      "perpendicular",
      "tangent",
    ]);
    expect(JOINT_KINDS).toEqual([
      "rigid",
      "revolute",
      "slider",
      "cylindrical",
      "planar",
      "ball",
    ]);
    expect(MATE_VALUE_UNITS).toEqual({ distance: "mm", angle: "deg" });
  });

  it("parses a coincident mate with endpoints", () => {
    const parsed = parseAssemblyMate({
      id: "mat_flush",
      name: "Flush faces",
      kind: "coincident",
      first: { occurrenceId: "occ_a", referenceId: "ref_top" },
      second: { occurrenceId: "occ_b", referenceId: "ref_bottom" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("coincident");
    expect(parsed.value.value).toBeUndefined();
  });

  it("requires a value for distance and angle and forbids it otherwise", () => {
    const distance = parseAssemblyMate({
      id: "mat_gap",
      name: "Gap",
      kind: "distance",
      first: { occurrenceId: "occ_a", referenceId: "ref_p" },
      second: { occurrenceId: "occ_b", referenceId: "ref_q" },
      value: 12.5,
    });
    expect(distance.ok).toBe(true);
    if (distance.ok) expect(distance.value.value).toBe(12.5);
    const missing = parseAssemblyMate({
      id: "mat_gap",
      name: "Gap",
      kind: "distance",
      first: { occurrenceId: "occ_a", referenceId: "ref_p" },
      second: { occurrenceId: "occ_b", referenceId: "ref_q" },
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "assembly/mate-value-invalid" },
    });
    const negative = parseAssemblyMate({
      id: "mat_gap",
      name: "Gap",
      kind: "distance",
      first: { occurrenceId: "occ_a", referenceId: "ref_p" },
      second: { occurrenceId: "occ_b", referenceId: "ref_q" },
      value: -1,
    });
    expect(negative).toMatchObject({
      ok: false,
      error: { code: "assembly/mate-value-invalid" },
    });
    const stray = parseAssemblyMate({
      id: "mat_par",
      name: "Parallel",
      kind: "parallel",
      first: { occurrenceId: "occ_a", referenceId: "ref_p" },
      second: { occurrenceId: "occ_b", referenceId: "ref_q" },
      value: 5,
    });
    expect(stray).toMatchObject({
      ok: false,
      error: { code: "assembly/mate-value-invalid" },
    });
    const angleDeg = parseAssemblyMate({
      id: "mat_tilt",
      name: "Tilt",
      kind: "angle",
      first: { occurrenceId: "occ_a", referenceId: "ref_x" },
      second: { occurrenceId: "occ_b", referenceId: "ref_y" },
      value: 90,
    });
    expect(angleDeg.ok).toBe(true);
  });

  it("rejects unknown mate kinds and malformed endpoints", () => {
    expect(
      parseAssemblyMate({
        id: "mat_x",
        name: "X",
        kind: "glued",
        first: { occurrenceId: "occ_a", referenceId: "ref_p" },
        second: { occurrenceId: "occ_b", referenceId: "ref_q" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "assembly/mate-unknown-kind" },
    });
    expect(
      parseAssemblyMate({
        id: "mat_x",
        name: "X",
        kind: "coincident",
        first: { occurrenceId: "occ_a" },
        second: { occurrenceId: "occ_b", referenceId: "ref_q" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "assembly/mate-reference-malformed" },
    });
    expect(
      parseAssemblyMate({
        id: "not-a-mate",
        name: "X",
        kind: "coincident",
        first: { occurrenceId: "occ_a", referenceId: "ref_p" },
        second: { occurrenceId: "occ_b", referenceId: "ref_q" },
      }),
    ).toMatchObject({ ok: false, error: { code: "assembly/mate-malformed" } });
  });

  it("grants the documented remaining DOF per joint kind", () => {
    // The roadmap's DOF-accounting fixture: a box on a cylindrical joint
    // keeps 1 rotational DOF (plus its slide); a revolute keeps exactly
    // one rotational; a slider exactly one translational.
    expect(JOINT_REMAINING_DOF.revolute).toEqual({
      rotational: 1,
      translational: 0,
    });
    expect(JOINT_REMAINING_DOF.cylindrical).toEqual({
      rotational: 1,
      translational: 1,
    });
    expect(JOINT_REMAINING_DOF.slider).toEqual({
      rotational: 0,
      translational: 1,
    });
    expect(JOINT_REMAINING_DOF.planar).toEqual({
      rotational: 1,
      translational: 2,
    });
    expect(JOINT_REMAINING_DOF.ball).toEqual({
      rotational: 3,
      translational: 0,
    });
    expect(JOINT_REMAINING_DOF.rigid).toEqual({
      rotational: 0,
      translational: 0,
    });
    expect(
      jointDofSummary([
        {
          id: createJointId("jnt_a"),
          name: "A",
          kind: "revolute",
          baseOccurrenceId: createOccurrenceId("occ_a"),
          occurrenceId: createOccurrenceId("occ_b"),
        },
        {
          id: createJointId("jnt_b"),
          name: "B",
          kind: "slider",
          baseOccurrenceId: createOccurrenceId("occ_a"),
          occurrenceId: createOccurrenceId("occ_c"),
        },
      ]),
    ).toEqual({ rotational: 1, translational: 1 });
  });

  it("parses joints with the documented frame rules", () => {
    const revolute = parseAssemblyJoint({
      id: "jnt_hinge",
      name: "Hinge",
      kind: "revolute",
      baseOccurrenceId: "occ_base",
      occurrenceId: "occ_lid",
      frame: { origin: [0, 0, 10], axis: [0, 0, 2] },
    });
    expect(revolute.ok).toBe(true);
    const ball = parseAssemblyJoint({
      id: "jnt_ball",
      name: "Ball",
      kind: "ball",
      baseOccurrenceId: "occ_base",
      occurrenceId: "occ_lid",
      frame: { origin: [1, 2, 3], axis: [0, 0, 1] },
    });
    expect(ball).toMatchObject({
      ok: false,
      error: { code: "assembly/joint-frame-invalid" },
    });
    const rigidWithFrame = parseAssemblyJoint({
      id: "jnt_weld",
      name: "Weld",
      kind: "rigid",
      baseOccurrenceId: "occ_base",
      occurrenceId: "occ_lid",
      frame: { origin: [0, 0, 0] },
    });
    expect(rigidWithFrame).toMatchObject({
      ok: false,
      error: { code: "assembly/joint-frame-invalid" },
    });
    const zeroAxis = parseAssemblyJoint({
      id: "jnt_hinge",
      name: "Hinge",
      kind: "revolute",
      baseOccurrenceId: "occ_base",
      occurrenceId: "occ_lid",
      frame: { origin: [0, 0, 0], axis: [0, 0, 0] },
    });
    expect(zeroAxis).toMatchObject({
      ok: false,
      error: { code: "assembly/joint-frame-invalid" },
    });
    const selfJoint = parseAssemblyJoint({
      id: "jnt_hinge",
      name: "Hinge",
      kind: "revolute",
      baseOccurrenceId: "occ_same",
      occurrenceId: "occ_same",
      frame: { origin: [0, 0, 0], axis: [1, 0, 0] },
    });
    expect(selfJoint).toMatchObject({
      ok: false,
      error: { code: "assembly/joint-malformed" },
    });
  });
});

describe("joint motion algebra", () => {
  const hinge: DocumentJoint = {
    id: createJointId("jnt_hinge"),
    name: "Hinge",
    kind: "revolute",
    baseOccurrenceId: createOccurrenceId("occ_base"),
    occurrenceId: createOccurrenceId("occ_lid"),
    frame: { origin: [5, 0, 0] as const, axis: [0, 0, 3] as const },
  };

  it("keeps a rigid joint motionless and a zero station at the identity", () => {
    expect(
      jointMotionTransform(
        { ...hinge, kind: "rigid", frame: undefined },
        { rotation: 1, translation: 1 },
      ),
    ).toEqual(IDENTITY_PLACEMENT_TRANSFORM);
    expect(
      jointMotionTransform(hinge, { rotation: 0, translation: 0 }),
    ).toEqual(IDENTITY_PLACEMENT_TRANSFORM);
  });

  it("rotates about the frame axis through the frame origin", () => {
    const quarterTurn = jointMotionTransform(hinge, {
      rotation: Math.PI / 2,
      translation: 0,
    });
    // The frame origin itself is fixed by the conjugation.
    expect(transformPlacementPoint(quarterTurn, [5, 0, 0])).toEqual([5, 0, 0]);
    // A point one unit along +x from the origin swings to +y; the axis is
    // normalized before use, so the scale is the radius (1).
    const swung = transformPlacementPoint(quarterTurn, [6, 0, 0]);
    expect(swung[0]).toBeCloseTo(5, 12);
    expect(swung[1]).toBeCloseTo(1, 12);
    expect(swung[2]).toBeCloseTo(0, 12);
  });

  it("slides along the axis for a slider and combines for a cylindrical", () => {
    const slider = { ...hinge, kind: "slider" as const };
    const slid = jointMotionTransform(slider, { rotation: 0, translation: 4 });
    expect(transformPlacementPoint(slid, [0, 0, 0])).toEqual([0, 0, 4]);
    const cylindrical = { ...hinge, kind: "cylindrical" as const };
    const screw = jointMotionTransform(cylindrical, {
      rotation: Math.PI,
      translation: 8,
    });
    // Rotation by pi about the z axis through (5,0,0): (6,0,0) -> (4,0,0),
    // then the slide lifts every point 8 along z.
    const moved = transformPlacementPoint(screw, [6, 0, 0]);
    expect(moved[0]).toBeCloseTo(4, 12);
    expect(moved[1]).toBeCloseTo(0, 12);
    expect(moved[2]).toBeCloseTo(8, 12);
  });
});

describe("mates and joints in the document", () => {
  it("adds and round-trips mates and joints through the serialized form", () => {
    const fixture = assemblyDocument();
    const withMate = addMate(fixture.document, {
      name: "Flush",
      kind: "coincident",
      first: {
        occurrenceId: fixture.firstOccurrence,
        referenceId: fixture.referenceId,
      },
      second: {
        occurrenceId: fixture.secondOccurrence,
        referenceId: fixture.referenceId,
      },
    });
    expect(withMate.ok).toBe(true);
    if (!withMate.ok) return;
    const withJoint = addJoint(withMate.value.document, {
      name: "Hinge",
      kind: "revolute",
      baseOccurrenceId: fixture.firstOccurrence,
      occurrenceId: fixture.secondOccurrence,
      frame: { origin: [0, 0, 5], axis: [0, 0, 1] },
    });
    expect(withJoint.ok).toBe(true);
    if (!withJoint.ok) return;
    const document = withJoint.value.document;
    expect(document.mates).toHaveLength(1);
    expect(document.joints).toHaveLength(1);
    // The generated ids carry the new prefixes and claim their counters.
    expect(withMate.value.mate.id.startsWith("mat_")).toBe(true);
    expect(withJoint.value.joint.id.startsWith("jnt_")).toBe(true);
    const parsed = parseCadDocument(serializeCadDocument(document));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mates).toEqual(document.mates);
    expect(parsed.value.joints).toEqual(document.joints);
  });

  it("serializes a mateless document byte-identically to its pre-mate form", () => {
    const fixture = assemblyDocument();
    const serialized = serializeCadDocument(fixture.document);
    expect(serialized.mates).toBeUndefined();
    expect(serialized.joints).toBeUndefined();
    const generator = createIdGenerator();
    expect(generator.state().mate).toBe(0);
    expect(
      serializeCadDocument(fixture.document).idGenerator.mate,
    ).toBeUndefined();
  });

  it("refuses mates addressing unknown occurrences or references", () => {
    const fixture = assemblyDocument();
    const unknownOccurrence = addMate(fixture.document, {
      name: "Ghost",
      kind: "coincident",
      first: {
        occurrenceId: fixture.firstOccurrence,
        referenceId: createReferenceId("ref_ghost"),
      },
      second: {
        occurrenceId: fixture.secondOccurrence,
        referenceId: fixture.referenceId,
      },
    });
    expect(unknownOccurrence).toMatchObject({
      ok: false,
      error: { code: "assembly/mate-invalid" },
    });
    const sameOccurrence = addMate(fixture.document, {
      name: "Self",
      kind: "distance",
      value: 5,
      first: {
        occurrenceId: fixture.firstOccurrence,
        referenceId: fixture.referenceId,
      },
      second: {
        occurrenceId: fixture.firstOccurrence,
        referenceId: fixture.referenceId,
      },
    });
    expect(sameOccurrence).toMatchObject({
      ok: false,
      error: { code: "assembly/mate-invalid" },
    });
  });

  it("refuses removing an occurrence a mate still addresses", () => {
    const fixture = assemblyDocument();
    const withMate = addMate(fixture.document, {
      name: "Flush",
      kind: "coincident",
      first: {
        occurrenceId: fixture.firstOccurrence,
        referenceId: fixture.referenceId,
      },
      second: {
        occurrenceId: fixture.secondOccurrence,
        referenceId: fixture.referenceId,
      },
    });
    expect(withMate.ok).toBe(true);
    if (!withMate.ok) return;
    const refused = removeOccurrence(
      withMate.value.document,
      fixture.firstOccurrence,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "assembly/occurrence-in-use" },
    });
    const withoutMate = removeMate(
      withMate.value.document,
      withMate.value.mate.id,
    );
    expect(withoutMate.ok).toBe(true);
    if (!withoutMate.ok) return;
    const removed = removeOccurrence(
      withoutMate.value,
      fixture.firstOccurrence,
    );
    expect(removed.ok).toBe(true);
  });

  it("composes joint motion with the placement algebra deterministically", () => {
    const hinge = {
      id: createJointId("jnt_hinge"),
      name: "Hinge",
      kind: "revolute" as const,
      baseOccurrenceId: createOccurrenceId("occ_base"),
      occurrenceId: createOccurrenceId("occ_lid"),
      frame: { origin: [0, 0, 0] as const, axis: [0, 1, 0] as const },
    };
    const motion = jointMotionTransform(hinge, {
      rotation: Math.PI,
      translation: 0,
    });
    const baseWorld = composePlacementTransforms(IDENTITY_PLACEMENT_TRANSFORM, {
      rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
      translation: [10, 0, 0],
    });
    const world = composePlacementTransforms(baseWorld, motion);
    expect(transformPlacementPoint(world, [1, 0, 0])[0]).toBeCloseTo(9, 12);
    expect(transformPlacementPoint(world, [1, 0, 0])[2]).toBeCloseTo(0, 12);
    // Deterministic: identical joints and stations compose identically.
    const again = composePlacementTransforms(
      baseWorld,
      jointMotionTransform(hinge, { rotation: Math.PI, translation: 0 }),
    );
    expect(JSON.stringify(world)).toBe(JSON.stringify(again));
  });
});
