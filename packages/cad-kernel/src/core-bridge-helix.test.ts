/**
 * The helix and thread features' bridge tests (Phase 40): the sketch +
 * parameter vocabulary → the bridge's `helix` kind → the fake kernel →
 * the exact screw volume; the datum-axis form (Phase 39 reuse); the
 * capability gate; the failure taxonomy (layout, unresolvable profile,
 * parameter domains, handedness/mode domains); the thread composition's
 * derived cut band and its no-op post-condition; and the cosmetic mode's
 * kernel-independent passthrough.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createDatumId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  type FeatureRecord,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";
import type { GeometryKernel, ProfileExtrudeInput } from "./contract";

import {
  createKernelFeatureExecutor,
  type KernelProfileResolver,
} from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";
import { helixProfilePolygon, helixScrewVolume } from "./helix-geometry";
import { isoThreadToolLoop } from "./thread-profile";
import { assertVolumeClose, unwrapKernelResult } from "./test-utils";

const bSpring = createBodyId("body_spring");
const fHelix = createFeatureId("feat_helix");
const skProfile = createSketchDocumentId("skd_helix_profile");
const pRadius = createParameterId("param_helix_radius");
const pPitch = createParameterId("param_helix_pitch");
const pTurns = createParameterId("param_helix_turns");
const pHand = createParameterId("param_helix_handedness");
const pStart = createParameterId("param_helix_start");
const pTaper = createParameterId("param_helix_taper");

const bThreaded = createBodyId("body_threaded");
const fCylinder = createFeatureId("feat_thread_rod");
const fThread = createFeatureId("feat_thread");
const pCylRadius = createParameterId("param_thread_rod_radius");
const pCylHeight = createParameterId("param_thread_rod_height");
const pMajor = createParameterId("param_thread_major");
const pThreadPitch = createParameterId("param_thread_pitch");
const pThreadLength = createParameterId("param_thread_length");
const pThreadMode = createParameterId("param_thread_mode");
const pThreadHand = createParameterId("param_thread_handedness");
const pThreadAxis = createParameterId("param_thread_axis");

/** The meridian rectangle: u ∈ [0, 2], v ∈ [−0.75, 0.75]. */
const MERIDIAN_LOOP: ProfileExtrudeInput["loop"] = [
  { kind: "line", start: [0, -0.75], end: [2, -0.75] },
  { kind: "line", start: [2, -0.75], end: [2, 0.75] },
  { kind: "line", start: [2, 0.75], end: [0, 0.75] },
  { kind: "line", start: [0, 0.75], end: [0, -0.75] },
];

const XY_PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

const SKETCH_PAYLOAD = {
  formatVersion: 1,
  workplane: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
  },
  entities: [],
  constraints: [],
};

const profileResolver: KernelProfileResolver = (sketchId) => {
  if (sketchId !== skProfile) {
    return {
      ok: false,
      error: {
        code: "document/not-found",
        message: `no sketch ${String(sketchId)}`,
        input: sketchId,
      },
    };
  }
  return { ok: true, value: { loop: MERIDIAN_LOOP, placement: XY_PLACEMENT } };
};

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

/** The helix document: one sketch, six parameters, the feature. */
function buildHelixDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_helix"));
  document = requireOk(
    addDocumentSketch(document, {
      id: skProfile,
      name: "helix meridian profile",
      sketch: SKETCH_PAYLOAD,
    }),
    "the profile sketch",
  ).document;
  document = requireOk(
    addBody(document, { id: bSpring, name: "spring" }),
    "the spring body",
  ).document;
  const parameters: [
    ReturnType<typeof createParameterId>,
    string,
    (
      | ReturnType<typeof length>
      | ReturnType<typeof angle>
      | ReturnType<typeof dimensionless>
    ),
  ][] = [
    [pRadius, "helixRadius", length(10)],
    [pPitch, "helixPitch", length(4)],
    [pTurns, "helixTurns", dimensionless(3)],
    [pHand, "helixHandedness", dimensionless(1)],
    [pStart, "helixStartAngle", angle(0)],
    [pTaper, "helixTaper", length(0)],
  ];
  for (const [id, name, value] of parameters) {
    document = requireOk(
      addDocumentParameter(document, { id, name, value }),
      `parameter ${name}`,
    ).document;
  }
  const feature: FeatureRecordInput = {
    id: fHelix,
    kind: "helix",
    inputs: [
      { kind: "sketch", id: skProfile },
      { kind: "parameter", id: pRadius },
      { kind: "parameter", id: pPitch },
      { kind: "parameter", id: pTurns },
      { kind: "parameter", id: pHand },
      { kind: "parameter", id: pStart },
      { kind: "parameter", id: pTaper },
    ],
    outputs: [bSpring],
  };
  return requireOk(addFeature(document, feature), "the helix feature").document;
}

