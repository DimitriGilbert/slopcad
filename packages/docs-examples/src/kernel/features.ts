/**
 * The `features` (regeneration half) guide's runnable example
 * (docs/guides/features.md): the document → kernel bridge — a real
 * document (box feature feeding a hole feature, both parameter-driven)
 * regenerated through `createKernelFeatureExecutor` and `regenerate`
 * against a caller-supplied kernel, with the executed solid measured
 * through the bridge. The parameter-edit cascade is the example's second
 * half: one `parameter.set` command, `documentChangeInvalidations` +
 * `markStale`, and the run re-executes exactly the affected features.
 */

import {
  addBody,
  addDocumentParameter,
  addFeature,
  applySessionCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSession,
  dimensionless,
  documentChangeInvalidations,
  initialRegenerationStates,
  length,
  markStale,
  regenerate,
  type BodyId,
  type CadDocument,
  type FeatureId,
  type ParameterId,
  type RegenerationRun,
  type RegenerationStateMap,
} from "@slopcad/cad-core";
import {
  createKernelFeatureExecutor,
  type GeometryKernel,
  type KernelExecutionBridge,
  type KernelSolid,
} from "@slopcad/cad-kernel";

import { unwrap } from "../core/document";

/** The example's ids. */
const B_BOX: BodyId = createBodyId("body_guide_box");
const B_HOLED: BodyId = createBodyId("body_guide_holed");
const F_BOX: FeatureId = createFeatureId("feat_guide_box");
const F_HOLE: FeatureId = createFeatureId("feat_guide_hole");

/** The example's analytic expectations (mm). */
export const BOX = { w: 30, d: 20, h: 10 } as const;
export const BOX_VOLUME_MM3 = BOX.w * BOX.d * BOX.h;
export const HOLE_DIAMETER_MM = 8;
export const HOLE_DEPTH_MM = 4;

/** What the example reports back to the guide and the docs page. */
export interface FeaturesExampleSummary {
  readonly featureKinds: readonly string[];
  readonly firstRunStates: readonly string[];
  readonly volumeAfterHoleMm3: number;
  readonly editedStates: readonly string[];
  readonly volumeAfterEditMm3: number;
  readonly executedFeatureIds: readonly string[];
}

/** Builds the guide's box → hole document. */
export function buildHoleDocument(holeDiameterMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_guide_features"));
  const parameters = [
    ["boxWidth", length(BOX.w)],
    ["boxDepth", length(BOX.d)],
    ["boxHeight", length(BOX.h)],
    ["holeDiameter", length(holeDiameterMm)],
    ["holeDepth", length(HOLE_DEPTH_MM)],
    ["holeX", length(BOX.w / 2)],
    ["holeY", length(BOX.d / 2)],
    ["holeAxis", dimensionless(3)],
  ] as const;
  for (const [index, entry] of parameters.entries()) {
    const [name, value] = entry;
    document = unwrap(
      addDocumentParameter(document, {
        id: createParameterId(`param_guide_${String(index)}`),
        name,
        value,
      }),
      `parameter ${name}`,
    ).document;
  }
  for (const body of [
    { id: B_BOX, name: "box" },
    { id: B_HOLED, name: "holed" },
  ]) {
    document = unwrap(addBody(document, body), `body ${body.name}`).document;
  }
  const byName = (name: string): ParameterId =>
    parameterIdByName(document, name);
  const features = [
    {
      id: F_BOX,
      kind: "box",
      inputs: [
        { kind: "parameter", id: byName("boxWidth") },
        { kind: "parameter", id: byName("boxDepth") },
        { kind: "parameter", id: byName("boxHeight") },
      ],
      outputs: [B_BOX],
    },
    {
      id: F_HOLE,
      kind: "hole",
      inputs: [
        { kind: "feature", id: F_BOX },
        { kind: "parameter", id: byName("holeDiameter") },
        { kind: "parameter", id: byName("holeDepth") },
        { kind: "parameter", id: byName("holeX") },
        { kind: "parameter", id: byName("holeY") },
        { kind: "parameter", id: byName("holeAxis") },
      ],
      outputs: [B_HOLED],
    },
  ] as const;
  for (const feature of features) {
    document = unwrap(
      addFeature(document, feature),
      `feature ${feature.kind}`,
    ).document;
  }
  return document;
}

