/**
 * The document scene computation's honesty tests (Phase 16 owner fix):
 * `computeDocumentScene` executed against the fake kernel over an
 * in-memory ComputationContext (the worker server's solid-id mapping in
 * miniature), pinning the rules the settle surface's truth rides on:
 *
 * - the body-display keep rule applies PER BODY, before any computation —
 *   an all-hidden request set renders nothing, measures an honest zero
 *   aggregate, and records no failure (the empty projection the engine's
 *   pre-display-filter dispatch decision exists to protect);
 * - a refused composition's lineage fallback renders its FULL embedded
 *   base state — a boolean renders BOTH operands (the union body is gone;
 *   the operands are the document's truth), not just the first;
 * - a fallback whose body id already rendered never double-counts — two
 *   refused lineages on one shared base render that base exactly once;
 * - the operand handoff (the real-CAD composition rule): a compute-only
 *   consumed base evaluates before its consumer and the consumer composes
 *   from its COMPUTED solid (block → hole → subtract keeps the window), a
 *   refused consumer's fallback surfaces the operand's pass measurement,
 *   and a missing computed solid is a structured refusal, never a crash.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  angle,
  type BodyId,
  createBodyId,
  createDocument,
  createDocumentId,
  createReferenceId,
  length,
  mintTopologyReference,
  ok,
  referenceProvenance,
  type TopologyEntityReference,
  type TopologySnapshot,
  valueIn,
} from "@slopcad/cad-core";
import {
  createFakeKernel,
  createRevisionTag,
  createWorkerSolidId,
  type ComputationContext,
  type GeometryKernel,
  type KernelSolid,
  type WorkerOperationId,
  type WorkerOperationInput,
  type WorkerOperationResult,
  type WorkerSolidId,
} from "@slopcad/cad-kernel";
import type { DocumentBodySceneRequest } from "../cad-workbench/document-scene";
import type { ExtrudeSceneRequest } from "../cad-workbench/extrude";
import type { FaceOpOperation } from "../cad-workbench/face-op";
import type { PrimitiveShape } from "../cad-workbench/primitive";
import type { ThreadSceneRequest } from "../cad-workbench/thread";
import type { TopologyCutSelection } from "../cad-workbench/topology-cut";

import { computeDocumentScene } from "./document-scene";

const mm = (value: number) => length(value, "mm");

const IDENTITY_PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: mm(0), y: mm(0), z: mm(0) },
};

/**
 * One correlated operation/input pair from the worker matrix — the union
 * whose destructuring lets the dispatch below narrow each operation's
 * input to its own wire type.
 */
type SceneRequest = {
  [O in WorkerOperationId]: readonly [
    operation: O,
    input: WorkerOperationInput<O>,
  ];
}[WorkerOperationId];

/** The matching correlated union of every operation's result shape. */
type SceneAnswer = {
  [O in WorkerOperationId]: WorkerOperationResult<O>;
}[WorkerOperationId];

/** Answers the operations the document scenes compose, on the kernel. */
function answerSceneOperation(
  kernel: GeometryKernel,
  mint: (handle: KernelSolid) => WorkerSolidId,
  owned: (id: WorkerSolidId) => KernelSolid,
  request: SceneRequest,
  topology: SceneTopology | null,
): SceneAnswer {
  const [operation, input] = request;
  switch (operation) {
    case "solid.extrude": {
      const extruded = kernel.extrude(input);
      if (!extruded.ok) throw new Error(extruded.error.message);
      return { solid: mint(extruded.value) };
    }
    case "solid.union": {
      const merged = kernel.union(input.operands.map(owned));
      if (!merged.ok) throw new Error(merged.error.message);
      return { solid: mint(merged.value) };
    }
    case "solid.subtract": {
      const cut = kernel.subtract(owned(input.target), input.tools.map(owned));
      if (!cut.ok) throw new Error(cut.error.message);
      return { solid: mint(cut.value) };
    }
    case "solid.transform": {
      const moved = kernel.transform(owned(input.solid), {
        ...(input.rotation === undefined ? {} : { rotation: input.rotation }),
        ...(input.scale === undefined ? {} : { scale: input.scale }),
        x: input.translation.x,
        y: input.translation.y,
        z: input.translation.z,
      });
      if (!moved.ok) throw new Error(moved.error.message);
      return { solid: mint(moved.value) };
    }
    case "solid.createBox": {
      const created = kernel.createBox(input);
      if (!created.ok) throw new Error(created.error.message);
      return { solid: mint(created.value) };
    }
    case "solid.createSphere": {
      const created = kernel.createSphere(input);
      if (!created.ok) throw new Error(created.error.message);
      return { solid: mint(created.value) };
    }
    case "solid.createCylinder": {
      const created = kernel.createCylinder(input);
      if (!created.ok) throw new Error(created.error.message);
      return { solid: mint(created.value) };
    }
    case "solid.createCone": {
      const created = kernel.createCone(input);
      if (!created.ok) throw new Error(created.error.message);
      return { solid: mint(created.value) };
    }
    case "solid.fillet": {
      const cut = kernel.fillet({ ...input, target: owned(input.target) });
      if (!cut.ok) throw new Error(cut.error.message);
      return { solid: mint(cut.value) };
    }
    case "solid.chamfer": {
      const cut = kernel.chamfer({ ...input, target: owned(input.target) });
      if (!cut.ok) throw new Error(cut.error.message);
      return { solid: mint(cut.value) };
    }
    case "solid.shell": {
      const cut = kernel.shell({ ...input, target: owned(input.target) });
      if (!cut.ok) throw new Error(cut.error.message);
      return { solid: mint(cut.value) };
    }
    case "solid.moveFace": {
      const moved = kernel.moveFace({ ...input, target: owned(input.target) });
      if (!moved.ok) throw new Error(moved.error.message);
      return { solid: mint(moved.value) };
    }
    case "solid.deleteFace": {
      const deleted = kernel.deleteFace({
        ...input,
        target: owned(input.target),
      });
      if (!deleted.ok) throw new Error(deleted.error.message);
      return { solid: mint(deleted.value) };
    }
    case "solid.replaceFace": {
      const replaced = kernel.replaceFace({
        ...input,
        target: owned(input.target),
      });
      if (!replaced.ok) throw new Error(replaced.error.message);
      return { solid: mint(replaced.value) };
    }
    case "solid.topology": {
      if (topology === null) {
        throw new Error(
          "the scene test session hosts no topology snapshot (pass one to sceneContext).",
        );
      }
      return { snapshot: topology(input.bodyId, input.regeneration) };
    }
    case "solid.helixSweep": {
      const swept = kernel.helixSweep(input);
      if (!swept.ok) throw new Error(swept.error.message);
      return { solid: mint(swept.value) };
    }
    case "solid.volume": {
      const measured = kernel.volume(owned(input.solid));
      if (!measured.ok) throw new Error(measured.error.message);
      return { volume: measured.value };
    }
    case "solid.area": {
      const measured = kernel.area(owned(input.solid));
      if (!measured.ok) throw new Error(measured.error.message);
      return { area: measured.value };
    }
    case "solid.bounds": {
      const measured = kernel.bounds(owned(input.solid));
      if (!measured.ok) throw new Error(measured.error.message);
      return { bounds: measured.value };
    }
    case "solid.tessellate": {
      const tessellated = kernel.tessellate(owned(input.solid));
      if (!tessellated.ok) throw new Error(tessellated.error.message);
      return { tessellation: tessellated.value };
    }
    default:
      throw new Error(
        `the scene test session does not host "${operation}" (extend the dispatch when a scene grows a new operation).`,
      );
  }
}