function runDocument(
  document: CadDocument,
  kernel: GeometryKernel = createFakeKernel(),
) {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: profileResolver,
  });
  const run = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  if (!run.ok) throw new Error(run.error.message);
  return { kernel, bridge, run: run.value };
}

/** The first failure message of a feature's regeneration state. */
function firstDiagnostic(
  run: {
    readonly states: ReadonlyMap<
      string,
      {
        readonly state?: string;
        readonly diagnostics?: readonly { readonly message: string }[];
      }
    >;
  },
  id: string,
): string | undefined {
  const status = run.states.get(id);
  return status?.state === "failed"
    ? status.diagnostics?.[0]?.message
    : undefined;
}

describe("bridge helix: meridian sketch + spine parameters → screw solid", () => {
  it("executes the helix at the exact screw volume on the fake kernel", () => {
    const { kernel, bridge, run } = runDocument(buildHelixDocument());
    expect(run.executed).toEqual([fHelix]);
    const solid = bridge.solidOf(bSpring);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // The meridian rectangle: A = 3, d̄ = 11: V = 198π exactly.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "spring volume"),
      2 * Math.PI * 3 * 3 * 11,
      1e-9,
    );
    // The world-z default frame: bounds [−12, 12]² × [−0.75, 12.75].
    expect(
      unwrapKernelResult(kernel.bounds(solid), "spring bounds").max[2],
    ).toBeCloseTo(12.75, 9);
  });

  it("declines on a kernel without the helix capability, before resolution", () => {
    const kernel = createFakeKernel();
    const declined: GeometryKernel = {
      ...kernel,
      capabilities: { ...kernel.capabilities, helix: false },
    };
    const { run } = runDocument(buildHelixDocument(), declined);
    expect(run.states.get(fHelix)?.state).toBe("failed");
    expect(firstDiagnostic(run, fHelix)).toContain(
      "does not declare the helix capability",
    );
  });

  it("declines malformed layouts and parameter domains with structured codes", () => {
    const base = buildHelixDocument();
    const layout = runDocument({
      ...base,
      features: base.features.map((feature) =>
        feature.id === fHelix
          ? {
              ...feature,
              inputs: [
                { kind: "sketch", id: skProfile },
                { kind: "parameter", id: pRadius },
              ],
            }
          : feature,
      ),
    });
    expect(layout.run.states.get(fHelix)?.state).toBe("failed");
    expect(firstDiagnostic(layout.run, fHelix)).toContain(
      "six parameter inputs",
    );

    // Handedness outside ±1 refuses before the kernel.
    const handed = {
      ...base,
      parameters: {
        parameters: base.parameters.parameters.map((parameter) =>
          parameter.id === pHand
            ? { ...parameter, value: dimensionless(2) }
            : parameter,
        ),
      },
    } satisfies CadDocument;
    const handRun = runDocument(handed);
    expect(handRun.run.states.get(fHelix)?.state).toBe("failed");
    expect(firstDiagnostic(handRun.run, fHelix)).toContain("handedness");
  });

  it("resolves the datum axis form through the Phase 39 seam", () => {
    const datumId = createDatumId("dtm_helix_axis");
    let document = buildHelixDocument();
    document = requireOk(
      addDocumentDatum(document, {
        id: datumId,
        name: "helix axis",
        datum: {
          formatVersion: 1,
          datumType: "axis",
          definition: "twoPoints",
          first: [0, 0, 5],
          second: [0, 0, 6],
        },
      }),
      "the datum axis",
    ).document;
    const datumFeature: FeatureRecord = {
      id: fHelix,
      kind: "helix",
      inputs: [
        { kind: "sketch", id: skProfile },
        { kind: "parameter", id: pRadius },
        { kind: "parameter", id: pPitch },
        { kind: "parameter", id: pTurns },
        { kind: "parameter", id: pHand },
        { kind: "parameter", id: pStart },
        { kind: "parameter", id: pTaper },
        { kind: "datum", id: datumId },
      ],
      outputs: [bSpring],
    };
    const withDatum: CadDocument = {
      ...document,
      features: document.features.map((feature): FeatureRecord =>
        feature.id === fHelix ? datumFeature : feature,
      ),
    };
    const { kernel, bridge, run } = runDocument(withDatum);
    expect(run.executed).toContain(fHelix);
    const solid = bridge.solidOf(bSpring);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Same volume (the frame moves the solid, never resizes it) — and the
    // axis through (0,0,5) along +z lifts the base by exactly 5.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "datum-framed volume"),
      2 * Math.PI * 3 * 3 * 11,
      1e-9,
    );
    expect(
      unwrapKernelResult(kernel.bounds(solid), "datum-framed bounds").min[2],
    ).toBeCloseTo(4.25, 9);
  });
});

