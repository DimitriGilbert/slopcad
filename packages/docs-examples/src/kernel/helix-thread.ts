/**
 * The `features` guide's helix/thread section's runnable example
 * (docs/guides/features.md, Phase 40): a helix document (a meridian
 * profile resolver + the six spine parameters) and a thread document (a
 * cylinder rod + the ISO specification parameters) regenerated through
 * `createKernelFeatureExecutor` against a caller-supplied kernel, with
 * the settled solids measured through the bridge. The helix lands at the
 * EXACT screw volume `2π·turns·A·d̄` (the fake kernel's analytic model);
 * the thread lands inside the derived containment band
 * `[rod − tool, rod − 0.83·tool]` (the end-sliver argument).
 */

import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  initialRegenerationStates,
  length,
  angle,
  regenerate,
  type BodyId,
  type CadDocument,
  type FeatureId,
  type ParameterId,
} from "@slopcad/cad-core";
import {
  createKernelFeatureExecutor,
  type GeometryKernel,
  helixProfilePolygon,
  helixScrewVolume,
  isoThreadToolLoop,
  type KernelSolid,
} from "@slopcad/cad-kernel";

import { unwrap } from "../core/document";

/** The meridian profile's document sketch id (the profile seam's address). */
const SKETCH = createSketchDocumentId("skd_guide_meridian");

/** The helix example's numbers: radius 10, pitch 4, 3 turns, right-handed. */
export const HELIX_RADIUS_MM = 10;
export const HELIX_PITCH_MM = 4;
export const HELIX_TURNS = 3;

/** The thread example's numbers: an M6×1 external thread, 6 mm long. */
export const THREAD_MAJOR_MM = 6;
export const THREAD_PITCH_MM = 1;
export const THREAD_LENGTH_MM = 6;

/** The meridian rectangle: u ∈ [0, 2], v ∈ [−0.75, 0.75] (mm). */
const MERIDIAN_LOOP = [
  { kind: "line", start: [0, -0.75], end: [2, -0.75] },
  { kind: "line", start: [2, -0.75], end: [2, 0.75] },
  { kind: "line", start: [2, 0.75], end: [0, 0.75] },
  { kind: "line", start: [0, 0.75], end: [0, -0.75] },
] as const;

/** The helix example's exact screw volume: 2π·3·3·11 = 198π mm³. */
export const HELIX_EXACT_VOLUME_MM3 =
  2 * Math.PI * HELIX_TURNS * 3 * (HELIX_RADIUS_MM + 1);

/** The thread example's exact tool volume (the ISO trapezoid's Pappus). */
export const THREAD_TOOL_VOLUME_MM3 = helixScrewVolume(
  helixProfilePolygon(
    isoThreadToolLoop({ pitchMm: THREAD_PITCH_MM, mode: "external" }),
  ),
  {
    radiusMm: THREAD_MAJOR_MM / 2,
    pitchMm: THREAD_PITCH_MM,
    turns: THREAD_LENGTH_MM / THREAD_PITCH_MM,
    handedness: 1,
    startAngleRad: 0,
    taperMm: 0,
  },
);

/** The thread example's unthreaded rod volume: π·3²·6 mm³. */
export const THREAD_ROD_VOLUME_MM3 =
  Math.PI * (THREAD_MAJOR_MM / 2) ** 2 * THREAD_LENGTH_MM;

/** The settled summary the guide states. */
export interface HelixThreadExampleSummary {
  /** The helical spring's measured volume (mm³). */
  readonly helixVolumeMm3: number;
  /** The exact screw volume the measurement is judged against (mm³). */
  readonly helixExactVolumeMm3: number;
  /** The threaded rod's measured volume (mm³). */
  readonly threadVolumeMm3: number;
  /** The rod volume before threading (mm³). */
  readonly threadRodVolumeMm3: number;
  /** The ISO tool's exact screw volume (mm³). */
  readonly threadToolVolumeMm3: number;
}