/**
 * The test session's `solid.topology` answer: a hand-built snapshot per
 * labeled body (the fixture-view precedent of the bridge's fillet tests —
 * the resolution protocol is pure, so no BREP kernel is needed).
 */
type SceneTopology = (bodyId: BodyId, regeneration: number) => TopologySnapshot;

/** An in-memory worker session: the kernel behind worker solid ids. */
function sceneContext(
  kernel: GeometryKernel,
  topology: SceneTopology | null = null,
): ComputationContext {
  const solids = new Map<WorkerSolidId, KernelSolid>();
  let minted = 0;
  const mint = (handle: KernelSolid): WorkerSolidId => {
    minted += 1;
    const id = createWorkerSolidId(`wsol_doc_${String(minted)}`);
    solids.set(id, handle);
    return id;
  };
  const owned = (id: WorkerSolidId): KernelSolid => {
    const handle = solids.get(id);
    if (handle === undefined) {
      throw new Error(
        `the scene test session does not own solid "${id}" (unknown or already disposed).`,
      );
    }
    return handle;
  };
  return {
    revision: createRevisionTag(0),
    request: <O extends WorkerOperationId>(
      operation: O,
      input: WorkerOperationInput<O>,
    ): Promise<WorkerOperationResult<O>> => {
      const answered = answerSceneOperation(
        kernel,
        mint,
        owned,
        [operation, input] as SceneRequest,
        topology,
      );
      return Promise.resolve(answered as WorkerOperationResult<O>);
    },
  };
}

/** A closed counter-clockwise square loop from (x0, y0) to (x1, y1). */
function squareLoop(x0: number, y0: number, x1: number, y1: number) {
  return [
    { kind: "line", start: [x0, y0], end: [x1, y0] },
    { kind: "line", start: [x1, y0], end: [x1, y1] },
    { kind: "line", start: [x1, y1], end: [x0, y1] },
    { kind: "line", start: [x0, y1], end: [x0, y0] },
  ] as const;
}

/** An extrusion request over the given loop, under the given body id. */
function extrusionOf(
  bodyId: string,
  loop: ReturnType<typeof squareLoop>,
): DocumentBodySceneRequest {
  return {
    bodyId,
    scene: {
      kind: "extrude",
      request: {
        loop,
        placement: IDENTITY_PLACEMENT,
        distanceMm: 10,
        bodyId,
      },
    },
  };
}

/** The structured stand-in refusal every pinned refusal path rides. */
function kernelRefusal(): {
  readonly ok: false;
  readonly error: {
    readonly code: "kernel/unsupported-operation";
    readonly message: string;
    readonly input: null;
  };
} {
  return {
    ok: false,
    error: {
      code: "kernel/unsupported-operation",
      message: "the stand-in kernel refuses this operation",
      input: null,
    },
  };
}

/**
 * The measuring stand-in: the fake kernel's area domain excludes extrusion
 * nodes (no closed form in the fake model), so — the rib scene test's
 * precedent — area answers a placeholder; the unit under test is the
 * fallback/keep-rule bookkeeping, not the area number.
 */
function measuringKernel(): GeometryKernel {
  return {
    ...createFakeKernel(),
    area: () => ok(2),
  };
}

describe("computeDocumentScene: the display keep rule (Phase 16)", () => {
  it("skips hidden bodies per body — the all-hidden scene settles the honest zero", async () => {
    const context = sceneContext(measuringKernel());
    const bodies = [extrusionOf("body_extrude", squareLoop(0, 0, 10, 10))];

    // The control: renderable, it renders and measures.
    const visible = await computeDocumentScene(
      context,
      bodies,
      new Set(["body_extrude"]),
    );
    expect(visible.bodies.map((body) => body.bodyId)).toEqual(["body_extrude"]);
    expect(visible.volume).toBeGreaterThan(0);
    expect(visible.failures).toEqual([]);

    // All-hidden: every body skips BEFORE its scene computes — an empty
    // render list, the zero aggregate (the settle's `data-volume` truth),
    // zeroed bounds, and no fabricated failure.
    const hidden = await computeDocumentScene(context, bodies, new Set());
    expect(hidden.bodies).toEqual([]);
    expect(hidden.volume).toBe(0);
    expect(hidden.area).toBe(0);
    expect(hidden.triangles).toBe(0);
    expect(hidden.bounds).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    expect(hidden.failures).toEqual([]);
  });

  it("a hidden body records no refusal — its scene is never computed", async () => {
    const context = sceneContext({
      ...measuringKernel(),
      union: () => kernelRefusal(),
    });
    const booleanBody: DocumentBodySceneRequest = {
      bodyId: "body_boolean",
      scene: {
        kind: "boolean",
        request: {
          target: {
            kind: "extrude",
            request: {
              loop: squareLoop(0, 0, 10, 10),
              placement: IDENTITY_PLACEMENT,
              distanceMm: 10,
              bodyId: "body_target",
            },
          },
          tools: [
            {
              kind: "extrude",
              request: {
                loop: squareLoop(20, 0, 30, 10),
                placement: IDENTITY_PLACEMENT,
                distanceMm: 10,
                bodyId: "body_tool",
              },
            },
          ],
          operation: "union",
          bodyId: "body_boolean",
        },
      },
    };
    const hidden = await computeDocumentScene(
      context,
      [booleanBody],
      new Set(["body_target", "body_tool"]),
    );
    expect(hidden.bodies).toEqual([]);
    expect(hidden.failures).toEqual([]);
  });
});

