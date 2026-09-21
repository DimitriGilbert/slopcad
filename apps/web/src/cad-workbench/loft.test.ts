/**
 * The workbench loft wiring tests (Phase 38): the document reader that
 * turns the FIRST loft feature (ordered section sketches + station-z length
 * parameters, matched by declared position) into its worker-scene request,
 * and the action-time validation battery's structured refusals (fewer than
 * two sections, a section off the first section's workplane frame,
 * non-increasing stations).
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  length,
  type CadDocument,
  type FeatureRecordInput,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
  type Sketch,
} from "@slopcad/cad-sketch";

import { sketchProfileResolverOf } from "./extrude";
import { documentLoftRequest, validateLoftSubmission } from "./loft";

function squareSketch(half: number): Sketch {
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(
        createSketchEntityId(`skent_${half}-a`),
        { x: -half, y: -half },
        { x: half, y: -half },
      ),
      createLineEntity(
        createSketchEntityId(`skent_${half}-b`),
        { x: half, y: -half },
        { x: half, y: half },
      ),
      createLineEntity(
        createSketchEntityId(`skent_${half}-c`),
        { x: half, y: half },
        { x: -half, y: half },
      ),
      createLineEntity(
        createSketchEntityId(`skent_${half}-d`),
        { x: -half, y: half },
        { x: -half, y: -half },
      ),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

/** A sketch payload on a workplane LIFTED to model z (a different frame). */
function liftedSketchPayload(z: number): Record<string, unknown> {
  return {
    formatVersion: 1,
    workplane: {
      origin: { x: 0, y: 0, z },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
    },
    entities: [],
    constraints: [],
  };
}

interface SectionSpec {
  readonly id: string;
  readonly half: number;
  readonly stationMm: number;
  readonly lifted?: number;
}

function loftDocument(sections: readonly SectionSpec[]): CadDocument {
  let document = createDocument(createDocumentId("doc_workbench_loft"));
  for (const section of sections) {
    const added = addDocumentSketch(document, {
      id: createSketchDocumentId(section.id),
      name: section.id,
      sketch: (section.lifted === undefined
        ? serializeSketch(squareSketch(section.half))
        : liftedSketchPayload(section.lifted)) as unknown as Record<
        string,
        unknown
      >,
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    const parameter = addDocumentParameter(document, {
      id: createParameterId(`param_${section.id}`),
      name: `loftZ_${section.id}`,
      value: length(section.stationMm),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const body = addBody(document, {
    id: createBodyId("body_loft"),
    name: "loft",
  });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const inputs: FeatureRecordInput["inputs"] = sections.flatMap((section) => [
    { kind: "sketch" as const, id: createSketchDocumentId(section.id) },
    {
      kind: "parameter" as const,
      id: createParameterId(`param_${section.id}`),
    },
  ]);
  const featured = addFeature(document, {
    id: createFeatureId("feat_loft"),
    kind: "loft",
    inputs,
    outputs: [createBodyId("body_loft")],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

describe("documentLoftRequest: the scene reader", () => {
  it("reads ordered sections and their station parameters", () => {
    const document = loftDocument([
      { id: "skd_s1", half: 10, stationMm: 0 },
      { id: "skd_s2", half: 5, stationMm: 20 },
    ]);
    const request = documentLoftRequest(document);
    expect(request).not.toBeNull();
    expect(request?.bodyId).toBe("body_loft");
    expect(request?.sections).toHaveLength(2);
    expect(request?.sections[0]?.loop).toHaveLength(4);
    expect(request?.sections[0]?.zMm).toBe(0);
    expect(request?.sections[1]?.zMm).toBe(20);
    // Tapered sections keep the SAME frame: the first section's placement.
    expect(request?.placement).toEqual(
      sketchProfileResolverOf(document)(createSketchDocumentId("skd_s1")).ok ===
        true
        ? (
            sketchProfileResolverOf(document)(
              createSketchDocumentId("skd_s1"),
            ) as { ok: true; value: { placement: unknown } }
          ).value.placement
        : null,
    );
  });

  it("returns null when a station parameter no longer resolves", () => {
    const document = loftDocument([
      { id: "skd_s1", half: 10, stationMm: 0 },
      { id: "skd_s2", half: 5, stationMm: 20 },
    ]);
    const broken: CadDocument = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === "feat_loft"
          ? {
              ...feature,
              inputs: [
                ...feature.inputs.slice(0, 2),
                { kind: "parameter", id: createParameterId("param_missing") },
              ] as unknown as FeatureRecordInput["inputs"],
            }
          : feature,
      ),
    };
    expect(documentLoftRequest(broken)).toBeNull();
  });

  it("returns null for a document without a loft feature", () => {
    expect(
      documentLoftRequest(createDocument(createDocumentId("doc_empty"))),
    ).toBeNull();
  });
});

describe("validateLoftSubmission: the action-time battery", () => {
  const squarePlacement = {
    rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
    translation: { x: length(0), y: length(0), z: length(0) },
  };
  const liftedPlacement = {
    rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
    translation: { x: length(0), y: length(0), z: length(12) },
  };
  const tiltedPlacement = {
    rotation: { axis: [1, 0, 0] as const, angle: angle(Math.PI / 2) },
    translation: { x: length(0), y: length(0), z: length(0) },
  };
  const choice = (sketchId: string, stationMm: number) => ({
    choice: { sketchId, stationMm },
    placement: squarePlacement,
  });

  it("accepts two increasing stations on one frame", () => {
    const validation = validateLoftSubmission({
      sections: [choice("skd_s1", 0), choice("skd_s2", 20)],
    });
    expect(validation).toEqual({ ok: true });
  });

  it("refuses fewer than two sections", () => {
    const validation = validateLoftSubmission({
      sections: [choice("skd_s1", 0)],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/invalid-operands");
  });

  it("refuses a section on a different frame (lifted workplane)", () => {
    const validation = validateLoftSubmission({
      sections: [
        choice("skd_s1", 0),
        {
          choice: { sketchId: "skd_s2", stationMm: 20 },
          placement: liftedPlacement,
        },
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/feature-input-invalid");
    expect(validation.message).toContain("different workplane frame");
  });

  it("refuses a section on a tilted frame", () => {
    const validation = validateLoftSubmission({
      sections: [
        choice("skd_s1", 0),
        {
          choice: { sketchId: "skd_s2", stationMm: 20 },
          placement: tiltedPlacement,
        },
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/feature-input-invalid");
  });

  it("refuses non-increasing stations with the kernel's code", () => {
    const validation = validateLoftSubmission({
      sections: [choice("skd_s1", 20), choice("skd_s2", 20)],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/loft-unordered-stations");
    expect(validation.message).toContain("strictly increase");
  });

  it("judges the whole list: a third section below the second refuses", () => {
    const validation = validateLoftSubmission({
      sections: [
        choice("skd_s1", 0),
        choice("skd_s2", 20),
        choice("skd_s3", 10),
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/loft-unordered-stations");
  });
});
