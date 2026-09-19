/**
 * The honest scene fallback tests: the pure re-point decision the shared
 * workbench layout runs on every document change — when the active scene's
 * request reader stops resolving over the reverted document (an undo
 * removed the anchored solid feature), the dispatch falls back to the
 * highest scene the document still resolves (hole over revolve over
 * extrude, then the plate) instead of freezing on stale pixels with a
 * wrong `data-scene-kind`. The fixtures build documents exactly as the
 * pages' create actions commit them, so every case names the feature set
 * and its expected active scene.
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
  dimensionless,
  length,
  type AnyDimensionalValue,
  type CadDocument,
  type FeatureInputRef,
  type FeatureRecord,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createRectangleEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

import { highestResolvableScene, honestSceneFallback } from "./scene-fallback";
import { filletBaseFeatureOf } from "./chain";
import { holeBaseFeatureOf } from "./hole";
import { REVOLVE_AXIS_X_RAD } from "./revolve";

const DOC = createDocumentId("doc_scene_fallback");

/** One stage of the solid fixture: the page action that commits it. */
type SolidStage = "extrude" | "hole" | "fillet" | "revolve";

/** A 20×15 rectangle on the XY workplane (the extrude profile). */
function extrudeSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_f-bottom");
  const right = createSketchEntityId("skent_f-right");
  const top = createSketchEntityId("skent_f-top");
  const left = createSketchEntityId("skent_f-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
      createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
      createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
      createRectangleEntity(createSketchEntityId("skent_f-rect"), [
        bottom,
        right,
        top,
        left,
      ]),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/**
 * A 30×25 rectangle touching the workplane origin along its bottom edge —
 * revolving about the X axis yields the exact cylinder without crossing.
 */
function revolveSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_rv-bottom");
  const right = createSketchEntityId("skent_rv-right");
  const top = createSketchEntityId("skent_rv-top");
  const left = createSketchEntityId("skent_rv-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 0, y: 0 }, { x: 30, y: 0 }),
      createLineEntity(right, { x: 30, y: 0 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 0, y: 25 }),
      createLineEntity(left, { x: 0, y: 25 }, { x: 0, y: 0 }),
      createRectangleEntity(createSketchEntityId("skent_rv-rect"), [
        bottom,
        right,
        top,
        left,
      ]),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** The parameter list form the stage builder commits. */
type StageParameters = readonly (readonly [
  ReturnType<typeof createParameterId>,
  string,
  AnyDimensionalValue,
])[];

/**
 * Builds a document whose features are exactly the given stages in order —
 * each stage commits what the corresponding page action commits (the
 * extrude and revolve bridges' sketch + parameters + body + feature, the
 * hole action's five parameters + body + feature targeting the last
 * extrude, the fillet action's radius + ordinal + body + feature targeting
 * the newest solid stage).
 */
function buildSolidDocument(...stages: readonly SolidStage[]): CadDocument {
  let document = createDocument(DOC);
  let extrudeCount = 0;
  let holeCount = 0;
  let filletCount = 0;
  let revolveCount = 0;
  for (const stage of stages) {
    const index =
      stage === "extrude"
        ? (extrudeCount += 1)
        : stage === "hole"
          ? (holeCount += 1)
          : stage === "fillet"
            ? (filletCount += 1)
            : (revolveCount += 1);
    const suffix =
      stage === "hole" || stage === "fillet"
        ? String(index)
        : index === 1
          ? ""
          : String(index);
    const parameters: StageParameters =
      stage === "extrude"
        ? [
            [
              createParameterId(`param_extrude_depth${suffix}`),
              `extrudeDepth${suffix}`,
              length(10),
            ],
          ]
        : stage === "hole"
          ? [
              [
                createParameterId(`param_hole_diameter${suffix}`),
                `holeDiameter${suffix}`,
                length(8),
              ],
              [
                createParameterId(`param_hole_depth${suffix}`),
                `holeDepth${suffix}`,
                length(4),
              ],
              [
                createParameterId(`param_hole_x${suffix}`),
                `holeX${suffix}`,
                length(20),
              ],
              [
                createParameterId(`param_hole_y${suffix}`),
                `holeY${suffix}`,
                length(17.5),
              ],
              [
                createParameterId(`param_hole_axis${suffix}`),
                `holeAxis${suffix}`,
                dimensionless(3),
              ],
            ]
          : stage === "fillet"
            ? [
                [
                  createParameterId(`param_fillet_radius${suffix}`),
                  `filletRadius${suffix}`,
                  length(3),
                ],
                [
                  createParameterId(`param_fillet_edge${suffix}`),
                  `filletEdge${suffix}`,
                  dimensionless(2),
                ],
              ]
            : [
                [
                  createParameterId(`param_revolve_sweep${suffix}`),
                  `revolveSweep${suffix}`,
                  angle(Math.PI * 2, "rad"),
                ],
                [
                  createParameterId(`param_revolve_axis${suffix}`),
                  `revolveAxis${suffix}`,
                  angle(REVOLVE_AXIS_X_RAD, "rad"),
                ],
              ];
    for (const [id, name, value] of parameters) {
      const parameter = addDocumentParameter(document, { id, name, value });
      if (!parameter.ok) throw new Error(parameter.error.message);
      document = parameter.value.document;
    }
    const sketchId = createSketchDocumentId(`skd_${stage}${suffix}`);
    if (stage === "extrude" || stage === "revolve") {
      const sketched = addDocumentSketch(document, {
        id: sketchId,
        name: `${stage} profile${suffix}`,
        sketch:
          stage === "extrude" ? extrudeSketchPayload() : revolveSketchPayload(),
      });
      if (!sketched.ok) throw new Error(sketched.error.message);
      document = sketched.value.document;
    }
    const bodyId = createBodyId(`body_${stage}${suffix}`);
    const body = addBody(document, {
      id: bodyId,
      name: `stage ${stage}${suffix}`,
    });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const inputs: readonly FeatureInputRef[] =
      stage === "hole" || stage === "fillet"
        ? [
            { kind: "feature", id: solidTargetOf(document, stage).id },
            ...parameters.map(([id]) => ({ kind: "parameter" as const, id })),
          ]
        : [
            { kind: "sketch", id: sketchId },
            ...parameters.map(([id]) => ({ kind: "parameter" as const, id })),
          ];
    const featured = addFeature(document, {
      id: createFeatureId(`feat_${stage}${suffix}`),
      kind: stage,
      inputs,
      outputs: [bodyId],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
  }
  return document;
}

/**
 * The solid stage feature the hole and fillet stages target — the hole
 * action's base (the last extrude) and the fillet action's newest stage
 * (the last hole when holes exist, else the last extrude).
 */
function solidTargetOf(
  document: CadDocument,
  stage: "hole" | "fillet",
): FeatureRecord {
  const target =
    stage === "hole"
      ? holeBaseFeatureOf(document)
      : filletBaseFeatureOf(document);
  if (target === undefined) {
    throw new Error(`The ${stage} stage found no solid target.`);
  }
  return target;
}

describe("highestResolvableScene", () => {
  it("prefers the hole composition when every hole still cuts its base", () => {
    expect(highestResolvableScene(buildSolidDocument("extrude", "hole"))).toBe(
      "hole",
    );
    expect(
      highestResolvableScene(buildSolidDocument("extrude", "hole", "fillet")),
    ).toBe("hole");
  });

  it("falls to the revolve when no hole scene resolves", () => {
    expect(highestResolvableScene(buildSolidDocument("revolve"))).toBe(
      "revolve",
    );
    // The precedence over the shallower scene: a document whose extrude
    // still resolves but whose holes are gone falls to the revolve, not
    // the extrude.
    expect(
      highestResolvableScene(buildSolidDocument("extrude", "revolve")),
    ).toBe("revolve");
  });

  it("falls to the extrude when only the extrusion remains", () => {
    expect(highestResolvableScene(buildSolidDocument("extrude"))).toBe(
      "extrude",
    );
  });

  it("lands on the plate when no solid feature resolves", () => {
    expect(highestResolvableScene(createDocument(DOC))).toBe("plate");
  });
});

describe("honestSceneFallback", () => {
  it("never falls back while the active scene still resolves", () => {
    const holed = buildSolidDocument("extrude", "hole");
    expect(honestSceneFallback(holed, "hole")).toBeNull();
    expect(
      honestSceneFallback(buildSolidDocument("extrude"), "extrude"),
    ).toBeNull();
    expect(
      honestSceneFallback(buildSolidDocument("revolve"), "revolve"),
    ).toBeNull();
  });

  it("never falls back from the plate scene (it always resolves)", () => {
    expect(honestSceneFallback(createDocument(DOC), "plate")).toBeNull();
    expect(
      honestSceneFallback(buildSolidDocument("extrude", "hole"), "plate"),
    ).toBeNull();
  });

  it("re-points the hole scene at the extrude after the hole is undone", () => {
    // The undo reverted the hole transaction: the extrusion remains.
    expect(honestSceneFallback(buildSolidDocument("extrude"), "hole")).toBe(
      "extrude",
    );
  });

  it("re-points the hole scene at the plate after everything is undone", () => {
    expect(honestSceneFallback(createDocument(DOC), "hole")).toBe("plate");
  });

  it("re-points a dead hole scene at the deepest survivor (revolve over extrude)", () => {
    expect(
      honestSceneFallback(buildSolidDocument("extrude", "revolve"), "hole"),
    ).toBe("revolve");
  });

  it("re-points the revolve scene at the extrude after the revolve is undone", () => {
    expect(honestSceneFallback(buildSolidDocument("extrude"), "revolve")).toBe(
      "extrude",
    );
  });

  it("re-points the extrude scene at the plate after the extrude is undone", () => {
    expect(honestSceneFallback(createDocument(DOC), "extrude")).toBe("plate");
  });
});