describe("computeDocumentScene: the lineage fallback (Phase 16)", () => {
  it("a refused boolean renders BOTH operands, both counted", async () => {
    const context = sceneContext({
      ...measuringKernel(),
      union: () => kernelRefusal(),
    });
    const booleanBody: DocumentBodySceneRequest = {
      bodyId: "body_boolean",
      scene: {
        kind: "boolean",
        request: {
          target: {
            kind: "extrude",
            request: {
              loop: squareLoop(0, 0, 10, 10),
              placement: IDENTITY_PLACEMENT,
              distanceMm: 10,
              bodyId: "body_target",
            },
          },
          tools: [
            {
              kind: "extrude",
              request: {
                loop: squareLoop(20, 0, 30, 10),
                placement: IDENTITY_PLACEMENT,
                distanceMm: 10,
                bodyId: "body_tool",
              },
            },
          ],
          operation: "union",
          bodyId: "body_boolean",
        },
      },
    };
    const result = await computeDocumentScene(
      context,
      [booleanBody],
      new Set(["body_boolean", "body_target", "body_tool"]),
    );
    // The refusal surfaces once, verbatim-carried; the fallback renders
    // the FULL embedded base state — both operands, in operand order.
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "boolean",
    ]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual([
      "body_target",
      "body_tool",
    ]);
    // The aggregate counts every rendered operand exactly once.
    const [target, tool] = result.bodies;
    expect(target?.measurement.volume).toBeGreaterThan(0);
    expect(tool?.measurement.volume).toBeGreaterThan(0);
    expect(result.volume).toBe(
      (target?.measurement.volume ?? 0) + (tool?.measurement.volume ?? 0),
    );
  });

  it("two refused lineages on one shared base render that base exactly once", async () => {
    const context = sceneContext({
      ...measuringKernel(),
      subtract: () => kernelRefusal(),
    });
    // The hole and the thread both embed the SAME base extrusion; both
    // scenes refuse (the stand-in declines every subtract — a documented
    // structured refusal path for both), and both fallbacks name the base.
    const sharedBase = {
      loop: squareLoop(0, 0, 10, 10),
      placement: IDENTITY_PLACEMENT,
      distanceMm: 10,
      bodyId: "body_shared_base",
    };
    const holeBody: DocumentBodySceneRequest = {
      bodyId: "body_hole",
      scene: {
        kind: "hole",
        request: {
          base: { kind: "extrude", request: sharedBase },
          holes: [
            {
              diameterMm: 4,
              depthMm: 4,
              positionXMm: 5,
              positionYMm: 5,
              axis: 3,
            },
          ],
        },
      },
    };
    const threadRequest: ThreadSceneRequest = {
      base: sharedBase,
      thread: {
        majorDiameterMm: 6,
        pitchMm: 1,
        lengthMm: 6,
        mode: 1,
        handedness: 1,
        axis: 3,
      },
      bodyId: "body_thread",
    };
    const threadBody: DocumentBodySceneRequest = {
      bodyId: "body_thread",
      scene: { kind: "thread", request: threadRequest },
    };
    const result = await computeDocumentScene(
      context,
      [holeBody, threadBody],
      new Set(["body_hole", "body_thread", "body_shared_base"]),
    );
    // Both refusals surface; the base renders ONCE — the second fallback's
    // body id is already in the rendered set, so the mesh and its volume
    // never double-count.
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "hole",
      "thread",
    ]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual([
      "body_shared_base",
    ]);
    expect(result.volume).toBe(result.bodies[0]?.measurement.volume ?? -1);
    expect(result.volume).toBeGreaterThan(0);
  });
});