/** Finds a parameter's id by name, failing loudly when it is absent. */
export function parameterIdByName(
  document: CadDocument,
  name: string,
): ParameterId {
  const found = document.parameters.parameters.find(
    (parameter) => parameter.name === name,
  );
  if (found === undefined) {
    throw new Error(`The document does not define a "${name}" parameter.`);
  }
  return found.id;
}

/** Runs the regeneration example against a caller-supplied kernel. */
export function runFeaturesExample(
  kernel: GeometryKernel,
  volumeOf: (solid: KernelSolid) => number,
): FeaturesExampleSummary {
  const document = buildHoleDocument(HOLE_DIAMETER_MM);
  const kinds = document.features.map((feature) => feature.kind);

  // First run: every feature executes from stale.
  const first = regenerateWith(
    kernel,
    document,
    initialRegenerationStates(document.features),
  );
  const firstStates = statesOf(first.states);
  const holedSolid = first.bridge.solidOf(B_HOLED);
  if (holedSolid === undefined) {
    throw new Error("The hole feature produced no solid for its output body.");
  }
  const volumeAfterHole = volumeOf(holedSolid);

  // One parameter edit (a real session command), the invalidation the
  // engine computes, stale-marking, re-run.
  const edited = unwrap(
    applySessionCommand(createSession(document), {
      type: "parameter.set",
      id: parameterIdByName(document, "holeDiameter"),
      value: length(10),
    }),
    "holeDiameter edit",
  );
  const stale = markStale(
    edited.document.features,
    first.states,
    documentChangeInvalidations(document, edited.document),
  );
  // Incremental regeneration's seam: the prior run's solids ride the
  // second bridge's `bodies` context, so features that stayed current
  // keep their geometry without re-executing.
  const priorSolids = new Map(
    document.bodies.flatMap((body) => {
      const solid = first.bridge.solidOf(body.id);
      return solid === undefined ? [] : [[body.id, solid] as const];
    }),
  );
  const second = regenerateWith(kernel, edited.document, stale, priorSolids);
  const editedSolid = second.bridge.solidOf(B_HOLED);
  if (editedSolid === undefined) {
    throw new Error("The edited hole feature produced no solid.");
  }

  return {
    featureKinds: kinds,
    firstRunStates: firstStates,
    volumeAfterHoleMm3: volumeAfterHole,
    editedStates: statesOf(second.states),
    volumeAfterEditMm3: volumeOf(editedSolid),
    executedFeatureIds: [...second.run.executed],
  };
}

/** Regenerates `document` through a fresh bridge over `kernel`. */
function regenerateWith(
  kernel: GeometryKernel,
  document: CadDocument,
  states: RegenerationStateMap,
  bodies: ReadonlyMap<BodyId, KernelSolid> = new Map(),
): {
  readonly bridge: KernelExecutionBridge;
  readonly states: RegenerationStateMap;
  readonly run: RegenerationRun;
} {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies,
    profiles: () => ({
      ok: false,
      error: {
        code: "sketch/profile-empty",
        message: "the features guide's document carries no sketch features",
        input: null,
      },
    }),
  });
  const run = regenerate({
    features: document.features,
    states,
    suppressed: [],
    execute: bridge.executor,
  });
  if (!run.ok) {
    throw new Error(`Regeneration failed: ${run.error.message}`);
  }
  return { bridge, states: run.value.states, run: run.value };
}

function statesOf(states: RegenerationStateMap): readonly string[] {
  return [...states.values()].map((entry) => entry.state);
}
