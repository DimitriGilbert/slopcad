/**
 * The Phase 49 sheet-scene unit tests: the rebuild plan evaluated through
 * the worker operation matrix (a recording stand-in kernel answers every
 * `sheet.*` call with measurement-deterministic handles), pinning the two
 * honesty rules the scene carries —
 *
 *  - the OPEN sheet (patch, trim, knit, offset roots) reports its AREA
 *    with the honest volume 0.000: no `solid.volume` call is ever made
 *    (the stand-in kernel declines volume on open-sheet handles the way a
 *    real kernel does, so a scene that asked would reject, not settle);
 *  - the thicken product is a CLOSED solid: `solid.volume` IS called and
 *    its number is the measurement.
 *
 * Together they pin the "area reported instead of volume" mutation class:
 * reporting the open sheet's area as its volume, or measuring an open
 * shell's volume at all, goes red here.
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
import type { SheetSurfaceInput } from "@slopcad/cad-kernel";
import type { SheetBuildPlan } from "../cad-workbench/surface-scene";

import { computeSheetScene, sheetRenderState } from "./sheet-scene";

const mm = (value: number) => length(value, "mm");

const IDENTITY_PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: mm(0), y: mm(0), z: mm(0) },
};

/** A plane-patch plan leaf (the datum-anchored `create-sheet` mirror). */
function patchPlan(
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
): SheetBuildPlan {
  return {
    kind: "patch",
    input: {
      kind: "plane",
      placement: IDENTITY_PLACEMENT,
      uMin: mm(uMin),
      uMax: mm(uMax),
      vMin: mm(vMin),
      vMax: mm(vMax),
    },
  };
}

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

/** One recorded worker call: the operation id and its wire input. */
interface RecordedCall {
  readonly operation: WorkerOperationId;
  readonly input: unknown;
}

/**
 * The measurement-deterministic sheet stand-in: every sheet-family call
 * answers a fresh handle carrying the fixture's analytic measurement (area
 * always; volume only for thicken products). Volume on an open-sheet
 * handle declines structurally — the same honesty a real kernel answers
 * with, and the teeth of the open-sheet pin.
 */
function sheetStandInKernel() {
  const fake = createFakeKernel();
  const areas = new Map<KernelSolid, number>();
  const volumes = new Map<KernelSolid, number>();
  const mint = (areaMm2: number, volumeMm3?: number): KernelSolid => {
    const box = fake.createBox({
      width: mm(1),
      depth: mm(1),
      height: mm(1),
    });
    if (!box.ok) throw new Error(box.error.message);
    areas.set(box.value, areaMm2);
    if (volumeMm3 !== undefined) volumes.set(box.value, volumeMm3);
    return box.value;
  };
  const planeArea = (input: SheetSurfaceInput): number =>
    input.kind === "plane"
      ? (input.uMax.value - input.uMin.value) *
        (input.vMax.value - input.vMin.value)
      : 0;
  const kernel: GeometryKernel = {
    ...fake,
    createSheet: (input) => ok(mint(planeArea(input))),
    trimSheet: () => ok(mint(200)),
    thickenSheet: () => ok(mint(520, 400)),
    knit: () => ok(mint(600)),
    offsetSheet: () => ok(mint(600)),
    area: (solid) => ok(areas.get(solid) ?? 0),
    volume: (solid) => {
      const volume = volumes.get(solid);
      return volume === undefined
        ? {
            ok: false,
            error: {
              code: "kernel/unsupported-operation",
              message: "an open shell bounds no material — its volume declines",
              input: solid,
            },
          }
        : ok(volume);
    },
  };
  return { kernel };
}

/** An in-memory worker session: the kernel behind worker solid ids. */
function sceneContext(
  kernel: GeometryKernel,
  calls: RecordedCall[],
): ComputationContext {
  const solids = new Map<WorkerSolidId, KernelSolid>();
  let minted = 0;
  const mint = (handle: KernelSolid): WorkerSolidId => {
    minted += 1;
    const id = createWorkerSolidId(`wsol_sheet_${String(minted)}`);
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
      calls.push({ operation, input });
      const answered = answerSceneOperation(kernel, mint, owned, [
        operation,
        input,
      ] as SceneRequest);
      return Promise.resolve(answered as WorkerOperationResult<O>);
    },
  };
}