describe("computeDocumentScene: the operand handoff (composition)", () => {
  /** The 10×10×10 block extrusion the fixtures compose from. */
  function blockBase(): {
    readonly kind: "extrude";
    readonly request: ExtrudeSceneRequest;
  } {
    return {
      kind: "extrude",
      request: {
        loop: squareLoop(0, 0, 10, 10),
        placement: IDENTITY_PLACEMENT,
        distanceMm: 10,
        bodyId: "body_block",
      },
    };
  }

  /** The consumed holed block: Ø4 through, at the block's centre. */
  function holedBase(): DocumentBodySceneRequest {
    return {
      bodyId: "body_holed",
      consumedOnly: true,
      scene: {
        kind: "hole",
        request: {
          base: blockBase(),
          holes: [
            {
              diameterMm: 4,
              depthMm: 10,
              positionXMm: 5,
              positionYMm: 5,
              axis: 3,
            },
          ],
        },
      },
    };
  }

  it("a subtract consumes the holed block's computed solid — the window survives", async () => {
    const context = sceneContext(measuringKernel());
    const booleanBody: DocumentBodySceneRequest = {
      bodyId: "body_boolean",
      scene: {
        kind: "boolean",
        request: {
          target: { kind: "computed", bodyId: "body_holed" },
          tools: [
            {
              kind: "extrude",
              request: {
                loop: squareLoop(2, 8, 6, 12),
                placement: IDENTITY_PLACEMENT,
                distanceMm: 10,
                bodyId: "body_tool",
              },
            },
          ],
          operation: "subtract",
          bodyId: "body_boolean",
        },
      },
    };
    const result = await computeDocumentScene(
      context,
      [holedBase(), booleanBody],
      new Set(["body_boolean"]),
    );
    // The compute-only base renders nothing; only the boolean's output
    // does — and its volume is the HOLED block minus the tool, the window
    // carried through the handoff (1000 − 40π − 80).
    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_boolean"]);
    const expected = 1000 - Math.PI * 4 * 10 - 4 * 2 * 10;
    expect(Math.abs(result.volume - expected)).toBeLessThanOrEqual(
      Math.abs(expected) * 0.02,
    );
  });

  it("a refused consumer's fallback surfaces the computed operand's current state", async () => {
    // The stand-in declines every subtract AFTER the first: the hole's cut
    // (call 1) succeeds, the boolean's (call 2) refuses.
    const base = measuringKernel();
    let subtractCalls = 0;
    const context = sceneContext({
      ...base,
      subtract: (target, tools) => {
        subtractCalls += 1;
        if (subtractCalls >= 2) return kernelRefusal();
        return base.subtract(target, tools);
      },
    });
    const booleanBody: DocumentBodySceneRequest = {
      bodyId: "body_boolean",
      scene: {
        kind: "boolean",
        request: {
          target: { kind: "computed", bodyId: "body_holed" },
          tools: [
            {
              kind: "extrude",
              request: {
                loop: squareLoop(2, 8, 6, 12),
                placement: IDENTITY_PLACEMENT,
                distanceMm: 10,
                bodyId: "body_tool",
              },
            },
          ],
          operation: "subtract",
          bodyId: "body_boolean",
        },
      },
    };
    const result = await computeDocumentScene(
      context,
      [holedBase(), booleanBody],
      new Set(["body_holed", "body_tool", "body_boolean"]),
    );
    // The refusal surfaces once; the fallback renders the operands in
    // their CURRENT state — the holed block (its pass measurement, the
    // window included), then the raw tool.
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "boolean",
    ]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual([
      "body_holed",
      "body_tool",
    ]);
    const holed = result.bodies[0]?.measurement.volume ?? -1;
    const expected = 1000 - Math.PI * 4 * 10;
    expect(Math.abs(holed - expected)).toBeLessThanOrEqual(
      Math.abs(expected) * 0.02,
    );
    expect(result.volume).toBe(
      holed + (result.bodies[1]?.measurement.volume ?? -1),
    );
  });

  it("a missing computed solid is a structured refusal, never a crash", async () => {
    const context = sceneContext(measuringKernel());
    const booleanBody: DocumentBodySceneRequest = {
      bodyId: "body_boolean",
      scene: {
        kind: "boolean",
        request: {
          target: { kind: "computed", bodyId: "body_holed" },
          tools: [
            {
              kind: "extrude",
              request: {
                loop: squareLoop(2, 8, 6, 12),
                placement: IDENTITY_PLACEMENT,
                distanceMm: 10,
                bodyId: "body_tool",
              },
            },
          ],
          operation: "subtract",
          bodyId: "body_boolean",
        },
      },
    };
    const result = await computeDocumentScene(
      context,
      // No consumedOnly entry carries the target's scene — the operand's
      // own composition never ran in this pass.
      [booleanBody],
      new Set(["body_boolean", "body_tool"]),
    );
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "boolean",
    ]);
    expect(String(result.failures[0]?.failure)).toContain(
      "operand-unavailable",
    );
    // The lineage fallback still renders the tool (its derivation).
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_tool"]);
  });

  it("a refused transform pattern falls back to its EXTRUDE target's derivation", async () => {
    // The fake kernel refuses rotations (transformRotation is false), so
    // the circular pattern's first copy transform fails — the lineage
    // fallback must still render the still-valid target's extrusion rather
    // than leave the consumed-only operand invisible.
    const context = sceneContext(measuringKernel());
    const patternBody: DocumentBodySceneRequest = {
      bodyId: "body_pattern",
      scene: {
        kind: "patternTransform",
        request: {
          target: {
            kind: "extrude",
            request: {
              loop: squareLoop(0, 0, 10, 10),
              placement: IDENTITY_PLACEMENT,
              distanceMm: 10,
              bodyId: "body_block",
            },
          },
          pattern: {
            kind: "circular",
            count: 4,
            totalAngleRad: Math.PI * 2,
            axis: [0, 0, 1],
            axisOrigin: [0, 0, 0],
          },
          bodyId: "body_pattern",
        },
      },
    };
    const result = await computeDocumentScene(
      context,
      [patternBody],
      new Set(["body_pattern", "body_block"]),
    );
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "patternTransform",
    ]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_block"]);
    expect(result.bodies[0]?.measurement.volume).toBeGreaterThan(0);
  });

  it("a refused transform pattern falls back to its COMPUTED target's pass measurement", async () => {
    // The reviewer's case: the pattern's target ran compute-only to feed
    // the pattern, the copy transform refuses (the fake kernel carries no
    // rotation), and the holed block must not disappear — its pass
    // measurement is the lineage's honest current state.
    const context = sceneContext(measuringKernel());
    const patternBody: DocumentBodySceneRequest = {
      bodyId: "body_pattern",
      scene: {
        kind: "patternTransform",
        request: {
          target: { kind: "computed", bodyId: "body_holed" },
          pattern: {
            kind: "circular",
            count: 4,
            totalAngleRad: Math.PI * 2,
            axis: [0, 0, 1],
            axisOrigin: [0, 0, 0],
          },
          bodyId: "body_pattern",
        },
      },
    };
    const result = await computeDocumentScene(
      context,
      [holedBase(), patternBody],
      new Set(["body_holed", "body_pattern"]),
    );
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "patternTransform",
    ]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_holed"]);
    const expected = 1000 - Math.PI * 4 * 10;
    expect(
      Math.abs((result.bodies[0]?.measurement.volume ?? -1) - expected),
    ).toBeLessThanOrEqual(Math.abs(expected) * 0.02);
  });
});