/** Builds the helix example's document (parameters + feature). */
function buildHelixDocument(): CadDocument {
  const body: BodyId = createBodyId("body_guide_spring");
  const feature: FeatureId = createFeatureId("feat_guide_helix");
  const ids: readonly ParameterId[] = [
    createParameterId("param_guide_helix_radius"),
    createParameterId("param_guide_helix_pitch"),
    createParameterId("param_guide_helix_turns"),
    createParameterId("param_guide_helix_handedness"),
    createParameterId("param_guide_helix_start"),
    createParameterId("param_guide_helix_taper"),
  ];
  let document = createDocument(createDocumentId("doc_guide_helix"));
  document = unwrap(
    addBody(document, { id: body, name: "spring" }),
    "the spring body",
  ).document;
  document = unwrap(
    addDocumentSketch(document, {
      id: SKETCH,
      name: "meridian profile",
      sketch: {
        formatVersion: 1,
        workplane: {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
          xAxis: { x: 1, y: 0, z: 0 },
        },
        entities: [],
        constraints: [],
      },
    }),
    "the meridian sketch",
  ).document;
  const values = [
    length(HELIX_RADIUS_MM),
    length(HELIX_PITCH_MM),
    dimensionless(HELIX_TURNS),
    dimensionless(1),
    angle(0),
    length(0),
  ] as const;
  const names = [
    "helixRadius",
    "helixPitch",
    "helixTurns",
    "helixHandedness",
    "helixStartAngle",
    "helixTaper",
  ] as const;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const value = values[i];
    const name = names[i];
    if (id === undefined || value === undefined || name === undefined) {
      throw new Error("Invariant violation: the helix parameters are dense.");
    }
    document = unwrap(
      addDocumentParameter(document, { id, name, value }),
      `parameter ${name}`,
    ).document;
  }
  return unwrap(
    addFeature(document, {
      id: feature,
      kind: "helix",
      inputs: [
        { kind: "sketch", id: SKETCH },
        ...ids.map((id) => ({ kind: "parameter" as const, id })),
      ],
      outputs: [body],
    }),
    "the helix feature",
  ).document;
}

/** Builds the thread example's document: a cylinder rod + the thread. */
function buildThreadDocument(): CadDocument {
  const body: BodyId = createBodyId("body_guide_threaded");
  const rod: FeatureId = createFeatureId("feat_guide_rod");
  const thread: FeatureId = createFeatureId("feat_guide_thread");
  const ids: readonly ParameterId[] = [
    createParameterId("param_guide_rod_radius"),
    createParameterId("param_guide_rod_height"),
    createParameterId("param_guide_thread_major"),
    createParameterId("param_guide_thread_pitch"),
    createParameterId("param_guide_thread_length"),
    createParameterId("param_guide_thread_mode"),
    createParameterId("param_guide_thread_handedness"),
    createParameterId("param_guide_thread_axis"),
  ];
  let document = createDocument(createDocumentId("doc_guide_thread"));
  document = unwrap(
    addBody(document, { id: body, name: "threaded rod" }),
    "the threaded body",
  ).document;
  const values = [
    length(THREAD_MAJOR_MM / 2),
    length(THREAD_LENGTH_MM),
    length(THREAD_MAJOR_MM),
    length(THREAD_PITCH_MM),
    length(THREAD_LENGTH_MM),
    dimensionless(1),
    dimensionless(1),
    dimensionless(3),
  ] as const;
  const names = [
    "rodRadius",
    "rodHeight",
    "threadMajor",
    "threadPitch",
    "threadLength",
    "threadMode",
    "threadHandedness",
    "threadAxis",
  ] as const;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const value = values[i];
    const name = names[i];
    if (id === undefined || value === undefined || name === undefined) {
      throw new Error("Invariant violation: the thread parameters are dense.");
    }
    document = unwrap(
      addDocumentParameter(document, { id, name, value }),
      `parameter ${name}`,
    ).document;
  }
  const [
    pRodRadius,
    pRodHeight,
    pMajor,
    pPitch,
    pLength,
    pMode,
    pHandedness,
    pAxis,
  ] = ids;
  if (
    pRodRadius === undefined ||
    pRodHeight === undefined ||
    pMajor === undefined ||
    pPitch === undefined ||
    pLength === undefined ||
    pMode === undefined ||
    pHandedness === undefined ||
    pAxis === undefined
  ) {
    throw new Error("Invariant violation: the thread parameters are dense.");
  }
  document = unwrap(
    addFeature(document, {
      id: rod,
      kind: "cylinder",
      inputs: [
        { kind: "parameter", id: pRodRadius },
        { kind: "parameter", id: pRodHeight },
      ],
      outputs: [body],
    }),
    "the rod feature",
  ).document;
  return unwrap(
    addFeature(document, {
      id: thread,
      kind: "thread",
      inputs: [
        { kind: "feature", id: rod },
        { kind: "parameter", id: pMajor },
        { kind: "parameter", id: pPitch },
        { kind: "parameter", id: pLength },
        { kind: "parameter", id: pMode },
        { kind: "parameter", id: pHandedness },
        { kind: "parameter", id: pAxis },
      ],
      outputs: [body],
    }),
    "the thread feature",
  ).document;
}