describe("bridge thread: ISO tool composition on a rod target", () => {
  /** The ⌀6 × 6 rod + M6×1 × 6 external thread document. */
  function buildThreadDocument(
    overrides: {
      readonly mode?: number;
      readonly majorMm?: number;
      readonly pitchMm?: number;
      readonly lengthMm?: number;
      readonly handedness?: number;
    } = {},
  ): CadDocument {
    let document = createDocument(createDocumentId("doc_bridge_thread"));
    document = requireOk(
      addBody(document, { id: bThreaded, name: "threaded rod" }),
      "the threaded body",
    ).document;
    const parameters: [
      ReturnType<typeof createParameterId>,
      string,
      ReturnType<typeof length> | ReturnType<typeof dimensionless>,
    ][] = [
      [pCylRadius, "rodRadius", length(3)],
      [pCylHeight, "rodHeight", length(6)],
      [pMajor, "threadMajor", length(overrides.majorMm ?? 6)],
      [pThreadPitch, "threadPitch", length(overrides.pitchMm ?? 1)],
      [pThreadLength, "threadLength", length(overrides.lengthMm ?? 6)],
      [pThreadMode, "threadMode", dimensionless(overrides.mode ?? 1)],
      [
        pThreadHand,
        "threadHandedness",
        dimensionless(overrides.handedness ?? 1),
      ],
      [pThreadAxis, "threadAxis", dimensionless(3)],
    ];
    for (const [id, name, value] of parameters) {
      document = requireOk(
        addDocumentParameter(document, { id, name, value }),
        `parameter ${name}`,
      ).document;
    }
    const rod: FeatureRecordInput = {
      id: fCylinder,
      kind: "cylinder",
      inputs: [
        { kind: "parameter", id: pCylRadius },
        { kind: "parameter", id: pCylHeight },
      ],
      outputs: [bThreaded],
    };
    document = requireOk(addFeature(document, rod), "the rod feature").document;
    const thread: FeatureRecordInput = {
      id: fThread,
      kind: "thread",
      inputs: [
        { kind: "feature", id: fCylinder },
        { kind: "parameter", id: pMajor },
        { kind: "parameter", id: pThreadPitch },
        { kind: "parameter", id: pThreadLength },
        { kind: "parameter", id: pThreadMode },
        { kind: "parameter", id: pThreadHand },
        { kind: "parameter", id: pThreadAxis },
      ],
      outputs: [bThreaded],
    };
    return requireOk(addFeature(document, thread), "the thread feature")
      .document;
  }

  it("cuts the M6 grooves inside the derived containment band", () => {
    const { kernel, bridge, run } = runDocument(buildThreadDocument());
    expect(run.executed).toEqual([fCylinder, fThread]);
    const solid = bridge.solidOf(bThreaded);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = unwrapKernelResult(kernel.volume(solid), "threaded volume");
    const rodVolume = Math.PI * 9 * 6;
    // The derived anchors: the tool's exact screw volume from the shared
    // analytic model (45√3/256 mm² at centroid radius ≈ 2.78, 6 turns),
    // with the containment band [rod − tool, rod − 0.83·tool] (the end
    // slivers at most (7/8)/turns of the tool) — widened by the fake
    // kernel's documented voxel band on the boolean.
    const loop = isoThreadToolLoop({ pitchMm: 1, mode: "external" });
    const toolVolume = helixScrewVolume(helixProfilePolygon(loop), {
      radiusMm: 3,
      pitchMm: 1,
      turns: 6,
      handedness: 1,
      startAngleRad: 0,
      taperMm: 0,
    });
    expect(volume).toBeLessThan(rodVolume);
    expect(volume).toBeGreaterThan(rodVolume - toolVolume * 1.2);
    expect(volume).toBeLessThan(rodVolume - toolVolume * 0.5);
  });

  it("passes the target through unchanged for the cosmetic mode on any kernel", () => {
    const kernel = createFakeKernel();
    const declined: GeometryKernel = {
      ...kernel,
      capabilities: { ...kernel.capabilities, helix: false },
    };
    const { bridge, run } = runDocument(
      buildThreadDocument({ mode: 3 }),
      declined,
    );
    expect(run.executed).toEqual([fCylinder, fThread]);
    // The teeth: on a helix-DECLINING kernel the cosmetic mode must still
    // settle VALID — the annotation passes through before the capability
    // gate, so the thread feature's own state (not just the unchanged
    // body volume, which the rod already satisfies) proves the passthrough.
    expect(run.states.get(fThread)?.state).toBe("valid");
    const solid = bridge.solidOf(bThreaded);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(declined.volume(solid), "cosmetic volume"),
      Math.PI * 9 * 6,
      1e-9,
    );
  });

  it("keeps the cosmetic mode geometry-free on a capable kernel too", () => {
    // A capable kernel (the fake kernel declares helix): the cosmetic
    // mode is still annotation data — the thread feature settles valid
    // and the body is EXACTLY the rod (no groove, no boolean, the
    // volume at the tightest band the exact-primitive discipline pins).
    const { kernel, bridge, run } = runDocument(
      buildThreadDocument({ mode: 3 }),
    );
    expect(run.executed).toEqual([fCylinder, fThread]);
    expect(run.states.get(fThread)?.state).toBe("valid");
    const solid = bridge.solidOf(bThreaded);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "capable cosmetic volume"),
      Math.PI * 9 * 6,
      1e-9,
    );
  });

  it("declines the impossible inputs with the roadmap's named codes", () => {
    const zeroPitch = runDocument(buildThreadDocument({ pitchMm: 0 }));
    expect(zeroPitch.run.states.get(fThread)?.state).toBe("failed");
    expect(firstDiagnostic(zeroPitch.run, fThread)).toContain(
      "strictly positive pitch",
    );
    const zeroMajor = runDocument(buildThreadDocument({ majorMm: 0 }));
    expect(firstDiagnostic(zeroMajor.run, fThread)).toContain(
      "strictly positive major diameter",
    );
    const negativeLength = runDocument(buildThreadDocument({ lengthMm: -2 }));
    expect(firstDiagnostic(negativeLength.run, fThread)).toContain(
      "strictly positive thread length",
    );
    const badMode = runDocument(buildThreadDocument({ mode: 7 }));
    expect(firstDiagnostic(badMode.run, fThread)).toContain(
      "1 (external), 2 (internal), or 3 (cosmetic)",
    );
  });

  it("refuses the silent no-op: a thread that misses the target", () => {
    // A datum axis parallel to the rod's Z axis but 20 mm away: the tool
    // sweeps around a line the ⌀6 rod never reaches — the cut removes
    // nothing, and the hole precedent's post-condition refuses the silent
    // no-op with a structured diagnostic.
    const datumId = createDatumId("dtm_miss_axis");
    const base = buildThreadDocument();
    const document = requireOk(
      addDocumentDatum(base, {
        id: datumId,
        name: "miss axis",
        datum: {
          formatVersion: 1,
          datumType: "axis",
          definition: "twoPoints",
          first: [20, 0, 0],
          second: [20, 0, 1],
        },
      }),
      "the miss datum axis",
    ).document;
    const missThread: FeatureRecord = {
      id: fThread,
      kind: "thread",
      inputs: [
        { kind: "feature", id: fCylinder },
        { kind: "parameter", id: pMajor },
        { kind: "parameter", id: pThreadPitch },
        { kind: "parameter", id: pThreadLength },
        { kind: "parameter", id: pThreadMode },
        { kind: "parameter", id: pThreadHand },
        { kind: "datum", id: datumId },
      ],
      outputs: [bThreaded],
    };
    const miss = runDocument({
      ...document,
      features: document.features.map((feature): FeatureRecord =>
        feature.id === fThread ? missThread : feature,
      ),
    });
    expect(miss.run.states.get(fThread)?.state).toBe("failed");
    const message = firstDiagnostic(miss.run, fThread);
    expect(message).toContain("cut nothing");
  });
});