describe("computeDocumentScene: the primitive scenes", () => {
  /** One primitive scene entry under `bodyId`. */
  function primitiveOf(
    bodyId: string,
    shape: PrimitiveShape,
    consumedOnly = false,
  ): DocumentBodySceneRequest {
    return {
      bodyId,
      ...(consumedOnly ? { consumedOnly: true } : {}),
      scene: { kind: "primitive", request: { shape, bodyId } },
    };
  }

  it("builds every primitive through its kernel operation and renders each", async () => {
    const context = sceneContext(createFakeKernel());
    const bodies = [
      primitiveOf("body_box", {
        kind: "box",
        widthMm: 10,
        depthMm: 20,
        heightMm: 30,
      }),
      primitiveOf("body_sphere", { kind: "sphere", radiusMm: 5 }),
      primitiveOf("body_cylinder", {
        kind: "cylinder",
        radiusMm: 4,
        heightMm: 12,
      }),
      primitiveOf("body_cone", {
        kind: "cone",
        bottomRadiusMm: 6,
        topRadiusMm: 0,
        heightMm: 9,
      }),
    ];
    const result = await computeDocumentScene(
      context,
      bodies,
      new Set(bodies.map((body) => body.bodyId)),
    );
    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual([
      "body_box",
      "body_sphere",
      "body_cylinder",
      "body_cone",
    ]);
    const box = result.bodies.find((body) => body.bodyId === "body_box");
    expect(box?.measurement.volume).toBeCloseTo(6000, 6);
  });

  it("a subtract consumes a primitive's computed solid", async () => {
    const context = sceneContext(measuringKernel());
    const booleanBody: DocumentBodySceneRequest = {
      bodyId: "body_cut",
      scene: {
        kind: "boolean",
        request: {
          target: { kind: "computed", bodyId: "body_block" },
          tools: [{ kind: "computed", bodyId: "body_core" }],
          operation: "subtract",
          bodyId: "body_cut",
        },
      },
    };
    const result = await computeDocumentScene(
      context,
      [
        primitiveOf(
          "body_block",
          { kind: "box", widthMm: 10, depthMm: 10, heightMm: 10 },
          true,
        ),
        primitiveOf(
          "body_core",
          { kind: "box", widthMm: 5, depthMm: 5, heightMm: 5 },
          true,
        ),
        booleanBody,
      ],
      new Set(["body_cut"]),
    );
    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_cut"]);
    expect(Math.abs(result.volume - 875)).toBeLessThanOrEqual(875 * 0.02);
  });
});

