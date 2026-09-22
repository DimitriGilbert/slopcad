/**
 * The Phase 41 feature-richness worker-scene unit tests: the rib scene's
 * composition through the worker operation matrix, executed against the
 * fake kernel over an in-memory ComputationContext (the worker server's
 * solid-id mapping in miniature). The pinned behavior is the no-op
 * post-condition: a rib whose profile adds no material REJECTS the
 * computation with the structured `rib/no-op` refusal — never a silently
 * unchanged solid settling as if work had happened.
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
import type { RibSceneRequest } from "../cad-workbench/rib";

import { computeRibScene } from "./feature-richness-scenes";

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

/** Answers the operations the rib scene composes, on the kernel. */
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
    const id = createWorkerSolidId(`wsol_scene_${String(minted)}`);
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
      // The dispatch answers each operation with its own result shape; the
      // two directed assertions carry the correlated pair in and narrow the
      // correlated answer back to the requested operation's result.
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

/** The rib scene request over a given rib profile placement. */
function ribSceneRequest(
  loop: ReturnType<typeof squareLoop>,
  ribPlacement: RibSceneRequest["placement"],
): RibSceneRequest {
  return {
    base: {
      loop: squareLoop(0, 0, 10, 10),
      placement: IDENTITY_PLACEMENT,
      distanceMm: 10,
      bodyId: "body_scene_base",
    },
    loop,
    placement: ribPlacement,
    thicknessMm: 2,
    bodyId: "body_scene_rib",
  };
}

describe("computeRibScene: the no-op post-condition (Phase 41)", () => {
  it("rejects the rib whose profile adds no material with rib/no-op", async () => {
    // The rib profile is a 4×4 square centered in the 10×10 base, lifted to
    // the base's mid-height: both symmetric extrusion halves (z ∈ [4, 6])
    // lie strictly inside the extruded base (z ∈ [0, 10]), so the union's
    // volume cannot grow — the computation must reject, never settle.
    const rejection = await computeRibScene(
      sceneContext(createFakeKernel()),
      ribSceneRequest(squareLoop(3, 3, 7, 7), {
        rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
        translation: { x: mm(0), y: mm(0), z: mm(5) },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("rib/no-op");
    expect((rejection as Error).message).toContain(
      "the union's volume did not grow",
    );
  });

  it("measures the rib that reaches outside the target", async () => {
    // The control: the same profile ON the base's top plane (z = 10) grows
    // the union by its up-half's full 4×4×1 slab — the guard stays silent
    // and the composed measurement settles. The fake kernel's area domain
    // excludes booleans (its volumes are voxel-quantized), so this control
    // runs over a measuring stand-in whose area answers a placeholder: the
    // unit under test is the no-op post-condition, not the area number.
    const measurable: GeometryKernel = {
      ...createFakeKernel(),
      area: () => ok(0),
    };
    const measured = await computeRibScene(
      sceneContext(measurable),
      ribSceneRequest(squareLoop(3, 3, 7, 7), {
        rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
        translation: { x: mm(0), y: mm(0), z: mm(10) },
      }),
    );
    // The union adds the up-half's full 4×4×1 slab (16 mm³) beyond the
    // base's 1000, judged within the fake kernel's voxel boolean band —
    // the suite's tolerance for every fake-kernel boolean fixture.
    expect(Math.abs(measured.volume - (1000 + 16))).toBeLessThanOrEqual(
      (1000 + 16) * 0.02,
    );
  });
});
