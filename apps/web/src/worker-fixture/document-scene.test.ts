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
import { angle, length, ok } from "@slopcad/cad-core";
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
import type { ThreadSceneRequest } from "../cad-workbench/thread";

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

/** An in-memory worker session: the kernel behind worker solid ids. */
function sceneContext(kernel: GeometryKernel): ComputationContext {
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
      const answered = answerSceneOperation(kernel, mint, owned, [
        operation,
        input,
      ] as SceneRequest);
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
});