describe("computeDocumentScene: the topology-cut scenes", () => {
  /** The fake kernel's box-edge ordinal 5: y-direction, length = depth. */
  const EDGE_ORDINAL = 5;
  const BOX = { widthMm: 10, depthMm: 20, heightMm: 30 } as const;
  const BOX_VOLUME = BOX.widthMm * BOX.depthMm * BOX.heightMm;
  const FIXTURE_KERNEL_ID = "fixture-kernel";
  const FIXTURE_SCHEMA = "fixture-snapshot-v1";

  /** The box primitive every cut targets, compute-only under `bodyId`. */
  function boxOf(bodyId: string): DocumentBodySceneRequest {
    return {
      bodyId,
      consumedOnly: true,
      scene: {
        kind: "primitive",
        request: { shape: { kind: "box", ...BOX }, bodyId },
      },
    };
  }

  /** One topology-cut entry over a computed target. */
  function cutOf(
    bodyId: string,
    kind: "fillet" | "chamfer" | "shell",
    targetBodyId: string,
    sizeMm: number,
    selection: TopologyCutSelection,
    consumedOnly = false,
  ): DocumentBodySceneRequest {
    return {
      bodyId,
      ...(consumedOnly ? { consumedOnly: true } : {}),
      scene: {
        kind: "topologyCut",
        request: {
          kind,
          target: { kind: "computed", bodyId: targetBodyId },
          targetBodyId,
          sizeMm,
          selection,
          bodyId,
        },
      },
    };
  }

  /** A hand-built persistent snapshot carrying the fixture edge. */
  function fixtureSnapshot(
    bodyId: BodyId,
    regeneration: number,
    hash: number,
    shiftMm = 0,
  ): TopologySnapshot {
    return {
      kernelId: FIXTURE_KERNEL_ID,
      persistentTopology: true,
      identitySchemas: [FIXTURE_SCHEMA],
      bodyId,
      regeneration,
      entities: [
        {
          kind: "edge",
          ordinal: EDGE_ORDINAL,
          identity: {
            kernelId: FIXTURE_KERNEL_ID,
            schema: FIXTURE_SCHEMA,
            data: { hash },
          },
          geometry: {
            lengthMm: BOX.depthMm,
            centroidAbsoluteMm: [BOX.widthMm + shiftMm, BOX.depthMm / 2, 0],
            centroidRelativeMm: [
              BOX.widthMm / 2 + shiftMm,
              0,
              -BOX.heightMm / 2,
            ],
          },
        },
      ],
    };
  }

  /** A persistent edge reference minted on the fixture snapshot. */
  function mintedEdgeReference(bodyId: string): TopologyEntityReference {
    const body = createBodyId(bodyId);
    const added = addBody(createDocument(createDocumentId("doc_cut")), {
      id: body,
      name: "block",
    });
    if (!added.ok) throw new Error(added.error.message);
    const provenance = referenceProvenance(added.value.document, body);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const minted = mintTopologyReference(
      fixtureSnapshot(body, 0, 4242),
      EDGE_ORDINAL,
      provenance.value,
      { id: createReferenceId("ref_cut_edge"), kind: "edge" },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    return minted.value;
  }

  it("fillets, chamfers and shells through the kernel's own operations", async () => {
    const context = sceneContext(measuringKernel());
    const ordinals = { kind: "ordinals", ordinals: [EDGE_ORDINAL] } as const;
    const bodies = [
      boxOf("body_box"),
      cutOf("body_fillet", "fillet", "body_box", 2, ordinals),
      cutOf("body_chamfer", "chamfer", "body_box", 2, ordinals),
      cutOf("body_shell", "shell", "body_box", 1, {
        kind: "ordinals",
        ordinals: [0],
      }),
    ];
    const result = await computeDocumentScene(
      context,
      bodies,
      new Set(["body_fillet", "body_chamfer", "body_shell"]),
    );
    expect(result.failures).toEqual([]);
    const volumeOf = (bodyId: string) =>
      result.bodies.find((body) => body.bodyId === bodyId)?.measurement
        .volume ?? -1;
    expect(volumeOf("body_fillet")).toBeCloseTo(
      BOX_VOLUME - (1 - Math.PI / 4) * 2 * 2 * BOX.depthMm,
      6,
    );
    expect(volumeOf("body_chamfer")).toBeCloseTo(
      BOX_VOLUME - ((2 * 2) / 2) * BOX.depthMm,
      6,
    );
    expect(volumeOf("body_shell")).toBeGreaterThan(0);
    expect(volumeOf("body_shell")).toBeLessThan(BOX_VOLUME);
  });

  it("resolves a persistent reference against the target's current snapshot", async () => {
    const context = sceneContext(measuringKernel(), (bodyId, regeneration) =>
      fixtureSnapshot(bodyId, regeneration, 4242),
    );
    const result = await computeDocumentScene(
      context,
      [
        boxOf("body_box"),
        cutOf("body_fillet", "fillet", "body_box", 2, {
          kind: "references",
          references: [mintedEdgeReference("body_box")],
        }),
      ],
      new Set(["body_fillet"]),
    );
    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_fillet"]);
    expect(result.volume).toBeCloseTo(
      BOX_VOLUME - (1 - Math.PI / 4) * 2 * 2 * BOX.depthMm,
      6,
    );
  });

  it("a missing reference repairs onto its unmoved edge before refusing (Phase N3)", async () => {
    const context = sceneContext(measuringKernel(), (bodyId, regeneration) =>
      fixtureSnapshot(bodyId, regeneration, 9999),
    );
    const result = await computeDocumentScene(
      context,
      [
        boxOf("body_box"),
        cutOf("body_fillet", "fillet", "body_box", 2, {
          kind: "references",
          references: [mintedEdgeReference("body_box")],
        }),
      ],
      new Set(["body_fillet"]),
    );
    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_fillet"]);
    expect(result.volume).toBeCloseTo(
      BOX_VOLUME - (1 - Math.PI / 4) * 2 * 2 * BOX.depthMm,
      6,
    );
  });

  it("a stale reference with no repair candidate refuses — the target's state renders in its place", async () => {
    const context = sceneContext(measuringKernel(), (bodyId, regeneration) =>
      fixtureSnapshot(bodyId, regeneration, 9999, 5),
    );
    const result = await computeDocumentScene(
      context,
      [
        boxOf("body_box"),
        cutOf("body_fillet", "fillet", "body_box", 2, {
          kind: "references",
          references: [mintedEdgeReference("body_box")],
        }),
      ],
      new Set(["body_box", "body_fillet"]),
    );
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "topologyCut",
    ]);
    const message = String(result.failures[0]?.failure);
    expect(message).toContain("reference-unresolved");
    expect(message).toContain("stands missing");
    expect(message).toContain("repair refused");
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_box"]);
    expect(result.volume).toBeCloseTo(BOX_VOLUME, 6);
  });

  it("a chain composes in order — each cut's output is the next cut's target", async () => {
    const fake = measuringKernel();
    const calls: { readonly kind: string; readonly target: KernelSolid }[] = [];
    const outputs: KernelSolid[] = [];
    /** A recording cut: answers a fresh, smaller box so each step is distinct. */
    const recording = (kind: string) => (input: { target: KernelSolid }) => {
      calls.push({ kind, target: input.target });
      const created = fake.createBox({
        width: mm(10),
        depth: mm(10),
        height: mm(10 - calls.length),
      });
      if (created.ok) outputs.push(created.value);
      return created;
    };
    const context = sceneContext({
      ...fake,
      chamfer: recording("chamfer"),
      fillet: recording("fillet"),
      shell: recording("shell"),
    });
    const edges = { kind: "ordinals", ordinals: [EDGE_ORDINAL] } as const;
    const result = await computeDocumentScene(
      context,
      [
        boxOf("body_box"),
        cutOf("body_c1", "chamfer", "body_box", 1, edges, true),
        cutOf("body_f2", "fillet", "body_c1", 1, edges, true),
        cutOf("body_s3", "shell", "body_f2", 1, {
          kind: "ordinals",
          ordinals: [0],
        }),
      ],
      new Set(["body_s3"]),
    );
    expect(result.failures).toEqual([]);
    expect(calls.map((call) => call.kind)).toEqual([
      "chamfer",
      "fillet",
      "shell",
    ]);
    expect(calls[1]?.target).toBe(outputs[0]);
    expect(calls[2]?.target).toBe(outputs[1]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_s3"]);
    expect(result.volume).toBeCloseTo(10 * 10 * 7, 6);
  });

  it("a refused cut mid-chain falls back to its target — the previous cut's output", async () => {
    // The fake kernel's fillet domain is a pristine box: filleting the
    // chamfered solid is its structured refusal.
    const context = sceneContext(measuringKernel());
    const edges = { kind: "ordinals", ordinals: [EDGE_ORDINAL] } as const;
    const result = await computeDocumentScene(
      context,
      [
        boxOf("body_box"),
        cutOf("body_chamfer", "chamfer", "body_box", 2, edges, true),
        cutOf("body_fillet", "fillet", "body_chamfer", 2, edges),
      ],
      new Set(["body_box", "body_chamfer", "body_fillet"]),
    );
    expect(result.failures.map((failure) => failure.bodyId)).toEqual([
      "body_fillet",
    ]);
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "topologyCut",
    ]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_chamfer"]);
    expect(result.volume).toBeCloseTo(
      BOX_VOLUME - ((2 * 2) / 2) * BOX.depthMm,
      6,
    );
  });
});

