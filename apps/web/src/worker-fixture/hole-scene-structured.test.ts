/**
 * The Phase 42 structured-hole worker-scene unit tests: the structured
 * composition through the worker operation matrix, executed against the
 * fake kernel (Pappus-exact revolves, voxel-banded booleans) AND the real
 * Manifold kernel (the workbench's default backend — the revolve +
 * subtract composition's chord band), with the threaded type's honest
 * decline on Manifold (no `helix` capability: the `solid.helixSweep` call
 * refuses, the computation rejects — the structured error the workbench's
 * error surface carries) and the composed cut's unchanged post-condition
 * (a cut that removed nothing never silently settles).
 */

import { beforeAll, describe, expect, it } from "vitest";
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
import { createManifoldKernel } from "@slopcad/cad-kernel-manifold";
import type { StructuredHoleCutInput } from "./hole-scene";
import type { SceneOperand } from "../cad-workbench/extrude";

import { computeHoleScene } from "./hole-scene";

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

/** Answers the operations the structured hole scene composes, on the kernel. */
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
    case "solid.revolve": {
      const revolved = kernel.revolve(input);
      if (!revolved.ok) throw new Error(revolved.error.message);
      return { solid: mint(revolved.value) };
    }
    case "solid.helixSweep": {
      const swept = kernel.helixSweep(input);
      if (!swept.ok) throw new Error(swept.error.message);
      return { solid: mint(swept.value) };
    }
    case "solid.subtract": {
      const cut = kernel.subtract(owned(input.target), input.tools.map(owned));
      if (!cut.ok) throw new Error(cut.error.message);
      return { solid: mint(cut.value) };
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
    const id = createWorkerSolidId(`wsol_shole_${String(minted)}`);
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

/** The 30 × 20 × 10 plate the structured holes cut (the kernel fixture's). */
const PLATE = { w: 30, d: 20, h: 10 } as const;
const PLATE_VOLUME = PLATE.w * PLATE.d * PLATE.h;

function plateBase(): SceneOperand {
  return {
    kind: "extrude",
    request: {
      loop: squareLoop(0, 0, PLATE.w, PLATE.d),
      placement: IDENTITY_PLACEMENT,
      distanceMm: PLATE.h,
      bodyId: "body_plate",
    },
  };
}

/** A structured entry over the given spec (world +z, parameter position). */
function structuredEntry(
  spec: StructuredHoleCutInput["spec"],
  positions: readonly { readonly x: number; readonly y: number }[],
): StructuredHoleCutInput {
  return { kind: "structured", spec, positions, axis: 3 };
}

/** The counterbore fixture spec: Ø8 × 6 with a Ø14 × 3 counterbore, flat tip. */
const CBORE_SPEC = {
  type: 2,
  diameterMm: 8,
  depthMm: 6,
  tipAngleDeg: 180,
  cboreDiameterMm: 14,
  cboreDepthMm: 3,
  csinkDiameterMm: 14,
  csinkAngleDeg: 90,
  taperAngleDeg: 30,
  threadMajorMm: 6,
  threadPitchMm: 1,
} as const;

/** The re-derived analytic removal of the counterbore fixture (mm³). */
function cboreRemovedMm3(): number {
  const r = CBORE_SPEC.diameterMm / 2;
  const R = CBORE_SPEC.cboreDiameterMm / 2;
  return (
    Math.PI * r * r * CBORE_SPEC.depthMm +
    Math.PI * (R * R - r * r) * CBORE_SPEC.cboreDepthMm
  );
}

let manifoldKernel: GeometryKernel;

beforeAll(async () => {
  manifoldKernel = await createManifoldKernel();
});

describe("computeHoleScene: the structured entries (Phase 42)", () => {
  it("settles the counterbore at the analytic volume on the fake kernel", async () => {
    // The fake kernel's area domain excludes boolean nodes (the rib scene
    // test's stand-in): the unit under test is the composed volume.
    const measurable: GeometryKernel = {
      ...createFakeKernel(),
      area: () => ok(0),
    };
    const measured = await computeHoleScene(sceneContext(measurable), {
      base: plateBase(),
      holes: [structuredEntry(CBORE_SPEC, [{ x: 15, y: 10 }])],
    });
    expect(
      Math.abs(
        measured.measurement.volume - (PLATE_VOLUME - cboreRemovedMm3()),
      ),
    ).toBeLessThanOrEqual(PLATE_VOLUME * 0.02);
  });

  it("cuts every sketch-point position of one feature on the fake kernel", async () => {
    const measurable: GeometryKernel = {
      ...createFakeKernel(),
      area: () => ok(0),
    };
    const spec = { ...CBORE_SPEC, type: 1, cboreDepthMm: 0 };
    const measured = await computeHoleScene(sceneContext(measurable), {
      base: plateBase(),
      holes: [
        structuredEntry(spec, [
          { x: PLATE.w / 4, y: PLATE.d / 2 },
          { x: (3 * PLATE.w) / 4, y: PLATE.d / 2 },
        ]),
      ],
    });
    const removed = Math.PI * 4 * 4 * 6;
    expect(
      Math.abs(measured.measurement.volume - (PLATE_VOLUME - 2 * removed)),
    ).toBeLessThanOrEqual(PLATE_VOLUME * 0.02);
  });

  it("composes the structured scene deterministically (two calls, byte-identical)", async () => {
    // The Phase 40 helix byte-determinism pin's shape: two independent
    // compositions of the SAME request — fresh sessions, fresh solid minting
    // — must agree to the byte, tessellation soup included. The structured
    // hole rides the same fake-kernel revolve the helix pin rides, so the
    // reference determinism the real kernels are judged against is pinned
    // here too.
    const measurable: GeometryKernel = {
      ...createFakeKernel(),
      area: () => ok(0),
    };
    const first = await computeHoleScene(sceneContext(measurable), {
      base: plateBase(),
      holes: [structuredEntry(CBORE_SPEC, [{ x: 15, y: 10 }])],
    });
    const second = await computeHoleScene(sceneContext(measurable), {
      base: plateBase(),
      holes: [structuredEntry(CBORE_SPEC, [{ x: 15, y: 10 }])],
    });
    expect(second).toEqual(first);
  });

  it("settles the counterbore within the revolve chord band on Manifold", async () => {
    const measured = await computeHoleScene(sceneContext(manifoldKernel), {
      base: plateBase(),
      holes: [structuredEntry(CBORE_SPEC, [{ x: 15, y: 10 }])],
    });
    // The revolved meridian's straight edges carry only the sweep-angle
    // tessellation's chord deficit — the curved band the contract suite
    // pins for mesh kernels.
    expect(
      Math.abs(
        measured.measurement.volume - (PLATE_VOLUME - cboreRemovedMm3()),
      ),
    ).toBeLessThanOrEqual((PLATE_VOLUME - cboreRemovedMm3()) * 0.02);
  });

  it("rejects the threaded hole on Manifold (no helix capability) with the structured refusal", async () => {
    const rejection = await computeHoleScene(sceneContext(manifoldKernel), {
      base: plateBase(),
      holes: [structuredEntry({ ...CBORE_SPEC, type: 5 }, [{ x: 15, y: 10 }])],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain("helixSweep");
    expect(message).toContain("unsupported");
  });

  it("rejects the composed cut that removed nothing (the unchanged contract)", async () => {
    const rejection = await computeHoleScene(sceneContext(manifoldKernel), {
      base: plateBase(),
      holes: [structuredEntry(CBORE_SPEC, [{ x: 300, y: 300 }])],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("removed no material");
  });

  it("rejects the spec the shared battery refuses, before any tool", async () => {
    // A counterbore narrower than its hole never reaches a kernel call.
    const rejection = await computeHoleScene(sceneContext(createFakeKernel()), {
      base: plateBase(),
      holes: [
        structuredEntry({ ...CBORE_SPEC, cboreDiameterMm: 6 }, [
          { x: 15, y: 10 },
        ]),
      ],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("EXCEED");
  });
});