/**
 * Runs the helix and thread examples against one kernel: the meridian
 * profile resolves through the bridge's profile seam (the loop alone —
 * the helix frame is the spine's, the sketch's workplane never carries),
 * the documents regenerate, and both solids are measured.
 */
export function runHelixThreadExample(
  kernel: GeometryKernel,
  volumeOf: (solid: KernelSolid) => number,
): HelixThreadExampleSummary {
  const helixDocument = buildHelixDocument();
  const helixBridge = createKernelFeatureExecutor(kernel, {
    document: helixDocument,
    bodies: new Map(),
    profiles: (sketchIdQueried) =>
      sketchIdQueried === SKETCH
        ? {
            ok: true,
            value: {
              loop: MERIDIAN_LOOP,
              placement: {
                rotation: { axis: [0, 0, 1], angle: angle(0) },
                translation: { x: length(0), y: length(0), z: length(0) },
              },
            },
          }
        : {
            ok: false,
            error: {
              code: "document/not-found",
              message: `no sketch ${String(sketchIdQueried)}`,
              input: sketchIdQueried,
            },
          },
  });
  const helixRun = regenerate({
    features: helixDocument.features,
    states: initialRegenerationStates(helixDocument.features),
    suppressed: [],
    execute: helixBridge.executor,
  });
  if (!helixRun.ok) throw new Error(helixRun.error.message);
  const spring = helixBridge.solidOf(createBodyId("body_guide_spring"));
  if (spring === undefined) throw new Error("the spring body has no solid");

  const threadDocument = buildThreadDocument();
  const threadBridge = createKernelFeatureExecutor(kernel, {
    document: threadDocument,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "the thread example carries no sketch inputs",
        input: null,
      },
    }),
  });
  const threadRun = regenerate({
    features: threadDocument.features,
    states: initialRegenerationStates(threadDocument.features),
    suppressed: [],
    execute: threadBridge.executor,
  });
  if (!threadRun.ok) throw new Error(threadRun.error.message);
  const threaded = threadBridge.solidOf(createBodyId("body_guide_threaded"));
  if (threaded === undefined) throw new Error("the threaded body has no solid");

  return {
    helixVolumeMm3: volumeOf(spring),
    helixExactVolumeMm3: HELIX_EXACT_VOLUME_MM3,
    threadVolumeMm3: volumeOf(threaded),
    threadRodVolumeMm3: THREAD_ROD_VOLUME_MM3,
    threadToolVolumeMm3: THREAD_TOOL_VOLUME_MM3,
  };
}