describe("computeDocumentScene: the face-op and patternFace scenes", () => {
  const BOX = { widthMm: 10, depthMm: 20, heightMm: 30 } as const;
  const FACE_ORDINAL = 2;
  const KERNEL_ID = "fixture-kernel";
  const SCHEMA = "fixture-snapshot-v1";

  /** The top face's centroid on the fake kernel's own box placement. */
  function topCentroid(): readonly [number, number, number] {
    const kernel = createFakeKernel();
    const box = kernel.createBox({
      width: mm(BOX.widthMm),
      depth: mm(BOX.depthMm),
      height: mm(BOX.heightMm),
    });
    if (!box.ok) throw new Error(box.error.message);
    const bounds = kernel.bounds(box.value);
    if (!bounds.ok) throw new Error(bounds.error.message);
    const { min, max } = bounds.value;
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[2]];
  }

  /**
   * A persistent snapshot carrying the box's top face (its centroid on
   * the top cap unless `centroidAbsoluteMm` overrides it).
   */
  function faceSnapshot(
    bodyId: BodyId,
    regeneration: number,
    centroidAbsoluteMm: readonly [number, number, number] = topCentroid(),
  ): TopologySnapshot {
    return {
      kernelId: KERNEL_ID,
      persistentTopology: true,
      identitySchemas: [SCHEMA],
      bodyId,
      regeneration,
      entities: [
        {
          kind: "face",
          ordinal: FACE_ORDINAL,
          identity: { kernelId: KERNEL_ID, schema: SCHEMA, data: { hash: 7 } },
          geometry: {
            areaMm2: BOX.widthMm * BOX.depthMm,
            centroidAbsoluteMm,
            centroidRelativeMm: [0, 0, BOX.heightMm / 2],
          },
        },
      ],
    };
  }

  /** A persistent face reference minted on `bodyId`'s fixture snapshot. */
  function faceReference(bodyId: string): TopologyEntityReference {
    const body = createBodyId(bodyId);
    const added = addBody(createDocument(createDocumentId("doc_face")), {
      id: body,
      name: "block",
    });
    if (!added.ok) throw new Error(added.error.message);
    const provenance = referenceProvenance(added.value.document, body);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const minted = mintTopologyReference(
      faceSnapshot(body, 0),
      FACE_ORDINAL,
      provenance.value,
      { id: createReferenceId("ref_face"), kind: "face" },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    return minted.value;
  }

  function boxOf(bodyId: string): DocumentBodySceneRequest {
    return {
      bodyId,
      consumedOnly: true,
      scene: {
        kind: "primitive",
        request: { shape: { kind: "box", ...BOX }, bodyId },
      },
    };
  }

  function faceOpOf(
    bodyId: string,
    targetBodyId: string,
    operation: FaceOpOperation,
    consumedOnly = false,
  ): DocumentBodySceneRequest {
    return {
      bodyId,
      ...(consumedOnly ? { consumedOnly: true } : {}),
      scene: {
        kind: "faceOp",
        request: {
          target: { kind: "computed", bodyId: targetBodyId },
          targetBodyId,
          face: faceReference(targetBodyId),
          operation,
          bodyId,
        },
      },
    };
  }

  function patternFaceOf(
    bodyId: string,
    targetBodyId: string,
    spacingMm: number,
  ): DocumentBodySceneRequest {
    return {
      bodyId,
      scene: {
        kind: "patternFace",
        request: {
          target: { kind: "computed", bodyId: targetBodyId },
          targetBodyId,
          face: faceReference(targetBodyId),
          legs: [
            { directionRad: 0, count: 3, spacingMm },
            { directionRad: Math.PI / 2, count: 2, spacingMm: spacingMm + 1 },
          ],
          bodyId,
        },
      },
    };
  }

  const MOVE = {
    kind: "moveFace",
    direction: [0, 0, 1],
    distanceMm: 2,
  } as const satisfies FaceOpOperation;

  it("moves, deletes and replaces the resolved face through the kernel", async () => {
    const fake = measuringKernel();
    const calls: {
      readonly kind: string;
      readonly face: number;
      readonly target: KernelSolid;
      readonly operands: Readonly<Record<string, unknown>>;
    }[] = [];
    const outputs: KernelSolid[] = [];
    // Records the kernel's FULL input — the operation's own operands in
    // canonical units — so a dropped unit or a flipped flag fails here.
    const record = (
      kind: string,
      input: { readonly target: KernelSolid; readonly face: number },
      operands: Readonly<Record<string, unknown>>,
    ) => {
      calls.push({ kind, face: input.face, target: input.target, operands });
      const created = fake.createBox({
        width: mm(10),
        depth: mm(10),
        height: mm(10 - calls.length),
      });
      if (created.ok) outputs.push(created.value);
      return created;
    };
    const context = sceneContext(
      {
        ...fake,
        moveFace: (input) =>
          record("moveFace", input, {
            direction: input.direction,
            distanceMm: valueIn(input.distance, "mm"),
          }),
        deleteFace: (input) =>
          record("deleteFace", input, { heal: input.heal }),
        replaceFace: (input) =>
          record("replaceFace", input, {
            originMm: [
              valueIn(input.plane.origin.x, "mm"),
              valueIn(input.plane.origin.y, "mm"),
              valueIn(input.plane.origin.z, "mm"),
            ],
            normal: input.plane.normal,
          }),
      },
      faceSnapshot,
    );
    const result = await computeDocumentScene(
      context,
      [
        boxOf("body_box"),
        faceOpOf("body_m", "body_box", MOVE, true),
        faceOpOf("body_d", "body_m", { kind: "deleteFace", heal: true }, true),
        faceOpOf("body_r", "body_d", {
          kind: "replaceFace",
          plane: { origin: [0, 0, 5], normal: [0, 0, 1] },
        }),
      ],
      new Set(["body_r"]),
    );
    expect(result.failures).toEqual([]);
    expect(
      calls.map(({ kind, face, operands }) => ({ kind, face, operands })),
    ).toEqual([
      {
        kind: "moveFace",
        face: FACE_ORDINAL,
        operands: { direction: [0, 0, 1], distanceMm: 2 },
      },
      { kind: "deleteFace", face: FACE_ORDINAL, operands: { heal: true } },
      {
        kind: "replaceFace",
        face: FACE_ORDINAL,
        operands: { originMm: [0, 0, 5], normal: [0, 0, 1] },
      },
    ]);
    expect(calls[1]?.target).toBe(outputs[0]);
    expect(calls[2]?.target).toBe(outputs[1]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_r"]);
    expect(result.volume).toBeCloseTo(10 * 10 * 7, 6);
  });

  it("passes an unhealed deleteFace's heal flag through as false", async () => {
    const fake = measuringKernel();
    const heals: boolean[] = [];
    const context = sceneContext(
      {
        ...fake,
        deleteFace: (input) => {
          heals.push(input.heal);
          return fake.createBox({
            width: mm(10),
            depth: mm(10),
            height: mm(9),
          });
        },
      },
      faceSnapshot,
    );
    const result = await computeDocumentScene(
      context,
      [
        boxOf("body_box"),
        faceOpOf("body_d", "body_box", { kind: "deleteFace", heal: false }),
      ],
      new Set(["body_d"]),
    );
    expect(result.failures).toEqual([]);
    expect(heals).toEqual([false]);
  });

  it("a refused face op falls back to its target's scene", async () => {
    // The fake kernel refuses every face op (no face identity).
    const context = sceneContext(measuringKernel(), faceSnapshot);
    const result = await computeDocumentScene(
      context,
      [boxOf("body_box"), faceOpOf("body_m", "body_box", MOVE)],
      new Set(["body_box", "body_m"]),
    );
    expect(result.failures.map((failure) => failure.scene)).toEqual(["faceOp"]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_box"]);
    expect(result.volume).toBeCloseTo(
      BOX.widthMm * BOX.depthMm * BOX.heightMm,
      6,
    );
  });

  it("patterns the target over the grid points inside the face, unioned", async () => {
    const fake = measuringKernel();
    const offsets: (readonly number[])[] = [];
    const unions: number[] = [];
    const context = sceneContext(
      {
        ...fake,
        transform: (solid, input) => {
          offsets.push([
            valueIn(input.x, "mm"),
            valueIn(input.y, "mm"),
            valueIn(input.z, "mm"),
          ]);
          return fake.transform(solid, input);
        },
        union: (operands) => {
          unions.push(operands.length);
          return fake.union(operands);
        },
      },
      faceSnapshot,
    );
    const result = await computeDocumentScene(
      context,
      [boxOf("body_box"), patternFaceOf("body_p", "body_box", 4)],
      new Set(["body_p"]),
    );
    expect(result.failures).toEqual([]);
    // The 3 × 2 grid from the face centroid: x ∈ {0, 4, 8}, y ∈ {0, 5};
    // x = 8 leaves the 10 mm-wide face, so four points qualify — the
    // origin copy plus three translated ones.
    const rounded = offsets
      .map((offset) => offset.map((value) => Math.round(value * 1e9) / 1e9 + 0))
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
    expect(rounded).toEqual([
      [0, 5, 0],
      [4, 0, 0],
      [4, 5, 0],
    ]);
    expect(unions).toEqual([4]);
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_p"]);
  });

  it("a grid with fewer than two points on the face falls back to its target", async () => {
    const context = sceneContext(measuringKernel(), faceSnapshot);
    const result = await computeDocumentScene(
      context,
      [boxOf("body_box"), patternFaceOf("body_p", "body_box", 50)],
      new Set(["body_box", "body_p"]),
    );
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "patternFace",
    ]);
    expect(String(result.failures[0]?.failure)).toContain(
      "patternFace/no-instance",
    );
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_box"]);
  });

  it("a bounding face whose centroid lies on no triangle falls back to its target", async () => {
    // The snapshot's centroid sits far outside the box, so no tessellated
    // triangle carries it and the face's plane cannot resolve.
    const context = sceneContext(measuringKernel(), (bodyId, regeneration) =>
      faceSnapshot(bodyId, regeneration, [500, 500, 500]),
    );
    const result = await computeDocumentScene(
      context,
      [boxOf("body_box"), patternFaceOf("body_p", "body_box", 4)],
      new Set(["body_box", "body_p"]),
    );
    expect(result.failures.map((failure) => failure.scene)).toEqual([
      "patternFace",
    ]);
    expect(String(result.failures[0]?.failure)).toContain(
      "face-plane-unresolved",
    );
    expect(result.bodies.map((body) => body.bodyId)).toEqual(["body_box"]);
    expect(result.volume).toBeCloseTo(
      BOX.widthMm * BOX.depthMm * BOX.heightMm,
      6,
    );
  });
});