/** Answers the operations the sheet scene composes, on the kernel. */
function answerSceneOperation(
  kernel: GeometryKernel,
  mint: (handle: KernelSolid) => WorkerSolidId,
  owned: (id: WorkerSolidId) => KernelSolid,
  request: SceneRequest,
): SceneAnswer {
  const [operation, input] = request;
  switch (operation) {
    case "solid.createSheet": {
      const created = kernel.createSheet(input);
      if (!created.ok) throw new Error(created.error.message);
      return { solid: mint(created.value) };
    }
    case "sheet.trim": {
      const trimmed = kernel.trimSheet({
        sheet: owned(input.sheet),
        tool: owned(input.tool),
        keepInside: input.keepInside,
      });
      if (!trimmed.ok) throw new Error(trimmed.error.message);
      return { solid: mint(trimmed.value) };
    }
    case "sheet.thicken": {
      const thickened = kernel.thickenSheet({
        sheet: owned(input.sheet),
        thickness: input.thickness,
        side: input.side,
      });
      if (!thickened.ok) throw new Error(thickened.error.message);
      return { solid: mint(thickened.value) };
    }
    case "sheet.knit": {
      const knitted = kernel.knit({
        bodies: input.bodies.map(owned),
        tolerance: input.tolerance,
      });
      if (!knitted.ok) throw new Error(knitted.error.message);
      return { solid: mint(knitted.value) };
    }
    case "sheet.offset": {
      const offset = kernel.offsetSheet({
        sheet: owned(input.sheet),
        distance: input.distance,
      });
      if (!offset.ok) throw new Error(offset.error.message);
      return { solid: mint(offset.value) };
    }
    case "solid.area": {
      const measured = kernel.area(owned(input.solid));
      if (!measured.ok) throw new Error(measured.error.message);
      return { area: measured.value };
    }
    case "solid.volume": {
      const measured = kernel.volume(owned(input.solid));
      if (!measured.ok) throw new Error(measured.error.message);
      return { volume: measured.value };
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

describe("computeSheetScene: the worker-matrix evaluation (Phase 49)", () => {
  it("executes the e2e chain's plan through the worker matrix, operands wired by minted id", async () => {
    // The e2e chain's plan: a 30 × 20 base patch trimmed by a crossing
    // 10 × 200 tool band, keep-inside.
    const { kernel } = sheetStandInKernel();
    const calls: RecordedCall[] = [];
    const plan: SheetBuildPlan = {
      kind: "trim",
      sheet: patchPlan(0, 30, 0, 20),
      tool: patchPlan(10, 20, -100, 100),
      keepInside: true,
    };
    await computeSheetScene(sceneContext(kernel, calls), {
      bodyId: "body_sheet",
      plan,
    });
    const operations = calls.map((call) => call.operation);
    expect(operations).toEqual([
      "solid.createSheet",
      "solid.createSheet",
      "sheet.trim",
      "solid.area",
      "solid.bounds",
      "solid.tessellate",
    ]);
    // Operand wiring: the trim consumed exactly the ids the two patch
    // creations minted, in operand order.
    const firstPatch = calls[0]?.input as { kind: string };
    expect(firstPatch.kind).toBe("plane");
    const trim = calls[2]?.input as {
      sheet: WorkerSolidId;
      tool: WorkerSolidId;
      keepInside: boolean;
    };
    expect(trim.sheet).toBe("wsol_sheet_1");
    expect(trim.tool).toBe("wsol_sheet_2");
    expect(trim.keepInside).toBe(true);
  });

  it("an OPEN trimmed sheet reports its area with the honest volume 0 — no volume call made", async () => {
    const { kernel } = sheetStandInKernel();
    const calls: RecordedCall[] = [];
    const plan: SheetBuildPlan = {
      kind: "trim",
      sheet: patchPlan(0, 30, 0, 20),
      tool: patchPlan(10, 20, -100, 100),
      keepInside: true,
    };
    const scene = await computeSheetScene(sceneContext(kernel, calls), {
      bodyId: "body_sheet",
      plan,
    });
    expect(scene.openShell).toBe(true);
    // The 10 × 20 common band the trim stand-in answers.
    expect(scene.areaMm2).toBe(200);
    // The honest zero: the area carried the number, volume was never
    // asked (a scene that measured an open shell's volume would reject on
    // the declining stand-in; one that reported the area AS the volume
    // would answer 200 here).
    expect(scene.measurement.volume).toBe(0);
    expect(scene.measurement.area).toBe(200);
    expect(calls.map((call) => call.operation)).not.toContain("solid.volume");
  });

  it("a thicken product is measured through solid.volume at its analytic number", async () => {
    const { kernel } = sheetStandInKernel();
    const calls: RecordedCall[] = [];
    const plan: SheetBuildPlan = {
      kind: "thicken",
      sheet: {
        kind: "trim",
        sheet: patchPlan(0, 30, 0, 20),
        tool: patchPlan(10, 20, -100, 100),
        keepInside: true,
      },
      thicknessMm: 2,
      side: 1,
    };
    const scene = await computeSheetScene(sceneContext(kernel, calls), {
      bodyId: "body_wall",
      plan,
    });
    expect(scene.openShell).toBe(false);
    expect(scene.measurement.volume).toBe(400);
    const operations = calls.map((call) => call.operation);
    expect(operations).toContain("solid.volume");
    // The thicken call carried the plan's wall and side, on the trimmed
    // operand the chain minted before it.
    const thickenIndex = operations.indexOf("sheet.thicken");
    const thicken = calls[thickenIndex]?.input as {
      sheet: WorkerSolidId;
      thickness: { value: number };
      side: number;
    };
    expect(thicken.sheet).toBe("wsol_sheet_3");
    expect(thicken.thickness.value).toBe(2);
    expect(thicken.side).toBe(1);
  });

  it("a knit plan sews its operands in order with the sewing tolerance", async () => {
    const { kernel } = sheetStandInKernel();
    const calls: RecordedCall[] = [];
    const plan: SheetBuildPlan = {
      kind: "knit",
      bodies: [patchPlan(0, 30, 0, 20), patchPlan(0, 30, 0, 20)],
      toleranceMm: 0.001,
    };
    const scene = await computeSheetScene(sceneContext(kernel, calls), {
      bodyId: "body_knit",
      plan,
    });
    // A knit root is an OPEN shell: area carried, honest volume 0.
    expect(scene.openShell).toBe(true);
    expect(scene.measurement.volume).toBe(0);
    const knitIndex = calls.findIndex(
      (call) => call.operation === "sheet.knit",
    );
    const knit = calls[knitIndex]?.input as {
      bodies: WorkerSolidId[];
      tolerance: { value: number };
    };
    expect(knit.bodies).toEqual(["wsol_sheet_1", "wsol_sheet_2"]);
    expect(knit.tolerance.value).toBe(0.001);
  });

  it("an offset plan carries the signed distance on the operand it minted", async () => {
    const { kernel } = sheetStandInKernel();
    const calls: RecordedCall[] = [];
    const plan: SheetBuildPlan = {
      kind: "offset",
      sheet: patchPlan(0, 30, 0, 20),
      distanceMm: -3,
    };
    const scene = await computeSheetScene(sceneContext(kernel, calls), {
      bodyId: "body_offset",
      plan,
    });
    expect(scene.openShell).toBe(true);
    expect(scene.measurement.volume).toBe(0);
    const offsetIndex = calls.findIndex(
      (call) => call.operation === "sheet.offset",
    );
    const offset = calls[offsetIndex]?.input as {
      sheet: WorkerSolidId;
      distance: { value: number };
    };
    expect(offset.sheet).toBe("wsol_sheet_1");
    expect(offset.distance.value).toBe(-3);
  });
});

describe("sheetRenderState: the openShell honesty marker (Phase 49)", () => {
  it("marks the open sheet's render object openShell and leaves the thicken solid unmarked", async () => {
    const openKernel = sheetStandInKernel();
    const open = await computeSheetScene(sceneContext(openKernel.kernel, []), {
      bodyId: "body_sheet",
      plan: {
        kind: "trim",
        sheet: patchPlan(0, 30, 0, 20),
        tool: patchPlan(10, 20, -100, 100),
        keepInside: true,
      },
    });
    const openState = sheetRenderState(open, "body_sheet");
    const openObject = openState.projection.objects[0];
    expect(openObject?.openShell).toBe(true);

    const solidKernel = sheetStandInKernel();
    const thickened = await computeSheetScene(
      sceneContext(solidKernel.kernel, []),
      {
        bodyId: "body_wall",
        plan: {
          kind: "thicken",
          sheet: patchPlan(0, 30, 0, 20),
          thicknessMm: 2,
          side: 1,
        },
      },
    );
    const solidState = sheetRenderState(thickened, "body_wall");
    expect(solidState.projection.objects[0]?.openShell).toBeUndefined();
  });
});