describe("computeDocumentScene: the computed-solid report (agent plane)", () => {
  /** Wraps a context so every operation the pass issues is recorded. */
  function recordingContext(context: ComputationContext): {
    readonly context: ComputationContext;
    readonly operations: WorkerOperationId[];
  } {
    const operations: WorkerOperationId[] = [];
    return {
      context: {
        revision: context.revision,
        request: (operation, input) => {
          operations.push(operation);
          return context.request(operation, input);
        },
      },
      operations,
    };
  }

  it("reports every computed solid by body id and issues no topology request", async () => {
    const { context, operations } = recordingContext(
      sceneContext(measuringKernel()),
    );
    const result = await computeDocumentScene(
      context,
      [
        extrusionOf("body_shown", squareLoop(0, 0, 10, 10)),
        extrusionOf("body_hidden", squareLoop(20, 0, 30, 10)),
      ],
      new Set(["body_shown"]),
    );
    expect(result.solids.map((entry) => entry.bodyId)).toEqual(["body_shown"]);
    expect(String(result.solids[0]?.solid)).toMatch(/^wsol_doc_/);
    // The inventory is queried on demand elsewhere: the render pass never
    // pays for per-body topology.
    expect(operations).not.toContain("solid.topology");
  });

  it("reports a refused lineage's fallback solids, still without a topology request", async () => {
    const { context, operations } = recordingContext(
      sceneContext({ ...measuringKernel(), union: () => kernelRefusal() }),
    );
    const result = await computeDocumentScene(
      context,
      [
        {
          bodyId: "body_boolean",
          scene: {
            kind: "boolean",
            request: {
              target: {
                kind: "extrude",
                request: {
                  loop: squareLoop(0, 0, 10, 10),
                  placement: IDENTITY_PLACEMENT,
                  distanceMm: 10,
                  bodyId: "body_target",
                },
              },
              tools: [
                {
                  kind: "extrude",
                  request: {
                    loop: squareLoop(20, 0, 30, 10),
                    placement: IDENTITY_PLACEMENT,
                    distanceMm: 10,
                    bodyId: "body_tool",
                  },
                },
              ],
              operation: "union",
              bodyId: "body_boolean",
            },
          },
        },
      ],
      new Set(["body_boolean", "body_target", "body_tool"]),
    );
    expect(result.failures.map((failure) => failure.bodyId)).toEqual([
      "body_boolean",
    ]);
    expect(result.solids.map((entry) => entry.bodyId)).toEqual([
      "body_target",
      "body_tool",
    ]);
    expect(operations).not.toContain("solid.topology");
  });
});
